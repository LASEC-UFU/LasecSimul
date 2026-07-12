import { CanonicalEndpoint, WebviewComponentModel, WebviewWireModel, endpointId, endpointPinId } from "../ui/webview/model";
import { componentLocalOrigin } from "../ui/webview/componentSymbols";

export interface SimulideSubcircuitScenePlacement {
  package?: { x: number; y: number };
  transform?: { scaleX?: number; scaleY?: number };
  components?: SimulideSubcircuitComponentPlacement[];
  wires?: SimulideSubcircuitWireRoute[];
}

export interface TranslatedSubcircuitScene {
  components: WebviewComponentModel[];
  wires: WebviewWireModel[];
}

interface WireEndpoint {
  componentId: string;
  pinId: string;
}

interface SimulideSubcircuitWireRoute {
  from: WireEndpoint;
  to: WireEndpoint;
  points: Array<{ x: number; y: number }>;
}

interface SimulideSubcircuitComponentPlacement {
  componentId: string;
  x: number;
  y: number;
  rotation?: WebviewComponentModel["rotation"];
  flipH?: boolean;
  flipV?: boolean;
  properties?: Record<string, string | number | boolean>;
}

function finiteNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined;
}

function normalizeRotation(value: number | undefined): WebviewComponentModel["rotation"] | undefined {
  if (value === undefined) return undefined;
  return (((Math.round(value / 90) * 90) % 360 + 360) % 360) as WebviewComponentModel["rotation"];
}

export function extractSimulideSubcircuitScene(json: Record<string, unknown>): SimulideSubcircuitScenePlacement | undefined {
  const raw = json.authoringScene;
  if (typeof raw !== "object" || raw === null) return undefined;
  const scene = raw as Record<string, unknown>;
  const rawPackage = scene.package;
  const packagePlacement = typeof rawPackage === "object" && rawPackage !== null
    ? (() => {
        const packageScene = rawPackage as Record<string, unknown>;
        const x = finiteNumber(packageScene.x);
        const y = finiteNumber(packageScene.y);
        return x === undefined || y === undefined ? undefined : { x, y };
      })()
    : undefined;
  const components = Array.isArray(scene.components)
    ? scene.components.map(sanitizeComponentPlacement).filter((component): component is SimulideSubcircuitComponentPlacement => Boolean(component))
    : undefined;
  const wires = Array.isArray(scene.wires) ? scene.wires.map(sanitizeWireRoute).filter((wire): wire is SimulideSubcircuitWireRoute => Boolean(wire)) : undefined;
  const rawTransform = scene.transform;
  const transform = typeof rawTransform === "object" && rawTransform !== null
    ? (() => {
        const transformScene = rawTransform as Record<string, unknown>;
        const scaleX = finiteNumber(transformScene.scaleX);
        const scaleY = finiteNumber(transformScene.scaleY);
        return scaleX === undefined && scaleY === undefined ? undefined : { ...(scaleX !== undefined ? { scaleX } : {}), ...(scaleY !== undefined ? { scaleY } : {}) };
      })()
    : undefined;
  if (!packagePlacement && (!components || components.length === 0) && (!wires || wires.length === 0)) return undefined;
  return {
    ...(packagePlacement ? { package: packagePlacement } : {}),
    ...(transform ? { transform } : {}),
    ...(components && components.length > 0 ? { components } : {}),
    ...(wires && wires.length > 0 ? { wires } : {}),
  };
}

function translatePackageComponents(components: WebviewComponentModel[], target: { x: number; y: number } | undefined): WebviewComponentModel[] {
  if (!target) return components;
  const packageBody = components.find((component) => component.typeId === "other.package");
  if (!packageBody) return components;
  const dx = target.x - packageBody.x;
  const dy = target.y - packageBody.y;
  if (dx === 0 && dy === 0) return components;
  return components.map((component) => ({
    ...component,
    x: Math.round(component.x + dx),
    y: Math.round(component.y + dy),
  }));
}

function sanitizeEndpoint(value: unknown): WireEndpoint | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  return typeof raw.componentId === "string" && raw.componentId.trim() && typeof raw.pinId === "string" && raw.pinId.trim()
    ? { componentId: raw.componentId.trim(), pinId: raw.pinId.trim() }
    : undefined;
}

function sanitizeWireRoute(value: unknown): SimulideSubcircuitWireRoute | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const from = sanitizeEndpoint(raw.from);
  const to = sanitizeEndpoint(raw.to);
  if (!from || !to || !Array.isArray(raw.points)) return undefined;
  const points = raw.points
    .filter((point): point is Record<string, unknown> => typeof point === "object" && point !== null)
    .map((point) => ({ x: finiteNumber(point.x), y: finiteNumber(point.y) }))
    .filter((point): point is { x: number; y: number } => point.x !== undefined && point.y !== undefined);
  return points.length > 0 ? { from, to, points } : undefined;
}

