// Editor FBD: grafo por redes, ligações formais nomeadas e POU browser comum.
(function () {
  "use strict";
  const esc = value => String(value ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]);
  const operators = ["AND", "OR", "XOR", "NOT", "ADD", "SUB", "MUL", "DIV", "MOD", "EQ", "NE", "GT", "GE", "LT", "LE", "NEG"];
  function id(prefix, values) { let n = values.length + 1; while (values.some(value => value.nodeId === `${prefix}-${n}` || value.edgeId === `${prefix}-${n}`)) n++; return `${prefix}-${n}`; }
  function render(root, pou, context) {
    const networks = pou.implementation.networks;
    const post = (value) => context.post({ type: "updateFbd", pouId: pou.pouId, networks: value });
    const ports = (node, direction) => {
      if (node.kind === "block") {
        const symbol = context.symbols.find(item => item.pouId === node.referencedPouId);
        if (!symbol) return [];
        if (symbol.kind === "function") return direction === "output" ? ["OUT", symbol.displayName] : symbol.extensible
          ? ["IN1", "IN2", "IN3", "IN4", "IN5", "IN6", "IN7", "IN8"]
          : symbol.interface.variables.filter(variable => variable.class === "input").map(variable => variable.name);
        return symbol.interface.variables.filter(variable => direction === "input"
          ? variable.class === "input" || variable.class === "inOut"
          : variable.class === "output" || variable.class === "inOut").map(variable => variable.name);
      }
      if (node.kind === "operator") return direction === "input" ? ["A", "B", "C", "D", "E", "F", "G", "H"] : ["OUT"];
      if (node.kind === "junction") return direction === "input" ? ["IN"] : ["OUT"];
      if (node.kind === "output" || node.kind === "coil") return direction === "input" ? ["IN"] : [];
      return direction === "input" ? [] : ["OUT"];
    };
    const portSelect = (node, direction, selected) => {
      const values = ports(node, direction);
      return '<select data-port>' + ['<option value="">porta</option>', ...values.map(value => `<option${value === selected ? " selected" : ""}>${esc(value)}</option>`)].join("") + '</select>';
    };
    root.innerHTML = '<div class="fbd-tools"><label>Operador novo<select id="fbdOperator">' + operators.map(op => `<option>${op}</option>`).join("") + '</select></label><button data-network="add">+ Rede</button></div>' +
      networks.map((network, ni) => {
        const nodes = network.nodes;
        const positions = new Map(nodes.map((node, index) => {
          const finite = value => Number.isFinite(Number(value));
          const x = finite(node.x) ? Math.max(12, Math.min(3000, Number(node.x))) : 35 + (index % 3) * 230;
          const y = finite(node.y) ? Math.max(12, Math.min(3000, Number(node.y))) : 35 + Math.floor(index / 3) * 145;
          return [node.nodeId, { x, y }];
        }));
        const width = Math.max(680, ...[...positions.values()].map(pos => pos.x + 220));
        const height = Math.max(220, ...[...positions.values()].map(pos => pos.y + 145));
        const wireSvg = network.edges.map(edge => {
          const from = positions.get(edge.fromNodeId), to = positions.get(edge.toNodeId);
          if (!from || !to) return "";
          const fromNode = nodes.find(node => node.nodeId === edge.fromNodeId), toNode = nodes.find(node => node.nodeId === edge.toNodeId);
          const sx = from.x + (fromNode?.kind === "junction" ? 9 : 190), sy = from.y + (fromNode?.kind === "junction" ? 9 : 44);
          const tx = to.x, ty = to.y + (toNode?.kind === "junction" ? 9 : 44);
          const bend = Math.max(36, Math.abs(tx - sx) * 0.45);
          return `<path class="fbd-edge${edge.feedback ? " fbd-feedback" : ""}" marker-end="url(#fbd-arrow-${ni})" d="M ${sx} ${sy} C ${sx + bend} ${sy}, ${tx - bend} ${ty}, ${tx} ${ty}"/><text class="fbd-edge-label" x="${(sx + tx) / 2}" y="${(sy + ty) / 2 - 6}">${esc(edge.toPort || "")}</text>`;
        }).join("");
        const cards = nodes.map(node => {
          const pos = positions.get(node.nodeId);
          const detail = node.kind === "block" ? (context.symbols.find(symbol => symbol.pouId === node.referencedPouId)?.qualifiedName || node.referencedPouId) : node.kind === "operator" ? node.operator : node.symbol || "";
          if (node.kind === "junction") return `<div class="fbd-junction" draggable="true" title="Junção" data-node-card="${esc(node.nodeId)}" data-network-card="${esc(network.networkId)}" style="left:${pos.x}px;top:${pos.y}px"><button class="icon" data-remove-node="${esc(node.nodeId)}">×</button></div>`;
          return `<div class="fbd-node" draggable="true" data-node-card="${esc(node.nodeId)}" data-network-card="${esc(network.networkId)}" style="left:${pos.x}px;top:${pos.y}px"><header><b>${esc(node.kind.toUpperCase())}</b><span>${esc(detail)}</span><button class="icon" data-remove-node="${esc(node.nodeId)}">×</button></header>` +
            (node.kind === "input" || node.kind === "output" || node.kind === "contact" || node.kind === "coil"
              ? `<label>Variável / literal<input data-node-symbol="${esc(node.nodeId)}" value="${esc(node.symbol || "")}" placeholder="BOOL, literal ou variável"></label>` : "") +
            (node.kind === "operator" ? `<label>Operação<select data-node-operator="${esc(node.nodeId)}">${operators.map(op => `<option${op === node.operator ? " selected" : ""}>${op}</option>`).join("")}</select></label>` : "") +
            (node.kind === "block" && node.instanceName ? `<small>Instância: ${esc(node.instanceName)}</small>` : "") + '</div>';
        }).join("");
        const wires = network.edges.map(edge => {
          const from = nodes.find(node => node.nodeId === edge.fromNodeId);
          const to = nodes.find(node => node.nodeId === edge.toNodeId);
          return `<div class="fbd-wire"><select data-edge-from="${esc(edge.edgeId)}">${nodes.map(node => `<option value="${esc(node.nodeId)}"${node.nodeId === edge.fromNodeId ? " selected" : ""}>${esc(node.nodeId)} · ${esc(node.symbol || node.operator || node.instanceName || node.kind)}</option>`).join("")}</select>` +
            portSelect(from || {}, "output", edge.fromPort) + '<span>→</span>' +
            `<select data-edge-to="${esc(edge.edgeId)}">${nodes.map(node => `<option value="${esc(node.nodeId)}"${node.nodeId === edge.toNodeId ? " selected" : ""}>${esc(node.nodeId)} · ${esc(node.symbol || node.operator || node.instanceName || node.kind)}</option>`).join("")}</select>` +
            portSelect(to || {}, "input", edge.toPort) + `<label><input type="checkbox" data-edge-feedback="${esc(edge.edgeId)}"${edge.feedback ? " checked" : ""}> atraso 1 scan</label>${edge.feedback ? `<input data-feedback-initial="${esc(edge.edgeId)}" value="${esc(edge.feedbackInitialValue ?? "")}" placeholder="inicial">` : ""}<button class="icon" data-remove-edge="${esc(edge.edgeId)}">×</button></div>`;
        }).join("");
        return `<section class="fbd-network"><header><b>Rede ${ni + 1}</b><button data-add-network-node="input" data-network-index="${ni}">+ Entrada</button><button data-add-network-node="output" data-network-index="${ni}">+ Saída</button><button data-add-network-node="operator" data-network-index="${ni}">+ Operador</button><button data-add-network-node="junction" data-network-index="${ni}">+ Junção</button><button data-add-edge="${ni}"${nodes.length < 2 ? " disabled" : ""}>+ Ligação</button><button class="icon" data-remove-network="${ni}"${networks.length < 2 ? " disabled" : ""}>Excluir rede</button></header><div class="fbd-canvas" data-canvas-network="${esc(network.networkId)}" style="width:${width}px;height:${height}px"><svg class="fbd-wires" width="${width}" height="${height}" aria-hidden="true"><defs><marker id="fbd-arrow-${ni}" markerWidth="8" markerHeight="8" refX="6" refY="3" orient="auto"><path d="M0,0 L0,6 L7,3 z"/></marker></defs>${wireSvg}</svg>${cards || '<span class="muted fbd-empty">Arraste um POU da biblioteca ou crie nós nesta rede.</span>'}</div><h3>Ligações</h3>${wires || '<span class="muted">Nenhuma ligação.</span>'}</section>`;
      }).join("");
    const commit = (mutate) => { const next = structuredClone(networks); mutate(next); post(next); };
    root.querySelectorAll("[data-add-network-node]").forEach(button => button.onclick = () => commit(next => {
      const network = next[Number(button.dataset.networkIndex)];
      if (!network) return;
      const kind = button.dataset.addNetworkNode;
      if (kind === "operator") network.nodes.push({ nodeId: id("node", network.nodes), kind, operator: root.querySelector("#fbdOperator").value });
      else if (kind === "junction") network.nodes.push({ nodeId: id("node", network.nodes), kind });
      else network.nodes.push({ nodeId: id("node", network.nodes), kind, symbol: kind === "input" ? "X" : "Y" });
    }));
    root.querySelector("[data-network=add]").onclick = () => commit(next => next.push({ networkId: id("network", next.map(item => ({ nodeId: item.networkId }))), nodes: [], edges: [] }));
    root.querySelectorAll("[data-remove-network]").forEach(button => button.onclick = () => commit(next => next.splice(Number(button.dataset.removeNetwork), 1)));
    root.querySelectorAll("[data-remove-node]").forEach(button => button.onclick = () => commit(next => next.forEach(network => {
      network.nodes = network.nodes.filter(node => node.nodeId !== button.dataset.removeNode);
      network.edges = network.edges.filter(edge => edge.fromNodeId !== button.dataset.removeNode && edge.toNodeId !== button.dataset.removeNode);
    })));
    root.querySelectorAll("[data-remove-edge]").forEach(button => button.onclick = () => commit(next => next.forEach(network => network.edges = network.edges.filter(edge => edge.edgeId !== button.dataset.removeEdge))));
    root.querySelectorAll("[data-edge-feedback]").forEach(input => input.onchange = () => commit(next => next.forEach(network => { const edge = network.edges.find(item => item.edgeId === input.dataset.edgeFeedback); if (edge) { edge.feedback = input.checked; if (!input.checked) delete edge.feedbackInitialValue; } })));
    root.querySelectorAll("[data-feedback-initial]").forEach(input => input.onchange = () => commit(next => next.forEach(network => { const edge = network.edges.find(item => item.edgeId === input.dataset.feedbackInitial); if (edge) edge.feedbackInitialValue = input.value.trim(); })));
    root.querySelectorAll("[data-node-symbol]").forEach(input => input.onchange = () => commit(next => next.forEach(network => { const node = network.nodes.find(item => item.nodeId === input.dataset.nodeSymbol); if (node) node.symbol = input.value.trim(); })));
    root.querySelectorAll("[data-node-operator]").forEach(select => select.onchange = () => commit(next => next.forEach(network => { const node = network.nodes.find(item => item.nodeId === select.dataset.nodeOperator); if (node) node.operator = select.value; })));
    root.querySelectorAll("[data-add-edge]").forEach(button => button.onclick = () => commit(next => {
      const network = next[Number(button.dataset.addEdge)];
      network.edges.push({ edgeId: id("edge", network.edges), fromNodeId: network.nodes[0].nodeId, fromPort: network.nodes[0].kind === "operator" ? "OUT" : "OUT", toNodeId: network.nodes[1].nodeId, toPort: network.nodes[1].kind === "operator" ? "A" : "IN" });
    }));
    root.querySelectorAll("[data-edge-from],[data-edge-to]").forEach(select => select.onchange = () => commit(next => next.forEach(network => {
      const edge = network.edges.find(item => item.edgeId === select.dataset.edgeFrom || item.edgeId === select.dataset.edgeTo);
      if (!edge) return;
      if (select.dataset.edgeFrom) edge.fromNodeId = select.value;
      else edge.toNodeId = select.value;
      const node = network.nodes.find(item => item.nodeId === select.value);
      if (select.dataset.edgeFrom) edge.fromPort = node?.kind === "operator" ? "OUT" : "OUT";
      else edge.toPort = node?.kind === "operator" ? "A" : "IN";
    })));
    let draggedNode;
    root.querySelectorAll("[data-node-card]").forEach(card => {
      card.ondragstart = event => { draggedNode = { networkId: card.dataset.networkCard, nodeId: card.dataset.nodeCard }; event.dataTransfer.setData("application/fbd-node", card.dataset.nodeCard); event.dataTransfer.effectAllowed = "move"; };
    });
    root.querySelectorAll("[data-canvas-network]").forEach(canvas => {
      canvas.ondragover = event => { if (event.dataTransfer.types.includes("application/fbd-node") || event.dataTransfer.types.includes("text/pou-id")) event.preventDefault(); };
      canvas.ondrop = event => {
        event.preventDefault(); event.stopPropagation();
        const pouId = event.dataTransfer.getData("text/pou-id");
        if (pouId) { context.post({ type: "insertReference", callerPouId: pou.pouId, targetPouId: pouId }); return; }
        if (!draggedNode || draggedNode.networkId !== canvas.dataset.canvasNetwork) return;
        const bounds = canvas.getBoundingClientRect();
        const x = Math.max(12, Math.round(event.clientX - bounds.left - 95));
        const y = Math.max(12, Math.round(event.clientY - bounds.top - 24));
        const networkId = draggedNode.networkId, nodeId = draggedNode.nodeId;
        commit(next => {
          const network = next.find(item => item.networkId === networkId);
          const node = network?.nodes.find(item => item.nodeId === nodeId);
          if (node) { node.x = x; node.y = y; }
        });
        draggedNode = undefined;
      };
    });
    root.querySelectorAll(".fbd-wire").forEach(row => {
      const edgeId = row.querySelector("[data-edge-from]").dataset.edgeFrom;
      const network = networks.find(item => item.edges.some(edge => edge.edgeId === edgeId));
      const edge = network?.edges.find(item => item.edgeId === edgeId);
      row.querySelectorAll("[data-port]").forEach((select, index) => select.onchange = () => commit(next => {
        const current = next.flatMap(item => item.edges).find(item => item.edgeId === edgeId);
        if (current) { if (index === 0) current.fromPort = select.value; else current.toPort = select.value; }
      }));
    });
    root.ondragover = event => event.preventDefault();
    root.ondrop = event => { event.preventDefault(); event.stopPropagation(); const pouId = event.dataTransfer.getData("text/pou-id"); if (pouId) context.post({ type: "insertReference", callerPouId: pou.pouId, targetPouId: pouId }); };
  }
  function select(pouId, nodeId) {
    const card = document.querySelector(`[data-node-card="${CSS.escape(String(nodeId ?? ""))}"]`);
    if (!card) return;
    card.classList.add("selected");
    card.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    setTimeout(() => card.classList.remove("selected"), 1500);
  }
  window.IecFbd = { render, select };
})();
