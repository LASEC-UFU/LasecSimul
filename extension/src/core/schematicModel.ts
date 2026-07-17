import { SYMBOL_PIN_TYPE_ID, TUNNEL_TYPE_ID, WebviewComponentModel, WebviewProjectState } from "../ui/webview/model";

/** Modelo canônico de domínio pros elementos de `WebviewProjectState` -- ÚNICA porta operacional
 * usada pelos handlers IPC (`extension.ts`) pra ler/mutar um elemento por id, qualquer que seja seu
 * escopo (circuito interno, Símbolo, Ícone). Nenhum handler deve indexar `state.schematicState.
 * components`/`symbolElements`/`iconElements` diretamente -- sempre por aqui.
 *
 * Os 3 arrays continuam existindo (armazenamento real, serialização/compatibilidade com o resto do
 * sistema -- `main.ts`/`subcircuitSymbolScene.ts`/`projectCommands.ts` seguem lendo-os pelo nome),
 * mas deixam de ser a INTERFACE operacional: todo lookup/mutação por id passa pelas funções abaixo,
 * que decidem sozinhas em qual array procurar. O índice (id -> escopo) é recomputado a cada chamada
 * a partir do estado ATUAL (nunca cacheado/mantido incrementalmente) -- mais simples que um cache
 * com invalidação, e sempre correto por construção (nunca pode ficar dessincronizado do estado). */

export type ElementScope = "schematic" | "symbol" | "icon";

/** Categoria de domínio de um elemento -- derivada do `typeId`, nunca gravada como campo à parte
 * (uma única fonte de verdade: o próprio typeId decide a categoria, sempre). "exposed-component" não
 * é um elemento desta função (vive em `exposedComponents[]`, indexado por `componentId` que
 * referencia um elemento "component" real -- ver `getExposedComponentEntry`/`setExposedComponentEntry`
 * abaixo). */
export type ElementCategory = "pin" | "tunnel" | "graphic" | "component";

export function categoryForTypeId(typeId: string): ElementCategory {
  if (typeId === TUNNEL_TYPE_ID) return "tunnel";
  if (typeId === SYMBOL_PIN_TYPE_ID) return "pin";
  if (typeId.startsWith("graphics.")) return "graphic";
  return "component";
}

export interface ElementRef {
  readonly id: string;
  readonly scope: ElementScope;
  readonly category: ElementCategory;
  readonly element: WebviewComponentModel;
}

type ScopedArrayKey = "components" | "symbolElements" | "iconElements";

function scopeArrayKey(scope: ElementScope): ScopedArrayKey {
  switch (scope) {
    case "schematic": return "components";
    case "symbol": return "symbolElements";
    case "icon": return "iconElements";
  }
}

const SCOPES: readonly ElementScope[] = ["schematic", "symbol", "icon"];

/** Acha 1 elemento por id, em QUALQUER escopo -- devolve também o escopo/categoria resolvidos, pra
 * quem chama nunca precisar redescobrir "em qual array isso vive" por conta própria. `undefined`
 * quando o id não existe em nenhum escopo (nunca lança). */
export function getElement(state: WebviewProjectState, id: string): ElementRef | undefined {
  for (const scope of SCOPES) {
    const element = state[scopeArrayKey(scope)].find((entry) => entry.id === id);
    if (element) return { id, scope, category: categoryForTypeId(element.typeId), element };
  }
  return undefined;
}

/** Todo id usado em MAIS de um escopo ao mesmo tempo -- nunca deveria acontecer (cada elemento tem
 * exatamente um dono), mas validado explicitamente em vez de assumido; achado aqui é sempre um bug
 * de outra parte do sistema (ex: um id copiado sem regenerar). */
export function findDuplicateElementIds(state: WebviewProjectState): string[] {
  const seenInScopes = new Map<string, Set<ElementScope>>();
  for (const scope of SCOPES) {
    for (const entry of state[scopeArrayKey(scope)]) {
      const scopes = seenInScopes.get(entry.id) ?? new Set<ElementScope>();
      scopes.add(scope);
      seenInScopes.set(entry.id, scopes);
    }
  }
  return [...seenInScopes.entries()].filter(([, scopes]) => scopes.size > 1).map(([id]) => id);
}

