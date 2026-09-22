import { createTestRunner, assert } from "../../ipc/testSupport/MockCoreServer";
import {
  IPD_LINE_CLASSES,
  ipdLineClassCssSuffix,
  ipdLineClassLabel,
  ipdGlyphStations,
  ipdLineStroke,
  isIpdLineClass,
  isIpdProcessClass,
} from "./ipdLineStyle";

(async () => {
  const { test, finish } = createTestRunner("ipdLineStyle — classes ISA/IPD");

  await test("expõe as 16 classes atuais do IPD sem duplicatas", () => {
    assert(IPD_LINE_CLASSES.length === 16, "deveria haver 16 classes");
    assert(new Set(IPD_LINE_CLASSES).size === 16, "classes deveriam ser únicas");
  });

  await test("preserva larguras e tracejados representativos", () => {
    assert(ipdLineStroke("process.major").width === 2.5, "processo principal deveria ter 2,5 px");
    assert(ipdLineStroke("signal.electric").dasharray === "4 3", "sinal elétrico deveria ser tracejado");
    assert(ipdLineStroke("pipe.battery-limit").dasharray === "12 4 3 4", "limite de bateria deveria preservar o padrão");
  });

  await test("marca somente a tubulação jaquetada como traço duplo", () => {
    const doubles = IPD_LINE_CLASSES.filter((lineClass) => ipdLineStroke(lineClass).double);
    assert(JSON.stringify(doubles) === JSON.stringify(["pipe.jacketed"]), "somente pipe.jacketed deveria ser duplo");
  });

  await test("classifica processo e tubulação sem confundir sinais", () => {
    assert(isIpdProcessClass("process.impulse"), "impulso pertence à família de processo no IPD");
    assert(isIpdProcessClass("pipe.traced"), "pipe.* deveria ser processo");
    assert(!isIpdProcessClass("signal.pneumatic"), "signal.* não deveria ser processo");
  });

  await test("valida entrada persistida sem aceitar aproximações", () => {
    assert(isIpdLineClass("signal.data"), "classe válida deveria passar");
    assert(!isIpdLineClass("signal-data"), "alias inventado deveria falhar");
    assert(!isIpdLineClass(undefined), "ausência não deveria virar classe");
  });

  await test("fornece rótulos em português e inglês", () => {
    assert(ipdLineClassLabel("pipe.jacketed", "pt-BR") === "Tubulação jaquetada", "rótulo pt-BR incorreto");
    assert(ipdLineClassLabel("pipe.jacketed", "en") === "Jacketed pipe", "rótulo inglês incorreto");
  });

  await test("gera sufixo CSS estável sem ponto", () => {
    assert(ipdLineClassCssSuffix("pipe.battery-limit") === "pipe-battery-limit", "sufixo CSS incorreto");
  });

  await test("posiciona glifos ao longo da rota sem invadir extremidades ou cantos", () => {
    const stations = ipdGlyphStations([{ x: 0, y: 0 }, { x: 72, y: 0 }, { x: 72, y: 72 }], 24);
    assert(JSON.stringify(stations.map(({ x, y, angle }) => ({ x, y, angle }))) === JSON.stringify([
      { x: 24, y: 0, angle: 0 },
      { x: 48, y: 0, angle: 0 },
      { x: 72, y: 24, angle: 90 },
      { x: 72, y: 48, angle: 90 },
    ]), "estações deveriam respeitar o cotovelo");
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();
