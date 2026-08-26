// Prova que SimulationSession::resolveI2cTransferUnlocked resolve a topologia corretamente pro
// fast path de I2C (docs/39-i2c-mttcg-throughput-ceiling-2026-08-26.md secao 9): acha o pino SDA
// via IMcuAdapter::resolveI2cPinIndex (chip-especifico), acha o no eletrico via
// Netlist/topologia (chip-neutro), e so' usa o fast path quando todo componente no mesmo no' e'
// I2C-capaz ou de um tipo explicitamente transparente (resistor/tunel) -- caso contrario cai
// pro caminho eletrico (handled=false). Usa um IMcuAdapter e um IComponentModel de teste, sem
// QEMU/plugin nativo real -- isola exatamente a logica de roteamento que esta sessao adicionou
// O contrato de mailbox QEMU/Core é validado separadamente em QemuArenaBridgeTest.
#include <cstdio>
#include <array>
#include <optional>
#include "lasecsimul/IMcuAdapter.hpp"
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

/** Pino 0 = "sda", pino 1 = "scl" -- resolveI2cPinIndex(bus=0,...) sempre devolve esses indices
 * fixos (sem GPIO matrix de verdade: o objetivo aqui e' testar SimulationSession, nao o adaptador
 * concreto do ESP32, ja' validado por compilacao + inspecao). Qualquer bus != 0 devolve nullopt,
 * pra provar que "chip sem roteamento pra este barramento" cai pro fallback como documentado. */
class FakeMcuAdapter final : public IMcuAdapter {
public:
    const char* chipId() const override { return "test.fake_mcu"; }
    QemuLaunchSpec buildLaunchArgs(std::string_view) const override { return {}; }
    std::span<const MemoryRegion> memoryRegions() const override { return {}; }
    std::span<const PinMapping> pinMap() const override { return m_pinMap; }
    std::vector<std::unique_ptr<QemuModule>> createModules() const override { return {}; }
    std::optional<uint32_t> resolveI2cPinIndex(uint32_t bus, bool sda) const override {
        if (bus != 0) return std::nullopt;
        return sda ? 0u : 1u;
    }

private:
    std::vector<PinMapping> m_pinMap{PinMapping{"sda", ModuleKind::Gpio, 0, 0},
                                     PinMapping{"scl", ModuleKind::Gpio, 0, 1}};
};

/** Componente I2C-capaz de teste: confirma endereco 0x42, devolve um byte fixo em leitura, grava
 * o ultimo payload de escrita recebido (pra provar que o transfer chegou intacto). */
class FakeI2cDevice final : public IComponentModel {
public:
    explicit FakeI2cDevice(Pin) {}

    const char* typeId() const override { return "test.fake_i2c_device"; }
    std::span<Pin> pins() override { return m_pins; }
    void stamp(MnaMatrixView&) override {}
    void postStep(uint64_t) override {}
    bool supportsI2cTransfer() const override { return true; }
    std::optional<uint32_t> i2cPinIndex(bool sda) const override { return sda ? 0u : 1u; }
    I2cTransferResult transferI2c(const I2cTransfer& transfer) override {
        I2cTransferResult result{};
        result.handled = true;
        result.firstNack = UINT32_MAX;
        if (transfer.address != 0x42) return result; // addressAck fica false -- NACK real.
        result.addressAck = true;
        if (transfer.read) {
            result.rxSize = 1;
            if (transfer.rxData && transfer.rxSize > 0) transfer.rxData[0] = 0xAB;
        } else {
            lastWriteSize = transfer.txSize;
            if (transfer.txSize > 0) lastWriteByte = transfer.txData[0];
        }
        return result;
    }
    size_t getState(uint8_t*, size_t) const override { return 0; }
    void setState(const uint8_t*, size_t) override {}
    std::vector<PropertyDescriptor> propertyDescriptors() override { return {}; }

    uint32_t lastWriteSize = 0;
    uint8_t lastWriteByte = 0;

private:
    std::array<Pin, 2> m_pins{Pin{"sda"}, Pin{"scl"}};
};

/** Sem `supportsI2cTransfer` nem tipo transparente -- representa "qualquer coisa desconhecida no
 * mesmo no'" (capacitor, componente ativo sem suporte, etc.) que deve forcar fallback. */
class FakeOpaqueComponent final : public IComponentModel {
public:
    explicit FakeOpaqueComponent(Pin pin) : m_pin(std::move(pin)) {}
    const char* typeId() const override { return "test.fake_opaque"; }
    std::span<Pin> pins() override { return {&m_pin, 1}; }
    void stamp(MnaMatrixView&) override {}
    void postStep(uint64_t) override {}
    size_t getState(uint8_t*, size_t) const override { return 0; }
    void setState(const uint8_t*, size_t) override {}
    std::vector<PropertyDescriptor> propertyDescriptors() override { return {}; }

private:
    Pin m_pin;
};

