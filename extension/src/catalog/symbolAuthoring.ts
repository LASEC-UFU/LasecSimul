/**
 * Conversão pura entre `PackageDescriptor` (o que fica salvo no `package` de um
 * `device.json`/`mcu.json`/`.lssub.json`) e uma lista de `WebviewComponentModel` (o que aparece na
 * sessão de autoria de símbolo, ver `.spec/lasecsimul-native-devices.spec` seção 21.3 e
 * `main.ts::enterSymbolAuthoring`). Mesma ideia do SimulIDE real: `other.package`/`graphics.*`/
 * `other.package_pin` são componentes comuns colocados no canvas; "compilar" é só ler de volta a
 * posição/rotação/propriedades de cada um.
 *
 * Convenção geométrica (mesma de `componentSymbols.ts`): `component.x/y` é o canto superior-esquerdo
 * da caixa do componente (`componentBox`); `component.rotation` (0/90/180/270, CSS) faz o papel do
 * `angle` de um `PackagePin`/orientação de uma `graphics.line` -- por isso só ângulos múltiplos de
 * 90° sobrevivem ao round-trip visual (ver `snapRotation`). Cada conversão (seed/compile) é a
 * INVERSA exata da outra quando a caixa do tipo é determinística a partir das mesmas propriedades
 * (rect/ellipse/pino: sim, sempre; texto: sim, desde que o conteúdo não mude entre seed e compile;
 * linha: perde precisão de ângulo não-cardinal, ver `snapRotation`).
 */
import { componentBox } from "../ui/webview/componentSymbols";
import { PackageBackground, PackageDescriptor, PackagePin, PackageShape, WebviewComponentModel } from "../ui/webview/model";

function nextComponentId(prefix: string, index: number): string {
  return `symbol-${prefix}-${index}`;
}

function baseComponent(id: string, typeId: string, x: number, y: number, rotation: 0 | 90 | 180 | 270, properties: Record<string, string | number | boolean>): WebviewComponentModel {
  return { id, typeId, label: typeId, hidden: false, x: Math.round(x), y: Math.round(y), rotation, pins: [], properties };
}

/** Ângulo real (graus, qualquer valor) -> o múltiplo de 90° mais próximo -- `component.rotation` só
 * aceita 4 valores. Pinos/formas autorados visualmente sempre caem exatamente num desses 4 (toda
 * rotação parte de 0 e só gira em passos de 90°), então isto só perde precisão pra packages escritos
 * à mão com ângulo não-cardinal (nenhum dos 3 exemplos reais do projeto faz isso hoje). */
function snapRotation(angleDegrees: number): 0 | 90 | 180 | 270 {
  const normalized = ((Math.round(angleDegrees / 90) * 90) % 360 + 360) % 360;
  return normalized as 0 | 90 | 180 | 270;
}

/** Constrói a lista de componentes pra semear a sessão de autoria a partir de um `package` já
 * existente (ou em branco, ver `extension.ts::extractPackageForEditing`). `originX`/`originY` é
 * onde o `other.package` (e portanto a origem `(0,0)` do package) fica no canvas -- arbitrário,
 * escolhido só pra dar folga visual em volta. */
export function seedSymbolAuthoringComponents(pkg: PackageDescriptor, originX = 140, originY = 140): WebviewComponentModel[] {
  const components: WebviewComponentModel[] = [];

  const packageProperties: Record<string, string | number | boolean> = { width: pkg.width, height: pkg.height, border: pkg.border ?? true };
  if (pkg.background?.kind === "color" && pkg.background.value) packageProperties.backgroundColor = pkg.background.value;
  components.push(baseComponent(nextComponentId("package", 0), "other.package", originX, originY, 0, packageProperties));

  (pkg.shapes ?? []).forEach((shape, index) => {
    const component = seedShapeComponent(shape, index, originX, originY);
    if (component) components.push(component);
  });

  pkg.pins.forEach((pin, index) => {
    const properties: Record<string, string | number | boolean> = { pinId: pin.id, label: pin.label ?? pin.id, length: pin.length };
    const box = componentBox("other.package_pin", properties);
    components.push(
      baseComponent(
        nextComponentId("pin", index),
        "other.package_pin",
        originX + pin.x - box.width / 2,
        originY + pin.y - box.height / 2,
        snapRotation(pin.angle),
        properties,
      ),
    );
  });

  return components;
}

