import { PackageDescriptor, PackagePin, SYMBOL_PIN_TYPE_ID, TUNNEL_TYPE_ID, WebviewComponentModel, WebviewProjectState } from "./model";

export type SubcircuitSymbolMode = "generic" | "custom";

export interface GenericSubcircuitPin {
  id: string;
  label?: string;
}

export interface GenericSubcircuitSymbol {
  descriptor: PackageDescriptor;
  canvas: { width: number; height: number; border: boolean };
  elements: WebviewComponentModel[];
}

const GRID = 8;
const PIN_LENGTH = 8;
const PIN_SPACING = 16;
const FIRST_PIN_Y = 24;
const PIN_FONT_SIZE = 7;
const TITLE_FONT_SIZE = 11;

function snapUp(value: number): number {
  return Math.ceil(value / GRID) * GRID;
}

function estimatedTextWidth(text: string, fontSize: number, padding: number): number {
  return text.length * fontSize * 0.62 + padding;
}

function normalizedPins(pins: readonly GenericSubcircuitPin[]): Array<{ id: string; label: string }> {
  const seen = new Set<string>();
  const result: Array<{ id: string; label: string }> = [];
  for (const pin of pins) {
    const id = pin.id.trim();
    if (!id || seen.has(id)) continue;
    seen.add(id);
    result.push({ id, label: pin.label?.trim() || id });
  }
  return result;
}

/**
 * Builds the canonical generic package. The electrical point stays outside the body and the lead
 * ends exactly at its border, following `packagePinVisualEnd`'s existing angle convention.
 */
export function buildGenericSubcircuitPackage(name: string, rawPins: readonly GenericSubcircuitPin[]): PackageDescriptor {
  const pins = normalizedPins(rawPins);
  const leftPins = pins.filter((_, index) => index % 2 === 0);
  const rightPins = pins.filter((_, index) => index % 2 === 1);
  const widest = (items: readonly { label: string }[]) => items.reduce(
    (maximum, pin) => Math.max(maximum, estimatedTextWidth(pin.label, PIN_FONT_SIZE, 8)),
    0,
  );
  const title = name.trim() || "Subcircuit";
  const width = snapUp(Math.max(
    56,
    estimatedTextWidth(title, TITLE_FONT_SIZE, 16),
    widest(leftPins) + widest(rightPins) + 32,
  ));
  const rows = Math.ceil(pins.length / 2);
  const height = snapUp(Math.max(40, FIRST_PIN_Y + Math.max(0, rows - 1) * PIN_SPACING + 8));

  const packagePins: PackagePin[] = pins.map((pin, index) => {
    const left = index % 2 === 0;
    return {
      id: pin.id,
      label: pin.label,
      labelFontSize: PIN_FONT_SIZE,
      x: left ? -PIN_LENGTH : width + PIN_LENGTH,
      y: FIRST_PIN_Y + Math.floor(index / 2) * PIN_SPACING,
      angle: left ? 180 : 0,
      length: PIN_LENGTH,
    };
  });

  return {
    width,
    height,
    border: true,
    pins: packagePins,
    shapes: [{
      kind: "text",
      x: width / 2,
      y: 10,
      value: title,
      fontSize: TITLE_FONT_SIZE,
      textAnchor: "middle",
      dominantBaseline: "middle",
    }],
  };
}

function pinBoxSide(length: number): number {
  return Math.max(14, length * 2 + 6);
}

/** Materializes only the small subset emitted by `buildGenericSubcircuitPackage`. */
export function buildGenericSubcircuitSymbol(
  name: string,
  pins: readonly GenericSubcircuitPin[],
  idFactory: () => string,
  existingElements: readonly WebviewComponentModel[] = [],
): GenericSubcircuitSymbol {
  const descriptor = buildGenericSubcircuitPackage(name, pins);
  const existingPinIds = new Map<string, string>();
  let existingTitleId: string | undefined;
  for (const element of existingElements) {
    if (element.typeId === SYMBOL_PIN_TYPE_ID && typeof element.properties.pinId === "string") {
      existingPinIds.set(element.properties.pinId, element.id);
    } else if (element.properties.__genericSymbolTitle === true) {
      existingTitleId = element.id;
    }
  }

  const elements: WebviewComponentModel[] = descriptor.pins.map((pin) => {
    const length = Number(pin.length);
    const box = pinBoxSide(length);
    const angle = Number(pin.angle);
    return {
      id: existingPinIds.get(pin.id) ?? idFactory(),
      typeId: SYMBOL_PIN_TYPE_ID,
      label: pin.label ?? pin.id,
      x: Number(pin.x) - box / 2,
      y: Number(pin.y) - box / 2,
      rotation: ((180 - angle + 360) % 360) as 0 | 90 | 180 | 270,
      pins: [],
      properties: { pinId: pin.id, length },
    };
  });

  const title = name.trim() || "Subcircuit";
  const titleWidth = Math.max(24, estimatedTextWidth(title, TITLE_FONT_SIZE, 12));
  const titleHeight = TITLE_FONT_SIZE + 14;
  elements.push({
    id: existingTitleId ?? idFactory(),
    typeId: "graphics.text",
    label: "graphics.text",
    x: Math.round(descriptor.width / 2 - titleWidth / 2),
    y: Math.round(10 - titleHeight / 2),
    rotation: 0,
    pins: [],
    locked: true,
    properties: {
      __symbolShapeOrder: 0,
      __genericSymbolTitle: true,
      text: title,
      fontSize: TITLE_FONT_SIZE,
    },
  });

  return {
    descriptor,
    canvas: { width: descriptor.width, height: descriptor.height, border: true },
    elements,
  };
}

export function genericPinsFromSymbolElements(elements: readonly WebviewComponentModel[]): GenericSubcircuitPin[] {
  return elements
    .filter((element) => element.typeId === SYMBOL_PIN_TYPE_ID && typeof element.properties.pinId === "string")
    .map((element) => ({ id: String(element.properties.pinId), label: element.label }));
}

function genericPinsFromState(state: WebviewProjectState): GenericSubcircuitPin[] {
  const authored = genericPinsFromSymbolElements(state.symbolElements);
  if (authored.length > 0) return authored;
  const pins: GenericSubcircuitPin[] = [];
  for (const element of state.components) {
    if (element.typeId !== TUNNEL_TYPE_ID) continue;
    const value = element.properties.pinId ?? element.properties.name;
    if (typeof value === "string") pins.push({ id: value, label: element.label || value });
  }
  return pins;
}

export function regenerateGenericSubcircuitState(
  state: WebviewProjectState,
  idFactory: () => string,
): WebviewProjectState {
  if (state.symbolMode !== "generic" || !state.subcircuitEditingContext) return state;
  const generated = buildGenericSubcircuitSymbol(
    state.subcircuitEditingContext.name,
    genericPinsFromState(state),
    idFactory,
    state.symbolElements,
  );
  return {
    ...state,
    symbolElements: generated.elements,
    symbolCanvas: generated.canvas,
    selectedComponentIds: state.selectedComponentIds.filter((id) => generated.elements.some((element) => element.id === id)),
  };
}
