/**
 * Páginas compostas do Laboratório (docs/65 §3.9): tanque, primeira ordem e sensor montados só com
 * elementos de tela (cartões, tanque de processo, gráficos do processo, parâmetros da planta, controles,
 * leituras e equações) no estilo do doc 55. Diferente da página de atividade (um `<iframe>` fechado), aqui
 * cada peça é um elemento que o professor move, troca e configura. Usado pelos exemplos
 * (`scripts/generate-calculus-lab-examples.cjs`) e por "+ Página do Laboratório" na edição.
 */
import type { HmiPage, HmiPageElement } from "./model.js";
import {
  MATH_CARD_TYPE_ID, MATH_PLANT_PARAMETER_TYPE_ID, MATH_PROCESS_TANK_TYPE_ID, MATH_READOUT_TYPE_ID, MATH_SERIES_CHART_TYPE_ID, MATH_SIM_CONTROLS_TYPE_ID,
} from "./labWidgets.js";
import { MATH_EQUATION_TYPE_ID } from "./mathWidgets.js";

export type ComposedPlantKind = "tank" | "firstOrder" | "sensor";

export const COMPOSED_PAGE_WIDTH = 1920;
export const COMPOSED_PAGE_HEIGHT = 1080;

const element = (id: string, typeId: string, x: number, y: number, width: number, height: number, properties: Record<string, unknown>): HmiPageElement =>
  ({ id, typeId, label: id, properties: { width, height, ...properties }, visual: { x, y, width, height, rotation: 0 } } as HmiPageElement);

/** Fileira de baixo: cartão de equações (três fórmulas com os valores da planta) e cartão "Explore". */
function bottomRow(prefix: string, plant: string, equations: Array<Record<string, unknown>>, explore: string): HmiPageElement[] {
  const elements = [
    element(`${prefix}-cartao-equacoes`, MATH_CARD_TYPE_ID, 24, 808, 1386, 248, { title: "Equações do processo", icon: "sigma", variant: "dark", titleStyle: "plain", titleSize: 16, accentColor: "#93c5fd" }),
    element(`${prefix}-explore`, MATH_CARD_TYPE_ID, 1434, 808, 462, 248, {
      title: "Explore:", icon: "bulb", variant: "dark", titleStyle: "accent", accentColor: "#f59e0b", titleSize: 22, textSize: 17, text: explore,
    }),
  ];
  const width = Math.floor((1386 - 40) / equations.length);
  equations.forEach((equation, index) => {
    elements.push(element(`${prefix}-equacao-${index + 1}`, MATH_EQUATION_TYPE_ID, 44 + index * width, 868, width - 12, 160, {
      lhs: "", variable: "", substitute: false, showValue: true, decimals: 2, fontSize: 32, background: "none", color: "#e8eef8", plantComponentId: plant, ...equation,
    }));
  });
  return elements;
}

function tankPage(plant: string, suffix: string): HmiPage {
  const p = `tanque${suffix}`;
  return {
    id: `pagina-tanque-composta${suffix}`, name: "Tanque — da vazão à integral", width: COMPOSED_PAGE_WIDTH, height: COMPOSED_PAGE_HEIGHT,
    elements: [
      element(`${p}-cartao-processo`, MATH_CARD_TYPE_ID, 24, 24, 936, 760, { title: "Processo em tempo real", icon: "process", variant: "dark" }),
      element(`${p}-tanque`, MATH_PROCESS_TANK_TYPE_ID, 40, 92, 450, 590, { plantComponentId: plant }),
      element(`${p}-leitura-v`, MATH_READOUT_TYPE_ID, 520, 96, 410, 84, { plantComponentId: plant, quantity: "V", decimals: 1, fontSize: 34, label: "Volume no tanque" }),
      element(`${p}-leitura-h`, MATH_READOUT_TYPE_ID, 520, 184, 410, 84, { plantComponentId: plant, quantity: "h", decimals: 3, fontSize: 34, label: "Nível" }),
      element(`${p}-vazao-entrada`, MATH_PLANT_PARAMETER_TYPE_ID, 516, 300, 420, 76, { plantComponentId: plant, parameterId: "qIn" }),
      element(`${p}-vazao-saida`, MATH_PLANT_PARAMETER_TYPE_ID, 516, 392, 420, 76, { plantComponentId: plant, parameterId: "qOut" }),
      element(`${p}-area`, MATH_PLANT_PARAMETER_TYPE_ID, 516, 484, 420, 76, { plantComponentId: plant, parameterId: "area" }),
      element(`${p}-controles`, MATH_SIM_CONTROLS_TYPE_ID, 44, 700, 620, 68, { plantComponentId: plant }),
      element(`${p}-grafico-nivel`, MATH_SERIES_CHART_TYPE_ID, 984, 24, 912, 372, {
        plantComponentId: plant, channel: "h", title: "Nível × tempo", color: "#2563eb", showTangent: true, showSecant: true, a: 0, b: -1, cursor: -1,
      }),
      element(`${p}-grafico-vazao`, MATH_SERIES_CHART_TYPE_ID, 984, 412, 912, 372, {
        plantComponentId: plant, channel: "q", title: "Vazão líquida × tempo", color: "#0891b2", showRiemann: true, showArea: true, riemannN: 12, a: 0, b: -1, cursor: -1,
      }),
      ...bottomRow(p, plant, [
        { formula: "q = q_e - q_s", expression: "inActual - outActual", unit: "L/s", decimals: 2 },
        { formula: "dh/dt = q/A", expression: "q/(1000 A)", unit: "m/s", decimals: 4 },
        { formula: "V = V_0 + Integrate(tau, 0, t, q)", expression: "V", unit: "L", decimals: 1 },
      ], "Como a vazão altera a inclinação da curva? Com a simulação rodando, mude a vazão de entrada e compare a tangente dh/dt com q/A."),
    ],
  };
}

