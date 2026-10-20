/** Entrada do Laboratório de Cálculo. Roda embutido nas Telas HMI (elemento `graphics.math.activity`,
 * `<iframe>` do Painel Visual, `__LAB_EMBED__`; ver `src/visual/labEmbeds.ts`); sem `__LAB_EMBED__` é a
 * Webview autônoma de antes (cabeçalho, abas e editor de atividades próprios). */
import type { CalculusLab, LabActivity } from "../activity.js";
import { LAB_MESSAGE_VERSION, type HostToLabMessage, type LabAuditFinding, type LabMode, type LabProjectComponent, type LabToHostMessage } from "../messages.js";
import { ActivityEditor } from "./ActivityEditor.js";
import { AxisView } from "./AxisView.js";
import { FirstOrderView } from "./FirstOrderView.js";
import { FunctionsView } from "./FunctionsView.js";
import { iconButton } from "./icons.js";
import { LimitsView } from "./LimitsView.js";
import { SensorView } from "./SensorView.js";
import { TankView } from "./TankView.js";

interface LabHostApi { postMessage(message: unknown): void; getState(): unknown; setState(state: unknown): void }
declare const acquireVsCodeApi: undefined | (() => LabHostApi);

/** Atividade embutida numa Tela HMI (elemento `graphics.math.activity`, docs/62 §6): o laboratório roda
 * num `<iframe>` do Painel Visual, que repassa as mensagens ao Host com o id do elemento. */
interface LabEmbedConfig { elementId: string; presentation?: boolean }
const embed = (window as unknown as { __LAB_EMBED__?: LabEmbedConfig }).__LAB_EMBED__;
let embeddedState: unknown;
const vscodeApi: LabHostApi = embed
  ? {
    postMessage: (message) => window.parent.postMessage({ __labEmbed: embed.elementId, message }, "*"),
    getState: () => embeddedState,
    setState: (next) => { embeddedState = next; },
  }
  : acquireVsCodeApi!();
/** Mensagens enviadas ao Host por tipo (testes: inspeção não pode enviar nada; docs/53 §2.6 itens 9 e 14). */
const sent: Record<string, number> = {};
const send = (message: LabToHostMessage): void => { sent[message.type] = (sent[message.type] ?? 0) + 1; vscodeApi.postMessage(message); };

const root = document.getElementById("lab") as HTMLElement;
root.innerHTML = `
<header class="lab-header">
  <div class="brand"><strong>LasecSimul</strong> <span>| Laboratório de Cálculo</span> <span id="labProject" class="note"></span></div>
  <nav id="labTabs" class="lab-tabs" aria-label="Atividades"></nav>
  <div id="labHeaderTools" class="toolbar"></div>
</header>
<div id="labAudit" class="audit-banner" role="status" hidden></div>
<main id="labActivity"></main>
<div id="labEditor" hidden></div>`;

type View = LimitsView | FunctionsView | AxisView | TankView | FirstOrderView | SensorView;
type ProcessView = TankView | FirstOrderView | SensorView;

let lab: CalculusLab | undefined;
let activities: LabActivity[] = [];
let activeId = "";
let mode: LabMode = "student";
let saved = false;
let view: View | undefined;
let editor: ActivityEditor | undefined;
let components: LabProjectComponent[] = [];
let findings: LabAuditFinding[] = [];
let history = { canUndo: false, canRedo: false };
/** Definição recebida no último `labInit` (modo embutido): distingue troca de modo de definição nova. */
let lastEmbeddedDefinition: string | undefined;

const stored = (vscodeApi.getState() ?? {}) as { presentation?: boolean };
document.body.classList.toggle("lab-embedded", Boolean(embed));
document.body.classList.toggle("presentation", Boolean(embed ? embed.presentation : stored.presentation));