/** typeId igual a um tipo embutido real (`isI2cFastPathTransparentUnlocked` só olha a string, ver
 * SimulationSession.cpp) mas SEM nenhum comportamento elétrico de verdade -- este teste não
 * registra `passive.resistor`/`other.ground` de produção (exigiria os headers/construtores reais
 * de components::Resistor/Ground só pra um typeId; não é o que está sob teste aqui). Um pino só,
 * nome configurável, pra caber tanto no papel de resistor (2 pinos numa rede real) quanto terra
 * (1 pino) sem precisar de duas classes. */
class FakeTransparentComponent final : public IComponentModel {
public:
    FakeTransparentComponent(const char* typeId, Pin pin) : m_typeId(typeId), m_pin(std::move(pin)) {}
    const char* typeId() const override { return m_typeId; }
    std::span<Pin> pins() override { return {&m_pin, 1}; }
    void stamp(MnaMatrixView&) override {}
    void postStep(uint64_t) override {}
    size_t getState(uint8_t*, size_t) const override { return 0; }
    void setState(const uint8_t*, size_t) override {}
    std::vector<PropertyDescriptor> propertyDescriptors() override { return {}; }

private:
    const char* m_typeId;
    Pin m_pin;
};

I2cTransfer makeWrite(uint8_t address, const uint8_t* data, uint32_t size) {
    I2cTransfer transfer{};
    transfer.address = address;
    transfer.read = false;
    transfer.start = true;
    transfer.stop = true;
    transfer.txData = data;
    transfer.txSize = size;
    return transfer;
}

void testFastPathRoutesToConnectedDevice() {
    plugins::GlobalPluginCache cache;
    SimulationSession session(cache);
    session.mcus().registerFactory("test.fake_mcu", [] { return std::make_unique<FakeMcuAdapter>(); });
    FakeI2cDevice* devicePtr = nullptr;
    session.components().registerFactory("test.fake_i2c_device", [&devicePtr](const registry::ComponentParams&) {
        auto instance = std::make_unique<FakeI2cDevice>(Pin{"sda"});
        devicePtr = instance.get();
        return instance;
    });

    const uint32_t mcuIndex = session.addComponent("test.fake_mcu", {});
    const uint32_t deviceIndex = session.addComponent("test.fake_i2c_device", {});
    session.connectWire(mcuIndex, "sda", deviceIndex, "sda");
    session.connectWire(mcuIndex, "scl", deviceIndex, "scl");
    for (int i = 0; i < 10 && session.settleStep(); ++i) {}

    const uint8_t payload = 0x99;
    const I2cTransferResult wrongAddress = session.resolveI2cTransferForTesting(mcuIndex, 0, makeWrite(0x10, &payload, 1));
    check(wrongAddress.handled, "endereco errado: fast path resolve (handled=true)");
    check(!wrongAddress.addressAck, "endereco errado: sem ACK (NACK definitivo, nao fallback)");

    const I2cTransferResult rightAddress = session.resolveI2cTransferForTesting(mcuIndex, 0, makeWrite(0x42, &payload, 1));
    check(rightAddress.handled, "endereco certo: fast path resolve");
    check(rightAddress.addressAck, "endereco certo: ACK do dispositivo conectado");
    check(devicePtr->lastWriteSize == 1 && devicePtr->lastWriteByte == payload,
          "payload chega intacto ao dispositivo (mesmo objeto, sem QEMU real)");

    const I2cTransferResult unknownBus = session.resolveI2cTransferForTesting(mcuIndex, 1, makeWrite(0x42, &payload, 1));
    check(!unknownBus.handled, "barramento sem roteamento do adaptador -> fallback (handled=false)");
}

void testFastPathFallsBackWithOpaqueComponentOnBus() {
    plugins::GlobalPluginCache cache;
    SimulationSession session(cache);
    session.mcus().registerFactory("test.fake_mcu", [] { return std::make_unique<FakeMcuAdapter>(); });
    session.components().registerFactory("test.fake_i2c_device", [](const registry::ComponentParams&) {
        return std::make_unique<FakeI2cDevice>(Pin{"sda"});
    });
    session.components().registerFactory("test.fake_opaque", [](const registry::ComponentParams&) {
        return std::make_unique<FakeOpaqueComponent>(Pin{"sda"});
    });

    const uint32_t mcuIndex = session.addComponent("test.fake_mcu", {});
    const uint32_t deviceIndex = session.addComponent("test.fake_i2c_device", {});
    const uint32_t opaqueIndex = session.addComponent("test.fake_opaque", {});
    session.connectWire(mcuIndex, "sda", deviceIndex, "sda");
    session.connectWire(mcuIndex, "scl", deviceIndex, "scl");
    session.connectWire(mcuIndex, "sda", opaqueIndex, "sda");
    for (int i = 0; i < 10 && session.settleStep(); ++i) {}

    const uint8_t payload = 0x01;
    const I2cTransferResult result = session.resolveI2cTransferForTesting(mcuIndex, 0, makeWrite(0x42, &payload, 1));
    check(!result.handled,
          "componente desconhecido (nao I2C-capaz, nao transparente) no mesmo no' forca fallback eletrico");
}

