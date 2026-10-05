import * as fs from "fs";
import * as path from "path";
import { manifestHartDeviceComponentId } from "../hart/hartManifest";
import { assert, createTestRunner } from "../ipc/testSupport/MockCoreServer";
import { loadUnifiedCatalog } from "./UnifiedCatalog";
import { buildPaletteTree, PaletteTreeNode } from "../ui/webview/paletteTree";

// The standard HART field device is the base every transmitter is built
// from; LD301 is the subcircuit subcircuits/hart_smar_ld301 (the old built-in
// LD301 type stays registered, hidden, so saved projects still open).
const smarTypeIds = ["protocol.hart.device.standard", "protocol.hart.device.smar_tt301", "protocol.hart.device.smar_fy301"];

function findFolder(nodes: PaletteTreeNode[], label: string): Extract<PaletteTreeNode, { kind: "folder" }> | undefined {
  return nodes.find((node): node is Extract<PaletteTreeNode, { kind: "folder" }> => node.kind === "folder" && node.label === label);
}

(async () => {
  const { test, finish } = createTestRunner("HART SMAR devices in the real palette pipeline");
  const extensionRoot = path.resolve(__dirname, "../..");
  const { catalog } = loadUnifiedCatalog(extensionRoot, "pt-BR");

  await test("the standard HART device, TT301 and FY301 are enabled entries in the shared HART folder", () => {
    for (const typeId of smarTypeIds) {
      const matches = catalog.filter((entry) => entry.typeId === typeId);
      assert(matches.length === 1, `esperava exatamente uma entrada para ${typeId}`);
      const entry = matches[0];
      if (!entry) throw new Error(`entrada ausente: ${typeId}`);
      assert(entry.workspaceSection === "process", `${typeId} deveria pertencer a Processo`);
      assert(JSON.stringify(entry.folderPath) === JSON.stringify(["Protocolos Industriais", "HART"]), `${typeId} deveria reutilizar a pasta HART`);
      assert(!entry.disabled, `${typeId} não deveria estar desabilitado`);
    }
  });

  await test("the Process palette has one HART folder containing the HART devices", () => {
    const industrial = findFolder(buildPaletteTree(catalog, "", "process"), "Protocolos Industriais");
    assert(Boolean(industrial), "pasta Protocolos Industriais ausente");
    if (!industrial) throw new Error("pasta Protocolos Industriais ausente");
    const hart = findFolder(industrial.children, "HART");
    assert(Boolean(hart), "pasta HART ausente");
    if (!hart) throw new Error("pasta HART ausente");
    const leafIds = hart.children.filter((node) => node.kind === "component").map((node) => node.typeId);
    for (const typeId of smarTypeIds) assert(leafIds.includes(typeId), `${typeId} ausente da paleta HART`);
  });

  await test("the standard HART device exposes the 4 terminals; the legacy built-in LD301 is hidden", () => {
    const standard = catalog.find((entry) => entry.typeId === "protocol.hart.device.standard");
    assert(JSON.stringify(standard?.pinIds) === JSON.stringify(["sensor_plus", "sensor_minus", "loop_plus", "loop_minus"]), "4 terminais");
    assert(catalog.find((entry) => entry.typeId === "protocol.hart.device.smar_ld301")?.hidden === true, "LD301 legado oculto");
  });

  await test("the HART modem is in the HART folder, wired in series (L+/L-), with the LasecPlot look", () => {
    // The real extension root (extension/), as the app loads it: project/schema/component-catalog.json.
    const realCatalog = loadUnifiedCatalog(path.resolve(__dirname, "../../.."), "pt-BR").catalog;
    const modem = realCatalog.find((entry) => entry.typeId === "protocol.hart.modem");
    assert(Boolean(modem), "Modem HART ausente do catálogo");
    assert(JSON.stringify(modem?.folderPath) === JSON.stringify(["Protocolos Industriais", "HART"]), "pasta HART");
    assert(JSON.stringify(modem?.pinIds) === JSON.stringify(["loop_plus", "loop_minus"]), "dois terminais de laço");
    const repoRoot = path.resolve(__dirname, "../../../..");
    const lasecplot = JSON.parse(fs.readFileSync(path.join(repoRoot, "devices", "simulide-peripherals", "lasecplot.lsdevice"), "utf8"));
    const modemPackage = modem?.package as { shapes?: unknown; width?: number; height?: number } | undefined;
    assert(JSON.stringify(modemPackage?.shapes) === JSON.stringify(lasecplot.package.shapes) &&
           modemPackage?.width === lasecplot.package.width && modemPackage?.height === lasecplot.package.height,
           "mesmo desenho do LasecPlot (LEDs Tx/Rx e botão Abrir)");
  });

  await test("HART reaches a transmitter only through the wire: no serial port in devices, no HART mode in COM/terminal", () => {
    for (const entry of catalog.filter((item) => item.typeId.startsWith("protocol.hart.device."))) {
      const defaults = (entry.defaultProperties ?? {}) as Record<string, unknown>;
      for (const key of ["endpoint", "baudRate", "bus"]) assert(!(key in defaults), `${entry.typeId} não deveria ter ${key}`);
    }
    const repoRoot = path.resolve(__dirname, "../../../..");
    for (const name of ["serialport.lsdevice", "serialterm.lsdevice"]) {
      const text = fs.readFileSync(path.join(repoRoot, "devices", "simulide-peripherals", name), "utf8");
      assert(!/hart/i.test(text), `${name} não deveria ter modo HART`);
    }
    const ld301 = JSON.parse(fs.readFileSync(path.join(repoRoot, "subcircuits", "hart_smar_ld301.lssubcircuit"), "utf8"));
    const inner = (ld301.components as Array<{ id: string; properties: Record<string, unknown> }>).find((component) => component.id === "ld301");
    for (const key of ["endpoint", "baudRate", "bus"]) assert(!(key in (inner?.properties ?? {})), `LD301 não deveria ter ${key}`);
  });

  await test("the LD301 subcircuit wraps one standard HART device that HART transports can target", () => {
    // out-test/src/catalog -> repository root.
    const file = path.resolve(__dirname, "../../../..", "subcircuits", "hart_smar_ld301.lssubcircuit");
    const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    assert(manifestHartDeviceComponentId(manifest) === "ld301", "hartDeviceComponentId do dispositivo interno");
    const pins = (manifest.interface as Array<{ pinId: string }>).map((entry) => entry.pinId);
    assert(JSON.stringify(pins) === JSON.stringify(["sensor_plus", "sensor_minus", "loop_plus", "loop_minus"]), "pinos do subcircuito");
    assert(JSON.stringify(manifest.folderPath) === JSON.stringify(["Protocolos Industriais", "HART"]), "pasta HART");
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();
