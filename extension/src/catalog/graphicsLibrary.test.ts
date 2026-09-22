import { createTestRunner, assert } from "../ipc/testSupport/MockCoreServer";
import { loadUnifiedCatalog } from "./UnifiedCatalog";
import { componentBox, packageSymbolSvg, registerPackage } from "../ui/webview/componentSymbols";
import { graphicalRuntimeProperties } from "../ui/webview/graphicsBinding";
import { propertyFieldKindFromEditor } from "../ui/webview/batchProperties";
import { buildPaletteTree } from "../ui/webview/paletteTree";
import type { WebviewComponentCatalogEntry } from "../ui/webview/model";

/**
 * Gate da biblioteca gráfica de supervisório (`graphics.*`). Renderiza pelo caminho REAL da Webview
 * (`registerPackage` -> `packageSymbolSvg`), não por uma reimplementação de teste: se o símbolo
 * quebra aqui, ele quebra na tela.
 */
const catalog = loadUnifiedCatalog(process.cwd(), "pt-BR").catalog;
for (const entry of catalog) registerPackage(entry.typeId, entry.package, entry.logicSymbolPackage, entry.boardPackage);

const graphics = catalog.filter((entry) => entry.typeId.startsWith("graphics."));
const byTypeId = new Map(graphics.map((entry) => [entry.typeId, entry]));

function render(entry: WebviewComponentCatalogEntry, overrides: Record<string, unknown> = {}, componentId?: string): string {
  const properties = { ...entry.defaultProperties, ...overrides };
  const runtime = { ...properties, ...graphicalRuntimeProperties(properties, () => undefined) };
  // `componentId` ativa o ViewSpec renderer (`packageBodySvg`: `pkg.viewSpec && componentId`), que
  // e' o unico caminho que aplica `stateProjection`. A Webview real sempre passa o id; um teste que
  // o omite exercita um caminho que a tela nunca usa.
  return packageSymbolSvg(entry.typeId, runtime, componentId) ?? "";
}

/** Altura do primeiro `<rect>` preenchido com a cor dada -- é assim que tanque/barra desenham o
 * nível (geometria vinda de `__g_pct`, ver `scripts/generate-graphics-library.mjs`). */
function filledRectHeight(svg: string, fill: string): number {
  const match = new RegExp(`<rect[^>]*height="([-\\d.]+)"[^>]*fill="${fill}"|<rect[^>]*fill="${fill}"[^>]*height="([-\\d.]+)"`).exec(svg);
  if (!match) return -1;
  return Number(match[1] ?? match[2]);
}

