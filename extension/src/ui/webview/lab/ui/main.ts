/** Entrada da Webview do Laboratório de Cálculo (painel próprio; ver `CalculusLabPanel`). */
import { defaultActivities, type CalculusLab, type LabActivity } from "../activity.js";
import { LAB_MESSAGE_VERSION, type HostToLabMessage, type LabMode, type LabToHostMessage } from "../messages.js";
import { iconButton } from "./icons.js";
import { LimitsView } from "./LimitsView.js";
import { TankView } from "./TankView.js";

declare function acquireVsCodeApi(): { postMessage(message: unknown): void };
const vscodeApi = acquireVsCodeApi();
const send = (message: LabToHostMessage): void => vscodeApi.postMessage(message);

const root = document.getElementById("lab") as HTMLElement;
root.innerHTML = `
<header class="lab-header">
  <div class="brand"><strong>LasecSimul</strong> <span>| Laboratório de Cálculo</span> <span id="labProject" class="note"></span></div>
  <nav id="labTabs" class="lab-tabs" aria-label="Atividades"></nav>
  <div id="labHeaderTools" class="toolbar"></div>
</header>
<main id="labActivity"></main>`;

let lab: CalculusLab | undefined;
let activities: LabActivity[] = [];
let activeId = "";
let mode: LabMode = "student";
let view: LimitsView | TankView | undefined;

/** Atividades do projeto + um modelo de cada tipo que o projeto ainda não tem (gravado só se o professor salvar). */
function withTemplates(current: CalculusLab | undefined): LabActivity[] {
  const own = current?.activities ?? [];
  return [...own, ...defaultActivities().filter((template) => !own.some((activity) => activity.kind === template.kind))];
}

const teacherButton = iconButton("teacher", "Modo professor (editar e gravar a atividade)", { id: "labTeacher", pressed: false });
teacherButton.addEventListener("click", () => {
  mode = mode === "teacher" ? "student" : "teacher";
  teacherButton.setAttribute("aria-pressed", String(mode === "teacher"));
  send({ version: LAB_MESSAGE_VERSION, type: "labSetMode", mode });
  // Trocar de modo não pode descartar o que está na tela (ex.: modelo editado antes de virar professor).
  const onScreen = view?.currentActivity();
  if (onScreen) activities = activities.map((a) => (a.id === onScreen.id ? onScreen : a));
  mountActive();
});
(document.getElementById("labHeaderTools") as HTMLElement).appendChild(teacherButton);

function renderTabs(): void {
  const nav = document.getElementById("labTabs") as HTMLElement;
  nav.textContent = "";
  for (const activity of activities) {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.textContent = activity.title;
    tab.dataset.kind = activity.kind;
    tab.setAttribute("aria-current", String(activity.id === activeId));
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

function mountActive(): void {
  view?.dispose();
  view = undefined;
  const container = document.getElementById("labActivity") as HTMLElement;
  const activity = activities.find((a) => a.id === activeId) ?? activities[0];
  if (!activity) { container.textContent = "Nenhuma atividade definida."; return; }
  const save = (updated: LabActivity) => send({ version: LAB_MESSAGE_VERSION, type: "labSaveActivity", activity: updated });
  if (activity.kind === "tank") {
    view = new TankView(container, activity, { teacher: mode === "teacher", send, onSave: save });
  } else {
    // Atividade sem experimento: o Host desliga o que estiver ligado ao Core.
    send({ version: LAB_MESSAGE_VERSION, type: "labActivate", activity });
    view = new LimitsView(container, activity, { teacher: mode === "teacher", onSave: save });
  }
}

window.addEventListener("message", (event: MessageEvent<HostToLabMessage>) => {
  const message = event.data;
  if (!message || message.version !== LAB_MESSAGE_VERSION) return;
  switch (message.type) {
    case "labInit":
      lab = message.lab;
      activities = withTemplates(lab);
      activeId = activities.some((a) => a.id === activeId) ? activeId : message.activeId;
      mode = message.mode;
      teacherButton.setAttribute("aria-pressed", String(mode === "teacher"));
      (document.getElementById("labProject") as HTMLElement).textContent = message.projectName ? `· ${message.projectName}` : "";
      renderTabs();
      mountActive();
      return;
    case "labSaved":
      view?.saved();
      return;
    default:
      if (!(view instanceof TankView)) return;
      if (message.type === "labRunState") view.runState(message.status);
      else if (message.type === "labPlant" && message.activityId === activeId) view.plant(message.status);
      else if (message.type === "labSeries" && message.activityId === activeId) view.series(message.delta);
      else if (message.type === "labParameter" && message.activityId === activeId) view.parameterAccepted(message.id, message.value);
      else if (message.type === "labParameterRejected" && message.activityId === activeId) view.parameterRejected(message.id, message.reason);
  }
});

/** Somente para testes de interface. */
(window as unknown as { __lab: unknown }).__lab = { get view() { return view; } };
send({ version: LAB_MESSAGE_VERSION, type: "labReady" });
