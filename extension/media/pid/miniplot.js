/*
 * Mini-Plotly do diálogo de sintonia PID (LasecSimul). Substitui o plotly-2.30.0.min.js (3,6 MB) pelo
 * subconjunto que o pid_dialog usa: newPlot, relayout (dragmode, autorange, shapes), restyle (visible,
 * limpar x/y) e extendTraces. SVG próprio, sem eval nem estilos inline gerados por string.
 * Mantém as estruturas que os cursores do diálogo leem: gd.data[i].x/y, gd._fullLayout.{xaxis,yaxis,yaxis2}.range
 * e o retângulo `.cartesianlayer .subplot.xy .plot` da área do gráfico.
 */
(function () {
  "use strict";
  const NS = "http://www.w3.org/2000/svg";
  const el = (name, attrs, parent) => {
    const node = document.createElementNS(NS, name);
    for (const key in attrs) node.setAttribute(key, String(attrs[key]));
    if (parent) parent.appendChild(node);
    return node;
  };
  const niceStep = (span, count) => {
    const raw = Math.abs(span) / (count || 6);
    const power = Math.pow(10, Math.floor(Math.log10(raw || 1)));
    const unit = raw / power;
    return (unit < 1.5 ? 1 : unit < 3.5 ? 2 : unit < 7.5 ? 5 : 10) * power;
  };
  const fmt = (v) => Number(v.toPrecision(6)).toLocaleString("pt-BR", { maximumFractionDigits: 3 });

  function extent(gd, traceIndexes) {
    let lo = Infinity, hi = -Infinity;
    for (const i of traceIndexes) {
      const t = gd.data[i];
      if (!t || !t.visible) continue;
      for (const v of t.y) if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
    }
    if (!Number.isFinite(lo)) return [0, 1];
    if (lo === hi) { lo -= 1; hi += 1; }
    const pad = (hi - lo) * 0.06;
    return [lo - pad, hi + pad];
  }

  function autorange(gd) {
    const fl = gd._fullLayout;
    if (gd.auto.x) {
      let lo = Infinity, hi = -Infinity;
      for (const t of gd.data) for (const v of t.x) if (Number.isFinite(v)) { if (v < lo) lo = v; if (v > hi) hi = v; }
      fl.xaxis.range = Number.isFinite(lo) ? (lo === hi ? [lo - 1, hi + 1] : [lo, hi]) : [0, 1];
    }
    const left = gd.data.map((t, i) => (t.yaxis === "y2" ? -1 : i)).filter((i) => i >= 0);
    const right = gd.data.map((t, i) => (t.yaxis === "y2" ? i : -1)).filter((i) => i >= 0);
    if (gd.auto.y) fl.yaxis.range = extent(gd, left);
    if (gd.auto.y2) fl.yaxis2.range = extent(gd, right);
  }

  function render(gd) {
    gd.frame = 0;
    const box = gd.el.getBoundingClientRect();
    const W = Math.max(200, box.width || 600), H = Math.max(160, box.height || 320);
    const m = gd.layout.margin || { l: 60, r: 60, t: 6, b: 48 };
    const pw = W - m.l - m.r, ph = H - m.t - m.b;
    autorange(gd);
    const fl = gd._fullLayout;
    const [x0, x1] = fl.xaxis.range, [y0, y1] = fl.yaxis.range, [z0, z1] = fl.yaxis2.range;
    const sx = (v) => m.l + ((v - x0) / (x1 - x0)) * pw;
    const sy = (v) => m.t + ph - ((v - y0) / (y1 - y0)) * ph;
    const sz = (v) => m.t + ph - ((v - z0) / (z1 - z0)) * ph;
    gd.scale = { sx, sy, sz, m, pw, ph };
    const svg = gd.svg;
    svg.setAttribute("viewBox", "0 0 " + W + " " + H);
    svg.setAttribute("width", W);
    svg.setAttribute("height", H);
    while (svg.firstChild) svg.removeChild(svg.firstChild);
    const cartesian = el("g", { class: "cartesianlayer" }, svg);
    const subplot = el("g", { class: "subplot xy" }, cartesian);
    el("rect", { class: "plot", x: m.l, y: m.t, width: pw, height: ph, fill: "#ffffff", stroke: "#90a4ae" }, subplot);
    const grid = el("g", {}, svg);
    const xs = niceStep(x1 - x0, 8);
    for (let v = Math.ceil(x0 / xs) * xs; v <= x1 + xs * 1e-9; v += xs) {
      el("line", { x1: sx(v), y1: m.t, x2: sx(v), y2: m.t + ph, stroke: "#eceff1" }, grid);
      el("text", { x: sx(v), y: m.t + ph + 16, "text-anchor": "middle", "font-size": 11, fill: "#546e7a" }, grid).textContent = fmt(v);
    }
    const ys = niceStep(y1 - y0, 6);
    for (let v = Math.ceil(y0 / ys) * ys; v <= y1 + ys * 1e-9; v += ys) {
      el("line", { x1: m.l, y1: sy(v), x2: m.l + pw, y2: sy(v), stroke: "#eceff1" }, grid);
      el("text", { x: m.l - 6, y: sy(v) + 4, "text-anchor": "end", "font-size": 11, fill: "#546e7a" }, grid).textContent = fmt(v);
    }
    const zs = niceStep(z1 - z0, 6);
    for (let v = Math.ceil(z0 / zs) * zs; v <= z1 + zs * 1e-9; v += zs) {
      el("text", { x: m.l + pw + 6, y: sz(v) + 4, "text-anchor": "start", "font-size": 11, fill: "#8d6e63" }, grid).textContent = fmt(v);
    }
    const titles = gd.layout;
    el("text", { x: m.l + pw / 2, y: H - 8, "text-anchor": "middle", "font-size": 12, fill: "#37474f" }, grid).textContent = (titles.xaxis && titles.xaxis.title && titles.xaxis.title.text) || "";
    el("text", { x: 14, y: m.t + ph / 2, "text-anchor": "middle", "font-size": 12, fill: "#37474f", transform: "rotate(-90 14 " + (m.t + ph / 2) + ")" }, grid).textContent = (titles.yaxis && titles.yaxis.title && titles.yaxis.title.text) || "";
    el("text", { x: W - 12, y: m.t + ph / 2, "text-anchor": "middle", "font-size": 12, fill: "#8d6e63", transform: "rotate(90 " + (W - 12) + " " + (m.t + ph / 2) + ")" }, grid).textContent = (titles.yaxis2 && titles.yaxis2.title && titles.yaxis2.title.text) || "";
    const clip = el("clipPath", { id: gd.clipId }, svg);
    el("rect", { x: m.l, y: m.t, width: pw, height: ph }, clip);
    const traces = el("g", { "clip-path": "url(#" + gd.clipId + ")" }, svg);
    for (const t of gd.data) {
      if (!t.visible || t.x.length === 0) continue;
      const scaleY = t.yaxis === "y2" ? sz : sy;
      let d = "";
      for (let i = 0; i < t.x.length; i++) {
        const X = sx(t.x[i]), Y = scaleY(t.y[i]);
        if (!Number.isFinite(X) || !Number.isFinite(Y)) continue;
        d += (d ? "L" : "M") + X.toFixed(1) + " " + Y.toFixed(1);
      }
      el("path", { d, fill: "none", stroke: (t.line && t.line.color) || "#1976d2", "stroke-width": (t.line && t.line.width) || 2, "stroke-dasharray": t.line && t.line.dash === "dot" ? "2 3" : "none", "data-trace": t.name }, traces);
    }
    for (const s of gd.layout.shapes || []) {
      const X0 = s.xref === "paper" ? m.l + s.x0 * pw : sx(s.x0), X1 = s.xref === "paper" ? m.l + s.x1 * pw : sx(s.x1);
      const Y0 = s.yref === "paper" ? m.t + ph - s.y0 * ph : sy(s.y0), Y1 = s.yref === "paper" ? m.t + ph - s.y1 * ph : sy(s.y1);
      el("line", { x1: X0, y1: Y0, x2: X1, y2: Y1, stroke: (s.line && s.line.color) || "#455a64", "stroke-width": (s.line && s.line.width) || 2, "stroke-dasharray": s.line && s.line.dash === "dot" ? "3 3" : "none", "data-shape": s.name || "" }, traces);
    }
    if (gd.layout.showlegend !== false) {
      const legend = el("g", {}, svg);
      const visible = gd.data;
      const lx = m.l + pw - 70, ly = m.t + ph - 14 - visible.length * 16;
      el("rect", { x: lx - 8, y: ly - 4, width: 76, height: visible.length * 16 + 8, fill: "#ffffff", stroke: "#cfd8dc" }, legend);
      visible.forEach((t, i) => {
        el("line", { x1: lx, y1: ly + i * 16 + 6, x2: lx + 18, y2: ly + i * 16 + 6, stroke: (t.line && t.line.color) || "#333", "stroke-width": 2, opacity: t.visible ? 1 : 0.3 }, legend);
        el("text", { x: lx + 24, y: ly + i * 16 + 10, "font-size": 11, fill: "#263238", opacity: t.visible ? 1 : 0.4 }, legend).textContent = t.name;
      });
    }
  }

  function schedule(gd) { if (!gd.frame) gd.frame = requestAnimationFrame(() => render(gd)); }

  function bindInteraction(gd) {
    let drag = null;
    gd.svg.addEventListener("pointerdown", (e) => {
      if (!gd.scale) return;
      const r = gd.svg.getBoundingClientRect();
      drag = { x: e.clientX, y: e.clientY, left: r.left, range: gd._fullLayout.xaxis.range.slice() };
    });
    gd.svg.addEventListener("pointermove", (e) => {
      if (!drag || gd.dragmode !== "pan") return;
      const dx = e.clientX - drag.x;
      if (Math.abs(dx) < 2) return;
      const span = drag.range[1] - drag.range[0], shift = (-dx / gd.scale.pw) * span;
      gd.auto.x = false;
      gd._fullLayout.xaxis.range = [drag.range[0] + shift, drag.range[1] + shift];
      schedule(gd);
    });
    gd.svg.addEventListener("pointerup", (e) => {
      if (drag && gd.dragmode === "zoom" && gd.scale && Math.abs(e.clientX - drag.x) > 6) {
        const toData = (px) => { const { m, pw } = gd.scale; const [a, b] = gd._fullLayout.xaxis.range; return a + ((px - drag.left - m.l) / pw) * (b - a); };
        const a = toData(Math.min(drag.x, e.clientX)), b = toData(Math.max(drag.x, e.clientX));
        gd.auto.x = false;
        gd._fullLayout.xaxis.range = [a, b];
        schedule(gd);
      }
      drag = null;
    });
    gd.svg.addEventListener("wheel", (e) => {
      if (!gd.scale) return;
      e.preventDefault();
      const r = gd.svg.getBoundingClientRect(), { m, pw } = gd.scale, [a, b] = gd._fullLayout.xaxis.range;
      const at = a + ((e.clientX - r.left - m.l) / pw) * (b - a), k = e.deltaY > 0 ? 1.2 : 1 / 1.2;
      gd.auto.x = false;
      gd._fullLayout.xaxis.range = [at + (a - at) * k, at + (b - at) * k];
      schedule(gd);
    }, { passive: false });
    new ResizeObserver(() => schedule(gd)).observe(gd.el);
  }

  let counter = 0;
  window.Plotly = {
    /** Identifica a implementação (testes e diagnóstico): não é o Plotly. */
    miniplot: true,
    newPlot(container, traces, layout) {
      container.textContent = "";
      const svg = el("svg", { role: "img", "aria-label": "PV, SP e MV no tempo" }, container);
      svg.style.display = "block";
      const gd = {
        el: container, svg, clipId: "mp-clip-" + (++counter), frame: 0, dragmode: layout.dragmode || "pan",
        data: traces.map((t) => ({ name: t.name, x: t.x.slice(), y: t.y.slice(), line: t.line, yaxis: t.yaxis, visible: t.visible !== "legendonly" && t.visible !== false })),
        layout: { ...layout, shapes: (layout.shapes || []).slice() },
        auto: { x: true, y: true, y2: true },
        _fullLayout: { xaxis: { range: [0, 1] }, yaxis: { range: [0, 1] }, yaxis2: { range: [0, 1] } },
        querySelector: (sel) => svg.querySelector(sel),
        addEventListener: (type, fn) => svg.addEventListener(type, fn),
      };
      container.__miniplot = gd; // testes e diagnóstico: o estado do gráfico a partir do elemento
      bindInteraction(gd);
      render(gd);
      return Promise.resolve(gd);
    },
    relayout(gd, update) {
      for (const key in update) {
        const value = update[key];
        if (key === "dragmode") gd.dragmode = value;
        else if (key === "shapes") gd.layout.shapes = value.slice();
        else if (key === "xaxis.autorange") gd.auto.x = Boolean(value);
        else if (key === "yaxis.autorange") gd.auto.y = Boolean(value);
        else if (key === "yaxis2.autorange") gd.auto.y2 = Boolean(value);
      }
      schedule(gd);
      return Promise.resolve(gd);
    },
    restyle(gd, update, indexes) {
      const targets = indexes || gd.data.map((_, i) => i);
      targets.forEach((i, k) => {
        const t = gd.data[i];
        if (!t) return;
        if ("visible" in update) t.visible = update.visible === true;
        if (update.x) t.x = (update.x[k] || []).slice();
        if (update.y) t.y = (update.y[k] || []).slice();
      });
      schedule(gd);
      return Promise.resolve(gd);
    },
    extendTraces(gd, update, indexes, maxPoints) {
      indexes.forEach((i, k) => {
        const t = gd.data[i];
        if (!t) return;
        for (const v of update.x[k]) t.x.push(v);
        for (const v of update.y[k]) t.y.push(v);
        if (maxPoints && t.x.length > maxPoints) { t.x.splice(0, t.x.length - maxPoints); t.y.splice(0, t.y.length - maxPoints); }
      });
      schedule(gd);
      return Promise.resolve(gd);
    },
  };
})();
