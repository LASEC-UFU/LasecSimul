const path = require("path");
const { spawn } = require("child_process");
const readline = require("readline");
const { CoreProcess } = require("../extension/out/ipc/CoreProcess");
const { CoreClient } = require("../extension/out/ipc/CoreClient");

const root = path.resolve(__dirname, "..");
const corePath = path.join(root, "core", "build", "Debug", process.platform === "win32" ? "lasecsimul-core.exe" : "lasecsimul-core");
const libraryPath = path.join(root, "devices", "library.json");
const devicePort = process.env.LASECSIMUL_SERIAL_PORT;
const peerPort = process.env.LASECSIMUL_SERIAL_PEER;

function check(condition, message) { if (!condition) throw new Error(message); }

function startWindowsPeer(portName) {
  const source = String.raw`
$ErrorActionPreference = 'Stop'
$port = [System.IO.Ports.SerialPort]::new($env:LASECSIMUL_SERIAL_PEER, 115200, [System.IO.Ports.Parity]::None, 8, [System.IO.Ports.StopBits]::One)
$port.ReadTimeout = 50
$port.WriteTimeout = 1000
$port.Open()
[Console]::Out.WriteLine('READY')
try {
  while (($line = [Console]::In.ReadLine()) -ne $null) {
    $parts = $line.Split(' ', 2)
    if ($parts[0] -eq 'WRITE') {
      $hex = $parts[1]
      $bytes = New-Object byte[] ($hex.Length / 2)
      for ($i = 0; $i -lt $bytes.Length; $i++) { $bytes[$i] = [Convert]::ToByte($hex.Substring($i * 2, 2), 16) }
      $port.Write($bytes, 0, $bytes.Length)
      [Console]::Out.WriteLine('OK')
    } elseif ($parts[0] -eq 'READ') {
      $wanted = [int]$parts[1]
      $bytes = New-Object System.Collections.Generic.List[byte]
      $until = [DateTime]::UtcNow.AddSeconds(3)
      while ($bytes.Count -lt $wanted -and [DateTime]::UtcNow -lt $until) {
        try { $bytes.Add([byte]$port.ReadByte()) } catch [System.TimeoutException] {}
      }
      [Console]::Out.WriteLine(($bytes | ForEach-Object { $_.ToString('x2') }) -join '')
    } elseif ($parts[0] -eq 'QUIT') { break }
  }
} finally { if ($port.IsOpen) { $port.Close() }; $port.Dispose() }
`;
  const encoded = Buffer.from(source, "utf16le").toString("base64");
  const child = spawn("powershell.exe", ["-NoProfile", "-NonInteractive", "-OutputFormat", "Text", "-EncodedCommand", encoded], {
    env: { ...process.env, LASECSIMUL_SERIAL_PEER: portName }, stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
  });
  const lines = readline.createInterface({ input: child.stdout });
  const pending = [];
  let stderrText = "";
  child.stderr.on("data", (data) => { stderrText += data.toString(); });
  lines.on("line", (line) => pending.shift()?.resolve(line.trim()));
  child.on("exit", (code) => {
    const error = new Error(`processo da porta serial virtual terminou (${code}): ${stderrText.trim()}`);
    while (pending.length) pending.shift().reject(error);
  });
  const request = (command) => new Promise((resolve, reject) => {
    pending.push({ resolve, reject }); child.stdin.write(`${command}\n`);
  });
  return { child, ready: new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timeout abrindo ${portName}: ${stderrText.trim()}`)), 5000);
    pending.push({ resolve: (line) => { clearTimeout(timer); resolve(line); }, reject });
  }), request };
}

async function main() {
  if (process.platform !== "win32" || !devicePort || !peerPort) {
    throw new Error("Defina LASECSIMUL_SERIAL_PORT e LASECSIMUL_SERIAL_PEER para um par serial virtual (ex.: COM5/CNCA0).");
  }
  const peer = startWindowsPeer(peerPort);
  const processManager = new CoreProcess({ executablePath: corePath, pipeName: `lasecsimul-serial-port-${process.pid}` });
  const client = new CoreClient(`lasecsimul-serial-port-${process.pid}`, { requestTimeoutMs: 10_000 });
  processManager.start();
  try {
    check(await peer.ready === "READY", "peer serial não iniciou");
    await client.start();
    await client.loadDeviceLibrary(libraryPath);
    const pins = [{ id: "tx", x: 0, y: 8 }, { id: "rx", x: 0, y: 24 }];
    const config = { baudrate: 115200, data_bits: 8, stop_bits: 1 };
    const serialPort = await client.addComponent("peripherals.serialport", { ...config, port_name: devicePort, auto_open: false }, pins, "Serial Port test");
    const terminal = await client.addComponent("peripherals.serialterm", { ...config, parity: "none" }, pins, "Serial Terminal test");
    await client.connectWire(serialPort.instanceId, "tx", terminal.instanceId, "rx");
    await client.connectWire(terminal.instanceId, "tx", serialPort.instanceId, "rx");
    await client.step(100_000);
    await client.setProperty(serialPort.instanceId, "port_open", true);
    check(await client.getProperty(serialPort.instanceId, "port_is_open") === true,
      `porta não abriu: ${await client.getProperty(serialPort.instanceId, "port_error")}`);

    const hostToCircuit = "0041ff0d0a80";
    check(await peer.request(`WRITE ${hostToCircuit}`) === "OK", "falha escrevendo no peer");
    await new Promise((resolve) => setTimeout(resolve, 100));
    await client.step(10_000_000);
    await client.step(10_000_000);
    const hostToCircuitReceived = (await client.drainUart(terminal.instanceId)).dataHex;
    check(hostToCircuitReceived === hostToCircuit, `host → circuito divergiu: ${hostToCircuitReceived} (port_tx_bytes=${await client.getProperty(serialPort.instanceId, "port_tx_bytes")})`);

    const circuitToHost = "10203000ff";
    await client.writeUart(terminal.instanceId, circuitToHost);
    await client.step(10_000_000);
    await client.step(1_000_000);
    check(await peer.request(`READ ${circuitToHost.length / 2}`) === circuitToHost, "circuito → host divergiu");

    await client.setProperty(serialPort.instanceId, "port_open", false);
    check(await client.getProperty(serialPort.instanceId, "port_is_open") === false, "porta não fechou");

    await client.setProperty(serialPort.instanceId, "port_name", "COM_DOES_NOT_EXIST");
    await client.setProperty(serialPort.instanceId, "port_open", true);
    check(await client.getProperty(serialPort.instanceId, "port_is_open") === false, "porta inexistente foi marcada como aberta");
    check(String(await client.getProperty(serialPort.instanceId, "port_error")).length > 0, "porta inexistente não informou erro");

    await client.setProperty(serialPort.instanceId, "port_name", devicePort);
    for (const settings of [{ baudrate: 9600, data_bits: 7, stop_bits: 2 }, { baudrate: 115200, data_bits: 8, stop_bits: 1 }]) {
      for (const [name, value] of Object.entries(settings)) await client.setProperty(serialPort.instanceId, name, value);
      await client.setProperty(serialPort.instanceId, "port_open", true);
      check(await client.getProperty(serialPort.instanceId, "port_is_open") === true, `não abriu com ${JSON.stringify(settings)}`);
      await client.setProperty(serialPort.instanceId, "port_open", false);
    }

    const autoPort = await client.addComponent("peripherals.serialport", { ...config, port_name: devicePort, auto_open: true }, pins, "Serial Port auto-open test");
    await client.step(2_000_000);
    check(await client.getProperty(autoPort.instanceId, "port_is_open") === true, "Auto Open não abriu a porta ao iniciar");
    console.log(`Serial Port integration: ${peerPort} <-> ${devicePort} <-> UART simulada OK (binário bidirecional, configurações, erros e Auto Open).`);
    await client.stop();
  } finally {
    processManager.kill();
    try { peer.child.stdin.write("QUIT\n"); } catch {}
    peer.child.kill();
  }
}

main().catch((error) => { console.error(error); process.exitCode = 1; });
