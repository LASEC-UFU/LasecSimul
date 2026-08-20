#pragma once

/** Artefato compilado produzido por `PlcCompiler` (F9.3) -- estrutura de dados pura, sem lógica.
 * Mínimo desta rodada (ST-only, um PROGRAM por artefato): sem `symbolTable`/`dataTypeTable`/
 * `pouTable`/`taskTable`/`retainLayout` completos ainda (ver plano F9 Rodada 1, "Mudanças
 * mínimas") -- esses crescem quando múltiplos POUs/linguagens cross-language entrarem em rodadas
 * futuras. */

#include <cstdint>
#include <string>
#include <vector>

namespace lasecsimul::plc {

struct PlcExportedIo {
    std::string ioId;      // identidade estável da ligação -- nesta rodada, igual ao nome da
                            // variável ST (sem symbol table própria ainda pra gerar IDs opacos).
    std::string name;
    std::string direction; // "input" | "output"
    std::string iecType;   // BOOL, INT, DINT, REAL, TIME, etc. -- nome IEC, não o tipo C++ interno.
};

/** Uma entrada por diretiva `#line N "arquivo.st"` encontrada no `.cpp` gerado pela STruCpp
 * (com `--line-directives`) -- não um `STLineMap` reconstruído (achado real de F9.2: `STLineMap`
 * é um artefato só do harness REPL da STruCpp, `#line` é o mecanismo que a compilação simples
 * realmente expõe). `generatedLine` é a linha do `.cpp` gerado onde a diretiva aparece; o mapeamento
 * vale a partir dali até a próxima diretiva (ou fim do arquivo). */
struct PlcDebugLineMapping {
    uint32_t generatedLine = 0;
    std::string sourceFile;
    uint32_t sourceLine = 0;
};

struct PlcNativeModule {
    uint32_t formatVersion = 1;
    uint32_t workerProtocolVersion = 1; // protocolo do PlcScanSession (F9.2) -- HELLO/RESET/SCAN/...

    std::string targetPlatform; // "windows" | "linux" | "darwin"
    std::string targetArch;     // "x64" | "arm64"

    std::string strucppVersion;      // scripts/strucpp-pin.json -> version
    std::string runtimeRevision;     // idem -- headers de core/src/plc/runtime/include/ vêm do
                                      // MESMO pacote de release, então a revisão é a mesma versão.
    std::string cxxToolchainVersion; // saída de `<compilador> --version`, primeira linha.

    std::string sourceHash;   // SHA-256 do(s) arquivo(s) .st fonte.
    std::string artifactHash; // SHA-256 do binário nativo final.

    std::string nativeBinaryRef; // caminho do executável nativo compilado.
    std::string programName;     // nome do PROGRAM (ex.: "HELLO") -- também a base de
                                  // `Program_<NOME>` gerado pela STruCpp.

    std::vector<PlcExportedIo> exportedIo;
    std::vector<PlcDebugLineMapping> debugMap;
};

} // namespace lasecsimul::plc
