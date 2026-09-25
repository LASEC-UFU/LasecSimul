import { createTestRunner, assert } from "../ipc/testSupport/MockCoreServer";
import { resolveNetworkMode } from "./networkMode";

(async () => {
  const { test, finish } = createTestRunner("network mode resolution");

  await test("isolated is a first-class no-admin mode", () => {
    const result = resolveNetworkMode("isolated");
    assert(result.effectiveMode === "isolated", "isolated deve ser enviado ao Core como isolated");
    assert(!result.migratedLegacyIsolated, "isolated não é mais migrado");
  });

  await test("supported modes remain unchanged", () => {
    assert(resolveNetworkMode("disabled").effectiveMode === "disabled", "disabled não deve mudar");
    assert(resolveNetworkMode("lab-router").effectiveMode === "lab-router", "lab-router não deve mudar");
    assert(resolveNetworkMode("lab-bridge").effectiveMode === "lab-bridge", "lab-bridge não deve mudar");
  });

  await test("unknown or missing modes default to transparent isolated", () => {
    assert(resolveNetworkMode(undefined).effectiveMode === "isolated", "modo ausente usa o padrão transparente");
    assert(resolveNetworkMode("unknown").effectiveMode === "isolated", "modo desconhecido usa o padrão transparente");
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();
