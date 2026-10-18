import type { ProcessActivity } from "../activity.js";
import type { LabGraph } from "../graph/LabGraph.js";
import { LAB_MESSAGE_VERSION, type LabPlantStatus, type LabRunStatus, type LabSeriesDelta, type LabToHostMessage } from "../messages.js";
import { PLANTS, type ParameterValues, type PlantParameterSpec, type PlantSpec, type ProcessKind } from "../plants.js";
import { SeriesBuffer } from "../series/SeriesBuffer.js";
import { displayUnit } from "../units.js";
import { byId, clear } from "./dom.js";
import { iconButton } from "./icons.js";

const nf = (x: number, d = 3): string => (Number.isFinite(x) ? x.toLocaleString("pt-BR", { maximumFractionDigits: d }) : "—");

/** Rótulos dos valores discretos (seleção em vez de número). */
const CHOICES: Readonly<Record<string, ReadonlyArray<readonly [number, string]>>> = {
  outlet: [[0, "bomba (vazão imposta)"], [1, "válvula (q = k·h)"], [2, "orifício (q = c·√h, Torricelli)"]],
};

/** Controles que só fazem sentido em certas configurações (ex.: k só com a válvula). */
const VISIBLE: Readonly<Partial<Record<ProcessKind, (id: string, values: ParameterValues) => boolean>>> = {
  tank: (id, v) => (id === "qOut" ? v.outlet === 0 : id === "k" ? v.outlet === 1 : id === "torr" ? v.outlet === 2 : true),
};

/**
 * Casca comum das atividades de processo (tanque, primeira ordem, sensor): ligação com a planta do
 * projeto, botões de execução, controles de parâmetro com a política do Host (o valor exibido é o
 * ACEITO; recusa volta ao anterior) e o buffer das séries gravadas pelo Core. Registra no grafo da vista
 * as fontes `rev`, `status`, `plant` e `params`.
 */
export class ProcessShell {
  readonly plantSpec: PlantSpec;
  readonly buffer = new SeriesBuffer();
  /** Último valor aceito pelo Core para cada parâmetro. */
  readonly accepted: ParameterValues;
  private readonly pendingSend = new Map<string, number>();
  private frame = 0;
  plantComponentId: string | undefined;

  constructor(readonly prefix: string, private readonly activity: ProcessActivity, private readonly graph: LabGraph,
              private readonly send: (message: LabToHostMessage) => void, private readonly onInput: () => void = () => undefined) {
    this.plantSpec = PLANTS[activity.kind];
    this.accepted = { ...this.plantSpec.defaults, ...activity.parameters };
    graph.source("rev", 0, { kind: "series" });
    graph.source("status", "stopped" as LabRunStatus, { kind: "execution" });
    graph.source("plant", { state: "missing" } as LabPlantStatus, { kind: "execution" });
    graph.source("params", { ...this.accepted }, { kind: "parameter-mirror", equals: (x, y) => JSON.stringify(x) === JSON.stringify(y) });
  }

  dispose(): void { if (this.frame) cancelAnimationFrame(this.frame); }

  // ------------------------------------------------------------------ mensagens do Host
  plant(status: LabPlantStatus): void {
    this.plantComponentId = status.state === "bound" ? status.componentId : undefined;
    this.graph.set("plant", status);
  }
  runState(status: LabRunStatus): void { this.graph.set("status", status); }
  series(delta: LabSeriesDelta): void {
    this.buffer.ingest(delta);
    this.graph.set("rev", this.buffer.revision);
  }
  parameterAccepted(id: string, value: number): void {
    this.accepted[id] = value;
    this.graph.set("params", { ...this.accepted });
    this.error("");
  }
  parameterRejected(id: string, reason: string): void {
    this.error(reason);
    this.show(id, this.accepted[id] ?? NaN);
  }

  // ------------------------------------------------------------------ marcação
  controlsHtml(): string {
    const p = this.prefix;
    const control = (spec: PlantParameterSpec): string => {
      const unit = displayUnit(spec.unit);
      const choices = CHOICES[spec.id];
      if (choices) {
        return `<label id="${p}Label_${spec.id}">${spec.label} <select id="${p}_${spec.id}">${choices.map(([v, text]) => `<option value="${v}">${text}</option>`).join("")}</select></label>`;
      }
      if (spec.policy === "live") {
        return `<label id="${p}Label_${spec.id}">${spec.label} <output id="${p}Out_${spec.id}"></output>
          <input id="${p}_${spec.id}" type="range" min="${spec.min}" max="${spec.max}" step="${spec.step}" aria-valuetext="" /></label>`;
      }
      return `<label id="${p}Label_${spec.id}">${spec.label}${unit ? ` (${unit})` : ""} <input id="${p}_${spec.id}" type="number" min="${spec.min}" max="${spec.max}" step="${spec.step}" /></label>`;
    };
    const live = this.plantSpec.parameters.filter((s) => s.policy === "live");
    const config = this.plantSpec.parameters.filter((s) => s.policy !== "live");
    return `<div class="sliders">${live.map(control).join("")}</div>
      <div class="config">${config.map(control).join("")}<p id="${p}ParamError" class="error" role="alert"></p></div>
      <div id="${p}RunBar" class="toolbar" role="toolbar" aria-label="Execução"></div>`;
  }