void testFastPathRequiresBothBusWires() {
    plugins::GlobalPluginCache cache;
    SimulationSession session(cache);
    session.mcus().registerFactory("test.fake_mcu", [] { return std::make_unique<FakeMcuAdapter>(); });
    session.components().registerFactory("test.fake_i2c_device", [](const registry::ComponentParams&) {
        return std::make_unique<FakeI2cDevice>(Pin{"sda"});
    });

    const uint32_t mcuIndex = session.addComponent("test.fake_mcu", {});
    const uint32_t deviceIndex = session.addComponent("test.fake_i2c_device", {});
    session.connectWire(mcuIndex, "sda", deviceIndex, "sda");
    for (int i = 0; i < 10 && session.settleStep(); ++i) {}

    const uint8_t payload = 0x55;
    const I2cTransferResult result =
        session.resolveI2cTransferForTesting(mcuIndex, 0, makeWrite(0x42, &payload, 1));
    check(!result.handled,
          "dispositivo ligado apenas em SDA, sem SCL correspondente, força fallback elétrico");
}

void testFastPathIgnoresTransparentComponents() {
    plugins::GlobalPluginCache cache;
    SimulationSession session(cache);
    session.mcus().registerFactory("test.fake_mcu", [] { return std::make_unique<FakeMcuAdapter>(); });
    FakeI2cDevice* devicePtr = nullptr;
    session.components().registerFactory("test.fake_i2c_device", [&devicePtr](const registry::ComponentParams&) {
        auto instance = std::make_unique<FakeI2cDevice>(Pin{"sda"});
        devicePtr = instance.get();
        return instance;
    });

    session.components().registerFactory("passive.resistor", [](const registry::ComponentParams&) {
        return std::make_unique<FakeTransparentComponent>("passive.resistor", Pin{"sda"});
    });
    session.components().registerFactory("connectors.tunnel", [](const registry::ComponentParams&) {
        return std::make_unique<FakeTransparentComponent>("connectors.tunnel", Pin{"sda"});
    });

    const uint32_t mcuIndex = session.addComponent("test.fake_mcu", {});
    const uint32_t deviceIndex = session.addComponent("test.fake_i2c_device", {});
    const uint32_t pullupIndex = session.addComponent("passive.resistor", {});
    const uint32_t tunnelIndex = session.addComponent("connectors.tunnel", {});
    // Todos os quatro pinos "sda" no MESMO nó -- não modela um pull-up de verdade eletricamente
    // (não é o que está sob teste), só prova que a PRESENÇA desses typeIds no nó não bloqueia o
    // fast path.
    session.connectWire(mcuIndex, "sda", deviceIndex, "sda");
    session.connectWire(mcuIndex, "scl", deviceIndex, "scl");
    session.connectWire(mcuIndex, "sda", pullupIndex, "sda");
    session.connectWire(mcuIndex, "sda", tunnelIndex, "sda");
    for (int i = 0; i < 10 && session.settleStep(); ++i) {}

    const uint8_t payload = 0x02;
    const I2cTransferResult result = session.resolveI2cTransferForTesting(mcuIndex, 0, makeWrite(0x42, &payload, 1));
    check(result.handled && result.addressAck,
          "resistor e tunel no mesmo no' nao impedem o fast path (tipos transparentes)");
}

void testFastPathDefinitiveNackWithNothingConnected() {
    plugins::GlobalPluginCache cache;
    SimulationSession session(cache);
    session.mcus().registerFactory("test.fake_mcu", [] { return std::make_unique<FakeMcuAdapter>(); });

    const uint32_t mcuIndex = session.addComponent("test.fake_mcu", {});
    for (int i = 0; i < 10 && session.settleStep(); ++i) {}

    const uint8_t payload = 0x03;
    const I2cTransferResult result = session.resolveI2cTransferForTesting(mcuIndex, 0, makeWrite(0x42, &payload, 1));
    check(result.handled, "barramento sem nenhum dispositivo: fast path ainda resolve (handled=true)");
    check(!result.addressAck, "barramento vazio: NACK definitivo, nao fallback pro eletrico");
}

} // namespace

int main() {
    testFastPathRoutesToConnectedDevice();
    testFastPathFallsBackWithOpaqueComponentOnBus();
    testFastPathRequiresBothBusWires();
    testFastPathIgnoresTransparentComponents();
    testFastPathDefinitiveNackWithNothingConnected();
    if (failures == 0) {
        std::printf("OK: fast path de I2C resolve topologia corretamente.\n");
        return 0;
    }
    std::fprintf(stderr, "FALHAS: %d\n", failures);
    return 1;
}
