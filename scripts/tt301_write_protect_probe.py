"""Probe TT301 communication write protection and always restore 01/FF."""
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
                if not payload:
                    raise RuntimeError(f"Cmd {command} returned no response code")
                return tx, frame, payload[0], payload[2:]
    raise TimeoutError(f"Cmd {command} timeout; RX {rx.hex(' ')}")


def record(port, lines, label, command, data=b""):
    tx, rx, rc, body = query(port, command, data)
    lines.append(f"{label} CMD {command:03d} TX: {tx.hex(' ').upper()}")
    lines.append(f"{label} CMD {command:03d} RX: {rx.hex(' ').upper()} (RC={rc})")
    time.sleep(0.15)
    return rc, body


def main():
    port_name = sys.argv[1] if len(sys.argv) > 1 else "COM17"
    output = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else pathlib.Path(
        "trm/tt301/write-protect-probe-COM17-20261015.txt")
    lines = [f"TT301 write-protection probe; {dt.datetime.now().astimezone().isoformat()}; {port_name}; 1200 8O1",
             "Temporary protection selection 00/FF; attempts an unchanged Cmd 18 identity write; finally restores 01/FF."]
    with serial.Serial(port_name, 1200, bytesize=8, parity=serial.PARITY_ODD,
                       stopbits=1, timeout=0.05, write_timeout=1) as port:
        rc, protection = record(port, lines, "BEFORE", 168, b"\x02")
        if rc != 0 or protection != b"\x02\x01\xff":
            raise RuntimeError(f"expected initial protection 02 01 FF; got RC={rc}, {protection.hex(' ')}; no write made")
        rc, identity = record(port, lines, "BEFORE", 13)
        if rc != 0 or len(identity) != 21:
            raise RuntimeError("could not capture the exact current 21-byte Cmd 13 payload")
        locked_rc = None
        try:
            record(port, lines, "ENABLE_READ_ONLY", 169, b"\x02\x00\xff")
            rc, readback = record(port, lines, "READ_ONLY", 168, b"\x02")
            if rc != 0 or readback != b"\x02\x00\xff":
                raise RuntimeError(f"read-only selection mismatch: RC={rc}, {readback.hex(' ')}")
            locked_rc, _ = record(port, lines, "WRITE_ATTEMPT", 18, identity)
        finally:
            record(port, lines, "RESTORE_WRITABLE", 169, b"\x02\x01\xff")
            rc, restored = record(port, lines, "RESTORED", 168, b"\x02")
            if rc != 0 or restored != b"\x02\x01\xff":
                lines.append("RESTORE ERROR: expected protection 02 01 FF")
                raise RuntimeError(f"failed to restore write protection: RC={rc}, {restored.hex(' ')}")
            rc, tag_after = record(port, lines, "IDENTITY_AFTER", 13)
            if rc != 0 or tag_after != identity:
                lines.append("IDENTITY ERROR: Cmd 13 differs after the blocked-write probe")
                raise RuntimeError("identity changed during write-protection probe")
        lines.append(f"UNCHANGED_CMD18_RESPONSE_CODE: {locked_rc}")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))
    print(f"Saved: {output.resolve()}")


if __name__ == "__main__":
    main()
