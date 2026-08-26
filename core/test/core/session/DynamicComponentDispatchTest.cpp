// Prova que SimulationSession::advanceDynamicComponentsUnlocked de fato despacha postStep() pra
// componentes com isDynamic()==true -- antes desta correção, IComponentModel::postStep() era pura
// virtual mas NENHUM caminho de produção a chamava (só PluginRuntimeTest, ao nível de ABI direto,
// sem passar por um SimulationSession real). Isso deixava rolagem de hardware do SSD1306 (comandos
// 0x26-0x2F) e animação de servo (devices/simulide-complex/src/lib.c) mortas silenciosamente. Ver
// IComponentModel.hpp::isDynamic() e SimulationSession::advanceDynamicComponentsUnlocked.
#include <cstdio>
#include <vector>
#include "lasecsimul/Types.hpp"
#include "plugins/GlobalPluginCache.hpp"
#include "session/SimulationSession.hpp"

using namespace lasecsimul;
using namespace lasecsimul::session;

namespace {

int failures = 0;

void check(bool ok, const char* label) {
    if (ok) std::printf("OK: %s\n", label);
    else {
        std::fprintf(stderr, "FALHOU: %s\n", label);
        failures++;
    }
}

/** Sem pino/eletrica nenhuma -- só grava cada postStep() recebido, pra isolar exatamente a
 * cadencia e o valor de dt_ns que a sessao entrega. */
class FakeDynamicComponent final : public IComponentModel {
public:
    const char* typeId() const override { return "test.fake_dynamic"; }
    std::span<Pin> pins() override { return {}; }
    void stamp(MnaMatrixView&) override {}
    bool isDynamic() const override { return true; }
    void postStep(uint64_t deltaNs) override { calls.push_back(deltaNs); }
    size_t getState(uint8_t*, size_t) const override { return 0; }
    void setState(const uint8_t*, size_t) override {}
    std::vector<PropertyDescriptor> propertyDescriptors() override { return {}; }

    std::vector<uint64_t> calls;
};

/** Mesma classe, mas isDynamic()==false (default) -- prova que o filtro realmente exclui quem nao
 * optou, nao so que quem optou e chamado. */
class FakeStaticComponent final : public IComponentModel {
public:
    const char* typeId() const override { return "test.fake_static"; }
    std::span<Pin> pins() override { return {}; }
    void stamp(MnaMatrixView&) override {}
    void postStep(uint64_t deltaNs) override { calls.push_back(deltaNs); }
    size_t getState(uint8_t*, size_t) const override { return 0; }
    void setState(const uint8_t*, size_t) override {}
    std::vector<PropertyDescriptor> propertyDescriptors() override { return {}; }

    std::vector<uint64_t> calls;
};

void testDynamicComponentReceivesPostStepAtBoundedCadence() {
    plugins::GlobalPluginCache cache;
    SimulationSession session(cache);

    FakeDynamicComponent* dynamicPtr = nullptr;
    session.components().registerFactory("test.fake_dynamic", [&dynamicPtr](const registry::ComponentParams&) {
        auto instance = std::make_unique<FakeDynamicComponent>();
        dynamicPtr = instance.get();
        return instance;
    });
    FakeStaticComponent* staticPtr = nullptr;
    session.components().registerFactory("test.fake_static", [&staticPtr](const registry::ComponentParams&) {
        auto instance = std::make_unique<FakeStaticComponent>();
        staticPtr = instance.get();
        return instance;
    });

    session.addComponent("test.fake_dynamic", {});
    session.addComponent("test.fake_static", {});
    for (int i = 0; i < 5 && session.settleStep(); ++i) {}

    // Um unico avanco de 5ms (< 1 tick de 16.666667ms) nao deve disparar postStep ainda --
    // exatamente o comportamento que evita a tempestade de threads do PluginWatchdog (ver
    // comentario de advanceDynamicComponentsUnlocked): despachar a cada passo MNA aceito, que sob
    // passo adaptativo pode acontecer em microssegundos, chamaria postStep() com dt quase zero
    // centenas/milhares de vezes por segundo.
    session.scheduler().step(5'000'000);
    check(dynamicPtr->calls.empty(), "sem postStep antes de acumular 1 tick de 60Hz (~16.67ms)");

    // Mais 15ms fecha os ~16.67ms do tick -- exatamente 1 chamada, com o total acumulado (nao o
    // ultimo delta), igual ao contrato que simulide-complex/src/lib.c ja assume (`elapsed_ns +=
    // dt_ns`).
    session.scheduler().step(15'000'000);
    check(dynamicPtr->calls.size() == 1, "exatamente 1 postStep ao cruzar o tick de 60Hz");
    if (!dynamicPtr->calls.empty()) {
        check(dynamicPtr->calls[0] >= 16'666'667ull, "dt entregue e o ACUMULADO (>= 1 tick), nao o ultimo delta de 15ms");
    }
    check(staticPtr->calls.empty(), "componente sem isDynamic() nunca recebe postStep");

    // Um avanco maior (50ms) e' subdividido pelo Scheduler adaptativo em varios passos aceitos
    // internos -- a cadencia de postStep() deve continuar limitada a ~60Hz (nem uma chamada por
    // passo MNA aceito, que seria uma tempestade de threads do PluginWatchdog; nem uma chamada so
    // pro avanco inteiro, que atrasaria demais a animacao sob um avanco grande).
    const size_t callsBeforeLongStep = dynamicPtr->calls.size();
    session.scheduler().step(50'000'000);
    const size_t newCalls = dynamicPtr->calls.size() - callsBeforeLongStep;
    check(newCalls >= 2 && newCalls <= 4, "cadencia de postStep continua limitada a ~60Hz num avanco maior (2-4 chamadas em 50ms)");
    for (size_t i = callsBeforeLongStep; i < dynamicPtr->calls.size(); ++i) {
        // 16'666'667ns: mesma constante de tick de 60Hz que SimulationSession.cpp usa (kDynamicComponentTickNs),
        // duplicada aqui de proposito -- este teste nao tem acesso ao simbolo anonymous-namespace do .cpp.
        check(dynamicPtr->calls[i] >= 16'666'667ull, "cada lote entrega pelo menos 1 tick acumulado, nunca um dt minusculo");
    }
}

} // namespace

int main() {
    testDynamicComponentReceivesPostStepAtBoundedCadence();
    if (failures == 0) {
        std::printf("OK: componentes dinamicos recebem postStep() da SimulationSession.\n");
        return 0;
    }
    std::fprintf(stderr, "FALHAS: %d\n", failures);
    return 1;
}
