// Discrete: parâmetros oficiais -> kernels de `DiscreteKernels.cpp` (e `discrete_state_space` de
// `ContinuousKernels.cpp`). Discrete Transfer Fcn, Discrete Filter, Discrete Zero-Pole e as formas
// diretas II usam o kernel `iir_filter` por canal (estados = atrasos do diagrama, que é o que
// `InitialStates` inicializa).
#include <complex>

#include "BuilderCommon.hpp"

namespace lasecsimul::components::blocks::builders {

// Definidos em ContinuousBuilders.cpp (mesma família: Zero-Pole contínuo e discreto).
struct ZeroPoleModel { std::vector<std::vector<double>> numerators; std::vector<double> denominator; };
ZeroPoleModel zeroPoleModel(const BuildContext& c);

namespace {

void requireDiscrete(const BuildContext& c) {
    if (c.resolution.rate.continuous())
        c.fail("exige tempo de amostragem discreto (defina Sample time > 0 ou ligue a um sinal discreto)");
}

void requireSampleBased(const BuildContext& c) {
    if (c.spec.param("InputProcessing") && c.text("InputProcessing") == "Columns as channels (frame based)")
        c.fail("Input processing por quadros (frame based) nao suportado: sinais sao amostra a amostra");
}

double samplePeriod(const BuildContext& c) { return static_cast<double>(c.resolution.rate.periodNs) * 1e-9; }

void requireFinite(const BuildContext& c, const std::vector<double>& values, const char* what) {
    for (double value : values) if (!std::isfinite(value)) c.fail(std::string(what) + " nao pode ser Inf ou NaN");
}

size_t nonNegativeInteger(const BuildContext& c, double value, const char* what) {
    if (!(value >= 0.0) || value != std::floor(value) || value > 1'000'000.0) c.fail(std::string(what) + " precisa ser inteiro >= 0");
    return static_cast<size_t>(value);
}

void buildUnitDelay(BuildContext& c) {
    requireDiscrete(c);
    requireSampleBased(c);
    const std::vector<double> ic = c.value("InitialCondition").linear();
    if (ic.empty()) c.fail("Initial condition vazia");
    const uint16_t width = elementwiseWidth(c, {ic.size()});
    simpleKernel(c, "unit_delay", width, expandTo(c, ic, width, "Initial condition"));
}

/** Delay (e os presets Resettable Delay / Variable Integer Delay): kernel `delay_general`. */
void buildDelay(BuildContext& c) {
    requireDiscrete(c);
    requireSampleBased(c);
    const bool fromPort = c.text("DelayLengthSource") == "Input port";
    const bool icPort = c.text("InitialConditionSource") == "Input port";
    const bool enable = c.flag("ShowEnablePort");
    const int64_t reset = resetMode(c.text("ExternalReset"));
    size_t length = 0, buffer = 0, lower = 0;
    if (fromPort) {
        buffer = nonNegativeInteger(c, c.scalar("DelayLengthUpperLimit"), "Delay length: Upper limit");
        lower = c.flag("PreventDirectFeedthrough") ? 1 : 0;
        if (buffer < lower) c.fail("Delay length: Upper limit menor que o limite inferior (Prevent direct feedthrough)");
    } else {
        length = nonNegativeInteger(c, c.scalar("DelayLength"), "Delay length");
        buffer = length;
    }
    const std::vector<double> ic = icPort ? std::vector<double>{0.0} : c.value("InitialCondition").linear();
    if (ic.empty()) c.fail("Initial condition vazia");
    requireFinite(c, ic, "Initial condition");
    size_t width = std::max<size_t>(c.inputWidth(0), ic.size());
    if (icPort) width = std::max<size_t>(width, c.inputWidth(c.inputPorts.size() - 1));
    if (width > 4096) c.fail("largura de sinal grande demais");
    if (static_cast<double>(buffer) * static_cast<double>(width) > 16'000'000.0) c.fail("Delay length grande demais para a largura do sinal");
    const std::vector<double> rp = expandTo(c, ic, width, "Initial condition");
    simpleKernel(c, "delay_general", static_cast<uint16_t>(width), rp,
                 {static_cast<int64_t>(buffer), fromPort ? 1 : 0, static_cast<int64_t>(lower), icPort ? 1 : 0, enable ? 1 : 0, reset,
                  static_cast<int64_t>(c.resolution.rate.offsetNs), static_cast<int64_t>(length)});
}

void buildZeroOrderHold(BuildContext& c) {
    requireDiscrete(c);
    simpleKernel(c, "zero_order_hold", elementwiseWidth(c));
}

/** Memory: atraso de um passo maior. Inherit sample time desligado (padrão) = taxa "contínua fixa
 * nos passos menores" do Simulink, i.e. o kernel roda na partição contínua (update em todo passo
 * maior); ligado = taxa herdada da entrada (com entrada discreta, igual ao Unit Delay). */
void buildMemory(BuildContext& c) {
    const std::vector<double> ic = c.value("InitialCondition").linear();
    if (ic.empty()) c.fail("Initial condition vazia");
    requireFinite(c, ic, "Initial condition");
    const uint16_t width = elementwiseWidth(c, {ic.size()});
    c.outputWidths = {width};
    if (c.widthsOnly) return;
    simulation::SignalBlockDefinition& kernel = c.kernel("", "unit_delay", inputWidths(c), width, expandTo(c, ic, width, "Initial condition"));
    // Taxa constante (entrada constante) não tem passo maior para atrasar: também contínua.
    if (!c.flag("InheritSampleTime") || c.resolution.rate.periodNs >= simulation::kConstantSamplePeriodNs) kernel.rate = {0, 0, 0};
    c.connectInputs(c.outputBlock(0));
}

// ---- Filtros IIR (kernel `iir_filter`) ------------------------------------------------------------
struct IirSetup {
    size_t w = 1, L = 1;
    int64_t structure = 0;
    std::vector<std::vector<double>> b; // r linhas de L (potências crescentes de z^-1, a0 = 1)
    std::vector<double> a;              // L (a0 = 1)
    double a0div = 1.0;
    bool numPort = false, denPort = false, numFront = true, denFront = true, denNoLead = false, icPort = false;
    size_t numWidth = 0, denWidth = 0;
    int64_t reset = 0;
    std::vector<double> icNum, icDen; // w x (L-1) cada
};

/** Estados iniciais por canal: escalar, um por estado (L-1, mesmo em todos os canais) ou matriz
 * (estados x canais, ordem linear do MATLAB = canal a canal). `count` estados úteis (o resto é 0). */
std::vector<double> initialStates(const BuildContext& c, const char* name, size_t w, size_t L, size_t count) {
    const std::vector<double> values = c.value(name).linear();
    requireFinite(c, values, name);
    const size_t n = L > 0 ? L - 1 : 0;
    std::vector<double> result(w * n, 0.0);
    for (size_t channel = 0; channel < w; ++channel)
        for (size_t j = 0; j < count && j < n; ++j) {
            double value;
            if (values.size() == 1) value = values[0];
            else if (values.size() == count) value = values[j];
            else if (values.size() == w * count) value = values[channel * count + j];
            else c.fail(std::string(name) + ": esperado escalar, " + std::to_string(count) + " ou " + std::to_string(w * count) + " valores");
            result[channel * n + j] = value;
        }
    return result;
}

void emitIir(BuildContext& c, const IirSetup& s) {
    const size_t r = s.b.empty() ? 1 : s.b.size();
    if (r > 1 && s.w != 1) c.fail("numerador matricial (varios filtros) exige entrada escalar");
    std::vector<double> rp;
    if (s.b.empty()) rp.assign(s.L, 0.0);
    for (const auto& row : s.b) rp.insert(rp.end(), row.begin(), row.end());
    if (s.a.empty()) { rp.push_back(1.0); rp.insert(rp.end(), s.L - 1, 0.0); }
    else rp.insert(rp.end(), s.a.begin(), s.a.end());
    rp.push_back(s.a0div);
    std::vector<double> icNum = s.icNum, icDen = s.icDen;
    icNum.resize(s.w * (s.L - 1), 0.0);
    icDen.resize(s.w * (s.L - 1), 0.0);
    rp.insert(rp.end(), icNum.begin(), icNum.end());
    rp.insert(rp.end(), icDen.begin(), icDen.end());
    if (s.w * r > 4096) c.fail("largura de sinal grande demais");
    simpleKernel(c, "iir_filter", static_cast<uint16_t>(s.w * r), rp,
                 {static_cast<int64_t>(s.w), static_cast<int64_t>(s.L), static_cast<int64_t>(r), s.structure, s.numPort ? 1 : 0,
                  static_cast<int64_t>(s.numWidth), s.numFront ? 1 : 0, s.denPort ? 1 : 0, static_cast<int64_t>(s.denWidth), s.denFront ? 1 : 0,
                  s.denNoLead ? 1 : 0, s.icPort ? 1 : 0, s.reset});
}

/** Índice da porta `id` entre as portas resolvidas. */
size_t portIndex(const BuildContext& c, const char* id) {
    for (size_t i = 0; i < c.inputPorts.size(); ++i) if (c.inputPorts[i] == id) return i;
    c.fail(std::string("porta ausente: ") + id);
}

/** Denominador do diálogo: a0 != 0; com a0EqualsOne, a0 precisa ser 1. Devolve normalizado e a0. */
std::vector<double> dialogDenominator(const BuildContext& c, const char* name, double& a0) {
    const std::vector<double> den = c.vector(name);
    if (den.empty()) c.fail(std::string(name) + " vazio");
    requireFinite(c, den, name);
    a0 = den[0];
    if (a0 == 0.0) c.fail("o primeiro coeficiente do denominador (a0) nao pode ser 0");
    if (c.flag("a0EqualsOne") && a0 != 1.0) c.fail("com a otimizacao a0EqualsOne, o primeiro coeficiente do denominador precisa ser 1");
    std::vector<double> normalized = den;
    for (double& value : normalized) value /= a0;
    return normalized;
}

void buildDiscreteTransferFcn(BuildContext& c) {
    requireDiscrete(c);
    requireSampleBased(c);
    IirSetup s;
    s.w = c.inputWidth(0);
    s.numPort = c.text("NumeratorSource") == "Input port";
    s.denPort = c.text("DenominatorSource") == "Input port";
    s.icPort = c.text("InitialStatesSource") == "Input port";
    s.reset = resetMode(c.text("ExternalReset"));
    s.numFront = s.denFront = true; // convenção em z: completa na frente
    if (s.denPort) {
        if (!c.flag("a0EqualsOne")) c.fail("denominador pela porta Den exige a otimizacao a0EqualsOne (a0 substituido por 1)");
        s.denWidth = c.inputWidth(portIndex(c, "den"));
        s.L = s.denWidth;
    } else {
        s.a = dialogDenominator(c, "Denominator", s.a0div);
        s.L = s.a.size();
    }
    if (s.numPort) {
        s.numWidth = c.inputWidth(portIndex(c, "num"));
        if (s.numWidth > s.L) c.fail("ordem do numerador maior que a do denominador (sistema nao causal)");
    } else {
        const lib::ParamValue numerator = c.value("Numerator");
        if (numerator.empty()) c.fail("Numerator vazio");
        for (std::vector<double> row : numeratorRows(numerator)) {
            requireFinite(c, row, "Numerator");
            if (row.size() > s.L) c.fail("ordem do numerador maior que a do denominador (sistema nao causal)");
            std::vector<double> padded(s.L - row.size(), 0.0);
            for (double value : row) padded.push_back(value / s.a0div);
            s.b.push_back(std::move(padded));
        }
    }
    if (!s.icPort) s.icNum = initialStates(c, "InitialStates", s.w, s.L, s.L - 1);
    emitIir(c, s);
}

void buildDiscreteFilter(BuildContext& c) {
    requireDiscrete(c);
    requireSampleBased(c);
    const std::string structure = c.text("FilterStructure");
    IirSetup s;
    s.structure = structure == "Direct form II transposed" ? 1 : structure == "Direct form I" ? 2 : structure == "Direct form I transposed" ? 3 : 0;
    const bool formII = s.structure <= 1;
    s.w = c.inputWidth(0);
    s.numPort = c.text("NumeratorSource") == "Input port";
    s.denPort = c.text("DenominatorSource") == "Input port";
    s.icPort = formII && c.text("InitialStatesSource") == "Input port";
    s.reset = resetMode(c.text("ExternalReset"));
    s.numFront = s.denFront = false; // convenção em z^-1: completa no fim
    size_t numLength = 0, denLength = 0;
    std::vector<std::vector<double>> rows;
    if (s.numPort) {
        s.numWidth = c.inputWidth(portIndex(c, "num"));
        numLength = s.numWidth;
    } else {
        const lib::ParamValue numerator = c.value("Numerator");
        if (numerator.empty()) c.fail("Numerator vazio");
        rows = numeratorRows(numerator);
        numLength = rows.front().size();
    }
    if (s.denPort) {
        if (!c.flag("a0EqualsOne")) c.fail("denominador pela porta Den exige a otimizacao a0EqualsOne (a0 substituido por 1)");
        s.denWidth = c.inputWidth(portIndex(c, "den"));
        denLength = s.denWidth;
    } else {
        s.a = dialogDenominator(c, "Denominator", s.a0div);
        denLength = s.a.size();
    }
    s.L = std::max(numLength, denLength);
    if (!s.a.empty()) s.a.resize(s.L, 0.0);
    for (const auto& row : rows) {
        requireFinite(c, row, "Numerator");
        std::vector<double> padded;
        for (double value : row) padded.push_back(value / s.a0div);
        padded.resize(s.L, 0.0);
        s.b.push_back(std::move(padded));
    }
    if (!s.icPort) {
        if (formII) s.icNum = initialStates(c, "InitialStates", s.w, s.L, s.L - 1);
        else {
            s.icNum = initialStates(c, "InitialStates", s.w, s.L, numLength > 0 ? numLength - 1 : 0);
            s.icDen = initialStates(c, "InitialDenominatorStates", s.w, s.L, denLength > 0 ? denLength - 1 : 0);
        }
    }
    emitIir(c, s);
}

void buildDiscreteZeroPole(BuildContext& c) {
    requireDiscrete(c);
    const ZeroPoleModel model = zeroPoleModel(c);
    IirSetup s;
    s.w = c.inputWidth(0);
    s.a = model.denominator;
    s.L = s.a.size();
    for (const auto& numerator : model.numerators) {
        std::vector<double> padded(s.L - numerator.size(), 0.0);
        padded.insert(padded.end(), numerator.begin(), numerator.end());
        s.b.push_back(std::move(padded));
    }
    emitIir(c, s);
}

void buildTransferFcnDirectFormII(BuildContext& c) {
    requireDiscrete(c);
    if (c.inputWidth(0) != 1) c.fail("bloco SISO: a entrada deve ter largura 1");
    const std::vector<double> num = c.vector("NumCoefVec");
    const std::vector<double> den = c.vector("DenCoefVec");
    if (num.empty()) c.fail("Numerator coefficients vazio");
    requireFinite(c, num, "Numerator coefficients");
    requireFinite(c, den, "Denominator coefficients");
    IirSetup s;
    s.L = std::max(num.size(), den.size() + 1);
    s.a = {1.0};
    s.a.insert(s.a.end(), den.begin(), den.end());
    s.a.resize(s.L, 0.0);
    std::vector<double> b = num;
    b.resize(s.L, 0.0);
    s.b.push_back(std::move(b));
    const double vinit = c.scalar("vinit");
    if (!std::isfinite(vinit)) c.fail("Initial condition nao pode ser Inf ou NaN");
    s.icNum.assign(s.L - 1, vinit);
    emitIir(c, s);
}

void buildTransferFcnDirectFormIITimeVarying(BuildContext& c) {
    requireDiscrete(c);
    if (c.inputWidth(0) != 1) c.fail("bloco SISO: a entrada deve ter largura 1");
    IirSetup s;
    s.numPort = s.denPort = true;
    s.denNoLead = true;
    s.numFront = false;
    s.numWidth = c.inputWidth(1);
    s.denWidth = c.inputWidth(2);
    s.L = s.denWidth + 1;
    if (s.numWidth != s.L)
        c.fail("largura de Num (" + std::to_string(s.numWidth) + ") deve ser igual a do denominador completo (" + std::to_string(s.L) + ")");
    const double vinit = c.scalar("vinit");
    if (!std::isfinite(vinit)) c.fail("Initial condition nao pode ser Inf ou NaN");
    s.icNum.assign(s.L - 1, vinit);
    emitIir(c, s);
}

void buildDiscreteFirFilter(BuildContext& c) {
    requireDiscrete(c);
    requireSampleBased(c);
    const std::string structure = c.text("FilterStructure");
    const int64_t code = structure == "Direct form symmetric" ? 1 : structure == "Direct form antisymmetric" ? 2
                       : structure == "Direct form transposed" ? 3 : structure == "Lattice MA" ? 4 : 0;
    const bool coefPort = c.text("CoefSource") == "Input port";
    const size_t w = c.inputWidth(0);
    std::vector<double> rp;
    size_t M = 0, r = 1;
    if (coefPort) {
        M = c.inputWidth(portIndex(c, "num"));
    } else {
        const lib::ParamValue coefficients = c.value("Coefficients");
        if (coefficients.empty()) c.fail("Coefficients vazio");
        requireFinite(c, coefficients.data, "Coefficients");
        if (coefficients.isVector()) { M = coefficients.numel(); rp = coefficients.data; }
        else { r = coefficients.rows; M = coefficients.cols; rp = coefficients.data; }
    }
    if (r > 1 && (code != 0 || w != 1)) c.fail("coeficientes matriciais (varios filtros) exigem Direct form e entrada escalar");
    const size_t S = code == 4 ? M : M - 1;
    const std::vector<double> values = c.value("InitialStates").linear();
    requireFinite(c, values, "Initial states");
    for (size_t channel = 0; channel < w; ++channel)
        for (size_t j = 0; j < S; ++j) {
            if (values.size() == 1) rp.push_back(values[0]);
            else if (values.size() == S) rp.push_back(values[j]);
            else if (values.size() == w * S) rp.push_back(values[channel * S + j]);
            else c.fail("Initial states: esperado escalar, " + std::to_string(S) + " ou " + std::to_string(w * S) + " valores");
        }
    if (w * r > 4096) c.fail("largura de sinal grande demais");
    simpleKernel(c, "fir_filter", static_cast<uint16_t>(w * r), rp,
                 {static_cast<int64_t>(w), static_cast<int64_t>(M), static_cast<int64_t>(r), code, coefPort ? 1 : 0,
                  resetMode(c.text("ExternalReset")), c.flag("ShowEnablePort") ? 1 : 0});
}

// ---- Seções de primeira ordem (kernel `first_order_section`) --------------------------------------
// y(k) = b0 u(k) + b1 s(k-1) + a1 y(k-1), s(k) = g u(k).
void emitFirstOrder(BuildContext& c, double b0, double b1, double a1, double g, std::vector<double> icInput, std::vector<double> icOutput) {
    requireDiscrete(c);
    requireSampleBased(c);
    for (double value : {b0, b1, a1, g}) if (!std::isfinite(value)) c.fail("parametro nao finito");
    requireFinite(c, icInput, "Initial condition");
    requireFinite(c, icOutput, "Initial condition");
    if (icInput.empty() || icOutput.empty()) c.fail("Initial condition vazia");
    const uint16_t width = elementwiseWidth(c, {icInput.size(), icOutput.size()});
    const size_t icWidth = icInput.size() == 1 && icOutput.size() == 1 ? 1 : width;
    std::vector<double> rp{b0, b1, a1, g};
    const std::vector<double> s = expandTo(c, icInput, icWidth, "Initial condition"), y = expandTo(c, icOutput, icWidth, "Initial condition");
    rp.insert(rp.end(), s.begin(), s.end());
    rp.insert(rp.end(), y.begin(), y.end());
    simpleKernel(c, "first_order_section", width, rp, {static_cast<int64_t>(icWidth)});
}

void buildTransferFcnFirstOrder(BuildContext& c) {
    const double p = c.scalar("PoleZ");
    emitFirstOrder(c, 1.0 - p, 0.0, p, 0.0, {0.0}, c.value("ICPrevOutput").linear());
}

void buildTransferFcnLeadOrLag(BuildContext& c) {
    const double p = c.scalar("PoleZ"), z = c.scalar("ZeroZ");
    emitFirstOrder(c, 1.0, -z, p, 1.0, c.value("ICPrevInput").linear(), c.value("ICPrevOutput").linear());
}

void buildTransferFcnRealZero(BuildContext& c) {
    const double z = c.scalar("ZeroZ");
    emitFirstOrder(c, 1.0, -z, 0.0, 1.0, c.value("ICPrevInput").linear(), {0.0});
}

void buildDifference(BuildContext& c) { emitFirstOrder(c, 1.0, -1.0, 0.0, 1.0, c.value("ICPrevInput").linear(), {0.0}); }

void buildDiscreteDerivative(BuildContext& c) {
    requireDiscrete(c);
    const double k = c.scalar("gainval");
    const double ts = samplePeriod(c);
    emitFirstOrder(c, k / ts, -1.0, 0.0, k / ts, c.value("ICPrevScaledInput").linear(), {0.0});
}

// ---- Discrete-Time Integrator -------------------------------------------------------------------
void buildDiscreteTimeIntegrator(BuildContext& c) {
    requireDiscrete(c);
    const std::string method = c.text("IntegratorMethod");
    const bool accumulation = method.rfind("Accumulation", 0) == 0;
    const int64_t code = method.find("Backward") != std::string::npos ? 1 : method.find("Trapezoidal") != std::string::npos ? 2 : 0;
    const std::string resetText = c.text("ExternalReset");
    const int64_t reset = resetText == "rising" ? 1 : resetText == "falling" ? 2 : resetText == "either" ? 3
                        : resetText == "level" ? 4 : resetText == "sampled level" ? 5 : 0;
    const bool external = c.text("InitialConditionSource") == "external";
    const bool limit = c.flag("LimitOutput");
    const std::vector<double> gain = c.value("gainval").linear();
    const std::vector<double> ic = external ? std::vector<double>{0.0} : c.value("InitialCondition").linear();
    const std::vector<double> upper = limit ? c.value("UpperSaturationLimit").linear() : std::vector<double>{INFINITY};
    const std::vector<double> lower = limit ? c.value("LowerSaturationLimit").linear() : std::vector<double>{-INFINITY};
    for (const auto* values : {&gain, &ic, &upper, &lower}) if (values->empty()) c.fail("parametro vazio");
    for (double k : gain) if (!(k > 0.0) || !std::isfinite(k)) c.fail("Gain value deve ser real positivo");
    requireFinite(c, ic, "Initial condition");
    size_t n = std::max({static_cast<size_t>(c.inputWidth(0)), gain.size(), ic.size(), upper.size(), lower.size()});
    if (external) n = std::max<size_t>(n, c.inputWidth(c.inputPorts.size() - 1));
    if (n > 4096) c.fail("largura de sinal grande demais");
    std::vector<double> rp;
    for (const auto& [values, name] : {std::pair{&gain, "Gain value"}, std::pair{&ic, "Initial condition"}, std::pair{&upper, "Upper saturation limit"},
                                       std::pair{&lower, "Lower saturation limit"}}) {
        const std::vector<double> expanded = expandTo(c, *values, n, name);
        rp.insert(rp.end(), expanded.begin(), expanded.end());
    }
    for (size_t i = 0; limit && i < n; ++i)
        if (rp[3 * n + i] > rp[2 * n + i]) c.fail("Lower saturation limit maior que Upper saturation limit");
    rp.push_back(accumulation ? 1.0 : samplePeriod(c));
    const bool showSat = limit && c.flag("ShowSaturationPort");
    const bool showState = c.flag("ShowStatePort");
    std::vector<uint16_t> ports{static_cast<uint16_t>(n)};
    if (showSat) ports.push_back(static_cast<uint16_t>(n));
    if (showState) ports.push_back(static_cast<uint16_t>(n));
    emitWithSlices(c, "discrete_integrator", inputWidths(c), ports, rp,
                   {static_cast<int64_t>(n), code, reset, external ? 1 : 0, limit ? 1 : 0, showSat ? 1 : 0, showState ? 1 : 0,
                    c.text("InitialConditionSetting") == "Output" ? 1 : 0});
}

void buildTappedDelay(BuildContext& c) {
    requireDiscrete(c);
    const double count = c.scalar("NumDelays");
    if (count == -1.0) c.fail("Number of delays = -1 (herdado por retropropagacao) nao suportado: informe N >= 1");
    if (!(count >= 1.0) || count != std::floor(count) || count > 4095.0) c.fail("Number of delays precisa ser inteiro >= 1");
    if (c.inputWidth(0) != 1) c.fail("a entrada deve ser escalar (largura 1)");
    const double vinit = c.scalar("vinit");
    if (!std::isfinite(vinit)) c.fail("Initial condition nao pode ser Inf ou NaN");
    const bool current = c.flag("includeCurrent");
    const auto n = static_cast<int64_t>(count);
    simpleKernel(c, "tapped_delay", static_cast<uint16_t>(n + (current ? 1 : 0)), {vinit},
                 {n, c.text("DelayOrder") == "Newest" ? 1 : 0, current ? 1 : 0});
}

void buildConditionalHold(BuildContext& c) {
    const std::vector<double> ic = c.value("InitialCondition").linear();
    if (ic.empty()) c.fail("Initial condition vazia");
    requireFinite(c, ic, "Initial condition");
    const uint16_t width = elementwiseWidth(c, {ic.size()});
    simpleKernel(c, "conditional_hold", width, expandTo(c, ic, width, "Initial condition"));
}

/** Propagation Delay: por evento (saída "fixa nos passos menores" = partição contínua com instantes
 * de saída como breakpoints) ou em intervalos fixos de Ts. */
void buildPropagationDelay(BuildContext& c) {
    const double initial = c.scalar("InitialOutput");
    if (!std::isfinite(initial)) c.fail("Initial output deve ser finito");
    if (c.inputWidth(0) != 1 || c.inputWidth(1) != 1) c.fail("u e dt devem ser escalares (largura 1)");
    const bool fixed = c.flag("RunAtFixedTimeIntervals");
    int64_t fixedNs = 0;
    if (fixed) {
        const double ts = c.scalar("SampleTime");
        if (!(ts > 0.0) || !std::isfinite(ts)) c.fail("Sample time deve ser > 0");
        fixedNs = nanoseconds(c, ts, "Sample time");
        if (fixedNs <= 0) c.fail("Sample time menor que 1 ns");
    }
    c.outputWidths = {1};
    if (c.widthsOnly) return;
    simulation::SignalBlockDefinition& kernel = c.kernel("", "propagation_delay", inputWidths(c), 1, {initial}, {65536, fixedNs});
    kernel.rate = fixed ? simulation::SignalRate{static_cast<uint64_t>(fixedNs), 0, 0} : simulation::SignalRate{0, 0, 0};
    c.connectInputs(c.outputBlock(0));
}

void buildDiscreteStateSpace(BuildContext& c) {
    requireDiscrete(c);
    buildStateSpaceKernel(c, "discrete_state_space");
}

} // namespace

void registerDiscreteBuilders(BuilderTable& table) {
    table.add("unit_delay", buildUnitDelay);
    table.add("delay", buildDelay);
    table.add("memory", buildMemory);
    table.add("zero_order_hold", buildZeroOrderHold);
    table.add("discrete_time_integrator", buildDiscreteTimeIntegrator);
    table.add("discrete_transfer_fcn", buildDiscreteTransferFcn);
    table.add("discrete_filter", buildDiscreteFilter);
    table.add("discrete_fir_filter", buildDiscreteFirFilter);
    table.add("discrete_state_space", buildDiscreteStateSpace);
    table.add("discrete_zero_pole", buildDiscreteZeroPole);
    table.add("discrete_derivative", buildDiscreteDerivative);
    table.add("difference", buildDifference);
    table.add("transfer_fcn_first_order", buildTransferFcnFirstOrder);
    table.add("transfer_fcn_lead_or_lag", buildTransferFcnLeadOrLag);
    table.add("transfer_fcn_real_zero", buildTransferFcnRealZero);
    table.add("tapped_delay", buildTappedDelay);
    table.add("conditional_hold", buildConditionalHold);
    table.add("propagation_delay", buildPropagationDelay);
    table.add("transfer_fcn_direct_form_ii", buildTransferFcnDirectFormII);
    table.add("transfer_fcn_direct_form_ii_time_varying", buildTransferFcnDirectFormIITimeVarying);
    table.add("fixed_point_state_space", buildDiscreteStateSpace);
}

} // namespace lasecsimul::components::blocks::builders
