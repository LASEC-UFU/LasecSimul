import { STEP_PHASE_LABEL, type ActivityStep } from "../activity.js";
import { clear, html } from "./dom.js";

/**
 * Sequência de etapas do aluno (prever → explorar → formalizar → aplicar; docs/51 §5). Navegação por
 * botões e teclado; dicas abrem sob demanda. Nada é gravado (respostas ficam na sessão).
 */
export class StepsPanel {
  private index = 0;
  private hintsShown = 0;

  constructor(private readonly root: HTMLElement, private readonly steps: readonly ActivityStep[]) {
    root.classList.add("steps");
    root.setAttribute("aria-label", "Etapas da atividade");
    this.render();
  }

  get current(): number { return this.index; }

  go(index: number): void {
    this.index = Math.max(0, Math.min(this.steps.length - 1, index));
    this.hintsShown = 0;
    this.render();
  }

  private render(): void {
    clear(this.root);
    if (this.steps.length === 0) { this.root.hidden = true; return; }
    this.root.hidden = false;
    const step = this.steps[this.index]!;
    const head = html("div", { class: "steps-head" });
    head.append(
      html("span", { class: `phase phase-${step.phase}` }, STEP_PHASE_LABEL[step.phase]),
      html("span", { class: "steps-count" }, `Etapa ${this.index + 1} de ${this.steps.length}`),
    );
    const prompt = html("p", { class: "steps-prompt", "aria-live": "polite" }, step.prompt);
    const nav = html("div", { class: "steps-nav" });
    const button = (label: string, id: string, disabled: boolean, action: () => void): HTMLButtonElement => {
      const b = html("button", { type: "button", id }, label);
      b.disabled = disabled;
      b.addEventListener("click", action);
      return b;
    };
    nav.append(
      button("◀ Anterior", "stepPrev", this.index === 0, () => this.go(this.index - 1)),
      button(step.hints.length ? `Dica (${this.hintsShown}/${step.hints.length})` : "Sem dicas", "stepHint", this.hintsShown >= step.hints.length, () => { this.hintsShown++; this.render(); }),
      button("Próxima ▶", "stepNext", this.index >= this.steps.length - 1, () => this.go(this.index + 1)),
    );
    this.root.append(head, prompt);
    if (this.hintsShown > 0) {
      const list = html("ul", { class: "steps-hints" });
      for (const hint of step.hints.slice(0, this.hintsShown)) list.append(html("li", {}, hint));
      this.root.append(list);
    }
    this.root.append(nav);
  }
}