function sanitizeComponentPlacement(value: unknown): SimulideSubcircuitComponentPlacement | undefined {
  if (typeof value !== "object" || value === null) return undefined;
  const raw = value as Record<string, unknown>;
  const componentId = typeof raw.componentId === "string" ? raw.componentId.trim() : "";
  const x = finiteNumber(raw.x);
  const y = finiteNumber(raw.y);
  if (!componentId || x === undefined || y === undefined) return undefined;
  const rotation = normalizeRotation(finiteNumber(raw.rotation));
  const properties = typeof raw.properties === "object" && raw.properties !== null
    ? Object.fromEntries(
        Object.entries(raw.properties as Record<string, unknown>)
          .filter((entry): entry is [string, string | number | boolean] =>
            typeof entry[0] === "string" &&
            (typeof entry[1] === "string" || typeof entry[1] === "number" || typeof entry[1] === "boolean")
          )
      )
    : undefined;
  return {
    componentId,
    x,
    y,
    ...(rotation !== undefined ? { rotation } : {}),
    ...(typeof raw.flipH === "boolean" ? { flipH: raw.flipH } : {}),
    ...(typeof raw.flipV === "boolean" ? { flipV: raw.flipV } : {}),
    ...(properties && Object.keys(properties).length > 0 ? { properties } : {}),
  };
}

function endpointKey(endpoint: WireEndpoint): string {
  return `${endpoint.componentId}:${endpoint.pinId}`;
}

function wireRouteKey(from: WireEndpoint | CanonicalEndpoint, to: WireEndpoint | CanonicalEndpoint): string {
  const keyOf = (endpoint: WireEndpoint | CanonicalEndpoint) =>
    "kind" in endpoint ? `${endpointId(endpoint)}:${endpointPinId(endpoint)}` : endpointKey(endpoint);
  const a = keyOf(from);
  const b = keyOf(to);
  return a < b ? `${a}|${b}` : `${b}|${a}`;
}

function sanitizePlacementProperties(properties: Record<string, string | number | boolean> | undefined): Record<string, string | number | boolean> {
  if (!properties) return {};
  const out: Record<string, string | number | boolean> = {};
  for (const [key, value] of Object.entries(properties)) {
    if (key === "__simulideSceneScaleX" || key === "__simulideSceneScaleY") continue;
    if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") out[key] = value;
  }
  return out;
}

function translateWireRoutes(wires: WebviewWireModel[], routes: SimulideSubcircuitWireRoute[] | undefined): WebviewWireModel[] {
  if (!routes || routes.length === 0) return wires;
  const routeBuckets = new Map<string, Array<Array<{ x: number; y: number }>>>();
  for (const route of routes) {
    const key = wireRouteKey(route.from, route.to);
    const bucket = routeBuckets.get(key);
    if (bucket) bucket.push(route.points);
    else routeBuckets.set(key, [route.points]);
  }
  const routeCursorByKey = new Map<string, number>();
  return wires.map((wire) => {
    const key = wireRouteKey(wire.from, wire.to);
    const bucket = routeBuckets.get(key);
    if (!bucket || bucket.length === 0) return wire;
    const cursor = routeCursorByKey.get(key) ?? 0;
    const points = bucket[Math.min(cursor, bucket.length - 1)];
    routeCursorByKey.set(key, cursor + 1);
    return points ? { ...wire, points: points.map((point) => ({ ...point })) } : wire;
  });
}

