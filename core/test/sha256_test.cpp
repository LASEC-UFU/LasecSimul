// Vetores de teste oficiais do NIST (FIPS 180-4) -- prova que a implementação autocontida
// (`lasecsimul::Sha256`, usada por `PluginLoader::verifyChecksum`) está correta antes de confiar
// nela pra rejeitar/aceitar um binário de plugin de verdade.
#include <cstdio>
#include <cstring>
#include "lasecsimul/Sha256.hpp"

using namespace lasecsimul;

namespace {

int failures = 0;
#define CHECK_EQ(actual, expected, msg) \
    do { \
        if ((actual) != (expected)) { \
            std::fprintf(stderr, "  FALHOU: %s -- esperado '%s', obtido '%s'\n", msg, \
                         std::string(expected).c_str(), std::string(actual).c_str()); \
            failures++; \
        } else { \
            std::fprintf(stderr, "  OK: %s\n", msg); \
        } \
    } while (false)

std::string hashOf(const std::string& input) {
    Sha256 hasher;
    hasher.update(reinterpret_cast<const uint8_t*>(input.data()), input.size());
    return hasher.finalizeHex();
}

} // namespace

int main() {
    std::fprintf(stderr, "=== Sha256Test ===\n");

    CHECK_EQ(hashOf(""), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
             "SHA-256('') == vetor NIST vazio");
    CHECK_EQ(hashOf("abc"), "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
             "SHA-256('abc') == vetor NIST FIPS 180-4");
    CHECK_EQ(hashOf("abcdbcdecdefdefgefghfghighijhijkijkljklmklmnlmnomnopnopq"),
             "248d6a61d20638b8e5c026930c3e6039a33ce45964ff2167f6ecedd419db06c1",
             "SHA-256(56 bytes, cruza o padding de um único bloco) == vetor NIST");

    // Mensagem longa o bastante pra cruzar múltiplos blocos de 64 bytes via update() em pedaços
    // pequenos -- prova que o buffer interno acumula corretamente entre chamadas, não só quando
    // tudo cabe numa call só (caso real: PluginLoader::verifyChecksum lê o arquivo em blocos de 64KB).
    {
        Sha256 hasher;
        const std::string chunk(37, 'a'); // tamanho que não divide 64 -- força acúmulo entre calls
        for (int i = 0; i < 100; ++i) hasher.update(reinterpret_cast<const uint8_t*>(chunk.data()), chunk.size());
        const std::string incremental = hasher.finalizeHex();

        const std::string wholeInput(37 * 100, 'a');
        const std::string oneShot = hashOf(wholeInput);
        CHECK_EQ(incremental, oneShot, "update() em pedaços pequenos == update() de uma vez só (mesmo conteúdo)");
    }

    // reset() permite reutilizar a mesma instância pra um segundo hash independente.
    {
        Sha256 hasher;
        hasher.update(reinterpret_cast<const uint8_t*>("abc"), 3);
        (void)hasher.finalizeHex();
        hasher.reset();
        hasher.update(reinterpret_cast<const uint8_t*>(""), 0);
        CHECK_EQ(hasher.finalizeHex(), "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
                 "reset() permite recomeçar um novo hash na mesma instância");
    }

    if (failures == 0) {
        std::fprintf(stderr, "\nTodos os testes passaram.\n");
        return 0;
    }
    std::fprintf(stderr, "\n%d teste(s) FALHARAM.\n", failures);
    return 1;
}
