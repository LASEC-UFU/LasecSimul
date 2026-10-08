import * as path from "path";
import { assert, createTestRunner } from "../ipc/testSupport/MockCoreServer";
import { CoreProcess } from "../ipc/CoreProcess";
import { CoreClient } from "../ipc/CoreClient";
import { resolveCoreExecutablePath } from "../core/coreExecutable";
import { decodeSegmentLcd } from "../ui/webview/segmentLcd";

/**
 * The SMAR TT301 is the subcircuit `subcircuits/hart_smar_tt301.lssubcircuit`
 * around one standard HART device (HART 7). This drives a REAL Core process:
 * load the subcircuit library, place the TT301, resolve its inner HART device
 * like the HART transports do and answer frames from the reference capture
 * (trm/tt301), then feed the TEMP signal input from a slider.
 *
 * Outside `npm test` (needs the compiled Core), like the other realCore tests:
 *   npm run compile && node out/hart/hartTt301Subcircuit.realCore.test.js
 */
const { test, finish } = createTestRunner("TT301 subcircuit on the standard HART device (Core real)");

const extensionRoot = path.resolve(__dirname, "..", "..");
const repoRoot = path.resolve(extensionRoot, "..");
const pins = ["temperature", "loop_plus", "loop_minus"].map((id, index) => ({ id, x: 0, y: index * 12 }));
// Long address of the captured specimen: Smar TT301, device ID 01 0C 3A.
const longAddress = "be02010c3a";

/** Master request with 5 preambles and the XOR checksum. */
function request(delimiterAndAddress: string, command: number, data: number[] = []): string {
  const frame = Buffer.concat([Buffer.from(delimiterAndAddress, "hex"), Buffer.from([command, data.length, ...data])]);
  const checksum = frame.reduce((xor, octet) => xor ^ octet, 0);
  return Buffer.concat([Buffer.alloc(5, 0xff), frame, Buffer.from([checksum])]).toString("hex");
}

/** Slave reply without preambles: delimiter .. checksum. */
function body(frameHex: string): string {
  return frameHex.slice(frameHex.search(/(86|06)/));
}

/** Response data bytes of a long-frame slave reply (after RC and status). */
function data(frameHex: string): Buffer {
  // delimiter, 5 address bytes, command, byte count, RC, status, data, checksum
  const frame = Buffer.from(body(frameHex), "hex");
  return frame.subarray(10, 8 + frame[7]!);
}

(async () => {
  const pipeName = `lasecsimul-tt301-realcore-${process.pid}`;
  const processManager = new CoreProcess({ executablePath: resolveCoreExecutablePath(extensionRoot), pipeName });
  const client = new CoreClient(pipeName, { requestTimeoutMs: 10_000 });
  processManager.start();
  try {
    await client.start();
    await client.loadDeviceLibrary(path.join(repoRoot, "subcircuits", "library.json"));
    const tt301 = await client.addComponent("subcircuits.hart.smar_tt301", {}, pins, "TT301 (real Core test)");
    const inner = await client.getSubcircuitChildInstanceId(tt301.instanceId, "tt301");

    await test("the inner standard HART device answers the HART 7 Command 0 identity of the captured TT301", async () => {
      const reply = await client.hartTransact(inner, request("0280", 0));
      assert(body(reply.frameHex).startsWith("068000180060fe3e020507086010000" + "10c3a0509002800003e003e01"),
        `Command 0: ${reply.frameHex}`);
    });

    await test("Command 15 (17 bytes) and the vendor Commands 130 / 223 match the capture byte for byte", async () => {
      const output = await client.hartTransact(inner, request("82" + longAddress, 15));
      const expected15 = ["010020", "44480000", "00000000", "00000000", "fffa"].join("");
      assert(data(output.frameHex).toString("hex") === expected15, `Command 15: ${output.frameHex}`);
      const sensor = await client.hartTransact(inner, request("82" + longAddress, 130, [2]));
      assert(data(sensor.frameHex).toString("hex") === "0201020101", `Command 130: ${sensor.frameHex}`);
      const cvd = await client.hartTransact(inner, request("82" + longAddress, 223, [2]));
      assert(data(cvd.frameHex).toString("hex") === "0242c800003b801132b51b057fac932d1d", `Command 223: ${cvd.frameHex}`);
    });

    await test("the inner device publishes its local display (LCD): power-up page TT301, HART 7", async () => {
      const frame = await client.getTelemetryFrame({ items: [{ key: "lcd", instanceId: inner }], probes: [] }, 0);
      const bytes = frame.componentStates["lcd"];
      assert(Boolean(bytes) && bytes!.length >= 36, `telemetria de ${bytes?.length ?? 0} bytes`);
      assert(bytes!.readUInt32LE(8) === 0x4c434431, "marcador LCD1");
      const lcd = decodeSegmentLcd(new Uint8Array(bytes!), 12);
      assert(lcd?.enabled === true && lcd.alpha === "TT301" && lcd.numeric === "  7 00", `vidro: '${lcd?.numeric}' '${lcd?.alpha}'`);
    });

    await test("a slider on TEMP drives the PV and the 4-20 mA output live (0..800 degC)", async () => {
      const input = tt301.exposedSignalPins?.temperature;
      assert(Boolean(input), "TT301 deve expor TEMP como sinal");
      if (!input) return;
      const slider = await client.addComponent("graphics.slider", { value: 400, actionMin: -200, actionMax: 850 }, [{ id: "out", x: 0, y: 0 }], "TEMP");
      await client.applyWireTopologyTransaction([
        { kind: "connect", from: { componentId: slider.instanceId, pinId: "out" }, to: { componentId: input.instanceId, pinId: input.pinId } },
      ]);
      await client.step(1_000_000);
      const liveCurrent = async (): Promise<number> => {
        const frame = await client.getTelemetryFrame({ items: [{ key: "live", instanceId: inner }], probes: [] }, 0);
        return frame.componentStates["live"]!.readDoubleLE(0);
      };
      const readTemperature = async (): Promise<number> => {
        const reply = await client.hartTransact(inner, request("82" + longAddress, 1));
        const values = data(reply.frameHex);
        assert(values[0] === 0x20, `Command 1 em graus Celsius: ${reply.frameHex}`);
        return values.readFloatBE(1);
      };
      assert(Math.abs((await readTemperature()) - 400) < 0.01, "400 degC no PV");
      assert(Math.abs((await liveCurrent()) - 12) < 0.05, "400 degC em 0..800 = 12 mA sem transação HART");
      await client.setProperty(slider.instanceId, "value", 200);
      await client.step(1_000_000);
      assert(Math.abs((await readTemperature()) - 200) < 0.01, "200 degC no PV");
      assert(Math.abs((await liveCurrent()) - 8) < 0.05, "200 degC = 8 mA");
    });
  } finally {
    await client.stop().catch(() => undefined);
    processManager.kill();
  }
  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();
