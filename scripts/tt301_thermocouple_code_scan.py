"""Probe TT301 thermocouple model bytes and restore Pt100 IEC afterward."""
import datetime as dt
import pathlib
import sys
import time

import serial

ADDRESS = bytes.fromhex("BE 02 01 0C 3A")
RESTORE = bytes.fromhex("02 01 02 01")


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
                    raise RuntimeError(f"Cmd {command} response code missing")
                return payload[0], payload[2:], frame
    raise TimeoutError(f"Cmd {command} timeout; RX={rx.hex(' ')}")


def main():
    port_name = sys.argv[1] if len(sys.argv) > 1 else "COM17"
    output = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else pathlib.Path(
        "trm/tt301/thermocouple-code-scan-COM17-20261015.txt")
    lines = [f"TT301 thermocouple selector scan; {dt.datetime.now().astimezone().isoformat()}; {port_name}; 1200 8O1",
             "Codes 00-0B are probed as TC model bytes. Each is followed by immediate restore to Pt100 IEC 2-wire (01 02 01).",
             "No thermocouple is attached; this records accepted selectors and loaded limits only."]
    with serial.Serial(port_name, 1200, bytesize=8, parity=serial.PARITY_ODD,
                       stopbits=1, timeout=0.05, write_timeout=1) as port:
        rc, current, _ = query(port, 130, b"\x02")
        if rc != 0 or current[:4] != RESTORE:
            raise RuntimeError(f"expected initial Pt100 IEC 2-wire; got RC={rc} {current.hex(' ')}; no writes made")
        for code in range(0x0C):
            body = bytes([0x02, 0x83, code, 0x01])
            try:
                wr_rc, _, wr_frame = query(port, 131, body)
                lines.append(f"CODE {code:02X} CMD131 TX BODY: {body.hex(' ').upper()}")
                lines.append(f"CODE {code:02X} CMD131 RX RC={wr_rc}: {wr_frame.hex(' ').upper()}")
                for command in (130, 14, 15):
                    data = b"\x02" if command == 130 else b""
                    read_rc, _, frame = query(port, command, data)
                    lines.append(f"CODE {code:02X} CMD{command:03d} RC={read_rc}: {frame.hex(' ').upper()}")
            finally:
                restore_rc, _, restore_frame = query(port, 131, RESTORE)
                verify_rc, verify, verify_frame = query(port, 130, b"\x02")
                lines.append(f"RESTORE CMD131 RC={restore_rc}: {restore_frame.hex(' ').upper()}")
                lines.append(f"RESTORE CMD130 RC={verify_rc}: {verify_frame.hex(' ').upper()}")
                if restore_rc != 0 or verify_rc != 0 or verify[:4] != RESTORE:
                    lines.append("FATAL: could not restore Pt100 IEC 2-wire; scan stopped")
                    raise RuntimeError(f"failed to restore Pt100 IEC after TC code {code:02X}")
            time.sleep(0.15)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))
    print(f"Saved: {output.resolve()}")


if __name__ == "__main__":
    main()
