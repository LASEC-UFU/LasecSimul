import { ComponentBox } from "./componentSymbols.js";

/** Os rótulos flutuantes que um componente pode ter -- "id" é o nome/título
 * (`WebviewComponentModel.label`, opt-in via `showId`), "value" é o valor formatado da propriedade
 * `showOnSymbol` do typeId (opt-in via `showValue`) e "dial" é a posição/valor do controle giratório
 * (opt-in via `showDialValue`). Movido de `main.ts` (nada mais importava esse
 * tipo de lá) pra este módulo puro -- mesmo princípio de `componentSymbols.ts`: geometria/resolução
 * de dado, sem DOM, importável tanto pela Webview quanto por testes em Node. */
export type ExternalLabelKind = "id" | "value" | "dial";

/** O Probe do SimulIDE usa `Component::m_valLabel` externo ao corpo, não texto embutido no SVG. */
export function isExternalProbeReadout(typeId: string): boolean {
  return typeId === "meters.probe";
}

/** Replica `Probe::setVolt`: arredonda a 0,01 V e apresenta a unidade junto da sonda. */
export function formatProbeVoltage(readout: number | undefined, running: boolean): string {
  if (readout === undefined) return running ? "... V" : "0 V";
  const rounded = Math.round(readout * 100) / 100;
  return `${Object.is(rounded, -0) ? 0 : rounded} V`;
}

/** Fonte ÚNICA do nome de propriedade de cada aspecto configurável de um rótulo externo (posição,
 * rotação, cor, tamanho de fonte) -- todos vivem em `component.properties` (serializados como
 * qualquer outra propriedade, sem campo dedicado em `WebviewComponentModel`), prefixados por kind
 * (`__ui_idLabel*`/`__ui_valueLabel*`/`__ui_dialLabel*`) pra nunca colidir entre os rótulos do mesmo componente. */
export function labelPropertyKey(kind: ExternalLabelKind, suffix: "x" | "y" | "rotation" | "color" | "size"): string {
  const prefix = kind === "id" ? "__ui_idLabel" : kind === "value" ? "__ui_valueLabel" : "__ui_dialLabel";
  return `${prefix}${suffix === "x" || suffix === "y" ? suffix.toUpperCase() : suffix[0]!.toUpperCase() + suffix.slice(1)}`;
}

/** Mesmo valor do `font-size:11px` fixo de `.component-floating-label--id`/`--value` em `styles.css`
 * -- default quando `__ui_idLabelSize`/`__ui_valueLabelSize` nunca foi customizado. Mantido os dois
 * em sincronia manualmente (nenhum mecanismo os lê um do outro); se um mudar, mudar o outro junto. */
export const DEFAULT_EXTERNAL_LABEL_FONT_SIZE = 11;

/** Mesmas cores de `.component-floating-label--id`/`--value` em `styles.css` -- default quando
 * `__ui_idLabelColor`/`__ui_valueLabelColor` nunca foi customizado. Precisavam bater exatamente
 * (achado: o fallback antigo `#1f2937` não correspondia a NENHUma das duas, então o diálogo de
 * propriedades mostrava uma cor "atual" que não era a realmente exibida em tela). */
export const DEFAULT_ID_LABEL_COLOR = "#5b7fd1";
export const DEFAULT_VALUE_LABEL_COLOR = "#c0594a";
export const DEFAULT_DIAL_LABEL_COLOR = "#7a4fa3";

/** Posição PADRÃO (antes de qualquer arrasto do usuário) de um rótulo externo, relativa ao canto
 * superior-esquerdo do componente (`component.x/y` -- `ComponentBox` normaliza toda origem pra
 * `(0,0)` nesse canto, nunca tem `x`/`y` negativo ou um centro implícito, ver `componentSymbols.ts`).
 * Centralizado horizontalmente na largura real do corpo (`box.width/2`) -- achado real: um `x:0`
 * fixo ancorava o rótulo na borda ESQUERDA do corpo, que pra componentes ESTREITOS (`switches.
 * switch_dip` largura 24, `switches.relay` largura 32) fazia um texto de rótulo mais longo que o
 * corpo se estender bem além da borda direita, invadindo pinos/fios/componentes vizinhos -- lido
 * como "a label não aparece"/"não dá pra pegar com o mouse" mesmo estando tecnicamente desenhada.
 * `y` (acima/abaixo do corpo) já estava correto -- `-14`/`box.height+2` sempre ficam fora do corpo
 * porque o topo do corpo é sempre `y=0`, nunca precisou do `box` pra isso.
 * `packageValueLabel` (posição declarada no catálogo pro rótulo de valor, ex: mostrador de
 * voltímetro) tem prioridade sobre o cálculo genérico quando presente -- preservado como estava. */
