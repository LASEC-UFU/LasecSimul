import * as fs from "fs";
import * as path from "path";
import { manifestHartDeviceComponentId } from "../hart/hartManifest";
import { assert, createTestRunner } from "../ipc/testSupport/MockCoreServer";
import { loadUnifiedCatalog } from "./UnifiedCatalog";
import { sanitizePackage } from "./packageSanitizers";
import { buildPaletteTree, PaletteTreeNode } from "../ui/webview/paletteTree";
import { livePackagePreviewSymbolSvg } from "../ui/webview/componentSymbols";

// The standard HART field device is the base every transmitter is built
// from; LD301, TT301 and FY301 are the subcircuits subcircuits/hart_smar_ld301,
// hart_smar_tt301 and hart_smar_fy301 (the old built-in types stay registered,
// hidden, so saved projects still open).
const smarTypeIds = ["protocol.hart.device.standard"];

function findFolder(nodes: PaletteTreeNode[], label: string): Extract<PaletteTreeNode, { kind: "folder" }> | undefined {
  return nodes.find((node): node is Extract<PaletteTreeNode, { kind: "folder" }> => node.kind === "folder" && node.label === label);
}

(async () => {
  const { test, finish } = createTestRunner("HART SMAR devices in the real palette pipeline");
  const extensionRoot = path.resolve(__dirname, "../..");
  const { catalog } = loadUnifiedCatalog(extensionRoot, "pt-BR");

  await test("the standard HART device is an enabled entry in the shared HART folder", () => {
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
    assert(catalog.find((entry) => entry.typeId === "protocol.hart.device.smar_tt301")?.hidden === true, "TT301 legado oculto");
    assert(catalog.find((entry) => entry.typeId === "protocol.hart.device.smar_fy301")?.hidden === true, "FY301 legado oculto");
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
    for (const [file, id] of [["hart_smar_ld301.lssubcircuit", "ld301"], ["hart_smar_tt301.lssubcircuit", "tt301"]] as const) {
      const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "subcircuits", file), "utf8"));
      const inner = (manifest.components as Array<{ id: string; properties: Record<string, unknown> }>).find((component) => component.id === id);
      for (const key of ["endpoint", "baudRate", "bus"]) assert(!(key in (inner?.properties ?? {})), `${id} não deveria ter ${key}`);
    }
  });

  await test("the LD301 subcircuit wraps one standard HART device that HART transports can target", () => {
    // out-test/src/catalog -> repository root.
    const file = path.resolve(__dirname, "../../../..", "subcircuits", "hart_smar_ld301.lssubcircuit");
    const manifest = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
    assert(manifestHartDeviceComponentId(manifest) === "ld301", "hartDeviceComponentId do dispositivo interno");
    const pins = (manifest.interface as Array<{ pinId: string }>).map((entry) => entry.pinId);
    assert(JSON.stringify(pins) === JSON.stringify(["high", "low", "loop_plus", "loop_minus"]), "entradas diferenciais por sinal e bornes elétricos do laço");
    assert(JSON.stringify(manifest.folderPath) === JSON.stringify(["Protocolos Industriais", "HART"]), "pasta HART");
  });

  await test("LD301 uses its packaged SVG on the schematic and in the palette", () => {
    const subcircuitsDir = path.resolve(__dirname, "../../../..", "subcircuits");
    const manifest = JSON.parse(fs.readFileSync(path.join(subcircuitsDir, "hart_smar_ld301.lssubcircuit"), "utf8"));
    const symbol = sanitizePackage(manifest.symbol, subcircuitsDir);
    const artwork = fs.readFileSync(path.join(subcircuitsDir, "ld301.svg"));
    const image = symbol?.shapes?.find((shape) => shape.kind === "image");
    const prefix = "data:image/svg+xml;base64,";
    assert(Boolean(image?.href?.startsWith(prefix)), "forma vetorial do símbolo");
    assert(Buffer.from(image?.href?.slice(prefix.length) ?? "", "base64").equals(artwork), "símbolo usa o SVG empacotado");
    assert(manifest.iconPath === "./ld301.svg", "paleta aponta para o mesmo SVG empacotado");
    const preview = livePackagePreviewSymbolSvg(symbol!);
    assert(preview.svg.includes(prefix), "prévia do esquemático desenha o SVG");
    assert(symbol?.pins.length === 4 && symbol.pins[0]?.id === "high" && symbol.pins[1]?.id === "low", "HIGH e LOW como sinais independentes");
    assert(manifest.name === "SMAR LD301", "nome do transmissor sem sufixo redundante");
    const projectCatalog = JSON.parse(fs.readFileSync(path.join(subcircuitsDir, "..", "project", "schema", "component-catalog.json"), "utf8"));
    const standard = projectCatalog.items.find((entry: { typeId: string }) => entry.typeId === "protocol.hart.device.standard")?.package;
    const display = manifest.exposedComponents.find((entry: { componentId: string }) => entry.componentId === "ld301");
    assert(Boolean(display && standard), "LCD e posição exposta presentes");
    assert(display.y + standard!.height < image!.y!, "LCD acima da imagem, sem sobreposição");
    assert(Boolean(standard!.shapes?.every((shape: { kind: string }) => shape.kind !== "text")), "LCD sem inscrição HART");
    const glass = standard!.shapes?.[1];
    assert(Boolean(glass?.kind === "rect" && glass.x === 5 && glass.y === 5 &&
      standard!.width - glass.x - glass.w! === 5 && standard!.height - glass.y - glass.h! === 5),
      "borda do LCD com a mesma espessura nos quatro lados");
    const screenPreview = livePackagePreviewSymbolSvg(standard!);
    assert(!screenPreview.svg.includes("terminal-clip"), "terminais não recortam as laterais do LCD");
    assert(display.x + screenPreview.offsetX === 31, "LCD centralizado sobre o transmissor");
  });

  await test("the TT301 subcircuit wraps one standard HART device, with the sensor terminals 1-4 and the loop terminals", () => {
    const subcircuitsDir = path.resolve(__dirname, "../../../..", "subcircuits");
    const manifest = JSON.parse(fs.readFileSync(path.join(subcircuitsDir, "hart_smar_tt301.lssubcircuit"), "utf8")) as Record<string, unknown>;
    assert(manifestHartDeviceComponentId(manifest) === "tt301", "hartDeviceComponentId do dispositivo interno");
    const pins = (manifest.interface as Array<{ pinId: string; domain: string }>).map((entry) => `${entry.pinId}:${entry.domain}`);
    assert(JSON.stringify(pins) === JSON.stringify(["s1:electrical", "s2:electrical", "s3:electrical", "s4:electrical", "loop_plus:electrical", "loop_minus:electrical"]),
      "bornes 1-4 do sensor (RTD a 2, 3 ou 4 fios) e bornes elétricos do laço");
    assert(JSON.stringify(manifest.folderPath) === JSON.stringify(["Protocolos Industriais", "HART"]), "pasta HART");
    assert(manifest.name === "SMAR TT301", "nome do transmissor");
    const library = JSON.parse(fs.readFileSync(path.join(subcircuitsDir, "library.json"), "utf8")) as { subcircuits: Array<{ typeId: string; manifest: string }> };
    assert(library.subcircuits.some((entry) => entry.typeId === "subcircuits.hart.smar_tt301" && entry.manifest === "hart_smar_tt301.lssubcircuit"),
      "TT301 publicado na biblioteca de subcircuitos");
  });

  await test("TT301 uses its packaged SVG on the schematic and in the palette, with the LCD above it", () => {
    const subcircuitsDir = path.resolve(__dirname, "../../../..", "subcircuits");
    const manifest = JSON.parse(fs.readFileSync(path.join(subcircuitsDir, "hart_smar_tt301.lssubcircuit"), "utf8"));
    const symbol = sanitizePackage(manifest.symbol, subcircuitsDir);
    const artwork = fs.readFileSync(path.join(subcircuitsDir, "tt301.svg"));
    const image = symbol?.shapes?.find((shape) => shape.kind === "image");
    const prefix = "data:image/svg+xml;base64,";
    assert(Buffer.from(image?.href?.slice(prefix.length) ?? "", "base64").equals(artwork), "símbolo usa o SVG empacotado");
    assert(manifest.iconPath === "./tt301.svg", "paleta aponta para o mesmo SVG empacotado");
    assert(symbol?.pins.map((pin) => pin.id).join(",") === "s1,s2,s3,s4,loop_plus,loop_minus", "bornes 1-4 do sensor, LOOP+ e LOOP-");
    const projectCatalog = JSON.parse(fs.readFileSync(path.join(subcircuitsDir, "..", "project", "schema", "component-catalog.json"), "utf8"));
    const standard = projectCatalog.items.find((entry: { typeId: string }) => entry.typeId === "protocol.hart.device.standard")?.package;
    const display = manifest.exposedComponents.find((entry: { componentId: string }) => entry.componentId === "tt301");
    assert(Boolean(display && standard), "LCD e posição exposta presentes");
    assert(display.y + standard!.height < image!.y!, "LCD acima da imagem, sem sobreposição");
    assert(display.x + livePackagePreviewSymbolSvg(standard!).offsetX === 31, "LCD centralizado sobre o transmissor");
    const inner = manifest.components.find((component: { id: string }) => component.id === "tt301");
    assert(inner?.properties?.displayModelName === "TT301", "identificação TT301 no LCD");
  });

  await test("the FY301 subcircuit is a loop-powered positioner on one standard HART device: SUP/OUT1/POS and LOOP+/LOOP-", () => {
    const subcircuitsDir = path.resolve(__dirname, "../../../..", "subcircuits");
    const manifest = JSON.parse(fs.readFileSync(path.join(subcircuitsDir, "hart_smar_fy301.lssubcircuit"), "utf8"));
    assert(manifestHartDeviceComponentId(manifest) === "fy301", "hartDeviceComponentId do dispositivo interno");
    const pins = (manifest.interface as Array<{ pinId: string; domain: string }>).map((entry) => `${entry.pinId}:${entry.domain}`);
    assert(JSON.stringify(pins) === JSON.stringify(["supply:signal", "out1:signal", "position:signal", "loop_plus:electrical", "loop_minus:electrical"]),
      "suprimento, OUT1 e posição (sinais) e os bornes do laço (elétricos)");
    assert(JSON.stringify(manifest.folderPath) === JSON.stringify(["Protocolos Industriais", "HART"]) && manifest.name === "SMAR FY301", "pasta HART e nome");
    const inner = manifest.components.find((component: { id: string }) => component.id === "fy301");
    assert(inner?.properties?.analogLoopDirection === "input" && inner?.properties?.analogInputResistance === 550,
      "lê o 4-20 mA (entrada, carga de 550 ohm)");
    assert(inner?.properties?.displayModelName === "FY301", "identificação FY301 no LCD");
    const symbol = sanitizePackage(manifest.symbol, subcircuitsDir);
    const image = symbol?.shapes?.find((shape) => shape.kind === "image");
    const artwork = fs.readFileSync(path.join(subcircuitsDir, "fy301.svg"));
    assert(Buffer.from(image?.href?.slice("data:image/svg+xml;base64,".length) ?? "", "base64").equals(artwork), "símbolo usa o SVG empacotado");
    assert((image?.x ?? 0) >= 8 && (image?.x ?? 0) + (image?.w ?? 0) <= (symbol?.width ?? 0) - 8, "imagem dentro das margens dos pinos (não é cortada)");
    const display = manifest.exposedComponents.find((entry: { componentId: string }) => entry.componentId === "fy301");
    assert(Boolean(display) && display.y < (image?.y ?? 0), "LCD acima da imagem");
    const library = JSON.parse(fs.readFileSync(path.join(subcircuitsDir, "library.json"), "utf8")) as { subcircuits: Array<{ typeId: string; manifest: string }> };
    assert(library.subcircuits.some((entry) => entry.typeId === "subcircuits.hart.smar_fy301" && entry.manifest === "hart_smar_fy301.lssubcircuit"),
      "FY301 publicado na biblioteca de subcircuitos");
  });

  await test("the legacy TT301 and FY301 built-ins load their SVG artwork, LCD and four Core terminals", () => {
    const repoRoot = path.resolve(__dirname, "../../../..");
    const realCatalog = loadUnifiedCatalog(path.join(repoRoot, "extension"), "pt-BR").catalog;
    const prefix = "data:image/svg+xml;base64,";
    for (const [typeId, artworkName, modelName] of [
      ["protocol.hart.device.smar_tt301", "tt301.svg", "TT301"],
      ["protocol.hart.device.smar_fy301", "fy301.svg", "FY301"],
    ] as const) {
      const entry = realCatalog.find((candidate) => candidate.typeId === typeId);
      const artwork = fs.readFileSync(path.join(repoRoot, "subcircuits", artworkName));
      const image = entry?.package?.shapes?.find((shape) => shape.kind === "image");
      assert(Boolean(entry?.graphical && image?.href?.startsWith(prefix)), `${modelName}: arte SVG no esquema`);
      assert(Buffer.from(image?.href?.slice(prefix.length) ?? "", "base64").equals(artwork), `${modelName}: SVG original empacotado`);
      assert(entry?.iconFilePath === path.join(repoRoot, "subcircuits", artworkName), `${modelName}: ícone da paleta`);
      assert(JSON.stringify(entry?.pinIds) === JSON.stringify(["sensor_plus", "sensor_minus", "loop_plus", "loop_minus"]),
        `${modelName}: terminais usados pelo Core`);
      assert(entry?.package?.pins?.length === 4, `${modelName}: quatro pinos desenhados`);
      assert(entry?.package?.runtimeState?.surface?.encoding === "segment-lcd", `${modelName}: LCD dinâmico`);
      const glass = entry?.package?.shapes?.[1];
      assert(Boolean(glass?.kind === "rect" && glass.x === 36 && glass.y === 9 && glass.w === 78 && glass.h === 48),
        `${modelName}: borda uniforme do LCD`);
      assert(Boolean(image?.y !== undefined && 4 + 58 < image.y), `${modelName}: LCD separado acima do transmissor`);
      assert(entry?.defaultProperties?.displayModelName === modelName, `${modelName}: identificação no LCD`);
      const preview = livePackagePreviewSymbolSvg(entry!.package!);
      assert(preview.svg.includes(prefix), `${modelName}: prévia renderiza o SVG`);
      assert(!preview.svg.includes("terminal-clip"), `${modelName}: arte não cortada pelos terminais`);
    }
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();
