import type { ComponentReadoutValue } from "./messages.js";

/**
 * Binding genérico "valor de simulação -> propriedade gráfica" da biblioteca de supervisório
 * (`graphics.*`, ver `docs/44-biblioteca-grafica-supervisorio-fase0.md`).
 *
 * É UMA implementação para TODOS os símbolos -- tanque, válvula, bomba, indicador, rótulo. Nenhum
 * símbolo tem lógica de binding própria: cada um declara, no seu `package.simulidePaint`, qual das
 * saídas abaixo ele consome (`__g_pct` para geometria, `__g_on` para cor de estado, `__g_text` para
 * texto). Adicionar um símbolo novo nunca exige tocar neste arquivo.
 *
 * O elemento gráfico NÃO participa do solver (`pinCount: 0` mantém a instância fora do Core, ver
 * `coreLifecycle.ts::shouldSyncComponentToCore`) -- ele apenas PROJETA telemetria já publicada,
 * exatamente a regra da FEAT-008 (`.spec/features/process-visualization.md`).
 *
 * `bindSource` guarda o **id** do componente-fonte, nunca o rótulo visível: renomear o rótulo de um
 * componente não pode quebrar uma tela (ARCH-006, "bindings persistem por identidade estável, não
 * por nome, posição visual ou índice do array").
 */

/** Propriedade estática usada como valor quando não há binding (ou enquanto a simulação está
 * parada) -- convenção única de toda a biblioteca, e é o que permite desenhar/ajustar a tela sem
 * simulação nenhuma rodando. */
export const GRAPHICAL_VALUE_PROPERTY = "value";

export interface GraphicalBindingProperties {
  /** Id do componente cuja telemetria alimenta este gráfico. Vazio/ausente == sem binding. */
  bindSource?: unknown;
  /** Índice do canal quando a leitura da fonte é um array (ex: osciloscópio). Ausente == 0. */
  bindChannel?: unknown;
  /** `valor * bindScale + bindOffset`, aplicado ao valor bruto da fonte. */
  bindScale?: unknown;
  bindOffset?: unknown;
  /** Faixa de engenharia que vira 0..100 % em `__g_pct`. */
  bindMin?: unknown;
  bindMax?: unknown;
  /** Formatação de `__g_text`. */
  bindDecimals?: unknown;
  bindUnit?: unknown;
  /** Limiar de `__g_on` (>= liga). `bindInvert` troca ligado/desligado. */
  bindThreshold?: unknown;
  bindInvert?: unknown;
  /** Limites de alarme em UNIDADE DE ENGENHARIA (não em %), na mesma escala de `bindMin`/`bindMax`.
   * Vazio/ausente == limite não especificado, que é diferente de zero: um indicador sem limite
   * declarado não desenha marca nenhuma, em vez de desenhar uma marca no fundo da escala. */
  limitLL?: unknown;
  limitL?: unknown;
  limitH?: unknown;
  limitHH?: unknown;
  [key: string]: unknown;
}

export interface GraphicalRuntimeProperties {
  /** Valor de engenharia já transformado (escala/offset). */
  __g_value: number;
  /** `__g_value` normalizado em 0..100 pela faixa `bindMin..bindMax`, saturado nas pontas. */
  __g_pct: number;
  /** `__g_value` formatado com `bindDecimals` casas + `bindUnit`. */
  __g_text: string;
  /** `"true"`/`"false"` -- chave de `stateFill.map`/`stateVisible.when`, que comparam com `String()`. */
  __g_on: string;
  /** `"bound"` quando existe binding resolvido, `"static"` quando o valor veio da propriedade,
   * `"missing"` quando há `bindSource` mas a fonte não publicou leitura (ainda). */
  __g_bind: "bound" | "static" | "missing";
  /** Cada limite normalizado em 0..100 pela MESMA faixa de `__g_pct`, para uma primitiva posicionar
   * a marca com uma expressão linear (`{prop, multiplier, offset}`) -- que é tudo que o IR tem.
   * Calcular aqui é o que permite o usuário digitar o limite na unidade do processo, como no IPD,
   * em vez de ter que convertê-lo para porcentagem à mão. 0 quando o limite não foi declarado; quem
   * decide desenhar é o `__g_*_set` correspondente. */
  __g_ll_pct: number;
  __g_l_pct: number;
  __g_h_pct: number;
  __g_hh_pct: number;
  /** `"true"`/`"false"`: o limite foi declarado? Chave de `stateVisible.when` -- é isto que faz um
   * indicador sem limites não desenhar marca nenhuma. */
  __g_ll_set: string;
  __g_l_set: string;
  __g_h_set: string;
  __g_hh_set: string;
  /** CODIFICAÇÃO VISUAL do valor contra os limites, não um ciclo de vida de alarme: não existe
   * reconhecer, silenciar, inibir nem prioridade configurável aqui. `"high"` = fora de LL/HH,
   * `"low"` = fora de L/H, `"none"` = dentro. Um motor de alarmes ISA-18.2 é outra coisa, e
   * deliberadamente não foi portado -- ver `docs/46-hmi-ipd-incorporacao.md`. */
  __g_alarm: "none" | "low" | "high";
  /** Qualidade do dado, no sentido do IPD: `"bad"` quando há fonte declarada que não publicou
   * leitura. Um widget com qualidade ruim não desenha ponteiro nem preenchimento e imprime traços
   * (`__g_text_q`) -- mostrar o último número que ele tinha é como um instrumento morto passa um
   * turno inteiro despercebido. */
  __g_quality: "ok" | "bad";
  /** `__g_text` com a qualidade aplicada. Deliberadamente um campo NOVO em vez de mudar
   * `__g_text`: os símbolos já publicados mostram o valor estático quando a fonte some, e trocar
   * isso agora seria uma mudança de comportamento em tela existente. */
  __g_text_q: string;
  /** SINAIS SECUNDÁRIOS. Um indicador mostra uma variável; uma malha de controle mostra três --
   * PV, setpoint e saída -- e um faceplate que só soubesse ler uma delas não seria um faceplate.
   * `B`/`C` são o MESMO contrato de binding com outro prefixo de propriedade (`bindSourceB`,
   * `bindScaleB`, ...), resolvido pela MESMA função; não há um segundo resolvedor, e um símbolo que
   * só usa o sinal primário não declara nenhuma destas propriedades e não paga nada por elas. */
  __g_b_value: number;
  __g_b_pct: number;
  __g_b_text: string;
  __g_b_bind: "bound" | "static" | "missing";
  __g_c_value: number;
  __g_c_pct: number;
  __g_c_text: string;
  __g_c_bind: "bound" | "static" | "missing";
}

