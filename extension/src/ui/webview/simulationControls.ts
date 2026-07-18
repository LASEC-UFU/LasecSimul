import { SimulationStatus } from "./messages.js";

export interface SimulationControlModel {
  primaryIcon: "start" | "pause";
  primaryLabelKey: "runSimulation" | "pauseSimulation" | "continueSimulation";
  primaryAction: "run" | "pause-toggle";
  stopDisabled: boolean;
}

/**
 * Modelo puro dos dois controles da simulação. Mantê-lo fora do DOM evita que
 * ícone, acessibilidade e ação se desencontrem em alguma transição de estado.
 */
export function simulationControlModel(status: SimulationStatus): SimulationControlModel {
  if (status === "running") {
    return {
      primaryIcon: "pause",
      primaryLabelKey: "pauseSimulation",
      primaryAction: "pause-toggle",
      stopDisabled: false,
    };
  }
  if (status === "paused") {
    return {
      primaryIcon: "start",
      primaryLabelKey: "continueSimulation",
      primaryAction: "pause-toggle",
      stopDisabled: false,
    };
  }
  return {
    primaryIcon: "start",
    primaryLabelKey: "runSimulation",
    primaryAction: "run",
    stopDisabled: true,
  };
}

/**
 * Durante Pause a Webview deve continuar desenhando o último frame convergido. Somente Stop
 * invalida a telemetria e devolve componentes/fios ao estado inicial.
 */
export function shouldRenderSimulationSnapshot(status: SimulationStatus): boolean {
  return status !== "stopped";
}
