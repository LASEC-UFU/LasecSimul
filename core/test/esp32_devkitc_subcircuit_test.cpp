// Valida o subcircuito REAL `subcircuits/esp32_devkitc_v4.lssubcircuit` (não um exemplo sintético
// como subcircuit_test.cpp) -- carrega o arquivo de verdade, registra o adaptador ESP32 REAL via
// plugin (mcu-adapters/espressif-esp32/), expande a instância, e prova eletricamente que:
//   1. Pinos GPIO expostos (ex: "G23") realmente chegam no McuComponent dentro do subcircuito.
//   2. As três referências de GND ("GND1"/"GND2"/"GND3") compartilham o mesmo nó (mesmo
//      `other.ground` interno) -- ver subcircuits/esp32_devkitc_v4.lssubcircuit.
//   3. As trilhas "3V3"/"5V" entregam a tensão configurada via `sources.fixed_volt`.
// Pula (sai com 0) se o adapter.dll do plugin ESP32 não estiver compilado ainda.
#include <cmath>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <memory>
#include <nlohmann/json.hpp>
#include "components/SimulideBuiltins.hpp"
#include "components/active/DiodeLegArray.hpp"
#include "components/connectors/Tunnel.hpp"
#include <unordered_set>
#include <unordered_map>
#include "components/other/Ground.hpp"
#include "components/passive/Resistor.hpp"
#include "components/sources/FixedVolt.hpp"
#include "components/sources/Rail.hpp"
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
    // Trilhos 3V3/5V do próprio esp32_devkitc_v4.lssubcircuit real usam "sources.rail" (não
    // "sources.fixed_volt") -- faltava aqui, causando "Unknown component typeId: sources.rail" (uma
    // exceção não capturada por main(), std::terminate()/abort() -- o "0xc0000409" que aparecia no
    // ctest é só o código de saída padrão do MSVC/UCRT pra abort() sem handler SEH, não um buffer
    // overflow real). Mesma factory de CoreApplication.cpp::registerBuiltinComponents.
    components.registerFactory("sources.rail", [](const ComponentParams& p) {
        const auto pos = p.pins<1>();
        return std::make_unique<components::Rail>(Pin{pos[0].id.empty() ? "out" : pos[0].id, pos[0].x, pos[0].y},
                                                    p.property("voltage", 5.0));
    });
    // DevKitC real usa pull-up (passive.resistor) e os botões EN/BOOT (switches.push) -- mesmas
    // factories de CoreApplication.cpp::registerBuiltinComponents, versão mínima só com o que o
    // teste eletricamente precisa (sem metadata, que é só pro catálogo da Extension).
    components.registerFactory("passive.resistor", [](const ComponentParams& p) {
        const auto pos = p.pins<2>();
        return std::make_unique<components::Resistor>(
            std::array<Pin, 2>{Pin{pos[0].id.empty() ? "p1" : pos[0].id, pos[0].x, pos[0].y},
                                Pin{pos[1].id.empty() ? "p2" : pos[1].id, pos[1].x, pos[1].y}},
            p.property("resistance", 1000.0));
    });
    components.registerFactory("switches.push", [](const ComponentParams& p) {
        std::vector<Pin> pins;
        pins.reserve(2);
        for (size_t i = 0; i < 2; ++i) {
            Pin pin = i < p.pinList.size() ? p.pinList[i] : Pin{};
            if (pin.id.empty()) pin.id = "pin-" + std::to_string(i + 1);
            pins.push_back(std::move(pin));
        }
        return std::make_unique<components::SimulideSwitch>("switches.push", std::move(pins),
                                                              p.property("closed", false),
                                                              p.property("normallyClosed", false));
    });
    // DevKitC real também tem uma barra de LED (outputs.led_bar) -- faltava aqui pela mesma razão
    // documentada acima pro "sources.rail" (registro mínimo deste teste nunca foi atualizado quando
    // o typeId passou a aparecer no `.lssubcircuit` real). Mesma classe/modelo elétrico de
    // `CoreApplication.cpp` (auditoria de dispositivos 2026-07-13, `DiodeLegArray` com o par P/N por
    // LED já resolvido em `p.pinList` -- não precisa do `ComponentPinSpec` dinâmico aqui, o
    // subcircuito real já vem com os pinos concretos).
    components.registerFactory("outputs.led_bar", [](const ComponentParams& p) {
        // `p.pinList[i].id` vem vazio quando o `.lssubcircuit` real não embute id por pino em
        // `properties` (o de-facto comum -- o catálogo/`ComponentPinSpec` é quem deriva o id
        // "pin-P{i}"/"pin-N{i}" de verdade em CoreApplication.cpp, ver `ledBarPinSpec`). Faltava essa
        // mesma derivação aqui -- SEM ela os fios do `.lssubcircuit` (que referenciam "pin-P1" etc)
        // nunca batiam com o id real do pino, achado da auditoria de dispositivos 2026-07-13.
        std::vector<Pin> pins = p.pinList;
        const size_t size = pins.size() / 2;
        for (size_t i = 0; i < size; ++i) {
            pins[i].id = "pin-P" + std::to_string(i + 1);
            pins[size + i].id = "pin-N" + std::to_string(i + 1);
        }
        std::vector<components::DiodeLegArray::Leg> legs;
        legs.reserve(size);
        for (size_t i = 0; i < size; ++i) legs.push_back({i, size + i});
        return std::make_unique<components::DiodeLegArray>("outputs.led_bar", std::move(pins), std::move(legs));
    });
}

