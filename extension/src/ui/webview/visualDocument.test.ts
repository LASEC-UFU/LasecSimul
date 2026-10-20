import { createTestRunner, assert } from "../../ipc/testSupport/MockCoreServer";
import {
  HMI_SCREEN_TYPE_ID, classifyWindowState, createScreenDocument, duplicateScreenDocument, isOtherWindow, remapBindingPaths, screenIdOf,
  uniqueScreenId, uniqueScreenTitle, type WebviewGeometry,
} from "./visualDocument";

// Medições reais do experimento (docs/poc/janelas-auxiliares-vscode, VS Code 1.128/1.141, dois monitores).
const PRIMARY = { width: 1920, height: 1080, availWidth: 1920, availHeight: 1032, availLeft: 0, availTop: 0 };
const LEFT = { width: 1366, height: 768, availWidth: 1366, availHeight: 720, availLeft: -1366, availTop: 0 };
const geo = (screenX: number, screenY: number, outer: [number, number], inner: [number, number], screen = PRIMARY): WebviewGeometry =>
  ({ screenX, screenY, outerWidth: outer[0], outerHeight: outer[1], innerWidth: inner[0], innerHeight: inner[1], devicePixelRatio: 1, screen });

(async () => {
  const { test, finish } = createTestRunner("visualDocument");

  await test("documento novo tem uma página 1920×1080 e tela cheia no contexto Laboratório", () => {
    const doc = createScreenDocument("tela-1", "Tela HMI");
    assert(doc.kind === "screen" && doc.id === "tela-1" && doc.title === "Tela HMI", "identidade");
    assert(doc.pages.length === 1 && doc.pages[0]!.width === 1920 && doc.pages[0]!.height === 1080, "página padrão");
    assert(doc.startPageId === doc.pages[0]!.id, "página inicial");
    assert(doc.presentation.fullscreenContext === "lab", "política de tela cheia");
  });

  await test("ids e títulos únicos sem reaproveitar existentes", () => {
    assert(uniqueScreenId(new Set()) === "tela-1", "primeiro id");
    assert(uniqueScreenId(new Set(["tela-1", "tela-2"])) === "tela-3", "próximo livre");
    assert(uniqueScreenId(new Set(), "Laboratório de Cálculo") === "laboratorio-de-calculo-1", "slug sem acento");
    assert(uniqueScreenTitle("Tela HMI", new Set(["Tela HMI"])) === "Tela HMI (2)", "título duplicado");
    assert(uniqueScreenTitle("Tela HMI (2)", new Set(["Tela HMI (2)", "Tela HMI"])) === "Tela HMI (3)", "título numerado");
  });

  await test("screenId só vale para o botão de tela", () => {
    assert(screenIdOf({ typeId: HMI_SCREEN_TYPE_ID, properties: { screenId: " tela-2 " } }) === "tela-2", "botão");
    assert(screenIdOf({ typeId: "graphics.label", properties: { screenId: "x" } }) === undefined, "outro tipo");
    assert(screenIdOf({ typeId: HMI_SCREEN_TYPE_ID, properties: {} }) === undefined, "sem id");
  });

  await test("duplicar gera cópia independente com páginas e navegação remapeadas", () => {
    const source = createScreenDocument("tela-1", "A");
    source.pages.push({ id: "p2", name: "Dois", width: 800, height: 600, elements: [{ id: "e1", typeId: "graphics.label", visual: { x: 1, y: 2, width: 3, height: 4 } }], navigation: [] });
    source.pages[0]!.navigation = [{ id: "n1", label: "ir", targetPageId: "p2", visual: { x: 0, y: 0, width: 10, height: 10 } }];
    const copy = duplicateScreenDocument(source, "tela-2", "B");
    assert(copy.id === "tela-2" && copy.title === "B", "identidade nova");
    assert(copy.pages.every((page) => !source.pages.some((other) => other.id === page.id)), "páginas com ids novos");
    assert(copy.pages[0]!.navigation![0]!.targetPageId === copy.pages[1]!.id, "navegação aponta para a cópia");
    copy.pages[1]!.elements[0]!.visual.x = 99;
    assert(source.pages[1]!.elements[0]!.visual.x === 1, "sem compartilhar objetos");
  });

  await test("classifica normal, maximizada e tela cheia com as medições da PoC", () => {
    assert(classifyWindowState(geo(440, 160, [1040, 776], [1024, 678])) === "normal", "janela auxiliar padrão");
    assert(classifyWindowState(geo(0, 0, [1920, 1032], [1920, 1002])) === "maximized", "maximizada");
    assert(classifyWindowState(geo(0, 0, [1920, 1080], [1920, 990])) === "fullscreen", "tela cheia não compacta (92 px de moldura)");
    assert(classifyWindowState(geo(0, 0, [1920, 1080], [1920, 1050])) === "fullscreen", "tela cheia compacta (30 px)");
    assert(classifyWindowState(geo(8, 8, [1904, 1064], [1920, 1080])) === "fullscreen", "tela cheia vinda de maximizada");
    assert(classifyWindowState(geo(-1366, 0, [1366, 768], [1366, 768], LEFT)) === "fullscreen", "tela cheia no monitor secundário");
    assert(classifyWindowState(geo(-1366, 0, [1366, 720], [1366, 690], LEFT)) === "maximized", "maximizada no secundário");
  });

  await test("detecta janela diferente da principal", () => {
    const main = geo(352, 140, [1216, 808], [846, 698]);
    assert(!isOtherWindow(geo(352, 140, [1216, 808], [700, 500]), main), "acoplada");
    assert(isOtherWindow(geo(440, 160, [1040, 776], [1024, 678]), main), "flutuante");
    assert(!isOtherWindow(geo(440, 160, [1040, 776], [1024, 678]), undefined), "sem referência não afirma");
  });

  await test("colar entre contextos remapeia ligações (Faceplate ↔ Tela)", () => {
    const fromFaceplate = remapBindingPaths({ bindSource: "acc", bindSourceB: "planta-2:h", value: 1 }, "planta-1", undefined);
    assert(fromFaceplate.bindSource === "planta-1:acc" && fromFaceplate.bindSourceB === "planta-2:h", "interno vira caminho da instância de origem");
    const intoFaceplate = remapBindingPaths({ bindSource: "planta-1:acc", bindSourceB: "k1" }, undefined, "planta-1");
    assert(intoFaceplate.bindSource === "acc" && intoFaceplate.bindSourceB === "k1", "caminho da própria instância vira id interno");
    const between = remapBindingPaths({ bindSource: "acc" }, "planta-1", "planta-2");
    assert(between.bindSource === "acc", "entre Faceplates o id interno vale para a outra instância");
  });

  finish();
})();
