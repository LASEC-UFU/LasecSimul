import * as fs from "fs";
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
 * (trm/tt301), then measure a Pt100 on the sensor terminals 1-4 (2, 3 and 4 wires).
 *
 * Outside `npm test` (needs the compiled Core), like the other realCore tests:
 *   npm run compile && node out/hart/hartTt301Subcircuit.realCore.test.js
 */
const { test, finish } = createTestRunner("TT301 subcircuit on the standard HART device (Core real)");

const extensionRoot = path.resolve(__dirname, "..", "..");
const repoRoot = path.resolve(extensionRoot, "..");
const pins = ["s1", "s2", "s3", "s4", "loop_plus", "loop_minus"].map((id, index) => ({ id, x: 0, y: index * 12 }));
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

    // Pt100 IEC 60751 (Callendar-Van Dusen, T >= 0) and its inverse, written independently of the
    // subcircuit's calc blocks.
    const pt100 = (t: number) => 100 * (1 + 3.9083e-3 * t - 5.775e-7 * t * t);
    const pt100Inverse = (r: number) => (-3.9083e-3 + Math.sqrt(3.9083e-3 ** 2 - 4 * -5.775e-7 * (1 - r / 100))) / (2 * -5.775e-7);
    const twoPins = [{ id: "pin-1", x: 0, y: 0 }, { id: "pin-2", x: 0, y: 0 }];
    type Placed = Awaited<ReturnType<typeof client.addComponent>>;
    const terminal = (device: Placed, id: string) => {
      const exposed = device.exposedPins?.[id];
      assert(Boolean(exposed), `borne ${id} exposto`);
      return { componentId: exposed!.instanceId, pinId: exposed!.pinId };
    };
    const at = (componentId: string, pinId: string) => ({ componentId, pinId });
    const edge = (from: { componentId: string; pinId: string }, to: { componentId: string; pinId: string }) => ({ kind: "connect" as const, from, to });
    const readings = (device: string) => ({
      temperature: async (): Promise<number> => {
        const reply = await client.hartTransact(device, request("82" + longAddress, 1));
        const values = data(reply.frameHex);
        assert(values[0] === 0x20, `Command 1 em graus Celsius: ${reply.frameHex}`);
        return values.readFloatBE(1);
      },
      current: async (): Promise<number> => {
        const frame = await client.getTelemetryFrame({ items: [{ key: "live", instanceId: device }], probes: [] }, 0);
        return frame.componentStates["live"]!.readDoubleLE(0);
      },
    });
    /** A Pt100 at `celsius` whose two ends (A, B) reach the terminals through `leads` (1 ohm each). */
    const placeSensor = async (label: string, celsius: number, leads: Array<"A1" | "A2" | "B3" | "B4">) => {
      const element = await client.addComponent("passive.resistor", { resistance: pt100(celsius) }, twoPins, `Pt100 ${label}`);
      const wires: Record<string, { componentId: string; pinId: string }> = {};
      const edges = [];
      for (const lead of leads) {
        const wire = await client.addComponent("passive.resistor", { resistance: 1 }, twoPins, `fio ${lead} ${label}`);
        edges.push(edge(at(element.instanceId, lead.startsWith("A") ? "pin-1" : "pin-2"), at(wire.instanceId, "pin-1")));
        wires[lead] = at(wire.instanceId, "pin-2");
      }
      return { element, wires, edges };
    };

    await test("Pt100 a 4 fios nos bornes 1-4: 138,51 ohm = 100 degC no PV e 6 mA (0..800); o cabo de 1 ohm por fio não influi", async () => {
      const device = await client.addComponent("subcircuits.hart.smar_tt301", {}, pins, "TT301 4 fios");
      const deviceInner = await client.getSubcircuitChildInstanceId(device.instanceId, "tt301");
      const sensor = await placeSensor("4 fios", 100, ["A1", "A2", "B3", "B4"]);
      await client.applyWireTopologyTransaction([...sensor.edges,
        edge(sensor.wires.A1!, terminal(device, "s1")), edge(sensor.wires.A2!, terminal(device, "s2")),
        edge(sensor.wires.B3!, terminal(device, "s3")), edge(sensor.wires.B4!, terminal(device, "s4"))]);
      await client.step(20_000_000);
      const read = readings(deviceInner);
      assert(Math.abs((await read.temperature()) - 100) < 0.01, `PV ${await read.temperature()} degC`);
      assert(Math.abs((await read.current()) - 6) < 0.01, `corrente ${await read.current()} mA`);
      await client.setProperty(sensor.element.instanceId, "resistance", pt100(400));
      await client.step(20_000_000);
      assert(Math.abs((await read.temperature()) - 400) < 0.01, `PV ${await read.temperature()} degC a 400 degC`);
      assert(Math.abs((await read.current()) - 12) < 0.01, `400 degC = 12 mA: ${await read.current()}`);

      // Sensor aberto: o estágio de entrada vê resistência fora da faixa e o TT301 vai ao burnout alto (21 mA).
      await client.setProperty(sensor.element.instanceId, "resistance", 1e9);
      await client.step(20_000_000);
      assert(Math.abs((await read.current()) - 21) < 0.01, `burnout: ${await read.current()} mA`);
      await client.setProperty(sensor.element.instanceId, "resistance", pt100(100));
      await client.step(20_000_000);
      assert(Math.abs((await read.current()) - 6) < 0.01, `sensor religado: ${await read.current()} mA`);
    });

    await test("2 fios (1-2 e 3-4 em ponte): os dois fios de 1 ohm entram na medida (+5,2 degC a 100 degC)", async () => {
      const device = await client.addComponent("subcircuits.hart.smar_tt301", {}, pins, "TT301 2 fios");
      const deviceInner = await client.getSubcircuitChildInstanceId(device.instanceId, "tt301");
      const sensor = await placeSensor("2 fios", 100, ["A1", "B4"]);
      await client.applyWireTopologyTransaction([...sensor.edges,
        edge(sensor.wires.A1!, terminal(device, "s1")), edge(terminal(device, "s1"), terminal(device, "s2")),
        edge(sensor.wires.B4!, terminal(device, "s4")), edge(terminal(device, "s3"), terminal(device, "s4"))]);
      await client.step(20_000_000);
      const expected = pt100Inverse(pt100(100) + 2);
      const measured = await readings(deviceInner).temperature();
      assert(Math.abs(measured - expected) < 0.01 && measured - 100 > 5, `PV ${measured}, esperado ${expected}`);
    });

    await test("3 fios (1-2 em ponte) com a conexão 3 fios configurada: a queda no fio de retorno é compensada", async () => {
      const device = await client.addComponent("subcircuits.hart.smar_tt301", {}, pins, "TT301 3 fios");
      const deviceInner = await client.getSubcircuitChildInstanceId(device.instanceId, "tt301");
      const sensor = await placeSensor("3 fios", 100, ["A1", "B3", "B4"]);
      await client.applyWireTopologyTransaction([...sensor.edges,
        edge(sensor.wires.A1!, terminal(device, "s1")), edge(terminal(device, "s1"), terminal(device, "s2")),
        edge(sensor.wires.B3!, terminal(device, "s3")), edge(sensor.wires.B4!, terminal(device, "s4"))]);
      await client.step(20_000_000);
      const read = readings(deviceInner);
      const asTwoWire = await read.temperature();
      assert(Math.abs(asTwoWire - pt100Inverse(pt100(100) + 1)) < 0.01, `configurado como 2 fios, só um fio entra: ${asTwoWire}`);
      const manifest = JSON.parse(fs.readFileSync(path.join(repoRoot, "subcircuits", "hart_smar_tt301.lssubcircuit"), "utf8"));
      const variables = JSON.parse(manifest.components.find((c: { id: string }) => c.id === "tt301").properties.hartVariablesJson);
      variables.find((v: { id: string }) => v.id === "sensor.connection").value = 2;
      await client.setSubcircuitChildProperty(device.instanceId, "tt301", "hartVariablesJson", JSON.stringify(variables));
      await client.step(20_000_000);
      assert(Math.abs((await read.temperature()) - 100) < 0.01, `3 fios compensado: ${await read.temperature()}`);
    });
  } finally {
    await client.stop().catch(() => undefined);
    processManager.kill();
  }
  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();
