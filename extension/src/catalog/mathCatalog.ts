import type { PropertySchemaEntry, WebviewComponentCatalogEntry } from "../ui/webview/model";
import { ACTIVITY_KIND_LABEL, defaultActivity, type LabActivityKind } from "../ui/webview/lab/activity";
import {
  MATH_ACTIVITY_TYPE_ID, MATH_DEFAULT_BOX, MATH_EQUATION_TYPE_ID, MATH_PARAMETER_TYPE_ID, MATH_PLOT_TYPE_ID, MATH_TABLE_TYPE_ID, MATH_TREND_TYPE_ID,
} from "../ui/webview/mathWidgets";
import {
  LAB_ICONS, MATH_CARD_TYPE_ID, MATH_PLANT_PARAMETER_TYPE_ID, MATH_PROCESS_TANK_TYPE_ID, MATH_READOUT_TYPE_ID, MATH_SERIES_CHART_TYPE_ID, MATH_SIM_CONTROLS_TYPE_ID,
  PLANT_CHANNEL_INFO, displayUnit,
} from "../ui/webview/labWidgets";
import { PLANTS } from "../ui/webview/lab/plants";

/**
 * Elementos matemáticos de tela (docs/62 §6.1): Miscelâneos › Grafico › Matemática. Gráficos fora do
 * solver (`pinCount: 0`), colocáveis em qualquer página de uma Tela HMI; o desenho vem de
 * `mathWidgets.ts` (SVG) e, na atividade, do próprio Laboratório num `<iframe>`.
 */
const FOLDER = ["Grafico", "Matemática"];

const icon = (body: string): string =>
  `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" stroke-linecap="round" stroke-linejoin="round">${body}</svg>`;

const geometry = (typeId: string): PropertySchemaEntry[] => [
  { id: "width", label: "Largura", group: "Geometria", unit: "px", editor: "number", default: MATH_DEFAULT_BOX[typeId]!.width, min: 40, max: 4000, step: 1 },
  { id: "height", label: "Altura", group: "Geometria", unit: "px", editor: "number", default: MATH_DEFAULT_BOX[typeId]!.height, min: 24, max: 4000, step: 1 },
];

const binding: PropertySchemaEntry[] = [
  { id: "bindSource", label: "Fonte (id do componente)", group: "Binding", unit: "", editor: "text", default: "" },
  { id: "bindChannel", label: "Canal da fonte", group: "Binding", unit: "", editor: "number", default: 0, min: 0, max: 64, step: 1 },
  { id: "bindScale", label: "Ganho", group: "Binding", unit: "", editor: "number", default: 1, min: -1000000, max: 1000000, step: 0.1 },
  { id: "bindOffset", label: "Offset", group: "Binding", unit: "", editor: "number", default: 0, min: -1000000, max: 1000000, step: 0.1 },
  { id: "bindUnit", label: "Unidade", group: "Binding", unit: "", editor: "text", default: "" },
  { id: "bindDecimals", label: "Casas decimais", group: "Binding", unit: "", editor: "number", default: 2, min: 0, max: 8, step: 1 },
];

function entry(
  typeId: string, label: string, iconBody: string, description: string,
  defaultProperties: Record<string, unknown>, schema: PropertySchemaEntry[],
): WebviewComponentCatalogEntry {
  const box = MATH_DEFAULT_BOX[typeId]!;
  return {
    typeId, label, category: "Grafico", folderPath: FOLDER, workspaceSection: "misc",
    icon: "package", iconSvgInline: icon(iconBody), hidden: false, graphical: true, pinCount: 0, pinIds: [],
    defaultProperties: { width: box.width, height: box.height, ...defaultProperties },
    propertySchema: [...geometry(typeId), ...schema],
    help: { description },
  };
}

const KINDS: LabActivityKind[] = ["functions", "sensor", "limits", "axis", "firstOrder", "tank"];