  /** Liga eventos depois que `controlsHtml()` foi inserido no DOM. */
  bind(onLive: () => void): void {
    const p = this.prefix;
    for (const spec of this.plantSpec.parameters) {
      const input = byId<HTMLInputElement | HTMLSelectElement>(`${p}_${spec.id}`);
      const event = input instanceof HTMLSelectElement || input.type === "number" ? "change" : "input";
      input.addEventListener(event, () => this.requestParameter(spec.id, Number(input.value)));
      this.show(spec.id, this.accepted[spec.id] ?? spec.min);
    }
    const bar = byId(`${p}RunBar`);
    const buttons: Array<[HTMLButtonElement, () => void]> = [
      [iconButton("play", "Executar / retomar", { id: `${p}Run` }), () => this.send({ version: LAB_MESSAGE_VERSION, type: "labRun" })],
      [iconButton("pause", "Pausar", { id: `${p}Pause` }), () => this.send({ version: LAB_MESSAGE_VERSION, type: "labPause" })],
      [iconButton("restart", "Reiniciar (volta aos valores iniciais da atividade)", { id: `${p}Restart` }), () => this.restart()],
      [iconButton("live", "Voltar ao vivo", { id: `${p}Live` }), onLive],
    ];
    for (const [button, action] of buttons) { button.addEventListener("click", action); bar.appendChild(button); }
  }

  show(id: string, value: number): void {
    const p = this.prefix, spec = this.plantSpec.parameters.find((s) => s.id === id);
    if (!spec) return;
    const input = byId<HTMLInputElement | HTMLSelectElement>(`${p}_${id}`);
    input.value = String(value);
    const output = document.getElementById(`${p}Out_${id}`);
    const text = `${nf(value)}${spec.unit ? ` ${displayUnit(spec.unit)}` : ""}`;
    if (output) output.textContent = text;
    if (input instanceof HTMLInputElement && input.type === "range") input.setAttribute("aria-valuetext", text);
    this.applyVisibility({ ...this.accepted, [id]: value });
  }

  private applyVisibility(values: ParameterValues): void {
    const visible = VISIBLE[this.activity.kind];
    if (!visible) return;
    for (const spec of this.plantSpec.parameters) {
      const label = document.getElementById(`${this.prefix}Label_${spec.id}`);
      if (label) label.hidden = !visible(spec.id, values);
    }
  }

  /** Pedido do aluno: mostra já, envia coalescido por quadro; o Host responde aceito/recusado. */
  requestParameter(id: string, value: number): void {
    this.onInput();
    this.show(id, value);
    this.pendingSend.set(id, value);
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      for (const [key, v] of this.pendingSend) this.send({ version: LAB_MESSAGE_VERSION, type: "labSetParameter", id: key, value: v });
      this.pendingSend.clear();
    });
  }

  restart(): void {
    const initial = { ...this.plantSpec.defaults, ...this.activity.parameters };
    for (const id of Object.keys(initial)) { this.accepted[id] = initial[id]!; this.show(id, initial[id]!); }
    this.error("");
    this.graph.set("params", { ...initial });
    this.send({ version: LAB_MESSAGE_VERSION, type: "labRestart", parameters: initial });
  }

  private error(text: string): void { const box = document.getElementById(`${this.prefix}ParamError`); if (box) box.textContent = text; }

  /** Estado de execução: configuração só com a simulação parada; botões só com a planta ligada. */
  drawStatus(statusBox: HTMLElement, now: number): void {
    const status = this.graph.get<LabRunStatus>("status"), bound = this.graph.get<LabPlantStatus>("plant").state === "bound";
    statusBox.textContent = `${{ stopped: "Configuração", running: "Executando", paused: "Pausado" }[status]} · t = ${nf(now, 2)} s`;
    for (const spec of this.plantSpec.parameters) {
      if (spec.policy === "live") continue;
      const input = byId<HTMLInputElement>(`${this.prefix}_${spec.id}`);
      input.disabled = status !== "stopped";
      input.title = status !== "stopped" ? "Só muda com a simulação parada: use Reiniciar" : "";
    }
    for (const id of ["Run", "Pause", "Restart"]) byId<HTMLButtonElement>(`${this.prefix}${id}`).disabled = !bound;
  }

  drawPlant(box: HTMLElement): void {
    const status = this.graph.get<LabPlantStatus>("plant");
    clear(box);
    if (status.state === "bound") { box.className = "plant-status ok"; box.textContent = `Processo ligado: ${status.label}`; return; }
    box.className = "plant-status warn";
    const text = document.createElement("span");
    text.textContent = status.state === "missing"
      ? `Este projeto ainda não tem o processo desta atividade (${this.plantSpec.name}). "Inserir no projeto" incorpora a planta ao próprio projeto.`
      : `Processo indisponível: ${status.message}`;
    box.appendChild(text);
    if (status.state === "missing") {
      const insert = document.createElement("button");
      insert.type = "button";
      insert.id = `${this.prefix}InsertPlant`;
      insert.textContent = "Inserir no projeto";
      insert.addEventListener("click", () => this.send({ version: LAB_MESSAGE_VERSION, type: "labInsertPlant" }));
      box.appendChild(insert);
    }
  }
}
