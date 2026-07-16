const path = require("path");
const { CoreProcess } = require("../extension/out/ipc/CoreProcess");
const { CoreClient } = require("../extension/out/ipc/CoreClient");

const root = path.resolve(__dirname, "..");
const corePath = path.join(root, "core", "build", "Debug", process.platform === "win32" ? "lasecsimul-core.exe" : "lasecsimul-core");
const libraryPath = path.join(root, "devices", "library.json");
const pins = [{ id: "tx", x: 0, y: 8 }, { id: "rx", x: 0, y: 24 }];

function check(condition, message) { if (!condition) throw new Error(message); }

async function main() {
  const pipeName = `lasecsimul-uart-integration-${process.pid}`;
  const processManager = new CoreProcess({ executablePath: corePath, pipeName });
  const client = new CoreClient(pipeName, { requestTimeoutMs: 10_000 });
  processManager.start();
  try {
    await client.start();
    await client.loadDeviceLibrary(libraryPath);
    const defaults = { baudrate: 115200, data_bits: 8, stop_bits: 1, parity: "none" };
    const terminal = await client.addComponent("peripherals.serialterm", defaults, pins, "Serial Terminal test");
    const plot = await client.addComponent("peripherals.lasecplot", { ...defaults, source_name: "Plot test", mode: "bidirectional", expose: true }, pins, "LasecPlot test");
    await client.connectWire(terminal.instanceId, "tx", plot.instanceId, "rx");
    await client.connectWire(plot.instanceId, "tx", terminal.instanceId, "rx");
    await client.step(10_000); // estabelece idle alto antes do primeiro start bit

    const cases = [
      { baud: 115200, bits: 8, stop: 1, parity: "none", data: Buffer.from([0x00, 0x41, 0xff, 0x0d, 0x0a, 0x80]) },
      { baud: 57600, bits: 8, stop: 1, parity: "even", data: Buffer.from("25.4,1.8\r\n") },
      { baud: 9600, bits: 8, stop: 2, parity: "odd", data: Buffer.from([0x55, 0xaa, 0x01, 0xfe]) },
      { baud: 19200, bits: 7, stop: 1, parity: "none", data: Buffer.from([0x00, 0x41, 0x7f, 0x0a]) },
    ];
    for (const item of cases) {
      for (const id of [terminal.instanceId, plot.instanceId]) {
        await client.setProperty(id, "baudrate", item.baud);
        await client.setProperty(id, "data_bits", item.bits);
        await client.setProperty(id, "stop_bits", item.stop);
        await client.setProperty(id, "parity", item.parity);
      }
      await client.writeUart(terminal.instanceId, item.data.toString("hex"));
      const frameBits = 1 + item.bits + item.stop + (item.parity === "none" ? 0 : 1);
      await client.step(Math.ceil((item.data.length * frameBits * 1e9) / item.baud) + 500_000);
      const received = (await client.drainUart(plot.instanceId)).dataHex;
      check(received === item.data.toString("hex"), `${item.baud}/${item.bits}/${item.parity}/${item.stop}: ${received}`);
    }

    for (const id of [terminal.instanceId, plot.instanceId]) {
      await client.setProperty(id, "data_bits", 8);
      await client.setProperty(id, "parity", "none");
      await client.setProperty(id, "stop_bits", 1);
    }
    await client.writeUart(plot.instanceId, "10203000ff");
    await client.step(5_000_000);
    check((await client.drainUart(terminal.instanceId)).dataHex === "10203000ff", "retorno LasecPlot -> Serial Terminal falhou");
    check(await client.getProperty(terminal.instanceId, "uart_tx_dropped") === 0, "houve overflow TX");
    check(await client.getProperty(plot.instanceId, "uart_rx_dropped") === 0, "houve overflow RX");
    console.log("UART integration: Serial Terminal <-> LasecPlot OK (binary/CSV/7-8 bits/parity/1-2 stop/bidirectional).");
    await client.stop();
  } finally {
    processManager.kill();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
