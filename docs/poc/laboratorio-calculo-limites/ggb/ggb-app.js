// PoC isolada (estratégia C): GeoGebra embutido + sincronização externa por API.
/* global GGBApplet */
window.__ggb = { loadedAt: undefined, startedAt: performance.now(), updates: 0, updatesByName: {}, errors: [] };
const params = {
  appName: "classic", width: 900, height: 560, showToolBar: false, showAlgebraInput: false, showMenuBar: false,
  enableRightClick: false, enableShiftDragZoom: true, showResetIcon: false, language: "en",
  appletOnLoad(api) {
    const s = window.__ggb;
    s.loadedAt = performance.now();
    const commands = [
      "h(t) = 0.5 t^2",
      "a = 4",
      "dt = 0.5",                       // número livre: a inspeção controla Δt diretamente
      "P = (a, h(a))",
      "Q = (a + dt, h(a + dt))",        // Q dependente de Δt (parametrização por t)
      "q = (h(a + dt) - h(a)) / dt",
      "s = Line(P, Q)",
      "tg = Tangent(a, h)",
      "Qc = Point(h)",                  // ponto restrito ao gráfico, para observar a projeção
    ];
    s.commandResults = commands.map((c) => [c, api.evalCommand(c)]);
    const t0 = performance.now();
    s.limitDefined = api.evalCommand("L = Limit((h(a + x) - h(a)) / x, 0)");
    s.limitMs = performance.now() - t0;
    s.limitValue = api.getValue("L");
    api.setCoords("Qc", 4.5, 0);
    s.projection = { requested: [4.5, 0], got: [api.getXcoord("Qc"), api.getYcoord("Qc")] };
    api.registerUpdateListener((name) => {
      s.updates++;
      s.updatesByName[name] = (s.updatesByName[name] ?? 0) + 1;
      if (name === "q") document.getElementById("q").textContent = String(api.getValue("q"));
    });
    window.__api = api;
  },
};
try {
  const applet = new GGBApplet(params, true);
  applet.setHTML5Codebase("/GeoGebra/HTML5/5.0/web3d/");
  applet.inject("ggb");
} catch (error) {
  window.__ggb.errors.push(String(error));
}
