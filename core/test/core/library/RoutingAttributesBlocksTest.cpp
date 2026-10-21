// Blocos `sl.*` -- Signal Routing e Signal Attributes (docs/66). Referencias analiticas ou definicoes documentadas pela
// MathWorks; nunca o proprio engine como referencia.
#include <limits>
#include <span>
#include <vector>

#include "library/LibraryTestHarness.hpp"

using namespace library_test;

namespace {

const double kNaN = std::numeric_limits<double>::quiet_NaN();
const double kInf = std::numeric_limits<double>::infinity();

/** Valor de `port` (todos os elementos) depois de rodar ate `t`. */
std::vector<double> values(Harness& h, uint32_t block, const char* port, uint16_t count) {
    std::vector<double> out;
    for (uint16_t i = 0; i < count; ++i) out.push_back(h.value(block, port, i));
    return out;
}

void expectVector(const std::vector<double>& actual, const std::vector<double>& expected, double tol, const std::string& label) {
    bool ok = actual.size() == expected.size();
    for (size_t i = 0; ok && i < actual.size(); ++i)
        ok = (std::isnan(expected[i]) && std::isnan(actual[i])) || (std::isinf(expected[i]) && actual[i] == expected[i]) ||
             std::abs(actual[i] - expected[i]) <= tol;
    std::string got;
    for (double v : actual) got += std::to_string(v) + " ";
    check(ok, label + " (obtido " + got + ")");
}

uint32_t constant(Harness& h, const char* value, const char* sampleTime = "inf") {
    return h.add("constant", {{"Value", text(value)}, {"SampleTime", text(sampleTime)}});
}

/** Relogio discreto: y = t nos acertos de periodo `ts` (Digital Clock). */
uint32_t digitalClock(Harness& h, const char* ts) { return h.add("digital_clock", {{"SampleTime", text(ts)}}); }

// ------------------------------------------------------------------------------- Mux / Demux

void muxAudit() {
    {
        Harness h;
        const uint32_t a = constant(h, "[4 5]"), b = constant(h, "3");
        const uint32_t mux = h.add("mux", {{"Inputs", text("[2 1]")}});
        h.wire(a, "out1", mux, "in1");
        h.wire(b, "out1", mux, "in2");
        h.runUntil(0.01);
        expectVector(values(h, mux, "out1", 3), {4, 5, 3}, 0, "Mux Inputs [2 1]: y = [u1; u2] na ordem das portas");
    }
    {
        Harness h;
        const uint32_t a = constant(h, "[4 5 6]"), b = constant(h, "3");
        const uint32_t mux = h.add("mux", {{"Inputs", text("[-1 1]")}});
        h.wire(a, "out1", mux, "in1");
        h.wire(b, "out1", mux, "in2");
        h.runUntil(0.01);
        expectVector(values(h, mux, "out1", 4), {4, 5, 6, 3}, 0, "Mux Inputs [-1 1]: -1 aceita qualquer largura");
    }
    check(fails([] {
        Harness h;
        const uint32_t a = constant(h, "[4 5 6]");
        const uint32_t mux = h.add("mux", {{"Inputs", text("[2 1]")}});
        h.wire(a, "out1", mux, "in1");
        h.runUntil(0.01);
    }), "Mux Inputs [2 1] recusa entrada 1 de largura 3 (largura declarada difere)");
    check(fails([] {
        Harness h;
        h.add("mux", {{"Inputs", text("position,velocity")}});
        h.runUntil(0.01);
    }), "Mux com lista de nomes: recusa explicita (regra de porta compartilhada nao conta nomes)");
}

void demuxAudit() {
    {
        Harness h;
        const uint32_t a = constant(h, "[1 2 3 4 5]");
        const uint32_t demux = h.add("demux", {{"Outputs", text("3")}});
        h.wire(a, "out1", demux, "in1");
        h.runUntil(0.01);
        // n = 5, p = 3: n mod p = 2 -> duas saidas de 2 elementos e uma de 1 (documentacao).
        expectVector(values(h, demux, "out1", 2), {1, 2}, 0, "Demux 5/3: saida 1 = [1 2]");
        expectVector(values(h, demux, "out2", 2), {3, 4}, 0, "Demux 5/3: saida 2 = [3 4]");
        expectVector(values(h, demux, "out3", 1), {5}, 0, "Demux 5/3: saida 3 = 5");
    }
    {
        Harness h;
        const uint32_t a = constant(h, "1:7");
        const uint32_t demux = h.add("demux", {{"Outputs", text("[-1 3 -1]")}});
        h.wire(a, "out1", demux, "in1");
        h.runUntil(0.01);
        expectVector(values(h, demux, "out1", 2), {1, 2}, 0, "Demux [-1 3 -1] com 7: saida 1 inferida = 2 elementos");
        expectVector(values(h, demux, "out2", 3), {3, 4, 5}, 0, "Demux [-1 3 -1]: saida 2 = 3 elementos");
        expectVector(values(h, demux, "out3", 2), {6, 7}, 0, "Demux [-1 3 -1]: saida 3 inferida = 2 elementos");
    }
    check(fails([] {
        Harness h;
        const uint32_t a = constant(h, "[1 2]");
        const uint32_t demux = h.add("demux", {{"Outputs", text("3")}});
        h.wire(a, "out1", demux, "in1");
        h.runUntil(0.01);
    }), "Demux p > n e erro (documentacao)");
    check(fails([] {
        Harness h;
        const uint32_t a = constant(h, "[1 2 3 4 5]");
        const uint32_t demux = h.add("demux", {{"Outputs", text("[2 2]")}});
        h.wire(a, "out1", demux, "in1");
        h.runUntil(0.01);
    }), "Demux [2 2] com entrada 5: soma diferente da largura e erro");
}

// ------------------------------------------------------------------------------------ Switch

double switchWith(const char* criteria, const char* threshold, const char* control) {
    Harness h;
    const uint32_t u1 = constant(h, "10"), u2 = constant(h, control), u3 = constant(h, "20");
    const uint32_t sw = h.add("switch", {{"Criteria", text(criteria)}, {"Threshold", text(threshold)}});
    h.wire(u1, "out1", sw, "in1");
    h.wire(u2, "out1", sw, "in2");
    h.wire(u3, "out1", sw, "in3");
    h.runUntil(0.01);
    return h.value(sw);
}

void switchBlock() {
    check(switchWith("u2 > Threshold", "0", "0") == 20, "Switch u2 > 0 com u2 = 0: passa u3");
    check(switchWith("u2 > Threshold", "0", "0.001") == 10, "Switch u2 > 0 com u2 = 0.001: passa u1");
    check(switchWith("u2 >= Threshold", "0", "0") == 10, "Switch u2 >= 0 com u2 = 0: passa u1");
    check(switchWith("u2 >= Threshold", "0", "-1e-9") == 20, "Switch u2 >= 0 com u2 < 0: passa u3");
    check(switchWith("u2 ~= 0", "5", "0") == 20, "Switch u2 ~= 0 com u2 = 0: passa u3 (Threshold ignorado)");
    check(switchWith("u2 ~= 0", "5", "-3") == 10, "Switch u2 ~= 0 com u2 = -3: passa u1");
    {
        // Padrao: Criteria 'u2 > Threshold', Threshold 0.
        Harness h;
        const uint32_t u1 = constant(h, "[1 2 3]"), u2 = constant(h, "[1 0 1]"), u3 = constant(h, "0");
        const uint32_t sw = h.add("switch");
        h.wire(u1, "out1", sw, "in1");
        h.wire(u2, "out1", sw, "in2");
        h.wire(u3, "out1", sw, "in3");
        h.runUntil(0.01);
        expectVector(values(h, sw, "out1", 3), {1, 0, 3}, 0, "Switch padrao elemento a elemento com u3 escalar expandido");
    }
    {
        Harness h;
        const uint32_t u1 = constant(h, "1"), u2 = constant(h, "2"), u3 = constant(h, "-1");
        const uint32_t sw = h.add("switch", {{"Criteria", text("u2 >= Threshold")}, {"Threshold", text("[1 3]")}});
        h.wire(u1, "out1", sw, "in1");
        h.wire(u2, "out1", sw, "in2");
        h.wire(u3, "out1", sw, "in3");
        h.runUntil(0.01);
        expectVector(values(h, sw, "out1", 2), {1, -1}, 0, "Switch Threshold vetorial [1 3] com u2 = 2: [u1, u3]");
    }
    {
        // Controle continuo (Clock): y = u1 para t >= 0.5, u3 antes.
        Harness h;
        const uint32_t u1 = constant(h, "1"), clock = h.add("clock"), u3 = constant(h, "-1");
        const uint32_t sw = h.add("switch", {{"Criteria", text("u2 >= Threshold")}, {"Threshold", text("0.5")}});
        h.wire(u1, "out1", sw, "in1");
        h.wire(clock, "out1", sw, "in2");
        h.wire(u3, "out1", sw, "in3");
        h.runUntil(0.3);
        check(h.value(sw) == -1, "Switch com controle continuo t: t = 0.3 < 0.5 -> u3");
        h.runUntil(0.7);
        check(h.value(sw) == 1, "Switch com controle continuo t: t = 0.7 >= 0.5 -> u1");
    }
    {
        // OutDataTypeStr int8: u1 = 200.7 -> floor 200 -> estouro circular -> -56.
        Harness h;
        const uint32_t u1 = constant(h, "200.7"), u2 = constant(h, "1"), u3 = constant(h, "0");
        const uint32_t sw = h.add("switch", {{"OutDataTypeStr", text("int8")}});
        h.wire(u1, "out1", sw, "in1");
        h.wire(u2, "out1", sw, "in2");
        h.wire(u3, "out1", sw, "in3");
        h.runUntil(0.01);
        check(h.value(sw) == -56, "Switch OutDataTypeStr int8 (Floor, estouro circular): 200.7 -> -56");
    }
    check(fails([] { switchWith("u2 > Threshold", "[1 2", "0"); }), "Switch Threshold invalido recusado");
    check(fails([] {
        Harness h;
        const uint32_t sw = h.add("switch", {{"Threshold", text("5")}, {"OutMax", text("3")}});
        (void)sw;
        h.runUntil(0.01);
    }), "Switch Threshold fora de [OutMin, OutMax] recusado");
    check(fails([] {
        Harness h;
        const uint32_t a = constant(h, "[1 2]"), b = constant(h, "[1 2 3]");
        const uint32_t sw = h.add("switch");
        h.wire(a, "out1", sw, "in1");
        h.wire(b, "out1", sw, "in3");
        h.runUntil(0.01);
    }), "Switch com entradas de dados de larguras 2 e 3 recusado (largura)");
}

// --------------------------------------------------------------------------- Multiport Switch

struct Multiport {
    Harness h;
    uint32_t block = 0;
    Multiport(std::initializer_list<std::pair<const char*, PropertyValue>> properties, const char* control, std::vector<const char*> data,
              const char* defaultValue = nullptr) {
        block = h.add("multiport_switch", properties);
        h.wire(constant(h, control), "out1", block, "in1");
        for (size_t i = 0; i < data.size(); ++i) h.wire(constant(h, data[i]), "out1", block, ("in" + std::to_string(i + 2)).c_str());
        if (defaultValue) h.wire(constant(h, defaultValue), "out1", block, "default");
        h.runUntil(0.01);
    }
};

void multiportSwitch() {
    {
        Multiport m({}, "2", {"10", "20", "30"});
        check(m.h.value(m.block) == 20, "Multiport Switch padrao (one-based): controle 2 -> dado 2");
    }
    {
        Multiport m({}, "2.9", {"10", "20", "30"});
        check(m.h.value(m.block) == 20, "Multiport Switch: controle 2.9 truncado para 2 (fix)");
    }
    {
        Multiport m({}, "-0.5", {"10", "20", "30"});
        check(std::isnan(m.h.value(m.block)), "Multiport Switch: controle 0 fora da faixa com Diagnostic Error -> NaN (erro de execucao)");
    }
    {
        Multiport m({{"DiagnosticForDefault", text("None")}}, "7", {"10", "20", "30"});
        check(m.h.value(m.block) == 30, "Multiport Switch: fora da faixa com None usa a ultima porta de dados");
    }
    {
        Multiport m({{"DiagnosticForDefault", text("Warning")}, {"DataPortForDefault", text("Additional data port")}}, "7", {"10", "20", "30"}, "-1");
        check(m.h.value(m.block) == -1, "Multiport Switch: fora da faixa com porta * adicional");
    }
    {
        Multiport m({{"DataPortOrder", text("Zero-based contiguous")}}, "0", {"10", "20", "30"});
        check(m.h.value(m.block) == 10, "Multiport Switch zero-based: controle 0 -> dado 1");
    }
    {
        Multiport m({{"DataPortOrder", text("Specify indices")}, {"DataPortIndices", text("[3 5 0 18]")}}, "0", {"1", "2", "3", "4"});
        check(m.h.value(m.block) == 3, "Multiport Switch Specify indices [3 5 0 18]: controle 0 -> porta 3");
    }
    {
        Multiport m({}, "1", {"[1 2]", "5", "6"});
        expectVector(values(m.h, m.block, "out1", 2), {1, 2}, 0, "Multiport Switch: dado vetorial passa inteiro");
    }
    {
        Multiport m({}, "2", {"[1 2]", "5", "6"});
        expectVector(values(m.h, m.block, "out1", 2), {5, 5}, 0, "Multiport Switch: dado escalar expandido para a largura da saida");
    }
    {
        // Index Vector (doc): d = [18 15 17 10], controle 3 (zero-based) -> 10.
        Multiport m({{"DataPortOrder", text("Zero-based contiguous")}, {"Inputs", text("1")}}, "3", {"[18 15 17 10]"});
        check(m.h.value(m.block) == 10, "Index Vector: d = [18 15 17 10], c = 3 -> 10 (exemplo da documentacao)");
    }
    {
        Multiport m({{"DataPortOrder", text("Zero-based contiguous")}, {"Inputs", text("1")}, {"DiagnosticForDefault", text("None")}}, "9", {"[18 15 17 10]"});
        check(m.h.value(m.block) == 10, "Index Vector: fora da faixa com None -> ultimo elemento");
    }
    {
        Multiport m({{"OutDataTypeStr", text("uint8")}, {"SaturateOnIntegerOverflow", true}}, "1", {"300", "20", "30"});
        check(m.h.value(m.block) == 255, "Multiport Switch OutDataTypeStr uint8 com saturacao: 300 -> 255");
    }
    check(fails([] { Multiport m({{"DataPortOrder", text("Specify indices")}, {"DataPortIndices", text("[1 1 2]")}}, "1", {"1", "2", "3"}); }),
          "Multiport Switch: indice de porta repetido recusado");
    check(fails([] { Multiport m({{"DataPortOrder", text("Specify indices")}, {"DataPortIndices", text("{[3,5],0,18}")}}, "1", {}); }),
          "Multiport Switch: celula em Data port indices recusada com mensagem (regra de porta compartilhada nao conta celulas)");
    check(fails([] { Multiport m({}, "[1 2]", {"1", "2", "3"}); }), "Multiport Switch: controle vetorial recusado (controle e escalar)");
}

// ----------------------------------------------------------------------------- Manual Switch

void manualSwitch() {
    for (const char* position : {"1", "0"}) {
        Harness h;
        const uint32_t clock = digitalClock(h, "0.1"), five = constant(h, "5");
        const uint32_t sw = h.add("manual_switch", {{"sw", text(position)}});
        h.wire(clock, "out1", sw, "in1");
        h.wire(five, "out1", sw, "in2");
        h.runUntil(0.35);
        if (std::string(position) == "1") expectNear(h.value(sw), 0.3, 1e-12, "Manual Switch sw = '1': y = u1 (relogio, 0.3)");
        else check(h.value(sw) == 5, "Manual Switch sw = '0': y = u2");
    }
    {
        // Parametro ajustavel em execucao (o duplo clique do Simulink troca sw): o kernel le sw a cada passo.
        Harness h;
        const uint32_t clock = digitalClock(h, "0.1"), five = constant(h, "5");
        const uint32_t sw = h.add("manual_switch");
        h.wire(clock, "out1", sw, "in1");
        h.wire(five, "out1", sw, "in2");
        h.runUntil(0.35);
        const double before = h.value(sw);
        const double zero = 0.0;
        // O caminho ajustavel da sessao (empurrar parametro `tunable` para o kernel) ainda nao existe; o teste
        // escreve o parametro direto no runtime para provar que o kernel le `sw` a cada execucao.
        const_cast<lasecsimul::simulation::SignalRuntime&>(h.session.signalRuntime())
            .setKernelParameters(lasecsimul::signalPortBlockId(sw, "out1"), std::span<const double>(&zero, 1));
        h.runUntil(0.55);
        check(std::abs(before - 0.3) < 1e-12 && h.value(sw) == 5, "Manual Switch: sw trocado com a simulacao rodando passa a entrada de baixo");
    }
    check(fails([] {
        Harness h;
        h.add("manual_switch", {{"sw", text("2")}});
        h.runUntil(0.01);
    }), "Manual Switch: sw diferente de '0'/'1' recusado");
}

// ---------------------------------------------------------------------------------- Selector

std::vector<double> select(std::initializer_list<std::pair<const char*, PropertyValue>> properties, const char* input, uint16_t count,
                           const char* index = nullptr) {
    Harness h;
    const uint32_t u = constant(h, input);
    const uint32_t s = h.add("selector", properties);
    h.wire(u, "out1", s, "in1");
    if (index) h.wire(constant(h, index), "out1", s, "idx1");
    h.runUntil(0.01);
    return values(h, s, "out1", count);
}

void selector() {
    expectVector(select({}, "[10 20 30]", 2), {10, 30}, 0, "Selector padrao: Index vector (dialog) [1 3] one-based -> [10 30]");
    expectVector(select({{"IndexMode", text("Zero-based")}, {"Indices", text("[2 0]")}}, "[10 20 30]", 2), {30, 10}, 0,
                 "Selector zero-based [2 0] reordena -> [30 10]");
    expectVector(select({{"IndexOptions", text("Select all")}}, "[10 20 30]", 3), {10, 20, 30}, 0, "Selector Select all");
    expectVector(select({{"IndexOptions", text("Starting index (dialog)")}, {"Indices", text("2")}, {"OutputSizes", text("2")}}, "[10 20 30]", 2), {20, 30}, 0,
                 "Selector Starting index (dialog) 2, Output Size 2 -> u(2:3)");
    expectVector(select({{"IndexOptions", text("Index vector (port)")}}, "[10 20 30]", 2, "[3 1]"), {30, 10}, 0, "Selector Index vector (port) [3 1]");
    expectVector(select({{"IndexOptions", text("Starting index (port)")}, {"OutputSizes", text("2")}}, "[10 20 30]", 2, "2"), {20, 30}, 0,
                 "Selector Starting index (port) 2, Output Size 2");
    expectVector(select({{"IndexOptions", text("Index vector (port)")}}, "[10 20 30]", 2, "[3 4]"), {30, kNaN}, 0,
                 "Selector: indice da porta fora da faixa -> NaN (erro de execucao no Simulink)");
    expectVector(select({{"InputPortWidth", text("-1")}, {"Indices", text("[5 1]")}}, "1:5", 2), {5, 1}, 0, "Selector Input port size -1 herda a largura 5");
    check(fails([] { select({{"Indices", text("[1 4]")}}, "[10 20 30]", 2); }), "Selector: indice 4 fora do vetor de 3 recusado");
    check(fails([] { select({}, "1:5", 2); }), "Selector: largura 5 difere de Input port size 3");
    check(fails([] { select({{"NumberOfDimensions", text("2")}}, "[10 20 30]", 2); }), "Selector N-D recusado (sinais sao vetores)");
    check(fails([] { select({{"IndexOptions", text("Starting and ending indices (port)")}}, "[10 20 30]", 2, "[1 2]"); }),
          "Selector Starting and ending indices (port) recusado (tamanho variavel)");
}

// ------------------------------------------------------------------------------------- Merge

/** Degrau discreto: 0 antes de `at`, `value` depois (Switch sobre um relogio discreto de 0.1 s). */
uint32_t discreteStep(Harness& h, const char* at, const char* value) {
    const uint32_t clock = digitalClock(h, "0.1"), high = constant(h, value), low = constant(h, "0");
    const uint32_t sw = h.add("switch", {{"Criteria", text("u2 >= Threshold")}, {"Threshold", text(at)}});
    h.wire(high, "out1", sw, "in1");
    h.wire(clock, "out1", sw, "in2");
    h.wire(low, "out1", sw, "in3");
    return sw;
}

void merge() {
    {
        Harness h;
        const uint32_t a = discreteStep(h, "1", "5"), b = discreteStep(h, "2", "9");
        const uint32_t m = h.add("merge", {{"InitialOutput", text("3")}});
        h.wire(a, "out1", m, "in1");
        h.wire(b, "out1", m, "in2");
        h.runUntil(0.55);
        check(h.value(m) == 3, "Merge: antes de qualquer escrita a saida e Initial output (3)");
        h.runUntil(1.25);
        check(h.value(m) == 5, "Merge: entrada 1 escreveu 5 em t = 1");
        h.runUntil(2.35);
        check(h.value(m) == 9, "Merge: entrada 2 escreveu 9 em t = 2 (mais recente)");
    }
    {
        Harness h;
        const uint32_t a = constant(h, "[1 2]"), b = discreteStep(h, "1", "7");
        const uint32_t m = h.add("merge", {{"AllowUnequalInputPortWidths", true}, {"InputPortOffsets", text("[0 2]")}});
        h.wire(a, "out1", m, "in1");
        h.wire(b, "out1", m, "in2");
        h.runUntil(1.25);
        expectVector(values(h, m, "out1", 3), {0, 0, 7}, 0, "Merge com larguras diferentes: entrada 2 no deslocamento 2; Initial output [] = 0");
    }
    check(fails([] {
        Harness h;
        const uint32_t a = constant(h, "[1 2]"), b = constant(h, "1");
        const uint32_t m = h.add("merge");
        h.wire(a, "out1", m, "in1");
        h.wire(b, "out1", m, "in2");
        h.runUntil(0.01);
    }), "Merge: larguras diferentes sem Allow unequal port widths recusadas");
}

void environmentController() {
    Harness h;
    const uint32_t sim = constant(h, "4"), coder = constant(h, "9");
    const uint32_t e = h.add("environment_controller");
    h.wire(sim, "out1", e, "in1");
    h.wire(coder, "out1", e, "in2");
    h.runUntil(0.01);
    check(h.value(e) == 4, "Environment Controller: em simulacao a saida e a entrada Sim");
}

// ---------------------------------------------------------------------------------------- IC

void icBlock() {
    {
        Harness h;
        const uint32_t clock = digitalClock(h, "0.1");
        const uint32_t ic = h.add("ic", {{"Value", text("7")}});
        h.wire(clock, "out1", ic, "in1");
        h.runUntil(0.05);
        check(h.value(ic) == 7, "IC discreto: no primeiro acerto (t = 0) a saida e Value");
        h.runUntil(0.15);
        expectNear(h.value(ic), 0.1, 1e-12, "IC discreto: depois do instante inicial a saida e a entrada");
        h.runUntil(0.35);
        expectNear(h.value(ic), 0.3, 1e-12, "IC discreto: t = 0.3 -> entrada");
    }
    {
        // Deslocamento: IC [0.1 0.05] publica Value no primeiro acerto t = 0.05 (>= tstart), depois u.
        Harness h;
        const uint32_t clock = digitalClock(h, "0.1");
        const uint32_t ic = h.add("ic", {{"Value", text("7")}, {"SampleTime", text("[0.1 0.05]")}});
        h.wire(clock, "out1", ic, "in1");
        h.runUntil(0.12);
        check(h.value(ic) == 7, "IC com offset 0.05: Value no primeiro acerto t = 0.05");
        h.runUntil(0.17);
        expectNear(h.value(ic), 0.1, 1e-12, "IC com offset: em t = 0.15 passa a entrada (0.1)");
    }
    {
        // Continuo: u = t; Value so vale no instante t = 0 (medida nula): integral = t^2/2.
        Harness h;
        const uint32_t clock = h.add("clock");
        const uint32_t ic = h.add("ic", {{"Value", text("100")}});
        const uint32_t integ = h.add("integrator");
        h.wire(clock, "out1", ic, "in1");
        h.wire(ic, "out1", integ, "in1");
        h.runUntil(1.0);
        expectNear(h.value(ic), 1.0, 1e-9, "IC continuo: y(1) = u(1)");
        expectNear(h.value(integ), 0.5, 2e-3, "IC continuo -> Integrator: integral de t em [0,1] = 0.5 (Value so em t = 0)");
    }
    {
        Harness h;
        const uint32_t u = constant(h, "[3 4]");
        const uint32_t ic = h.add("ic", {{"Value", text("1")}});
        h.wire(u, "out1", ic, "in1");
        h.runUntil(0.01);
        expectVector(values(h, ic, "out1", 2), {3, 4}, 0, "IC com entrada constante vetorial: depois de tstart a saida e u (Value escalar expandido)");
    }
    check(fails([] {
        Harness h;
        const uint32_t ic = h.add("ic", {{"Value", text("[1 2]")}});
        h.wire(constant(h, "[1 2 3]"), "out1", ic, "in1");
        h.runUntil(0.01);
    }), "IC: Value de largura 2 com entrada de largura 3 recusado");
    check(fails([] {
        Harness h;
        h.add("ic", {{"Value", text("Inf")}});
        h.runUntil(0.01);
    }), "IC: Value nao finito recusado");
}

// --------------------------------------------------------------------- Conversoes de tipo/sinal

double converted(const char* type, const char* input, std::initializer_list<std::pair<const char*, PropertyValue>> extra = {}) {
    Harness h;
    const uint32_t u = constant(h, input);
    ComponentParams params;
    params.properties["OutDataTypeStr"] = text(type);
    for (const auto& [name, value] : extra) params.properties[name] = value;
    const uint32_t dtc = h.session.addComponent("sl.data_type_conversion", params);
    h.wire(u, "out1", dtc, "in1");
    h.runUntil(0.01);
    return h.value(dtc);
}

void dataTypeConversion() {
    const std::pair<const char*, std::pair<double, double>> rounding[] = {
        {"Floor", {2, -3}}, {"Ceiling", {3, -2}}, {"Zero", {2, -2}}, {"Round", {3, -3}}, {"Nearest", {3, -2}}, {"Convergent", {2, -2}}, {"Simplest", {2, -2}}};
    for (const auto& [mode, expected] : rounding) {
        check(converted("int8", "2.5", {{"RndMeth", text(mode)}}) == expected.first, std::string("DTC int8 ") + mode + ": 2.5");
        check(converted("int8", "-2.5", {{"RndMeth", text(mode)}}) == expected.second, std::string("DTC int8 ") + mode + ": -2.5");
    }
    check(converted("int8", "3.5", {{"RndMeth", text("Convergent")}}) == 4, "DTC Convergent: 3.5 -> 4 (par)");
    check(converted("int8", "200") == -56, "DTC int8 estouro circular: 200 -> -56");
    check(converted("int8", "200", {{"SaturateOnIntegerOverflow", true}}) == 127, "DTC int8 saturado: 200 -> 127");
    check(converted("int8", "-200") == 56, "DTC int8 estouro circular: -200 -> 56");
    check(converted("uint8", "-1") == 255, "DTC uint8 estouro circular: -1 -> 255");
    check(converted("uint8", "-1", {{"SaturateOnIntegerOverflow", true}}) == 0, "DTC uint8 saturado: -1 -> 0");
    check(converted("int16", "40000.9") == 40000 - 65536, "DTC int16: 40000.9 -> floor -> -25536");
    check(converted("uint32", "4294967296") == 0, "DTC uint32: 2^32 -> 0 (circular)");
    check(converted("int8", "NaN") == 0, "DTC int8: NaN -> 0");
    check(converted("int8", "Inf") == 127, "DTC int8: Inf -> 127");
    check(converted("boolean", "0.3") == 1 && converted("boolean", "0") == 0, "DTC boolean: u ~= 0");
    check(converted("single", "0.1") == static_cast<double>(0.1f), "DTC single: 0.1 arredondado para float");
    check(converted("half", "0.1") == 0.0999755859375, "DTC half: 0.1 -> 0.0999755859375");
    check(converted("half", "1/3") == 0.333251953125, "DTC half: 1/3 -> 0.333251953125");
    check(converted("half", "70000") == kInf, "DTC half: 70000 -> Inf (estouro)");
    check(converted("half", "65519") == 65504, "DTC half: 65519 -> 65504 (maior finito)");
    check(converted("half", "1e-8") == 0, "DTC half: 1e-8 -> 0 (abaixo do menor subnormal/2)");
    check(converted("fixdt(1,16,4)", "1.03") == 1.0, "DTC fixdt(1,16,4): 1.03 -> floor(16.48)/16 = 1");
    check(converted("sfix16_En4", "1.03") == 1.0, "DTC sfix16_En4 = fixdt(1,16,4)");
    check(converted("fixdt(1,8,0.5,1)", "3.3") == 3.0, "DTC fixdt(1,8,0.5,1): q = floor((3.3-1)/0.5) = 4 -> 3");
    check(converted("fixdt(0,8,2)", "100") == 36, "DTC fixdt(0,8,2) (inclinacao 2^-2): 100 -> q = 400 -> circular 144 -> 36 (sem saturacao)");
    check(converted("fixdt(0,8,2)", "100", {{"SaturateOnIntegerOverflow", true}}) == 63.75, "DTC fixdt(0,8,2) saturado: 100 -> 255/4 = 63.75");
    check(fails([] { converted("fixdt(0,8,2^-2)", "1"); }), "DTC fixdt(s,w,f) com fracao nao inteira recusado");
    check(converted("fixdt(1,16,4)", "3", {{"ConvertRealWorld", text("Stored Integer (SI)")}}) == 0.1875, "DTC Stored Integer: u = 3 vira o inteiro armazenado -> 3/16");
    check(converted("Inherit: Inherit via back propagation", "2.7") == 2.7, "DTC padrao (back propagation -> double): identidade");
    check(converted("double", "2.7") == 2.7, "DTC double: identidade");
    check(fails([] { converted("fixdt(1,16)", "1"); }), "DTC fixdt(1,16) sem escala recusado");
    check(fails([] { converted("Enum: Cores", "1"); }), "DTC Enum recusado (sinais sao double)");
    check(fails([] { converted("int7", "1"); }), "DTC tipo desconhecido recusado");
    {
        Harness h;
        const uint32_t ref = constant(h, "1"), u = constant(h, "[1.5 2.5]");
        const uint32_t dtci = h.add("data_type_conversion_inherited");
        h.wire(ref, "out1", dtci, "in1");
        h.wire(u, "out1", dtci, "in2");
        h.runUntil(0.01);
        expectVector(values(h, dtci, "out1", 2), {1.5, 2.5}, 0, "Data Type Conversion Inherited: referencia double -> y = u");
    }
}

void identityAttributes() {
    for (const char* block : {"signal_conversion", "data_type_scaling_strip", "unit_conversion", "signal_specification"}) {
        Harness h;
        const uint32_t u = constant(h, "[1 2 3]");
        const uint32_t b = h.add(block);
        h.wire(u, "out1", b, "in1");
        h.runUntil(0.01);
        expectVector(values(h, b, "out1", 3), {1, 2, 3}, 0, std::string(block) + ": y = u (copia)");
    }
    check(fails([] {
        Harness h;
        h.add("signal_conversion", {{"ConversionOutput", text("Virtual bus")}});
        h.runUntil(0.01);
    }), "Signal Conversion 'Virtual bus' recusado (sem barramentos)");
    {
        Harness h;
        const uint32_t u = constant(h, "[1 2 3]");
        const uint32_t b = h.add("signal_specification", {{"Dimensions", text("[1 3]")}, {"OutDataTypeStr", text("double")}});
        h.wire(u, "out1", b, "in1");
        h.runUntil(0.01);
        check(h.value(b, "out1", 2) == 3, "Signal Specification Dimensions [1 3] confere com a largura 3");
    }
    check(fails([] {
        Harness h;
        const uint32_t b = h.add("signal_specification", {{"Dimensions", text("2")}});
        h.wire(constant(h, "[1 2 3]"), "out1", b, "in1");
        h.runUntil(0.01);
    }), "Signal Specification: Dimensions 2 com largura 3 recusado");
    check(fails([] {
        Harness h;
        h.add("signal_specification", {{"SignalType", text("complex")}});
        h.runUntil(0.01);
    }), "Signal Specification complex recusado");
    check(fails([] {
        Harness h;
        h.add("signal_specification", {{"OutDataTypeStr", text("Bus: Barramento")}});
        h.runUntil(0.01);
    }), "Signal Specification Bus recusado");
    {
        Harness h;
        const uint32_t a = constant(h, "1"), b = constant(h, "[1 2]");
        const uint32_t dup = h.add("data_type_duplicate"), prop = h.add("data_type_propagation");
        h.wire(a, "out1", dup, "in1");
        h.wire(b, "out1", dup, "in2");
        h.wire(a, "out1", prop, "in1");
        h.wire(a, "out1", prop, "in2");
        h.wire(b, "out1", prop, "in3");
        h.runUntil(0.01);
        check(true, "Data Type Duplicate/Propagation: sem saida e sem efeito numerico (compilam)");
    }
}

// ------------------------------------------------------------------------------ Width / Probe

void widthAndProbe() {
    {
        Harness h;
        const uint32_t u = constant(h, "[1 2 3]");
        const uint32_t w = h.add("width");
        h.wire(u, "out1", w, "in1");
        h.runUntil(0.01);
        check(h.value(w) == 3, "Width: largura 3");
    }
    {
        // O engine limita vetores a 64 elementos (SignalGraphDefinition::maxVectorWidth), abaixo do maximo de int8.
        Harness h;
        const uint32_t u = constant(h, "ones(1,50)");
        const uint32_t w = h.add("width", {{"DataType", text("int8")}, {"AlwaysUseConstantSampleTime", false}});
        h.wire(u, "out1", w, "in1");
        h.runUntil(0.01);
        check(h.value(w) == 50, "Width int8 com tempo herdado: largura 50");
    }
    {
        Harness h;
        const uint32_t clock = digitalClock(h, "0.1");
        const uint32_t p = h.add("probe");
        h.wire(clock, "out1", p, "in1");
        h.runUntil(0.25);
        check(h.value(p, "W") == 1 && h.value(p, "C") == 0 && h.value(p, "D") == 1, "Probe: W = 1, C = 0, D = 1");
        expectVector(values(h, p, "Ts", 2), {0.1, 0}, 1e-15, "Probe: Ts = [0.1 0]");
    }
    {
        Harness h;
        const uint32_t u = constant(h, "[1 2 3]");
        const uint32_t p = h.add("probe", {{"ProbeWidth", false}});
        h.wire(u, "out1", p, "in1");
        h.runUntil(0.01);
        expectVector(values(h, p, "Ts", 2), {kInf, 0}, 0, "Probe: entrada constante -> Ts = [Inf 0]");
        check(h.value(p, "D") == 3, "Probe: D = 3 (vetor)");
    }
    {
        Harness h;
        const uint32_t clock = h.add("clock");
        const uint32_t p = h.add("probe");
        h.wire(clock, "out1", p, "in1");
        h.runUntil(0.01);
        expectVector(values(h, p, "Ts", 2), {0, 0}, 0, "Probe: entrada continua -> Ts = [0 0]");
    }
}

// --------------------------------------------------------------------------- Rate Transition

void rateTransition() {
    {
        // Rapida (0.1) -> lenta (0.5), deterministica: ZOH na taxa lenta.
        Harness h;
        const uint32_t clock = digitalClock(h, "0.1");
        const uint32_t rt = h.add("rate_transition", {{"OutPortSampleTime", text("0.5")}});
        h.wire(clock, "out1", rt, "in1");
        h.runUntil(0.45);
        check(h.value(rt) == 0, "Rate Transition rapida->lenta: em [0, 0.5) segura u(0) = 0");
        h.runUntil(0.75);
        expectNear(h.value(rt), 0.5, 1e-12, "Rate Transition rapida->lenta: em [0.5, 1) segura u(0.5)");
    }
    {
        // Lenta (0.5) -> rapida (0.1), deterministica: atraso unitario na taxa lenta, IC no primeiro periodo.
        Harness h;
        const uint32_t clock = digitalClock(h, "0.5");
        const uint32_t rt = h.add("rate_transition", {{"OutPortSampleTime", text("0.1")}, {"InitialCondition", text("7")}});
        h.wire(clock, "out1", rt, "in1");
        h.runUntil(0.25);
        check(h.value(rt) == 7, "Rate Transition lenta->rapida (1/z): [0, 0.5) = Initial conditions");
        h.runUntil(0.75);
        check(h.value(rt) == 0, "Rate Transition lenta->rapida (1/z): [0.5, 1) = u(0)");
        h.runUntil(1.25);
        expectNear(h.value(rt), 0.5, 1e-12, "Rate Transition lenta->rapida (1/z): [1, 1.5) = u(0.5)");
    }
    {
        // Sem determinismo: dado mais recente, sem atraso.
        Harness h;
        const uint32_t clock = digitalClock(h, "0.5");
        const uint32_t rt = h.add("rate_transition", {{"OutPortSampleTime", text("0.1")}, {"Deterministic", false}});
        h.wire(clock, "out1", rt, "in1");
        h.runUntil(0.75);
        expectNear(h.value(rt), 0.5, 1e-12, "Rate Transition sem determinismo: copia o valor mais recente");
    }
    {
        Harness h;
        const uint32_t clock = digitalClock(h, "0.1");
        const uint32_t rt = h.add("rate_transition", {{"OutPortSampleTimeOpt", text("Multiple of input port sample time")}, {"OutPortSampleTimeMultiple", text("2")}});
        h.wire(clock, "out1", rt, "in1");
        h.runUntil(0.35);
        expectNear(h.value(rt), 0.2, 1e-12, "Rate Transition multiplo 2 da entrada 0.1: ZOH a cada 0.2");
    }
    check(fails([] {
        Harness h;
        const uint32_t rt = h.add("rate_transition", {{"OutPortSampleTime", text("0.3")}});
        h.wire(digitalClock(h, "0.2"), "out1", rt, "in1");
        h.runUntil(0.5);
    }), "Rate Transition deterministica com razao nao inteira (0.2 -> 0.3) recusada");
    {
        Harness h;
        const uint32_t clock = digitalClock(h, "0.2");
        const uint32_t rt = h.add("rate_transition", {{"OutPortSampleTime", text("0.3")}, {"Deterministic", false}});
        h.wire(clock, "out1", rt, "in1");
        h.runUntil(0.65);
        expectNear(h.value(rt), 0.6, 1e-12, "Rate Transition nao deterministica aceita razao nao inteira (amostra em 0.6)");
    }
    check(fails([] {
        Harness h;
        h.add("rate_transition", {{"InitialCondition", text("NaN")}});
        h.runUntil(0.01);
    }), "Rate Transition: Initial conditions NaN recusada");
}

void weightedSampleTime() {
    const auto run = [](const char* op, const char* weight, double t) {
        Harness h;
        const uint32_t clock = digitalClock(h, "0.2");
        const uint32_t w = h.add("weighted_sample_time", {{"TsampMathOp", text(op)}, {"weightValue", text(weight)}});
        h.wire(clock, "out1", w, "in1");
        h.runUntil(t);
        return h.value(w);
    };
    expectNear(run("Ts Only", "1.0", 0.1), 0.2, 1e-15, "Weighted Sample Time padrao: Ts = 0.2");
    expectNear(run("Ts Only", "3", 0.1), 0.6, 1e-15, "Weighted Sample Time: Ts*w = 0.6");
    expectNear(run("1/Ts Only", "1", 0.1), 5.0, 1e-12, "Weighted Sample Time: 1/Ts = 5");
    expectNear(run("+", "1", 0.45), 0.6, 1e-12, "Weighted Sample Time '+': u(0.4) + Ts");
    expectNear(run("-", "1", 0.45), 0.2, 1e-12, "Weighted Sample Time '-': u(0.4) - Ts");
    expectNear(run("*", "2", 0.45), 0.16, 1e-12, "Weighted Sample Time '*': u(0.4)*(Ts*w)");
    expectNear(run("/", "1", 0.45), 2.0, 1e-12, "Weighted Sample Time '/': u(0.4)/Ts");
    check(fails([] {
        Harness h;
        const uint32_t w = h.add("weighted_sample_time");
        h.wire(h.add("clock"), "out1", w, "in1");
        h.runUntil(0.1);
    }), "Weighted Sample Time com entrada continua recusado (exige tempo discreto)");
}

} // namespace

int main() {
    const std::pair<const char*, void (*)()> cases[] = {
        {"muxAudit", muxAudit}, {"demuxAudit", demuxAudit}, {"switchBlock", switchBlock}, {"multiportSwitch", multiportSwitch},
        {"manualSwitch", manualSwitch}, {"selector", selector}, {"merge", merge}, {"environmentController", environmentController},
        {"icBlock", icBlock}, {"dataTypeConversion", dataTypeConversion}, {"identityAttributes", identityAttributes},
        {"widthAndProbe", widthAndProbe}, {"rateTransition", rateTransition}, {"weightedSampleTime", weightedSampleTime},
    };
    for (const auto& [name, test] : cases) {
        try { test(); } catch (const std::exception& error) { check(false, std::string(name) + " lancou: " + error.what()); }
    }
    return finish("library_routing_attributes");
}
