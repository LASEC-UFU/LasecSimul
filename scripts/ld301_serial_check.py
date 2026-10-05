"""Act as the HART master (PACTware side) against the simulated LD301 served by
core/tools/hart_ld301_serial_bridge on the other end of a com0com pair, and
replay every request of the reference capture through the real Windows serial
driver at 1200 baud 8O1.

    hart_ld301_serial_bridge.exe CNCB2          (terminal 1)
    python scripts/ld301_serial_check.py COM22  (terminal 2)

Replies are compared with the captured LD301 replies frame by frame (preamble
count excluded); the known capture defects (line-noise bit flips, truncated
last reply, sensor-temperature drift) are reported separately.
"""
import pathlib
import re
import sys
import time

import serial  # pyserial

CAPTURE = pathlib.Path(__file__).resolve().parents[1] / "core" / "test" / "core" / "protocols" / "fixtures" / "ld301_capture.txt"
LINE = re.compile(r"^\[([0-9:.]+)\] (SERIAL|UDP) RX \(\d+ bytes\): (.*)$")


def load_capture():
    exchanges = []
    for raw in CAPTURE.read_text(encoding="utf-8", errors="replace").splitlines():
        match = LINE.match(raw.strip())
        if not match:
            continue
        data = bytearray()
        for token in match.group(3).split():
            if len(token) != 2:
                break
            data.append(int(token, 16))
        if match.group(2) == "SERIAL":
            exchanges.append([bytes(data), bytearray()])
        elif exchanges:
            exchanges[-1][1].extend(data)
    return exchanges


def frame_of(raw):
    """HART frame without preambles (skips line-noise bytes before the ACK)."""
    for i, byte in enumerate(raw):
        if byte in (0x06, 0x86):
            return bytes(raw[i:])
    return b""


def read_reply(port, timeout=3.0):
    deadline = time.time() + timeout
    data = bytearray()
    while time.time() < deadline:
        data.extend(port.read(64))
        frame = frame_of(data)
        if len(frame) >= 2:
            address = 5 if frame[0] & 0x80 else 1
            if len(frame) >= 3 + address and len(frame) >= address + 3 + frame[address + 2] + 1:
                return bytes(data)
    return bytes(data)


def packed(text, characters):
    """HART packed ASCII (6 bits per character, space padded)."""
    text = text.upper().ljust(characters)[:characters]
    out = bytearray()
    for i in range(0, characters, 4):
        value = 0
        for ch in text[i:i + 4]:
            value = (value << 6) | (ord(ch) & 0x3F)
        out += value.to_bytes(3, "big")
    return bytes(out)


def request_frame(command, data=b"", primary=True):
    body = bytes([0x82, 0x3E | (0x80 if primary else 0x00), 0x01, 0x05, 0xF0, 0x4D, command, len(data)]) + data
    checksum = 0
    for byte in body:
        checksum ^= byte
    return bytes([0xFF] * 5) + body + bytes([checksum])


def main() -> int:
    port_name = sys.argv[1] if len(sys.argv) > 1 else "COM22"
    exchanges = load_capture()
    known = {41: "capture lost 3 preambles", 97: "sensor temperature drift", 112: "address bit flip on the wire",
             117: "address bit flip on the wire", 134: "capture truncated"}
    same = differ = 0
    with serial.Serial(port_name, 1200, bytesize=8, parity=serial.PARITY_ODD, stopbits=1, timeout=0.05) as port:
        # Pre-capture identity (written by the SECONDARY master so the primary
        # master's Cold Start bit survives), as in hart_ld301_test's replay.
        tag_desc_date = packed("TAG", 8) + packed("16 CHARACTERES", 16) + bytes([0x82, 0x08, 0x20])
        for command, data in ((18, tag_desc_date), (17, packed("32 CHARACTERES", 32))):
            port.write(request_frame(command, data, primary=False))
            read_reply(port)
        for index, (request, captured) in enumerate(exchanges):
            port.reset_input_buffer()
            port.write(request)
            reply = read_reply(port)
            if frame_of(reply) == frame_of(captured):
                same += 1
                continue
            differ += 1
            note = known.get(index, "UNEXPECTED")
            print(f"#{index:03d} {note}\n  sent      {request.hex(' ')}\n  captured  {bytes(captured).hex(' ')}\n  simulated {reply.hex(' ')}")
    print(f"serial replay over {port_name}: {len(exchanges)} requests, {same} frames identical to the capture, {differ} differing")
    unexpected = differ - sum(1 for i in known if i < len(exchanges))
    return 0 if unexpected <= 0 else 1


if __name__ == "__main__":
    sys.exit(main())
