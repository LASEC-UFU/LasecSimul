#!/usr/bin/env node
"use strict";

/**
 * Canonical ROADMAP-001/F1 baseline runner.
 *
 * The default path is intentionally strict: remove the Core build directory, configure and build
 * every target, discover tests from CTest labels, run available external suites, then collect two
 * warm-ups and ten measured samples from every benchmark executable.
 */

const { spawnSync } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const repoRoot = path.resolve(__dirname, "..");
const buildDir = path.join(repoRoot, "core", "build");
const defaultWarmupCount = 2;
const defaultSampleCount = 10;

function argumentValue(name) {
  const inline = process.argv.find((argument) => argument.startsWith(`${name}=`));
  if (inline) return inline.slice(name.length + 1);
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function positiveInteger(name, fallback) {
  const raw = argumentValue(name);
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) throw new Error(`${name} must be a positive integer`);
  return value;
}

if (process.argv.includes("--help")) {
  console.log(
    "Usage: node scripts/baseline-core.js [--config Release] [--output FILE] " +
      "[--warmups 2] [--samples 10]"
  );
  process.exit(0);
}

const configuration = argumentValue("--config") ?? "Release";
const warmupCount = positiveInteger("--warmups", defaultWarmupCount);
const sampleCount = positiveInteger("--samples", defaultSampleCount);
if (warmupCount < 2) throw new Error("--warmups must be at least 2 for an official baseline");
if (sampleCount < 10) throw new Error("--samples must be at least 10 for an official baseline");

function printableCommand(command, args) {
  return [command, ...args]
    .map((part) => (/\s/.test(part) ? JSON.stringify(part) : part))
    .join(" ");
}

function execute(command, args, options = {}) {
  const display = printableCommand(command, args);
  console.log(`[baseline-core] ${display}`);
  const result = spawnSync(command, args, {
    cwd: options.cwd ?? repoRoot,
    encoding: "utf8",
    env: process.env,
    maxBuffer: 64 * 1024 * 1024,
    shell: false,
    stdio: options.capture ? "pipe" : "inherit",
  });
  if (result.error) {
    if (options.allowFailure) return { ...result, status: result.status ?? 1, display };
    throw new Error(`failed to execute ${display}: ${result.error.message}`);
  }
  if (!options.capture && result.status !== 0 && !options.allowFailure) {
    throw new Error(`${display} exited with status ${result.status}`);
  }
  if (options.capture && options.echo) {
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
  }
  if (result.status !== 0 && !options.allowFailure) {
    throw new Error(
      `${display} exited with status ${result.status}\n${result.stdout ?? ""}${result.stderr ?? ""}`
    );
  }
  return { ...result, display };
}

function captured(command, args, options = {}) {
  return execute(command, args, { ...options, capture: true }).stdout.trim();
}

function git(args) {
  return captured("git", args);
}

const source = {
  commit: git(["rev-parse", "HEAD"]),
  dirty: git(["status", "--porcelain", "--untracked-files=normal"]).length > 0,
};

const supportBuilds = [
  [path.join("scripts", "build-devices.js"), "--clean", "--config", configuration],
  [path.join("scripts", "build-mcu-adapters.js"), "--clean", "--config", configuration],
];
for (const args of supportBuilds) execute(process.execPath, args);

// O modulo VPI usa o toolchain do proprio GHDL e nao possui --clean. Remover somente seu output
// reproduzivel evita que uma execucao local reutilize um binario de outra versao/toolchain.
fs.rmSync(path.join(repoRoot, "fpga", "ghdl-vpi", "build"), { recursive: true, force: true });
const vpiBuildArgs = [path.join("scripts", "build-fpga-vpi.js")];
execute(process.execPath, vpiBuildArgs);

const buildArgs = [
  path.join("scripts", "build-core.js"),
  "--clean",
  "--config",
  configuration,
];
const buildCommands = [
  ...supportBuilds.map((args) => printableCommand(process.execPath, args)),
  printableCommand(process.execPath, vpiBuildArgs),
  printableCommand(process.execPath, buildArgs),
];
execute(process.execPath, buildArgs);

const cachePath = path.join(buildDir, "CMakeCache.txt");
const cache = fs.readFileSync(cachePath, "utf8");
function cacheValue(key) {
  const match = cache.match(new RegExp(`^${key}(?::[^=]+)?=(.*)$`, "m"));
  return match?.[1]?.trim() || null;
}

