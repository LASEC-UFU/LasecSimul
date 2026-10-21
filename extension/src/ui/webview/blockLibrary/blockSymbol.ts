/**
 * Símbolo de um bloco da biblioteca equivalente ao Simulink (docs/66): corpo, ícone e portas no
 * mesmo arranjo visual dos blocos da documentação oficial, redesenhados aqui como vetor próprio
 * (nenhuma imagem da MathWorks é incorporada). O símbolo depende das propriedades da instância
 * (número de portas do Sum, valor do Gain, polinômios da Transfer Fcn...), então é gerado por
 * instância. Os ícones ficam por família em `icons/`; aqui só a montagem. Módulo puro: roda no host
 * e na Webview.
 */
import type { PackageDescriptor, PackagePin, PackageShape } from "../model.js";
import { BlockProperties, BlockSpec, withDefaults } from "./spec.js";
import { resolveBlockPorts } from "./ports.js";
import { centered, escapeXml, Geometry, IconDrawer, INK, portLabels, portY, rectBody, roundPortAngles } from "./symbolKit.js";
import { attributeIcons } from "./icons/attributes.js";
import { continuousIcons } from "./icons/continuous.js";
import { discontinuityIcons } from "./icons/discontinuities.js";
import { discreteIcons } from "./icons/discrete.js";
import { logicIcons } from "./icons/logic.js";
import { lookupIcons } from "./icons/lookup.js";
import { mathIcons } from "./icons/math.js";
import { pidIcons } from "./icons/pid.js";
import { routingIcons } from "./icons/routing.js";
import { sinkIcons } from "./icons/sinks.js";
import { sourceIcons } from "./icons/sources.js";
import { userDefinedIcons } from "./icons/userdefined.js";

export { polynomialMarkup } from "./symbolKit.js";

/** Escala dos tamanhos padrão do Simulink (px) para a grade do esquemático. */
export const BLOCK_SCALE = 1.6;
/** Comprimento da seta de porta (fora do corpo). */
const PORT = 7;

const ICONS: ReadonlyMap<string, IconDrawer> = (() => {
  const map = new Map<string, IconDrawer>();
  for (const table of [sourceIcons, mathIcons, continuousIcons, discreteIcons, pidIcons, discontinuityIcons, logicIcons, lookupIcons,
    routingIcons, sinkIcons, attributeIcons, userDefinedIcons]) {
    for (const [id, drawer] of Object.entries(table)) {
      if (map.has(id)) throw new Error(`icone duplicado para o bloco '${id}'`);
      map.set(id, drawer);
    }
  }
  return map;
})();

/** O bloco tem desenho próprio (fora o genérico com o nome). */
export function hasBlockIcon(blockId: string): boolean {
  return ICONS.has(blockId);
}

/** Desenho do ícone (corpo incluído) em coordenadas do corpo [0..w]x[0..h]. */
function iconSvg(g: Geometry): string {
  const drawer = ICONS.get(g.spec.id);
  const body = drawer ? drawer(g) : rectBody(g) + centered(g, escapeXml(g.spec.name), g.spec.name, { size: 10 });
  return body + portLabels(g);
}

/** Tamanho do corpo: padrão do Simulink escalado, crescendo para manter as portas legíveis. */
function bodySize(spec: BlockSpec, inputs: number, outputs: number, size?: [number, number]): { width: number; height: number } {
  const [w, h] = size ?? spec.size ?? [30, 30];
  const width = Math.round(w * BLOCK_SCALE);
  let height = Math.round(h * BLOCK_SCALE);
  height = Math.max(height, Math.max(inputs, outputs) * 16);
  return { width, height };
}

/** Seta de porta (aberta, apontando para dentro do bloco na entrada e para fora na saída). */
function chevron(x: number, y: number, angleDeg: number): string {
  const a = (angleDeg * Math.PI) / 180;
  // Ponta em (x, y), abertura voltada para `angleDeg + 180`.
  const back = (offset: number) => {
    const bx = x - Math.cos(a) * 5 + Math.cos(a + Math.PI / 2) * offset;
    const by = y + Math.sin(a) * 5 - Math.sin(a + Math.PI / 2) * offset;
    return `${bx.toFixed(2)} ${by.toFixed(2)}`;
  };
  return `<path d="M ${back(4)} L ${x.toFixed(2)} ${y.toFixed(2)} L ${back(-4)}" fill="none" stroke="${INK}" stroke-width="1.2"/>`;
}

interface PlacedPort { id: string; x: number; y: number; angle: 0 | 90 | 180 | 270 }

/** Posição das portas em coordenadas do pacote (o corpo começa em x = PORT). */
function placePorts(g: Geometry): PlacedPort[] {
  const w = g.width, h = g.height;
  const placed: PlacedPort[] = [];
  if (g.spec.id === "sum" && g.props.IconShape === "round") {
    const r = Math.min(w, h) / 2;
    const cx = PORT + w / 2, cy = h / 2;
    roundPortAngles(String(g.props.Inputs ?? "")).forEach(({ angle }, index) => {
      const port = g.inputs[index];
      if (!port) return;
      const degrees = Math.round((angle * 180) / Math.PI);
      const snapped = (degrees >= 135 && degrees <= 225 ? 180 : degrees < 135 ? 90 : 270) as 90 | 180 | 270;
      placed.push({ id: port.id, x: cx + Math.cos(angle) * (r + PORT), y: cy - Math.sin(angle) * (r + PORT), angle: snapped });
    });
    g.outputs.forEach((port) => placed.push({ id: port.id, x: cx + r + PORT, y: cy, angle: 0 }));
    return placed;
  }
  g.inputs.forEach((port, index) => placed.push({ id: port.id, x: 0, y: portY(h, index, g.inputs.length), angle: 180 }));
  const right = PORT + w + PORT;
  g.outputs.forEach((port, index) => placed.push({ id: port.id, x: right, y: portY(h, index, g.outputs.length), angle: 0 }));
  return placed;
}

/** Desenho completo (corpo + setas) e pinos do símbolo da instância. */
export function blockPackage(spec: BlockSpec, properties: BlockProperties, size?: [number, number]): PackageDescriptor {
  const props = withDefaults(spec, properties);
  const ports = resolveBlockPorts(spec, props);
  const { width, height } = bodySize(spec, ports.inputs.length, ports.outputs.length, size);
  const g: Geometry = { spec, props, width, height, inputs: ports.inputs, outputs: ports.outputs };
  const placed = placePorts(g);
  const arrows = placed.map((port) => {
    if (port.angle === 0) return chevron(port.x, port.y, 0);
    // Entrada: seta aponta PARA o corpo; a ponta fica na borda do corpo.
    const a = (port.angle * Math.PI) / 180;
    return chevron(port.x - Math.cos(a) * PORT, port.y + Math.sin(a) * PORT, port.angle + 180);
  });
  const svg = `<g class="sl-block" transform="translate(${PORT},0)">${iconSvg(g)}</g>${arrows.join("")}`;
  const shapes: PackageShape[] = [{ kind: "svg", value: svg }];
  const pins: PackagePin[] = placed.map((port) => ({ id: port.id, x: Number(port.x.toFixed(2)), y: Number(port.y.toFixed(2)), angle: port.angle, length: 0, label: "" }));
  return { width: width + 2 * PORT, height, border: false, shapes, pins };
}
