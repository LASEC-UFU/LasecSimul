import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const subcircuitsDir = path.join(repoRoot, "subcircuits");
const imageDir = path.join(subcircuitsDir, "tdps-reference-images");

// O screen.bmp do TDPS é convertido previamente para PNG otimizado e usado como referência visual
// completa da planta (não um ícone de componente).
// Cada arquivo .lssubcircuit continua sendo a fonte funcional: a imagem só ocupa o fundo do símbolo,
// enquanto pinos/topologia/exposedComponents permanecem declarativos e editáveis.
const references = {
  "process_fopdt.lssubcircuit": "process_fopdt.png",
  "tdps_basic_flow_loop.lssubcircuit": "tdps_basic_flow_loop.png",
  "tdps_boiler_drum.lssubcircuit": "tdps_boiler_drum.png",
  "tdps_furnace_combustion.lssubcircuit": "tdps_furnace_combustion.png",
  "tdps_heat_exchanger.lssubcircuit": "tdps_heat_exchanger.png",
  "tdps_ph_neutralization.lssubcircuit": "tdps_ph_neutralization.png",
  "tdps_reactor_temperature.lssubcircuit": "tdps_reactor_temperature.png",
  "tdps_smith_predictor.lssubcircuit": "tdps_smith_predictor.png",
  "tdps_split_range.lssubcircuit": "tdps_split_range.png",
  "tdps_surge_tank_level.lssubcircuit": "tdps_surge_tank_level.png",
};

const CANVAS_WIDTH = 640;

function finite(value, fallback = 0) {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

for (const [fileName, imageName] of Object.entries(references)) {
  const filePath = path.join(subcircuitsDir, fileName);
  const imagePath = path.join(imageDir, imageName);
  if (!fs.existsSync(filePath)) throw new Error(`subcircuito ausente: ${filePath}`);
  if (!fs.existsSync(imagePath)) throw new Error(`imagem de referência ausente: ${imagePath}`);
  const document = JSON.parse(fs.readFileSync(filePath, "utf8"));
  // PNG IHDR: largura em 0x10, altura em 0x14 (big-endian). Mantemos a proporção da captura para
  // que a planta inteira seja visível e não seja esticada no símbolo.
  const imageBytes = fs.readFileSync(imagePath);
  const sourceWidth = imageBytes.length >= 24 ? imageBytes.readUInt32BE(16) : CANVAS_WIDTH;
  const sourceHeight = imageBytes.length >= 24 ? imageBytes.readUInt32BE(20) : 480;
  const canvasHeight = Math.max(120, Math.round(CANVAS_WIDTH * sourceHeight / Math.max(1, sourceWidth)));
  const previousWidth = finite(document.symbol?.width, CANVAS_WIDTH);
  const previousHeight = finite(document.symbol?.height, canvasHeight);
  const sx = CANVAS_WIDTH / Math.max(1, previousWidth);
  const sy = canvasHeight / Math.max(1, previousHeight);
  const previousPins = Array.isArray(document.symbol?.pins) ? document.symbol.pins : [];
  const pins = previousPins.map((pin) => ({ ...pin, x: finite(pin.x) * sx, y: finite(pin.y) * sy }));

  // Exponha somente componentes internos reais (nunca túneis): a exposição é uma projeção visual,
  // não uma cópia funcional. As posições são uma transformação determinística do layout interno.
  const internals = Array.isArray(document.components) ? document.components : [];
  const exposedComponents = internals
    .filter((component) => component && typeof component.id === "string" && component.typeId !== "connectors.tunnel")
    .map((component, layer) => ({
      componentId: component.id,
      x: finite(component.visual?.x, 0) * sx,
      y: finite(component.visual?.y, 0) * sy,
      rotation: component.visual?.rotation === 90 || component.visual?.rotation === 180 || component.visual?.rotation === 270 ? component.visual.rotation : 0,
      flipH: false,
      flipV: false,
      scale: 1,
      layer,
    }));

  document.symbolMode = "custom";
  document.symbol = {
    ...(document.symbol ?? {}),
    width: CANVAS_WIDTH,
    height: canvasHeight,
    border: true,
    // sanitizePackage() resolve este caminho relativo ao diretório do .lssubcircuit e embute o PNG
    // em data:image/png;base64 no catálogo/VSIX. Assim o símbolo funciona sem depender do filesystem.
    background: { kind: "image", asset: `tdps-reference-images/${imageName}`, mime: "image/png" },
    shapes: [],
    pins,
  };
  document.exposedComponents = exposedComponents;
  fs.writeFileSync(filePath, `${JSON.stringify(document, null, 2)}\n`, "utf8");
  console.log(`[tdps-reference] ${fileName} <- ${imageName}; exposed=${exposedComponents.length}`);
}
