"""Reconstruct the captured LD301 HART session from serial requests and UDP chunks.

Usage: python scripts/ld301_decode.py [log.txt] [decoded.csv]
The CSV keeps raw request/response frames and parsed payloads for every exchange.
No UDP chunk is treated as an independent HART frame.
"""

import csv
import re
import sys
from pathlib import Path


LINE = re.compile(r"\] (SERIAL RX|UDP RX) \((\d+) bytes\): (.*)")
HEX = re.compile(r"(?<![0-9A-F])[0-9A-F]{2}(?![0-9A-F])")


def decode_frame(raw):
    preambles = 0
    while preambles < len(raw) and raw[preambles] == 0xFF:
        preambles += 1
    if preambles == len(raw):
        raise ValueError("only preambles")
    delimiter = raw[preambles]
    address_width = 5 if delimiter & 0x80 else 1
    command_at = preambles + 1 + address_width
    if command_at + 2 > len(raw):
        raise ValueError("short header")
    count = raw[command_at + 1]
    payload_at = command_at + 2
    end = payload_at + count + 1
    if end > len(raw):
        raise ValueError("truncated frame")
    frame = raw[preambles:end]
    xor = 0
    for byte in frame:
        xor ^= byte
    return {
        "preambles": preambles,
        "delimiter": f"{delimiter:02X}",
        "address": raw[preambles + 1:command_at].hex(" ").upper(),
        "command": f"{raw[command_at]:02X}",
        "byte_count": count,
        "data": raw[payload_at:payload_at + count].hex(" ").upper(),
        "checksum": f"{raw[end - 1]:02X}",
        "checksum_valid": xor == 0,
        "complete": end == len(raw),
        "extra_bytes": raw[end:].hex(" ").upper(),
        "frame": raw[:end].hex(" ").upper(),
    }


def read_exchanges(path):
    exchanges = []
    for line in Path(path).read_text(encoding="utf-8", errors="replace").splitlines():
        match = LINE.search(line)
        if not match:
            continue
        chunk = bytes(int(token, 16) for token in HEX.findall(match[3]))
        anomaly = "" if len(chunk) == int(match[2]) else f"incomplete hex in logged chunk: {line}"
        if match[1] == "SERIAL RX":
            exchanges.append([chunk, bytearray(), 0, [anomaly] if anomaly else []])
        elif exchanges:
            exchanges[-1][1].extend(chunk)
            exchanges[-1][2] += 1
            if anomaly:
                exchanges[-1][3].append(anomaly)
    return exchanges


def decoded_rows(path):
    for index, (request, udp, chunks, anomalies) in enumerate(read_exchanges(path)):
        req = decode_frame(request)
        try:
            resp = decode_frame(udp)
            response_error = ""
        except ValueError as exc:
            resp = None
            response_error = str(exc)
        row = {"index": index, "udp_chunks": chunks, "log_anomalies": " | ".join(anomalies),
               "request_frame": request.hex(" ").upper(),
               "udp_reassembled": udp.hex(" ").upper(), "response_parse_error": response_error}
        for prefix, frame in (("request", req), ("response", resp)):
            if frame:
                row.update({f"{prefix}_{key}": value for key, value in frame.items()})
        if resp and resp["byte_count"] >= 2:
            data = bytes.fromhex(resp["data"])
            row["response_code"] = f"{data[0]:02X}"
            row["device_status"] = f"{data[1]:02X}"
            row["response_body"] = data[2:].hex(" ").upper()
        yield row


def main():
    source = Path(sys.argv[1]) if len(sys.argv) > 1 else Path("core/test/core/protocols/fixtures/ld301_capture.txt")
    target = Path(sys.argv[2]) if len(sys.argv) > 2 else Path("docs/ld301-session.csv")
    rows = list(decoded_rows(source))
    target.parent.mkdir(parents=True, exist_ok=True)
    fields = list(dict.fromkeys(key for row in rows for key in row))
    with target.open("w", encoding="utf-8", newline="") as stream:
        writer = csv.DictWriter(stream, fieldnames=fields)
        writer.writeheader()
        writer.writerows(rows)
    commands = sorted({row["request_command"] for row in rows})
    good = sum(row.get("response_checksum_valid") is True and row.get("response_complete") is True for row in rows)
    print(f"{len(rows)} exchanges; {len(commands)} commands; {good} complete responses with valid XOR")
    print("commands: " + " ".join(commands))
    print(f"CSV: {target}")


if __name__ == "__main__":
    main()
