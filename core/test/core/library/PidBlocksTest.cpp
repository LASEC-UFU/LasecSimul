// Blocos `sl.*` -- PID Controller, PID Controller (2DOF) e variantes discretas (docs/66). Referencias analiticas ou definicoes documentadas pela
// MathWorks; nunca o proprio engine como referencia.
//
// Referencias usadas (paginas pidcontroller/pidcontroller2dof/discretepidcontroller da MathWorks):
//  - continuo paralelo: C(s) = P + I/s + D*N*s/(s + N); ideal: P*(1 + I/s + D*N*s/(s + N));
//    resposta a degrau unitario do termo D: D*N*exp(-N t) (filtro com estado inicial 0);
//  - discreto: alpha(z)/beta(z) = Ts/(z-1) (Forward Euler), Ts*z/(z-1) (Backward Euler),
//    (Ts/2)(z+1)/(z-1) (Trapezoidal); termo D = D*N/(1 + N*beta(z)), resposta ao degrau
//    D*N/(1+a)*((1-a)/(1+a))^k com a = c*N*Ts (c = 0, 1, 1/2); sem filtro D*(z-1)/(z*Ts);
//  - integrador discreto (Discrete-Time Integrator, Auto): y(n) = x(n) + c*Ts*u(n),
//    x(n+1) = y(n) + (1-c)*Ts*u(n); Output: y(0) = IC;
//  - 2DOF: u = P(b r - y) + I/s (r - y) + D*N*s/(s+N) (c r - y);
//  - back-calculation: entrada do integrador + Kb*(ysat - y); tracking: + Kt*(TR - ysat);
//    clamping: integracao para quando a soma excede os limites e tem o sinal da entrada do integrador.
#include <cmath>
#include <vector>

#include "library/LibraryTestHarness.hpp"

using namespace library_test;

