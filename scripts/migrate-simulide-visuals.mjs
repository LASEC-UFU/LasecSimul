import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { componentBox } from "../extension/out-webview/componentSymbols.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, "..");
const devicesRoot = path.join(root, "devices");
const simulideAssetRoot = path.join(root, ".codex-simulide-src", "src", "icons", "components");

const assetByTypeId = new Map(Object.entries({
  "outputs.ssd1306": "ssd1306.png",
  "outputs.sh1107": "sh1107.png",
  "outputs.hd44780": "hd44780.png",
  "outputs.aip31068_i2c": "aip31068.png",
  "outputs.ili9341": "ili9341.png",
  "outputs.st7735": "st7735.png",
  "outputs.st7789": "st7789.png",
  "outputs.gc9a01a": "gc9a01a.png",
  "outputs.pcf8833": "pcf8833.png",
  "outputs.pcd8544": "pcd8544.png",
  "outputs.ks0108": "ks0108.png",
  "outputs.max72xx_matrix": "max72xx.png",
  "outputs.ws2812": "ws2812.png",
  "outputs.servo": "servo.png",
  "outputs.audio_out": "audio_out.png",
  "passive.transformer": "transformer.png",
  "active.diac": "diac.png",
  "active.scr": "scr.png",
  "active.triac": "triac.png",
  "active.bjt": "bjt.png",
  "active.mosfet": "mosfet.png",
  "active.jfet": "jfet.png",

  "logic.buffer": "buffer.png",
  "logic.and_gate": "andgate.png",
  "logic.or_gate": "orgate.png",
  "logic.xor_gate": "xorgate.png",
  "logic.counter": "2to1.png",
  "logic.bin_counter": "2to3g.png",
  "logic.full_adder": "2to2.png",
  "logic.magnitude_comp": "3to2g.png",
  "logic.shift_reg": "1to3.png",
  "logic.function": "subc.png",
  "logic.flipflop_d": "2to2.png",
  "logic.flipflop_t": "2to2.png",
  "logic.flipflop_rs": "2to2.png",
  "logic.flipflop_jk": "3to2.png",
  "logic.latch_d": "subc.png",
  "logic.memory": "2to3g.png",
  "logic.dynamic_memory": "2to3g.png",
  "logic.i2c_ram": "2to3.png",
  "logic.mux": "mux.png",
  "logic.demux": "demux.png",
  "logic.bcd_to_dec": "2to3g.png",
  "logic.dec_to_bcd": "3to2g.png",
  "logic.bcd_to_7seg": "2to3g.png",
  "logic.i2c_to_parallel": "2to3g.png",
  "logic.adc": "1to3.png",
  "logic.dac": "3to1.png",
  "logic.seven_segment_bcd": "7segbcd.png",
  "logic.lm555": "ic2.png",

  "sensors.ldr": "ldr.png",
  "sensors.thermistor": "thermistor.png",
  "sensors.rtd": "rtd.png",
  "sensors.strain": "strain.png",
  "sensors.sr04": "sr04.svg",
  "sensors.dht22": "dht22.svg",
  "sensors.ds1621": "ic_comp.png",
  "sensors.ds18b20": "ic2_comp.png",

  "peripherals.touchpad": "touch.png",
  "peripherals.ds1307": "dsxxx.png",
  "peripherals.serialterm": "serialterm.png",
  "peripherals.serialport": "serialport.png",
  "peripherals.sdcard": "sdcard.png",
  "peripherals.esp01": "esp01.png",
}));

const preserveManualViewSpec = new Set([
  "peripherals.ky023",
  "peripherals.ky040",
]);

const preferAssetOnlyViewSpec = new Set([
  "peripherals.touchpad",
]);

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, "utf8").replace(/^\uFEFF/, ""));
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

function round(value) {
  return Math.round(value * 1000) / 1000;
}

function cloneJson(value) {
  return JSON.parse(JSON.stringify(value));
}

function isOutputPin(pin) {
  return typeof pin.kind === "string" && pin.kind.includes("_OUT");
}

function isPowerPin(pin) {
  return pin.kind === "POWER" || /^(vcc|vdd|vss|gnd|bat|vbat)$/i.test(pin.id ?? "");
}

function inferHorizontalSide(pin) {
  if (isOutputPin(pin)) return "right";
  return "left";
}

function spacedRows(count, height) {
  return Array.from({ length: count }, (_, index) => round((height / (count + 1)) * (index + 1)));
}

function pinLabel(pin) {
  return typeof pin.label === "string" ? pin.label : String(pin.id ?? "").toUpperCase();
}

function inferAngleFromPosition(pin, width, height) {
  if ((pin.angle === 0 || pin.angle === 180) && typeof pin.angle === "number") return pin.angle;
  if (pin.y <= 0) return 270;
  if (pin.y >= height) return 90;
  if (pin.x <= 0) return 180;
  if (pin.x >= width) return 0;
  return typeof pin.angle === "number" ? pin.angle : 180;
}