const PLANT_NAME: Record<string, string> = { tank: "Tanque", firstOrder: "Primeira ordem", sensor: "Sensor 4–20 mA" };
const plantField: PropertySchemaEntry = { id: "plantComponentId", label: "Planta (id do componente)", group: "Componente", unit: "", editor: "text", default: "" };
const channelOptions = Object.values(PLANTS).flatMap((plant) => [
  ...plant.series.map((channel) => channel.id),
  ...(plant.kind === "tank" ? ["q"] : []),
]).filter((id, index, all) => all.indexOf(id) === index && PLANT_CHANNEL_INFO[id])
  .map((id) => ({ value: id, label: `${PLANT_CHANNEL_INFO[id]!.symbol} – ${PLANT_CHANNEL_INFO[id]!.label}${PLANT_CHANNEL_INFO[id]!.unit ? ` (${PLANT_CHANNEL_INFO[id]!.unit})` : ""}` }));
const parameterOptions = Object.values(PLANTS).flatMap((plant) => plant.parameters.map((parameter) => ({
  value: parameter.id, label: `${PLANT_NAME[plant.kind] ?? plant.kind} · ${parameter.label}${parameter.unit ? ` (${displayUnit(parameter.unit)})` : ""}`,
}))).filter((option, index, all) => all.findIndex((other) => other.value === option.value) === index);
const iconOptions = [{ value: "none", label: "Nenhum" }, ...Object.keys(LAB_ICONS).map((name) => ({ value: name, label: name }))];
const variantOptions = [{ value: "dark", label: "Escuro" }, { value: "light", label: "Claro" }, { value: "glass", label: "Vidro" }, { value: "accent", label: "Destaque" }];

export const mathActivityCatalogEntry = entry(
  MATH_ACTIVITY_TYPE_ID, "Atividade do Laboratório",
  '<rect x="3" y="4" width="18" height="14" rx="2"/><path d="M6 15c2-6 4-6 6-2s4 4 6-3"/><path d="M8 21h8"/>',
  "Uma atividade do Laboratório de Cálculo (Funções, Sensor 4–20 mA, Limites, Eixo, Primeira ordem, Tanque) dentro da tela, com a mesma aparência e o mesmo cálculo. Em edição a atividade abre no modo professor; em operação, no modo aluno. \"Ocupar a página\" faz a atividade preencher a janela em operação, como no Laboratório.",
  { kind: "functions", fillPage: false, plantComponentId: "", activityJson: JSON.stringify(defaultActivity("functions")) },
  [
    {
      id: "kind", label: "Atividade", group: "Componente", unit: "", editor: "select", default: "functions",
      options: KINDS.map((kind) => ({ value: kind, label: ACTIVITY_KIND_LABEL[kind] })),
    },
    { id: "fillPage", label: "Ocupar a página (operação)", group: "Componente", unit: "", editor: "checkbox", default: false },
    // Tanque, primeira ordem e sensor: qual instância do projeto o experimento usa (vazio = a única do tipo).
    { id: "plantComponentId", label: "Planta (id do componente; vazio = a única)", group: "Componente", unit: "", editor: "text", default: "" },
  ],
);

