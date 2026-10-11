// Editor gráfico de SFC (IEC 61131-3 3ª ed., seção 6.7). Usado por editor.js.
// Representação da norma: passo = retângulo (inicial com borda dupla), transição = traço horizontal
// com a condição, divergência/convergência seletiva = linha simples, simultânea = linha dupla, salto
// = seta com o nome do passo de destino, bloco de ação = qualificador | ação | duração à direita do passo.
(function () {
  "use strict";

  const COL = 270;
  const LEVEL = 46;
  const STEP_W = 96;
  const STEP_H = 34;
  const TR_W = 44;
  const LEFT = 30;
  const TOP = 16;
  const QUALIFIERS = ["N", "R", "S", "L", "D", "P", "P1", "P0", "SD", "DS", "SL"];
  const TIMED = new Set(["L", "D", "SD", "DS", "SL"]);
  const SVG = "http://www.w3.org/2000/svg";

  let selection; // { pouId, id }
  let lastMonitor; // último estado dos passos recebido do monitor

  const escape = (value) => String(value ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" })[c]);

  function ends(transition) {
    return {
      from: transition.fromStepIds || (transition.fromStepId ? [transition.fromStepId] : []),
      to: transition.toStepIds || (transition.toStepId ? [transition.toStepId] : []),
    };
  }

  /** Cópia do corpo com transições sempre em fromStepIds/toStepIds e lista de ações. */
  function normalize(body) {
    const copy = JSON.parse(JSON.stringify(body));
    copy.actions = copy.actions || [];
    copy.transitions = copy.transitions.map((transition) => {
      const { from, to } = ends(transition);
      const next = { ...transition, fromStepIds: from, toStepIds: to };
      delete next.fromStepId;
      delete next.toStepId;
      return next;
    });
    return copy;
  }

  function uniqueId(prefix, used) {
    let index = 1;
    while (used.has(`${prefix}-${index}`)) index += 1;
    return `${prefix}-${index}`;
  }

  function uniqueStepName(body) {
    const used = new Set(body.steps.map((step) => step.name.toUpperCase()));
    let index = 1;
    while (used.has(`S${index}`)) index += 1;
    return `S${index}`;
  }

  function orderedOutgoing(body, stepId) {
    return body.transitions
      .map((transition, index) => ({ transition, index }))
      .filter((item) => ends(item.transition).from.includes(stepId))
      .sort((a, b) => (a.transition.priority ?? Infinity) - (b.transition.priority ?? Infinity) || a.index - b.index)
      .map((item) => item.transition);
  }

  // ------------------------------------------------------------------------------------ layout

  function layout(body) {
    const level = new Map();
    const column = new Map();
    const nextFree = new Map();
    const jumps = new Set();
    const place = (id, lvl, desired) => {
      const col = Math.max(desired, nextFree.get(lvl) ?? 0);
      column.set(id, col);
      level.set(id, lvl);
      nextFree.set(lvl, col + 1);
    };
    const initial = body.steps.find((step) => step.initial) || body.steps[0];
    const queue = [];
    if (initial) { place(initial.stepId, 0, 0); queue.push(initial.stepId); }
    const visit = () => {
      while (queue.length > 0) {
        const stepId = queue.shift();
        orderedOutgoing(body, stepId).forEach((transition, branch) => {
          if (level.has(transition.transitionId)) return;
          const { from, to } = ends(transition);
          if (!from.every((id) => level.has(id))) return; // convergência: espera todos os ramos
          const lvl = Math.max(...from.map((id) => level.get(id))) + 1;
          const desired = Math.min(...from.map((id) => column.get(id))) + (from.length === 1 ? branch : 0);
          place(transition.transitionId, lvl, desired);
          to.forEach((targetId, index) => {
            if (!body.steps.some((step) => step.stepId === targetId)) return;
            if (level.has(targetId)) {
              if (level.get(targetId) <= lvl) jumps.add(`${transition.transitionId}>${targetId}`);
              return;
            }
            place(targetId, lvl + 1, column.get(transition.transitionId) + index);
            queue.push(targetId);
          });
        });
      }
    };
    visit();
    // Passos ainda sem lugar (inalcançáveis): ao lado, um abaixo do outro.
    let extra = Math.max(0, ...[...column.values()]) + 1;
    for (const step of body.steps) {
      if (level.has(step.stepId)) continue;
      place(step.stepId, 0, extra++);
      queue.push(step.stepId);
      visit();
    }
    for (const transition of body.transitions) {
      if (level.has(transition.transitionId)) continue;
      const { from } = ends(transition);
      const placed = from.filter((id) => level.has(id));
      place(transition.transitionId, placed.length ? Math.max(...placed.map((id) => level.get(id))) + 1 : 1,
        placed.length ? column.get(placed[0]) : extra++);
      for (const targetId of ends(transition).to) if (level.has(targetId) && level.get(targetId) <= level.get(transition.transitionId)) jumps.add(`${transition.transitionId}>${targetId}`);
    }
    const x = (id) => LEFT + column.get(id) * COL;
    const y = (id) => TOP + level.get(id) * LEVEL;
    return { level, column, jumps, x, y };
  }

  // ------------------------------------------------------------------------------------ desenho

  function node(name, attributes, parent, text) {
    const element = document.createElementNS(SVG, name);
    for (const [key, value] of Object.entries(attributes)) element.setAttribute(key, String(value));
    if (text !== undefined) element.textContent = text;
    if (parent) parent.appendChild(element);
    return element;
  }

  function polyline(parent, points, className) {
    return node("polyline", { points: points.map((point) => point.join(",")).join(" "), class: className || "sfc-line" }, parent);
  }

  function draw(svg, body, geometry, ctx) {
    const { x, y, jumps } = geometry;
    const stepById = new Map(body.steps.map((step) => [step.stepId, step]));
    const problemIds = new Set((ctx.problems || []).map((item) => item.elementId).filter(Boolean));
    const selected = selection && selection.pouId === ctx.pouId ? selection.id : undefined;
    let width = 0;
    let height = 0;
    const grow = (px, py) => { width = Math.max(width, px + 40); height = Math.max(height, py + 40); };

    // Ligações primeiro (ficam por baixo).
    for (const transition of body.transitions) {
      if (!geometry.level.has(transition.transitionId)) continue;
      const { from, to } = ends(transition);
      const tx = x(transition.transitionId) + STEP_W / 2;
      const ty = y(transition.transitionId) + STEP_H / 2;
      const sources = from.filter((id) => stepById.has(id));
      if (sources.length > 1) {
        // Convergência simultânea: linha dupla acima da transição.
        const xs = sources.map((id) => x(id) + STEP_W / 2);
        const barY = ty - 16;
        for (const id of sources) polyline(svg, [[x(id) + STEP_W / 2, y(id) + STEP_H], [x(id) + STEP_W / 2, barY - 3]]);
        polyline(svg, [[Math.min(...xs, tx) - 6, barY - 3], [Math.max(...xs, tx) + 6, barY - 3]], "sfc-line sfc-double");
        polyline(svg, [[Math.min(...xs, tx) - 6, barY + 1], [Math.max(...xs, tx) + 6, barY + 1]], "sfc-line sfc-double");
        polyline(svg, [[tx, barY + 1], [tx, ty]]);
      } else if (sources.length === 1) {
        const sx = x(sources[0]) + STEP_W / 2;
        const sy = y(sources[0]) + STEP_H;
        const midY = sy + (ty - sy) / 2;
        // Divergência seletiva: linha simples saindo do passo para cada transição.
        polyline(svg, sx === tx ? [[sx, sy], [tx, ty]] : [[sx, sy], [sx, midY], [tx, midY], [tx, ty]]);
      }
      const targets = to.filter((id) => stepById.has(id) && !jumps.has(`${transition.transitionId}>${id}`));
      if (targets.length > 1) {
        // Divergência simultânea: linha dupla abaixo da transição.
        const xs = targets.map((id) => x(id) + STEP_W / 2);
        const barY = ty + 16;
        polyline(svg, [[tx, ty], [tx, barY - 3]]);
        polyline(svg, [[Math.min(...xs, tx) - 6, barY - 3], [Math.max(...xs, tx) + 6, barY - 3]], "sfc-line sfc-double");
        polyline(svg, [[Math.min(...xs, tx) - 6, barY + 1], [Math.max(...xs, tx) + 6, barY + 1]], "sfc-line sfc-double");
        for (const id of targets) polyline(svg, [[x(id) + STEP_W / 2, barY + 1], [x(id) + STEP_W / 2, y(id)]]);
      } else if (targets.length === 1) {
        const id = targets[0];
        const sx = x(id) + STEP_W / 2;
        const sy = y(id);
        const midY = ty + (sy - ty) / 2;
        polyline(svg, sx === tx ? [[tx, ty], [sx, sy]] : [[tx, ty], [tx, midY], [sx, midY], [sx, sy]]);
      }
      // Salto: seta para baixo com o nome do passo de destino.
      const jumpTargets = to.filter((id) => jumps.has(`${transition.transitionId}>${id}`));
      jumpTargets.forEach((id, index) => {
        const jx = tx + index * 60;
        polyline(svg, [[tx, ty], [tx, ty + 8], [jx, ty + 8], [jx, ty + 22]]);
        node("polygon", { points: `${jx - 5},${ty + 20} ${jx + 5},${ty + 20} ${jx},${ty + 28}`, class: "sfc-arrow" }, svg);
        node("text", { x: jx + 8, y: ty + 30, class: "sfc-jump" }, svg, stepById.get(id).name);
        grow(jx + 60, ty + 34);
      });
    }

    // Transições.
    for (const transition of body.transitions) {
      if (!geometry.level.has(transition.transitionId)) continue;
      const tx = x(transition.transitionId) + STEP_W / 2;
      const ty = y(transition.transitionId) + STEP_H / 2;
      const group = node("g", { class: "sfc-transition" + (selected === transition.transitionId ? " selected" : "") + (problemIds.has(transition.transitionId) ? " bad" : ""),
        "data-id": transition.transitionId }, svg);
      node("rect", { x: tx - TR_W / 2 - 4, y: ty - 9, width: TR_W + 8 + 170, height: 18, class: "sfc-hit" }, group);
      node("line", { x1: tx - TR_W / 2, y1: ty, x2: tx + TR_W / 2, y2: ty, class: "sfc-bar" }, group);
      const condition = (transition.condition || "").trim() || "?";
      node("text", { x: tx + TR_W / 2 + 8, y: ty + 4, class: "sfc-condition" }, group, condition.length > 30 ? condition.slice(0, 29) + "…" : condition);
      if (transition.priority !== undefined && transition.priority !== null && transition.priority !== "") {
        node("text", { x: tx - TR_W / 2 - 22, y: ty + 4, class: "sfc-priority" }, group, `(${transition.priority})`);
      }
      grow(tx + TR_W / 2 + 200, ty);
    }

    // Passos e blocos de ação.
    for (const step of body.steps) {
      const sx = x(step.stepId);
      const sy = y(step.stepId);
      const group = node("g", { class: "sfc-step" + (selected === step.stepId ? " selected" : "") + (problemIds.has(step.stepId) ? " bad" : ""),
        "data-id": step.stepId, "data-name": step.name.toUpperCase() }, svg);
      node("rect", { x: sx, y: sy, width: STEP_W, height: STEP_H, class: "sfc-box" }, group);
      if (step.initial) node("rect", { x: sx + 4, y: sy + 4, width: STEP_W - 8, height: STEP_H - 8, class: "sfc-box-inner" }, group);
      node("text", { x: sx + STEP_W / 2, y: sy + STEP_H / 2 + 5, class: "sfc-name", "text-anchor": "middle" }, group, step.name);
      node("text", { x: sx + STEP_W / 2, y: sy + STEP_H + 12, class: "sfc-time", "text-anchor": "middle" }, group, "");
      (step.actions || []).forEach((association, index) => {
        const ax = sx + STEP_W + 14;
        const ay = sy + index * 18;
        if (index === 0) node("line", { x1: sx + STEP_W, y1: sy + 9, x2: ax, y2: sy + 9, class: "sfc-line" }, group);
        const qualifier = association.qualifier || "N";
        const name = association.actionName || association.instanceName || (association.text ? "(código)" : "?");
        const timed = TIMED.has(qualifier);
        node("rect", { x: ax, y: ay, width: 28, height: 18, class: "sfc-action-cell" }, group);
        node("text", { x: ax + 14, y: ay + 13, class: "sfc-action-text", "text-anchor": "middle" }, group, qualifier);
        node("rect", { x: ax + 28, y: ay, width: 104, height: 18, class: "sfc-action-cell" }, group);
        node("text", { x: ax + 33, y: ay + 13, class: "sfc-action-text" }, group, name.length > 14 ? name.slice(0, 13) + "…" : name);
        if (timed) {
          node("rect", { x: ax + 132, y: ay, width: 56, height: 18, class: "sfc-action-cell" }, group);
          node("text", { x: ax + 136, y: ay + 13, class: "sfc-action-text" }, group, association.time || "?");
        }
        grow(ax + 190, ay + 18);
      });
      grow(sx + STEP_W, sy + STEP_H + 14);
    }
    svg.setAttribute("width", String(Math.max(width, 400)));
    svg.setAttribute("height", String(Math.max(height, 120)));
  }

  // ------------------------------------------------------------------------------------ edição

  function commit(ctx, body) {
    ctx.post({ type: "updateSfc", pouId: ctx.pouId, body });
  }

  function addStepAfter(body, stepId) {
    const usedSteps = new Set(body.steps.map((step) => step.stepId));
    const usedTransitions = new Set(body.transitions.map((transition) => transition.transitionId));
    const newStep = { stepId: uniqueId("step", usedSteps), name: uniqueStepName(body), actions: [] };
    body.steps.push(newStep);
    body.transitions.push({ transitionId: uniqueId("tr", usedTransitions), fromStepIds: [stepId], toStepIds: [newStep.stepId], condition: "TRUE" });
    return newStep.stepId;
  }

  function removeStep(body, stepId) {
    body.steps = body.steps.filter((step) => step.stepId !== stepId);
    body.transitions = body.transitions
      .map((transition) => ({ ...transition, fromStepIds: transition.fromStepIds.filter((id) => id !== stepId), toStepIds: transition.toStepIds.filter((id) => id !== stepId) }))
      .filter((transition) => transition.fromStepIds.length > 0 && transition.toStepIds.length > 0);
  }

  function stepChecklist(body, selectedIds, field) {
    return '<div class="sfc-checks">' + body.steps.map((step) =>
      `<label class="inline"><input type="checkbox" data-${field}="${escape(step.stepId)}"${selectedIds.includes(step.stepId) ? " checked" : ""}/> ${escape(step.name)}</label>`).join("") + "</div>";
  }

  function actionNames(body, variables) {
    const booleans = variables.filter((variable) => variable.class !== "input" && String(variable.type).toUpperCase() === "BOOL").map((variable) => variable.name);
    return [...body.actions.map((action) => action.name), ...booleans];
  }

  function stepPanel(body, step, ctx) {
    const rows = (step.actions || []).map((association, index) => {
      const qualifier = association.qualifier || "N";
      return `<tr data-row="${index}">` +
        `<td><select data-field="qualifier">${QUALIFIERS.map((q) => `<option${q === qualifier ? " selected" : ""}>${q}</option>`).join("")}</select></td>` +
        `<td><input data-field="actionName" list="sfcActionNames" value="${escape(association.actionName || association.instanceName || "")}" placeholder="ação ou variável BOOL"/></td>` +
        `<td><input data-field="time" value="${escape(association.time || "")}" placeholder="${TIMED.has(qualifier) ? "T#5s" : "—"}"${TIMED.has(qualifier) ? "" : " disabled"}/></td>` +
        `<td><button class="icon" data-remove-action="${index}" title="Remover">✕</button></td></tr>`;
    }).join("");
    return `<h3>Passo ${escape(step.name)}</h3>` +
      `<label>Nome<input id="sfcStepName" value="${escape(step.name)}"/></label>` +
      `<label class="inline"><input type="checkbox" id="sfcStepInitial"${step.initial ? " checked" : ""}/> passo inicial</label>` +
      `<datalist id="sfcActionNames">${actionNames(body, ctx.variables).map((name) => `<option value="${escape(name)}"></option>`).join("")}</datalist>` +
      `<table class="vars"><thead><tr><th>Qualif.</th><th>Ação</th><th>Duração</th><th></th></tr></thead><tbody id="sfcAssociations">${rows}</tbody></table>` +
      `<div class="row"><button id="sfcAddAssociation">+ Bloco de ação</button><button id="sfcAddStep">+ Transição e passo abaixo</button><button id="sfcDeleteStep">Excluir passo</button></div>` +
      `<p class="muted">Outra transição a partir deste passo cria uma divergência seletiva (prioridade da esquerda para a direita, ou numerada).</p>`;
  }

  function transitionPanel(body, transition) {
    return `<h3>Transição</h3>` +
      `<label>Condição (expressão ST; pode usar PASSO.X e PASSO.T)<input id="sfcCondition" value="${escape(transition.condition || "")}"/></label>` +
      `<label>Prioridade na divergência seletiva (vazio = esquerda para a direita)<input id="sfcPriority" type="number" min="1" step="1" value="${escape(transition.priority ?? "")}"/></label>` +
      `<div class="sfc-cols"><div><b>Passos antes</b> (mais de um = convergência simultânea)${stepChecklist(body, transition.fromStepIds, "from")}</div>` +
      `<div><b>Passos depois</b> (mais de um = divergência simultânea; passo acima = salto)${stepChecklist(body, transition.toStepIds, "to")}</div></div>` +
      `<div class="row"><button id="sfcParallel">+ Ramo paralelo (novo passo depois)</button><button id="sfcDeleteTransition">Excluir transição</button></div>`;
  }

  function actionsPanel(body) {
    return `<h3>Ações</h3>` + body.actions.map((action, index) =>
      `<div class="sfc-action" data-action="${index}">` +
      `<div class="row"><input data-field="name" value="${escape(action.name)}"/>` +
      `<select data-field="language"><option value="st"${action.language === "st" ? " selected" : ""}>ST</option><option value="il"${action.language === "il" ? " selected" : ""}>IL</option></select>` +
      `<button class="icon" data-remove="${index}" title="Excluir ação">✕</button></div>` +
      `<textarea data-field="text" spellcheck="false">${escape(action.text)}</textarea></div>`).join("") +
      `<button id="sfcAddAction">+ Ação</button>` +
      `<p class="muted">Ação de código executa enquanto o ACTION_CONTROL dá A (Q ou a última execução quando Q cai); use NOME.Q para saber se é a última. Uma variável BOOL usada como ação recebe Q.</p>`;
  }

  function bindPanels(container, body, ctx) {
    const el = (id) => container.querySelector("#" + id);
    const selected = selection && selection.pouId === ctx.pouId ? selection.id : undefined;
    const step = body.steps.find((item) => item.stepId === selected);
    const transition = body.transitions.find((item) => item.transitionId === selected);
    if (step) {
      el("sfcStepName").onchange = () => { step.name = el("sfcStepName").value.trim(); commit(ctx, body); };
      el("sfcStepInitial").onchange = () => {
        // A norma pede exatamente um passo inicial: marcar um desmarca os outros.
        if (el("sfcStepInitial").checked) for (const other of body.steps) other.initial = other.stepId === step.stepId ? true : undefined;
        else step.initial = undefined;
        for (const other of body.steps) if (!other.initial) delete other.initial;
        commit(ctx, body);
      };
      container.querySelectorAll("#sfcAssociations tr[data-row]").forEach((row) => {
        const association = step.actions[Number(row.dataset.row)];
        row.querySelectorAll("[data-field]").forEach((input) => {
          input.onchange = () => {
            const value = input.value.trim();
            if (input.dataset.field === "qualifier") association.qualifier = value;
            else if (value) association[input.dataset.field] = value;
            else delete association[input.dataset.field];
            if (!TIMED.has(association.qualifier || "N")) delete association.time;
            delete association.text; delete association.referencedPouId; delete association.instanceName;
            commit(ctx, body);
          };
        });
      });
      container.querySelectorAll("[data-remove-action]").forEach((button) => {
        button.onclick = () => { step.actions.splice(Number(button.dataset.removeAction), 1); commit(ctx, body); };
      });
      el("sfcAddAssociation").onclick = () => {
        const used = new Set(step.actions.map((item) => item.actionId));
        step.actions.push({ actionId: uniqueId("assoc", used), qualifier: "N", actionName: "" });
        commit(ctx, body);
      };
      el("sfcAddStep").onclick = () => { selection = { pouId: ctx.pouId, id: addStepAfter(body, step.stepId) }; commit(ctx, body); };
      el("sfcDeleteStep").onclick = () => { removeStep(body, step.stepId); selection = undefined; commit(ctx, body); };
    }
    if (transition) {
      el("sfcCondition").onchange = () => { transition.condition = el("sfcCondition").value; commit(ctx, body); };
      el("sfcPriority").onchange = () => {
        const value = el("sfcPriority").value.trim();
        if (value) transition.priority = Math.max(1, Math.round(Number(value))); else delete transition.priority;
        commit(ctx, body);
      };
      container.querySelectorAll("[data-from],[data-to]").forEach((box) => {
        box.onchange = () => {
          const field = box.dataset.from ? "fromStepIds" : "toStepIds";
          const id = box.dataset.from || box.dataset.to;
          transition[field] = box.checked ? [...new Set([...transition[field], id])] : transition[field].filter((item) => item !== id);
          commit(ctx, body);
        };
      });
      el("sfcParallel").onclick = () => {
        const used = new Set(body.steps.map((item) => item.stepId));
        const newStep = { stepId: uniqueId("step", used), name: uniqueStepName(body), actions: [] };
        body.steps.push(newStep);
        transition.toStepIds.push(newStep.stepId);
        selection = { pouId: ctx.pouId, id: newStep.stepId };
        commit(ctx, body);
      };
      el("sfcDeleteTransition").onclick = () => {
        body.transitions = body.transitions.filter((item) => item !== transition);
        selection = undefined;
        commit(ctx, body);
      };
    }
    container.querySelectorAll(".sfc-action[data-action]").forEach((box) => {
      const action = body.actions[Number(box.dataset.action)];
      box.querySelectorAll("[data-field]").forEach((input) => {
        input.onchange = () => { action[input.dataset.field] = input.dataset.field === "name" ? input.value.trim() : input.value; commit(ctx, body); };
        if (input.tagName === "TEXTAREA") input.onkeydown = (event) => {
          if (event.key === "Tab") { event.preventDefault(); input.setRangeText("  ", input.selectionStart, input.selectionEnd, "end"); }
        };
      });
    });
    container.querySelectorAll("[data-remove]").forEach((button) => {
      button.onclick = () => { body.actions.splice(Number(button.dataset.remove), 1); commit(ctx, body); };
    });
    el("sfcAddAction").onclick = () => {
      const used = new Set(body.actions.map((action) => action.name.toUpperCase()));
      let index = 1;
      while (used.has(`ACAO${index}`)) index += 1;
      body.actions.push({ name: `ACAO${index}`, language: "st", text: "" });
      commit(ctx, body);
    };
  }

  function render(container, pou, ctx) {
    const body = normalize(pou.implementation);
    ctx.pouId = pou.pouId;
    const focusInside = document.activeElement && container.contains(document.activeElement) && document.activeElement.tagName !== "BUTTON";
    if (!container.querySelector(".sfc-canvas") || container.dataset.pouId !== pou.pouId || !focusInside) {
      const selected = selection && selection.pouId === pou.pouId ? selection.id : undefined;
      const step = body.steps.find((item) => item.stepId === selected);
      const transition = body.transitions.find((item) => item.transitionId === selected);
      container.dataset.pouId = pou.pouId;
      container.innerHTML =
        `<div class="row"><button id="sfcAddLoose" title="Passo solto, para ligar depois por uma transição">+ Passo</button>` +
        `<span class="muted">Clique num passo ou numa transição para editar.</span></div>` +
        `<div class="sfc-canvas"><svg class="sfc-svg"></svg></div>` +
        `<div id="sfcProps" class="sfc-props">${step ? stepPanel(body, step, ctx) : transition ? transitionPanel(body, transition) : ""}</div>` +
        `<div class="sfc-actions">${actionsPanel(body)}</div>`;
      container.querySelector("#sfcAddLoose").onclick = () => {
        const used = new Set(body.steps.map((item) => item.stepId));
        const newStep = { stepId: uniqueId("step", used), name: uniqueStepName(body), actions: [], ...(body.steps.length === 0 ? { initial: true } : {}) };
        body.steps.push(newStep);
        selection = { pouId: pou.pouId, id: newStep.stepId };
        commit(ctx, body);
      };
      bindPanels(container, body, ctx);
    }
    const svg = container.querySelector(".sfc-svg");
    svg.innerHTML = "";
    draw(svg, body, layout(body), ctx);
    svg.querySelectorAll("[data-id]").forEach((group) => {
      group.onclick = () => {
        selection = { pouId: pou.pouId, id: group.dataset.id };
        container.dataset.pouId = "";
        render(container, pou, ctx);
      };
    });
    updateMonitor(container, ctx.monitor || lastMonitor);
  }

  /** Passos ativos em verde e o tempo do passo (PASSO.T) embaixo, sem redesenhar. */
  function updateMonitor(container, sfcState) {
    lastMonitor = sfcState;
    container.querySelectorAll(".sfc-step").forEach((group) => {
      const state = sfcState && sfcState[group.dataset.name];
      group.classList.toggle("active", Boolean(state && state.active));
      const time = group.querySelector(".sfc-time");
      if (time) time.textContent = state && state.active ? state.time : "";
    });
  }

  function select(pouId, id) {
    selection = { pouId, id };
  }

  window.IecSfc = { render, updateMonitor, select };
})();
