import {
  PACKAGE_SHAPE_ORDER_PROPERTY_KEY,
  PACKAGE_SHAPE_TYPE_IDS,
  PackageDescriptor,
  PackagePin,
  PackageShape,
  PackageShapeTypeId,
  TUNNEL_TYPE_ID,
  WebviewComponentModel,
} from "../ui/webview/model";
import { sanitizePackage } from "./packageSanitizers";

export { PACKAGE_SHAPE_ORDER_PROPERTY_KEY, PACKAGE_SHAPE_TYPE_IDS };
export type { PackageShapeTypeId };

/** Autoria visual do ícone (Figura) e do Package (corpo + pinos) do SimulIDE, DENTRO da mesma cena
 * já usada por "Abrir Subcircuito" (`extension.ts::openSubcircuitForEditingCommand`) -- nunca um
 * editor/modo separado (o antigo `symbolAuthoring.ts`/`symbolCommands.ts`, removido 2026-07-09,
 * commit `6c9e185`, TINHA um modo/toolbar dedicado; este módulo não reintroduz isso, só compila os
 * componentes de autoria já presentes na cena normal). Ver `.spec/lasecsimul-subcircuits.spec` e
 * `.spec/lasecsimul.spec`.
 *
 * Convenção geral: os 3 typeIds de autoria (`other.package`, `other.package_pin`, e o ÚNICO
 * `graphics.image` com `packageIconRole: true`) são componentes NORMAIS da cena (mesmo model,
 * mesmo drag/rotate/copy/undo, `pinCount: 0` então nunca vão pro Core -- ver
 * `coreLifecycle.ts::shouldSyncComponentToCore`). `seedPackageAuthoringComponents` os materializa a
 * partir de `manifest.package`/`manifest.interface` ao abrir a sessão;
 * `compilePackageAuthoringComponents` os lê de volta e produz `package`/`interface[]` compilados ao
 * salvar -- essas duas funções são o único lugar que entende esse round-trip. */

export const PACKAGE_TYPE_ID = "other.package";
export const PACKAGE_PIN_TYPE_ID = "other.package_pin";
/** Reaproveita o typeId genérico `graphics.image` já existente no catálogo -- a Figura/ícone do
 * Package NÃO é um typeId novo, só uma instância marcada (`WebviewComponentModel.packageIconRole`).
 * Ver seção 5 do pedido original: "reutilize o objeto Figura já existente... não crie uma segunda
 * implementação concorrente". */
export const PACKAGE_ICON_TYPE_ID = "graphics.image";

function isPackageShapeEligibleTypeId(typeId: string): typeId is PackageShapeTypeId {
  return (PACKAGE_SHAPE_TYPE_IDS as readonly string[]).includes(typeId);
}

/** Espelha `manifest.interface[]` (`.lssubcircuit`) -- `internalTunnel` (nome) continua sendo o
 * único campo que o Core (`CoreApplication.cpp`/`SimulationSession.cpp`) de fato consome e valida
 * (obrigatório, precisa bater com um túnel interno existente); `internalTunnelId` é a extensão desta
 * feature: o id ESTÁVEL do componente-túnel, usado como fonte de verdade do vínculo durante a
 * autoria (sobrevive a renomear o túnel, ao contrário do nome). A cada compilação,
 * `internalTunnel` é RE-DERIVADO do nome atual do túnel referenciado por `internalTunnelId` -- nunca
 * o inverso. */
export interface SubcircuitInterfaceEntry {
  pinId: string;
  label: string;
  internalTunnel: string;
  internalTunnelId?: string;
}

function nearestCardinalRotation(angleDeg: number): 0 | 90 | 180 | 270 {
  const normalized = ((angleDeg % 360) + 360) % 360;
  const rounded = (Math.round(normalized / 90) * 90) % 360;
  return rounded as 0 | 90 | 180 | 270;
}

/** Caixa quadrada de `other.package_pin`, espelhando `propertyDrivenBox` (`componentSymbols.ts`) --
 * duplicada aqui (não importada) porque `componentSymbols.ts` é código de renderização da Webview,
 * este módulo roda no host (Node), sem DOM. Mudar a fórmula lá exige mudar aqui também (mesmo
 * princípio de `main.ts::componentsToAddForTypeId`, que já tinha essa duplicação antes desta
 * feature). */
function packagePinBoxSide(length: number): number {
  return Math.max(24, length * 2 + 16);
}

/** Duplica `PACKAGE_PIN_LABEL_FONT_SIZE` (`componentSymbols.ts`) -- mesmo motivo de
 * `packagePinBoxSide` acima: este módulo roda no host, sem acesso ao código de renderização da
 * Webview. */
const DEFAULT_PACKAGE_PIN_LABEL_FONT_SIZE = 7;
/** Cor padrão de um rótulo de pino recém-seedado (sem `pin.labelColor` no arquivo) -- mesmo valor
 * hardcoded que este editor sempre usou pra rótulos novos; `pin.labelColor` explícito sempre ganha
 * (ver seed abaixo). */
const DEFAULT_PACKAGE_PIN_LABEL_COLOR = "#1f2937";

/** Espelha EXATAMENTE o ramo `!hasCustomLabelPos` de `packagePinLeadSvg` (`componentSymbols.ts`) --
 * mesma fórmula de offset (`length + (labelSpace ?? max(2, fontSize/2))`) e mesma posição/rotação
 * por `angle` cardeal. Usada tanto pro seed (quando o pino ainda não tem `labelX`/`labelY` no
 * arquivo) quanto, implicitamente, como a "verdade" que o preview do editor precisa reproduzir --
 * se as duas fórmulas divergirem, o editor mostra uma posição que o esquemático final não respeita.
 * Em espaço NATIVO (mesmo de `pin.x`/`pin.y`), não escalado. */
function defaultLabelNativePosition(
  anchorX: number,
  anchorY: number,
  angle: 0 | 90 | 180 | 270,
  length: number,
  labelSpace: number | undefined,
  fontSize: number
): { x: number; y: number; rotation: 0 | 90 | 270 } {
  const offset = length + (labelSpace ?? Math.max(2, fontSize / 2));
  switch (angle) {
    case 0: return { x: anchorX - offset, y: anchorY, rotation: 0 };
    case 90: return { x: anchorX, y: anchorY + offset, rotation: 90 };
    case 180: return { x: anchorX + offset, y: anchorY, rotation: 0 };
    case 270: return { x: anchorX, y: anchorY - offset, rotation: 270 };
  }
}