export const mathCatalog: WebviewComponentCatalogEntry[] = [
  mathActivityCatalogEntry,
  entry(
    MATH_PLOT_TYPE_ID, "Gráfico de função",
    '<path d="M3 20h18M4 21V3"/><path d="M5 17c3-9 5-11 7-6s4 5 7-6"/>',
    "Desenha f(x) (e g(x), opcional) com os parâmetros da página (elementos \"Parâmetro\"). Mesma amostragem adaptativa do Laboratório; derivada e raízes opcionais.",
    { title: "", variable: "x", expression: "a x^2 + b x + c", expression2: "", xMin: -5, xMax: 5, yMin: 0, yMax: 0, showGrid: true, showDerivative: false, showRoots: true, color: "#2563eb", color2: "#dc2626" },
    [
      { id: "title", label: "Título", group: "Componente", unit: "", editor: "text", default: "" },
      { id: "expression", label: "f(x)", group: "Componente", unit: "", editor: "text", default: "a x^2 + b x + c" },
      { id: "expression2", label: "g(x) (opcional)", group: "Componente", unit: "", editor: "text", default: "" },
      { id: "variable", label: "Variável", group: "Componente", unit: "", editor: "text", default: "x" },
      { id: "xMin", label: "x mínimo", group: "Faixa", unit: "", editor: "number", default: -5, min: -1e9, max: 1e9, step: 0.5 },
      { id: "xMax", label: "x máximo", group: "Faixa", unit: "", editor: "number", default: 5, min: -1e9, max: 1e9, step: 0.5 },
      { id: "yMin", label: "y mínimo (= máximo: automático)", group: "Faixa", unit: "", editor: "number", default: 0, min: -1e9, max: 1e9, step: 0.5 },
      { id: "yMax", label: "y máximo", group: "Faixa", unit: "", editor: "number", default: 0, min: -1e9, max: 1e9, step: 0.5 },
      { id: "showGrid", label: "Grade", group: "Aparência", unit: "", editor: "checkbox", default: true },
      { id: "showDerivative", label: "Mostrar f′", group: "Aparência", unit: "", editor: "checkbox", default: false },
      { id: "showRoots", label: "Mostrar raízes", group: "Aparência", unit: "", editor: "checkbox", default: true },
      { id: "color", label: "Cor de f", group: "Aparência", unit: "", editor: "color", default: "#2563eb" },
      { id: "color2", label: "Cor de g", group: "Aparência", unit: "", editor: "color", default: "#dc2626" },
    ],
  ),
  entry(
    MATH_PARAMETER_TYPE_ID, "Parâmetro",
    '<path d="M4 12h16"/><circle cx="10" cy="12" r="3"/><path d="M5 6h3M5 18h6"/>',
    "Slider de um parâmetro da página (ex.: a). Gráficos, equações e tabelas da mesma página usam o nome nas expressões. Em operação, arraste para mudar; o valor inicial é o autorado.",
    { name: "a", label: "", min: -3, max: 3, step: 0.1, value: 1, unit: "", decimals: 2, color: "#3b82f6", icon: "none", background: "card" },
    [
      { id: "name", label: "Nome (usado nas expressões)", group: "Componente", unit: "", editor: "text", default: "a" },
      { id: "label", label: "Rótulo (opcional)", group: "Componente", unit: "", editor: "text", default: "" },
      { id: "min", label: "Mínimo", group: "Faixa", unit: "", editor: "number", default: -3, min: -1e9, max: 1e9, step: 0.1 },
      { id: "max", label: "Máximo", group: "Faixa", unit: "", editor: "number", default: 3, min: -1e9, max: 1e9, step: 0.1 },
      { id: "step", label: "Passo (0 = contínuo)", group: "Faixa", unit: "", editor: "number", default: 0.1, min: 0, max: 1e9, step: 0.01 },
      { id: "value", label: "Valor inicial", group: "Faixa", unit: "", editor: "number", default: 1, min: -1e9, max: 1e9, step: 0.1 },
      { id: "unit", label: "Unidade", group: "Componente", unit: "", editor: "text", default: "" },
      { id: "decimals", label: "Casas decimais", group: "Componente", unit: "", editor: "number", default: 2, min: 0, max: 8, step: 1 },
      { id: "color", label: "Cor", group: "Aparência", unit: "", editor: "color", default: "#3b82f6" },
      { id: "icon", label: "Ícone", group: "Aparência", unit: "", editor: "select", default: "none", options: iconOptions },
      { id: "background", label: "Fundo", group: "Aparência", unit: "", editor: "select", default: "card", options: [{ value: "card", label: "Cartão" }, { value: "none", label: "Nenhum" }] },
    ],
  ),
  entry(
    MATH_EQUATION_TYPE_ID, "Equação",
    '<path d="M4 9h6M4 15h6"/><path d="M14 6l6 12M20 6l-6 12"/>',
    "Mostra uma expressão em notação matemática (MathML), com os parâmetros da página por nome ou já substituídos pelos valores. Sem variável livre, mostra também o valor.",
    { formula: "", lhs: "f(x)", variable: "x", expression: "a x^2 + b x + c", plantComponentId: "", substitute: false, showValue: true, decimals: 4, unit: "", fontSize: 20, background: "card", color: "#e8eef8" },
    [
      { id: "formula", label: "Fórmula exibida (opcional; ex.: dh/dt = q/A)", group: "Componente", unit: "", editor: "text", default: "" },
      { id: "lhs", label: "Lado esquerdo", group: "Componente", unit: "", editor: "text", default: "f(x)" },
      { id: "expression", label: "Expressão", group: "Componente", unit: "", editor: "text", default: "a x^2 + b x + c" },
      { ...plantField, label: "Planta (opcional: séries e parâmetros entram na expressão por nome)" },
      { id: "variable", label: "Variável livre", group: "Componente", unit: "", editor: "text", default: "x" },
      { id: "substitute", label: "Substituir parâmetros pelos valores", group: "Componente", unit: "", editor: "checkbox", default: false },
      { id: "showValue", label: "Mostrar valor (sem variável livre)", group: "Componente", unit: "", editor: "checkbox", default: true },
      { id: "decimals", label: "Casas decimais", group: "Componente", unit: "", editor: "number", default: 4, min: 0, max: 12, step: 1 },
      { id: "unit", label: "Unidade do valor", group: "Componente", unit: "", editor: "text", default: "" },
      { id: "fontSize", label: "Tamanho", group: "Aparência", unit: "px", editor: "number", default: 20, min: 8, max: 96, step: 1 },
      { id: "background", label: "Fundo", group: "Aparência", unit: "", editor: "select", default: "card", options: [{ value: "card", label: "Cartão escuro" }, { value: "light", label: "Cartão claro" }, { value: "glass", label: "Vidro" }, { value: "none", label: "Nenhum" }] },
      { id: "color", label: "Cor do texto", group: "Aparência", unit: "", editor: "color", default: "#e8eef8" },
    ],
  ),
  entry(
    MATH_TABLE_TYPE_ID, "Tabela de valores",
    '<rect x="4" y="4" width="16" height="16" rx="1"/><path d="M12 4v16M4 9h16M4 14h16"/>',
    "Tabela x | f(x) a partir de um início e de um passo, com os parâmetros da página.",
    { variable: "x", expression: "a x^2 + b x + c", header: "", start: -2, step: 1, rows: 8, decimals: 3 },
    [
      { id: "expression", label: "f(x)", group: "Componente", unit: "", editor: "text", default: "a x^2 + b x + c" },
      { id: "variable", label: "Variável", group: "Componente", unit: "", editor: "text", default: "x" },
      { id: "header", label: "Cabeçalho (opcional)", group: "Componente", unit: "", editor: "text", default: "" },
      { id: "start", label: "Início", group: "Faixa", unit: "", editor: "number", default: -2, min: -1e9, max: 1e9, step: 0.5 },
      { id: "step", label: "Passo", group: "Faixa", unit: "", editor: "number", default: 1, min: -1e9, max: 1e9, step: 0.1 },
      { id: "rows", label: "Linhas", group: "Faixa", unit: "", editor: "number", default: 8, min: 1, max: 60, step: 1 },
      { id: "decimals", label: "Casas decimais", group: "Componente", unit: "", editor: "number", default: 3, min: 0, max: 10, step: 1 },
    ],
  ),
  entry(
    MATH_TREND_TYPE_ID, "Tendência (série no tempo)",
    '<path d="M3 20h18M4 21V3"/><path d="M5 15l4-4 3 3 4-6 4 2"/>',
    "Gráfico do valor de um componente do projeto ao longo do tempo (janela deslizante), com o mesmo binding dos indicadores (Fonte, canal, ganho, offset).",
    { title: "", windowSeconds: 30, yMin: 0, yMax: 0, showGrid: true, color: "#2563eb", bindSource: "", bindChannel: 0, bindScale: 1, bindOffset: 0, bindUnit: "", bindDecimals: 2 },
    [
      { id: "title", label: "Título", group: "Componente", unit: "", editor: "text", default: "" },
      { id: "windowSeconds", label: "Janela", group: "Faixa", unit: "s", editor: "number", default: 30, min: 1, max: 3600, step: 1 },
      { id: "yMin", label: "y mínimo (= máximo: automático)", group: "Faixa", unit: "", editor: "number", default: 0, min: -1e9, max: 1e9, step: 0.5 },
      { id: "yMax", label: "y máximo", group: "Faixa", unit: "", editor: "number", default: 0, min: -1e9, max: 1e9, step: 0.5 },
      { id: "showGrid", label: "Grade", group: "Aparência", unit: "", editor: "checkbox", default: true },
      { id: "color", label: "Cor", group: "Aparência", unit: "", editor: "color", default: "#2563eb" },
      ...binding,
    ],
  ),
  entry(
    MATH_CARD_TYPE_ID, "Cartão",
    '<rect x="3" y="4" width="18" height="16" rx="3"/><path d="M7 9h6M7 13h10M7 16h7"/>',
    "Painel do tema do Laboratório com título (ícone opcional) e texto: \"Processo em tempo real\", \"Explore:\", uma pergunta. Fica atrás dos outros elementos (ordem de camadas).",
    { title: "Processo em tempo real", text: "", icon: "process", variant: "dark", titleStyle: "pill", accentColor: "#38bdf8", titleSize: 18, textSize: 15 },
    [
      { id: "title", label: "Título", group: "Componente", unit: "", editor: "text", default: "Processo em tempo real" },
      { id: "text", label: "Texto", group: "Componente", unit: "", editor: "textarea", default: "" },
      { id: "icon", label: "Ícone", group: "Componente", unit: "", editor: "select", default: "process", options: iconOptions },
      { id: "variant", label: "Estilo", group: "Aparência", unit: "", editor: "select", default: "dark", options: variantOptions },
      { id: "titleStyle", label: "Título", group: "Aparência", unit: "", editor: "select", default: "pill", options: [{ value: "pill", label: "Em pílula" }, { value: "plain", label: "Simples" }, { value: "accent", label: "Na cor de destaque" }] },
      { id: "accentColor", label: "Cor de destaque", group: "Aparência", unit: "", editor: "color", default: "#38bdf8" },
      { id: "titleSize", label: "Tamanho do título", group: "Aparência", unit: "px", editor: "number", default: 18, min: 8, max: 72, step: 1 },
      { id: "textSize", label: "Tamanho do texto", group: "Aparência", unit: "px", editor: "number", default: 15, min: 8, max: 72, step: 1 },
    ],
  ),
  entry(
    MATH_SERIES_CHART_TYPE_ID, "Gráfico do processo",
    '<path d="M3 20h18M4 21V3"/><path d="M5 17c4-8 7-10 14-11"/><path d="M8 20v-5h3v5M11 20v-7h3v7"/>',
    "Série gravada de uma planta do Laboratório (nível, volume, vazão, saída, corrente...) com reta tangente no cursor, reta secante e soma de Riemann entre a e b, área sob a curva e legenda. Na operação, arraste para mover o cursor e as alças a e b. Usa a mesma gravação das atividades (uma por planta).",
    { plantComponentId: "", channel: "h", title: "Nível × tempo", curveLabel: "", color: "#2563eb", variant: "light", windowSeconds: 0, minSeconds: 10, yMin: 0, yMax: 0, includeZero: true,
      showCursor: true, showTangent: false, showSecant: false, showArea: false, showRiemann: false, riemannMethod: "left", riemannN: 12, a: 0, b: -1, cursor: -1, showLegend: true, legendPosition: "auto", showEvents: true, titleSize: 22 },
    [
      plantField,
      { id: "channel", label: "Série", group: "Componente", unit: "", editor: "select", default: "h", options: channelOptions },
      { id: "title", label: "Título", group: "Componente", unit: "", editor: "text", default: "Nível × tempo" },
      { id: "curveLabel", label: "Legenda da curva (vazio = automática)", group: "Componente", unit: "", editor: "text", default: "" },
      { id: "showCursor", label: "Cursor", group: "Cálculo", unit: "", editor: "checkbox", default: true },
      { id: "showTangent", label: "Reta tangente no cursor", group: "Cálculo", unit: "", editor: "checkbox", default: false },
      { id: "showSecant", label: "Reta secante entre a e b", group: "Cálculo", unit: "", editor: "checkbox", default: false },
      { id: "showArea", label: "Área sob a curva entre a e b", group: "Cálculo", unit: "", editor: "checkbox", default: false },
      { id: "showRiemann", label: "Soma de Riemann entre a e b", group: "Cálculo", unit: "", editor: "checkbox", default: false },
      { id: "riemannMethod", label: "Método de Riemann", group: "Cálculo", unit: "", editor: "select", default: "left", options: [{ value: "left", label: "Esquerda" }, { value: "right", label: "Direita" }, { value: "midpoint", label: "Ponto médio" }, { value: "trapezoid", label: "Trapézio" }] },
      { id: "riemannN", label: "Retângulos (n)", group: "Cálculo", unit: "", editor: "number", default: 12, min: 1, max: 400, step: 1 },
      { id: "a", label: "a (início)", group: "Cálculo", unit: "s", editor: "number", default: 0, min: 0, max: 1e9, step: 0.5 },
      { id: "b", label: "b (fim; −1 = agora)", group: "Cálculo", unit: "s", editor: "number", default: -1, min: -1, max: 1e9, step: 0.5 },
      { id: "cursor", label: "Cursor (−1 = acompanha o presente)", group: "Cálculo", unit: "s", editor: "number", default: -1, min: -1, max: 1e9, step: 0.5 },
      { id: "windowSeconds", label: "Janela (0 = desde o início)", group: "Faixa", unit: "s", editor: "number", default: 0, min: 0, max: 36000, step: 1 },
      { id: "minSeconds", label: "Eixo do tempo mínimo", group: "Faixa", unit: "s", editor: "number", default: 10, min: 1, max: 36000, step: 1 },
      { id: "yMin", label: "y mínimo (= máximo: automático)", group: "Faixa", unit: "", editor: "number", default: 0, min: -1e9, max: 1e9, step: 0.1 },
      { id: "yMax", label: "y máximo", group: "Faixa", unit: "", editor: "number", default: 0, min: -1e9, max: 1e9, step: 0.1 },
      { id: "includeZero", label: "Incluir o zero no eixo y", group: "Faixa", unit: "", editor: "checkbox", default: true },
      { id: "color", label: "Cor da curva", group: "Aparência", unit: "", editor: "color", default: "#2563eb" },
      { id: "variant", label: "Estilo", group: "Aparência", unit: "", editor: "select", default: "light", options: [{ value: "light", label: "Claro" }, { value: "dark", label: "Escuro" }] },
      { id: "showLegend", label: "Legenda", group: "Aparência", unit: "", editor: "checkbox", default: true },
      { id: "legendPosition", label: "Posição da legenda", group: "Aparência", unit: "", editor: "select", default: "auto", options: [{ value: "auto", label: "Automática" }, { value: "top-right", label: "Em cima, à direita" }, { value: "bottom-right", label: "Embaixo, à direita" }, { value: "top-left", label: "Em cima, à esquerda" }, { value: "bottom-left", label: "Embaixo, à esquerda" }] },
      { id: "showEvents", label: "Marcar mudanças de parâmetro", group: "Aparência", unit: "", editor: "checkbox", default: true },
      { id: "titleSize", label: "Tamanho do título", group: "Aparência", unit: "px", editor: "number", default: 22, min: 10, max: 48, step: 1 },
    ],
  ),
  entry(
    MATH_PROCESS_TANK_TYPE_ID, "Tanque de processo",
    '<path d="M6 5h12v13a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2z"/><path d="M6 12c2 1 4 1 6 0s4-1 6 0"/><path d="M2 3h7v2M18 17h4"/>',
    "Tanque vetorial animado: vidro e aço, líquido com superfície e bolhas, régua de nível, jato de entrada, saída por bomba, válvula ou orifício e avisos de transbordo. Ligado a uma planta de tanque do Laboratório mostra V, h, A e as vazões; sem planta, mostra o nível (%) de uma fonte (Binding).",
    { plantComponentId: "", label: "", liquidColor: "#1e88e5", showScale: true, showValues: true, scaleMax: 0, value: 50, bindSource: "", bindChannel: 0, bindScale: 1, bindOffset: 0, bindUnit: "%", bindDecimals: 1 },
    [
      plantField,
      { id: "label", label: "Rótulo (opcional)", group: "Componente", unit: "", editor: "text", default: "" },
      { id: "showScale", label: "Régua de nível", group: "Aparência", unit: "", editor: "checkbox", default: true },
      { id: "showValues", label: "Valores (V, A, vazões)", group: "Aparência", unit: "", editor: "checkbox", default: true },
      { id: "scaleMax", label: "Topo da régua (0 = h máx. da planta)", group: "Aparência", unit: "m", editor: "number", default: 0, min: 0, max: 1e6, step: 0.1 },
      { id: "liquidColor", label: "Cor do líquido", group: "Aparência", unit: "", editor: "color", default: "#1e88e5" },
      { id: "value", label: "Nível sem fonte", group: "Binding", unit: "%", editor: "number", default: 50, min: 0, max: 100, step: 1 },
      ...binding,
    ],
  ),
  entry(
    MATH_PLANT_PARAMETER_TYPE_ID, "Parâmetro da planta",
    '<path d="M4 15h16"/><circle cx="14" cy="15" r="3"/><path d="M12 3c2 2.5 3.5 4.3 3.5 6a3.5 3.5 0 0 1-7 0c0-1.7 1.5-3.5 3.5-6z"/>',
    "Slider de um parâmetro de uma planta do Laboratório (vazões, área, degrau u, pressão...). Muda a planta no simulador ao vivo, com a política do Laboratório: parâmetros estruturais só com a simulação parada. Vale só para a execução: Reiniciar volta aos valores do projeto.",
    { plantComponentId: "", parameterId: "qIn", label: "", icon: "auto", color: "", decimals: -1, background: "none" },
    [
      plantField,
      { id: "parameterId", label: "Parâmetro", group: "Componente", unit: "", editor: "select", default: "qIn", options: parameterOptions },
      { id: "label", label: "Rótulo (vazio = o do parâmetro)", group: "Componente", unit: "", editor: "text", default: "" },
      { id: "icon", label: "Ícone", group: "Aparência", unit: "", editor: "select", default: "auto", options: [{ value: "auto", label: "Automático" }, ...iconOptions] },
      { id: "color", label: "Cor (vazio = automática)", group: "Aparência", unit: "", editor: "color", default: "" },
      { id: "decimals", label: "Casas decimais (−1 = pelo passo)", group: "Aparência", unit: "", editor: "number", default: -1, min: -1, max: 6, step: 1 },
      { id: "background", label: "Fundo", group: "Aparência", unit: "", editor: "select", default: "none", options: [{ value: "none", label: "Nenhum" }, { value: "card", label: "Cartão" }] },
    ],
  ),
  entry(
    MATH_SIM_CONTROLS_TYPE_ID, "Controles da simulação",
    '<rect x="2" y="7" width="8" height="10" rx="2"/><path d="M5 10v4l3-2z"/><rect x="12" y="7" width="5" height="10" rx="2"/><path d="M20 10v4"/>',
    "Botões Executar, Pausar e Reiniciar (para e reconstrói: as séries recomeçam e os parâmetros voltam aos do projeto) com o estado da simulação e o tempo simulado da planta.",
    { plantComponentId: "", showStatus: true, runningText: "Simulação em tempo real" },
    [
      { ...plantField, label: "Planta (opcional: mostra o tempo simulado)" },
      { id: "showStatus", label: "Mostrar o estado", group: "Aparência", unit: "", editor: "checkbox", default: true },
      { id: "runningText", label: "Texto em execução", group: "Aparência", unit: "", editor: "text", default: "Simulação em tempo real" },
    ],
  ),
  entry(
    MATH_READOUT_TYPE_ID, "Leitura da planta",
    '<path d="M4 8h4M4 12h4"/><path d="M11 6h9v12h-9z"/><path d="M14 10h3M14 14h2"/>',
    "Valor grande de uma série ou de um parâmetro da planta (ex.: V = 21,2 L), com símbolo, unidade e rótulo.",
    { plantComponentId: "", quantity: "V", symbol: "", unit: "", label: "", decimals: 2, fontSize: 26, color: "#e8eef8", background: "none" },
    [
      plantField,
      { id: "quantity", label: "Grandeza", group: "Componente", unit: "", editor: "select", default: "V", options: [...channelOptions, ...parameterOptions] },
      { id: "symbol", label: "Símbolo (vazio = automático)", group: "Componente", unit: "", editor: "text", default: "" },
      { id: "unit", label: "Unidade (vazio = automática)", group: "Componente", unit: "", editor: "text", default: "" },
      { id: "label", label: "Rótulo acima (opcional)", group: "Componente", unit: "", editor: "text", default: "" },
      { id: "decimals", label: "Casas decimais", group: "Aparência", unit: "", editor: "number", default: 2, min: 0, max: 8, step: 1 },
      { id: "fontSize", label: "Tamanho", group: "Aparência", unit: "px", editor: "number", default: 26, min: 8, max: 96, step: 1 },
      { id: "color", label: "Cor", group: "Aparência", unit: "", editor: "color", default: "#e8eef8" },
      { id: "background", label: "Fundo", group: "Aparência", unit: "", editor: "select", default: "none", options: [{ value: "none", label: "Nenhum" }, { value: "card", label: "Cartão" }] },
    ],
  ),
];
