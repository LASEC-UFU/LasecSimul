import * as fs from "fs";
import * as path from "path";
import { createTestRunner, assert } from "../ipc/testSupport/MockCoreServer";
import { TUNNEL_TYPE_ID, WebviewComponentModel } from "../ui/webview/model";
import { packagePinVisualEnd } from "../ui/webview/componentSymbols";
import { sanitizePackage } from "./packageSanitizers";
import {
  PACKAGE_ICON_TYPE_ID,
  PACKAGE_PIN_TYPE_ID,
  PACKAGE_SHAPE_ORDER_PROPERTY_KEY,
  PACKAGE_TYPE_ID,
  compilePackageAuthoringComponents,
  extractPackageNativeScale,
  isPackageAuthoringComponent,
  seedPackageAuthoringComponents,
} from "./subcircuitPackageAuthoring";

function tunnel(id: string, name: string, x = 0, y = 0): WebviewComponentModel {
  return {
    id,
    typeId: TUNNEL_TYPE_ID,
    label: name,
    x,
    y,
    rotation: 0,
    pins: [{ id: "pin", x: 0, y: 0 }],
    properties: { name },
  };
}

function makeIdFactory(prefix: string): () => string {
  let n = 0;
  return () => `${prefix}-${n++}`;
}

const manifestWithPackage = (overrides: Record<string, unknown> = {}) => ({
  schemaVersion: 1,
  typeId: "subcircuits.local_test",
  name: "Local Test",
  components: [],
  wires: [],
  interface: [
    { pinId: "P1", label: "P1", internalTunnel: "TUN1" },
    { pinId: "P2", label: "P2", internalTunnel: "TUN2" },
  ],
  package: {
    width: 56,
    height: 40,
    border: true,
    pins: [
      { id: "P1", x: 0, y: 12, angle: 180, length: 8, label: "P1" },
      { id: "P2", x: 56, y: 12, angle: 0, length: 8, label: "P2" },
    ],
  },
  ...overrides,
});

