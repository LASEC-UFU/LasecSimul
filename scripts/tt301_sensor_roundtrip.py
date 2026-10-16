"""Reversible TT301 sensor-command probe on COM17; always restores Cmd 130 state."""
import datetime as dt
import pathlib
import sys
import time

import serial


ADDRESS = bytes.fromhex("BE 02 01 0C 3A")


def request(command, data=b"", short=False):
    address = b"\x80" if short else ADDRESS
    frame = bytearray(b"\xff" * 5 + bytes([0x02 if short else 0x82]) + address)
    frame += bytes([command, len(data)]) + data
    checksum = 0
    # HART checksum covers the delimiter through the final data byte, not preambles.
    for value in frame[5:]:
        checksum ^= value
    frame.append(checksum)
    return bytes(frame)


def parse_frame(buf):
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
            frame = bytes(buf[start:end])
            # response payload starts after address, command, count, RC, status
            data_at = 1 + width + 4
            payload_size = max(0, count - 2)
            command_at = 1 + width
            return frame, frame[command_at], frame[command_at + 2], frame[command_at + 3], frame[data_at:data_at + payload_size]
    return None


def query(port, command, data=b"", short=False, timeout=1.5):
    tx = request(command, data, short)
    port.reset_input_buffer()
    port.write(tx)
    port.flush()
    buf = bytearray()
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        buf.extend(port.read(64))
        parsed = parse_frame(buf)
        if parsed:
            return tx, parsed
    raise TimeoutError(f"Cmd {command} timeout, RX={bytes(buf).hex(' ').upper()}")


def main():
    port_name = sys.argv[1] if len(sys.argv) > 1 else "COM17"
    stamp = dt.datetime.now().astimezone().strftime("%Y%m%d-%H%M%S")
    output = pathlib.Path(sys.argv[2]) if len(sys.argv) > 2 else pathlib.Path(f"trm/tt301/sensor-roundtrip-{port_name}-{stamp}.txt")
    lines = [f"TT301 reversible Cmd 131 sensor roundtrip; {dt.datetime.now().astimezone().isoformat()}; port={port_name}; 1200 8O1",
             "Initial state is read first; Pt100 IEC 2-wire -> TC J NBS -> TC K NBS -> exact initial Cmd 130 bytes is written."]

    def record(port, command, data=b"", short=False):
        tx, parsed = query(port, command, data, short)
        frame, reply_command, rc, status, payload = parsed
        lines.append(f"CMD {command:03d} TX: {tx.hex(' ').upper()}")
        lines.append(f"CMD {command:03d} RX: {frame.hex(' ').upper()}  RC={rc:02X} STATUS={status:02X} DATA={payload.hex(' ').upper()}")
        time.sleep(0.15)
        return rc, payload

    output.parent.mkdir(parents=True, exist_ok=True)
    with serial.Serial(port_name, 1200, bytesize=8, parity=serial.PARITY_ODD, stopbits=1,
                       timeout=0.05, write_timeout=1) as port:
        _, identity = record(port, 0, short=True)
        rc, initial_sensor = record(port, 130, b"\x02")
        if rc != 0 or len(initial_sensor) != 5 or initial_sensor[:4] != bytes.fromhex("02 01 02 01"):
            raise RuntimeError(f"Expected initial RTD/Pt100/two-wire; RC={rc:02X} len={len(initial_sensor)} read={initial_sensor.hex(' ').upper()} line={lines[-1]}")
        _, initial_range = record(port, 15)
        _, initial_limits = record(port, 14)
        _, initial_pid = record(port, 138, b"\x02")
        _, initial_burnout = record(port, 162, b"\x02")
        protect_rc, protect = record(port, 168, b"\x02")
        if protect_rc != 0 or protect != bytes.fromhex("02 01 FF"):
            raise RuntimeError(f"Write protection is not in the confirmed read/write state: {protect.hex(' ').upper()}")

        changed = False
        try:
            # If an ACK is lost, restoration must still be attempted because
            # the field device may have applied the write before the timeout.
            changed = True
            rc, ack = record(port, 131, bytes.fromhex("02 83 02 01"))
            if rc != 0 or ack != bytes.fromhex("02 83 02 01"):
                raise RuntimeError(f"Cmd 131 TC/J write failed: RC={rc:02X} DATA={ack.hex(' ').upper()}")
            time.sleep(0.2)
            _, tc_sensor = record(port, 130, b"\x02")
            _, tc_range = record(port, 15)
            _, tc_limits = record(port, 14)
            if tc_sensor != bytes.fromhex("02 83 02 01 01") or tc_range[3:11] != bytes.fromhex("44 3B 80 00 C3 16 00 00"):
                raise RuntimeError(f"Unexpected J NBS readback: sensor={tc_sensor.hex(' ').upper()} range={tc_range.hex(' ').upper()}")
            rc, ack = record(port, 131, bytes.fromhex("02 83 03 01"))
            if rc != 0 or ack != bytes.fromhex("02 83 03 01"):
                raise RuntimeError(f"Cmd 131 TC/K write failed: RC={rc:02X} DATA={ack.hex(' ').upper()}")
            _, k_sensor = record(port, 130, b"\x02")
            _, k_range = record(port, 15)
            _, k_limits = record(port, 14)
            if k_sensor != bytes.fromhex("02 83 03 01 01") or k_range != tc_range or k_limits != tc_limits:
                raise RuntimeError(f"Unexpected K NBS readback: sensor={k_sensor.hex(' ').upper()} range={k_range.hex(' ').upper()}")
        finally:
            if changed:
                time.sleep(0.2)
                rc, restored = record(port, 131, initial_sensor[:4])
                if rc != 0 or restored != initial_sensor[:4]:
                    # Retry once, still writing only the saved initial sensor tuple.
                    time.sleep(0.2)
                    rc, restored = record(port, 131, initial_sensor[:4])
                if rc != 0 or restored != initial_sensor[:4]:
                    raise RuntimeError(f"Initial Cmd 130 state restore failed: RC={rc:02X} DATA={restored.hex(' ').upper()}")
                time.sleep(0.2)
                _, final_sensor = record(port, 130, b"\x02")
                _, final_range = record(port, 15)
                _, final_limits = record(port, 14)
                if final_sensor != initial_sensor:
                    raise RuntimeError(f"Final sensor state differs: {final_sensor.hex(' ').upper()}")
                lines.append(f"RESTORE VERIFIED: sensor={final_sensor.hex(' ').upper()}; Cmd15={final_range.hex(' ').upper()}; Cmd14={final_limits.hex(' ').upper()}")

    output.write_text("\n".join(lines) + "\n", encoding="utf-8")
    print("\n".join(lines))
    print(f"Saved: {output.resolve()}")


if __name__ == "__main__":
    main()
