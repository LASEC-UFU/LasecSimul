#include "PlcDriverCodegen.hpp"

#include <algorithm>
#include <cctype>
#include <optional>
#include <regex>
#include <sstream>
#include <stdexcept>
#include <unordered_map>

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

struct ResolvedVar { std::string name; std::string tag; std::string direction; std::string memberPath; };

const std::vector<PlcParsedTypeField>* builtinFunctionBlockFields(const std::string& iecType) {
    static const std::unordered_map<std::string, std::vector<PlcParsedTypeField>> fields = {
        {"TON", {{"IN", "BOOL"}, {"PT", "TIME"}, {"Q", "BOOL"}, {"ET", "TIME"}}},
        {"TOF", {{"IN", "BOOL"}, {"PT", "TIME"}, {"Q", "BOOL"}, {"ET", "TIME"}}},
        {"TP", {{"IN", "BOOL"}, {"PT", "TIME"}, {"Q", "BOOL"}, {"ET", "TIME"}}},
        {"R_TRIG", {{"CLK", "BOOL"}, {"Q", "BOOL"}}},
        {"F_TRIG", {{"CLK", "BOOL"}, {"Q", "BOOL"}}},
        {"SR", {{"S1", "BOOL"}, {"R", "BOOL"}, {"Q1", "BOOL"}}},
        {"RS", {{"S", "BOOL"}, {"R1", "BOOL"}, {"Q1", "BOOL"}}},
        {"CTU", {{"CU", "BOOL"}, {"R", "BOOL"}, {"PV", "INT"}, {"Q", "BOOL"}, {"CV", "INT"}}},
        {"CTD", {{"CD", "BOOL"}, {"LD", "BOOL"}, {"PV", "INT"}, {"Q", "BOOL"}, {"CV", "INT"}}},
        {"CTUD", {{"CU", "BOOL"}, {"CD", "BOOL"}, {"R", "BOOL"}, {"LD", "BOOL"}, {"PV", "INT"}, {"QU", "BOOL"}, {"QD", "BOOL"}, {"CV", "INT"}}},
    };
    const auto found = fields.find(toUpper(iecType));
    return found == fields.end() ? nullptr : &found->second;
}

const PlcParsedType* findType(const std::vector<PlcParsedType>& types, const std::string& name) {
    const std::string wanted = toUpper(name);
    const auto found = std::find_if(types.begin(), types.end(), [&](const PlcParsedType& type) {
        return toUpper(type.name) == wanted;
    });
    return found == types.end() ? nullptr : &*found;
}

std::string cppMemberIdentifier(const std::string& identifier, const std::vector<PlcParsedType>& types) {
    const std::string upper = toUpper(identifier);
    return findType(types, upper) ? upper + "_" : upper;
}

bool parseArrayType(const std::string& source, std::vector<std::pair<int64_t, int64_t>>& dimensions,
                    std::string& elementType) {
    static const std::regex arrayPattern(R"re(^\s*ARRAY\s*\[([^\]]+)\]\s*OF\s*(.+?)\s*$)re", std::regex_constants::icase);
    std::smatch match;
    if (!std::regex_match(source, match, arrayPattern)) return false;
    elementType = match[2].str();
    std::istringstream bounds(match[1].str());
    std::string bound;
    while (std::getline(bounds, bound, ',')) {
        const size_t dots = bound.find("..");
        if (dots == std::string::npos) return false;
        try {
            const int64_t lower = std::stoll(bound.substr(0, dots));
            const int64_t upper = std::stoll(bound.substr(dots + 2));
            if (upper < lower) return false;
            dimensions.emplace_back(lower, upper);
        } catch (...) { return false; }
    }
    return !dimensions.empty();
}

