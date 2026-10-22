import { spawn } from "child_process";
import * as vscode from "vscode";
import { resolveSelectedPythonExecutable } from "./pythonEnvironment";

type PythonPortEntry = { name: string; type: string; unit?: string; description?: string; initialValue?: boolean | number };
type PythonBlock = { id: string; label: string; typeId: string; properties: Record<string, string | number | boolean> };
const targetByDocument = new Map<string, string>();

/** Uses a real untitled Python document so the installed VS Code Python tooling provides syntax
 * coloring, indentation, completion, search/replace and navigation. Applying writes the buffer
 * back into the schematic's embedded project property. */
export function registerPythonBlockEditor(
  context: vscode.ExtensionContext,
  getBlock: (id?: string) => PythonBlock | undefined,
  applySource: (id: string, source: string) => Promise<void>,
  editPorts: (id: string, ports: { inputs: PythonPortEntry[]; outputs: PythonPortEntry[] }, renamedSource?: string) => Promise<void>,
): void {
  const diagnostics = vscode.languages.createDiagnosticCollection("lasecsimul-python-block");
  context.subscriptions.push(diagnostics);
  context.subscriptions.push(vscode.commands.registerCommand("lasecsimul.python.showEnvironment", async () => {
    const executable = await resolveSelectedPythonExecutable();
    if (!executable) {
      void vscode.window.showErrorMessage("Não encontrei um interpretador Python ativo. Selecione um ambiente na extensão Python ou configure lasecsimul.python.executable.");
      return;
    }
    const details = await new Promise<string>((resolve, reject) => {
      const child = spawn(executable, ["-c", "import importlib.metadata,importlib.util,sys; print(sys.version.split()[0]); print(sys.prefix); print(importlib.metadata.version('numpy') if importlib.util.find_spec('numpy') else 'não instalado')"], { windowsHide: true, stdio: ["ignore", "pipe", "pipe"] });
      let stdout = ""; let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (value: string) => stdout += value);
      child.stderr.setEncoding("utf8").on("data", (value: string) => stderr += value);
      child.once("error", reject);
      child.once("close", code => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || `Python terminou com código ${code}.`)));
    });
    const [version, prefix, numpy] = details.split(/\r?\n/);
    await vscode.window.showInformationMessage(`Python ${version ?? "?"} · ${executable} · ambiente ${prefix ?? "?"} · NumPy ${numpy ?? "desconhecido"}`);
  }));
  context.subscriptions.push(vscode.languages.registerCompletionItemProvider("python", {
    provideCompletionItems(document) {
      const id = targetByDocument.get(document.uri.toString());
      const block = id ? getBlock(id) : undefined;
      if (!block) return [];
      let ports: { inputs?: Array<{ name?: string; type?: string; unit?: string; description?: string }>; outputs?: Array<{ name?: string; type?: string; unit?: string; description?: string }> } = {};
      try { ports = JSON.parse(String(block.properties.ports ?? "{}")); } catch { /* o Core reporta portas inválidas */ }
      const items: vscode.CompletionItem[] = [];
      for (const [direction, values] of [["Entrada", ports.inputs ?? []], ["Saída", ports.outputs ?? []]] as const) {
        for (const port of values) {
          if (!port.name) continue;
          const item = new vscode.CompletionItem(port.name, vscode.CompletionItemKind.Variable);
          item.detail = `${direction} ${port.type ?? "real"}${port.unit ? ` (${port.unit})` : ""}`;
          item.documentation = port.description || (direction === "Entrada" ? "Valor lido do pino de entrada." : "Atribua um valor a esta variável para atualizar o pino de saída.");
          items.push(item);
        }
      }
      for (const [name, detail] of [["sim", "Contexto temporal: sim.time (s), sim.dt (s), sim.step"], ["state", "Estado persistente exclusivo desta instância; use state.nome = valor"]] as const) {
        const item = new vscode.CompletionItem(name, vscode.CompletionItemKind.Variable);
        item.detail = detail;
        items.push(item);
      }
      return items;
    },
  }, "."));
  context.subscriptions.push(vscode.languages.registerHoverProvider("python", {
    provideHover(document, position) {
      const id = targetByDocument.get(document.uri.toString());
      const block = id ? getBlock(id) : undefined;
      if (!block) return undefined;
      const word = document.getWordRangeAtPosition(position);
      if (!word) return undefined;
      const name = document.getText(word);
      if (name === "sim") return new vscode.Hover("`sim.time` e `sim.dt` estão em segundos; `sim.step` é a contagem de chamadas deste bloco.", word);
      if (name === "state") return new vscode.Hover("`state` mantém atributos Python entre ciclos da mesma instância. O estado reinicia ao reiniciar a simulação.", word);
      try {
        const ports = JSON.parse(String(block.properties.ports ?? "{}")) as { inputs?: Array<{ name: string; type: string; unit?: string; description?: string }>; outputs?: Array<{ name: string; type: string; unit?: string; description?: string }> };
        const input = (ports.inputs ?? []).find(port => port.name === name);
        if (input) return new vscode.Hover(`Entrada **${name}** · ${input.type}${input.unit ? ` · ${input.unit}` : ""}${input.description ? `\n\n${input.description}` : ""}`, word);
        const output = (ports.outputs ?? []).find(port => port.name === name);
        if (output) return new vscode.Hover(`Saída **${name}** · ${output.type}${output.unit ? ` · ${output.unit}` : ""}\n\nAtribua um valor a esta variável para publicar o valor na porta.`, word);
      } catch { /* sem definições de portas válidas */ }
      return undefined;
    },
  }));
  context.subscriptions.push(vscode.commands.registerCommand("lasecsimul.python.openBlockEditor", async (id?: string) => {
    const block = getBlock(id);
    if (!block || block.typeId !== "python.programmable") {
      void vscode.window.showWarningMessage("Selecione um bloco Python Programável no esquemático.");
      return;
    }
    const document = await vscode.workspace.openTextDocument({ language: "python", content: String(block.properties.source ?? "") });
    targetByDocument.set(document.uri.toString(), block.id);
    await vscode.window.showTextDocument(document, { preview: false });
    await vscode.commands.executeCommand("setContext", "lasecsimul.pythonBlockEditor", true);
  }));
  context.subscriptions.push(vscode.commands.registerCommand("lasecsimul.python.configurePorts", async (id?: string) => {
    const block = getBlock(id);
    if (!block || block.typeId !== "python.programmable") {
      void vscode.window.showWarningMessage("Selecione um bloco Python Programável no esquemático.");
      return;
    }
    const ports = (() => {
      try { return JSON.parse(String(block.properties.ports ?? "{}")) as { inputs?: PythonPortEntry[]; outputs?: PythonPortEntry[] }; }
      catch { return {}; }
    })();
    const direction = await vscode.window.showQuickPick([{ label: "Entradas", key: "inputs" as const }, { label: "Saídas", key: "outputs" as const }], { title: `Portas de ${block.label}` });
    if (!direction) return;
    const list = [...(ports[direction.key] ?? [])];
    const action = await vscode.window.showQuickPick(["Adicionar porta", ...list.map(port => `Editar: ${port.name}`)], { title: direction.label });
    if (!action) return;
    let rename: { from: string; to: string } | undefined;
    if (action === "Adicionar porta") {
      const name = await vscode.window.showInputBox({ title: `Nome da nova ${direction.label.toLowerCase().slice(0, -1)}`, prompt: "Use um identificador Python único dentro do bloco." });
      if (!name) return;
      const type = await vscode.window.showQuickPick(["real", "bool", "int64"], { title: `Tipo da porta ${name}` });
      if (!type) return;
      const unit = await vscode.window.showInputBox({ title: "Unidade (opcional)" });
      const description = await vscode.window.showInputBox({ title: "Descrição (opcional)" });
      const initialText = await vscode.window.showInputBox({
        title: "Valor inicial",
        value: type === "bool" ? "false" : "0",
        prompt: type === "bool" ? "Use true ou false." : type === "int64" ? "Informe um inteiro exato." : "Informe um número finito.",
      });
      if (initialText === undefined) return;
      const initialValue = parseInitialValue(type, initialText);
      if (initialValue === undefined) {
        void vscode.window.showErrorMessage(type === "bool" ? "Use true ou false para um pino bool." : "Informe um número válido para o tipo do pino.");
        return;
      }
      if (list.length >= 64) {
        void vscode.window.showErrorMessage("Cada direção aceita no máximo 64 pinos Python.");
        return;
      }
      list.push({ name, type, initialValue, ...(unit ? { unit } : {}), ...(description ? { description } : {}) });
    } else {
      const index = list.findIndex(port => action === `Editar: ${port.name}`);
      if (index < 0) return;
      const current = list[index]!;
      const operation = await vscode.window.showQuickPick(["Renomear", "Alterar tipo", "Editar valor inicial", "Editar descrição", "Remover"], { title: current.name });
      if (!operation) return;
      if (operation === "Remover") list.splice(index, 1);
      else if (operation === "Editar descrição") {
        const description = await vscode.window.showInputBox({ title: `Descrição de ${current.name}`, value: current.description ?? "" });
        if (description === undefined) return;
        list[index] = { ...current, description };
      } else if (operation === "Editar valor inicial") {
        const raw = await vscode.window.showInputBox({ title: `Valor inicial de ${current.name}`, value: String(current.initialValue ?? (current.type === "bool" ? false : 0)) });
        if (raw === undefined) return;
        const initialValue = parseInitialValue(current.type, raw);
        if (initialValue === undefined) { void vscode.window.showErrorMessage(current.type === "bool" ? "Use true ou false para um pino bool." : "Informe um número válido para o tipo do pino."); return; }
        list[index] = { ...current, initialValue };
      }
      else if (operation === "Renomear") {
        const name = await vscode.window.showInputBox({ title: "Novo identificador", value: current.name });
        if (!name) return;
        list[index] = { ...current, name };
        rename = { from: current.name, to: name };
      } else {
        const type = await vscode.window.showQuickPick(["real", "bool", "int64"], { title: `Tipo de ${current.name}`, placeHolder: current.type });
        if (!type) return;
        const initialValue = current.type === type
          ? current.initialValue
          : type === "bool" ? (typeof current.initialValue === "boolean" ? current.initialValue : false)
            : typeof current.initialValue === "number" && (type !== "int64" || Number.isSafeInteger(current.initialValue)) ? current.initialValue : 0;
        list[index] = { ...current, type, initialValue };
      }
    }
    const next = { inputs: direction.key === "inputs" ? list : [...(ports.inputs ?? [])], outputs: direction.key === "outputs" ? list : [...(ports.outputs ?? [])] };
    const allNames = [...next.inputs, ...next.outputs].map(port => port.name);
    const reserved = new Set(["False", "None", "True", "and", "as", "assert", "async", "await", "break", "class", "continue", "def", "del", "elif", "else", "except", "finally", "for", "from", "global", "if", "import", "in", "is", "lambda", "nonlocal", "not", "or", "pass", "raise", "return", "try", "while", "with", "yield", "match", "case", "sim", "state", "inputs", "outputs"]);
    if (allNames.some(name => !/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || reserved.has(name)) || new Set(allNames).size !== allNames.length) {
      void vscode.window.showErrorMessage("As portas precisam ter identificadores Python válidos, únicos e não reservados.");
      return;
    }
    let renamedSource: string | undefined;
    if (rename) {
      const editorEntry = [...targetByDocument].find(([, targetId]) => targetId === block.id);
      const document = editorEntry ? vscode.workspace.textDocuments.find(candidate => candidate.uri.toString() === editorEntry[0]) : undefined;
      const originalSource = document?.getText() ?? String(block.properties.source ?? "");
      try { renamedSource = await renamePythonIdentifierReferences(originalSource, rename.from, rename.to); }
      catch (error) {
        void vscode.window.showErrorMessage(`Não renomeei a porta: não foi possível analisar as referências Python com segurança. ${error instanceof Error ? error.message : String(error)}`);
        return;
      }
      if (document) {
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)), renamedSource);
        if (!await vscode.workspace.applyEdit(edit)) return;
      }
    }
    await editPorts(block.id, next, renamedSource);
  }));
  context.subscriptions.push(vscode.commands.registerCommand("lasecsimul.python.applyBlockCode", async () => {
    const editor = vscode.window.activeTextEditor;
    const id = editor && targetByDocument.get(editor.document.uri.toString());
    if (!editor || !id) {
      void vscode.window.showWarningMessage("Abra o editor a partir de um bloco Python Programável.");
      return;
    }
    const block = getBlock(id);
    if (!block) throw new Error("O bloco Python foi removido do projeto.");
    await applySource(id, editor.document.getText());
    void vscode.window.showInformationMessage(`Código aplicado ao bloco ${block.label}.`);
  }));
  context.subscriptions.push(vscode.commands.registerCommand("lasecsimul.python.validateBlockCode", async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor || !targetByDocument.has(editor.document.uri.toString())) {
      void vscode.window.showWarningMessage("Abra primeiro o editor de um bloco Python Programável.");
      return;
    }
    const uri = editor.document.uri;
    const executable = await resolveSelectedPythonExecutable();
    if (!executable) {
      void vscode.window.showErrorMessage("Não encontrei o interpretador Python selecionado no VS Code.");
      return;
    }
    const script = "import ast,json,sys\ntry:\n ast.parse(sys.stdin.read())\n print(json.dumps({'ok':True}))\nexcept SyntaxError as e:\n print(json.dumps({'ok':False,'message':e.msg,'line':e.lineno or 1,'column':e.offset or 1}))\n";
    const result = await new Promise<{ stdout: string; stderr: string; code: number | null }>((resolve, reject) => {
      const child = spawn(executable, ["-c", script], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
      let stdout = ""; let stderr = "";
      child.stdout.setEncoding("utf8").on("data", (value: string) => stdout += value);
      child.stderr.setEncoding("utf8").on("data", (value: string) => stderr += value);
      child.once("error", reject);
      child.once("close", code => resolve({ stdout, stderr, code }));
      child.stdin.end(editor.document.getText());
    });
    if (result.code !== 0) throw new Error(result.stderr || `Python terminou com código ${result.code}.`);
    const parsed = JSON.parse(result.stdout.trim()) as { ok: boolean; message?: string; line?: number; column?: number };
    diagnostics.delete(uri);
    if (!parsed.ok) {
      const line = Math.max(0, (parsed.line ?? 1) - 1);
      const column = Math.max(0, (parsed.column ?? 1) - 1);
      const range = new vscode.Range(line, column, line, column + 1);
      diagnostics.set(uri, [new vscode.Diagnostic(range, parsed.message ?? "Erro de sintaxe Python", vscode.DiagnosticSeverity.Error)]);
      void vscode.window.showErrorMessage(`Erro de sintaxe Python na linha ${line + 1}: ${parsed.message ?? "erro"}`);
      return;
    }
    void vscode.window.showInformationMessage(`Sintaxe Python válida (${executable}).`);
  }));
  context.subscriptions.push(vscode.workspace.onDidCloseTextDocument(document => {
    targetByDocument.delete(document.uri.toString());
    diagnostics.delete(document.uri);
    if (targetByDocument.size === 0) void vscode.commands.executeCommand("setContext", "lasecsimul.pythonBlockEditor", false);
  }));
  context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(editor => {
    void vscode.commands.executeCommand("setContext", "lasecsimul.pythonBlockEditor", Boolean(editor && targetByDocument.has(editor.document.uri.toString())));
  }));
}

