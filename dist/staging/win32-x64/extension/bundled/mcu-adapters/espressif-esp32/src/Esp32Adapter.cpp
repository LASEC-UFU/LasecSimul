/* Adaptador nativo de MCU para ESP32 (QEMU), via plugin DLL/SO (mcu_abi.h, major 2+).
 *
 * Migrado nesta sessao do adaptador built-in equivalente (antes compilado direto no Core, ver
 * core/src/mcu/esp32/ na historia do repositorio) -- mesmos offsets de registrador, mesmos args de
 * launch, mesma faixa de memoria, copiados fielmente, so que agora expostos via
 * LsdnQemuModuleVTable (create_modules) em vez de QemuModule C++ direto. Performance e' a mesma:
 * cada chamada daqui e' um ponteiro de funcao C, chamado no MESMO processo do Core (sem IPC, sem
 * serializacao) -- identico ao custo de uma chamada virtual C++ built-in.
 *
 * Fontes de referencia reais (nao suposicao): C:\SourceCode\simulide_2\src\microsim\cores\qemu\
 * esp32\esp32{,gpio}.{h,cpp} (offsets de registrador e args de launch) e
 * C:\SourceCode\qemu_simulide\hw\gpio\esp32_gpio.c (confirma que o QEMU manda registrador bruto,
 * sem decodificar nada -- por isso o modulo abaixo e' chip-especifico de proposito). */
#include "lasecsimul/mcu_abi.h"
#include <cstdint>
#include <cstring>
#include <string>
#include <vector>

