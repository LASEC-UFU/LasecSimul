/**
 * Model Workspace do projeto (docs/66 §3): variáveis MATLAB (`l = 2`, `R = 3*l`) usadas nos
 * parâmetros dos blocos `sl.*`, como o workspace do modelo no Simulink. Avaliadas em ordem pelo Core
 * (`setModelWorkspace`): cada variável enxerga as anteriores. Os modelos importados do Simulink trazem
 * aqui as variáveis do workspace base que os parâmetros citam (o valor delas não fica no `.slx`).
 */

export interface ModelWorkspaceVariable {
  name: string;
  /** Expressão do subconjunto MATLAB (`core/src/simulation/library/ParamExpr.hpp`); vazia = a definir. */
  value: string;
  description?: string;
}

const IDENTIFIER = /^[A-Za-z][A-Za-z0-9_]*$/;

export function isWorkspaceIdentifier(name: string): boolean {
  return IDENTIFIER.test(name);
}

/** Leitura tolerante do campo do projeto: entradas inválidas são descartadas, nomes repetidos ficam
 * com a primeira ocorrência (a ordem é a de avaliação). */
export function validateModelWorkspace(value: unknown): ModelWorkspaceVariable[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const seen = new Set<string>();
  const result: ModelWorkspaceVariable[] = [];
  for (const entry of value) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const name = typeof record.name === "string" ? record.name.trim() : "";
    if (!isWorkspaceIdentifier(name) || seen.has(name)) continue;
    seen.add(name);
    const variable: ModelWorkspaceVariable = { name, value: typeof record.value === "string" ? record.value : typeof record.value === "number" ? String(record.value) : "" };
    if (typeof record.description === "string" && record.description.trim()) variable.description = record.description;
    result.push(variable);
  }
  return result.length > 0 ? result : undefined;
}

/** Variáveis com valor definido, na forma do verbo IPC. Sem valor, a variável não é enviada: o bloco
 * que a usa recusa com "identificador desconhecido", em vez de simular com um valor inventado. */
export function workspaceForCore(variables: readonly ModelWorkspaceVariable[] | undefined): Array<{ name: string; value: string }> {
  return (variables ?? []).filter((variable) => variable.value.trim().length > 0).map((variable) => ({ name: variable.name, value: variable.value }));
}

/** Nomes ainda sem valor (importação do Simulink, por exemplo). */
export function undefinedWorkspaceVariables(variables: readonly ModelWorkspaceVariable[] | undefined): string[] {
  return (variables ?? []).filter((variable) => variable.value.trim().length === 0).map((variable) => variable.name);
}
