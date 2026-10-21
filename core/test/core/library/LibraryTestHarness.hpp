#pragma once
// Harness dos testes da biblioteca de blocos equivalente ao Simulink (docs/66): blocos `sl.*` no
// caminho REAL da sessao (`addComponent`/`connectWire`, larguras e tempos herdados resolvidos pela
// materializacao). Os testes comparam com referencias ANALITICAS (ou com a definicao documentada
// pela MathWorks), nunca com o proprio engine.
#include <cmath>
#include <cstdio>
#include <functional>
#include <initializer_list>
#include <memory>
#include <stdexcept>
#include <string>
#include <utility>

#include "components/blocks/LibraryBlock.hpp"
#include "components/control/SignalConstant.hpp"
#include "plugins/GlobalPluginCache.hpp"
#include "session/SimulationSession.hpp"

namespace library_test {

using lasecsimul::PropertyValue;
using lasecsimul::registry::ComponentParams;

inline int failures = 0;

inline void check(bool ok, const std::string& label) {
    if (ok) std::printf("OK: %s\n", label.c_str());
    else { std::fprintf(stderr, "FALHOU: %s\n", label.c_str()); ++failures; }
}

/** |a - b| <= tol, com rotulo mostrando os dois valores. */
inline void expectNear(double actual, double expected, double tol, const std::string& label) {
    const bool ok = (std::isnan(expected) && std::isnan(actual)) || (std::isinf(expected) && actual == expected) || std::abs(actual - expected) <= tol;
    check(ok, label + " (obtido " + std::to_string(actual) + ", esperado " + std::to_string(expected) + ")");
}

inline PropertyValue text(const char* value) { return PropertyValue{std::string(value)}; }
inline PropertyValue text(const std::string& value) { return PropertyValue{value}; }

struct Harness {
    lasecsimul::plugins::GlobalPluginCache cache;
    lasecsimul::session::SimulationSession session{cache};
    uint64_t now = 0;
    Harness() {
        for (const lasecsimul::components::blocks::BlockSpec& spec : lasecsimul::components::blocks::blockLibrary())
            session.components().registerFactory(spec.typeId, [&spec](const ComponentParams& p) {
                return std::make_unique<lasecsimul::components::blocks::LibraryBlock>(spec, p);
            });
        session.components().registerFactory(lasecsimul::components::SignalConstant::kTypeId, [](const ComponentParams& p) {
            return std::make_unique<lasecsimul::components::SignalConstant>(p);
        });
    }
    /** Adiciona `sl.<block>` com as propriedades dadas (texto como no dialogo do Simulink). */
    uint32_t add(const std::string& block, std::initializer_list<std::pair<const char*, PropertyValue>> properties = {}) {
        ComponentParams params;
        for (const auto& [name, value] : properties) params.properties[name] = value;
        return session.addComponent("sl." + block, params);
    }
    void wire(uint32_t from, const char* fromPort, uint32_t to, const char* toPort) { session.connectWire(from, fromPort, to, toPort); }
    void runUntil(double seconds) { now = static_cast<uint64_t>(std::llround(seconds * 1e9)); session.scheduler().runUntil(now); }
    double value(uint32_t component, const char* port = "out1", uint16_t element = 0) {
        return session.signalRuntime().real(session.signalRuntime().output(lasecsimul::signalPortBlockId(component, port)), element);
    }
};

/** Executa `body` esperando que a montagem/compilacao do diagrama falhe (erro de parametro/largura). */
inline bool fails(const std::function<void()>& body) {
    try { body(); } catch (const std::exception&) { return true; }
    return false;
}

inline int finish(const char* suite) {
    if (failures == 0) std::printf("%s: todos os testes passaram\n", suite);
    else std::fprintf(stderr, "%s: %d falha(s)\n", suite, failures);
    return failures == 0 ? 0 : 1;
}

} // namespace library_test