function seedShapeComponent(shape: PackageShape, index: number, originX: number, originY: number): WebviewComponentModel | undefined {
  switch (shape.kind) {
    case "rect": {
      const properties = { width: shape.w ?? 0, height: shape.h ?? 0, stroke: shape.stroke ?? "#94a3b8", fill: shape.fill ?? "none", strokeWidth: shape.strokeWidth ?? 1 };
      return baseComponent(nextComponentId("shape", index), "graphics.rectangle", originX + (shape.x ?? 0), originY + (shape.y ?? 0), 0, properties);
    }
    case "ellipse": {
      const rx = shape.rx ?? 0;
      const ry = shape.ry ?? 0;
      const properties = { width: rx * 2, height: ry * 2, stroke: shape.stroke ?? "#94a3b8", fill: shape.fill ?? "none" };
      return baseComponent(nextComponentId("shape", index), "graphics.ellipse", originX + (shape.cx ?? 0) - rx, originY + (shape.cy ?? 0) - ry, 0, properties);
    }
    case "line": {
      const x1 = shape.x1 ?? 0;
      const y1 = shape.y1 ?? 0;
      const x2 = shape.x2 ?? 0;
      const y2 = shape.y2 ?? 0;
      const midX = (x1 + x2) / 2;
      const midY = (y1 + y2) / 2;
      const length = Math.hypot(x2 - x1, y2 - y1);
      const angle = (Math.atan2(y2 - y1, x2 - x1) * 180) / Math.PI;
      const properties = { length, stroke: shape.stroke ?? "#94a3b8" };
      const box = componentBox("graphics.line", properties);
      return baseComponent(nextComponentId("shape", index), "graphics.line", originX + midX - box.width / 2, originY + midY - box.height / 2, snapRotation(angle), properties);
    }
    case "text": {
      const fontSize = shape.fontSize ?? 11;
      const properties = { text: shape.value ?? "", fontSize, color: shape.color ?? "#1f2937" };
      const box = componentBox("graphics.text", properties);
      const centerX = shape.x ?? 0;
      const centerY = (shape.y ?? 0) - fontSize / 3;
      return baseComponent(nextComponentId("shape", index), "graphics.text", originX + centerX - box.width / 2, originY + centerY - box.height / 2, 0, properties);
    }
    default:
      return undefined;
  }
}

export interface CompileSymbolResult {
  package?: PackageDescriptor;
  /** Mensagem de erro pronta pra `vscode.window.showErrorMessage` -- nunca lança exceção, quem
   * chama decide o que fazer (abortar o save, ver `extension.ts::saveSymbolCommand`). */
  error?: string;
}

/** Inverso de `seedSymbolAuthoringComponents` -- varre a sessão de autoria (todo `state.components`
 * no momento de "Salvar Símbolo") e reconstrói o `PackageDescriptor`. `existingBackground` é o
 * `background` ATUAL no disco (relido fresco, ver `extension.ts::saveSymbolCommand`) -- preservado
 * verbatim quando não é `"color"` (svg/image ainda não tem UI de upload nesta sessão de autoria,
 * perder esse dado ao salvar seria uma regressão silenciosa, não uma limitação aceitável). */
