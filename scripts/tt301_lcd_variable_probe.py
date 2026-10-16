"""Temporarily select TT301 LCD First Variable PV% and restore Temp./Temp.PV."""
import datetime as dt
import pathlib
import sys
import time

import serial

ADDRESS = bytes.fromhex("BE 02 01 0C 3A")


def request(command, data=b""):
    body = bytes([0x82]) + ADDRESS + bytes([command, len(data)]) + data
    checksum = 0
    for value in body:
        checksum ^= value
    return b"\xff" * 5 + body + bytes([checksum])


def query(port, command, data=b""):
    tx = request(command, data)
    port.reset_input_buffer()
    port.write(tx)
    port.flush()
    rx = bytearray()
    deadline = time.monotonic() + 1.5
    while time.monotonic() < deadline:
        rx.extend(port.read(64))
        start = rx.find(b"\x86")
        if start >= 0 and len(rx) >= start + 9:
            end = start + 8 + rx[start + 7] + 1
            if len(rx) >= end:
                frame = bytes(rx[:end])
                count = frame[start + 7]
                payload = frame[start + 8:start + 8 + count]
                if not payload or payload[0] != 0:
                    raise RuntimeError(f"Cmd {command} returned RC {payload[0] if payload else 'missing'}")
                return tx, frame, payload[2:]
    raise TimeoutError(f"Cmd {command} timeout; RX {rx.hex(' ')}")


def record(port, lines, label, command, data=b""):
    tx, rx, body = query(port, command, data)
    lines.append(f"{label} CMD {command:03d} TX: {tx.hex(' ').upper()}")
    lines.append(f"{label} CMD {command:03d} RX: {rx.hex(' ').upper()}")
    time.sleep(0.15)
    return body


def main():
    port_name = sys.argv[1] if len(sys.argv) > 1 else "COM17"
    output = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else pathlib.Path(
        "trm/tt301/lcd-pv-percent-probe-COM17-20261015.txt")
    lines = [f"TT301 LCD First Variable PV% probe; {dt.datetime.now().astimezone().isoformat()}; {port_name}; 1200 8O1",
             "Precondition/restoration target: Cmd 164 = 02 03 02. Probe writes First Variable 04, then restores 03."]
    with serial.Serial(port_name, 1200, bytesize=8, parity=serial.PARITY_ODD,
                       stopbits=1, timeout=0.05, write_timeout=1) as port:
        original = record(port, lines, "BEFORE", 164, b"\x02")
        if original != b"\x02\x03\x02":
            raise RuntimeError(f"expected display config 02 03 02; got {original.hex(' ')}; no write made")
        try:
            record(port, lines, "SET_PV_PERCENT", 165, b"\x02\x04\x02")
            changed = record(port, lines, "PV_PERCENT", 164, b"\x02")
            if changed != b"\x02\x04\x02":
                raise RuntimeError(f"PV% readback mismatch: {changed.hex(' ')}")
        finally:
            record(port, lines, "RESTORE", 165, b"\x02\x03\x02")
            restored = record(port, lines, "RESTORED", 164, b"\x02")
            if restored != b"\x02\x03\x02":
                lines.append("RESTORE ERROR: expected 02 03 02")
                raise RuntimeError(f"LCD restore failed: {restored.hex(' ')}")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))
    print(f"Saved: {output.resolve()}")


if __name__ == "__main__":
    main()
