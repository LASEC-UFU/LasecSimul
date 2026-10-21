import * as vscode from "vscode";
import { state } from "../state";
import { evaluateParam, ParamValue } from "../ui/webview/blockLibrary/paramExpr";
import { isWorkspaceIdentifier, ModelWorkspaceVariable } from "./modelWorkspace";

/**
 * Editor do Model Workspace (docs/66 §3): lista as variáveis em ordem de avaliação; escolher uma abre
 * as ações (valor, renomear, mover, remover). O valor é conferido no mesmo avaliador dos blocos
 * (espelho de `ParamExpr`) com as variáveis ANTERIORES, como o Core avalia.
 */
export async function editModelWorkspaceCommand(onChanged: () => Promise<void> | void): Promise<void> {
  for (;;) {
    const variables = [...(state.schematicState.modelWorkspace ?? [])];
    type Item = vscode.QuickPickItem & { index?: number; add?: boolean };
    const items: Item[] = [
      ...variables.map((variable, index) => ({
        label: `${variable.name} = ${variable.value.trim() || "(sem valor)"}`,
        description: variable.value.trim() ? describe(variables, index) : "defina o valor: os blocos que usam esta variável não compilam",
        detail: variable.description,
        index,
      })),
      { label: "$(add) Nova variável", add: true },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: "Model Workspace (variáveis dos parâmetros dos blocos, em ordem de avaliação)",
      placeHolder: variables.length === 0 ? "Nenhuma variável; crie a primeira" : "Escolha uma variável para editar",
    });
    if (!picked) return;
    if (picked.add) {
      const name = await askName(variables);
      if (!name) continue;
      const value = await askValue(name, "", variables, variables.length);
      if (value === undefined) continue;
      await commit([...variables, { name, value }], onChanged);
      continue;
    }
    const index = picked.index!;
    const variable = variables[index]!;
    const action = await vscode.window.showQuickPick(["Editar valor", "Renomear", "Descrição", "Mover para cima", "Mover para baixo", "Remover"], { title: variable.name });
    if (!action) continue;
    const next = [...variables];
    if (action === "Editar valor") {
      const value = await askValue(variable.name, variable.value, variables, index);
      if (value === undefined) continue;
      next[index] = { ...variable, value };
    } else if (action === "Renomear") {
      const name = await askName(variables.filter((_, i) => i !== index), variable.name);
      if (!name) continue;
      next[index] = { ...variable, name };
    } else if (action === "Descrição") {
      const description = await vscode.window.showInputBox({ title: `Descrição de ${variable.name}`, value: variable.description ?? "" });
      if (description === undefined) continue;
      next[index] = description.trim() ? { ...variable, description } : { name: variable.name, value: variable.value };
    } else if (action === "Mover para cima" && index > 0) {
      [next[index - 1], next[index]] = [next[index]!, next[index - 1]!];
    } else if (action === "Mover para baixo" && index < next.length - 1) {
      [next[index + 1], next[index]] = [next[index]!, next[index + 1]!];
    } else if (action === "Remover") {
      next.splice(index, 1);
    } else {
      continue;
    }
    await commit(next, onChanged);
  }
}

async function commit(variables: ModelWorkspaceVariable[], onChanged: () => Promise<void> | void): Promise<void> {
  state.schematicState = { ...state.schematicState, modelWorkspace: variables.length > 0 ? variables : undefined };
  await onChanged();
}

async function askName(existing: readonly ModelWorkspaceVariable[], initial = ""): Promise<string | undefined> {
  const taken = new Set(existing.map((variable) => variable.name));
  const name = await vscode.window.showInputBox({
    title: "Nome da variável",
    value: initial,
    validateInput: (text) => !isWorkspaceIdentifier(text.trim()) ? "Letra seguida de letras, dígitos ou _" : taken.has(text.trim()) ? "Já existe uma variável com este nome" : undefined,
  });
  return name?.trim();
}

async function askValue(name: string, initial: string, variables: readonly ModelWorkspaceVariable[], index: number): Promise<string | undefined> {
  return vscode.window.showInputBox({
    title: `Valor de ${name} (expressão MATLAB; pode usar as variáveis acima)`,
    value: initial,
    validateInput: (text) => {
      if (!text.trim()) return undefined;
      try {
        evaluateParam(text, workspaceBefore(variables, index));
        return undefined;
      } catch (error) {
        return error instanceof Error ? error.message : String(error);
      }
    },
  });
}

/** Workspace avaliado até a variável `index` (exclusive), como o Core faz. */
function workspaceBefore(variables: readonly ModelWorkspaceVariable[], index: number): Map<string, ParamValue> {
  const workspace = new Map<string, ParamValue>();
  for (let i = 0; i < index && i < variables.length; i++) {
    const variable = variables[i]!;
    if (!variable.value.trim()) continue;
    try { workspace.set(variable.name, evaluateParam(variable.value, workspace)); } catch { /* inválida: fica fora, o Core relata */ }
  }
  return workspace;
}

function describe(variables: readonly ModelWorkspaceVariable[], index: number): string {
  try {
    const value = evaluateParam(variables[index]!.value, workspaceBefore(variables, index));
    if (value.data.length === 1) return String(value.data[0]);
    return `${value.rows}x${value.cols}`;
  } catch (error) {
    return `erro: ${error instanceof Error ? error.message : String(error)}`;
  }
}
