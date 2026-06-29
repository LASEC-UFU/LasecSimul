// Valida o subcircuito REAL `subcircuits/esp32_devkitc_v4.lssub.json` (não um exemplo sintético
// como subcircuit_test.cpp) -- carrega o arquivo de verdade, registra o adaptador ESP32 REAL via
// plugin (mcu-adapters/espressif-esp32/), expande a instância, e prova eletricamente que:
//   1. Pinos GPIO expostos (ex: "G23") realmente chegam no McuComponent dentro do subcircuito.
//   2. As três referências de GND ("GND1"/"GND2"/"GND3") compartilham o mesmo nó (mesmo
//      `other.ground` interno) -- ver subcircuits/esp32_devkitc_v4.lssub.json.
//   3. As trilhas "3V3"/"5V" entregam a tensão configurada via `sources.fixed_volt`.
// Pula (sai com 0) se o adapter.dll do plugin ESP32 não estiver compilado ainda.
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <memory>
#include <nlohmann/json.hpp>
#include "components/connectors/Tunnel.hpp"
#include "components/other/Ground.hpp"
#include "components/sources/FixedVolt.hpp"
#include "plugins/GlobalPluginCache.hpp"
#include "registry/SubcircuitRegistry.hpp"
#include "session/SimulationSession.hpp"

using namespace lasecsimul;
using namespace lasecsimul::registry;
using namespace lasecsimul::plugins;
using namespace lasecsimul::session;

