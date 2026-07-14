/**
 * CoreBootstrapTest — testes de bootstrap headless do processo Core.
 *
 * Sem framework de testes externo: usa assert() + código de saída 1 em falha.
 * Executa em CI sem VSCode.
 */
#include <algorithm>
#include <cassert>
#include <chrono>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <filesystem>
#include <fstream>
#include <thread>
#include <string>
#include <vector>

#include "app/CoreApplication.hpp"
#include "ipc/IpcServer.hpp"
#include "ipc/Protocol.hpp"
#include "plugins/GlobalPluginCache.hpp"
#include "session/SimulationSession.hpp"

// ── helpers de socket para o lado cliente dos testes ─────────────────────────

#ifdef _WIN32
#  define WIN32_LEAN_AND_MEAN
#  include <windows.h>

static void* clientConnect(const std::string& name) {
    const std::string path = "\\\\.\\pipe\\" + name;
    for (int i = 0; i < 40; ++i) {
        HANDLE h = CreateFileA(path.c_str(), GENERIC_READ | GENERIC_WRITE,
                               0, nullptr, OPEN_EXISTING, 0, nullptr);
        if (h != INVALID_HANDLE_VALUE) return h;
        Sleep(100);
    }
    return INVALID_HANDLE_VALUE;
}
static bool clientWriteLine(void* h, const std::string& line) {
    const std::string msg = line + "\n";
    DWORD n = 0;
    return WriteFile(static_cast<HANDLE>(h), msg.data(), (DWORD)msg.size(), &n, nullptr) == TRUE;
}
static std::string clientReadLine(void* h) {
    std::string result;
    char ch; DWORD n;
    while (ReadFile(static_cast<HANDLE>(h), &ch, 1, &n, nullptr) && n > 0) {
        if (ch == '\n') break;
        result += ch;
    }
    return result;
}
static void clientClose(void* h) { CloseHandle(static_cast<HANDLE>(h)); }

#else
#  include <sys/socket.h>
#  include <sys/un.h>
#  include <unistd.h>
#  include <cerrno>

