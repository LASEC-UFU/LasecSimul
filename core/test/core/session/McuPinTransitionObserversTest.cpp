// Regra de SimulationSession::refreshMcuPinTransitionObserversUnlocked() (mcu_abi.h 3.1): um pino de
// MCU só dispensa as bordas por bit quando nada no seu nó depende delas -- além do próprio pino,
// apenas túneis e o RX de um LasecPlot servido pelo tap byte-exato desse mesmo pino. Adaptador e
// componentes de teste, sem QEMU/plugin nativo: isola a decisão de topologia; o comportamento do
// frame sem bordas no adaptador real é coberto por Esp32AdapterTest.
#include <cstdio>
#include <cstdlib>
#include <map>
#include <memory>
#include <string>
#include <vector>
#include "lasecsimul/IMcuAdapter.hpp"
#include "lasecsimul/QemuModule.hpp"
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

void setFrameModeEnv(const char* value) {
#if defined(_WIN32)
    _putenv_s("LASECSIMUL_UART_TX_FRAME_MODE", value ? value : "");
#else
    if (value) setenv("LASECSIMUL_UART_TX_FRAME_MODE", value, 1);
    else unsetenv("LASECSIMUL_UART_TX_FRAME_MODE");
#endif
}

/** USART 0 com TX (linha 1) dirigido e tap byte-exato, como o módulo do ESP32. */
class FakeUsartModule final : public QemuModule {
public:
    FakeUsartModule() : QemuModule(ModuleKind::Usart, 0, 0x1000, 0x1FFF) {}
    void writeRegister(uint64_t, uint64_t) override {}
    uint64_t readRegister(uint64_t) override { return 0; }
    bool isOutputEnabled(uint32_t line) const override { return line == 1; }
    bool hasWireTap() const override { return true; }
};

using Observed = std::map<uint32_t, bool>;

/** Pinos: 0 = "TX" (USART, com tap), 1 = "RX" (USART), 2 = "GPIO5" (GPIO, sem tap). */
class FakeUartMcuAdapter final : public IMcuAdapter {
public:
    explicit FakeUartMcuAdapter(std::shared_ptr<Observed> observed) : m_observed(std::move(observed)) {}
    const char* chipId() const override { return "test.fake_uart_mcu"; }
    QemuLaunchSpec buildLaunchArgs(std::string_view) const override { return {}; }
    std::span<const MemoryRegion> memoryRegions() const override { return {}; }
    std::span<const PinMapping> pinMap() const override { return m_pinMap; }
    std::vector<std::unique_ptr<QemuModule>> createModules() const override {
        std::vector<std::unique_ptr<QemuModule>> modules;
        modules.push_back(std::make_unique<FakeUsartModule>());
        return modules;
    }
    void setPinTransitionsObserved(uint32_t pinIndex, bool observed) override { (*m_observed)[pinIndex] = observed; }

private:
    std::shared_ptr<Observed> m_observed;
    std::vector<PinMapping> m_pinMap{PinMapping{"TX", ModuleKind::Usart, 0, 1},
                                     PinMapping{"RX", ModuleKind::Usart, 0, 0},
                                     PinMapping{"GPIO5", ModuleKind::Gpio, 0, 5}};
};

/** Componente inerte com typeId e pinos configuráveis: o que está sob teste é só a topologia. */
class FakeComponent final : public IComponentModel {
public:
    FakeComponent(const char* typeId, std::vector<Pin> pins) : m_typeId(typeId), m_pins(std::move(pins)) {}
    const char* typeId() const override { return m_typeId; }
    std::span<Pin> pins() override { return m_pins; }
    void stamp(MnaMatrixView&) override {}
    void postStep(uint64_t) override {}
    size_t getState(uint8_t*, size_t) const override { return 0; }
    void setState(const uint8_t*, size_t) override {}
    std::vector<PropertyDescriptor> propertyDescriptors() override { return {}; }

private:
    const char* m_typeId;
    std::vector<Pin> m_pins;
};

struct Fixture {
    plugins::GlobalPluginCache cache;
    SimulationSession session{cache};
    std::shared_ptr<Observed> observed = std::make_shared<Observed>();
    uint32_t mcu = 0;

