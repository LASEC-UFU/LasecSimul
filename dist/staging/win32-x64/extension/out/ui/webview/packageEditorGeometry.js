"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.pinTip = pinTip;
exports.computeBounds = computeBounds;
exports.shapeOrigin = shapeOrigin;
exports.applyShapeOrigin = applyShapeOrigin;
exports.inferPinPlacement = inferPinPlacement;
exports.nextFreePinId = nextFreePinId;
/** Mesma convenção de `componentSymbols.ts::resolvePackageLayout`: `x`/`y` é onde o lead toca o
 * corpo; a ponta real é `x + cos(angle)*length, y + sin(angle)*length` (graus, convenção SVG —
 * y pra baixo, 0=direita/90=baixo/180=esquerda/270=cima). */
function pinTip(pin) {
    const rad = (pin.angle * Math.PI) / 180;
    return { x: pin.x + Math.cos(rad) * pin.length, y: pin.y + Math.sin(rad) * pin.length };
}
/** Mesmo cálculo de `componentSymbols.ts::resolvePackageLayout` -- o canvas do editor precisa da
 * MESMA folga (leads podem sair de propósito de `0..width`/`0..height`) pra nada cortar/sair da
 * viewBox visível. */
function computeBounds(pkg) {
    let minX = 0;
    let minY = 0;
    let maxX = pkg.width;
    let maxY = pkg.height;
    for (const pin of pkg.pins) {
        const tip = pinTip(pin);
        minX = Math.min(minX, tip.x, pin.x);
        maxX = Math.max(maxX, tip.x, pin.x);
        minY = Math.min(minY, tip.y, pin.y);
        maxY = Math.max(maxY, tip.y, pin.y);
    }
    return { minX, minY, maxX, maxY };
}
/** Ponto "de origem" de uma forma -- o que se move quando o usuário arrasta a forma pelo corpo
 * (canto superior-esquerdo do rect/texto, centro da elipse, primeiro ponto da linha). */
function shapeOrigin(shape) {
    switch (shape.kind) {
        case "rect": return { x: shape.x ?? 0, y: shape.y ?? 0 };
        case "ellipse": return { x: shape.cx ?? 0, y: shape.cy ?? 0 };
        case "line": return { x: shape.x1 ?? 0, y: shape.y1 ?? 0 };
        case "text":
        default: return { x: shape.x ?? 0, y: shape.y ?? 0 };
    }
}
/** Move a forma TODA pra `next` (delta aplicado a TODOS os pontos da forma) -- uma linha precisa
 * mover os dois pontos juntos (não só `x1`/`y1`), senão "arrastar" estica em vez de mover. Modifica
 * `shape` no lugar (mesmo padrão de `applyPinAnchor`/quem chama em `packageEditor.ts`). */
function applyShapeOrigin(shape, next) {
    const prev = shapeOrigin(shape);
    const dx = next.x - prev.x;
    const dy = next.y - prev.y;
    switch (shape.kind) {
        case "rect":
            shape.x = Math.round(next.x);
            shape.y = Math.round(next.y);
            break;
        case "ellipse":
            shape.cx = Math.round(next.x);
            shape.cy = Math.round(next.y);
            break;
        case "line":
            shape.x1 = Math.round(next.x);
            shape.y1 = Math.round(next.y);
            shape.x2 = Math.round((shape.x2 ?? 0) + dx);
            shape.y2 = Math.round((shape.y2 ?? 0) + dy);
            break;
        case "text":
        default:
            shape.x = Math.round(next.x);
            shape.y = Math.round(next.y);
            break;
    }
}
/** Clique em qualquer ponto perto do corpo (`width`x`height`) -> qual lado é mais próximo, e a
 * posição/ângulo de pino correspondente (preso à borda daquele lado, ângulo apontando pra fora) --
 * ver `.spec/lasecsimul-native-devices.spec` seção 21.3 ("clicar na borda do corpo adiciona pino"). */
function inferPinPlacement(point, width, height) {
    const distances = [
        { side: "top", distance: Math.abs(point.y) },
        { side: "bottom", distance: Math.abs(point.y - height) },
        { side: "left", distance: Math.abs(point.x) },
        { side: "right", distance: Math.abs(point.x - width) },
    ];
    distances.sort((a, b) => a.distance - b.distance);
    const side = distances[0]?.side ?? "right";
    const clampedX = Math.max(0, Math.min(width, point.x));
    const clampedY = Math.max(0, Math.min(height, point.y));
    if (side === "top")
        return { side, x: clampedX, y: 0, angle: 270 };
    if (side === "bottom")
        return { side, x: clampedX, y: height, angle: 90 };
    if (side === "left")
        return { side, x: 0, y: clampedY, angle: 180 };
    return { side, x: width, y: clampedY, angle: 0 };
}
/** Próximo `id` livre no formato `pin1`, `pin2`, ... -- usado ao adicionar um pino novo sem nome
 * escolhido pelo usuário ainda (campo "Id" no painel lateral deixa renomear depois). */
function nextFreePinId(existingIds) {
    const taken = new Set(existingIds);
    let suffix = taken.size + 1;
    let id = `pin${suffix}`;
    while (taken.has(id))
        id = `pin${++suffix}`;
    return id;
}
//# sourceMappingURL=packageEditorGeometry.js.map