#pragma once

/**
 * Adapter de get/set/force/unforce/watch pra variáveis de PROGRAM compilado pela STruCpp --
 * EXTRAÍDO (não forkado inteiro) de `runtime/repl/iec_repl.hpp` da STruCpp v0.6.3
 * (Autonomy-Logic/STruCpp, GPL-3.0-or-later WITH STruCpp-runtime-exception, ver
 * scripts/strucpp-pin.json), especificamente os tipos `VarTypeTag`/`VarDescriptor`/
 * `ProgramDescriptor`/`STLineMap` e a função `process_command()` (achado real, 2026-08-20:
 * o comentário do próprio código-fonte da STruCpp já descreve essa função como "Used by both the
 * interactive REPL loop and the IPC command server").
 *
 * Por que extração em vez de `#include "iec_repl.hpp"` direto: esse header inclui
 * `"isocline.h"` (biblioteca de line-editing de terminal) no topo do arquivo INTEIRO -- mesmo sem
 * chamar `repl_run()`/tab-completion/highlighting, o parser ainda precisa resolver os tipos de
 * `isocline.h` (ex.: `ic_completion_env_t*` aparece em assinaturas de função no mesmo arquivo),
 * então incluir o header inteiro arrasta essa dependência de terminal pro worker do LasecSimul sem
 * necessidade real. `process_command()` em si (extraída abaixo, verbatim) nunca chama nada de
 * isocline -- só usa `IECVar<T>`/`ProgramDescriptor`/`VarDescriptor`, já disponíveis via
 * `iec_var.hpp`/`iec_std_lib.hpp`. Ver plano F9 Rodada 1, seção 3 ("`process_command()` NÃO é
 * dependência obrigatória").
 *
 * O que NÃO foi trazido pra cá (fica só no binário REPL interativo da STruCpp, nunca no worker do
 * LasecSimul): `repl_run()`, tab completion, syntax highlighting, o comando `code`/`dashboard`,
 * qualquer coisa que toque `isocline.h`/terminal.
 */

#include <cinttypes>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>

#include "iec_std_lib.hpp"
#include "iec_var.hpp"

