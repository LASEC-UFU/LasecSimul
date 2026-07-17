import * as fs from "fs";
import * as path from "path";
import { assert, createTestRunner } from "../ipc/testSupport/MockCoreServer";
const { test, finish } = createTestRunner("LasecPlot manifest");
const manifestPath = path.resolve(__dirname, "../../../../devices/simulide-peripherals/lasecplot.lsdevice");
const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8"));
const serial = JSON.parse(fs.readFileSync(path.join(path.dirname(manifestPath), "serialterm.lsdevice"), "utf8"));
const serialPort = JSON.parse(fs.readFileSync(path.join(path.dirname(manifestPath), "serialport.lsdevice"), "utf8"));
const webviewDir = path.resolve(__dirname, "../../../src/ui/webview");
const webviewStyles = fs.readFileSync(path.join(webviewDir, "styles.css"), "utf8");
const webviewMain = fs.readFileSync(path.join(webviewDir, "main.ts"), "utf8");
const extensionManifest = JSON.parse(fs.readFileSync(path.resolve(webviewDir, "../../../package.json"), "utf8"));
(async () => {
await test("é registrado como LasecPlot", () => assert(manifest.typeId === "peripherals.lasecplot" && manifest.name === "LasecPlot", "identidade inválida"));
await test("possui exclusivamente TX e RX, sem alimentação", () => { assert(manifest.pins.map((pin: { id: string }) => pin.id).join(",") === "tx,rx", "pinos devem ser tx,rx"); assert(!manifest.pins.some((pin: { id: string }) => /^(gnd|vcc|3v3|5v)$/i.test(pin.id)), "pino de alimentação encontrado"); assert(manifest.pins[0].kind === "DIGITAL_OUT" && manifest.pins[1].kind === "DIGITAL_IN", "direções inválidas"); });
await test("reutiliza posição/orientação do Serial Terminal", () => assert(JSON.stringify(manifest.package.pins) === JSON.stringify(serial.package.pins), "layout dos terminais divergiu do Serial Terminal"));
await test("LasecPlot e Serial Terminal compartilham a mesma carcaça visual do SimulIDE", () => {
  for (const field of ["width", "height", "shapes", "pinLabelColor"])
    assert(JSON.stringify(manifest.package[field]) === JSON.stringify(serial.package[field]), `carcaça divergiu em ${field}`);
});
await test("paleta e estados visuais pertencem aos .lsdevice", () => {
  for (const device of [manifest, serial, serialPort]) {
    assert(device.package.shapes[0].fill === "#00008b", `${device.typeId}: corpo fora da paleta SimulIDE`);
    assert(device.package.shapes[0].stroke === "#00006b", `${device.typeId}: contorno fora da paleta SimulIDE`);
    assert(device.package.shapes[3].fill === "#c0c0c0", `${device.typeId}: botão fora da paleta SimulIDE`);
    assert(device.package.pinLabelColor === "#FAFAC8", `${device.typeId}: rótulo de pino fora da paleta SimulIDE`);
    assert(device.package.shapes[1].stateFill?.map?.active === "#ffff00", `${device.typeId}: estado TX não declarado no manifesto`);
    assert(device.package.shapes[2].stateFill?.map?.idle === "#ff0000", `${device.typeId}: estado RX não declarado no manifesto`);
    assert(device.package.shapes[4].stateText?.prop === "__serial_button_label", `${device.typeId}: texto do botão não declarativo`);
  }
});
await test("CSS e runtime não sobrescrevem a aparência declarada pelos .lsdevice", () => {
  assert(!/serial-toggle-hit-zone\s*\{/.test(webviewStyles), "CSS não pode estilizar a aparência do botão serial declarado no manifesto");
  assert(!/(?:serialterm|serialport|lasecplot)[^\{]*\{[^}]*\b(?:fill|stroke|color)\s*:/is.test(webviewStyles), "CSS específico de dispositivo está substituindo cores do manifesto");
  assert(!/setAttribute\(\s*["'](?:fill|stroke|font-size)["']/.test(webviewMain), "runtime não pode substituir atributos visuais vindos do manifesto");
  assert(!/component__symbol--fixed-volt-on/.test(webviewStyles + webviewMain), "estado visual legado em CSS deve permanecer declarativo via stateFill");
});
await test("Serial Terminal também possui somente TX/RX e UART completa", () => {
  assert(serial.pins.map((pin: { id: string }) => pin.id).join(",") === "tx,rx", "Serial Terminal deve possuir somente tx,rx");
  const ids = new Set(serial.properties.map((property: { id: string }) => property.id));
  for (const id of ["baudrate", "data_bits", "stop_bits", "parity", "uart_rx_hex", "uart_tx_hex"]) assert(ids.has(id), `Serial Terminal sem ${id}`);
});
await test("expõe somente configurações com efeito real", () => { const ids = new Set(manifest.properties.map((property: { id: string }) => property.id)); for (const id of ["source_name", "baudrate", "data_bits", "stop_bits", "parity", "mode", "expose"]) assert(ids.has(id), `propriedade ausente: ${id}`); });
await test("Serial Port mantém a interface TX/RX e o ciclo de abertura do SimulIDE", () => {
  assert(serialPort.pins.map((pin: { id: string }) => pin.id).join(",") === "tx,rx", "Serial Port deve possuir somente tx,rx");
  const properties = new Map(serialPort.properties.map((property: { id: string }) => [property.id, property]));
  for (const id of ["port_name", "baudrate", "data_bits", "stop_bits", "auto_open", "port_open", "port_is_open", "port_error"])
    assert(properties.has(id), `Serial Port sem ${id}`);
  assert((properties.get("auto_open") as { default?: unknown }).default === false, "Auto Open deve iniciar desligado como no SimulIDE");
  assert((properties.get("port_is_open") as { readOnly?: unknown }).readOnly === true, "estado aberto deve ser somente leitura");
  assert(serialPort.package.shapes[0].fill === serial.package.shapes[0].fill, "Serial Port usa cor de corpo diferente");
  assert(JSON.stringify(serialPort.package.shapes.slice(1, 5)) === JSON.stringify(serial.package.shapes.slice(1, 5)), "LEDs/botão do Serial Port divergem");
  assert(serialPort.package.pinLabelColor === serial.package.pinLabelColor, "cor dos rótulos do Serial Port diverge");
});
await test("Configurações está habilitado e ação externa usa semântica de importar arquivo", () => {
  const commands = new Map(extensionManifest.contributes.commands.map((command: { command: string }) => [command.command, command]));
  const settings = commands.get("lasecsimul.openSettings") as { enablement?: string } | undefined;
  const external = commands.get("lasecsimul.palette.registerFile") as { title?: string; icon?: string } | undefined;
  assert(settings !== undefined && settings.enablement !== "false", "botão Configurações não pode estar desabilitado");
  assert(external?.title?.includes("Adicionar componente externo") === true, "ação externa ainda usa nome de registro");
  assert(external?.icon === "$(new-file)", "ação externa deve usar ícone de adicionar/importar arquivo");
});
const { failed } = finish(); process.exitCode = failed > 0 ? 1 : 0;
})();