function explicitPackagePins(pins, width, height) {
  if (!Array.isArray(pins) || pins.length === 0) return undefined;
  if (!pins.every((pin) => typeof pin.x === "number" && typeof pin.y === "number")) return undefined;

  const minX = Math.min(...pins.map((pin) => pin.x));
  const maxX = Math.max(...pins.map((pin) => pin.x));
  const minY = Math.min(...pins.map((pin) => pin.y));
  const maxY = Math.max(...pins.map((pin) => pin.y));
  const offsetX = minX < 0 && maxX <= width / 2 ? width / 2 : 0;
  const offsetY = minY < 0 && maxY <= height / 2 ? height / 2 : 0;

  return pins.map((pin) => {
    const x = round(pin.x + offsetX);
    const y = round(pin.y + offsetY);
    const candidate = {
      id: pin.id,
      x,
      y,
      angle: typeof pin.angle === "number" ? pin.angle : 180,
      length: typeof pin.length === "number" ? pin.length : 8,
      label: pinLabel(pin),
    };
    candidate.angle = inferAngleFromPosition(candidate, width, height);
    if (typeof pin.labelX === "number") candidate.labelX = round(pin.labelX + offsetX);
    if (typeof pin.labelY === "number") candidate.labelY = round(pin.labelY + offsetY);
    return candidate;
  });
}

function inferredPackagePins(pins, width, height) {
  const left = [];
  const right = [];
  const top = [];
  const bottom = [];

  for (const pin of pins) {
    if (isPowerPin(pin) && /^(vcc|vdd|vbat|bat)$/i.test(pin.id)) top.push(pin);
    else if (isPowerPin(pin) && /^(gnd|vss)$/i.test(pin.id)) bottom.push(pin);
    else if (inferHorizontalSide(pin) === "right") right.push(pin);
    else left.push(pin);
  }

  const result = [];
  for (const [group, side] of [[left, "left"], [right, "right"]]) {
    const rows = spacedRows(group.length, height);
    group.forEach((pin, index) => {
      result.push({
        id: pin.id,
        x: side === "left" ? 0 : width,
        y: rows[index],
        angle: side === "left" ? 180 : 0,
        length: 8,
        label: pinLabel(pin),
      });
    });
  }
  for (const [group, side] of [[top, "top"], [bottom, "bottom"]]) {
    const columns = spacedRows(group.length, width);
    group.forEach((pin, index) => {
      result.push({
        id: pin.id,
        x: columns[index],
        y: side === "top" ? 0 : height,
        angle: side === "top" ? 270 : 90,
        length: 8,
        label: pinLabel(pin),
      });
    });
  }

  const order = new Map(pins.map((pin, index) => [pin.id, index]));
  return result.sort((a, b) => (order.get(a.id) ?? 0) - (order.get(b.id) ?? 0));
}

function existingPackagePins(json) {
  if (!Array.isArray(json.package?.pins) || json.package.pins.length === 0) return undefined;
  return cloneJson(json.package.pins);
}

function packagePinsFor(json, width, height) {
  return existingPackagePins(json)
    ?? explicitPackagePins(json.pins, width, height)
    ?? inferredPackagePins(json.pins ?? [], width, height);
}

function copyAsset(manifestDir, assetFile) {
  const source = path.join(simulideAssetRoot, assetFile);
  if (!fs.existsSync(source)) return false;
  const targetDir = path.join(manifestDir, "assets");
  fs.mkdirSync(targetDir, { recursive: true });
  fs.copyFileSync(source, path.join(targetDir, assetFile));
  return true;
}

function cleanPackageForAsset(json, width, height, assetFile) {
  const previous = json.package && typeof json.package === "object" ? json.package : {};
  const pins = packagePinsFor(json, width, height);
  const nextPackage = {
    ...cloneJson(previous),
    width,
    height,
    border: false,
    background: { kind: "image", asset: `assets/${assetFile}` },
    shapes: [],
    pins,
  };

  if (previous.viewSpec) {
    nextPackage.viewSpec = cloneJson(previous.viewSpec);
    if (preferAssetOnlyViewSpec.has(json.typeId)) {
      nextPackage.viewSpec.paint = [];
      nextPackage.shapes = [];
    }
  }

  if (typeof previous.pinLabelColor === "string") nextPackage.pinLabelColor = previous.pinLabelColor;
  json.package = nextPackage;
}

function migrate() {
  const library = readJson(path.join(devicesRoot, "library.json"));
  const report = {
    updated: [],
    skippedManualViewSpec: [],
    assetNotLocalized: [],
  };

  for (const entry of library.devices ?? []) {
    if (entry.typeId === "example.blinker") continue;
    const manifestPath = path.join(devicesRoot, entry.manifest);
    const json = readJson(manifestPath);
    const typeId = json.typeId;

    if (preserveManualViewSpec.has(typeId)) {
      report.skippedManualViewSpec.push(typeId);
      continue;
    }

    const assetFile = assetByTypeId.get(typeId);
    if (!assetFile) {
      report.assetNotLocalized.push(`${typeId}: mapping nao localizado`);
      continue;
    }
    if (!copyAsset(path.dirname(manifestPath), assetFile)) {
      report.assetNotLocalized.push(`${typeId}: asset ${assetFile} nao localizado`);
      continue;
    }

    const existing = json.package;
    const fallbackBox = componentBox(typeId, {});
    const width = typeof existing?.width === "number" ? existing.width : fallbackBox.width;
    const height = typeof existing?.height === "number" ? existing.height : fallbackBox.height;
    cleanPackageForAsset(json, width, height, assetFile);
    writeJson(manifestPath, json);
    report.updated.push(`${typeId} -> ${assetFile}`);
  }

  console.log(JSON.stringify(report, null, 2));
}

migrate();