void appendLocalMonitorVars(const std::string& variableName, const std::string& memberPath,
                            const std::string& iecType, const std::vector<PlcParsedType>& types,
                            std::vector<ResolvedVar>& out, std::vector<std::string>& typeStack,
                            size_t arrayBudget = 2048) {
    if (const auto tag = mapIecTypeToVarTypeTag(iecType)) {
        out.push_back({variableName, *tag, "local", memberPath});
        return;
    }
    std::vector<std::pair<int64_t, int64_t>> dimensions;
    std::string elementType;
    const PlcParsedType* type = findType(types, iecType);
    if (!type) {
        if (const auto* fields = builtinFunctionBlockFields(iecType)) {
            for (const auto& field : *fields) {
                const std::string fieldName = toUpper(field.name);
                appendLocalMonitorVars(variableName + "." + fieldName,
                    memberPath + "." + cppMemberIdentifier(field.name, types), field.iecType, types, out, typeStack);
            }
            return;
        }
        if (!parseArrayType(iecType, dimensions, elementType)) return;
    } else if (std::find(typeStack.begin(), typeStack.end(), toUpper(type->name)) != typeStack.end()) {
        return;
    } else if (type->kind == "alias") {
        typeStack.push_back(toUpper(type->name));
        appendLocalMonitorVars(variableName, memberPath, type->baseType, types, out, typeStack, arrayBudget);
        typeStack.pop_back();
        return;
    } else if (type->kind == "struct") {
        typeStack.push_back(toUpper(type->name));
        for (const PlcParsedTypeField& field : type->fields) {
            const std::string fieldName = toUpper(field.name);
            appendLocalMonitorVars(variableName + "." + fieldName, memberPath + "." + cppMemberIdentifier(field.name, types),
                                   field.iecType, types, out, typeStack, arrayBudget);
        }
        typeStack.pop_back();
        return;
    } else {
        dimensions = type->dimensions;
        elementType = type->baseType;
    }

    size_t count = 1;
    for (const auto& [lower, upper] : dimensions) {
        const uint64_t width = static_cast<uint64_t>(upper - lower) + 1;
        if (width > arrayBudget || count > arrayBudget / static_cast<size_t>(width)) { count = arrayBudget; break; }
        count *= static_cast<size_t>(width);
    }
    typeStack.push_back(type ? toUpper(type->name) : toUpper(iecType));
    for (size_t flatIndex = 0; flatIndex < count; ++flatIndex) {
        size_t remainder = flatIndex;
        std::vector<int64_t> indices(dimensions.size());
        for (size_t dimension = dimensions.size(); dimension-- > 0;) {
            const auto [lower, upper] = dimensions[dimension];
            const size_t width = static_cast<size_t>(upper - lower) + 1;
            indices[dimension] = lower + static_cast<int64_t>(remainder % width);
            remainder /= width;
        }
        std::string indexedName = variableName;
        std::string indexedPath = memberPath;
        for (int64_t index : indices) {
            indexedName += "[" + std::to_string(index) + "]";
            indexedPath += "[" + std::to_string(index) + "]";
        }
        appendLocalMonitorVars(indexedName, indexedPath, elementType, types, out, typeStack, arrayBudget);
    }
    typeStack.pop_back();
}

} // namespace