const teacherButton = iconButton("teacher", "Modo professor (editar e gravar atividades)", { id: "labTeacher", pressed: false });
teacherButton.addEventListener("click", () => {
  mode = mode === "teacher" ? "student" : "teacher";
  teacherButton.setAttribute("aria-pressed", String(mode === "teacher"));
  editorButton.hidden = mode !== "teacher";
  send({ version: LAB_MESSAGE_VERSION, type: "labSetMode", mode });
  // Trocar de modo não pode descartar o que está na tela (ex.: modelo editado antes de virar professor).
  const onScreen = view?.currentActivity();
  if (onScreen) activities = activities.map((a) => (a.id === onScreen.id ? onScreen : a));
  if (mode === "student") closeEditor();
  mountActive();
});
const editorButton = document.createElement("button");
editorButton.type = "button";
editorButton.id = "labOpenEditor";
editorButton.className = "header-button";
editorButton.textContent = "Editor de atividades";
editorButton.hidden = true;
editorButton.addEventListener("click", () => openEditor());
const presentationButton = document.createElement("button");
presentationButton.type = "button";
presentationButton.id = "labPresentation";
presentationButton.className = "header-button";
presentationButton.textContent = "Apresentação";
presentationButton.setAttribute("aria-pressed", String(document.body.classList.contains("presentation")));
presentationButton.addEventListener("click", () => {
  const on = !document.body.classList.contains("presentation");
  document.body.classList.toggle("presentation", on);
  presentationButton.setAttribute("aria-pressed", String(on));
  vscodeApi.setState({ ...stored, presentation: on });
});
(document.getElementById("labHeaderTools") as HTMLElement).append(presentationButton, editorButton, teacherButton);

function renderTabs(): void {
  const nav = document.getElementById("labTabs") as HTMLElement;
  nav.textContent = "";
  for (const activity of activities) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.textContent = activity.title;
    tab.dataset.kind = activity.kind;
    tab.dataset.id = activity.id;
    tab.setAttribute("aria-current", String(activity.id === activeId));
    if (findings.some((f) => f.activityId === activity.id && f.severity === "error")) tab.classList.add("has-error");
    tab.addEventListener("click", () => {
      if (activity.id === activeId) return;
      const onScreen = view?.currentActivity();
      if (onScreen) activities = activities.map((a) => (a.id === onScreen.id ? onScreen : a));
      activeId = activity.id;
      renderTabs();
      mountActive();
    });
    nav.appendChild(tab);
  }
}

function renderAudit(): void {
  const banner = document.getElementById("labAudit") as HTMLElement;
  const mine = findings.filter((f) => f.activityId === activeId);
  banner.hidden = mine.length === 0;
  banner.textContent = mine.map((f) => `⚠ ${f.message}`).join(" ");
  banner.className = `audit-banner ${mine.some((f) => f.severity === "error") ? "error" : "warn"}`;
}

function mountActive(): void {
  view?.dispose();
  view = undefined;
  const container = document.getElementById("labActivity") as HTMLElement;
  const activity = activities.find((a) => a.id === activeId) ?? activities[0];
  renderAudit();
  if (!activity) { container.textContent = "Nenhuma atividade definida."; return; }
  activeId = activity.id;
  const teacher = mode === "teacher";
  const save = (updated: LabActivity) => send({ version: LAB_MESSAGE_VERSION, type: "labSaveActivity", activity: updated });
  switch (activity.kind) {
    case "tank": view = new TankView(container, activity, { teacher, send, onSave: save }); break;
    case "firstOrder": view = new FirstOrderView(container, activity, { teacher, send, onSave: save }); break;
    case "sensor": view = new SensorView(container, activity, { teacher, send, onSave: save }); break;
    case "functions": view = new FunctionsView(container, activity, { teacher, send, onSave: save }); break;
    case "axis": view = new AxisView(container, activity, { teacher, send, onSave: save }); break;
    default:
      // Atividade sem experimento: o Host desliga o que estiver ligado ao Core.
      send({ version: LAB_MESSAGE_VERSION, type: "labActivate", activity });
      view = new LimitsView(container, activity, { teacher, onSave: save });
  }
}

function openEditor(): void {
  const box = document.getElementById("labEditor") as HTMLElement;
  box.hidden = false;
  (document.getElementById("labActivity") as HTMLElement).hidden = true;
  editor = new ActivityEditor(box, { schemaVersion: 1, activities }, components, findings, send, closeEditor);
  editor.setHistory(history.canUndo, history.canRedo);
}