function translateComponentPlacements(components: WebviewComponentModel[], placements: SimulideSubcircuitComponentPlacement[] | undefined, transform: SimulideSubcircuitScenePlacement["transform"]): WebviewComponentModel[] {
  if (!placements || placements.length === 0) return components;
  const legacyTransformMode = transform?.scaleX !== undefined || transform?.scaleY !== undefined;
  const placementById = new Map(placements.map((placement) => [placement.componentId, placement]));
  return components.map((component) => {
    const placement = placementById.get(component.id);
    if (!placement) return component;
    const placementProperties: Record<string, string | number | boolean> = { ...(placement.properties ?? {}) };
    const persistentPlacementProperties = sanitizePlacementProperties(placementProperties);
    const translationProps: Record<string, string | number | boolean> = { ...component.properties, ...placementProperties };
    const intrinsicOrigin = componentLocalOrigin(component.typeId, translationProps);
    const placementUsesQtOrigin =
      placement.properties?.__simulideQtOrigin === true
      || (intrinsicOrigin !== undefined && placement.properties?.__simulideQtOrigin !== false)
      || (legacyTransformMode && placement.properties?.__simulideQtOrigin !== false);
    if (placementUsesQtOrigin) translationProps.__simulideQtOrigin = true;

    const explicitScaleX = placement.properties?.__simulideSceneScaleX;
    const explicitScaleY = placement.properties?.__simulideSceneScaleY;
    if (typeof explicitScaleX === "number" && Number.isFinite(explicitScaleX) && explicitScaleX > 0) {
      translationProps.__simulideSceneScaleX = explicitScaleX;
    } else if (placementUsesQtOrigin && transform?.scaleX !== undefined) {
      translationProps.__simulideSceneScaleX = transform.scaleX;
    }
    if (typeof explicitScaleY === "number" && Number.isFinite(explicitScaleY) && explicitScaleY > 0) {
      translationProps.__simulideSceneScaleY = explicitScaleY;
    } else if (placementUsesQtOrigin && transform?.scaleY !== undefined) {
      translationProps.__simulideSceneScaleY = transform.scaleY;
    }

    if (component.typeId === "connectors.tunnel") {
      translationProps.__simulideTunnelRotated =
        typeof translationProps.__simulideTunnelRotated === "boolean"
          ? translationProps.__simulideTunnelRotated
          : placement.flipH === true;
    }
    if (placementUsesQtOrigin) persistentPlacementProperties.__simulideQtOrigin = true;
    if (placementUsesQtOrigin && typeof translationProps.__simulideSceneScaleX === "number") {
      persistentPlacementProperties.__simulideSceneScaleX = translationProps.__simulideSceneScaleX;
    }
    if (placementUsesQtOrigin && typeof translationProps.__simulideSceneScaleY === "number") {
      persistentPlacementProperties.__simulideSceneScaleY = translationProps.__simulideSceneScaleY;
    }
    if (component.typeId === "connectors.tunnel" && typeof translationProps.__simulideTunnelRotated === "boolean") {
      persistentPlacementProperties.__simulideTunnelRotated = translationProps.__simulideTunnelRotated;
    }

    const properties = Object.keys(persistentPlacementProperties).length > 0
      ? { ...component.properties, ...persistentPlacementProperties }
      : component.properties;
    const localOrigin = componentLocalOrigin(component.typeId, translationProps);
    return {
      ...component,
      x: placementUsesQtOrigin && localOrigin ? placement.x - localOrigin.x : placement.x,
      y: placementUsesQtOrigin && localOrigin ? placement.y - localOrigin.y : placement.y,
      rotation: placement.rotation ?? component.rotation,
      flipH: component.typeId === "connectors.tunnel" ? false : placement.flipH,
      flipV: component.typeId === "connectors.tunnel" ? false : placement.flipV,
      properties,
    };
  });
}

/** Traduz a cena de "Abrir Subcircuito" do SimulIDE para a cena da Webview.
 * A regra principal e propositalmente simples: o circuito interno usa `components[].visual` e
 * `wires[].points` exatamente como persistidos; o `Package` usa a posicao declarada em
 * `authoringScene.package`; posicoes/rotacoes/flips de itens vindos de `authoringScene.components`
 * sao aplicados por componentId; rotas de fios vindas de `authoringScene.wires` sao copiadas por
 * endpoint.
 * Se esses dados nao foram localizados no manifesto, o tradutor nao inventa um layout por typeId nem
 * por bounds.
 *
 * **Aplicado UMA VEZ só** (bug corrigido 2026-07-06, ver `.spec/lasecsimul-subcircuits.spec` seção 13):
 * `authoringScene.components[]`/`.transform`/`.wires[]` são um SNAPSHOT CONGELADO da importação
 * original (nunca atualizado depois — `extension.ts::persistSubcircuitAuthoringScene` só reescreve
 * `.package`) — reaplicar isso em TODA reabertura descartava silenciosamente qualquer edição manual
 * (posição/rotação/rota de fio) feita depois da primeira vez, e pior: reaplicava
 * `__simulideSceneScaleX`/`__simulideSceneScaleY` (escala POR EIXO da conversão Qt-pixel -> grid,
 * quase nunca 1:1) num componente que JÁ tinha essas mesmas propriedades gravadas desde o save
 * anterior — inofensivo por si só (mesmo valor), mas o sintoma real era band a reaplicação de
 * `x`/`y`/`rotation`/`flip` do snapshot congelado ignorar qualquer ajuste manual feito depois. A
 * primeira vez que um componente passa por esta tradução, `translateComponentPlacements` grava
 * `properties.__simulideQtOrigin = true` nele -- usamos essa MESMA marca (já existente, não é campo
 * novo) como sinal de "sessão anterior já consumiu este snapshot": se QUALQUER componente interno já
 * carrega essa marca, a tradução inteira (componentes E fios, sempre da MESMA importação) é pulada,
 * e o circuito usa exatamente o que está salvo -- exatamente a mesma aparência entre save e reload. */
export function translateSimulideSubcircuitAuthoringScene(
  packageComponents: WebviewComponentModel[],
  internalComponents: WebviewComponentModel[],
  internalWires: WebviewWireModel[],
  scene: SimulideSubcircuitScenePlacement | undefined
): TranslatedSubcircuitScene {
  const alreadyTranslated = internalComponents.some((component) => component.properties?.__simulideQtOrigin === true);
  return {
    components: [
      ...translatePackageComponents(packageComponents, scene?.package),
      ...(alreadyTranslated ? internalComponents : translateComponentPlacements(internalComponents, scene?.components, scene?.transform)),
    ],
    wires: alreadyTranslated ? internalWires : translateWireRoutes(internalWires, scene?.wires),
  };
}
