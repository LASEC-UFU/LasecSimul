// Blocos `sl.*` -- Discontinuities, Logic and Bit Operations, Lookup Tables (docs/66). Referencias analiticas ou definicoes documentadas pela
// MathWorks; nunca o proprio engine como referencia.
#include <functional>
#include <utility>

#include "library/LibraryTestHarness.hpp"

using namespace library_test;

namespace {

PropertyValue on() { return PropertyValue{true}; }
PropertyValue off() { return PropertyValue{false}; }

/** Propriedade depois de criado (para variantes); erro de validacao vira excecao. */
void set(Harness& h, uint32_t component, const char* name, const PropertyValue& value) {
    if (const auto error = h.session.setProperty(component, name, value)) throw std::invalid_argument(*error);
}

/** Sequencia discreta (Ts = 0.25) s_k = expr(m), m = indice da amostra, via Digital Clock + Fcn. */
uint32_t discreteSequence(Harness& h, const std::string& exprOfM) {
    const uint32_t clock = h.add("digital_clock", {{"SampleTime", text("0.25")}});
    std::string expr = exprOfM;
    for (size_t at = expr.find('M'); at != std::string::npos; at = expr.find('M', at + 17)) expr.replace(at, 1, "floor(u(1)*4+0.5)");
    const uint32_t fcn = h.add("fcn", {{"Expr", text(expr)}});
    h.wire(clock, "out1", fcn, "in1");
    return fcn;
}

// ------------------------------------------------------------------ Discontinuities

void saturation() {
    Harness h;
    const uint32_t u = h.add("constant", {{"Value", text("[-1 0.2 3 0.5]")}});
    const uint32_t sat = h.add("saturation", {{"UpperLimit", text("[0 1 2 0.5]")}, {"LowerLimit", text("-0.5")}, {"OutputSaturationStatus", on()}});
    h.wire(u, "out1", sat, "in1");
    const uint32_t d = h.add("constant", {{"Value", text("2")}});
    const uint32_t satDefault = h.add("saturation");
    h.wire(d, "out1", satDefault, "in1");
    h.runUntil(0.01);
    const double expected[] = {-0.5, 0.2, 2.0, 0.5};
    const double up[] = {0, 0, 1, 0}, lo[] = {1, 0, 0, 0};
    for (uint16_t i = 0; i < 4; ++i) {
        expectNear(h.value(sat, "out1", i), expected[i], 0, "Saturation y = min(max(u, LL), UL) elemento " + std::to_string(i));
        expectNear(h.value(sat, "satup", i), up[i], 0, "Saturation satup (u > UL) elemento " + std::to_string(i));
        expectNear(h.value(sat, "satlo", i), lo[i], 0, "Saturation satlo (u < LL) elemento " + std::to_string(i));
    }
    expectNear(h.value(satDefault), 0.5, 0, "Saturation padrao [-0.5, 0.5] com u = 2");
    check(fails([] {
        Harness e;
        const uint32_t v = e.add("constant", {{"Value", text("[1 2 3]")}});
        const uint32_t s = e.add("saturation", {{"UpperLimit", text("[1 2]")}});
        e.wire(v, "out1", s, "in1");
        e.runUntil(0.01);
    }), "Saturation recusa limite vetorial com largura diferente do sinal");
}

void deadZone() {
    Harness h;
    const uint32_t u = h.add("constant", {{"Value", text("[2 -2 0.3 0.5 -0.5]")}});
    const uint32_t dz = h.add("dead_zone");
    h.wire(u, "out1", dz, "in1");
    const uint32_t v = h.add("constant", {{"Value", text("[-1 0 1 2]")}});
    const uint32_t dzv = h.add("dead_zone", {{"LowerValue", text("[-0.5 -1 -2 -3]")}, {"UpperValue", text("1")}});
    h.wire(v, "out1", dzv, "in1");
    const uint32_t clock = h.add("clock");
    const uint32_t sampled = h.add("dead_zone", {{"SampleTime", text("0.1")}});
    h.wire(clock, "out1", sampled, "in1");
    h.runUntil(0.75);
    const double expected[] = {1.5, -1.5, 0.0, 0.0, 0.0};
    for (uint16_t i = 0; i < 5; ++i) expectNear(h.value(dz, "out1", i), expected[i], 1e-15, "Dead Zone [-0.5, 0.5] (limites inclusivos) elemento " + std::to_string(i));
    const double vector[] = {-0.5, 0.0, 0.0, 1.0};
    for (uint16_t i = 0; i < 4; ++i) expectNear(h.value(dzv, "out1", i), vector[i], 1e-15, "Dead Zone vetorial elemento " + std::to_string(i));
    expectNear(h.value(sampled), 0.7 - 0.5, 1e-9, "Dead Zone discreto (Ts = 0.1) segura u(0.7) - UL em t = 0.75");
    check(fails([] {
        Harness e;
        e.add("dead_zone", {{"LowerValue", text("1")}, {"UpperValue", text("0")}});
        e.runUntil(0.01);
    }), "Dead Zone recusa Start of dead zone > End of dead zone");
}

void dynamicLimits() {
    Harness h;
    const uint32_t up = h.add("constant", {{"Value", text("1")}});
    const uint32_t lo = h.add("constant", {{"Value", text("-2")}});
    const uint32_t u = h.add("constant", {{"Value", text("[3 -3 0.5]")}});
    const uint32_t sat = h.add("saturation_dynamic");
    const uint32_t dz = h.add("dead_zone_dynamic");
    for (uint32_t block : {sat, dz}) {
        h.wire(up, "out1", block, "up");
        h.wire(u, "out1", block, "in1");
        h.wire(lo, "out1", block, "lo");
    }
    h.runUntil(0.01);
    const double satExpected[] = {1.0, -2.0, 0.5}, dzExpected[] = {2.0, -1.0, 0.0};
    for (uint16_t i = 0; i < 3; ++i) {
        expectNear(h.value(sat, "out1", i), satExpected[i], 0, "Saturation Dynamic y = up/lo/u elemento " + std::to_string(i));
        expectNear(h.value(dz, "out1", i), dzExpected[i], 0, "Dead Zone Dynamic y = u - up / u - lo / 0 elemento " + std::to_string(i));
    }
}

void relay() {
    // Continuo: u = sin(pi t), liga em u >= 0.5 (t = 1/6), desliga em u <= -0.5 (t = 7/6).
    Harness h;
    const uint32_t sine = h.add("sine_wave", {{"Frequency", text("pi")}});
    const uint32_t r = h.add("relay", {{"OnSwitchValue", text("0.5")}, {"OffSwitchValue", text("-0.5")}, {"OnOutputValue", text("2")}, {"OffOutputValue", text("-1")}});
    h.wire(sine, "out1", r, "in1");
    const uint32_t zero = h.add("constant", {{"Value", text("[0 1 -1]")}});
    const uint32_t threshold = h.add("relay");
    h.wire(zero, "out1", threshold, "in1");
    const std::pair<double, double> samples[] = {{0.1, -1.0}, {0.3, 2.0}, {1.0, 2.0}, {1.1, 2.0}, {1.5, -1.0}, {2.1, -1.0}, {2.3, 2.0}};
    for (const auto& [t, expected] : samples) {
        h.runUntil(t);
        expectNear(h.value(r), expected, 0, "Relay com histerese (sin(pi t), on 0.5 / off -0.5) em t = " + std::to_string(t));
    }
    const double thresholdExpected[] = {0.0, 1.0, 0.0};
    for (uint16_t i = 0; i < 3; ++i)
        expectNear(h.value(threshold, "out1", i), thresholdExpected[i], 0, "Relay padrao (on = off = eps): chave com limiar eps, elemento " + std::to_string(i));

    // Discreto (herdado, Ts = 0.25): s = [0 1 0.2 -1 -0.2 0.7], on 0.5 / off -0.5, regra aplicada aqui.
    Harness d;
    const uint32_t seq = discreteSequence(d, "(M==1) + 0.2*(M==2) - (M==3) - 0.2*(M==4) + 0.7*(M==5)");
    const uint32_t dr = d.add("relay", {{"OnSwitchValue", text("0.5")}, {"OffSwitchValue", text("-0.5")}});
    d.wire(seq, "out1", dr, "in1");
    const double sequence[] = {0, 1, 0.2, -1, -0.2, 0.7};
    double mode = 0.0;  // entrada inicial entre os pontos -> desligado
    for (int k = 0; k < 6; ++k) {
        mode = sequence[k] >= 0.5 ? 1.0 : sequence[k] <= -0.5 ? 0.0 : mode;
        d.runUntil(0.25 * k + 0.1);
        expectNear(d.value(dr), mode, 0, "Relay discreto amostra " + std::to_string(k));
    }
    check(fails([] {
        Harness e;
        e.add("relay", {{"OnSwitchValue", text("0")}, {"OffSwitchValue", text("1")}});
        e.runUntil(0.01);
    }), "Relay recusa Switch on point < Switch off point");
    check(fails([] {
        Harness e;
        e.add("relay", {{"InputProcessing", text("Columns as channels (frame based)")}});
        e.runUntil(0.01);
    }), "Relay recusa processamento por quadro (frame based, DSP System Toolbox)");
}

void rateLimiter() {
    // Continuo: y(i) = y(i-1) + R (t(i) - t(i-1)) enquanto a taxa da entrada excede R. Com entradas
    // u = 10 t e u = 1 - 10 t a soma telescopa: y = R t e y = 1 + F t em QUALQUER sequencia de passos
    // maiores (independe do passo do solver). IC e ignorada (y(0) = u(0)).
    Harness h;
    const uint32_t clock = h.add("clock");
    const uint32_t fast = h.add("gain", {{"Gain", text("10")}});
    const uint32_t fastDown = h.add("fcn", {{"Expr", text("1 - 10*u(1)")}});
    const uint32_t fastVector = h.add("gain", {{"Gain", text("[10 10]")}});
    h.wire(clock, "out1", fast, "in1");
    h.wire(clock, "out1", fastDown, "in1");
    h.wire(clock, "out1", fastVector, "in1");
    const uint32_t rl = h.add("rate_limiter", {{"SampleTimeMode", text("continuous")}, {"InitialCondition", text("5")}});
    const uint32_t fall = h.add("rate_limiter", {{"FallingSlewLimit", text("-2")}, {"InitialCondition", text("7")}});
    const uint32_t vrl = h.add("rate_limiter", {{"RisingSlewLimit", text("[1 2]")}});
    h.wire(fast, "out1", rl, "in1");
    h.wire(fastDown, "out1", fall, "in1");
    h.wire(fastVector, "out1", vrl, "in1");
    // Degrau 0 -> 1 em t = 1: depois do salto a rampa tem inclinacao R exata entre dois instantes.
    const uint32_t step = h.add("step", {{"Time", text("1")}});
    const uint32_t stepLimited = h.add("rate_limiter");
    h.wire(step, "out1", stepLimited, "in1");
    h.runUntil(0.5);
    expectNear(h.value(rl), 0.5, 1e-12, "Rate Limiter continuo (SampleTimeMode continuous): y = R t com u = 10 t (IC 5 ignorada)");
    expectNear(h.value(fall), 1.0 - 2.0 * 0.5, 1e-12, "Rate Limiter herdado de sinal continuo: descida F = -2 a partir de y(0) = u(0) = 1 (IC 7 ignorada)");
    expectNear(h.value(vrl, "out1", 0), 0.5, 1e-12, "Rate Limiter vetorial R = [1 2], elemento 0");
    expectNear(h.value(vrl, "out1", 1), 1.0, 1e-12, "Rate Limiter vetorial R = [1 2], elemento 1");
    expectNear(h.value(stepLimited), 0.0, 0, "Rate Limiter continuo antes do degrau");
    h.runUntil(1.1);
    const double atStart = h.value(stepLimited);
    h.runUntil(1.35);
    expectNear(h.value(stepLimited) - atStart, 0.25, 1e-12, "Rate Limiter continuo: inclinacao R = 1 depois do degrau");
    h.runUntil(3.0);
    expectNear(h.value(stepLimited), 1.0, 0, "Rate Limiter continuo alcanca a entrada");

    // Discreto (herdado de Ts = 0.1): y(-1) = IC, y(k) = y(k-1) + Ts R quando a taxa excede R.
    Harness d;
    const uint32_t one = d.add("constant", {{"Value", text("1")}, {"SampleTime", text("0.1")}});
    const uint32_t drl = d.add("rate_limiter", {{"RisingSlewLimit", text("2")}});
    const uint32_t closeIc = d.add("rate_limiter", {{"RisingSlewLimit", text("2")}, {"InitialCondition", text("0.95")}});
    d.wire(one, "out1", drl, "in1");
    d.wire(one, "out1", closeIc, "in1");
    const double expected[] = {0.2, 0.4, 0.6, 0.8, 1.0, 1.0};
    for (int k = 0; k < 6; ++k) {
        d.runUntil(0.1 * k + 0.05);
        expectNear(d.value(drl), expected[k], 1e-12, "Rate Limiter discreto (IC 0, R 2, Ts 0.1) amostra " + std::to_string(k));
    }
    expectNear(d.value(closeIc), 1.0, 0, "Rate Limiter discreto: IC 0.95, taxa (1 - 0.95)/0.1 = 0.5 < R -> y(0) = u(0)");

    // Entrada discreta (Ts = 0.5) 0 -> 1 em t = 0.5: modo continuo rampa entre amostras; herdado e discreto.
    Harness m;
    const uint32_t seq = m.add("step", {{"Time", text("0.5")}, {"SampleTime", text("0.5")}});
    const uint32_t forced = m.add("rate_limiter", {{"SampleTimeMode", text("continuous")}});
    const uint32_t inherited = m.add("rate_limiter");
    m.wire(seq, "out1", forced, "in1");
    m.wire(seq, "out1", inherited, "in1");
    m.runUntil(0.6);
    const double rampStart = m.value(forced);
    m.runUntil(0.85);
    expectNear(m.value(forced) - rampStart, 0.25, 1e-12, "Rate Limiter SampleTimeMode continuous com entrada discreta: rampa continua entre amostras");
    expectNear(m.value(inherited), 0.5, 1e-12, "Rate Limiter herdado discreto (Ts 0.5): y = Ts R na amostra t = 0.5, segurado ate a proxima");
    check(fails([] {
        Harness e;
        e.add("rate_limiter", {{"InitialCondition", text("inf")}});
        e.runUntil(0.01);
    }), "Rate Limiter recusa Initial condition infinita");
}

void rateLimiterDynamic() {
    Harness h;
    const uint32_t u = h.add("constant", {{"Value", text("1")}, {"SampleTime", text("0.1")}});
    const uint32_t up = h.add("constant", {{"Value", text("2")}});
    const uint32_t lo = h.add("constant", {{"Value", text("-2")}});
    const uint32_t r = h.add("rate_limiter_dynamic");
    h.wire(up, "out1", r, "up");
    h.wire(u, "out1", r, "in1");
    h.wire(lo, "out1", r, "lo");
    const double expected[] = {0.2, 0.4, 0.6, 0.8, 1.0, 1.0};
    for (int k = 0; k < 6; ++k) {
        h.runUntil(0.1 * k + 0.05);
        expectNear(h.value(r), expected[k], 1e-12, "Rate Limiter Dynamic (up 2, lo -2, Ts 0.1, y(-1) = 0) amostra " + std::to_string(k));
    }
    check(fails([] {
        Harness e;
        const uint32_t clock = e.add("clock");
        const uint32_t block = e.add("rate_limiter_dynamic");
        e.wire(clock, "out1", block, "in1");
        e.runUntil(0.01);
    }), "Rate Limiter Dynamic recusa tempo continuo (so tempo discreto)");
}

void backlash() {
    // u = 2 - |t - 2|: largura 1, saida inicial 0. y = 0 ate u = 0.5; y = u - 0.5 subindo (y(2) = 1.5);
    // desengata na descida ate u = y - 0.5 = 1 (t = 3) e depois y = u + 0.5.
    Harness h;
    const uint32_t clock = h.add("clock");
    const uint32_t tri = h.add("fcn", {{"Expr", text("2 - abs(u(1) - 2)")}});
    h.wire(clock, "out1", tri, "in1");
    const uint32_t b = h.add("backlash");
    h.wire(tri, "out1", b, "in1");
    const uint32_t c3 = h.add("constant", {{"Value", text("[3 0.2 -3]")}});
    const uint32_t engaged = h.add("backlash", {{"InitialOutput", text("0")}});
    h.wire(c3, "out1", engaged, "in1");
    const std::pair<double, double> samples[] = {{0.3, 0.0}, {1.0, 0.5}, {2.0, 1.5}, {2.5, 1.5}, {2.9, 1.5}, {3.5, 1.0}};
    for (const auto& [t, expected] : samples) {
        h.runUntil(t);
        expectNear(h.value(b), expected, 2e-3, "Backlash (largura 1) em t = " + std::to_string(t));
    }
    const double engagedExpected[] = {2.5, 0.0, -2.5};
    for (uint16_t i = 0; i < 3; ++i)
        expectNear(h.value(engaged, "out1", i), engagedExpected[i], 0, "Backlash: entrada inicial fora da zona morta engata (y = u -/+ w/2), elemento " + std::to_string(i));
    check(fails([] {
        Harness e;
        e.add("backlash", {{"BacklashWidth", text("-1")}});
        e.runUntil(0.01);
    }), "Backlash recusa largura negativa");
}

void coulomb() {
    Harness h;
    const uint32_t two = h.add("constant", {{"Value", text("2")}});
    const uint32_t minus = h.add("constant", {{"Value", text("-1")}});
    const uint32_t zero = h.add("constant", {{"Value", text("0")}});
    const uint32_t a = h.add("coulomb_viscous_friction"), b = h.add("coulomb_viscous_friction"), z = h.add("coulomb_viscous_friction");
    h.wire(two, "out1", a, "in1");
    h.wire(minus, "out1", b, "in1");
    h.wire(zero, "out1", z, "in1");
    const uint32_t v = h.add("constant", {{"Value", text("[1 -2]")}});
    const uint32_t vector = h.add("coulomb_viscous_friction", {{"offset", text("1")}, {"gain", text("[2 3]")}});
    h.wire(v, "out1", vector, "in1");
    h.runUntil(0.01);
    const double offset[] = {1, 3, 2, 0};
    for (uint16_t i = 0; i < 4; ++i) {
        expectNear(h.value(a, "out1", i), 2.0 + offset[i], 0, "Coulomb: entrada escalar e offset [1 3 2 0] -> saida 4-vetor, u = 2, elemento " + std::to_string(i));
        expectNear(h.value(b, "out1", i), -(1.0 + offset[i]), 0, "Coulomb: u = -1, elemento " + std::to_string(i));
        expectNear(h.value(z, "out1", i), 0.0, 0, "Coulomb: u = 0 -> sign(0) = 0, elemento " + std::to_string(i));
    }
    expectNear(h.value(vector, "out1", 0), 3.0, 0, "Coulomb vetorial: sign(1)(2*1 + 1)");
    expectNear(h.value(vector, "out1", 1), -7.0, 0, "Coulomb vetorial: sign(-2)(3*2 + 1)");
    check(fails([] {
        Harness e;
        const uint32_t w = e.add("constant", {{"Value", text("[1 2]")}});
        const uint32_t c = e.add("coulomb_viscous_friction");
        e.wire(w, "out1", c, "in1");
        e.runUntil(0.01);
    }), "Coulomb recusa entrada vetorial com offset de outra largura");
}

void quantizerAndWrap() {
    Harness h;
    const uint32_t u = h.add("constant", {{"Value", text("[1.3 1.2 1.25 -1.25]")}});
    const uint32_t q = h.add("quantizer");
    h.wire(u, "out1", q, "in1");
    const uint32_t v = h.add("constant", {{"Value", text("[1.3 2.9]")}});
    const uint32_t qv = h.add("quantizer", {{"QuantizationInterval", text("[0.5 2]")}});
    h.wire(v, "out1", qv, "in1");
    const uint32_t w = h.add("constant", {{"Value", text("[255 256 -3]")}});
    const uint32_t wrap = h.add("wrap_to_zero");
    h.wire(w, "out1", wrap, "in1");
    const uint32_t wv = h.add("constant", {{"Value", text("[1 300]")}});
    const uint32_t wrapv = h.add("wrap_to_zero", {{"Threshold", text("[0 400]")}});
    h.wire(wv, "out1", wrapv, "in1");
    h.runUntil(0.01);
    const double quantized[] = {1.5, 1.0, 1.5, -1.5};
    for (uint16_t i = 0; i < 4; ++i)
        expectNear(h.value(q, "out1", i), quantized[i], 1e-15, "Quantizer y = q round(u/q) (meio para longe de zero), elemento " + std::to_string(i));
    expectNear(h.value(qv, "out1", 0), 1.5, 1e-15, "Quantizer vetorial q = 0.5");
    expectNear(h.value(qv, "out1", 1), 2.0, 1e-15, "Quantizer vetorial q = 2");
    const double wrapped[] = {255, 0, -3};
    for (uint16_t i = 0; i < 3; ++i) expectNear(h.value(wrap, "out1", i), wrapped[i], 0, "Wrap To Zero (Threshold 255) elemento " + std::to_string(i));
    expectNear(h.value(wrapv, "out1", 0), 0, 0, "Wrap To Zero vetorial: 1 > 0 -> 0");
    expectNear(h.value(wrapv, "out1", 1), 300, 0, "Wrap To Zero vetorial: 300 <= 400 -> u");
    check(fails([] {
        Harness e;
        e.add("quantizer", {{"QuantizationInterval", text("0")}});
        e.runUntil(0.01);
    }), "Quantizer recusa intervalo nulo");
}

void hitCrossing() {
    // Ts = 0.25: s = u - 0.5 com u = t (cruza subindo entre 0.25 e 0.5... exatamente em 0.5 fica 0).
    const auto run = [](const char* direction, const char* expr, const std::vector<double>& expected, const std::string& label) {
        Harness h;
        const uint32_t seq = discreteSequence(h, expr);
        const uint32_t hit = h.add("hit_crossing", {{"HitCrossingDirection", text(direction)}});
        h.wire(seq, "out1", hit, "in1");
        for (size_t k = 0; k < expected.size(); ++k) {
            h.runUntil(0.25 * static_cast<double>(k) + 0.1);
            expectNear(h.value(hit), expected[k], 0, label + " amostra " + std::to_string(k));
        }
    };
    // s_k = k - 2.5 (cruza subindo entre k = 2 e 3): y = 1 na segunda amostra do par e volta a 0.
    run("rising", "M - 2.5", {0, 0, 0, 1, 0, 0}, "Hit Crossing rising");
    run("falling", "M - 2.5", {0, 0, 0, 0, 0, 0}, "Hit Crossing falling ignora subida");
    run("either", "2.5 - M", {0, 0, 0, 1, 0, 0}, "Hit Crossing either detecta descida");
    // s = (k < 2)(k - 2): chega ao offset em k = 2 e fica nele: y continua 1.
    run("rising", "(M<2)*(M-2)", {0, 0, 1, 1, 1}, "Hit Crossing: entrada fica no offset depois do cruzamento");
    run("falling", "(M<2)*(M-2)", {0, 0, 0, 0, 0}, "Hit Crossing falling: chegada por baixo nao conta");
    // Entrada inicial igual ao offset: 1 so com either.
    run("either", "0*M", {1, 1}, "Hit Crossing: entrada inicial no offset (either)");
    run("rising", "0*M", {0, 0}, "Hit Crossing: entrada inicial no offset (rising)");
    // Continuo: u = t, offset 0.5 rising. O passo maior que termina em t = 0.5 ve s = 0 vindo de
    // negativo (y = 1); longe do cruzamento y = 0.
    Harness c;
    const uint32_t clock = c.add("clock");
    const uint32_t hit = c.add("hit_crossing", {{"HitCrossingOffset", text("0.5")}, {"HitCrossingDirection", text("rising")}});
    c.wire(clock, "out1", hit, "in1");
    c.runUntil(0.3);
    expectNear(c.value(hit), 0, 0, "Hit Crossing continuo antes do cruzamento");
    c.runUntil(0.5);
    expectNear(c.value(hit), 1, 0, "Hit Crossing continuo no passo maior em que u chega ao offset");
    c.runUntil(0.6);
    expectNear(c.value(hit), 0, 0, "Hit Crossing continuo volta a 0 depois do cruzamento");
    check(fails([] {
        Harness e;
        e.add("hit_crossing", {{"HitCrossingOutputType", text("Message")}});
        e.runUntil(0.01);
    }), "Hit Crossing recusa Output type Message (sem mensagens)");
    check(!fails([] {
        Harness e;
        const uint32_t c = e.add("clock");
        const uint32_t hit = e.add("hit_crossing", {{"ShowOutputPort", off()}});
        e.wire(c, "out1", hit, "in1");
        e.runUntil(0.1);
    }), "Hit Crossing sem porta de saida compila");
}

void pwm() {
    Harness h;
    const uint32_t d = h.add("constant", {{"Value", text("0.25")}});
    const uint32_t p = h.add("pwm");
    h.wire(d, "out1", p, "in1");
    const uint32_t delayed = h.add("pwm", {{"InitialDelay", text("0.5")}});
    h.wire(d, "out1", delayed, "in1");
    const uint32_t noZero = h.add("pwm", {{"DisallowZeroDutyCycle", on()}});
    h.wire(d, "out1", noZero, "in1");
    const uint32_t change = h.add("step", {{"Time", text("0.5")}, {"InitialValue", text("0.25")}, {"FinalValue", text("0.75")}});
    const uint32_t sampled = h.add("pwm");
    h.wire(change, "out1", sampled, "in1");
    const uint32_t big = h.add("constant", {{"Value", text("1.5")}});
    const uint32_t full = h.add("pwm");
    h.wire(big, "out1", full, "in1");
    const uint32_t zero = h.add("constant", {{"Value", text("0")}});
    const uint32_t none = h.add("pwm");
    h.wire(zero, "out1", none, "in1");
    struct Sample { double t, y, delayed, sampled; };
    const Sample samples[] = {{0.1, 1, 0, 1}, {0.25, 0, 0, 0}, {0.3, 0, 0, 0}, {0.6, 0, 1, 0}, {0.75, 0, 0, 0}, {0.9, 0, 0, 0},
                              {1.0, 1, 0, 1}, {1.1, 1, 0, 1}, {1.3, 0, 0, 1}, {1.6, 0, 1, 1}, {1.8, 0, 0, 0}};
    for (const Sample& s : samples) {
        h.runUntil(s.t);
        expectNear(h.value(p), s.y, 0, "PWM (P 1, D 0.25): y = 1 em [tk, tk + D P), t = " + std::to_string(s.t));
        expectNear(h.value(noZero), s.y, 0, "PWM com DisallowZeroDutyCycle (sem direct feedthrough), t = " + std::to_string(s.t));
        expectNear(h.value(delayed), s.delayed, 0, "PWM com Initial Delay 0.5, t = " + std::to_string(s.t));
        expectNear(h.value(sampled), s.sampled, 0, "PWM le D so no inicio do pulso (D 0.25 -> 0.75 em t = 0.5), t = " + std::to_string(s.t));
        expectNear(h.value(full), 1.0, 0, "PWM com D > 1 limitado a 1, t = " + std::to_string(s.t));
        expectNear(h.value(none), 0.0, 0, "PWM com D = 0, t = " + std::to_string(s.t));
    }
    // Intervalos fixos: Ts = 0.25 P, D = 0.47 -> nP = 4, npw = floor(0.47/0.25) = 1 (exemplo da documentacao).
    Harness f;
    const uint32_t duty = f.add("constant", {{"Value", text("0.47")}});
    const uint32_t fixed = f.add("pwm", {{"RunAtFixedTimeIntervals", on()}, {"SampleTime", text("0.25")}});
    f.wire(duty, "out1", fixed, "in1");
    const double expected[] = {1, 0, 0, 0, 1, 0, 0, 0};
    for (int k = 0; k < 8; ++k) {
        f.runUntil(0.25 * k + 0.1);
        expectNear(f.value(fixed), expected[k], 0, "PWM em intervalos fixos (nP 4, npw 1) amostra " + std::to_string(k));
    }
    check(fails([] {
        Harness e;
        e.add("pwm", {{"Period", text("0")}});
        e.runUntil(0.01);
    }), "PWM recusa Period nulo");
    check(fails([] {
        Harness e;
        const uint32_t v = e.add("constant", {{"Value", text("[0.1 0.2]")}});
        const uint32_t block = e.add("pwm");
        e.wire(v, "out1", block, "in1");
        e.runUntil(0.01);
    }), "PWM recusa D vetorial");
}

// ------------------------------------------------------------------ Logic and Bit Operations

void logicalOperator() {
    Harness h;
    const uint32_t a = h.add("constant", {{"Value", text("[1 0 2 0]")}});
    const uint32_t b = h.add("constant", {{"Value", text("[1 1 0 0]")}});
    const char* ops[] = {"AND", "OR", "NAND", "NOR", "XOR", "NXOR"};
    const double expected[6][4] = {{1, 0, 0, 0}, {1, 1, 1, 0}, {0, 1, 1, 1}, {0, 0, 0, 1}, {0, 1, 1, 0}, {1, 0, 0, 1}};
    uint32_t blocks[6];
    for (int i = 0; i < 6; ++i) {
        blocks[i] = h.add("logical_operator", {{"Operator", text(ops[i])}});
        h.wire(a, "out1", blocks[i], "in1");
        h.wire(b, "out1", blocks[i], "in2");
    }
    const uint32_t notBlock = h.add("logical_operator", {{"Operator", text("NOT")}});
    h.wire(a, "out1", notBlock, "in1");
    const uint32_t one = h.add("constant", {{"Value", text("-1")}});
    const uint32_t xor3 = h.add("logical_operator", {{"Operator", text("XOR")}, {"Inputs", text("3")}});
    const uint32_t nxor3 = h.add("logical_operator", {{"Operator", text("NXOR")}, {"Inputs", text("3")}});
    for (uint32_t block : {xor3, nxor3})
        for (const char* port : {"in1", "in2", "in3"}) h.wire(one, "out1", block, port);
    const uint32_t vector = h.add("constant", {{"Value", text("[1 1 0]")}});
    const uint32_t andReduce = h.add("logical_operator", {{"Inputs", text("1")}});
    const uint32_t orReduce = h.add("logical_operator", {{"Operator", text("OR")}, {"Inputs", text("1")}});
    h.wire(vector, "out1", andReduce, "in1");
    h.wire(vector, "out1", orReduce, "in1");
    h.runUntil(0.01);
    for (int i = 0; i < 6; ++i)
        for (uint16_t e = 0; e < 4; ++e)
            expectNear(h.value(blocks[i], "out1", e), expected[i][e], 0, std::string("Logical Operator ") + ops[i] + " elemento " + std::to_string(e));
    const double notExpected[] = {0, 1, 0, 1};
    for (uint16_t e = 0; e < 4; ++e) expectNear(h.value(notBlock, "out1", e), notExpected[e], 0, "Logical Operator NOT elemento " + std::to_string(e));
    expectNear(h.value(xor3), 1, 0, "XOR de 3 entradas verdadeiras = 1 (numero impar)");
    expectNear(h.value(nxor3), 0, 0, "NXOR de 3 entradas verdadeiras = 0");
    expectNear(h.value(andReduce), 0, 0, "AND de uma entrada reduz o vetor [1 1 0]");
    expectNear(h.value(orReduce), 1, 0, "OR de uma entrada reduz o vetor [1 1 0]");
    check(fails([] {
        Harness e;
        e.add("logical_operator", {{"Inputs", text("1.5")}});
        e.runUntil(0.01);
    }), "Logical Operator recusa numero de entradas nao inteiro");
}

void relationalOperators() {
    Harness h;
    const uint32_t a = h.add("constant", {{"Value", text("[1 2 3]")}});
    const uint32_t two = h.add("constant", {{"Value", text("2")}});
    const char* ops[] = {"==", "~=", "<", "<=", ">=", ">"};
    const double expected[6][3] = {{0, 1, 0}, {1, 0, 1}, {1, 0, 0}, {1, 1, 0}, {0, 1, 1}, {0, 0, 1}};
    uint32_t blocks[6];
    for (int i = 0; i < 6; ++i) {
        blocks[i] = h.add("relational_operator", {{"Operator", text(ops[i])}});
        h.wire(a, "out1", blocks[i], "in1");
        h.wire(two, "out1", blocks[i], "in2");
    }
    const uint32_t special = h.add("constant", {{"Value", text("[1 Inf -Inf NaN]")}});
    const char* unary[] = {"isInf", "isNaN", "isFinite"};
    const double unaryExpected[3][4] = {{0, 1, 1, 0}, {0, 0, 0, 1}, {1, 0, 0, 0}};
    uint32_t unaryBlocks[3];
    for (int i = 0; i < 3; ++i) {
        unaryBlocks[i] = h.add("relational_operator", {{"Operator", text(unary[i])}});
        h.wire(special, "out1", unaryBlocks[i], "in1");
    }
    const uint32_t u = h.add("constant", {{"Value", text("[1 3 5]")}});
    const uint32_t ctc = h.add("compare_to_constant", {{"const", text("3")}});
    const uint32_t ctcVector = h.add("compare_to_constant", {{"relop", text(">")}, {"const", text("[0 3 6]")}});
    const uint32_t z = h.add("constant", {{"Value", text("[-1 0 2]")}});
    const uint32_t ctz = h.add("compare_to_zero");
    const uint32_t ctzGt = h.add("compare_to_zero", {{"relop", text(">")}});
    const uint32_t ctzNe = h.add("compare_to_zero", {{"relop", text("~=")}});
    h.wire(u, "out1", ctc, "in1");
    h.wire(u, "out1", ctcVector, "in1");
    for (uint32_t block : {ctz, ctzGt, ctzNe}) h.wire(z, "out1", block, "in1");
    h.runUntil(0.01);
    for (int i = 0; i < 6; ++i)
        for (uint16_t e = 0; e < 3; ++e)
            expectNear(h.value(blocks[i], "out1", e), expected[i][e], 0, std::string("Relational Operator ") + ops[i] + " (escalar expandido) elemento " + std::to_string(e));
    for (int i = 0; i < 3; ++i)
        for (uint16_t e = 0; e < 4; ++e)
            expectNear(h.value(unaryBlocks[i], "out1", e), unaryExpected[i][e], 0, std::string("Relational Operator ") + unary[i] + " elemento " + std::to_string(e));
    const double ctcExpected[] = {1, 1, 0}, ctcVectorExpected[] = {1, 0, 0};
    const double ctzExpected[] = {1, 1, 0}, ctzGtExpected[] = {0, 0, 1}, ctzNeExpected[] = {1, 0, 1};
    for (uint16_t e = 0; e < 3; ++e) {
        expectNear(h.value(ctc, "out1", e), ctcExpected[e], 0, "Compare To Constant u <= 3 elemento " + std::to_string(e));
        expectNear(h.value(ctcVector, "out1", e), ctcVectorExpected[e], 0, "Compare To Constant u > [0 3 6] elemento " + std::to_string(e));
        expectNear(h.value(ctz, "out1", e), ctzExpected[e], 0, "Compare To Zero <= elemento " + std::to_string(e));
        expectNear(h.value(ctzGt, "out1", e), ctzGtExpected[e], 0, "Compare To Zero > elemento " + std::to_string(e));
        expectNear(h.value(ctzNe, "out1", e), ctzNeExpected[e], 0, "Compare To Zero ~= elemento " + std::to_string(e));
    }

    // Tempo continuo: integral de (t >= 0.5) de 0 a 1 = 0.5 (a comparacao troca so em passo maior).
    Harness c;
    const uint32_t clock = c.add("clock");
    const uint32_t half = c.add("constant", {{"Value", text("0.5")}});
    const uint32_t ge = c.add("relational_operator", {{"Operator", text(">=")}});
    c.wire(clock, "out1", ge, "in1");
    c.wire(half, "out1", ge, "in2");
    const uint32_t integral = c.add("integrator");
    c.wire(ge, "out1", integral, "in1");
    c.runUntil(0.25);
    expectNear(c.value(ge), 0, 0, "Relational Operator continuo: 0.25 >= 0.5 falso");
    c.runUntil(1.0);
    expectNear(c.value(ge), 1, 0, "Relational Operator continuo: 1 >= 0.5 verdadeiro");
    expectNear(c.value(integral), 0.5, 2e-3, "Integral da comparacao continua (t >= 0.5) em [0, 1]");
    check(fails([] {
        Harness e;
        const uint32_t v = e.add("constant", {{"Value", text("[1 2]")}});
        const uint32_t w = e.add("constant", {{"Value", text("[1 2 3]")}});
        const uint32_t r = e.add("relational_operator");
        e.wire(v, "out1", r, "in1");
        e.wire(w, "out1", r, "in2");
        e.runUntil(0.01);
    }), "Relational Operator recusa entradas vetoriais de larguras diferentes");
}

void detectors() {
    // s_k = [0 1 1 0 -1 -1 2 2] (Ts = 0.25); referencias pelas definicoes documentadas (U/z = amostra anterior).
    const std::string seq = "(M==1)+(M==2)-(M==4)-(M==5)+2*(M>=6)";
    const double s[] = {0, 1, 1, 0, -1, -1, 2, 2};
    struct Case { const char* block; const char* vinit; std::function<double(double, double&)> step; };
    const Case cases[] = {
        {"detect_change", "0", [](double u, double& m) { const double y = u != m; m = u; return y; }},
        {"detect_change", "5", [](double u, double& m) { const double y = u != m; m = u; return y; }},
        {"detect_decrease", "0", [](double u, double& m) { const double y = u < m; m = u; return y; }},
        {"detect_increase", "0.0", [](double u, double& m) { const double y = u > m; m = u; return y; }},
        {"detect_fall_negative", "0", [](double u, double& m) { const bool f = u < 0; const double y = f && m == 0; m = f; return y; }},
        {"detect_fall_nonpositive", "0", [](double u, double& m) { const bool f = u <= 0; const double y = f && m == 0; m = f; return y; }},
        {"detect_rise_nonnegative", "0", [](double u, double& m) { const bool f = u >= 0; const double y = f && m == 0; m = f; return y; }},
        {"detect_rise_nonnegative", "1", [](double u, double& m) { const bool f = u >= 0; const double y = f && m == 0; m = f; return y; }},
        {"detect_rise_positive", "0", [](double u, double& m) { const bool f = u > 0; const double y = f && m == 0; m = f; return y; }},
    };
    for (const Case& item : cases) {
        Harness h;
        const uint32_t input = discreteSequence(h, seq);
        const uint32_t block = h.add(item.block, {{"vinit", text(item.vinit)}});
        h.wire(input, "out1", block, "in1");
        double memory = std::string(item.block).find("detect_change") == 0 || std::string(item.block).find("crease") != std::string::npos
                            ? std::stod(item.vinit) : (std::stod(item.vinit) != 0.0 ? 1.0 : 0.0);
        for (int k = 0; k < 8; ++k) {
            const double expected = item.step(s[k], memory);
            h.runUntil(0.25 * k + 0.1);
            expectNear(h.value(block), expected, 0, std::string(item.block) + " (vinit " + item.vinit + ") amostra " + std::to_string(k));
        }
    }
    Harness v;
    const uint32_t pair = v.add("constant", {{"Value", text("[1 1]")}, {"SampleTime", text("0.25")}});
    const uint32_t change = v.add("detect_change", {{"vinit", text("[0 1]")}});
    v.wire(pair, "out1", change, "in1");
    v.runUntil(0.1);
    expectNear(v.value(change, "out1", 0), 1, 0, "Detect Change vetorial: vinit [0 1], u [1 1] -> [1 0] (0)");
    expectNear(v.value(change, "out1", 1), 0, 0, "Detect Change vetorial: vinit [0 1], u [1 1] -> [1 0] (1)");
    check(fails([] {
        Harness e;
        const uint32_t clock = e.add("clock");
        const uint32_t block = e.add("detect_increase");
        e.wire(clock, "out1", block, "in1");
        e.runUntil(0.01);
    }), "Detect Increase recusa tempo continuo");
}

void intervalAndCombinatorial() {
    Harness h;
    const uint32_t u = h.add("constant", {{"Value", text("[-1 -0.5 0 0.5 1]")}});
    const uint32_t closed = h.add("interval_test");
    const uint32_t openLeft = h.add("interval_test", {{"IntervalClosedLeft", off()}});
    const uint32_t openRight = h.add("interval_test", {{"IntervalClosedRight", off()}});
    for (uint32_t block : {closed, openLeft, openRight}) h.wire(u, "out1", block, "in1");
    const uint32_t up = h.add("constant", {{"Value", text("1")}});
    const uint32_t lo = h.add("constant", {{"Value", text("-1")}});
    const uint32_t v = h.add("constant", {{"Value", text("[-1 0 1 2]")}});
    const uint32_t dynamic = h.add("interval_test_dynamic");
    const uint32_t dynamicOpen = h.add("interval_test_dynamic", {{"IntervalClosedRight", off()}});
    for (uint32_t block : {dynamic, dynamicOpen}) {
        h.wire(up, "out1", block, "up");
        h.wire(v, "out1", block, "in1");
        h.wire(lo, "out1", block, "lo");
    }
    const uint32_t bits = h.add("constant", {{"Value", text("[1 0 1]")}});
    const uint32_t bits2 = h.add("constant", {{"Value", text("[2 -1 -3]")}});
    const uint32_t adder = h.add("combinatorial_logic");
    const uint32_t adder2 = h.add("combinatorial_logic");
    h.wire(bits, "out1", adder, "in1");
    h.wire(bits2, "out1", adder2, "in1");
    h.runUntil(0.01);
    const double closedExpected[] = {0, 1, 1, 1, 0}, openLeftExpected[] = {0, 0, 1, 1, 0}, openRightExpected[] = {0, 1, 1, 0, 0};
    for (uint16_t e = 0; e < 5; ++e) {
        expectNear(h.value(closed, "out1", e), closedExpected[e], 0, "Interval Test [-0.5, 0.5] elemento " + std::to_string(e));
        expectNear(h.value(openLeft, "out1", e), openLeftExpected[e], 0, "Interval Test (-0.5, 0.5] elemento " + std::to_string(e));
        expectNear(h.value(openRight, "out1", e), openRightExpected[e], 0, "Interval Test [-0.5, 0.5) elemento " + std::to_string(e));
    }
    const double dynamicExpected[] = {1, 1, 1, 0}, dynamicOpenExpected[] = {1, 1, 0, 0};
    for (uint16_t e = 0; e < 4; ++e) {
        expectNear(h.value(dynamic, "out1", e), dynamicExpected[e], 0, "Interval Test Dynamic [lo, up] elemento " + std::to_string(e));
        expectNear(h.value(dynamicOpen, "out1", e), dynamicOpenExpected[e], 0, "Interval Test Dynamic [lo, up) elemento " + std::to_string(e));
    }
    // Tabela padrao: somador completo [vai-um soma]; linha = 1 + 4 u1 + 2 u2 + u3 (nao nulo = 1).
    expectNear(h.value(adder, "out1", 0), 1, 0, "Combinatorial Logic [1 0 1] -> linha 6 = [1 0] (0)");
    expectNear(h.value(adder, "out1", 1), 0, 0, "Combinatorial Logic [1 0 1] -> linha 6 = [1 0] (1)");
    expectNear(h.value(adder2, "out1", 0), 1, 0, "Combinatorial Logic [2 -1 -3] (nao nulo = 1) -> linha 8 = [1 1] (0)");
    expectNear(h.value(adder2, "out1", 1), 1, 0, "Combinatorial Logic [2 -1 -3] (nao nulo = 1) -> linha 8 = [1 1] (1)");
    check(fails([] {
        Harness e;
        const uint32_t w = e.add("constant", {{"Value", text("[1 0]")}});
        const uint32_t c = e.add("combinatorial_logic");
        e.wire(w, "out1", c, "in1");
        e.runUntil(0.01);
    }), "Combinatorial Logic recusa tabela de 8 linhas com entrada de 2 elementos");
}

// ------------------------------------------------------------------ Lookup Tables

/** n-D Lookup Table 1-D com bp [0 1 2] e T [0 10 40] na entrada constante `u`. */
double lookup1d(double u, std::initializer_list<std::pair<const char*, PropertyValue>> extra) {
    Harness h;
    const uint32_t input = h.add("constant", {{"Value", text(std::to_string(u))}});
    const uint32_t table = h.add("lookup_nd", {{"NumberOfTableDimensions", text("1")}, {"Table", text("[0 10 40]")}, {"BreakpointsForDimension1", text("[0 1 2]")}});
    for (const auto& [name, value] : extra) set(h, table, name, value);
    h.wire(input, "out1", table, "in1");
    h.runUntil(0.01);
    return h.value(table);
}

double lookupWith(const char* table, const char* bp, double u, const char* interp, const char* extrap) {
    Harness h;
    const uint32_t input = h.add("constant", {{"Value", text(std::to_string(u))}});
    const uint32_t block = h.add("lookup_nd", {{"NumberOfTableDimensions", text("1")}, {"Table", text(table)}, {"BreakpointsForDimension1", text(bp)},
                                               {"InterpMethod", text(interp)}, {"ExtrapMethod", text(extrap)}});
    h.wire(input, "out1", block, "in1");
    h.runUntil(0.01);
    return h.value(block);
}

void lookupOneD() {
    expectNear(lookup1d(0.5, {}), 5, 1e-12, "1-D Linear point-slope: u = 0.5");
    expectNear(lookup1d(1.5, {}), 25, 1e-12, "1-D Linear point-slope: u = 1.5");
    expectNear(lookup1d(3, {}), 70, 1e-12, "1-D extrapolacao Linear acima: 40 + (40 - 10)");
    expectNear(lookup1d(-1, {}), -10, 1e-12, "1-D extrapolacao Linear abaixo");
    expectNear(lookup1d(3, {{"ExtrapMethod", text("Clip")}}), 40, 0, "1-D Clip acima: ultimo valor");
    expectNear(lookup1d(-1, {{"ExtrapMethod", text("Clip")}}), 0, 0, "1-D Clip abaixo: primeiro valor");
    expectNear(lookup1d(1.5, {{"InterpMethod", text("Linear Lagrange")}}), 25, 1e-12, "1-D Linear Lagrange: (1 - f) T(i) + f T(i+1)");
    expectNear(lookup1d(3, {{"InterpMethod", text("Linear Lagrange")}}), 70, 1e-12, "1-D Linear Lagrange extrapolado (f = 2)");
    expectNear(lookup1d(1.5, {{"InterpMethod", text("Flat")}}), 10, 0, "1-D Flat (Use Input Below): u = 1.5 -> T(2)");
    expectNear(lookup1d(1, {{"InterpMethod", text("Flat")}}), 10, 0, "1-D Flat no breakpoint: T(2)");
    expectNear(lookup1d(2.5, {{"InterpMethod", text("Flat")}}), 40, 0, "1-D Flat acima da faixa: ultimo");
    expectNear(lookup1d(-1, {{"InterpMethod", text("Flat")}}), 0, 0, "1-D Flat abaixo da faixa: primeiro");
    expectNear(lookup1d(1.5, {{"InterpMethod", text("Nearest")}}), 40, 0, "1-D Nearest: empate escolhe o indice maior");
    expectNear(lookup1d(1.4, {{"InterpMethod", text("Nearest")}}), 10, 0, "1-D Nearest: u = 1.4 -> T(2)");
    expectNear(lookup1d(0.6, {{"InterpMethod", text("Nearest")}}), 10, 0, "1-D Nearest: u = 0.6 -> T(2)");
    expectNear(lookup1d(1.5, {{"BreakpointsSpecification", text("Even spacing")}, {"BreakpointsForDimension1FirstPoint", text("0")},
                              {"BreakpointsForDimension1Spacing", text("1")}}), 25, 1e-12, "1-D Even spacing (0, 1): mesmos breakpoints [0 1 2]");
    expectNear(lookup1d(1.5, {{"IndexSearchMethod", text("Evenly spaced points")}}), 25, 1e-12, "1-D Evenly spaced points com breakpoints uniformes");
    expectNear(lookup1d(1.5, {{"UseLastTableValue", on()}, {"ExtrapMethod", text("Clip")}}), 25, 1e-12, "1-D UseLastTableValue nao muda o valor dentro da faixa");

    // Spline cubica natural em x^3 (bp 0..3): M1 = 4.8, M2 = 16.8 (sistema tridiagonal com M0 = M3 = 0).
    const double m1 = 4.8, m2 = 16.8;
    const auto natural = [&](double x) {
        if (x <= 1) { const double b = x, a = 1 - b; return a * 0 + b * 1 + ((b * b * b - b) * m1) / 6.0; }
        if (x <= 2) { const double b = x - 1, a = 1 - b; return a * 1 + b * 8 + ((a * a * a - a) * m1 + (b * b * b - b) * m2) / 6.0; }
        const double b = x - 2, a = 1 - b;
        return a * 8 + b * 27 + ((a * a * a - a) * m2) / 6.0;
    };
    expectNear(lookupWith("[0 1 8 27]", "[0 1 2 3]", 1.5, "Cubic spline", "Linear"), natural(1.5), 1e-12, "Cubic spline natural em x = 1.5 (3.15)");
    expectNear(lookupWith("[0 1 8 27]", "[0 1 2 3]", 0.5, "Cubic spline", "Linear"), natural(0.5), 1e-12, "Cubic spline natural em x = 0.5");
    expectNear(lookupWith("[0 1 8 27]", "[0 1 2 3]", 3.5, "Cubic spline", "Cubic spline"), natural(3.5), 1e-12, "Cubic spline extrapolada pelo polinomio da ponta (37.55)");
    expectNear(lookupWith("[0 1 8 27]", "[0 1 2 3]", 3.5, "Cubic spline", "Linear"), 27 + 0.5 * (19 + m2 / 6.0 * 1.0), 1e-12, "Cubic spline + extrapolacao Linear pela tangente na ponta (37.9)");
    expectNear(lookupWith("[0 1 8 27]", "[0 1 2 3]", 3.5, "Cubic spline", "Clip"), 27, 1e-12, "Cubic spline + Clip");

    // makima em x^2 (bp 0..4): inclinacoes s = [0 1.5 11/3 5.75 7.8] pelos pesos de Akima modificado.
    const double s[] = {0.0, 1.5, 44.0 / 12.0, 5.75, 7.8}, y[] = {0, 1, 4, 9, 16};
    const auto hermite = [&](size_t k, double x) {
        const double t = x - static_cast<double>(k), u = 1 - t;
        return (1 + 2 * t) * u * u * y[k] + t * u * u * s[k] + t * t * (3 - 2 * t) * y[k + 1] + t * t * (t - 1) * s[k + 1];
    };
    expectNear(lookupWith("[0 1 4 9 16]", "[0 1 2 3 4]", 1.5, "Akima spline", "Akima spline"), hermite(1, 1.5), 1e-12, "Akima spline (makima) em x = 1.5 (2.229167)");
    expectNear(lookupWith("[0 1 4 9 16]", "[0 1 2 3 4]", 0.25, "Akima spline", "Akima spline"), hermite(0, 0.25), 1e-12, "Akima spline (makima) em x = 0.25");
    expectNear(lookupWith("[0 1 4 9 16]", "[0 1 2 3 4]", 4.5, "Akima spline", "Akima spline"), hermite(3, 4.5), 1e-12, "Akima spline extrapolada (19.93125)");

    // Padroes do preset 1-D Lookup Table: tanh([-5:5]) em [-5:5].
    Harness h;
    const uint32_t input = h.add("constant", {{"Value", text("0.5")}});
    const uint32_t preset = h.add("lookup_nd", {{"NumberOfTableDimensions", text("1")}, {"Table", text("tanh([-5:5])")}, {"BreakpointsForDimension1", text("[-5:5]")}});
    h.wire(input, "out1", preset, "in1");
    const uint32_t vector = h.add("constant", {{"Value", text("[0.5 1.5]")}});
    const uint32_t elementwise = h.add("lookup_nd", {{"NumberOfTableDimensions", text("1")}, {"Table", text("[0 10 40]")}, {"BreakpointsForDimension1", text("[0 1 2]")}});
    h.wire(vector, "out1", elementwise, "in1");
    const uint32_t tablePort = h.add("lookup_nd", {{"NumberOfTableDimensions", text("1")}, {"TableSource", text("Input port")}, {"BreakpointsForDimension1", text("[0 1 2]")}});
    const uint32_t tableValues = h.add("constant", {{"Value", text("[0 10 40]")}});
    h.wire(input, "out1", tablePort, "in1");
    h.wire(tableValues, "out1", tablePort, "T");
    const uint32_t bpPort = h.add("lookup_nd", {{"NumberOfTableDimensions", text("1")}, {"Table", text("[0 10 40]")}, {"BreakpointsForDimension1Source", text("Input port")}});
    const uint32_t bpValues = h.add("constant", {{"Value", text("[0 1 2]")}});
    h.wire(vector, "out1", bpPort, "in1");
    h.wire(bpValues, "out1", bpPort, "bp1");
    h.runUntil(0.01);
    expectNear(h.value(preset), 0.5 * std::tanh(1.0), 1e-12, "1-D Lookup Table padrao: interpolacao de tanh entre 0 e 1");
    expectNear(h.value(elementwise, "out1", 0), 5, 1e-12, "1-D elemento a elemento (0)");
    expectNear(h.value(elementwise, "out1", 1), 25, 1e-12, "1-D elemento a elemento (1)");
    expectNear(h.value(tablePort), 5, 1e-12, "1-D com tabela pela porta T");
    expectNear(h.value(bpPort, "out1", 1), 25, 1e-12, "1-D com breakpoints pela porta bp1");

    const auto refuses = [](std::initializer_list<std::pair<const char*, PropertyValue>> props) {
        return fails([&] {
            Harness e;
            const uint32_t table = e.add("lookup_nd", {{"NumberOfTableDimensions", text("1")}, {"Table", text("[0 10 40]")}, {"BreakpointsForDimension1", text("[0 1 2]")}});
            for (const auto& [name, value] : props) set(e, table, name, value);
            e.runUntil(0.01);
        });
    };
    check(refuses({{"BreakpointsForDimension1", text("[0 2 1]")}}), "n-D Lookup recusa breakpoints nao estritamente crescentes");
    check(refuses({{"BreakpointsForDimension1", text("[0 1 1]")}}), "n-D Lookup recusa breakpoints repetidos");
    check(refuses({{"Table", text("[1 2]")}}), "n-D Lookup recusa tabela com tamanho diferente dos breakpoints");
    check(refuses({{"InterpMethod", text("Akima spline")}}), "Akima spline exige extrapolacao Akima spline");
    check(refuses({{"ExtrapMethod", text("Cubic spline")}}), "Extrapolacao Cubic spline exige interpolacao Cubic spline");
    check(refuses({{"DataSpecification", text("Lookup table object")}}), "Lookup table object nao suportado");
    check(refuses({{"IndexSearchMethod", text("Evenly spaced points")}, {"BreakpointsForDimension1", text("[0 1 3]")}}),
          "Evenly spaced points recusa breakpoints nao uniformes");
    check(fails([] {
        Harness e;
        const uint32_t v = e.add("constant", {{"Value", text("[0.5 1.5]")}});
        const uint32_t table = e.add("lookup_nd", {{"NumberOfTableDimensions", text("1")}, {"Table", text("[0 10 40]")}, {"BreakpointsForDimension1", text("[0 1 2]")},
                                                  {"InterpMethod", text("Cubic spline")}, {"ExtrapMethod", text("Cubic spline")}});
        e.wire(v, "out1", table, "in1");
        e.runUntil(0.01);
    }), "Cubic spline recusa sinal vetorial");
}

void lookupMultiD() {
    Harness h;
    const uint32_t u1 = h.add("constant", {{"Value", text("1.5")}});
    const uint32_t u2 = h.add("constant", {{"Value", text("2.5")}});
    const uint32_t twoD = h.add("lookup_nd", {{"NumberOfTableDimensions", text("2")}, {"Table", text("[4 5 6; 16 19 20; 10 18 23]")},
                                              {"BreakpointsForDimension1", text("[1:3]")}, {"BreakpointsForDimension2", text("[1:3]")}});
    h.wire(u1, "out1", twoD, "in1");
    h.wire(u2, "out1", twoD, "in2");
    const uint32_t a = h.add("constant", {{"Value", text("4")}});
    const uint32_t b = h.add("constant", {{"Value", text("1")}});
    const uint32_t extrap = h.add("lookup_nd", {{"NumberOfTableDimensions", text("2")}, {"Table", text("[4 5 6; 16 19 20; 10 18 23]")},
                                                {"BreakpointsForDimension1", text("[1:3]")}, {"BreakpointsForDimension2", text("[1:3]")}});
    h.wire(a, "out1", extrap, "in1");
    h.wire(b, "out1", extrap, "in2");
    const uint32_t both = h.add("constant", {{"Value", text("[1.5 2.5]")}});
    const uint32_t single = h.add("lookup_nd", {{"NumberOfTableDimensions", text("2")}, {"Table", text("[4 5 6; 16 19 20; 10 18 23]")},
                                                {"BreakpointsForDimension1", text("[1:3]")}, {"BreakpointsForDimension2", text("[1:3]")},
                                                {"UseOneInputPortForAllInputData", on()}});
    h.wire(both, "out1", single, "in1");
    // 3-D: T(i,j,k) = i + 3(j-1) + 9(k-1) (ordem por coluna) com bp [0 1 2], [0 1 2], [0 1]:
    // a tabela e afim nos breakpoints, entao a interpolacao trilinear e exata: 1 + x + 3y + 9z.
    const uint32_t x = h.add("constant", {{"Value", text("0.5")}});
    const uint32_t y = h.add("constant", {{"Value", text("1.25")}});
    const uint32_t z = h.add("constant", {{"Value", text("0.5")}});
    const uint32_t threeD = h.add("lookup_nd", {{"Table", text("reshape([1:18],[3,3,2])")}, {"BreakpointsForDimension1", text("[0 1 2]")},
                                                {"BreakpointsForDimension2", text("[0 1 2]")}, {"BreakpointsForDimension3", text("[0 1]")}});
    const uint32_t flattened = h.add("lookup_nd", {{"Table", text("reshape([1:18],3,6)")}, {"BreakpointsForDimension1", text("[0 1 2]")},
                                                   {"BreakpointsForDimension2", text("[0 1 2]")}, {"BreakpointsForDimension3", text("[0 1]")}});
    const uint32_t lagrange = h.add("lookup_nd", {{"Table", text("reshape([1:18],[3,3,2])")}, {"BreakpointsForDimension1", text("[0 1 2]")},
                                                  {"BreakpointsForDimension2", text("[0 1 2]")}, {"BreakpointsForDimension3", text("[0 1]")},
                                                  {"InterpMethod", text("Linear Lagrange")}});
    const uint32_t cubic3 = h.add("lookup_nd", {{"Table", text("reshape([1:18],[3,3,2])")}, {"BreakpointsForDimension1", text("[0 1 2]")},
                                                {"BreakpointsForDimension2", text("[0 1 2]")}, {"BreakpointsForDimension3", text("[0 1]")},
                                                {"InterpMethod", text("Cubic spline")}, {"ExtrapMethod", text("Cubic spline")}});
    const uint32_t nearest3 = h.add("lookup_nd", {{"Table", text("reshape([1:18],[3,3,2])")}, {"BreakpointsForDimension1", text("[0 1 2]")},
                                                  {"BreakpointsForDimension2", text("[0 1 2]")}, {"BreakpointsForDimension3", text("[0 1]")},
                                                  {"InterpMethod", text("Nearest")}});
    for (uint32_t block : {threeD, flattened, lagrange, cubic3, nearest3}) {
        h.wire(x, "out1", block, "in1");
        h.wire(y, "out1", block, "in2");
        h.wire(z, "out1", block, "in3");
    }
    // Padrao do n-D (3x3x2 com as duas paginas iguais): (16, 26.5, 6) cai no meio da celula -> (5+6+19+20)/4.
    const uint32_t q1 = h.add("constant", {{"Value", text("16")}});
    const uint32_t q2 = h.add("constant", {{"Value", text("26.5")}});
    const uint32_t q3 = h.add("constant", {{"Value", text("6")}});
    const uint32_t defaults = h.add("lookup_nd");
    h.wire(q1, "out1", defaults, "in1");
    h.wire(q2, "out1", defaults, "in2");
    h.wire(q3, "out1", defaults, "in3");
    h.runUntil(0.01);
    expectNear(h.value(twoD), (5.0 + 6.0 + 19.0 + 20.0) / 4.0, 1e-12, "2-D bilinear no centro da celula (12.5)");
    expectNear(h.value(extrap), 10.0 + (10.0 - 16.0), 1e-12, "2-D extrapolacao Linear na 1a dimensao");
    expectNear(h.value(single), 12.5, 1e-12, "2-D com uma porta u = [u1 u2]");
    expectNear(h.value(threeD), 1 + 0.5 + 3 * 1.25 + 9 * 0.5, 1e-12, "3-D trilinear (reshape N-D, ordem por coluna)");
    expectNear(h.value(flattened), 1 + 0.5 + 3 * 1.25 + 9 * 0.5, 1e-12, "3-D com tabela 3x6 (N-D achatado por coluna)");
    expectNear(h.value(lagrange), 1 + 0.5 + 3 * 1.25 + 9 * 0.5, 1e-12, "3-D Linear Lagrange");
    expectNear(h.value(cubic3), 1 + 0.5 + 3 * 1.25 + 9 * 0.5, 1e-12, "3-D spline cubica natural reproduz funcao afim");
    expectNear(h.value(nearest3), 1 + 1 + 3 * 1 + 9 * 1, 0, "3-D Nearest (0.5 -> 1, 1.25 -> 1, 0.5 -> 1 empate para cima)");
    expectNear(h.value(defaults), 12.5, 1e-12, "n-D Lookup Table com os padroes (3x3x2)");
}

void prelookupAndInterpolation() {
    Harness h;
    const uint32_t u = h.add("constant", {{"Value", text("55")}});
    const uint32_t pre = h.add("prelookup");
    const uint32_t doc = h.add("prelookup", {{"BreakpointsData", text("[0 5 10 20 50 100]")}});
    h.wire(u, "out1", pre, "in1");
    h.wire(u, "out1", doc, "in1");
    const uint32_t below = h.add("constant", {{"Value", text("[-5 120 110]")}});
    const uint32_t clip = h.add("prelookup");
    const uint32_t last = h.add("prelookup", {{"UseLastBreakpoint", on()}});
    h.wire(below, "out1", clip, "in1");
    h.wire(below, "out1", last, "in1");
    const uint32_t lin = h.add("constant", {{"Value", text("[0.5 3.5]")}});
    const uint32_t linear = h.add("prelookup", {{"BreakpointsData", text("[1 2 3]")}, {"ExtrapMethod", text("Linear")}});
    const uint32_t indexOnly = h.add("prelookup", {{"BreakpointsData", text("[1 2 3]")}, {"OutputSelection", text("Index only")}});
    const uint32_t even = h.add("prelookup", {{"BreakpointsSpecification", text("Even spacing")}});
    const uint32_t port = h.add("prelookup", {{"BreakpointsDataSource", text("Input port")}});
    const uint32_t portBp = h.add("constant", {{"Value", text("[0 5 10 20 50 100]")}});
    h.wire(lin, "out1", linear, "in1");
    h.wire(lin, "out1", indexOnly, "in1");
    h.wire(u, "out1", even, "in1");
    h.wire(u, "out1", port, "in1");
    h.wire(portBp, "out1", port, "bp");
    h.runUntil(0.01);
    expectNear(h.value(pre, "out1"), 4, 0, "Prelookup padrao [10:10:110], u = 55: k = 4");
    expectNear(h.value(pre, "out2"), 0.5, 1e-12, "Prelookup padrao: f = 0.5");
    expectNear(h.value(doc, "out1"), 4, 0, "Prelookup (exemplo da documentacao) k = 4");
    expectNear(h.value(doc, "out2"), 0.1, 1e-12, "Prelookup (exemplo da documentacao) f = 0.1");
    expectNear(h.value(clip, "out1", 0), 0, 0, "Prelookup Clip abaixo: k = 0");
    expectNear(h.value(clip, "out2", 0), 0, 0, "Prelookup Clip abaixo: f = 0");
    expectNear(h.value(clip, "out1", 1), 9, 0, "Prelookup Clip acima: k = n-2");
    expectNear(h.value(clip, "out2", 1), 1, 0, "Prelookup Clip acima: f = 1");
    expectNear(h.value(clip, "out1", 2), 9, 0, "Prelookup no ultimo breakpoint: k = n-2");
    expectNear(h.value(clip, "out2", 2), 1, 0, "Prelookup no ultimo breakpoint: f = 1");
    expectNear(h.value(last, "out1", 2), 10, 0, "Prelookup UseLastBreakpoint: k = n-1");
    expectNear(h.value(last, "out2", 2), 0, 0, "Prelookup UseLastBreakpoint: f = 0");
    expectNear(h.value(linear, "out1", 0), 0, 0, "Prelookup Linear abaixo: k = 0");
    expectNear(h.value(linear, "out2", 0), -0.5, 1e-12, "Prelookup Linear abaixo: f = -0.5 (documentacao)");
    expectNear(h.value(linear, "out1", 1), 1, 0, "Prelookup Linear acima: k = 1");
    expectNear(h.value(linear, "out2", 1), 1.5, 1e-12, "Prelookup Linear acima: f = 1.5 (documentacao)");
    expectNear(h.value(indexOnly, "out1", 1), 1, 0, "Prelookup Index only: k");
    expectNear(h.value(even, "out2"), 0.5, 1e-12, "Prelookup Even spacing (10, 10, 11 pontos) = padrao");
    expectNear(h.value(port, "out2"), 0.1, 1e-12, "Prelookup com breakpoints pela porta bp");

    // Interpolation Using Prelookup encadeado: bp [0 1 2], T [0 10 40].
    const auto chain = [](double input, const char* preExtrap, std::initializer_list<std::pair<const char*, PropertyValue>> extra) {
        Harness c;
        const uint32_t v = c.add("constant", {{"Value", text(std::to_string(input))}});
        const uint32_t p = c.add("prelookup", {{"BreakpointsData", text("[0 1 2]")}, {"ExtrapMethod", text(preExtrap)}});
        const uint32_t interp = c.add("interpolation_using_prelookup", {{"NumberOfTableDimensions", text("1")}, {"Table", text("[0 10 40]")}});
        for (const auto& [name, value] : extra) set(c, interp, name, value);
        c.wire(v, "out1", p, "in1");
        c.wire(p, "out1", interp, "in1");
        c.wire(p, "out2", interp, "in2");
        c.runUntil(0.01);
        return c.value(interp);
    };
    expectNear(chain(1.5, "Clip", {}), 25, 1e-12, "Interpolation Using Prelookup 1-D (Prelookup -> k, f)");
    expectNear(chain(3, "Linear", {}), 70, 1e-12, "Interpolation Using Prelookup com extrapolacao Linear nos dois blocos");
    expectNear(chain(3, "Clip", {}), 40, 1e-12, "Interpolation Using Prelookup com Clip");
    expectNear(chain(3, "Linear", {{"ExtrapMethod", text("Clip")}}), 40, 1e-12, "Interpolation Using Prelookup Clip limita f > 1");
    expectNear(chain(1.5, "Clip", {{"InterpMethod", text("Linear Lagrange")}}), 25, 1e-12, "Interpolation Using Prelookup Linear Lagrange");
    expectNear(chain(1.9, "Clip", {{"InterpMethod", text("Flat")}}), 10, 0, "Interpolation Using Prelookup Flat usa so k");
    expectNear(chain(1.5, "Clip", {{"InterpMethod", text("Nearest")}}), 40, 0, "Interpolation Using Prelookup Nearest: f = 0.5 -> k + 1");

    // Padrao 2-D: T(i,j) = sqrt(i j) 11x11, k1 = 2, f1 = 0.5, k2 = 3, f2 = 0.25 (base zero).
    Harness d;
    const uint32_t k1 = d.add("constant", {{"Value", text("2")}}), f1 = d.add("constant", {{"Value", text("0.5")}});
    const uint32_t k2 = d.add("constant", {{"Value", text("3")}}), f2 = d.add("constant", {{"Value", text("0.25")}});
    const uint32_t interp2 = d.add("interpolation_using_prelookup");
    d.wire(k1, "out1", interp2, "in1");
    d.wire(f1, "out1", interp2, "in2");
    d.wire(k2, "out1", interp2, "in3");
    d.wire(f2, "out1", interp2, "in4");
    const uint32_t lastIndex = d.add("interpolation_using_prelookup", {{"NumberOfTableDimensions", text("1")}, {"Table", text("[0 10 40]")},
                                                                      {"ExtrapMethod", text("Clip")}, {"ValidIndexMayReachLast", on()}});
    const uint32_t two = d.add("constant", {{"Value", text("2")}}), zero = d.add("constant", {{"Value", text("0")}});
    d.wire(two, "out1", lastIndex, "in1");
    d.wire(zero, "out1", lastIndex, "in2");
    d.runUntil(0.01);
    const auto t = [](double i, double j) { return std::sqrt(i * j); };
    const double expected = 0.5 * 0.75 * t(3, 4) + 0.5 * 0.75 * t(4, 4) + 0.5 * 0.25 * t(3, 5) + 0.5 * 0.25 * t(4, 5);
    expectNear(d.value(interp2), expected, 1e-12, "Interpolation Using Prelookup 2-D padrao sqrt([1:11]'*[1:11])");
    expectNear(d.value(lastIndex), 40, 1e-12, "Interpolation Using Prelookup: indice que alcanca o ultimo (k = n-1, f = 0)");
    check(fails([] {
        Harness e;
        e.add("interpolation_using_prelookup", {{"NumSelectionDims", text("1")}});
        e.runUntil(0.01);
    }), "Interpolation Using Prelookup recusa selecao de subtabela");
    check(fails([] {
        Harness e;
        e.add("prelookup", {{"BreakpointsData", text("[3 2 1]")}});
        e.runUntil(0.01);
    }), "Prelookup recusa breakpoints decrescentes");
}

void directAndDynamic() {
    Harness h;
    const uint32_t i1 = h.add("constant", {{"Value", text("1")}});
    const uint32_t i2 = h.add("constant", {{"Value", text("2")}});
    const uint32_t big = h.add("constant", {{"Value", text("5.3")}});
    const uint32_t frac = h.add("constant", {{"Value", text("1.7")}});
    const uint32_t element = h.add("direct_lookup_nd");
    const uint32_t clamped = h.add("direct_lookup_nd");
    const uint32_t truncated = h.add("direct_lookup_nd");
    h.wire(i1, "out1", element, "in1");
    h.wire(i2, "out1", element, "in2");
    h.wire(big, "out1", clamped, "in1");
    h.wire(i2, "out1", clamped, "in2");
    h.wire(frac, "out1", truncated, "in1");
    h.wire(i2, "out1", truncated, "in2");
    const uint32_t column = h.add("direct_lookup_nd", {{"InputsSelectThisObjectFromTable", text("Vector")}});
    h.wire(i1, "out1", column, "in1");
    const uint32_t page = h.add("direct_lookup_nd", {{"NumberOfTableDimensions", text("3")}, {"InputsSelectThisObjectFromTable", text("2-D Matrix")},
                                                     {"Table", text("reshape([1:18],[3,3,2])")}});
    h.wire(i1, "out1", page, "in1");
    const uint32_t tableInput = h.add("direct_lookup_nd", {{"NumberOfTableDimensions", text("1")}, {"TableIsInput", on()}});
    const uint32_t values = h.add("constant", {{"Value", text("[7 8 9]")}});
    h.wire(i2, "out1", tableInput, "in1");
    h.wire(values, "out1", tableInput, "T");
    h.runUntil(0.01);
    expectNear(h.value(element), 20, 0, "Direct Lookup Element: T(1+1, 2+1) = 20 (indices de base zero)");
    expectNear(h.value(clamped), 23, 0, "Direct Lookup: indice 5.3 fora da faixa limitado ao ultimo");
    expectNear(h.value(truncated), 20, 0, "Direct Lookup: indice 1.7 truncado para 1");
    const double columnExpected[] = {5, 19, 18};
    for (uint16_t e = 0; e < 3; ++e) expectNear(h.value(column, "out1", e), columnExpected[e], 0, "Direct Lookup Vector: T(:, 2) elemento " + std::to_string(e));
    for (uint16_t e = 0; e < 9; ++e) expectNear(h.value(page, "out1", e), 10.0 + e, 0, "Direct Lookup 2-D Matrix: T(:, :, 2) por coluna, elemento " + std::to_string(e));
    expectNear(h.value(tableInput), 9, 0, "Direct Lookup 1-D com tabela pela porta T");

    // Lookup Table Dynamic: exemplo da documentacao (xdat [-5:5], ydat sinh(xdat)).
    const auto dynamic = [](double x, const char* method) {
        Harness d;
        const uint32_t input = d.add("constant", {{"Value", text(std::to_string(x))}});
        const uint32_t xdat = d.add("constant", {{"Value", text("[-5:5]")}});
        const uint32_t ydat = d.add("constant", {{"Value", text("sinh([-5:5])")}});
        const uint32_t block = d.add("lookup_table_dynamic", {{"LookUpMeth", text(method)}});
        d.wire(input, "out1", block, "in1");
        d.wire(xdat, "out1", block, "in2");
        d.wire(ydat, "out1", block, "in3");
        d.runUntil(0.01);
        return d.value(block);
    };
    expectNear(dynamic(1.4, "Interpolation-Extrapolation"), std::sinh(1.0) + 0.4 * (std::sinh(2.0) - std::sinh(1.0)), 1e-12, "Lookup Table Dynamic interpolacao (2.156)");
    expectNear(dynamic(5.2, "Interpolation-Extrapolation"), std::sinh(5.0) + 0.2 * (std::sinh(5.0) - std::sinh(4.0)), 1e-9, "Lookup Table Dynamic extrapolacao (83.59)");
    expectNear(dynamic(5.2, "Interpolation-Use End Values"), std::sinh(5.0), 1e-12, "Lookup Table Dynamic Use End Values (74.2)");
    expectNear(dynamic(1.4, "Use Input Above"), std::sinh(2.0), 1e-12, "Lookup Table Dynamic Use Input Above (3.627)");
    expectNear(dynamic(5.2, "Use Input Above"), std::sinh(5.0), 1e-12, "Lookup Table Dynamic Use Input Above sem breakpoint acima");
    expectNear(dynamic(1.4, "Use Input Below"), std::sinh(1.0), 1e-12, "Lookup Table Dynamic Use Input Below (1.175)");
    expectNear(dynamic(-5.2, "Use Input Below"), std::sinh(-5.0), 1e-12, "Lookup Table Dynamic Use Input Below sem breakpoint abaixo (-74.2)");
    expectNear(dynamic(1.4, "Use Input Nearest"), std::sinh(1.0), 1e-12, "Lookup Table Dynamic Use Input Nearest (1.175)");
    check(fails([] {
        Harness e;
        const uint32_t two = e.add("constant", {{"Value", text("[1 2]")}});
        const uint32_t three = e.add("constant", {{"Value", text("[1 2 3]")}});
        const uint32_t block = e.add("lookup_table_dynamic");
        e.wire(two, "out1", block, "in2");
        e.wire(three, "out1", block, "in3");
        e.runUntil(0.01);
    }), "Lookup Table Dynamic recusa xdat e ydat de larguras diferentes");
    check(fails([] {
        Harness e;
        e.add("direct_lookup_nd", {{"NumberOfTableDimensions", text("3")}});
        e.runUntil(0.01);
    }), "Direct Lookup recusa tabela 3-D sem reshape");
}

/** Parametros ajustaveis (tunable) mudam com a simulacao em andamento, sem recompilar o plano. */
void tunableParameters() {
    Harness h;
    const uint32_t one = h.add("constant", {{"Value", text("1")}});
    const uint32_t relayBlock = h.add("relay");
    const uint32_t table = h.add("lookup_nd", {{"NumberOfTableDimensions", text("1")}, {"Table", text("[0 10 40]")}, {"BreakpointsForDimension1", text("[0 1 2]")}});
    const uint32_t dz = h.add("dead_zone");
    for (uint32_t block : {relayBlock, table, dz}) h.wire(one, "out1", block, "in1");
    h.runUntil(0.1);
    expectNear(h.value(relayBlock), 1, 0, "Relay antes do ajuste");
    expectNear(h.value(table), 10, 1e-12, "Lookup antes do ajuste");
    expectNear(h.value(dz), 0.5, 1e-15, "Dead Zone antes do ajuste");
    set(h, relayBlock, "OnOutputValue", text("5"));
    set(h, table, "Table", text("[0 20 40]"));
    set(h, dz, "UpperValue", text("0.25"));
    h.runUntil(0.2);
    expectNear(h.value(relayBlock), 5, 0, "Relay: Output when on ajustado em execucao");
    expectNear(h.value(table), 20, 1e-12, "Lookup: Table ajustada em execucao");
    expectNear(h.value(dz), 0.75, 1e-15, "Dead Zone: End of dead zone ajustado em execucao");
    check(fails([&] { set(h, table, "BreakpointsForDimension1", text("[0 2 1]")); }), "Lookup recusa ajuste para breakpoints nao crescentes");
    h.runUntil(0.3);
    expectNear(h.value(table), 20, 1e-12, "Lookup mantem os breakpoints anteriores depois do ajuste recusado");
}

} // namespace

int main() {
    const std::pair<const char*, std::function<void()>> cases[] = {
        {"saturation", saturation}, {"deadZone", deadZone}, {"dynamicLimits", dynamicLimits}, {"relay", relay}, {"rateLimiter", rateLimiter},
        {"rateLimiterDynamic", rateLimiterDynamic}, {"backlash", backlash}, {"coulomb", coulomb}, {"quantizerAndWrap", quantizerAndWrap},
        {"hitCrossing", hitCrossing}, {"pwm", pwm}, {"logicalOperator", logicalOperator}, {"relationalOperators", relationalOperators},
        {"detectors", detectors}, {"intervalAndCombinatorial", intervalAndCombinatorial}, {"lookupOneD", lookupOneD}, {"lookupMultiD", lookupMultiD},
        {"prelookupAndInterpolation", prelookupAndInterpolation}, {"directAndDynamic", directAndDynamic}, {"tunableParameters", tunableParameters},
    };
    for (const auto& [name, test] : cases) {
        try { test(); } catch (const std::exception& error) { check(false, std::string(name) + " lancou: " + error.what()); }
    }
    return finish("library_discontinuity_logic_lookup");
}