function firstOrderPage(plant: string, suffix: string): HmiPage {
  const p = `primeira-ordem${suffix}`;
  return {
    id: `pagina-primeira-ordem-composta${suffix}`, name: "Primeira ordem — exponencial", width: COMPOSED_PAGE_WIDTH, height: COMPOSED_PAGE_HEIGHT,
    elements: [
      element(`${p}-cartao-processo`, MATH_CARD_TYPE_ID, 24, 24, 936, 760, { title: "Processo em tempo real", icon: "chart", variant: "dark" }),
      element(`${p}-modelo`, MATH_EQUATION_TYPE_ID, 44, 96, 896, 130, {
        formula: "Y/U = K/(tau s + 1)", lhs: "", variable: "", showValue: false, fontSize: 40, background: "glass",
      }),
      element(`${p}-leitura-y`, MATH_READOUT_TYPE_ID, 60, 250, 420, 84, { plantComponentId: plant, quantity: "y", decimals: 3, fontSize: 36, label: "Saída" }),
      element(`${p}-leitura-u`, MATH_READOUT_TYPE_ID, 500, 250, 420, 84, { plantComponentId: plant, quantity: "u", decimals: 2, fontSize: 36, label: "Entrada (degrau)" }),
      element(`${p}-degrau`, MATH_PLANT_PARAMETER_TYPE_ID, 44, 366, 430, 76, { plantComponentId: plant, parameterId: "u" }),
      element(`${p}-ganho`, MATH_PLANT_PARAMETER_TYPE_ID, 500, 366, 430, 76, { plantComponentId: plant, parameterId: "K" }),
      element(`${p}-tau`, MATH_PLANT_PARAMETER_TYPE_ID, 44, 466, 430, 76, { plantComponentId: plant, parameterId: "tau" }),
      element(`${p}-y0`, MATH_PLANT_PARAMETER_TYPE_ID, 500, 466, 430, 76, { plantComponentId: plant, parameterId: "y0" }),
      element(`${p}-dica`, MATH_CARD_TYPE_ID, 44, 570, 896, 110, {
        title: "", variant: "glass", textSize: 16,
        text: "u muda com a simulação rodando (é um degrau na entrada); K, τ e y₀ mudam o modelo, por isso só com a simulação parada: use Reiniciar.",
      }),
      element(`${p}-controles`, MATH_SIM_CONTROLS_TYPE_ID, 44, 700, 620, 68, { plantComponentId: plant }),
      element(`${p}-grafico-saida`, MATH_SERIES_CHART_TYPE_ID, 984, 24, 912, 500, {
        plantComponentId: plant, channel: "y", title: "Resposta y(t)", color: "#2563eb", showTangent: true, cursor: -1, minSeconds: 20,
      }),
      element(`${p}-grafico-entrada`, MATH_SERIES_CHART_TYPE_ID, 984, 540, 912, 244, {
        plantComponentId: plant, channel: "u", title: "Entrada u(t)", color: "#f97316", showCursor: false, minSeconds: 20, titleSize: 18,
      }),
      ...bottomRow(p, plant, [
        { formula: "y_tau = 0.632 K u", expression: "0.632 K u", decimals: 3 },
        { formula: "dy/dt = (K u - y)/tau", expression: "(K u - y)/tau", decimals: 3 },
        { formula: "y = K u (1 - e^(-t/tau))", showValue: false },
      ], "Quanto tempo y leva para chegar a 63,2 % do salto? Pare, mude τ, reinicie e compare o tempo com o novo τ."),
    ],
  };
}

