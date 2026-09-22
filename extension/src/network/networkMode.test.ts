import { createTestRunner, assert } from "../ipc/testSupport/MockCoreServer";
import { resolveNetworkMode } from "./networkMode";

(async () => {
  const { test, finish } = createTestRunner("network mode migration");

  await test("isolated migrates to lab-router", () => {
    const result = resolveNetworkMode("isolated");
    assert(result.effectiveMode === "lab-router", "isolated deve usar lab-router no Core");
    assert(result.migratedLegacyIsolated, "a migração legada deve ser sinalizada");
  });

  await test("supported modes remain unchanged", () => {
    assert(resolveNetworkMode("lab-router").effectiveMode === "lab-router", "lab-router não deve mudar");
    assert(resolveNetworkMode("lab-bridge").effectiveMode === "lab-bridge", "lab-bridge não deve mudar");
    assert(!resolveNetworkMode("lab-router").migratedLegacyIsolated, "modo atual não é legado");
  });

  await test("unknown or missing modes are safe-disabled", () => {
    assert(resolveNetworkMode(undefined).effectiveMode === "disabled", "modo ausente deve desabilitar rede");
    assert(resolveNetworkMode("unknown").effectiveMode === "disabled", "modo desconhecido deve desabilitar rede");
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();
