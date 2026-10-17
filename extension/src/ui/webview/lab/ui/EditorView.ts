import type { Ast } from "../calc/ast.js";
import { EditorModel, type TemplateKind } from "../editor/EditorModel.js";

/**
 * Liga o `EditorModel` (sem DOM) a um elemento focável: teclado, clique e colagem. O modelo produz o MathML;
 * esta camada só aplica eventos e redesenha.
 */
export class EditorView {
  readonly model: EditorModel;

  constructor(readonly host: HTMLElement, options: { variable: string; label: string; onChange?: (text: string) => void }) {
    this.model = new EditorModel(options.variable);
    this.label = options.label;
    this.onChange = options.onChange;
    host.tabIndex = 0;
    host.setAttribute("role", "textbox");
    host.classList.add("math-editor");
    host.addEventListener("keydown", (e) => {
      if (e.altKey) return;
      const handled = this.model.key({ key: e.key, shift: e.shiftKey, ctrl: e.ctrlKey || e.metaKey });
      if (!handled) return;
      e.preventDefault();
      this.commit(!(e.ctrlKey || e.metaKey));
    });
    host.addEventListener("pointerdown", (e) => {
      // Foca ANTES de redesenhar: o redesenho remove o alvo do clique e o foco padrão do navegador se perderia.
      e.preventDefault();
      host.focus({ preventScroll: true });
      const target = (e.target as Element | null)?.closest?.("[data-s]") as HTMLElement | null | undefined;
      const seqId = target?.dataset.s === undefined ? undefined : Number(target.dataset.s);
      const index = target?.dataset.i === undefined ? undefined : Number(target.dataset.i);
      let after = false;
      if (target && index !== undefined && target.dataset.ph === undefined) {
        const r = target.getBoundingClientRect();
        after = e.clientX > r.left + r.width / 2;
      }
      this.model.placeCursor(seqId, index, after);
      this.commit(false);
    });
    host.addEventListener("paste", (e) => {
      e.preventDefault();
      this.model.typeText(e.clipboardData?.getData("text") ?? "");
      this.commit(true);
    });
    this.commit(false);
  }

  private readonly label: string;
  private readonly onChange: ((text: string) => void) | undefined;

  focus(): void { this.host.focus(); }
  text(): string { return this.model.text(); }
  emptyFields(): number { return this.model.emptyFields(); }
  setAst(ast: Ast): void { this.model.setAst(ast); this.commit(true); }
  typeText(text: string): void { this.model.typeText(text); this.commit(true); }
  insertTemplate(kind: TemplateKind | "pow2", options: { name?: string; dir?: number } = {}): void { this.model.insertTemplate(kind, options); this.commit(true); }
  key(name: string): void { if (this.model.key({ key: name })) this.commit(true); }

  private commit(changed: boolean): void {
    this.host.innerHTML = this.model.render();
    this.host.classList.toggle("all-selected", this.model.selectionAll);
    this.host.setAttribute("aria-label", `${this.label}: ${this.model.readable()}`);
    if (changed) this.onChange?.(this.model.text());
  }
}
