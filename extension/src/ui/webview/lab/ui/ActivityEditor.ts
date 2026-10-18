import {
  ACTIVITY_KIND_LABEL, CALCULUS_LAB_SCHEMA_VERSION, STEP_PHASES, STEP_PHASE_LABEL, defaultActivity, isProcessActivity, validateCalculusLab,
  type ActivityStep, type CalculusLab, type FunctionsActivity, type LabActivity, type LabActivityKind, type LimitsActivity, type StepPhase,
} from "../activity.js";
import { parseExpression } from "../calc/ast.js";
import { astToMathML, escapeXml } from "../calc/mathml.js";
import { LAB_MESSAGE_VERSION, type LabAuditFinding, type LabProjectComponent, type LabToHostMessage } from "../messages.js";
import { PLANTS } from "../plants.js";
import { displayUnit } from "../units.js";
import { byId, clear, html } from "./dom.js";

const KINDS: readonly LabActivityKind[] = ["functions", "sensor", "limits", "axis", "firstOrder", "tank"];

/**
 * Editor de atividades (M6, docs/54): autoria sem programação sobre os mesmos tipos que o laboratório
 * executa. Trabalha numa cópia; "Gravar no projeto" valida com `validateCalculusLab` e envia o
 * laboratório inteiro. Desfazer/refazer é do documento (Host). Achados da auditoria aparecem na
 * atividade com as ações religar/remover -- nunca falha silenciosa.
 */
export class ActivityEditor {
  private draft: LabActivity[];
  private selected = 0;
  private history = { canUndo: false, canRedo: false };

  constructor(private readonly root: HTMLElement, lab: CalculusLab, private components: LabProjectComponent[], private findings: LabAuditFinding[],
              private readonly send: (message: LabToHostMessage) => void, private readonly close: () => void) {
    this.draft = structuredClone(lab.activities);
    this.render();
  }

  setProject(components: LabProjectComponent[], findings: LabAuditFinding[]): void {
    this.components = components;
    this.findings = findings;
    this.render();
  }

  setHistory(canUndo: boolean, canRedo: boolean): void {
    this.history = { canUndo, canRedo };
    const undo = document.getElementById("edUndo") as HTMLButtonElement | null, redo = document.getElementById("edRedo") as HTMLButtonElement | null;
    if (undo) undo.disabled = !canUndo;
    if (redo) redo.disabled = !canRedo;
  }

  /** Laboratório que seria gravado (exposto para testes e para o botão gravar). */
  lab(): CalculusLab { return { schemaVersion: CALCULUS_LAB_SCHEMA_VERSION, activities: structuredClone(this.draft) }; }

  private uniqueId(base: string): string {
    let id = base, n = 2;
    while (this.draft.some((a) => a.id === id)) id = `${base}-${n++}`;
    return id;
  }

  private render(): void {
    clear(this.root);
    this.root.className = "editor";
    const header = html("div", { class: "editor-head" });
    header.append(html("h1", {}, "Editor de atividades"));
    const actions = html("div", { class: "editor-actions" });
    const button = (label: string, id: string, action: () => void, disabled = false): HTMLButtonElement => {
      const b = html("button", { type: "button", id }, label);
      b.disabled = disabled;
      b.addEventListener("click", action);
      return b;
    };
    actions.append(
      button("↶ Desfazer", "edUndo", () => this.send({ version: LAB_MESSAGE_VERSION, type: "labUndo" }), !this.history.canUndo),
      button("↷ Refazer", "edRedo", () => this.send({ version: LAB_MESSAGE_VERSION, type: "labRedo" }), !this.history.canRedo),
      button("Gravar no projeto", "edSave", () => this.save()),
      button("Fechar", "edClose", () => this.close()),
    );
    header.append(actions);
    const error = html("p", { id: "edError", class: "error", role: "alert" });
    const body = html("div", { class: "editor-body" });
    body.append(this.renderList(), this.renderForm());
    this.root.append(header, error, body);
  }

