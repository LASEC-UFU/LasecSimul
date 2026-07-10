import { PackageDescriptor, PackagePin, TUNNEL_TYPE_ID, WebviewComponentModel } from "../ui/webview/model";
import { sanitizePackage } from "./packageSanitizers";

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

/** Caixa de `graphics.text`, mesma fórmula de `propertyDrivenBox` -- usada só pra centralizar o
 * rótulo seedado do pino na posição inicial (o usuário pode arrastar depois). */
function labelBoxSize(text: string, fontSize: number): { width: number; height: number } {
  return { width: Math.max(24, text.length * fontSize * 0.62 + 12), height: fontSize + 14 };
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
    const rotation = nearestCardinalRotation(rawAngle);
    if (((rawAngle % 360) + 360) % 360 !== rotation) {
      warnings.push(`Pino "${pin.id}" tinha ângulo não-cardeal (${rawAngle}°) e foi ajustado para ${rotation}°.`);
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
    const fontSize = 7;
    const rad = (rotation * Math.PI) / 180;
    const labelAnchorX = anchorX + Math.cos(rad) * (length + 9);
    const labelAnchorY = anchorY + Math.sin(rad) * (length + 9);
    const labelBox = labelBoxSize(labelText, fontSize);
    components.push({
      id: idFactory(),
      typeId: "graphics.text",
      label: "graphics.text",
      x: Math.round(labelAnchorX - labelBox.width / 2),
      y: Math.round(labelAnchorY - labelBox.height / 2),
      rotation: 0,
      pins: [],
      properties: { text: labelText, fontSize, color: "#1f2937", linkedPinComponentId: pinComponentId },
    });
  }

  return { components, warnings };
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
export function compilePackageAuthoringComponents(components: readonly WebviewComponentModel[]): PackageAuthoringCompileResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  const pinComponentIds = pinComponentIdsOf(components);
  const packageComps = components.filter((c) => c.typeId === PACKAGE_TYPE_ID);
  const pinComps = components.filter((c) => c.typeId === PACKAGE_PIN_TYPE_ID);
  const iconComps = components.filter((c) => c.typeId === PACKAGE_ICON_TYPE_ID && c.packageIconRole === true);
  const remainingComponents = components.filter((c) => !isPackageAuthoringComponent(c, pinComponentIds));

  const touchedPackageAuthoring = packageComps.length > 0 || pinComps.length > 0 || iconComps.length > 0;
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
  const labelByPinComponentId = new Map<string, string>();
  for (const c of components) {
    if (c.typeId !== "graphics.text") continue;
    const linked = c.properties.linkedPinComponentId;
    if (typeof linked === "string" && linked) {
      const text = typeof c.properties.text === "string" ? c.properties.text : undefined;
      if (text) labelByPinComponentId.set(linked, text);
    }
  }

  const width = typeof packageComponent.properties.width === "number" ? packageComponent.properties.width : 56;
  const height = typeof packageComponent.properties.height === "number" ? packageComponent.properties.height : 40;
  const border = packageComponent.properties.border !== false;

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

    const length = typeof pinComp.properties.length === "number" ? pinComp.properties.length : 8;
    const box = packagePinBoxSide(length);
    const anchorX = pinComp.x + box / 2;
    const anchorY = pinComp.y + box / 2;
    const label = labelByPinComponentId.get(pinComp.id) ?? pinId;
    const tunnelName = typeof tunnel.properties.name === "string" ? tunnel.properties.name : "";
    if (!tunnelName) {
      warnings.push(`Túnel interno vinculado ao pino "${pinId}" não tem nome -- não será exposto no circuito principal.`);
      continue;
    }

    pins.push({
      id: pinId,
      x: anchorX - packageComponent.x,
      y: anchorY - packageComponent.y,
      angle: pinComp.rotation,
      length,
      label,
    });
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

  const packageDescriptor: PackageDescriptor = {
    width,
    height,
    border,
    ...(background ? { background } : {}),
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