// Mesmo mapeamento de campos que CoreApplication.cpp::loadSubcircuitLibraryFile -- mantido em
// sincronia manualmente (lógica trivial, ver lá para o original).
SubcircuitDefinition parseLssubJson(const std::filesystem::path& path) {
    std::ifstream file(path);
    if (!file) throw std::runtime_error("manifesto de subcircuito (.lssubcircuit) não encontrado: " + path.string());
    nlohmann::json manifest;
    file >> manifest;

    SubcircuitDefinition def;
    def.typeId = manifest.value("typeId", std::string{});
    def.name = manifest.value("name", def.typeId);
    def.packageJson = manifest.contains("package") ? manifest["package"].dump() : "{}";

    // Manifesto canônico v2 (ver ProjectTypes.ts::ProjectTopology) move os fios pra
    // `topology.conductors[]` -- endpoints usam `{kind:"port"|"node", ...}` em vez de
    // `{componentId,pinId}` direto, e junções viram `topology.nodes[]` em vez de componentes
    // `connectors.junction`. Sem esta branch, `manifest["wires"]` simplesmente não existe no
    // arquivo migrado e este parser silenciosamente registra ZERO fios (regressão real: fez
    // 3V3/5V/EN do esp32_devkitc_v4.lssubcircuit flutuarem, só GND sobrevivia por ser unido via
    // nome de túnel, não por fio) -- mesma branch de CoreApplication.cpp::registerSubcircuitFromManifestRich.
    const bool canonicalTopology = manifest.contains("topology") && manifest["topology"].is_object();

    std::unordered_set<std::string> topologyNodes;
    for (const auto& compJson : manifest["components"]) {
        SubcircuitComponentDef comp;
        comp.id = compJson.value("id", std::string{});
        comp.typeId = compJson.value("typeId", std::string{});
        comp.propertiesJson = compJson.contains("properties") ? compJson["properties"].dump() : "{}";
        if (comp.typeId == "connectors.junction") topologyNodes.insert(comp.id);
        else def.components.push_back(std::move(comp));
    }
    if (canonicalTopology) {
        for (const auto& nodeJson : manifest["topology"].value("nodes", nlohmann::json::array()))
            topologyNodes.insert(nodeJson.value("id", std::string{}));
    }
    const auto endpointComponentId = [](const nlohmann::json& endpoint) {
        return endpoint.value("kind", std::string{}) == "node" ? endpoint.value("nodeId", std::string{})
                                                                 : endpoint.value("componentId", std::string{});
    };
    const auto endpointPinId = [](const nlohmann::json& endpoint) {
        return endpoint.value("kind", std::string{}) == "node" ? std::string{"pin-1"} : endpoint.value("pinId", std::string{});
    };
    const nlohmann::json& wiresJson = canonicalTopology ? manifest["topology"]["conductors"] : manifest["wires"];
    for (const auto& wireJson : wiresJson) {
        SubcircuitWireDef wire;
        wire.fromComponentId = endpointComponentId(wireJson.at("from"));
        wire.fromPinId = endpointPinId(wireJson.at("from"));
        wire.toComponentId = endpointComponentId(wireJson.at("to"));
        wire.toPinId = endpointPinId(wireJson.at("to"));
        def.wires.push_back(std::move(wire));
    }
    if (!topologyNodes.empty()) {
        constexpr char sep = '\x1f';
        const auto key = [sep](const std::string& component, const std::string& pin) { return component + std::string(1, sep) + pin; };
        std::unordered_map<std::string, std::vector<std::string>> adjacency;
        for (const auto& wire : def.wires) {
            const auto a = key(wire.fromComponentId, wire.fromPinId); const auto b = key(wire.toComponentId, wire.toPinId);
            adjacency[a].push_back(b); adjacency[b].push_back(a);
        }
        std::unordered_set<std::string> visited; std::vector<SubcircuitWireDef> flattened;
        for (const auto& [start, unused] : adjacency) {
            (void)unused; if (visited.contains(start)) continue;
            std::vector<std::string> stack{start}; visited.insert(start); std::vector<std::pair<std::string, std::string>> ports;
            while (!stack.empty()) {
                auto current = std::move(stack.back()); stack.pop_back(); const auto split = current.find(sep);
                auto component = current.substr(0, split); auto pin = current.substr(split + 1);
                if (!topologyNodes.contains(component)) ports.emplace_back(std::move(component), std::move(pin));
                for (const auto& next : adjacency[current]) if (visited.insert(next).second) stack.push_back(next);
            }
            for (size_t i = 1; i < ports.size(); ++i) flattened.push_back({ports[0].first, ports[0].second, ports[i].first, ports[i].second});
        }
        def.wires = std::move(flattened);
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

// Corpo real do teste, isolado de main() só para poder envolver tudo num try/catch -- uma exceção
// não capturada (ex: "Unknown component typeId") vira std::terminate()/abort() sem nenhuma
// mensagem útil, só um código de saída opaco do SO (ex: 0xc0000409 no Windows, que parece um buffer
// overflow real de /GS mas é só o sinal padrão de abort() sem handler SEH -- já nos custou uma
// investigação inteira por causa disso).
int runTest() {
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
    TEST_ASSERT(std::filesystem::exists(manifestPath), "esp32_devkitc_v4.lssubcircuit existe no repositório");
    session.subcircuits().registerDefinition(parseLssubJson(manifestPath));

    const SubcircuitExpansionResult expansion = session.addSubcircuitInstance("subcircuits.esp32_devkitc_v4");
    TEST_ASSERT(expansion.exposedPins.size() == 38, "38 pinos expostos (2x19 header da DevKitC V4)");
    TEST_ASSERT(expansion.exposedPins.count("G23") == 1, "pino G23 (GPIO23) exposto");
    TEST_ASSERT(expansion.exposedPins.count("GND1") == 1 && expansion.exposedPins.count("GND2") == 1 &&
                    expansion.exposedPins.count("GND3") == 1,
                "GND1/GND2/GND3 todos expostos");
    TEST_ASSERT(expansion.exposedPins.count("3V3") == 1 && expansion.exposedPins.count("5V") == 1,
                "trilhas 3V3 e 5V expostas");
    TEST_ASSERT(expansion.exposedPins.count("EN") == 1, "pino EN exposto");

    for (int i = 0; i < 200 && session.settleStep(); ++i) {}

    const auto& gnd1 = expansion.exposedPins.at("GND1");
    const auto& gnd2 = expansion.exposedPins.at("GND2");
    const auto& rail3v3 = expansion.exposedPins.at("3V3");
    const auto& rail5v = expansion.exposedPins.at("5V");
    const auto& en = expansion.exposedPins.at("EN");

    TEST_ASSERT(session.nodeVoltageOfPin(en.instanceId, en.pinId) > 3.0,
                "EN em repouso (pull-up, botão solto) fica em ~3.3V -- mcu1.RST liberado, chip roda");

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
        TEST_ASSERT(std::filesystem::exists(wroomManifestPath), "esp32_wroom32.lssubcircuit existe no repositório");
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

int main() {
    try {
        return runTest();
    } catch (const std::exception& e) {
        std::fprintf(stderr, "FALHOU: exceção não tratada -- %s\n", e.what());
        return 1;
    }
}
