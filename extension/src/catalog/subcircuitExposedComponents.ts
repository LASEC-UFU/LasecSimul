import { ExposedComponentEntry, SubcircuitDocument } from "./subcircuitDocument";

/** Domínio puro (sem `vscode`/DOM) das referências de "componente exposto" -- substitui a antiga
 * flag `WebviewComponentModel.exposed` + campos flat `boardX/boardY/boardRotation/boardFlipH/
 * boardFlipV/boardWidth/boardHeight` (2 formatos incompatíveis encontrados nesta auditoria: escrita
 * aninhada em `writeSubcircuitEditingSessionBack` vs. leitura plana em `subcircuitInternals.ts`/
 * `mcuCommands.ts` -- nenhum dos dois sobrevivia corretamente a reabrir a sessão) por UMA lista
 * explícita (`SubcircuitDocument.exposedComponents`), cada entrada referenciando
 * `components[].id` por identificador PERSISTENTE, nunca índice. NUNCA copia o componente interno --
 * só posição/rotação/escala/camada de APRESENTAÇÃO no Símbolo; estado funcional continua pertencendo
 * exclusivamente ao componente interno real (`components[]`). */

export interface ExposedComponentValidationResult {
  document: SubcircuitDocument;
  warnings: string[];
}

/** Remove/invalida referências órfãs: `componentId` que não existe mais em `components[]`, e
 * duplicatas (mais de uma exposição do MESMO componente -- só uma representação exposta permitida
 * por componente, regra explícita do pedido original). Mantém sempre a PRIMEIRA ocorrência de cada
 * `componentId` duplicado. Nunca silencioso -- toda remoção vira um warning explicando o quê e por
 * quê, nunca apenas desaparece sem explicação. */
export function pruneInvalidExposedComponentRefs(document: SubcircuitDocument): ExposedComponentValidationResult {
  const warnings: string[] = [];
  const existingComponentIds = new Set(document.components.map((component) => component.id));
  const seenComponentIds = new Set<string>();
  const nextExposedComponents: ExposedComponentEntry[] = [];

  for (const entry of document.exposedComponents) {
    if (!existingComponentIds.has(entry.componentId)) {
      warnings.push(`Componente exposto referencia "${entry.componentId}", que não existe mais no circuito interno -- referência removida.`);
      continue;
    }
    if (seenComponentIds.has(entry.componentId)) {
      warnings.push(`Componente "${entry.componentId}" tinha mais de uma representação exposta -- mantida só a primeira, as demais foram removidas.`);
      continue;
    }
    seenComponentIds.add(entry.componentId);
    nextExposedComponents.push(entry);
  }

  if (nextExposedComponents.length === document.exposedComponents.length) {
    return { document, warnings };
  }
  return { document: { ...document, exposedComponents: nextExposedComponents }, warnings };
}

/** Adiciona ou atualiza a exposição de UM componente interno -- se já existe uma entrada pra esse
 * `componentId`, substitui (nunca duplica); senão, adiciona uma nova. */
export function setExposedComponent(document: SubcircuitDocument, entry: ExposedComponentEntry): SubcircuitDocument {
  const existingIndex = document.exposedComponents.findIndex((existing) => existing.componentId === entry.componentId);
  if (existingIndex === -1) {
    return { ...document, exposedComponents: [...document.exposedComponents, entry] };
  }
  const nextExposedComponents = [...document.exposedComponents];
  nextExposedComponents[existingIndex] = entry;
  return { ...document, exposedComponents: nextExposedComponents };
}

/** Remove a exposição de um componente (o componente interno em si NUNCA é afetado -- só a
 * apresentação no Símbolo deixa de existir). */
export function removeExposedComponent(document: SubcircuitDocument, componentId: string): SubcircuitDocument {
  return { ...document, exposedComponents: document.exposedComponents.filter((entry) => entry.componentId !== componentId) };
}
