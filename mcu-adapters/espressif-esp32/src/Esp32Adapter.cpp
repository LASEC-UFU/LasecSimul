/* Adaptador nativo de MCU para ESP32 (QEMU), via plugin DLL/SO (mcu_abi.h).
 *
 * Esta versao sobe um degrau em relacao ao GPIO puro anterior: espelha tambem o IOMUX do ESP32 e
 * o roteamento principal da GPIO matrix (UART0/1/2, I2C0/1, HSPI/VSPI). O objetivo aqui e'
 * alinhar a topologia MMIO e o roteamento de sinais com o SimulIDE real sem reintroduzir nada
 * built-in no Core: tudo continua encapsulado no plugin ABI.
 *
 * Referencias auditadas localmente:
 * - C:\SourceCode\simulide_2\src\microsim\cores\qemu\esp32\esp32.cpp
 * - C:\SourceCode\simulide_2\src\microsim\cores\qemu\esp32\esp32gpio.cpp
 * - C:\SourceCode\simulide_2\src\microsim\cores\qemu\esp32\esp32iomux.cpp
 */
#include "lasecsimul/mcu_abi.h"
#include <algorithm>
#include <array>
#include <cmath>
#include <cstdio>
#include <cstdlib>
#include <cstdint>
#include <deque>
#include <cstring>
#include <filesystem>
#include <string>
#include <vector>

#if defined(_WIN32)
#include <windows.h>
#else
#include <dlfcn.h>
#endif

