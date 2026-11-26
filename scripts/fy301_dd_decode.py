"""Decodes a Smar HART DD in the tokenizer binary format 5 (.fms) -- written for the FY301.

Usage:
    python scripts/fy301_dd_decode.py "C:\\Program Files (x86)\\Smar\\HART\\DD\\00003e\\0003" 0202 \
        [--json docs/data/fy301-dd-0202.json] [--markdown]

Reads <rev>.fms (binary DD), <rev>.sym (item names) and shapes.txt (types and sizes of each device
revision / DD revision) and prints, for every COMMAND item, its number, operation and the request
and reply data items (variable, type, size), plus the enumerations of the variables. The format was
reverse engineered for docs/fy301-dtm-engenharia-reversa.md:

- object:   index(2) 02 00 00 00 00 80 00 FF FF FF FF  length(4)  type(1) 00  itemId(4)  attributes...
            type 1 VARIABLE, 2 COMMAND, 3 MENU, 4 EDIT_DISPLAY, 5 METHOD, 9 ITEM_ARRAY, 10 COLLECTION
- integers: 7-bit groups, high bit = continuation ("81 18" = 152)
- COMMAND:  mask 0F, then attributes tag/length/value: 00 NUMBER, 01 OPERATION (1 read, 2 write,
            3 command), 02 TRANSACTION (AA len, transaction number, 00 request / 01 reply, each
            CE len 82 len + data items), 03 RESPONSE_CODES
- data item: 01 0C <id> reference; 02 0C <id> <flags>; 03 0C <id> <mask>; 00 <value> constant
- strings:  count, then (length, "|en|text") after "|en|<manufacturer>"; a string reference is
            00 3E <type> <dev rev> <dd rev> <index>
"""
import argparse
import json
import os
import re
import struct
import sys


def varint(data, i):
    value = 0
    while True:
        c = data[i]
        i += 1
        value = (value << 7) | (c & 0x7F)
        if not c & 0x80:
            return value, i


def objects(data):
    out = {}
    for match in re.finditer(rb"\x80\x00\xff\xff\xff\xff", data):
        p = match.start()
        length = struct.unpack(">I", data[p + 6:p + 10])[0]
        kind = data[p + 10]
        item_id = struct.unpack(">I", data[p + 12:p + 16])[0]
        out[item_id] = {"type": kind, "body": data[p + 16:p + 10 + length]}
    return out


def symbols(path):
    out = {}
    for line in open(path, encoding="latin-1"):
        parts = line.split()
        numbers = [x for x in parts if x.isdigit()]
        if len(parts) >= 3 and numbers:
            out[int(numbers[-1])] = (parts[0], parts[1])
    return out


def shapes(path, device_rev, dd_rev):
    out, active = {}, False
    for line in open(path, encoding="latin-1"):
        if line.startswith("Device Rev"):
            active = line.strip() == f"Device Rev {device_rev}, DD Rev {dd_rev}"
            continue
        parts = line.split()
        if active and len(parts) >= 4 and parts[0].isdigit():
            out[int(parts[0])] = (parts[1], parts[2], int(parts[3]))
    return out


def strings(data):
    start = data.find(b"|en|") - 1
    j = start - 1
    while data[j - 1] & 0x80:
        j -= 1
    count, i = varint(data, j)
    out = []
    for _ in range(count):
        n, i = varint(data, i)
        out.append(data[i:i + n].decode("latin-1").rstrip("\0").replace("|en|", ""))
        i += n
    return out


def data_items(block):
    items, i = [], 0
    while i < len(block):
        kind = block[i]
        i += 1
        if kind in (1, 2, 3, 4) and i < len(block) and block[i] == 0x0C:
            item_id, i = varint(block, i + 1)
            if kind in (2, 3):
                _, i = varint(block, i)
            items.append(("ref", item_id))
        elif kind == 0:
            value, i = varint(block, i)
            items.append(("const", value))
        else:
            items.append(("expr", block[i - 1:].hex(" ")))
            break
    return items