function numberProperty(properties: GraphicalBindingProperties, key: string, fallback: number): number {
  const raw = properties[key];
  if (typeof raw === "number" && Number.isFinite(raw)) return raw;
  // Propriedade vinda de campo de texto do Inspector chega como string -- aceitar aqui evita que
  // um `bindMax` digitado "100" degrade silenciosamente para o default.
  if (typeof raw === "string" && raw.trim() !== "") {
    const parsed = Number(raw);
    if (Number.isFinite(parsed)) return parsed;
  }
  return fallback;
}

function stringProperty(properties: GraphicalBindingProperties, key: string): string {
  const raw = properties[key];
  return typeof raw === "string" ? raw.trim() : "";
}

function booleanProperty(properties: GraphicalBindingProperties, key: string): boolean {
  const raw = properties[key];
  return raw === true || raw === "true";
}

/** Leitura escalar de uma fonte: número direto, ou o canal pedido quando a fonte publica um array
 * (instrumentos multicanal já chegam assim em `readoutsByComponentId`). */
function scalarReadout(readout: ComponentReadoutValue | undefined, channel: number): number | undefined {
  if (typeof readout === "number") return Number.isFinite(readout) ? readout : undefined;
  if (Array.isArray(readout)) {
    const value = readout[Math.max(0, Math.trunc(channel))];
    return typeof value === "number" && Number.isFinite(value) ? value : undefined;
  }
  return undefined;
}

export function formatGraphicalValue(value: number, decimals: number, unit: string): string {
  const safeDecimals = Math.min(6, Math.max(0, Math.trunc(decimals)));
  const text = Number.isFinite(value) ? value.toFixed(safeDecimals) : "--";
  return unit ? `${text} ${unit}` : text;
}

/**
 * Projeta as propriedades de runtime de UM elemento gráfico. Função pura: recebe as propriedades da
 * instância e um resolvedor de leitura por id de componente (em produção,
 * `readoutsByComponentId[id]`; em teste, um mapa qualquer).
 *
 * Sem `bindSource` o resultado continua sendo produzido -- o símbolo desenha o valor ESTÁTICO da
 * propriedade `value`, que é o que faz a tela ser editável com a simulação parada.
 */
interface ResolvedSignal {
  value: number;
  pct: number;
  text: string;
  bind: "bound" | "static" | "missing";
  min: number;
  max: number;
  span: number;
}

/**
 * Resolve UM sinal: fonte -> escala/offset -> faixa -> formatação.
 *
 * `suffix` é o sufixo das propriedades (`""` para o sinal primário, `"B"`/`"C"` para os
 * secundários). É a única razão de esta função existir separada: sem ela, ler o setpoint de um
 * faceplate exigiria copiar este bloco inteiro com outro nome de propriedade, que é exatamente como
 * duas cópias da mesma regra passam a divergir.
 */
function resolveSignal(
  properties: GraphicalBindingProperties,
  readoutOf: (componentId: string) => ComponentReadoutValue | undefined,
  suffix: string,
): ResolvedSignal {
  const source = stringProperty(properties, `bindSource${suffix}`);
  let value = numberProperty(properties, `${GRAPHICAL_VALUE_PROPERTY}${suffix}`, 0);
  let bind: ResolvedSignal["bind"] = "static";
  if (source) {
    const raw = scalarReadout(readoutOf(source), numberProperty(properties, `bindChannel${suffix}`, 0));
    if (raw === undefined) {
      bind = "missing";
    } else {
      value = raw * numberProperty(properties, `bindScale${suffix}`, 1) + numberProperty(properties, `bindOffset${suffix}`, 0);
      bind = "bound";
    }
  }
  const min = numberProperty(properties, `bindMin${suffix}`, 0);
  const max = numberProperty(properties, `bindMax${suffix}`, 100);
  const span = max - min;
  return {
    value,
    pct: span === 0 ? 0 : Math.min(100, Math.max(0, ((value - min) / span) * 100)),
    text: formatGraphicalValue(value, numberProperty(properties, `bindDecimals${suffix}`, 1), stringProperty(properties, `bindUnit${suffix}`)),
    bind,
    min,
    max,
    span,
  };
}

