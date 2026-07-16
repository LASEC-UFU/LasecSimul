import * as fs from "fs";
import * as path from "path";
import { assert, createTestRunner } from "../ipc/testSupport/MockCoreServer";
const { test, finish } = createTestRunner("LasecPlot manifest");
const manifestPath = path.resolve(__dirname, "../../../../devices/simulide-peripherals/lasecplot.lsdevice");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const serial = JSON.parse(fs.readFileSync(path.join(path.dirname(manifestPath), "serialterm.lsdevice"), "utf8"));
(async () => {
await test("é registrado como LasecPlot", () => assert(manifest.typeId === "peripherals.lasecplot" && manifest.name === "LasecPlot", "identidade inválida"));
await test("possui exclusivamente TX e RX, sem alimentação", () => { assert(manifest.pins.map((pin: { id: string }) => pin.id).join(",") === "tx,rx", "pinos devem ser tx,rx"); assert(!manifest.pins.some((pin: { id: string }) => /^(gnd|vcc|3v3|5v)$/i.test(pin.id)), "pino de alimentação encontrado"); assert(manifest.pins[0].kind === "DIGITAL_OUT" && manifest.pins[1].kind === "DIGITAL_IN", "direções inválidas"); });
await test("reutiliza posição/orientação do Serial Terminal", () => assert(JSON.stringify(manifest.package.pins) === JSON.stringify(serial.package.pins), "layout dos terminais divergiu do Serial Terminal"));
await test("expõe somente configurações com efeito real", () => { const ids = new Set(manifest.properties.map((property: { id: string }) => property.id)); for (const id of ["source_name", "baudrate", "data_bits", "stop_bits", "mode", "expose"]) assert(ids.has(id), `propriedade ausente: ${id}`); assert(!ids.has("parity"), "paridade sem implementação real não deve ser exibida"); });
const { failed } = finish(); process.exitCode = failed > 0 ? 1 : 0;
})();