def command(body):
    attributes, i = {}, 1
    while i < len(body):
        tag = body[i]
        length, j = varint(body, i + 1)
        attributes[tag] = body[j:j + length]
        i = j + length
    number_bytes = attributes[0]
    number = varint(number_bytes, len(number_bytes) - 2 if number_bytes[-2] & 0x80 else len(number_bytes) - 1)[0]
    operation = {1: "READ", 2: "WRITE", 3: "COMMAND"}.get(attributes[1][-1], "?")
    request, reply = [], []
    transaction = attributes.get(2, b"")
    if transaction[:1] == b"\xaa":
        _, k = varint(transaction, 1)
        _, k = varint(transaction, k)
        while k < len(transaction):
            section = transaction[k]
            k += 1
            if transaction[k] != 0xCE:
                break
            length, k = varint(transaction, k + 1)
            sub = transaction[k:k + length]
            k += length
            inner, m = varint(sub, 1)
            (request if section == 0 else reply).extend(data_items(sub[m:m + inner]))
    return number, operation, request, reply


def enumerations(body, table, mfr_dev_dd):
    out = {}
    pattern = rb"\xcd.\x00((?:[\x80-\xff])*[\x00-\x7f])\x03\x00" + re.escape(mfr_dev_dd) + rb"((?:[\x80-\xff])*[\x00-\x7f])"
    for match in re.finditer(pattern, body, re.S):
        value = varint(match.group(1), 0)[0]
        index = varint(match.group(2), 0)[0]
        out[value] = table[index] if index < len(table) else f"#{index}"
    return out


def label(body, table, mfr_dev_dd):
    match = re.search(rb"\x03.\x82.\x00" + re.escape(mfr_dev_dd) + rb"((?:[\x80-\xff])*[\x00-\x7f])", body, re.S)
    if not match:
        return ""
    index = varint(match.group(1), 0)[0]
    return table[index] if index < len(table) else f"#{index}"


def decode(directory, revision):
    data = open(os.path.join(directory, f"{revision}.fms"), "rb").read()
    device_rev, dd_rev = int(revision[:2]), int(revision[2:])
    names = symbols(os.path.join(directory, f"{revision}.sym"))
    types = shapes(os.path.join(directory, "shapes.txt"), device_rev, dd_rev)
    table = strings(data)
    header = data[16:23]   # manufacturer (3), device type (2), device revision, DD revision
    mfr_dev_dd = bytes([header[2], header[4], header[5], header[6]])
    items = objects(data)
    variables = {}
    for item_id, obj in items.items():
        if obj["type"] == 1:
            kind = types.get(item_id)
            variables[item_id] = {"name": names.get(item_id, ("", f"id{item_id}"))[1],
                                  "type": kind[1] if kind else "?", "size": kind[2] if kind else None,
                                  "label": label(obj["body"], table, mfr_dev_dd),
                                  "enum": enumerations(obj["body"], table, mfr_dev_dd)}
    commands = []
    for item_id, obj in items.items():
        if obj["type"] != 2:
            continue
        try:
            number, operation, request, reply = command(obj["body"])
        except (IndexError, KeyError):
            continue
        commands.append({"number": number, "name": names.get(item_id, ("", "?"))[1], "operation": operation,
                         "request": request, "reply": [x for x in reply if not (x[0] == "ref" and x[1] in (150, 151))]})
    commands.sort(key=lambda c: c["number"])
    return commands, variables


def describe(items, variables):
    out = []
    for kind, value in items:
        if kind == "ref":
            v = variables.get(value)
            out.append(f"{v['name']} ({v['type']} {v['size']})" if v else f"std#{value}")
        elif kind == "const":
            out.append(f"const {value}")
        else:
            out.append(f"[expr {value}]")
    return ", ".join(out)


def main():
    parser = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    parser.add_argument("directory")
    parser.add_argument("revision", help="device revision + DD revision, e.g. 0202")
    parser.add_argument("--json")
    parser.add_argument("--markdown", action="store_true")
    args = parser.parse_args()
    commands, variables = decode(args.directory, args.revision)
    if args.json:
        with open(args.json, "w", encoding="utf-8", newline="\n") as handle:
            json.dump({"commands": commands, "variables": {str(k): v for k, v in sorted(variables.items())}},
                      handle, ensure_ascii=False, indent=1)
            handle.write("\n")
    if args.markdown:
        print("| Cmd | Operação | Nome no DD | Requisição | Resposta |\n|---|---|---|---|---|")
        for c in commands:
            print(f"| {c['number']} | {c['operation']} | `{c['name']}` | {describe(c['request'], variables) or '—'} | "
                  f"{describe(c['reply'], variables) or '—'} |")
    else:
        for c in commands:
            print(f"Cmd {c['number']:3d} {c['operation']:7s} {c['name']}")
            print(f"    request: {describe(c['request'], variables)}")
            print(f"    reply:   {describe(c['reply'], variables)}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
