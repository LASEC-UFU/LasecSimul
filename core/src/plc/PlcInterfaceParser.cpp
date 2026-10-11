#include "PlcInterfaceParser.hpp"

#include <algorithm>
#include <cctype>
#include <limits>
#include <regex>
#include <sstream>

namespace lasecsimul::plc {

namespace {

std::string trim(const std::string& text) {
    const size_t start = text.find_first_not_of(" \t\r\n");
    if (start == std::string::npos) return {};
    const size_t end = text.find_last_not_of(" \t\r\n");
    return text.substr(start, end - start + 1);
}

std::string toUpper(const std::string& text) {
    std::string result = text;
    std::transform(result.begin(), result.end(), result.begin(),
                    [](unsigned char c) { return static_cast<char>(std::toupper(c)); });
    return result;
}

/** Remove TODOS os comentários `(* ... *)` do texto inteiro, incluindo comentários que atravessam
 * várias linhas -- acha real (2026-08-20): uma primeira versão só tratava comentário de uma
 * linha só; a própria fixture `hello.st` tem um comentário de cabeçalho de 3 linhas cujo texto
 * menciona a palavra "PROGRAM" (descrevendo o propósito do arquivo), e a versão anterior
 * confundia essa linha de comentário com uma declaração `PROGRAM` de verdade. Substitui cada
 * comentário por um espaço (nunca concatena tokens de lados opostos do comentário) preservando a
 * contagem de quebras de linha do texto original (mantém `\n` internos), já que declarações após
 * um comentário multi-linha continuam em linhas separadas. Comentário não fechado (`(*` sem `*)`
 * correspondente) remove até o fim do texto -- mesmo tratamento "melhor falhar removendo demais do
 * que interpretar lixo como código" já usado no resto deste parser. */
std::string stripAllComments(const std::string& source) {
    std::string result;
    result.reserve(source.size());
    size_t pos = 0;
    while (pos < source.size()) {
        const size_t start = source.find("(*", pos);
        if (start == std::string::npos) {
            result += source.substr(pos);
            break;
        }
        result += source.substr(pos, start - pos);
        const size_t end = source.find("*)", start + 2);
        const size_t commentEnd = (end == std::string::npos) ? source.size() : end + 2;
        for (size_t i = start; i < commentEnd; ++i) {
            if (source[i] == '\n') result += '\n'; // preserva quebras de linha dentro do comentario
        }
        result += ' ';
        pos = commentEnd;
    }
    return result;
}

enum class BlockKind { None, Input, Output, Local, Unsupported };

/** Divide `nome1, nome2 : TIPO [:= inicial];` (sem o `;` final) em nomes + tipo. Lança em formato
 * inesperado -- melhor falhar alto e claro do que exportar uma interface errada. */
void parseDeclarationLine(const std::string& declaration, BlockKind kind, std::vector<PlcParsedVariable>& out,
                          bool retain = false) {
    // Locais só servem para monitorar: uma forma que este leitor não entende (AT %IX0.0, ARRAY com
    // inicializador...) fica fora da lista em vez de derrubar a compilação.
    const bool lenient = kind == BlockKind::Local;
    const size_t colon = declaration.find(':');
    if (colon == std::string::npos) {
        if (lenient) return;
        throw PlcInterfaceParseError("declaracao sem ':' dentro de VAR_INPUT/VAR_OUTPUT: " + declaration);
    }
    const std::string namesPart = trim(declaration.substr(0, colon));
    std::string typePart = trim(declaration.substr(colon + 1));
    const size_t assign = typePart.find(":=");
    if (assign != std::string::npos) typePart = trim(typePart.substr(0, assign));
    if (namesPart.empty() || typePart.empty()) {
        if (lenient) return;
        throw PlcInterfaceParseError("declaracao malformada dentro de VAR_INPUT/VAR_OUTPUT: " + declaration);
    }

    std::istringstream names(namesPart);
    std::string name;
    while (std::getline(names, name, ',')) {
        name = trim(name);
        if (name.empty()) continue;
        if (lenient && name.find_first_of(" \t") != std::string::npos) continue;
        out.push_back({name, typePart,
                       kind == BlockKind::Input ? "input" : kind == BlockKind::Output ? "output" : "local",
                       retain});
    }
}

/** Primeira palavra da linha em maiúsculas (letras, dígitos e `_`): `VAR` não casa com `VARIAVEL`. */
std::string firstWord(const std::string& upperLine) {
    size_t end = 0;
    while (end < upperLine.size() &&
           (std::isalnum(static_cast<unsigned char>(upperLine[end])) || upperLine[end] == '_')) {
        ++end;
    }
    return upperLine.substr(0, end);
}

std::vector<PlcParsedType> parseDataTypes(const std::string& source) {
    std::vector<PlcParsedType> types;
    static const std::regex functionBlockPattern(
        R"re(\bFUNCTION_BLOCK\s+([A-Za-z_][A-Za-z0-9_]*)\b([\s\S]*?)\bEND_FUNCTION_BLOCK\b)re",
        std::regex_constants::icase);
    for (std::sregex_iterator it(source.begin(), source.end(), functionBlockPattern), end; it != end; ++it) {
        PlcParsedType type;
        type.name = (*it)[1].str();
        type.kind = "struct";
        std::istringstream body((*it)[2].str());
        std::string rawLine;
        BlockKind block = BlockKind::None;
        std::string pending;
        while (std::getline(body, rawLine)) {
            const std::string line = trim(rawLine);
            if (line.empty()) continue;
            const std::string word = firstWord(toUpper(line));
            if (block == BlockKind::None) {
                if (word == "VAR_INPUT") block = BlockKind::Input;
                else if (word == "VAR_OUTPUT") block = BlockKind::Output;
                else if (word == "VAR") block = BlockKind::Local;
                else if (word == "VAR_IN_OUT") block = BlockKind::Unsupported;
                continue;
            }
            if (word == "END_VAR") { block = BlockKind::None; pending.clear(); continue; }
            if (block == BlockKind::Unsupported) continue;
            pending += (pending.empty() ? "" : " ") + line;
            size_t semicolon = 0;
            while ((semicolon = pending.find(';')) != std::string::npos) {
                const std::string declaration = trim(pending.substr(0, semicolon));
                pending = trim(pending.substr(semicolon + 1));
                if (declaration.empty()) continue;
                std::vector<PlcParsedVariable> fields;
                parseDeclarationLine(declaration, BlockKind::Local, fields);
                for (const auto& field : fields) type.fields.push_back({field.name, field.iecType});
            }
        }
        if (!type.fields.empty()) types.push_back(std::move(type));
    }

    static const std::regex structPattern(
        R"re(\bTYPE\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*STRUCT\b([\s\S]*?)\bEND_STRUCT\s*;?\s*END_TYPE\b)re",
        std::regex_constants::icase);
    for (std::sregex_iterator it(source.begin(), source.end(), structPattern), end; it != end; ++it) {
        PlcParsedType type;
        type.name = (*it)[1].str();
        type.kind = "struct";
        const std::string body = (*it)[2].str();
        static const std::regex fieldPattern(R"re(([A-Za-z_][A-Za-z0-9_]*(?:\s*,\s*[A-Za-z_][A-Za-z0-9_]*)*)\s*:\s*([^;]+);)re");
        for (std::sregex_iterator field(body.begin(), body.end(), fieldPattern), fieldEnd; field != fieldEnd; ++field) {
            std::vector<PlcParsedVariable> parsed;
            parseDeclarationLine((*field)[1].str() + " : " + (*field)[2].str(), BlockKind::Local, parsed);
            for (const auto& variable : parsed) type.fields.push_back({variable.name, variable.iecType});
        }
        types.push_back(std::move(type));
    }

    static const std::regex typePattern(
        R"re(\bTYPE\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([\s\S]*?)\bEND_TYPE\b)re",
        std::regex_constants::icase);
    for (std::sregex_iterator it(source.begin(), source.end(), typePattern), end; it != end; ++it) {
        const std::string name = (*it)[1].str();
        if (std::any_of(types.begin(), types.end(), [&](const PlcParsedType& type) { return toUpper(type.name) == toUpper(name); })) continue;
        std::string definition = trim((*it)[2].str());
        if (!definition.empty() && definition.back() == ';') definition.pop_back();
        definition = trim(definition);
        if (definition.empty() || definition.front() == '(') continue; // enum member types need a dedicated VarTypeTag.

        PlcParsedType type;
        type.name = name;
        static const std::regex arrayPattern(R"re(^ARRAY\s*\[([^\]]+)\]\s*OF\s*(.+)$)re", std::regex_constants::icase);
        std::smatch arrayMatch;
        if (std::regex_match(definition, arrayMatch, arrayPattern)) {
            type.kind = "array";
            type.baseType = trim(arrayMatch[2].str());
            std::istringstream bounds(arrayMatch[1].str());
            std::string bound;
            bool valid = true;
            while (std::getline(bounds, bound, ',')) {
                const size_t separator = bound.find("..");
                if (separator == std::string::npos) { valid = false; break; }
                try {
                    const int64_t lower = std::stoll(trim(bound.substr(0, separator)));
                    const int64_t upper = std::stoll(trim(bound.substr(separator + 2)));
                    if (upper < lower) { valid = false; break; }
                    type.dimensions.emplace_back(lower, upper);
                } catch (...) { valid = false; break; }
            }
            if (!valid || type.dimensions.empty()) continue;
        } else {
            type.kind = "alias";
            type.baseType = definition;
        }
        types.push_back(std::move(type));
    }
    return types;
}

void parseConfigurationMetadata(const std::string& source, PlcParsedInterface& result) {
    static const std::regex configurationPattern(
        R"re(\bCONFIGURATION\s+([A-Za-z_][A-Za-z0-9_]*)\b([\s\S]*?)\bEND_CONFIGURATION\b)re",
        std::regex_constants::icase);
    std::smatch configuration;
    if (!std::regex_search(source, configuration, configurationPattern)) return;
    result.configurationName = configuration[1].str();
    const std::string body = configuration[2].str();

    static const std::regex taskPattern(
        R"re(\bTASK\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*INTERVAL\s*:=\s*T#([0-9]+)\s*(ns|us|ms|s|m|h)\s*,\s*PRIORITY\s*:=\s*(-?[0-9]+)\s*\)\s*;)re",
        std::regex_constants::icase);
    for (std::sregex_iterator it(body.begin(), body.end(), taskPattern), end; it != end; ++it) {
        int64_t multiplier = 1;
        const std::string unit = toUpper((*it)[3].str());
        if (unit == "US") multiplier = 1'000;
        else if (unit == "MS") multiplier = 1'000'000;
        else if (unit == "S") multiplier = 1'000'000'000;
        else if (unit == "M") multiplier = 60'000'000'000LL;
        else if (unit == "H") multiplier = 3'600'000'000'000LL;
        try {
            const int64_t amount = std::stoll((*it)[2].str());
            const int64_t priority = std::stoll((*it)[4].str());
            if (amount > std::numeric_limits<int64_t>::max() / multiplier ||
                priority < std::numeric_limits<int32_t>::min() || priority > std::numeric_limits<int32_t>::max()) continue;
            result.tasks.push_back({(*it)[1].str(), amount * multiplier, static_cast<int32_t>(priority)});
        } catch (...) { /* malformed task is diagnosed by STruCpp; omit incomplete metadata */ }
    }

    static const std::regex eventTaskPattern(
        R"re(\bTASK\s+([A-Za-z_][A-Za-z0-9_]*)\s*\(\s*SINGLE\s*:=\s*([A-Za-z_][A-Za-z0-9_]*)\s*,\s*PRIORITY\s*:=\s*(-?[0-9]+)\s*\)\s*;)re",
        std::regex_constants::icase);
    for (std::sregex_iterator it(body.begin(), body.end(), eventTaskPattern), end; it != end; ++it) {
        try {
            const int64_t priority = std::stoll((*it)[3].str());
            if (priority < std::numeric_limits<int32_t>::min() || priority > std::numeric_limits<int32_t>::max()) continue;
            result.tasks.push_back({(*it)[1].str(), 0, static_cast<int32_t>(priority), (*it)[2].str()});
        } catch (...) { /* malformed task is diagnosed by STruCpp; omit incomplete metadata */ }
    }

    static const std::regex instancePattern(
        R"re(\bPROGRAM\s+([A-Za-z_][A-Za-z0-9_]*)\s+WITH\s+([A-Za-z_][A-Za-z0-9_]*)\s*:\s*([A-Za-z_][A-Za-z0-9_]*)\s*;)re",
        std::regex_constants::icase);
    for (std::sregex_iterator it(body.begin(), body.end(), instancePattern), end; it != end; ++it) {
        result.programInstances.push_back({(*it)[1].str(), (*it)[2].str(), (*it)[3].str()});
    }
}

} // namespace

PlcParsedInterface parsePlcProgramInterface(const std::string& stSource, const std::string& requestedProgramName) {
    PlcParsedInterface result;
    BlockKind currentBlock = BlockKind::None;
    bool insideProgram = false;
    bool currentBlockRetain = false;
    std::string pendingDeclaration;

    const std::string withoutComments = stripAllComments(stSource);
    result.dataTypes = parseDataTypes(withoutComments);
    parseConfigurationMetadata(withoutComments, result);
    std::istringstream stream(withoutComments);
    std::string rawLine;
    while (std::getline(stream, rawLine)) {
        const std::string line = trim(rawLine);
        if (line.empty()) continue;
        const std::string upper = toUpper(line);
        const std::string word = firstWord(upper);

        if (currentBlock == BlockKind::None) {
            if (!insideProgram && word == "PROGRAM") {
                std::istringstream tokenStream(line);
                std::string keyword;
                std::string name;
                tokenStream >> keyword >> name;
                if (name.empty()) throw PlcInterfaceParseError("PROGRAM sem nome: " + line);
                if (result.programName.empty() &&
                    (requestedProgramName.empty() || toUpper(name) == toUpper(requestedProgramName))) {
                    result.programName = name;
                    insideProgram = true;
                }
                continue;
            }
            if (word == "END_PROGRAM") { insideProgram = false; continue; }
            // Blocos de FUNCTION/FUNCTION_BLOCK e do próprio PROGRAM que não viram interface
            // (VAR_IN_OUT, VAR_TEMP, VAR_EXTERNAL, VAR CONSTANT...) são reconhecidos só para pular
            // até o END_VAR certo.
            if (word == "VAR_INPUT") { currentBlock = insideProgram ? BlockKind::Input : BlockKind::Unsupported; continue; }
            if (word == "VAR_OUTPUT") { currentBlock = insideProgram ? BlockKind::Output : BlockKind::Unsupported; continue; }
            if (word == "VAR") {
                const bool constant = upper.find("CONSTANT") != std::string::npos;
                currentBlock = insideProgram && !constant ? BlockKind::Local : BlockKind::Unsupported;
                currentBlockRetain = insideProgram && !constant && upper.find("RETAIN") != std::string::npos;
                continue;
            }
            if (word.rfind("VAR_", 0) == 0) { currentBlock = BlockKind::Unsupported; continue; }
            continue; // corpo de POU, CONFIGURATION etc. -- ignorado
        }

        if (word == "END_VAR") {
            currentBlock = BlockKind::None;
            currentBlockRetain = false;
            pendingDeclaration.clear();
            continue;
        }

        if (currentBlock == BlockKind::Unsupported) continue; // conteudo de bloco nao exportado, ignorado

        // Uma declaracao termina em ';': varias numa linha ou uma continuando em varias linhas.
        pendingDeclaration += (pendingDeclaration.empty() ? "" : " ") + line;
        size_t semicolon = 0;
        while ((semicolon = pendingDeclaration.find(';')) != std::string::npos) {
            const std::string declaration = trim(pendingDeclaration.substr(0, semicolon));
            pendingDeclaration = trim(pendingDeclaration.substr(semicolon + 1));
            if (declaration.empty()) continue;
            parseDeclarationLine(declaration, currentBlock,
                                 currentBlock == BlockKind::Local ? result.locals : result.variables,
                                 currentBlockRetain);
        }
    }

    if (currentBlock != BlockKind::None) {
        throw PlcInterfaceParseError("bloco VAR sem END_VAR correspondente");
    }
    if (result.programName.empty()) {
        throw PlcInterfaceParseError("nenhum PROGRAM encontrado no fonte ST");
    }
    return result;
}

} // namespace lasecsimul::plc
