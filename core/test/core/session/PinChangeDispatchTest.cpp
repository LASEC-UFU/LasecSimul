// Teste da detecção de borda digital no settleStep(): quando um nó cruza kDigitalThreshold, o
// Core dispara ComponentEvent{kPinChangeEventTag,...} pra todo IComponentModel com um pino naquele
// nó -- ESTA é a infraestrutura que faltava pra que devices (plugins ou built-ins) decodifiquem
// protocolos bit a bit (I2C/SPI/1-wire) a partir de transições reais de pino, em vez do antigo
// I2cBusModule/SpiBusModule (removidos -- ver .spec/archive/legacy-v2/lasecsimul-native-devices.spec, seção 8: nunca
// chegaram a ser ligados num SimulationSession real).
#include <cstdio>
#include <vector>
#include "components/sources/VoltSource.hpp"
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

/** Só grava todo ComponentEvent recebido -- sem eletrica nenhuma, pra isolar exatamente o que o
 * Core decidiu disparar. */
class FakeListener final : public IComponentModel {
public:
    explicit FakeListener(Pin pin) : m_pin(std::move(pin)) {}

    const char* typeId() const override { return "test.fake_listener"; }
    std::span<Pin> pins() override { return {&m_pin, 1}; }
    void stamp(MnaMatrixView&) override {}
    void postStep(uint64_t) override {}
    void onEvent(const ComponentEvent& event) override { events.push_back(event); }
    size_t getState(uint8_t*, size_t) const override { return 0; }
    void setState(const uint8_t*, size_t) override {}
    std::vector<PropertyDescriptor> propertyDescriptors() override { return {}; }

    std::vector<ComponentEvent> events;

private:
    Pin m_pin;
};

void testDigitalEdgeDispatchesPinChangeToListener() {
    plugins::GlobalPluginCache cache;
    SimulationSession session(cache);

    session.components().registerFactory("sources.voltage_source", [](const registry::ComponentParams& p) {
        return std::make_unique<components::VoltSource>(Pin{"out"}, p.property("value", 0.0), p.property("minValue", 0.0),
                                                         p.property("maxValue", 10.0));
    });
    FakeListener* listenerPtr = nullptr;
    session.components().registerFactory("test.fake_listener", [&listenerPtr](const registry::ComponentParams&) {
        auto instance = std::make_unique<FakeListener>(Pin{"in"});
        listenerPtr = instance.get();
        return instance;
    });

    registry::ComponentParams driverParams;
    driverParams.properties["value"] = 0.0;
    driverParams.properties["minValue"] = 0.0;
    driverParams.properties["maxValue"] = 10.0;
    const uint32_t driver = session.addComponent("sources.voltage_source", driverParams);
    const uint32_t listener = session.addComponent("test.fake_listener", {});
    session.connectWire(driver, "out", listener, "in");

    for (int i = 0; i < 20 && session.settleStep(); ++i) {}
    check(listenerPtr->events.empty(), "nenhum PIN_CHANGE antes de qualquer borda (nó nasce em 0V, abaixo do limiar)");

    session.setProperty(driver, "value", PropertyValue{5.0});
    for (int i = 0; i < 20 && session.settleStep(); ++i) {}
    check(listenerPtr->events.size() == 1, "exatamente 1 evento disparado ao cruzar pra 5V (acima do limiar de 2.5V)");
    if (!listenerPtr->events.empty()) {
        const ComponentEvent& ev = listenerPtr->events.back();
        check(ev.tag == kPinChangeEventTag, "tag == kPinChangeEventTag");
        check(ev.a == 0, "a == 0 (índice local do único pino do listener, \"in\")");
        check(ev.b == 1, "b == 1 (nível alto)");
    }

    session.scheduler().step(1000); // avança o relógio simulado pra c (ns desde a borda) não ficar em 0
    session.setProperty(driver, "value", PropertyValue{0.0});
    for (int i = 0; i < 20 && session.settleStep(); ++i) {}
    check(listenerPtr->events.size() == 2, "exatamente 1 evento novo disparado ao cruzar de volta pra 0V");
    if (listenerPtr->events.size() >= 2) {
        const ComponentEvent& ev = listenerPtr->events.back();
        check(ev.b == 0, "b == 0 (nível baixo) na borda de descida");
        check(ev.c >= 1000, "c (ns desde a borda anterior) reflete o tempo simulado avançado");
    }

    session.setProperty(driver, "value", PropertyValue{1.0});
    for (int i = 0; i < 20 && session.settleStep(); ++i) {}
    check(listenerPtr->events.size() == 2, "mudar de 0V pra 1V (sem cruzar o limiar de 2.5V) NÃO dispara evento novo");
}

} // namespace

int main() {
    testDigitalEdgeDispatchesPinChangeToListener();

    if (failures == 0) {
        std::printf("\nTodos os testes de PinChangeDispatch passaram.\n");
        return 0;
    }
    std::fprintf(stderr, "\n%d teste(s) FALHARAM.\n", failures);
    return 1;
}