export function graphicalRuntimeProperties(
  properties: GraphicalBindingProperties,
  readoutOf: (componentId: string) => ComponentReadoutValue | undefined
): GraphicalRuntimeProperties {
  const source = stringProperty(properties, "bindSource");
  const staticValue = numberProperty(properties, GRAPHICAL_VALUE_PROPERTY, 0);

  let value = staticValue;
  let bind: GraphicalRuntimeProperties["__g_bind"] = "static";
  if (source) {
    const raw = scalarReadout(readoutOf(source), numberProperty(properties, "bindChannel", 0));
    if (raw === undefined) {
      // Fonte declarada mas sem leitura: mantém o valor estático (a tela continua legível) e marca
      // `missing`, que é o que um indicador de binding quebrado consome para se destacar.
      bind = "missing";
    } else {
      value = raw * numberProperty(properties, "bindScale", 1) + numberProperty(properties, "bindOffset", 0);
      bind = "bound";
    }
  }

  const min = numberProperty(properties, "bindMin", 0);
  const max = numberProperty(properties, "bindMax", 100);
  // Faixa degenerada (min == max) não pode virar divisão por zero nem NaN no `d`/`height` de uma
  // primitiva -- cai para 0 %, que desenha o elemento vazio em vez de sumir com ele.
  const span = max - min;
  const pct = span === 0 ? 0 : Math.min(100, Math.max(0, ((value - min) / span) * 100));

  const threshold = numberProperty(properties, "bindThreshold", 50);
  const on = booleanProperty(properties, "bindInvert") ? value < threshold : value >= threshold;

  const limitOf = (key: string): number | undefined => {
    const raw = properties[key];
    if (typeof raw === "number") return Number.isFinite(raw) ? raw : undefined;
    if (typeof raw === "string" && raw.trim() !== "") {
      const parsed = Number(raw);
      return Number.isFinite(parsed) ? parsed : undefined;
    }
    return undefined;
  };
  const pctOf = (limit: number | undefined): number =>
    limit === undefined || span === 0 ? 0 : Math.min(100, Math.max(0, ((limit - min) / span) * 100));

  const ll = limitOf("limitLL");
  const l = limitOf("limitL");
  const h = limitOf("limitH");
  const hh = limitOf("limitHH");

  // Ordem deliberada: a condição mais grave vence. Um valor abaixo de LL também está abaixo de L,
  // e anunciá-lo como "low" seria subdeclarar a severidade.
  const alarm: GraphicalRuntimeProperties["__g_alarm"] =
    (ll !== undefined && value <= ll) || (hh !== undefined && value >= hh) ? "high"
      : (l !== undefined && value <= l) || (h !== undefined && value >= h) ? "low"
      : "none";
  const quality: GraphicalRuntimeProperties["__g_quality"] = bind === "missing" ? "bad" : "ok";
  const signalB = resolveSignal(properties, readoutOf, "B");
  const signalC = resolveSignal(properties, readoutOf, "C");
  const text = formatGraphicalValue(value, numberProperty(properties, "bindDecimals", 1), stringProperty(properties, "bindUnit"));

  return {
    __g_value: value,
    __g_pct: pct,
    __g_text: text,
    __g_on: on ? "true" : "false",
    __g_bind: bind,
    __g_ll_pct: pctOf(ll),
    __g_l_pct: pctOf(l),
    __g_h_pct: pctOf(h),
    __g_hh_pct: pctOf(hh),
    __g_ll_set: ll === undefined ? "false" : "true",
    __g_l_set: l === undefined ? "false" : "true",
    __g_h_set: h === undefined ? "false" : "true",
    __g_hh_set: hh === undefined ? "false" : "true",
    __g_alarm: alarm,
    __g_quality: quality,
    __g_text_q: quality === "bad" ? "- - -" : text,
    __g_b_value: signalB.value,
    __g_b_pct: signalB.pct,
    __g_b_text: signalB.text,
    __g_b_bind: signalB.bind,
    __g_c_value: signalC.value,
    __g_c_pct: signalC.pct,
    __g_c_text: signalC.text,
    __g_c_bind: signalC.bind,
  };
}

/** Todo typeId da biblioteca de supervisório. Prefixo único (`graphics.`) é o contrato -- é assim
 * que `main.ts` decide projetar as propriedades de runtime acima sem manter uma lista paralela que
 * precisaria crescer a cada símbolo novo. */
export function isGraphicalTypeId(typeId: string): boolean {
  return typeId.startsWith("graphics.");
}
