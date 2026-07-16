import { TUNNEL_TYPE_ID } from "../ui/webview/model";
import { SubcircuitDocument } from "./subcircuitDocument";
import { pruneInvalidExposedComponentRefs } from "./subcircuitExposedComponents";

/** Validação obrigatória ANTES de salvar (pré-save) -- ponto único, testável, sem DOM, que decide se
 * um `SubcircuitDocument` pode ser gravado em disco. Nunca lança exceção -- toda condição vira
 * `errors[]` (bloqueante) ou `warnings[]` (não-bloqueante). Correções automáticas (`autoFixed`) só
 * quando SEGURAS e DETERMINÍSTICAS (nunca apagam conteúdo válido sem aviso, nunca escolhem
 * arbitrariamente entre fontes conflitantes, nunca renumeram pino silenciosamente, nunca alteram
 * conexão elétrica sem informar o usuário -- cada correção vira também um warning explicando o que
 * mudou). */
export interface SubcircuitValidationResult {
  errors: string[];
  warnings: string[];
  /** Presente só quando alguma correção seguraautomática foi aplicada -- documento pronto pra
   * salvar SE `errors.length === 0`. Nunca aplicado silenciosamente sem os `warnings[]`
   * correspondentes explicando cada mudança. */
  autoFixed?: SubcircuitDocument;
}

function tunnelPinId(component: { typeId: string; properties: Record<string, unknown> }): string | undefined {
  if (component.typeId !== TUNNEL_TYPE_ID) return undefined;
  const value = component.properties.pinId;
  return typeof value === "string" && value.trim() ? value.trim() : undefined;
}

function isSerializable(value: unknown): boolean {
  if (value === undefined) return true; // campo ausente -- sempre serializável (omitido)
  if (typeof value === "function" || typeof value === "symbol" || typeof value === "bigint") return false;
  try {
    // JSON.stringify NUNCA lança pra function/symbol/bigint aninhados (só os omite silenciosamente
    // da chave) -- a checagem de `typeof` acima cobre o valor de topo; `undefined` retornado aqui
    // só acontece por referência circular ou (coberto acima) tipo não-JSON no topo.
    return JSON.stringify(value) !== undefined;
  } catch {
    return false;
  }
}

const SUPPORTED_SHAPE_KINDS = new Set(["rect", "text", "line", "ellipse", "polygon", "path", "image", "svg"]);

export function validateSubcircuitDocument(document: SubcircuitDocument): SubcircuitValidationResult {
  const errors: string[] = [];
  const warnings: string[] = [];

  // IDs duplicados -- components[] + symbol.pins[] JUNTOS, nunca só por namespace separado (um
  // pino e um componente interno com o MESMO id ainda é uma colisão de identidade no documento).
  const seenIds = new Set<string>();
  const duplicateIds = new Set<string>();
  for (const component of document.components) {
    if (seenIds.has(component.id)) duplicateIds.add(component.id);
    seenIds.add(component.id);
  }
  for (const pin of document.symbol?.pins ?? []) {
    if (seenIds.has(pin.id)) duplicateIds.add(pin.id);
    seenIds.add(pin.id);
  }
  for (const id of duplicateIds) {
    errors.push(`Identificador duplicado: "${id}" (componente interno e/ou pino do Símbolo compartilhando o mesmo id).`);
  }

  // Pino sem pinId (símbolo malformado).
  const pinIds = new Set<string>();
  for (const pin of document.symbol?.pins ?? []) {
    const pinId = typeof pin.id === "string" ? pin.id.trim() : "";
    if (!pinId) {
      errors.push(`Pino do Símbolo sem identificador (pinId) válido -- label "${pin.label ?? "?"}".`);
      continue;
    }
    pinIds.add(pinId);
  }

  // Pino sem nenhum túnel correspondente.
  const tunnelsByPinId = new Map<string, number>();
  for (const component of document.components) {
    const pinId = tunnelPinId(component);
    if (!pinId) continue;
    tunnelsByPinId.set(pinId, (tunnelsByPinId.get(pinId) ?? 0) + 1);
  }
  for (const pinId of pinIds) {
    if (!tunnelsByPinId.has(pinId)) {
      errors.push(`Pino "${pinId}" não tem nenhum túnel interno associado -- todo pino externo precisa de pelo menos um túnel.`);
    }
  }

  // Túnel apontando pra um pino inexistente.
  for (const component of document.components) {
    const pinId = tunnelPinId(component);
    if (pinId && !pinIds.has(pinId)) {
      errors.push(`Túnel "${component.id}" referencia o pino "${pinId}", que não existe no Símbolo.`);
    }
  }

  // Componentes expostos -- referências órfãs/duplicadas (correção automática segura: pruneInvalidExposedComponentRefs
  // já é determinística -- mantém a primeira ocorrência, nunca escolhe arbitrariamente).
  const pruned = pruneInvalidExposedComponentRefs(document);
  for (const warning of pruned.warnings) warnings.push(warning);

  // Formas do Símbolo/Ícone com kind não suportado ou referência inválida.
  const shapeSources: Array<{ label: string; shapes: SubcircuitDocument["symbol"] extends undefined ? never : NonNullable<SubcircuitDocument["symbol"]>["shapes"] }> = [];
  if (document.symbol?.shapes) shapeSources.push({ label: "símbolo", shapes: document.symbol.shapes });
  if (document.icon?.shapes) shapeSources.push({ label: "ícone", shapes: document.icon.shapes });
  for (const source of shapeSources) {
    for (const shape of source.shapes ?? []) {
      if (!SUPPORTED_SHAPE_KINDS.has(shape.kind)) {
        errors.push(`Elemento gráfico do ${source.label} com tipo não suportado: "${shape.kind}".`);
      }
      if ((shape.kind === "image" || shape.kind === "svg") && !shape.href && !shape.value) {
        warnings.push(`Elemento de imagem/SVG do ${source.label} sem nenhuma fonte (href/value) -- não será visível.`);
      }
    }
  }

  // Propriedades não serializáveis (componentes internos e propriedades do símbolo/ícone).
  for (const component of document.components) {
    for (const [key, value] of Object.entries(component.properties ?? {})) {
      if (!isSerializable(value)) {
        errors.push(`Propriedade "${key}" do componente "${component.id}" não é serializável (JSON).`);
      }
    }
  }

  const finalDocument: SubcircuitDocument = pruned.warnings.length > 0 ? pruned.document : document;
  return {
    errors,
    warnings,
    ...(pruned.warnings.length > 0 ? { autoFixed: finalDocument } : {}),
  };
}