export type ElementOperationOutcome<T> = { ok: true; value: T } | { ok: false; error: string };

/** Aplica um patch a UM elemento, em qualquer escopo -- "elemento inexistente" é um erro explícito
 * (`ok:false`), nunca um no-op silencioso que deixa quem chama sem saber que nada mudou. */
export function updateElement(
  state: WebviewProjectState,
  id: string,
  patch: Partial<WebviewComponentModel>
): ElementOperationOutcome<{ state: WebviewProjectState; ref: ElementRef }> {
  const ref = getElement(state, id);
  if (!ref) return { ok: false, error: `Elemento "${id}" não encontrado.` };
  const key = scopeArrayKey(ref.scope);
  const nextElement = { ...ref.element, ...patch };
  const nextArray = state[key].map((entry) => (entry.id === id ? nextElement : entry));
  return { ok: true, value: { state: { ...state, [key]: nextArray }, ref: { ...ref, element: nextElement } } };
}

function tunnelPinId(element: WebviewComponentModel): string | undefined {
  if (element.typeId !== TUNNEL_TYPE_ID) return undefined;
  const value = element.properties.pinId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

/** Remove UM elemento, em qualquer escopo, com a cascata/regra correta pra sua categoria:
 * - `pin`: remove também TODO túnel interno ligado a ele (mesmo `pinId`, `components[]`) -- nunca
 *   deixa um túnel órfão apontando pra um pino que não existe mais.
 * - `tunnel` ligado a um pino (`properties.pinId` presente): BLOQUEADO (`ok:false`, mensagem
 *   acionável) quando é a ÚNICA ligação interna daquele pino -- remover o pino inteiro (categoria
 *   `pin`) é o caminho correto nesse caso, nunca apagar o túnel isoladamente e deixar o pino sem
 *   nenhuma ligação. Túnel comum (sem `pinId`) nunca é bloqueado.
 * - qualquer elemento no escopo `schematic`: remove também sua entrada em `exposedComponents[]` e
 *   `exportedPropertyComponentIds[]`, se houver -- nunca deixa uma exposição/exportação órfã
 *   apontando pra um componente apagado.
 * "Elemento inexistente" é erro explícito, nunca no-op silencioso. */
export function removeElement(state: WebviewProjectState, id: string): ElementOperationOutcome<{ state: WebviewProjectState; ref: ElementRef }> {
  const ref = getElement(state, id);
  if (!ref) return { ok: false, error: `Elemento "${id}" não encontrado.` };

  if (ref.category === "tunnel") {
    const pinId = tunnelPinId(ref.element);
    if (pinId) {
      const siblingCount = state.components.filter((c) => c.id !== id && tunnelPinId(c) === pinId).length;
      if (siblingCount === 0) {
        return {
          ok: false,
          error: `Este túnel é a única ligação interna do pino "${pinId}". Para removê-lo, exclua o pino no modo Símbolo ou crie outro túnel associado antes.`,
        };
      }
    }
  }

  const key = scopeArrayKey(ref.scope);
  let next: WebviewProjectState = { ...state, [key]: state[key].filter((entry) => entry.id !== id) };

  if (ref.category === "pin") {
    const pinId = typeof ref.element.properties.pinId === "string" ? ref.element.properties.pinId : undefined;
    if (pinId) {
      next = { ...next, components: next.components.filter((c) => !(c.typeId === TUNNEL_TYPE_ID && c.properties.pinId === pinId)) };
    }
  }
  if (ref.scope === "schematic") {
    next = {
      ...next,
      exposedComponents: next.exposedComponents.filter((entry) => entry.componentId !== id),
      exportedPropertyComponentIds: next.exportedPropertyComponentIds.filter((componentId) => componentId !== id),
    };
  }
  return { ok: true, value: { state: next, ref } };
}

/** Move um elemento de um escopo pra outro -- sem chamador hoje (nenhuma operação atual precisa
 * mover um elemento entre circuito interno/Símbolo/Ícone), incluída por completude/simetria da API
 * canônica. Valida: escopo de destino compatível com a categoria (pino só existe em "symbol"); id já
 * ocupado no destino (nunca sobrescreve silenciosamente). */
export function moveElement(
  state: WebviewProjectState,
  id: string,
  targetScope: ElementScope
): ElementOperationOutcome<{ state: WebviewProjectState; ref: ElementRef }> {
  const ref = getElement(state, id);
  if (!ref) return { ok: false, error: `Elemento "${id}" não encontrado.` };
  if (ref.scope === targetScope) return { ok: true, value: { state, ref } };
  if (ref.category === "pin" && targetScope !== "symbol") {
    return { ok: false, error: `Pino só pode existir no escopo Símbolo.` };
  }
  const sourceKey = scopeArrayKey(ref.scope);
  const targetKey = scopeArrayKey(targetScope);
  if (state[targetKey].some((entry) => entry.id === id)) {
    return { ok: false, error: `Já existe um elemento com id "${id}" no escopo de destino.` };
  }
  const nextState: WebviewProjectState = {
    ...state,
    [sourceKey]: state[sourceKey].filter((entry) => entry.id !== id),
    [targetKey]: [...state[targetKey], ref.element],
  };
  return { ok: true, value: { state: nextState, ref: { ...ref, scope: targetScope } } };
}

/** Insere elementos NOVOS num escopo específico (colar/duplicar) -- ignora silenciosamente qualquer
 * elemento cujo id já exista em QUALQUER escopo (mesma proteção contra reentrega duplicada de
 * mensagem que o comportamento anterior já tinha, nunca uma sobrescrita). Devolve os elementos
 * REALMENTE inseridos (após o filtro), pra quem chama saber o que de fato entrou (ex: pra
 * selecioná-los). */
export function insertElements(
  state: WebviewProjectState,
  scope: ElementScope,
  elements: readonly WebviewComponentModel[]
): { state: WebviewProjectState; inserted: WebviewComponentModel[] } {
  const inserted = elements.filter((element) => !getElement(state, element.id));
  const key = scopeArrayKey(scope);
  return { state: { ...state, [key]: [...state[key], ...inserted] }, inserted };
}

export type ExposedComponentEntry = WebviewProjectState["exposedComponents"][number];

/** Lê a exposição atual de um componente interno (por `componentId`) -- `undefined` quando o
 * componente não está exposto no Símbolo. */
export function getExposedComponentEntry(state: WebviewProjectState, componentId: string): ExposedComponentEntry | undefined {
  return state.exposedComponents.find((entry) => entry.componentId === componentId);
}

/** Cria/atualiza a exposição de UM componente interno -- rejeita explicitamente (`ok:false`) quando
 * `componentId` não existe ou não pertence ao escopo `schematic` (só o circuito interno real pode
 * ser exposto, nunca um pino/forma do próprio Símbolo). Nunca duplica -- substitui a entrada
 * existente por completo quando já há uma pra esse `componentId`. */
export function setExposedComponentEntry(state: WebviewProjectState, entry: ExposedComponentEntry): ElementOperationOutcome<WebviewProjectState> {
  const ref = getElement(state, entry.componentId);
  if (!ref) return { ok: false, error: `Componente "${entry.componentId}" não encontrado.` };
  if (ref.scope !== "schematic") return { ok: false, error: `Só um componente do circuito interno pode ser exposto no Símbolo.` };
  const existingIndex = state.exposedComponents.findIndex((existing) => existing.componentId === entry.componentId);
  const nextExposedComponents =
    existingIndex === -1
      ? [...state.exposedComponents, entry]
      : state.exposedComponents.map((existing, index) => (index === existingIndex ? entry : existing));
  return { ok: true, value: { ...state, exposedComponents: nextExposedComponents } };
}

/** Remove a exposição de um componente (o componente interno em si nunca é afetado) -- idempotente,
 * nunca erro quando já não está exposto. */
export function removeExposedComponentEntry(state: WebviewProjectState, componentId: string): WebviewProjectState {
  return { ...state, exposedComponents: state.exposedComponents.filter((entry) => entry.componentId !== componentId) };
}