namespace {

PropertyValue on() { return PropertyValue{true}; }

/** Valor do bloco discreto na amostra k (leitura no meio do intervalo, como no Simulink com ZOH). */
double sample(Harness& h, uint32_t block, int k, double ts, const char* port = "out1", uint16_t element = 0) {
    h.runUntil(ts * k + ts / 2);
    return h.value(block, port, element);
}

// ---- Tempo continuo ---------------------------------------------------------------------------------

void continuousForms() {
    Harness h;
    const uint32_t one = h.add("constant", {{"Value", text("1")}});
    const auto pid = [&](std::initializer_list<std::pair<const char*, PropertyValue>> extra) {
        ComponentParams params;
        params.properties = {{"P", text("2")}, {"I", text("3")}, {"D", text("0.5")}, {"N", text("10")}};
        for (const auto& [name, value] : extra) params.properties[name] = value;
        const uint32_t block = h.session.addComponent("sl.pid_controller", params);
        h.wire(one, "out1", block, "in1");
        return block;
    };
    const uint32_t parallel = pid({});
    const uint32_t ideal = pid({{"Form", text("Ideal")}});
    const uint32_t pi = pid({{"Controller", text("PI")}});
    const uint32_t pd = pid({{"Controller", text("PD")}});
    const uint32_t p = pid({{"Controller", text("P")}});
    const uint32_t iOnly = pid({{"Controller", text("I")}, {"Form", text("Ideal")}});
    const uint32_t idealPi = pid({{"Controller", text("PI")}, {"Form", text("Ideal")}});
    const uint32_t ics = pid({{"InitialConditionForIntegrator", text("0.5")}, {"InitialConditionForFilter", text("0.2")}});
    const uint32_t defaults = h.add("pid_controller");
    h.wire(one, "out1", defaults, "in1");
    // Bloco a jusante com tempo herdado: o PID Controller e de tempo continuo mesmo com entrada constante.
    const uint32_t downstream = h.add("gain", {{"Gain", text("2")}});
    h.wire(defaults, "out1", downstream, "in1");
    for (double t : {0.3, 1.0}) {
        h.runUntil(t);
        const double decay = std::exp(-10.0 * t);
        const std::string at = " t=" + std::to_string(t);
        expectNear(h.value(parallel), 2.0 + 3.0 * t + 5.0 * decay, 1e-6, "paralelo P + I/s + D*N*s/(s+N): 2 + 3t + 5e^-10t" + at);
        expectNear(h.value(ideal), 2.0 + 6.0 * t + 10.0 * decay, 1e-6, "ideal P*(1 + I/s + D*N*s/(s+N))" + at);
        expectNear(h.value(pi), 2.0 + 3.0 * t, 1e-6, "PI paralelo" + at);
        expectNear(h.value(pd), 2.0 + 5.0 * decay, 1e-6, "PD paralelo" + at);
        expectNear(h.value(p), 2.0, 1e-12, "P" + at);
        expectNear(h.value(iOnly), 3.0 * t, 1e-6, "I (a forma nao se aplica sem P)" + at);
        expectNear(h.value(idealPi), 2.0 + 6.0 * t, 1e-6, "PI ideal" + at);
        expectNear(h.value(ics), 2.5 + 3.0 * t + 3.0 * decay, 1e-6, "condicoes iniciais integrador 0.5 e filtro 0.2" + at);
        expectNear(h.value(defaults), 1.0 + t, 1e-6, "padroes (P=1, I=1, D=0): 1 + t" + at);
        expectNear(h.value(downstream), 2.0 * (1.0 + t), 1e-6, "Gain a jusante herda tempo continuo do PID Controller" + at);
    }
}

void continuousVector() {
    Harness h;
    const uint32_t u = h.add("constant", {{"Value", text("[1 2]")}});
    const uint32_t pid = h.add("pid_controller", {{"Controller", text("PI")}, {"P", text("[1 3]")}, {"I", text("[0.5 1]")}});
    h.wire(u, "out1", pid, "in1");
    h.runUntil(0.8);
    expectNear(h.value(pid, "out1", 0), 1.0 + 0.5 * 0.8, 1e-6, "vetor: elemento 1 = 1 + 0.5t");
    expectNear(h.value(pid, "out1", 1), 6.0 + 2.0 * 0.8, 1e-6, "vetor: elemento 2 = 6 + 2t");
    const uint32_t scalarGains = h.add("pid_controller", {{"Controller", text("P")}, {"P", text("[2 4 8]")}});
    const uint32_t one = h.add("constant", {{"Value", text("1")}});
    h.wire(one, "out1", scalarGains, "in1");
    h.runUntil(0.9);
    expectNear(h.value(scalarGains, "out1", 2), 8.0, 1e-12, "entrada escalar expande para a largura dos ganhos");
}

void continuousClosedLoop() {
    // r = 1 -> e = r - y -> PI (P = 2, I = 1) -> 1/(s+1) -> y; T(s) = (2s+1)/(s^2+3s+1).
    Harness h;
    const uint32_t r = h.add("constant", {{"Value", text("1")}});
    const uint32_t e = h.add("sum", {{"Inputs", text("|+-")}});
    const uint32_t pid = h.add("pid_controller", {{"Controller", text("PI")}, {"P", text("2")}, {"I", text("1")}});
    const uint32_t plant = h.add("transfer_fcn");
    h.wire(r, "out1", e, "in1");
    h.wire(plant, "out1", e, "in2");
    h.wire(e, "out1", pid, "in1");
    h.wire(pid, "out1", plant, "in1");
    h.runUntil(5.0);
    const double p1 = (-3.0 + std::sqrt(5.0)) / 2.0, p2 = (-3.0 - std::sqrt(5.0)) / 2.0;
    const double r1 = (2.0 * p1 + 1.0) / (p1 * (p1 - p2)), r2 = (2.0 * p2 + 1.0) / (p2 * (p2 - p1));
    expectNear(h.value(plant), 1.0 + r1 * std::exp(p1 * 5.0) + r2 * std::exp(p2 * 5.0), 1e-6, "malha fechada PI + 1/(s+1): y(5) analitico");
}

void continuousAntiWindup() {
    // I = 1, u = +1 ate t = 2 e -1 depois, saida limitada em 0.5.
    Harness h;
    const auto make = [&](const char* mode) {
        const uint32_t u = h.add("step", {{"Time", text("2")}, {"InitialValue", text("1")}, {"FinalValue", text("-1")}});
        const uint32_t pid = h.add("pid_controller", {{"Controller", text("I")}, {"LimitOutput", on()}, {"UpperSaturationLimit", text("0.5")},
                                                      {"LowerSaturationLimit", text("-10")}, {"AntiWindupMode", text(mode)}, {"Kb", text("2")}});
        h.wire(u, "out1", pid, "in1");
        return pid;
    };
    const uint32_t none = make("none");
    const uint32_t back = make("back-calculation");
    const uint32_t clamp = make("clamping");
    h.runUntil(1.0);
    expectNear(h.value(back), 0.5, 1e-12, "back-calculation: saida saturada em 0.5");
    // back-calculation: x' = 1 + Kb*(0.5 - x) apos x = 0.5 (t = 0.5) -> x(2) = 1 - 0.5 e^-3; depois
    // x' = -1 + 2(0.5 - x) = -2x ate x = 0.5 (t1) e entao x' = -1.
    const double x2 = 1.0 - 0.5 * std::exp(-3.0);
    const double t1 = 2.0 + 0.5 * std::log(2.0 * x2);
    h.runUntil(2.25);
    expectNear(h.value(clamp), 0.25, 3e-4, "clamping: integracao retoma imediatamente apos a inversao (y(2.25) = 0.25)");
    h.runUntil(3.0);
    expectNear(h.value(back), 0.5 - (3.0 - t1), 1e-4, "back-calculation: desenrola com constante 1/Kb (y(3) analitico)");
    expectNear(h.value(none), 0.5, 1e-12, "sem anti-windup: integrador em windup ainda saturado em t = 3");
    h.runUntil(4.0);
    expectNear(h.value(none), 0.0, 1e-6, "sem anti-windup: x = 2 - (t - 2) -> y(4) = 0");
}

void continuousTrackingResetAndLimits() {
    Harness h;
    const uint32_t zero = h.add("constant", {{"Value", text("0")}});
    const uint32_t three = h.add("constant", {{"Value", text("3")}});
    const uint32_t one = h.add("constant", {{"Value", text("1")}});
    const uint32_t two = h.add("constant", {{"Value", text("2")}});
    const uint32_t tracking = h.add("pid_controller", {{"Controller", text("I")}, {"TrackingMode", on()}, {"Kt", text("2")}});
    h.wire(zero, "out1", tracking, "in1");
    h.wire(three, "out1", tracking, "tr");
    const auto withReset = [&](const char* mode, const char* initial, const char* final) {
        const uint32_t pulse = h.add("step", {{"Time", text("1")}, {"InitialValue", text(initial)}, {"FinalValue", text(final)}});
        const uint32_t pid = h.add("pid_controller", {{"Controller", text("I")}, {"ExternalReset", text(mode)}});
        h.wire(one, "out1", pid, "in1");
        h.wire(pulse, "out1", pid, "reset");
        return pid;
    };
    const uint32_t rising = withReset("rising", "0", "1");
    const uint32_t falling = withReset("falling", "1", "0");
    const uint32_t either = withReset("either", "1", "0");
    const uint32_t level = withReset("level", "0", "1");
    const uint32_t external = h.add("pid_controller", {{"Controller", text("I")}, {"InitialConditionSource", text("external")}, {"ExternalReset", text("rising")}});
    const uint32_t externalPulse = h.add("step", {{"Time", text("1")}});
    h.wire(one, "out1", external, "in1");
    h.wire(externalPulse, "out1", external, "reset");
    h.wire(two, "out1", external, "i0");
    const uint32_t limited = h.add("pid_controller", {{"Controller", text("PI")}, {"P", text("0.25")}, {"LimitIntegratorOutput", on()},
                                                      {"UpperIntegratorSaturationLimit", text("0.4")}});
    h.wire(one, "out1", limited, "in1");
    h.runUntil(0.5);
    expectNear(h.value(tracking), 3.0 * (1.0 - std::exp(-1.0)), 1e-6, "tracking: x' = Kt*(TR - y) -> 3(1 - e^-2t), t = 0.5");
    expectNear(h.value(external), 2.5, 1e-6, "IC externa I0 = 2: y(0.5) = 2.5");
    expectNear(h.value(level), 0.5, 1e-6, "level: sem reset enquanto o sinal e 0");
    h.runUntil(1.5);
    expectNear(h.value(rising), 0.5, 1e-6, "reset rising em t = 1: y(1.5) = 0.5");
    expectNear(h.value(falling), 0.5, 1e-6, "reset falling em t = 1: y(1.5) = 0.5");
    expectNear(h.value(either), 0.5, 1e-6, "reset either em t = 1: y(1.5) = 0.5");
    expectNear(h.value(level), 0.0, 1e-9, "reset level: saida presa na condicao inicial enquanto o sinal e nao nulo");
    expectNear(h.value(external), 2.5, 1e-6, "reset volta a I0 = 2: y(1.5) = 2.5");
    expectNear(h.value(limited), 0.25 + 0.4, 1e-9, "limite do integrador em 0.4: y = P*u + 0.4");
}

void continuousExternalGainsAndTwoDof() {
    Harness h;
    const auto constant = [&](const char* value) { return h.add("constant", {{"Value", text(value)}}); };
    const uint32_t one = constant("1"), r = constant("1"), ym = constant("0.4");
    const uint32_t gP = constant("2"), gI = constant("3"), gD = constant("0.5"), gN = constant("10"), gB = constant("0.5"), gC = constant("0");
    const uint32_t external = h.add("pid_controller", {{"ControllerParametersSource", text("external")}});
    h.wire(one, "out1", external, "in1");
    h.wire(gP, "out1", external, "p");
    h.wire(gI, "out1", external, "i");
    h.wire(gD, "out1", external, "d");
    h.wire(gN, "out1", external, "n");
    const auto twoDof = [&](const char* form, bool externalGains) {
        const uint32_t block = externalGains
            ? h.add("pid_controller_2dof", {{"ControllerParametersSource", text("external")}, {"Form", text(form)}})
            : h.add("pid_controller_2dof", {{"P", text("2")}, {"I", text("3")}, {"D", text("0.5")}, {"N", text("10")}, {"b", text("0.5")},
                                            {"c", text("0")}, {"Form", text(form)}});
        h.wire(r, "out1", block, "in1");
        h.wire(ym, "out1", block, "in2");
        if (externalGains) {
            h.wire(gP, "out1", block, "p");
            h.wire(gI, "out1", block, "i");
            h.wire(gD, "out1", block, "d");
            h.wire(gN, "out1", block, "n");
            h.wire(gB, "out1", block, "b");
            h.wire(gC, "out1", block, "c");
        }
        return block;
    };
    const uint32_t parallel = twoDof("Parallel", false);
    const uint32_t ideal = twoDof("Ideal", false);
    const uint32_t externalTwoDof = twoDof("Parallel", true);
    for (double t : {0.2, 0.7}) {
        h.runUntil(t);
        const double decay = std::exp(-10.0 * t);
        const std::string at = " t=" + std::to_string(t);
        expectNear(h.value(external), 2.0 + 3.0 * t + 5.0 * decay, 1e-6, "ganhos externos P, I, D, N pelas portas" + at);
        // eP = b r - y = 0.1, eI = r - y = 0.6, eD = c r - y = -0.4.
        expectNear(h.value(parallel), 0.2 + 1.8 * t - 2.0 * decay, 1e-6, "2DOF paralelo: P(b r - y) + I/s (r - y) + D N s/(s+N) (c r - y)" + at);
        expectNear(h.value(ideal), 0.2 + 3.6 * t - 4.0 * decay, 1e-6, "2DOF ideal: P*[...]" + at);
        expectNear(h.value(externalTwoDof), 0.2 + 1.8 * t - 2.0 * decay, 1e-6, "2DOF com P, I, D, N, b, c externos" + at);
    }
}

// ---- Tempo discreto ---------------------------------------------------------------------------------

void discreteIntegratorMethods() {
    Harness h;
    const uint32_t one = h.add("constant", {{"Value", text("1")}});
    const auto make = [&](const char* method, const char* gain, bool useKiTs, const char* setting = "Auto") {
        ComponentParams params;
        params.properties = {{"Controller", text("I")}, {"I", text(gain)}, {"SampleTime", text("0.1")}, {"IntegratorMethod", text(method)},
                             {"InitialConditionSetting", text(setting)}, {"InitialConditionForIntegrator", text("0")}};
        if (useKiTs) params.properties["UseKiTs"] = on();
        const uint32_t block = h.session.addComponent("sl.discrete_pid_controller", params);
        h.wire(one, "out1", block, "in1");
        return block;
    };
    const uint32_t fe = make("Forward Euler", "2", false), be = make("Backward Euler", "2", false), tr = make("Trapezoidal", "2", false);
    const uint32_t feKiTs = make("Forward Euler", "0.2", true), trKiTs = make("Trapezoidal", "0.2", true);
    const uint32_t beOutput = h.add("discrete_pid_controller", {{"Controller", text("I")}, {"I", text("1")}, {"SampleTime", text("0.1")},
                                                                {"IntegratorMethod", text("Backward Euler")}, {"InitialConditionSetting", text("Output")},
                                                                {"InitialConditionForIntegrator", text("0.5")}});
    const uint32_t trOutput = h.add("discrete_pid_controller", {{"Controller", text("I")}, {"I", text("1")}, {"SampleTime", text("0.1")},
                                                                {"IntegratorMethod", text("Trapezoidal")}, {"InitialConditionSetting", text("Output")},
                                                                {"InitialConditionForIntegrator", text("0.5")}});
    const uint32_t beAuto = h.add("discrete_pid_controller", {{"Controller", text("I")}, {"I", text("1")}, {"SampleTime", text("0.1")},
                                                              {"IntegratorMethod", text("Backward Euler")}, {"InitialConditionForIntegrator", text("0.5")}});
    h.wire(one, "out1", beOutput, "in1");
    h.wire(one, "out1", trOutput, "in1");
    h.wire(one, "out1", beAuto, "in1");
    for (int k = 0; k < 5; ++k) {
        const std::string at = " k=" + std::to_string(k);
        expectNear(sample(h, fe, k, 0.1), 0.2 * k, 1e-12, "Forward Euler: I*Ts/(z-1) -> 0.2k" + at);
        expectNear(h.value(be), 0.2 * (k + 1), 1e-12, "Backward Euler: I*Ts*z/(z-1) -> 0.2(k+1)" + at);
        expectNear(h.value(tr), 0.2 * (k + 0.5), 1e-12, "Trapezoidal: I*Ts/2 (z+1)/(z-1) -> 0.2(k+1/2)" + at);
        expectNear(h.value(feKiTs), 0.2 * k, 1e-12, "Use I*Ts (I*Ts = 0.2) = Forward Euler com I = 2" + at);
        expectNear(h.value(trKiTs), 0.2 * (k + 0.5), 1e-12, "Use I*Ts com Trapezoidal" + at);
        expectNear(h.value(beOutput), 0.5 + 0.1 * k, 1e-12, "Backward Euler, IC na saida: y(0) = IC, x(1) = y(0)" + at);
        expectNear(h.value(trOutput), 0.5 + 0.1 * k, 1e-12, "Trapezoidal, IC na saida: y(0) = IC, x(1) = y(0) + Ts/2 u(0)" + at);
        expectNear(h.value(beAuto), 0.5 + 0.1 * (k + 1), 1e-12, "Backward Euler, IC no estado (Auto): y(0) = IC + Ts*u(0)" + at);
    }
}

void discreteFilterMethods() {
    Harness h;
    const uint32_t one = h.add("constant", {{"Value", text("1")}});
    const auto make = [&](const char* method) {
        const uint32_t block = h.add("discrete_pid_controller", {{"Controller", text("PD")}, {"P", text("0")}, {"D", text("0.5")}, {"N", text("4")},
                                                                 {"SampleTime", text("0.1")}, {"FilterMethod", text(method)}});
        h.wire(one, "out1", block, "in1");
        return block;
    };
    const uint32_t fe = make("Forward Euler"), be = make("Backward Euler"), tr = make("Trapezoidal");
    // Resposta ao degrau de D*N/(1 + N*beta(z)) com D*N = 2, N*Ts = 0.4.
    for (int k = 0; k < 6; ++k) {
        const std::string at = " k=" + std::to_string(k);
        expectNear(sample(h, fe, k, 0.1), 2.0 * std::pow(0.6, k), 1e-12, "filtro Forward Euler: polo 1 - N*Ts = 0.6" + at);
        expectNear(h.value(be), 2.0 / 1.4 * std::pow(1.0 / 1.4, k), 1e-12, "filtro Backward Euler: polo 1/(1 + N*Ts)" + at);
        expectNear(h.value(tr), 2.0 / 1.2 * std::pow(0.8 / 1.2, k), 1e-12, "filtro Trapezoidal: polo (1 - N*Ts/2)/(1 + N*Ts/2)" + at);
    }
}

void discreteUnfilteredAndIdeal() {
    Harness h;
    const uint32_t step = h.add("step", {{"Time", text("0.2")}, {"SampleTime", text("0.1")}});
    const uint32_t one = h.add("constant", {{"Value", text("1")}});
    const uint32_t raw = h.add("discrete_pid_controller", {{"Controller", text("PD")}, {"P", text("0")}, {"D", text("0.5")}, {"UseFilter", PropertyValue{false}},
                                                           {"SampleTime", text("0.1")}});
    h.wire(step, "out1", raw, "in1");
    const uint32_t rawIc = h.add("discrete_pid_controller", {{"Controller", text("PD")}, {"P", text("0")}, {"D", text("0.5")}, {"UseFilter", PropertyValue{false}},
                                                             {"SampleTime", text("0.1")}, {"DifferentiatorICPrevScaledInput", text("5")}});
    h.wire(one, "out1", rawIc, "in1");
    const uint32_t ideal = h.add("discrete_pid_controller", {{"P", text("2")}, {"I", text("3")}, {"D", text("0.5")}, {"N", text("4")}, {"Form", text("Ideal")},
                                                             {"SampleTime", text("0.1")}});
    h.wire(one, "out1", ideal, "in1");
    const double expectedRaw[] = {0.0, 0.0, 5.0, 0.0, 0.0};
    for (int k = 0; k < 5; ++k) {
        const std::string at = " k=" + std::to_string(k);
        expectNear(sample(h, raw, k, 0.1), expectedRaw[k], 1e-12, "sem filtro: D*(z-1)/(z*Ts) sobre degrau em k=2" + at);
        expectNear(h.value(rawIc), 0.0, 1e-12, "diferenciador com entrada escalada anterior D*u/Ts = 5" + at);
        expectNear(h.value(ideal), 2.0 + 0.6 * k + 4.0 * std::pow(0.6, k), 1e-12, "ideal discreto P*(1 + I*Ts/(z-1) + D*N/(1+N*Ts/(z-1)))" + at);
    }
}

void discreteAntiWindupTrackingReset() {
    Harness h;
    const uint32_t one = h.add("constant", {{"Value", text("1")}});
    const uint32_t zero = h.add("constant", {{"Value", text("0")}});
    const uint32_t three = h.add("constant", {{"Value", text("3")}});
    const auto make = [&](const char* method, const char* mode) {
        const uint32_t block = h.add("discrete_pid_controller", {{"Controller", text("I")}, {"SampleTime", text("0.1")}, {"IntegratorMethod", text(method)},
                                                                 {"LimitOutput", on()}, {"UpperSaturationLimit", text("0.25")}, {"AntiWindupMode", text(mode)},
                                                                 {"Kb", text("2")}});
        h.wire(one, "out1", block, "in1");
        return block;
    };
    const uint32_t feBack = make("Forward Euler", "back-calculation"), beBack = make("Backward Euler", "back-calculation");
    const uint32_t feClamp = make("Forward Euler", "clamping"), beClamp = make("Backward Euler", "clamping");
    const uint32_t tracking = h.add("discrete_pid_controller", {{"Controller", text("I")}, {"SampleTime", text("0.1")}, {"TrackingMode", on()}, {"Kt", text("2")}});
    h.wire(zero, "out1", tracking, "in1");
    h.wire(three, "out1", tracking, "tr");
    const auto withReset = [&](const char* mode) {
        const uint32_t pulse = h.add("step", {{"Time", text("0.3")}, {"SampleTime", text("0.1")}});
        const uint32_t block = h.add("discrete_pid_controller", {{"Controller", text("I")}, {"SampleTime", text("0.1")}, {"ExternalReset", text(mode)}});
        h.wire(one, "out1", block, "in1");
        h.wire(pulse, "out1", block, "reset");
        return block;
    };
    const uint32_t rising = withReset("rising"), level = withReset("level");
    // Referencias pelas equacoes documentadas (Discrete-Time Integrator + realimentacoes).
    double xFeBack = 0.0, xBeBack = 0.0, xFeClamp = 0.0, xBeClamp = 0.0, xTrack = 0.0;
    const double ts = 0.1, up = 0.25, kb = 2.0;
    for (int k = 0; k < 10; ++k) {
        const std::string at = " k=" + std::to_string(k);
        // FE back-calculation: y = sat(x); v = 1 + Kb*(y - x); x+ = x + Ts*v.
        const double yFe = std::min(xFeBack, up);
        // BE back-calculation: Y = x + Ts*v(Y), v = 1 + Kb*(sat(Y) - Y) (laco algebrico, solucao exata).
        double yBe = xBeBack + ts;
        if (yBe > up) yBe = (xBeBack + ts + ts * kb * up) / (1.0 + ts * kb);
        // Clamping FE: integra 0 enquanto a soma excede o limite com o mesmo sinal da entrada.
        const double yFeClamp = std::min(xFeClamp, up);
        const bool clampFe = xFeClamp > up;
        // Clamping BE: soma com a entrada atual; se excede, a entrada do integrador e zerada.
        const double candidate = xBeClamp + ts;
        const double yBeClampUnsat = candidate > up ? xBeClamp : candidate;
        expectNear(sample(h, feBack, k, ts), yFe, 1e-12, "back-calculation Forward Euler" + at);
        expectNear(h.value(beBack), std::min(yBe, up), 1e-12, "back-calculation Backward Euler (laco algebrico exato)" + at);
        expectNear(h.value(feClamp), yFeClamp, 1e-12, "clamping Forward Euler" + at);
        expectNear(h.value(beClamp), std::min(yBeClampUnsat, up), 1e-12, "clamping Backward Euler" + at);
        expectNear(h.value(tracking), xTrack, 1e-12, "tracking discreto: x+ = x + Ts*Kt*(TR - y)" + at);
        expectNear(h.value(rising), k < 3 ? 0.1 * k : 0.1 * (k - 3), 1e-12, "reset rising em k = 3" + at);
        expectNear(h.value(level), k < 3 ? 0.1 * k : 0.0, 1e-12, "reset level mantem a condicao inicial" + at);
        xFeBack += ts * (1.0 + kb * (yFe - xFeBack));
        xBeBack = yBe;
        xFeClamp += clampFe ? 0.0 : ts;
        xBeClamp = yBeClampUnsat;
        xTrack += ts * 2.0 * (3.0 - xTrack);
    }
}

void discreteTwoDofInheritanceAndExternalAntiWindup() {
    Harness h;
    const uint32_t r = h.add("constant", {{"Value", text("1")}});
    const uint32_t ym = h.add("constant", {{"Value", text("0.4")}});
    const uint32_t pid = h.add("discrete_pid_controller_2dof", {{"P", text("2")}, {"I", text("3")}, {"D", text("0.5")}, {"N", text("4")}, {"b", text("0.5")},
                                                                {"c", text("0")}, {"SampleTime", text("0.1")}});
    h.wire(r, "out1", pid, "in1");
    h.wire(ym, "out1", pid, "in2");
    // Tempo herdado (-1) de uma fonte discreta de 0.1 s.
    const uint32_t discreteOne = h.add("constant", {{"Value", text("1")}, {"SampleTime", text("0.1")}});
    const uint32_t inherited = h.add("discrete_pid_controller", {{"Controller", text("I")}, {"I", text("2")}});
    h.wire(discreteOne, "out1", inherited, "in1");
    // Anti-windup externo: integra extAW e publica preInt = I*u.
    const uint32_t half = h.add("constant", {{"Value", text("0.5")}});
    const uint32_t externalAw = h.add("discrete_pid_controller", {{"Controller", text("PI")}, {"SampleTime", text("0.1")}, {"LimitOutput", on()},
                                                                  {"AntiWindupMode", text("external")}, {"I", text("3")}});
    h.wire(r, "out1", externalAw, "in1");
    h.wire(half, "out1", externalAw, "extaw");
    // Tempo continuo escolhido no bloco discreto (TimeDomain) e discreto no bloco continuo.
    const uint32_t continuousInDiscrete = h.add("discrete_pid_controller", {{"TimeDomain", text("Continuous-time")}, {"Controller", text("PI")}});
    h.wire(r, "out1", continuousInDiscrete, "in1");
    const uint32_t discreteInContinuous = h.add("pid_controller", {{"TimeDomain", text("Discrete-time")}, {"SampleTime", text("0.1")}, {"Controller", text("I")}});
    h.wire(r, "out1", discreteInContinuous, "in1");
    const uint32_t withOffset = h.add("pid_controller", {{"TimeDomain", text("Discrete-time")}, {"SampleTime", text("[0.1 0.05]")}, {"Controller", text("I")}});
    h.wire(r, "out1", withOffset, "in1");
    for (int k = 0; k < 5; ++k) {
        const std::string at = " k=" + std::to_string(k);
        // eP = 0.1, eI = 0.6, eD = -0.4: 0.2 + I*Ts*0.6*k + D*N*eD*(1 - N*Ts)^k.
        expectNear(sample(h, pid, k, 0.1), 0.2 + 0.18 * k - 0.8 * std::pow(0.6, k), 1e-12, "2DOF discreto Forward Euler" + at);
        expectNear(h.value(inherited), 0.2 * k, 1e-12, "tempo de amostragem herdado de 0.1 s" + at);
        expectNear(h.value(externalAw), 1.0 + 0.05 * k, 1e-12, "anti-windup externo: integrador integra extAW = 0.5" + at);
        expectNear(h.value(externalAw, "preint"), 3.0, 1e-12, "preInt = I*u" + at);
        expectNear(h.value(discreteInContinuous), 0.1 * k, 1e-12, "PID Controller com Time domain discreto" + at);
        expectNear(h.value(withOffset), 0.1 * k, 1e-12, "Sample time [0.1 0.05]: acertos em 0.05 + 0.1k" + at);
        expectNear(h.value(continuousInDiscrete), 1.0 + (0.1 * k + 0.05), 1e-6, "Discrete PID Controller com Time domain continuo" + at);
    }
}

void discreteTransferFunctionWithSine() {
    // Entrada variavel: u(k) = sin(0.1 k). Referencia: C(z) = P + I*alpha(z) + D*N/(1 + N*beta(z)) com
    // alpha Backward Euler e beta Trapezoidal, como equacoes de diferencas de estado inicial nulo:
    //   w(k) = w(k-1) + I*Ts*u(k);  (1+a) d(k) - (1-a) d(k-1) = D*N*(u(k) - u(k-1)), a = N*Ts/2.
    Harness h;
    const uint32_t sine = h.add("sine_wave", {{"SampleTime", text("0.1")}});
    const uint32_t pid = h.add("discrete_pid_controller", {{"P", text("1.5")}, {"I", text("2")}, {"D", text("0.3")}, {"N", text("8")}, {"SampleTime", text("0.1")},
                                                           {"IntegratorMethod", text("Backward Euler")}, {"FilterMethod", text("Trapezoidal")}});
    const uint32_t idealFe = h.add("discrete_pid_controller", {{"P", text("1.5")}, {"I", text("2")}, {"D", text("0.3")}, {"N", text("8")}, {"SampleTime", text("0.1")},
                                                               {"Form", text("Ideal")}});
    h.wire(sine, "out1", pid, "in1");
    h.wire(sine, "out1", idealFe, "in1");
    const double ts = 0.1, a = 8.0 * ts / 2.0;
    double w = 0.0, d = 0.0, previousU = 0.0;
    double wIdeal = 0.0, fIdeal = 0.0; // FE: integral e filtro com a entrada P*u
    for (int k = 0; k < 25; ++k) {
        const double u = std::sin(ts * k);
        w += 2.0 * ts * u;
        d = ((1.0 - a) * d + 0.3 * 8.0 * (u - previousU)) / (1.0 + a);
        previousU = u;
        const double pu = 1.5 * u;
        const double dIdeal = 8.0 * (0.3 * pu - fIdeal);
        const double idealExpected = pu + wIdeal + dIdeal;
        expectNear(sample(h, pid, k, ts), 1.5 * u + w + d, 1e-12, "sin(0.1k) por P + I*Ts*z/(z-1) + D*N/(1 + N*Ts/2 (z+1)/(z-1)) k=" + std::to_string(k));
        expectNear(h.value(idealFe), idealExpected, 1e-12, "sin(0.1k) pela forma ideal Forward Euler k=" + std::to_string(k));
        wIdeal += ts * 2.0 * pu;
        fIdeal += ts * dIdeal;
    }
}

void limitsAndInitialConditionPorts() {
    Harness h;
    const auto constant = [&](const char* value, const char* ts = "inf") { return h.add("constant", {{"Value", text(value)}, {"SampleTime", text(ts)}}); };
    const uint32_t one = constant("1"), zero = constant("0"), three = constant("3");
    const uint32_t d0 = constant("0.2"), up = constant("1.5"), lo = constant("0");
    const uint32_t filterIc = h.add("pid_controller", {{"Controller", text("PD")}, {"P", text("0")}, {"D", text("0.5")}, {"N", text("10")},
                                                       {"InitialConditionSource", text("external")}});
    h.wire(one, "out1", filterIc, "in1");
    h.wire(d0, "out1", filterIc, "d0");
    const uint32_t externalLimits = h.add("pid_controller", {{"Controller", text("P")}, {"P", text("2")}, {"LimitOutput", on()}, {"SatLimitsSource", text("external")}});
    h.wire(one, "out1", externalLimits, "in1");
    h.wire(up, "out1", externalLimits, "up");
    h.wire(lo, "out1", externalLimits, "lo");
    const uint32_t intLimit = h.add("discrete_pid_controller", {{"Controller", text("I")}, {"SampleTime", text("0.1")}, {"LimitIntegratorOutput", on()},
                                                                {"UpperIntegratorSaturationLimit", text("0.25")}});
    h.wire(one, "out1", intLimit, "in1");
    const uint32_t beTracking = h.add("discrete_pid_controller", {{"Controller", text("I")}, {"SampleTime", text("0.1")}, {"IntegratorMethod", text("Backward Euler")},
                                                                  {"TrackingMode", on()}, {"Kt", text("2")}});
    h.wire(zero, "out1", beTracking, "in1");
    h.wire(three, "out1", beTracking, "tr");
    double xTrack = 0.0;
    for (int k = 0; k < 6; ++k) {
        const std::string at = " k=" + std::to_string(k);
        const double t = 0.1 * k + 0.05;
        const double yTrack = (xTrack + 0.1 * 2.0 * 3.0) / (1.0 + 0.1 * 2.0);
        expectNear(sample(h, intLimit, k, 0.1), std::min(0.1 * k, 0.25), 1e-12, "limite do integrador discreto em 0.25" + at);
        expectNear(h.value(beTracking), yTrack, 1e-12, "tracking Backward Euler: y = (x + Ts*Kt*TR)/(1 + Ts*Kt)" + at);
        expectNear(h.value(filterIc), 3.0 * std::exp(-10.0 * t), 1e-6, "IC do filtro pela porta D0 = 0.2: N(D - 0.2)e^-Nt" + at);
        expectNear(h.value(externalLimits), 1.5, 1e-12, "limites externos up/lo: P*u = 2 saturado em up = 1.5" + at);
        xTrack = yTrack;
    }
}

// ---- Erros --------------------------------------------------------------------------------------------

void errors() {
    const auto build = [](const char* block, std::initializer_list<std::pair<const char*, PropertyValue>> properties, const char* source = "constant") {
        return fails([&] {
            Harness h;
            const uint32_t u = std::string(source) == "sine" ? h.add("sine_wave") : h.add("constant", {{"Value", text("1")}});
            const uint32_t pid = h.add(block, properties);
            h.wire(u, "out1", pid, "in1");
            h.runUntil(0.3);
        });
    };
    check(!build("pid_controller", {}), "controle: padroes compilam");
    check(build("pid_controller", {{"N", text("Inf")}}), "N = Inf recusado (derivada ideal nao suportada)");
    check(build("pid_controller", {{"InitialConditionForIntegrator", text("NaN")}}), "condicao inicial NaN recusada");
    check(build("pid_controller", {{"InitialConditionForFilter", text("Inf")}}), "condicao inicial do filtro Inf recusada");
    check(build("pid_controller", {{"LimitOutput", on()}, {"UpperSaturationLimit", text("1")}, {"LowerSaturationLimit", text("0")},
                                   {"InitialConditionForIntegrator", text("2")}}),
          "condicao inicial do integrador fora dos limites da saida recusada (R2022b)");
    check(build("pid_controller", {{"LimitOutput", on()}, {"UpperSaturationLimit", text("0")}, {"LowerSaturationLimit", text("1")}}),
          "Lower limit > Upper limit recusado");
    check(build("pid_controller", {{"LimitOutput", on()}, {"AntiWindupMode", text("back-calculation")}, {"Kb", text("[1 2]")}}), "Kb vetorial recusado");
    check(build("pid_controller", {{"P", text("[1 2 3]")}, {"I", text("[1 2]")}}), "larguras de parametros incompativeis recusadas");
    check(build("pid_controller_2dof", {{"Controller", text("P")}}), "2DOF recusa Controller P (so PID, PI, PD)");
    check(build("pid_controller", {{"Controller", text("PIDF")}}), "Controller desconhecido recusado");
    check(build("discrete_pid_controller", {{"SampleTime", text("0.1")}, {"UseExternalTs", on()}}), "porta TDTI (subsistema condicional) recusada");
    check(build("discrete_pid_controller", {{"SampleTime", text("0.1")}, {"IntegratorMethod", text("Midpoint")}}), "metodo de integracao desconhecido recusado");
    check(build("discrete_pid_controller", {{"SampleTime", text("-2")}}), "Sample time negativo recusado");
    check(build("pid_controller", {{"TimeDomain", text("Discrete-time")}}), "PID Controller discreto com Sample time -1 recusado (taxa declarada continua)");
    check(build("pid_controller", {{"TimeDomain", text("Discrete-time")}, {"SampleTime", text("[0.1 0.2]")}}), "offset >= Ts recusado");
    check(!build("pid_controller", {{"TimeDomain", text("Discrete-time")}, {"SampleTime", text("[0.1 0.05]")}}), "[Ts offset] aceito no PID Controller discreto");
    bool continuousRejected = false;
    try {
        Harness h;
        const uint32_t sine = h.add("sine_wave");
        const uint32_t pid = h.add("discrete_pid_controller");
        h.wire(sine, "out1", pid, "in1");
        h.runUntil(0.1);
    } catch (const std::exception& error) {
        continuousRejected = std::string(error.what()).find("exige tempo de amostragem discreto") != std::string::npos;
    }
    check(continuousRejected, "Discrete PID herdando tempo continuo e recusado com a mensagem padrao");
    bool looseRejected = false;
    try {
        Harness h;
        h.add("discrete_pid_controller_2dof");
        h.runUntil(0.1);
    } catch (const std::exception& error) {
        looseRejected = std::string(error.what()).find("exige tempo de amostragem discreto") != std::string::npos;
    }
    check(looseRejected, "Discrete PID 2DOF com entradas soltas (tempo constante) e recusado como no Simulink");
}

} // namespace

