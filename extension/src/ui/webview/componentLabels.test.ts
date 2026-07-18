import { createTestRunner, assert } from "../../ipc/testSupport/MockCoreServer";
import fs from "node:fs";
import path from "node:path";
import { componentBox, registerPackage } from "./componentSymbols";
import { PackageDescriptor } from "./model";
import {
  DEFAULT_EXTERNAL_LABEL_FONT_SIZE,
  DEFAULT_ID_LABEL_COLOR,
  DEFAULT_VALUE_LABEL_COLOR,
  SYMBOL_PIN_LABEL_ALIGN_KEY,
  genericExternalLabelFontSize,
  formatProbeVoltage,
  isExternalProbeReadout,
  labelPropertyKey,
  nextLabelRotation,
  resolveDefaultExternalLabelOffset,
  resolveExternalLabelColor,
  symbolPinLabelPackageFields,
} from "./componentLabels";

(async () => {
  const { test, finish } = createTestRunner("componentLabels — sistema genérico de rótulo (posição/cor/tamanho)");

  await test("Probe: leitura é rótulo externo e segue o arredondamento de 0,01 V do SimulIDE", () => {
    assert(isExternalProbeReadout("meters.probe"), "meters.probe deveria usar o rótulo externo");
    assert(!isExternalProbeReadout("instruments.voltmeter"), "voltímetro continua com mostrador embutido");
    assert(formatProbeVoltage(2.4049, true) === "2.4 V", `recebido ${formatProbeVoltage(2.4049, true)}`);
    assert(formatProbeVoltage(-0.004, true) === "0 V", `zero negativo não deveria aparecer: ${formatProbeVoltage(-0.004, true)}`);
    assert(formatProbeVoltage(undefined, true) === "... V", "antes da primeira amostra deve mostrar ... V");
    assert(formatProbeVoltage(undefined, false) === "0 V", "parado deve mostrar 0 V");
  });

  /** Mesmo helper de `componentSymbols.test.ts` -- lê o `package` REAL do catálogo em vez de um
   * literal escrito à mão, pra pegar o mesmo bug se a geometria do typeId mudar no catálogo. */
  function catalogPackage(typeId: string): PackageDescriptor {
    const candidates = [
      path.resolve(process.cwd(), "..", "project", "schema", "component-catalog.json"),
      path.resolve(process.cwd(), "project", "schema", "component-catalog.json"),
    ];
    const catalogPath = candidates.find((candidate) => fs.existsSync(candidate));
    if (!catalogPath) throw new Error("component-catalog.json nao localizado para teste de rótulo");
    const catalog = JSON.parse(fs.readFileSync(catalogPath, "utf8")) as { items?: Array<{ typeId?: string; package?: PackageDescriptor }> };
    const item = catalog.items?.find((entry) => entry.typeId === typeId);
    if (!item?.package) throw new Error(`package nao localizado no catalogo para ${typeId}`);
    registerPackage(typeId, item.package);
    return item.package;
  }

  // ── Bug A: offset padrão do id/value precisa centralizar na LARGURA real do corpo, nunca ficar
  // preso na borda esquerda (`x:0` fixo) -- achado real: corpos ESTREITOS (switch_dip 24px, relay
  // 32px) tinham o rótulo ancorado na borda esquerda, um texto de rótulo mais longo que o corpo se
  // estendia bem além da borda direita, invadindo pinos/componentes vizinhos (lido como "a label não
  // aparece"/"não dá pra mover"). Testado contra o `package` REAL do catálogo (não um número
  // hand-typed), pra pegar regressão se a largura declarada mudar. ──────────────────────────────────
  for (const typeId of ["switches.switch_dip", "switches.relay", "switches.keypad"]) {
    await test(`${typeId}: offset padrão do rótulo id/value centraliza na largura real do corpo (Bug A)`, () => {
      const pkg = catalogPackage(typeId);
      const box = componentBox(typeId, {});
      assert(box.width === pkg.width, `componentBox deveria bater com package.width, recebido ${JSON.stringify(box)} vs pkg.width=${pkg.width}`);

      const idOffset = resolveDefaultExternalLabelOffset("id", box);
      assert(idOffset.x === box.width / 2, `id-label deveria centralizar em box.width/2=${box.width / 2}, recebido x=${idOffset.x}`);
      assert(idOffset.y === -14, `id-label deveria continuar 14px acima do topo do corpo (y=0), recebido y=${idOffset.y}`);

      const valueOffset = resolveDefaultExternalLabelOffset("value", box);
      assert(valueOffset.x === box.width / 2, `value-label deveria centralizar em box.width/2=${box.width / 2}, recebido x=${valueOffset.x}`);
      assert(valueOffset.y === box.height + 2, `value-label deveria continuar 2px abaixo do fundo do corpo, recebido y=${valueOffset.y}, esperado ${box.height + 2}`);
    });
  }

  // ── Sem regressão em componentes "normais" (largos o bastante que o bug antigo não incomodava
  // visualmente) -- a centralização precisa continuar valendo igual, não só pros switches estreitos. ──
  for (const typeId of ["passive.resistor", "outputs.led"]) {
    await test(`${typeId}: offset padrão do rótulo id/value também centraliza (sem regressão fora de switches)`, () => {
      const box = componentBox(typeId, {});
      const idOffset = resolveDefaultExternalLabelOffset("id", box);
      const valueOffset = resolveDefaultExternalLabelOffset("value", box);
      assert(idOffset.x === box.width / 2, `id-label deveria centralizar, recebido x=${idOffset.x} pra box.width=${box.width}`);
      assert(valueOffset.x === box.width / 2, `value-label deveria centralizar, recebido x=${valueOffset.x} pra box.width=${box.width}`);
    });
  }

  await test("resolveDefaultExternalLabelOffset: override de package.valueLabel continua tendo prioridade sobre o cálculo genérico", () => {
    const box = { width: 100, height: 40 };
    const offset = resolveDefaultExternalLabelOffset("value", box, { x: 7, y: 9 });
    assert(offset.x === 7 && offset.y === 9, `package.valueLabel deveria vencer o cálculo genérico, recebido ${JSON.stringify(offset)}`);
    // "id" nunca lê `packageValueLabel` (conceito exclusivo do rótulo de valor).
    const idOffset = resolveDefaultExternalLabelOffset("id", box, { x: 7, y: 9 });
    assert(idOffset.x === box.width / 2, `id-label não deveria ser afetado por packageValueLabel, recebido ${JSON.stringify(idOffset)}`);
  });

  // ── Bug B: tamanho de fonte por-kind, mesmo padrão de nomenclatura de x/y/rotation/color ──────────
  await test("labelPropertyKey: sufixo 'size' produz __ui_idLabelSize/__ui_valueLabelSize", () => {
    assert(labelPropertyKey("id", "size") === "__ui_idLabelSize", `recebido ${labelPropertyKey("id", "size")}`);
    assert(labelPropertyKey("value", "size") === "__ui_valueLabelSize", `recebido ${labelPropertyKey("value", "size")}`);
    // Sufixos existentes continuam intactos (não regredir o mecanismo já usado por x/y/rotation/color).
    assert(labelPropertyKey("id", "x") === "__ui_idLabelX", `recebido ${labelPropertyKey("id", "x")}`);
    assert(labelPropertyKey("value", "color") === "__ui_valueLabelColor", `recebido ${labelPropertyKey("value", "color")}`);
  });

  await test("genericExternalLabelFontSize: default 11 (bate com o CSS) quando nunca customizado, e respeita override", () => {
    assert(genericExternalLabelFontSize("id", {}) === DEFAULT_EXTERNAL_LABEL_FONT_SIZE, "default deveria ser 11 (mesmo font-size fixo do CSS)");
    assert(genericExternalLabelFontSize("value", {}) === DEFAULT_EXTERNAL_LABEL_FONT_SIZE, "default deveria ser 11 pro value também");
    const customized = genericExternalLabelFontSize("id", { __ui_idLabelSize: 18 });
    assert(customized === 18, `override deveria vencer o default, recebido ${customized}`);
    // Chave errada (kind trocado) não pode vazar pro outro kind.
    const notLeaked = genericExternalLabelFontSize("value", { __ui_idLabelSize: 18 });
    assert(notLeaked === DEFAULT_EXTERNAL_LABEL_FONT_SIZE, `__ui_idLabelSize não deveria afetar o kind "value", recebido ${notLeaked}`);
  });

  // ── Bug C: cor default por-kind bate com o CSS real (.component-floating-label--id/--value) ──────
  await test("resolveExternalLabelColor: defaults por-kind batem com as cores reais do CSS", () => {
    assert(resolveExternalLabelColor("id", {}) === DEFAULT_ID_LABEL_COLOR, `default id deveria ser ${DEFAULT_ID_LABEL_COLOR}`);
    assert(resolveExternalLabelColor("value", {}) === DEFAULT_VALUE_LABEL_COLOR, `default value deveria ser ${DEFAULT_VALUE_LABEL_COLOR}`);
    const customized = resolveExternalLabelColor("id", { __ui_idLabelColor: "#ff0000" });
    assert(customized === "#ff0000", `override deveria vencer o default, recebido ${customized}`);
  });

  // ── symbolPinLabelPackageFields: fonte ÚNICA compartilhada entre compileSymbolScene (host) e
  // compileLiveSymbolPins (main.ts) -- bug real corrigido: os dois tinham o MESMO hardcode
  // `labelTextAnchor:"middle"` incondicional cada um por conta própria, então corrigir só um lado
  // deixava o preview ao vivo divergente do arquivo salvo. ────────────────────────────────────────
  await test("symbolPinLabelPackageFields: sem customização não escreve nada (deixa o default por ângulo do packagePinLeadSvg valer)", () => {
    const fields = symbolPinLabelPackageFields({}, undefined);
    assert(Object.keys(fields).length === 0, `esperado objeto vazio, recebido ${JSON.stringify(fields)}`);
  });

  await test("symbolPinLabelPackageFields: alinhamento customizado grava labelTextAnchor + labelDominantBaseline", () => {
    const fields = symbolPinLabelPackageFields({ [SYMBOL_PIN_LABEL_ALIGN_KEY]: "end" }, undefined);
    assert(fields.labelTextAnchor === "end", `recebido ${JSON.stringify(fields)}`);
    assert(fields.labelDominantBaseline === "middle", `recebido ${JSON.stringify(fields)}`);
    assert(fields.labelHidden === undefined, "labelHidden não deveria ser afetado por alinhamento");
  });

  await test("symbolPinLabelPackageFields: showId===false grava labelHidden:true, showId ausente/true não grava nada", () => {
    const hidden = symbolPinLabelPackageFields({}, false);
    assert(hidden.labelHidden === true, `recebido ${JSON.stringify(hidden)}`);
    const shownAbsent = symbolPinLabelPackageFields({}, undefined);
    assert(shownAbsent.labelHidden === undefined, `showId ausente não deveria gravar labelHidden, recebido ${JSON.stringify(shownAbsent)}`);
    const shownTrue = symbolPinLabelPackageFields({}, true);
    assert(shownTrue.labelHidden === undefined, `showId===true não deveria gravar labelHidden, recebido ${JSON.stringify(shownTrue)}`);
  });

  await test("symbolPinLabelPackageFields: valor de alinhamento inválido é ignorado (nunca propaga lixo pro PackagePin)", () => {
    const fields = symbolPinLabelPackageFields({ [SYMBOL_PIN_LABEL_ALIGN_KEY]: "center" }, undefined);
    assert(fields.labelTextAnchor === undefined, `"center" não é um valor válido de labelTextAnchor, recebido ${JSON.stringify(fields)}`);
  });

  // ── nextLabelRotation: mesma fórmula de rotateSelectedComponents, extraída pra ficar testável ────
  await test("nextLabelRotation: gira em passos de 90°, com wrap-around nos dois sentidos", () => {
    assert(nextLabelRotation(0, 1) === 90, `0+1 deveria ser 90, recebido ${nextLabelRotation(0, 1)}`);
    assert(nextLabelRotation(0, -1) === 270, `0-1 deveria dar wrap pra 270, recebido ${nextLabelRotation(0, -1)}`);
    assert(nextLabelRotation(90, 2) === 270, `90+180 deveria ser 270, recebido ${nextLabelRotation(90, 2)}`);
    assert(nextLabelRotation(270, 1) === 0, `270+90 deveria dar wrap pra 0, recebido ${nextLabelRotation(270, 1)}`);
  });

  finish();
})();
