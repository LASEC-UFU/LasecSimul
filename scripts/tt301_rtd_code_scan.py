"""Probe TT301 RTD sensor model bytes and restore Pt100 IEC after each code."""
import datetime as dt
import pathlib
import struct
import sys
import time

import serial

ADDRESS = bytes.fromhex("BE 02 01 0C 3A")
RESTORE = bytes.fromhex("02 01 02 01")  # TT301 selector, RTD, Pt100 IEC, 2 wires


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


def f32(data, offset):
    return struct.unpack(">f", data[offset:offset + 4])[0]


def main():
    port_name = sys.argv[1] if len(sys.argv) > 1 else "COM17"
    output = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else pathlib.Path(
        "trm/tt301/rtd-sensor-code-scan-COM17-20261015.txt")
    lines = [f"TT301 RTD selector scan; {dt.datetime.now().astimezone().isoformat()}; {port_name}; 1200 8O1",
             "Codes 00-0E are probed as RTD model bytes. Each is followed by an immediate restore to Pt100 IEC 2-wire (01 02 01).",
             "No sensor resistance is attached; observed ranges identify the loaded profile, not a physical temperature accuracy check."]
    with serial.Serial(port_name, 1200, bytesize=8, parity=serial.PARITY_ODD,
                       stopbits=1, timeout=0.05, write_timeout=1) as port:
        rc, original, _ = query(port, 130, b"\x02")
        if rc != 0 or original[:4] != RESTORE:
            raise RuntimeError(f"expected initial Pt100 IEC 2-wire {RESTORE.hex(' ')}, got RC={rc} {original.hex(' ')}; no writes made")
        for code in range(0x00, 0x0F):
            request_body = bytes([0x02, 0x01, code, 0x01])
            try:
                wr_rc, wr_body, wr_frame = query(port, 131, request_body)
                lines.append(f"CODE {code:02X} CMD131 TX BODY: {request_body.hex(' ').upper()}")
                lines.append(f"CODE {code:02X} CMD131 RX RC={wr_rc}: {wr_frame.hex(' ').upper()}")
                read_rc, sensor, sensor_frame = query(port, 130, b"\x02")
                range_rc, range14, range_frame = query(port, 14)
                span_rc, range15, range15_frame = query(port, 15)
                lines.append(f"CODE {code:02X} CMD130 RC={read_rc}: {sensor_frame.hex(' ').upper()}")
                lines.append(f"CODE {code:02X} CMD014 RC={range_rc}: {range_frame.hex(' ').upper()}")
                lines.append(f"CODE {code:02X} CMD015 RC={span_rc}: {range15_frame.hex(' ').upper()}")
                if range_rc == 0 and len(range14) >= 16:
                    lines.append(f"CODE {code:02X} LIMITS: USL={f32(range14,4):g}, LSL={f32(range14,8):g}, MINSPAN={f32(range14,12):g}")
                if wr_rc not in (0, 7):
                    lines.append(f"CODE {code:02X} WRITE_RC: {wr_rc}; result not classified")
            finally:
                restore_rc, restore_body, restore_frame = query(port, 131, RESTORE)
                verify_rc, verify, verify_frame = query(port, 130, b"\x02")
                lines.append(f"RESTORE CMD131 RC={restore_rc}: {restore_frame.hex(' ').upper()}")
                lines.append(f"RESTORE CMD130 RC={verify_rc}: {verify_frame.hex(' ').upper()}")
                if restore_rc != 0 or verify_rc != 0 or verify[:4] != RESTORE:
                    lines.append("FATAL: could not restore Pt100 IEC 2-wire; scan stopped")
                    raise RuntimeError(f"failed to restore Pt100 IEC after code {code:02X}")
            time.sleep(0.15)
    output.parent.mkdir(parents=True, exist_ok=True)
    output.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))
    print(f"Saved: {output.resolve()}")


if __name__ == "__main__":
    main()