function closeEditor(): void {
  editor = undefined;
  const box = document.getElementById("labEditor") as HTMLElement;
  box.hidden = true;
  box.textContent = "";
  (document.getElementById("labActivity") as HTMLElement).hidden = false;
}

const isProcessView = (v: View | undefined): v is ProcessView => v instanceof TankView || v instanceof FirstOrderView || v instanceof SensorView;

window.addEventListener("message", (event: MessageEvent<HostToLabMessage>) => {
  const control = (event.data as { __labEmbedControl?: { presentation?: boolean } } | undefined)?.__labEmbedControl;
  if (embed && control && event.source === window.parent) {
    // A casca da Tela HMI decide o modo Apresentação de todas as atividades da página.
    if (typeof control.presentation === "boolean") document.body.classList.toggle("presentation", control.presentation);
    return;
  }
  const message = event.data;
  if (!message || message.version !== LAB_MESSAGE_VERSION) return;
  switch (message.type) {
    case "labInit": {
      lab = message.lab;
      saved = message.saved;
      const incoming = structuredClone(lab.activities);
      // Embutida numa Tela HMI, o Host reenvia o `labInit` ao trocar edição/operação. Com a MESMA
      // definição de antes, o que está na tela (ex.: modelo digitado e não gravado) continua -- como a
      // troca de modo do painel antigo, que nunca descartava a edição do aluno.
      const onScreen = embed && lastEmbeddedDefinition === JSON.stringify(incoming) ? view?.currentActivity() : undefined;
      activities = onScreen ? incoming.map((a) => (a.id === onScreen.id ? onScreen : a)) : incoming;
      lastEmbeddedDefinition = JSON.stringify(incoming);
      activeId = activities.some((a) => a.id === activeId) ? activeId : message.activeId;
      mode = message.mode;
      teacherButton.setAttribute("aria-pressed", String(mode === "teacher"));
      editorButton.hidden = mode !== "teacher" || Boolean(embed);
      const project = document.getElementById("labProject") as HTMLElement;
      project.textContent = `${message.projectName ? `· ${message.projectName}` : ""}${saved ? "" : " · atividades-modelo (grave no modo professor para guardar no projeto)"}`;
      renderTabs();
      if (editor) openEditor(); else mountActive();
      return;
    }
    case "labSaved": view?.saved(); return;
    case "labProject":
      components = message.components;
      findings = message.findings;
      renderTabs();
      renderAudit();
      editor?.setProject(components, findings);
      return;
    case "labHistory":
      history = { canUndo: message.canUndo, canRedo: message.canRedo };
      editor?.setHistory(history.canUndo, history.canRedo);
      return;
    default:
      if (!isProcessView(view)) return;
      if (message.type === "labRunState") view.runState(message.status);
      else if (message.type === "labPlant" && message.activityId === activeId) view.plant(message.status);
      else if (message.type === "labSeries" && message.activityId === activeId) view.series(message.delta);
      else if (message.type === "labParameter" && message.activityId === activeId) view.parameterAccepted(message.id, message.value);
      else if (message.type === "labParameterRejected" && message.activityId === activeId) view.parameterRejected(message.id, message.reason);
  }
});

// Desfazer/refazer da definição (modo professor), fora de campos de texto e do editor de equações.
window.addEventListener("keydown", (event) => {
  if (mode !== "teacher" || !(event.ctrlKey || event.metaKey)) return;
  const target = event.target as HTMLElement | null;
  if (target && (target.closest("input, textarea, select") || target.closest(".math-editor"))) return;
  const key = event.key.toLowerCase();
  if (key === "z" && !event.shiftKey) { event.preventDefault(); send({ version: LAB_MESSAGE_VERSION, type: "labUndo" }); }
  else if (key === "y" || (key === "z" && event.shiftKey)) { event.preventDefault(); send({ version: LAB_MESSAGE_VERSION, type: "labRedo" }); }
});

/** Somente para testes de interface. */
(window as unknown as { __lab: unknown }).__lab = { get view() { return view; }, get editor() { return editor; }, sent };
send({ version: LAB_MESSAGE_VERSION, type: "labReady" });
