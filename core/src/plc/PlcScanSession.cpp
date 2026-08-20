#include "PlcScanSession.hpp"

#include <cctype>
#include <sstream>

#include "iec_std_lib.hpp"

namespace lasecsimul::plc {

namespace {

/** Divide `line` em `(command, requestId, resto)`. Formato: `<COMANDO> <requestId> [resto]`.
 * `requestId` é sempre texto opaco (o Core decide o formato -- este driver só ecoa de volta). */
struct ParsedCommand {
    std::string command;
    std::string requestId;
    std::string rest;
    bool valid = false;
};

ParsedCommand parseCommandLine(const std::string& line) {
    ParsedCommand result;
    std::istringstream stream(line);
    if (!(stream >> result.command)) return result;
    if (!(stream >> result.requestId)) return result;
    std::getline(stream, result.rest);
    size_t start = result.rest.find_first_not_of(" \t");
    result.rest = (start == std::string::npos) ? std::string{} : result.rest.substr(start);
    result.valid = true;
    return result;
}

/** Confere se `value` é sintaticamente válido pro tipo, SEM tocar nenhum ponteiro -- usado na
 * primeira passada de SCAN pra garantir atomicidade (todos os pares validados antes de qualquer
 * um ser aplicado). Espelha exatamente os mesmos casos de `var_set_value` (PlcVariableCommands.hpp)
 * mas descarta o resultado em vez de escrever na variável. */
bool isValueValidForType(VarTypeTag type, const std::string& value) {
    try {
        switch (type) {
            case VarTypeTag::BOOL:
                return value == "TRUE" || value == "true" || value == "1" ||
                       value == "FALSE" || value == "false" || value == "0";
            case VarTypeTag::SINT:
            case VarTypeTag::INT:  (void)std::stoi(value); return true;
            case VarTypeTag::DINT: (void)std::stol(value); return true;
            case VarTypeTag::LINT: (void)std::stoll(value); return true;
            case VarTypeTag::USINT:
            case VarTypeTag::UINT:
            case VarTypeTag::UDINT: (void)std::stoul(value); return true;
            case VarTypeTag::ULINT: (void)std::stoull(value); return true;
            case VarTypeTag::REAL:  (void)std::stof(value); return true;
            case VarTypeTag::LREAL: (void)std::stod(value); return true;
            case VarTypeTag::BYTE:
            case VarTypeTag::WORD:
            case VarTypeTag::DWORD: (void)std::stoul(value, nullptr, 0); return true;
            case VarTypeTag::LWORD: (void)std::stoull(value, nullptr, 0); return true;
            case VarTypeTag::TIME:  (void)std::stoll(value); return true;
            case VarTypeTag::STRING: return value.size() <= 256; // aspas opcionais + 254 chars
            default: return false;
        }
    } catch (...) {
        return false;
    }
}

} // namespace

PlcScanSession::PlcScanSession(ProgramDescriptor program, std::vector<VarDescriptor> inputVars,
                               std::vector<VarDescriptor> outputVars, std::function<void()> resetInstance)
    : m_program(program), m_inputVars(std::move(inputVars)), m_outputVars(std::move(outputVars)),
      m_resetInstance(std::move(resetInstance)) {}

std::string PlcScanSession::handleLine(const std::string& line) {
    const ParsedCommand parsed = parseCommandLine(line);
    if (!parsed.valid) return "ERR ? malformed command line";

    if (parsed.command == "HELLO") return handleHello(parsed.requestId);
    if (parsed.command == "RESET") return handleReset(parsed.requestId);
    if (parsed.command == "SCAN") return handleScan(parsed.requestId, parsed.rest);
    if (parsed.command == "GET" || parsed.command == "SET" ||
        parsed.command == "FORCE" || parsed.command == "UNFORCE") {
        return handleVariableCommand(parsed.command, parsed.requestId, parsed.rest);
    }
    if (parsed.command == "SHUTDOWN") return handleShutdown(parsed.requestId);

    // Reservados pelo protocolo (versão 1), NÃO implementados nesta rodada -- ver plano F9 Rodada
    // 1, secao 3.5. Devolver ERR explicito em vez de "Unknown command" generico deixa claro que o
    // nome e reconhecido, so ainda nao suportado.
    if (parsed.command == "PAUSE" || parsed.command == "CONTINUE" || parsed.command == "STEP_SCAN" ||
        parsed.command == "SET_BREAKPOINT" || parsed.command == "CLEAR_BREAKPOINT") {
        return "ERR " + parsed.requestId + " command reserved for future debug mode, not implemented in this round";
    }

    return "ERR " + parsed.requestId + " unknown command: " + parsed.command;
}

std::string PlcScanSession::handleHello(const std::string& requestId) {
    return "OK " + requestId + " protocol=1 program=" + std::string(m_program.name);
}

std::string PlcScanSession::handleReset(const std::string& requestId) {
    if (m_resetInstance) m_resetInstance();
    m_hasScanned = false;
    m_lastAcceptedTimeNs = -1;
    m_scanCount = 0;
    strucpp::__CURRENT_TIME_NS = 0;
    strucpp::__CURRENT_DT_NS = 0;
    return "OK " + requestId;
}

std::string PlcScanSession::handleScan(const std::string& requestId, const std::string& args) {
    std::istringstream stream(args);
    int64_t simulationTimeNs = 0;
    if (!(stream >> simulationTimeNs)) {
        return "ERR " + requestId + " missing or invalid simulationTimeNs";
    }

    // Monotonicidade: tempo regressivo OU igual ao ultimo scan aceito e rejeitado ANTES de tocar
    // qualquer estado (nem __CURRENT_TIME_NS, nem variaveis, nem run()). Decisao explicita do
    // plano F9 Rodada 1: mesmo timestamp nao e idempotente nesta rodada, e erro.
    if (m_hasScanned && simulationTimeNs <= m_lastAcceptedTimeNs) {
        return "ERR " + requestId + " simulationTimeNs must be strictly greater than the last accepted scan (" +
               std::to_string(m_lastAcceptedTimeNs) + "), got " + std::to_string(simulationTimeNs);
    }

    // Passada 1: parseia e VALIDA todos os pares nome=valor sem tocar nenhum ponteiro real --
    // garante que um SCAN so aplica QUALQUER entrada se TODAS forem validas (I/O atomico).
    struct PendingAssignment { VarDescriptor* var; std::string value; };
    std::vector<PendingAssignment> pending;
    std::string token;
    while (stream >> token) {
        const size_t eq = token.find('=');
        if (eq == std::string::npos || eq == 0) {
            return "ERR " + requestId + " malformed input assignment: " + token;
        }
        const std::string name = token.substr(0, eq);
        const std::string value = token.substr(eq + 1);
        VarDescriptor* var = nullptr;
        for (auto& candidate : m_inputVars) {
            if (name == candidate.name) { var = &candidate; break; }
        }
        if (!var) return "ERR " + requestId + " unknown input variable: " + name;
        if (!isValueValidForType(var->type, value)) {
            return "ERR " + requestId + " invalid value for input " + name + " (" + var_type_name(var->type) + "): " + value;
        }
        pending.push_back({var, value});
    }

    // Passada 2: aplica -- ja validado, var_set_value so pode falhar aqui por um bug de
    // consistencia entre isValueValidForType/var_set_value, nao por entrada do usuario.
    for (auto& assignment : pending) {
        if (!var_set_value(assignment.var->type, assignment.var->var_ptr, assignment.value)) {
            return "ERR " + requestId + " internal: validated value rejected on apply for " +
                   std::string(assignment.var->name);
        }
    }

    // Tempo simulado, nunca wall clock (achado real: TIME() le __CURRENT_TIME_NS, um global
    // simples -- ver PlcVariableCommands.hpp). __CURRENT_DT_NS tambem fixado deterministicamente
    // (senao CURRENT_DT() cai pra system_clock::now() de verdade quando __CURRENT_DT_NS == 0 --
    // ver comentario real em iec_std_lib.hpp) -- simplificacao documentada: nao e uma data de
    // calendario real, so mantem CURRENT_DT() deterministico caso algum POU futuro a use.
    strucpp::__CURRENT_TIME_NS = simulationTimeNs;
    strucpp::__CURRENT_DT_NS = simulationTimeNs;

    m_program.instance->run();

    m_hasScanned = true;
    m_lastAcceptedTimeNs = simulationTimeNs;
    ++m_scanCount;

    // Passada 3: le todas as saidas -- resposta so e construida (e so entao devolvida) depois do
    // scan e da leitura completarem, nunca parcialmente.
    std::string response = "OK " + requestId;
    for (const auto& output : m_outputVars) {
        response += " ";
        response += output.name;
        response += "=";
        response += var_value_to_string(output.type, output.var_ptr);
    }
    return response;
}

std::string PlcScanSession::handleVariableCommand(const std::string& command, const std::string& requestId,
                                                   const std::string& args) {
    std::string lowered = command;
    for (char& c : lowered) c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
    ProgramDescriptor programs[] = {m_program};
    const std::string result = process_command(lowered + (args.empty() ? "" : " " + args), programs, 1);
    if (result.rfind("OK:", 0) == 0) {
        std::string message = result.substr(3);
        if (!message.empty() && message.front() == ' ') message.erase(0, 1);
        return "OK " + requestId + (message.empty() ? "" : " " + message);
    }
    if (result.rfind("ERR:", 0) == 0) {
        std::string message = result.substr(4);
        if (!message.empty() && message.front() == ' ') message.erase(0, 1);
        return "ERR " + requestId + " " + message;
    }
    return "ERR " + requestId + " unexpected response from variable command processor";
}

std::string PlcScanSession::handleShutdown(const std::string& requestId) {
    return "OK " + requestId;
}

} // namespace lasecsimul::plc