namespace {

bool analogTraceEnabled() {
    const char* value = std::getenv("LASECSIMUL_TRACE_ANALOG");
    return value != nullptr && value[0] != '\0' && std::strcmp(value, "0") != 0;
}

constexpr uint64_t kUart0Start = 0x3FF40000;
constexpr uint64_t kUart0End = 0x3FF40FFF;
constexpr uint64_t kGpioStart = 0x3FF44000;
constexpr uint64_t kGpioEnd = 0x3FF44FFF;
constexpr uint64_t kIoMuxStart = 0x3FF49000;
constexpr uint64_t kIoMuxEnd = 0x3FF49FFF;
constexpr uint64_t kAdcStart = 0x3FF48800;
constexpr uint64_t kAdcEnd = 0x3FF48BFF;
constexpr uint64_t kUart1Start = 0x3FF50000;
constexpr uint64_t kUart1End = 0x3FF50FFF;
constexpr uint64_t kLedcStart = 0x3FF59000;
constexpr uint64_t kLedcEnd = 0x3FF59193;
constexpr uint64_t kI2c0Start = 0x3FF53000;
constexpr uint64_t kI2c0End = 0x3FF53FFF;
constexpr uint64_t kSpi0Start = 0x3FF64000; // HSPI in the SimulIDE mapping
constexpr uint64_t kSpi0End = 0x3FF64FFF;
constexpr uint64_t kSpi1Start = 0x3FF65000; // VSPI in the SimulIDE mapping
constexpr uint64_t kSpi1End = 0x3FF65FFF;
constexpr uint64_t kI2c1Start = 0x3FF67000;
constexpr uint64_t kI2c1End = 0x3FF67FFF;
constexpr uint64_t kUart2Start = 0x3FF6E000;
constexpr uint64_t kUart2End = 0x3FF6EFFF;

constexpr uint32_t kUartRxLine = 0;
constexpr uint32_t kUartTxLine = 1;
constexpr uint32_t kI2cSclLine = 0;
constexpr uint32_t kI2cSdaLine = 1;
constexpr uint32_t kSpiClkLine = 0;
constexpr uint32_t kSpiMisoLine = 1;
constexpr uint32_t kSpiMosiLine = 2;
constexpr uint32_t kSpiCs0Line = 3;
constexpr uint64_t kDefaultUartBitPeriodNs = 8'680; // 115200 baud, rounded to ns
constexpr uint64_t kEsp32ApbClockHz = 80'000'000;

enum class SignalKind {
    None,
    RawGpio,
    UartRx,
    UartTx,
    I2cScl,
    I2cSda,
    SpiClk,
    SpiMiso,
    SpiMosi,
    SpiCs0,
    Ledc,
};

struct SignalDesc {
    SignalKind kind = SignalKind::None;
    uint32_t index = 0;
};

enum class UartRxPhase : uint8_t {
    Idle,
    Start,
    Data,
    Stop,
};

struct UsartState {
    bool rxLevel = true;
    bool txLevel = true; // UART idle line
    std::deque<uint8_t> rxFifo;
    std::deque<uint8_t> txFifo;
    bool txActive = false;
    uint16_t txFrame = 0x03FF;
    uint8_t txBitIndex = 0;
    uint8_t txTotalBits = 10;
    UartRxPhase rxPhase = UartRxPhase::Idle;
    uint8_t rxBitIndex = 0;
    uint8_t rxShift = 0;
    uint8_t rxStopIndex = 0;
    uint8_t dataBits = 8;
    uint8_t stopBits = 1;
    uint64_t bitPeriodNs = kDefaultUartBitPeriodNs;
    uint64_t txDueNs = LSDN_QEMU_MODULE_NO_WAKEUP;
    uint64_t rxDueNs = LSDN_QEMU_MODULE_NO_WAKEUP;
};

struct I2cState {
    bool sclInput = true;
    bool sdaInput = true;
    bool sclOutputLevel = true;
    bool sdaOutputLevel = true;
    bool sclOutputEnabled = false;
    bool sdaOutputEnabled = false;
};

struct SpiState {
    bool clkInput = false;
    bool misoInput = false;
    bool mosiInput = false;
    bool cs0Input = true;
    bool clkOutputLevel = false;
    bool misoOutputLevel = false;
    bool mosiOutputLevel = false;
    bool cs0OutputLevel = true;
    bool clkOutputEnabled = false;
    bool misoOutputEnabled = false;
    bool mosiOutputEnabled = false;
    bool cs0OutputEnabled = false;
};

struct LedcState {
    std::array<uint32_t, 8> timerConfig{};
    std::array<uint8_t, 8> dutyResolution{};
    std::array<uint64_t, 8> periodNs{};
    std::array<uint8_t, 16> channelTimer{};
    std::array<uint32_t, 16> dutyRaw{};
    std::array<bool, 16> outputLevel{};
    std::array<uint64_t, 16> nextEdgeNs{};
};

struct Esp32SharedState {
    uint32_t gpioOut = 0;
    uint32_t gpioEnable = 0;
    std::array<bool, 40> gpioInputs{};
    std::array<double, 40> gpioVoltages{};
    std::array<uint32_t, 40> gpioPinRegs{};
    std::array<uint16_t, 40> ioMuxRegs{};
    std::array<SignalDesc, 40 * 6> ioMuxFuncs{};
    std::array<uint32_t, 256> matrixInRegs{};
    std::array<uint32_t, 40> matrixOutRegs{};
    std::array<UsartState, 3> usarts{};
    std::array<I2cState, 2> i2cs{};
    std::array<SpiState, 2> spis{};
    LedcState ledc{};
};

SignalDesc makeRawGpio(uint32_t pin) { return SignalDesc{SignalKind::RawGpio, pin}; }
SignalDesc makeUartRx(uint32_t index) { return SignalDesc{SignalKind::UartRx, index}; }
SignalDesc makeUartTx(uint32_t index) { return SignalDesc{SignalKind::UartTx, index}; }
SignalDesc makeI2cScl(uint32_t index) { return SignalDesc{SignalKind::I2cScl, index}; }
SignalDesc makeI2cSda(uint32_t index) { return SignalDesc{SignalKind::I2cSda, index}; }
SignalDesc makeSpiClk(uint32_t index) { return SignalDesc{SignalKind::SpiClk, index}; }
SignalDesc makeSpiMiso(uint32_t index) { return SignalDesc{SignalKind::SpiMiso, index}; }
SignalDesc makeSpiMosi(uint32_t index) { return SignalDesc{SignalKind::SpiMosi, index}; }
SignalDesc makeSpiCs0(uint32_t index) { return SignalDesc{SignalKind::SpiCs0, index}; }
SignalDesc makeLedc(uint32_t index) { return SignalDesc{SignalKind::Ledc, index}; }

uint64_t usartStartAddress(uint32_t index) {
    switch (index) {
        case 0: return kUart0Start;
        case 1: return kUart1Start;
        case 2: return kUart2Start;
        default: return kUart0Start;
    }
}

uint64_t addDelayNs(uint64_t nowNs, uint64_t delayNs) {
    if (delayNs > LSDN_QEMU_MODULE_NO_WAKEUP - nowNs) return LSDN_QEMU_MODULE_NO_WAKEUP;
    return nowNs + delayNs;
}

uint64_t delayUntilNs(uint64_t dueNs, uint64_t nowNs) {
    if (dueNs == LSDN_QEMU_MODULE_NO_WAKEUP) return LSDN_QEMU_MODULE_NO_WAKEUP;
    return dueNs <= nowNs ? 0 : dueNs - nowNs;
}

uint64_t nextUsartWakeupDelayNs(const UsartState& usart, uint64_t nowNs) {
    const uint64_t dueNs = usart.txDueNs < usart.rxDueNs ? usart.txDueNs : usart.rxDueNs;
    return delayUntilNs(dueNs, nowNs);
}

void usartStartTx(UsartState& usart, uint64_t nowNs) {
    if (usart.txActive || usart.txFifo.empty()) return;

    const uint8_t data = usart.txFifo.front();
    usart.txFifo.pop_front();

    usart.txFrame = static_cast<uint16_t>((uint16_t(1) << (1u + usart.dataBits)) | (uint16_t(data) << 1u));
    usart.txTotalBits = static_cast<uint8_t>(1u + usart.dataBits + usart.stopBits);
    usart.txBitIndex = 0;
    usart.txActive = true;
    usart.txLevel = (usart.txFrame & 1u) != 0; // start bit
    usart.txBitIndex = 1;
    usart.txDueNs = addDelayNs(nowNs, usart.bitPeriodNs);
}

void usartAdvanceTx(UsartState& usart, uint64_t nowNs) {
    usart.txDueNs = LSDN_QEMU_MODULE_NO_WAKEUP;
    if (!usart.txActive) {
        usartStartTx(usart, nowNs);
        return;
    }

    if (usart.txBitIndex < usart.txTotalBits) {
        if (usart.txBitIndex <= usart.dataBits) {
            usart.txLevel = ((usart.txFrame >> usart.txBitIndex) & 1u) != 0;
        } else {
            usart.txLevel = true; // stop bit(s)
        }
        ++usart.txBitIndex;
        usart.txDueNs = addDelayNs(nowNs, usart.bitPeriodNs);
        return;
    }

    usart.txActive = false;
    usart.txLevel = true;
    usartStartTx(usart, nowNs);
}

void usartStartRx(UsartState& usart, uint64_t nowNs) {
    usart.rxPhase = UartRxPhase::Start;
    usart.rxBitIndex = 0;
    usart.rxShift = 0;
    usart.rxStopIndex = 0;
    usart.rxDueNs = addDelayNs(nowNs, usart.bitPeriodNs / 2u);
}

void usartSetRxLevel(UsartState& usart, bool level, uint64_t nowNs) {
    const bool previousLevel = usart.rxLevel;
    usart.rxLevel = level;
    if (previousLevel && !level && usart.rxPhase == UartRxPhase::Idle) usartStartRx(usart, nowNs);
}

void usartAdvanceRx(UsartState& usart, uint64_t nowNs) {
    usart.rxDueNs = LSDN_QEMU_MODULE_NO_WAKEUP;

    switch (usart.rxPhase) {
        case UartRxPhase::Start:
            if (usart.rxLevel) {
                usart.rxPhase = UartRxPhase::Idle;
                return;
            }
            usart.rxPhase = UartRxPhase::Data;
            usart.rxBitIndex = 0;
            usart.rxDueNs = addDelayNs(nowNs, usart.bitPeriodNs);
            return;

        case UartRxPhase::Data:
            if (usart.rxLevel && usart.rxBitIndex < 8) usart.rxShift |= static_cast<uint8_t>(1u << usart.rxBitIndex);
            ++usart.rxBitIndex;
            if (usart.rxBitIndex < usart.dataBits) {
                usart.rxDueNs = addDelayNs(nowNs, usart.bitPeriodNs);
                return;
            }
            usart.rxPhase = UartRxPhase::Stop;
            usart.rxStopIndex = 0;
            usart.rxDueNs = addDelayNs(nowNs, usart.bitPeriodNs);
            return;

        case UartRxPhase::Stop:
            if (usart.rxStopIndex == 0 && usart.rxLevel && usart.rxFifo.size() < 128) {
                usart.rxFifo.push_back(usart.rxShift);
            }
            ++usart.rxStopIndex;
            if (usart.rxStopIndex < usart.stopBits) {
                usart.rxDueNs = addDelayNs(nowNs, usart.bitPeriodNs);
                return;
            }
            usart.rxPhase = UartRxPhase::Idle;
            usart.rxDueNs = LSDN_QEMU_MODULE_NO_WAKEUP;
            return;

        case UartRxPhase::Idle:
        default:
            usart.rxDueNs = LSDN_QEMU_MODULE_NO_WAKEUP;
            return;
    }
}

void usartAdvanceDueWork(UsartState& usart, uint64_t nowNs) {
    for (uint8_t guard = 0; guard < 4; ++guard) {
        bool advanced = false;
        if (usart.txDueNs != LSDN_QEMU_MODULE_NO_WAKEUP && usart.txDueNs <= nowNs) {
            usartAdvanceTx(usart, nowNs);
            advanced = true;
        }
        if (usart.rxDueNs != LSDN_QEMU_MODULE_NO_WAKEUP && usart.rxDueNs <= nowNs) {
            usartAdvanceRx(usart, nowNs);
            advanced = true;
        }
        if (!advanced) return;
    }
}

void usartWriteConf0(UsartState& usart, uint32_t data) {
    const uint8_t dataBitsField = static_cast<uint8_t>((data & 0b001100u) >> 2u);
    usart.dataBits = static_cast<uint8_t>(5u + dataBitsField);

    const uint8_t stopBitsField = static_cast<uint8_t>((data & 0b110000u) >> 4u);
    usart.stopBits = stopBitsField == 3 ? 2 : 1;

    if ((data & (1u << 18u)) != 0) usart.txFifo.clear();
    if ((data & (1u << 17u)) != 0) {
        usart.rxFifo.clear();
        usart.rxPhase = UartRxPhase::Idle;
        usart.rxDueNs = LSDN_QEMU_MODULE_NO_WAKEUP;
    }
}

// Bit 31 nunca é setado por hardware real (UART_CLKDIV_REG só usa bits[23:0]) nem por bit-time em
// ns plausível (cobre até ~2.1s de período de bit, bem acima do pior caso real). Usado como marcador
// explícito em vez de heurística por magnitude -- magnitude sozinha é ambígua: existem bauds não-
// padrão "redondos" (ex: 8000, 10000, 20000) cujo CLKDIV real colide com um valor de bit-time em ns
// também plausível, então qualquer corte por tamanho erra algum desses.
constexpr uint32_t kRawClkDivMarker = 0x80000000u;

void usartWriteClkDiv(UsartState& usart, uint32_t data) {
    if (data == 0) return;

    if ((data & kRawClkDivMarker) == 0) {
        // qemu_simulide (produção) sempre converte o UART_CLKDIV do ESP32 pra bit-time em ns antes
        // de mandar pra SimulIDE -- este é o único caminho que produção usa.
        usart.bitPeriodNs = data;
        return;
    }

    // Pedido explícito (só usado por teste direto, nunca por produção) pra decodificar como
    // registrador real ESP32 UART_CLKDIV_REG: inteiro em bits[19:0], fração (1/16) em bits[23:20].
    const uint32_t raw = data & ~kRawClkDivMarker;
    const uint64_t clkDivFixed = (uint64_t(raw & 0x000FFFFFu) << 4u) | ((raw >> 20u) & 0xFu);
    if (clkDivFixed == 0) return;
    usart.bitPeriodNs = (clkDivFixed * 1'000'000'000ull + ((kEsp32ApbClockHz << 4u) - 1u)) /
                        (kEsp32ApbClockHz << 4u);
}

SignalDesc& ioMuxFunc(Esp32SharedState& state, uint32_t pin, uint32_t funcIndex) {
    return state.ioMuxFuncs[pin * 6u + funcIndex];
}
const SignalDesc& ioMuxFunc(const Esp32SharedState& state, uint32_t pin, uint32_t funcIndex) {
    return state.ioMuxFuncs[pin * 6u + funcIndex];
}

void setIoMuxFuncs(Esp32SharedState& state, uint32_t pin, std::array<SignalDesc, 6> funcs) {
    for (uint32_t i = 0; i < funcs.size(); ++i) ioMuxFunc(state, pin, i) = funcs[i];
}

void configureIoMux(Esp32SharedState& state) {
    for (uint32_t pin = 0; pin < 40; ++pin) {
        setIoMuxFuncs(
            state, pin,
            std::array<SignalDesc, 6>{makeRawGpio(pin), SignalDesc{}, makeRawGpio(pin), SignalDesc{},
                                      SignalDesc{}, SignalDesc{}});
    }

    setIoMuxFuncs(state, 1, std::array<SignalDesc, 6>{makeUartTx(0), SignalDesc{}, makeRawGpio(1),
                                                      SignalDesc{}, SignalDesc{}, SignalDesc{}});
    setIoMuxFuncs(state, 3, std::array<SignalDesc, 6>{makeUartRx(0), SignalDesc{}, makeRawGpio(3),
                                                      SignalDesc{}, SignalDesc{}, SignalDesc{}});
    setIoMuxFuncs(state, 5, std::array<SignalDesc, 6>{makeRawGpio(5), makeSpiCs0(1), makeRawGpio(5),
                                                      SignalDesc{}, SignalDesc{}, SignalDesc{}});
    setIoMuxFuncs(state, 9, std::array<SignalDesc, 6>{SignalDesc{}, SignalDesc{}, makeRawGpio(9),
                                                      SignalDesc{}, makeUartRx(1), SignalDesc{}});
    setIoMuxFuncs(state, 10, std::array<SignalDesc, 6>{SignalDesc{}, SignalDesc{}, makeRawGpio(10),
                                                       SignalDesc{}, makeUartTx(1), SignalDesc{}});
    setIoMuxFuncs(state, 12, std::array<SignalDesc, 6>{makeSpiMiso(0), SignalDesc{}, makeRawGpio(12),
                                                       SignalDesc{}, SignalDesc{}, SignalDesc{}});
    setIoMuxFuncs(state, 13, std::array<SignalDesc, 6>{makeSpiMosi(0), SignalDesc{}, makeRawGpio(13),
                                                       SignalDesc{}, SignalDesc{}, SignalDesc{}});
    setIoMuxFuncs(state, 14, std::array<SignalDesc, 6>{SignalDesc{}, makeSpiClk(0), makeRawGpio(14),
                                                       SignalDesc{}, SignalDesc{}, SignalDesc{}});
    setIoMuxFuncs(state, 15, std::array<SignalDesc, 6>{makeSpiCs0(0), SignalDesc{}, makeRawGpio(15),
                                                       SignalDesc{}, SignalDesc{}, SignalDesc{}});
    setIoMuxFuncs(state, 16, std::array<SignalDesc, 6>{makeRawGpio(16), SignalDesc{}, makeRawGpio(16),
                                                       SignalDesc{}, makeUartRx(2), SignalDesc{}});
    setIoMuxFuncs(state, 17, std::array<SignalDesc, 6>{makeRawGpio(17), SignalDesc{}, makeRawGpio(17),
                                                       SignalDesc{}, makeUartTx(2), SignalDesc{}});
    setIoMuxFuncs(state, 18, std::array<SignalDesc, 6>{makeRawGpio(18), makeSpiClk(1), makeRawGpio(18),
                                                       SignalDesc{}, SignalDesc{}, SignalDesc{}});
    setIoMuxFuncs(state, 19, std::array<SignalDesc, 6>{makeRawGpio(19), makeSpiMiso(1), makeRawGpio(19),
                                                       SignalDesc{}, SignalDesc{}, SignalDesc{}});
    setIoMuxFuncs(state, 23, std::array<SignalDesc, 6>{makeRawGpio(23), makeSpiMosi(1), makeRawGpio(23),
                                                       SignalDesc{}, SignalDesc{}, SignalDesc{}});
}

SignalDesc matrixInputSignal(uint32_t func) {
    switch (func) {
        case 8: return makeSpiClk(0);
        case 9: return makeSpiMiso(0);
        case 10: return makeSpiMosi(0);
        case 11: return makeSpiCs0(0);
        case 14: return makeUartRx(0);
        case 17: return makeUartRx(1);
        case 29: return makeI2cScl(0);
        case 30: return makeI2cSda(0);
        case 63: return makeSpiClk(1);
        case 64: return makeSpiMiso(1);
        case 65: return makeSpiMosi(1);
        case 68: return makeSpiCs0(1);
        case 95: return makeI2cScl(1);
        case 96: return makeI2cSda(1);
        case 198: return makeUartRx(2);
        default: return {};
    }
}

SignalDesc matrixOutputSignal(uint32_t func) {
    if (func >= 71 && func <= 86) return makeLedc(func - 71);
    switch (func) {
        case 8: return makeSpiClk(0);
        case 9: return makeSpiMiso(0);
        case 10: return makeSpiMosi(0);
        case 11: return makeSpiCs0(0);
        case 14: return makeUartTx(0);
        case 17: return makeUartTx(1);
        case 29: return makeI2cScl(0);
        case 30: return makeI2cSda(0);
        case 63: return makeSpiClk(1);
        case 64: return makeSpiMiso(1);
        case 65: return makeSpiMosi(1);
        case 68: return makeSpiCs0(1);
        case 95: return makeI2cScl(1);
        case 96: return makeI2cSda(1);
        case 198: return makeUartTx(2);
        default: return {};
    }
}

bool signalOutputEnabled(const Esp32SharedState& state, SignalDesc signal) {
    switch (signal.kind) {
        case SignalKind::RawGpio:
            return signal.index < 32 && (state.gpioEnable & (1u << signal.index)) != 0;
        case SignalKind::UartTx: return signal.index < state.usarts.size();
        case SignalKind::I2cScl: return signal.index < state.i2cs.size() && state.i2cs[signal.index].sclOutputEnabled;
        case SignalKind::I2cSda: return signal.index < state.i2cs.size() && state.i2cs[signal.index].sdaOutputEnabled;
        case SignalKind::SpiClk: return signal.index < state.spis.size() && state.spis[signal.index].clkOutputEnabled;
        case SignalKind::SpiMiso: return signal.index < state.spis.size() && state.spis[signal.index].misoOutputEnabled;
        case SignalKind::SpiMosi: return signal.index < state.spis.size() && state.spis[signal.index].mosiOutputEnabled;
        case SignalKind::SpiCs0: return signal.index < state.spis.size() && state.spis[signal.index].cs0OutputEnabled;
        case SignalKind::Ledc: return signal.index < state.ledc.outputLevel.size();
        default: return false;
    }
}

bool signalOutputLevel(const Esp32SharedState& state, SignalDesc signal) {
    switch (signal.kind) {
        case SignalKind::RawGpio:
            return signal.index < 32 && (state.gpioOut & (1u << signal.index)) != 0;
        case SignalKind::UartTx: return signal.index < state.usarts.size() && state.usarts[signal.index].txLevel;
        case SignalKind::I2cScl: return signal.index < state.i2cs.size() && state.i2cs[signal.index].sclOutputLevel;
        case SignalKind::I2cSda: return signal.index < state.i2cs.size() && state.i2cs[signal.index].sdaOutputLevel;
        case SignalKind::SpiClk: return signal.index < state.spis.size() && state.spis[signal.index].clkOutputLevel;
        case SignalKind::SpiMiso: return signal.index < state.spis.size() && state.spis[signal.index].misoOutputLevel;
        case SignalKind::SpiMosi: return signal.index < state.spis.size() && state.spis[signal.index].mosiOutputLevel;
        case SignalKind::SpiCs0: return signal.index < state.spis.size() && state.spis[signal.index].cs0OutputLevel;
        case SignalKind::Ledc: return signal.index < state.ledc.outputLevel.size() && state.ledc.outputLevel[signal.index];
        default: return false;
    }
}

void signalSetInputLevelAt(Esp32SharedState& state, SignalDesc signal, bool level, uint64_t nowNs) {
    switch (signal.kind) {
        case SignalKind::UartRx:
            if (signal.index < state.usarts.size()) usartSetRxLevel(state.usarts[signal.index], level, nowNs);
            break;
        case SignalKind::I2cScl:
            if (signal.index < state.i2cs.size()) state.i2cs[signal.index].sclInput = level;
            break;
        case SignalKind::I2cSda:
            if (signal.index < state.i2cs.size()) state.i2cs[signal.index].sdaInput = level;
            break;
        case SignalKind::SpiClk:
            if (signal.index < state.spis.size()) state.spis[signal.index].clkInput = level;
            break;
        case SignalKind::SpiMiso:
            if (signal.index < state.spis.size()) state.spis[signal.index].misoInput = level;
            break;
        case SignalKind::SpiMosi:
            if (signal.index < state.spis.size()) state.spis[signal.index].mosiInput = level;
            break;
        case SignalKind::SpiCs0:
            if (signal.index < state.spis.size()) state.spis[signal.index].cs0Input = level;
            break;
        default: break;
    }
}

uint8_t selectedIoMuxIndex(const Esp32SharedState& state, uint32_t pin) {
    if (pin >= state.ioMuxRegs.size()) return 0;
    return static_cast<uint8_t>((state.ioMuxRegs[pin] >> 12) & 0x7);
}

SignalDesc selectedPinOutputSignal(const Esp32SharedState& state, uint32_t pin) {
    if (pin >= 40) return {};
    const uint8_t muxIndex = selectedIoMuxIndex(state, pin);
    if (muxIndex >= 6) return {};

    const SignalDesc direct = ioMuxFunc(state, pin, muxIndex);
    if (muxIndex == 2) {
        const SignalDesc matrix = matrixOutputSignal(state.matrixOutRegs[pin] & 0xFFu);
        if (matrix.kind != SignalKind::None) return matrix;
    }
    if (direct.kind != SignalKind::None) return direct;
    return muxIndex == 2 ? makeRawGpio(pin) : SignalDesc{};
}

SignalDesc selectedDirectInputSignal(const Esp32SharedState& state, uint32_t pin) {
    if (pin >= 40) return {};
    const uint8_t muxIndex = selectedIoMuxIndex(state, pin);
    if (muxIndex == 2 || muxIndex >= 6) return {};
    return ioMuxFunc(state, pin, muxIndex);
}

void routeDirectInputAt(Esp32SharedState& state, uint32_t pin, uint64_t nowNs) {
    const SignalDesc signal = selectedDirectInputSignal(state, pin);
    if (signal.kind == SignalKind::None || signal.kind == SignalKind::RawGpio) return;
    signalSetInputLevelAt(state, signal, state.gpioInputs[pin], nowNs);
}

void routeMatrixInputsAt(Esp32SharedState& state, uint32_t pin, uint64_t nowNs) {
    for (uint32_t func = 0; func < state.matrixInRegs.size(); ++func) {
        if ((state.matrixInRegs[func] & 0x3Fu) != pin) continue;
        const SignalDesc signal = matrixInputSignal(func);
        if (signal.kind == SignalKind::None) continue;
        signalSetInputLevelAt(state, signal, state.gpioInputs[pin], nowNs);
    }
}

void routePinInputAt(Esp32SharedState& state, uint32_t pin, uint64_t nowNs) {
    if (pin >= 40) return;
    routeDirectInputAt(state, pin, nowNs);
    routeMatrixInputsAt(state, pin, nowNs);
}

uint32_t readPort(const Esp32SharedState& state, bool upperPort) {
    uint32_t value = 0;
    if (!upperPort) {
        for (uint32_t pin = 0; pin < 32; ++pin) {
            if (state.gpioInputs[pin]) value |= (1u << pin);
        }
        return value;
    }
    for (uint32_t pin = 33; pin < 40; ++pin) {
        if (state.gpioInputs[pin]) value |= (1u << (pin - 33u));
    }
    return value;
}

int getIoMuxPin(uint64_t offset) {
    switch (offset) {
        case 0x04: return 36;
        case 0x08: return 37;
        case 0x0C: return 38;
        case 0x10: return 39;
        case 0x14: return 34;
        case 0x18: return 35;
        case 0x1C: return 32;
        case 0x20: return 33;
        case 0x24: return 25;
        case 0x28: return 26;
        case 0x2C: return 27;
        case 0x30: return 14;
        case 0x34: return 12;
        case 0x38: return 13;
        case 0x3C: return 15;
        case 0x40: return 2;
        case 0x44: return 0;
        case 0x48: return 4;
        case 0x4C: return 16;
        case 0x50: return 17;
        case 0x54: return 9;
        case 0x58: return 10;
        case 0x5C: return 11;
        case 0x60: return 6;
        case 0x64: return 7;
        case 0x68: return 8;
        case 0x6C: return 5;
        case 0x70: return 18;
        case 0x74: return 19;
        case 0x78: return 20;
        case 0x7C: return 21;
        case 0x80: return 22;
        case 0x84: return 3;
        case 0x88: return 1;
        case 0x8C: return 23;
        case 0x90: return 24;
        default: return -1;
    }
}

struct GpioModuleState {
    Esp32SharedState* chip = nullptr;
};

struct IoMuxModuleState {
    Esp32SharedState* chip = nullptr;
};

struct UsartModuleState {
    Esp32SharedState* chip = nullptr;
    uint32_t index = 0;
};

struct I2cModuleState {
    Esp32SharedState* chip = nullptr;
    uint32_t index = 0;
};

struct SpiModuleState {
    Esp32SharedState* chip = nullptr;
    uint32_t index = 0;
};

struct AdcModuleState {
    Esp32SharedState* chip = nullptr;
    uint8_t channel1 = 0;
    uint8_t channel2 = 0;
};

struct LedcModuleState {
    Esp32SharedState* chip = nullptr;
};

void gpioReset(LsdnQemuModule* module) {
    auto* s = reinterpret_cast<GpioModuleState*>(module);
    s->chip->gpioOut = 0;
    s->chip->gpioEnable = 0;
    s->chip->gpioInputs.fill(false);
    s->chip->gpioVoltages.fill(0.0);
    s->chip->gpioPinRegs.fill(0);
    s->chip->matrixInRegs.fill(0);
    s->chip->matrixOutRegs.fill(0);
}

void gpioWriteRegisterAt(LsdnQemuModule* module, uint64_t address, uint64_t value, uint64_t nowNs) {
    auto* s = reinterpret_cast<GpioModuleState*>(module);
    Esp32SharedState& chip = *s->chip;
    const uint64_t offset = address - kGpioStart;
    const uint32_t value32 = static_cast<uint32_t>(value);

    if (offset == 0x04) {
        chip.gpioOut = value32;
        return;
    }
    // GPIO_OUT_W1TS_REG/GPIO_OUT_W1TC_REG (0x08/0x0C, TRM real do ESP32) -- registrador de AÇÃO
    // (write-1-pra-set/clear), não de nível: `digitalWrite()`/`gpio_set_level()` do ESP-IDF
    // (`hal/esp32/include/hal/gpio_ll.h::gpio_ll_set_level`) usam EXCLUSIVAMENTE estes dois
    // registradores, nunca escrevem `GPIO_OUT_REG` (0x04) diretamente -- só firmware/bootloader
    // de baixo nível tocaria 0x04 cru. Sem tratar isto aqui, todo `digitalWrite()` normal seria um
    // no-op silencioso (bit nunca chega a `chip.gpioOut`), completando a modelagem que faltava
    // (achado 2026-07-17, revisão "pente fino").
    if (offset == 0x08) {
        chip.gpioOut |= value32;
        return;
    }
    if (offset == 0x0C) {
        chip.gpioOut &= ~value32;
        return;
    }
    if (offset == 0x20) {
        chip.gpioEnable = value32;
        return;
    }
    // GPIO_ENABLE_W1TS_REG/GPIO_ENABLE_W1TC_REG (0x24/0x28) -- mesmo padrão de ação acima, usado
    // por `gpio_set_direction()`/`pinMode()` real.
    if (offset == 0x24) {
        chip.gpioEnable |= value32;
        return;
    }
    if (offset == 0x28) {
        chip.gpioEnable &= ~value32;
        return;
    }
    if (offset >= 0x88 && offset < 0x130) {
        const uint32_t pin = static_cast<uint32_t>((offset - 0x88) / 4u);
        if (pin < chip.gpioPinRegs.size()) chip.gpioPinRegs[pin] = value32;
        return;
    }
    if (offset >= 0x130 && offset < 0x530) {
        const uint32_t func = static_cast<uint32_t>((offset - 0x130) / 4u);
        if (func < chip.matrixInRegs.size()) {
            chip.matrixInRegs[func] = value32;
            const uint32_t pin = value32 & 0x3Fu;
            if (pin < 40) routePinInputAt(chip, pin, nowNs);
        }
        return;
    }
    if (offset >= 0x530 && offset < 0x5D0) {
        const uint32_t pin = static_cast<uint32_t>((offset - 0x530) / 4u);
        if (pin < chip.matrixOutRegs.size()) {
            chip.matrixOutRegs[pin] = value32;
            if (analogTraceEnabled() && pin == 27) {
                std::fprintf(stderr, "[LasecSimul][adapter][GPIO27] matrix=0x%08x signal=%u\n",
                             value32, value32 & 0xFFu);
            }
        }
    }
}

void gpioWriteRegister(LsdnQemuModule* module, uint64_t address, uint64_t value) {
    gpioWriteRegisterAt(module, address, value, 0);
}

uint64_t gpioReadRegister(LsdnQemuModule* module, uint64_t address) {
    auto* s = reinterpret_cast<GpioModuleState*>(module);
    const uint64_t offset = address - kGpioStart;
    if (offset == 0x3C) return readPort(*s->chip, false);
    if (offset == 0x40) return readPort(*s->chip, true);
    return 0;
}

int32_t gpioIsOutputEnabled(LsdnQemuModule* module, uint32_t bit) {
    auto* s = reinterpret_cast<GpioModuleState*>(module);
    const Esp32SharedState& chip = *s->chip;
    if (bit >= 34) return 0; // GPIO34-39 are input-only

    const SignalDesc signal = selectedPinOutputSignal(chip, bit);
    bool enabled = signalOutputEnabled(chip, signal);

    if (bit < chip.matrixOutRegs.size() && selectedIoMuxIndex(chip, bit) == 2) {
        const uint32_t cfg = chip.matrixOutRegs[bit];
        if ((cfg & (1u << 10)) != 0) enabled = (bit < 32) && (chip.gpioEnable & (1u << bit)) != 0;
        if ((cfg & (1u << 11)) != 0) enabled = !enabled;
    }
    if (analogTraceEnabled() && bit == 27) {
        static int previous = -1;
        const int current = enabled ? 1 : 0;
        if (current != previous) {
            std::fprintf(stderr,
                         "[LasecSimul][adapter][GPIO27] output_enabled=%d mux=%u matrix=0x%08x\n",
                         current, selectedIoMuxIndex(chip, bit), chip.matrixOutRegs[bit]);
            previous = current;
        }
    }
    return enabled ? 1 : 0;
}

int32_t gpioOutputLevel(LsdnQemuModule* module, uint32_t bit) {
    auto* s = reinterpret_cast<GpioModuleState*>(module);
    const Esp32SharedState& chip = *s->chip;
    if (bit >= 34) return 0;

    const SignalDesc signal = selectedPinOutputSignal(chip, bit);
    bool level = signalOutputLevel(chip, signal);
    if (bit < chip.matrixOutRegs.size() && selectedIoMuxIndex(chip, bit) == 2) {
        if ((chip.matrixOutRegs[bit] & (1u << 9)) != 0) level = !level;
    }
    if (analogTraceEnabled() && bit == 27) {
        static int previous = -1;
        static uint32_t changes = 0;
        const int current = level ? 1 : 0;
        if (current != previous && changes < 32) {
            std::fprintf(stderr,
                         "[LasecSimul][adapter][GPIO27] output_level=%d ledc0=%d mux=%u\n",
                         current, chip.ledc.outputLevel[0] ? 1 : 0, selectedIoMuxIndex(chip, bit));
            previous = current;
            ++changes;
        }
    }
    return level ? 1 : 0;
}

void gpioSetInputLevelAt(LsdnQemuModule* module, uint32_t bit, int32_t level, uint64_t nowNs) {
    auto* s = reinterpret_cast<GpioModuleState*>(module);
    Esp32SharedState& chip = *s->chip;
    if (bit >= chip.gpioInputs.size()) return;
    chip.gpioInputs[bit] = level != 0;
    routePinInputAt(chip, bit, nowNs);
}

void gpioSetInputLevel(LsdnQemuModule* module, uint32_t bit, int32_t level) {
    gpioSetInputLevelAt(module, bit, level, 0);
}

void gpioSetInputVoltageAt(LsdnQemuModule* module, uint32_t bit, double voltage, uint64_t nowNs) {
    auto* s = reinterpret_cast<GpioModuleState*>(module);
    Esp32SharedState& chip = *s->chip;
    if (bit >= chip.gpioInputs.size()) return;
    chip.gpioVoltages[bit] = voltage;
    chip.gpioInputs[bit] = voltage > 1.65;
    routePinInputAt(chip, bit, nowNs);
}

void gpioDestroy(LsdnQemuModule* module) {
    delete reinterpret_cast<GpioModuleState*>(module);
}

const LsdnQemuModuleVTable kGpioModuleVTable = {
    &gpioReset, &gpioWriteRegister, &gpioReadRegister, &gpioIsOutputEnabled, &gpioOutputLevel,
    &gpioSetInputLevel, &gpioDestroy, nullptr, nullptr, &gpioWriteRegisterAt, &gpioSetInputLevelAt, nullptr,
    &gpioSetInputVoltageAt,
};

void ioMuxReset(LsdnQemuModule* module) {
    auto* s = reinterpret_cast<IoMuxModuleState*>(module);
    s->chip->ioMuxRegs.fill(0);
}

void ioMuxWriteRegisterAt(LsdnQemuModule* module, uint64_t address, uint64_t value, uint64_t nowNs) {
    auto* s = reinterpret_cast<IoMuxModuleState*>(module);
    Esp32SharedState& chip = *s->chip;
    const uint64_t offset = address - kIoMuxStart;
    const int pin = getIoMuxPin(offset);
    if (pin < 0) return;
    chip.ioMuxRegs[static_cast<size_t>(pin)] = static_cast<uint16_t>(value);
    if (analogTraceEnabled() && pin == 27) {
        std::fprintf(stderr, "[LasecSimul][adapter][GPIO27] iomux=0x%08llx mux=%u\n",
                     static_cast<unsigned long long>(value), selectedIoMuxIndex(chip, 27));
    }
    routePinInputAt(chip, static_cast<uint32_t>(pin), nowNs);
}

void ioMuxWriteRegister(LsdnQemuModule* module, uint64_t address, uint64_t value) {
    ioMuxWriteRegisterAt(module, address, value, 0);
}

uint64_t ioMuxReadRegister(LsdnQemuModule* module, uint64_t address) {
    auto* s = reinterpret_cast<IoMuxModuleState*>(module);
    const uint64_t offset = address - kIoMuxStart;
    const int pin = getIoMuxPin(offset);
    if (pin < 0) return 0;
    return s->chip->ioMuxRegs[static_cast<size_t>(pin)];
}

void ioMuxDestroy(LsdnQemuModule* module) {
    delete reinterpret_cast<IoMuxModuleState*>(module);
}

const LsdnQemuModuleVTable kIoMuxModuleVTable = {
    &ioMuxReset, &ioMuxWriteRegister, &ioMuxReadRegister, nullptr, nullptr, nullptr, &ioMuxDestroy,
    nullptr, nullptr, &ioMuxWriteRegisterAt, nullptr, nullptr,
};

void usartReset(LsdnQemuModule* module) {
    auto* s = reinterpret_cast<UsartModuleState*>(module);
    s->chip->usarts[s->index] = {};
}

void usartWriteRegisterAt(LsdnQemuModule* module, uint64_t address, uint64_t value, uint64_t nowNs) {
    auto* s = reinterpret_cast<UsartModuleState*>(module);
    if (s->index >= s->chip->usarts.size()) return;

    UsartState& usart = s->chip->usarts[s->index];
    const uint64_t offset = address - usartStartAddress(s->index);
    const uint32_t data = static_cast<uint32_t>(value);

    switch (offset) {
        case 0x00:
            if (usart.txFifo.size() < 128) {
                usart.txFifo.push_back(static_cast<uint8_t>(data & 0xFFu));
                usartStartTx(usart, nowNs);
            }
            break;
        case 0x14:
            usartWriteClkDiv(usart, data);
            break;
        case 0x20:
            usartWriteConf0(usart, data);
            break;
        default:
            break;
    }
}

void usartWriteRegister(LsdnQemuModule* module, uint64_t address, uint64_t value) {
    usartWriteRegisterAt(module, address, value, 0);
}

uint64_t usartReadRegister(LsdnQemuModule* module, uint64_t address) {
    auto* s = reinterpret_cast<UsartModuleState*>(module);
    if (s->index >= s->chip->usarts.size()) return 0;

    UsartState& usart = s->chip->usarts[s->index];
    const uint64_t offset = address - usartStartAddress(s->index);
    switch (offset) {
        case 0x00:
            if (usart.rxFifo.empty()) return 0;
            {
                const uint8_t data = usart.rxFifo.front();
                usart.rxFifo.pop_front();
                return data;
            }
        case 0x1C:
            return static_cast<uint64_t>(usart.rxFifo.size()) |
                   (static_cast<uint64_t>(usart.txFifo.size()) << 16u);
        case 0x60:
            return static_cast<uint64_t>(usart.rxFifo.size() & 0x7Fu) << 13u;
        case 0x78:
            return 0x15122500u;
        default:
            return 0;
    }
}
int32_t usartIsOutputEnabled(LsdnQemuModule* module, uint32_t line) {
    auto* s = reinterpret_cast<UsartModuleState*>(module);
    return line == kUartTxLine && s->index < s->chip->usarts.size() ? 1 : 0;
}
int32_t usartOutputLevel(LsdnQemuModule* module, uint32_t line) {
    auto* s = reinterpret_cast<UsartModuleState*>(module);
    return line == kUartTxLine && s->index < s->chip->usarts.size() && s->chip->usarts[s->index].txLevel ? 1 : 0;
}
void usartSetInputLevel(LsdnQemuModule* module, uint32_t line, int32_t level) {
    auto* s = reinterpret_cast<UsartModuleState*>(module);
    if (line == kUartRxLine && s->index < s->chip->usarts.size()) {
        usartSetRxLevel(s->chip->usarts[s->index], level != 0, 0);
    }
}
void usartSetInputLevelAt(LsdnQemuModule* module, uint32_t line, int32_t level, uint64_t nowNs) {
    auto* s = reinterpret_cast<UsartModuleState*>(module);
    if (line == kUartRxLine && s->index < s->chip->usarts.size()) {
        usartSetRxLevel(s->chip->usarts[s->index], level != 0, nowNs);
    }
}
void usartDestroy(LsdnQemuModule* module) {
    delete reinterpret_cast<UsartModuleState*>(module);
}

uint64_t usartNextWakeupDelayNsAt(LsdnQemuModule* module, uint64_t nowNs);

uint64_t usartNextWakeupDelayNs(LsdnQemuModule* module) {
    return usartNextWakeupDelayNsAt(module, 0);
}

uint64_t usartNextWakeupDelayNsAt(LsdnQemuModule* module, uint64_t nowNs) {
    auto* s = reinterpret_cast<UsartModuleState*>(module);
    if (s->index >= s->chip->usarts.size()) return LSDN_QEMU_MODULE_NO_WAKEUP;
    return nextUsartWakeupDelayNs(s->chip->usarts[s->index], nowNs);
}

void usartOnWakeup(LsdnQemuModule* module, uint64_t nowNs) {
    auto* s = reinterpret_cast<UsartModuleState*>(module);
    if (s->index >= s->chip->usarts.size()) return;
    usartAdvanceDueWork(s->chip->usarts[s->index], nowNs);
}

const LsdnQemuModuleVTable kUsartModuleVTable = {
    &usartReset, &usartWriteRegister, &usartReadRegister, &usartIsOutputEnabled, &usartOutputLevel,
    &usartSetInputLevel, &usartDestroy, &usartNextWakeupDelayNs, &usartOnWakeup,
    &usartWriteRegisterAt, &usartSetInputLevelAt, &usartNextWakeupDelayNsAt,
};

void i2cReset(LsdnQemuModule* module) {
    auto* s = reinterpret_cast<I2cModuleState*>(module);
    s->chip->i2cs[s->index] = {};
}

void i2cWriteRegister(LsdnQemuModule*, uint64_t, uint64_t) {}
uint64_t i2cReadRegister(LsdnQemuModule*, uint64_t) { return 0; }
int32_t i2cIsOutputEnabled(LsdnQemuModule* module, uint32_t line) {
    auto* s = reinterpret_cast<I2cModuleState*>(module);
    if (s->index >= s->chip->i2cs.size()) return 0;
    if (line == kI2cSclLine) return s->chip->i2cs[s->index].sclOutputEnabled ? 1 : 0;
    if (line == kI2cSdaLine) return s->chip->i2cs[s->index].sdaOutputEnabled ? 1 : 0;
    return 0;
}
int32_t i2cOutputLevel(LsdnQemuModule* module, uint32_t line) {
    auto* s = reinterpret_cast<I2cModuleState*>(module);
    if (s->index >= s->chip->i2cs.size()) return 0;
    if (line == kI2cSclLine) return s->chip->i2cs[s->index].sclOutputLevel ? 1 : 0;
    if (line == kI2cSdaLine) return s->chip->i2cs[s->index].sdaOutputLevel ? 1 : 0;
    return 0;
}
void i2cSetInputLevel(LsdnQemuModule* module, uint32_t line, int32_t level) {
    auto* s = reinterpret_cast<I2cModuleState*>(module);
    if (s->index >= s->chip->i2cs.size()) return;
    if (line == kI2cSclLine) s->chip->i2cs[s->index].sclInput = level != 0;
    if (line == kI2cSdaLine) s->chip->i2cs[s->index].sdaInput = level != 0;
}
void i2cDestroy(LsdnQemuModule* module) {
    delete reinterpret_cast<I2cModuleState*>(module);
}

const LsdnQemuModuleVTable kI2cModuleVTable = {
    &i2cReset, &i2cWriteRegister, &i2cReadRegister, &i2cIsOutputEnabled, &i2cOutputLevel,
    &i2cSetInputLevel, &i2cDestroy,
};

void spiReset(LsdnQemuModule* module) {
    auto* s = reinterpret_cast<SpiModuleState*>(module);
    s->chip->spis[s->index] = {};
}

void spiWriteRegister(LsdnQemuModule*, uint64_t, uint64_t) {}
uint64_t spiReadRegister(LsdnQemuModule*, uint64_t) { return 0; }
int32_t spiIsOutputEnabled(LsdnQemuModule* module, uint32_t line) {
    auto* s = reinterpret_cast<SpiModuleState*>(module);
    if (s->index >= s->chip->spis.size()) return 0;
    const SpiState& spi = s->chip->spis[s->index];
    switch (line) {
        case kSpiClkLine: return spi.clkOutputEnabled ? 1 : 0;
        case kSpiMisoLine: return spi.misoOutputEnabled ? 1 : 0;
        case kSpiMosiLine: return spi.mosiOutputEnabled ? 1 : 0;
        case kSpiCs0Line: return spi.cs0OutputEnabled ? 1 : 0;
        default: return 0;
    }
}
int32_t spiOutputLevel(LsdnQemuModule* module, uint32_t line) {
    auto* s = reinterpret_cast<SpiModuleState*>(module);
    if (s->index >= s->chip->spis.size()) return 0;
    const SpiState& spi = s->chip->spis[s->index];
    switch (line) {
        case kSpiClkLine: return spi.clkOutputLevel ? 1 : 0;
        case kSpiMisoLine: return spi.misoOutputLevel ? 1 : 0;
        case kSpiMosiLine: return spi.mosiOutputLevel ? 1 : 0;
        case kSpiCs0Line: return spi.cs0OutputLevel ? 1 : 0;
        default: return 0;
    }
}
void spiSetInputLevel(LsdnQemuModule* module, uint32_t line, int32_t level) {
    auto* s = reinterpret_cast<SpiModuleState*>(module);
    if (s->index >= s->chip->spis.size()) return;
    SpiState& spi = s->chip->spis[s->index];
    switch (line) {
        case kSpiClkLine: spi.clkInput = level != 0; break;
        case kSpiMisoLine: spi.misoInput = level != 0; break;
        case kSpiMosiLine: spi.mosiInput = level != 0; break;
        case kSpiCs0Line: spi.cs0Input = level != 0; break;
        default: break;
    }
}
void spiDestroy(LsdnQemuModule* module) {
    delete reinterpret_cast<SpiModuleState*>(module);
}

const LsdnQemuModuleVTable kSpiModuleVTable = {
    &spiReset, &spiWriteRegister, &spiReadRegister, &spiIsOutputEnabled, &spiOutputLevel,
    &spiSetInputLevel, &spiDestroy,
};

bool selectedAdcChannel(uint32_t value, uint8_t& channel) {
    const uint32_t mask = (value & 0x7FF80000u) >> 19u;
    if (mask == 0) return false;
    for (uint8_t bit = 0; bit < 16; ++bit) {
        if ((mask & (1u << bit)) != 0) {
            channel = bit;
            return true;
        }
    }
    return false;
}

int adcChannelToGpio(bool adc2, uint8_t channel) {
    static constexpr std::array<int, 8> kAdc1Gpio = {36, 37, 38, 39, 32, 33, 34, 35};
    static constexpr std::array<int, 10> kAdc2Gpio = {4, 0, 2, 15, 13, 12, 14, 27, 25, 26};
    if (!adc2) return channel < kAdc1Gpio.size() ? kAdc1Gpio[channel] : -1;
    return channel < kAdc2Gpio.size() ? kAdc2Gpio[channel] : -1;
}

uint16_t adcRawFromVoltage(double voltage) {
    // Modelo eletrico inicial: 12 bits no intervalo nominal 0..3,3 V. A nao-linearidade e as
    // curvas por atenuacao do ADC real podem ser acrescentadas depois sem mudar a ABI.
    const double clamped = std::clamp(voltage, 0.0, 3.3);
    return static_cast<uint16_t>(std::lround(clamped * 4095.0 / 3.3));
}

void adcReset(LsdnQemuModule* module) {
    auto* s = reinterpret_cast<AdcModuleState*>(module);
    s->channel1 = 0;
    s->channel2 = 0;
}

void adcWriteRegister(LsdnQemuModule* module, uint64_t address, uint64_t value) {
    auto* s = reinterpret_cast<AdcModuleState*>(module);
    const uint64_t offset = address - kAdcStart;
    // O ESP-IDF escreve o registrador START diversas vezes durante uma conversao. Algumas
    // dessas escritas alteram apenas START/FORCE e deixam o bitmap de canais zerado. Nesse
    // caso o canal previamente selecionado precisa ser preservado; zerar para ADC1_CH0 fazia
    // uma leitura valida ser seguida por GPIO36=0 V e analogRead() acabava retornando zero.
    if (offset == 0x54) {
        selectedAdcChannel(static_cast<uint32_t>(value), s->channel1);
    } else if (offset == 0x94) {
        selectedAdcChannel(static_cast<uint32_t>(value), s->channel2);
    }
}

uint64_t adcReadRegister(LsdnQemuModule* module, uint64_t address) {
    auto* s = reinterpret_cast<AdcModuleState*>(module);
    const uint64_t offset = address - kAdcStart;
    const bool adc2 = offset == 0x94;
    if (offset != 0x54 && !adc2) return 0;
    const int gpio = adcChannelToGpio(adc2, adc2 ? s->channel2 : s->channel1);
    if (gpio < 0 || static_cast<size_t>(gpio) >= s->chip->gpioVoltages.size()) return 0;
    return adcRawFromVoltage(s->chip->gpioVoltages[static_cast<size_t>(gpio)]);
}

void adcDestroy(LsdnQemuModule* module) {
    delete reinterpret_cast<AdcModuleState*>(module);
}

const LsdnQemuModuleVTable kAdcModuleVTable = {
    &adcReset, &adcWriteRegister, &adcReadRegister, nullptr, nullptr, nullptr, &adcDestroy,
};

uint64_t ledcPeriodNs(uint32_t config, uint8_t& dutyResolution, bool lowSpeed) {
    dutyResolution = static_cast<uint8_t>(config & 0x1Fu);
    const uint32_t dividerFixed8 = (config & 0x007FFFE0u) >> 5u;
    if (dutyResolution == 0 || dividerFixed8 == 0) return 0;

    uint64_t sourceHz = 1'000'000;
    if ((config & 0x02000000u) != 0) sourceHz = lowSpeed ? 80'000'000 : 80'000'000;
    const long double ticks = (static_cast<long double>(dividerFixed8) / 256.0L) *
                              static_cast<long double>(uint64_t(1) << dutyResolution);
    return std::max<uint64_t>(1, static_cast<uint64_t>(std::llround(ticks * 1.0e9L / sourceHz)));
}

void ledcRestartChannel(Esp32SharedState& chip, uint32_t channel, uint64_t nowNs) {
    if (channel >= chip.ledc.outputLevel.size()) return;
    const uint32_t timer = chip.ledc.channelTimer[channel];
    if (timer >= chip.ledc.periodNs.size()) return;
    const uint64_t period = chip.ledc.periodNs[timer];
    const uint8_t resolution = chip.ledc.dutyResolution[timer];
    if (analogTraceEnabled() && channel == 0) {
        static uint32_t messages = 0;
        if (messages < 32) {
            std::fprintf(stderr,
                         "[LasecSimul][adapter][LEDC0] timer=%u period_ns=%llu resolution=%u duty=%u now=%llu\n",
                         timer, static_cast<unsigned long long>(period), resolution,
                         chip.ledc.dutyRaw[channel], static_cast<unsigned long long>(nowNs));
            ++messages;
        }
    }
    if (period == 0 || resolution == 0) {
        chip.ledc.outputLevel[channel] = false;
        chip.ledc.nextEdgeNs[channel] = 0;
        return;
    }

    const uint64_t fullScale = uint64_t(1) << resolution;
    const uint64_t duty = std::min<uint64_t>(chip.ledc.dutyRaw[channel], fullScale);
    if (duty == 0) {
        chip.ledc.outputLevel[channel] = false;
        chip.ledc.nextEdgeNs[channel] = 0;
        return;
    }
    if (duty >= fullScale || period <= 1) {
        chip.ledc.outputLevel[channel] = true;
        chip.ledc.nextEdgeNs[channel] = 0;
        return;
    }

    const uint64_t highNs = std::clamp<uint64_t>((period * duty) / fullScale, 1, period - 1);
    chip.ledc.outputLevel[channel] = true;
    chip.ledc.nextEdgeNs[channel] = addDelayNs(nowNs, highNs);
}

void ledcReset(LsdnQemuModule* module) {
    auto* s = reinterpret_cast<LedcModuleState*>(module);
    s->chip->ledc = LedcState{};
}

void ledcWriteRegisterAt(LsdnQemuModule* module, uint64_t address, uint64_t value, uint64_t nowNs) {
    auto* s = reinterpret_cast<LedcModuleState*>(module);
    Esp32SharedState& chip = *s->chip;
    const uint64_t offset = address - kLedcStart;
    const uint32_t value32 = static_cast<uint32_t>(value);

    if (offset >= 0x140 && offset <= 0x178 && ((offset - 0x140) % 8u) == 0) {
        const uint32_t timer = static_cast<uint32_t>((offset - 0x140) / 8u);
        chip.ledc.timerConfig[timer] = value32;
        chip.ledc.periodNs[timer] = ledcPeriodNs(value32, chip.ledc.dutyResolution[timer], timer >= 4);
        if (analogTraceEnabled()) {
            std::fprintf(stderr,
                         "[LasecSimul][adapter][LEDC] timer=%u config=0x%08x period_ns=%llu resolution=%u\n",
                         timer, value32, static_cast<unsigned long long>(chip.ledc.periodNs[timer]),
                         chip.ledc.dutyResolution[timer]);
        }
        for (uint32_t channel = 0; channel < chip.ledc.channelTimer.size(); ++channel) {
            if (chip.ledc.channelTimer[channel] == timer) ledcRestartChannel(chip, channel, nowNs);
        }
        return;
    }

    if (offset < 0x140) {
        const uint32_t channel = static_cast<uint32_t>(offset / 0x14u);
        const uint32_t registerOffset = static_cast<uint32_t>(offset % 0x14u);
        if (channel >= chip.ledc.channelTimer.size()) return;
        if (registerOffset == 0) {
            chip.ledc.channelTimer[channel] = static_cast<uint8_t>((value32 & 0x3u) + (channel >= 8 ? 4u : 0u));
            ledcRestartChannel(chip, channel, nowNs);
        } else if (registerOffset == 8) {
            chip.ledc.dutyRaw[channel] = (value32 >> 4u) & 0xFFFFFu;
            ledcRestartChannel(chip, channel, nowNs);
        }
    }
}

void ledcWriteRegister(LsdnQemuModule* module, uint64_t address, uint64_t value) {
    ledcWriteRegisterAt(module, address, value, 0);
}

uint64_t ledcReadRegister(LsdnQemuModule*, uint64_t) { return 0; }

uint64_t ledcNextWakeupAt(LsdnQemuModule* module, uint64_t nowNs) {
    auto* s = reinterpret_cast<LedcModuleState*>(module);
    uint64_t nearest = LSDN_QEMU_MODULE_NO_WAKEUP;
    for (const uint64_t edge : s->chip->ledc.nextEdgeNs) {
        if (edge == 0) continue;
        nearest = std::min(nearest, edge <= nowNs ? uint64_t(0) : edge - nowNs);
    }
    return nearest;
}

void ledcOnWakeup(LsdnQemuModule* module, uint64_t nowNs) {
    auto* s = reinterpret_cast<LedcModuleState*>(module);
    Esp32SharedState& chip = *s->chip;
    for (uint32_t channel = 0; channel < chip.ledc.nextEdgeNs.size(); ++channel) {
        if (chip.ledc.nextEdgeNs[channel] == 0 || chip.ledc.nextEdgeNs[channel] > nowNs) continue;
        const uint32_t timer = chip.ledc.channelTimer[channel];
        if (timer >= chip.ledc.periodNs.size()) continue;
        const uint64_t period = chip.ledc.periodNs[timer];
        const uint8_t resolution = chip.ledc.dutyResolution[timer];
        const uint64_t fullScale = resolution == 0 ? 0 : uint64_t(1) << resolution;
        const uint64_t duty = fullScale == 0 ? 0 : std::min<uint64_t>(chip.ledc.dutyRaw[channel], fullScale);
        if (period <= 1 || duty == 0 || duty >= fullScale) {
            ledcRestartChannel(chip, channel, nowNs);
            continue;
        }
        const uint64_t highNs = std::clamp<uint64_t>((period * duty) / fullScale, 1, period - 1);
        chip.ledc.outputLevel[channel] = !chip.ledc.outputLevel[channel];
        chip.ledc.nextEdgeNs[channel] = addDelayNs(
            nowNs, chip.ledc.outputLevel[channel] ? highNs : period - highNs);
    }
}

void ledcDestroy(LsdnQemuModule* module) {
    delete reinterpret_cast<LedcModuleState*>(module);
}

const LsdnQemuModuleVTable kLedcModuleVTable = {
    &ledcReset, &ledcWriteRegister, &ledcReadRegister, nullptr, nullptr, nullptr, &ledcDestroy,
    nullptr, &ledcOnWakeup, &ledcWriteRegisterAt, nullptr, &ledcNextWakeupAt,
};

const LsdnMemoryRegion kMemoryRegions[] = {
    {kUart0Start, kUart0End, LSDN_MODULE_USART, 0},
    {kGpioStart, kGpioEnd, LSDN_MODULE_GPIO, 0},
    {kAdcStart, kAdcEnd, LSDN_MODULE_ADC, 0},
    {kIoMuxStart, kIoMuxEnd, LSDN_MODULE_IOMUX, 0},
    {kUart1Start, kUart1End, LSDN_MODULE_USART, 1},
    {kLedcStart, kLedcEnd, LSDN_MODULE_PWM, 0},
    {kI2c0Start, kI2c0End, LSDN_MODULE_I2C, 0},
    {kSpi0Start, kSpi0End, LSDN_MODULE_SPI, 0},
    {kSpi1Start, kSpi1End, LSDN_MODULE_SPI, 1},
    {kI2c1Start, kI2c1End, LSDN_MODULE_I2C, 1},
    {kUart2Start, kUart2End, LSDN_MODULE_USART, 2},
};

/** Caminho ABSOLUTO do próprio módulo (.dll/.so) carregado, ou vazio se a resolução falhar. Usa a
 * API nativa de cada SO (nunca `argv[0]`/CWD do processo host, que aqui é o Core, um executável
 * DIFERENTE deste plugin). */
std::string resolveOwnModuleDirectory() {
#if defined(_WIN32)
    HMODULE module = nullptr;
    if (!GetModuleHandleExA(
            GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS | GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
            reinterpret_cast<LPCSTR>(&resolveOwnModuleDirectory), &module)) {
        return {};
    }
    char buffer[MAX_PATH] = {};
    const DWORD length = GetModuleFileNameA(module, buffer, MAX_PATH);
    if (length == 0 || length == MAX_PATH) return {};
    return std::filesystem::path(buffer).parent_path().string();
#else
    Dl_info info{};
    if (!dladdr(reinterpret_cast<void*>(&resolveOwnModuleDirectory), &info) || !info.dli_fname) return {};
    return std::filesystem::path(info.dli_fname).parent_path().string();
#endif
}

/** ROM do QEMU (`-L`, ver `buildLaunchArgs` abaixo) mora em `devices/qemu-esp32/bin/esp32/rom/bin`,
 * SEMPRE irmão de `mcu-adapters/` -- tanto no repo de desenvolvimento quanto dentro de `bundled/` no
 * pacote instalado (`scripts/package-release.js::stageBundledAssets` copia os dois como irmãos sob a
 * mesma raiz). Esse adaptador (.dll/.so) é sempre buildado/copiado em
 * `mcu-adapters/espressif-esp32/build/<plataforma>/adapter.{dll,so}`
 * (`scripts/build-mcu-adapters.js`) -- 4 níveis acima da raiz comum, de onde desce de volta pra
 * `devices/qemu-esp32/bin/esp32/rom/bin`.
 *
 * Bug real corrigido aqui: o valor antigo era um caminho relativo FIXO
 * (`"devices/qemu-esp32/bin/esp32/rom/bin"`), relativo ao diretório de trabalho do processo do
 * CORE (não deste plugin) -- que é `dirname` do executável do Core
 * (`CoreProcess.ts::spawnOpts.cwd`), nunca a pasta de instalação real. Calculado a partir do
 * caminho REAL do próprio módulo carregado em vez disso. Cai pro caminho relativo antigo só se a
 * resolução do próprio módulo falhar (nunca pior que o comportamento de antes). */
std::string resolveDefaultRomDir() {
    const std::string ownDir = resolveOwnModuleDirectory();
    if (ownDir.empty()) return "devices/qemu-esp32/bin/esp32/rom/bin";
    const std::filesystem::path romPath = std::filesystem::path(ownDir) / ".." / ".." / ".." / ".."
        / "devices" / "qemu-esp32" / "bin" / "esp32" / "rom" / "bin";
    return romPath.lexically_normal().string();
}

struct Esp32AdapterState {
    void* hostCtx = nullptr;
    const LsdnMcuHostApi* api = nullptr;
    Esp32SharedState chip;
    std::vector<std::string> pinIdStorage;
    std::vector<LsdnPinMapping> pinMapStorage;
    std::vector<std::string> launchArgStorage;
    std::vector<const char*> launchArgs;
    std::string romDir = resolveDefaultRomDir();
};

void buildPinMap(Esp32AdapterState* state) {
    state->pinIdStorage.clear();
    state->pinMapStorage.clear();
    state->pinIdStorage.reserve(43);
    state->pinMapStorage.reserve(43);

    for (uint32_t gpio = 0; gpio <= 39; ++gpio) {
        state->pinIdStorage.push_back("GPIO" + std::to_string(gpio));
    }
    state->pinIdStorage.push_back("UART0_RX");
    state->pinIdStorage.push_back("UART0_TX");
    state->pinIdStorage.push_back("RST"); // EN do ESP32 real -- reset de hardware, não GPIO comum

    for (uint32_t gpio = 0; gpio <= 39; ++gpio) {
        state->pinMapStorage.push_back(
            LsdnPinMapping{state->pinIdStorage[gpio].c_str(), LSDN_MODULE_GPIO, 0, gpio});
    }
    state->pinMapStorage.push_back(
        LsdnPinMapping{state->pinIdStorage[40].c_str(), LSDN_MODULE_USART, 0, kUartRxLine});
    state->pinMapStorage.push_back(
        LsdnPinMapping{state->pinIdStorage[41].c_str(), LSDN_MODULE_USART, 0, kUartTxLine});
    state->pinMapStorage.push_back(
        LsdnPinMapping{state->pinIdStorage[42].c_str(), LSDN_MODULE_RESET, 0, 0});
}

LsdnMcuAdapter* create(void* hostCtx, const LsdnMcuHostApi* api) {
    auto* state = new Esp32AdapterState();
    state->hostCtx = hostCtx;
    state->api = api;
    configureIoMux(state->chip);
    buildPinMap(state);
    return reinterpret_cast<LsdnMcuAdapter*>(state);
}

LsdnQemuLaunchSpec buildLaunchArgs(LsdnMcuAdapter* adapter, const char* firmwarePath) {
    auto* state = reinterpret_cast<Esp32AdapterState*>(adapter);
    state->launchArgStorage = {
        "qemu-system-xtensa",
        "-M",
        "esp32-simul",
        "-display",
        "none",
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

uint32_t createModules(LsdnMcuAdapter* adapter, LsdnQemuModuleHandle* out, uint32_t cap) {
    auto* state = reinterpret_cast<Esp32AdapterState*>(adapter);
    constexpr uint32_t kCount = 11;
    if (!out || cap < kCount) return kCount;

    out[0] = LsdnQemuModuleHandle{
        LSDN_MODULE_GPIO, 0, reinterpret_cast<LsdnQemuModule*>(new GpioModuleState{&state->chip}), &kGpioModuleVTable,
    };
    out[1] = LsdnQemuModuleHandle{
        LSDN_MODULE_IOMUX, 0, reinterpret_cast<LsdnQemuModule*>(new IoMuxModuleState{&state->chip}), &kIoMuxModuleVTable,
    };
    out[2] = LsdnQemuModuleHandle{
        LSDN_MODULE_USART, 0, reinterpret_cast<LsdnQemuModule*>(new UsartModuleState{&state->chip, 0}), &kUsartModuleVTable,
    };
    out[3] = LsdnQemuModuleHandle{
        LSDN_MODULE_USART, 1, reinterpret_cast<LsdnQemuModule*>(new UsartModuleState{&state->chip, 1}), &kUsartModuleVTable,
    };
    out[4] = LsdnQemuModuleHandle{
        LSDN_MODULE_USART, 2, reinterpret_cast<LsdnQemuModule*>(new UsartModuleState{&state->chip, 2}), &kUsartModuleVTable,
    };
    out[5] = LsdnQemuModuleHandle{
        LSDN_MODULE_I2C, 0, reinterpret_cast<LsdnQemuModule*>(new I2cModuleState{&state->chip, 0}), &kI2cModuleVTable,
    };
    out[6] = LsdnQemuModuleHandle{
        LSDN_MODULE_I2C, 1, reinterpret_cast<LsdnQemuModule*>(new I2cModuleState{&state->chip, 1}), &kI2cModuleVTable,
    };
    out[7] = LsdnQemuModuleHandle{
        LSDN_MODULE_SPI, 0, reinterpret_cast<LsdnQemuModule*>(new SpiModuleState{&state->chip, 0}), &kSpiModuleVTable,
    };
    out[8] = LsdnQemuModuleHandle{
        LSDN_MODULE_SPI, 1, reinterpret_cast<LsdnQemuModule*>(new SpiModuleState{&state->chip, 1}), &kSpiModuleVTable,
    };
    out[9] = LsdnQemuModuleHandle{
        LSDN_MODULE_ADC, 0, reinterpret_cast<LsdnQemuModule*>(new AdcModuleState{&state->chip}), &kAdcModuleVTable,
    };
    out[10] = LsdnQemuModuleHandle{
        LSDN_MODULE_PWM, 0, reinterpret_cast<LsdnQemuModule*>(new LedcModuleState{&state->chip}), &kLedcModuleVTable,
    };
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
