// Regressão da auditoria "pente fino" (2026-07-08): portas NAND/NOR/NOT/XNOR eram inconstruíveis
// (devices/simulide-logic/src/lib.c só tinha AND/OR/XOR/Buffer, sem flag de inversão -- mesma
// arquitetura do SimulIDE real, "Inverted Outs" na MESMA porta). Prova que active.and_gate (typeId
// real: logic.and_gate) com properties.inverted=true vira NAND de verdade via o DLL/SO REAL do
// plugin (não uma vtable sintética) -- mesmo padrão de esp32_devkitc_subcircuit_test.cpp. Pula
// (exit 0) se o artefato ainda não foi compilado (`npm run build:devices`).
#include <cstdio>
#include <filesystem>
#include <initializer_list>
#include <memory>
#include <string>
#include "components/other/Ground.hpp"
#include "components/sources/FixedVolt.hpp"
#include "plugins/GlobalPluginCache.hpp"
#include "session/SimulationSession.hpp"

using namespace lasecsimul;
using namespace lasecsimul::registry;
using namespace lasecsimul::plugins;
using namespace lasecsimul::session;

namespace {

int failures = 0;
#define CHECK(expr, msg) \
    do { \
        if (!(expr)) { \
            std::fprintf(stderr, "  FALHOU: %s -- %s\n", msg, #expr); \
            failures++; \
        } else { \
            std::fprintf(stderr, "  OK: %s\n", msg); \
        } \
    } while (false)

void registerCommon(ComponentRegistry& c) {
    c.registerFactory("sources.fixed_volt", [](const ComponentParams& p) {
        return std::make_unique<components::FixedVolt>(Pin{"out"}, p.property("voltage", 5.0),
                                                         p.property("out", true));
    });
    c.registerFactory("other.ground", [](const ComponentParams&) {
        return std::make_unique<components::Ground>(Pin{"pin"});
    });
}

ComponentParams withVoltage(double v) {
    ComponentParams p;
    p.properties["voltage"] = v;
    p.properties["out"] = true;
    return p;
}

// Constrói uma porta AND (typeId real logic.and_gate) com in1/in2 fixos e lê "out" -- `inverted`
// controla AND vs NAND.
// Sem `other.ground` -- `sources.fixed_volt`/a saída do gate (`drive_volts` real do plugin) já se
// referenciam sozinhos à terra IMPLÍCITA do solver (mesma técnica de `Rail`, ver FixedVolt.hpp) --
// um `other.ground` explícito aqui competiria pelo MESMO nó da fonte, dando uma tensão errada
// (média ponderada de dois estampos de tensão ideal conflitantes, não 0V nem 5V).
double andGateOutput(SimulationSession& session, std::initializer_list<bool> inputs, bool inverted) {
    const uint32_t inputCount = static_cast<uint32_t>(inputs.size());
    ComponentParams gateParams;
    gateParams.properties["inputs"] = static_cast<double>(inputCount);
    gateParams.properties["inverted"] = inverted;
    // `registerKnownPluginTypes()` usa `params.pinList` direto pra `ComponentMeta::pins` (sem o
    // fallback sintético que `makePinVector` dá aos built-ins) -- sem chamar o carregador real de
    // `.lsdevice` (linkage interna em `CoreApplication.cpp`, como sempre nestes testes), os pinos
    // precisam vir explícitos aqui, mesmos ids do manifesto real (`and_gate.lsdevice`).
    gateParams.pinList = {Pin{"out"}, Pin{"in1"}, Pin{"in2"}};
    for (uint32_t i = 3; i <= inputCount; ++i) gateParams.pinList.push_back(Pin{"in" + std::to_string(i)});
    const uint32_t gate = session.addComponent("logic.and_gate", gateParams);

    uint32_t index = 1;
    for (const bool value : inputs) {
        const uint32_t src = session.addComponent("sources.fixed_volt", withVoltage(value ? 5.0 : 0.0));
        session.connectWire(src, "out", gate, "in" + std::to_string(index));
        index++;
    }

    for (int i = 0; i < 20; ++i) {
        if (!session.settleStep()) break;
    }
    return session.nodeVoltageOfPin(gate, "out");
}

} // namespace

int main() {
    std::fprintf(stderr, "=== LogicGatePluginTest ===\n");

#ifndef SIMULIDE_LOGIC_DLL_PATH
#error "SIMULIDE_LOGIC_DLL_PATH precisa ser definido pelo CMakeLists"
#endif
    const std::filesystem::path dllPath = SIMULIDE_LOGIC_DLL_PATH;
    if (!std::filesystem::exists(dllPath)) {
        std::fprintf(stderr, "PULADO: %s não existe -- rode 'npm run build:devices' antes deste teste.\n",
                     dllPath.string().c_str());
        return 0;
    }

    try {
        GlobalPluginCache cache;
        std::shared_ptr<PluginModule> module = cache.loader().loadDevicePlugin(dllPath);
        cache.setActiveDeviceModule("logic.and_gate", module);

        SimulationSession session(cache);
        registerCommon(session.components());
        session.registerKnownPluginTypes();

        const double vAndHH = andGateOutput(session, {true, true}, false);
        CHECK(vAndHH > 2.5, "AND(1,1) = HIGH (comportamento normal preservado)");

        SimulationSession session2(cache);
        registerCommon(session2.components());
        session2.registerKnownPluginTypes();
        const double vNandHH = andGateOutput(session2, {true, true}, true);
        CHECK(vNandHH < 2.5, "AND(1,1) com inverted=true (NAND) = LOW (0V, oposto do AND normal)");

        SimulationSession session3(cache);
        registerCommon(session3.components());
        session3.registerKnownPluginTypes();
        const double vNandHL = andGateOutput(session3, {true, false}, true);
        CHECK(vNandHL > 2.5, "NAND(1,0) = HIGH (só NAND(1,1) é LOW)");
        SimulationSession session4(cache);
        registerCommon(session4.components());
        session4.registerKnownPluginTypes();
        const double vAnd3 = andGateOutput(session4, {true, true, true}, false);
        CHECK(vAnd3 > 2.5, "AND de 3 entradas com inputs=3 = HIGH quando todas as entradas estao HIGH");

        SimulationSession session5(cache);
        registerCommon(session5.components());
        session5.registerKnownPluginTypes();
        const double vAnd3Low = andGateOutput(session5, {true, true, false}, false);
        CHECK(vAnd3Low < 2.5, "AND de 3 entradas com inputs=3 = LOW quando uma entrada esta LOW");
    } catch (const std::exception& e) {
        std::fprintf(stderr, "FALHOU: exceção não tratada -- %s\n", e.what());
        return 1;
    }

    if (failures == 0) {
        std::fprintf(stderr, "\nTodos os testes passaram.\n");
        return 0;
    }
    std::fprintf(stderr, "\n%d teste(s) FALHARAM.\n", failures);
    return 1;
}