(async () => {
  const { test, finish } = createTestRunner("graphicsLibrary");

  await test("a biblioteca existe em Miscelaneos > Grafico, com subsecoes", () => {
    const tree = buildPaletteTree(graphics, "", "misc");
    const root = tree.find((node) => node.kind === "folder" && node.label === "Grafico");
    assert(Boolean(root), "a pasta Grafico deveria existir na aba Miscelaneos");
    if (!root || root.kind !== "folder") throw new Error("pasta Grafico ausente");
    const folders = root.children.filter((node) => node.kind === "folder").map((node) => node.label).sort();
    // "Bombas e Motores" deixou de existir: bomba e motor eram duplicatas nativas de
    // `graphics.hmi.pump`, e o equipamento herdado do IPD vive em `Grafico > HMI > Equipamentos`
    // (widgets ligados ao binding) e em `Grafico > P&ID` (desenho ISA).
    for (const expected of ["Tubulacao", "Tanques e Vasos", "Valvulas", "Instrumentos", "Indicadores", "Controles HMI", "HMI", "P&ID", "Supervisório Industrial", "Formas Basicas"]) {
      assert(folders.includes(expected), `subsecao ${expected} deveria existir -- veio ${JSON.stringify(folders)}`);
    }
  });

  await test("todo simbolo e puramente visual: zero pinos, nunca sincronizado com o Core", () => {
    // `pinCount: 0` é o que faz `coreLifecycle.ts::shouldSyncComponentToCore` devolver false --
    // é a garantia ESTRUTURAL da FEAT-008 de que a visualizacao nao participa do solver.
    for (const entry of graphics) {
      assert(entry.pinCount === 0, `${entry.typeId} deveria ter pinCount 0`);
      assert(entry.graphical === true, `${entry.typeId} deveria ser graphical`);
      assert(entry.workspaceSection === "misc", `${entry.typeId} deveria ficar em Miscelaneos`);
    }
  });

  await test("todo simbolo com package desenha vetor real (sem NaN/undefined no SVG)", () => {
    const withPackage = graphics.filter((entry) => entry.package);
    assert(withPackage.length >= 42, `esperado o conjunto completo de simbolos, veio ${withPackage.length}`);
    for (const entry of withPackage) {
      const svg = render(entry);
      assert(svg.length > 0, `${entry.typeId} nao renderizou nada`);
      assert(!svg.includes("NaN"), `${entry.typeId} gerou NaN em algum atributo`);
      assert(!svg.includes("undefined"), `${entry.typeId} gerou undefined em algum atributo`);
      assert(!/<image\b/.test(svg), `${entry.typeId} usa bitmap -- a biblioteca e vetorial`);
      const box = componentBox(entry.typeId, entry.defaultProperties);
      assert(box.width > 0 && box.height > 0, `${entry.typeId} tem caixa degenerada`);
    }
  });

  await test("redimensionar e por instancia: width/height mudam a caixa e o desenho escala", () => {
    const tank = byTypeId.get("graphics.hmi.tank")!;
    const natural = componentBox(tank.typeId, tank.defaultProperties);
    const bigger = componentBox(tank.typeId, { ...tank.defaultProperties, width: 300, height: 400 });
    assert(bigger.width === 300 && bigger.height === 400, `caixa deveria seguir as propriedades, veio ${bigger.width}x${bigger.height}`);
    assert(natural.width !== bigger.width, "a caixa natural nao pode ser igual a redimensionada");
    assert(render(tank, { width: 300, height: 400 }).length > 0, "o simbolo redimensionado continua desenhando");
  });

  await test("dispositivos preservam proporcao; somente elementos elasticos aceitam escala X/Y independente", () => {
    const elastic = new Set(["graphics.pipe", "graphics.equipment", "graphics.signal_line", "graphics.arrow", "graphics.label",
      // Painel/moldura de area: estica nos dois eixos por definicao, como o retangulo de fundo --
      // nao e um dispositivo, cuja proporcao faz parte do desenho.
      "graphics.group_box",
      // Moldura e tarja do HMI: leem `width`/`height` DIRETO nas primitivas, entao esticar nao
      // escala o desenho -- o traco e o texto mantem o tamanho, como num retangulo de fundo. Os
      // demais widgets portados (barra, display, vaso, valvula, faceplate) tem proporcao desenhada
      // e ficam com `fixed`, senao o texto e os circulos distorcem ao redimensionar.
      "graphics.hmi.panel", "graphics.hmi.alarm_banner"]);
    for (const entry of graphics.filter((candidate) => candidate.package)) {
      const pkg = entry.package!;
      const paint = pkg.simulidePaint;
      // Dois renderizadores vetoriais legitimos: `simulidePaint` (biblioteca nativa, primitivas
      // declarativas) e `shapes[]` com SVG embutido (biblioteca P&ID portada do IPD Studio). A
      // regra de proporcao vale para os dois -- muda so' onde `aspect` e' declarado.
      const drawsVector = Boolean(paint) || (pkg.shapes ?? []).length > 0;
      assert(drawsVector, `${entry.typeId} deveria usar o renderer vetorial`);
      const expected = elastic.has(entry.typeId) ? "variable" : "fixed";
      const aspect = pkg.aspect ?? paint?.aspect;
      assert(aspect === expected, `${entry.typeId}: aspecto deveria ser ${expected}, veio ${aspect}`);
      if (expected === "fixed" && paint) {
        assert(Boolean(paint.referenceSize), `${entry.typeId}: dispositivo fixo sem tamanho vetorial de referencia`);
        assert(paint.referenceSize!.width > 0 && paint.referenceSize!.height > 0, `${entry.typeId}: tamanho de referencia degenerado`);
      }
      if (expected === "fixed" && !paint) {
        // Simbolo portado: o tamanho de referencia e' a propria caixa de projeto do package, e o
        // redimensionamento da instancia passa por `schematicWidth/Height`.
        assert(pkg.width > 0 && pkg.height > 0, `${entry.typeId}: caixa de projeto degenerada`);
        assert(Boolean(pkg.dynamicLayout?.schematicWidth && pkg.dynamicLayout?.schematicHeight),
          `${entry.typeId}: simbolo portado sem schematicWidth/Height -- redimensionar nao escalaria o desenho`);
      }
    }
  });

  await test("balao ISA continua circular mesmo dentro de uma caixa muito larga", () => {
    const instrument = byTypeId.get("graphics.instrument")!;
    const svg = render(instrument, { width: 210, height: 70, housing: "circle" });
    const ellipse = /<ellipse[^>]*\brx="([\d.]+)"[^>]*\bry="([\d.]+)"/.exec(svg);
    assert(Boolean(ellipse), `balao ISA nao produziu ellipse: ${svg.slice(0, 300)}`);
    assert(Number(ellipse![1]) === Number(ellipse![2]), `balao deformado: rx=${ellipse![1]} ry=${ellipse![2]}`);
  });

  await test("caminhos abertos de tubulacao nunca recebem preenchimento", () => {
    for (const typeId of ["graphics.pipe_elbow", "graphics.pipe_cross"]) {
      const svg = render(byTypeId.get(typeId)!);
      const paths = [...svg.matchAll(/<path\b[^>]*>/g)].map((match) => match[0]);
      assert(paths.length > 0, `${typeId} deveria desenhar ao menos um path`);
      assert(paths.every((pathMarkup) => pathMarkup.includes('fill="none"')), `${typeId} gerou massa fechada: ${paths.join(" ")}`);
    }
  });

  await test("Inspector: todo campo usa editor reconhecido e tem default coerente", () => {
    for (const entry of graphics) {
      for (const schema of entry.propertySchema ?? []) {
        const kind = propertyFieldKindFromEditor(schema.editor);
        assert(kind !== "text" || schema.editor === "text", `${entry.typeId}.${schema.id}: editor "${schema.editor}" cairia silenciosamente para texto`);
        assert(schema.id in (entry.defaultProperties ?? {}), `${entry.typeId}.${schema.id} nao tem default em defaultProperties`);
      }
      // As 5 formas legadas (sem `package`) seguem o schema antigo, com grupo "Geral" -- so os
      // simbolos da biblioteca nova respondem pelo contrato de grupos do Inspector.
      if (!entry.package) continue;
      const groups = new Set((entry.propertySchema ?? []).map((schema) => schema.group));
      assert(groups.has("Geometria"), `${entry.typeId} deveria expor o grupo Geometria no Inspector`);
      assert(groups.has("Aparência") || groups.has("Componente"), `${entry.typeId} deveria expor Aparencia ou Componente`);
    }
  });

  await test("tanque: nivel 0 %, 50 % e 100 % desenham alturas crescentes de liquido", () => {
    // O vaso agora é o herdado do HMI Studio do IPD; a cor do líquido é a do tema ISA-101, que é
    // do símbolo e não uma propriedade do usuário -- um tema não se edita instância a instância.
    const tank = byTypeId.get("graphics.hmi.tank")!;
    const liquid = "#9aa8b2";
    const h0 = filledRectHeight(render(tank, { value: 0 }), liquid);
    const h50 = filledRectHeight(render(tank, { value: 50 }), liquid);
    const h100 = filledRectHeight(render(tank, { value: 100 }), liquid);
    assert(h0 === 0, `0 % deveria desenhar altura zero, veio ${h0}`);
    assert(h50 > h0 && h100 > h50, `nivel deveria crescer: ${h0} / ${h50} / ${h100}`);
  });

  await test("tanque: valor fora da faixa satura no desenho, nunca vaza do casco", () => {
    const tank = byTypeId.get("graphics.hmi.tank")!;
    const liquid = "#9aa8b2";
    const cheio = filledRectHeight(render(tank, { value: 100 }), liquid);
    const estourado = filledRectHeight(render(tank, { value: 100000 }), liquid);
    const negativo = filledRectHeight(render(tank, { value: -5000 }), liquid);
    assert(estourado === cheio, `acima da faixa deveria saturar em cheio (${cheio}), veio ${estourado}`);
    assert(negativo === 0, `abaixo da faixa deveria saturar em vazio, veio ${negativo}`);
  });

  await test("valvula: fechada e aberta usam cores de estado distintas, e a posicao aparece", () => {
    // A válvula nativa foi removida por ser duplicata; quem responde ao binding agora é a herdada
    // do HMI Studio. A cor de estado é ISA-101: aberta é o tom ativo, fechada é NEUTRA (um
    // fechamento correto não é um alarme), e não há mais um terceiro tom "parcial".
    const valve = byTypeId.get("graphics.hmi.valve")!;
    const fillOf = (svg: string) => /<polygon[^>]*fill="([^"]+)"/.exec(svg)?.[1];
    const fechada = fillOf(render(valve, { value: 0 }));
    const aberta = fillOf(render(valve, { value: 100 }));
    assert(Boolean(fechada && aberta), "as duas posicoes deveriam desenhar o corpo da valvula");
    assert(fechada !== aberta, `cores deveriam diferir: ${fechada} / ${aberta}`);
    // Modulante: a posicao em % e' parte do desenho, nao um rotulo separado por cima.
    assert(render(valve, { value: 37, throttle: true }).includes("37.0"), "a posicao deveria aparecer no corpo modulante");
  });

  await test("valvula: a variante e uma propriedade, nao um typeId por combinacao", () => {
    // O princípio continua valendo, agora onde ele é mais forte: a válvula globo do porte P&ID
    // carrega 56 combinações (atuador x modo de falha x posicionador) numa ÚNICA entrada.
    const globe = byTypeId.get("graphics.pid.cv_globe");
    assert(Boolean(globe), "a valvula de controle globo do IPD deveria existir");
    const variants = (globe!.package?.shapes ?? []).filter((shape) => shape.kind === "svg");
    assert(variants.length > 20, `esperadas dezenas de variantes numa unica entrada, vieram ${variants.length}`);
    const hmi = byTypeId.get("graphics.hmi.valve")!;
    assert(render(hmi, { throttle: true }) !== render(hmi, { throttle: false }),
      "modulante e on/off deveriam ser a mesma entrada com desenhos diferentes");
  });

  await test("portas IPD preservam geometria vetorial e proveniencia PolyForm", () => {
    // `control_valve_ipd` e `tank_ipd` saíram: eram transcrições parciais feitas antes de o acervo
    // do IPD estar disponível inteiro, e duplicavam `graphics.pid.*` / `graphics.hmi.*`.
    for (const typeId of ["graphics.hmi_lamp_button", "graphics.hmi_toggle"]) {
      const entry = byTypeId.get(typeId);
      assert(Boolean(entry), `${typeId} deveria existir na biblioteca`);
      const provenance = entry!.provenance as Record<string, unknown> | undefined;
      assert(provenance?.license === "PolyForm Noncommercial 1.0.0", `${typeId} perdeu a licença PolyForm`);
      assert(String(provenance?.requiredNotice ?? "").includes("Praharsh Nagpure"), `${typeId} perdeu o aviso autoral`);
      assert(String(provenance?.sourceCommit ?? "").length === 40, `${typeId} sem revisão de origem exata`);
      const svg = render(entry!);
      assert(svg.length > 0 && !/<image\b/.test(svg), `${typeId} deveria renderizar vetor nativo`);
    }
    const valve = byTypeId.get("graphics.hmi.valve")!;
    assert(render(valve, { value: 0 }) !== render(valve, { value: 100 }), "válvula IPD deveria refletir abertura no corpo");
  });

  await test("catalogo P&ID completo do IPD preserva licença, fonte e aviso em cada item", () => {
    const ipd = graphics.filter((entry) => entry.typeId.startsWith("graphics.pid."));
    assert(ipd.length === 193, `esperado o snapshot completo de 193 símbolos IPD, veio ${ipd.length}`);
    for (const entry of ipd) {
      assert(entry.provenance?.license === "PolyForm Noncommercial 1.0.0", `${entry.typeId} sem licença PolyForm`);
      assert(entry.provenance?.sourceCommit === "4b84fb8694bc89985872690366e8be2e32a8db2b", `${entry.typeId} sem commit fixado`);
      assert(Boolean(entry.provenance?.sourceFiles?.[0]?.startsWith("src/symbols/lib/")), `${entry.typeId} sem arquivo de origem`);
      assert(Boolean(entry.provenance?.requiredNotice?.includes("Praharsh Nagpure")), `${entry.typeId} sem aviso obrigatório`);
    }
  });

  await test("bomba/motor/lampada: estado ligado e desligado trocam a cor", () => {
    for (const typeId of ["graphics.hmi.pump", "graphics.hmi.lamp", "graphics.status_lamp", "graphics.conveyor"]) {
      const entry = byTypeId.get(typeId)!;
      const parado = render(entry, { value: 0 });
      const rodando = render(entry, { value: 100 });
      assert(parado !== rodando, `${typeId} deveria mudar de aparencia entre parado e rodando`);
    }
  });

  await test("indicadores mostram o texto formatado do binding", () => {
    const display = byTypeId.get("graphics.value_display")!;
    const svg = render(display, { value: 12.3456, bindDecimals: 2, bindUnit: "kPa" });
    assert(svg.includes("12.35 kPa"), `o display deveria mostrar o valor formatado -- veio ${svg.slice(0, 400)}`);
  });

  await test("controles HMI são vetoriais e expõem Ação no Inspector", () => {
    for (const typeId of ["graphics.hmi_button", "graphics.hmi_lamp_button", "graphics.hmi_toggle", "graphics.hmi_switch", "graphics.numeric_input", "graphics.slider", "graphics.setpoint"]) {
      const entry = byTypeId.get(typeId);
      assert(Boolean(entry), `${typeId} deveria existir na biblioteca`);
      const fields = new Set((entry!.propertySchema ?? []).map((field) => `${field.group}/${field.id}`));
      assert(fields.has("Ação/actionTarget"), `${typeId} sem alvo de ação`);
      assert(fields.has("Ação/actionProperty"), `${typeId} sem propriedade de ação`);
      assert(fields.has("Ação/actionMode"), `${typeId} sem modo de ação`);
      const svg = render(entry!);
      assert(svg.length > 0 && !svg.includes("NaN") && !svg.includes("undefined"), `${typeId} não renderizou vetor válido`);
    }
  });

  await test("indicador de alarme troca de aparência pelo binding booleano", () => {
    const alarm = byTypeId.get("graphics.alarm_indicator")!;
    assert(render(alarm, { value: 0 }) !== render(alarm, { value: 100 }), "alarme deveria distinguir normal e ativo");
  });

  await test("rotulo: mostra o texto autorado sem binding e o valor quando ligado", () => {
    const label = byTypeId.get("graphics.label")!;
    const estatico = render(label, { text: "Vazao" });
    assert(estatico.includes("Vazao"), "sem binding deveria mostrar o texto autorado");
    assert(!estatico.includes("50.0"), "sem binding nao deveria mostrar valor nenhum");
  });

  await test("tubulacao: a seta de fluxo some quando nao ha fluxo", () => {
    const pipe = byTypeId.get("graphics.pipe")!;
    const comFluxo = render(pipe, { value: 100 });
    const semFluxo = render(pipe, { value: 0 });
    const lines = (svg: string) => (svg.match(/<line\b/g) ?? []).length;
    assert(lines(comFluxo) > lines(semFluxo), `com fluxo deveria desenhar a seta a mais: ${lines(comFluxo)} vs ${lines(semFluxo)}`);
  });

  await test("o icone da paleta existe para todo simbolo", () => {
    // O gerador renderiza o icone a partir do MESMO paint spec, entao o item nunca cai no
    // `generic-component.svg` do fallback (`ComponentPaletteViewProvider::resolveIconReference`).
    const fs = require("node:fs") as typeof import("node:fs");
    const path = require("node:path") as typeof import("node:path");
    for (const entry of graphics) {
      if (!entry.package) continue;
      for (const theme of ["light", "dark"]) {
        const file = path.join(process.cwd(), "media", "components", theme, `${entry.icon}.svg`);
        assert(fs.existsSync(file), `icone ausente: ${theme}/${entry.icon}.svg (${entry.typeId})`);
        if (entry.typeId.startsWith("graphics.pid.")) {
          const iconSvg = fs.readFileSync(file, "utf8");
          assert(iconSvg.includes("PolyForm Noncommercial 1.0.0"), `${entry.typeId}: ícone sem metadado de licença`);
          assert(iconSvg.includes("Praharsh Nagpure"), `${entry.typeId}: ícone sem aviso autoral`);
        }
        if (entry.typeId === "graphics.pipe_elbow" || entry.typeId === "graphics.pipe_cross") {
          const iconSvg = fs.readFileSync(file, "utf8");
          const paths = [...iconSvg.matchAll(/<path\b[^>]*>/g)].map((match) => match[0]);
          assert(paths.every((pathMarkup) => pathMarkup.includes('fill="none"')), `${entry.typeId}: icone voltou a preencher caminho aberto`);
        }
      }
    }
  });

  // ════════════════════════════════════════════════════════════════════════════════════════
  // Widgets portados do HMI Studio do IPD (`graphics.hmi.*`).
  //
  // O gate genérico acima já prova que eles DESENHAM. Estes testes provam o que é específico do
  // porte: que o desenho RESPONDE ao valor ligado, que os limites entram em unidade de engenharia
  // e que a qualidade do dado suprime o indicador. Sem isto, um widget congelado num valor fixo
  // passaria em tudo que já existia.
  // ════════════════════════════════════════════════════════════════════════════════════════

  const hmi = graphics.filter((entry) => entry.typeId.startsWith("graphics.hmi."));

  await test("HMI: o conjunto portado existe e declara proveniencia nao comercial", () => {
    assert(hmi.length === 10, `esperados 10 widgets HMI, vieram ${hmi.length}`);
    for (const entry of hmi) {
      const provenance = entry.provenance;
      if (!provenance) throw new Error(`${entry.typeId} sem proveniencia`);
      assert((provenance.source ?? "").includes("IPD Studio"), `${entry.typeId}: origem nao declarada`);
      assert(provenance.license === "PolyForm-Noncommercial-1.0.0", `${entry.typeId}: licenca errada`);
      assert((provenance.sourceFiles ?? []).some((file) => file.startsWith("src/hmi/")),
        `${entry.typeId}: arquivo de origem nao aponta para o HMI Studio`);
      assert(Boolean(provenance.sourceCommit), `${entry.typeId}: sem commit fixado`);
    }
  });

  await test("HMI: o motor continua sendo o nosso -- nada do simulador do IPD foi portado", () => {
    // A garantia e' estrutural, nao uma promessa no README: `pinCount: 0` mantem o widget fora do
    // solver, e nao existe nenhuma propriedade de modelo de processo (vazao, pressao, ganho de
    // controlador) no schema -- so' binding, limites e aparencia.
    const forbidden = ["kp", "ki", "kd", "flow", "pressure", "conductance", "scenario", "pumpCurve"];
    for (const entry of hmi) {
      assert(entry.pinCount === 0, `${entry.typeId} entraria no solver`);
      for (const field of entry.propertySchema ?? []) {
        assert(!forbidden.includes(field.id),
          `${entry.typeId}: propriedade de simulacao "${field.id}" nao deveria existir num widget`);
      }
    }
  });

  await test("HMI: o indicador de barra segue o valor ligado", () => {
    const bar = byTypeId.get("graphics.hmi.bar")!;
    const low = filledRectHeight(render(bar, { value: 10 }), "#9aa8b2");
    const high = filledRectHeight(render(bar, { value: 90 }), "#9aa8b2");
    assert(low >= 0 && high >= 0, `preenchimento do PV nao encontrado (low=${low}, high=${high})`);
    assert(high > low, `a barra deveria crescer com o valor: 10%->${low}, 90%->${high}`);
  });

  await test("HMI: limites entram em unidade de engenharia e somem quando nao declarados", () => {
    const bar = byTypeId.get("graphics.hmi.bar")!;
    const semLimite = render(bar);
    assert(!semLimite.includes(">H<") && !semLimite.includes(">HH<"),
      "sem limite declarado o indicador nao pode desenhar marca -- inventar limite e' o que o upstream recusa");
    // Faixa 0..100 com H=80: a marca fica a 80 % da escala.
    const comLimite = render(bar, { limitH: "80" });
    assert(comLimite.includes(">H<"), "a marca H deveria aparecer quando o limite e' declarado");
    const tickY = /<line[^>]*stroke="#c06a00"[^>]*y1="([-\d.]+)"|<line[^>]*y1="([-\d.]+)"[^>]*stroke="#c06a00"/.exec(comLimite);
    assert(Boolean(tickY), "marca H sem coordenada");
    const y = Number(tickY![1] ?? tickY![2]);
    // top=16, bottom=148 no espaco de projeto: 80 % => 148 - 0.8*132 = 42.4
    assert(Math.abs(y - 42.4) < 0.75, `marca H deveria cair em y=42.4 para H=80 na faixa 0..100, veio ${y}`);
  });

  await test("HMI: qualidade ruim suprime o indicador e imprime tracos", () => {
    // Fonte declarada que nunca publicou leitura: mostrar o ultimo numero que o widget tinha e'
    // como um instrumento morto passa um turno inteiro despercebido (regra do upstream).
    const bar = byTypeId.get("graphics.hmi.bar")!;
    const bom = render(bar, { value: 70 });
    const ruim = render(bar, { value: 70, bindSource: "fonte-inexistente" });
    assert(filledRectHeight(bom, "#9aa8b2") > 0, "com qualidade boa o preenchimento existe");
    assert(filledRectHeight(ruim, "#9aa8b2") === -1, "com qualidade ruim o preenchimento nao pode ser desenhado");
    assert(ruim.includes("- - -"), "com qualidade ruim o valor imprime tracos");
    assert(!ruim.includes("70.0"), "com qualidade ruim o ultimo numero nao pode aparecer");
  });

  await test("HMI: o ponteiro do medidor radial gira com o valor", () => {
    // O gauge e' o unico widget autorado como `viewSpec`, porque `shapes[]` so' tem `transform`
    // estatico. Este teste tambem prova que o `viewSpec` sobreviveu ao sanitizador do catalogo --
    // sem ele, o ponteiro ficaria parado na posicao de repouso.
    const gauge = byTypeId.get("graphics.hmi.gauge")!;
    const rotationOf = (svg: string): number => {
      const match = /rotate\((-?[\d.]+)/.exec(svg);
      return match ? Number(match[1]) : NaN;
    };
    const baixo = rotationOf(render(gauge, { value: 0 }, "gauge-1"));
    const alto = rotationOf(render(gauge, { value: 100 }, "gauge-1"));
    assert(Number.isFinite(baixo) && Number.isFinite(alto), `ponteiro sem rotacao: 0%->${baixo}, 100%->${alto}`);
    // Mesma varredura do upstream (`angOf`): -120 graus no fundo da escala, +120 no topo.
    assert(Math.abs(baixo + 120) < 0.6, `0 % deveria girar -120 graus, veio ${baixo}`);
    assert(Math.abs(alto - 120) < 0.6, `100 % deveria girar +120 graus, veio ${alto}`);
  });

  await test("HMI: o faceplate le tres sinais independentes", () => {
    // A razao de existirem bindings secundarios: uma malha mostra PV, SP e OP, e um faceplate que
    // so' soubesse ler um deles nao seria um faceplate.
    const faceplate = byTypeId.get("graphics.hmi.faceplate")!;
    const svg = render(faceplate, { value: 20, valueB: 60, valueC: 90 });
    const pv = filledRectHeight(svg, "#9aa8b2");
    const sp = filledRectHeight(svg, "#1f4fb0");
    const op = filledRectHeight(svg, "#5a3fb0");
    assert(pv > 0 && sp > 0 && op > 0, `as tres barras deveriam desenhar: PV=${pv}, SP=${sp}, OP=${op}`);
    assert(pv < sp && sp < op, `cada barra segue o SEU sinal: PV(20)=${pv} < SP(60)=${sp} < OP(90)=${op}`);
  });

  await test("HMI: a tarja codifica o valor contra os limites, sem ciclo de vida de alarme", () => {
    const banner = byTypeId.get("graphics.hmi.alarm_banner")!;
    const normal = render(banner, { value: 50, limitH: "80", limitHH: "95" });
    const atencao = render(banner, { value: 85, limitH: "80", limitHH: "95" });
    const critico = render(banner, { value: 97, limitH: "80", limitHH: "95" });
    assert(normal.includes("NORMAL"), "dentro dos limites a tarja fica neutra");
    assert(atencao.includes("#c06a00"), "acima de H a tarja usa o tom de atencao");
    assert(critico.includes("#c62222"), "acima de HH a tarja usa o tom critico");
    // A severidade maior vence: 97 esta' acima de H E de HH, e anuncia-lo como atencao seria
    // subdeclarar. Nao existe reconhecer/silenciar/inibir aqui -- isso e' motor de alarme.
    assert(!critico.includes("#c06a00"), "acima de HH a tarja nao pode ficar no tom de atencao");
    for (const field of banner.propertySchema ?? []) {
      assert(!["ack", "acked", "shelve", "suppress"].includes(field.id),
        `tarja nao deveria ter "${field.id}" -- ciclo de vida de alarme nao foi portado`);
    }
  });

  await test("HMI: todo rotulo declara ancora e cabe dentro da caixa do widget", () => {
    // As DUAS regressoes reais desta incorporacao, travadas juntas porque tem a mesma causa:
    // geometria transcrita de um SVG cujos defaults e cuja caixa nao sao os nossos.
    //
    // (1) ANCORA. O renderizador assume `text-anchor="middle"` quando a forma nao declara um
    //     (`componentSymbols.ts`), enquanto o SVG do upstream assume `start`. Um rotulo transcrito
    //     como `x={8}` sem ancora explicito era centralizado em x=8 e perdia a metade esquerda:
    //     "TI-301" virava "-301", "GRUPO" virava "RUPO". Passava em todos os testes que existiam.
    //
    // (2) CAIXA. O upstream escreve o TAG em `y = h + 12`, FORA da caixa do widget, porque la' a
    //     tela nao recorta. Aqui a caixa E' o recorte, entao um rotulo nessa posicao e' cortado ou
    //     cai em cima do corpo. Cada widget precisa da sua faixa de rotulo no proprio desenho.
    const texts = (primitives: readonly Record<string, unknown>[], typeId: string): void => {
      for (const primitive of primitives) {
        if (Array.isArray(primitive.primitives)) texts(primitive.primitives as Record<string, unknown>[], typeId);
        if (primitive.kind !== "text") continue;
        assert(typeof primitive.textAnchor === "string",
          `${typeId}: texto sem "textAnchor" explicito -- o default do renderer (middle) nao e' o do SVG de origem (start)`);
      }
    };
    for (const entry of hmi) {
      const paint = entry.package?.simulidePaint;
      assert(Boolean(paint), `${entry.typeId}: sem simulidePaint`);
      texts((paint!.primitives ?? []) as unknown as Record<string, unknown>[], entry.typeId);

      // A caixa e' o recorte: nenhuma linha de base pode cair fora dela. `y` pode ser expressao
      // (`{prop,...}`), e nesse caso o valor extremo ja' e' coberto pelo teste de saturacao.
      const box = componentBox(entry.typeId, entry.defaultProperties);
      for (const primitive of (paint!.primitives ?? []) as unknown as Record<string, unknown>[]) {
        if (primitive.kind !== "text" || typeof primitive.y !== "number") continue;
        assert(primitive.y >= 0 && primitive.y <= box.height,
          `${entry.typeId}: rotulo em y=${primitive.y} fora da caixa de ${box.height} px -- o tag do upstream fica em h+12 e precisa de faixa propria aqui`);
      }
    }
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();
