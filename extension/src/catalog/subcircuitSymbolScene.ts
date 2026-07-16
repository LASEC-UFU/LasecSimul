import { PackageDescriptor, PackagePin, PackageShape, SYMBOL_PIN_TYPE_ID, WebviewComponentModel } from "../ui/webview/model";

export { SYMBOL_PIN_TYPE_ID };

/** Materializa/compila a cena WYSIWYG do Modo Símbolo/Ícone (`state.symbolElements`/`iconElements`,
 * `main.ts`) a partir de/para um `PackageDescriptor` (`SubcircuitDocument.symbol`/`icon`,
 * `subcircuitDocument.ts`). Substitui `subcircuitPackageAuthoring.ts` (removido) -- diferenças
 * deliberadas que eliminam a classe inteira de bugs "2 Package na cena"/"rótulo desalinhado do
 * pino":
 *
 * - NÃO existe um objeto "corpo do Package" na cena -- `width`/`height`/`border`/`background` são
 *   propriedades do PRÓPRIO DOCUMENTO (`PackageDescriptor`), nunca um componente arrastável/
 *   duplicável/apagável. Isso é estrutural, não uma regra aplicada por validação: não há nenhum
 *   typeId "canvas" pra duplicar em primeiro lugar.
 * - Pino (`SYMBOL_PIN_TYPE_ID`) usa `component.label` como seu PRÓPRIO rótulo -- nunca um
 *   `graphics.text` linkado à parte (`linkedPinComponentId`, removido). A posição/rotação/cor do
 *   rótulo (arrastável de verdade no editor, ver `main.ts::renderExternalLabel`) reaproveita o MESMO
 *   mecanismo genérico de rótulo "id" de QUALQUER componente (`__ui_idLabelX/Y/Rotation/Color`) --
 *   nenhum sistema de arrasto novo, só uma nova origem padrão (direção do lead) pro pino
 *   especificamente. Contrato compartilhado com `main.ts` (que nunca pode importar deste arquivo,
 *   fora do `rootDir` de `tsconfig.webview.json`): os NOMES dessas 4 chaves de propriedade e o
 *   significado de X/Y (delta relativo a `component.x/y`, o canto superior-esquerdo da caixa do
 *   pino) são duplicados por necessidade, não acidente -- mudar um lado exige mudar o outro.
 * - Cena começa em (0,0) -- sem "origem reservada"/distinção nativo-vs-exibido (essa complexidade
 *   existia só pra caber ao lado do circuito interno real na MESMA cena; Símbolo/Ícone agora são
 *   cenas próprias e independentes). */

const DEFAULT_LABEL_FONT_SIZE = 7;
const DEFAULT_LABEL_COLOR = "#1f2937";
const ID_LABEL_X_KEY = "__ui_idLabelX";
const ID_LABEL_Y_KEY = "__ui_idLabelY";
const ID_LABEL_ROTATION_KEY = "__ui_idLabelRotation";
const ID_LABEL_COLOR_KEY = "__ui_idLabelColor";

function nearestCardinalRotation(angleDeg: number): 0 | 90 | 180 | 270 {
  const normalized = ((angleDeg % 360) + 360) % 360;
  const rounded = (Math.round(normalized / 90) * 90) % 360;
  return rounded as 0 | 90 | 180 | 270;
}

/** Caixa quadrada apertada de um pino -- mesmo espírito de `tunnelBox`/`propertyDrivenBox`
 * (`componentSymbols.ts`): área de seleção/arrasto pequena o bastante pra mover um pino perto de
 * outro sem esbarrar (bug real corrigido nesta área, sessão anterior). */
function pinBoxSide(length: number): number {
  return Math.max(14, length * 2 + 6);
}

function pinLabelBoxSize(text: string, fontSize: number): { width: number; height: number } {
  return { width: Math.max(16, text.length * fontSize * 0.62 + 4), height: fontSize + 4 };
}

function shapeLabelBoxSize(text: string, fontSize: number): { width: number; height: number } {
  return { width: Math.max(24, text.length * fontSize * 0.62 + 12), height: fontSize + 14 };
}

