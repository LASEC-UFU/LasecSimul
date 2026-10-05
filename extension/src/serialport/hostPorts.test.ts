import { assert, createTestRunner } from "../ipc/testSupport/MockCoreServer";
import { parseSerialCommRegistry, sortPortNames } from "./hostPorts";

(async () => {
  const { test, finish } = createTestRunner("portas seriais do PC (Modem HART)");

  await test("lê COM e as pontas com0com (CNCx) do registro do Windows, em ordem natural", () => {
    const output = [
      "HKEY_LOCAL_MACHINE\\HARDWARE\\DEVICEMAP\\SERIALCOMM",
      "    \\Device\\Serial0    REG_SZ    COM1",
      "    \\Device\\com0com10    REG_SZ    COM20",
      "    \\Device\\com0com20    REG_SZ    CNCB0",
      "    \\Device\\com0com12    REG_SZ    COM22",
      "    \\Device\\com0com22    REG_SZ    CNCB2",
      "    \\Device\\com0com11    REG_SZ    COM3",
      "",
    ].join("\r\n");
    const ports = parseSerialCommRegistry(output);
    assert(JSON.stringify(ports) === JSON.stringify(["CNCB0", "CNCB2", "COM1", "COM3", "COM20", "COM22"]), ports.join(","));
  });

  await test("ordem natural e sem repetição", () => {
    assert(JSON.stringify(sortPortNames(["COM10", "COM2", "COM2"])) === JSON.stringify(["COM2", "COM10"]), "COM2 antes de COM10");
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();
