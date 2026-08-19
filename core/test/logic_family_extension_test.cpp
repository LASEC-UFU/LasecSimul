// Cobertura da familia adicionada em devices/simulide-logic pra fechar a lacuna de
// aritmetica/plexers frente ao Logisim Evolution (varredura 2026-08-18, ver
// .spec/features/workspace-navigation.md FEAT-011). Mesmo padrao de logic_gate_plugin_test.cpp:
// carrega o DLL/SO REAL do plugin via GlobalPluginCache e roda o solver de verdade -- prova que
// bits_in/bits_out/read_level dos novos stamp_* leem os pinos certos na ordem declarada no
// .lsdevice, nao so que o C compilou. Cobre as formas de codigo mais arriscadas de erro de
// indice de pino (aritmetica bits_in/bits_out, decode com enable, scan de prioridade); pula
// (exit 0) se o artefato ainda nao foi compilado (`npm run build:devices`).
#include <cstdint>
#include <cstdio>
#include <filesystem>
#include <initializer_list>
#include <string>
#include <vector>
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

// Cria uma instancia do typeId com os pinos EXPLICITOS (mesma razao de logic_gate_plugin_test.cpp:
// este harness sintetico nao carrega o .lsdevice real), amarra cada bit de `inputIds` a uma fonte
// fixa (MSB->LSB conforme a ordem da lista) e devolve as tensoes lidas em `outputIds` na mesma
// ordem.
std::vector<double> runDevice(SimulationSession& session, const std::string& typeId,
                               const std::vector<std::string>& inputIds, const std::vector<bool>& inputValues,
                               const std::vector<std::string>& outputIds,
                               const ComponentParams* extraProperties = nullptr) {
    ComponentParams params;
    if (extraProperties) params = *extraProperties;
    for (const std::string& id : inputIds) params.pinList.push_back(Pin{id});
    for (const std::string& id : outputIds) params.pinList.push_back(Pin{id});
    const uint32_t dev = session.addComponent(typeId, params);

    for (size_t i = 0; i < inputIds.size(); ++i) {
        const uint32_t src = session.addComponent("sources.fixed_volt", withVoltage(inputValues[i] ? 5.0 : 0.0));
        session.connectWire(src, "out", dev, inputIds[i]);
    }

    for (int i = 0; i < 20; ++i) {
        if (!session.settleStep()) break;
    }

    std::vector<double> result;
    result.reserve(outputIds.size());
    for (const std::string& id : outputIds) result.push_back(session.nodeVoltageOfPin(dev, id));
    return result;
}

uint32_t bitsOf(const std::vector<double>& voltages) {
    uint32_t value = 0;
    for (size_t i = 0; i < voltages.size(); ++i) {
        if (voltages[i] > 2.5) value |= (1u << i);
    }
    return value;
}

} // namespace

