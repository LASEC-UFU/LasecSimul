import * as assert from "node:assert";
import { shouldRenderSimulationSnapshot, simulationControlModel } from "./simulationControls.js";

assert.deepStrictEqual(simulationControlModel("stopped"), {
  primaryIcon: "start",
  primaryLabelKey: "runSimulation",
  primaryAction: "run",
  stopDisabled: true,
});
assert.deepStrictEqual(simulationControlModel("running"), {
  primaryIcon: "pause",
  primaryLabelKey: "pauseSimulation",
  primaryAction: "pause-toggle",
  stopDisabled: false,
});
assert.deepStrictEqual(simulationControlModel("paused"), {
  primaryIcon: "start",
  primaryLabelKey: "continueSimulation",
  primaryAction: "pause-toggle",
  stopDisabled: false,
});

assert.strictEqual(shouldRenderSimulationSnapshot("running"), true);
assert.strictEqual(shouldRenderSimulationSnapshot("paused"), true, "Pause preserva o último frame visual");
assert.strictEqual(shouldRenderSimulationSnapshot("stopped"), false, "Stop restaura o estado inicial");

console.log("simulationControls tests passed");
