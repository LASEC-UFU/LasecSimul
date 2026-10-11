// Editor de projeto IEC 61131-3 (Webview). Host: src/plc/IecProjectEditorProvider.ts.
// Sem build: JavaScript puro servido de media/iec-editor.
(function () {
  "use strict";
  const vscode = acquireVsCodeApi();
  const saved = vscode.getState() || {};
  let activeId = saved.activeId;
  let payload;
  let build = { state: "idle" };
  let monitor;
  let monitorSignature = "";
  let textTimer;

  const el = (id) => document.getElementById(id);
  const escape = (value) => String(value ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const post = (message) => vscode.postMessage(message);

  // Palavras-chave da norma: são as que o aluno vê no ST e nos manuais dos CLPs.
  const CLASS_LABELS = {
    input: "VAR_INPUT",
    output: "VAR_OUTPUT",
    inOut: "VAR_IN_OUT",
    local: "VAR",
    temp: "VAR_TEMP",
    external: "VAR_EXTERNAL",
  };
  const CLASSES_BY_KIND = {
    program: ["input", "output", "local", "temp", "external"],
    functionBlock: ["input", "output", "inOut", "local", "temp", "external"],
    function: ["input", "local", "temp", "external"],
  };
  const KIND_LABELS = { program: "PROGRAM", functionBlock: "FUNCTION_BLOCK", function: "FUNCTION" };
  const STANDARD_FBS = ["TON", "TOF", "TP", "CTU", "CTD", "CTUD", "R_TRIG", "F_TRIG", "SR", "RS"];

  function select(id) {
    activeId = id;
    vscode.setState({ activeId });
    render();
  }

  function activePou() {
    if (!payload) return undefined;
    const pous = payload.project.pous;
    if (!pous.some((pou) => pou.pouId === activeId)) activeId = (payload.entry && payload.entry.pouId) || (pous[0] && pous[0].pouId);
    return pous.find((pou) => pou.pouId === activeId);
  }

  // ---------------------------------------------------------------- explorer / novo POU
  function renderExplorer() {
    const pous = payload.project.pous;
    const groups = [["Programas", "program"], ["Blocos de função", "functionBlock"], ["Funções", "function"]];
    el("explorer").innerHTML = groups.map(([label, kind]) => {
      const items = pous.filter((pou) => pou.kind === kind);
      if (items.length === 0) return "";
      return '<div class="group">' + label + "</div>" + items.map((pou) =>
        '<button class="item' + (pou.pouId === activeId ? " active" : "") + '" data-select="' + escape(pou.pouId) + '">' +
        escape(pou.name) + ' <span class="badge">' + pou.implementation.language.toUpperCase() + "</span>" +
        (payload.entry && payload.entry.pouId === pou.pouId ? ' <span class="badge entry" title="Programa executado pela tarefa">▶</span>' : "") +
        "</button>").join("");
    }).join("");
    el("explorer").querySelectorAll("[data-select]").forEach((button) => { button.onclick = () => select(button.dataset.select); });

    if (!el("newPouName")) {
      el("add").innerHTML =
        '<input id="newPouName" placeholder="Nome do novo POU"/>' +
        '<select id="newPouKind"><option value="functionBlock">FUNCTION_BLOCK</option><option value="function">FUNCTION</option><option value="program">PROGRAM</option></select>' +
        '<select id="newPouLanguage"><option value="st">ST</option><option value="il">IL</option><option value="ld">LD</option><option value="fbd">FBD</option><option value="sfc">SFC</option></select>' +
        '<button id="newPouButton">Adicionar POU</button>';
      el("newPouButton").onclick = () => {
        const name = el("newPouName").value.trim();
        if (!name) return;
        post({ type: "addPou", name, kind: el("newPouKind").value, language: el("newPouLanguage").value });
        el("newPouName").value = "";
      };
    }
  }

  // ---------------------------------------------------------------- configuração (TASK)
  function renderConfiguration() {
    const entry = payload.entry;
    const programs = payload.project.pous.filter((pou) => pou.kind === "program");
    if (document.activeElement && el("configuration").contains(document.activeElement)) return;
    const taskEditor = !entry || programs.length === 0 ? '<p class="muted">Crie um POU PROGRAM para configurar a tarefa.</p>' :
      '<label>Tarefa (TASK)<input id="taskName" value="' + escape(entry.taskName) + '"/></label>' +
      '<label>Período cíclico (ms)<input id="taskInterval" type="number" min="0.1" step="0.1" value="' + escape(entry.taskIntervalMs) + '"/></label>' +
      '<label>Prioridade<input id="taskPriority" type="number" min="0" step="1" value="' + escape(entry.taskPriority) + '"/></label>' +
      '<label>Instância de programa<input id="instanceName" value="' + escape(entry.programInstanceName) + '"/></label>' +
      '<label>Programa<select id="instancePou">' + programs.map((pou) =>
        '<option value="' + escape(pou.pouId) + '"' + (pou.pouId === entry.pouId ? " selected" : "") + ">" + escape(pou.name) + "</option>").join("") +
      "</select></label>" +
      '<button id="applyTask">Aplicar</button>' +
      '<p class="muted">Tasks cíclicas executam suas instâncias no período definido, usando o tempo da simulação.</p>';
    const typesJson = JSON.stringify(payload.project.dataTypes || [], null, 2);
    const globalsJson = JSON.stringify(payload.project.globalVariableLists || [], null, 2);
    const runtimeConfigurationJson = JSON.stringify({
      entryConfiguration: payload.project.buildSettings?.entryConfiguration,
      configurations: payload.project.configurations || [],
      resources: payload.project.resources || [],
      tasks: payload.project.tasks || [],
      programInstances: payload.project.programInstances || [],
    }, null, 2);
    el("configuration").innerHTML = taskEditor +
      '<details><summary>Resources, tasks e instÃ¢ncias adicionais</summary><p class="muted">Edite as listas completas para configurar vÃ¡rias tasks cÃ­clicas e instÃ¢ncias. Use resources[].tasks para associar mais de uma task ao resource.</p><textarea id="iecRuntimeConfiguration" rows="12" spellcheck="false">' + escape(runtimeConfigurationJson) + '</textarea><button id="applyRuntimeConfiguration">Aplicar configuraÃ§Ã£o de runtime</button></details>' +
      '<details><summary>Tipos de dados IEC</summary><p class="muted">Cada item usa kind alias/baseType, enum/values, struct/fields ou array/elementType/dimensions.</p><textarea id="iecDataTypes" rows="7" spellcheck="false">' + escape(typesJson) + '</textarea></details>' +
      '<details><summary>Listas de variáveis globais</summary><p class="muted">Cada GVL contém name e variables; declare-as nos POUs como VAR_EXTERNAL.</p><textarea id="iecGlobals" rows="7" spellcheck="false">' + escape(globalsJson) + '</textarea></details>' +
      '<button id="applyProjectData">Aplicar tipos e variáveis globais</button>';
    if (entry && programs.length > 0) el("applyTask").onclick = () => post({
      type: "updateTask",
      taskName: el("taskName").value.trim(),
      intervalMs: Number(el("taskInterval").value),
      priority: Number(el("taskPriority").value),
      instanceName: el("instanceName").value.trim(),
      pouId: el("instancePou").value,
    });
    el("applyProjectData").onclick = () => post({
      type: "updateProjectData", dataTypes: el("iecDataTypes").value, globalVariableLists: el("iecGlobals").value,
    });
    el("applyRuntimeConfiguration").onclick = () => post({
      type: "updateProjectRuntimeConfiguration", configuration: el("iecRuntimeConfiguration").value,
    });
  }

  // ---------------------------------------------------------------- variáveis
  function typeOptions() {
    const projectFbs = payload.project.pous.filter((pou) => pou.kind === "functionBlock").map((pou) => pou.name.toUpperCase());
    const projectTypes = (payload.project.dataTypes || []).map((type) => type.name.toUpperCase());
    return [...payload.scalarTypes, ...STANDARD_FBS, ...projectFbs, ...projectTypes];
  }

  function readVariableRows() {
    return [...el("variables").querySelectorAll("tr[data-row]")].map((row) => ({
      name: row.querySelector('[data-field="name"]').value,
      class: row.querySelector('[data-field="class"]').value,
      type: row.querySelector('[data-field="type"]').value,
      initialValue: row.querySelector('[data-field="initialValue"]').value,
      retain: row.querySelector('[data-field="retain"]').checked,
      ioId: row.querySelector('[data-field="ioId"]') ? row.querySelector('[data-field="ioId"]').value : "",
    }));
  }

  function commitVariables(pou, rows) {
    post({ type: "updateVariables", pouId: pou.pouId, variables: rows });
  }

  function variablesTable(pou) {
    const classes = CLASSES_BY_KIND[pou.kind] || CLASSES_BY_KIND.functionBlock;
    const rows = pou.interface.variables.map((variable, index) => {
      const isPublic = variable.class === "input" || variable.class === "output" || variable.class === "inOut";
      const classOptions = [...new Set([...classes, variable.class])].map((value) =>
        '<option value="' + value + '"' + (value === variable.class ? " selected" : "") + ">" + escape(CLASS_LABELS[value] || value) + "</option>").join("");
      return '<tr data-row="' + index + '">' +
        '<td><input data-field="name" value="' + escape(variable.name) + '"/></td>' +
        '<td><select data-field="class">' + classOptions + "</select></td>" +
        '<td><input data-field="type" list="iecTypes" value="' + escape(variable.type) + '"/></td>' +
        '<td><input data-field="initialValue" value="' + escape(variable.initialValue || "") + '" placeholder="padrão"/></td>' +
        '<td><label class="inline"><input type="checkbox" data-field="retain"' + (variable.retain ? " checked" : "") + '/> RETAIN</label></td>' +
        "<td>" + (isPublic && pou.kind === "program" ? '<input data-field="ioId" value="' + escape(variable.ioId || variable.name) + '" title="Id do pino no bloco PLC do esquemático"/>' : '<span class="muted">—</span>') + "</td>" +
        '<td><button class="icon" data-remove="' + index + '" title="Remover">✕</button></td></tr>';
    }).join("");
    return '<datalist id="iecTypes">' + typeOptions().map((type) => '<option value="' + escape(type) + '"></option>').join("") + "</datalist>" +
      '<table class="vars"><thead><tr><th>Nome</th><th>Classe</th><th>Tipo</th><th>Valor inicial</th><th>Retenção</th><th>Pino</th><th></th></tr></thead>' +
      '<tbody id="variables">' + rows + "</tbody></table>" +
      '<button id="addVariable">+ Variável</button>' +
      (pou.kind === "program" ? '<span class="muted"> Entradas e saídas viram pinos do bloco PLC: BOOL é 0/5 V, números são o valor em volts.</span>' : "");
  }

  function bindVariables(pou) {
    const table = el("variables");
    table.querySelectorAll("input,select").forEach((input) => { input.onchange = () => commitVariables(pou, readVariableRows()); });
    table.querySelectorAll("[data-remove]").forEach((button) => {
      button.onclick = () => {
        const rows = readVariableRows();
        rows.splice(Number(button.dataset.remove), 1);
        commitVariables(pou, rows);
      };
    });
    el("addVariable").onclick = () => {
      const rows = readVariableRows();
      const used = new Set(rows.map((row) => row.name.toUpperCase()));
      let index = rows.length + 1;
      while (used.has("VAR" + index)) index += 1;
      rows.push({ name: "VAR" + index, class: "local", type: "BOOL", initialValue: "", ioId: "" });
      commitVariables(pou, rows);
    };
  }

  // ---------------------------------------------------------------- código
  function problemLines(pou) {
    const lines = new Map();
    for (const item of build.diagnostics || []) {
      if (item.pouId === pou.pouId && item.line) lines.set(item.line, item.message);
    }
    return lines;
  }

  function updateGutter(pou) {
    const code = el("code");
    const gutter = el("gutter");
    if (!code || !gutter) return;
    const count = Math.max(1, code.value.split("\n").length);
    const marks = problemLines(pou);
    let html = "";
    for (let line = 1; line <= count; line += 1) {
      html += marks.has(line)
        ? '<div class="bad" title="' + escape(marks.get(line)) + '">' + line + "</div>"
        : "<div>" + line + "</div>";
    }
    gutter.innerHTML = html;
    gutter.scrollTop = code.scrollTop;
  }

  function codeEditor(pou) {
    return '<div class="code"><div id="gutter" class="gutter"></div><textarea id="code" spellcheck="false" wrap="off">' +
      escape(pou.implementation.text) + "</textarea></div>";
  }

  function bindCode(pou) {
    const code = el("code");
    if (!code) return;
    const send = () => {
      clearTimeout(textTimer);
      textTimer = undefined;
      if (code.value !== pou.implementation.text) post({ type: "updateText", pouId: pou.pouId, text: code.value });
    };
    code.oninput = () => {
      updateGutter(pou);
      clearTimeout(textTimer);
      textTimer = setTimeout(send, 500);
    };
    code.onblur = send;
    code.onscroll = () => { el("gutter").scrollTop = code.scrollTop; };
    code.onkeydown = (event) => {
      if (event.key === "Tab") {
        event.preventDefault();
        const start = code.selectionStart;
        code.setRangeText("  ", start, code.selectionEnd, "end");
        code.oninput();
      }
    };
    updateGutter(pou);
  }

  function graphicalBody(body) {
    return body.networks.map((network) => '<div class="network">' + network.nodes.map((node) =>
      '<div class="node"><b>' + escape(node.kind) + "</b><div>" + escape(node.symbol || node.instanceName || node.referencedPouId || node.nodeId) + "</div></div>").join("") + "</div>").join("");
  }

  function renderEditor() {
    const pou = activePou();
    const out = el("editor");
    if (!pou) { out.innerHTML = '<p class="muted">Crie um POU à esquerda.</p>'; return; }
    const code = el("code");
    const sameCode = code && out.dataset.pouId === pou.pouId && document.activeElement === code;
    const editingTable = out.dataset.pouId === pou.pouId && document.activeElement && el("variables") && el("variables").contains(document.activeElement);
    if (sameCode || editingTable) {
      // Não recria o campo em que o aluno está digitando (perderia cursor e seleção).
      if (sameCode) updateGutter(pou);
      return;
    }
    const body = pou.implementation;
    const textual = body.language === "st" || body.language === "il";
    const sfc = body.language === "sfc";
    const ld = body.language === "ld";
    const fbd = body.language === "fbd";
    const interfaceKey = JSON.stringify(pou.interface);
    if (out.dataset.pouId === pou.pouId && out.dataset.interfaceKey === interfaceKey) {
      // Só o diagrama mudou: o editor gráfico se atualiza sem recriar a tabela de variáveis.
      if (sfc && el("sfcEditor")) { window.IecSfc.render(el("sfcEditor"), pou, sfcContext(pou)); return; }
      if (ld && el("ldEditor")) { window.IecLd.render(el("ldEditor"), pou, ldContext(pou)); return; }
      if (fbd && el("fbdEditor")) { window.IecFbd.render(el("fbdEditor"), pou, fbdContext(pou)); return; }
    }
    out.dataset.pouId = pou.pouId;
    out.dataset.interfaceKey = interfaceKey;
    out.innerHTML =
      '<h1>' + escape(pou.name) + ' <span class="badge">' + KIND_LABELS[pou.kind] + " · " + body.language.toUpperCase() + "</span></h1>" +
      "<h2>Variáveis</h2>" + variablesTable(pou) +
      "<h2>" + (textual ? "Código" : sfc ? "SFC" : ld ? "Ladder" : fbd ? "FBD" : "Rede") + "</h2>" +
      (textual ? codeEditor(pou) : sfc ? '<div id="sfcEditor" class="sfc"></div>' : ld ? '<div id="ldEditor" class="ld"></div>' : fbd ? '<div id="fbdEditor" class="fbd"></div>'
        : graphicalBody(body) + '<p class="muted">Editor gráfico desta linguagem: etapa seguinte.</p>');
    bindVariables(pou);
    if (textual) bindCode(pou);
    if (sfc) window.IecSfc.render(el("sfcEditor"), pou, sfcContext(pou));
    if (ld) window.IecLd.render(el("ldEditor"), pou, ldContext(pou));
    if (fbd) window.IecFbd.render(el("fbdEditor"), pou, fbdContext(pou));
    out.ondragover = (event) => event.preventDefault();
    out.ondrop = (event) => { event.preventDefault(); insert(event.dataTransfer.getData("text/pou-id")); };
  }

  function graphProblems(pou) {
    return [
      ...((payload && payload.graphProblems) || []).filter((item) => item.pouId === pou.pouId),
      ...(build.diagnostics || []).filter((item) => item.pouId === pou.pouId && item.elementId),
    ];
  }

  /** Problemas, biblioteca de blocos e fluxo de energia do LD deste POU para o editor gráfico. */
  function ldContext(pou) {
    return {
      post,
      variables: pou.interface.variables,
      problems: graphProblems(pou),
      library: (payload && payload.blockLibrary) || {},
      power: monitor && monitor.ld && monitor.ld.pouId === pou.pouId ? monitor.ld.power : undefined,
      rerender: () => { el("editor").dataset.pouId = ""; renderEditor(); },
    };
  }

  /** Problemas e monitor do SFC deste POU para o editor gráfico. */
  function sfcContext(pou) {
    const problems = graphProblems(pou);
    const state = monitor && monitor.sfc ? Object.fromEntries(Object.entries(monitor.sfc).filter(([, value]) => value.pouId === pou.pouId)) : undefined;
    return { post, variables: pou.interface.variables, problems, monitor: state };
  }

  function fbdContext(pou) {
    return { post, symbols: payload.symbols, rerender: () => { el("editor").dataset.pouId = ""; renderEditor(); } };
  }

  function revealElement(pouId, elementId) {
    window.IecSfc.select(pouId, elementId);
    window.IecLd.select(pouId, elementId);
    const out = el("editor");
    out.dataset.pouId = "";
    select(pouId);
    window.IecFbd.select(pouId, elementId);
  }

  function revealLine(pouId, line) {
    select(pouId);
    const code = el("code");
    if (!code || !line) return;
    const lines = code.value.split("\n");
    let start = 0;
    for (let index = 0; index < line - 1 && index < lines.length; index += 1) start += lines[index].length + 1;
    const end = start + (lines[line - 1] || "").length;
    code.focus();
    code.setSelectionRange(start, end);
    code.scrollTop = Math.max(0, (line - 4) * 18);
  }

  // ---------------------------------------------------------------- problemas e status
  function renderProblems() {
    const items = [
      ...(payload ? payload.diagnostics.map((item) => ({ severity: "error", message: item.message, pouId: item.pouId })) : []),
      ...((payload && payload.graphProblems) || []),
      ...(build.diagnostics || []),
    ];
    const pouName = (id) => { const pou = payload && payload.project.pous.find((item) => item.pouId === id); return pou ? pou.name : ""; };
    el("problems").innerHTML = items.length === 0 ? '<span class="muted">Nenhum.</span>' : items.map((item, index) =>
      '<div class="problem ' + escape(item.severity) + '" data-problem="' + index + '">' +
      '<span class="sev">' + (item.severity === "warning" ? "aviso" : "erro") + "</span> " +
      (item.pouId ? "<b>" + escape(item.pouName || pouName(item.pouId)) + (item.line ? ":" + item.line + (item.column ? ":" + item.column : "") : "") + "</b> " : "") +
      (item.elementLabel ? "(" + escape(item.elementLabel) + ") " : "") +
      (item.variableName ? "(variável " + escape(item.variableName) + ") " : "") +
      '<span class="msg">' + escape(item.message) + "</span></div>").join("");
    el("problems").querySelectorAll("[data-problem]").forEach((row) => {
      const item = items[Number(row.dataset.problem)];
      if (item && item.pouId) row.onclick = () => item.elementId ? revealElement(item.pouId, item.elementId) : revealLine(item.pouId, item.line);
    });
  }

  function renderStatus() {
    const status = el("status");
    el("compile").disabled = build.state === "running";
    if (build.state === "running") { status.className = "status running"; status.textContent = "Compilando… (ST → C++ → executável)"; return; }
    if (build.state !== "done") { status.className = "status"; status.textContent = "Ainda não compilado"; return; }
    if (!build.ok) {
      const errors = (build.diagnostics || []).filter((item) => item.severity !== "warning").length;
      status.className = "status bad";
      status.textContent = "Falhou: " + errors + " erro(s)";
      return;
    }
    status.className = "status ok";
    status.textContent = "Compilado" + (build.cached ? " (sem mudanças)" : " em " + (build.durationMs / 1000).toFixed(1) + " s") +
      " · " + build.programName + ": " + build.inputs + " entrada(s), " + build.outputs + " saída(s) · " +
      (build.taskName || "tarefa") + " a cada " + build.taskIntervalMs + " ms";
    status.title = "STruCpp " + (build.strucpp || "") + " · " + (build.toolchain || "");
  }

  // ---------------------------------------------------------------- monitor
  function renderMonitor() {
    const box = el("monitor");
    if (!monitor || monitor.instances.length === 0) {
      monitorSignature = "";
      box.innerHTML = '<p class="muted">Nenhum CLP com este projeto no Core. No esquemático, coloque o bloco "PLC IEC 61131-3", escolha este projeto em Propriedades e rode a simulação.</p>';
      return;
    }
    const signature = monitor.selectedInstanceId + "|" + monitor.instances.map((item) => item.instanceId).join(",") + "|" +
      monitor.variables.map((item) => item.qualifiedName + ":" + item.iecType).join(",");
    if (signature !== monitorSignature) {
      monitorSignature = signature;
      box.innerHTML =
        (monitor.instances.length > 1
          ? '<label>Bloco<select id="monitorInstance">' + monitor.instances.map((item) =>
            '<option value="' + escape(item.instanceId) + '"' + (item.instanceId === monitor.selectedInstanceId ? " selected" : "") + ">" + escape(item.label) + "</option>").join("") + "</select></label>"
          : '<div class="muted">' + escape(monitor.instances[0].label) + "</div>") +
        '<div id="simState" class="muted"></div>' +
        '<table class="watch"><thead><tr><th>Variável</th><th>Valor</th><th>Escrever / forçar</th></tr></thead><tbody>' +
        monitor.variables.map((variable) => {
          const isBool = variable.iecType === "BOOL";
          const editor = isBool
            ? '<button data-act="force" data-value="TRUE">TRUE</button><button data-act="force" data-value="FALSE">FALSE</button>'
            : '<input class="val" data-input placeholder="valor"/><button data-act="set">Escrever</button><button data-act="force">Forçar</button>';
          return '<tr data-var="' + escape(variable.qualifiedName) + '">' +
            '<td><b>' + escape(variable.name) + '</b> <span class="badge">' + escape(variable.iecType) + "</span>" +
            '<div class="muted small">' + (variable.role === "input" ? "entrada" : variable.role === "output" ? "saída" : "local") + "</div></td>" +
            '<td class="value" data-value-cell></td>' +
            '<td class="actions">' + editor + '<button data-act="unforce" title="Liberar o forçamento">Liberar</button></td></tr>';
        }).join("") +
        "</tbody></table>" +
        '<button id="plcReset" title="Partida a frio: descarta todos os valores de runtime">Cold Reset</button>' +
        '<button id="plcWarmReset" title="Reinicia o programa e preserva variáveis RETAIN">Warm Reset</button>';
      if (el("monitorInstance")) el("monitorInstance").onchange = () => post({ type: "selectInstance", instanceId: el("monitorInstance").value });
      el("plcReset").onclick = () => post({ type: "monitorReset", instanceId: monitor.selectedInstanceId });
      el("plcWarmReset").onclick = () => post({ type: "monitorReset", instanceId: monitor.selectedInstanceId, mode: "warm" });
      box.querySelectorAll("tr[data-var]").forEach((row) => {
        row.querySelectorAll("[data-act]").forEach((button) => {
          button.onclick = () => {
            const input = row.querySelector("[data-input]");
            const value = button.dataset.value || (input ? input.value.trim() : "");
            if (button.dataset.act !== "unforce" && value === "") return;
            post({ type: "monitorWrite", instanceId: monitor.selectedInstanceId, qualifiedName: row.dataset.var, value, mode: button.dataset.act });
          };
        });
      });
    }
    const running = { running: "rodando", paused: "pausada", stopped: "parada" }[monitor.simulationStatus] || monitor.simulationStatus;
    if (el("simState")) el("simState").textContent = "Simulação " + running + ".";
    box.querySelectorAll("tr[data-var]").forEach((row) => {
      const name = row.dataset.var;
      const cell = row.querySelector("[data-value-cell]");
      const forced = Object.prototype.hasOwnProperty.call(monitor.forced, name);
      const value = monitor.errors[name] ? "erro" : (monitor.values[name] ?? "");
      cell.innerHTML = '<span class="v' + (value === "TRUE" ? " on" : "") + '">' + escape(value) + "</span>" + (forced ? ' <span class="badge forced" title="Forçado">F</span>' : "");
      cell.title = monitor.errors[name] || "";
    });
  }

  // ---------------------------------------------------------------- navegador de blocos
  function insert(pouId) {
    if (activeId && pouId) post({ type: "insertReference", callerPouId: activeId, targetPouId: pouId });
  }

  function renderBrowser() {
    const query = el("search").value.toLowerCase();
    el("browser").innerHTML = payload.symbols
      .filter((symbol) => symbol.kind !== "program" && symbol.qualifiedName.toLowerCase().includes(query))
      .map((symbol) => '<button class="item" draggable="true" data-insert="' + escape(symbol.pouId) + '">' + escape(symbol.qualifiedName) +
        ' <span class="badge">' + escape(symbol.kind) + (symbol.extensible ? " · variádico" : "") + "</span></button>").join("");
    el("browser").querySelectorAll("[data-insert]").forEach((button) => {
      button.onclick = () => insert(button.dataset.insert);
      button.ondragstart = (event) => event.dataTransfer.setData("text/pou-id", button.dataset.insert);
    });
  }

  function render() {
    if (!payload) return;
    renderExplorer();
    renderConfiguration();
    renderEditor();
    renderProblems();
    renderStatus();
    renderBrowser();
  }

  el("compile").onclick = () => {
    const code = el("code");
    const pou = activePou();
    // Texto ainda não enviado (digitado há menos de 0,5 s) vai junto antes de compilar.
    if (code && pou && textTimer) { clearTimeout(textTimer); textTimer = undefined; post({ type: "updateText", pouId: pou.pouId, text: code.value }); }
    post({ type: "compile" });
  };
  el("search").oninput = () => payload && renderBrowser();

  window.addEventListener("message", (event) => {
    const message = event.data;
    if (message.type === "project") { payload = message; render(); }
    else if (message.type === "error") { el("editor").innerHTML = '<div class="error">' + escape(message.message) + "</div>"; }
    else if (message.type === "build") {
      build = message;
      renderStatus();
      if (message.state === "done") {
        renderProblems();
        const pou = activePou();
        if (pou) updateGutter(pou);
        const firstError = (message.diagnostics || []).find((item) => item.severity !== "warning" && item.pouId);
        if (firstError && firstError.line) revealLine(firstError.pouId, firstError.line);
      }
    } else if (message.type === "notice") {
      const notice = el("notice");
      notice.textContent = message.message;
      notice.className = "notice" + (message.error ? " bad" : "");
      setTimeout(() => { if (notice.textContent === message.message) notice.textContent = ""; }, 8000);
    } else if (message.type === "monitor") {
      monitor = message;
      renderMonitor();
      const pou = activePou();
      if (pou && el("sfcEditor")) window.IecSfc.updateMonitor(el("sfcEditor"), sfcContext(pou).monitor);
      if (pou && el("ldEditor")) window.IecLd.updateMonitor(el("ldEditor"), ldContext(pou).power);
    }
  });
  post({ type: "ready" });
})();
