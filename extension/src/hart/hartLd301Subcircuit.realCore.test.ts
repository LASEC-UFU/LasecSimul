import * as path from "path";
import { assert, createTestRunner } from "../ipc/testSupport/MockCoreServer";
import { CoreProcess } from "../ipc/CoreProcess";
import { CoreClient } from "../ipc/CoreClient";
import { resolveCoreExecutablePath } from "../core/coreExecutable";
import { decodeSegmentLcd } from "../ui/webview/segmentLcd";

/**
 * The SMAR LD301 is the subcircuit `subcircuits/hart_smar_ld301.lssubcircuit`
 * around one standard HART device. This drives a REAL Core process: load the
 * subcircuit library, place the LD301, resolve its inner HART device exactly
 * like the HART transports do (`getSubcircuitChildInstanceId`) and answer
 * frames copied from the reference capture (ld301/).
 *
 * Outside `npm test` (needs the compiled Core), like the other realCore tests:
 *   npm run compile && node out/hart/hartLd301Subcircuit.realCore.test.js
 */
const { test, finish } = createTestRunner("LD301 subcircuit on the standard HART device (Core real)");

const extensionRoot = path.resolve(__dirname, "..", "..");
const repoRoot = path.resolve(extensionRoot, "..");
const pins = ["pressure", "loop_plus", "loop_minus"].map((id, index) => ({ id, x: 0, y: index * 12 }));

function body(frameHex: string): string {
  // Strip preambles; the slave delimiter starts the frame.
  const index = frameHex.search(/(86|06)/);
  return frameHex.slice(index);
}

(async () => {
  const pipeName = `lasecsimul-ld301-realcore-${process.pid}`;
  const processManager = new CoreProcess({ executablePath: resolveCoreExecutablePath(extensionRoot), pipeName });
  const client = new CoreClient(pipeName, { requestTimeoutMs: 10_000 });
  processManager.start();
  try {
    await client.start();
    await client.loadDeviceLibrary(path.join(repoRoot, "subcircuits", "library.json"));
    const ld301 = await client.addComponent("subcircuits.hart.smar_ld301", {}, pins, "LD301 (real Core test)");
    const inner = await client.getSubcircuitChildInstanceId(ld301.instanceId, "ld301");

    await test("the inner standard HART device answers Command 0 with the captured LD301 identity (status 0x64)", async () => {
      const reply = await client.hartTransact(inner, "ffffffffff0280000082");
      assert(body(reply.frameHex) === "0680000e0064fe3e0105050572200605f04dc4", `Command 0: ${reply.frameHex}`);
    });

    await test("Command 15 and the vendor Command 140 match the capture byte for byte", async () => {
      const output = await client.hartTransact(inner, "ffffffffff82be0105f04d0f008a");
      assert(body(output.frameHex) === "86be0105f04d0f13004401000444d34000433e000000000000003e48", `Command 15: ${output.frameHex}`);
      const pid = await client.hartTransact(inner, "ffffffffff82be0105f04d8c0009");
      assert(body(pid.frameHex) === "86be0105f04d8c187044" + "39c14aaaaa394248000039bfa00000ff003900000000" + "40",
             `Command 140: ${pid.frameHex}`);
    });

    await test("the inner device publishes its local display (LCD) in the live telemetry", async () => {
      const frame = await client.getTelemetryFrame({ items: [{ key: "lcd", instanceId: inner }], probes: [] }, 0);
      const bytes = frame.componentStates["lcd"];
      assert(Boolean(bytes) && bytes!.length >= 36, `telemetria de ${bytes?.length ?? 0} bytes`);
      assert(Math.abs(bytes!.readDoubleLE(0) - 3.8) < 1e-6, `corrente de laço ${bytes!.readDoubleLE(0)} mA`);
      assert(bytes!.readUInt32LE(8) === 0x4c434431, "marcador LCD1");
      const lcd = decodeSegmentLcd(new Uint8Array(bytes!), 12);
      assert(lcd?.enabled === true && lcd.alpha === "LD301" && lcd.numeric === "  5 00", `vidro: '${lcd?.numeric}' '${lcd?.alpha}'`);
    });

    await test("Command 20 (HART 6+) is not implemented: RC 64", async () => {
      const reply = await client.hartTransact(inner, "ffffffffff82be0105f04d140091");
      assert(body(reply.frameHex) === "86be0105f04d1402404493", `Command 20: ${reply.frameHex}`);
    });

    await test("o slider alimenta a entrada PRESSAO e altera a PV medida", async () => {
      const pressure = ld301.exposedSignalPins?.pressure;
      assert(Boolean(pressure), "a interface do LD301 deve expor PRESSAO como sinal");
      if (!pressure) return;
      const slider = await client.addComponent("graphics.slider", { value: 190 }, [{ id: "out", x: 0, y: 0 }], "Pressao manual");
      await client.connectWire(slider.instanceId, "out", pressure.instanceId, pressure.pinId);
      await client.step(1_000);
      const readPressure = async (): Promise<number> => {
        const reply = await client.hartTransact(inner, "ffffffffff82be0105f04d010084");
        const frame = Buffer.from(reply.frameHex, "hex");
        assert(frame[11] === 1 && frame[13] === 0, `Command 1 inesperado: ${reply.frameHex}`);
        return frame.readFloatBE(16);
      };
      const low = await readPressure();
      assert(Math.abs(low - 190) < 0.01, `PRESSAO 190 deveria chegar a PV: ${low}`);
      await client.setProperty(slider.instanceId, "value", 1690);
      await client.step(1_000);
      const high = await readPressure();
      assert(Math.abs(high - 1690) < 0.01, `PRESSAO 1690 deveria chegar a PV: ${high}`);
    });
  } finally {
    await client.stop().catch(() => undefined);
    processManager.kill();
  }
  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();
