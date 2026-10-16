"""Temporarily toggle TT301 burnout selection and restore the original state.

This focused bench probe records raw HART frames for Commands 162/163/15.
It only supports a device found in Burnout High (code 01) and always attempts
to restore High in a finally block.
"""
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


def read_frame(port, command, data=b"", timeout=1.5):
    tx = request(command, data)
    port.reset_input_buffer()
    port.write(tx)
    port.flush()
    rx = bytearray()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        rx.extend(port.read(64))
        start = rx.find(b"\x86")
        if start < 0 or len(rx) < start + 9:
            continue
        count = rx[start + 7]
        end = start + 8 + count + 1
        if len(rx) >= end:
            return tx, bytes(rx[:end])
    return tx, bytes(rx)


def response_data(frame):
    start = frame.find(b"\x86")
    if start < 0 or len(frame) < start + 9:
        raise RuntimeError("no complete long-frame reply")
    count = frame[start + 7]
    payload = frame[start + 8:start + 8 + count]
    if not payload:
        raise RuntimeError("reply has no response code")
    if payload[0] != 0:
        raise RuntimeError(f"HART response code {payload[0]}")
    return payload[2:]


def record(port, lines, label, command, data=b""):
    tx, rx = read_frame(port, command, data)
    lines.append(f"{label} CMD {command:03d} TX: {tx.hex(' ').upper()}")
    lines.append(f"{label} CMD {command:03d} RX: {rx.hex(' ').upper() or '(timeout)'}")
    time.sleep(0.15)
    return response_data(rx)


def main():
    port_name = sys.argv[1] if len(sys.argv) > 1 else "COM17"
    output = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else pathlib.Path(
        "trm/tt301/burnout-low-probe-COM17-20261015.txt")
    lines = [f"TT301 controlled Burnout Low probe; {dt.datetime.now().astimezone().isoformat()}; {port_name}; 1200 8O1",
             "Precondition and restoration target: Burnout High (01). Probe writes Low (00), reads back, then restores High (01)."]
    with serial.Serial(port_name, 1200, bytesize=8, parity=serial.PARITY_ODD,
                       stopbits=1, timeout=0.05, write_timeout=1) as port:
        original = record(port, lines, "BEFORE", 162, b"\x02")
        record(port, lines, "BEFORE", 15)
        if len(original) < 2 or original[1] != 1:
            raise RuntimeError(f"expected current Burnout High=01; got {original.hex(' ')}; no write made")
        try:
            record(port, lines, "SET_LOW", 163, b"\x02\x00")
            low = record(port, lines, "LOW", 162, b"\x02")
            record(port, lines, "LOW", 15)
            if len(low) < 2 or low[1] != 0:
                raise RuntimeError(f"Low readback mismatch: {low.hex(' ')}")
        finally:
            record(port, lines, "RESTORE_HIGH", 163, b"\x02\x01")
            high = record(port, lines, "RESTORED", 162, b"\x02")
            record(port, lines, "RESTORED", 15)
            if len(high) < 2 or high[1] != 1:
                lines.append("RESTORE ERROR: Burnout High readback did not match")
                raise RuntimeError(f"restore failed; Burnout readback={high.hex(' ')}")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))
    print(f"Saved: {output.resolve()}")


if __name__ == "__main__":
    main()
