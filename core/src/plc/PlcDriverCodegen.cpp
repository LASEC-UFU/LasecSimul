#include "PlcDriverCodegen.hpp"

#include <algorithm>
#include <cctype>
#include <optional>
#include <sstream>
#include <stdexcept>

namespace lasecsimul::plc {

namespace {

std::string toUpper(const std::string& text) {
    std::string result = text;
    std::transform(result.begin(), result.end(), result.begin(),
                    [](unsigned char c) { return static_cast<char>(std::toupper(c)); });
    return result;
}

/** Mapeia o nome IEC (BOOL, INT, ...) pro nome do enumerador `VarTypeTag` correspondente --
 * espelha 1:1 os tipos que `PlcVariableCommands.hpp` sabe formatar/parsear (extraídos da própria
 * STruCpp). Tipos IEC não escalares (structs, arrays, function blocks como TON usado como
 * VAR_INPUT/VAR_OUTPUT, o que nem é válido em IEC 61131-3 pra interface de PROGRAM) não têm
 * mapeamento -- `std::nullopt`, tratado como erro por quem chama. */
std::optional<std::string> mapIecTypeToVarTypeTag(const std::string& iecType) {
    static const std::vector<std::pair<std::string, std::string>> kKnownTypes = {
        {"BOOL", "BOOL"}, {"SINT", "SINT"}, {"INT", "INT"}, {"DINT", "DINT"}, {"LINT", "LINT"},
        {"USINT", "USINT"}, {"UINT", "UINT"}, {"UDINT", "UDINT"}, {"ULINT", "ULINT"},
        {"REAL", "REAL"}, {"LREAL", "LREAL"},
        {"BYTE", "BYTE"}, {"WORD", "WORD"}, {"DWORD", "DWORD"}, {"LWORD", "LWORD"},
        {"TIME", "TIME"}, {"STRING", "STRING"},
    };
    const std::string upper = toUpper(iecType);
    for (const auto& [name, tag] : kKnownTypes) {
        if (upper == name) return tag;
    }
    return std::nullopt;
}

} // namespace

std::string generatePlcWorkerDriverSource(const PlcParsedInterface& interface, const std::string& generatedHeaderName) {
    const std::string programNameUpper = toUpper(interface.programName);
    const std::string className = "Program_" + programNameUpper;

    struct ResolvedVar { std::string name; std::string tag; std::string direction; };
    std::vector<ResolvedVar> resolved;
    resolved.reserve(interface.variables.size());
    for (const auto& variable : interface.variables) {
        const auto tag = mapIecTypeToVarTypeTag(variable.iecType);
        if (!tag) {
            throw std::runtime_error("PlcDriverCodegen: tipo IEC sem mapeamento pra VarTypeTag: " +
                                     variable.iecType + " (variavel " + variable.name + ")");
        }
        // STruCpp gera nomes de membro em maiusculo a partir do identificador ST (ex.: "di0" ->
        // "DI0", confirmado no .hpp real gerado) -- o nome usado em VarDescriptor/GET/SET segue a
        // mesma convencao (mesmo padrao que o proprio harness --build da STruCpp usa).
        resolved.push_back({toUpper(variable.name), *tag, variable.direction});
    }

    std::ostringstream out;
    out << "// GERADO por PlcCompiler (F9.3) -- nao editar manualmente. Driver proprio do\n";
    out << "// LasecSimul, nao vendorizado da STruCpp -- ver core/src/plc/PlcDriverCodegen.cpp.\n";
    out << "#include <iostream>\n";
    out << "#include <string>\n";
    out << "#include <vector>\n\n";
    out << "#include \"PlcScanSession.hpp\"\n";
    out << "#include \"" << generatedHeaderName << "\"\n\n";
    out << "using namespace lasecsimul::plc;\n\n";
    out << "namespace {\n";
    out << "strucpp::" << className << " g_program;\n";
    out << "}\n\n";
    out << "int main() {\n";
    out << "    std::vector<VarDescriptor> allVars = {\n";
    for (const auto& variable : resolved) {
        out << "        {\"" << variable.name << "\", VarTypeTag::" << variable.tag
            << ", &g_program." << variable.name << "},\n";
    }
    out << "    };\n";
    out << "    std::vector<VarDescriptor> inputVars = {\n";
    for (const auto& variable : resolved) {
        if (variable.direction != "input") continue;
        out << "        {\"" << variable.name << "\", VarTypeTag::" << variable.tag
            << ", &g_program." << variable.name << "},\n";
    }
    out << "    };\n";
    out << "    std::vector<VarDescriptor> outputVars = {\n";
    for (const auto& variable : resolved) {
        if (variable.direction != "output") continue;
        out << "        {\"" << variable.name << "\", VarTypeTag::" << variable.tag
            << ", &g_program." << variable.name << "},\n";
    }
    out << "    };\n\n";
    out << "    ProgramDescriptor descriptor{\"" << programNameUpper
        << "\", &g_program, allVars.data(), allVars.size(), 0LL};\n\n";
    out << "    PlcScanSession session(descriptor, std::move(inputVars), std::move(outputVars), [] {\n";
    out << "        g_program.~" << className << "();\n";
    out << "        new (&g_program) strucpp::" << className << "();\n";
    out << "    });\n\n";
    out << "    std::string line;\n";
    out << "    while (std::getline(std::cin, line)) {\n";
    out << "        if (line.empty()) continue;\n";
    out << "        const std::string response = session.handleLine(line);\n";
    out << "        std::cout << response << \"\\n\" << std::flush;\n";
    out << "        if (line.rfind(\"SHUTDOWN\", 0) == 0) break;\n";
    out << "    }\n";
    out << "    return 0;\n";
    out << "}\n";
    return out.str();
}

} // namespace lasecsimul::plc
