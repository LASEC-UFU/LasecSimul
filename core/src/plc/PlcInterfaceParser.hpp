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

#include <stdexcept>
#include <string>
#include <vector>

namespace lasecsimul::plc {

struct PlcParsedVariable {
    std::string name;
    std::string iecType; // nome IEC como aparece no fonte (BOOL, INT, REAL, TIME, ...)
    std::string direction; // "input" | "output"
};

struct PlcParsedInterface {
    std::string programName;
    std::vector<PlcParsedVariable> variables; // só VAR_INPUT/VAR_OUTPUT, nessa ordem de declaração
};

class PlcInterfaceParseError : public std::runtime_error {
public:
    using std::runtime_error::runtime_error;
};

/** Lança `PlcInterfaceParseError` se nenhum `PROGRAM <nome>` for encontrado, se um bloco
 * `VAR_INPUT`/`VAR_OUTPUT` não fechar com `END_VAR`, ou se uma declaração dentro desses blocos não
 * seguir o formato `nome[, nome2, ...] : TIPO [:= inicial];`. */
PlcParsedInterface parsePlcProgramInterface(const std::string& stSource);

} // namespace lasecsimul::plc