  private renderList(): HTMLElement {
    const box = html("aside", { class: "editor-list", "aria-label": "Atividades" });
    const list = html("ol", {});
    this.draft.forEach((activity, index) => {
      const item = html("li", { class: index === this.selected ? "selected" : "" });
      const pick = html("button", { type: "button", class: "pick", "data-index": String(index) }, `${activity.title} · ${ACTIVITY_KIND_LABEL[activity.kind]}`);
      pick.addEventListener("click", () => { this.selected = index; this.render(); });
      const findings = this.findings.filter((f) => f.activityId === activity.id);
      if (findings.length) pick.append(html("span", { class: `finding ${findings.some((f) => f.severity === "error") ? "error" : "warn"}` }, " ⚠"));
      const tools = html("span", { class: "tools" });
      const tool = (label: string, title: string, action: () => void, disabled = false) => {
        const b = html("button", { type: "button", title, "aria-label": `${title}: ${activity.title}` }, label);
        b.disabled = disabled;
        b.addEventListener("click", action);
        tools.append(b);
      };
      tool("↑", "Subir", () => this.move(index, -1), index === 0);
      tool("↓", "Descer", () => this.move(index, 1), index === this.draft.length - 1);
      tool("⧉", "Duplicar", () => { const copy = { ...structuredClone(activity), id: this.uniqueId(`${activity.id}-copia`), title: `${activity.title} (cópia)` }; this.draft.splice(index + 1, 0, copy); this.selected = index + 1; this.render(); });
      tool("✕", "Remover", () => { this.draft.splice(index, 1); this.selected = Math.max(0, Math.min(this.selected, this.draft.length - 1)); this.render(); }, this.draft.length <= 1);
      item.append(pick, tools);
      list.append(item);
    });
    const add = html("div", { class: "editor-add" });
    const kind = html("select", { id: "edAddKind", "aria-label": "Tipo da nova atividade" });
    for (const k of KINDS) kind.append(new Option(ACTIVITY_KIND_LABEL[k], k));
    const addButton = html("button", { type: "button", id: "edAdd" }, "Adicionar");
    addButton.addEventListener("click", () => {
      const template = defaultActivity(kind.value as LabActivityKind);
      this.draft.push({ ...template, id: this.uniqueId(template.id) });
      this.selected = this.draft.length - 1;
      this.render();
    });
    add.append(kind, addButton);
    box.append(list, add);
    return box;
  }

  private move(index: number, delta: number): void {
    const target = index + delta;
    const [item] = this.draft.splice(index, 1);
    this.draft.splice(target, 0, item!);
    this.selected = target;
    this.render();
  }

  private renderForm(): HTMLElement {
    const form = html("section", { class: "editor-form", "aria-label": "Atividade selecionada" });
    const activity = this.draft[this.selected];
    if (!activity) return form;
    const update = (patch: Partial<LabActivity>) => { this.draft[this.selected] = { ...activity, ...patch } as LabActivity; };
    for (const finding of this.findings.filter((f) => f.activityId === activity.id)) form.append(this.renderFinding(finding, activity));
    form.append(
      this.field("Título", "edTitle", activity.title, (v) => update({ title: v })),
      this.field("Pergunta", "edQuestion", activity.question, (v) => update({ question: v }), true),
    );
    if (activity.kind === "limits") form.append(this.limitsFields(activity));
    else if (activity.kind === "functions") form.append(this.functionsFields(activity));
    else if (activity.kind === "axis") {
      form.append(this.number("Curso L (mm)", "edL", activity.L, (v) => update({ L: v })), this.number("Duração T (s)", "edT", activity.T, (v) => update({ T: v })),
        this.number("t₀ da tangente (s)", "edT0", activity.t0, (v) => update({ t0: v })));
    } else form.append(this.processFields(activity));
    form.append(this.stepsFields(activity));
    return form;
  }

  private renderFinding(finding: LabAuditFinding, activity: LabActivity): HTMLElement {
    const box = html("div", { class: `audit ${finding.severity}`, role: "status", "data-code": finding.code });
    box.append(html("p", {}, finding.message));
    if (isProcessActivity(activity)) {
      if (finding.candidates.length) {
        const select = html("select", { "aria-label": "Religar a" });
        for (const c of finding.candidates) select.append(new Option(c.label, c.id));
        const relink = html("button", { type: "button", class: "edRelink" }, "Religar");
        relink.addEventListener("click", () => { this.draft[this.selected] = { ...activity, plantComponentId: select.value }; this.save(); });
        box.append(select, relink);
      }
      if (activity.plantComponentId) {
        const remove = html("button", { type: "button", class: "edUnlink" }, "Remover a referência");
        remove.addEventListener("click", () => { const { plantComponentId: _removed, ...rest } = activity; this.draft[this.selected] = rest as LabActivity; this.save(); });
        box.append(remove);
      }
    }
    return box;
  }