export function compileSymbolAuthoringComponents(components: WebviewComponentModel[], existingBackground: PackageBackground | undefined): CompileSymbolResult {
  const packages = components.filter((component) => component.typeId === "other.package");
  if (packages.length === 0) return { error: "Nenhum componente \"Pacote\" (other.package) na sessão -- adicione um pra definir o corpo do símbolo." };
  if (packages.length > 1) return { error: "Mais de um componente \"Pacote\" (other.package) na sessão -- deixe só um." };

  const packageComponent = packages[0]!;
  const originX = packageComponent.x;
  const originY = packageComponent.y;
  const width = typeof packageComponent.properties.width === "number" ? packageComponent.properties.width : 80;
  const height = typeof packageComponent.properties.height === "number" ? packageComponent.properties.height : 60;
  const border = packageComponent.properties.border !== false;
  const backgroundColor = typeof packageComponent.properties.backgroundColor === "string" ? packageComponent.properties.backgroundColor : undefined;
  const background: PackageBackground | undefined = backgroundColor
    ? { kind: "color", value: backgroundColor }
    : existingBackground && existingBackground.kind !== "color" && existingBackground.kind !== "none"
      ? existingBackground
      : undefined;

  const shapes: PackageShape[] = [];
  const pins: PackagePin[] = [];

  for (const component of components) {
    if (component.typeId === "other.package") continue;
    const localX = component.x - originX;
    const localY = component.y - originY;
    if (component.typeId === "graphics.rectangle") {
      const w = typeof component.properties.width === "number" ? component.properties.width : 0;
      const h = typeof component.properties.height === "number" ? component.properties.height : 0;
      shapes.push({
        kind: "rect",
        x: localX,
        y: localY,
        w,
        h,
        stroke: typeof component.properties.stroke === "string" ? component.properties.stroke : undefined,
        fill: typeof component.properties.fill === "string" ? component.properties.fill : undefined,
        strokeWidth: typeof component.properties.strokeWidth === "number" ? component.properties.strokeWidth : undefined,
      });
    } else if (component.typeId === "graphics.ellipse") {
      const w = typeof component.properties.width === "number" ? component.properties.width : 0;
      const h = typeof component.properties.height === "number" ? component.properties.height : 0;
      shapes.push({
        kind: "ellipse",
        cx: localX + w / 2,
        cy: localY + h / 2,
        rx: w / 2,
        ry: h / 2,
        stroke: typeof component.properties.stroke === "string" ? component.properties.stroke : undefined,
        fill: typeof component.properties.fill === "string" ? component.properties.fill : undefined,
      });
    } else if (component.typeId === "graphics.line") {
      const box = componentBox("graphics.line", component.properties);
      const length = typeof component.properties.length === "number" ? component.properties.length : 40;
      const midX = localX + box.width / 2;
      const midY = localY + box.height / 2;
      const rad = (component.rotation * Math.PI) / 180;
      const dx = (Math.cos(rad) * length) / 2;
      const dy = (Math.sin(rad) * length) / 2;
      shapes.push({
        kind: "line",
        x1: midX - dx,
        y1: midY - dy,
        x2: midX + dx,
        y2: midY + dy,
        stroke: typeof component.properties.stroke === "string" ? component.properties.stroke : undefined,
      });
    } else if (component.typeId === "graphics.text") {
      const box = componentBox("graphics.text", component.properties);
      const fontSize = typeof component.properties.fontSize === "number" ? component.properties.fontSize : 11;
      shapes.push({
        kind: "text",
        x: localX + box.width / 2,
        y: localY + box.height / 2 + fontSize / 3,
        value: typeof component.properties.text === "string" ? component.properties.text : "",
        fontSize,
        color: typeof component.properties.color === "string" ? component.properties.color : undefined,
      });
    } else if (component.typeId === "other.package_pin") {
      const box = componentBox("other.package_pin", component.properties);
      const id = typeof component.properties.pinId === "string" && component.properties.pinId.trim() ? component.properties.pinId.trim() : `pin${pins.length + 1}`;
      pins.push({
        id,
        x: localX + box.width / 2,
        y: localY + box.height / 2,
        angle: component.rotation,
        length: typeof component.properties.length === "number" ? component.properties.length : 8,
        label: typeof component.properties.label === "string" ? component.properties.label : undefined,
      });
    }
  }

  return { package: { width, height, border, background, shapes, pins } };
}
