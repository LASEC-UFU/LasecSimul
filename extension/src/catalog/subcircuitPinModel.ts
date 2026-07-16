import { PackagePin, TUNNEL_TYPE_ID } from "../ui/webview/model";
import { ProjectComponent } from "../project/ProjectTypes";
import { SubcircuitDocument, SubcircuitInterfaceEntry } from "./subcircuitDocument";

/** Domínio puro (sem `vscode`/DOM) do ciclo de vida pino-externo↔túnel-interno -- substitui a antiga
 * ligação por `tunnelComponentId`/`internalTunnelId` (`subcircuitPackageAuthoring.ts`, removido) por
 * uma regra única e mais simples: A IDENTIDADE ELÉTRICA do túnel (`properties.name`, o que o Core
 * de fato entende, `Netlist::m_tunnelGroups`) É o `pinId` do pino que ele serve -- nunca hand-editado
 * independentemente uma vez ligado. Múltiplos túneis com o mesmo `pinId` (logo, mesmo `name`) já são
 * unificados numa única rede pelo próprio Core (união por nome), então "N túneis pra 1 pino" nunca
 * exige nenhuma mudança no Core -- é uma consequência direta desta regra.
 *
 * Toda operação aqui é PURA (recebe um `SubcircuitDocument`, devolve um novo) e TRANSACIONAL -- nunca
 * existe um estado intermediário onde um pino não tem túnel, ou um túnel aponta pra um pino
 * inexistente; cada função aplica a mudança inteira de uma vez. */

