import { strict as assert } from "assert";
import * as path from "path";
import { CanonicalStOrigin, mapCompilerOutput, parsePlcVariableReply, resolvePlcToolchain } from "./plcBuild";

function main(): void {
  // Mapa de linhas: erro do STruCpp/g++ na linha do ST gerado -> POU e linha do editor.
  const origins: CanonicalStOrigin[] = [
    { pouId: "FB1", pouName: "FB1", section: "header" },
    { pouId: "FB1", pouName: "FB1", section: "declaration", variableName: "X" },
    { pouId: "FB1", pouName: "FB1", section: "body", bodyLine: 3 },
    { pouId: "MAIN", pouName: "MAIN", section: "header" },
    { pouId: "MAIN", pouName: "MAIN", section: "declaration", variableName: "DI0" },
    { pouId: "MAIN", pouName: "MAIN", section: "body", bodyLine: 1 },
    { pouId: "MAIN", pouName: "MAIN", section: "body", bodyLine: 2, element: { id: "t1", label: "transição S1 -> S2" } },
  ];
  const diagnostics = mapCompilerOutput([
    "main.st:6:16: error: Unexpected `;` after `AND` while parsing an expression.",
    "C:/tmp/build/main.st:3:1: error: something",
    "main.st:6:16: error: Unexpected `;` after `AND` while parsing an expression.",
    "   6 | DO0 := DI0 AND ;",
    "main.st:7:2: warning: unused",
  ].join("\n"), origins, "strucpp");
  assert.equal(diagnostics.length, 3, "a mesma mensagem na mesma linha aparece uma vez");
  assert.deepEqual([diagnostics[0]!.pouName, diagnostics[0]!.line, diagnostics[0]!.column, diagnostics[0]!.severity], ["MAIN", 1, 16, "error"]);
  assert.deepEqual([diagnostics[1]!.pouName, diagnostics[1]!.line], ["FB1", 3]);
  assert.deepEqual([diagnostics[2]!.severity, diagnostics[2]!.elementLabel], ["warning", "transição S1 -> S2"]);
  const declaration = mapCompilerOutput("main.st:5:3: error: bad type", origins, "strucpp")[0]!;
  assert.equal(declaration.variableName, "DI0", "erro numa declaração aponta a variável");
  assert.equal(declaration.line, undefined);

  // Resposta do monitor.
  assert.deepEqual(parsePlcVariableReply("MAIN.DI0 : BOOL = TRUE [FORCED]"), { value: "TRUE", forced: true });
  assert.deepEqual(parsePlcVariableReply("MAIN.COUNT : INT = 12"), { value: "12", forced: false });

  // Ferramentas: instalação usa bundled/plc; checkout usa plc/strucpp/build e core/src/plc.
  const extensionPath = path.join(path.sep, "ext");
  const bundled = resolvePlcToolchain(extensionPath, "win32", "x64", candidate => candidate.includes(`${path.sep}bundled${path.sep}`));
  assert.ok(bundled.strucppBinary.endsWith(path.join("bundled", "plc", "strucpp", "strucpp.exe")));
  assert.ok(bundled.runtimeIncludeDir.endsWith(path.join("bundled", "plc", "runtime", "include")));
  assert.ok(bundled.cxxCompiler?.endsWith(path.join("bundled", "plc", "ucrt64", "bin", "g++.exe")));
  const dev = resolvePlcToolchain(extensionPath, "linux", "x64", () => false);
  assert.ok(dev.strucppBinary.endsWith(path.join("plc", "strucpp", "build", "linux-x64", "strucpp", "strucpp")));
  assert.ok(dev.plcSrcDir.endsWith(path.join("core", "src", "plc")));
  assert.equal(dev.cxxCompiler, undefined, "Linux usa o g++ do sistema");

  console.log("PLC build (line map, monitor reply, toolchain): OK");
}

main();
