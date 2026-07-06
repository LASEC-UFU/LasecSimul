/**
 * Conversão pura entre `PackageDescriptor` (o que fica salvo no `package` de um
 * `.lsdevice`/`.lssubcircuit`) e uma lista de `WebviewComponentModel` (o que aparece na
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
import { PackageBackground, PackageDescriptor, PackagePin, PackageShape, SIMULIDE_PACKAGE_GRID_UNIT, WebviewComponentModel, WebviewWireModel } from "../ui/webview/model";

/** Posição/orientação visual de um componente -- mesmo formato de `ProjectComponent.visual`
 * (`project/ProjectTypes.ts`), reaproveitado pro circuito INTERNO de um subcircuito
 * (`.lssubcircuit::components[].visual`/`boardVisual`, ver `extension.ts::extractInternalCircuit`). */
export interface VisualPosition {
  x: number;
  y: number;
  rotation?: 0 | 90 | 180 | 270;
  flipH?: boolean;
  flipV?: boolean;
}

export interface InternalComponentSeed {
  id: string;
  typeId: string;
  properties: Record<string, unknown>;
  visual?: VisualPosition;
  boardVisual?: VisualPosition;
  /** "Selecione os Componentes expostos" -- ver `subpackage.cpp::mainComp()`/`isMainComp` no
   * SimulIDE real. Controla quem aparece no overlay de Modo Placa do circuito PRINCIPAL (não a
   * sessão de autoria). Ausente == `false` (não exposto por padrão). */
  exposed?: boolean;
}

export interface InternalWireSeed {
  id?: string;
  from: { componentId: string; pinId: string };
  to: { componentId: string; pinId: string };
  points?: Array<{ x: number; y: number }>;
}

/** Typeids que pertencem à AUTORIA DO SÍMBOLO (corpo/formas/pinos visuais) -- tudo o mais numa
 * sessão de "Abrir Subcircuito" é circuito interno real (`compileSubcircuitInternalComponents`).
 * Rótulo de pino (`graphics.text` com `linkedPinComponentId`) é um caso especial dentro de
 * "graphics.text" -- tratado à parte em `compileSymbolAuthoringComponents`. */
function isSymbolAuthoringTypeId(typeId: string): boolean {
  return typeId === "other.package" || typeId === "other.package_pin" || typeId.startsWith("graphics.");
}

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

  const displayWidth = typeof pkg.schematicWidth === "number" && pkg.schematicWidth > 0 ? pkg.schematicWidth : pkg.width;
  const displayHeight = typeof pkg.schematicHeight === "number" && pkg.schematicHeight > 0 ? pkg.schematicHeight : pkg.height;
  const scaleX = pkg.width > 0 ? displayWidth / pkg.width : 1;
  const scaleY = pkg.height > 0 ? displayHeight / pkg.height : 1;
  const usesSimulideGrid = pkg.schematicWidth !== undefined || pkg.schematicHeight !== undefined;
  const packageProperties: Record<string, string | number | boolean> = {
    width: usesSimulideGrid ? displayWidth / SIMULIDE_PACKAGE_GRID_UNIT : pkg.width,
    height: usesSimulideGrid ? displayHeight / SIMULIDE_PACKAGE_GRID_UNIT : pkg.height,
    border: pkg.border ?? true,
  };
  if (usesSimulideGrid) {
    packageProperties.__ui_packageUnit = "simulide-grid";
    packageProperties.__ui_nativeWidth = pkg.width;
    packageProperties.__ui_nativeHeight = pkg.height;
  }
  if (pkg.background?.kind === "color" && pkg.background.value) packageProperties.backgroundColor = pkg.background.value;
  if (pkg.pinLabelColor) packageProperties.pinLabelColor = pkg.pinLabelColor;
  // `properties` só aceita string/number/boolean (sem objeto aninhado) -- a foto em base64 cabe
  // direto como string, só achatada num nome próprio em vez de `background.data`. Sem isto, a sessão
  // de autoria (componente `other.package`, ver componentSymbols.ts) nunca via a imagem real (só
  // `packageSymbolSvg`/uso normal do subcircuito via, que lê `pkg.background` direto -- caminho de
  // renderização DIFERENTE, ver `componentSymbols.ts::componentSymbolSvg` caso "other.package").
  if (pkg.background?.kind === "image" && pkg.background.data) packageProperties.backgroundImageData = pkg.background.data;
  components.push(baseComponent(nextComponentId("package", 0), "other.package", originX, originY, 0, packageProperties));

  (pkg.shapes ?? []).forEach((shape, index) => {
    const component = seedShapeComponent(shape, index, originX, originY, scaleX, scaleY);
    if (component) components.push(component);
  });

  pkg.pins.forEach((pin, index) => {
    const pinScale = pin.angle === 90 || pin.angle === 270 ? scaleY : scaleX;
    const properties: Record<string, string | number | boolean> = { pinId: pin.id, length: pin.length * pinScale };
    const box = componentBox("other.package_pin", properties);
    const pinComponentId = nextComponentId("pin", index);
    components.push(baseComponent(pinComponentId, "other.package_pin", originX + pin.x * scaleX - box.width / 2, originY + pin.y * scaleY - box.height / 2, snapRotation(pin.angle), properties));
    components.push(seedPinLabelComponent(pin, pinComponentId, index, originX, originY, scaleX, scaleY, pkg.pinLabelColor));
  });

  return components;
}

