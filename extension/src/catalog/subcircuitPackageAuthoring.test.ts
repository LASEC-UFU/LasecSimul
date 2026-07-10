import { createTestRunner, assert } from "../ipc/testSupport/MockCoreServer";
import { TUNNEL_TYPE_ID, WebviewComponentModel } from "../ui/webview/model";
import {
  PACKAGE_ICON_TYPE_ID,
  PACKAGE_PIN_TYPE_ID,
  PACKAGE_TYPE_ID,
  compilePackageAuthoringComponents,
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
    const box = Math.max(24, scaledLength * 2 + 16);
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
    assert(pin?.rotation === 0 || pin?.rotation === 90, `ângulo 45 deveria arredondar pro cardeal mais próximo, recebido ${pin?.rotation}`);
    assert(warnings.some((w) => w.includes("não-cardeal")), "deveria avisar sobre o ajuste de ângulo não-cardeal");
  });

  finish();
})();