  private field(label: string, id: string, value: string, onChange: (value: string) => void, long = false): HTMLElement {
    const wrap = html("label", { class: "edfield" }, `${label} `);
    const input = long ? html("textarea", { id, rows: "2" }) : html("input", { id, type: "text" });
    input.value = value;
    input.addEventListener("input", () => onChange(input.value));
    wrap.append(input);
    return wrap;
  }

  private number(label: string, id: string, value: number, onChange: (value: number) => void, attrs: Record<string, string> = {}): HTMLElement {
    const wrap = html("label", { class: "edfield" }, `${label} `);
    const input = html("input", { id, type: "number", step: "any", ...attrs });
    input.value = String(value);
    input.addEventListener("input", () => { if (input.value !== "" && Number.isFinite(Number(input.value))) onChange(Number(input.value)); });
    wrap.append(input);
    return wrap;
  }

  /** Campo de expressão com prévia MathML ao vivo e mensagem de erro do parser. */
  private expression(label: string, id: string, value: string, symbols: string[], onChange: (value: string) => void, optional = false): HTMLElement {
    const wrap = html("div", { class: "edfield expr" });
    const input = html("input", { id, type: "text", spellcheck: "false" });
    input.value = value;
    const preview = html("div", { class: "preview", "aria-live": "polite" });
    const error = html("p", { class: "error" });
    const refresh = () => {
      if (optional && !input.value.trim()) { preview.innerHTML = '<span class="note">(vazio)</span>'; error.textContent = ""; onChange(""); return; }
      try { preview.innerHTML = astToMathML(parseExpression(input.value, symbols)); error.textContent = ""; onChange(input.value); }
      catch (err) { error.textContent = (err as Error).message; }
    };
    input.addEventListener("input", refresh);
    wrap.append(html("label", { for: id }, label), input, preview, error);
    refresh();
    return wrap;
  }

  private limitsFields(activity: LimitsActivity): HTMLElement {
    const box = html("fieldset", {});
    box.append(html("legend", {}, "Limites"));
    const update = (patch: Partial<LimitsActivity>) => { this.draft[this.selected] = { ...this.draft[this.selected] as LimitsActivity, ...patch }; };
    box.append(
      this.expression(`Modelo h(${activity.variable})`, "edModel", activity.model, [activity.variable], (v) => update({ model: v })),
      this.number("a", "edA", activity.a, (v) => update({ a: v })),
      this.number("Domínio mín.", "edD0", activity.domain[0], (v) => update({ domain: [v, (this.draft[this.selected] as LimitsActivity).domain[1]] })),
      this.number("Domínio máx.", "edD1", activity.domain[1], (v) => update({ domain: [(this.draft[this.selected] as LimitsActivity).domain[0], v] })),
      this.field("Linhas da tabela (|Δ| separados por ;)", "edRows", activity.rows.join("; "), (v) => update({ rows: v.split(/[;\s]+/).map(Number).filter((x) => x > 0) })),
      this.number("Δ inicial", "edDelta", activity.initialDelta, (v) => update({ initialDelta: v })),
      this.number("ε inicial", "edEps", activity.epsilon, (v) => update({ epsilon: v })),
      this.field("Unidade de t", "edUx", activity.units.x, (v) => update({ units: { ...(this.draft[this.selected] as LimitsActivity).units, x: v } })),
      this.field("Unidade de h", "edUy", activity.units.y, (v) => update({ units: { ...(this.draft[this.selected] as LimitsActivity).units, y: v } })),
    );
    return box;
  }

