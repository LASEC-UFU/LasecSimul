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

enum class BlockKind { None, Input, Output, Unsupported };

/** Divide `nome1, nome2 : TIPO [:= inicial];` (sem o `;` final) em nomes + tipo. Lança em formato
 * inesperado -- melhor falhar alto e claro do que exportar uma interface errada. */
void parseDeclarationLine(const std::string& declaration, BlockKind kind, std::vector<PlcParsedVariable>& out) {
    const size_t colon = declaration.find(':');
    if (colon == std::string::npos) {
        throw PlcInterfaceParseError("declaracao sem ':' dentro de VAR_INPUT/VAR_OUTPUT: " + declaration);
    }
    const std::string namesPart = trim(declaration.substr(0, colon));
    std::string typePart = trim(declaration.substr(colon + 1));
    const size_t assign = typePart.find(":=");
    if (assign != std::string::npos) typePart = trim(typePart.substr(0, assign));
    if (namesPart.empty() || typePart.empty()) {
        throw PlcInterfaceParseError("declaracao malformada dentro de VAR_INPUT/VAR_OUTPUT: " + declaration);
    }

    std::istringstream names(namesPart);
    std::string name;
    while (std::getline(names, name, ',')) {
        name = trim(name);
        if (name.empty()) continue;
        out.push_back({name, typePart, kind == BlockKind::Input ? "input" : "output"});
    }
}

} // namespace

PlcParsedInterface parsePlcProgramInterface(const std::string& stSource) {
    PlcParsedInterface result;
    BlockKind currentBlock = BlockKind::None;
    std::string pendingDeclaration;

    const std::string withoutComments = stripAllComments(stSource);
    std::istringstream stream(withoutComments);
    std::string rawLine;
    while (std::getline(stream, rawLine)) {
        const std::string line = trim(rawLine);
        if (line.empty()) continue;
        const std::string upper = toUpper(line);

        if (result.programName.empty() && upper.rfind("PROGRAM", 0) == 0) {
            std::istringstream tokenStream(line);
            std::string keyword;
            std::string name;
            tokenStream >> keyword >> name;
            if (name.empty()) throw PlcInterfaceParseError("PROGRAM sem nome: " + line);
            result.programName = name;
            continue;
        }

        if (currentBlock == BlockKind::None) {
            if (upper.rfind("VAR_INPUT", 0) == 0) { currentBlock = BlockKind::Input; continue; }
            if (upper.rfind("VAR_OUTPUT", 0) == 0) { currentBlock = BlockKind::Output; continue; }
            // VAR (interno), VAR_IN_OUT, VAR_GLOBAL, etc.: reconhecidos so o suficiente pra pular
            // o bloco corretamente ate o END_VAR correspondente -- nunca exportados nesta rodada
            // (ver doc-comment do header).
            if (upper.rfind("VAR", 0) == 0) { currentBlock = BlockKind::Unsupported; continue; }
            continue; // fora de qualquer bloco VAR_*, corpo do programa etc. -- ignorado
        }

        if (upper == "END_VAR") {
            currentBlock = BlockKind::None;
            continue;
        }

        if (currentBlock == BlockKind::Unsupported) continue; // conteudo de bloco nao exportado, ignorado

        // Declaracoes podem terminar com ';' -- suporta multiplas declaracoes numa linha e
        // declaracao continuando em varias linhas ate o ';' (concatena ate achar um).
        pendingDeclaration += (pendingDeclaration.empty() ? "" : " ") + line;
        if (pendingDeclaration.back() != ';') continue;
        pendingDeclaration.pop_back(); // remove o ';'
        parseDeclarationLine(pendingDeclaration, currentBlock, result.variables);
        pendingDeclaration.clear();
    }

    if (currentBlock != BlockKind::None) {
        throw PlcInterfaceParseError("VAR_INPUT/VAR_OUTPUT sem END_VAR correspondente");
    }
    if (result.programName.empty()) {
        throw PlcInterfaceParseError("nenhum PROGRAM encontrado no fonte ST");
    }
    return result;
}

} // namespace lasecsimul::plc