/** Posição padrão (sem `visual` salvo ainda -- nenhum dos `.lssubcircuit` reais do projeto tem essa
 * chave hoje, escritos à mão antes dela existir) -- grade simples, só pra não empilhar tudo no
 * mesmo ponto na primeira vez que alguém abre um subcircuito antigo pra editar. */
function defaultInternalLayout(index: number): VisualPosition {
  const columns = 6;
  return { x: 400 + (index % columns) * 90, y: 60 + Math.floor(index / columns) * 70, rotation: 0 };
}

function toWebviewVisual(visual: VisualPosition | undefined, index: number): Required<Pick<VisualPosition, "x" | "y" | "rotation">> & Pick<VisualPosition, "flipH" | "flipV"> {
  const resolved = visual ?? defaultInternalLayout(index);
  return { x: resolved.x, y: resolved.y, rotation: resolved.rotation ?? 0, flipH: resolved.flipH, flipV: resolved.flipV };
}

function sanitizeSubcircuitInternalProperties(properties: Record<string, unknown> | undefined): Record<string, string | number | boolean> {
  if (!properties) return {};
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(properties)) {
    // Metadados de tradução Qt->Webview são transitórios: não devem contaminar o estado visual
    // persistido de `components[]` (causava escala/distorção após reopen).
    if (key === "__simulideQtOrigin" || key === "__simulideSceneScaleX" || key === "__simulideSceneScaleY") continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") out[key] = value;
  }
  return out;
}

/** Semeia o circuito INTERNO real de um subcircuito (`.lssubcircuit` `components[]`/`wires[]`) pra
 * dentro da MESMA sessão de autoria do `package` -- igual ao SimulIDE real, onde "Open Subcircuit"
 * mostra o objeto `Package` E o circuito interno juntos, na mesma cena (ver `.spec/
 * lasecsimul-subcircuits.spec`). `pins: []` aqui é só placeholder -- quem chama
 * (`extension.ts::editPackageSymbolCommand`) preenche com `pinsForTypeId(typeId)` depois (mesmo
 * catálogo que populariza pinos pra QUALQUER componente adicionado normalmente, ver
 * `extension.ts::pinsForTypeId`) -- esta função não tem acesso ao catálogo, só à geometria. */