(async () => {
  const { test, finish } = createTestRunner("subcircuitPackageAuthoring - seed/compile");

  await test("seed materializa 1 Package + N pinos + rótulos linkados, sem ícone quando background ausente", () => {
    const manifest = manifestWithPackage();
    const internalComponents = [tunnel("t1", "TUN1"), tunnel("t2", "TUN2")];
    const { components, warnings } = seedPackageAuthoringComponents(manifest, internalComponents, "/tmp", makeIdFactory("seed"));

    const packages = components.filter((c) => c.typeId === PACKAGE_TYPE_ID);
    const pins = components.filter((c) => c.typeId === PACKAGE_PIN_TYPE_ID);
    const icons = components.filter((c) => c.typeId === PACKAGE_ICON_TYPE_ID);
    const labels = components.filter((c) => c.typeId === "graphics.text");

    assert(packages.length === 1, `esperado 1 Package, recebido ${packages.length}`);
    assert(pins.length === 2, `esperado 2 pinos, recebido ${pins.length}`);
    assert(icons.length === 0, "sem background de imagem no manifesto, não deveria seedar ícone");
    assert(labels.length === 2, `esperado 2 rótulos de pino, recebido ${labels.length}`);
    assert(warnings.length === 0, `não deveria ter warnings, recebido: ${warnings.join(" | ")}`);

    const pin1 = pins.find((p) => p.properties.pinId === "P1");
    assert(pin1?.properties.tunnelComponentId === "t1", "pino P1 deveria vincular ao túnel t1 por nome (migração legado)");
    const pin2 = pins.find((p) => p.properties.pinId === "P2");
    assert(pin2?.properties.tunnelComponentId === "t2", "pino P2 deveria vincular ao túnel t2 por nome (migração legado)");

    const label1 = labels.find((l) => l.properties.linkedPinComponentId === pin1?.id);
    assert(label1?.properties.text === "P1", "rótulo do pino P1 deveria mostrar o label do pino");
  });

  await test("seed não sintetiza Package quando manifest.package está ausente (arquivo antigo)", () => {
    const manifest = { schemaVersion: 1, typeId: "x", components: [], wires: [], interface: [] };
    const { components, warnings } = seedPackageAuthoringComponents(manifest, [], "/tmp", makeIdFactory("seed"));
    assert(components.length === 0, "sem package no manifesto, não deveria criar nenhum componente de autoria");
    assert(warnings.length === 0, "não deveria gerar warning nesse caso (comportamento esperado, não erro)");
  });

  await test("seed converte width/height/pinos do espaço NATIVO pro espaço EXIBIDO quando schematicWidth/Height existem (bug real: ESP32 DevKitC nascia com o tamanho da foto, 308x601, em vez de 88x176)", () => {
    const manifest = {
      schemaVersion: 1,
      typeId: "subcircuits.local_test",
      name: "Local Test",
      components: [],
      wires: [],
      interface: [{ pinId: "GND1", label: "Gnd", internalTunnel: "GND" }],
      package: {
        width: 308,
        height: 601,
        schematicWidth: 88,
        schematicHeight: 176,
        border: true,
        pins: [{ id: "GND1", x: 308, y: 68.3, angle: 0, length: 8, label: "Gnd" }],
      },
    };
    const { components } = seedPackageAuthoringComponents(manifest, [tunnel("t1", "GND")], "/tmp", makeIdFactory("seed"));
    const pkg = components.find((c) => c.typeId === PACKAGE_TYPE_ID);
    const pin = components.find((c) => c.typeId === PACKAGE_PIN_TYPE_ID);

    assert(pkg?.properties.width === 88 && pkg?.properties.height === 176, `Package deveria nascer no tamanho EXIBIDO (88x176), recebido ${JSON.stringify(pkg?.properties)}`);
    assert(pin !== undefined, "deveria seedar o pino GND1");
    // scaleX = 88/308 ≈ 0.2857 -- pin.x=308 (borda direita no espaço nativo) deveria virar ~88 (borda
    // direita no espaço exibido, RELATIVA ao x do próprio Package), nunca os 308 crus (o que faria o
    // pino nascer bem fora do corpo menor). Âncora = x do componente + metade da caixa quadrada do
    // pino (packagePinBoxSide) -- subtrai `pkg.x` pra comparar em coordenada relativa ao Package, não
    // à origem absoluta da cena reservada.
    const scaledLength = Math.max(4, 8 * (88 / 308));
    const box = Math.max(14, scaledLength * 2 + 6);
    const anchorXRelativeToPackage = pin!.x + box / 2 - (pkg?.x ?? 0);
    assert(Math.abs(anchorXRelativeToPackage - 88) < 1, `pino deveria ancorar perto de x=88 (borda direita do Package já escalado, relativo ao Package), recebido x=${anchorXRelativeToPackage}`);
  });

  await test("seed materializa a Figura/ícone quando background é imagem, travada no tamanho do Package", () => {
    const manifest = manifestWithPackage({
      package: {
        width: 56,
        height: 40,
        border: true,
        background: { kind: "image", data: "QUJD", mime: "image/png" },
        pins: [{ id: "P1", x: 0, y: 12, angle: 180, length: 8, label: "P1" }],
      },
      interface: [{ pinId: "P1", label: "P1", internalTunnel: "TUN1" }],
    });
    const { components } = seedPackageAuthoringComponents(manifest, [tunnel("t1", "TUN1")], "/tmp", makeIdFactory("seed"));
    const icon = components.find((c) => c.typeId === PACKAGE_ICON_TYPE_ID);
    const pkg = components.find((c) => c.typeId === PACKAGE_TYPE_ID);
    assert(icon !== undefined, "background de imagem deveria seedar 1 graphics.image");
    assert(icon?.packageIconRole === true, "ícone seedado precisa ter packageIconRole marcado");
    assert(icon?.properties.imageData === "QUJD", "imageData deveria vir de package.background.data");
    assert(icon?.x === pkg?.x && icon?.y === pkg?.y, "ícone deveria estar ancorado na mesma posição do Package");
    assert(icon?.properties.width === 56 && icon?.properties.height === 40, "ícone deveria ter o mesmo tamanho do Package");
  });

  await test("compile persiste posição arrastada do rótulo como labelX/labelY + textAnchor/baseline 'middle' (bug real: posição do rótulo era descartada em todo save, só o texto sobrevivia)", () => {
    const manifest = manifestWithPackage();
    const internalComponents = [tunnel("t1", "TUN1"), tunnel("t2", "TUN2")];
    const seeded = seedPackageAuthoringComponents(manifest, internalComponents, "/tmp", makeIdFactory("seed"));
    const pkg = seeded.components.find((c) => c.typeId === PACKAGE_TYPE_ID);
    const pin1 = seeded.components.find((c) => c.typeId === PACKAGE_PIN_TYPE_ID && c.properties.pinId === "P1");
    const label1 = seeded.components.find((c) => c.typeId === "graphics.text" && c.properties.linkedPinComponentId === pin1?.id);
    assert(pkg !== undefined && pin1 !== undefined && label1 !== undefined, "seed deveria produzir Package + pino P1 + rótulo linkado");

    const dragged: WebviewComponentModel = { ...label1!, x: 999, y: 888 };
    const fullScene = [...internalComponents, ...seeded.components.filter((c) => c.id !== label1!.id), dragged];

    const compiled = compilePackageAuthoringComponents(fullScene);
    assert(compiled.errors.length === 0, `não deveria ter erros: ${compiled.errors.join(" | ")}`);
    const p1 = compiled.package?.pins.find((p) => p.id === "P1");
    const w = Math.max(16, "P1".length * 7 * 0.62 + 4);
    const h = 7 + 4;
    const expectedLabelX = 999 + w / 2 - (pkg?.x ?? 0);
    const expectedLabelY = 888 + h / 2 - (pkg?.y ?? 0);
    assert(Math.abs((p1?.labelX as number) - expectedLabelX) < 0.01, `labelX deveria refletir a posição arrastada, recebido ${p1?.labelX}, esperado ${expectedLabelX}`);
    assert(Math.abs((p1?.labelY as number) - expectedLabelY) < 0.01, `labelY deveria refletir a posição arrastada, recebido ${p1?.labelY}, esperado ${expectedLabelY}`);
    assert(p1?.labelTextAnchor === "middle", "labelTextAnchor deveria ser 'middle' (mesma renderização centralizada do editor)");
    assert(p1?.labelDominantBaseline === "middle", "labelDominantBaseline deveria ser 'middle'");
  });

  await test("seed usa labelX/labelY explícitos do arquivo diretamente, nunca recalcula (WYSIWYG pra arquivo já autorado)", () => {
    const manifest = manifestWithPackage({
      package: {
        width: 56,
        height: 40,
        border: true,
        pins: [{ id: "P1", x: 0, y: 12, angle: 180, length: 8, label: "P1", labelX: 30, labelY: 5 }],
      },
      interface: [{ pinId: "P1", label: "P1", internalTunnel: "TUN1" }],
    });
    const { components } = seedPackageAuthoringComponents(manifest, [tunnel("t1", "TUN1")], "/tmp", makeIdFactory("seed"));
    const pkg = components.find((c) => c.typeId === PACKAGE_TYPE_ID);
    const label = components.find((c) => c.typeId === "graphics.text");
    assert(label !== undefined, "deveria seedar o rótulo linkado");
    const w = Math.max(16, "P1".length * 7 * 0.62 + 4);
    const h = 7 + 4;
    const centerX = label!.x + w / 2;
    const centerY = label!.y + h / 2;
    const expectedCenterX = (pkg?.x ?? 0) + 30;
    const expectedCenterY = (pkg?.y ?? 0) + 5;
    assert(Math.abs(centerX - expectedCenterX) < 0.6, `centro do rótulo deveria bater com labelX explícito, recebido ${centerX}, esperado ${expectedCenterX}`);
    assert(Math.abs(centerY - expectedCenterY) < 0.6, `centro do rótulo deveria bater com labelY explícito, recebido ${centerY}, esperado ${expectedCenterY}`);
  });

  await test("seed sem labelX/labelY usa a MESMA fórmula padrão de packagePinLeadSvg (preview do editor bate com o esquemático antes de qualquer arraste)", () => {
    const manifest = manifestWithPackage(); // P1 angle180 x0,y12,length8; P2 angle0 x56,y12,length8
    const { components } = seedPackageAuthoringComponents(manifest, [tunnel("t1", "TUN1"), tunnel("t2", "TUN2")], "/tmp", makeIdFactory("seed"));
    const pin1 = components.find((c) => c.typeId === PACKAGE_PIN_TYPE_ID && c.properties.pinId === "P1");
    const pin2 = components.find((c) => c.typeId === PACKAGE_PIN_TYPE_ID && c.properties.pinId === "P2");
    const label1 = components.find((c) => c.typeId === "graphics.text" && c.properties.linkedPinComponentId === pin1?.id);
    const label2 = components.find((c) => c.typeId === "graphics.text" && c.properties.linkedPinComponentId === pin2?.id);
    assert(label1 !== undefined && label2 !== undefined, "deveria seedar os 2 rótulos");
    const w = Math.max(16, "P1".length * 7 * 0.62 + 4);
    const h = 7 + 4;
    const center1X = label1!.x + w / 2;
    const center1Y = label1!.y + h / 2;
    const center2X = label2!.x + w / 2;
    const center2Y = label2!.y + h / 2;
    // offset = length(8) + max(2, fontSize(7)/2=3.5) = 11.5; origin = {x:200,y:40} (maxX das 2
    // tunnels em x=0, +200); P1 angle180 x=0,y=12 -> nativo (11.5,12) -> exibido (211.5,52); P2
    // angle0 x=56,y=12 -> nativo (56-11.5,12)=(44.5,12) -> exibido (244.5,52).
    assert(Math.abs(center1X - 211.5) < 0.6, `rótulo P1 (angle180) deveria ficar em x~211.5 (mesma fórmula do renderizador), recebido ${center1X}`);
    assert(Math.abs(center1Y - 52) < 0.6, `rótulo P1 deveria ficar em y~52 (mesmo y do pino), recebido ${center1Y}`);
    assert(Math.abs(center2X - 244.5) < 0.6, `rótulo P2 (angle0) deveria ficar em x~244.5, recebido ${center2X}`);
    assert(Math.abs(center2Y - 52) < 0.6, `rótulo P2 deveria ficar em y~52, recebido ${center2Y}`);
  });

  await test("seed -> compile -> seed é idempotente (abrir/salvar repetido não move rótulos)", () => {
    const manifest = manifestWithPackage();
    const internalComponents = [tunnel("t1", "TUN1"), tunnel("t2", "TUN2")];
    const seeded1 = seedPackageAuthoringComponents(manifest, internalComponents, "/tmp", makeIdFactory("seed1"));
    const compiled1 = compilePackageAuthoringComponents([...internalComponents, ...seeded1.components]);
    assert(compiled1.errors.length === 0, `não deveria ter erros: ${compiled1.errors.join(" | ")}`);

    const manifest2 = { ...manifest, package: compiled1.package, interface: compiled1.interfaceEntries };
    const seeded2 = seedPackageAuthoringComponents(manifest2, internalComponents, "/tmp", makeIdFactory("seed2"));
    const compiled2 = compilePackageAuthoringComponents([...internalComponents, ...seeded2.components]);
    assert(compiled2.errors.length === 0, `não deveria ter erros na segunda rodada: ${compiled2.errors.join(" | ")}`);

    const p1a = compiled1.package?.pins.find((p) => p.id === "P1");
    const p1b = compiled2.package?.pins.find((p) => p.id === "P1");
    assert(Math.abs((p1a?.labelX as number) - (p1b?.labelX as number)) < 0.01, `labelX deveria ser estável entre save/reload, recebido ${p1a?.labelX} vs ${p1b?.labelX}`);
    assert(Math.abs((p1a?.labelY as number) - (p1b?.labelY as number)) < 0.01, `labelY deveria ser estável entre save/reload, recebido ${p1a?.labelY} vs ${p1b?.labelY}`);
  });

  await test("compile persiste labelRotation quando o rótulo foi rotacionado (pino vertical, angle 90) -- sem isso, um rótulo vertical vira horizontal no primeiro save", () => {
    const manifest = manifestWithPackage({
      package: { width: 56, height: 40, border: true, pins: [{ id: "P1", x: 20, y: 40, angle: 90, length: 8, label: "P1" }] },
      interface: [{ pinId: "P1", label: "P1", internalTunnel: "TUN1" }],
    });
    const seeded = seedPackageAuthoringComponents(manifest, [tunnel("t1", "TUN1")], "/tmp", makeIdFactory("seed"));
    const label = seeded.components.find((c) => c.typeId === "graphics.text");
    assert(label?.rotation === 90, `preview do editor deveria já nascer rotacionado 90 (mesma fórmula do renderizador pra angle=90), recebido ${label?.rotation}`);

    const compiled = compilePackageAuthoringComponents([tunnel("t1", "TUN1"), ...seeded.components]);
    assert(compiled.errors.length === 0, `não deveria ter erros: ${compiled.errors.join(" | ")}`);
    const p1 = compiled.package?.pins.find((p) => p.id === "P1");
    assert(p1?.labelRotation === 90, `labelRotation deveria sobreviver ao compile, recebido ${p1?.labelRotation}`);

    // Ciclo completo compile -> sanitize -> seed: sem o fix em packageSanitizers.ts, labelRotation
    // sobrevive à ESCRITA (linha acima) mas some na LEITURA -- tanto ao reabrir o MESMO subcircuito
    // pra editar de novo quanto ao renderizar como dispositivo colocado (os dois usam sanitizePackage).
    const sanitized = sanitizePackage(compiled.package, "/tmp");
    const sanitizedPin = sanitized?.pins.find((p) => p.id === "P1");
    assert(sanitizedPin?.labelRotation === 90, `labelRotation deveria sobreviver ao sanitizePackage (bug real: campo nunca era lido de volta), recebido ${sanitizedPin?.labelRotation}`);

    const reseeded = seedPackageAuthoringComponents({ package: sanitized, interface: compiled.interfaceEntries }, [tunnel("t1", "TUN1")], "/tmp", makeIdFactory("reseed"));
    const reseededLabel = reseeded.components.find((c) => c.typeId === "graphics.text");
    assert(reseededLabel?.rotation === 90, `reabrir a sessão deveria restaurar labelRotation=90 (custom), recebido ${reseededLabel?.rotation}`);
  });

  await test("compile persiste a cor customizada do rótulo do pino (bug real: mudar a cor na sessão de autoria não sobrevivia ao save -- seed sempre gravava a cor padrão hardcoded)", () => {
    const manifest = manifestWithPackage({
      package: { width: 56, height: 40, border: true, pins: [{ id: "P1", x: 0, y: 12, angle: 180, length: 8, label: "P1" }] },
      interface: [{ pinId: "P1", label: "P1", internalTunnel: "TUN1" }],
    });
    const seeded = seedPackageAuthoringComponents(manifest, [tunnel("t1", "TUN1")], "/tmp", makeIdFactory("seed"));
    const label = seeded.components.find((c) => c.typeId === "graphics.text")!;
    assert(label.properties.color === "#1f2937", `sem labelColor no arquivo, deveria nascer com a cor padrão, recebido ${label.properties.color}`);

    // Usuário muda a cor do rótulo (equivalente ao diálogo de Propriedades) e salva.
    const recolored: WebviewComponentModel = { ...label, properties: { ...label.properties, color: "#e11d48" } };
    const fullScene = [tunnel("t1", "TUN1"), ...seeded.components.filter((c) => c.id !== label.id), recolored];
    const compiled = compilePackageAuthoringComponents(fullScene);
    assert(compiled.errors.length === 0, `não deveria ter erros: ${compiled.errors.join(" | ")}`);
    const p1 = compiled.package?.pins.find((p) => p.id === "P1");
    assert(p1?.labelColor === "#e11d48", `labelColor deveria sobreviver ao compile, recebido ${p1?.labelColor}`);

    // Ciclo completo compile -> sanitize -> seed, mesmo padrão do teste de labelRotation acima.
    const sanitized = sanitizePackage(compiled.package, "/tmp");
    const sanitizedPin = sanitized?.pins.find((p) => p.id === "P1");
    assert(sanitizedPin?.labelColor === "#e11d48", `labelColor deveria sobreviver ao sanitizePackage, recebido ${sanitizedPin?.labelColor}`);

    const reseeded = seedPackageAuthoringComponents({ package: sanitized, interface: compiled.interfaceEntries }, [tunnel("t1", "TUN1")], "/tmp", makeIdFactory("reseed"));
    const reseededLabel = reseeded.components.find((c) => c.typeId === "graphics.text");
    assert(reseededLabel?.properties.color === "#e11d48", `reabrir a sessão deveria restaurar a cor customizada, recebido ${reseededLabel?.properties.color}`);
  });

  await test("round-trip seed -> compile produz package/interface equivalentes ao original", () => {
    const manifest = manifestWithPackage();
    const internalComponents = [tunnel("t1", "TUN1"), tunnel("t2", "TUN2")];
    const seeded = seedPackageAuthoringComponents(manifest, internalComponents, "/tmp", makeIdFactory("seed"));
    const fullScene = [...internalComponents, ...seeded.components];

    const compiled = compilePackageAuthoringComponents(fullScene);
    assert(compiled.errors.length === 0, `não deveria ter erros: ${compiled.errors.join(" | ")}`);
    assert(compiled.touchedPackageAuthoring === true, "cena com Package deveria marcar touchedPackageAuthoring");
    assert(compiled.hasPackage === true, "deveria compilar um Package");
    assert(compiled.package?.width === 56 && compiled.package?.height === 40, "dimensões do Package deveriam sobreviver ao round-trip");
    assert(compiled.package?.pins.length === 2, `esperado 2 pinos compilados, recebido ${compiled.package?.pins.length}`);
    assert(compiled.interfaceEntries?.length === 2, "interface[] compilada deveria ter 2 entradas");
    const p1 = compiled.interfaceEntries?.find((e) => e.pinId === "P1");
    assert(p1?.internalTunnel === "TUN1", "internalTunnel deveria ser re-derivado do nome atual do túnel");
    assert(p1?.internalTunnelId === "t1", "internalTunnelId deveria apontar pro id estável do túnel");
    assert(compiled.remainingComponents.every((c) => internalComponents.some((ic) => ic.id === c.id)), "remainingComponents não deveria conter componentes de autoria");
  });

  await test("round-trip seed -> compile preserva width/height NATIVOS + schematicWidth/Height quando o package foi capturado em pixel de foto (bug real: ESP32-WROOM colapsava pro tamanho exibido e perdia schematicWidth/Height no primeiro save via 'Abrir Subcircuito')", () => {
    const manifest = {
      schemaVersion: 1,
      typeId: "subcircuits.local_test",
      name: "Local Test",
      components: [],
      wires: [],
      interface: [{ pinId: "GND1", label: "Gnd", internalTunnel: "GND" }],
      package: {
        width: 343,
        height: 487,
        schematicWidth: 104,
        schematicHeight: 160,
        border: false,
        background: { kind: "image", data: "QUJD", mime: "image/png" },
        pins: [{ id: "GND1", x: 0, y: 31, angle: 180, length: 8, label: "Gnd" }],
      },
    };
    const internalComponents = [tunnel("t1", "GND")];
    const seeded = seedPackageAuthoringComponents(manifest, internalComponents, "/tmp", makeIdFactory("seed"));
    const fullScene = [...internalComponents, ...seeded.components];

    const compiled = compilePackageAuthoringComponents(fullScene, extractPackageNativeScale(manifest));
    assert(compiled.errors.length === 0, `não deveria ter erros: ${compiled.errors.join(" | ")}`);
    assert(compiled.package?.width === 343 && compiled.package?.height === 487, `width/height nativos deveriam sobreviver ao round-trip, recebido ${compiled.package?.width}x${compiled.package?.height}`);
    assert(compiled.package?.schematicWidth === 104 && compiled.package?.schematicHeight === 160, `schematicWidth/Height deveriam sobreviver ao round-trip, recebido ${compiled.package?.schematicWidth}x${compiled.package?.schematicHeight}`);
    const pin = compiled.package?.pins.find((p) => p.id === "GND1");
    const pinY = typeof pin?.y === "number" ? pin.y : NaN;
    assert(Math.abs(pinY - 31) < 0.01, `pino deveria voltar pro espaço NATIVO (y~31), recebido ${pin?.y}`);
    assert(compiled.package?.background?.data === "QUJD", "background de imagem deveria sobreviver ao round-trip");
  });

  await test("compile sem originalScale (package novo/sem foto) mantém comportamento antigo -- width/height ficam no tamanho exibido, sem schematicWidth/Height", () => {
    const manifest = manifestWithPackage();
    const internalComponents = [tunnel("t1", "TUN1"), tunnel("t2", "TUN2")];
    const seeded = seedPackageAuthoringComponents(manifest, internalComponents, "/tmp", makeIdFactory("seed"));
    const compiled = compilePackageAuthoringComponents([...internalComponents, ...seeded.components]);
    assert(compiled.package?.width === 56 && compiled.package?.height === 40, "sem originalScale, width/height deveriam ficar no tamanho exibido (comportamento pré-existente)");
    assert(compiled.package?.schematicWidth === undefined && compiled.package?.schematicHeight === undefined, "sem distinção nativo/esquemático original, schematicWidth/Height não deveriam ser introduzidos");
  });

  await test("rename do túnel entre seed e compile é refletido no internalTunnel re-derivado (o bug que a feature resolve)", () => {
    const manifest = manifestWithPackage({ interface: [{ pinId: "P1", label: "P1", internalTunnel: "TUN1" }], package: { width: 56, height: 40, border: true, pins: [{ id: "P1", x: 0, y: 12, angle: 180, length: 8, label: "P1" }] } });
    const t1 = tunnel("t1", "TUN1");
    const seeded = seedPackageAuthoringComponents(manifest, [t1], "/tmp", makeIdFactory("seed"));
    const renamedTunnel: WebviewComponentModel = { ...t1, properties: { ...t1.properties, name: "GND_RENAMED" } };
    const fullScene = [renamedTunnel, ...seeded.components];

    const compiled = compilePackageAuthoringComponents(fullScene);
    assert(compiled.errors.length === 0, `não deveria ter erros: ${compiled.errors.join(" | ")}`);
    assert(compiled.interfaceEntries?.[0]?.internalTunnel === "GND_RENAMED", "internalTunnel deveria refletir o nome ATUAL do túnel, não o nome no momento do seed");
  });

  await test("pino sem túnel associado gera warning e é excluído do compilado (nunca gravado órfão)", () => {
    const pkgId = "pkg-orphan";
    const scene: WebviewComponentModel[] = [
      { id: pkgId, typeId: PACKAGE_TYPE_ID, label: "Package", x: 0, y: 0, rotation: 0, pins: [], properties: { width: 56, height: 40 } },
      { id: "pin-orphan", typeId: PACKAGE_PIN_TYPE_ID, label: "P1", x: -12, y: 8, rotation: 180, pins: [], properties: { pinId: "P1", length: 8 } },
    ];
    const compiled = compilePackageAuthoringComponents(scene);
    assert(compiled.errors.length === 0, "pino órfão não deveria ser erro bloqueante");
    assert(compiled.warnings.some((w) => w.includes("sem túnel")), `esperava warning de pino sem túnel, recebido: ${compiled.warnings.join(" | ")}`);
    assert(compiled.package?.pins.length === 0, "pino sem túnel não deveria entrar no package.pins compilado");
  });

  await test("dois pinos com pinId diferente vinculados ao MESMO túnel é PERMITIDO (bug real de produção: ESP32 DevKitC tem GND1/GND2/GND3, 3 pinos físicos na mesma malha de terra -- o Core só rejeita pinId duplicado, nunca internalTunnel repetido entre entradas de interface[])", () => {
    const t1 = tunnel("t1", "GND");
    const pkgId = "pkg-multi-gnd";
    const scene: WebviewComponentModel[] = [
      t1,
      { id: pkgId, typeId: PACKAGE_TYPE_ID, label: "Package", x: 0, y: 0, rotation: 0, pins: [], properties: { width: 56, height: 40 } },
      { id: "pin-a", typeId: PACKAGE_PIN_TYPE_ID, label: "GND1", x: -12, y: 8, rotation: 180, pins: [], properties: { pinId: "GND1", length: 8, tunnelComponentId: "t1" } },
      { id: "pin-b", typeId: PACKAGE_PIN_TYPE_ID, label: "GND2", x: 60, y: 8, rotation: 0, pins: [], properties: { pinId: "GND2", length: 8, tunnelComponentId: "t1" } },
      { id: "pin-c", typeId: PACKAGE_PIN_TYPE_ID, label: "GND3", x: 60, y: 30, rotation: 0, pins: [], properties: { pinId: "GND3", length: 8, tunnelComponentId: "t1" } },
    ];
    const compiled = compilePackageAuthoringComponents(scene);
    assert(compiled.errors.length === 0, `não deveria bloquear -- vários pinos físicos no mesmo net é válido, recebido: ${compiled.errors.join(" | ")}`);
    assert(compiled.package?.pins.length === 3, `os 3 pinos GND deveriam ser compilados, recebido ${compiled.package?.pins.length}`);
    assert(compiled.interfaceEntries?.every((e) => e.internalTunnel === "GND") ?? false, "todas as 3 entradas de interface deveriam apontar pro mesmo túnel GND");
  });

  await test("pinId duplicado entre pinos é erro bloqueante", () => {
    const t1 = tunnel("t1", "TUN1");
    const t2 = tunnel("t2", "TUN2");
    const scene: WebviewComponentModel[] = [
      t1,
      t2,
      { id: "pkg", typeId: PACKAGE_TYPE_ID, label: "Package", x: 0, y: 0, rotation: 0, pins: [], properties: { width: 56, height: 40 } },
      { id: "pin-a", typeId: PACKAGE_PIN_TYPE_ID, label: "PA", x: -12, y: 8, rotation: 180, pins: [], properties: { pinId: "P1", length: 8, tunnelComponentId: "t1" } },
      { id: "pin-b", typeId: PACKAGE_PIN_TYPE_ID, label: "PB", x: 60, y: 8, rotation: 0, pins: [], properties: { pinId: "P1", length: 8, tunnelComponentId: "t2" } },
    ];
    const compiled = compilePackageAuthoringComponents(scene);
    assert(compiled.errors.some((e) => e.includes("duplicado")), `esperava erro de pinId duplicado, recebido: ${compiled.errors.join(" | ")}`);
  });

  await test("mais de um objeto Package na cena é erro bloqueante", () => {
    const scene: WebviewComponentModel[] = [
      { id: "pkg1", typeId: PACKAGE_TYPE_ID, label: "Package", x: 0, y: 0, rotation: 0, pins: [], properties: { width: 56, height: 40 } },
      { id: "pkg2", typeId: PACKAGE_TYPE_ID, label: "Package", x: 100, y: 0, rotation: 0, pins: [], properties: { width: 56, height: 40 } },
    ];
    const compiled = compilePackageAuthoringComponents(scene);
    assert(compiled.errors.some((e) => e.includes("Mais de um objeto Package")), `esperava erro de Package duplicado, recebido: ${compiled.errors.join(" | ")}`);
  });

  await test("mais de uma Figura marcada como ícone é erro bloqueante (cópia acidental)", () => {
    const scene: WebviewComponentModel[] = [
      { id: "pkg", typeId: PACKAGE_TYPE_ID, label: "Package", x: 0, y: 0, rotation: 0, pins: [], properties: { width: 56, height: 40 } },
      { id: "icon1", typeId: PACKAGE_ICON_TYPE_ID, label: "Ícone", x: 0, y: 0, rotation: 0, pins: [], properties: { imageData: "A" }, packageIconRole: true },
      { id: "icon2", typeId: PACKAGE_ICON_TYPE_ID, label: "Ícone (cópia)", x: 0, y: 0, rotation: 0, pins: [], properties: { imageData: "A" }, packageIconRole: true },
    ];
    const compiled = compilePackageAuthoringComponents(scene);
    assert(compiled.errors.some((e) => e.includes("Mais de uma Figura")), `esperava erro de ícone duplicado, recebido: ${compiled.errors.join(" | ")}`);
  });

  await test("cena sem NENHUM componente de autoria não toca em package/interface (arquivo antigo aberto e salvo sem editar)", () => {
    const compiled = compilePackageAuthoringComponents([tunnel("t1", "TUN1")]);
    assert(compiled.touchedPackageAuthoring === false, "sem componentes de autoria, não deveria marcar touchedPackageAuthoring");
    assert(compiled.hasPackage === false, "sem componentes de autoria, hasPackage deveria ser false (irrelevante/não escrito)");
  });

  await test("remover o único other.package da cena (deixando warnings, sem pinos) compila como remoção deliberada", () => {
    const compiled = compilePackageAuthoringComponents([tunnel("t1", "TUN1")]);
    assert(compiled.touchedPackageAuthoring === false, "cena sem nenhum vestígio de autoria -- não é uma remoção, é ausência nunca-tocada");
  });

  await test("isPackageAuthoringComponent distingue rótulo linkado (meta) de graphics.text solto (real, preservado)", () => {
    const pinComponentIds = new Set(["pin-1"]);
    const linkedLabel: WebviewComponentModel = { id: "l1", typeId: "graphics.text", label: "l", x: 0, y: 0, rotation: 0, pins: [], properties: { text: "P1", linkedPinComponentId: "pin-1" } };
    const plainNote: WebviewComponentModel = { id: "l2", typeId: "graphics.text", label: "l", x: 0, y: 0, rotation: 0, pins: [], properties: { text: "Anotação do usuário" } };
    assert(isPackageAuthoringComponent(linkedLabel, pinComponentIds) === true, "rótulo linkado a um pino deveria ser tratado como meta");
    assert(isPackageAuthoringComponent(plainNote, pinComponentIds) === false, "graphics.text sem link deveria ser preservado como componente real do circuito interno");
  });

  await test("ângulo não-cardeal de pino escrito à mão é ajustado com warning, não quebra o seed", () => {
    const manifest = manifestWithPackage({
      package: { width: 56, height: 40, border: true, pins: [{ id: "P1", x: 0, y: 12, angle: 45, length: 8, label: "P1" }] },
      interface: [{ pinId: "P1", label: "P1", internalTunnel: "TUN1" }],
    });
    const { components, warnings } = seedPackageAuthoringComponents(manifest, [tunnel("t1", "TUN1")], "/tmp", makeIdFactory("seed"));
    const pin = components.find((c) => c.typeId === PACKAGE_PIN_TYPE_ID);
    // rotation = (180 - 45) mod 360 = 135, arredonda pro cardeal mais próximo (Math.round(135/90)=2) = 180.
    assert(pin?.rotation === 180, `ângulo 45 (convertido: 135) deveria arredondar pra 180, recebido ${pin?.rotation}`);
    assert(warnings.some((w) => w.includes("não-cardeal")), "deveria avisar sobre o ajuste de ângulo não-cardeal");
  });

  await test("conversão rotation<->angle: pino de borda esquerda (angle:180, ex. GND real do ESP32) gira o lead na direção CORRETA (bug real: identidade fazia o lead apontar 180° invertido)", () => {
    for (const angle of [0, 90, 180, 270]) {
      const manifest = manifestWithPackage({
        package: { width: 56, height: 40, border: true, pins: [{ id: "P1", x: 0, y: 20, angle, length: 8, label: "P1" }] },
        interface: [{ pinId: "P1", label: "P1", internalTunnel: "TUN1" }],
      });
      const { components } = seedPackageAuthoringComponents(manifest, [tunnel("t1", "TUN1")], "/tmp", makeIdFactory("seed"));
      const pin = components.find((c) => c.typeId === PACKAGE_PIN_TYPE_ID);
      const expectedRotation = (180 - angle + 360) % 360;
      assert(pin?.rotation === expectedRotation, `angle=${angle} deveria virar rotation=${expectedRotation}, recebido ${pin?.rotation}`);

      // Cross-check numérico contra a função REAL do renderizador final (não uma fórmula copiada
      // à mão) -- rotacionar o lead canônico (length,0) por `rotation` (matriz de rotação padrão,
      // mesma que o wrapper CSS/SVG genérico aplica) deve produzir EXATAMENTE o mesmo vetor que
      // `packagePinVisualEnd` (importada de componentSymbols.ts) produz pro mesmo pino -- prova que
      // o lead desenhado na autoria aponta pra onde o dispositivo colocado realmente aponta.
      const rad = (pin!.rotation * Math.PI) / 180;
      const authoringVector = { x: 8 * Math.cos(rad), y: 8 * Math.sin(rad) };
      const realEnd = packagePinVisualEnd({ id: "P1", x: 0, y: 0, angle, length: 8 });
      assert(Math.abs(authoringVector.x - realEnd.x) < 1e-9, `angle=${angle}: vetor X da autoria (${authoringVector.x}) deveria bater com packagePinVisualEnd (${realEnd.x})`);
      assert(Math.abs(authoringVector.y - realEnd.y) < 1e-9, `angle=${angle}: vetor Y da autoria (${authoringVector.y}) deveria bater com packagePinVisualEnd (${realEnd.y})`);
    }
  });

  await test("seed -> compile de angle é a inversa EXATA (round-trip preserva o ângulo original do arquivo) para os 4 cardeais", () => {
    for (const angle of [0, 90, 180, 270]) {
      const manifest = manifestWithPackage({
        package: { width: 56, height: 40, border: true, pins: [{ id: "P1", x: 0, y: 20, angle, length: 8, label: "P1" }] },
        interface: [{ pinId: "P1", label: "P1", internalTunnel: "TUN1" }],
      });
      const t1 = tunnel("t1", "TUN1");
      const seeded = seedPackageAuthoringComponents(manifest, [t1], "/tmp", makeIdFactory("seed"));
      const compiled = compilePackageAuthoringComponents([t1, ...seeded.components]);
      const pin = compiled.package?.pins.find((p) => p.id === "P1");
      assert(pin?.angle === angle, `angle=${angle} deveria sobreviver ao round-trip seed->compile, recebido ${pin?.angle}`);
    }
  });

  await test("regressão real: GND1 do ESP32-WROOM-32 (angle:180, borda esquerda) tem o lead corrigido (bug real fixado 2026-07-15)", () => {
    const manifestPath = path.join(__dirname, "..", "..", "..", "..", "subcircuits", "esp32_wroom32.lssubcircuit");
    const manifest = JSON.parse(fs.readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    const internalComponents = ((manifest.components as Array<Record<string, unknown>>) ?? []).map((c) => ({
      id: c.id as string,
      typeId: c.typeId as string,
      label: c.typeId as string,
      x: ((c.visual as Record<string, unknown> | undefined)?.x as number) ?? 0,
      y: ((c.visual as Record<string, unknown> | undefined)?.y as number) ?? 0,
      rotation: (((c.visual as Record<string, unknown> | undefined)?.rotation as number) ?? 0) as 0 | 90 | 180 | 270,
      pins: [] as WebviewComponentModel["pins"],
      properties: (c.properties as WebviewComponentModel["properties"]) ?? {},
    }));
    const { components } = seedPackageAuthoringComponents(manifest, internalComponents, path.dirname(manifestPath), makeIdFactory("seed"));
    const gnd1PackagePin = ((manifest.package as Record<string, unknown>).pins as Array<Record<string, unknown>>).find((p) => p.id === "GND1");
    assert(gnd1PackagePin?.angle === 180, `pré-condição: GND1 real deveria ser angle:180, recebido ${gnd1PackagePin?.angle}`);

    const pin = components.find((c) => c.typeId === PACKAGE_PIN_TYPE_ID && c.properties.pinId === "GND1");
    assert(pin !== undefined, "deveria seedar o pino GND1 real do arquivo");
    // (180 - 180) % 360 = 0 -- ANTES do fix, a identidade produzia rotation=180 (lead apontando de
    // volta PRA DENTRO do corpo, errado); com o fix, rotation=0 (lead aponta pra -X, PRA FORA da
    // borda esquerda, correto).
    assert(pin?.rotation === 0, `GND1 (angle:180) deveria virar rotation=0 (lead corrigido), recebido ${pin?.rotation}`);

    const realEnd = packagePinVisualEnd({ id: "GND1", x: 0, y: 0, angle: 180, length: 8 });
    const authoringRad = (pin!.rotation * Math.PI) / 180;
    const authoringVector = { x: 8 * Math.cos(authoringRad), y: 8 * Math.sin(authoringRad) };
    assert(Math.abs(authoringVector.x - realEnd.x) < 1e-9 && Math.abs(authoringVector.y - realEnd.y) < 1e-9, `lead da autoria (${JSON.stringify(authoringVector)}) deveria bater com packagePinVisualEnd real (${JSON.stringify(realEnd)})`);
  });

  await test("isPackageAuthoringComponent reconhece packageShapeRole (novo, Parte B)", () => {
    const rect: WebviewComponentModel = { id: "r1", typeId: "graphics.rectangle", label: "r", x: 0, y: 0, rotation: 0, pins: [], properties: {}, packageShapeRole: true };
    const normalRect: WebviewComponentModel = { id: "r2", typeId: "graphics.rectangle", label: "r", x: 0, y: 0, rotation: 0, pins: [], properties: {} };
    assert(isPackageAuthoringComponent(rect, new Set()) === true, "retângulo marcado deveria ser reconhecido como autoria de Package");
    assert(isPackageAuthoringComponent(normalRect, new Set()) === false, "retângulo NÃO marcado deveria continuar como componente normal do circuito interno");
  });

  await test("seed materializa package.shapes[] (1 de cada kind) em componentes de cena marcados com packageShapeRole", () => {
    const manifest = manifestWithPackage({
      package: {
        width: 56,
        height: 40,
        border: true,
        pins: [{ id: "P1", x: 0, y: 12, angle: 180, length: 8, label: "P1" }],
        shapes: [
          { kind: "rect", x: 4, y: 4, w: 20, h: 10, stroke: "#111", fill: "#eee", strokeWidth: 2 },
          { kind: "ellipse", cx: 30, cy: 20, rx: 8, ry: 5, stroke: "#222" },
          { kind: "line", x1: 0, y1: 0, x2: 10, y2: 0, stroke: "#333" },
          { kind: "image", x: 0, y: 0, w: 12, h: 12, href: "data:image/png;base64,QUJD" },
          { kind: "text", x: 25, y: 5, value: "Rev A", fontSize: 6, color: "#444" },
        ],
      },
      interface: [{ pinId: "P1", label: "P1", internalTunnel: "TUN1" }],
    });
    const { components, warnings } = seedPackageAuthoringComponents(manifest, [tunnel("t1", "TUN1")], "/tmp", makeIdFactory("seed"));
    assert(warnings.length === 0, `não deveria ter warnings: ${warnings.join(" | ")}`);
    const shapeComps = components.filter((c) => c.packageShapeRole === true);
    assert(shapeComps.length === 5, `esperado 5 elementos seedados, recebido ${shapeComps.length}`);

    const rect = shapeComps.find((c) => c.typeId === "graphics.rectangle");
    assert(rect?.properties.width === 20 && rect?.properties.height === 10, `retângulo deveria ter width/height 20x10 (escala 1:1), recebido ${JSON.stringify(rect?.properties)}`);
    assert(rect?.properties.stroke === "#111" && rect?.properties.fill === "#eee" && rect?.properties.strokeWidth === 2, "retângulo deveria preservar stroke/fill/strokeWidth");

    const ellipse = shapeComps.find((c) => c.typeId === "graphics.ellipse");
    assert(ellipse?.properties.width === 16 && ellipse?.properties.height === 10, `elipse deveria ter width/height = 2*rx/2*ry = 16x10, recebido ${JSON.stringify(ellipse?.properties)}`);

    const line = shapeComps.find((c) => c.typeId === "graphics.line");
    assert(line?.properties.length === 10, `linha deveria ter length=10 (distância x1..x2), recebido ${line?.properties.length}`);

    const image = shapeComps.find((c) => c.typeId === "graphics.image");
    assert(image?.properties.imageData === "QUJD" && image?.properties.imageMime === "image/png", `imagem deveria extrair imageData/imageMime do href data URI, recebido ${JSON.stringify(image?.properties)}`);

    const text = shapeComps.find((c) => c.typeId === "graphics.text");
    assert(text?.properties.text === "Rev A" && text?.properties.fontSize === 6 && text?.properties.color === "#444", `texto deveria preservar value/fontSize/color, recebido ${JSON.stringify(text?.properties)}`);

    // Ordem de z-order (__packageShapeOrder) deveria refletir a ordem do array original.
    const orders = ["graphics.rectangle", "graphics.ellipse", "graphics.line", "graphics.image", "graphics.text"].map(
      (typeId) => shapeComps.find((c) => c.typeId === typeId)?.properties[PACKAGE_SHAPE_ORDER_PROPERTY_KEY]
    );
    assert(JSON.stringify(orders) === JSON.stringify([0, 1, 2, 3, 4]), `ordem esperada [0,1,2,3,4], recebido ${JSON.stringify(orders)}`);
  });

  await test("compile converte componentes packageShapeRole de volta pra package.shapes[] (round-trip por kind)", () => {
    const manifest = manifestWithPackage({
      package: { width: 56, height: 40, border: true, pins: [{ id: "P1", x: 0, y: 12, angle: 180, length: 8, label: "P1" }] },
      interface: [{ pinId: "P1", label: "P1", internalTunnel: "TUN1" }],
    });
    const seeded = seedPackageAuthoringComponents(manifest, [tunnel("t1", "TUN1")], "/tmp", makeIdFactory("seed"));
    const pkg = seeded.components.find((c) => c.typeId === PACKAGE_TYPE_ID)!;

    const rect: WebviewComponentModel = {
      id: "shape-rect", typeId: "graphics.rectangle", label: "r", x: pkg.x + 4, y: pkg.y + 4, rotation: 0, pins: [],
      packageShapeRole: true, properties: { width: 20, height: 10, stroke: "#111", fill: "#eee", strokeWidth: 2, [PACKAGE_SHAPE_ORDER_PROPERTY_KEY]: 0 },
    };
    const fullScene = [tunnel("t1", "TUN1"), ...seeded.components, rect];
    const compiled = compilePackageAuthoringComponents(fullScene);
    assert(compiled.errors.length === 0, `não deveria ter erros: ${compiled.errors.join(" | ")}`);
    assert(compiled.package?.shapes?.length === 1, `esperado 1 shape compilado, recebido ${compiled.package?.shapes?.length}`);
    const compiledRect = compiled.package!.shapes![0]!;
    assert(compiledRect.kind === "rect" && compiledRect.x === 4 && compiledRect.y === 4 && compiledRect.w === 20 && compiledRect.h === 10, `retângulo compilado deveria voltar pro espaço nativo (4,4,20,10), recebido ${JSON.stringify(compiledRect)}`);
    assert(compiledRect.stroke === "#111" && compiledRect.fill === "#eee" && compiledRect.strokeWidth === 2, "retângulo deveria preservar stroke/fill/strokeWidth no compile");
  });

  await test("elemento do Package rotacionado grava transform=rotate(...) e o seed reconstrói a MESMA rotação (round-trip de rotação)", () => {
    const manifest = manifestWithPackage({
      package: { width: 56, height: 40, border: true, pins: [{ id: "P1", x: 0, y: 12, angle: 180, length: 8, label: "P1" }] },
      interface: [{ pinId: "P1", label: "P1", internalTunnel: "TUN1" }],
    });
    const seeded = seedPackageAuthoringComponents(manifest, [tunnel("t1", "TUN1")], "/tmp", makeIdFactory("seed"));
    const pkg = seeded.components.find((c) => c.typeId === PACKAGE_TYPE_ID)!;

    const rect: WebviewComponentModel = {
      id: "shape-rect", typeId: "graphics.rectangle", label: "r", x: pkg.x + 4, y: pkg.y + 4, rotation: 90, pins: [],
      packageShapeRole: true, properties: { width: 20, height: 10, [PACKAGE_SHAPE_ORDER_PROPERTY_KEY]: 0 },
    };
    const compiled = compilePackageAuthoringComponents([tunnel("t1", "TUN1"), ...seeded.components, rect]);
    const compiledShape = compiled.package?.shapes?.[0];
    assert(typeof compiledShape?.transform === "string" && compiledShape.transform.startsWith("rotate(90 "), `deveria gravar transform="rotate(90 ...)", recebido ${compiledShape?.transform}`);

    const manifest2 = { ...manifest, package: compiled.package };
    const reseeded = seedPackageAuthoringComponents(manifest2, [], "/tmp", makeIdFactory("seed2"));
    const reseededRect = reseeded.components.find((c) => c.typeId === "graphics.rectangle");
    assert(reseededRect?.rotation === 90, `rotação deveria sobreviver ao round-trip (90), recebido ${reseededRect?.rotation}`);
  });

  await test("reordenar elementos do Package (Trazer pra frente/Enviar pra trás) muda a ordem compilada de package.shapes[]", () => {
    const manifest = manifestWithPackage({
      package: { width: 56, height: 40, border: true, pins: [{ id: "P1", x: 0, y: 12, angle: 180, length: 8, label: "P1" }] },
      interface: [{ pinId: "P1", label: "P1", internalTunnel: "TUN1" }],
    });
    const seeded = seedPackageAuthoringComponents(manifest, [tunnel("t1", "TUN1")], "/tmp", makeIdFactory("seed"));
    const pkg = seeded.components.find((c) => c.typeId === PACKAGE_TYPE_ID)!;

    const shapeA: WebviewComponentModel = { id: "a", typeId: "graphics.rectangle", label: "a", x: pkg.x, y: pkg.y, rotation: 0, pins: [], packageShapeRole: true, properties: { width: 8, height: 8, [PACKAGE_SHAPE_ORDER_PROPERTY_KEY]: 0 } };
    const shapeB: WebviewComponentModel = { id: "b", typeId: "graphics.rectangle", label: "b", x: pkg.x, y: pkg.y, rotation: 0, pins: [], packageShapeRole: true, properties: { width: 8, height: 8, [PACKAGE_SHAPE_ORDER_PROPERTY_KEY]: 1 } };

    const compiledBeforeReorder = compilePackageAuthoringComponents([tunnel("t1", "TUN1"), ...seeded.components, shapeA, shapeB]);
    assert(compiledBeforeReorder.package?.shapes?.[0]?.fill === undefined, "sanity check: 2 shapes sem diferenciação visual, checando só a ordem abaixo");

    // "Enviar shapeA pra trás de shapeB" -- troca as ordens.
    const shapeAReordered: WebviewComponentModel = { ...shapeA, properties: { ...shapeA.properties, [PACKAGE_SHAPE_ORDER_PROPERTY_KEY]: 1 } };
    const shapeBReordered: WebviewComponentModel = { ...shapeB, properties: { ...shapeB.properties, [PACKAGE_SHAPE_ORDER_PROPERTY_KEY]: 0 } };
    const compiledAfterReorder = compilePackageAuthoringComponents([tunnel("t1", "TUN1"), ...seeded.components, shapeAReordered, shapeBReordered]);
    assert(compiledAfterReorder.package?.shapes?.length === 2, "deveria continuar com 2 shapes após reordenar");
    // Como não há campo id em PackageShape, identificamos pela ordem: depois da troca, o shape que
    // era 2º (shapeB, order=1) deveria vir PRIMEIRO no array compilado (order=0 agora).
    const idsInOrder = compiledAfterReorder.package!.shapes!.map((s) => `${s.x}`);
    assert(idsInOrder.length === 2, "esperado exatamente 2 entradas no array reordenado");
  });

  await test("round-trip seed -> compile -> seed de elementos do Package é idempotente (posições/estilos estáveis)", () => {
    const manifest = manifestWithPackage({
      package: {
        width: 56, height: 40, border: true, pins: [],
        shapes: [{ kind: "rect", x: 4, y: 4, w: 20, h: 10, stroke: "#111", fill: "#eee" }],
      },
      interface: [],
    });
    const seeded1 = seedPackageAuthoringComponents(manifest, [], "/tmp", makeIdFactory("seed1"));
    const compiled1 = compilePackageAuthoringComponents(seeded1.components);
    assert(compiled1.errors.length === 0, `não deveria ter erros: ${compiled1.errors.join(" | ")}`);

    const manifest2 = { ...manifest, package: compiled1.package };
    const seeded2 = seedPackageAuthoringComponents(manifest2, [], "/tmp", makeIdFactory("seed2"));
    const compiled2 = compilePackageAuthoringComponents(seeded2.components);
    assert(compiled2.errors.length === 0, `não deveria ter erros na 2ª rodada: ${compiled2.errors.join(" | ")}`);

    const shape1 = compiled1.package?.shapes?.[0];
    const shape2 = compiled2.package?.shapes?.[0];
    assert(shape1?.x === shape2?.x && shape1?.y === shape2?.y && shape1?.w === shape2?.w && shape1?.h === shape2?.h, `posição/tamanho deveriam ser estáveis entre save/reload, recebido ${JSON.stringify(shape1)} vs ${JSON.stringify(shape2)}`);
    assert(shape1?.stroke === shape2?.stroke && shape1?.fill === shape2?.fill, "estilo deveria ser estável entre save/reload");
  });

  await test("elemento do Package sem nenhum objeto Package na cena é erro bloqueante (mesma regra dos pinos)", () => {
    const shape: WebviewComponentModel = { id: "orphan", typeId: "graphics.rectangle", label: "r", x: 0, y: 0, rotation: 0, pins: [], packageShapeRole: true, properties: { width: 8, height: 8 } };
    const compiled = compilePackageAuthoringComponents([shape]);
    assert(compiled.errors.some((e) => e.includes("sem nenhum objeto Package")), `esperava erro de elemento órfão, recebido: ${compiled.errors.join(" | ")}`);
  });

  finish();
})();
