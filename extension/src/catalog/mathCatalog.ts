import type { PropertySchemaEntry, WebviewComponentCatalogEntry } from "../ui/webview/model";
import { ACTIVITY_KIND_LABEL, defaultActivity, type LabActivityKind } from "../ui/webview/lab/activity";
import {
  MATH_ACTIVITY_TYPE_ID, MATH_DEFAULT_BOX, MATH_EQUATION_TYPE_ID, MATH_PARAMETER_TYPE_ID, MATH_PLOT_TYPE_ID, MATH_TABLE_TYPE_ID, MATH_TREND_TYPE_ID,
} from "../ui/webview/mathWidgets";

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
    { name: "a", label: "", min: -3, max: 3, step: 0.1, value: 1, unit: "", decimals: 2 },
    [
      { id: "name", label: "Nome (usado nas expressões)", group: "Componente", unit: "", editor: "text", default: "a" },
      { id: "label", label: "Rótulo (opcional)", group: "Componente", unit: "", editor: "text", default: "" },
      { id: "min", label: "Mínimo", group: "Faixa", unit: "", editor: "number", default: -3, min: -1e9, max: 1e9, step: 0.1 },
      { id: "max", label: "Máximo", group: "Faixa", unit: "", editor: "number", default: 3, min: -1e9, max: 1e9, step: 0.1 },
      { id: "step", label: "Passo (0 = contínuo)", group: "Faixa", unit: "", editor: "number", default: 0.1, min: 0, max: 1e9, step: 0.01 },
      { id: "value", label: "Valor inicial", group: "Faixa", unit: "", editor: "number", default: 1, min: -1e9, max: 1e9, step: 0.1 },
      { id: "unit", label: "Unidade", group: "Componente", unit: "", editor: "text", default: "" },
      { id: "decimals", label: "Casas decimais", group: "Componente", unit: "", editor: "number", default: 2, min: 0, max: 8, step: 1 },
    ],
  ),
  entry(
    MATH_EQUATION_TYPE_ID, "Equação",
    '<path d="M4 9h6M4 15h6"/><path d="M14 6l6 12M20 6l-6 12"/>',
    "Mostra uma expressão em notação matemática (MathML), com os parâmetros da página por nome ou já substituídos pelos valores. Sem variável livre, mostra também o valor.",
    { lhs: "f(x)", variable: "x", expression: "a x^2 + b x + c", substitute: false, showValue: true, decimals: 4, fontSize: 20 },
    [
      { id: "lhs", label: "Lado esquerdo", group: "Componente", unit: "", editor: "text", default: "f(x)" },
      { id: "expression", label: "Expressão", group: "Componente", unit: "", editor: "text", default: "a x^2 + b x + c" },
      { id: "variable", label: "Variável livre", group: "Componente", unit: "", editor: "text", default: "x" },
      { id: "substitute", label: "Substituir parâmetros pelos valores", group: "Componente", unit: "", editor: "checkbox", default: false },
      { id: "showValue", label: "Mostrar valor (sem variável livre)", group: "Componente", unit: "", editor: "checkbox", default: true },
      { id: "decimals", label: "Casas decimais", group: "Componente", unit: "", editor: "number", default: 4, min: 0, max: 12, step: 1 },
      { id: "fontSize", label: "Tamanho", group: "Aparência", unit: "px", editor: "number", default: 20, min: 8, max: 96, step: 1 },
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
];