namespace {

int failures = 0;

#define TEST_ASSERT(expr, msg) \
    do { \
        if (!(expr)) { \
            std::fprintf(stderr, "  FALHOU: %s -- %s\n", msg, #expr); \
            failures++; \
        } else { \
            std::fprintf(stderr, "  OK: %s\n", msg); \
        } \
    } while (false)

void registerNeededBuiltins(ComponentRegistry& components) {
    components.registerFactory("connectors.tunnel", [](const ComponentParams&) {
        return std::make_unique<components::Tunnel>(Pin{"pin"});
    });
    components.registerFactory("other.ground", [](const ComponentParams&) {
        return std::make_unique<components::Ground>(Pin{"pin"});
    });
    components.registerFactory("sources.fixed_volt", [](const ComponentParams& p) {
        return std::make_unique<components::FixedVolt>(Pin{"out"}, p.property("voltage", 5.0),
                                                         p.property("out", true));
    });
}

// Mesmo mapeamento de campos que CoreApplication.cpp::loadSubcircuitLibraryFile -- mantido em
// sincronia manualmente (lógica trivial, ver lá para o original).
SubcircuitDefinition parseLssubJson(const std::filesystem::path& path) {
    std::ifstream file(path);
    if (!file) throw std::runtime_error(".lssub.json não encontrado: " + path.string());
    nlohmann::json manifest;
    file >> manifest;

    SubcircuitDefinition def;
    def.typeId = manifest.value("typeId", std::string{});
    def.name = manifest.value("name", def.typeId);
    def.packageJson = manifest.contains("package") ? manifest["package"].dump() : "{}";

    for (const auto& compJson : manifest["components"]) {
        SubcircuitComponentDef comp;
        comp.id = compJson.value("id", std::string{});
        comp.typeId = compJson.value("typeId", std::string{});
        comp.propertiesJson = compJson.contains("properties") ? compJson["properties"].dump() : "{}";
        def.components.push_back(std::move(comp));
    }
    for (const auto& wireJson : manifest["wires"]) {
        SubcircuitWireDef wire;
        wire.fromComponentId = wireJson["from"].value("componentId", std::string{});
        wire.fromPinId = wireJson["from"].value("pinId", std::string{});
        wire.toComponentId = wireJson["to"].value("componentId", std::string{});
        wire.toPinId = wireJson["to"].value("pinId", std::string{});
        def.wires.push_back(std::move(wire));
    }
    for (const auto& ifaceJson : manifest["interface"]) {
        SubcircuitInterfaceDef iface;
        iface.pinId = ifaceJson.value("pinId", std::string{});
        iface.label = ifaceJson.value("label", iface.pinId);
        iface.internalTunnel = ifaceJson.value("internalTunnel", std::string{});
        def.interfaceDefs.push_back(std::move(iface));
    }
    return def;
}

} // namespace

int main() {
    std::fprintf(stderr, "=== Esp32DevkitcSubcircuitTest ===\n");

#ifndef ESP32_ADAPTER_DLL_PATH
#error "ESP32_ADAPTER_DLL_PATH precisa ser definido pelo CMakeLists (caminho do adapter.dll real)"
#endif
    const std::filesystem::path dllPath = ESP32_ADAPTER_DLL_PATH;
    if (!std::filesystem::exists(dllPath)) {
        std::fprintf(stderr,
                      "PULADO: %s não existe -- rode 'npm run build:mcu-adapters' antes deste teste.\n",
                      dllPath.string().c_str());
        return 0;
    }

    GlobalPluginCache cache;
    std::shared_ptr<PluginModule> module = cache.loader().loadMcuPlugin(dllPath);
    cache.setActiveMcuModule("espressif.esp32", module);

    SimulationSession session(cache);
    registerNeededBuiltins(session.components());
    session.registerKnownMcuTypes();
    // Reproduz o cenário real: a Extension chama "loadDeviceLibrary" uma vez por library.json
    // (devices/, mcu-adapters/, subcircuits/), e o handler chama registerKnownMcuTypes() no FINAL
    // de cada chamada -- ou seja, esta função é chamada mais de uma vez por sessão sempre que há
    // mais de um library.json. Precisa ser idempotente (replaceFactory, não registerFactory).
    session.registerKnownMcuTypes();

    const std::filesystem::path manifestPath =
        std::filesystem::path(LSSUB_MANIFEST_PATH);
    TEST_ASSERT(std::filesystem::exists(manifestPath), "esp32_devkitc_v4.lssub.json existe no repositório");
    session.subcircuits().registerDefinition(parseLssubJson(manifestPath));

    const SubcircuitExpansionResult expansion = session.addSubcircuitInstance("subcircuits.esp32_devkitc_v4");
    TEST_ASSERT(expansion.exposedPins.size() == 38, "38 pinos expostos (2x19 header da DevKitC V4)");
    TEST_ASSERT(expansion.exposedPins.count("G23") == 1, "pino G23 (GPIO23) exposto");
    TEST_ASSERT(expansion.exposedPins.count("GND1") == 1 && expansion.exposedPins.count("GND2") == 1 &&
                    expansion.exposedPins.count("GND3") == 1,
                "GND1/GND2/GND3 todos expostos");
    TEST_ASSERT(expansion.exposedPins.count("3V3") == 1 && expansion.exposedPins.count("5V") == 1,
                "trilhas 3V3 e 5V expostas");
    TEST_ASSERT(expansion.exposedPins.count("EN") == 1, "pino EN exposto (decorativo, sem conexão elétrica)");

    for (int i = 0; i < 5 && session.settleStep(); ++i) {}

    const auto& gnd1 = expansion.exposedPins.at("GND1");
    const auto& gnd2 = expansion.exposedPins.at("GND2");
    const auto& rail3v3 = expansion.exposedPins.at("3V3");
    const auto& rail5v = expansion.exposedPins.at("5V");

    TEST_ASSERT(std::abs(session.nodeVoltageOfPin(rail3v3.instanceId, rail3v3.pinId) - 3.3) < 0.05,
                "trilha 3V3 entrega 3.3V de verdade");
    TEST_ASSERT(std::abs(session.nodeVoltageOfPin(rail5v.instanceId, rail5v.pinId) - 5.0) < 0.05,
                "trilha 5V entrega 5.0V de verdade");
    TEST_ASSERT(std::abs(session.nodeVoltageOfPin(gnd1.instanceId, gnd1.pinId) -
                          session.nodeVoltageOfPin(gnd2.instanceId, gnd2.pinId)) < 1e-6,
                "GND1 e GND2 são o mesmo nó elétrico (0V)");

    // Leitura de registrador real (ENABLE+OUT via arena do plugin) já é coberta por
    // McuComponentTest.cpp/Esp32AdapterTest.cpp -- este teste foca no que é específico do
    // SUBCIRCUITO: mapeamento de pino público -> McuComponent interno, e os nós GND/3V3/5V
    // compartilhados, que não existem em nenhum dos outros dois testes.

    // ── ESP32-WROOM-32 (módulo, sem placa/USB/EN-BOOT físicos -- sem pino "5V") ──────────────────
    // Sessão separada de propósito: cada SimulationSession tem seu próprio McuRegistry/
    // SubcircuitRegistry, evita qualquer dúvida sobre reaproveitamento de estado entre os dois
    // subcircuitos (mesmo princípio de isolamento que duas instâncias reais teriam).
    {
        GlobalPluginCache wroomCache;
        std::shared_ptr<PluginModule> wroomModule = wroomCache.loader().loadMcuPlugin(dllPath);
        wroomCache.setActiveMcuModule("espressif.esp32", wroomModule);

        SimulationSession wroomSession(wroomCache);
        registerNeededBuiltins(wroomSession.components());
        wroomSession.registerKnownMcuTypes();

        const std::filesystem::path wroomManifestPath = std::filesystem::path(WROOM32_LSSUB_MANIFEST_PATH);
        TEST_ASSERT(std::filesystem::exists(wroomManifestPath), "esp32_wroom32.lssub.json existe no repositório");
        wroomSession.subcircuits().registerDefinition(parseLssubJson(wroomManifestPath));

        const SubcircuitExpansionResult wroomExpansion = wroomSession.addSubcircuitInstance("subcircuits.esp32_wroom32");
        TEST_ASSERT(wroomExpansion.exposedPins.size() == 38, "WROOM-32: 38 pinos expostos (14+14+10)");
        TEST_ASSERT(wroomExpansion.exposedPins.count("SVP") == 1 && wroomExpansion.exposedPins.count("SVN") == 1,
                    "WROOM-32: SVP/SVN (sensor ADC1, GPIO36/GPIO39) expostos");
        TEST_ASSERT(wroomExpansion.exposedPins.count("5V") == 0, "WROOM-32: não tem pino 5V (só DevKitC tem)");
        TEST_ASSERT(wroomExpansion.exposedPins.count("NC") == 1, "WROOM-32: pino NC exposto (decorativo)");
        TEST_ASSERT(wroomExpansion.exposedPins.count("GND1") == 1 && wroomExpansion.exposedPins.count("GND2") == 1 &&
                        wroomExpansion.exposedPins.count("GND3") == 1,
                    "WROOM-32: GND1/GND2/GND3 todos expostos");

        for (int i = 0; i < 5 && wroomSession.settleStep(); ++i) {}

        const auto& wroomGnd1 = wroomExpansion.exposedPins.at("GND1");
        const auto& wroomGnd3 = wroomExpansion.exposedPins.at("GND3");
        const auto& wroomRail3v3 = wroomExpansion.exposedPins.at("3v3");
        TEST_ASSERT(std::abs(wroomSession.nodeVoltageOfPin(wroomRail3v3.instanceId, wroomRail3v3.pinId) - 3.3) < 0.05,
                    "WROOM-32: pino 3v3 entrega 3.3V de verdade");
        TEST_ASSERT(std::abs(wroomSession.nodeVoltageOfPin(wroomGnd1.instanceId, wroomGnd1.pinId) -
                              wroomSession.nodeVoltageOfPin(wroomGnd3.instanceId, wroomGnd3.pinId)) < 1e-6,
                    "WROOM-32: GND1 e GND3 são o mesmo nó elétrico (0V)");
    }

    if (failures == 0) {
        std::fprintf(stderr, "\nTodos os testes passaram.\n");
        return 0;
    }
    std::fprintf(stderr, "\n%d teste(s) FALHARAM.\n", failures);
    return 1;
}