export function resolveDefaultExternalLabelOffset(
  kind: ExternalLabelKind,
  box: ComponentBox,
  packageValueLabel?: { x: number; y: number }
): { x: number; y: number } {
  if (kind === "value" && packageValueLabel) return { x: packageValueLabel.x, y: packageValueLabel.y };
  if (kind === "id") return { x: box.width / 2, y: -14 };
  if (kind === "value") return { x: box.width / 2, y: box.height + 2 };
  // O terceiro rótulo fica abaixo do valor elétrico para não nascer sobreposto a ele. Depois disso
  // ele é totalmente livre/arrastável como qualquer outro rótulo externo.
  return { x: box.width / 2, y: box.height + 16 };
}

/** Tamanho de fonte do rótulo externo genérico (qualquer componente comum, id ou value) -- NÃO usado
 * pelo `symbol.pin` ao vivo em Modo Símbolo, que continua com sua própria propriedade `labelFontSize`
 * (mecanismo separado, renderiza via SVG consolidado do símbolo, ver `main.ts::renderExternalLabel`/
 * `externalLabelWorldBox`). Ausente == `DEFAULT_EXTERNAL_LABEL_FONT_SIZE`. */
export function genericExternalLabelFontSize(kind: ExternalLabelKind, properties: Record<string, unknown>): number {
  const size = properties[labelPropertyKey(kind, "size")];
  return typeof size === "number" ? size : DEFAULT_EXTERNAL_LABEL_FONT_SIZE;
}

/** Cor do rótulo externo -- `__ui_idLabelColor`/`__ui_valueLabelColor` customizada quando presente,
 * senão o default POR KIND que bate com o CSS (`DEFAULT_ID_LABEL_COLOR`/`DEFAULT_VALUE_LABEL_COLOR`). */
export function resolveExternalLabelColor(kind: ExternalLabelKind, properties: Record<string, unknown>): string {
  const color = properties[labelPropertyKey(kind, "color")];
  if (typeof color === "string" && color) return color;
  return kind === "id" ? DEFAULT_ID_LABEL_COLOR : kind === "value" ? DEFAULT_VALUE_LABEL_COLOR : DEFAULT_DIAL_LABEL_COLOR;
}

/** Alinhamento do rótulo de um `symbol.pin` (Modo Símbolo) -- só esse caso tem alinhamento
 * configurável hoje (o rótulo id/value genérico de um componente comum não tem esse conceito).
 * Propriedade própria, fora do padrão `labelPropertyKey` (esse é só pros 4 aspectos que TODO rótulo
 * id/value compartilha -- alinhamento não é um deles). */
export const SYMBOL_PIN_LABEL_ALIGN_KEY = "__ui_idLabelAlign";

/** Deriva os campos de `PackagePin` ligados a alinhamento/visibilidade do rótulo de um `symbol.pin`
 * a partir do componente AO VIVO em Modo Símbolo -- fonte ÚNICA pros dois compiladores que precisam
 * disso (`catalog/subcircuitSymbolScene.ts::compileSymbolScene`, rodado só ao salvar, e
 * `main.ts::compileLiveSymbolPins`, rodado a cada render do preview ao vivo) -- sem isto, os dois
 * duplicariam a mesma lógica de "só grava quando o usuário customizou" e divergiriam entre si (bug
 * real encontrado: os dois tinham o MESMO hardcode `labelTextAnchor:"middle"` incondicional, então
 * o alinhamento nunca chegava no arquivo nem no preview). Ausente/default em qualquer campo == não
 * inclui a chave no resultado, deixando `packagePinLeadSvg` calcular o default por ângulo sozinho. */
export function symbolPinLabelPackageFields(
  properties: Record<string, unknown>,
  showId: boolean | undefined
): { labelTextAnchor?: "start" | "middle" | "end"; labelDominantBaseline?: "middle"; labelHidden?: boolean } {
  const result: { labelTextAnchor?: "start" | "middle" | "end"; labelDominantBaseline?: "middle"; labelHidden?: boolean } = {};
  const align = properties[SYMBOL_PIN_LABEL_ALIGN_KEY];
  if (align === "start" || align === "middle" || align === "end") {
    result.labelTextAnchor = align;
    result.labelDominantBaseline = "middle";
  }
  if (showId === false) result.labelHidden = true;
  return result;
}

/** Próxima rotação de um rótulo externo após girar `steps` passos de 90° -- mesma fórmula já usada
 * por `main.ts::rotateSelectedComponents`, extraída aqui pra ficar testável em Node sem precisar
 * exportar `main.ts` inteiro (que manipula `document`/`window` no escopo do módulo). */
export function nextLabelRotation(current: 0 | 90 | 180 | 270, steps: 1 | -1 | 2): 0 | 90 | 180 | 270 {
  const delta = steps === 2 ? 180 : steps * 90;
  return ((((current + delta) % 360) + 360) % 360) as 0 | 90 | 180 | 270;
}