export function seedSubcircuitInternalComponents(components: InternalComponentSeed[], wires: InternalWireSeed[]): { components: WebviewComponentModel[]; wires: WebviewWireModel[] } {
  const seededComponents: WebviewComponentModel[] = components.map((component, index) => {
    const visual = toWebviewVisual(component.visual, index);
    // `connectors.tunnel` mostra o nome do NET (`properties.name`, ex: "G23") -- é o que identifica
    // a ligação pra quem está editando; o id interno ("tunnel_G23") é só um detalhe de
    // implementação. Demais componentes mostram o próprio id (sem nome de net pra mostrar).
    // `showId: true` torna o rótulo visível por padrão -- sem isso (`renderComponent` em main.ts)
    // todo componente do circuito interno aparecia sem nenhum texto, só o símbolo genérico, o que
    // tornava a tela de "Abrir Subcircuito" difícil de entender (várias formas iguais sem dizer o
    // que são).
    const tunnelName = component.typeId === "connectors.tunnel" && typeof component.properties.name === "string" ? component.properties.name : undefined;
    const model: WebviewComponentModel = {
      id: component.id,
      typeId: component.typeId,
      label: tunnelName ?? component.id,
      hidden: false,
      showId: true,
      x: Math.round(visual.x),
      y: Math.round(visual.y),
      rotation: visual.rotation,
      flipH: visual.flipH,
      flipV: visual.flipV,
      pins: [],
      properties: sanitizeSubcircuitInternalProperties(component.properties),
      exposed: component.exposed === true,
    };
    if (component.boardVisual) {
      model.boardX = Math.round(component.boardVisual.x);
      model.boardY = Math.round(component.boardVisual.y);
      model.boardRotation = component.boardVisual.rotation ?? 0;
      model.boardFlipH = component.boardVisual.flipH;
      model.boardFlipV = component.boardVisual.flipV;
    }
    return model;
  });

  const seededWires: WebviewWireModel[] = wires.map((wire, index) => ({
    id: wire.id ?? `internal-wire-${index}`,
    from: wire.from,
    to: wire.to,
    points: wire.points,
  }));

  return { components: seededComponents, wires: seededWires };
}

export interface CompiledInternalCircuit {
  components: InternalComponentSeed[];
  wires: InternalWireSeed[];
}

/** Inverso de `seedSubcircuitInternalComponents` -- varre a sessão e separa o que é circuito
 * interno REAL (qualquer typeId que não seja autoria de símbolo, ver `isSymbolAuthoringTypeId`) do
 * que é `package`. Grava `visual` (posição ativa no momento de salvar) e `boardVisual` (se o
 * componente já tiver entrado em Modo Placa alguma vez na sessão, ver `main.ts::toggleBoardMode`)
 * separadamente -- nunca perde a posição do modo que não está ativo no momento de salvar. */
export function compileSubcircuitInternalComponents(components: WebviewComponentModel[], wires: WebviewWireModel[]): CompiledInternalCircuit {
  const internalComponents: InternalComponentSeed[] = components
    .filter((component) => !isSymbolAuthoringTypeId(component.typeId))
    .map((component) => {
      const seed: InternalComponentSeed = {
        id: component.id,
        typeId: component.typeId,
        properties: sanitizeSubcircuitInternalProperties(component.properties),
        visual: { x: component.x, y: component.y, rotation: component.rotation, flipH: component.flipH, flipV: component.flipV },
        exposed: component.exposed === true,
      };
      if (component.boardX !== undefined && component.boardY !== undefined) {
        seed.boardVisual = { x: component.boardX, y: component.boardY, rotation: component.boardRotation ?? 0, flipH: component.boardFlipH, flipV: component.boardFlipV };
      }
      return seed;
    });

  const internalWires: InternalWireSeed[] = wires.map((wire) => ({ id: wire.id, from: wire.from, to: wire.to, points: wire.points }));

  return { components: internalComponents, wires: internalWires };
}

/** Rótulo do pino -- SEMPRE um `graphics.text` vinculado (`linkedPinComponentId`), nunca desenhado
 * pelo próprio `other.package_pin` (ver `componentSymbols.ts`) -- arrastável independente da posição
 * do pino, igual ao SimulIDE real. Sem `pin.labelX`/`labelY` (package nunca editado assim antes),
 * cai na MESMA posição padrão que o renderizador de leitura sempre calculou (ponta do lead + 9
 * unidades na direção do `angle`) -- abrir e salvar sem mover nada reproduz o `package` idêntico. */
