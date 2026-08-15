// Passo 1 do plano FPGA/VHDL (golden-puzzling-quasar.md): LogicValue isolado, sem nenhuma
// dependência de GhdlProcessManager/arena -- prova as conversões char<->LogicValue e
// LogicValue<->elétrico antes de qualquer infraestrutura de processo/VPI.
#include <cstdio>

#include "lasecsimul/LogicValue.hpp"
#include "lasecsimul/Types.hpp"

using namespace lasecsimul;
using namespace lasecsimul::fpga;

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

void testAllNineStatesRoundTripThroughChar() {
    const LogicValue all[] = {LogicValue::U, LogicValue::X, LogicValue::Zero, LogicValue::One,
                               LogicValue::Z, LogicValue::W, LogicValue::L, LogicValue::H,
                               LogicValue::DontCare};
    const char expectedChars[] = {'U', 'X', '0', '1', 'Z', 'W', 'L', 'H', '-'};
    for (int i = 0; i < 9; ++i) {
        CHECK(toChar(all[i]) == expectedChars[i], "toChar bate com a tabela canônica VHDL");
        CHECK(fromChar(expectedChars[i]) == all[i], "fromChar é a inversa exata de toChar");
    }
}

void testFromCharAcceptsLowercaseAndUnknownFallsBackToX() {
    CHECK(fromChar('x') == LogicValue::X, "fromChar aceita minúsculo (vpiBinStrVal padrão usa x/z minúsculo)");
    CHECK(fromChar('z') == LogicValue::Z, "fromChar aceita minúsculo pra Z também");
    CHECK(fromChar('u') == LogicValue::U, "fromChar aceita minúsculo pra U também (GHDL observado emitindo maiúsculo)");
    CHECK(fromChar('?') == LogicValue::X, "caractere não reconhecido cai em X, nunca crash/UB");
}

void testDrivingStatesProduceRealDriveConductance() {
    const double vcc = 3.3;
    DriveStamp one = toVoltageStamp(LogicValue::One, vcc);
    CHECK(one.conductance == kFpgaDriveConductance, "'1' crava com a condutância de drive real");
    CHECK(one.currentSource > 0.0, "'1' tem fonte de corrente positiva (empurra pra vcc)");

    DriveStamp h = toVoltageStamp(LogicValue::H, vcc);
    CHECK(h.conductance == one.conductance && h.currentSource == one.currentSource,
          "'H' (fraco-1) usa a MESMA condutância de drive que '1' nesta política de stamp");

    DriveStamp zero = toVoltageStamp(LogicValue::Zero, vcc);
    CHECK(zero.conductance == kFpgaDriveConductance, "'0' crava com a condutância de drive real");
    CHECK(zero.currentSource == 0.0, "'0' não empurra corrente (vcc*conductance de um 0V equivalente)");

    DriveStamp l = toVoltageStamp(LogicValue::L, vcc);
    CHECK(l.conductance == zero.conductance && l.currentSource == zero.currentSource,
          "'L' (fraco-0) usa a MESMA condutância de drive que '0' nesta política de stamp");
}

void testUnknownAndHighZStatesFloat() {
    const double vcc = 3.3;
    const LogicValue floating[] = {LogicValue::Z, LogicValue::X, LogicValue::U, LogicValue::W, LogicValue::DontCare};
    for (LogicValue value : floating) {
        DriveStamp stamp = toVoltageStamp(value, vcc);
        CHECK(stamp.conductance == kFpgaFloatingConductance,
              "estado sem tensão defensável (Z/X/U/W/-) cai em condutância flutuante, nunca meio-vcc");
        CHECK(stamp.currentSource == 0.0, "estado flutuante nunca empurra corrente");
    }
}

void testFromVoltageOnlyEverProducesZeroOrOne() {
    CHECK(fromVoltage(0.0) == LogicValue::Zero, "0V lê como Zero");
    CHECK(fromVoltage(kDigitalLevelThreshold - 0.01) == LogicValue::Zero, "logo abaixo do limiar lê como Zero");
    CHECK(fromVoltage(kDigitalLevelThreshold + 0.01) == LogicValue::One, "logo acima do limiar lê como One");
    CHECK(fromVoltage(5.0) == LogicValue::One, "tensão alta lê como One");
    CHECK(fromVoltage(kDigitalLevelThreshold) == LogicValue::Zero,
          "exatamente no limiar NÃO conta como acima (mesma convenção de settleStep -- '>' estrito)");
}

} // namespace

int main() {
    std::fprintf(stderr, "=== LogicValueTest ===\n");
    testAllNineStatesRoundTripThroughChar();
    testFromCharAcceptsLowercaseAndUnknownFallsBackToX();
    testDrivingStatesProduceRealDriveConductance();
    testUnknownAndHighZStatesFloat();
    testFromVoltageOnlyEverProducesZeroOrOne();

    if (failures == 0) {
        std::fprintf(stderr, "\nTodos os testes passaram.\n");
        return 0;
    }
    std::fprintf(stderr, "\n%d teste(s) FALHARAM.\n", failures);
    return 1;
}
