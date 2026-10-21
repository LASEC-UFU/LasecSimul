// Ícones da biblioteca PID Controller, PID Controller (2DOF) e variantes discretas (docs/66).
// Como no Simulink: texto `<Controller>(s)` ou `<Controller>(z)` centrado (muda com o tipo do
// controlador e o domínio do tempo), rótulos das portas opcionais (P, I, D, N, b, c, I0, D0, up, lo,
// TR, extAW, preInt e `Ref` no 2DOF) desenhados por `portLabels` a partir da especificação e o
// símbolo do tipo de reset ao lado da porta de reset. Desenho vetorial próprio.
import { Geometry, glyph, IconTable, portY, propertyText, rectBody, svgText, textWidth } from "../symbolKit.js";

/** Largura dos rótulos de porta na faixa vertical do texto central (o texto foge deles; rótulos em
 * outra altura, como o `Ref` do 2DOF, não deslocam o texto -- igual ao ícone de referência). */
function labelWidth(g: Geometry, side: "inputs" | "outputs", band: number): number {
  const ports = g[side];
  let widest = 0;
  ports.forEach((port, index) => {
    if (Math.abs(portY(g.height, index, ports.length) - g.height / 2) > band) return;
    if (port.label) widest = Math.max(widest, textWidth(port.label, 8));
    if (port.id === "reset") widest = Math.max(widest, 12);
  });
  return widest > 0 ? widest + 5 : 0;
}

/** Símbolo do disparo do reset (borda de subida, descida, ambas ou nível) junto à porta. */
function resetGlyph(g: Geometry): string {
  const index = g.inputs.findIndex((port) => port.id === "reset");
  if (index < 0) return "";
  const y = portY(g.height, index, g.inputs.length);
  const lo = y + 3, hi = y - 3;
  const mode = propertyText(g.props.ExternalReset);
  const path = mode === "falling" ? `M 3 ${hi} H 7 V ${lo} H 11`
    : mode === "either" ? `M 2 ${lo} H 5 V ${hi} H 9 V ${lo} H 12`
    : mode === "level" ? `M 2 ${lo} H 4 V ${hi} H 10 V ${lo} H 12 M 4 ${y} H 10`
    : `M 3 ${lo} H 7 V ${hi} H 11`;
  return glyph(path, undefined, 1);
}

function pidIcon(g: Geometry): string {
  const controller = propertyText(g.props.Controller) || "PID";
  const variable = propertyText(g.props.TimeDomain) === "Discrete-time" ? "z" : "s";
  const label = `${controller}(${variable})`;
  let size = Math.min(g.height * 0.27, 14);
  // Faixa vertical em que um rótulo (meia altura ~4) encostaria no texto (meia altura ~size/2).
  const band = size * 0.5 + 4;
  const left = labelWidth(g, "inputs", band), right = labelWidth(g, "outputs", band);
  const room = Math.max(10, g.width - left - right - 6);
  const width = textWidth(label, size);
  if (width > room) size = Math.max(6, (size * room) / width);
  const cx = left + (g.width - left - right) / 2;
  return rectBody(g) + svgText(cx, g.height / 2, label, { size }) + resetGlyph(g);
}

export const pidIcons: IconTable = {
  pid_controller: pidIcon,
  pid_controller_2dof: pidIcon,
  discrete_pid_controller: pidIcon,
  discrete_pid_controller_2dof: pidIcon,
};
