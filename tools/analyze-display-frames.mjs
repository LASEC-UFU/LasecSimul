import fs from "node:fs";

const bytes = fs.readFileSync(process.argv[2]);
const raw = bytes.length > 1 && ((bytes[0] === 0xff && bytes[1] === 0xfe) || bytes[1] === 0)
  ? bytes.toString("utf16le")
  : bytes.toString("utf8");
const jsonStart = raw.search(/\r?\n\{\r?\n\s*"fixture"/);
if (jsonStart < 0) throw new Error("benchmark JSON not found");
const jsonEnd = raw.indexOf("\n[Core]", jsonStart);
const report = JSON.parse(raw.slice(jsonStart, jsonEnd < 0 ? undefined : jsonEnd).trim());
if (process.argv[4]) fs.writeFileSync(process.argv[4], report.qemuLogs ?? "");
const frames = report.display?.timeline?.filter(frame => frame.payloadHex) ?? [];

function pixel(payload, x, y) {
  return (payload[Math.floor(y / 8) * 128 + x] >> (y & 7)) & 1;
}

function bandDifference(left, right, y0, y1, dx) {
  let compared = 0;
  let different = 0;
  for (let y = y0; y < y1; y += 1) {
    for (let x = Math.max(0, -dx); x < Math.min(128, 128 - dx); x += 1) {
      compared += 1;
      if (pixel(left, x, y) !== pixel(right, x + dx, y)) different += 1;
    }
  }
  return different / compared;
}

function bestShift(left, right, y0, y1) {
  let best = { dx: 0, difference: Number.POSITIVE_INFINITY };
  for (let dx = -8; dx <= 8; dx += 1) {
    const difference = bandDifference(left, right, y0, y1, dx);
    if (difference < best.difference) best = { dx, difference };
  }
  return best;
}

const decoded = frames.map(frame => ({ ...frame, payload: Buffer.from(frame.payloadHex, "hex") }));
if (process.argv[3]) {
  fs.mkdirSync(process.argv[3], { recursive: true });
  for (let index = 0; index < decoded.length; index += 1) {
    const image = Buffer.alloc(54 + 128 * 64 * 3);
    image.write("BM", 0, "ascii");
    image.writeUInt32LE(image.length, 2); image.writeUInt32LE(54, 10); image.writeUInt32LE(40, 14);
    image.writeInt32LE(128, 18); image.writeInt32LE(64, 22); image.writeUInt16LE(1, 26);
    image.writeUInt16LE(24, 28); image.writeUInt32LE(128 * 64 * 3, 34);
    for (let y = 0; y < 64; y += 1) {
      for (let x = 0; x < 128; x += 1) {
        const value = pixel(decoded[index].payload, x, y) ? 255 : 0;
        const offset = 54 + ((63 - y) * 128 + x) * 3;
        image[offset] = value; image[offset + 1] = value; image[offset + 2] = value;
      }
    }
    fs.writeFileSync(`${process.argv[3]}/frame-${String(index).padStart(2, "0")}.bmp`, image);
  }
}
const pairs = [];
for (let i = 1; i < decoded.length; i += 1) {
  const previous = decoded[i - 1];
  const current = decoded[i];
  pairs.push({
    frame: i,
    wallDeltaMs: current.wallMs - previous.wallMs,
    line1: bestShift(previous.payload, current.payload, 0, 16),
    line2: bestShift(previous.payload, current.payload, 20, 36),
    line3: bestShift(previous.payload, current.payload, 40, 56),
  });
}

console.log(JSON.stringify({ frames: decoded.length, pairs }, null, 2));