    Fixture() {
        session.mcus().registerFactory("test.fake_uart_mcu", [observed = observed] {
            return std::make_unique<FakeUartMcuAdapter>(observed);
        });
        for (const char* typeId : {"peripherals.lasecplot", "connectors.tunnel", "meters.probe"}) {
            session.components().registerFactory(typeId, [typeId](const registry::ComponentParams&) {
                if (std::string(typeId) == "peripherals.lasecplot") {
                    return std::make_unique<FakeComponent>(typeId, std::vector<Pin>{Pin{"tx"}, Pin{"rx"}});
                }
                return std::make_unique<FakeComponent>(typeId, std::vector<Pin>{Pin{"pin"}});
            });
        }
        mcu = session.addComponent("test.fake_uart_mcu", {});
    }

    bool publishedObserved(uint32_t pin) {
        observed->clear();
        session.publishSimulationPlan();
        const auto it = observed->find(pin);
        return it == observed->end() || it->second;
    }
};

void testLasecPlotServedByTapIsNotAnObserver() {
    Fixture f;
    const uint32_t plot = f.session.addComponent("peripherals.lasecplot", {});
    const uint32_t tunnel = f.session.addComponent("connectors.tunnel", {});
    f.session.connectWire(f.mcu, "TX", tunnel, "pin");
    f.session.connectWire(tunnel, "pin", plot, "rx");
    check(!f.publishedObserved(0), "TX com apenas tunel e RX de LasecPlot servido pelo tap: sem observador");
    check(!(*f.observed)[2], "pino sem nenhuma conexao: sem observador");
}

void testProbeOnTheNodeObservesTransitions() {
    Fixture f;
    const uint32_t plot = f.session.addComponent("peripherals.lasecplot", {});
    const uint32_t probe = f.session.addComponent("meters.probe", {});
    f.session.connectWire(f.mcu, "TX", plot, "rx");
    f.session.connectWire(f.mcu, "TX", probe, "pin");
    check(f.publishedObserved(0), "ponta de prova no no do TX mantem o caminho bit-a-bit");
}

void testLasecPlotWithoutTapObservesTransitions() {
    Fixture f;
    const uint32_t plot = f.session.addComponent("peripherals.lasecplot", {});
    f.session.connectWire(f.mcu, "GPIO5", plot, "rx");
    check(f.publishedObserved(2), "LasecPlot em pino sem tap depende do decodificador eletrico");
}

void testLasecPlotTransmitterOnTheNodeObservesTransitions() {
    Fixture f;
    const uint32_t plot = f.session.addComponent("peripherals.lasecplot", {});
    f.session.connectWire(f.mcu, "TX", plot, "tx");
    check(f.publishedObserved(0), "TX do LasecPlot no mesmo no nao e' um receptor servido pelo tap");
}

void testLoopbackToOwnReceiverObservesTransitions() {
    Fixture f;
    f.session.connectWire(f.mcu, "TX", f.mcu, "RX");
    check(f.publishedObserved(0), "TX ligado ao RX da propria MCU mantem o caminho bit-a-bit");
}

void testEnvironmentForcesBitLevel() {
    Fixture f;
    const uint32_t plot = f.session.addComponent("peripherals.lasecplot", {});
    f.session.connectWire(f.mcu, "TX", plot, "rx");
    setFrameModeEnv("bit");
    const bool forced = f.publishedObserved(0);
    setFrameModeEnv(nullptr);
    check(forced, "LASECSIMUL_UART_TX_FRAME_MODE=bit forca o caminho bit-a-bit");
}

} // namespace

int main() {
    testLasecPlotServedByTapIsNotAnObserver();
    testProbeOnTheNodeObservesTransitions();
    testLasecPlotWithoutTapObservesTransitions();
    testLasecPlotTransmitterOnTheNodeObservesTransitions();
    testLoopbackToOwnReceiverObservesTransitions();
    testEnvironmentForcesBitLevel();
    if (failures) {
        std::fprintf(stderr, "%d teste(s) FALHARAM.\n", failures);
        return 1;
    }
    std::printf("OK: observadores de transicao por pino de MCU.\n");
    return 0;
}
