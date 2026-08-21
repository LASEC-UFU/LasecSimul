#!/usr/bin/env node
"use strict";

const fs = require("fs");
const net = require("net");
const path = require("path");
const { spawn } = require("child_process");

const repoRoot = path.resolve(__dirname, "..");
const count = Number(process.env.LASECSIMUL_SHARED_HOST_SESSIONS || 20);
const rounds = Number(process.env.LASECSIMUL_SHARED_HOST_ROUNDS || 25);
const deltaNs = Number(process.env.LASECSIMUL_SHARED_HOST_DELTA_NS || 1_000_000);
const executable = process.env.LASECSIMUL_CORE_EXECUTABLE || path.join(
  repoRoot, "core", "build", process.platform === "win32" ? "Release" : "", process.platform === "win32" ? "lasecsimul-core.exe" : "lasecsimul-core",
);

if (!Number.isInteger(count) || count < 1 || count > 100) throw new Error("session count must be 1..100");
if (!Number.isInteger(rounds) || rounds < 1) throw new Error("round count must be positive");
if (!fs.existsSync(executable)) throw new Error(`Core executable not found: ${executable}`);

function pipePath(name) {
  return process.platform === "win32" ? `\\\\.\\pipe\\${name}` : path.join(require("os").tmpdir(), `${name}.sock`);
}

function delay(ms) { return new Promise(resolve => setTimeout(resolve, ms)); }

async function connectWithRetry(name, child) {
  const deadline = Date.now() + 15_000;
  let lastError;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`Core ${name} exited with ${child.exitCode} before IPC was ready`);
    try {
      return await new Promise((resolve, reject) => {
        const socket = net.createConnection(pipePath(name));
        socket.once("connect", () => resolve(socket));
        socket.once("error", reject);
      });
    } catch (error) {
      lastError = error;
      await delay(20);
    }
  }
  throw new Error(`Timed out connecting to ${name}: ${lastError?.message || lastError}`);
}

function requestChannel(socket) {
  let nextId = 0;
  let buffered = "";
  const pending = new Map();
  socket.setEncoding("utf8");
  socket.on("data", chunk => {
    buffered += chunk;
    for (;;) {
      const newline = buffered.indexOf("\n");
      if (newline < 0) break;
      const line = buffered.slice(0, newline).trim();
      buffered = buffered.slice(newline + 1);
      if (!line) continue;
      const response = JSON.parse(line);
      const waiter = pending.get(String(response.id));
      if (!waiter) continue;
      pending.delete(String(response.id));
      if (response.ok) waiter.resolve(response.payload);
      else waiter.reject(new Error(response.error || `request ${response.id} failed`));
    }
  });
  socket.on("error", error => {
    for (const waiter of pending.values()) waiter.reject(error);
    pending.clear();
  });
  return (type, payload = {}) => new Promise((resolve, reject) => {
    const id = String(++nextId);
    pending.set(id, { resolve, reject });
    socket.write(JSON.stringify({ id, type, payload, protocolVersion: 2 }) + "\n");
  });
}

function waitForExit(child, timeoutMs = 10_000) {
  if (child.exitCode !== null) return Promise.resolve(child.exitCode);
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`Core pid=${child.pid} did not exit after shutdown`)), timeoutMs);
    child.once("exit", code => { clearTimeout(timer); resolve(code); });
  });
}

(async () => {
  const startedAt = Date.now();
  const sessions = [];
  try {
    for (let index = 0; index < count; ++index) {
      const name = `lasecsimul-shared-${process.pid}-${index}`;
      const child = spawn(executable, ["--pipe", name, "--resource-profile", "shared-host"], {
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stderr = "";
      child.stderr.on("data", chunk => { stderr += chunk.toString("utf8"); });
      sessions.push({ name, child, stderr: () => stderr });
    }

    await Promise.all(sessions.map(async session => {
      session.socket = await connectWithRetry(session.name, session.child);
      session.request = requestChannel(session.socket);
      const hello = await session.request("hello", { clientVersion: "shared-host-capacity" });
      if (hello?.protocolVersion !== 2) throw new Error(`${session.name}: protocol mismatch`);
    }));
    const readyAt = Date.now();

    for (let round = 0; round < rounds; ++round) {
      await Promise.all(sessions.map(session => session.request("step", { deltaNs })));
    }
    const expectedNs = rounds * deltaNs;
    const times = await Promise.all(sessions.map(session => session.request("getSimulationTime", {})));
    for (let index = 0; index < times.length; ++index) {
      if (times[index]?.simulatedNs !== expectedNs) {
        throw new Error(`${sessions[index].name}: expected ${expectedNs}ns, got ${times[index]?.simulatedNs}`);
      }
    }
    const metrics = await Promise.all(sessions.map(session => session.request("getPerformanceMetrics", {})));
    for (let index = 0; index < metrics.length; ++index) {
      const budget = metrics[index]?.resourceBudget;
      if (!budget || budget.maxParallelTasks > 2 || budget.maxExternalProcesses > 2 || budget.maxBuildJobs > 1) {
        throw new Error(`${sessions[index].name}: invalid SharedHost budget ${JSON.stringify(budget)}`);
      }
    }
    const workloadAt = Date.now();

    await Promise.all(sessions.map(async session => {
      try { await session.request("shutdown", {}); } catch { /* server may close immediately */ }
      session.socket.destroy();
      const code = await waitForExit(session.child);
      if (code !== 0) throw new Error(`${session.name}: exit=${code}\n${session.stderr()}`);
    }));
    const endedAt = Date.now();
    console.log(JSON.stringify({
      scenario: "shared-host-empty-core-fair-share",
      platform: `${process.platform}-${process.arch}`,
      coreExecutable: executable,
      sessions: count,
      roundsPerSession: rounds,
      deltaNsPerRound: deltaNs,
      expectedSimulationTimeNs: expectedNs,
      startupMs: readyAt - startedAt,
      concurrentWorkloadMs: workloadAt - readyAt,
      shutdownMs: endedAt - workloadAt,
      totalMs: endedAt - startedAt,
      uniquePipes: new Set(sessions.map(session => session.name)).size,
      result: "pass",
    }, null, 2));
  } finally {
    for (const session of sessions) {
      session.socket?.destroy();
      if (session.child.exitCode === null) session.child.kill();
    }
  }
})().catch(error => {
  console.error(error?.stack || error);
  process.exitCode = 1;
});