function seedPinLabelComponent(
  pin: PackagePin,
  pinComponentId: string,
  index: number,
  originX: number,
  originY: number,
  scaleX = 1,
  scaleY = 1,
  labelColor = "#1f2937"
): WebviewComponentModel {
  const rad = (pin.angle * Math.PI) / 180;
  const tipX = pin.x + Math.cos(rad) * pin.length;
  const tipY = pin.y + Math.sin(rad) * pin.length;
  // `labelX`/`labelY` (e a fórmula padrão de fallback) são a posição EXATA da baseline do `<text>`
  // que `packagePinLeadSvg` desenha (`x=labelX y=labelY` direto) -- mesma convenção do `shape.y` de
  // um `PackageShape` kind "text" em `packageShapeSvg`, por isso o mesmo ajuste de `fontSize/3` pra
  // converter baseline -> centro da caixa (ver `seedShapeComponent`/`case "text"` abaixo e a
  // compilação espelhada em `compileSymbolAuthoringComponents`).
  const labelX = (pin.labelX ?? tipX + Math.cos(rad) * 9) * scaleX;
  const labelY = (pin.labelY ?? tipY + Math.sin(rad) * 9) * scaleY;
  const text = pin.label ?? pin.id;
  const fontSize = typeof pin.labelFontSize === "number" && pin.labelFontSize > 0 ? pin.labelFontSize : 7;
  const properties: Record<string, string | number | boolean> = { text, fontSize, color: labelColor, linkedPinComponentId: pinComponentId };
  const box = componentBox("graphics.text", properties);
  const centerX = labelX;
  const centerY = labelY - fontSize / 3;
  return baseComponent(nextComponentId("pin-label", index), "graphics.text", originX + centerX - box.width / 2, originY + centerY - box.height / 2, 0, properties);
}