function shapeLineBoxSide(length: number): number {
  return Math.max(20, length + 12);
}

function shapeRotationTransform(rotation: 0 | 90 | 180 | 270, cx: number, cy: number): string | undefined {
  return rotation === 0 ? undefined : `rotate(${rotation} ${cx} ${cy})`;
}

function parseShapeRotationTransform(transform: string | undefined): 0 | 90 | 180 | 270 {
  if (!transform) return 0;
  const match = /^rotate\(\s*(-?\d+(?:\.\d+)?)/.exec(transform.trim());
  if (!match) return 0;
  return nearestCardinalRotation(Number(match[1]));
}

/** Materializa 1 `PackagePin` num componente de cena `symbol.pin` -- lead+rótulo NUM SÓ objeto
 * (nunca um `graphics.text` separado). `angle` (espaço do arquivo, convenção `packagePinVisualEnd`)
 * vira `rotation` de cena via `(180-angle) mod 360` -- MESMA conversão de sempre (verificada
 * numericamente contra `packagePinVisualEnd`, ver `subcircuitPackageAuthoring.test.ts`, preservada
 * aqui). */
export function materializeSymbolPin(pin: PackagePin, idFactory: () => string): WebviewComponentModel {
  const rawAngle = typeof pin.angle === "number" ? pin.angle : 0;
  const angle = ((rawAngle % 360) + 360) % 360;
  const rotation = nearestCardinalRotation((180 - angle + 360) % 360);
  const length = typeof pin.length === "number" ? pin.length : 8;
  const box = pinBoxSide(length);
  const anchorX = typeof pin.x === "number" ? pin.x : 0;
  const anchorY = typeof pin.y === "number" ? pin.y : 0;
  const componentX = anchorX - box / 2;
  const componentY = anchorY - box / 2;

  const label = pin.label ?? pin.id;
  const fontSize = typeof pin.labelFontSize === "number" ? pin.labelFontSize : DEFAULT_LABEL_FONT_SIZE;
  // `pin.labelX/Y` (arquivo) são ABSOLUTOS na mesma cena de `pin.x/y`; `__ui_idLabelX/Y` (cena da
  // Webview) são um DELTA relativo ao canto superior-esquerdo do próprio pino (`component.x/y`,
  // contrato de `main.ts::externalLabelOffset`) -- só grava a propriedade quando o arquivo tem
  // posição EXPLÍCITA (rótulo já arrastado numa sessão anterior); ausente deixa `main.ts` calcular
  // o padrão (direção do lead) sozinho, nunca duplicando a fórmula como um valor "cravado".
  const hasCustomLabelPos = typeof pin.labelX === "number" && typeof pin.labelY === "number";

  return {
    id: idFactory(),
    typeId: SYMBOL_PIN_TYPE_ID,
    label,
    x: componentX,
    y: componentY,
    rotation,
    pins: [],
    properties: {
      pinId: pin.id,
      length,
      ...(hasCustomLabelPos
        ? {
            [ID_LABEL_X_KEY]: (pin.labelX as number) - componentX,
            [ID_LABEL_Y_KEY]: (pin.labelY as number) - componentY,
          }
        : {}),
      ...(typeof pin.labelRotation === "number" && pin.labelRotation ? { [ID_LABEL_ROTATION_KEY]: nearestCardinalRotation(pin.labelRotation) } : {}),
      ...(typeof pin.labelColor === "string" && pin.labelColor !== DEFAULT_LABEL_COLOR ? { [ID_LABEL_COLOR_KEY]: pin.labelColor } : {}),
      ...(fontSize !== DEFAULT_LABEL_FONT_SIZE ? { labelFontSize: fontSize } : {}),
      ...(pin.kind ? { kind: pin.kind } : {}),
    },
  };
}

/** Materializa 1 `PackageShape` -- reaproveita os typeIds GENÉRICOS já existentes no catálogo
 * (`graphics.rectangle`/`ellipse`/`line`/`image`/`text`), nunca um typeId novo (mesma peça já
 * arrastável/editável/copiável pela paleta comum). `polygon`/`path`/`svg` não têm contraparte de
 * cena editável ainda (mesma limitação documentada da versão anterior) -- sobrevivem intocados no
 * arquivo até a sessão de fato editar/salvar o Símbolo/Ícone. */
export function materializeSymbolShape(shape: PackageShape, order: number, idFactory: () => string): WebviewComponentModel | undefined {
  const rotation = parseShapeRotationTransform(shape.transform);
  const baseProperties = { __symbolShapeOrder: order };
  switch (shape.kind) {
    case "rect": {
      const x = shape.x ?? 0;
      const y = shape.y ?? 0;
      const w = shape.w ?? 0;
      const h = shape.h ?? 0;
      return {
        id: idFactory(), typeId: "graphics.rectangle", label: "graphics.rectangle", x, y, rotation, pins: [],
        properties: {
          ...baseProperties, width: w, height: h,
          ...(shape.stroke ? { stroke: shape.stroke } : {}),
          ...(shape.fill ? { fill: shape.fill } : {}),
          ...(shape.strokeWidth !== undefined ? { strokeWidth: shape.strokeWidth } : {}),
        },
      };
    }
    case "ellipse": {
      const rx = shape.rx ?? 0;
      const ry = shape.ry ?? 0;
      const cx = shape.cx ?? 0;
      const cy = shape.cy ?? 0;
      return {
        id: idFactory(), typeId: "graphics.ellipse", label: "graphics.ellipse", x: cx - rx, y: cy - ry, rotation, pins: [],
        properties: {
          ...baseProperties, width: rx * 2, height: ry * 2,
          ...(shape.stroke ? { stroke: shape.stroke } : {}),
          ...(shape.fill ? { fill: shape.fill } : {}),
        },
      };
    }
    case "line": {
      const x1 = shape.x1 ?? 0, y1 = shape.y1 ?? 0, x2 = shape.x2 ?? 0, y2 = shape.y2 ?? 0;
      const length = Math.max(4, Math.hypot(x2 - x1, y2 - y1));
      const midX = (x1 + x2) / 2, midY = (y1 + y2) / 2;
      const box = shapeLineBoxSide(length);
      return {
        id: idFactory(), typeId: "graphics.line", label: "graphics.line", x: midX - box / 2, y: midY - box / 2, rotation, pins: [],
        properties: { ...baseProperties, length, ...(shape.stroke ? { stroke: shape.stroke } : {}) },
      };
    }
    case "image": {
      const x = shape.x ?? 0, y = shape.y ?? 0, w = shape.w ?? 0, h = shape.h ?? 0;
      const href = shape.href ?? shape.value ?? "";
      const dataUriMatch = /^data:([^;]+);base64,(.*)$/s.exec(href);
      return {
        id: idFactory(), typeId: "graphics.image", label: "graphics.image", x, y, rotation, pins: [],
        properties: {
          ...baseProperties, path: "", width: w, height: h,
          ...(dataUriMatch ? { imageData: dataUriMatch[2]!, imageMime: dataUriMatch[1]! } : {}),
        },
      };
    }
    case "text": {
      const text = shape.value ?? "";
      const fontSize = shape.fontSize ?? 11;
      const cx = shape.x ?? 0, cy = shape.y ?? 0;
      const box = shapeLabelBoxSize(text, fontSize);
      return {
        id: idFactory(), typeId: "graphics.text", label: "graphics.text",
        x: Math.round(cx - box.width / 2), y: Math.round(cy - box.height / 2), rotation, pins: [],
        properties: { ...baseProperties, text, fontSize, ...(shape.color ? { color: shape.color } : {}) },
      };
    }
    default:
      return undefined;
  }
}

/** Materializa o `PackageDescriptor` inteiro (pinos + shapes) numa cena `WebviewComponentModel[]` --
 * chamado ao abrir "Abrir Subcircuito" pra popular `state.symbolElements`/`iconElements`. `icon`
 * nunca tem pinos (`descriptor.pins` sempre vazio/ausente nesse caso, ver `subcircuitDocument.ts`),
 * então esta função funciona igual pras duas cenas sem nenhum parâmetro extra. */
export function materializeSymbolScene(descriptor: PackageDescriptor | undefined, idFactory: () => string): WebviewComponentModel[] {
  if (!descriptor) return [];
  const elements: WebviewComponentModel[] = [];
  for (const pin of descriptor.pins ?? []) elements.push(materializeSymbolPin(pin, idFactory));
  (descriptor.shapes ?? []).forEach((shape, index) => {
    const el = materializeSymbolShape(shape, index, idFactory);
    if (el) elements.push(el);
  });
  return elements;
}

export interface SymbolSceneCompileResult {
  pins: PackagePin[];
  shapes: PackageShape[];
  errors: string[];
  warnings: string[];
}

function deriveSymbolShape(component: WebviewComponentModel): PackageShape | undefined {
  const rotation = component.rotation;
  switch (component.typeId) {
    case "graphics.rectangle": {
      const width = typeof component.properties.width === "number" ? component.properties.width : 0;
      const height = typeof component.properties.height === "number" ? component.properties.height : 0;
      const pivotX = component.x + width / 2;
      const pivotY = component.y + height / 2;
      return {
        kind: "rect", x: component.x, y: component.y, w: width, h: height,
        stroke: typeof component.properties.stroke === "string" ? component.properties.stroke : undefined,
        fill: typeof component.properties.fill === "string" ? component.properties.fill : undefined,
        strokeWidth: typeof component.properties.strokeWidth === "number" ? component.properties.strokeWidth : undefined,
        transform: shapeRotationTransform(rotation, pivotX, pivotY),
      };
    }
    case "graphics.ellipse": {
      const width = typeof component.properties.width === "number" ? component.properties.width : 0;
      const height = typeof component.properties.height === "number" ? component.properties.height : 0;
      const cx = component.x + width / 2;
      const cy = component.y + height / 2;
      return {
        kind: "ellipse", cx, cy, rx: width / 2, ry: height / 2,
        stroke: typeof component.properties.stroke === "string" ? component.properties.stroke : undefined,
        fill: typeof component.properties.fill === "string" ? component.properties.fill : undefined,
        transform: shapeRotationTransform(rotation, cx, cy),
      };
    }
    case "graphics.line": {
      const length = typeof component.properties.length === "number" ? component.properties.length : 40;
      const box = shapeLineBoxSide(length);
      const centerX = component.x + box / 2;
      const centerY = component.y + box / 2;
      const halfLength = length / 2;
      return {
        kind: "line", x1: centerX - halfLength, y1: centerY, x2: centerX + halfLength, y2: centerY,
        stroke: typeof component.properties.stroke === "string" ? component.properties.stroke : undefined,
        transform: shapeRotationTransform(rotation, centerX, centerY),
      };
    }
    case "graphics.image": {
      const width = typeof component.properties.width === "number" ? component.properties.width : 0;
      const height = typeof component.properties.height === "number" ? component.properties.height : 0;
      const pivotX = component.x + width / 2;
      const pivotY = component.y + height / 2;
      const imageData = typeof component.properties.imageData === "string" ? component.properties.imageData : undefined;
      const imageMime = typeof component.properties.imageMime === "string" ? component.properties.imageMime : "image/png";
      return {
        kind: "image", x: component.x, y: component.y, w: width, h: height,
        href: imageData ? `data:${imageMime};base64,${imageData}` : undefined,
        preserveAspectRatio: "none",
        transform: shapeRotationTransform(rotation, pivotX, pivotY),
      };
    }
    case "graphics.text": {
      const text = typeof component.properties.text === "string" ? component.properties.text : "";
      const fontSize = typeof component.properties.fontSize === "number" ? component.properties.fontSize : 11;
      const box = shapeLabelBoxSize(text, fontSize);
      const cx = component.x + box.width / 2;
      const cy = component.y + box.height / 2;
      return {
        kind: "text", x: cx, y: cy, value: text, fontSize, textAnchor: "middle", dominantBaseline: "middle",
        color: typeof component.properties.color === "string" ? component.properties.color : undefined,
        transform: shapeRotationTransform(rotation, cx, cy),
      };
    }
    default:
      return undefined;
  }
}

/** Compila uma cena `WebviewComponentModel[]` (Modo Símbolo/Ícone) de volta pra `pins[]`/`shapes[]`
 * -- chamado por `writeSubcircuitEditingSessionBack` ANTES de gravar em disco. Nunca lança;
 * condições inválidas viram `errors[]`/`warnings[]` (mesmo princípio de
 * `compilePackageAuthoringComponents`, removida). Duplicar pinId aqui é sempre um bug de quem
 * chama (`subcircuitPinModel.ts::createPin` nunca deveria produzir isso) -- reportado como erro
 * bloqueante mesmo assim, nunca silenciosamente sobrescrito. */
export function compileSymbolScene(elements: readonly WebviewComponentModel[]): SymbolSceneCompileResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const seenPinIds = new Set<string>();
  const pins: PackagePin[] = [];

  for (const component of elements) {
    if (component.typeId !== SYMBOL_PIN_TYPE_ID) continue;
    const pinId = typeof component.properties.pinId === "string" ? component.properties.pinId.trim() : "";
    if (!pinId) {
      warnings.push(`Pino "${component.label}" sem identificador (pinId) -- ignorado.`);
      continue;
    }
    if (seenPinIds.has(pinId)) {
      errors.push(`Identificador de pino duplicado no Símbolo: "${pinId}".`);
      continue;
    }
    seenPinIds.add(pinId);

    const length = typeof component.properties.length === "number" ? component.properties.length : 8;
    const box = pinBoxSide(length);
    const anchorX = component.x + box / 2;
    const anchorY = component.y + box / 2;
    const label = component.label || pinId;
    const labelFontSize = typeof component.properties.labelFontSize === "number" ? component.properties.labelFontSize : DEFAULT_LABEL_FONT_SIZE;

    const pin: PackagePin = {
      id: pinId,
      x: anchorX,
      y: anchorY,
      angle: (180 - component.rotation + 360) % 360,
      length,
      label,
      labelFontSize,
      labelTextAnchor: "middle",
      labelDominantBaseline: "middle",
    };
    // `__ui_idLabelX/Y` (Webview) só existem quando o usuário efetivamente ARRASTOU o rótulo --
    // presença aqui é o único sinal de "posição customizada" (mesmo contrato de
    // `materializeSymbolPin`, delta relativo a `component.x/y`, convertido de volta pro absoluto do
    // arquivo). Ausente == deixa `pin.labelX/Y` de fora, nunca escreve um valor "cravado" que
    // coincide por acaso com o padrão calculado.
    if (typeof component.properties[ID_LABEL_X_KEY] === "number" && typeof component.properties[ID_LABEL_Y_KEY] === "number") {
      pin.labelX = component.x + (component.properties[ID_LABEL_X_KEY] as number);
      pin.labelY = component.y + (component.properties[ID_LABEL_Y_KEY] as number);
    }
    if (typeof component.properties[ID_LABEL_ROTATION_KEY] === "number" && component.properties[ID_LABEL_ROTATION_KEY]) {
      pin.labelRotation = component.properties[ID_LABEL_ROTATION_KEY] as number;
    }
    if (typeof component.properties[ID_LABEL_COLOR_KEY] === "string" && component.properties[ID_LABEL_COLOR_KEY] !== DEFAULT_LABEL_COLOR) {
      pin.labelColor = component.properties[ID_LABEL_COLOR_KEY] as string;
    }
    if (typeof component.properties.kind === "string") pin.kind = component.properties.kind;
    pins.push(pin);
  }

  const shapes = elements
    .filter((c) => c.typeId !== SYMBOL_PIN_TYPE_ID)
    .slice()
    .sort((a, b) => {
      const orderA = typeof a.properties.__symbolShapeOrder === "number" ? a.properties.__symbolShapeOrder : Number.MAX_SAFE_INTEGER;
      const orderB = typeof b.properties.__symbolShapeOrder === "number" ? b.properties.__symbolShapeOrder : Number.MAX_SAFE_INTEGER;
      return orderA - orderB;
    })
    .map(deriveSymbolShape)
    .filter((shape): shape is PackageShape => shape !== undefined);

  return { pins, shapes, errors, warnings };
}