namespace {

// ── Faixas de memoria MMIO reais do ESP32 (confirmadas contra esp32.cpp/esp32_gpio.c reais) ──────
constexpr uint64_t kGpioStart = 0x3FF44000;
constexpr uint64_t kGpioEnd = 0x3FF44FFF;
constexpr uint64_t kI2c0Start = 0x3FF53000;
constexpr uint64_t kI2c0End = 0x3FF53FFF;
constexpr uint64_t kSpi0Start = 0x3FF64000;
constexpr uint64_t kSpi0End = 0x3FF64FFF;
constexpr uint64_t kUart0Start = 0x3FF40000;
constexpr uint64_t kUart0End = 0x3FF40FFF;
constexpr uint32_t kUartRxLine = 0;
constexpr uint32_t kUartTxLine = 1;

// ── Modulo GPIO concreto (LsdnQemuModuleVTable) ───────────────────────────────────────────────────
// Espelho fiel de Esp32Gpio::writeRegister()/readRegister() (esp32gpio.cpp), restrito de proposito
// a GPIO_OUT_REG/GPIO_ENABLE_REG/GPIO_IN_REG/GPIO_IN1_REG -- sem IOMUX/pin-matrix (ver pendencia em
// docs/17-pendencias-pos-sessao-qemu-abi.md secao 3.1). Offsets confirmados lendo
// hw/gpio/esp32_gpio.c do fork QEMU real:
//   0x04 = GPIO_OUT_REG (escrita)    -- 1 bit por pino 0-31, nivel de saida
//   0x20 = GPIO_ENABLE_REG (escrita) -- 1 bit por pino 0-31, 1 = saida, 0 = entrada
//   0x3C = GPIO_IN_REG (leitura)     -- pinos 0-31
//   0x40 = GPIO_IN1_REG (leitura)    -- pinos 33-39 nos bits 0-6
struct Esp32GpioModuleState {
    uint32_t out = 0;
    uint32_t enable = 0;
    uint64_t in = 0; // bits 0-31 = GPIO0-31, bits 33-39 = GPIO33-39 (bit 32 nao usado)
};

void gpioReset(LsdnQemuModule* module) {
    auto* s = reinterpret_cast<Esp32GpioModuleState*>(module);
    s->out = 0;
    s->enable = 0;
    s->in = 0;
}

void gpioWriteRegister(LsdnQemuModule* module, uint64_t address, uint64_t value) {
    auto* s = reinterpret_cast<Esp32GpioModuleState*>(module);
    const uint64_t offset = address - kGpioStart;
    const uint32_t value32 = static_cast<uint32_t>(value);
    if (offset == 0x04) s->out = value32;
    else if (offset == 0x20) s->enable = value32;
    // offsets >= 0x88 (GPIO_PINxx_REG/matrix in/out) ficam fora desta versao -- ver doc acima.
}

uint64_t gpioReadRegister(LsdnQemuModule* module, uint64_t address) {
    auto* s = reinterpret_cast<Esp32GpioModuleState*>(module);
    const uint64_t offset = address - kGpioStart;
    if (offset == 0x3C) return s->in & 0xFFFFFFFFull;       // GPIO_IN_REG: pinos 0-31
    if (offset == 0x40) return (s->in >> 32) & 0x7Full;       // GPIO_IN1_REG: pinos 33-39
    return 0;
}

int32_t gpioIsOutputEnabled(LsdnQemuModule* module, uint32_t bit) {
    auto* s = reinterpret_cast<Esp32GpioModuleState*>(module);
    return (bit < 32 && (s->enable & (1u << bit)) != 0) ? 1 : 0;
}

int32_t gpioOutputLevel(LsdnQemuModule* module, uint32_t bit) {
    auto* s = reinterpret_cast<Esp32GpioModuleState*>(module);
    return (bit < 32 && (s->out & (1u << bit)) != 0) ? 1 : 0;
}

void gpioSetInputLevel(LsdnQemuModule* module, uint32_t bit, int32_t level) {
    auto* s = reinterpret_cast<Esp32GpioModuleState*>(module);
    if (bit >= 40) return;
    const uint64_t mask = uint64_t(1) << bit;
    if (level) s->in |= mask;
    else s->in &= ~mask;
}

void gpioDestroy(LsdnQemuModule* module) {
    delete reinterpret_cast<Esp32GpioModuleState*>(module);
}

const LsdnQemuModuleVTable kGpioModuleVTable = {
    &gpioReset, &gpioWriteRegister, &gpioReadRegister, &gpioIsOutputEnabled, &gpioOutputLevel,
    &gpioSetInputLevel, &gpioDestroy,
};

// ── Faixas de memoria + mapa de pinos (declarativo, get_memory_regions/get_pin_map) ──────────────
const LsdnMemoryRegion kMemoryRegions[] = {
    {kGpioStart, kGpioEnd, LSDN_MODULE_GPIO, 0},
    {kI2c0Start, kI2c0End, LSDN_MODULE_I2C, 0},
    {kSpi0Start, kSpi0End, LSDN_MODULE_SPI, 0},
    {kUart0Start, kUart0End, LSDN_MODULE_USART, 0},
};

// ── Estado do adaptador ───────────────────────────────────────────────────────────────────────────
struct Esp32AdapterState {
    void* hostCtx = nullptr;
    const LsdnMcuHostApi* api = nullptr;
    std::vector<std::string> pinIdStorage;
    std::vector<LsdnPinMapping> pinMapStorage;
    std::vector<std::string> launchArgStorage;
    std::vector<const char*> launchArgs;
    std::string romDir = "devices/qemu-esp32/bin/esp32/rom/bin";
};

void buildPinMap(Esp32AdapterState* state) {
    state->pinIdStorage.clear();
    state->pinMapStorage.clear();
    state->pinIdStorage.reserve(42);
    state->pinMapStorage.reserve(42);

    for (uint32_t gpio = 0; gpio <= 39; ++gpio) {
        state->pinIdStorage.push_back("GPIO" + std::to_string(gpio));
    }
    state->pinIdStorage.push_back("UART0_RX");
    state->pinIdStorage.push_back("UART0_TX");

    for (uint32_t gpio = 0; gpio <= 39; ++gpio) {
        state->pinMapStorage.push_back(LsdnPinMapping{state->pinIdStorage[gpio].c_str(), LSDN_MODULE_GPIO, 0, gpio});
    }
    state->pinMapStorage.push_back(LsdnPinMapping{state->pinIdStorage[40].c_str(), LSDN_MODULE_USART, 0, kUartRxLine});
    state->pinMapStorage.push_back(LsdnPinMapping{state->pinIdStorage[41].c_str(), LSDN_MODULE_USART, 0, kUartTxLine});
}

LsdnMcuAdapter* create(void* hostCtx, const LsdnMcuHostApi* api) {
    auto* state = new Esp32AdapterState();
    state->hostCtx = hostCtx;
    state->api = api;
    buildPinMap(state);
    return reinterpret_cast<LsdnMcuAdapter*>(state);
}

// Espelho fiel de Esp32::createArgs() real (C:\SourceCode\simulide_2\...\esp32\esp32.cpp) -- NAO
// inclui a chave da shared memory aqui (McuController prepend isso como argv[1], ver simuMain() em
// simuliface.c). Primeiro elemento e' o argv[0] convencional que o proprio QEMU espera, nao o
// caminho real do binario (esse vem de spec.binary).
LsdnQemuLaunchSpec buildLaunchArgs(LsdnMcuAdapter* adapter, const char* firmwarePath) {
    auto* state = reinterpret_cast<Esp32AdapterState*>(adapter);
    state->launchArgStorage = {
        "qemu-system-xtensa",
        "-M",
        "esp32-simul",
        "-L",
        state->romDir,
        "-drive",
        "file=" + std::string(firmwarePath ? firmwarePath : "") + ",if=mtd,format=raw",
        "-icount",
        "shift=4,align=off,sleep=off",
    };
    state->launchArgs.clear();
    state->launchArgs.reserve(state->launchArgStorage.size());
    for (const std::string& arg : state->launchArgStorage) state->launchArgs.push_back(arg.c_str());

    return LsdnQemuLaunchSpec{"qemu-system-xtensa", state->launchArgs.data(),
                              static_cast<uint32_t>(state->launchArgs.size())};
}

uint32_t getMemoryRegions(LsdnMcuAdapter*, LsdnMemoryRegion* out, uint32_t cap) {
    const uint32_t count = sizeof(kMemoryRegions) / sizeof(kMemoryRegions[0]);
    if (out && cap >= count) std::memcpy(out, kMemoryRegions, sizeof(kMemoryRegions));
    return count;
}

uint32_t getPinMap(LsdnMcuAdapter* adapter, LsdnPinMapping* out, uint32_t cap) {
    auto* state = reinterpret_cast<Esp32AdapterState*>(adapter);
    const uint32_t count = static_cast<uint32_t>(state->pinMapStorage.size());
    if (out && cap >= count) {
        for (uint32_t i = 0; i < count; ++i) out[i] = state->pinMapStorage[i];
    }
    return count;
}

uint32_t createModules(LsdnMcuAdapter*, LsdnQemuModuleHandle* out, uint32_t cap) {
    constexpr uint32_t kCount = 1; // só GPIO puro nesta versão -- ver doc do arquivo
    if (out && cap >= kCount) {
        out[0] = LsdnQemuModuleHandle{
            LSDN_MODULE_GPIO, 0, reinterpret_cast<LsdnQemuModule*>(new Esp32GpioModuleState()), &kGpioModuleVTable,
        };
    }
    return kCount;
}

void destroy(LsdnMcuAdapter* adapter) {
    delete reinterpret_cast<Esp32AdapterState*>(adapter);
}

const LsdnMcuVTable kVTable = {
    &create, &buildLaunchArgs, &getMemoryRegions, &getPinMap, &createModules, &destroy,
};

} // namespace

extern "C" LSDN_EXPORT const LsdnMcuVTable* lsdn_get_mcu_vtable(uint32_t* abiMajor, uint32_t* abiMinor) {
    *abiMajor = LSDN_MCU_ABI_VERSION_MAJOR;
    *abiMinor = LSDN_MCU_ABI_VERSION_MINOR;
    return &kVTable;
}