/** Caixa de `graphics.text`, mesma fórmula de `propertyDrivenBox` -- usada só pra centralizar o
 * rótulo seedado do pino na posição inicial (o usuário pode arrastar depois). */
function labelBoxSize(text: string, fontSize: number): { width: number; height: number } {
  return { width: Math.max(24, text.length * fontSize * 0.62 + 12), height: fontSize + 14 };
}

/** Caixa quadrada de `graphics.line`, espelhando `propertyDrivenBox` (`componentSymbols.ts`) --
 * mesmo motivo de duplicação de `packagePinBoxSide` acima (host sem DOM). */
function packageLineBoxSide(length: number): number {
  return Math.max(20, length + 12);
}

/** `PackageShape.transform` só é usado por esta feature pra carregar rotação (`rotate(deg cx cy)`,
 * mesmo pivô -- centro do elemento -- que TODO componente de cena já usa via o wrapper CSS/SVG
 * genérico, `componentGeometry.ts::svgLocalTransform`). Escrito SEMPRE neste formato exato por
 * `derivePackageShape` abaixo; só precisa reconhecer o próprio formato de volta, não qualquer
 * `transform` arbitrário que um arquivo hand-authored possa ter (nesse caso, cai no padrão
 * `rotation: 0` -- nunca quebra o seed, só não recupera uma rotação em formato desconhecido). */
