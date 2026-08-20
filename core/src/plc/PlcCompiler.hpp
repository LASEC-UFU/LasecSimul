#pragma once

/**
 * Orquestra ST source -> STruCpp -> C++ gerado -> driver LasecSimul -> toolchain C++ nativo ->
 * `PlcNativeModule` (F9.3). Não integra com `SimulationSession`/`Scheduler` ainda (F9.4/F9.5) --
 * este arquivo só sabe compilar um projeto ST isolado e devolver o artefato ou lançar com
 * diagnóstico completo.
 *
 * Separação de proveniência preservada (plano F9 Rodada 1): binário STruCpp = compilador de
 * terceiros (nunca modificado, invocado como processo externo); `core/src/plc/runtime/include/` =
 * headers de terceiros vendorizados (só incluídos, nunca gerados aqui); `PlcDriverCodegen`/
 * `PlcScanSession`/este arquivo = código próprio do LasecSimul.
 */

#include <filesystem>
#include <stdexcept>
#include <string>

#include "PlcNativeModule.hpp"

namespace lasecsimul::plc {

struct PlcCompileOptions {
    std::filesystem::path stSourcePath;
    std::filesystem::path workDir; // diretório de trabalho/saída -- criado se não existir; arquivos
                                    // intermediários (.cpp gerado, driver, binário) ficam aqui.

    /** Caminho do binário STruCpp vendorizado -- OBRIGATÓRIO, nunca resolvido via PATH aqui (a
     * resolução da convenção de instalação/pin, ver scripts/strucpp-pin.json, é responsabilidade
     * de quem chama, mesmo padrão já usado por scripts/test-strucpp-smoke.js). Lança se vazio ou
     * se o arquivo não existir. */
    std::filesystem::path strucppBinaryPath;

    /** Compilador C++ nativo -- se vazio, resolvido nesta ordem: variável de ambiente
     * `LASECSIMUL_PLC_CXX`, depois `g++`/`gcc` no PATH (mesma lógica de
     * scripts/check-plc-toolchain.js). Se PREENCHIDO (aqui OU via a variável de ambiente) e o
     * compilador resultante não for executável, é erro explícito -- nunca cai silenciosamente pro
     * PATH nesse caso (só tenta PATH quando NADA foi configurado). */
    std::filesystem::path cxxCompilerPath;

    /** `core/src/plc/runtime/include` -- headers de runtime da STruCpp vendorizados. Obrigatório. */
    std::filesystem::path runtimeIncludeDir;

    /** `core/src/plc` -- onde `PlcScanSession.{hpp,cpp}`/`PlcVariableCommands.hpp` vivem, pra
     * compilar o driver contra eles. Obrigatório. */
    std::filesystem::path lasecsimulPlcSrcDir;
};

struct PlcCompileDiagnostics {
    std::string stage; // "toolchain" | "parse" | "strucpp" | "codegen" | "cxx" | "validate"
    std::string message;
    std::string capturedOutput; // stdout+stderr combinados do processo externo, quando aplicável
    int exitCode = 0;
};

/** Lançada em qualquer falha do pipeline -- nunca devolve um `PlcNativeModule` parcialmente válido;
 * ou a compilação inteira (incluindo validação do artefato) teve sucesso, ou isto é lançado. */
class PlcCompileError : public std::runtime_error {
public:
    explicit PlcCompileError(PlcCompileDiagnostics diagnostics)
        : std::runtime_error("[" + diagnostics.stage + "] " + diagnostics.message), m_diagnostics(std::move(diagnostics)) {}

    const PlcCompileDiagnostics& diagnostics() const { return m_diagnostics; }

private:
    PlcCompileDiagnostics m_diagnostics;
};

class PlcCompiler {
public:
    /** Roda o pipeline inteiro de ponta a ponta, incluindo validação do artefato final (spawna o
     * binário compilado, faz HELLO/SHUTDOWN reais, confirma que responde antes de devolver).
     * Lança `PlcCompileError` em qualquer falha -- nunca deixa `workDir` com um binário "parecendo
     * válido" sem essa validação ter passado. */
    static PlcNativeModule compile(const PlcCompileOptions& options);
};

} // namespace lasecsimul::plc
