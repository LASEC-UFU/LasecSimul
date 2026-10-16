"""Capture read-only HART queries from a TT301 on a Windows serial port.

Usage: python scripts/tt301_live_read.py COM17 [output.txt]
Only standard/vendor read requests are sent; no configuration writes are made.
"""
import datetime as dt
import pathlib
import sys
import time

import serial


def request(command, data=b"", short=False):
    address = b"\x80" if short else bytes.fromhex("BE 02 01 0C 3A")
    body = bytes([0x02 if short else 0x82, *address, command, len(data)]) + data
    checksum = 0
    for byte in body:
        checksum ^= byte
    return b"\xff" * 5 + body + bytes([checksum])


def complete_frame(buf):
    for start, value in enumerate(buf):
        if value not in (0x06, 0x86):
            continue
        width = 5 if value & 0x80 else 1
        cmd_at = start + 1 + width
        if len(buf) < cmd_at + 2:
            continue
        count = buf[cmd_at + 1]
        end = cmd_at + 2 + count + 1
        if len(buf) >= end:
            return bytes(buf[:end]), buf[end:]
    return None, b""


def query(port, command, data=b"", short=False, timeout=1.2):
    tx = request(command, data, short)
    port.reset_input_buffer()
    port.write(tx)
    port.flush()
    rx = bytearray()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        rx.extend(port.read(64))
        frame, tail = complete_frame(rx)
        if frame:
            return tx, bytes(rx)
    return tx, bytes(rx)


def main():
    port_name = sys.argv[1] if len(sys.argv) > 1 else "COM17"
    stamp = dt.datetime.now().astimezone().strftime("%Y-%m-%d %H:%M:%S %z")
    output = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else pathlib.Path("trm/tt301/live-read-COM17.txt")
    # Standard reads plus TT301 manufacturer read commands. Vendor command
    # selector 02 is the documented TT301 family byte; all requests are reads.
    reads = [(0, b"", True), (1, b"", False), (2, b"", False), (3, b"", False),
             (12, b"", False), (13, b"", False), (14, b"", False), (15, b"", False),
             (16, b"", False), (20, b"", False), (21, b"", False), (22, b"", False),
             (48, b"", False), (50, b"", False),
             (54, b"\x00", False), (54, b"\x01", False), (54, b"\x02", False),
             (54, b"\x03", False), (54, b"\xF6", False),
             (9, b"\x03\x01\x02\x00", False), (33, b"\x03\x01\x02\x00", False),
             # TT301 Device Variables 5-8: SP%, SP engineering units,
             # setpoint-generator time, and controller error. Keep this scan
             # separate from the four configured dynamic-variable slots.
             (9, b"\x05\x06\x07\x08", False), (33, b"\x05\x06\x07\x08", False),
             (130, b"\x02", False), (131, b"\x02", False),
             (136, b"\x02", False), (138, b"\x02", False), (140, b"\x02", False),
             (142, b"\x02", False), (152, b"\x02", False), (162, b"\x02", False),
             (164, b"\x02", False), (168, b"\x02", False), (187, b"\x02", False),
             (198, b"\x02", False), (223, b"\x02", False)]
    lines = [f"TT301 read-only live capture; {stamp}; port={port_name}; 1200 8O1",
             "No writes sent. Each RX line is the raw serial bytes after one request."]
    with serial.Serial(port_name, 1200, bytesize=8, parity=serial.PARITY_ODD,
                       stopbits=1, timeout=0.05, write_timeout=1) as port:
        for command, data, short in reads:
            tx, rx = query(port, command, data, short)
            lines.append(f"CMD {command:03d} TX ({len(tx)}): {tx.hex(' ').upper()}")
            lines.append(f"CMD {command:03d} RX ({len(rx)}): {rx.hex(' ').upper() or '(timeout)'}")
            time.sleep(0.12)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))
    print(f"Saved: {output.resolve()}")


if __name__ == "__main__":
    main()