function parseShapeRotationTransform(transform: string | undefined): 0 | 90 | 180 | 270 {
  if (!transform) return 0;
  const match = /^rotate\(\s*(-?\d+(?:\.\d+)?)/.exec(transform.trim());
  if (!match) return 0;
  return nearestCardinalRotation(Number(match[1]));
}

function shapeRotationTransform(rotation: 0 | 90 | 180 | 270, cx: number, cy: number): string | undefined {
  return rotation === 0 ? undefined : `rotate(${rotation} ${cx} ${cy})`;
}

/** Materializa 1 `package.shapes[]` (linha/figura/texto/retângulo/elipse) num componente de cena
 * marcado com `packageShapeRole: true` -- espelha exatamente o mesmo espaço NATIVO->EXIBIDO que o
 * Package/pinos já usam (`scaleX`/`scaleY`), e recupera a rotação (sempre cardeal, ver
 * `WebviewComponentModel.rotation`) do `shape.transform` escrito por `derivePackageShape`. Retorna
 * `undefined` pra kinds sem contraparte de cena (`polygon`/`path`/`svg`), fora de escopo desta
 * feature -- o shape original nesses casos NUNCA é seedado como componente editável, mas sobrevive
 * intocado no arquivo enquanto a sessão não tocar em autoria (`touchedPackageAuthoring`), e é
 * perdido apenas se e quando o usuário efetivamente editar/salvar o Package por esta feature (mesma
 * limitação documentada no plano -- fora de escopo, não uma perda silenciosa por omissão). */
function materializePackageShape(
  shape: PackageShape,
  order: number,
  scaleX: number,
  scaleY: number,
  origin: { x: number; y: number },
  idFactory: () => string
): WebviewComponentModel | undefined {
  const rotation = parseShapeRotationTransform(shape.transform);
  const baseProperties = { [PACKAGE_SHAPE_ORDER_PROPERTY_KEY]: order };
  switch (shape.kind) {
    case "rect": {
      const nx = shape.x ?? 0;
      const ny = shape.y ?? 0;
      const nw = shape.w ?? 0;
      const nh = shape.h ?? 0;
      return {
        id: idFactory(),
        typeId: "graphics.rectangle",
        label: "graphics.rectangle",
        x: origin.x + nx * scaleX,
        y: origin.y + ny * scaleY,
        rotation,
        pins: [],
        packageShapeRole: true,
        properties: {
          ...baseProperties,
          width: nw * scaleX,
          height: nh * scaleY,
          ...(shape.stroke ? { stroke: shape.stroke } : {}),
          ...(shape.fill ? { fill: shape.fill } : {}),
          ...(shape.strokeWidth !== undefined ? { strokeWidth: shape.strokeWidth } : {}),
        },
      };
    }
    case "ellipse": {
      const rx = shape.rx ?? 0;
      const ry = shape.ry ?? 0;
      const ncx = shape.cx ?? 0;
      const ncy = shape.cy ?? 0;
      return {
        id: idFactory(),
        typeId: "graphics.ellipse",
        label: "graphics.ellipse",
        x: origin.x + (ncx - rx) * scaleX,
        y: origin.y + (ncy - ry) * scaleY,
        rotation,
        pins: [],
        packageShapeRole: true,
        properties: {
          ...baseProperties,
          width: rx * 2 * scaleX,
          height: ry * 2 * scaleY,
          ...(shape.stroke ? { stroke: shape.stroke } : {}),
          ...(shape.fill ? { fill: shape.fill } : {}),
        },
      };
    }
    case "line": {
      const x1 = shape.x1 ?? 0;
      const y1 = shape.y1 ?? 0;
      const x2 = shape.x2 ?? 0;
      const y2 = shape.y2 ?? 0;
      const length = Math.max(4, Math.hypot(x2 - x1, y2 - y1) * scaleX);
      const midXNative = (x1 + x2) / 2;
      const midYNative = (y1 + y2) / 2;
      const box = packageLineBoxSide(length);
      const anchorX = origin.x + midXNative * scaleX;
      const anchorY = origin.y + midYNative * scaleY;
      return {
        id: idFactory(),
        typeId: "graphics.line",
        label: "graphics.line",
        x: anchorX - box / 2,
        y: anchorY - box / 2,
        rotation,
        pins: [],
        packageShapeRole: true,
        properties: {
          ...baseProperties,
          length,
          ...(shape.stroke ? { stroke: shape.stroke } : {}),
        },
      };
    }
    case "image": {
      const nx = shape.x ?? 0;
      const ny = shape.y ?? 0;
      const nw = shape.w ?? 0;
      const nh = shape.h ?? 0;
      const href = shape.href ?? shape.value ?? "";
      const dataUriMatch = /^data:([^;]+);base64,(.*)$/s.exec(href);
      return {
        id: idFactory(),
        typeId: "graphics.image",
        label: "graphics.image",
        x: origin.x + nx * scaleX,
        y: origin.y + ny * scaleY,
        rotation,
        pins: [],
        packageShapeRole: true,
        properties: {
          ...baseProperties,
          path: "",
          width: nw * scaleX,
          height: nh * scaleY,
          ...(dataUriMatch ? { imageData: dataUriMatch[2]!, imageMime: dataUriMatch[1]! } : {}),
        },
      };
    }
    case "text": {
      const text = shape.value ?? "";
      const fontSize = shape.fontSize ?? 11;
      const ncx = shape.x ?? 0;
      const ncy = shape.y ?? 0;
      const box = labelBoxSize(text, fontSize);
      const anchorX = origin.x + ncx * scaleX;
      const anchorY = origin.y + ncy * scaleY;
      return {
        id: idFactory(),
        typeId: "graphics.text",
        label: "graphics.text",
        x: Math.round(anchorX - box.width / 2),
        y: Math.round(anchorY - box.height / 2),
        rotation,
        pins: [],
        packageShapeRole: true,
        properties: {
          ...baseProperties,
          text,
          fontSize,
          ...(shape.color ? { color: shape.color } : {}),
        },
      };
    }
    default:
      return undefined;
  }
}

/** Inverso de `materializePackageShape` -- lê um componente `packageShapeRole` de volta pro espaço
 * NATIVO (`inverseScaleX`/`inverseScaleY`, mesmo par usado pra pinos/Package, ver
 * `compilePackageAuthoringComponents`) e produz o `PackageShape` equivalente. `pivotX`/`pivotY`
 * (centro do elemento em espaço NATIVO) é sempre o pivô do `transform` de rotação -- mesmo ponto que
 * o wrapper CSS/SVG genérico já usa pra girar QUALQUER componente da cena (nunca um pivô diferente
 * escondido). Retorna `undefined` só se o componente não tiver dados suficientes (nunca deveria
 * acontecer pra um componente seedado por esta mesma feature). */
function derivePackageShape(
  component: WebviewComponentModel,
  inverseScaleX: number,
  inverseScaleY: number,
  packageComponent: WebviewComponentModel
): PackageShape | undefined {
  const rotation = component.rotation;
  switch (component.typeId) {
    case "graphics.rectangle": {
      const width = typeof component.properties.width === "number" ? component.properties.width : 0;
      const height = typeof component.properties.height === "number" ? component.properties.height : 0;
      const nx = (component.x - packageComponent.x) * inverseScaleX;
      const ny = (component.y - packageComponent.y) * inverseScaleY;
      const nw = width * inverseScaleX;
      const nh = height * inverseScaleY;
      const pivotX = nx + nw / 2;
      const pivotY = ny + nh / 2;
      return {
        kind: "rect",
        x: nx,
        y: ny,
        w: nw,
        h: nh,
        stroke: typeof component.properties.stroke === "string" ? component.properties.stroke : undefined,
        fill: typeof component.properties.fill === "string" ? component.properties.fill : undefined,
        strokeWidth: typeof component.properties.strokeWidth === "number" ? component.properties.strokeWidth : undefined,
        transform: shapeRotationTransform(rotation, pivotX, pivotY),
      };
    }
    case "graphics.ellipse": {
      const width = typeof component.properties.width === "number" ? component.properties.width : 0;
      const height = typeof component.properties.height === "number" ? component.properties.height : 0;
      const nx = (component.x - packageComponent.x) * inverseScaleX;
      const ny = (component.y - packageComponent.y) * inverseScaleY;
      const nw = width * inverseScaleX;
      const nh = height * inverseScaleY;
      const cx = nx + nw / 2;
      const cy = ny + nh / 2;
      return {
        kind: "ellipse",
        cx,
        cy,
        rx: nw / 2,
        ry: nh / 2,
        stroke: typeof component.properties.stroke === "string" ? component.properties.stroke : undefined,
        fill: typeof component.properties.fill === "string" ? component.properties.fill : undefined,
        transform: shapeRotationTransform(rotation, cx, cy),
      };
    }
    case "graphics.line": {
      const displayLength = typeof component.properties.length === "number" ? component.properties.length : 40;
      const box = packageLineBoxSide(displayLength);
      const centerX = (component.x + box / 2 - packageComponent.x) * inverseScaleX;
      const centerY = (component.y + box / 2 - packageComponent.y) * inverseScaleY;
      const halfLengthNative = (displayLength * inverseScaleX) / 2;
      return {
        kind: "line",
        x1: centerX - halfLengthNative,
        y1: centerY,
        x2: centerX + halfLengthNative,
        y2: centerY,
        stroke: typeof component.properties.stroke === "string" ? component.properties.stroke : undefined,
        transform: shapeRotationTransform(rotation, centerX, centerY),
      };
    }
    case "graphics.image": {
      const width = typeof component.properties.width === "number" ? component.properties.width : 0;
      const height = typeof component.properties.height === "number" ? component.properties.height : 0;
      const nx = (component.x - packageComponent.x) * inverseScaleX;
      const ny = (component.y - packageComponent.y) * inverseScaleY;
      const nw = width * inverseScaleX;
      const nh = height * inverseScaleY;
      const pivotX = nx + nw / 2;
      const pivotY = ny + nh / 2;
      const imageData = typeof component.properties.imageData === "string" ? component.properties.imageData : undefined;
      const imageMime = typeof component.properties.imageMime === "string" ? component.properties.imageMime : "image/png";
      return {
        kind: "image",
        x: nx,
        y: ny,
        w: nw,
        h: nh,
        href: imageData ? `data:${imageMime};base64,${imageData}` : undefined,
        preserveAspectRatio: "none",
        transform: shapeRotationTransform(rotation, pivotX, pivotY),
      };
    }
    case "graphics.text": {
      const text = typeof component.properties.text === "string" ? component.properties.text : "";
      const fontSize = typeof component.properties.fontSize === "number" ? component.properties.fontSize : 11;
      const box = labelBoxSize(text, fontSize);
      const cx = (component.x + box.width / 2 - packageComponent.x) * inverseScaleX;
      const cy = (component.y + box.height / 2 - packageComponent.y) * inverseScaleY;
      return {
        kind: "text",
        x: cx,
        y: cy,
        value: text,
        fontSize,
        textAnchor: "middle",
        dominantBaseline: "middle",
        color: typeof component.properties.color === "string" ? component.properties.color : undefined,
        transform: shapeRotationTransform(rotation, cx, cy),
      };
    }
    default:
      return undefined;
  }
}

/** Todo componente de autoria de Package/ícone/rótulo-de-pino presente na cena -- usado tanto por
 * `compilePackageAuthoringComponents` (pra separar do circuito interno real) quanto por quem monta
 * a cena inicial (`openSubcircuitForEditingCommand`, pra saber se uma sessão "tocou" em autoria).
 * `pinComponentIds` precisa ser o conjunto de ids de TODOS os `other.package_pin` presentes (não só
 * os válidos) -- um rótulo cujo pino-alvo já não existe mais também é meta (nunca vira anotação
 * "real" do circuito interno por acidente). */
export function isPackageAuthoringComponent(component: WebviewComponentModel, pinComponentIds: ReadonlySet<string>): boolean {
  if (component.typeId === PACKAGE_TYPE_ID || component.typeId === PACKAGE_PIN_TYPE_ID) return true;
  if (component.typeId === PACKAGE_ICON_TYPE_ID && component.packageIconRole === true) return true;
  if (component.packageShapeRole === true) return true;
  if (component.typeId === "graphics.text") {
    const linked = component.properties.linkedPinComponentId;
    if (typeof linked === "string" && linked && pinComponentIds.has(linked)) return true;
  }
  return false;
}

function pinComponentIdsOf(components: readonly WebviewComponentModel[]): Set<string> {
  return new Set(components.filter((c) => c.typeId === PACKAGE_PIN_TYPE_ID).map((c) => c.id));
}

/** Posição de cena reservada pro Package/pinos/ícone -- canto claramente afastado do circuito
 * interno (nunca sobreposto), mesmo princípio conceitual de `boardVisual` (coordenada derivada,
 * resolvida por "modo", nunca perdida no save-back). Determinística (sem `Math.random`) pra ficar
 * estável entre seed→compile→seed no mesmo teste. */
function reservedAuthoringOrigin(internalComponents: readonly WebviewComponentModel[]): { x: number; y: number } {
  if (internalComponents.length === 0) return { x: 400, y: 40 };
  const maxX = Math.max(...internalComponents.map((c) => c.x));
  return { x: maxX + 200, y: 40 };
}

export interface SeedPackageAuthoringResult {
  components: WebviewComponentModel[];
  warnings: string[];
}

/** Materializa `other.package` + `other.package_pin[]` (+ rótulos linkados) + a Figura/ícone
 * (`graphics.image` com `packageIconRole`) a partir de `manifest.package`/`manifest.interface` --
 * chamado por `openSubcircuitForEditingCommand` ANTES de empilhar a sessão, pra que os componentes
 * de autoria entrem tanto em `session.initialComponents` quanto em `state.schematicState.components`
 * pela MESMA referência (evita a sessão abrir "suja" por causa do seeding, ver riscos de regressão
 * do plano). Não sintetiza NADA quando `manifest.package` está ausente ou não sanitiza (arquivo
 * antigo sem Package nunca ganha um gratuitamente só por abrir a sessão). */
export function seedPackageAuthoringComponents(
  manifest: Record<string, unknown>,
  internalComponents: readonly WebviewComponentModel[],
  manifestDir: string,
  idFactory: () => string
): SeedPackageAuthoringResult {
  const warnings: string[] = [];
  const packageDescriptor = sanitizePackage(manifest.package, manifestDir);
  if (!packageDescriptor) return { components: [], warnings };

  const rawInterface = Array.isArray(manifest.interface) ? manifest.interface : [];
  const interfaceByPinId = new Map<string, SubcircuitInterfaceEntry>();
  for (const raw of rawInterface) {
    if (typeof raw !== "object" || raw === null) continue;
    const entry = raw as Record<string, unknown>;
    const pinId = typeof entry.pinId === "string" ? entry.pinId : "";
    if (!pinId) continue;
    interfaceByPinId.set(pinId, {
      pinId,
      label: typeof entry.label === "string" ? entry.label : pinId,
      internalTunnel: typeof entry.internalTunnel === "string" ? entry.internalTunnel : "",
      internalTunnelId: typeof entry.internalTunnelId === "string" ? entry.internalTunnelId : undefined,
    });
  }

  const tunnelsById = new Map<string, WebviewComponentModel>();
  const tunnelsByName = new Map<string, WebviewComponentModel>();
  for (const c of internalComponents) {
    if (c.typeId !== TUNNEL_TYPE_ID) continue;
    tunnelsById.set(c.id, c);
    const name = typeof c.properties.name === "string" ? c.properties.name : "";
    if (name && !tunnelsByName.has(name)) tunnelsByName.set(name, c);
  }

  const origin = reservedAuthoringOrigin(internalComponents);
  const components: WebviewComponentModel[] = [];

  // `width`/`height` de um `PackageDescriptor` são o espaço NATIVO (pixels da foto/placa, mesmo
  // espaço de `pins[].x/y` -- ex: 308x601 no ESP32 DevKitC), quase sempre BEM maior que o tamanho
  // exibido de verdade no esquemático (`schematicWidth`/`schematicHeight`, ex: 88x176 -- mesma
  // relação de `resolvePackageLayout`/`scaleX`/`scaleY`, `componentSymbols.ts:221-222`). Sem
  // converter aqui, o `other.package` seedado nasce do TAMANHO NATIVO (3-4x maior que o corpo
  // deveria aparecer), destoando brutalmente do resto da cena -- bug observado ao abrir o ESP32
  // DevKitC pra edição. `other.package`/`other.package_pin` NÃO têm conceito de "native vs
  // schematic" -- a cena de autoria vive inteira no espaço EXIBIDO (o que se vê é o que se edita),
  // então tudo (caixa do Package, posição/comprimento dos pinos) entra já escalado.
  const scaleX = typeof packageDescriptor.schematicWidth === "number" && packageDescriptor.schematicWidth > 0 && packageDescriptor.width > 0
    ? packageDescriptor.schematicWidth / packageDescriptor.width
    : 1;
  const scaleY = typeof packageDescriptor.schematicHeight === "number" && packageDescriptor.schematicHeight > 0 && packageDescriptor.height > 0
    ? packageDescriptor.schematicHeight / packageDescriptor.height
    : 1;
  const displayWidth = packageDescriptor.width * scaleX;
  const displayHeight = packageDescriptor.height * scaleY;

  const packageComponentId = idFactory();
  const packageComponent: WebviewComponentModel = {
    id: packageComponentId,
    typeId: PACKAGE_TYPE_ID,
    label: "Package",
    x: origin.x,
    y: origin.y,
    rotation: 0,
    pins: [],
    properties: {
      width: displayWidth,
      height: displayHeight,
      border: packageDescriptor.border ?? true,
      ...(packageDescriptor.background?.kind === "color" && packageDescriptor.background.value
        ? { backgroundColor: packageDescriptor.background.value }
        : {}),
    },
  };
  components.push(packageComponent);

  // Ícone/Figura -- só quando o background é imagem (cor sólida fica só em `properties.
  // backgroundColor` do Package, sem precisar de um objeto Figura pra isso). Trancada na mesma
  // posição/tamanho do Package (ver Estágio 3 do plano): o que é compilado é SEMPRE esticado pro
  // width×height do Package, então o que aparece na cena precisa bater com isso pra não enganar.
  if (packageDescriptor.background?.kind === "image" && packageDescriptor.background.data) {
    components.push({
      id: idFactory(),
      typeId: PACKAGE_ICON_TYPE_ID,
      label: "Ícone do Subcircuito",
      x: origin.x,
      y: origin.y,
      rotation: 0,
      pins: [],
      properties: {
        path: "",
        width: displayWidth,
        height: displayHeight,
        imageData: packageDescriptor.background.data,
        imageMime: packageDescriptor.background.mime ?? "image/png",
      },
      packageIconRole: true,
    });
  }

  for (const pin of packageDescriptor.pins) {
    const iface = interfaceByPinId.get(pin.id);
    let tunnelComponentId = "";
    if (iface?.internalTunnelId && tunnelsById.has(iface.internalTunnelId)) {
      tunnelComponentId = iface.internalTunnelId;
    } else if (iface?.internalTunnel) {
      const byName = tunnelsByName.get(iface.internalTunnel);
      if (byName) tunnelComponentId = byName.id;
      else warnings.push(`Pino "${pin.id}" referencia o túnel interno "${iface.internalTunnel}", que não foi encontrado no circuito.`);
    } else {
      warnings.push(`Pino "${pin.id}" não tem túnel interno associado.`);
    }

    const rawAngle = typeof pin.angle === "number" ? pin.angle : 0;
    const rawAngleNormalized = ((rawAngle % 360) + 360) % 360;
    // `PackagePin.angle` (espaço do ARQUIVO) e `WebviewComponentModel.rotation` (espaço da CENA) são
    // convenções DIFERENTES, não a mesma coisa com nome diferente: o lead real é
    // `rad=(180-angle)*PI/180` (`packagePinVisualEnd`, componentSymbols.ts), mas o desenho canônico
    // de `other.package_pin` aponta pra +X e é girado pelo wrapper CSS genérico (rotação padrão) --
    // pra bater visualmente, `rotation` precisa ser `(180-angle) mod 360`, NUNCA `angle` direto (bug
    // real, verificado numericamente: a identidade fazia todo pino de borda esquerda/direita, angle
    // 0/180, desenhar o lead 180° invertido -- ESP32 GND/3V3/EN, todos angle:180, apontavam pra fora
    // do corpo em vez de pra dentro). `fileCardinalAngle` (SEM a conversão) é o valor que
    // `defaultLabelNativePosition` precisa logo abaixo -- seu switch espelha `packagePinLeadSvg`, que
    // decide o lado do rótulo por `pin.angle` real, nunca pela rotação de cena.
    const convertedAngle = (180 - rawAngleNormalized + 360) % 360;
    const rotation = nearestCardinalRotation(convertedAngle);
    const fileCardinalAngle = nearestCardinalRotation(rawAngleNormalized);
    if (rawAngleNormalized % 90 !== 0) {
      // Reporta o ângulo derivado do `rotation` REALMENTE gravado (não de `fileCardinalAngle`
      // independente) -- nos 4 casos de empate exato (45/135/225/315°) o arredondamento de
      // `Math.round` em lados opostos da reflexão `180-x` pode divergir, e a mensagem precisa
      // sempre bater com o que foi de fato salvo.
      const adjustedFileAngle = (180 - rotation + 360) % 360;
      warnings.push(`Pino "${pin.id}" tinha ângulo não-cardeal (${rawAngle}°) e foi ajustado para ${adjustedFileAngle}°.`);
    }
    // Mesma conversão nativo->exibido do Package acima -- `pin.x/y` vêm no espaço NATIVO
    // (`packageDescriptor.width/height`), `length` idem (é o que `resolvePackageLayout` usa pra
    // calcular `tipX/tipY` ANTES de aplicar `scaleX/scaleY`, `componentSymbols.ts:234-235`). Usa
    // `scaleX` pro comprimento do lead (aproximação -- a maioria dos packages reais tem
    // `scaleX`≈`scaleY`; um lead de pino não precisa de precisão sub-pixel, só não pode nascer
    // gigante/absurdo em relação ao corpo já escalado), com um mínimo de 4px pra nunca desaparecer.
    const rawLength = typeof pin.length === "number" ? pin.length : 8;
    const length = Math.max(4, rawLength * scaleX);
    const localX = (typeof pin.x === "number" ? pin.x : 0) * scaleX;
    const localY = (typeof pin.y === "number" ? pin.y : 0) * scaleY;
    const box = packagePinBoxSide(length);
    const anchorX = origin.x + localX;
    const anchorY = origin.y + localY;

    const pinComponentId = idFactory();
    components.push({
      id: pinComponentId,
      typeId: PACKAGE_PIN_TYPE_ID,
      label: pin.label ?? pin.id,
      x: anchorX - box / 2,
      y: anchorY - box / 2,
      rotation,
      pins: [],
      properties: {
        pinId: pin.id,
        length,
        ...(tunnelComponentId ? { tunnelComponentId } : {}),
      },
    });

    const labelText = pin.label ?? pin.id;
    const fontSize = typeof pin.labelFontSize === "number" ? pin.labelFontSize : DEFAULT_PACKAGE_PIN_LABEL_FONT_SIZE;
    // `pin.labelColor` (ausente == cor padrão do editor, `#1f2937`) -- bug real corrigido aqui: o
    // seed sempre gravava a cor padrão HARDCODED, nunca a cor de fato salva no arquivo, então uma
    // cor de rótulo customizada pelo usuário revertia pra cinza-escuro toda vez que a sessão de
    // autoria era reaberta (mesma classe de bug já corrigida uma vez pra `labelRotation`).
    const labelColor = typeof pin.labelColor === "string" ? pin.labelColor : DEFAULT_PACKAGE_PIN_LABEL_COLOR;
    // `pin.labelX`/`labelY` (espaço NATIVO, ver model.ts) ganham de qualquer fórmula padrão -- uma
    // vez que o arquivo tem posição explícita de rótulo, ela é a fonte de verdade (nunca recalculada
    // aqui). Só cai no `defaultLabelNativePosition` (mesma fórmula de `packagePinLeadSvg`) quando o
    // pino NUNCA foi editado por este editor -- garante que o preview do editor bate com o que o
    // esquemático já renderiza por padrão, mesmo antes de qualquer arraste do usuário.
    const hasCustomLabelPos = typeof pin.labelX === "number" && typeof pin.labelY === "number";
    const nativeAnchorX = typeof pin.x === "number" ? pin.x : 0;
    const nativeAnchorY = typeof pin.y === "number" ? pin.y : 0;
    const labelSpaceNative = typeof pin.labelSpace === "number" ? pin.labelSpace : undefined;
    const nativeLabel = hasCustomLabelPos
      ? { x: pin.labelX as number, y: pin.labelY as number, rotation: 0 as 0 | 90 | 270 }
      : defaultLabelNativePosition(nativeAnchorX, nativeAnchorY, fileCardinalAngle, rawLength, labelSpaceNative, fontSize);
    const labelAnchorX = origin.x + nativeLabel.x * scaleX;
    const labelAnchorY = origin.y + nativeLabel.y * scaleY;
    const labelBox = labelBoxSize(labelText, fontSize);
    components.push({
      id: idFactory(),
      typeId: "graphics.text",
      label: "graphics.text",
      x: Math.round(labelAnchorX - labelBox.width / 2),
      y: Math.round(labelAnchorY - labelBox.height / 2),
      rotation: hasCustomLabelPos ? nearestCardinalRotation(typeof pin.labelRotation === "number" ? pin.labelRotation : 0) : nativeLabel.rotation,
      pins: [],
      properties: { text: labelText, fontSize, color: labelColor, linkedPinComponentId: pinComponentId },
    });
  }

  // Elementos decorativos extras (linha/figura/texto/retângulo/elipse) marcados com
  // `packageShapeRole` -- `package.shapes[]` array order vira `__packageShapeOrder` (0,1,2...),
  // único sinal de z-order que sobrevive (`PackageShape` não tem `id`/`zIndex`). Kinds sem
  // contraparte de cena (`polygon`/`path`/`svg`) não são seedados (ver `materializePackageShape`).
  const rawShapes = Array.isArray(packageDescriptor.shapes) ? packageDescriptor.shapes : [];
  rawShapes.forEach((shape, index) => {
    const shapeComponent = materializePackageShape(shape, index, scaleX, scaleY, origin, idFactory);
    if (shapeComponent) components.push(shapeComponent);
  });

  return { components, warnings };
}

/** `width`/`height`/`schematicWidth`/`schematicHeight` do `package` ORIGINAL do manifesto (antes de
 * qualquer edição desta sessão) -- o suficiente pra `compilePackageAuthoringComponents` saber se
 * existe uma distinção nativo/esquemático (foto capturada em pixel nativo, ex: ESP32 DevKitC/WROOM)
 * a preservar no save. */
export interface PackageNativeScale {
  width: number;
  height: number;
  schematicWidth?: number;
  schematicHeight?: number;
}

/** Extrai `PackageNativeScale` de `manifest.package` -- não usa `sanitizePackage` (que resolve
 * `background`/`pins` também), só os 4 campos numéricos importam aqui. Chamado com
 * `session.originalManifest` ANTES do seed, pra que o valor reflita o arquivo em disco, nunca a
 * cena já editada. */
export function extractPackageNativeScale(manifest: Record<string, unknown>): PackageNativeScale | undefined {
  const raw = manifest.package;
  if (typeof raw !== "object" || raw === null) return undefined;
  const pkg = raw as Record<string, unknown>;
  const width = typeof pkg.width === "number" ? pkg.width : undefined;
  const height = typeof pkg.height === "number" ? pkg.height : undefined;
  if (width === undefined || height === undefined) return undefined;
  return {
    width,
    height,
    schematicWidth: typeof pkg.schematicWidth === "number" ? pkg.schematicWidth : undefined,
    schematicHeight: typeof pkg.schematicHeight === "number" ? pkg.schematicHeight : undefined,
  };
}

export interface PackageAuthoringCompileResult {
  /** Componentes REAIS (não-autoria) que vão pra `components[]` do manifesto -- mesma lista de
   * entrada, filtrada. */
  remainingComponents: WebviewComponentModel[];
  /** `false` == a cena não tinha NENHUM componente de autoria de Package (nem seedado, nem criado
   * pelo usuário) -- `package`/`interface[]` do manifesto original devem ficar 100% intocados. */
  touchedPackageAuthoring: boolean;
  /** Só significativo quando `touchedPackageAuthoring === true`. `false` == sessão removeu
   * deliberadamente o Package (existiam 0 `other.package` na cena) -- apagar `package`/`interface`
   * do manifesto. */
  hasPackage: boolean;
  package?: PackageDescriptor;
  interfaceEntries?: SubcircuitInterfaceEntry[];
  /** Bloqueante -- salvar deve ser abortado (mantém sessão "suja") quando não-vazio. Espelha as
   * regras que o Core (`CoreApplication.cpp`) rejeitaria de qualquer forma (pinId duplicado,
   * package.pins fora da interface) mais checagens extras só desta feature (Package/ícone
   * duplicado, vínculo de túnel duplicado). */
  errors: string[];
  /** Não-bloqueante -- pino sem túnel (excluído do compilado), ângulo não-cardeal ajustado, etc. */
  warnings: string[];
}

/** Compila os componentes de autoria presentes em `components` (cena completa da sessão) de volta
 * pra `package`/`interface[]` -- chamado por `writeSubcircuitEditingSessionBack` ANTES de
 * `fs.writeFileSync` (nunca depois: um resultado inválido não pode chegar a tocar o disco, ver
 * riscos de regressão do plano). Nunca lança exceção -- condições fatais viram `errors[]`. */
export function compilePackageAuthoringComponents(
  components: readonly WebviewComponentModel[],
  originalScale?: PackageNativeScale
): PackageAuthoringCompileResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const pinComponentIds = pinComponentIdsOf(components);
  const packageComps = components.filter((c) => c.typeId === PACKAGE_TYPE_ID);
  const pinComps = components.filter((c) => c.typeId === PACKAGE_PIN_TYPE_ID);
  const iconComps = components.filter((c) => c.typeId === PACKAGE_ICON_TYPE_ID && c.packageIconRole === true);
  const shapeComps = components.filter((c) => c.packageShapeRole === true && isPackageShapeEligibleTypeId(c.typeId));
  const remainingComponents = components.filter((c) => !isPackageAuthoringComponent(c, pinComponentIds));

  const touchedPackageAuthoring = packageComps.length > 0 || pinComps.length > 0 || iconComps.length > 0 || shapeComps.length > 0;
  if (!touchedPackageAuthoring) {
    return { remainingComponents, touchedPackageAuthoring: false, hasPackage: false, errors, warnings };
  }

  if (packageComps.length > 1) {
    errors.push(`Mais de um objeto Package encontrado na cena (${packageComps.length}) -- deve haver no máximo um.`);
  }
  if (iconComps.length > 1) {
    errors.push(`Mais de uma Figura marcada como ícone do subcircuito encontrada (${iconComps.length}) -- deve haver no máximo uma.`);
  }
  if (packageComps.length === 0 && pinComps.length > 0) {
    errors.push(`${pinComps.length} pino(s) de Package encontrado(s) sem nenhum objeto Package na cena.`);
  }
  if (packageComps.length === 0 && shapeComps.length > 0) {
    errors.push(`${shapeComps.length} elemento(s) do Package encontrado(s) sem nenhum objeto Package na cena.`);
  }
  if (errors.length > 0) {
    return { remainingComponents, touchedPackageAuthoring, hasPackage: packageComps.length > 0, errors, warnings };
  }

  if (packageComps.length === 0) {
    if (iconComps.length > 0) warnings.push("Ícone definido sem nenhum Package associado -- ignorado.");
    return { remainingComponents, touchedPackageAuthoring, hasPackage: false, errors, warnings };
  }

  const packageComponent = packageComps[0];
  if (!packageComponent) {
    return { remainingComponents, touchedPackageAuthoring, hasPackage: false, errors, warnings };
  }
  const tunnelsById = new Map(components.filter((c) => c.typeId === TUNNEL_TYPE_ID).map((c) => [c.id, c]));
  // Guarda o componente `graphics.text` INTEIRO (não só o texto) -- a posição/rotação/fontSize
  // arrastados pelo usuário no editor precisam sobreviver ao compile, ver `labelBoxSize` abaixo.
  // Antes desta mudança, só o texto era lido de volta: qualquer reposicionamento de rótulo feito no
  // editor era descartado silenciosamente a cada save (bug real, motivo de este bloco existir).
  const labelByPinComponentId = new Map<string, WebviewComponentModel>();
  for (const c of components) {
    if (c.typeId !== "graphics.text") continue;
    const linked = c.properties.linkedPinComponentId;
    if (typeof linked === "string" && linked) {
      const text = typeof c.properties.text === "string" ? c.properties.text : undefined;
      if (text) labelByPinComponentId.set(linked, c);
    }
  }

  // `packageComponent.properties.width/height` é o tamanho EXIBIDO na cena de autoria (espaço
  // esquemático, ver `seedPackageAuthoringComponents`) -- quando o `package` original tinha
  // `schematicWidth`/`schematicHeight` distintos de `width`/`height` (foto capturada em pixel
  // nativo, ex: ESP32 DevKitC/WROOM), reprojeta de volta pro espaço NATIVO da foto antes de
  // gravar, senão `width`/`height`/pinos ficam presos na resolução de exibição e
  // `schematicWidth`/`schematicHeight` somem do arquivo pra sempre (bug real: ESP32-WROOM perdia
  // a distinção nativo/esquemático no primeiro save via "Abrir Subcircuito", mesmo sem nenhuma
  // edição deliberada de posição). Ausente `originalScale` (package novo, criado nesta sessão, ou
  // package sem foto) preserva o comportamento antigo: escala 1:1, sem `schematicWidth`/Height.
  const displayWidth = typeof packageComponent.properties.width === "number" ? packageComponent.properties.width : 56;
  const displayHeight = typeof packageComponent.properties.height === "number" ? packageComponent.properties.height : 40;
  const border = packageComponent.properties.border !== false;

  const hasNativeScale = originalScale !== undefined
    && typeof originalScale.schematicWidth === "number" && originalScale.schematicWidth > 0
    && typeof originalScale.schematicHeight === "number" && originalScale.schematicHeight > 0
    && originalScale.width > 0 && originalScale.height > 0;
  const width = hasNativeScale ? originalScale!.width : displayWidth;
  const height = hasNativeScale ? originalScale!.height : displayHeight;
  // Inverso EXATO de `scaleX`/`scaleY` em `seedPackageAuthoringComponents` -- lá,
  // `displayValue = nativeValue * scaleX` (`scaleX = schematicWidth/width`); aqui,
  // `nativeValue = displayValue * inverseScaleX` (`inverseScaleX = width/schematicWidth atual`,
  // usa o `displayWidth` ATUAL pra respeitar um redimensionamento do Package feito nesta sessão).
  const inverseScaleX = hasNativeScale ? width / displayWidth : 1;
  const inverseScaleY = hasNativeScale ? height / displayHeight : 1;

  const seenPinIds = new Set<string>();
  const pins: PackagePin[] = [];
  const interfaceEntries: SubcircuitInterfaceEntry[] = [];

  for (const pinComp of pinComps) {
    const pinId = typeof pinComp.properties.pinId === "string" ? pinComp.properties.pinId.trim() : "";
    if (!pinId) {
      warnings.push(`Pino "${pinComp.label}" sem identificador (pinId) -- ignorado.`);
      continue;
    }
    if (seenPinIds.has(pinId)) {
      errors.push(`Identificador de pino duplicado: "${pinId}".`);
      continue;
    }

    const tunnelComponentId = typeof pinComp.properties.tunnelComponentId === "string" ? pinComp.properties.tunnelComponentId : "";
    const tunnel = tunnelComponentId ? tunnelsById.get(tunnelComponentId) : undefined;
    if (!tunnel) {
      warnings.push(`Pino "${pinId}" sem túnel interno associado -- não será exposto no circuito principal.`);
      seenPinIds.add(pinId);
      continue;
    }
    // Vários pinos DIFERENTES (pinId distintos) apontando pro MESMO túnel interno é válido --
    // padrão comum em hardware real (ex: GND1/GND2/GND3 do ESP32 DevKitC, 3 pinos físicos na
    // placa, todos na mesma malha de terra). O Core (`CoreApplication.cpp`) só rejeita `pinId`
    // duplicado (já checado acima) -- NUNCA duplicidade de `internalTunnel` entre entradas
    // diferentes de `interface[]`. Bug real encontrado em produção: uma versão anterior bloqueava
    // isso como erro, impedindo salvar um arquivo já válido (3 pinos de GND legítimos).
    seenPinIds.add(pinId);

    // `length` (lead do pino) trafega em espaço EXIBIDO na cena (mesmo espaço de `pinComp.x/y`,
    // ver `seedPackageAuthoringComponents`) -- `box`/`anchorX/Y` usam o valor EXIBIDO (posição real
    // do componente na cena); só o valor GRAVADO no arquivo (`pinEntry.length` abaixo) volta pro
    // espaço nativo via `inverseScaleX`.
    const displayLength = typeof pinComp.properties.length === "number" ? pinComp.properties.length : 8;
    const box = packagePinBoxSide(displayLength);
    const anchorX = pinComp.x + box / 2;
    const anchorY = pinComp.y + box / 2;
    const labelComponent = labelByPinComponentId.get(pinComp.id);
    const label = (typeof labelComponent?.properties.text === "string" ? labelComponent.properties.text : undefined) ?? pinId;
    const tunnelName = typeof tunnel.properties.name === "string" ? tunnel.properties.name : "";
    if (!tunnelName) {
      warnings.push(`Túnel interno vinculado ao pino "${pinId}" não tem nome -- não será exposto no circuito principal.`);
      continue;
    }

    const pinEntry: PackagePin = {
      id: pinId,
      x: (anchorX - packageComponent.x) * inverseScaleX,
      y: (anchorY - packageComponent.y) * inverseScaleY,
      // Inverso EXATO da conversão em seedPackageAuthoringComponents (`rotation=(180-angle)%360`) --
      // `pinComp.rotation` já é garantidamente cardeal (`WebviewComponentModel.rotation: 0|90|180|270`),
      // então não precisa de `nearestCardinalRotation` aqui, só a mesma reflexão.
      angle: (180 - pinComp.rotation + 360) % 360,
      length: Math.max(1, displayLength * inverseScaleX),
      label,
    };
    // Posição do rótulo é SEMPRE persistida a partir de onde o `graphics.text` linkado está
    // AGORA na cena (arrastado ou não) -- vira a fonte de verdade pro esquemático a partir deste
    // save, igual ao `x`/`y` do próprio pino. Mesma fórmula de caixa (`labelBoxSize`) usada pra
    // seedar a posição inicial, ver `seedPackageAuthoringComponents`. `labelFontSize` NUNCA escala
    // (mesmo motivo documentado em `componentSymbols.ts::packagePinElectricalPoint` -- fonte/traço
    // são constantes fixas no SimulIDE real, só posição comprime com `scaleX`/`scaleY`).
    if (labelComponent) {
      const labelFontSize = typeof labelComponent.properties.fontSize === "number" ? labelComponent.properties.fontSize : DEFAULT_PACKAGE_PIN_LABEL_FONT_SIZE;
      const labelBox = labelBoxSize(label, labelFontSize);
      const displayLabelX = labelComponent.x + labelBox.width / 2 - packageComponent.x;
      const displayLabelY = labelComponent.y + labelBox.height / 2 - packageComponent.y;
      pinEntry.labelX = displayLabelX * inverseScaleX;
      pinEntry.labelY = displayLabelY * inverseScaleY;
      pinEntry.labelFontSize = labelFontSize;
      pinEntry.labelTextAnchor = "middle";
      pinEntry.labelDominantBaseline = "middle";
      if (labelComponent.rotation) pinEntry.labelRotation = labelComponent.rotation;
      // Bug real corrigido aqui: a cor do rótulo (editável via "Propriedades" no `graphics.text`
      // linkado) nunca era lida de volta -- sobrevivia na cena, mas sumia (voltava pra cor padrão)
      // a cada save, já que nada aqui gravava `pinEntry.labelColor`.
      if (typeof labelComponent.properties.color === "string" && labelComponent.properties.color !== DEFAULT_PACKAGE_PIN_LABEL_COLOR) {
        pinEntry.labelColor = labelComponent.properties.color;
      }
    }
    pins.push(pinEntry);
    interfaceEntries.push({ pinId, label, internalTunnel: tunnelName, internalTunnelId: tunnel.id });
  }

  if (errors.length > 0) {
    return { remainingComponents, touchedPackageAuthoring, hasPackage: true, errors, warnings };
  }
  if (pins.length === 0) {
    warnings.push("Package sem nenhum pino válido -- não será exibido corretamente até ter ao menos um pino com túnel associado.");
  }

  const icon = iconComps[0];
  const background: PackageDescriptor["background"] = icon
    ? {
        kind: "image",
        data: typeof icon.properties.imageData === "string" ? icon.properties.imageData : undefined,
        mime: typeof icon.properties.imageMime === "string" ? icon.properties.imageMime : "image/png",
      }
    : typeof packageComponent.properties.backgroundColor === "string" && packageComponent.properties.backgroundColor
      ? { kind: "color", value: packageComponent.properties.backgroundColor }
      : undefined;

  // Elementos decorativos extras, na MESMA ordem de pintura escolhida pelo usuário ("Trazer pra
  // frente"/"Enviar pra trás", `main.ts`) -- `__packageShapeOrder` é o único sinal de z-order que
  // sobrevive (`PackageShape` não tem `id`/`zIndex`). Componentes sem essa propriedade (nunca
  // deveria acontecer pra algo seedado por esta feature, mas não trava o save) vão pro fim, na
  // ordem em que aparecem em `components`.
  const shapes = [...shapeComps]
    .sort((a, b) => {
      const orderA = typeof a.properties[PACKAGE_SHAPE_ORDER_PROPERTY_KEY] === "number" ? (a.properties[PACKAGE_SHAPE_ORDER_PROPERTY_KEY] as number) : Number.MAX_SAFE_INTEGER;
      const orderB = typeof b.properties[PACKAGE_SHAPE_ORDER_PROPERTY_KEY] === "number" ? (b.properties[PACKAGE_SHAPE_ORDER_PROPERTY_KEY] as number) : Number.MAX_SAFE_INTEGER;
      return orderA - orderB;
    })
    .map((shapeComp) => derivePackageShape(shapeComp, inverseScaleX, inverseScaleY, packageComponent))
    .filter((shape): shape is PackageShape => shape !== undefined);

  const packageDescriptor: PackageDescriptor = {
    width,
    height,
    ...(hasNativeScale ? { schematicWidth: displayWidth, schematicHeight: displayHeight } : {}),
    border,
    ...(background ? { background } : {}),
    ...(shapes.length > 0 ? { shapes } : {}),
    pins,
  };

  return {
    remainingComponents,
    touchedPackageAuthoring,
    hasPackage: true,
    package: packageDescriptor,
    interfaceEntries,
    errors,
    warnings,
  };
}