function seedShapeComponent(shape: PackageShape, index: number, originX: number, originY: number, scaleX = 1, scaleY = 1): WebviewComponentModel | undefined {
  switch (shape.kind) {
    case "rect": {
      const properties = { width: (shape.w ?? 0) * scaleX, height: (shape.h ?? 0) * scaleY, stroke: shape.stroke ?? "#94a3b8", fill: shape.fill ?? "none", strokeWidth: shape.strokeWidth ?? 1 };
      return baseComponent(nextComponentId("shape", index), "graphics.rectangle", originX + (shape.x ?? 0) * scaleX, originY + (shape.y ?? 0) * scaleY, 0, properties);
    }
    case "ellipse": {
      const rx = (shape.rx ?? 0) * scaleX;
      const ry = (shape.ry ?? 0) * scaleY;
      const properties = { width: rx * 2, height: ry * 2, stroke: shape.stroke ?? "#94a3b8", fill: shape.fill ?? "none" };
      return baseComponent(nextComponentId("shape", index), "graphics.ellipse", originX + (shape.cx ?? 0) * scaleX - rx, originY + (shape.cy ?? 0) * scaleY - ry, 0, properties);
    }
    case "line": {
      const x1 = (shape.x1 ?? 0) * scaleX;
      const y1 = (shape.y1 ?? 0) * scaleY;
      const x2 = (shape.x2 ?? 0) * scaleX;
      const y2 = (shape.y2 ?? 0) * scaleY;
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
      const centerX = (shape.x ?? 0) * scaleX;
      const centerY = (shape.y ?? 0) * scaleY - fontSize / 3;
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
  const editedWidth = typeof packageComponent.properties.width === "number" ? packageComponent.properties.width : 80;
  const editedHeight = typeof packageComponent.properties.height === "number" ? packageComponent.properties.height : 60;
  const usesSimulideGrid = packageComponent.properties.__ui_packageUnit === "simulide-grid";
  const schematicWidth = usesSimulideGrid ? editedWidth * SIMULIDE_PACKAGE_GRID_UNIT : undefined;
  const schematicHeight = usesSimulideGrid ? editedHeight * SIMULIDE_PACKAGE_GRID_UNIT : undefined;
  const width = typeof packageComponent.properties.__ui_nativeWidth === "number" && packageComponent.properties.__ui_nativeWidth > 0 ? packageComponent.properties.__ui_nativeWidth : (schematicWidth ?? editedWidth);
  const height = typeof packageComponent.properties.__ui_nativeHeight === "number" && packageComponent.properties.__ui_nativeHeight > 0 ? packageComponent.properties.__ui_nativeHeight : (schematicHeight ?? editedHeight);
  const scaleX = schematicWidth !== undefined && schematicWidth > 0 && width > 0 ? schematicWidth / width : 1;
  const scaleY = schematicHeight !== undefined && schematicHeight > 0 && height > 0 ? schematicHeight / height : 1;
  const toNativeX = (value: number): number => value / scaleX;
  const toNativeY = (value: number): number => value / scaleY;
  const border = packageComponent.properties.border !== false;
  const backgroundColor = typeof packageComponent.properties.backgroundColor === "string" ? packageComponent.properties.backgroundColor : undefined;
  const background: PackageBackground | undefined = backgroundColor
    ? { kind: "color", value: backgroundColor }
    : existingBackground && existingBackground.kind !== "color" && existingBackground.kind !== "none"
      ? existingBackground
      : undefined;

  // Rótulo de pino é um `graphics.text` vinculado por `linkedPinComponentId` (id ESTÁVEL do
  // componente do pino, ver `main.ts::componentsToAddForTypeId`) -- precisa ser identificado ANTES
  // do laço principal, pra (a) não cair também em `shapes[]` como texto decorativo genérico e
  // (b) fornecer `label`/`labelX`/`labelY` reais pro `PackagePin` correspondente.
  const linkedLabelByPinComponentId = new Map<string, WebviewComponentModel>();
  for (const component of components) {
    const linkedId = component.properties.linkedPinComponentId;
    if (component.typeId === "graphics.text" && typeof linkedId === "string") {
      linkedLabelByPinComponentId.set(linkedId, component);
    }
  }

  const shapes: PackageShape[] = [];
  const pins: PackagePin[] = [];

  for (const component of components) {
    if (component.typeId === "other.package") continue;
    if (component.typeId === "graphics.text" && typeof component.properties.linkedPinComponentId === "string") continue;
    const localDisplayX = component.x - originX;
    const localDisplayY = component.y - originY;
    const localX = toNativeX(localDisplayX);
    const localY = toNativeY(localDisplayY);
    if (component.typeId === "graphics.rectangle") {
      const w = toNativeX(typeof component.properties.width === "number" ? component.properties.width : 0);
      const h = toNativeY(typeof component.properties.height === "number" ? component.properties.height : 0);
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
      const w = toNativeX(typeof component.properties.width === "number" ? component.properties.width : 0);
      const h = toNativeY(typeof component.properties.height === "number" ? component.properties.height : 0);
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
      const length = toNativeX(typeof component.properties.length === "number" ? component.properties.length : 40);
      const midX = toNativeX(localDisplayX + box.width / 2);
      const midY = toNativeY(localDisplayY + box.height / 2);
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
        x: toNativeX(localDisplayX + box.width / 2),
        y: toNativeY(localDisplayY + box.height / 2 + fontSize / 3),
        value: typeof component.properties.text === "string" ? component.properties.text : "",
        fontSize,
        color: typeof component.properties.color === "string" ? component.properties.color : undefined,
      });
    } else if (component.typeId === "other.package_pin") {
      const box = componentBox("other.package_pin", component.properties);
      const id = typeof component.properties.pinId === "string" && component.properties.pinId.trim() ? component.properties.pinId.trim() : `pin${pins.length + 1}`;
      const pin: PackagePin = {
        id,
        x: toNativeX(localDisplayX + box.width / 2),
        y: toNativeY(localDisplayY + box.height / 2),
        angle: component.rotation,
        length: (typeof component.properties.length === "number" ? component.properties.length : 8) / (component.rotation === 90 || component.rotation === 270 ? scaleY : scaleX),
      };
      const linkedLabel = linkedLabelByPinComponentId.get(component.id);
      if (linkedLabel) {
        const labelBox = componentBox("graphics.text", linkedLabel.properties);
        const labelFontSize = typeof linkedLabel.properties.fontSize === "number" ? linkedLabel.properties.fontSize : 7;
        pin.label = typeof linkedLabel.properties.text === "string" ? linkedLabel.properties.text : undefined;
        pin.labelFontSize = labelFontSize;
        pin.labelX = toNativeX(linkedLabel.x - originX + labelBox.width / 2);
        pin.labelY = toNativeY(linkedLabel.y - originY + labelBox.height / 2 + labelFontSize / 3);
      }
      pins.push(pin);
    }
  }

  const linkedPinLabelColor = [...linkedLabelByPinComponentId.values()]
    .map((component) => component.properties.color)
    .find((value): value is string => typeof value === "string" && value.trim().length > 0);
  const pinLabelColor =
    linkedPinLabelColor
    ?? (typeof packageComponent.properties.pinLabelColor === "string" && packageComponent.properties.pinLabelColor.trim()
      ? packageComponent.properties.pinLabelColor as string
      : undefined);
  return { package: { width, height, schematicWidth, schematicHeight, border, background, shapes, pins, pinLabelColor } };
}
