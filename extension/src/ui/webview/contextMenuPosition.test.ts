import * as assert from "assert";
import {
  contextMenuViewportSize,
  positionContextSubmenu,
  positionRootContextMenu,
} from "./contextMenuPosition";

const viewport = { width: 800, height: 600 };

assert.deepStrictEqual(
  positionRootContextMenu({ x: 100, y: 80 }, { width: 240, height: 160 }, viewport),
  { left: 100, top: 80 },
  "a posição preferencial deve ser preservada quando há espaço",
);

assert.deepStrictEqual(
  positionRootContextMenu({ x: 760, y: 570 }, { width: 240, height: 160 }, viewport),
  { left: 520, top: 410 },
  "o menu principal deve inverter horizontal e verticalmente nas bordas",
);

assert.deepStrictEqual(
  positionContextSubmenu(
    { left: 300, top: 120, right: 500, bottom: 152 },
    { width: 220, height: 180 },
    viewport,
  ),
  { left: 500, top: 120, direction: "right" },
  "o submenu deve abrir à direita e alinhado ao item quando couber",
);

assert.deepStrictEqual(
  positionContextSubmenu(
    { left: 610, top: 500, right: 790, bottom: 532 },
    { width: 220, height: 180 },
    viewport,
  ),
  { left: 390, top: 412, direction: "left" },
  "o submenu deve abrir à esquerda e subir somente o necessário perto das bordas",
);

assert.deepStrictEqual(
  contextMenuViewportSize({ width: 320, height: 200 }),
  { width: 304, height: 184 },
  "menus maiores que o viewport devem receber limites que preservem a margem visível",
);

console.log("contextMenuPosition tests passed");
