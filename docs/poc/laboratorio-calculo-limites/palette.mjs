// PoC isolada (NÃO é produção). Teclado matemático próprio: abas 123, f(x) e Cálculo.
// Organização inspirada no teclado do GeoGebra (`keyboard-base`, MathKeyboardFactory): x, π, e, x², xⁿ,
// √, |x|, parênteses; faces desenhadas em MathML com placeholders (□), sem recursos do GeoGebra.
const PH = '<mspace class="ph" width="0.55em" height="0.7em" depth="0.1em"></mspace>';
const m = (body) => `<math>${body}</math>`;

/** Cada tecla: rótulo acessível, face (MathML ou texto) e ação sobre o editor. */
export function paletteKeys(variable) {
  const v = `<mi>${variable === "Δt" ? "Δt" : variable}</mi>`;
  return {
    "123": [
      ...["7", "8", "9"].map((d) => ({ label: d, face: d, act: (e) => e.typeText(d) })),
      { label: "fração", face: m(`<mfrac>${PH}${PH}</mfrac>`), act: (e) => e.insertTemplate("frac") },
      ...["4", "5", "6"].map((d) => ({ label: d, face: d, act: (e) => e.typeText(d) })),
      { label: "vezes", face: "·", act: (e) => e.typeText("*") },
      ...["1", "2", "3"].map((d) => ({ label: d, face: d, act: (e) => e.typeText(d) })),
      { label: "menos", face: "−", act: (e) => e.typeText("-") },
      { label: "0", face: "0", act: (e) => e.typeText("0") },
      { label: "vírgula decimal", face: ",", act: (e) => e.typeText(",") },
      { label: "abre parêntese", face: "(", act: (e) => e.typeText("(") },
      { label: "mais", face: "+", act: (e) => e.typeText("+") },
      { label: "cursor à esquerda", face: "←", act: (e) => e.key("ArrowLeft") },
      { label: "cursor à direita", face: "→", act: (e) => e.key("ArrowRight") },
      { label: "fecha parêntese", face: ")", act: (e) => e.typeText(")") },
      { label: "apagar", face: "⌫", act: (e) => e.key("Backspace") },
    ],
    "f(x)": [
      { label: `variável ${variable}`, face: m(v), act: (e) => e.typeText(variable) },
      { label: "ao quadrado", face: m(`<msup>${PH}<mn>2</mn></msup>`), act: (e) => e.insertTemplate("pow2") },
      { label: "potência", face: m(`<msup>${PH}${PH}</msup>`), act: (e) => e.insertTemplate("pow") },
      { label: "raiz quadrada", face: m(`<msqrt>${PH}</msqrt>`), act: (e) => e.insertTemplate("sqrt") },
      { label: "módulo", face: m(`<mrow><mo>|</mo>${PH}<mo>|</mo></mrow>`), act: (e) => e.insertTemplate("abs") },
      { label: "pi", face: m("<mi>π</mi>"), act: (e) => e.typeText("π") },
      { label: "número de Euler", face: m("<mi>e</mi>"), act: (e) => e.typeText("e") },
      { label: "delta", face: m("<mi>Δ</mi>"), act: (e) => e.typeText("Δ") },
      ...["sin", "cos", "tan", "ln", "log", "exp"].map((name) => ({
        label: { sin: "seno", cos: "cosseno", tan: "tangente", ln: "logaritmo natural", log: "logaritmo decimal", exp: "exponencial" }[name],
        face: m(`<mrow><mi>${{ sin: "sen", tan: "tg" }[name] ?? name}</mi><mo>(</mo>${PH}<mo>)</mo></mrow>`),
        act: (e) => e.insertTemplate("fn", { name }),
      })),
    ],
    "Cálculo": [
      { label: "integral definida", face: m(`<mrow><msubsup><mo>∫</mo>${PH}${PH}</msubsup>${PH}<mi>d</mi>${v}</mrow>`), act: (e) => e.insertTemplate("int") },
      { label: `derivada em relação a ${variable}`, face: m(`<mfrac><mi>d</mi><mrow><mi>d</mi>${v}</mrow></mfrac>`), act: (e) => e.insertTemplate("deriv") },
      { label: "limite", face: m(`<munder><mo movablelimits="false">lim</mo><mrow>${v}<mo>→</mo>${PH}</mrow></munder>`), act: (e) => e.insertTemplate("lim", { dir: 0 }) },
      { label: "limite pela direita", face: m(`<munder><mo movablelimits="false">lim</mo><mrow>${v}<mo>→</mo><msup>${PH}<mo>+</mo></msup></mrow></munder>`), act: (e) => e.insertTemplate("lim", { dir: 1 }) },
      { label: "limite pela esquerda", face: m(`<munder><mo movablelimits="false">lim</mo><mrow>${v}<mo>→</mo><msup>${PH}<mo>−</mo></msup></mrow></munder>`), act: (e) => e.insertTemplate("lim", { dir: -1 }) },
      { label: "somatório", face: m(`<munderover><mo movablelimits="false">∑</mo><mrow><mi>k</mi><mo>=</mo><mn>1</mn></mrow>${PH}</munderover>`), act: (e) => e.insertTemplate("sum") },
      { label: "produtório", face: m(`<munderover><mo movablelimits="false">∏</mo><mrow><mi>k</mi><mo>=</mo><mn>1</mn></mrow>${PH}</munderover>`), act: (e) => e.insertTemplate("prod") },
      { label: "infinito", face: m("<mi>∞</mi>"), act: (e) => e.typeText("∞") },
      { label: "fração", face: m(`<mfrac>${PH}${PH}</mfrac>`), act: (e) => e.insertTemplate("frac") },
      { label: "próximo campo", face: "⇥", act: (e) => e.key("Tab") },
    ],
  };
}

/** Monta o teclado num contêiner; as teclas não roubam o foco do editor. */
export function mountPalette(container, editorRef, variable) {
  const keys = paletteKeys(variable);
  container.innerHTML = "";
  container.classList.add("palette");
  const tabs = document.createElement("div");
  tabs.className = "palette-tabs"; tabs.setAttribute("role", "tablist");
  const grid = document.createElement("div");
  grid.className = "palette-grid";
  const show = (name) => {
    for (const b of tabs.children) b.setAttribute("aria-selected", String(b.dataset.tab === name));
    grid.innerHTML = "";
    grid.dataset.tab = name;
    for (const key of keys[name]) {
      const b = document.createElement("button");
      b.type = "button"; b.className = "key"; b.innerHTML = key.face; b.title = key.label;
      b.setAttribute("aria-label", key.label);
      b.addEventListener("pointerdown", (ev) => ev.preventDefault()); // mantém o foco no editor
      b.addEventListener("click", () => { const ed = editorRef(); key.act(ed); ed.focus(); });
      grid.appendChild(b);
    }
  };
  for (const name of Object.keys(keys)) {
    const t = document.createElement("button");
    t.type = "button"; t.textContent = name; t.dataset.tab = name; t.setAttribute("role", "tab");
    t.addEventListener("pointerdown", (ev) => ev.preventDefault());
    t.addEventListener("click", () => show(name));
    tabs.appendChild(t);
  }
  container.append(tabs, grid);
  show("Cálculo");
}