  private functionsFields(activity: FunctionsActivity): HTMLElement {
    const box = html("fieldset", {});
    box.append(html("legend", {}, "Funções"));
    const current = () => this.draft[this.selected] as FunctionsActivity;
    const update = (patch: Partial<FunctionsActivity>) => { this.draft[this.selected] = { ...current(), ...patch }; };
    const symbols = () => [activity.variable, ...current().parameters.map((p) => p.name)];
    box.append(
      this.expression(`f(${activity.variable})`, "edF", activity.f, symbols(), (v) => update({ f: v })),
      this.expression(`g(${activity.variable}) (opcional)`, "edG", activity.g, symbols(), (v) => update({ g: v }), true),
    );
    const table = html("table", { class: "edparams" });
    table.innerHTML = "<thead><tr><th>parâmetro</th><th>mín.</th><th>máx.</th><th>passo</th><th>valor</th><th></th></tr></thead>";
    const tbody = html("tbody", {});
    activity.parameters.forEach((p, index) => {
      const row = html("tr", {});
      const cell = (key: "name" | "min" | "max" | "step" | "value") => {
        const td = html("td", {});
        const input = html("input", { type: key === "name" ? "text" : "number", step: "any", maxlength: "1", "aria-label": `${key} de ${p.name}` });
        input.value = String(p[key]);
        input.addEventListener("input", () => {
          const params = current().parameters.map((q, i) => (i === index ? { ...q, [key]: key === "name" ? input.value : Number(input.value) } : q));
          update({ parameters: params });
        });
        td.append(input);
        return td;
      };
      const remove = html("button", { type: "button", "aria-label": `remover ${p.name}` }, "✕");
      remove.addEventListener("click", () => { update({ parameters: current().parameters.filter((_, i) => i !== index) }); this.render(); });
      const tdRemove = html("td", {});
      tdRemove.append(remove);
      row.append(cell("name"), cell("min"), cell("max"), cell("step"), cell("value"), tdRemove);
      tbody.append(row);
    });
    table.append(tbody);
    const addParam = html("button", { type: "button", id: "edAddParam" }, "+ parâmetro");
    addParam.disabled = activity.parameters.length >= 6;
    addParam.addEventListener("click", () => {
      const used = new Set(current().parameters.map((p) => p.name));
      const name = "abcdkmnpqrsuvw".split("").find((c) => !used.has(c) && c !== activity.variable) ?? "z";
      update({ parameters: [...current().parameters, { name, min: -5, max: 5, step: 0.1, value: 1 }] });
      this.render();
    });
    box.append(table, addParam,
      this.number("x mín.", "edX0", activity.domain[0], (v) => update({ domain: [v, current().domain[1]] })),
      this.number("x máx.", "edX1", activity.domain[1], (v) => update({ domain: [current().domain[0], v] })),
      this.number("y mín.", "edY0", activity.range[0], (v) => update({ range: [v, current().range[1]] })),
      this.number("y máx.", "edY1", activity.range[1], (v) => update({ range: [current().range[0], v] })),
      this.number("a de F(x) = ∫ₐˣ f", "edIntFrom", activity.integralFrom, (v) => update({ integralFrom: v })),
      this.number("Passo da tabela", "edTableStep", activity.tableStep, (v) => update({ tableStep: v })),
    );
    const show = html("div", { class: "edshow" });
    for (const [key, label] of [["derivative", "f′"], ["integral", "F = ∫f"], ["asymptotes", "assíntotas"], ["roots", "raízes"], ["table", "tabela"]] as const) {
      const wrap = html("label", {});
      const input = html("input", { type: "checkbox" });
      input.checked = activity.show[key];
      input.addEventListener("change", () => update({ show: { ...current().show, [key]: input.checked } }));
      wrap.append(input, ` ${label}`);
      show.append(wrap);
    }
    box.append(show);
    return box;
  }

  private processFields(activity: LabActivity): HTMLElement {
    const box = html("fieldset", {});
    if (!isProcessActivity(activity)) return box;
    const plant = PLANTS[activity.kind];
    box.append(html("legend", {}, `Processo: ${plant.name}`));
    const current = () => this.draft[this.selected] as typeof activity;
    const bind = html("label", { class: "edfield" }, "Instância no projeto ");
    const select = html("select", { id: "edPlant" });
    select.append(new Option("(a única do tipo / a primeira)", ""));
    for (const c of this.components.filter((c) => c.typeId === plant.typeId)) select.append(new Option(c.label, c.id));
    if (activity.plantComponentId && !this.components.some((c) => c.id === activity.plantComponentId)) select.append(new Option(`${activity.plantComponentId} (não existe mais)`, activity.plantComponentId));
    select.value = activity.plantComponentId ?? "";
    select.addEventListener("change", () => {
      const { plantComponentId: _old, ...rest } = current();
      this.draft[this.selected] = (select.value ? { ...rest, plantComponentId: select.value } : rest) as LabActivity;
    });
    bind.append(select);
    box.append(bind);
    for (const spec of plant.parameters) {
      box.append(this.number(`${spec.label}${spec.unit ? ` (${displayUnit(spec.unit)})` : ""} [${spec.min}, ${spec.max}]`, `edParam_${spec.id}`, activity.parameters[spec.id] ?? spec.min,
        (v) => { this.draft[this.selected] = { ...current(), parameters: { ...current().parameters, [spec.id]: v } } as LabActivity; }, { min: String(spec.min), max: String(spec.max) }));
    }
    if (activity.kind === "tank") {
      const r = activity.riemann;
      const set = (patch: Partial<typeof r>) => { const a = current(); if (a.kind === "tank") this.draft[this.selected] = { ...a, riemann: { ...a.riemann, ...patch } }; };
      box.append(this.number("Riemann a (s)", "edRa", r.a, (v) => set({ a: v })), this.number("Riemann b (s)", "edRb", r.b, (v) => set({ b: v })),
        this.number("Riemann n", "edRn", r.n, (v) => set({ n: Math.round(v) })));
      const method = html("select", { id: "edRmethod" });
      for (const [v, label] of [["left", "esquerda"], ["right", "direita"], ["midpoint", "ponto médio"], ["trapezoid", "trapézio"]] as const) method.append(new Option(label, v));
      method.value = r.method;
      method.addEventListener("change", () => set({ method: method.value as typeof r.method }));
      box.append(method);
    }
    return box;
  }