std::string generatePlcWorkerDriverSource(const PlcParsedInterface& interface, const std::string& generatedHeaderName) {
    const std::string programNameUpper = toUpper(interface.programName);
    const std::string className = "Program_" + programNameUpper;
    const auto entryInstance = std::find_if(interface.programInstances.begin(), interface.programInstances.end(),
        [&](const PlcParsedProgramInstance& instance) { return toUpper(instance.programName) == programNameUpper; });
    const bool configured = !interface.configurationName.empty() && entryInstance != interface.programInstances.end();
    const std::string configurationClass = "Configuration_" + toUpper(interface.configurationName);
    const std::string instanceMember = configured ? toUpper(entryInstance->instanceName) : std::string{};
    const std::string programObject = configured ? "g_configuration." + instanceMember : "g_program";

    std::vector<ResolvedVar> resolved;
    resolved.reserve(interface.variables.size());
    for (const auto& variable : interface.variables) {
        std::vector<std::string> typeStack;
        const size_t before = resolved.size();
        appendLocalMonitorVars(toUpper(variable.name), cppMemberIdentifier(variable.name, interface.dataTypes), variable.iecType,
                               interface.dataTypes, resolved, typeStack);
        if (resolved.size() == before) {
            throw std::runtime_error("PlcDriverCodegen: tipo IEC sem mapeamento pra VarTypeTag: " +
                                     variable.iecType + " (variavel " + variable.name + ")");
        }
        if ((variable.direction == "input" || variable.direction == "output") &&
            (resolved.size() != before + 1 || resolved[before].name != toUpper(variable.name))) {
            throw std::runtime_error("PlcDriverCodegen: porta de PROGRAM deve ter tipo escalar IEC: " + variable.name);
        }
        // STruCpp gera nomes de membro em maiusculo a partir do identificador ST (ex.: "di0" ->
        // "DI0", confirmado no .hpp real gerado) -- o nome usado em VarDescriptor/GET/SET segue a
        // mesma convencao (mesmo padrao que o proprio harness --build da STruCpp usa).
        for (size_t i = before; i < resolved.size(); ++i) resolved[i].direction = variable.direction;
    }
    // Locais escalares entram só na tabela de GET/SET/FORCE (monitoração do editor). Instâncias de
    // FB, arrays e structs ficam de fora: não há VarTypeTag para elas.
    for (const auto& variable : interface.locals) {
        std::vector<std::string> typeStack;
        appendLocalMonitorVars(toUpper(variable.name), cppMemberIdentifier(variable.name, interface.dataTypes), variable.iecType,
                               interface.dataTypes, resolved, typeStack);
    }

    std::ostringstream out;
    out << "// GERADO por PlcCompiler (F9.3) -- nao editar manualmente. Driver proprio do\n";
    out << "// LasecSimul, nao vendorizado da STruCpp -- ver core/src/plc/PlcDriverCodegen.cpp.\n";
    out << "#include <iostream>\n";
    out << "#include <string>\n";
    out << "#include <vector>\n\n";
    out << "#include <algorithm>\n";
    out << "#include <cctype>\n";
    out << "#include <limits>\n";
    out << "#include <new>\n";
    out << "#include \"PlcScanSession.hpp\"\n";
    out << "#include \"" << generatedHeaderName << "\"\n\n";
    out << "using namespace lasecsimul::plc;\n\n";
    out << "namespace {\n";
    if (configured) {
        out << "strucpp::" << configurationClass << " g_configuration;\n";
        out << "strucpp::" << className << "& g_program = g_configuration." << instanceMember << ";\n";
    } else {
        out << "strucpp::" << className << " g_program;\n";
    }
    out << "}\n\n";
    out << "int main() {\n";
    out << "    std::vector<VarDescriptor> allVars = {\n";
    for (const auto& variable : resolved) {
        out << "        {\"" << variable.name << "\", VarTypeTag::" << variable.tag
            << ", &" << programObject << "." << variable.memberPath << "},\n";
    }
    out << "    };\n";
    out << "    std::vector<VarDescriptor> inputVars = {\n";
    for (const auto& variable : resolved) {
        if (variable.direction != "input") continue;
        out << "        {\"" << variable.name << "\", VarTypeTag::" << variable.tag
            << ", &" << programObject << "." << variable.memberPath << "},\n";
    }
    out << "    };\n";
    out << "    std::vector<VarDescriptor> outputVars = {\n";
    for (const auto& variable : resolved) {
        if (variable.direction != "output") continue;
        out << "        {\"" << variable.name << "\", VarTypeTag::" << variable.tag
            << ", &" << programObject << "." << variable.memberPath << "},\n";
    }
    out << "    };\n\n";
    out << "    auto exportRetain = [&allVars]() {\n";
    out << "        std::string snapshot; const auto* retained = g_program.getRetainVars();\n";
    out << "        static const char* hex = \"0123456789abcdef\";\n";
    out << "        for (size_t i = 0; retained && i < g_program.getRetainCount(); ++i) {\n";
    out << "            if (!retained[i].name) continue; std::string name = retained[i].name;\n";
    out << "            std::transform(name.begin(), name.end(), name.begin(), [](unsigned char c) { return static_cast<char>(std::toupper(c)); });\n";
    out << "            for (const auto& var : allVars) if (var.name && name == var.name) {\n";
    out << "                const std::string value = var_value_to_string(var.type, var.var_ptr); snapshot += name + '=';\n";
    out << "                for (unsigned char c : value) { snapshot += hex[c >> 4]; snapshot += hex[c & 15]; } snapshot += ';'; break;\n";
    out << "            }\n        } return snapshot;\n    };\n";
    out << "    auto importRetain = [&allVars](const std::string& snapshot) {\n";
    out << "        auto nibble = [](char c) -> int { if (c >= '0' && c <= '9') return c - '0'; if (c >= 'a' && c <= 'f') return c - 'a' + 10; if (c >= 'A' && c <= 'F') return c - 'A' + 10; return -1; };\n";
    out << "        size_t start = 0; while (start < snapshot.size()) { const size_t end = snapshot.find(';', start); if (end == std::string::npos) return false; const size_t eq = snapshot.find('=', start); if (eq == std::string::npos || eq >= end || ((end - eq - 1) % 2) != 0) return false;\n";
    out << "            const std::string name = snapshot.substr(start, eq - start); std::string value; value.reserve((end - eq - 1) / 2);\n";
    out << "            for (size_t p = eq + 1; p < end; p += 2) { const int hi = nibble(snapshot[p]), lo = nibble(snapshot[p + 1]); if (hi < 0 || lo < 0) return false; value.push_back(static_cast<char>((hi << 4) | lo)); }\n";
    out << "            bool found = false; for (const auto& var : allVars) if (var.name && name == var.name) { if (!var_set_value(var.type, var.var_ptr, value)) return false; found = true; break; } if (!found) return false; start = end + 1;\n";
    out << "        } return true;\n    };\n\n";
    out << "    ProgramDescriptor descriptor{\"" << programNameUpper
        << "\", &g_program, allVars.data(), allVars.size(), 0LL};\n\n";
    if (configured) {
        out << "    std::vector<int64_t> nextTaskTime;\n";
        out << "    std::vector<int64_t> lastTaskTime;\n";
        out << "    auto runConfiguredTasks = [&nextTaskTime, &lastTaskTime](int64_t targetTimeNs, const std::vector<std::string>& eventTasks) {\n";
        out << "        strucpp::ResourceInstance* resources = g_configuration.get_resources();\n";
        out << "        const size_t resourceCount = g_configuration.get_resource_count();\n";
        out << "        size_t taskCount = 0;\n";
        out << "        for (size_t r = 0; resources && r < resourceCount; ++r) taskCount += resources[r].task_count;\n";
        out << "        if (nextTaskTime.size() != taskCount) { nextTaskTime.assign(taskCount, -1); lastTaskTime.assign(taskCount, -1); }\n";
        out << "        if (eventTasks.empty()) for (;;) {\n";
        out << "            strucpp::TaskInstance* selected = nullptr; size_t selectedIndex = 0;\n";
        out << "            int64_t selectedTime = std::numeric_limits<int64_t>::max(); size_t flatIndex = 0;\n";
        out << "            for (size_t r = 0; resources && r < resourceCount; ++r) {\n";
        out << "                for (size_t t = 0; t < resources[r].task_count; ++t, ++flatIndex) {\n";
        out << "                    auto& task = resources[r].tasks[t]; if (task.interval_ns <= 0) continue;\n";
        out << "                    if (nextTaskTime[flatIndex] < 0) { const int64_t remainder = targetTimeNs % task.interval_ns; nextTaskTime[flatIndex] = remainder == 0 ? targetTimeNs : targetTimeNs + (task.interval_ns - remainder); }\n";
        out << "                    const int64_t due = nextTaskTime[flatIndex]; if (due > targetTimeNs) continue;\n";
        out << "                    if (!selected || due < selectedTime || (due == selectedTime && task.priority > selected->priority) ||\n";
        out << "                        (due == selectedTime && task.priority == selected->priority && std::string(task.name ? task.name : \"\") < (selected->name ? selected->name : \"\"))) {\n";
        out << "                        selected = &task; selectedIndex = flatIndex; selectedTime = due;\n";
        out << "                    }\n";
        out << "                }\n            }\n";
        out << "            if (!selected) break;\n";
        out << "            strucpp::__CURRENT_TIME_NS = selectedTime;\n";
        out << "            strucpp::__CURRENT_DT_NS = lastTaskTime[selectedIndex] < 0 ? selectedTime : selectedTime - lastTaskTime[selectedIndex];\n";
        out << "            for (size_t p = 0; selected->programs && p < selected->program_count; ++p) {\n";
        out << "                if (!selected->programs[p]) continue; selected->programs[p]->sync_in(); selected->programs[p]->run(); selected->programs[p]->sync_out();\n";
        out << "            }\n";
        out << "            lastTaskTime[selectedIndex] = selectedTime;\n";
        out << "            if (selectedTime > std::numeric_limits<int64_t>::max() - selected->interval_ns) break;\n";
        out << "            nextTaskTime[selectedIndex] += selected->interval_ns;\n";
        out << "        }\n";
        out << "        for (const auto& requested : eventTasks) for (size_t r = 0; resources && r < resourceCount; ++r) for (size_t t = 0; t < resources[r].task_count; ++t) {\n";
        out << "            auto& task = resources[r].tasks[t]; if (!task.name || requested != task.name || task.interval_ns > 0) continue;\n";
        out << "            strucpp::__CURRENT_TIME_NS = targetTimeNs; strucpp::__CURRENT_DT_NS = 0;\n";
        out << "            for (size_t p = 0; task.programs && p < task.program_count; ++p) if (task.programs[p]) { task.programs[p]->sync_in(); task.programs[p]->run(); task.programs[p]->sync_out(); }\n";
        out << "        }\n";
        out << "        strucpp::__CURRENT_TIME_NS = targetTimeNs;\n";
        out << "    };\n";
    }
    out << "    PlcScanSession session(descriptor, std::move(inputVars), std::move(outputVars), [&allVars"
        << (configured ? ", &nextTaskTime, &lastTaskTime" : "") << "] {\n";
    out << "        struct SavedRetain { std::string name; VarTypeTag type; std::string value; };\n";
    out << "        std::vector<SavedRetain> retained;\n";
    out << "        const auto* retainVars = g_program.getRetainVars();\n";
    out << "        for (size_t i = 0; retainVars && i < g_program.getRetainCount(); ++i) {\n";
    out << "            if (!retainVars[i].name) continue;\n";
    out << "            std::string retainedName = retainVars[i].name;\n";
    out << "            std::transform(retainedName.begin(), retainedName.end(), retainedName.begin(), [](unsigned char c) { return static_cast<char>(std::toupper(c)); });\n";
    out << "            for (const auto& var : allVars) if (var.name && retainedName == var.name) { retained.push_back({retainedName, var.type, var_value_to_string(var.type, var.var_ptr)}); break; }\n";
    out << "        }\n";
    if (configured) {
        out << "        g_configuration.~" << configurationClass << "();\n";
        out << "        new (&g_configuration) strucpp::" << configurationClass << "();\n";
        out << "        nextTaskTime.clear(); lastTaskTime.clear();\n";
    } else {
        out << "        g_program.~" << className << "();\n";
        out << "        new (&g_program) strucpp::" << className << "();\n";
    }
    out << "        for (const auto& saved : retained) for (const auto& var : allVars) {\n";
    out << "            if (var.name && saved.name == var.name && var.type == saved.type) { var_set_value(var.type, var.var_ptr, saved.value); break; }\n";
    out << "        }\n";
    out << "    }";
    if (configured) out << ", runConfiguredTasks";
    else out << ", std::function<void(int64_t, const std::vector<std::string>&)>{}";
    out << ", exportRetain, importRetain";
    out << ");\n\n";
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