static std::string sockPath(const std::string& name) {
    const char* tmp = getenv("TMPDIR");
    if (!tmp || !tmp[0]) tmp = "/tmp";
    return std::string(tmp) + "/" + name + ".sock";
}
static int clientConnect(const std::string& name) {
    for (int i = 0; i < 40; ++i) {
        int fd = socket(AF_UNIX, SOCK_STREAM, 0);
        struct sockaddr_un addr = {};
        addr.sun_family = AF_UNIX;
        std::strncpy(addr.sun_path, sockPath(name).c_str(), sizeof(addr.sun_path) - 1);
        if (connect(fd, reinterpret_cast<struct sockaddr*>(&addr), sizeof(addr)) == 0) return fd;
        close(fd);
        usleep(100'000); // 100 ms
    }
    return -1;
}
static bool clientWriteLine(int fd, const std::string& line) {
    const std::string msg = line + "\n";
    return write(fd, msg.data(), msg.size()) == static_cast<ssize_t>(msg.size());
}
static std::string clientReadLine(int fd) {
    std::string result;
    char ch;
    while (read(fd, &ch, 1) == 1) {
        if (ch == '\n') break;
        result += ch;
    }
    return result;
}
static void clientClose(int fd) { close(fd); }
#endif

// ── Nlohmann para parse de resposta no cliente de teste ──────────────────────
#include <nlohmann/json.hpp>

// ── testes ────────────────────────────────────────────────────────────────────

static int failures = 0;

#define TEST_ASSERT(expr, msg) \
    do { \
        if (!(expr)) { \
            std::fprintf(stderr, "  FALHOU: %s — %s\n", msg, #expr); \
            failures++; \
        } else { \
            std::fprintf(stderr, "  OK: %s\n", msg); \
        } \
    } while (false)

#if defined(_WIN32)
static constexpr const char* kTestPlatformKey = "win32-x64";
#elif defined(__APPLE__)
static constexpr const char* kTestPlatformKey = "darwin-universal";
#else
static constexpr const char* kTestPlatformKey = "linux-x64";
#endif

static std::filesystem::path uniqueTempPath(const char* stem) {
    return std::filesystem::temp_directory_path()
           / (std::string(stem) + "-" + std::to_string(std::chrono::steady_clock::now().time_since_epoch().count()));
}

static std::filesystem::path createRequiresRestartLibraryFixture() {
#ifndef DEVICES_LIBRARY_JSON_PATH
    return {};
#else
    const std::filesystem::path sourceLibraryPath = DEVICES_LIBRARY_JSON_PATH;
    const std::filesystem::path devicesRoot = sourceLibraryPath.parent_path();
    const std::filesystem::path tempDir = uniqueTempPath("lasecsimul-setproperty-restart");
    std::filesystem::create_directories(tempDir / "example-blinker");

    const auto absolutizeNativeEntry = [](const std::filesystem::path& manifestPath, nlohmann::json& manifest) -> bool {
        if (!manifest.contains("nativeEntry") || !manifest["nativeEntry"].contains(kTestPlatformKey)) return false;
        const std::filesystem::path binaryPath =
            std::filesystem::absolute(manifestPath.parent_path() / manifest["nativeEntry"][kTestPlatformKey].get<std::string>());
        if (!std::filesystem::exists(binaryPath)) return false;
        manifest["nativeEntry"][kTestPlatformKey] = binaryPath.string();
        return true;
    };

    const std::filesystem::path blinkerSourceManifest = devicesRoot / "example-blinker" / "device.lsdevice";
    if (!std::filesystem::exists(blinkerSourceManifest)) return {};

    nlohmann::json blinkerManifest;
    {
        std::ifstream input(blinkerSourceManifest);
        if (!input) return {};
        input >> blinkerManifest;
    }
    if (!absolutizeNativeEntry(blinkerSourceManifest, blinkerManifest)) {
        return {};
    }

    blinkerManifest["typeId"] = "example.blinker.requires_restart";
    blinkerManifest["properties"][0]["requiresRestart"] = true;

    const std::filesystem::path blinkerManifestOut = tempDir / "example-blinker" / "device.lsdevice";
    const std::filesystem::path libraryOut = tempDir / "library.json";

    {
        std::ofstream manifestFile(blinkerManifestOut);
        manifestFile << blinkerManifest.dump(2);
    }
    const nlohmann::json library = {
        {"schemaVersion", 1},
        {"publisher", "test"},
        {"version", "0.0.0"},
        {"devices", {{{"typeId", "example.blinker.requires_restart"}, {"manifest", "example-blinker/device.lsdevice"}}}},
    };
    std::ofstream libraryFile(libraryOut);
    libraryFile << library.dump(2);
    return libraryOut;
#endif
}

// Teste 1: SimulationSession cria vazia
static void testSessionCreatesEmpty() {
    std::fprintf(stderr, "\n[T1] Sessão vazia é criada sem erros\n");
    lasecsimul::plugins::GlobalPluginCache cache;
    lasecsimul::session::SimulationSession session(cache);
    // Se chegou aqui sem exceção, ok
    TEST_ASSERT(true, "SimulationSession criada sem exceção");
}

// Teste 2: Core inicia headless (CoreApplication constrói sem travar)
static void testCoreApplicationConstructs() {
    std::fprintf(stderr, "\n[T2] CoreApplication constrói sem VSCode\n");
    // Usamos um nome de pipe fictício; run() não é chamado neste teste
    lasecsimul::app::CoreApplication app({"test-construct-only"});
    TEST_ASSERT(true, "CoreApplication construída sem exceção");
}

// Teste 3: Core aceita hello e responde com protocolVersion correto
static void testCoreAcceptsHello() {
    std::fprintf(stderr, "\n[T3] Core aceita 'hello' e retorna protocolVersion\n");

    const std::string pipeName = "lasecsimul-bootstrap-test-hello";

    // Corre o servidor numa thread separada
    int serverResult = -1;
    std::thread serverThread([&] {
        lasecsimul::app::CoreApplication app({pipeName});
        serverResult = app.run();
    });

    // Cliente de teste
#ifdef _WIN32
    void* conn = clientConnect(pipeName);
    TEST_ASSERT(conn != INVALID_HANDLE_VALUE, "cliente conectou ao pipe");
#else
    int conn = clientConnect(pipeName);
    TEST_ASSERT(conn >= 0, "cliente conectou ao socket");
#endif

    if (
#ifdef _WIN32
        conn != INVALID_HANDLE_VALUE
#else
        conn >= 0
#endif
    ) {
        // Envia hello
        const nlohmann::json req = {
            {"id", "1"}, {"type", "hello"},
            {"payload", {{"clientVersion", "0.1.0"}}},
            {"protocolVersion", lasecsimul::ipc::PROTOCOL_VERSION}
        };
        clientWriteLine(conn, req.dump());

        // Lê resposta
        const std::string rawResp = clientReadLine(conn);
        try {
            auto resp = nlohmann::json::parse(rawResp);
            TEST_ASSERT(resp.value("ok", false), "resposta hello ok == true");
            TEST_ASSERT(resp.contains("payload"), "resposta hello contém payload");
            TEST_ASSERT(resp["payload"].value("protocolVersion", -1) == lasecsimul::ipc::PROTOCOL_VERSION,
                        "protocolVersion correto na resposta hello");
        } catch (...) {
            TEST_ASSERT(false, "resposta hello é JSON válido");
        }

        // Envia shutdown para encerrar o servidor
        const nlohmann::json shutdownReq = {
            {"id", "2"}, {"type", "shutdown"},
            {"payload", nlohmann::json::object()},
            {"protocolVersion", lasecsimul::ipc::PROTOCOL_VERSION}
        };
        clientWriteLine(conn, shutdownReq.dump());
        clientReadLine(conn); // aguarda resposta
        clientClose(conn);
    }

    serverThread.join();
    TEST_ASSERT(serverResult == 0, "servidor encerrou com código 0 (shutdown limpo)");
}

// Teste 4b: getComponentState via IPC devolve os bytes opacos de getState() de uma instância real —
// mecanismo genérico (não específico de um tipo), usado pela Extension pra ler de volta qualquer
// valor calculado (built-in ou plugin, ex: voltímetro — ver .spec/lasecsimul.spec).
static void testGetComponentStateOverIpc() {
    std::fprintf(stderr, "\n[T4b] 'getComponentState' via IPC devolve o estado opaco de uma instância real\n");

    const std::string pipeName = "lasecsimul-bootstrap-test-state";
    int serverResult = -1;
    std::thread serverThread([&] {
        lasecsimul::app::CoreApplication app({pipeName});
        serverResult = app.run();
    });

#ifdef _WIN32
    void* conn = clientConnect(pipeName);
    TEST_ASSERT(conn != INVALID_HANDLE_VALUE, "cliente conectou");
#else
    int conn = clientConnect(pipeName);
    TEST_ASSERT(conn >= 0, "cliente conectou");
#endif

    if (
#ifdef _WIN32
        conn != INVALID_HANDLE_VALUE
#else
        conn >= 0
#endif
    ) {
        int nextId = 1;
        auto send = [&](const std::string& type, const nlohmann::json& payload) -> nlohmann::json {
            const nlohmann::json req = {{"id", std::to_string(nextId++)},
                                         {"type", type},
                                         {"payload", payload},
                                         {"protocolVersion", lasecsimul::ipc::PROTOCOL_VERSION}};
            clientWriteLine(conn, req.dump());
            return nlohmann::json::parse(clientReadLine(conn));
        };

        send("hello", {{"clientVersion", "0.1.0"}});

        // Capacitor built-in: getState() devolve 8 bytes (a tensão interna, double), 0.0 recém-criado
        // — escolhido por já ter getState/setState reais, sem depender de nenhum plugin pra este teste.
        const std::string cap = send("addComponent", {{"typeId", "passive.capacitor"}, {"properties", {{"capacitance", 1e-6}}}})["payload"]["instanceId"];

        const nlohmann::json stateResp = send("getComponentState", {{"instanceId", cap}});
        TEST_ASSERT(stateResp.value("ok", false), "getComponentState responde ok para instância válida");
        const std::string stateHex = stateResp["payload"].value("stateHex", std::string{});
        TEST_ASSERT(stateHex.size() == 16, "stateHex tem 16 hex chars (8 bytes de double)");

        double decoded = -1.0;
        if (stateHex.size() == 16) {
            uint8_t bytes[8];
            for (int i = 0; i < 8; ++i) {
                const auto hexNibble = [](char c) -> int {
                    return (c >= '0' && c <= '9') ? c - '0' : (c - 'a' + 10);
                };
                bytes[i] = static_cast<uint8_t>((hexNibble(stateHex[i * 2]) << 4) | hexNibble(stateHex[i * 2 + 1]));
            }
            std::memcpy(&decoded, bytes, sizeof(decoded));
        }
        TEST_ASSERT(decoded == 0.0, "estado decodificado do capacitor recém-criado é 0.0V");

        const nlohmann::json badInstance = send("getComponentState", {{"instanceId", "999"}});
        TEST_ASSERT(!badInstance.value("ok", true), "getComponentState com instanceId inválido reporta erro, não trava o Core");

        send("removeComponent", {{"instanceId", cap}});
        const nlohmann::json afterRemove = send("getComponentState", {{"instanceId", cap}});
        TEST_ASSERT(!afterRemove.value("ok", true), "getComponentState de instância removida reporta erro, não trava o Core");

        send("shutdown", nlohmann::json::object());
        clientClose(conn);
    }

    serverThread.join();
    TEST_ASSERT(serverResult == 0, "servidor encerrou com codigo 0 apos shutdown");
}

// Teste 4b2: getNodeVoltage via IPC resolve um divisor resistivo de ponta a ponta -- usado pela
// Extension pra colorir/animar fios na Webview (ver .spec/lasecsimul.spec e ConnectorLine do SimulIDE).
static void testGetNodeVoltageOverIpc() {
    std::fprintf(stderr, "\n[T4b2] 'getNodeVoltage' via IPC resolve divisor resistivo (10V/1k/1k)\n");

    const std::string pipeName = "lasecsimul-bootstrap-test-nodevoltage";
    int serverResult = -1;
    std::thread serverThread([&] {
        lasecsimul::app::CoreApplication app({pipeName});
        serverResult = app.run();
    });

#ifdef _WIN32
    void* conn = clientConnect(pipeName);
    TEST_ASSERT(conn != INVALID_HANDLE_VALUE, "cliente conectou");
#else
    int conn = clientConnect(pipeName);
    TEST_ASSERT(conn >= 0, "cliente conectou");
#endif

    if (
#ifdef _WIN32
        conn != INVALID_HANDLE_VALUE
#else
        conn >= 0
#endif
    ) {
        int nextId = 1;
        auto send = [&](const std::string& type, const nlohmann::json& payload) -> nlohmann::json {
            const nlohmann::json req = {{"id", std::to_string(nextId++)},
                                         {"type", type},
                                         {"payload", payload},
                                         {"protocolVersion", lasecsimul::ipc::PROTOCOL_VERSION}};
            clientWriteLine(conn, req.dump());
            return nlohmann::json::parse(clientReadLine(conn));
        };

        send("hello", {{"clientVersion", "0.1.0"}});

        const std::string source = send("addComponent", {{"typeId", "sources.dc_voltage"}, {"properties", {{"voltage", 10.0}}}})["payload"]["instanceId"];
        const std::string r1 = send("addComponent", {{"typeId", "passive.resistor"}, {"properties", {{"resistance", 1000.0}}}})["payload"]["instanceId"];
        const std::string r2 = send("addComponent", {{"typeId", "passive.resistor"}, {"properties", {{"resistance", 1000.0}}}})["payload"]["instanceId"];
        const std::string ground = send("addComponent", {{"typeId", "other.ground"}, {"properties", nlohmann::json::object()}})["payload"]["instanceId"];

        send("connectWire", {{"from", {{"componentId", source}, {"pinId", "p1"}}}, {"to", {{"componentId", r1}, {"pinId", "p1"}}}});
        send("connectWire", {{"from", {{"componentId", r1}, {"pinId", "p2"}}}, {"to", {{"componentId", r2}, {"pinId", "p1"}}}});
        send("connectWire", {{"from", {{"componentId", r2}, {"pinId", "p2"}}}, {"to", {{"componentId", source}, {"pinId", "p2"}}}});
        send("connectWire", {{"from", {{"componentId", source}, {"pinId", "p2"}}}, {"to", {{"componentId", ground}, {"pinId", "pin"}}}});

        send("start", nlohmann::json::object());

        double lastVoltage = -1.0;
        bool stabilized = false;
        for (int attempt = 0; attempt < 100 && !stabilized; ++attempt) {
            const nlohmann::json resp = send("getNodeVoltage", {{"instanceId", r1}, {"pinId", "p2"}});
            if (resp.value("ok", false)) {
                lastVoltage = resp["payload"].value("voltage", -1.0);
                if (std::abs(lastVoltage - 5.0) < 1e-3) stabilized = true;
            }
            if (!stabilized) std::this_thread::sleep_for(std::chrono::milliseconds(20));
        }
        TEST_ASSERT(stabilized, "tensao no ponto medio do divisor converge para 5V via getNodeVoltage");
        std::fprintf(stderr, "  [info] ultima tensao lida: %.6f\n", lastVoltage);

        const nlohmann::json badPin = send("getNodeVoltage", {{"instanceId", r1}, {"pinId", "pin-que-nao-existe"}});
        TEST_ASSERT(!badPin.value("ok", true), "getNodeVoltage com pino invalido reporta erro, nao trava o Core");

        send("stop", nlohmann::json::object());
        send("shutdown", nlohmann::json::object());
        clientClose(conn);
    }

    serverThread.join();
    TEST_ASSERT(serverResult == 0, "servidor encerrou com codigo 0 apos shutdown");
}

// Teste 4b3: getComponentCurrent via IPC (opção de baixo custo do plano de leitura de corrente --
// sem incógnita nova na matriz, lida sob demanda do estado cacheado na última stamp()). Mesmo
// divisor resistivo de testGetNodeVoltageOverIpc.
static void testGetComponentCurrentOverIpc() {
    std::fprintf(stderr, "\n[T4b3] 'getComponentCurrent' via IPC mede a corrente de um resistor (10V/1k/1k)\n");

    const std::string pipeName = "lasecsimul-bootstrap-test-current";
    int serverResult = -1;
    std::thread serverThread([&] {
        lasecsimul::app::CoreApplication app({pipeName});
        serverResult = app.run();
    });

#ifdef _WIN32
    void* conn = clientConnect(pipeName);
    TEST_ASSERT(conn != INVALID_HANDLE_VALUE, "cliente conectou");
#else
    int conn = clientConnect(pipeName);
    TEST_ASSERT(conn >= 0, "cliente conectou");
#endif

    if (
#ifdef _WIN32
        conn != INVALID_HANDLE_VALUE
#else
        conn >= 0
#endif
    ) {
        int nextId = 1;
        auto send = [&](const std::string& type, const nlohmann::json& payload) -> nlohmann::json {
            const nlohmann::json req = {{"id", std::to_string(nextId++)},
                                         {"type", type},
                                         {"payload", payload},
                                         {"protocolVersion", lasecsimul::ipc::PROTOCOL_VERSION}};
            clientWriteLine(conn, req.dump());
            return nlohmann::json::parse(clientReadLine(conn));
        };

        send("hello", {{"clientVersion", "0.1.0"}});

        const std::string source = send("addComponent", {{"typeId", "sources.dc_voltage"}, {"properties", {{"voltage", 10.0}}}})["payload"]["instanceId"];
        const std::string r1 = send("addComponent", {{"typeId", "passive.resistor"}, {"properties", {{"resistance", 1000.0}}}})["payload"]["instanceId"];
        const std::string r2 = send("addComponent", {{"typeId", "passive.resistor"}, {"properties", {{"resistance", 1000.0}}}})["payload"]["instanceId"];
        const std::string ground = send("addComponent", {{"typeId", "other.ground"}, {"properties", nlohmann::json::object()}})["payload"]["instanceId"];

        send("connectWire", {{"from", {{"componentId", source}, {"pinId", "p1"}}}, {"to", {{"componentId", r1}, {"pinId", "p1"}}}});
        send("connectWire", {{"from", {{"componentId", r1}, {"pinId", "p2"}}}, {"to", {{"componentId", r2}, {"pinId", "p1"}}}});
        send("connectWire", {{"from", {{"componentId", r2}, {"pinId", "p2"}}}, {"to", {{"componentId", source}, {"pinId", "p2"}}}});
        send("connectWire", {{"from", {{"componentId", source}, {"pinId", "p2"}}}, {"to", {{"componentId", ground}, {"pinId", "pin"}}}});

        send("start", nlohmann::json::object());

        double lastCurrent = -1.0;
        bool stabilized = false;
        for (int attempt = 0; attempt < 100 && !stabilized; ++attempt) {
            const nlohmann::json resp = send("getComponentCurrent", {{"instanceId", r1}});
            if (resp.value("ok", false) && resp["payload"].value("hasCurrent", false)) {
                lastCurrent = resp["payload"].value("current", -1.0);
                if (std::abs(lastCurrent - 0.005) < 1e-4) stabilized = true;
            }
            if (!stabilized) std::this_thread::sleep_for(std::chrono::milliseconds(20));
        }
        TEST_ASSERT(stabilized, "corrente do resistor r1 converge para 5mA (10V/2k) via getComponentCurrent");
        std::fprintf(stderr, "  [info] ultima corrente lida: %.6f\n", lastCurrent);

        const nlohmann::json groundResp = send("getComponentCurrent", {{"instanceId", ground}});
        TEST_ASSERT(groundResp.value("ok", false) && !groundResp["payload"].value("hasCurrent", true),
                    "Ground nao implementa current() -- hasCurrent=false, nunca erro");

        const nlohmann::json badId = send("getComponentCurrent", {{"instanceId", "99999"}});
        TEST_ASSERT(badId.value("ok", false) && !badId["payload"].value("hasCurrent", true),
                    "instanceId invalido devolve hasCurrent=false, nao trava o Core");

        send("stop", nlohmann::json::object());
        send("shutdown", nlohmann::json::object());
        clientClose(conn);
    }

    serverThread.join();
    TEST_ASSERT(serverResult == 0, "servidor encerrou com codigo 0 apos shutdown");
}

// Teste 4b4: 'registerAdhocSubcircuit' via IPC registra UM .lssubcircuit avulso (sem library.json) e
// addComponent com o typeId resultante expande normalmente -- prova o verbo IPC usado pelo bloco
// genérico de subcircuito por caminho (ver .spec/lasecsimul-subcircuits.spec seção 9). Mesmo
// "divisor_5v" sintético de subcircuit_test.cpp, mas escrito num arquivo real e registrado pela
// via IPC em vez de SubcircuitRegistry::registerDefinition() direto.
static void testRegisterAdhocSubcircuitOverIpc() {
    std::fprintf(stderr, "\n[T4b4] 'registerAdhocSubcircuit' via IPC registra .lssubcircuit avulso e expande via addComponent\n");

    const std::filesystem::path manifestPath = uniqueTempPath("lasecsimul-adhoc-divisor");
    {
        std::ofstream manifestFile(manifestPath);
        manifestFile << nlohmann::json{
            {"schemaVersion", 1},
            {"typeId", "subcircuits.divisor_5v_adhoc"},
            {"name", "Divisor 5V avulso (teste IPC)"},
            {"components", {
                {{"id", "r1"}, {"typeId", "passive.resistor"}, {"properties", {{"resistance", 1000}}}},
                {{"id", "r2"}, {"typeId", "passive.resistor"}, {"properties", {{"resistance", 1000}}}},
                {{"id", "tunnel_in"}, {"typeId", "connectors.tunnel"}, {"properties", {{"name", "VIN"}}}},
                {{"id", "tunnel_out"}, {"typeId", "connectors.tunnel"}, {"properties", {{"name", "VOUT"}}}},
                {{"id", "tunnel_gnd"}, {"typeId", "connectors.tunnel"}, {"properties", {{"name", "GND"}}}},
            }},
            {"wires", {
                {{"from", {{"componentId", "tunnel_in"}, {"pinId", "pin"}}}, {"to", {{"componentId", "r1"}, {"pinId", "p1"}}}},
                {{"from", {{"componentId", "r1"}, {"pinId", "p2"}}}, {"to", {{"componentId", "r2"}, {"pinId", "p1"}}}},
                {{"from", {{"componentId", "r1"}, {"pinId", "p2"}}}, {"to", {{"componentId", "tunnel_out"}, {"pinId", "pin"}}}},
                {{"from", {{"componentId", "r2"}, {"pinId", "p2"}}}, {"to", {{"componentId", "tunnel_gnd"}, {"pinId", "pin"}}}},
            }},
            {"interface", {
                {{"pinId", "VIN"}, {"label", "Entrada"}, {"internalTunnel", "VIN"}},
                {{"pinId", "VOUT"}, {"label", "Saída"}, {"internalTunnel", "VOUT"}},
                {{"pinId", "GND"}, {"label", "Terra"}, {"internalTunnel", "GND"}},
            }},
            {"package", {
                {"width", 60},
                {"height", 48},
                {"pins", {
                    {{"id", "VIN"}, {"x", -30}, {"y", -12}, {"side", "left"}},
                    {{"id", "VOUT"}, {"x", 30}, {"y", 0}, {"side", "right"}},
                    {{"id", "GND"}, {"x", 0}, {"y", 24}, {"side", "bottom"}},
                }},
            }},
        }.dump(2);
    }
    const std::filesystem::path invalidSchemaPath = uniqueTempPath("lasecsimul-adhoc-invalid-schema");
    {
        std::ofstream manifestFile(invalidSchemaPath);
        manifestFile << nlohmann::json{
            {"schemaVersion", 999},
            {"typeId", "subcircuits.invalid_schema"},
            {"components", nlohmann::json::array()},
            {"wires", nlohmann::json::array()},
            {"interface", nlohmann::json::array()},
        }.dump(2);
    }
    const std::filesystem::path duplicateManifestPath = uniqueTempPath("lasecsimul-adhoc-divisor-duplicate");
    {
        std::ofstream manifestFile(duplicateManifestPath);
        manifestFile << nlohmann::json{
            {"schemaVersion", 1},
            {"typeId", "subcircuits.divisor_5v_adhoc"},
            {"name", "Duplicado em outro arquivo"},
            {"components", {
                {{"id", "tunnel_in"}, {"typeId", "connectors.tunnel"}, {"properties", {{"name", "VIN"}}}},
            }},
            {"wires", nlohmann::json::array()},
            {"interface", {
                {{"pinId", "VIN"}, {"label", "Entrada"}, {"internalTunnel", "VIN"}},
            }},
        }.dump(2);
    }

    const std::string pipeName = "lasecsimul-bootstrap-test-adhoc-subcircuit";
    int serverResult = -1;
    std::thread serverThread([&] {
        lasecsimul::app::CoreApplication app({pipeName});
        serverResult = app.run();
    });

#ifdef _WIN32
    void* conn = clientConnect(pipeName);
    TEST_ASSERT(conn != INVALID_HANDLE_VALUE, "cliente conectou");
#else
    int conn = clientConnect(pipeName);
    TEST_ASSERT(conn >= 0, "cliente conectou");
#endif

    if (
#ifdef _WIN32
        conn != INVALID_HANDLE_VALUE
#else
        conn >= 0
#endif
    ) {
        int nextId = 1;
        auto send = [&](const std::string& type, const nlohmann::json& payload) -> nlohmann::json {
            const nlohmann::json req = {{"id", std::to_string(nextId++)},
                                         {"type", type},
                                         {"payload", payload},
                                         {"protocolVersion", lasecsimul::ipc::PROTOCOL_VERSION}};
            clientWriteLine(conn, req.dump());
            return nlohmann::json::parse(clientReadLine(conn));
        };

        send("hello", {{"clientVersion", "0.1.0"}});

        const nlohmann::json missingResp = send("registerAdhocSubcircuit", {{"path", (manifestPath.string() + "-nao-existe")}});
        TEST_ASSERT(!missingResp.value("ok", true), "registerAdhocSubcircuit com caminho inexistente reporta erro, nao trava o Core");
        const nlohmann::json invalidSchemaResp = send("registerAdhocSubcircuit", {{"path", invalidSchemaPath.string()}});
        TEST_ASSERT(!invalidSchemaResp.value("ok", true), "registerAdhocSubcircuit rejeita schemaVersion invalido");

        const nlohmann::json registerResp = send("registerAdhocSubcircuit", {{"path", manifestPath.string()}});
        TEST_ASSERT(registerResp.value("ok", false), "registerAdhocSubcircuit aceita o .lssubcircuit avulso");
        const std::string typeId = registerResp["payload"].value("typeId", std::string{});
        TEST_ASSERT(typeId == "subcircuits.divisor_5v_adhoc", "typeId devolvido bate com o declarado no manifesto");
        TEST_ASSERT(registerResp["payload"].value("status", std::string{}) == "registered", "payload informa status registered no primeiro carregamento");
        TEST_ASSERT(registerResp["payload"].value("pinCount", 0) == 3, "payload informa pinCount derivado da interface");
        TEST_ASSERT(registerResp["payload"].contains("interface") && registerResp["payload"]["interface"].size() == 3, "payload inclui interface completa");
        TEST_ASSERT(registerResp["payload"].contains("package") && registerResp["payload"]["package"].contains("pins"), "payload inclui package visual");

        const nlohmann::json reloadResp = send("registerAdhocSubcircuit", {{"path", manifestPath.string()}});
        TEST_ASSERT(reloadResp.value("ok", false), "recarregar o mesmo arquivo sem replace e permitido");
        TEST_ASSERT(reloadResp["payload"].value("status", std::string{}) == "reloaded", "payload informa status reloaded no mesmo sourcePath");

        const nlohmann::json duplicateResp = send("registerAdhocSubcircuit", {{"path", duplicateManifestPath.string()}});
        TEST_ASSERT(!duplicateResp.value("ok", true), "typeId duplicado em outro arquivo e rejeitado por padrao");
        const nlohmann::json replaceResp = send("registerAdhocSubcircuit", {{"path", duplicateManifestPath.string()}, {"replace", true}});
        TEST_ASSERT(replaceResp.value("ok", false), "typeId duplicado em outro arquivo so substitui com replace explicito");
        (void)send("registerAdhocSubcircuit", {{"path", manifestPath.string()}, {"replace", true}});

        const nlohmann::json addResp = send("addComponent", {{"typeId", typeId}, {"properties", nlohmann::json::object()}});
        TEST_ASSERT(addResp.value("ok", false), "addComponent com o typeId avulso expande a instância");
        const auto& exposedPins = addResp["payload"]["exposedPins"];
        TEST_ASSERT(exposedPins.size() == 3, "3 pinos expostos (VIN/VOUT/GND)");

        // `exposedPins[label].pinId` é sempre "pin" (o pino real do `connectors.tunnel` interno
        // renomeado) -- "VIN"/"VOUT"/"GND" são só as CHAVES do mapa (o rótulo externo), nunca o
        // pinId de fiação real, mesmo padrão de `esp32_devkitc_subcircuit_test.cpp`.
        const std::string vin = exposedPins["VIN"].value("instanceId", std::string{});
        const std::string vout = exposedPins["VOUT"].value("instanceId", std::string{});
        const std::string gnd = exposedPins["GND"].value("instanceId", std::string{});
        const std::string tunnelPinId = exposedPins["VIN"].value("pinId", std::string{});
        TEST_ASSERT(tunnelPinId == "pin", "pino do tunnel exposto é 'pin' (Tunnel real interno)");

        const std::string source = send("addComponent", {{"typeId", "sources.dc_voltage"}, {"properties", {{"voltage", 10.0}}}})["payload"]["instanceId"];
        const std::string ground = send("addComponent", {{"typeId", "other.ground"}, {"properties", nlohmann::json::object()}})["payload"]["instanceId"];

        send("connectWire", {{"from", {{"componentId", source}, {"pinId", "p1"}}}, {"to", {{"componentId", vin}, {"pinId", "pin"}}}});
        send("connectWire", {{"from", {{"componentId", source}, {"pinId", "p2"}}}, {"to", {{"componentId", ground}, {"pinId", "pin"}}}});
        send("connectWire", {{"from", {{"componentId", gnd}, {"pinId", "pin"}}}, {"to", {{"componentId", ground}, {"pinId", "pin"}}}});

        send("start", nlohmann::json::object());

        double lastVoltage = -1.0;
        bool stabilized = false;
        for (int attempt = 0; attempt < 100 && !stabilized; ++attempt) {
            const nlohmann::json resp = send("getNodeVoltage", {{"instanceId", vout}, {"pinId", "pin"}});
            if (resp.value("ok", false)) {
                lastVoltage = resp["payload"].value("voltage", -1.0);
                if (std::abs(lastVoltage - 5.0) < 1e-3) stabilized = true;
            }
            if (!stabilized) std::this_thread::sleep_for(std::chrono::milliseconds(20));
        }
        TEST_ASSERT(stabilized, "subcircuito avulso expandido resolve eletricamente (VOUT converge para 5V)");
        std::fprintf(stderr, "  [info] ultima tensao lida: %.6f\n", lastVoltage);

        send("stop", nlohmann::json::object());
        send("shutdown", nlohmann::json::object());
        clientClose(conn);
    }

    serverThread.join();
    TEST_ASSERT(serverResult == 0, "servidor encerrou com codigo 0 apos shutdown");
    std::filesystem::remove(manifestPath);
    std::filesystem::remove(invalidSchemaPath);
    std::filesystem::remove(duplicateManifestPath);
}

// Teste 4c.2: componentes complexos refeitos via ABI recebem comandos bit a bit pelo on_event.
static void testSimulideComplexAbiEventsOverIpc() {
    std::fprintf(stderr, "\n[T4c.2] componente complexo SimulIDE via ABI interpreta pinos bit a bit\n");
#ifndef DEVICES_LIBRARY_JSON_PATH
    std::fprintf(stderr, "  [info] DEVICES_LIBRARY_JSON_PATH nao definido -- pulando teste.\n");
    TEST_ASSERT(true, "teste pulado sem fixture de devices");
    return;
#else
    const std::filesystem::path libraryPath = DEVICES_LIBRARY_JSON_PATH;
    const std::filesystem::path hdDll = libraryPath.parent_path() / "simulide-complex" / "build" / kTestPlatformKey / "device.dll";
    if (!std::filesystem::exists(libraryPath) || !std::filesystem::exists(hdDll)) {
        std::fprintf(stderr, "  [info] biblioteca ABI complexa nao encontrada -- pulando teste.\n");
        TEST_ASSERT(true, "teste pulado sem DLL simulide-complex compilado");
        return;
    }

    const std::string pipeName = "lasecsimul-test-complex-abi-" + std::to_string(std::rand());
    lasecsimul::app::CoreApplication app({pipeName});
    int serverResult = -1;
    std::thread serverThread([&] { serverResult = app.run(); });

#ifdef _WIN32
    void* conn = clientConnect(pipeName);
    TEST_ASSERT(conn != INVALID_HANDLE_VALUE, "cliente conectou");
#else
    int conn = clientConnect(pipeName);
    TEST_ASSERT(conn >= 0, "cliente conectou");
#endif

    if (
#ifdef _WIN32
        conn != INVALID_HANDLE_VALUE
#else
        conn >= 0
#endif
    ) {
        int nextId = 1;
        auto send = [&](const std::string& type, const nlohmann::json& payload) -> nlohmann::json {
            const nlohmann::json req = {{"id", std::to_string(nextId++)},
                                         {"type", type},
                                         {"payload", payload},
                                         {"protocolVersion", lasecsimul::ipc::PROTOCOL_VERSION}};
            clientWriteLine(conn, req.dump());
            return nlohmann::json::parse(clientReadLine(conn));
        };
        const auto decodeHex = [](const std::string& hex) {
            std::vector<uint8_t> bytes(hex.size() / 2);
            const auto nibble = [](char c) -> uint8_t {
                if (c >= '0' && c <= '9') return static_cast<uint8_t>(c - '0');
                if (c >= 'A' && c <= 'F') return static_cast<uint8_t>(c - 'A' + 10);
                return static_cast<uint8_t>(c - 'a' + 10);
            };
            for (size_t i = 0; i < bytes.size(); ++i) {
                bytes[i] = static_cast<uint8_t>((nibble(hex[i * 2]) << 4) | nibble(hex[i * 2 + 1]));
            }
            return bytes;
        };

        send("hello", {{"clientVersion", "0.1.0"}});
        TEST_ASSERT(send("loadDeviceLibrary", {{"path", libraryPath.string()}}).value("ok", false),
                    "loadDeviceLibrary registra outputs.hd44780 como plugin ABI");
        const nlohmann::json hdResp = send("addComponent", {{"typeId", "outputs.hd44780"},
                                                             {"properties", {{"rows", 2.0}, {"columns", 16.0}}},
                                                             {"pins", {{{"id", "rs"}}, {{"id", "rw"}}, {{"id", "en"}},
                                                                       {{"id", "d0"}}, {{"id", "d1"}}, {{"id", "d2"}},
                                                                       {{"id", "d3"}}, {{"id", "d4"}}, {{"id", "d5"}},
                                                                       {{"id", "d6"}}, {{"id", "d7"}}}}});
        TEST_ASSERT(hdResp.value("ok", false), "addComponent('outputs.hd44780') usa NativeDeviceProxy");
        const std::string hd = hdResp["payload"]["instanceId"];

        auto setPin = [&](uint32_t pin, uint32_t level) {
            return send("sendComponentEvent", {{"instanceId", hd}, {"tag", 1}, {"a", pin}, {"b", level}, {"c", 0}}).value("ok", false);
        };
        auto writeParallelByte = [&](uint8_t value, bool rs) {
            TEST_ASSERT(setPin(0, rs ? 1u : 0u), "RS entregue ao ABI");
            TEST_ASSERT(setPin(1, 0), "RW em escrita entregue ao ABI");
            for (uint32_t bit = 0; bit < 8; ++bit) {
                TEST_ASSERT(setPin(3 + bit, (value >> bit) & 1u), "bit paralelo entregue ao ABI");
            }
            TEST_ASSERT(setPin(2, 1), "borda de subida EN entregue ao ABI");
            TEST_ASSERT(setPin(2, 0), "borda de descida EN faz latch do byte");
        };

        writeParallelByte(0x0c, false);
        writeParallelByte(65, true);

        const nlohmann::json stateResp = send("getComponentState", {{"instanceId", hd}});
        TEST_ASSERT(stateResp.value("ok", false), "getComponentState retorna RAM do HD44780 ABI");
        const std::vector<uint8_t> state = decodeHex(stateResp["payload"].value("stateHex", std::string{}));
        // ABI v2 (.spec/lasecsimul-native-devices.spec): header de get_state ganhou um uint32 de
        // versão na frente (header[0]) -- payload (DDRAM) agora começa no byte 36, não 32.
        TEST_ASSERT(state.size() >= 37 && state[36] == 65, "DDRAM[0] contem 'A' apos latches bit a bit");

        send("shutdown", nlohmann::json::object());
        clientClose(conn);
    }

    serverThread.join();
    TEST_ASSERT(serverResult == 0, "servidor encerrou com codigo 0 apos shutdown");
#endif
}

// Teste 4d: 'getPropertySchemas' devolve o schema rico (grupo/editor/min/unidade) de um built-in
// ANTES de qualquer loadDeviceLibrary, e passa a incluir também o typeId de um plugin DEPOIS de
// carregá-lo -- mesma fonte (ComponentMetadataRegistry) pros dois caminhos, sem distinção no Core.
static void testGetPropertySchemasOverIpc() {
    std::fprintf(stderr, "\n[T4d] 'getPropertySchemas' via IPC devolve schema de built-in e de plugin\n");

    const std::string pipeName = "lasecsimul-bootstrap-test-propschemas";
    int serverResult = -1;
    std::thread serverThread([&] {
        lasecsimul::app::CoreApplication app({pipeName});
        serverResult = app.run();
    });

#ifdef _WIN32
    void* conn = clientConnect(pipeName);
    TEST_ASSERT(conn != INVALID_HANDLE_VALUE, "cliente conectou");
#else
    int conn = clientConnect(pipeName);
    TEST_ASSERT(conn >= 0, "cliente conectou");
#endif

    if (
#ifdef _WIN32
        conn != INVALID_HANDLE_VALUE
#else
        conn >= 0
#endif
    ) {
        int nextId = 1;
        auto send = [&](const std::string& type, const nlohmann::json& payload) -> nlohmann::json {
            const nlohmann::json req = {{"id", std::to_string(nextId++)},
                                         {"type", type},
                                         {"payload", payload},
                                         {"protocolVersion", lasecsimul::ipc::PROTOCOL_VERSION}};
            clientWriteLine(conn, req.dump());
            return nlohmann::json::parse(clientReadLine(conn));
        };

        send("hello", {{"clientVersion", "0.1.0"}});

        const nlohmann::json beforeResp = send("getPropertySchemas", nlohmann::json::object());
        TEST_ASSERT(beforeResp.value("ok", false), "getPropertySchemas responde ok");
        const nlohmann::json& beforeSchemas = beforeResp["payload"]["schemasByTypeId"];
        TEST_ASSERT(beforeSchemas.contains("passive.resistor"), "schema do resistor built-in já existe sem nenhum loadDeviceLibrary");
        TEST_ASSERT(!beforeSchemas.contains("example.blinker"), "example.blinker (plugin) ainda não aparece antes de carregar a library");

        const nlohmann::json& resistorSchema = beforeSchemas["passive.resistor"][0];
        TEST_ASSERT(resistorSchema.value("group", std::string{}) == "Elétrica", "resistor: grupo == Elétrica");
        TEST_ASSERT(resistorSchema.value("editor", std::string{}) == "number", "resistor: editor == number");
        TEST_ASSERT(resistorSchema.value("unit", std::string{}) == "Ω", "resistor: unidade == Ω");
        TEST_ASSERT(resistorSchema.contains("min"), "resistor: min presente");

        // ABI v2 (.spec/lasecsimul-native-devices.spec) -- readoutFormatByTypeId/interactionKindByTypeId
        // são mapas IRMÃOS aditivos, só aparecem pra quem declarou; resistor não declara nenhum dos dois.
        const nlohmann::json& readoutByTypeId = beforeResp["payload"]["readoutFormatByTypeId"];
        const nlohmann::json& interactionByTypeId = beforeResp["payload"]["interactionKindByTypeId"];
        TEST_ASSERT(!readoutByTypeId.contains("passive.resistor"), "resistor não declara readoutFormat");
        TEST_ASSERT(!interactionByTypeId.contains("passive.resistor"), "resistor não declara interactionKind");

        const nlohmann::json& oscopeReadout = readoutByTypeId["meters.oscope"];
        TEST_ASSERT(oscopeReadout.value("kind", std::string{}) == "channelHistory", "oscope: readout.kind == channelHistory");
        TEST_ASSERT(oscopeReadout.value("channels", 0u) == 4u, "oscope: readout.channels == 4");

        const nlohmann::json& logicAnalyzerReadout = readoutByTypeId["meters.logic_analyzer"];
        TEST_ASSERT(logicAnalyzerReadout.value("kind", std::string{}) == "vectorHistory", "logic_analyzer: readout.kind == vectorHistory");
        TEST_ASSERT(logicAnalyzerReadout.value("channels", 0u) == 8u, "logic_analyzer: readout.channels == 8");

        const nlohmann::json& ampmeterReadout = readoutByTypeId["meters.ampmeter"];
        TEST_ASSERT(ampmeterReadout.value("kind", std::string{}) == "scalar", "ampmeter: readout.kind == scalar");
        TEST_ASSERT(ampmeterReadout.value("unit", std::string{}) == "A", "ampmeter: readout.unit == A");

        const nlohmann::json& freqmeterReadout = readoutByTypeId["meters.freqmeter"];
        TEST_ASSERT(freqmeterReadout.value("unit", std::string{}) == "Hz", "freqmeter: readout.unit == Hz");

        const nlohmann::json& probeReadout = readoutByTypeId["meters.probe"];
        TEST_ASSERT(probeReadout.value("unit", std::string{}) == "V", "probe: readout.unit == V");

        TEST_ASSERT(interactionByTypeId.value("switches.push", std::string{}) == "momentary", "push: interaction == momentary");
        TEST_ASSERT(interactionByTypeId.value("switches.switch", std::string{}) == "toggle", "switch: interaction == toggle");
        TEST_ASSERT(interactionByTypeId.value("switches.switch_dip", std::string{}) == "toggle", "switch_dip: interaction == toggle");

#ifdef DEVICES_LIBRARY_JSON_PATH
        const std::filesystem::path libraryPath = DEVICES_LIBRARY_JSON_PATH;
        if (std::filesystem::exists(libraryPath)) {
            send("loadDeviceLibrary", {{"path", libraryPath.string()}});
            const nlohmann::json afterResp = send("getPropertySchemas", nlohmann::json::object());
            const nlohmann::json& afterSchemas = afterResp["payload"]["schemasByTypeId"];
            TEST_ASSERT(afterSchemas.contains("example.blinker"), "example.blinker (plugin) aparece depois de loadDeviceLibrary");
            TEST_ASSERT(afterSchemas.contains("passive.resistor"), "resistor (built-in) continua presente depois do loadDeviceLibrary");

            // Built-in agora também pode declarar tradução no Core -- pedir "en" resolve o grupo traduzido.
            const nlohmann::json enResp = send("getPropertySchemas", {{"language", "en"}});
            const nlohmann::json& enResistorSchema = enResp["payload"]["schemasByTypeId"]["passive.resistor"][0];
            TEST_ASSERT(enResistorSchema.value("group", std::string{}) == "Electrical", "resistor: language=en resolve group traduzido");
        } else {
            std::fprintf(stderr, "  [info] %s não existe -- pulando verificação pós-loadDeviceLibrary.\n", libraryPath.string().c_str());
        }
#endif

        send("shutdown", nlohmann::json::object());
        clientClose(conn);
    }

    serverThread.join();
    TEST_ASSERT(serverResult == 0, "servidor encerrou com codigo 0 apos shutdown");
}

// Teste 4f: setProperty via IPC valida tipo/faixa/nome com built-in e reflete errorCode estÃ¡vel.
// TambÃ©m cobre readOnly e requiresRestart via plugins reais/fixture quando os artefatos existem.
static void testSetPropertyValidationOverIpc() {
    std::fprintf(stderr, "\n[T4f] 'setProperty' via IPC valida tipo/faixa/nome e retorna errorCode estavel\n");

    const std::string pipeName = "lasecsimul-bootstrap-test-setproperty";
    int serverResult = -1;
    std::thread serverThread([&] {
        lasecsimul::app::CoreApplication app({pipeName});
        serverResult = app.run();
    });

#ifdef _WIN32
    void* conn = clientConnect(pipeName);
    TEST_ASSERT(conn != INVALID_HANDLE_VALUE, "cliente conectou");
#else
    int conn = clientConnect(pipeName);
    TEST_ASSERT(conn >= 0, "cliente conectou");
#endif

    if (
#ifdef _WIN32
        conn != INVALID_HANDLE_VALUE
#else
        conn >= 0
#endif
    ) {
        int nextId = 1;
        auto send = [&](const std::string& type, const nlohmann::json& payload) -> nlohmann::json {
            const nlohmann::json req = {{"id", std::to_string(nextId++)},
                                        {"type", type},
                                        {"payload", payload},
                                        {"protocolVersion", lasecsimul::ipc::PROTOCOL_VERSION}};
            clientWriteLine(conn, req.dump());
            return nlohmann::json::parse(clientReadLine(conn));
        };
        auto payloadString = [](const nlohmann::json& response, const char* key) -> std::string {
            if (!response.contains("payload") || !response["payload"].is_object()) return {};
            return response["payload"].value(key, std::string{});
        };
        auto payloadBool = [](const nlohmann::json& response, const char* key) -> bool {
            if (!response.contains("payload") || !response["payload"].is_object()) return false;
            return response["payload"].value(key, false);
        };

        send("hello", {{"clientVersion", "0.1.0"}});

        const std::string resistor =
            send("addComponent", {{"typeId", "passive.resistor"},
                                   {"properties", {{"resistance", 1000.0}}}})["payload"]["instanceId"];

        const nlohmann::json validResp =
            send("setProperty", {{"instanceId", resistor}, {"name", "resistance"}, {"value", 2200.0}});
        TEST_ASSERT(validResp.value("ok", false), "setProperty aceita valor valido no resistor built-in");

        const nlohmann::json wrongTypeResp =
            send("setProperty", {{"instanceId", resistor}, {"name", "resistance"}, {"value", "abc"}});
        TEST_ASSERT(!wrongTypeResp.value("ok", true), "setProperty rejeita tipo invalido");
        TEST_ASSERT(payloadString(wrongTypeResp, "errorCode") == "type_mismatch",
                    "errorCode=type_mismatch para tipo invalido");

        const nlohmann::json outOfRangeResp =
            send("setProperty", {{"instanceId", resistor}, {"name", "resistance"}, {"value", -5.0}});
        TEST_ASSERT(!outOfRangeResp.value("ok", true), "setProperty rejeita valor fora da faixa");
        TEST_ASSERT(payloadString(outOfRangeResp, "errorCode") == "out_of_range",
                    "errorCode=out_of_range para valor fora da faixa");

        const nlohmann::json unknownPropertyResp =
            send("setProperty", {{"instanceId", resistor}, {"name", "doesNotExist"}, {"value", 1.0}});
        TEST_ASSERT(!unknownPropertyResp.value("ok", true), "setProperty rejeita propriedade desconhecida");
        TEST_ASSERT(payloadString(unknownPropertyResp, "errorCode") == "unknown_property",
                    "errorCode=unknown_property para nome inexistente");

#ifdef DEVICES_LIBRARY_JSON_PATH
        const std::filesystem::path restartFixture = createRequiresRestartLibraryFixture();
        if (!restartFixture.empty()) {
            const nlohmann::json loadRestartResp = send("loadDeviceLibrary", {{"path", restartFixture.string()}});
            TEST_ASSERT(loadRestartResp.value("ok", false), "loadDeviceLibrary da fixture requiresRestart funciona");

            const nlohmann::json blinkerResp =
                send("addComponent", {{"typeId", "example.blinker.requires_restart"},
                                       {"properties", {{"periodMs", 500.0}}},
                                       {"pins", {{{"id", "out"}}, {{"id", "vcc"}}, {{"id", "gnd"}}}}});
            TEST_ASSERT(blinkerResp.value("ok", false), "addComponent da fixture requiresRestart funciona");
            if (blinkerResp.value("ok", false)) {
                const std::string blinker = blinkerResp["payload"]["instanceId"];
                const nlohmann::json restartResp =
                    send("setProperty", {{"instanceId", blinker}, {"name", "periodMs"}, {"value", 250.0}});
                TEST_ASSERT(restartResp.value("ok", false), "setProperty aplica mudanca em propriedade requiresRestart");
                TEST_ASSERT(payloadBool(restartResp, "requiresRestart"),
                            "payload.requiresRestart=true quando o schema declara a flag");
            }
        } else {
            const std::filesystem::path libraryPath = DEVICES_LIBRARY_JSON_PATH;
            if (std::filesystem::exists(libraryPath)) {
                send("loadDeviceLibrary", {{"path", libraryPath.string()}});
            } else {
                std::fprintf(stderr, "  [info] devices/library.json nao existe -- pulando plugins ABI.\n");
            }
            std::fprintf(stderr,
                         "  [info] artefato real do example-blinker nao existe -- pulando requiresRestart.\n");
        }
#endif

        send("shutdown", nlohmann::json::object());
        clientClose(conn);
    }

    serverThread.join();
    TEST_ASSERT(serverResult == 0, "servidor encerrou com codigo 0 apos shutdown");
}

// Teste 4: Core encerra com shutdown
static void testCoreShutdown() {
    std::fprintf(stderr, "\n[T4] Core encerra com mensagem 'shutdown'\n");

    const std::string pipeName = "lasecsimul-bootstrap-test-shutdown";
    int serverResult = -1;
    std::thread serverThread([&] {
        lasecsimul::app::CoreApplication app({pipeName});
        serverResult = app.run();
    });

#ifdef _WIN32
    void* conn = clientConnect(pipeName);
    TEST_ASSERT(conn != INVALID_HANDLE_VALUE, "cliente conectou");
#else
    int conn = clientConnect(pipeName);
    TEST_ASSERT(conn >= 0, "cliente conectou");
#endif

    if (
#ifdef _WIN32
        conn != INVALID_HANDLE_VALUE
#else
        conn >= 0
#endif
    ) {
        // Handshake
        const nlohmann::json hello = {
            {"id", "1"}, {"type", "hello"},
            {"payload", {{"clientVersion", "0.1.0"}}},
            {"protocolVersion", lasecsimul::ipc::PROTOCOL_VERSION}
        };
        clientWriteLine(conn, hello.dump());
        clientReadLine(conn);

        // Shutdown
        const nlohmann::json shutdown = {
            {"id", "2"}, {"type", "shutdown"},
            {"payload", nlohmann::json::object()},
            {"protocolVersion", lasecsimul::ipc::PROTOCOL_VERSION}
        };
        clientWriteLine(conn, shutdown.dump());
        const std::string rawResp = clientReadLine(conn);
        try {
            auto resp = nlohmann::json::parse(rawResp);
            TEST_ASSERT(resp.value("ok", false), "resposta shutdown ok == true");
        } catch (...) {
            TEST_ASSERT(false, "resposta shutdown é JSON válido");
        }
        clientClose(conn);
    }

    serverThread.join();
    TEST_ASSERT(serverResult == 0, "shutdown encerrou servidor com código 0");
}

// Integração temporal real: condição registrada pelo protocolo, avaliada pelo
// worker do Scheduler e devolvida como notificação assíncrona no mesmo pipe.
static void testPauseConditionNotificationOverIpc() {
    std::fprintf(stderr, "\n[T4g] condicao de pausa dispara notificacao IPC no passo do Core\n");
    const std::string pipeName = "lasecsimul-bootstrap-test-pause-condition";
    int serverResult = -1;
    std::thread serverThread([&] {
        lasecsimul::app::CoreApplication app({pipeName});
        serverResult = app.run();
    });
#ifdef _WIN32
    void* conn = clientConnect(pipeName);
    const bool connected = conn != INVALID_HANDLE_VALUE;
#else
    int conn = clientConnect(pipeName);
    const bool connected = conn >= 0;
#endif
    TEST_ASSERT(connected, "cliente conectou para teste de pausa");
    if (connected) {
        int nextId = 1;
        std::vector<nlohmann::json> notifications;
        auto send = [&](const std::string& type, const nlohmann::json& payload) {
            const std::string id = std::to_string(nextId++);
            clientWriteLine(conn, nlohmann::json{{"id",id},{"type",type},{"payload",payload},
                {"protocolVersion",lasecsimul::ipc::PROTOCOL_VERSION}}.dump());
            for (;;) {
                const nlohmann::json message = nlohmann::json::parse(clientReadLine(conn));
                if (message.contains("id") && message.value("id", std::string{}) == id) return message;
                notifications.push_back(message);
            }
        };
        send("hello", {{"clientVersion","0.1.0"}});
        send("addComponent", {{"typeId","sources.clock"},{"instanceName","CLK"},
            {"properties",{{"freqHz",1000.0},{"voltage",5.0},{"alwaysOn",true}}}});
        const nlohmann::json condition = send("setPauseCondition", {{"ownerId","analyzer"},{"expression","rising(CLK.out)"}});
        if (!condition.value("ok", false)) std::fprintf(stderr, "  [info] rejeicao: %s\n", condition.dump().c_str());
        TEST_ASSERT(condition.value("ok", false), "Core aceita e compila a condicao pelo IPC");
        send("start", nlohmann::json::object());

        // O start pode responder antes da notificacao. Uma requisicao sincronizadora
        // posterior permite consumir qualquer notificacao que tenha sido enfileirada.
        for (int attempt = 0; attempt < 20 && notifications.empty(); ++attempt) {
            std::this_thread::sleep_for(std::chrono::milliseconds(10));
            send("getSimulationTime", nlohmann::json::object());
        }
        const auto triggered = std::find_if(notifications.begin(), notifications.end(), [](const nlohmann::json& n) {
            return n.value("type", std::string{}) == "pauseConditionTriggered";
        });
        TEST_ASSERT(triggered != notifications.end(), "Core envia pauseConditionTriggered sem polling da UI");
        if (triggered != notifications.end()) {
            TEST_ASSERT((*triggered)["payload"].value("ownerId", std::string{}) == "analyzer", "evento preserva ownerId");
            TEST_ASSERT((*triggered)["payload"].value("simulationTimeNs", uint64_t{0}) > 0, "evento informa instante simulado exato");
        }
        send("shutdown", nlohmann::json::object());
        clientClose(conn);
    }
    serverThread.join();
    TEST_ASSERT(serverResult == 0, "servidor encerrou apos teste de pausa");
}

// ── main ───────────────────────────────────────────────────────────────────────

int main() {
    std::fprintf(stderr, "=== CoreBootstrapTest ===\n");
    testSessionCreatesEmpty();
    testCoreApplicationConstructs();
    testCoreAcceptsHello();
    testGetComponentStateOverIpc();
    testGetNodeVoltageOverIpc();
    testGetComponentCurrentOverIpc();
    testRegisterAdhocSubcircuitOverIpc();
    testSimulideComplexAbiEventsOverIpc();
    testGetPropertySchemasOverIpc();
    testSetPropertyValidationOverIpc();
    testPauseConditionNotificationOverIpc();
    testCoreShutdown();

    if (failures == 0) {
        std::fprintf(stderr, "\nTodos os testes passaram.\n");
        return 0;
    }
    std::fprintf(stderr, "\n%d teste(s) FALHARAM.\n", failures);
    return 1;
}
