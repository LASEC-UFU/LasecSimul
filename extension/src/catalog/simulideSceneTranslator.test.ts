import { createTestRunner, assert } from "../ipc/testSupport/MockCoreServer";
import { extractSimulideSubcircuitScene, translateSimulideSubcircuitAuthoringScene } from "./simulideSceneTranslator";
import { PackageDescriptor, WebviewComponentModel, WebviewWireModel } from "../ui/webview/model";
import { registerPackage } from "../ui/webview/componentSymbols";

(async () => {
  const { test, finish } = createTestRunner("simulideSceneTranslator - subcircuit authoring scene");

  await test("extractSimulideSubcircuitScene: le authoringScene.package do manifesto", () => {
    const scene = extractSimulideSubcircuitScene({
      authoringScene: {
        package: { x: 70, y: 232 },
        transform: { scaleX: 2.714442258, scaleY: 1.719123611 },
        components: [
          {
            componentId: "tunnel_G22",
            x: 721,
            y: 88,
            rotation: 90,
            flipH: true,
          },
        ],
        wires: [
          {
            from: { componentId: "a", pinId: "p1" },
            to: { componentId: "b", pinId: "p2" },
            points: [{ x: 10, y: 20 }],
          },
        ],
      },
    });
    assert(Boolean(scene), "cena deveria ser extraida");
    assert(scene!.package?.x === 70 && scene!.package.y === 232, `posicao do package deveria vir do manifesto, recebido ${JSON.stringify(scene)}`);
    assert(scene!.transform?.scaleX === 2.714442258 && scene!.transform.scaleY === 1.719123611, "transform da cena SimulIDE deveria ser extraido");
    assert(scene!.components?.[0]?.rotation === 90 && scene!.components[0]!.flipH === true, "posicao/rotacao/flip de componente deveriam ser extraidos da cena");
    assert(scene!.wires?.[0]?.points[0]?.x === 10, "rotas de fio declaradas deveriam ser extraidas da cena");
  });

  await test("translateSimulideSubcircuitAuthoringScene: aplica translate declarativo no package e preserva circuito interno", () => {
    const packageComponents: WebviewComponentModel[] = [
      { id: "symbol-package-0", typeId: "other.package", label: "package", hidden: false, x: 0, y: 0, rotation: 0, pins: [], properties: { width: 88, height: 176 } },
      { id: "symbol-pin-0", typeId: "other.package_pin", label: "pin", hidden: false, x: 80, y: 10, rotation: 0, pins: [], properties: { pinId: "GND1", length: 8 } },
    ];
    const internalComponents: WebviewComponentModel[] = [
      { id: "mcu1", typeId: "espressif.esp32", label: "mcu1", hidden: false, x: 640, y: 160, rotation: 0, pins: [], properties: {} },
    ];
    const wires: WebviewWireModel[] = [
      { id: "w1", from: { componentId: "mcu1", pinId: "GPIO23" }, to: { componentId: "tunnel_G23", pinId: "pin" }, points: [{ x: 700, y: 200 }] },
    ];

    const translated = translateSimulideSubcircuitAuthoringScene(packageComponents, internalComponents, wires, { package: { x: 70, y: 232 } });
    const translatedPackage = translated.components.find((component) => component.id === "symbol-package-0")!;
    const translatedPin = translated.components.find((component) => component.id === "symbol-pin-0")!;
    const translatedMcu = translated.components.find((component) => component.id === "mcu1")!;

    assert(translatedPackage.x === 70 && translatedPackage.y === 232, "package deveria ir para authoringScene.package");
    assert(translatedPin.x === 150 && translatedPin.y === 242, "pinos/formas do package devem receber o mesmo translate do corpo");
    assert(translatedMcu.x === 640 && translatedMcu.y === 160, "componentes internos nao devem ser reposicionados pelo tradutor");
    assert(translated.wires[0] === wires[0], "fios internos devem ser preservados, sem reroute artificial");
  });

  await test("translateSimulideSubcircuitAuthoringScene: aplica points declarados por endpoint do fio", () => {
    const wires: WebviewWireModel[] = [
      { id: "internal-wire-0", from: { componentId: "a", pinId: "p1" }, to: { componentId: "b", pinId: "p2" } },
      { id: "internal-wire-1", from: { componentId: "c", pinId: "p1" }, to: { componentId: "d", pinId: "p2" } },
    ];
    const translated = translateSimulideSubcircuitAuthoringScene([], [], wires, {
      wires: [
        {
          from: { componentId: "b", pinId: "p2" },
          to: { componentId: "a", pinId: "p1" },
          points: [{ x: 100, y: 40 }, { x: 120, y: 40 }],
        },
      ],
    });
    assert(translated.wires[0]!.points?.length === 2 && translated.wires[0]!.points[0]!.x === 100, "rota declarada deveria ser aplicada mesmo com from/to invertidos");
    assert(translated.wires[1] === wires[1], "fio sem rota declarada deveria permanecer intocado");
  });

  await test("translateSimulideSubcircuitAuthoringScene: aplica posicao rotacao e flip declarados por componentId", () => {
    const components: WebviewComponentModel[] = [
      { id: "tunnel_G22", typeId: "connectors.tunnel", label: "G22", hidden: false, x: 10, y: 20, rotation: 0, pins: [], properties: { name: "G22" } },
      { id: "mcu1", typeId: "espressif.esp32", label: "mcu1", hidden: false, x: 640, y: 160, rotation: 0, pins: [], properties: {} },
    ];
    const translated = translateSimulideSubcircuitAuthoringScene([], components, [], {
      components: [{ componentId: "tunnel_G22", x: 212, y: -100, rotation: 90, flipH: true, flipV: false }],
    });
    const tunnel = translated.components.find((component) => component.id === "tunnel_G22")!;
    const mcu = translated.components.find((component) => component.id === "mcu1")!;
    assert(tunnel.x === 212 && tunnel.y === -106 && tunnel.rotation === 90, "Tunnel deveria converter Pos Qt em top-left subtraindo a origem local do render");
    assert(tunnel.flipH === false && tunnel.flipV === false, "Tunnel nao deveria receber flip SVG generico; hflip do SimulIDE vira setRotated");
    assert(tunnel.properties.__simulideTunnelRotated === true, "hflip=-1 do Tunnel no SimulIDE deveria virar Tunnel::setRotated(true)");
    assert(mcu.x === 640 && mcu.y === 160, "componente sem placement declarado deveria permanecer intocado");
  });

  await test("translateSimulideSubcircuitAuthoringScene: package usa origem Qt exposta pelo renderer", () => {
    const pkg: PackageDescriptor = {
      width: 60,
      height: 40,
      border: true,
      pins: [{ id: "p1", x: -8, y: 20, angle: 180, length: 8, label: "P1", leadOrigin: "terminal" }],
    };
    registerPackage("test.qt-package", pkg);
    const components: WebviewComponentModel[] = [
      { id: "chip", typeId: "test.qt-package", label: "chip", hidden: false, x: 0, y: 0, rotation: 0, pins: [{ id: "p1", x: 0, y: 0 }], properties: {} },
    ];
    const translated = translateSimulideSubcircuitAuthoringScene([], components, [], {
      transform: { scaleX: 2, scaleY: 3 },
      components: [{ componentId: "chip", x: 124, y: -60, rotation: 0 }],
    });
    const chip = translated.components.find((component) => component.id === "chip")!;
    assert(chip.x === 108 && chip.y === -60, `package deveria subtrair offset local escalado do renderer, recebido x=${chip.x} y=${chip.y}`);
    assert(chip.properties.__simulideQtOrigin === true, "placement vindo do SimulIDE deve marcar origem Qt para o renderer");
    assert(chip.properties.__simulideSceneScaleX === 2 && chip.properties.__simulideSceneScaleY === 3, "escala da cena SimulIDE deve ser repassada para o renderer");
  });

  await test("translateSimulideSubcircuitAuthoringScene: NAO reaplica a cena (regressao de distorcao) num componente que ja foi traduzido antes", () => {
    // Reproduz o bug real: "insiro um componente novo, aparece certo; depois de salvar e reabrir,
    // alguns componentes voltam distorcidos" -- `authoringScene` e um snapshot CONGELADO da
    // importacao original (nunca atualizado depois de salvar, ver `persistSubcircuitAuthoringScene`
    // em extension.ts). Reaplicar a cada abertura reescrevia x/y/rotation/flip do snapshot antigo
    // por cima de qualquer edicao manual feita depois, e reaplicava `__simulideSceneScaleX/Y` (que
    // ESTICA o componente de forma NAO uniforme quando os dois eixos tem escalas diferentes,
    // distorcendo a proporcao de um chip quadrado ou resistor).
    const pkg: PackageDescriptor = {
      width: 60,
      height: 40,
      border: true,
      pins: [{ id: "p1", x: -8, y: 20, angle: 180, length: 8, label: "P1", leadOrigin: "terminal" }],
    };
    registerPackage("test.qt-package-2", pkg);
    const scene = {
      transform: { scaleX: 2, scaleY: 3 },
      components: [{ componentId: "chip", x: 124, y: -60, rotation: 0 as const }],
      wires: [{ from: { componentId: "chip", pinId: "p1" }, to: { componentId: "other", pinId: "p2" }, points: [{ x: 999, y: 999 }] }],
    };

    // 1ª sessão: componente recém-importado (sem marcador ainda) -- a tradução DEVE aplicar.
    const freshComponents: WebviewComponentModel[] = [
      { id: "chip", typeId: "test.qt-package-2", label: "chip", hidden: false, x: 0, y: 0, rotation: 0, pins: [{ id: "p1", x: 0, y: 0 }], properties: {} },
    ];
    const freshWires: WebviewWireModel[] = [
      { id: "w1", from: { componentId: "chip", pinId: "p1" }, to: { componentId: "other", pinId: "p2" } },
    ];
    const firstOpen = translateSimulideSubcircuitAuthoringScene([], freshComponents, freshWires, scene);
    const chipFirstOpen = firstOpen.components.find((component) => component.id === "chip")!;
    assert(chipFirstOpen.properties.__simulideQtOrigin === true, "1ª abertura deveria marcar __simulideQtOrigin (nunca visto antes)");
    assert(chipFirstOpen.properties.__simulideSceneScaleX === 2, "1ª abertura deveria aplicar a escala da cena");
    assert(firstOpen.wires[0]!.points?.[0]?.x === 999, "1ª abertura deveria aplicar a rota de fio declarada");

    // 2ª sessão: simula reabrir o MESMO arquivo depois de salvo -- `compileSubcircuitInternalComponents`
    // grava `properties`/`visual` verbatim, então o componente chega aqui JÁ com o marcador. O usuário
    // moveu manualmente o componente (x=555,y=777) e editou a rota do fio DEPOIS da 1ª sessão -- a
    // tradução NÃO pode desfazer isso usando o snapshot antigo (x=124,y=-60 / rota [999,999]).
    const editedAfterFirstSave: WebviewComponentModel[] = [
      { ...chipFirstOpen, x: 555, y: 777 },
    ];
    const editedWires: WebviewWireModel[] = [
      { id: "w1", from: { componentId: "chip", pinId: "p1" }, to: { componentId: "other", pinId: "p2" }, points: [{ x: 1, y: 2 }] },
    ];
    const secondOpen = translateSimulideSubcircuitAuthoringScene([], editedAfterFirstSave, editedWires, scene);
    const chipSecondOpen = secondOpen.components.find((component) => component.id === "chip")!;
    assert(chipSecondOpen.x === 555 && chipSecondOpen.y === 777, `2ª abertura NÃO deveria sobrescrever a posição editada manualmente, recebido x=${chipSecondOpen.x} y=${chipSecondOpen.y}`);
    assert(secondOpen.wires[0]!.points?.[0]?.x === 1, "2ª abertura NÃO deveria sobrescrever a rota de fio editada manualmente");

    // Um componente NOVO (nunca visto na cena original, sem o marcador) inserido na MESMA sessão
    // continua de fora da tradução -- nunca ganha a escala/marcador de outra importação.
    const brandNewComponent: WebviewComponentModel = { id: "new-one", typeId: "passive.resistor", label: "R-new", hidden: false, x: 10, y: 10, rotation: 0, pins: [], properties: {} };
    const thirdOpen = translateSimulideSubcircuitAuthoringScene([], [...editedAfterFirstSave, brandNewComponent], editedWires, scene);
    const newOnly = thirdOpen.components.find((component) => component.id === "new-one")!;
    assert(newOnly.properties.__simulideQtOrigin === undefined, "componente novo na mesma sessão não deveria ganhar marcador/escala de outra importação");
  });

  finish();
})();