int main() {
    const std::pair<const char*, void (*)()> cases[] = {
        {"continuousForms", continuousForms},
        {"continuousVector", continuousVector},
        {"continuousClosedLoop", continuousClosedLoop},
        {"continuousAntiWindup", continuousAntiWindup},
        {"continuousTrackingResetAndLimits", continuousTrackingResetAndLimits},
        {"continuousExternalGainsAndTwoDof", continuousExternalGainsAndTwoDof},
        {"discreteIntegratorMethods", discreteIntegratorMethods},
        {"discreteFilterMethods", discreteFilterMethods},
        {"discreteUnfilteredAndIdeal", discreteUnfilteredAndIdeal},
        {"discreteAntiWindupTrackingReset", discreteAntiWindupTrackingReset},
        {"discreteTwoDofInheritanceAndExternalAntiWindup", discreteTwoDofInheritanceAndExternalAntiWindup},
        {"discreteTransferFunctionWithSine", discreteTransferFunctionWithSine},
        {"limitsAndInitialConditionPorts", limitsAndInitialConditionPorts},
        {"errors", errors},
    };
    for (const auto& [name, test] : cases) {
        try { test(); } catch (const std::exception& error) { check(false, std::string(name) + " lancou: " + error.what()); }
    }
    return finish("library_pid");
}
