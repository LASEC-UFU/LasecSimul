"""Rewrite the current TT301 Cmd 13 identity payload twice, byte for byte."""
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
                if payload[0] != 0:
                    raise RuntimeError(f"Cmd {command} returned RC {payload[0]}")
                return tx, frame, payload[2:]
    raise TimeoutError(f"Cmd {command} timeout; RX {rx.hex(' ')}")


def record(port, lines, label, command, data=b""):
    tx, rx, body = query(port, command, data)
    lines.append(f"{label} CMD {command:03d} TX: {tx.hex(' ').upper()}")
    lines.append(f"{label} CMD {command:03d} RX: {rx.hex(' ').upper()}")
    time.sleep(0.15)
    return body


def counter(cmd0):
    # HART 7 Cmd 0 response body: 22 bytes; configuration counter at 14:16.
    if len(cmd0) != 22:
        raise RuntimeError(f"unexpected Cmd 0 body length {len(cmd0)}")
    return int.from_bytes(cmd0[14:16], "big")


def main():
    port_name = sys.argv[1] if len(sys.argv) > 1 else "COM17"
    output = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else pathlib.Path(
        "trm/tt301/idempotent-identity-probe-COM17-20261015.txt")
    lines = [f"TT301 idempotent identity write probe; {dt.datetime.now().astimezone().isoformat()}; {port_name}; 1200 8O1",
             "The complete current 21-byte Cmd 13 payload is reused unchanged in Cmd 18 twice."]
    with serial.Serial(port_name, 1200, bytesize=8, parity=serial.PARITY_ODD,
                       stopbits=1, timeout=0.05, write_timeout=1) as port:
        identity = record(port, lines, "BEFORE", 13)
        before_count = counter(record(port, lines, "BEFORE", 0))
        if len(identity) != 21:
            raise RuntimeError(f"Cmd 13 payload must be 21 bytes; got {len(identity)}")
        lines.append(f"IDENTITY BODY REUSED: {identity.hex(' ').upper()}")
        record(port, lines, "WRITE_1", 18, identity)
        count1 = counter(record(port, lines, "AFTER_WRITE_1", 0))
        record(port, lines, "WRITE_2", 18, identity)
        count2 = counter(record(port, lines, "AFTER_WRITE_2", 0))
        readback = record(port, lines, "READBACK", 13)
        if readback != identity:
            raise RuntimeError("Cmd 13 payload changed after writing the identical value")
        lines.append(f"COUNTER SUMMARY: 0x{before_count:04X} -> 0x{count1:04X} -> 0x{count2:04X}")
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))
    print(f"Saved: {output.resolve()}")


if __name__ == "__main__":
    main()
