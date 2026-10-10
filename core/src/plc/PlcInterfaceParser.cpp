#include "PlcInterfaceParser.hpp"

#include <algorithm>
#include <cctype>
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
void parseDeclarationLine(const std::string& declaration, BlockKind kind, std::vector<PlcParsedVariable>& out) {
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
                       kind == BlockKind::Input ? "input" : kind == BlockKind::Output ? "output" : "local"});
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

} // namespace

PlcParsedInterface parsePlcProgramInterface(const std::string& stSource) {
    PlcParsedInterface result;
    BlockKind currentBlock = BlockKind::None;
    bool insideProgram = false;
    std::string pendingDeclaration;

    const std::string withoutComments = stripAllComments(stSource);
    std::istringstream stream(withoutComments);
    std::string rawLine;
    while (std::getline(stream, rawLine)) {
        const std::string line = trim(rawLine);
        if (line.empty()) continue;
        const std::string upper = toUpper(line);
        const std::string word = firstWord(upper);

        if (currentBlock == BlockKind::None) {
            if (!insideProgram && result.programName.empty() && word == "PROGRAM") {
                std::istringstream tokenStream(line);
                std::string keyword;
                std::string name;
                tokenStream >> keyword >> name;
                if (name.empty()) throw PlcInterfaceParseError("PROGRAM sem nome: " + line);
                result.programName = name;
                insideProgram = true;
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
                continue;
            }
            if (word.rfind("VAR_", 0) == 0) { currentBlock = BlockKind::Unsupported; continue; }
            continue; // corpo de POU, CONFIGURATION etc. -- ignorado
        }

        if (word == "END_VAR") {
            currentBlock = BlockKind::None;
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
                                 currentBlock == BlockKind::Local ? result.locals : result.variables);
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