/** Uses Python's tokenizer so renaming a pin changes NAME tokens, never text inside a comment or
 * string literal. If tokenization fails, the port change is cancelled instead of risking damage. */
async function renamePythonIdentifierReferences(source: string, oldName: string, newName: string): Promise<string> {
  const executable = await resolveSelectedPythonExecutable();
  if (!executable) throw new Error("o interpretador Python ativo não foi resolvido");
  const script = "import io,json,sys,tokenize\nold=sys.argv[1]; source=sys.stdin.read()\ntokens=[{'start':list(t.start),'end':list(t.end)} for t in tokenize.generate_tokens(io.StringIO(source).readline) if t.type==tokenize.NAME and t.string==old]\nprint(json.dumps(tokens))\n";
  const output = await new Promise<string>((resolve, reject) => {
    const child = spawn(executable, ["-c", script, oldName, newName], { windowsHide: true, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = ""; let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (value: string) => stdout += value);
    child.stderr.setEncoding("utf8").on("data", (value: string) => stderr += value);
    child.once("error", reject);
    child.once("close", code => code === 0 ? resolve(stdout.trim()) : reject(new Error(stderr || `Python terminou com código ${code}.`)));
    child.stdin.end(source);
  });
  const tokens = JSON.parse(output) as Array<{ start: [number, number]; end: [number, number] }>;
  const lines = source.split("\n");
  const lineOffsets: number[] = [];
  let offset = 0;
  for (const line of lines) { lineOffsets.push(offset); offset += line.length + 1; }
  const position = ([row, column]: [number, number]): number => {
    const line = lines[row - 1] ?? "";
    return (lineOffsets[row - 1] ?? source.length) + Array.from(line).slice(0, column).join("").length;
  };
  let result = source;
  for (const token of tokens.sort((left, right) => position(right.start) - position(left.start))) {
    const start = position(token.start); const end = position(token.end);
    result = result.slice(0, start) + newName + result.slice(end);
  }
  return result;
}

function parseInitialValue(type: string, raw: string): boolean | number | undefined {
  if (type === "bool") {
    const value = raw.trim().toLowerCase();
    return value === "true" ? true : value === "false" ? false : undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || (type === "int64" && !Number.isSafeInteger(value))) return undefined;
  if (type === "int64" && !Number.isInteger(value)) return undefined;
  return value;
}