int main() {
    std::fprintf(stderr, "=== LogicFamilyExtensionTest ===\n");

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
        for (const char* typeId : {"logic.subtractor", "logic.multiplier", "logic.divider", "logic.decoder",
                                    "logic.priority_encoder", "logic.bit_selector", "logic.negator", "logic.minmax",
                                    "logic.shifter", "logic.absolute", "logic.bit_adder"}) {
            cache.setActiveDeviceModule(typeId, module);
        }

        // Subtractor: A=0,B=1,BI=0 -> emprestimo de B (D=1, BO=1).
        {
            SimulationSession session(cache);
            registerCommon(session.components());
            session.registerKnownPluginTypes();
            const auto out = runDevice(session, "logic.subtractor", {"a", "b", "bin"}, {false, true, false},
                                        {"diff", "bout"});
            CHECK(out[0] > 2.5 && out[1] > 2.5, "Subtractor 0-1: diff=1, borrow=1");
        }
        {
            SimulationSession session(cache);
            registerCommon(session.components());
            session.registerKnownPluginTypes();
            const auto out = runDevice(session, "logic.subtractor", {"a", "b", "bin"}, {true, true, false},
                                        {"diff", "bout"});
            CHECK(out[0] < 2.5 && out[1] < 2.5, "Subtractor 1-1: diff=0, borrow=0");
        }

        // Multiplier: 3 x 5 = 15 (0011 x 0101 -> 00001111).
        {
            SimulationSession session(cache);
            registerCommon(session.components());
            session.registerKnownPluginTypes();
            const std::vector<bool> a3 = {true, true, false, false};  // a0..a3 = 3
            const std::vector<bool> b5 = {true, false, true, false};  // b0..b3 = 5
            std::vector<bool> inputs = a3;
            inputs.insert(inputs.end(), b5.begin(), b5.end());
            const auto out = runDevice(session, "logic.multiplier", {"a0", "a1", "a2", "a3", "b0", "b1", "b2", "b3"},
                                        inputs, {"p0", "p1", "p2", "p3", "p4", "p5", "p6", "p7"});
            CHECK(bitsOf(out) == 15u, "Multiplier 3*5=15");
        }

        // Divider: 13 / 4 = quociente 3, resto 1 (1101 / 0100).
        {
            SimulationSession session(cache);
            registerCommon(session.components());
            session.registerKnownPluginTypes();
            const std::vector<bool> a13 = {true, false, true, true};
            const std::vector<bool> b4 = {false, false, true, false};
            std::vector<bool> inputs = a13;
            inputs.insert(inputs.end(), b4.begin(), b4.end());
            const auto out = runDevice(session, "logic.divider", {"a0", "a1", "a2", "a3", "b0", "b1", "b2", "b3"},
                                        inputs, {"q0", "q1", "q2", "q3", "r0", "r1", "r2", "r3"});
            const uint32_t q = bitsOf({out[0], out[1], out[2], out[3]});
            const uint32_t r = bitsOf({out[4], out[5], out[6], out[7]});
            CHECK(q == 3u && r == 1u, "Divider 13/4 = quociente 3, resto 1");
        }
        {
            SimulationSession session(cache);
            registerCommon(session.components());
            session.registerKnownPluginTypes();
            const auto out = runDevice(session, "logic.divider", {"a0", "a1", "a2", "a3", "b0", "b1", "b2", "b3"},
                                        {true, false, true, false, false, false, false, false},
                                        {"q0", "q1", "q2", "q3", "r0", "r1", "r2", "r3"});
            const uint32_t q = bitsOf({out[0], out[1], out[2], out[3]});
            CHECK(q == 15u, "Divider por zero satura quociente em 1111 (sem crash)");
        }

        // Decoder 3-para-8: sel=101 (5), en=1 -> somente y5 em HIGH.
        {
            SimulationSession session(cache);
            registerCommon(session.components());
            session.registerKnownPluginTypes();
            const auto out = runDevice(
                session, "logic.decoder", {"s0", "s1", "s2", "en"}, {true, false, true, true},
                {"y0", "y1", "y2", "y3", "y4", "y5", "y6", "y7"});
            CHECK(bitsOf(out) == (1u << 5), "Decoder sel=5,en=1 -> somente y5 ativo");
        }
        {
            SimulationSession session(cache);
            registerCommon(session.components());
            session.registerKnownPluginTypes();
            const auto out = runDevice(
                session, "logic.decoder", {"s0", "s1", "s2", "en"}, {true, false, true, false},
                {"y0", "y1", "y2", "y3", "y4", "y5", "y6", "y7"});
            CHECK(bitsOf(out) == 0u, "Decoder com en=0 -> todas as saidas em LOW");
        }

        // Priority encoder: entradas i3 e i6 ativas -> vence i6 (indice mais alto), a=110, gs=1.
        {
            SimulationSession session(cache);
            registerCommon(session.components());
            session.registerKnownPluginTypes();
            const auto out = runDevice(session, "logic.priority_encoder",
                                        {"i0", "i1", "i2", "i3", "i4", "i5", "i6", "i7"},
                                        {false, false, false, true, false, false, true, false},
                                        {"a0", "a1", "a2", "gs"});
            const uint32_t idx = bitsOf({out[0], out[1], out[2]});
            CHECK(idx == 6u && out[3] > 2.5, "Priority encoder: i6 vence sobre i3, gs=1");
        }
        {
            SimulationSession session(cache);
            registerCommon(session.components());
            session.registerKnownPluginTypes();
            const auto out = runDevice(session, "logic.priority_encoder",
                                        {"i0", "i1", "i2", "i3", "i4", "i5", "i6", "i7"},
                                        {false, false, false, false, false, false, false, false},
                                        {"a0", "a1", "a2", "gs"});
            CHECK(out[3] < 2.5, "Priority encoder sem entradas ativas -> gs=0");
        }

        // Bit selector: byte 0xA5 (10100101), G=1 seleciona o nibble alto (1010).
        {
            SimulationSession session(cache);
            registerCommon(session.components());
            session.registerKnownPluginTypes();
            const auto out = runDevice(session, "logic.bit_selector",
                                        {"in0", "in1", "in2", "in3", "in4", "in5", "in6", "in7", "g"},
                                        {true, false, true, false, false, true, false, true, true},
                                        {"out0", "out1", "out2", "out3"});
            CHECK(bitsOf(out) == 0xAu, "Bit selector G=1 extrai nibble alto (0xA5 -> 0xA)");
        }

        // Negator: complemento de dois de 5 (00000101) = 251 (11111011).
        {
            SimulationSession session(cache);
            registerCommon(session.components());
            session.registerKnownPluginTypes();
            const auto out = runDevice(session, "logic.negator",
                                        {"d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7"},
                                        {true, false, true, false, false, false, false, false},
                                        {"q0", "q1", "q2", "q3", "q4", "q5", "q6", "q7"});
            CHECK(bitsOf(out) == 251u, "Negator: -5 em 8 bits (complemento de dois) = 251");
        }

        // Shifter: D=0x03 (00000011), amt=2, dir=0 (esquerda) -> 0x0C (00001100).
        {
            SimulationSession session(cache);
            registerCommon(session.components());
            session.registerKnownPluginTypes();
            ComponentParams props;
            props.properties["arithmetic"] = false;
            const auto out = runDevice(session, "logic.shifter",
                                        {"d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7", "s0", "s1", "s2", "dir"},
                                        {true, true, false, false, false, false, false, false, false, true, false, false},
                                        {"q0", "q1", "q2", "q3", "q4", "q5", "q6", "q7"}, &props);
            CHECK(bitsOf(out) == 0x0Cu, "Shifter 0x03 << 2 (logico) = 0x0C");
        }
        // Shifter: D=0x80 (bit7=1), amt=1, dir=1 (direita), arithmetic=true -> sign-extend = 0xC0.
        {
            SimulationSession session(cache);
            registerCommon(session.components());
            session.registerKnownPluginTypes();
            ComponentParams props;
            props.properties["arithmetic"] = true;
            const auto out = runDevice(session, "logic.shifter",
                                        {"d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7", "s0", "s1", "s2", "dir"},
                                        {false, false, false, false, false, false, false, true, true, false, false, true},
                                        {"q0", "q1", "q2", "q3", "q4", "q5", "q6", "q7"}, &props);
            CHECK(bitsOf(out) == 0xC0u, "Shifter 0x80 >> 1 aritmetico (sign-extend) = 0xC0");
        }

        // Absolute: entrada 251 (-5 em complemento de dois) -> |−5| = 5.
        {
            SimulationSession session(cache);
            registerCommon(session.components());
            session.registerKnownPluginTypes();
            const auto out = runDevice(session, "logic.absolute", {"d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7"},
                                        {true, true, false, true, true, true, true, true}, // 251 = 0xFB
                                        {"q0", "q1", "q2", "q3", "q4", "q5", "q6", "q7"});
            CHECK(bitsOf(out) == 5u, "Absolute(-5) = 5");
        }

        // Bit adder (popcount): 0xA5 (10100101) tem 4 bits em 1.
        {
            SimulationSession session(cache);
            registerCommon(session.components());
            session.registerKnownPluginTypes();
            const auto out = runDevice(session, "logic.bit_adder", {"d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7"},
                                        {true, false, true, false, false, true, false, true},
                                        {"c0", "c1", "c2", "c3"});
            CHECK(bitsOf(out) == 4u, "Bit adder popcount(0xA5) = 4");
        }

        // MinMax: A=9 (1001), B=3 (1100 -> 0011 lsb-first) -> min=3, max=9.
        {
            SimulationSession session(cache);
            registerCommon(session.components());
            session.registerKnownPluginTypes();
            const auto out = runDevice(session, "logic.minmax", {"a0", "a1", "a2", "a3", "b0", "b1", "b2", "b3"},
                                        {true, false, false, true, true, true, false, false},
                                        {"min0", "min1", "min2", "min3", "max0", "max1", "max2", "max3"});
            const uint32_t mn = bitsOf({out[0], out[1], out[2], out[3]});
            const uint32_t mx = bitsOf({out[4], out[5], out[6], out[7]});
            CHECK(mn == 3u && mx == 9u, "MinMax(9,3) -> min=3, max=9");
        }
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
