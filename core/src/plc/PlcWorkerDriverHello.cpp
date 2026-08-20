/**
 * Driver de worker PLC pro fixture `hello` (F9.2) -- prova o protocolo/contrato de execução
 * (PlcScanSession) ponta a ponta, fora do Core, como um processo standalone. Escrito à mão pra
 * UM `PROGRAM` específico nesta rodada; F9.3 (`PlcCompiler`) gera este arquivo automaticamente por
 * projeto em vez de alguém escrever isto manualmente -- a forma abaixo (instância estática +
 * VarDescriptor[] + ProgramDescriptor) já é exatamente como a própria STruCpp conecta um PROGRAM
 * gerado ao runtime dela (visto no `main.cpp` que `strucpp --build` gera), então é o padrão real a
 * seguir, não um formato inventado.
 *
 * Loop: lê uma linha de comando do stdin, processa via PlcScanSession::handleLine(), escreve a
 * resposta no stdout, repete até SHUTDOWN ou EOF. Protocolo texto por linha, síncrono (uma
 * requisição pendente por vez) -- ver PlcScanSession.hpp pro contrato completo.
 */

#include <cstdio>
#include <iostream>
#include <string>

#include "PlcScanSession.hpp"
#include "fixtures/hello.generated.hpp"

using namespace lasecsimul::plc;

namespace {

// Mesma forma que "strucpp --build" gera pra conectar um PROGRAM ao runtime -- ver
// C:/Temp/strucpp-inspect/main.cpp (harness real gerado durante a investigação de F9.2), não
// inventado aqui.
strucpp::Program_HELLO g_program;

VarDescriptor makeVarDescriptor(const char* name, VarTypeTag type, void* ptr) {
    return VarDescriptor{name, type, ptr};
}

} // namespace

int main() {
    std::vector<VarDescriptor> allVars = {
        makeVarDescriptor("DI0", VarTypeTag::BOOL, &g_program.DI0),
        makeVarDescriptor("DO0", VarTypeTag::BOOL, &g_program.DO0),
        makeVarDescriptor("TIMER0", VarTypeTag::OTHER, &g_program.TIMER0),
    };
    std::vector<VarDescriptor> inputVars = {
        makeVarDescriptor("DI0", VarTypeTag::BOOL, &g_program.DI0),
    };
    std::vector<VarDescriptor> outputVars = {
        makeVarDescriptor("DO0", VarTypeTag::BOOL, &g_program.DO0),
    };

    ProgramDescriptor descriptor{"HELLO", &g_program, allVars.data(), allVars.size(), 0LL};

    PlcScanSession session(descriptor, std::move(inputVars), std::move(outputVars), [] {
        // Reset = reconstroi a instancia no MESMO endereco (placement-new) -- os ponteiros ja
        // resolvidos em allVars/inputVars/outputVars continuam validos depois (ver doc-comment de
        // PlcScanSession::PlcScanSession).
        g_program.~Program_HELLO();
        new (&g_program) strucpp::Program_HELLO();
    });

    std::string line;
    while (std::getline(std::cin, line)) {
        if (line.empty()) continue;
        const std::string response = session.handleLine(line);
        std::cout << response << "\n" << std::flush;
        if (line.rfind("SHUTDOWN", 0) == 0) break;
    }
    return 0;
}
