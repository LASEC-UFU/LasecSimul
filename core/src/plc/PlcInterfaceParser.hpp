#pragma once

/**
 * Extrai o nome do `PROGRAM` e as declarações de `VAR_INPUT`/`VAR_OUTPUT` de um arquivo-fonte ST --
 * NÃO é um parser ST completo (não entende expressões, corpo do programa, VAR_IN_OUT, structs,
 * arrays, POUs aninhados) -- só o suficiente pra montar `exportedIo[]`
 * (`PlcNativeModule`) e o driver (`PlcCompiler`, F9.3) sem reimplementar/incorporar o front-end da
 * STruCpp (proibido pelo plano F9 Rodada 1: "sem fork da STruCpp"). Escopo deliberadamente restrito
 * aos blocos de interface -- se o projeto real precisar de VAR_IN_OUT/structs/arrays exportados,
 * isso é uma extensão futura documentada, não um caso silenciosamente ignorado: variáveis em
 * blocos não suportados (`VAR_IN_OUT`, `VAR_GLOBAL`, etc.) são reconhecidas o suficiente pra pular
 * o bloco corretamente, mas nunca aparecem em `exportedIo[]`.
 */

#include <cstdint>
#include <stdexcept>
#include <string>
#include <utility>
#include <vector>

namespace lasecsimul::plc {

struct PlcParsedVariable {
    std::string name;
    std::string iecType; // nome IEC como aparece no fonte (BOOL, INT, REAL, TIME, ...)
    std::string direction; // "input" | "output" | "local"
    bool retain = false;
};

struct PlcParsedTypeField {
    std::string name;
    std::string iecType;
};

/** User-defined IEC type metadata used by the worker monitor to expose scalar members. */
struct PlcParsedType {
    std::string name;
    std::string kind; // "alias" | "struct" | "array"
    std::string baseType; // alias target, or array element type
    std::vector<std::pair<int64_t, int64_t>> dimensions;
    std::vector<PlcParsedTypeField> fields;
};

struct PlcParsedTask {
    std::string name;
    int64_t intervalNs = 0; // 0 is an IEC event task
    int32_t priority = 0;
    std::string eventVariable;
};

struct PlcParsedProgramInstance {
    std::string instanceName;
    std::string taskName;
    std::string programName;
};

struct PlcParsedInterface {
    std::string programName;
    std::vector<PlcParsedVariable> variables; // só VAR_INPUT/VAR_OUTPUT, nessa ordem de declaração
    /** `VAR`/`VAR RETAIN`/`VAR NON_RETAIN` do PROGRAM, para monitorar e forçar no editor; nunca
     * viram pinos. Inclui instâncias de FB (TON...); o driver só publica os tipos escalares. */
    std::vector<PlcParsedVariable> locals;
    std::vector<PlcParsedType> dataTypes;
    std::string configurationName;
    std::vector<PlcParsedTask> tasks;
    std::vector<PlcParsedProgramInstance> programInstances;
};

class PlcInterfaceParseError : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

/** Só os blocos do PROGRAM contam: VAR_INPUT de um FUNCTION_BLOCK declarado antes dele no mesmo
 * arquivo não é entrada do programa.
 *
 * Lança `PlcInterfaceParseError` se nenhum `PROGRAM <nome>` for encontrado, se um bloco
 * `VAR_INPUT`/`VAR_OUTPUT` não fechar com `END_VAR`, ou se uma declaração dentro desses blocos não
 * seguir o formato `nome[, nome2, ...] : TIPO [:= inicial];`. */
/** When a source contains multiple PROGRAMs, select the requested one. An empty name preserves the
 * legacy behavior of selecting the first PROGRAM. */
PlcParsedInterface parsePlcProgramInterface(const std::string& stSource,
                                            const std::string& requestedProgramName = {});

} // namespace lasecsimul::plc