function sensorPage(plant: string, suffix: string): HmiPage {
  const p = `sensor${suffix}`;
  return {
    id: `pagina-sensor-composta${suffix}`, name: "Sensor 4–20 mA — função afim", width: COMPOSED_PAGE_WIDTH, height: COMPOSED_PAGE_HEIGHT,
    elements: [
      element(`${p}-cartao-processo`, MATH_CARD_TYPE_ID, 24, 24, 936, 760, { title: "Transmissor no laço 4–20 mA", icon: "gauge", variant: "dark" }),
      element(`${p}-modelo`, MATH_EQUATION_TYPE_ID, 44, 96, 896, 140, {
        formula: "I = 4 + 16 (P - P_min)/(P_max - P_min)", lhs: "", variable: "", showValue: false, fontSize: 38, background: "glass",
      }),
      element(`${p}-leitura-p`, MATH_READOUT_TYPE_ID, 60, 262, 420, 92, { plantComponentId: plant, quantity: "p", decimals: 1, fontSize: 40, label: "Pressão medida" }),
      element(`${p}-leitura-i`, MATH_READOUT_TYPE_ID, 500, 262, 420, 92, { plantComponentId: plant, quantity: "i", decimals: 2, fontSize: 40, label: "Corrente no laço", color: "#86efac" }),
      element(`${p}-pressao`, MATH_PLANT_PARAMETER_TYPE_ID, 44, 384, 896, 76, { plantComponentId: plant, parameterId: "p" }),
      element(`${p}-pmin`, MATH_PLANT_PARAMETER_TYPE_ID, 44, 476, 430, 76, { plantComponentId: plant, parameterId: "pmin" }),
      element(`${p}-pmax`, MATH_PLANT_PARAMETER_TYPE_ID, 500, 476, 430, 76, { plantComponentId: plant, parameterId: "pmax" }),
      element(`${p}-dica`, MATH_CARD_TYPE_ID, 44, 572, 896, 110, {
        title: "", variant: "glass", textSize: 16,
        text: "Fora da faixa o transmissor satura, como num laço real: abaixo de Pmin a corrente fica em 3,8 mA e acima de Pmax em 20,5 mA.",
      }),
      element(`${p}-controles`, MATH_SIM_CONTROLS_TYPE_ID, 44, 700, 620, 68, { plantComponentId: plant }),
      element(`${p}-grafico-corrente`, MATH_SERIES_CHART_TYPE_ID, 984, 24, 912, 372, {
        plantComponentId: plant, channel: "i", title: "Corrente I(t)", color: "#16a34a", minSeconds: 20,
      }),
      element(`${p}-grafico-pressao`, MATH_SERIES_CHART_TYPE_ID, 984, 412, 912, 372, {
        plantComponentId: plant, channel: "p", title: "Pressão P(t)", color: "#2563eb", minSeconds: 20,
      }),
      ...bottomRow(p, plant, [
        { formula: "I = 4 + 16 x", expression: "4 + 16 (p - pmin)/(pmax - pmin)", unit: "mA", decimals: 2 },
        { formula: "x = (P - P_min)/(P_max - P_min)", expression: "(p - pmin)/(pmax - pmin)", decimals: 3 },
        { formula: "dI/dP = 16/(P_max - P_min)", expression: "16/(pmax - pmin)", unit: "mA/kPa", decimals: 4 },
      ], "Em que pressão a corrente chega a 12 mA? E acima de Pmax, o que acontece com a reta?"),
    ],
  };
}

/** Página composta do processo `kind` ligada à planta `plantComponentId` (vazio: o professor escolhe depois). */
export function labComposedPage(kind: ComposedPlantKind, plantComponentId: string, suffix = ""): HmiPage {
  if (kind === "tank") return tankPage(plantComponentId, suffix);
  if (kind === "firstOrder") return firstOrderPage(plantComponentId, suffix);
  return sensorPage(plantComponentId, suffix);
}

export const isComposedPlantKind = (kind: string): kind is ComposedPlantKind => kind === "tank" || kind === "firstOrder" || kind === "sensor";
