#pragma once

#include <cstdint>

#include "lasecsimul/Types.hpp"
#include "lasecsimul/fpga_arena_abi.h"

namespace lasecsimul::fpga {

/** Estado IEEE 1164 std_logic (9 valores) -- confinado à camada FPGA (FpgaPortMapper/
 * FpgaComponent/payloads da arena GHDL). NÃO se propaga pro resto do Core: o modelo digital
 * existente (portas lógicas, McuComponent) continua puramente por tensão + kDigitalLevelThreshold,
 * sem nenhum estado multi-valorado -- ver `.claude/plans/golden-puzzling-quasar.md`.
 *
 * Ordem dos valores casa com a ordem canônica VHDL ('U','X','0','1','Z','W','L','H','-') pra
 * `toChar`/`fromChar` ficarem uma tabela direta. */
enum class LogicValue : uint8_t {
    U = LSDN_FPGA_LOGIC_U,               // uninitialized
    X = LSDN_FPGA_LOGIC_X,               // forcing unknown
    Zero = LSDN_FPGA_LOGIC_ZERO,         // forcing 0
    One = LSDN_FPGA_LOGIC_ONE,           // forcing 1
    Z = LSDN_FPGA_LOGIC_Z,               // high impedance
    W = LSDN_FPGA_LOGIC_W,               // weak unknown
    L = LSDN_FPGA_LOGIC_L,               // weak 0
    H = LSDN_FPGA_LOGIC_H,               // weak 1
    DontCare = LSDN_FPGA_LOGIC_DONT_CARE, // '-'
};

/** Delega pra `fpga_arena_abi.h` (`lsdnFpgaLogicValueToChar`/`lsdnFpgaCharToLogicValue`) em vez
 * de ter sua própria tabela -- aquele header é C puro e é a única coisa que o módulo VPI
 * (lasecsimul_vpi.c) enxerga, então a codificação numérica precisa morar lá; ter uma segunda
 * tabela aqui seria um risco real de divergência silenciosa entre os dois lados. */
inline char toChar(LogicValue value) { return lsdnFpgaLogicValueToChar(static_cast<uint8_t>(value)); }
inline LogicValue fromChar(char c) { return static_cast<LogicValue>(lsdnFpgaCharToLogicValue(c)); }

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