  private stepsFields(activity: LabActivity): HTMLElement {
    const box = html("fieldset", { class: "edsteps" });
    box.append(html("legend", {}, "Etapas do aluno"));
    const steps = () => (this.draft[this.selected] as LabActivity).steps;
    const write = (next: ActivityStep[], rerender = false) => { this.draft[this.selected] = { ...this.draft[this.selected]!, steps: next } as LabActivity; if (rerender) this.render(); };
    activity.steps.forEach((step, index) => {
      const row = html("div", { class: "edstep" });
      const phase = html("select", { "aria-label": `fase da etapa ${index + 1}` });
      for (const p of STEP_PHASES) phase.append(new Option(STEP_PHASE_LABEL[p], p));
      phase.value = step.phase;
      phase.addEventListener("change", () => write(steps().map((s, i) => (i === index ? { ...s, phase: phase.value as StepPhase } : s))));
      const prompt = html("textarea", { rows: "2", "aria-label": `pergunta da etapa ${index + 1}` });
      prompt.value = step.prompt;
      prompt.addEventListener("input", () => write(steps().map((s, i) => (i === index ? { ...s, prompt: prompt.value } : s))));
      const hints = html("textarea", { rows: "2", placeholder: "dicas, uma por linha", "aria-label": `dicas da etapa ${index + 1}` });
      hints.value = step.hints.join("\n");
      hints.addEventListener("input", () => write(steps().map((s, i) => (i === index ? { ...s, hints: hints.value.split("\n").map((h) => h.trim()).filter(Boolean) } : s))));
      const remove = html("button", { type: "button", "aria-label": `remover etapa ${index + 1}` }, "✕");
      remove.addEventListener("click", () => write(steps().filter((_, i) => i !== index), true));
      row.append(html("span", { class: "n" }, `${index + 1}.`), phase, prompt, hints, remove);
      box.append(row);
    });
    const add = html("button", { type: "button", id: "edAddStep" }, "+ etapa");
    add.addEventListener("click", () => {
      const used = new Set(steps().map((s) => s.id));
      let n = steps().length + 1;
      while (used.has(`etapa-${n}`)) n++;
      write([...steps(), { id: `etapa-${n}`, phase: "explore", prompt: "Nova etapa: escreva a pergunta.", hints: [] }], true);
    });
    box.append(add);
    return box;
  }

  private save(): void {
    const lab = this.lab();
    try {
      validateCalculusLab(lab);
    } catch (err) {
      byId("edError").textContent = `Não gravado: ${(err as Error).message}`;
      return;
    }
    for (const activity of lab.activities) { // expressões malformadas não derrubam o projeto, mas o editor avisa antes de gravar
      const problems: string[] = [];
      if (activity.kind === "limits") { try { parseExpression(activity.model, [activity.variable]); } catch (e) { problems.push(`${activity.title}: ${(e as Error).message}`); } }
      if (activity.kind === "functions") {
        const symbols = [activity.variable, ...activity.parameters.map((p) => p.name)];
        for (const text of [activity.f, activity.g].filter((t) => t.trim())) { try { parseExpression(text, symbols); } catch (e) { problems.push(`${activity.title}: ${(e as Error).message}`); } }
      }
      if (problems.length) { byId("edError").textContent = `Não gravado: ${problems.map(escapeXml).join("; ")}`; return; }
    }
    byId("edError").textContent = "";
    this.send({ version: LAB_MESSAGE_VERSION, type: "labSaveLab", lab });
  }
}
