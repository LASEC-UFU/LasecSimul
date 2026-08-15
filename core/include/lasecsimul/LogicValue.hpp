#pragma once

#include <cstdint>

#include "lasecsimul/Types.hpp"

namespace lasecsimul::fpga {

/** Estado IEEE 1164 std_logic (9 valores) -- confinado à camada FPGA (FpgaPortMapper/
 * FpgaComponent/payloads da arena GHDL). NÃO se propaga pro resto do Core: o modelo digital
 * existente (portas lógicas, McuComponent) continua puramente por tensão + kDigitalLevelThreshold,
 * sem nenhum estado multi-valorado -- ver `.claude/plans/golden-puzzling-quasar.md`.
 *
 * Ordem dos valores casa com a ordem canônica VHDL ('U','X','0','1','Z','W','L','H','-') pra
 * `toChar`/`fromChar` ficarem uma tabela direta. */
enum class LogicValue : uint8_t {
    U = 0,        // uninitialized
    X,            // forcing unknown
    Zero,         // forcing 0
    One,          // forcing 1
    Z,            // high impedance
    W,            // weak unknown
    L,            // weak 0
    H,             // weak 1
    DontCare,     // '-'
};

inline char toChar(LogicValue value) {
    switch (value) {
        case LogicValue::U: return 'U';
        case LogicValue::X: return 'X';
        case LogicValue::Zero: return '0';
        case LogicValue::One: return '1';
        case LogicValue::Z: return 'Z';
        case LogicValue::W: return 'W';
        case LogicValue::L: return 'L';
        case LogicValue::H: return 'H';
        case LogicValue::DontCare: return '-';
    }
    return 'X';
}

/** Aceita maiúsculo OU minúsculo (GHDL/VPI observado emitindo maiúsculo nos testes do Spike 0, mas
 * vpiBinStrVal do padrão VPI usa minúsculo pra x/z) -- caractere não reconhecido cai em `X` (mesma
 * postura de "desconhecido é o fallback seguro" que o resto do engine usa, nunca um crash). */
inline LogicValue fromChar(char c) {
    switch (c) {
        case 'U': case 'u': return LogicValue::U;
        case 'X': case 'x': return LogicValue::X;
        case '0': return LogicValue::Zero;
        case '1': return LogicValue::One;
        case 'Z': case 'z': return LogicValue::Z;
        case 'W': case 'w': return LogicValue::W;
        case 'L': case 'l': return LogicValue::L;
        case 'H': case 'h': return LogicValue::H;
        case '-': return LogicValue::DontCare;
        default: return LogicValue::X;
    }
}

/** Contribuição elétrica de um `LogicValue` sendo cravado num pino (via
 * `MnaMatrixView::addConductanceToGround` + `addCurrentToGround`, mesmo idioma usado por
 * McuComponent/devices/simulide-logic) -- corrente é sempre `volts * conductance`, já pronta pra
 * somar direto no stamp. */
struct DriveStamp {
    double conductance = 0.0;
    double currentSource = 0.0;
};

/** Mesmas impedâncias físicas usadas por McuComponent (`McuComponent.hpp`, comentário ali cita a
 * fonte real: `IoPin::m_outputImp`/`m_inputImp` do SimulIDE) -- repetidas aqui (não extraídas pra
 * um header compartilhado nesta passada) pra não mexer em McuComponent.hpp, que é código já
 * testado em produção; ver plano `golden-puzzling-quasar.md` sobre por que essa unificação fica
 * pra quando FpgaComponent existir de verdade. */
inline constexpr double kFpgaDriveConductance = 1.0 / 40.0;
inline constexpr double kFpgaFloatingConductance = 1.0 / 1e7;

/** Convertido pro estado elétrico que um pino de FPGA deveria assumir, dado um `LogicValue` e a
 * tensão lógica alta (`vcc`) do "chip". `X`/`U`/`W`/`DontCare` não têm tensão defensável -- caem em
 * flutuante (mesma postura eletricamente honesta de "não afirmar nada que não se sabe"), não em
 * meio-vcc. Achado do Spike 0: na prática só 0/1 chegam a ser ESCRITOS de volta pro GHDL (o
 * `vpi_put_value` desse build do GHDL não aceita depósito de estado não-binário), mas GHDL PODE
 * emitir os 9 estados como SAÍDA (leitura via VPI funcionou pra todos), então esta função continua
 * necessária pro sentido GHDL -> circuito elétrico. */
inline DriveStamp toVoltageStamp(LogicValue value, double vcc) {
    switch (value) {
        case LogicValue::One:
        case LogicValue::H:
            return DriveStamp{kFpgaDriveConductance, vcc * kFpgaDriveConductance};
        case LogicValue::Zero:
        case LogicValue::L:
            return DriveStamp{kFpgaDriveConductance, 0.0};
        case LogicValue::Z:
        case LogicValue::X:
        case LogicValue::U:
        case LogicValue::W:
        case LogicValue::DontCare:
        default:
            return DriveStamp{kFpgaFloatingConductance, 0.0};
    }
}

/** Leitura de um pino de entrada (tensão analógica -> LogicValue). Só pode retornar `Zero`/`One`
 * -- uma única amostra de tensão nunca revela X/Z/U/etc, mesma limitação de qualquer pino real de
 * hardware (e do resto do Core, que também só conhece `kDigitalLevelThreshold`). */
inline LogicValue fromVoltage(double voltage) {
    return voltage > kDigitalLevelThreshold ? LogicValue::One : LogicValue::Zero;
}

} // namespace lasecsimul::fpga