namespace lasecsimul::plc {

// =============================================================================
// Extraído de iec_repl.hpp: Type Tags for REPL Value Display
// =============================================================================

enum class VarTypeTag {
    BOOL, SINT, INT, DINT, LINT,
    USINT, UINT, UDINT, ULINT,
    REAL, LREAL,
    BYTE, WORD, DWORD, LWORD,
    TIME, STRING, OTHER
};

// =============================================================================
// Extraído de iec_repl.hpp: Variable and Program Descriptors
// =============================================================================

struct VarDescriptor {
    const char* name;
    VarTypeTag type;
    void* var_ptr;
};

struct ProgramDescriptor {
    const char* name;
    strucpp::ProgramBase* instance;
    VarDescriptor* vars;
    size_t var_count;
    int64_t interval_ns; // não usado pelo driver do LasecSimul (scan é dirigido por comando, não por task interval) -- mantido só por compatibilidade de forma com o struct real da STruCpp.
};

/** Mapeamento linha ST -> linha(s) C++ gerado -- extraído de iec_repl.hpp pra uso futuro de debug
 * (ver investigação de F9.2 sobre metadata de debug). Não populado nesta rodada: a fonte real de
 * verdade pra isso, confirmada por teste direto do binário STruCpp, são as diretivas `#line N
 * "arquivo.st"` que `--line-directives` já emite no `.cpp` gerado -- mais padrão/portável que
 * reconstruir este array, então `PlcCompiler` (F9.3) deve preferir parsear `#line` em vez de
 * depender deste struct. Mantido aqui só pra manter paridade de nome com a STruCpp caso um consumo
 * futuro precise do formato array. */
struct STLineMap {
    int st_line;
    int cpp_start;
    int cpp_end;
};

// =============================================================================
// Extraído de iec_repl.hpp: Value Display Helpers
// =============================================================================

inline const char* var_type_name(VarTypeTag type) {
    switch (type) {
        case VarTypeTag::BOOL:  return "BOOL";
        case VarTypeTag::SINT:  return "SINT";
        case VarTypeTag::INT:   return "INT";
        case VarTypeTag::DINT:  return "DINT";
        case VarTypeTag::LINT:  return "LINT";
        case VarTypeTag::USINT: return "USINT";
        case VarTypeTag::UINT:  return "UINT";
        case VarTypeTag::UDINT: return "UDINT";
        case VarTypeTag::ULINT: return "ULINT";
        case VarTypeTag::REAL:  return "REAL";
        case VarTypeTag::LREAL: return "LREAL";
        case VarTypeTag::BYTE:  return "BYTE";
        case VarTypeTag::WORD:  return "WORD";
        case VarTypeTag::DWORD: return "DWORD";
        case VarTypeTag::LWORD: return "LWORD";
        case VarTypeTag::TIME:  return "TIME";
        case VarTypeTag::STRING: return "STRING";
        default: return "OTHER";
    }
}

inline std::string var_value_to_string(VarTypeTag type, void* ptr) {
    using namespace strucpp;
    char buf[64];
    switch (type) {
        case VarTypeTag::BOOL:  return static_cast<IECVar<BOOL_t>*>(ptr)->get() ? "TRUE" : "FALSE";
        case VarTypeTag::SINT:  return std::to_string(static_cast<IECVar<SINT_t>*>(ptr)->get());
        case VarTypeTag::INT:   return std::to_string(static_cast<IECVar<INT_t>*>(ptr)->get());
        case VarTypeTag::DINT:  return std::to_string(static_cast<IECVar<DINT_t>*>(ptr)->get());
        case VarTypeTag::LINT:  return std::to_string(static_cast<IECVar<LINT_t>*>(ptr)->get());
        case VarTypeTag::USINT: return std::to_string(static_cast<IECVar<USINT_t>*>(ptr)->get());
        case VarTypeTag::UINT:  return std::to_string(static_cast<IECVar<UINT_t>*>(ptr)->get());
        case VarTypeTag::UDINT: return std::to_string(static_cast<IECVar<UDINT_t>*>(ptr)->get());
        case VarTypeTag::ULINT: return std::to_string(static_cast<IECVar<ULINT_t>*>(ptr)->get());
        case VarTypeTag::REAL:  std::snprintf(buf, sizeof(buf), "%.6g", static_cast<IECVar<REAL_t>*>(ptr)->get()); return buf;
        case VarTypeTag::LREAL: std::snprintf(buf, sizeof(buf), "%.10g", static_cast<IECVar<LREAL_t>*>(ptr)->get()); return buf;
        case VarTypeTag::BYTE:  std::snprintf(buf, sizeof(buf), "16#%02X", static_cast<IECVar<BYTE_t>*>(ptr)->get()); return buf;
        case VarTypeTag::WORD:  std::snprintf(buf, sizeof(buf), "16#%04X", static_cast<IECVar<WORD_t>*>(ptr)->get()); return buf;
        case VarTypeTag::DWORD: std::snprintf(buf, sizeof(buf), "16#%08X", static_cast<IECVar<DWORD_t>*>(ptr)->get()); return buf;
        case VarTypeTag::LWORD: std::snprintf(buf, sizeof(buf), "16#%016" PRIX64, static_cast<uint64_t>(static_cast<IECVar<LWORD_t>*>(ptr)->get())); return buf;
        case VarTypeTag::TIME: {
            int64_t ns = static_cast<IECVar<TIME_t>*>(ptr)->get();
            if (ns == 0) return "T#0s";
            std::string r = "T#";
            int64_t abs_ns = ns < 0 ? -ns : ns;
            if (ns < 0) r = "-T#";
            if (abs_ns >= 1000000000LL) { r += std::to_string(abs_ns / 1000000000LL) + "s"; abs_ns %= 1000000000LL; }
            if (abs_ns >= 1000000LL) { r += std::to_string(abs_ns / 1000000LL) + "ms"; abs_ns %= 1000000LL; }
            if (abs_ns >= 1000LL) { r += std::to_string(abs_ns / 1000LL) + "us"; abs_ns %= 1000LL; }
            if (abs_ns > 0) r += std::to_string(abs_ns) + "ns";
            return r;
        }
        case VarTypeTag::STRING: {
            const char* str_data = reinterpret_cast<const char*>(ptr);
            return std::string("'") + str_data + "'";
        }
        default: return "<?>";
    }
}

inline bool var_is_forced(VarTypeTag type, void* ptr) {
    using namespace strucpp;
    switch (type) {
        case VarTypeTag::BOOL:  return static_cast<IECVar<BOOL_t>*>(ptr)->is_forced();
        case VarTypeTag::SINT:  return static_cast<IECVar<SINT_t>*>(ptr)->is_forced();
        case VarTypeTag::INT:   return static_cast<IECVar<INT_t>*>(ptr)->is_forced();
        case VarTypeTag::DINT:  return static_cast<IECVar<DINT_t>*>(ptr)->is_forced();
        case VarTypeTag::LINT:  return static_cast<IECVar<LINT_t>*>(ptr)->is_forced();
        case VarTypeTag::USINT: return static_cast<IECVar<USINT_t>*>(ptr)->is_forced();
        case VarTypeTag::UINT:  return static_cast<IECVar<UINT_t>*>(ptr)->is_forced();
        case VarTypeTag::UDINT: return static_cast<IECVar<UDINT_t>*>(ptr)->is_forced();
        case VarTypeTag::ULINT: return static_cast<IECVar<ULINT_t>*>(ptr)->is_forced();
        case VarTypeTag::REAL:  return static_cast<IECVar<REAL_t>*>(ptr)->is_forced();
        case VarTypeTag::LREAL: return static_cast<IECVar<LREAL_t>*>(ptr)->is_forced();
        case VarTypeTag::BYTE:  return static_cast<IECVar<BYTE_t>*>(ptr)->is_forced();
        case VarTypeTag::WORD:  return static_cast<IECVar<WORD_t>*>(ptr)->is_forced();
        case VarTypeTag::DWORD: return static_cast<IECVar<DWORD_t>*>(ptr)->is_forced();
        case VarTypeTag::LWORD: return static_cast<IECVar<LWORD_t>*>(ptr)->is_forced();
        case VarTypeTag::TIME:  return static_cast<IECVar<TIME_t>*>(ptr)->is_forced();
        default: return false;
    }
}

inline bool var_set_value(VarTypeTag type, void* ptr, const std::string& val) {
    using namespace strucpp;
    try {
        switch (type) {
            case VarTypeTag::BOOL:
                if (val == "TRUE" || val == "true" || val == "1") { static_cast<IECVar<BOOL_t>*>(ptr)->set(true); return true; }
                if (val == "FALSE" || val == "false" || val == "0") { static_cast<IECVar<BOOL_t>*>(ptr)->set(false); return true; }
                return false;
            case VarTypeTag::SINT:  static_cast<IECVar<SINT_t>*>(ptr)->set(static_cast<SINT_t>(std::stoi(val))); return true;
            case VarTypeTag::INT:   static_cast<IECVar<INT_t>*>(ptr)->set(static_cast<INT_t>(std::stoi(val))); return true;
            case VarTypeTag::DINT:  static_cast<IECVar<DINT_t>*>(ptr)->set(static_cast<DINT_t>(std::stol(val))); return true;
            case VarTypeTag::LINT:  static_cast<IECVar<LINT_t>*>(ptr)->set(static_cast<LINT_t>(std::stoll(val))); return true;
            case VarTypeTag::USINT: static_cast<IECVar<USINT_t>*>(ptr)->set(static_cast<USINT_t>(std::stoul(val))); return true;
            case VarTypeTag::UINT:  static_cast<IECVar<UINT_t>*>(ptr)->set(static_cast<UINT_t>(std::stoul(val))); return true;
            case VarTypeTag::UDINT: static_cast<IECVar<UDINT_t>*>(ptr)->set(static_cast<UDINT_t>(std::stoul(val))); return true;
            case VarTypeTag::ULINT: static_cast<IECVar<ULINT_t>*>(ptr)->set(static_cast<ULINT_t>(std::stoull(val))); return true;
            case VarTypeTag::REAL:  static_cast<IECVar<REAL_t>*>(ptr)->set(std::stof(val)); return true;
            case VarTypeTag::LREAL: static_cast<IECVar<LREAL_t>*>(ptr)->set(std::stod(val)); return true;
            case VarTypeTag::BYTE:  static_cast<IECVar<BYTE_t>*>(ptr)->set(static_cast<BYTE_t>(std::stoul(val, nullptr, 0))); return true;
            case VarTypeTag::WORD:  static_cast<IECVar<WORD_t>*>(ptr)->set(static_cast<WORD_t>(std::stoul(val, nullptr, 0))); return true;
            case VarTypeTag::DWORD: static_cast<IECVar<DWORD_t>*>(ptr)->set(static_cast<DWORD_t>(std::stoul(val, nullptr, 0))); return true;
            case VarTypeTag::LWORD: static_cast<IECVar<LWORD_t>*>(ptr)->set(static_cast<LWORD_t>(std::stoull(val, nullptr, 0))); return true;
            case VarTypeTag::TIME:  static_cast<IECVar<TIME_t>*>(ptr)->set(static_cast<TIME_t>(std::stoll(val))); return true;
            case VarTypeTag::STRING: {
                std::string s = val;
                if (s.size() >= 2 && s.front() == '\'' && s.back() == '\'') s = s.substr(1, s.size() - 2);
                char* data_ptr = reinterpret_cast<char*>(ptr);
                uint16_t len = static_cast<uint16_t>(s.size() > 254 ? 254 : s.size());
                std::memcpy(data_ptr, s.c_str(), len);
                data_ptr[len] = '\0';
                return true;
            }
            default: return false;
        }
    } catch (...) { return false; }
}

inline bool var_force_value(VarTypeTag type, void* ptr, const std::string& val) {
    using namespace strucpp;
    try {
        switch (type) {
            case VarTypeTag::BOOL:
                if (val == "TRUE" || val == "true" || val == "1") { static_cast<IECVar<BOOL_t>*>(ptr)->force(true); return true; }
                if (val == "FALSE" || val == "false" || val == "0") { static_cast<IECVar<BOOL_t>*>(ptr)->force(false); return true; }
                return false;
            case VarTypeTag::SINT:  static_cast<IECVar<SINT_t>*>(ptr)->force(static_cast<SINT_t>(std::stoi(val))); return true;
            case VarTypeTag::INT:   static_cast<IECVar<INT_t>*>(ptr)->force(static_cast<INT_t>(std::stoi(val))); return true;
            case VarTypeTag::DINT:  static_cast<IECVar<DINT_t>*>(ptr)->force(static_cast<DINT_t>(std::stol(val))); return true;
            case VarTypeTag::LINT:  static_cast<IECVar<LINT_t>*>(ptr)->force(static_cast<LINT_t>(std::stoll(val))); return true;
            case VarTypeTag::USINT: static_cast<IECVar<USINT_t>*>(ptr)->force(static_cast<USINT_t>(std::stoul(val))); return true;
            case VarTypeTag::UINT:  static_cast<IECVar<UINT_t>*>(ptr)->force(static_cast<UINT_t>(std::stoul(val))); return true;
            case VarTypeTag::UDINT: static_cast<IECVar<UDINT_t>*>(ptr)->force(static_cast<UDINT_t>(std::stoul(val))); return true;
            case VarTypeTag::ULINT: static_cast<IECVar<ULINT_t>*>(ptr)->force(static_cast<ULINT_t>(std::stoull(val))); return true;
            case VarTypeTag::REAL:  static_cast<IECVar<REAL_t>*>(ptr)->force(std::stof(val)); return true;
            case VarTypeTag::LREAL: static_cast<IECVar<LREAL_t>*>(ptr)->force(std::stod(val)); return true;
            case VarTypeTag::BYTE:  static_cast<IECVar<BYTE_t>*>(ptr)->force(static_cast<BYTE_t>(std::stoul(val, nullptr, 0))); return true;
            case VarTypeTag::WORD:  static_cast<IECVar<WORD_t>*>(ptr)->force(static_cast<WORD_t>(std::stoul(val, nullptr, 0))); return true;
            case VarTypeTag::DWORD: static_cast<IECVar<DWORD_t>*>(ptr)->force(static_cast<DWORD_t>(std::stoul(val, nullptr, 0))); return true;
            case VarTypeTag::LWORD: static_cast<IECVar<LWORD_t>*>(ptr)->force(static_cast<LWORD_t>(std::stoull(val, nullptr, 0))); return true;
            case VarTypeTag::TIME:  static_cast<IECVar<TIME_t>*>(ptr)->force(static_cast<TIME_t>(std::stoll(val))); return true;
            default: return false;
        }
    } catch (...) { return false; }
}

inline void var_unforce(VarTypeTag type, void* ptr) {
    using namespace strucpp;
    switch (type) {
        case VarTypeTag::BOOL:  static_cast<IECVar<BOOL_t>*>(ptr)->unforce(); break;
        case VarTypeTag::SINT:  static_cast<IECVar<SINT_t>*>(ptr)->unforce(); break;
        case VarTypeTag::INT:   static_cast<IECVar<INT_t>*>(ptr)->unforce(); break;
        case VarTypeTag::DINT:  static_cast<IECVar<DINT_t>*>(ptr)->unforce(); break;
        case VarTypeTag::LINT:  static_cast<IECVar<LINT_t>*>(ptr)->unforce(); break;
        case VarTypeTag::USINT: static_cast<IECVar<USINT_t>*>(ptr)->unforce(); break;
        case VarTypeTag::UINT:  static_cast<IECVar<UINT_t>*>(ptr)->unforce(); break;
        case VarTypeTag::UDINT: static_cast<IECVar<UDINT_t>*>(ptr)->unforce(); break;
        case VarTypeTag::ULINT: static_cast<IECVar<ULINT_t>*>(ptr)->unforce(); break;
        case VarTypeTag::REAL:  static_cast<IECVar<REAL_t>*>(ptr)->unforce(); break;
        case VarTypeTag::LREAL: static_cast<IECVar<LREAL_t>*>(ptr)->unforce(); break;
        case VarTypeTag::BYTE:  static_cast<IECVar<BYTE_t>*>(ptr)->unforce(); break;
        case VarTypeTag::WORD:  static_cast<IECVar<WORD_t>*>(ptr)->unforce(); break;
        case VarTypeTag::DWORD: static_cast<IECVar<DWORD_t>*>(ptr)->unforce(); break;
        case VarTypeTag::LWORD: static_cast<IECVar<LWORD_t>*>(ptr)->unforce(); break;
        case VarTypeTag::TIME:  static_cast<IECVar<TIME_t>*>(ptr)->unforce(); break;
        default: break;
    }
}

// =============================================================================
// Extraído de iec_repl.hpp: Lookup Helpers
// =============================================================================

inline ProgramDescriptor* find_program(ProgramDescriptor* programs, size_t count, const std::string& name) {
    for (size_t i = 0; i < count; ++i) {
        if (name == programs[i].name) return &programs[i];
    }
    return nullptr;
}

inline VarDescriptor* find_var(ProgramDescriptor* prog, const std::string& name) {
    for (size_t i = 0; i < prog->var_count; ++i) {
        if (name == prog->vars[i].name) return &prog->vars[i];
    }
    return nullptr;
}

inline bool parse_qualified_name(const std::string& input, std::string& prog_name, std::string& var_name) {
    auto dot = input.find('.');
    if (dot == std::string::npos || dot == 0 || dot == input.size() - 1) return false;
    prog_name = input.substr(0, dot);
    var_name = input.substr(dot + 1);
    return true;
}

// =============================================================================
// Extraído de iec_repl.hpp: Shared Command Processor (get/set/force/unforce/list) --
// NUNCA toca __CURRENT_TIME_NS nem chama instance->run() -- só lê/escreve ponteiro de variável.
// Isso é o que garante (testado em PlcScanSessionTest) que inspecionar/forçar uma variável
// enquanto a instância está parada nunca avança o programa.
// =============================================================================

inline std::string process_command(
    const std::string& cmd_line,
    ProgramDescriptor* programs,
    size_t program_count)
{
    std::string line = cmd_line;
    size_t start = line.find_first_not_of(" \t\r\n");
    if (start == std::string::npos) return "ERR: Empty command";
    size_t end = line.find_last_not_of(" \t\r\n");
    line = line.substr(start, end - start + 1);
    if (line.empty()) return "ERR: Empty command";

    size_t sp = line.find(' ');
    std::string cmd = (sp == std::string::npos) ? line : line.substr(0, sp);
    std::string args_str = (sp == std::string::npos) ? "" : line.substr(sp + 1);
    size_t astart = args_str.find_first_not_of(" \t");
    if (astart != std::string::npos) args_str = args_str.substr(astart);
    else args_str.clear();

    if (cmd == "get") {
        if (args_str.empty()) return "ERR: Usage: get <program>.<var>";
        std::string pn, vn;
        if (!parse_qualified_name(args_str, pn, vn)) return "ERR: Invalid format. Use: program.variable";
        auto* prog = find_program(programs, program_count, pn);
        if (!prog) return "ERR: Unknown program: " + pn;
        auto* var = find_var(prog, vn);
        if (!var) return "ERR: Unknown variable: " + vn + " in " + pn;
        bool forced = var_is_forced(var->type, var->var_ptr);
        std::string val = var_value_to_string(var->type, var->var_ptr);
        return std::string("OK: ") + pn + "." + vn + " : " +
            var_type_name(var->type) + " = " + val + (forced ? " [FORCED]" : "");
    }

    if (cmd == "set") {
        size_t vsp = args_str.find(' ');
        if (vsp == std::string::npos) return "ERR: Usage: set <program>.<var> <value>";
        std::string qname = args_str.substr(0, vsp);
        std::string val = args_str.substr(vsp + 1);
        size_t vs = val.find_first_not_of(" \t");
        if (vs != std::string::npos) val = val.substr(vs);
        std::string pn, vn;
        if (!parse_qualified_name(qname, pn, vn)) return "ERR: Invalid format. Use: program.variable";
        auto* prog = find_program(programs, program_count, pn);
        if (!prog) return "ERR: Unknown program: " + pn;
        auto* var = find_var(prog, vn);
        if (!var) return "ERR: Unknown variable: " + vn + " in " + pn;
        if (var_set_value(var->type, var->var_ptr, val)) {
            return std::string("OK: ") + pn + "." + vn + " = " + var_value_to_string(var->type, var->var_ptr);
        }
        return std::string("ERR: Invalid value for ") + var_type_name(var->type) + ": " + val;
    }

    if (cmd == "force") {
        size_t vsp = args_str.find(' ');
        if (vsp == std::string::npos) return "ERR: Usage: force <program>.<var> <value>";
        std::string qname = args_str.substr(0, vsp);
        std::string val = args_str.substr(vsp + 1);
        size_t vs = val.find_first_not_of(" \t");
        if (vs != std::string::npos) val = val.substr(vs);
        std::string pn, vn;
        if (!parse_qualified_name(qname, pn, vn)) return "ERR: Invalid format. Use: program.variable";
        auto* prog = find_program(programs, program_count, pn);
        if (!prog) return "ERR: Unknown program: " + pn;
        auto* var = find_var(prog, vn);
        if (!var) return "ERR: Unknown variable: " + vn + " in " + pn;
        if (var_force_value(var->type, var->var_ptr, val)) {
            return std::string("OK: ") + pn + "." + vn + " FORCED = " + var_value_to_string(var->type, var->var_ptr);
        }
        return std::string("ERR: Invalid value for ") + var_type_name(var->type) + ": " + val;
    }

    if (cmd == "unforce") {
        if (args_str.empty()) return "ERR: Usage: unforce <program>.<var>";
        std::string pn, vn;
        if (!parse_qualified_name(args_str, pn, vn)) return "ERR: Invalid format. Use: program.variable";
        auto* prog = find_program(programs, program_count, pn);
        if (!prog) return "ERR: Unknown program: " + pn;
        auto* var = find_var(prog, vn);
        if (!var) return "ERR: Unknown variable: " + vn + " in " + pn;
        var_unforce(var->type, var->var_ptr);
        return std::string("OK: ") + pn + "." + vn + " unforced. Value: " + var_value_to_string(var->type, var->var_ptr);
    }

    if (cmd == "list_vars") {
        std::string result = "OK:";
        for (size_t p = 0; p < program_count; ++p) {
            if (!args_str.empty() && args_str != programs[p].name) continue;
            for (size_t i = 0; i < programs[p].var_count; ++i) {
                auto& v = programs[p].vars[i];
                bool forced = var_is_forced(v.type, v.var_ptr);
                result += std::string("\n") + programs[p].name + "." + v.name +
                    " : " + var_type_name(v.type) + " = " +
                    var_value_to_string(v.type, v.var_ptr) +
                    (forced ? " [FORCED]" : "");
            }
        }
        return result;
    }

    return "ERR: Unknown command: " + cmd;
}

} // namespace lasecsimul::plc
