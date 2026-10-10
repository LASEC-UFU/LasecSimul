#pragma once

/**
 * Modo de linha de comando `lasecsimul-core --plc-compile <pedido.json>`: o botão Compilar da
 * Extension usa o MESMO executável do Core que roda a simulação, sem abrir uma sessão IPC, para
 * levar o ST canônico até o artefato nativo (`PlcCompiler::compile`).
 *
 * Pedido (JSON): `stSourcePath`, `workDir`, `strucppBinaryPath`, `runtimeIncludeDir`,
 * `lasecsimulPlcSrcDir`, `manifestPath`; opcionais `cxxCompilerPath`, `strucppLibraryDirs` e
 * `ioIdByVariableName` (objeto nome ST -> ioId estável).
 *
 * Resposta: uma linha JSON em stdout. Sucesso (código 0): `{"ok":true,"manifestPath":...}` e o
 * manifesto `PlcNativeModule` gravado em `manifestPath`. Falha (código 2):
 * `{"ok":false,"diagnostics":{"stage","message","capturedOutput","exitCode"}}`. Pedido inválido:
 * código 3, mesmo formato com stage "request".
 */

#include <string>

namespace lasecsimul::plc {

int runPlcCompileCli(const std::string& requestPath);

} // namespace lasecsimul::plc