function tunnelPinId(component: ProjectComponent): string | undefined {
  const value = component.properties.pinId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isTunnelForPin(component: ProjectComponent, pinId: string): boolean {
  return component.typeId === TUNNEL_TYPE_ID && tunnelPinId(component) === pinId;
}

function makeTunnelComponent(id: string, pinId: string, x: number, y: number): ProjectComponent {
  return { id, typeId: TUNNEL_TYPE_ID, properties: { name: pinId, pinId }, visual: { x, y, rotation: 0 } };
}

function emptySymbol(): NonNullable<SubcircuitDocument["symbol"]> {
  return { width: 56, height: 40, border: true, pins: [] };
}

export interface CreatePinAttrs {
  label: string;
  x: number;
  y: number;
  angle: 0 | 90 | 180 | 270;
  length?: number;
  kind?: string;
  /** Posição do túnel interno auto-criado (Modo Subcircuito) -- coordenada de conveniência inicial,
   * o usuário pode arrastar depois como qualquer componente normal. */
  tunnelX?: number;
  tunnelY?: number;
}

export interface CreatePinResult {
  document: SubcircuitDocument;
  pinId: string;
  tunnelComponentId: string;
}

/** Cria um pino externo NO SÍMBOLO + seu túnel interno OBRIGATÓRIO, atomicamente -- nunca existe um
 * estado intermediário onde o pino existe sem nenhum túnel. `idFactory` gera ids ESTÁVEIS, nunca
 * derivados de posição/índice (mesmo princípio de `nextId`/`nextIndexedLabel` já usado no resto da
 * base). */
export function createPin(document: SubcircuitDocument, attrs: CreatePinAttrs, idFactory: () => string): CreatePinResult {
  const pinId = idFactory();
  const tunnelComponentId = idFactory();
  const pin: PackagePin = {
    id: pinId,
    label: attrs.label,
    x: attrs.x,
    y: attrs.y,
    angle: attrs.angle,
    length: attrs.length ?? 8,
    ...(attrs.kind ? { kind: attrs.kind } : {}),
  };
  const symbol = document.symbol ?? emptySymbol();
  const tunnelComponent = makeTunnelComponent(tunnelComponentId, pinId, attrs.tunnelX ?? 0, attrs.tunnelY ?? 0);
  return {
    document: {
      ...document,
      symbol: { ...symbol, pins: [...symbol.pins, pin] },
      components: [...document.components, tunnelComponent],
    },
    pinId,
    tunnelComponentId,
  };
}

/** Duplica um pino existente -- SEMPRE um `pinId` NOVO + túnel OBRIGATÓRIO novo, nunca reaproveita o
 * `pinId`/túnel(is) do original (regra explícita de copiar/colar no Modo Símbolo). Copia posição/
 * ângulo/rótulo do original como ponto de partida (usuário ajusta depois); `offsetX/offsetY`
 * deslocam a posição inicial pra não nascer exatamente sobre o original (mesmo espírito de
 * `pasteClipboardItems`, `main.ts`). */
export function duplicatePin(document: SubcircuitDocument, sourcePinId: string, idFactory: () => string, offsetX = 12, offsetY = 12): CreatePinResult | { error: string } {
  const source = document.symbol?.pins.find((pin) => pin.id === sourcePinId);
  if (!source || typeof source.x !== "number" || typeof source.y !== "number" || typeof source.angle !== "number") {
    return { error: `Pino "${sourcePinId}" não encontrado.` };
  }
  const angle = (((source.angle % 360) + 360) % 360) as 0 | 90 | 180 | 270;
  return createPin(
    document,
    {
      label: source.label ?? sourcePinId,
      x: source.x + offsetX,
      y: source.y + offsetY,
      angle,
      length: typeof source.length === "number" ? source.length : undefined,
      kind: source.kind,
    },
    idFactory
  );
}

/** Cria um túnel ADICIONAL pra um pino JÁ EXISTENTE -- ação explícita, distinta da criação do pino
 * em si. Mesmo `pinId`/`name` do pino (identidade elétrica compartilhada, união automática pelo
 * Core). */
export function createAdditionalTunnelForPin(document: SubcircuitDocument, pinId: string, idFactory: () => string, x = 0, y = 0): SubcircuitDocument | { error: string } {
  const pinExists = document.symbol?.pins.some((pin) => pin.id === pinId) ?? false;
  if (!pinExists) return { error: `Pino "${pinId}" não existe no Símbolo.` };
  const tunnelComponentId = idFactory();
  return { ...document, components: [...document.components, makeTunnelComponent(tunnelComponentId, pinId, x, y)] };
}

export type DeleteTunnelResult = { document: SubcircuitDocument } | { blocked: string };

/** Remove UM túnel -- bloqueia (nunca lança) quando é a ÚNICA ligação interna do pino que serve,
 * com mensagem ACIONÁVEL (regra obrigatória do pedido original). Remover um túnel SEM `pinId` (um
 * túnel comum, não ligado a nenhum pino externo) nunca é bloqueado -- essa regra só protege pinos
 * externos, não túneis internos genéricos. */
export function deleteTunnel(document: SubcircuitDocument, tunnelComponentId: string): DeleteTunnelResult {
  const tunnel = document.components.find((component) => component.id === tunnelComponentId && component.typeId === TUNNEL_TYPE_ID);
  if (!tunnel) return { document };
  const pinId = tunnelPinId(tunnel);
  if (pinId) {
    const siblingCount = document.components.filter((component) => component.id !== tunnelComponentId && isTunnelForPin(component, pinId)).length;
    if (siblingCount === 0) {
      return {
        blocked: `Este túnel é a única ligação interna do pino "${pinId}". Para removê-lo, exclua o pino no modo Símbolo ou crie outro túnel associado antes.`,
      };
    }
  }
  return { document: { ...document, components: document.components.filter((component) => component.id !== tunnelComponentId) } };
}

/** Exclui um pino do Símbolo -- cascata ATÔMICA: remove o pino de `symbol.pins[]` E todo túnel
 * ligado a ele (`properties.pinId === pinId`), quaisquer sejam quantos. Rótulo/posição/cor do pino
 * já vivem NO PRÓPRIO `PackagePin` (`model.ts`) nesta nova arquitetura -- não existe mais um
 * `graphics.text` linkado separado (como no antigo `other.package_pin`) que precisasse de limpeza à
 * parte; excluir o pino já remove tudo que pertencia só a ele, nenhuma referência órfã sobra. */
export function deletePin(document: SubcircuitDocument, pinId: string): SubcircuitDocument {
  const symbol = document.symbol ? { ...document.symbol, pins: document.symbol.pins.filter((pin) => pin.id !== pinId) } : document.symbol;
  const components = document.components.filter((component) => !isTunnelForPin(component, pinId));
  return { ...document, symbol, components };
}

/** Força `properties.name === properties.pinId` em TODO túnel ligado a um pino -- a ÚNICA fonte de
 * verdade da identidade elétrica de um pino é seu `pinId`; o nome do túnel NUNCA é editável
 * independentemente uma vez ligado (rodar isto sempre antes de derivar `interface[]`/salvar
 * neutraliza qualquer edição manual acidental do nome via painel de Propriedades). Túneis SEM
 * `pinId` (túneis internos comuns, não ligados a nenhum pino externo) são preservados intocados. */
export function renameCanonicalTunnelNames(document: SubcircuitDocument): SubcircuitDocument {
  let changed = false;
  const components = document.components.map((component) => {
    if (component.typeId !== TUNNEL_TYPE_ID) return component;
    const pinId = tunnelPinId(component);
    if (!pinId || component.properties.name === pinId) return component;
    changed = true;
    return { ...component, properties: { ...component.properties, name: pinId } };
  });
  return changed ? { ...document, components } : document;
}

/** Re-deriva `interface[]` INTEIRO a partir de `symbol.pins[]` -- nunca hand-authored, nunca
 * parcialmente corrigido (requisito obrigatório do pedido original). Como o nome canônico do túnel
 * de um pino É o próprio `pinId` (ver `renameCanonicalTunnelNames`), `internalTunnel` é sempre
 * `pin.id` -- não precisa procurar nenhum componente-túnel pra derivar isto. */
export function deriveInterfaceEntries(document: SubcircuitDocument): SubcircuitInterfaceEntry[] {
  const pins = document.symbol?.pins ?? [];
  return pins.map((pin) => ({ pinId: pin.id, label: pin.label ?? pin.id, internalTunnel: pin.id }));
}

/** Ponto único chamado ANTES de todo save -- aplica `renameCanonicalTunnelNames` e re-deriva
 * `interface[]`, nessa ordem. Idempotente (rodar 2x produz o mesmo resultado). */
export function finalizeSubcircuitDocumentForSave(document: SubcircuitDocument): SubcircuitDocument {
  const renamed = renameCanonicalTunnelNames(document);
  return { ...renamed, interface: deriveInterfaceEntries(renamed) };
}
