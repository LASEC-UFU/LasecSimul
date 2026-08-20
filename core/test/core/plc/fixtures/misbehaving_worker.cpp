/**
 * Worker de teste "mal-comportado" pro PlcRuntimeTest (F9.4) -- nao ha construcao ST que produza
 * crash/resposta malformada/requestId errado de forma deterministica e nao-racy, entao este
 * executavel escrito a mao simula esses modos via argv[1], mesmo raciocinio que F8 usou trechos
 * inline de Python (`os._exit(23)`) pra testar caminhos de falha do PythonRuntime.
 *
 * Modo selecionado via variavel de ambiente `LASECSIMUL_PLC_TEST_MISBEHAVE_MODE`, nao argv --
 * `PlcRuntime`/`Process::start()` (PlcRuntime.cpp) spawna `nativeBinaryRef` como um caminho de
 * executavel puro, sem suporte a argumentos extra (nenhum artefato real de `PlcCompiler` precisa
 * disso), entao o teste passa o modo por ambiente do processo pai em vez de inventar um mecanismo
 * de CLI só pra isto.
 *
 * Fala o protocolo `PlcScanSession` (linha de texto por comando) o suficiente pra passar do HELLO
 * na maioria dos modos, depois se comporta mal do jeito pedido pela variavel de ambiente:
 *
 *   exit-before-hello        -- sai antes de ler qualquer coisa (processo morre antes do handshake)
 *   bad-protocol              -- HELLO responde com protocol=99 (versao incompativel)
 *   bad-program                -- HELLO responde com program=WRONG (identidade inesperada)
 *   crash-after-hello          -- HELLO ok, sai imediatamente em seguida (worker morre logo depois do handshake)
 *   wrong-request-id           -- HELLO ok; qualquer comando seguinte responde com requestId errado ("zzz")
 *   malformed-response         -- HELLO ok; qualquer comando seguinte responde uma linha sem o formato esperado
 *   truncated-response         -- HELLO ok; qualquer comando seguinte escreve uma resposta parcial (sem newline) e sai
 *   exit-after-scan-received   -- HELLO ok; ao receber um SCAN, sai sem responder nada
 *   hang                       -- HELLO ok; qualquer comando seguinte nunca recebe resposta (dorme)
 */

#include <chrono>
#include <cstdio>
#include <cstdlib>
#include <sstream>
#include <string>
#include <thread>

namespace {

std::string misbehaveMode() {
    const char* value = std::getenv("LASECSIMUL_PLC_TEST_MISBEHAVE_MODE");
    return value ? value : "";
}

bool readLine(std::string& out) {
    out.clear();
    int ch;
    bool any = false;
    while ((ch = std::fgetc(stdin)) != EOF) {
        any = true;
        if (ch == '\n') return true;
        out.push_back(static_cast<char>(ch));
    }
    return any && !out.empty();
}

void writeLine(const std::string& text) {
    std::fwrite(text.data(), 1, text.size(), stdout);
    std::fputc('\n', stdout);
    std::fflush(stdout);
}

} // namespace

int main() {
    const std::string mode = misbehaveMode();
    std::setvbuf(stdout, nullptr, _IONBF, 0);

    if (mode == "exit-before-hello") return 0;

    std::string line;
    if (!readLine(line)) return 0; // EOF antes até de HELLO chegar -- nada a fazer.
    std::string helloRequestId;
    { std::istringstream stream(line); std::string command; stream >> command >> helloRequestId; }

    if (mode == "bad-protocol") { writeLine("OK " + helloRequestId + " protocol=99 program=HELLO"); return 0; }
    if (mode == "bad-program") { writeLine("OK " + helloRequestId + " protocol=1 program=WRONG"); return 0; }

    writeLine("OK " + helloRequestId + " protocol=1 program=HELLO");
    if (mode == "crash-after-hello") return 0;

    for (;;) {
        if (!readLine(line)) return 0; // EOF -- o Core fechou o pipe, sai limpo.
        std::istringstream stream(line);
        std::string command, requestId;
        stream >> command >> requestId;

        if (command == "SHUTDOWN") { writeLine("OK " + requestId); return 0; }

        if (mode == "wrong-request-id") { writeLine("OK zzz"); continue; }
        if (mode == "malformed-response") { writeLine("garbage-nao-e-uma-resposta-valida"); continue; }
        if (mode == "truncated-response") {
            std::fwrite("OK ", 1, 3, stdout);
            std::fwrite(requestId.data(), 1, requestId.size(), stdout);
            std::fwrite(" partial-nao-termina-em-newline", 1, 32, stdout);
            std::fflush(stdout);
            return 0; // sai sem completar a linha -- simula crash no meio da escrita.
        }
        if (mode == "exit-after-scan-received" && command == "SCAN") return 0;
        if (mode == "hang") { std::this_thread::sleep_for(std::chrono::hours(1)); continue; }

        writeLine("OK " + requestId); // fallback seguro pra qualquer comando nao coberto pelo modo.
    }
}
