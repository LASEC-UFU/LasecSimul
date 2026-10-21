// Blocos `sl.*` -- Continuous e Discrete (exceto PID) (docs/66). Referencias analiticas ou definicoes documentadas pela
// MathWorks; nunca o proprio engine como referencia.
#include <array>
#include <vector>

#include "library/LibraryTestHarness.hpp"

using namespace library_test;

namespace {

constexpr double kTs = 0.1;
constexpr double kPi = 3.14159265358979323846;

PropertyValue on() { return PropertyValue{true}; }

/** Instante logo depois do acerto k de uma taxa de 0.1 s. */
double after(int k) { return kTs * k + 0.05; }

/** Lê a sequência y(0..count-1) de um bloco discreto (amostras de 0.1 s). */
std::vector<double> samples(Harness& h, uint32_t block, int count, const char* port = "out1", uint16_t element = 0) {
    std::vector<double> values;
    for (int k = 0; k < count; ++k) {
        h.runUntil(after(k));
        values.push_back(h.value(block, port, element));
    }
    return values;
}

void expectSequence(const std::vector<double>& actual, const std::vector<double>& expected, double tol, const std::string& label) {
    bool ok = actual.size() == expected.size();
    std::string text;
    for (size_t i = 0; i < actual.size() && i < expected.size(); ++i) {
        ok = ok && std::abs(actual[i] - expected[i]) <= tol;
        text += std::to_string(actual[i]) + (i + 1 < actual.size() ? " " : "");
    }
    check(ok, label + " (obtido [" + text + "])");
}

uint32_t discreteConstant(Harness& h, const char* value) { return h.add("constant", {{"Value", text(value)}, {"SampleTime", text("0.1")}}); }
uint32_t discreteRamp(Harness& h) { return h.add("digital_clock", {{"SampleTime", text("0.1")}}); } // u(k) = 0.1 k
uint32_t discreteStep(Harness& h, const char* time, const char* before = "0", const char* after = "1") {
    return h.add("step", {{"Time", text(time)}, {"Before", text(before)}, {"After", text(after)}, {"SampleTime", text("0.1")}});
}

// ================================================================== Continuous

void integratorBlock() {
    {
        Harness h;
        const uint32_t one = h.add("constant", {{"Value", text("1")}});
        const uint32_t integrator = h.add("integrator", {{"InitialCondition", text("2")}});
        h.wire(one, "out1", integrator, "in1");
        h.runUntil(1.5);
        expectNear(h.value(integrator), 3.5, 1e-9, "Integrator: y = IC + t");
    }
    {
        // Limitado em [0, 1] com u = 1 ate t = 2 e u = -1 depois: satura em 1 e sai do limite logo que u < 0.
        Harness h;
        const uint32_t u = h.add("step", {{"Time", text("2")}, {"Before", text("1")}, {"After", text("-1")}});
        const uint32_t integrator = h.add("integrator", {{"LimitOutput", on()}, {"UpperSaturationLimit", text("1")}, {"LowerSaturationLimit", text("0")},
                                                         {"ShowSaturationPort", on()}, {"ShowStatePort", on()}});
        h.wire(u, "out1", integrator, "in1");
        h.runUntil(1.9);
        expectNear(h.value(integrator), 1.0, 1e-9, "Integrator limitado: segura no limite superior");
        expectNear(h.value(integrator, "sat"), 1.0, 0.0, "Integrator: porta de saturacao = 1 no limite superior");
        expectNear(h.value(integrator, "state"), 1.0, 1e-9, "Integrator: porta de estado = saida fora do reset");
        h.runUntil(2.5);
        expectNear(h.value(integrator), 0.5, 1e-6, "Integrator limitado: anti-windup (sai do limite assim que u < 0)");
        expectNear(h.value(integrator, "sat"), 0.0, 0.0, "Integrator: porta de saturacao = 0 dentro dos limites");
    }
    {
        Harness h;
        const uint32_t one = h.add("constant", {{"Value", text("1")}});
        const uint32_t integrator = h.add("integrator", {{"WrapState", on()}});
        h.wire(one, "out1", integrator, "in1");
        h.runUntil(4.0);
        expectNear(h.value(integrator), 4.0 - 2.0 * kPi, 1e-6, "Integrator wrap [-pi, pi): y = x - 2pi floor((x + pi)/2pi)");
    }
    {
        Harness h;
        const uint32_t one = h.add("constant", {{"Value", text("[1 2]")}});
        const uint32_t x0 = h.add("constant", {{"Value", text("3")}});
        const uint32_t integrator = h.add("integrator", {{"InitialConditionSource", text("external")}});
        h.wire(one, "out1", integrator, "in1");
        h.wire(x0, "out1", integrator, "x0");
        h.runUntil(1.0);
        expectNear(h.value(integrator, "out1", 0), 4.0, 1e-9, "Integrator: x0 externo + vetor (elemento 1)");
        expectNear(h.value(integrator, "out1", 1), 5.0, 1e-9, "Integrator: x0 externo + vetor (elemento 2)");
    }
    {
        // Reset por nivel: com o reset nao nulo o estado fica preso na condicao inicial.
        Harness h;
        const uint32_t one = h.add("constant", {{"Value", text("1")}});
        const uint32_t reset = h.add("step", {{"Time", text("1")}});
        const uint32_t integrator = h.add("integrator", {{"ExternalReset", text("level")}});
        h.wire(one, "out1", integrator, "in1");
        h.wire(reset, "out1", integrator, "reset");
        h.runUntil(0.5);
        expectNear(h.value(integrator), 0.5, 1e-9, "Integrator level: integra com reset nulo");
        h.runUntil(2.0);
        expectNear(h.value(integrator), 0.0, 1e-9, "Integrator level: segura IC enquanto reset != 0");
    }
    {
        Harness h;
        const uint32_t one = h.add("constant", {{"Value", text("1")}});
        const uint32_t vector = h.add("integrator", {{"WrapState", on()}, {"WrappedStateUpperValue", text("[1 2]")}, {"WrappedStateLowerValue", text("0")}});
        h.wire(one, "out1", vector, "in1");
        h.runUntil(1.5);
        expectNear(h.value(vector, "out1", 0), 0.5, 1e-6, "Integrator wrap vetorial: elemento 1 em [0, 1)");
        expectNear(h.value(vector, "out1", 1), 1.5, 1e-6, "Integrator wrap vetorial: elemento 2 em [0, 2)");
    }
    check(fails([] {
        Harness h;
        h.add("integrator", {{"LimitOutput", on()}, {"UpperSaturationLimit", text("1")}, {"LowerSaturationLimit", text("0")}, {"InitialCondition", text("2")}});
        h.runUntil(0.1);
    }), "Integrator: IC fora dos limites e recusada");
    check(fails([] { Harness h; h.add("integrator", {{"InitialCondition", text("inf")}}); h.runUntil(0.1); }), "Integrator: IC infinita e recusada");
}

void secondOrderIntegratorBlock() {
    {
        Harness h;
        const uint32_t u = h.add("constant", {{"Value", text("2")}});
        const uint32_t soi = h.add("second_order_integrator", {{"ICX", text("1")}, {"ICDXDT", text("3")}});
        h.wire(u, "out1", soi, "in1");
        h.runUntil(2.0);
        expectNear(h.value(soi, "out1"), 1.0 + 3.0 * 2.0 + 4.0, 1e-8, "Second-Order Integrator: x = x0 + v0 t + u t^2/2");
        expectNear(h.value(soi, "dx"), 3.0 + 4.0, 1e-8, "Second-Order Integrator: dx/dt = v0 + u t");
    }
    {
        Harness h;
        const uint32_t u = h.add("constant", {{"Value", text("1")}});
        const uint32_t soi = h.add("second_order_integrator", {{"LimitX", on()}, {"UpperLimitX", text("1")}, {"LowerLimitX", text("0")}});
        h.wire(u, "out1", soi, "in1");
        h.runUntil(1.0);
        expectNear(h.value(soi, "out1"), 0.5, 1e-8, "Second-Order Integrator limitado: x = t^2/2 antes do limite");
        h.runUntil(3.0);
        expectNear(h.value(soi, "out1"), 1.0, 1e-9, "Second-Order Integrator: x preso no limite superior");
        expectNear(h.value(soi, "dx"), 0.0, 1e-9, "Second-Order Integrator: dx/dt = 0 com x no limite");
    }
    {
        Harness h;
        const uint32_t u = h.add("constant", {{"Value", text("1")}});
        const uint32_t soi = h.add("second_order_integrator", {{"LimitDXDT", on()}, {"UpperLimitDXDT", text("1")}});
        h.wire(u, "out1", soi, "in1");
        h.runUntil(3.0);
        expectNear(h.value(soi, "dx"), 1.0, 1e-9, "Second-Order Integrator: dx/dt preso no limite");
        expectNear(h.value(soi, "out1"), 0.5 + 2.0, 1e-6, "Second-Order Integrator: x segue dx/dt = L depois do limite");
    }
    {
        Harness h;
        const uint32_t u = h.add("constant", {{"Value", text("1")}});
        const uint32_t x0 = h.add("constant", {{"Value", text("-1")}});
        const uint32_t dx0 = h.add("constant", {{"Value", text("2")}});
        const uint32_t reset = h.add("step", {{"Time", text("1")}});
        const uint32_t soi = h.add("second_order_integrator", {{"ICSourceX", text("external")}, {"ICSourceDXDT", text("external")},
                                                               {"ExternalReset", text("rising")}, {"ShowOutput", text("both")}});
        h.wire(u, "out1", soi, "in1");
        h.wire(x0, "out1", soi, "x0");
        h.wire(dx0, "out1", soi, "dx0");
        h.wire(reset, "out1", soi, "reset");
        h.runUntil(0.5);
        expectNear(h.value(soi, "out1"), -1.0 + 1.0 + 0.125, 1e-8, "Second-Order Integrator: ICs externas");
        h.runUntil(2.0);
        expectNear(h.value(soi, "out1"), -1.0 + 2.0 + 0.5, 1e-6, "Second-Order Integrator: reset rising volta os dois estados as ICs");
        expectNear(h.value(soi, "dx"), 3.0, 1e-6, "Second-Order Integrator: dx/dt depois do reset");
    }
    {
        Harness h;
        const uint32_t soi = h.add("second_order_integrator", {{"ShowOutput", text("dxdt")}, {"ICDXDT", text("4")}});
        h.runUntil(0.5);
        expectNear(h.value(soi, "dx"), 4.0, 1e-12, "Second-Order Integrator: Show output = dxdt publica so dx");
    }
    check(fails([] { Harness h; h.add("second_order_integrator", {{"LimitX", on()}, {"UpperLimitX", text("0")}, {"LowerLimitX", text("0")}}); h.runUntil(0.1); }),
          "Second-Order Integrator: limite superior de x deve ser estritamente maior");
    check(fails([] {
        Harness h;
        h.add("second_order_integrator", {{"LimitX", on()}, {"LimitDXDT", on()}, {"UpperLimitDXDT", text("2")}, {"LowerLimitDXDT", text("0.5")}});
        h.runUntil(0.1);
    }), "Second-Order Integrator: com x limitado, o intervalo de dx/dt deve conter 0");
}

void stateSpaceBlocks() {
    {
        Harness h;
        const uint32_t ss = h.add("state_space", {{"A", text("-1")}, {"B", text("1")}, {"C", text("1")}, {"D", text("0")}, {"InitialCondition", text("2")}});
        h.runUntil(1.0);
        expectNear(h.value(ss), 2.0 * std::exp(-1.0), 1e-8, "State-Space: resposta livre 2 e^-t");
    }
    {
        Harness h;
        const uint32_t u = h.add("constant", {{"Value", text("[1 1]")}});
        const uint32_t ss = h.add("state_space", {{"A", text("[-1 0; 0 -2]")}, {"B", text("eye(2)")}, {"C", text("eye(2)")}, {"D", text("zeros(2)")}});
        h.wire(u, "out1", ss, "in1");
        h.runUntil(1.0);
        expectNear(h.value(ss, "out1", 0), 1.0 - std::exp(-1.0), 1e-8, "State-Space MIMO: y1 = 1 - e^-t");
        expectNear(h.value(ss, "out1", 1), (1.0 - std::exp(-2.0)) / 2.0, 1e-8, "State-Space MIMO: y2 = (1 - e^-2t)/2");
    }
    {
        Harness h;
        const uint32_t ss = h.add("state_space", {{"A", text("-1")}, {"B", text("[]")}, {"C", text("1")}, {"D", text("[]")}, {"InitialCondition", text("1")}});
        h.runUntil(1.0);
        expectNear(h.value(ss), std::exp(-1.0), 1e-8, "State-Space autonomo (B e D vazios): e^-t");
    }
    check(fails([] {
        Harness h;
        const uint32_t u = h.add("constant", {{"Value", text("[1 2 3]")}});
        const uint32_t ss = h.add("state_space");
        h.wire(u, "out1", ss, "in1");
        h.runUntil(0.1);
    }), "State-Space: largura da entrada diferente das colunas de B e recusada");
    {
        // E x' = A x + B u com E = 2: x = 1 - e^(-t/2).
        Harness h;
        const uint32_t u = h.add("constant", {{"Value", text("1")}});
        const uint32_t ds = h.add("descriptor_state_space", {{"E", text("2")}, {"A", text("-1")}, {"B", text("1")}, {"C", text("1")}, {"D", text("0")}});
        h.wire(u, "out1", ds, "in1");
        h.runUntil(2.0);
        expectNear(h.value(ds), 1.0 - std::exp(-1.0), 1e-8, "Descriptor State-Space: E nao singular");
    }
    {
        // E singular (indice 1): x1' = -x1 + x2, 0 = x1 - 2 x2 + u, y = x2 = (x1 + u)/2, x1 = 1 - e^(-t/2).
        Harness h;
        const uint32_t u = h.add("constant", {{"Value", text("1")}});
        const uint32_t ds = h.add("descriptor_state_space", {{"E", text("[1 0; 0 0]")}, {"A", text("[-1 1; 1 -2]")}, {"B", text("[0; 1]")},
                                                             {"C", text("[0 1]")}, {"D", text("0")}, {"InitialCondition", text("[0; 0.5]")}});
        h.wire(u, "out1", ds, "in1");
        h.runUntil(2.0);
        expectNear(h.value(ds), (1.0 - std::exp(-1.0) + 1.0) / 2.0, 1e-8, "Descriptor State-Space: DAE de indice 1 (parte algebrica eliminada)");
    }
    check(fails([] {
        Harness h;
        h.add("descriptor_state_space", {{"E", text("[1 0; 0 0]")}, {"A", text("[0 1; 1 0]")}, {"B", text("[0; 1]")}, {"C", text("[1 0]")}, {"D", text("0")}});
        h.runUntil(0.1);
    }), "Descriptor State-Space: indice > 1 recusado");
    check(fails([] {
        Harness h;
        h.add("descriptor_state_space", {{"E", text("[1 0; 0 0]")}, {"A", text("[-1 1; 1 -2]")}, {"B", text("[0; 1]")}, {"C", text("[0 1]")},
                                         {"D", text("0")}, {"DirectFeedthrough", text("False")}});
        h.runUntil(0.1);
    }), "Descriptor State-Space: Direct feedthrough = False com D efetiva nao nula e recusado");
}

void transferFunctionBlocks() {
    {
        Harness h;
        const uint32_t u = h.add("constant", {{"Value", text("1")}});
        const uint32_t tf = h.add("transfer_fcn", {{"Numerator", text("[1; 2]")}, {"Denominator", text("[1 1]")}});
        h.wire(u, "out1", tf, "in1");
        h.runUntil(1.0);
        expectNear(h.value(tf, "out1", 0), 1.0 - std::exp(-1.0), 1e-8, "Transfer Fcn SIMO: saida 1");
        expectNear(h.value(tf, "out1", 1), 2.0 * (1.0 - std::exp(-1.0)), 1e-8, "Transfer Fcn SIMO: saida 2");
    }
    {
        Harness h;
        const uint32_t u = h.add("constant", {{"Value", text("1")}});
        const uint32_t tf = h.add("transfer_fcn", {{"Numerator", text("[1 2]")}, {"Denominator", text("[1 1]")}});
        h.wire(u, "out1", tf, "in1");
        h.runUntil(1.0);
        expectNear(h.value(tf), 2.0 - std::exp(-1.0), 1e-8, "Transfer Fcn bipropria (s+2)/(s+1): 2 - e^-t");
    }
    check(fails([] { Harness h; h.add("transfer_fcn", {{"Numerator", text("[1 2 3]")}, {"Denominator", text("[1 1]")}}); h.runUntil(0.1); }),
          "Transfer Fcn impropria e recusada");
    {
        // Zero-Pole padrao (s-1)/(s(s+1)) com degrau: y = 2 - t - 2 e^-t.
        Harness h;
        const uint32_t u = h.add("constant", {{"Value", text("1")}});
        const uint32_t zp = h.add("zero_pole");
        h.wire(u, "out1", zp, "in1");
        h.runUntil(1.0);
        expectNear(h.value(zp), 2.0 - 1.0 - 2.0 * std::exp(-1.0), 1e-8, "Zero-Pole padrao: 2 - t - 2e^-t");
    }
    {
        // Duas saidas: uma coluna de Zeros por elemento de Gain.
        Harness h;
        const uint32_t u = h.add("constant", {{"Value", text("1")}});
        const uint32_t zp = h.add("zero_pole", {{"Zeros", text("[1 2]")}, {"Poles", text("[-1 -2]")}, {"Gain", text("[1 3]")}});
        h.wire(u, "out1", zp, "in1");
        h.runUntil(1.0);
        const double e1 = std::exp(-1.0), e2 = std::exp(-2.0);
        expectNear(h.value(zp, "out1", 0), -0.5 + 2.0 * e1 - 1.5 * e2, 1e-8, "Zero-Pole SIMO: saida 1 (s-1)/((s+1)(s+2))");
        expectNear(h.value(zp, "out1", 1), -3.0 + 9.0 * e1 - 6.0 * e2, 1e-8, "Zero-Pole SIMO: saida 2 3(s-2)/((s+1)(s+2))");
    }
    check(fails([] { Harness h; h.add("zero_pole", {{"Zeros", text("[1 2 3]")}, {"Poles", text("[-1 -2]")}}); h.runUntil(0.1); }),
          "Zero-Pole: mais zeros que polos e recusado");
}

void derivativeAndDelays() {
    {
        Harness h;
        const uint32_t ramp = h.add("ramp", {{"slope", text("2")}});
        const uint32_t derivative = h.add("derivative");
        h.wire(ramp, "out1", derivative, "in1");
        h.runUntil(1.0);
        expectNear(h.value(derivative), 2.0, 1e-6, "Derivative de rampa: inclinacao");
    }
    {
        Harness h;
        const uint32_t sine = h.add("sine_wave");
        const uint32_t delay = h.add("transport_delay", {{"DelayTime", text("0.5")}, {"InitialOutput", text("3")}});
        h.wire(sine, "out1", delay, "in1");
        h.runUntil(0.3);
        expectNear(h.value(delay), 3.0, 0.0, "Transport Delay: Initial output antes do atraso");
        h.runUntil(2.0);
        expectNear(h.value(delay), std::sin(1.5), 1e-6, "Transport Delay: y = u(t - 0.5) (interpolacao linear)");
    }
    {
        Harness h;
        const uint32_t step = h.add("step", {{"Time", text("0.2")}});
        const uint32_t delay = h.add("transport_delay", {{"DelayTime", text("[0.5 1]")}});
        h.wire(step, "out1", delay, "in1");
        h.runUntil(1.0);
        expectNear(h.value(delay, "out1", 0), 1.0, 1e-9, "Transport Delay vetorial: elemento com atraso 0.5 ja chegou");
        expectNear(h.value(delay, "out1", 1), 0.0, 1e-9, "Transport Delay vetorial: elemento com atraso 1 ainda nao");
        h.runUntil(1.3);
        expectNear(h.value(delay, "out1", 1), 1.0, 1e-9, "Transport Delay vetorial: degrau chega em 1.2");
    }
    check(fails([] { Harness h; h.add("transport_delay", {{"DelayTime", text("-1")}}); h.runUntil(0.1); }), "Transport Delay: atraso negativo recusado");
    {
        Harness h;
        const uint32_t sine = h.add("sine_wave");
        const uint32_t tau = h.add("constant", {{"Value", text("0.5")}});
        const uint32_t delay = h.add("variable_time_delay");
        h.wire(sine, "out1", delay, "in1");
        h.wire(tau, "out1", delay, "in2");
        h.runUntil(2.0);
        expectNear(h.value(delay), std::sin(1.5), 1e-6, "Variable Time Delay: tau constante");
    }
    {
        Harness h;
        const uint32_t sine = h.add("sine_wave");
        const uint32_t clock = h.add("clock");
        const uint32_t gain = h.add("gain", {{"Gain", text("0.25")}});
        const uint32_t delay = h.add("variable_time_delay");
        h.wire(clock, "out1", gain, "in1");
        h.wire(sine, "out1", delay, "in1");
        h.wire(gain, "out1", delay, "in2");
        h.runUntil(2.0);
        expectNear(h.value(delay), std::sin(1.5), 1e-6, "Variable Time Delay: tau(t) = t/4 -> sin(0.75 t)");
    }
    {
        Harness h;
        const uint32_t sine = h.add("sine_wave");
        const uint32_t tau = h.add("constant", {{"Value", text("5")}});
        const uint32_t delay = h.add("variable_time_delay", {{"MaximumDelay", text("1")}, {"InitialOutput", text("7")}});
        h.wire(sine, "out1", delay, "in1");
        h.wire(tau, "out1", delay, "in2");
        h.runUntil(0.5);
        expectNear(h.value(delay), 7.0, 0.0, "Variable Time Delay: Initial output enquanto t < atraso");
        h.runUntil(3.0);
        expectNear(h.value(delay), std::sin(2.0), 1e-6, "Variable Time Delay: atraso limitado a Maximum delay");
    }
    {
        Harness h;
        const uint32_t sine = h.add("sine_wave");
        const uint32_t tau = h.add("constant", {{"Value", text("0")}});
        const uint32_t delay = h.add("variable_time_delay", {{"ZeroDelay", on()}});
        h.wire(sine, "out1", delay, "in1");
        h.wire(tau, "out1", delay, "in2");
        h.runUntil(1.0);
        expectNear(h.value(delay), std::sin(1.0), 1e-9, "Variable Time Delay: Handle zero delay passa u(t)");
    }
    {
        Harness h;
        const uint32_t sine = h.add("sine_wave");
        const uint32_t ti = h.add("constant", {{"Value", text("0.5")}});
        const uint32_t delay = h.add("variable_transport_delay", {{"InitialOutput", text("4")}});
        h.wire(sine, "out1", delay, "in1");
        h.wire(ti, "out1", delay, "in2");
        h.runUntil(0.3);
        expectNear(h.value(delay), 4.0, 0.0, "Variable Transport Delay: Initial output antes do transito completo");
        h.runUntil(2.0);
        expectNear(h.value(delay), std::sin(1.5), 1e-6, "Variable Transport Delay: ti constante = atraso fixo");
    }
    {
        // ti(t) = 1/(1 + t/2) (velocidade 1 + t/2): s(t) = t + t^2/4; em t = 2, s(t*) = 2 -> t* = -2 + sqrt(12).
        Harness h;
        const uint32_t clock = h.add("clock");
        const uint32_t ti = h.add("fcn", {{"Expr", text("1/(1+0.5*u)")}});
        const uint32_t delay = h.add("variable_transport_delay");
        h.wire(clock, "out1", ti, "in1");
        h.wire(clock, "out1", delay, "in1");
        h.wire(ti, "out1", delay, "in2");
        h.runUntil(2.0);
        expectNear(h.value(delay), -2.0 + std::sqrt(12.0), 1e-5, "Variable Transport Delay: integral de 1/ti = 1");
    }
}

void firstOrderHoldBlock() {
    {
        // Slow: y(T_k) = U_{k-1}; com rampa amostrada 0.1k, y(t) = t - 0.1 para t >= 0.1.
        Harness h;
        const uint32_t u = discreteRamp(h);
        const uint32_t foh = h.add("first_order_hold");
        h.wire(u, "out1", foh, "in1");
        h.runUntil(0.55);
        expectNear(h.value(foh), 0.45, 1e-9, "First Order Hold (Slow): interpolacao atrasada de uma amostra");
    }
    {
        Harness h;
        const uint32_t u = discreteRamp(h);
        const uint32_t foh = h.add("first_order_hold", {{"OutputAlgorithm", text("Fast (Minimize Error)")}});
        h.wire(u, "out1", foh, "in1");
        h.runUntil(0.55);
        expectNear(h.value(foh), 0.55, 1e-9, "First Order Hold (Fast): predicao segue a rampa sem atraso");
    }
    {
        Harness h;
        const uint32_t u = discreteConstant(h, "1");
        const uint32_t foh = h.add("first_order_hold", {{"InitialOutput", text("5")}});
        h.wire(u, "out1", foh, "in1");
        h.runUntil(0.05);
        expectNear(h.value(foh), 3.0, 1e-9, "First Order Hold: sai de Initial output sem salto (rampa ate U_0)");
        h.runUntil(0.3);
        expectNear(h.value(foh), 1.0, 1e-9, "First Order Hold: segue a entrada constante");
    }
    check(fails([] {
        Harness h;
        const uint32_t sine = h.add("sine_wave");
        const uint32_t foh = h.add("first_order_hold");
        h.wire(sine, "out1", foh, "in1");
        h.runUntil(0.1);
    }), "First Order Hold: entrada continua sem Allow continuous input e recusada");
    {
        Harness h;
        const uint32_t clock = h.add("clock");
        const uint32_t foh = h.add("first_order_hold", {{"AllowContinuousInput", on()}});
        h.wire(clock, "out1", foh, "in1");
        h.runUntil(1.0);
        check(std::abs(h.value(foh) - 1.0) < 1e-3 && h.value(foh) <= 1.0, "First Order Hold: entrada continua com atraso de um passo maior (" +
                                                                                std::to_string(h.value(foh)) + ")");
    }
}

void propagationDelayBlock() {
    {
        Harness h;
        const uint32_t u = h.add("step", {{"Time", text("1")}});
        const uint32_t dt = h.add("constant", {{"Value", text("0.5")}});
        const uint32_t delay = h.add("propagation_delay", {{"InitialOutput", text("2")}});
        h.wire(u, "out1", delay, "in1");
        h.wire(dt, "out1", delay, "dt");
        h.runUntil(0.3);
        expectNear(h.value(delay), 2.0, 0.0, "Propagation Delay: Initial output antes de T0 + D0");
        h.runUntil(1.4);
        expectNear(h.value(delay), 0.0, 0.0, "Propagation Delay: valor de antes do degrau");
        h.runUntil(1.6);
        expectNear(h.value(delay), 1.0, 0.0, "Propagation Delay: degrau chega em 1.5");
    }
    {
        Harness h;
        const uint32_t u = h.add("step", {{"Time", text("1")}});
        const uint32_t dt = h.add("constant", {{"Value", text("0.68")}});
        const uint32_t delay = h.add("propagation_delay", {{"RunAtFixedTimeIntervals", on()}, {"SampleTime", text("0.1")}});
        h.wire(u, "out1", delay, "in1");
        h.wire(dt, "out1", delay, "dt");
        h.runUntil(1.55);
        expectNear(h.value(delay), 0.0, 0.0, "Propagation Delay (intervalos fixos): 0.68 arredonda para 0.6");
        h.runUntil(1.65);
        expectNear(h.value(delay), 1.0, 0.0, "Propagation Delay (intervalos fixos): degrau em 1.6");
    }
}

// ================================================================== Discrete

void unitDelayAndMemory() {
    {
        Harness h;
        const uint32_t u = discreteStep(h, "0.3");
        const uint32_t delay = h.add("unit_delay", {{"InitialCondition", text("5")}});
        h.wire(u, "out1", delay, "in1");
        expectSequence(samples(h, delay, 6), {5, 0, 0, 0, 1, 1}, 0.0, "Unit Delay: y(k) = u(k-1), y(0) = IC");
    }
    check(fails([] {
        Harness h;
        const uint32_t u = discreteConstant(h, "1");
        const uint32_t delay = h.add("unit_delay", {{"InputProcessing", text("Columns as channels (frame based)")}});
        h.wire(u, "out1", delay, "in1");
        h.runUntil(0.1);
    }), "Unit Delay: frame based recusado");
    {
        Harness h;
        const uint32_t u = discreteRamp(h);
        const uint32_t memory = h.add("memory", {{"InitialCondition", text("5")}, {"InheritSampleTime", on()}});
        h.wire(u, "out1", memory, "in1");
        expectSequence(samples(h, memory, 5), {5, 0.0, 0.1, 0.2, 0.3}, 1e-12, "Memory (herda a taxa discreta): atraso de uma amostra");
    }
    {
        Harness h;
        const uint32_t clock = h.add("clock");
        const uint32_t memory = h.add("memory");
        h.wire(clock, "out1", memory, "in1");
        h.runUntil(1.0);
        check(h.value(memory) < 1.0 && h.value(memory) > 1.0 - 1e-3,
              "Memory (padrao): saida = entrada do passo maior anterior (" + std::to_string(h.value(memory)) + ")");
    }
    {
        Harness h;
        const uint32_t constant = h.add("constant", {{"Value", text("4")}});
        const uint32_t memory = h.add("memory", {{"InitialCondition", text("1")}, {"InheritSampleTime", on()}});
        h.wire(constant, "out1", memory, "in1");
        h.runUntil(0.5);
        expectNear(h.value(memory), 4.0, 0.0, "Memory com entrada constante: entrada depois do primeiro passo maior");
    }
    {
        Harness h;
        const uint32_t sine = h.add("sine_wave");
        const uint32_t zoh = h.add("zero_order_hold", {{"SampleTime", text("0.1")}});
        h.wire(sine, "out1", zoh, "in1");
        h.runUntil(0.35);
        expectNear(h.value(zoh), std::sin(0.3), 1e-12, "Zero-Order Hold: segura u(t_k)");
    }
}

void delayBlock() {
    {
        Harness h;
        const uint32_t u = discreteRamp(h);
        const uint32_t delay = h.add("delay", {{"InitialCondition", text("7")}});
        h.wire(u, "out1", delay, "in1");
        expectSequence(samples(h, delay, 5), {7, 7, 0.0, 0.1, 0.2}, 1e-12, "Delay N = 2: y(k) = u(k-2), IC nas duas primeiras");
    }
    {
        Harness h;
        const uint32_t u = discreteRamp(h);
        const uint32_t d = discreteConstant(h, "3");
        const uint32_t delay = h.add("delay", {{"DelayLengthSource", text("Input port")}});
        h.wire(u, "out1", delay, "in1");
        h.wire(d, "out1", delay, "d");
        expectSequence(samples(h, delay, 6), {0, 0, 0, 0.0, 0.1, 0.2}, 1e-12, "Delay pela porta d = 3");
    }
    {
        Harness h;
        const uint32_t u = discreteRamp(h);
        const uint32_t d = discreteConstant(h, "2.7");
        const uint32_t delay = h.add("delay", {{"DelayLengthSource", text("Input port")}});
        h.wire(u, "out1", delay, "in1");
        h.wire(d, "out1", delay, "d");
        expectSequence(samples(h, delay, 5), {0, 0, 0.0, 0.1, 0.2}, 1e-12, "Delay pela porta: d nao inteiro e truncado");
    }
    {
        Harness h;
        const uint32_t u = discreteRamp(h);
        const uint32_t d = discreteConstant(h, "0");
        const uint32_t delay = h.add("delay", {{"DelayLengthSource", text("Input port")}});
        h.wire(u, "out1", delay, "in1");
        h.wire(d, "out1", delay, "d");
        expectSequence(samples(h, delay, 3), {0.0, 0.1, 0.2}, 1e-12, "Delay pela porta: d = 0 e passagem direta");
    }
    {
        Harness h;
        const uint32_t u = discreteRamp(h);
        const uint32_t d = discreteConstant(h, "0");
        const uint32_t delay = h.add("delay", {{"DelayLengthSource", text("Input port")}, {"PreventDirectFeedthrough", on()}});
        h.wire(u, "out1", delay, "in1");
        h.wire(d, "out1", delay, "d");
        expectSequence(samples(h, delay, 3), {0.0, 0.0, 0.1}, 1e-12, "Delay: Prevent direct feedthrough eleva d = 0 para 1");
    }
    {
        Harness h;
        const uint32_t u = discreteRamp(h);
        const uint32_t d = discreteConstant(h, "500");
        const uint32_t delay = h.add("delay", {{"DelayLengthSource", text("Input port")}, {"DelayLengthUpperLimit", text("3")}});
        h.wire(u, "out1", delay, "in1");
        h.wire(d, "out1", delay, "d");
        expectSequence(samples(h, delay, 5), {0, 0, 0, 0.0, 0.1}, 1e-12, "Delay: d acima do limite superior e limitado");
    }
    {
        Harness h;
        const uint32_t u = discreteRamp(h);
        const uint32_t x0 = discreteConstant(h, "9");
        const uint32_t reset = discreteStep(h, "0.3");
        const uint32_t delay = h.add("delay", {{"InitialConditionSource", text("Input port")}, {"ExternalReset", text("Rising")}});
        h.wire(u, "out1", delay, "in1");
        h.wire(x0, "out1", delay, "x0");
        h.wire(reset, "out1", delay, "reset");
        expectSequence(samples(h, delay, 7), {9, 9, 0.0, 9, 9, 0.3, 0.4}, 1e-12, "Delay: x0 pela porta e reset rising volta os estados para x0");
    }
    {
        Harness h;
        const uint32_t u = discreteRamp(h);
        const uint32_t enable = discreteStep(h, "0.3");
        const uint32_t delay = h.add("delay", {{"DelayLength", text("1")}, {"InitialCondition", text("7")}, {"ShowEnablePort", on()}});
        h.wire(u, "out1", delay, "in1");
        h.wire(enable, "out1", delay, "enable");
        expectSequence(samples(h, delay, 6), {0, 0, 0, 7, 0.3, 0.4}, 1e-12, "Delay: 0 antes de habilitar, IC na primeira habilitacao");
    }
    {
        Harness h;
        const uint32_t u = discreteRamp(h);
        const uint32_t enable = discreteStep(h, "0.5", "1", "0");
        const uint32_t delay = h.add("delay", {{"DelayLength", text("1")}, {"InitialCondition", text("7")}, {"ShowEnablePort", on()}});
        h.wire(u, "out1", delay, "in1");
        h.wire(enable, "out1", delay, "enable");
        expectSequence(samples(h, delay, 8), {7, 0.0, 0.1, 0.2, 0.3, 0.3, 0.3, 0.3}, 1e-12, "Delay: desabilitado segura a ultima saida");
    }
    {
        Harness h;
        const uint32_t u = h.add("constant", {{"Value", text("1")}, {"SampleTime", text("[0.1 0.05]")}});
        const uint32_t delay = h.add("delay", {{"InitialCondition", text("3")}});
        h.wire(u, "out1", delay, "in1");
        h.runUntil(0.02);
        expectNear(h.value(delay), 0.0, 0.0, "Delay: saida 0 antes do primeiro acerto (deslocamento)");
        h.runUntil(0.06);
        expectNear(h.value(delay), 3.0, 0.0, "Delay: IC a partir do primeiro acerto");
    }
    {
        Harness h;
        const uint32_t u = discreteRamp(h);
        const uint32_t delay = h.add("delay", {{"DelayLength", text("1")}, {"InitialCondition", text("[1 2]")}});
        h.wire(u, "out1", delay, "in1");
        h.runUntil(0.05);
        expectNear(h.value(delay, "out1", 1), 2.0, 0.0, "Delay: IC vetorial expande a largura");
    }
    check(fails([] { Harness h; const uint32_t u = discreteConstant(h, "1"); const uint32_t d = h.add("delay", {{"DelayLength", text("1.5")}});
                     h.wire(u, "out1", d, "in1"); h.runUntil(0.1); }), "Delay: comprimento nao inteiro no dialogo recusado");
    check(fails([] { Harness h; const uint32_t u = discreteConstant(h, "1"); const uint32_t d = h.add("delay", {{"DelayLength", text("-1")}});
                     h.wire(u, "out1", d, "in1"); h.runUntil(0.1); }), "Delay: comprimento negativo recusado");
}

void discreteTimeIntegratorBlock() {
    const auto run = [](std::initializer_list<std::pair<const char*, PropertyValue>> props, int count) {
        Harness h;
        const uint32_t u = discreteConstant(h, "1");
        const uint32_t dti = h.add("discrete_time_integrator", props);
        h.wire(u, "out1", dti, "in1");
        return samples(h, dti, count);
    };
    expectSequence(run({}, 4), {0.0, 0.1, 0.2, 0.3}, 1e-12, "DTI Forward Euler: y(n) = y(n-1) + K T u(n-1)");
    expectSequence(run({{"IntegratorMethod", text("Integration: Backward Euler")}}, 4), {0.1, 0.2, 0.3, 0.4}, 1e-12, "DTI Backward Euler: y(n) = y(n-1) + K T u(n)");
    expectSequence(run({{"IntegratorMethod", text("Integration: Trapezoidal")}}, 4), {0.05, 0.15, 0.25, 0.35}, 1e-12, "DTI Trapezoidal (Auto): y(0) = IC + K T/2 u(0)");
    expectSequence(run({{"IntegratorMethod", text("Accumulation: Forward Euler")}}, 4), {0, 1, 2, 3}, 1e-12, "DTI acumulacao (T = 1)");
    expectSequence(run({{"IntegratorMethod", text("Accumulation: Backward Euler")}, {"gainval", text("2")}}, 3), {2, 4, 6}, 1e-12, "DTI acumulacao BE com ganho 2");
    expectSequence(run({{"IntegratorMethod", text("Integration: Backward Euler")}, {"InitialConditionSetting", text("Output")}}, 4), {0.0, 0.1, 0.2, 0.3},
                   1e-12, "DTI BE com Initial condition setting = Output: y(0) = IC");
    expectSequence(run({{"IntegratorMethod", text("Integration: Trapezoidal")}, {"InitialConditionSetting", text("Output")}}, 3), {0.0, 0.1, 0.2},
                   1e-12, "DTI Trapezoidal com Output: y(0) = IC, x(1) = y(0) + K T/2 u(0)");
    expectSequence(run({{"gainval", text("2")}, {"InitialCondition", text("1")}}, 3), {1.0, 1.2, 1.4}, 1e-12, "DTI ganho K e IC");
    {
        Harness h;
        const uint32_t u = discreteRamp(h); // u(k) = 0.1k: trapezio exato de t: y(n) = sum (u(k)+u(k-1))/2 T
        const uint32_t dti = h.add("discrete_time_integrator", {{"IntegratorMethod", text("Integration: Trapezoidal")}});
        h.wire(u, "out1", dti, "in1");
        // y(0) = T/2 u(0) = 0; y(n) = y(n-1) + T/2 (u(n) + u(n-1)) -> y(n) = 0.01 n^2/2.
        expectSequence(samples(h, dti, 4), {0.0, 0.005, 0.02, 0.045}, 1e-12, "DTI Trapezoidal com rampa: regra do trapezio");
    }
    {
        Harness h;
        const uint32_t u = discreteConstant(h, "1");
        const uint32_t dti = h.add("discrete_time_integrator", {{"LimitOutput", on()}, {"UpperSaturationLimit", text("0.25")}, {"ShowSaturationPort", on()},
                                                                {"ShowStatePort", on()}});
        h.wire(u, "out1", dti, "in1");
        expectSequence(samples(h, dti, 5), {0.0, 0.1, 0.2, 0.25, 0.25}, 1e-12, "DTI limitado: estado e saida presos no limite");
        expectNear(h.value(dti, "sat"), 1.0, 0.0, "DTI: porta de saturacao = 1 no limite superior");
        expectNear(h.value(dti, "state"), 0.25, 1e-12, "DTI: porta de estado = x(n)");
    }
    {
        Harness h;
        const uint32_t u = discreteConstant(h, "1");
        const uint32_t x0 = discreteConstant(h, "3");
        const uint32_t dti = h.add("discrete_time_integrator", {{"InitialConditionSource", text("external")}});
        h.wire(u, "out1", dti, "in1");
        h.wire(x0, "out1", dti, "x0");
        expectSequence(samples(h, dti, 3), {3.0, 3.1, 3.2}, 1e-12, "DTI: IC pela porta x0");
    }
    {
        Harness h;
        const uint32_t u = discreteConstant(h, "1");
        const uint32_t reset = discreteStep(h, "0.3");
        const uint32_t dti = h.add("discrete_time_integrator", {{"ExternalReset", text("rising")}, {"ShowStatePort", on()}});
        h.wire(u, "out1", dti, "in1");
        h.wire(reset, "out1", dti, "reset");
        expectSequence(samples(h, dti, 6), {0.0, 0.1, 0.2, 0.0, 0.1, 0.2}, 1e-12, "DTI reset rising: estado volta a IC");
        h.runUntil(after(3));
    }
    {
        Harness h;
        const uint32_t u = discreteConstant(h, "1");
        const uint32_t reset = discreteStep(h, "0.3");
        const uint32_t dti = h.add("discrete_time_integrator", {{"ExternalReset", text("rising")}, {"ShowStatePort", on()}});
        h.wire(u, "out1", dti, "in1");
        h.wire(reset, "out1", dti, "reset");
        h.runUntil(after(3));
        expectNear(h.value(dti, "state"), 0.3, 1e-12, "DTI: porta de estado mostra x(n) antes do reset");
        expectNear(h.value(dti), 0.0, 1e-12, "DTI: saida ja resetada no mesmo passo");
    }
    {
        Harness h;
        const uint32_t u = discreteConstant(h, "1");
        const uint32_t reset = discreteStep(h, "0.3", "-1", "0");
        const uint32_t dti = h.add("discrete_time_integrator", {{"ExternalReset", text("rising")}});
        h.wire(u, "out1", dti, "in1");
        h.wire(reset, "out1", dti, "reset");
        expectSequence(samples(h, dti, 5), {0.0, 0.1, 0.2, 0.3, 0.4}, 1e-12, "DTI: -1 -> 0 nao e borda de subida (so valores positivos)");
    }
    {
        Harness h;
        const uint32_t u = discreteConstant(h, "1");
        const uint32_t reset = discreteStep(h, "0.3");
        const uint32_t dti = h.add("discrete_time_integrator", {{"ExternalReset", text("level")}});
        h.wire(u, "out1", dti, "in1");
        h.wire(reset, "out1", dti, "reset");
        expectSequence(samples(h, dti, 6), {0.0, 0.1, 0.2, 0.0, 0.0, 0.0}, 1e-12, "DTI level: segura IC enquanto reset != 0");
    }
    check(fails([] { Harness h; const uint32_t u = discreteConstant(h, "1"); const uint32_t d = h.add("discrete_time_integrator", {{"gainval", text("-1")}});
                     h.wire(u, "out1", d, "in1"); h.runUntil(0.1); }), "DTI: ganho nao positivo recusado");
    check(fails([] { Harness h; const uint32_t u = h.add("sine_wave"); const uint32_t d = h.add("discrete_time_integrator");
                     h.wire(u, "out1", d, "in1"); h.runUntil(0.1); }), "DTI: tempo de amostragem continuo recusado");
}

void discreteTransferFunctionAndFilters() {
    {
        Harness h;
        const uint32_t u = discreteConstant(h, "1");
        const uint32_t tf = h.add("discrete_transfer_fcn", {{"Numerator", text("[1 0]")}, {"Denominator", text("[1 -0.5]")}});
        h.wire(u, "out1", tf, "in1");
        expectSequence(samples(h, tf, 3), {1.0, 1.5, 1.75}, 1e-12, "Discrete Transfer Fcn z/(z-0.5): passagem direta");
    }
    {
        // 1/(z + 0.5), estados iniciais 2, u = 0: y = 2, -1, 0.5.
        Harness h;
        const uint32_t u = discreteConstant(h, "0");
        const uint32_t tf = h.add("discrete_transfer_fcn", {{"InitialStates", text("2")}});
        h.wire(u, "out1", tf, "in1");
        expectSequence(samples(h, tf, 3), {2.0, -1.0, 0.5}, 1e-12, "Discrete Transfer Fcn: estados iniciais (atrasos do diagrama)");
    }
    {
        Harness h;
        const uint32_t u = discreteConstant(h, "0");
        const uint32_t x0 = discreteConstant(h, "2");
        const uint32_t tf = h.add("discrete_transfer_fcn", {{"InitialStatesSource", text("Input port")}});
        h.wire(u, "out1", tf, "in1");
        h.wire(x0, "out1", tf, "x0");
        expectSequence(samples(h, tf, 3), {2.0, -1.0, 0.5}, 1e-12, "Discrete Transfer Fcn: estados iniciais pela porta x0");
    }
    {
        Harness h;
        const uint32_t u = discreteConstant(h, "[1 2]");
        const uint32_t tf = h.add("discrete_transfer_fcn", {{"Denominator", text("[1 -0.5]")}});
        h.wire(u, "out1", tf, "in1");
        h.runUntil(after(2));
        expectNear(h.value(tf, "out1", 0), 1.5, 1e-12, "Discrete Transfer Fcn por canal: canal 1");
        expectNear(h.value(tf, "out1", 1), 3.0, 1e-12, "Discrete Transfer Fcn por canal: canal 2");
    }
    {
        Harness h;
        const uint32_t u = discreteConstant(h, "1");
        const uint32_t tf = h.add("discrete_transfer_fcn", {{"Numerator", text("[1; 2]")}, {"Denominator", text("[1 -0.5]")}});
        h.wire(u, "out1", tf, "in1");
        h.runUntil(after(2));
        expectNear(h.value(tf, "out1", 1), 3.0, 1e-12, "Discrete Transfer Fcn: numerador matricial = varias saidas");
    }
    {
        Harness h;
        const uint32_t u = discreteConstant(h, "1");
        const uint32_t reset = discreteStep(h, "0.3");
        const uint32_t tf = h.add("discrete_transfer_fcn", {{"Denominator", text("[1 -0.5]")}, {"ExternalReset", text("Rising")}});
        h.wire(u, "out1", tf, "in1");
        h.wire(reset, "out1", tf, "reset");
        expectSequence(samples(h, tf, 5), {0.0, 1.0, 1.5, 0.0, 1.0}, 1e-12, "Discrete Transfer Fcn: reset rising zera os estados");
    }
    {
        Harness h;
        const uint32_t u = discreteConstant(h, "1");
        const uint32_t num = discreteConstant(h, "[0 1]");
        const uint32_t den = discreteConstant(h, "[1 -0.5]");
        const uint32_t tf = h.add("discrete_transfer_fcn", {{"NumeratorSource", text("Input port")}, {"DenominatorSource", text("Input port")},
                                                             {"a0EqualsOne", on()}});
        h.wire(u, "out1", tf, "in1");
        h.wire(num, "out1", tf, "num");
        h.wire(den, "out1", tf, "den");
        expectSequence(samples(h, tf, 3), {0.0, 1.0, 1.5}, 1e-12, "Discrete Transfer Fcn: coeficientes pelas portas Num/Den");
    }
    {
        Harness h;
        const uint32_t u = discreteConstant(h, "1");
        const uint32_t tf = h.add("discrete_transfer_fcn", {{"Denominator", text("[2 -1]")}});
        h.wire(u, "out1", tf, "in1");
        expectSequence(samples(h, tf, 3), {0.0, 0.5, 0.75}, 1e-12, "Discrete Transfer Fcn: divide por a0");
    }
    check(fails([] { Harness h; const uint32_t u = discreteConstant(h, "1");
                     const uint32_t tf = h.add("discrete_transfer_fcn", {{"Denominator", text("[2 -1]")}, {"a0EqualsOne", on()}});
                     h.wire(u, "out1", tf, "in1"); h.runUntil(0.1); }), "Discrete Transfer Fcn: a0EqualsOne com a0 != 1 recusado");
    check(fails([] { Harness h; const uint32_t u = discreteConstant(h, "1");
                     const uint32_t tf = h.add("discrete_transfer_fcn", {{"Numerator", text("[1 2 3]")}});
                     h.wire(u, "out1", tf, "in1"); h.runUntil(0.1); }), "Discrete Transfer Fcn: numerador de ordem maior recusado");
    check(fails([] { Harness h; const uint32_t u = discreteConstant(h, "1");
                     const uint32_t tf = h.add("discrete_transfer_fcn", {{"Denominator", text("[0 1]")}});
                     h.wire(u, "out1", tf, "in1"); h.runUntil(0.1); }), "Discrete Transfer Fcn: a0 = 0 recusado");

    // Discrete Filter (potências de z^-1).
    {
        Harness h;
        const uint32_t u = discreteConstant(h, "1");
        const uint32_t filter = h.add("discrete_filter");
        h.wire(u, "out1", filter, "in1");
        expectSequence(samples(h, filter, 3), {1.0, 0.5, 0.75}, 1e-12, "Discrete Filter padrao 1/(1 + 0.5 z^-1)");
    }
    {
        Harness h;
        const uint32_t u = discreteConstant(h, "1");
        const uint32_t filter = h.add("discrete_filter", {{"Numerator", text("[1 1]")}, {"Denominator", text("1")}});
        h.wire(u, "out1", filter, "in1");
        expectSequence(samples(h, filter, 3), {1.0, 2.0, 2.0}, 1e-12, "Discrete Filter FIR 1 + z^-1 (numerador mais longo)");
    }
    // Todas as estruturas: y(k) = 0.3 y(k-1) + u(k) + 0.5 u(k-1), u = rampa 0.1 k.
    std::vector<double> reference;
    {
        double y = 0.0, uPrev = 0.0;
        for (int k = 0; k < 6; ++k) { const double u = 0.1 * k; y = 0.3 * y + u + 0.5 * uPrev; uPrev = u; reference.push_back(y); }
    }
    for (const char* structure : {"Direct form I", "Direct form I transposed", "Direct form II", "Direct form II transposed"}) {
        Harness h;
        const uint32_t u = discreteRamp(h);
        const uint32_t filter = h.add("discrete_filter", {{"FilterStructure", text(structure)}, {"Numerator", text("[1 0.5]")}, {"Denominator", text("[1 -0.3]")}});
        h.wire(u, "out1", filter, "in1");
        expectSequence(samples(h, filter, 6), reference, 1e-12, std::string("Discrete Filter ") + structure + ": mesma resposta com ICs nulas");
    }
    // Condições iniciais por estrutura (u = 0), definidas pelo diagrama de cada forma.
    const struct { const char* structure; const char* ic; const char* icDen; std::vector<double> expected; } icCases[] = {
        {"Direct form II", "1", "0", {0.8, 0.24}},
        {"Direct form II transposed", "1", "0", {1.0, 0.3}},
        {"Direct form I", "1", "2", {1.1, 0.33}},
        {"Direct form I transposed", "1", "2", {3.0, 1.6}},
    };
    for (const auto& item : icCases) {
        Harness h;
        const uint32_t u = discreteConstant(h, "0");
        const uint32_t filter = h.add("discrete_filter", {{"FilterStructure", text(item.structure)}, {"Numerator", text("[1 0.5]")}, {"Denominator", text("[1 -0.3]")},
                                                          {"InitialStates", text(item.ic)}, {"InitialDenominatorStates", text(item.icDen)}});
        h.wire(u, "out1", filter, "in1");
        expectSequence(samples(h, filter, 2), item.expected, 1e-12, std::string("Discrete Filter ") + item.structure + ": estados iniciais");
    }
    check(fails([] { Harness h; const uint32_t u = discreteConstant(h, "1");
                     const uint32_t f = h.add("discrete_filter", {{"DenominatorSource", text("Input port")}});
                     const uint32_t den = discreteConstant(h, "[1 0.5]");
                     h.wire(u, "out1", f, "in1"); h.wire(den, "out1", f, "den"); h.runUntil(0.1); }),
          "Discrete Filter: Den pela porta sem a0EqualsOne recusado");

    // Discrete FIR Filter.
    {
        Harness h;
        const uint32_t u = discreteStep(h, "0.3");
        const uint32_t fir = h.add("discrete_fir_filter");
        h.wire(u, "out1", fir, "in1");
        expectSequence(samples(h, fir, 5), {0, 0, 0, 0.5, 1.0}, 1e-12, "Discrete FIR Filter padrao 0.5 + 0.5 z^-1");
    }
    const struct { const char* structure; const char* coefficients; double steady; } firCases[] = {
        {"Direct form", "[1 2 3]", 6.0}, {"Direct form transposed", "[1 2 3]", 6.0},
        {"Direct form symmetric", "[1 2 3]", 4.0}, {"Direct form antisymmetric", "[1 2 3]", 2.0},
        {"Lattice MA", "[0.5 0.5]", 2.25},
    };
    for (const auto& item : firCases) {
        Harness h;
        const uint32_t u = discreteConstant(h, "1");
        const uint32_t fir = h.add("discrete_fir_filter", {{"FilterStructure", text(item.structure)}, {"Coefficients", text(item.coefficients)}});
        h.wire(u, "out1", fir, "in1");
        h.runUntil(after(4));
        expectNear(h.value(fir), item.steady, 1e-12, std::string("Discrete FIR ") + item.structure + ": ganho DC (soma dos coeficientes efetivos)");
    }
    {
        Harness h;
        const uint32_t u = discreteConstant(h, "1");
        const uint32_t fir = h.add("discrete_fir_filter", {{"FilterStructure", text("Lattice MA")}, {"Coefficients", text("[0.5 0.5]")}});
        h.wire(u, "out1", fir, "in1");
        expectSequence(samples(h, fir, 3), {1.0, 1.75, 2.25}, 1e-12, "Discrete FIR Lattice MA [0.5 0.5] = 1 + 0.75 z^-1 + 0.5 z^-2");
    }
    {
        Harness h;
        const uint32_t u = discreteConstant(h, "0");
        const uint32_t fir = h.add("discrete_fir_filter", {{"InitialStates", text("3")}});
        h.wire(u, "out1", fir, "in1");
        expectSequence(samples(h, fir, 2), {1.5, 0.0}, 1e-12, "Discrete FIR: estado inicial = entrada passada");
    }
    {
        Harness h;
        const uint32_t u = discreteConstant(h, "1");
        const uint32_t num = discreteConstant(h, "[0.25 0.75]");
        const uint32_t fir = h.add("discrete_fir_filter", {{"CoefSource", text("Input port")}});
        h.wire(u, "out1", fir, "in1");
        h.wire(num, "out1", fir, "num");
        expectSequence(samples(h, fir, 2), {0.25, 1.0}, 1e-12, "Discrete FIR: coeficientes pela porta Num");
    }
    {
        Harness h;
        const uint32_t u = discreteRamp(h);
        const uint32_t fir = h.add("discrete_fir_filter", {{"Coefficients", text("[1 0; 0 1]")}});
        h.wire(u, "out1", fir, "in1");
        h.runUntil(after(3));
        expectNear(h.value(fir, "out1", 0), 0.3, 1e-12, "Discrete FIR matricial: filtro 1 = u(k)");
        expectNear(h.value(fir, "out1", 1), 0.2, 1e-12, "Discrete FIR matricial: filtro 2 = u(k-1)");
    }
    {
        Harness h;
        const uint32_t u = discreteConstant(h, "1");
        const uint32_t reset = discreteStep(h, "0.3");
        const uint32_t fir = h.add("discrete_fir_filter", {{"ExternalReset", text("Rising")}});
        h.wire(u, "out1", fir, "in1");
        h.wire(reset, "out1", fir, "reset");
        expectSequence(samples(h, fir, 5), {0.5, 1.0, 1.0, 0.5, 1.0}, 1e-12, "Discrete FIR: reset volta os estados iniciais");
    }
    {
        Harness h;
        const uint32_t u = discreteConstant(h, "1");
        const uint32_t enable = discreteStep(h, "0.2");
        const uint32_t fir = h.add("discrete_fir_filter", {{"ShowEnablePort", on()}});
        h.wire(u, "out1", fir, "in1");
        h.wire(enable, "out1", fir, "enable");
        expectSequence(samples(h, fir, 4), {0, 0, 0.5, 1.0}, 1e-12, "Discrete FIR: 0 antes de habilitar, estados congelados");
    }
}

void discreteStateSpaceAndZeroPole() {
    {
        Harness h;
        const uint32_t u = discreteConstant(h, "1");
        const uint32_t ss = h.add("discrete_state_space", {{"A", text("0.5")}, {"B", text("1")}, {"C", text("1")}, {"D", text("0")}});
        h.wire(u, "out1", ss, "in1");
        expectSequence(samples(h, ss, 3), {0.0, 1.0, 1.5}, 1e-12, "Discrete State-Space: x(n+1) = 0.5x + u, Sample time herdado (-1)");
    }
    {
        // (z-1)/(z(z-0.5)): y(k) = 0.5 y(k-1) + u(k-1) - u(k-2).
        Harness h;
        const uint32_t u = discreteConstant(h, "1");
        const uint32_t zp = h.add("discrete_zero_pole");
        h.wire(u, "out1", zp, "in1");
        expectSequence(samples(h, zp, 4), {0.0, 1.0, 0.5, 0.25}, 1e-12, "Discrete Zero-Pole padrao (z-1)/(z(z-0.5))");
    }
    {
        // Fixed-Point State-Space: as equacoes documentadas (double), x(n+1) = Ax + Bu, y = Cx + Du.
        Harness h;
        const uint32_t u = discreteConstant(h, "1");
        const uint32_t fp = h.add("fixed_point_state_space");
        h.wire(u, "out1", fp, "in1");
        const double A[3][3] = {{2.6020, -2.2793, 0.6708}, {1, 0, 0}, {0, 1, 0}};
        const double C[3] = {0.0184, 0.0024, 0.0055};
        std::array<double, 3> x{0, 0, 0};
        std::vector<double> expected;
        for (int k = 0; k < 5; ++k) {
            expected.push_back(C[0] * x[0] + C[1] * x[1] + C[2] * x[2] + 0.0033);
            std::array<double, 3> next{};
            for (int r = 0; r < 3; ++r) next[r] = A[r][0] * x[0] + A[r][1] * x[1] + A[r][2] * x[2] + (r == 0 ? 1.0 : 0.0);
            x = next;
        }
        expectSequence(samples(h, fp, 5), expected, 1e-12, "Fixed-Point State-Space: equacoes de estado em double");
    }
}

void firstOrderSections() {
    const auto run = [](const char* block, std::initializer_list<std::pair<const char*, PropertyValue>> props, bool ramp, int count) {
        Harness h;
        const uint32_t u = ramp ? discreteRamp(h) : discreteConstant(h, "1");
        const uint32_t b = h.add(block, props);
        h.wire(u, "out1", b, "in1");
        return samples(h, b, count);
    };
    expectSequence(run("transfer_fcn_first_order", {}, false, 3), {0.05, 1.0 - 0.95 * 0.95, 1.0 - 0.95 * 0.95 * 0.95}, 1e-12,
                   "Transfer Fcn First Order: (1-p) z/(z-p), ganho DC unitario");
    expectSequence(run("transfer_fcn_first_order", {{"ICPrevOutput", text("1")}}, false, 2), {1.0, 1.0}, 1e-12, "Transfer Fcn First Order: IC da saida anterior");
    expectSequence(run("transfer_fcn_lead_or_lag", {}, false, 3), {1.0, 1.2, 1.39}, 1e-12, "Transfer Fcn Lead or Lag: (z-0.75)/(z-0.95)");
    expectSequence(run("transfer_fcn_lead_or_lag", {{"ICPrevInput", text("1")}, {"ICPrevOutput", text("5")}}, false, 2), {5.0, 5.0}, 1e-12,
                   "Transfer Fcn Lead or Lag: regime (1-z0)/(1-p) com ICs consistentes");
    expectSequence(run("transfer_fcn_real_zero", {}, false, 3), {1.0, 0.25, 0.25}, 1e-12, "Transfer Fcn Real Zero: (z-0.75)/z");
    expectSequence(run("difference", {}, true, 3), {0.0, 0.1, 0.1}, 1e-12, "Difference: u(k) - u(k-1)");
    expectSequence(run("difference", {{"ICPrevInput", text("1")}}, true, 2), {-1.0, 0.1}, 1e-12, "Difference: IC da entrada anterior");
    expectSequence(run("discrete_derivative", {}, true, 3), {0.0, 1.0, 1.0}, 1e-12, "Discrete Derivative: K (u(k) - u(k-1))/Ts");
    expectSequence(run("discrete_derivative", {{"gainval", text("2")}, {"ICPrevScaledInput", text("3")}}, true, 2), {-3.0, 2.0}, 1e-12,
                   "Discrete Derivative: y(0) = K u(0)/Ts - IC");
    check(fails([] { Harness h; const uint32_t u = h.add("sine_wave"); const uint32_t d = h.add("difference");
                     h.wire(u, "out1", d, "in1"); h.runUntil(0.1); }), "Difference: entrada continua recusada");
}

void tappedDelayAndHolds() {
    const auto run = [](std::initializer_list<std::pair<const char*, PropertyValue>> props, uint16_t width) {
        Harness h;
        const uint32_t u = discreteRamp(h);
        const uint32_t taps = h.add("tapped_delay", props);
        h.wire(u, "out1", taps, "in1");
        h.runUntil(after(5));
        std::vector<double> values;
        for (uint16_t i = 0; i < width; ++i) values.push_back(h.value(taps, "out1", i));
        return values;
    };
    expectSequence(run({}, 4), {0.1, 0.2, 0.3, 0.4}, 1e-12, "Tapped Delay Oldest: [u(k-4) .. u(k-1)]");
    expectSequence(run({{"DelayOrder", text("Newest")}}, 4), {0.4, 0.3, 0.2, 0.1}, 1e-12, "Tapped Delay Newest");
    expectSequence(run({{"includeCurrent", on()}}, 5), {0.1, 0.2, 0.3, 0.4, 0.5}, 1e-12, "Tapped Delay com a entrada atual");
    expectSequence(run({{"vinit", text("9")}, {"NumDelays", text("8")}}, 3), {9, 9, 9}, 1e-12, "Tapped Delay: condicao inicial nas posicoes ainda vazias");
    check(fails([] { Harness h; const uint32_t u = discreteRamp(h); const uint32_t t = h.add("tapped_delay", {{"NumDelays", text("-1")}});
                     h.wire(u, "out1", t, "in1"); h.runUntil(0.1); }), "Tapped Delay: NumDelays = -1 recusado");
    {
        Harness h;
        const uint32_t u = discreteRamp(h);
        const uint32_t hold = discreteStep(h, "0.3");
        const uint32_t block = h.add("conditional_hold", {{"InitialCondition", text("8")}});
        h.wire(u, "out1", block, "in1");
        h.wire(hold, "out1", block, "h");
        expectSequence(samples(h, block, 6), {0.0, 0.1, 0.2, 0.2, 0.2, 0.2}, 1e-12, "Conditional Hold: passa com h falso, segura com h verdadeiro");
    }
    {
        Harness h;
        const uint32_t u = discreteRamp(h);
        const uint32_t hold = discreteConstant(h, "1");
        const uint32_t block = h.add("conditional_hold", {{"InitialCondition", text("8")}});
        h.wire(u, "out1", block, "in1");
        h.wire(hold, "out1", block, "h");
        expectSequence(samples(h, block, 3), {8, 8, 8}, 1e-12, "Conditional Hold: IC quando h verdadeiro desde o inicio");
    }
}

void directFormII() {
    // y(k) = 0.9 y(k-1) - 0.6 y(k-2) + 0.2 u(k) + 0.3 u(k-1) + 0.2 u(k-2), degrau.
    std::vector<double> expected;
    {
        double y1 = 0, y2 = 0;
        for (int k = 0; k < 5; ++k) {
            const double u0 = 1, u1 = k >= 1 ? 1 : 0, u2 = k >= 2 ? 1 : 0;
            const double y = 0.9 * y1 - 0.6 * y2 + 0.2 * u0 + 0.3 * u1 + 0.2 * u2;
            expected.push_back(y);
            y2 = y1;
            y1 = y;
        }
    }
    {
        Harness h;
        const uint32_t u = discreteConstant(h, "1");
        const uint32_t tf = h.add("transfer_fcn_direct_form_ii");
        h.wire(u, "out1", tf, "in1");
        expectSequence(samples(h, tf, 5), expected, 1e-12, "Transfer Fcn Direct Form II: equacao de diferencas");
    }
    {
        Harness h;
        const uint32_t u = discreteConstant(h, "1");
        const uint32_t num = discreteConstant(h, "[0.2 0.3 0.2]");
        const uint32_t den = discreteConstant(h, "[-0.9 0.6]");
        const uint32_t tf = h.add("transfer_fcn_direct_form_ii_time_varying");
        h.wire(u, "out1", tf, "in1");
        h.wire(num, "out1", tf, "num");
        h.wire(den, "out1", tf, "den");
        expectSequence(samples(h, tf, 5), expected, 1e-12, "Transfer Fcn Direct Form II Time Varying: coeficientes pelas portas");
    }
    {
        // Coeficiente variando no tempo: denominador sem o lider = -0.5 ate k = 2 e 0 depois (FIR puro).
        Harness h;
        const uint32_t u = discreteConstant(h, "1");
        const uint32_t num = discreteConstant(h, "[1 0]");
        const uint32_t den = discreteStep(h, "0.3", "-0.5", "0");
        const uint32_t tf = h.add("transfer_fcn_direct_form_ii_time_varying");
        h.wire(u, "out1", tf, "in1");
        h.wire(num, "out1", tf, "num");
        h.wire(den, "out1", tf, "den");
        // w(k) = u(k) - a1(k) w(k-1); y = w(k): 1, 1.5, 1.75, 1, 1.
        expectSequence(samples(h, tf, 5), {1.0, 1.5, 1.75, 1.0, 1.0}, 1e-12, "Direct Form II Time Varying: coeficientes lidos a cada passo");
    }
}

} // namespace

int main() {
    const std::pair<const char*, void (*)()> cases[] = {
        {"integratorBlock", integratorBlock},
        {"secondOrderIntegratorBlock", secondOrderIntegratorBlock},
        {"stateSpaceBlocks", stateSpaceBlocks},
        {"transferFunctionBlocks", transferFunctionBlocks},
        {"derivativeAndDelays", derivativeAndDelays},
        {"firstOrderHoldBlock", firstOrderHoldBlock},
        {"propagationDelayBlock", propagationDelayBlock},
        {"unitDelayAndMemory", unitDelayAndMemory},
        {"delayBlock", delayBlock},
        {"discreteTimeIntegratorBlock", discreteTimeIntegratorBlock},
        {"discreteTransferFunctionAndFilters", discreteTransferFunctionAndFilters},
        {"discreteStateSpaceAndZeroPole", discreteStateSpaceAndZeroPole},
        {"firstOrderSections", firstOrderSections},
        {"tappedDelayAndHolds", tappedDelayAndHolds},
        {"directFormII", directFormII},
    };
    for (const auto& [name, test] : cases) {
        try { test(); } catch (const std::exception& error) { check(false, std::string(name) + " lancou: " + error.what()); }
    }
    return finish("library_continuous_discrete");
}
