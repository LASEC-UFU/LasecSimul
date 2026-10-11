// Editor gráfico de Ladder (IEC 61131-3 3ª ed., seção 8.2). Usado por editor.js.
// Rede = grade entre a barra de alimentação esquerda e a direita. Elementos das tabelas da norma:
// 74 (barras, ligação horizontal e vertical), 75 (contatos NA, NF, P, N, comparação), 76 (bobinas
// ( ), (/), (S), (R), (P), (N)), 18 (blocos com EN/ENO) e 73 (salto >>RÓTULO e <RETURN>).
(function () {
  "use strict";

  const CELL_W = 104;
  const CELL_H = 58;
  const RAIL = 22;
  const MID = 34; // y do fio dentro da célula
  const SVG = "http://www.w3.org/2000/svg";
  const CONTACTS = [["no", "┤ ├", "Contato normalmente aberto"], ["nc", "┤/├", "Contato normalmente fechado"],
    ["p", "┤P├", "Contato de transição positiva"], ["n", "┤N├", "Contato de transição negativa"]];
  const COILS = [["coil", "( )", "Bobina"], ["negated", "(/)", "Bobina negada"], ["set", "(S)", "Bobina set (com memória)"],
    ["reset", "(R)", "Bobina reset"], ["p", "(P)", "Bobina de transição positiva"], ["n", "(N)", "Bobina de transição negativa"]];
  const COMPARISONS = ["=", "<>", ">", ">=", "<", "<="];
  const COIL_MARK = { coil: "", negated: "/", set: "S", reset: "R", p: "P", n: "N" };

  let selection; // { pouId, rungId, row, column }
  let lastPower;

  const escape = (value) => String(value ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);
  const cellId = (rung, row, column) => `${rung.rungId}:${row}:${column}`;

  function normalize(rungs) {
    const copy = JSON.parse(JSON.stringify(rungs || []));
    for (const rung of copy) {
      rung.verticals = rung.verticals || [];
      if (!rung.rows || rung.rows.length === 0) rung.rows = [[]];
      const columns = Math.max(6, ...rung.rows.map((row) => row.length));
      rung.rows = rung.rows.map((row) => Array.from({ length: columns }, (_, index) => row[index] ?? null));
    }
    return copy;
  }

  function uniqueRungId(rungs) {
    const used = new Set(rungs.map((rung) => rung.rungId));
    let index = 1;
    while (used.has(`rung-${index}`)) index += 1;
    return `rung-${index}`;
  }

  function emptyRung(rungs) {
    return { rungId: uniqueRungId(rungs), rows: [[null, null, null, null, null, null]], verticals: [] };
  }

  function signatureOf(ctx, typeName) {
    return ctx.library ? ctx.library[String(typeName || "").trim().toUpperCase()] : undefined;
  }

  /** Pinos do bloco que não estão ligados ao degrau (ficam listados na caixa). */
  function blockPins(ctx, cell) {
    const signature = signatureOf(ctx, cell.typeName);
    const powerIn = (cell.powerInput || "EN").toUpperCase();
    const powerOut = (cell.powerOutput || "ENO").toUpperCase();
    const inputs = signature ? signature.inputs.map((pin) => pin.name) : Object.keys(cell.inputs || {});
    const extra = Object.keys(cell.inputs || {}).map((name) => name.toUpperCase()).filter((name) => !inputs.includes(name));
    const outputs = signature ? signature.outputs.map((pin) => pin.name) : Object.keys(cell.outputs || {});
    return {
      signature, powerIn, powerOut,
      inputs: [...inputs, ...extra].filter((name) => name !== powerIn),
      outputs: outputs.filter((name) => name !== powerOut),
    };
  }

  function blockHeight(ctx, cell) {
    const pins = blockPins(ctx, cell);
    return 30 + Math.max(pins.inputs.length, pins.outputs.length) * 14;
  }

  // ------------------------------------------------------------------------------------ desenho

  function node(name, attributes, parent, text) {
    const element = document.createElementNS(SVG, name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    if (text !== undefined) element.textContent = text;
    if (parent) parent.appendChild(element);
    return element;
  }

  function line(parent, x1, y1, x2, y2, className) {
    return node("line", { x1, y1, x2, y2, class: className || "ld-line" }, parent);
  }

  function label(parent, x, y, text, className, anchor) {
    const value = String(text ?? "");
    return node("text", { x, y, class: className || "ld-text", "text-anchor": anchor || "middle" }, parent, value.length > 15 ? value.slice(0, 14) + "…" : value);
  }

  function drawCell(group, cell, x, y, ctx) {
    const cy = y + MID;
    const cx = x + CELL_W / 2;
    if (cell.kind === "wire") { line(group, x, cy, x + CELL_W, cy); return; }
    if (cell.kind === "contact" || cell.kind === "compare") {
      const half = cell.kind === "compare" ? 30 : 12;
      line(group, x, cy, cx - half, cy);
      line(group, cx + half, cy, x + CELL_W, cy);
      line(group, cx - half, cy - 13, cx - half, cy + 13, "ld-line ld-strong");
      line(group, cx + half, cy - 13, cx + half, cy + 13, "ld-line ld-strong");
      if (cell.kind === "compare") {
        label(group, cx, cy + 4, `${cell.operator}${cell.dataType ? " " + cell.dataType : ""}`, "ld-text ld-mark");
        label(group, cx, y + 12, cell.left || "?");
        label(group, cx, cy + 26, cell.right || "?");
      } else {
        if (cell.contact === "nc") line(group, cx - 8, cy + 10, cx + 8, cy - 10, "ld-line");
        else if (cell.contact === "p" || cell.contact === "n") label(group, cx, cy + 4, cell.contact.toUpperCase(), "ld-text ld-mark");
        label(group, cx, y + 14, cell.variable || "?");
      }
      return;
    }
    if (cell.kind === "coil") {
      line(group, x, cy, cx - 13, cy);
      line(group, cx + 13, cy, x + CELL_W, cy);
      node("path", { d: `M ${cx - 7} ${cy - 13} Q ${cx - 19} ${cy} ${cx - 7} ${cy + 13}`, class: "ld-line ld-strong ld-nofill" }, group);
      node("path", { d: `M ${cx + 7} ${cy - 13} Q ${cx + 19} ${cy} ${cx + 7} ${cy + 13}`, class: "ld-line ld-strong ld-nofill" }, group);
      label(group, cx, cy + 4, COIL_MARK[cell.coil] ?? "", "ld-text ld-mark");
      label(group, cx, y + 14, cell.variable || "?");
      return;
    }
    if (cell.kind === "block") {
      const pins = blockPins(ctx, cell);
      const top = cy - 16;
      const height = blockHeight(ctx, cell);
      const left = x + 18;
      const width = CELL_W - 36;
      line(group, x, cy, left, cy);
      line(group, left + width, cy, x + CELL_W, cy);
      node("rect", { x: left, y: top, width, height, class: "ld-block" }, group);
      label(group, cx, top - 3, cell.instanceName || "", "ld-text");
      label(group, cx, top + 11, cell.typeName || "?", "ld-text ld-mark");
      label(group, left + 3, cy + 12, pins.powerIn, "ld-pin", "start");
      label(group, left + width - 3, cy + 12, pins.powerOut, "ld-pin", "end");
      pins.inputs.forEach((name, index) => {
        const py = cy + 26 + index * 14;
        label(group, left + 3, py, name, "ld-pin", "start");
        label(group, left - 3, py, (cell.inputs || {})[name] ?? (cell.inputs || {})[name.toLowerCase()] ?? "", "ld-value", "end");
      });
      pins.outputs.forEach((name, index) => {
        const py = cy + 26 + index * 14;
        label(group, left + width - 3, py, name, "ld-pin", "end");
        label(group, left + width + 3, py, (cell.outputs || {})[name] ?? "", "ld-value", "start");
      });
      return;
    }
    if (cell.kind === "jump") {
      line(group, x, cy, x + 24, cy);
      node("path", { d: `M ${x + 24} ${cy - 6} L ${x + 32} ${cy} L ${x + 24} ${cy + 6} M ${x + 32} ${cy - 6} L ${x + 40} ${cy} L ${x + 32} ${cy + 6}`, class: "ld-line ld-nofill" }, group);
      label(group, x + 44, cy + 4, cell.label || "?", "ld-text ld-mark", "start");
      return;
    }
    if (cell.kind === "return") {
      line(group, x, cy, x + 14, cy);
      label(group, x + 16, cy + 4, "<RETURN>", "ld-text ld-mark", "start");
    }
  }

  function drawRung(svg, rung, rungIndex, ctx) {
    const rows = rung.rows;
    const columns = rows[0].length;
    const problemIds = new Set((ctx.problems || []).map((item) => item.elementId).filter(Boolean));
    let height = rows.length * CELL_H;
    rows.forEach((row, rowIndex) => row.forEach((cell) => {
      if (cell && cell.kind === "block") height = Math.max(height, rowIndex * CELL_H + MID - 16 + blockHeight(ctx, cell) + 8);
    }));
    const width = RAIL + columns * CELL_W + RAIL;
    svg.setAttribute("width", String(width));
    svg.setAttribute("height", String(height));
    line(svg, RAIL, 0, RAIL, height, "ld-line ld-rail");
    line(svg, RAIL + columns * CELL_W, 0, RAIL + columns * CELL_W, height, "ld-line ld-rail");
    rows.forEach((row, rowIndex) => row.forEach((cell, column) => {
      const x = RAIL + column * CELL_W;
      const y = rowIndex * CELL_H;
      const id = cellId(rung, rowIndex, column);
      const isSelected = selection && selection.pouId === ctx.pouId && selection.rungId === rung.rungId && selection.row === rowIndex && selection.column === column;
      const group = node("g", { class: "ld-cell" + (cell ? "" : " empty") + (isSelected ? " selected" : "") + (problemIds.has(id) ? " bad" : ""),
        "data-id": id, "data-row": rowIndex, "data-column": column }, svg);
      node("rect", { x: x + 1, y: y + 1, width: CELL_W - 2, height: CELL_H - 2, class: "ld-hit" }, group);
      if (cell) drawCell(group, cell, x, y, ctx);
      // Bobina no fim da linha: ligação horizontal até a barra de alimentação direita.
      const last = row.reduce((found, item, index) => (item ? index : found), -1);
      if (cell && cell.kind === "coil" && column === last && column + 1 < columns) {
        line(group, x + CELL_W, y + MID, RAIL + columns * CELL_W, y + MID);
      }
    }));
    for (const link of rung.verticals) {
      if (link.row + 1 >= rows.length || link.column >= columns) continue;
      const x = RAIL + (link.column + 1) * CELL_W;
      // Estado da ligação vertical = OU das saídas de todas as linhas unidas nesta coluna.
      const joined = new Set([link.row, link.row + 1]);
      let grew = true;
      while (grew) {
        grew = false;
        for (const other of rung.verticals) {
          if (other.column !== link.column) continue;
          if (joined.has(other.row) !== joined.has(other.row + 1)) { joined.add(other.row); joined.add(other.row + 1); grew = true; }
        }
      }
      const members = [...joined].map((row) => cellId(rung, row, link.column)).join(" ");
      const group = node("g", { class: "ld-vertical", "data-members": members }, svg);
      line(group, x, link.row * CELL_H + MID, x, (link.row + 1) * CELL_H + MID, "ld-line");
    }
    node("text", { x: 2, y: 12, class: "ld-number" }, svg, String(rungIndex + 1));
  }

  // ------------------------------------------------------------------------------------ edição

  function commit(ctx, rungs) {
    ctx.post({ type: "updateLd", pouId: ctx.pouId, rungs });
  }

  function selectedCell(rungs, ctx) {
    if (!selection || selection.pouId !== ctx.pouId) return undefined;
    const rung = rungs.find((item) => item.rungId === selection.rungId);
    if (!rung) return undefined;
    return { rung, row: selection.row, column: selection.column, cell: (rung.rows[selection.row] || [])[selection.column] ?? null };
  }

  function boolNames(ctx) {
    return ctx.variables.filter((variable) => String(variable.type).toUpperCase() === "BOOL").map((variable) => variable.name);
  }

  function palette() {
    const button = (action, text, title) => `<button data-place="${action}" title="${escape(title)}">${escape(text)}</button>`;
    return '<div class="ld-palette">' +
      button("wire", "──", "Ligação horizontal") +
      CONTACTS.map(([kind, text, title]) => button(`contact:${kind}`, text, title)).join("") +
      button("compare", "┤<├", "Contato de comparação") +
      COILS.map(([kind, text, title]) => button(`coil:${kind}`, text, title)).join("") +
      button("block", "Bloco", "Função ou bloco de função (EN/ENO ou entrada/saída BOOL no degrau)") +
      button("jump", ">>", "Salto para o rótulo de uma rede") +
      button("return", "RET", "Retorno") +
      button("vertical", "│", "Ligação vertical: une a borda direita desta posição à da linha de baixo") +
      button("erase", "Apagar", "Esvazia a posição selecionada") +
      "</div>";
  }

  function propertiesPanel(found, ctx, rungs) {
    if (!found) return '<p class="muted">Clique numa posição da grade e escolha um elemento na paleta.</p>';
    const { cell } = found;
    if (!cell) return '<p class="muted">Posição vazia: escolha um elemento na paleta.</p>';
    const datalist = `<datalist id="ldBools">${boolNames(ctx).map((name) => `<option value="${escape(name)}"></option>`).join("")}</datalist>`;
    if (cell.kind === "contact" || cell.kind === "coil") {
      const kinds = cell.kind === "contact" ? CONTACTS : COILS;
      const current = cell.kind === "contact" ? cell.contact : cell.coil;
      return datalist + `<div class="row"><label>Variável BOOL<input id="ldVariable" list="ldBools" value="${escape(cell.variable)}"/></label>` +
        `<label>Tipo<select id="ldKind">${kinds.map(([kind, text, title]) => `<option value="${kind}"${kind === current ? " selected" : ""}>${escape(text)} ${escape(title)}</option>`).join("")}</select></label></div>`;
    }
    if (cell.kind === "compare") {
      return `<div class="row"><label>Operando esquerdo<input id="ldLeft" value="${escape(cell.left)}"/></label>` +
        `<label>Operador<select id="ldOperator">${COMPARISONS.map((op) => `<option${op === cell.operator ? " selected" : ""}>${escape(op)}</option>`).join("")}</select></label>` +
        `<label>Operando direito<input id="ldRight" value="${escape(cell.right)}"/></label>` +
        `<label>Tipo (contato tipado; vazio = sobrecarregado)<input id="ldDataType" value="${escape(cell.dataType || "")}" placeholder="INT"/></label></div>`;
    }
    if (cell.kind === "jump") {
      const labels = rungs.map((rung) => rung.label).filter(Boolean);
      return `<datalist id="ldLabels">${labels.map((name) => `<option value="${escape(name)}"></option>`).join("")}</datalist>` +
        `<label>Rótulo da rede de destino<input id="ldLabel" list="ldLabels" value="${escape(cell.label)}"/></label>`;
    }
    if (cell.kind === "block") {
      const pins = blockPins(ctx, cell);
      const signature = pins.signature;
      const types = Object.keys(ctx.library || {});
      const instances = ctx.variables.filter((variable) => String(variable.type).toUpperCase() === String(cell.typeName).toUpperCase()).map((variable) => variable.name);
      const boolIn = signature ? signature.inputs.filter((pin) => pin.type === "BOOL" || pin.type.startsWith("ANY")).map((pin) => pin.name) : [];
      const boolOut = signature ? signature.outputs.filter((pin) => pin.type === "BOOL" || pin.type.startsWith("ANY")).map((pin) => pin.name) : [];
      const option = (value, current) => `<option${value === current ? " selected" : ""}>${escape(value)}</option>`;
      const typeOf = (list, name) => { const pin = (list || []).find((item) => item.name === name); return pin ? pin.type : ""; };
      return `<datalist id="ldTypes">${types.map((name) => `<option value="${escape(name)}"></option>`).join("")}</datalist>` +
        `<datalist id="ldInstances">${instances.map((name) => `<option value="${escape(name)}"></option>`).join("")}</datalist>` +
        `<div class="row"><label>Função ou bloco<input id="ldType" list="ldTypes" value="${escape(cell.typeName)}"/></label>` +
        (signature && signature.kind === "function" ? "" : `<label>Instância (variável do tipo do bloco)<input id="ldInstance" list="ldInstances" value="${escape(cell.instanceName || "")}"/></label>`) +
        `<label>Entrada no degrau<select id="ldPowerIn">${["EN", ...boolIn].map((name) => option(name, pins.powerIn)).join("")}</select></label>` +
        `<label>Saída no degrau<select id="ldPowerOut">${["ENO", ...boolOut].map((name) => option(name, pins.powerOut)).join("")}</select></label></div>` +
        (signature ? "" : '<p class="error">Bloco desconhecido.</p>') +
        `<table class="vars"><thead><tr><th>Entrada</th><th>Tipo</th><th>Variável ou literal</th></tr></thead><tbody>` +
        pins.inputs.map((name) => `<tr><td>${escape(name)}</td><td class="muted">${escape(typeOf(signature && signature.inputs, name))}</td><td><input data-input="${escape(name)}" value="${escape((cell.inputs || {})[name] ?? "")}"/></td></tr>`).join("") +
        (signature && signature.extensible ? `<tr><td colspan="3"><button id="ldAddInput">+ Entrada</button></td></tr>` : "") +
        `</tbody></table>` +
        `<table class="vars"><thead><tr><th>Saída</th><th>Tipo</th><th>Variável</th></tr></thead><tbody>` +
        pins.outputs.map((name) => `<tr><td>${escape(name)}</td><td class="muted">${escape(typeOf(signature && signature.outputs, name))}</td><td><input data-output="${escape(name)}" value="${escape((cell.outputs || {})[name] ?? "")}"/></td></tr>`).join("") +
        `</tbody></table>`;
    }
    return "";
  }

  function place(rungs, ctx, action) {
    const found = selectedCell(rungs, ctx);
    if (!found) return false;
    const { rung, row, column } = found;
    const [kind, variant] = action.split(":");
    if (kind === "vertical") {
      const index = rung.verticals.findIndex((link) => link.row === row && link.column === column);
      if (index >= 0) rung.verticals.splice(index, 1);
      else {
        if (row + 1 >= rung.rows.length) rung.rows.push(rung.rows[0].map(() => null));
        rung.verticals.push({ row, column });
      }
      return true;
    }
    const previous = rung.rows[row][column];
    const variable = previous && (previous.kind === "contact" || previous.kind === "coil") ? previous.variable : "";
    let cell = null;
    if (kind === "wire") cell = { kind: "wire" };
    else if (kind === "contact") cell = { kind: "contact", contact: variant, variable };
    else if (kind === "coil") cell = { kind: "coil", coil: variant, variable };
    else if (kind === "compare") cell = { kind: "compare", operator: ">=", left: "", right: "" };
    else if (kind === "block") cell = { kind: "block", typeName: "TON", instanceName: "", powerInput: "IN", powerOutput: "Q", inputs: {}, outputs: {} };
    else if (kind === "jump") cell = { kind: "jump", label: "" };
    else if (kind === "return") cell = { kind: "return" };
    rung.rows[row][column] = cell;
    if (kind === "erase") rung.verticals = rung.verticals.filter((link) => !(link.row === row && link.column === column));
    return true;
  }

  function bind(container, rungs, ctx) {
    const found = selectedCell(rungs, ctx);
    container.querySelectorAll("[data-place]").forEach((button) => {
      button.onclick = () => { if (place(rungs, ctx, button.dataset.place)) commit(ctx, rungs); };
    });
    const el = (id) => container.querySelector("#" + id);
    const onChange = (id, apply) => { const input = el(id); if (input) input.onchange = () => { apply(input.value.trim()); commit(ctx, rungs); }; };
    if (found && found.cell) {
      const cell = found.cell;
      onChange("ldVariable", (value) => { cell.variable = value; });
      onChange("ldKind", (value) => { if (cell.kind === "contact") cell.contact = value; else cell.coil = value; });
      onChange("ldLeft", (value) => { cell.left = value; });
      onChange("ldRight", (value) => { cell.right = value; });
      onChange("ldOperator", (value) => { cell.operator = value; });
      onChange("ldDataType", (value) => { if (value) cell.dataType = value.toUpperCase(); else delete cell.dataType; });
      onChange("ldLabel", (value) => { cell.label = value; });
      onChange("ldType", (value) => {
        cell.typeName = value.toUpperCase();
        // Outro bloco: as ligações antigas deixam de valer; padrão é a primeira entrada/saída BOOL ou EN/ENO.
        const signature = signatureOf(ctx, cell.typeName);
        const boolIn = signature ? signature.inputs.find((pin) => pin.type === "BOOL") : undefined;
        const boolOut = signature ? signature.outputs.find((pin) => pin.type === "BOOL") : undefined;
        const isBlock = signature && signature.kind === "functionBlock";
        cell.powerInput = isBlock && boolIn ? boolIn.name : "EN";
        cell.powerOutput = isBlock && boolOut ? boolOut.name : "ENO";
        cell.inputs = {};
        cell.outputs = {};
        if (!isBlock) delete cell.instanceName;
      });
      onChange("ldInstance", (value) => { cell.instanceName = value; });
      onChange("ldPowerIn", (value) => { cell.powerInput = value; delete cell.inputs[value]; });
      onChange("ldPowerOut", (value) => { cell.powerOutput = value; delete cell.outputs[value]; });
      container.querySelectorAll("[data-input]").forEach((input) => {
        input.onchange = () => { const value = input.value.trim(); if (value) cell.inputs[input.dataset.input] = value; else delete cell.inputs[input.dataset.input]; commit(ctx, rungs); };
      });
      container.querySelectorAll("[data-output]").forEach((input) => {
        input.onchange = () => { const value = input.value.trim(); if (value) cell.outputs[input.dataset.output] = value; else delete cell.outputs[input.dataset.output]; commit(ctx, rungs); };
      });
      const addInput = el("ldAddInput");
      if (addInput) addInput.onclick = () => {
        let index = 1;
        const pins = blockPins(ctx, cell);
        while (pins.inputs.includes(`IN${index}`) || pins.powerIn === `IN${index}`) index += 1;
        cell.inputs[`IN${index}`] = "0";
        commit(ctx, rungs);
      };
    }
    container.querySelectorAll("[data-rung]").forEach((header) => {
      const rung = rungs.find((item) => item.rungId === header.dataset.rung);
      const index = rungs.indexOf(rung);
      header.querySelectorAll("[data-field]").forEach((input) => {
        input.onchange = () => { const value = input.value.trim(); if (value) rung[input.dataset.field] = value; else delete rung[input.dataset.field]; commit(ctx, rungs); };
      });
      header.querySelectorAll("[data-action]").forEach((button) => {
        button.onclick = () => {
          const action = button.dataset.action;
          if (action === "add") rungs.splice(index + 1, 0, emptyRung(rungs));
          else if (action === "delete") rungs.splice(index, 1);
          else if (action === "up" && index > 0) rungs.splice(index - 1, 0, rungs.splice(index, 1)[0]);
          else if (action === "down" && index + 1 < rungs.length) rungs.splice(index + 1, 0, rungs.splice(index, 1)[0]);
          else if (action === "row") rung.rows.push(rung.rows[0].map(() => null));
          else if (action === "column") rung.rows.forEach((row) => row.push(null));
          else if (action === "trim") {
            // Remove a última linha e a última coluna quando vazias.
            if (rung.rows.length > 1 && rung.rows[rung.rows.length - 1].every((cell) => !cell)) {
              rung.rows.pop();
              rung.verticals = rung.verticals.filter((link) => link.row + 1 < rung.rows.length);
            }
            if (rung.rows[0].length > 2 && rung.rows.every((row) => !row[row.length - 1])) rung.rows.forEach((row) => row.pop());
          }
          if (rungs.length === 0) rungs.push(emptyRung(rungs));
          commit(ctx, rungs);
        };
      });
    });
  }

  function render(container, pou, ctx) {
    ctx.pouId = pou.pouId;
    if (!pou.implementation.rungs) {
      container.innerHTML = '<p class="muted">Este POU está no formato antigo de LD (nós e arestas). </p><button id="ldConvert">Começar a editar em redes</button>';
      container.querySelector("#ldConvert").onclick = () => commit(ctx, [emptyRung([])]);
      return;
    }
    const rungs = normalize(pou.implementation.rungs);
    if (rungs.length === 0) rungs.push(emptyRung(rungs));
    const focusInside = document.activeElement && container.contains(document.activeElement) && document.activeElement.tagName !== "BUTTON";
    if (focusInside && container.dataset.pouId === pou.pouId) {
      // O aluno está digitando numa propriedade: só redesenha as redes.
      redraw(container, rungs, ctx);
      return;
    }
    container.dataset.pouId = pou.pouId;
    container.innerHTML = palette() +
      rungs.map((rung, index) =>
        `<div class="ld-rung" data-rung="${escape(rung.rungId)}">` +
        `<div class="ld-rung-head"><b>Rede ${index + 1}</b>` +
        `<input data-field="label" placeholder="rótulo" value="${escape(rung.label || "")}"/>` +
        `<input data-field="comment" class="wide" placeholder="comentário" value="${escape(rung.comment || "")}"/>` +
        `<button data-action="row" title="Mais uma linha">+ linha</button><button data-action="column" title="Mais uma coluna">+ coluna</button>` +
        `<button data-action="trim" title="Remove a última linha e a última coluna vazias">− vazias</button>` +
        `<button data-action="up" title="Sobe a rede">↑</button><button data-action="down" title="Desce a rede">↓</button>` +
        `<button data-action="add" title="Nova rede abaixo">+ rede</button><button data-action="delete" title="Exclui a rede">✕</button></div>` +
        `<div class="ld-canvas"><svg class="ld-svg" data-svg="${escape(rung.rungId)}"></svg></div></div>`).join("") +
      `<div id="ldProps" class="ld-props"></div>`;
    container.querySelector("#ldProps").innerHTML = propertiesPanel(selectedCell(rungs, ctx), ctx, rungs);
    bind(container, rungs, ctx);
    redraw(container, rungs, ctx);
  }

  function redraw(container, rungs, ctx) {
    rungs.forEach((rung, index) => {
      const svg = container.querySelector(`[data-svg="${rung.rungId}"]`);
      if (!svg) return;
      svg.innerHTML = "";
      drawRung(svg, rung, index, ctx);
      svg.querySelectorAll(".ld-cell").forEach((group) => {
        group.onclick = () => {
          selection = { pouId: ctx.pouId, rungId: rung.rungId, row: Number(group.dataset.row), column: Number(group.dataset.column) };
          container.dataset.pouId = "";
          if (ctx.rerender) ctx.rerender();
        };
      });
    });
    updateMonitor(container, ctx.power || lastPower);
  }

  /** Fluxo de energia: elementos cuja saída está ON em verde. */
  function updateMonitor(container, power) {
    lastPower = power;
    container.querySelectorAll(".ld-cell").forEach((group) => group.classList.toggle("on", Boolean(power && power[group.dataset.id])));
    container.querySelectorAll(".ld-vertical").forEach((group) =>
      group.classList.toggle("on", Boolean(power && group.dataset.members.split(" ").some((id) => power[id]))));
  }

  function select(pouId, id) {
    const parts = String(id).split(":");
    if (parts.length === 3) selection = { pouId, rungId: parts[0], row: Number(parts[1]), column: Number(parts[2]) };
  }

  window.IecLd = { render, updateMonitor, select };
})();