function compilerMetadataValue(key) {
  const cmakeFiles = path.join(buildDir, "CMakeFiles");
  if (!fs.existsSync(cmakeFiles)) return null;
  for (const entry of fs.readdirSync(cmakeFiles, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const metadataPath = path.join(cmakeFiles, entry.name, "CMakeCXXCompiler.cmake");
    if (!fs.existsSync(metadataPath)) continue;
    const metadata = fs.readFileSync(metadataPath, "utf8");
    const match = metadata.match(new RegExp(`set\\(${key}\\s+"([^"]*)"\\)`));
    if (match) return match[1];
  }
  return null;
}

const multiConfig = cache.includes("CMAKE_CONFIGURATION_TYPES:STRING=");
const ctestCommand = cacheValue("CMAKE_CTEST_COMMAND") ?? "ctest";
const ctestBaseArgs = ["--test-dir", buildDir];
if (multiConfig) ctestBaseArgs.push("-C", configuration);

const discoveryText = captured(ctestCommand, [...ctestBaseArgs, "--show-only=json-v1"]);
const discovery = JSON.parse(discoveryText);
const discoveredTests = discovery.tests ?? [];

function testLabels(test) {
  const property = (test.properties ?? []).find((entry) => entry.name === "LABELS");
  if (!property) return [];
  return Array.isArray(property.value) ? property.value : [property.value];
}

const expectedLabels = new Set(["hermetic", "external-ghdl", "external-qemu"]);
const classificationErrors = [];
const testsByLabel = Object.fromEntries([...expectedLabels].map((label) => [label, []]));
for (const test of discoveredTests) {
  const labels = testLabels(test).filter((label) => expectedLabels.has(label));
  if (labels.length !== 1) {
    classificationErrors.push(`${test.name}: expected exactly one baseline label, found ${labels.join(", ") || "none"}`);
  } else {
    testsByLabel[labels[0]].push(test.name);
  }
}
if (classificationErrors.length > 0) {
  throw new Error(`invalid CTest baseline classification:\n${classificationErrors.join("\n")}`);
}

function firstRunnable(candidates, versionArgs) {
  for (const candidate of [...new Set(candidates.filter(Boolean))]) {
    const result = execute(candidate, versionArgs, { capture: true, allowFailure: true });
    if (result.status === 0) {
      const version = `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().split(/\r?\n/)[0];
      return { available: true, command: candidate, version };
    }
  }
  return { available: false, command: null, version: null };
}

const ghdlRuntime = firstRunnable(
  [process.env.LASECSIMUL_GHDL_PATH, process.env.LASECSIMUL_GHDL_BINARY, "ghdl"],
  ["--version"]
);
const qemuRuntime = firstRunnable(
  [
    process.env.LASECSIMUL_QEMU_PATH,
    process.env.LASECSIMUL_QEMU_BINARY,
    path.join(repoRoot, "devices", "qemu-esp32", "bin", "qemu-system-xtensa.exe"),
    "qemu-system-xtensa",
  ],
  ["--version"]
);

function parseJunit(file, discovered, status) {
  if (!fs.existsSync(file)) {
    return {
      discovered,
      passed: status === 0 ? discovered : null,
      failed: status === 0 ? 0 : null,
      skipped: 0,
    };
  }
  const xml = fs.readFileSync(file, "utf8");
  const testcaseCount = (xml.match(/<testcase\b/g) ?? []).length;
  const failed = (xml.match(/<failure\b/g) ?? []).length;
  const skipped = (xml.match(/<skipped\b/g) ?? []).length;
  return { discovered, passed: testcaseCount - failed - skipped, failed, skipped };
}

function runTestLabel(label) {
  const junit = path.join(buildDir, `baseline-${label}.xml`);
  fs.rmSync(junit, { force: true });
  const args = [
    ...ctestBaseArgs,
    "-L",
    `^${label}$`,
    "--output-on-failure",
    "--output-junit",
    junit,
  ];
  // A suite hermetica nao compartilha processos externos nem firmware. Executa-la em paralelo
  // reduz o tempo de CI sem alterar a cobertura; GHDL e QEMU permanecem seriais por seguranca.
  if (label === "hermetic") args.push("--parallel", process.env.CI ? "4" : "2");
  // Runners compartilhados podem pausar o processo QEMU por tempo suficiente para disparar um
  // watchdog. Repete somente o teste que falhou, uma unica vez; falhas reais continuam fatais.
  if (label === "external-qemu" && process.env.CI) args.push("--repeat", "until-pass:2");
  const result = execute(ctestCommand, args, { capture: true, echo: true, allowFailure: true });
  return {
    ...parseJunit(junit, testsByLabel[label].length, result.status),
    command: result.display,
    exitCode: result.status,
  };
}

function skippedTestLabel(label, reason) {
  return {
    discovered: testsByLabel[label].length,
    passed: 0,
    failed: 0,
    skipped: testsByLabel[label].length,
    command: null,
    exitCode: null,
    skippedReason: reason,
  };
}

const hermetic = runTestLabel("hermetic");
const externalGhdl = ghdlRuntime.available
  ? runTestLabel("external-ghdl")
  : skippedTestLabel("external-ghdl", "GHDL is not executable in this environment");
const externalQemu = qemuRuntime.available
  ? runTestLabel("external-qemu")
  : skippedTestLabel("external-qemu", "QEMU Xtensa is not executable in this environment");

const externalSuites = [externalGhdl, externalQemu];
const externalSkippedReasons = externalSuites
  .map((suite) => suite.skippedReason)
  .filter(Boolean);
const external = {
  discovered: externalSuites.reduce((sum, suite) => sum + suite.discovered, 0),
  passed: externalSuites.reduce((sum, suite) => sum + suite.passed, 0),
  failed: externalSuites.reduce((sum, suite) => sum + suite.failed, 0),
  skipped: externalSuites.reduce((sum, suite) => sum + suite.skipped, 0),
  skippedReason: externalSkippedReasons.length > 0 ? externalSkippedReasons.join("; ") : null,
  runtimes: { ghdl: externalGhdl, qemu: externalQemu },
};

function executablePath(name) {
  const suffix = process.platform === "win32" ? ".exe" : "";
  const candidates = multiConfig
    ? [path.join(buildDir, configuration, `${name}${suffix}`), path.join(buildDir, `${name}${suffix}`)]
    : [path.join(buildDir, `${name}${suffix}`), path.join(buildDir, configuration, `${name}${suffix}`)];
  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) throw new Error(`benchmark executable not found: ${name}`);
  return found;
}

const benchmarkPrograms = [
  { name: "solver", executable: "solver_benchmark", args: [] },
  { name: "transient", executable: "transient_benchmark", args: [] },
  {
    name: "simulation",
    executable: "simulation_performance_benchmark",
    args: ["--sim-ns", "10000000", "--scale", "100", "--digital-hz", "10000"],
  },
];

function tokensOf(line) {
  const values = {};
  const pattern = /([A-Za-z_][A-Za-z0-9_]*)=(-?\d+(?:\.\d+)?(?:e[+-]?\d+)?)(x)?/gi;
  for (const match of line.matchAll(pattern)) values[match[1]] = Number(match[2]);
  return values;
}

function benchmarkMetrics(program, stdout) {
  const metrics = [];
  for (const rawLine of stdout.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line) continue;
    const [kind] = line.split(/\s+/, 1);
    const values = tokensOf(line);
    if (program === "solver") {
      const prefix = {
        STAMP: "solver.stamp",
        SOLVER: "solver.solve",
        REFACTOR: "solver.refactor",
        LARGE_FACTOR: "solver.large_factor",
      }[kind];
      if (!prefix) continue;
      for (const metric of ["dense_ms", "sparse_ms", "serial_ms", "pool_ms"]) {
        if (Number.isFinite(values[metric])) metrics.push([`${prefix}.${metric}`, values[metric], "ms"]);
      }
    } else if (program === "transient" && kind === "TRANSIENT" && Number.isFinite(values.time_ms)) {
      const method = line.match(/\bmethod=([^\s]+)/)?.[1]?.toLowerCase();
      if (method) metrics.push([`transient.${method}.time_ms`, values.time_ms, "ms"]);
    } else if (program === "simulation" && kind === "SCENARIO") {
      const scenario = line.match(/\bname=([^\s]+)/)?.[1]?.toLowerCase();
      if (!scenario) continue;
      for (const [metric, unit] of [["init_ms", "ms"], ["wall_ms", "ms"], ["rate", "x-realtime"]]) {
        if (Number.isFinite(values[metric])) metrics.push([`simulation.${scenario}.${metric}`, values[metric], unit]);
      }
    }
  }
  return metrics;
}

function statistics(samples) {
  const sorted = [...samples].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  const median = sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
  return {
    median,
    mean: samples.reduce((sum, value) => sum + value, 0) / samples.length,
    min: sorted[0],
    max: sorted.at(-1),
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
  };
}

const benchmarkSamples = new Map();
const benchmarkCommands = new Map();
const benchmarkErrors = [];
for (const program of benchmarkPrograms) {
  const executable = executablePath(program.executable);
  const command = printableCommand(executable, program.args);
  for (let run = 0; run < warmupCount + sampleCount; run += 1) {
    const measured = run >= warmupCount;
    console.log(
      `[baseline-core] ${program.name} ${measured ? `sample ${run - warmupCount + 1}/${sampleCount}` : `warm-up ${run + 1}/${warmupCount}`}`
    );
    const result = execute(executable, program.args, { capture: true, echo: true, allowFailure: true });
    if (result.status !== 0) {
      benchmarkErrors.push(`${program.name} run ${run + 1} exited with status ${result.status}`);
      continue;
    }
    const metrics = benchmarkMetrics(program.name, result.stdout);
    if (metrics.length === 0) benchmarkErrors.push(`${program.name} run ${run + 1} emitted no recognized metrics`);
    if (!measured) continue;
    for (const [scenario, value, unit] of metrics) {
      const entry = benchmarkSamples.get(scenario) ?? { unit, samples: [] };
      entry.samples.push(value);
      benchmarkSamples.set(scenario, entry);
      benchmarkCommands.set(scenario, command);
    }
  }
}

const benchmarks = {};
for (const [scenario, entry] of [...benchmarkSamples.entries()].sort(([left], [right]) => left.localeCompare(right))) {
  if (entry.samples.length !== sampleCount) {
    benchmarkErrors.push(`${scenario} has ${entry.samples.length} samples; expected ${sampleCount}`);
  }
  benchmarks[scenario] = {
    unit: entry.unit,
    sampleCount: entry.samples.length,
    warmupCount,
    command: benchmarkCommands.get(scenario),
    samples: entry.samples,
    ...statistics(entry.samples),
  };
}

function commandVersion(command, args) {
  if (!command) return null;
  const result = execute(command, args, { capture: true, allowFailure: true });
  if (result.status !== 0) return null;
  return `${result.stdout ?? ""}\n${result.stderr ?? ""}`.trim().split(/\r?\n/)[0];
}

const compiler = cacheValue("CMAKE_CXX_COMPILER") ?? compilerMetadataValue("CMAKE_CXX_COMPILER");
const cmakeCommand = cacheValue("CMAKE_COMMAND") ?? "cmake";
const failures = [
  ...(hermetic.exitCode === 0 ? [] : ["hermetic CTest suite failed"]),
  ...(externalGhdl.exitCode === null || externalGhdl.exitCode === 0 ? [] : ["external GHDL CTest suite failed"]),
  ...(externalQemu.exitCode === null || externalQemu.exitCode === 0 ? [] : ["external QEMU CTest suite failed"]),
  ...benchmarkErrors,
];

const platformName = { win32: "windows", linux: "linux", darwin: "macos" }[process.platform] ?? process.platform;
const generatedDate = new Date().toISOString().slice(0, 10);
const outputPath = path.resolve(
  repoRoot,
  argumentValue("--output") ?? path.join(".spec", "benchmarks", `baseline-${generatedDate}-${platformName}.json`)
);
const baseline = {
  formatVersion: 1,
  scenarioVersion: 1,
  status: !source.dirty && failures.length === 0 ? "official" : "candidate",
  generatedAt: new Date().toISOString(),
  rebuiltFromClean: true,
  source,
  environment: {
    os: `${os.type()} ${os.release()} (${os.arch()})`,
    runnerImage: process.env.ImageOS
      ? `${process.env.ImageOS}${process.env.ImageVersion ? ` ${process.env.ImageVersion}` : ""}`
      : null,
    cpu: os.cpus()[0]?.model ?? "unknown",
    logicalProcessors: os.cpus().length,
    ramBytes: os.totalmem(),
    toolchain: {
      compiler: compilerMetadataValue("CMAKE_CXX_COMPILER_ID") ?? compiler,
      compilerVersion:
        compilerMetadataValue("CMAKE_CXX_COMPILER_VERSION") ?? commandVersion(compiler, ["--version"]),
      cmake: commandVersion(cmakeCommand, ["--version"]),
      generator: cacheValue("CMAKE_GENERATOR"),
      ghdl: ghdlRuntime.version,
      qemu: qemuRuntime.version,
      node: process.version,
    },
    externalRuntimesAvailable: { ghdl: ghdlRuntime.available, qemu: qemuRuntime.available },
  },
  build: {
    configuration,
    clean: true,
    command: buildCommands.join(" && "),
    commands: buildCommands,
  },
  tests: {
    discovered: discoveredTests.length,
    passed: hermetic.passed + external.passed,
    failed: hermetic.failed + external.failed,
    skipped: hermetic.skipped + external.skipped,
    hermetic,
    external,
  },
  benchmarks,
  failures,
};

fs.mkdirSync(path.dirname(outputPath), { recursive: true });
fs.writeFileSync(outputPath, `${JSON.stringify(baseline, null, 2)}\n`, { encoding: "utf8", flag: "wx" });
console.log(`[baseline-core] baseline written to ${outputPath}`);
if (failures.length > 0) {
  console.error(`[baseline-core] baseline completed with ${failures.length} failure(s):`);
  for (const failure of failures) console.error(`- ${failure}`);
  process.exit(1);
}
