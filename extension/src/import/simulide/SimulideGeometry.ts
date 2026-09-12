import type { WebviewComponentCatalogEntry } from "../../ui/webview/model";
import type { SimulideAttributes } from "./SimulideTypes";

export function parseSimulidePosition(attributes: SimulideAttributes): { x: number; y: number } {
  const raw = attributes.Pos;
  if (raw) {
    const [xRaw, yRaw] = raw.split(",");
    const x = Number(xRaw);
    const y = Number(yRaw);
    if (Number.isFinite(x) && Number.isFinite(y)) return { x, y };
  }

  const x = Number(attributes.x ?? 0);
  const y = Number(attributes.y ?? 0);
  return {
    x: Number.isFinite(x) ? x : 0,
    y: Number.isFinite(y) ? y : 0,
  };
}

export function parseSimulidePoint(raw: string | undefined): { x: number; y: number } | undefined {
  if (!raw) return undefined;
  const [xRaw, yRaw] = raw.split(",");
  const x = Number(xRaw);
  const y = Number(yRaw);
  return Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
}

export function normalizeSimulideRotation(raw: string | number | undefined): {
  rotation: 0 | 90 | 180 | 270;
  rounded: boolean;
  original: number;
} {
  const numeric = Number(raw ?? 0);
  const original = Number.isFinite(numeric) ? numeric : 0;
  const normalized = ((original % 360) + 360) % 360;
  const cardinals = [0, 90, 180, 270] as const;
  let rotation: 0 | 90 | 180 | 270 = 0;
  let distance = Number.POSITIVE_INFINITY;
  for (const candidate of cardinals) {
    const delta = Math.min(Math.abs(normalized - candidate), 360 - Math.abs(normalized - candidate));
    if (delta < distance) {
      distance = delta;
      rotation = candidate;
    }
  }
  return { rotation, rounded: distance > 0.001, original };
}

/**
 * `rotation` salvo pelo SimulIDE já inclui rotações fixas do construtor (Rail=+90°, Probe=-45°).
 * O catálogo do LasecSimul já reproduz isso em package.initialTransform, portanto precisamos retirar
 * essa parcela antes de persistir ProjectComponent.visual.rotation, senão a rotação seria aplicada
 * duas vezes.
 */
export function projectRotationForSimulide(
  attributes: SimulideAttributes,
  entry: WebviewComponentCatalogEntry
): ReturnType<typeof normalizeSimulideRotation> {
  const raw = Number(attributes.rotation ?? attributes.Angle ?? 0);
  const sourceRotation = Number.isFinite(raw) ? raw : 0;
  const initialRotation = entry.package?.initialTransform?.rotateDeg ?? 0;
  return normalizeSimulideRotation(sourceRotation - initialRotation);
}

export function simulideFlipEnabled(raw: string | undefined): boolean {
  if (raw === undefined) return false;
  const normalized = raw.trim().toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  const numeric = Number(normalized);
  // SimulIDE usa multiplicador +1/-1 para flip. -1 significa espelhado.
  return Number.isFinite(numeric) ? numeric < 0 : false;
}

export function simulideBoolean(raw: string | undefined): boolean | undefined {
  if (raw === undefined) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(normalized)) return true;
  if (["0", "false", "no", "off"].includes(normalized)) return false;
  return undefined;
}

/** Converte um ponto local do QGraphicsItem do SimulIDE para deslocamento de cena a partir de Pos. */
export function simulideLocalPointToSceneDelta(
  point: { x: number; y: number },
  attributes: SimulideAttributes
): { x: number; y: number } {
  let x = point.x;
  let y = point.y;
  if (simulideFlipEnabled(attributes.hflip)) x = -x;
  if (simulideFlipEnabled(attributes.vflip)) y = -y;
  const angle = Number(attributes.rotation ?? attributes.Angle ?? 0);
  const radians = (Number.isFinite(angle) ? angle : 0) * Math.PI / 180;
  const cosine = Math.cos(radians);
  const sine = Math.sin(radians);
  return { x: x * cosine - y * sine, y: x * sine + y * cosine };
}

/**
 * Labels são filhos do componente no SimulIDE e herdam a rotação do pai; no LasecSimul são DIVs de
 * cena independentes. Somamos pai + labelrot para obter a orientação visual equivalente na tela.
 */
export function simulideLabelSceneRotation(
  attributes: SimulideAttributes,
  rawLabelRotation: string | undefined
): ReturnType<typeof normalizeSimulideRotation> {
  const parent = Number(attributes.rotation ?? attributes.Angle ?? 0);
  const child = Number(rawLabelRotation ?? 0);
  return normalizeSimulideRotation((Number.isFinite(parent) ? parent : 0) + (Number.isFinite(child) ? child : 0));
}
