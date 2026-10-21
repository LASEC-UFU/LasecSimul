// Discontinuities: parâmetros oficiais -> kernels de `simulation/library/kernels/DiscontinuityKernels.cpp`
// (layout `rp/ip` documentado em cada kernel). Parâmetros vetoriais seguem a expansão escalar.
#include <initializer_list>

#include "BuilderCommon.hpp"

namespace lasecsimul::components::blocks::builders {
namespace {

std::vector<double> nonEmpty(const BuildContext& c, const char* name) {
    std::vector<double> values = c.value(name).linear();
    if (values.empty()) c.fail(std::string(name) + " vazio");
    return values;
}

void requireWidth(const BuildContext& c, const std::vector<double>& values, size_t width, const char* name) {
    if (values.size() != 1 && values.size() != width)
        c.fail(std::string(name) + ": largura " + std::to_string(values.size()) + " incompativel com o sinal (" + std::to_string(width) + ")");
}

/** Vetores concatenados em `rp` e o tamanho de cada um (menos o último) em `ip` -- layout `Packed`. */
struct PackedParams { std::vector<double> rp; std::vector<int64_t> ip; uint16_t width = 1; };
PackedParams pack(const BuildContext& c, std::initializer_list<std::pair<const char*, const std::vector<double>*>> vectors) {
    PackedParams packed;
    size_t width = 1;
    for (const auto& [name, values] : vectors) width = std::max(width, values->size());
    packed.width = elementwiseWidth(c, {width});
    size_t index = 0;
    for (const auto& [name, values] : vectors) {
        requireWidth(c, *values, packed.width, name);
        packed.rp.insert(packed.rp.end(), values->begin(), values->end());
        if (++index < vectors.size()) packed.ip.push_back(static_cast<int64_t>(values->size()));
    }
    return packed;
}

void requireDiscrete(const BuildContext& c) {
    if (c.resolution.rate.continuous())
        c.fail("exige tempo de amostragem discreto (use um solver de passo fixo/um sinal discreto na entrada)");
}

void buildSaturation(BuildContext& c) {
    const std::vector<double> upper = nonEmpty(c, "UpperLimit"), lower = nonEmpty(c, "LowerLimit");
    PackedParams p = pack(c, {{"Upper limit", &upper}, {"Lower limit", &lower}});
    const bool status = c.flag("OutputSaturationStatus");
    p.ip.push_back(status ? 1 : 0);
    if (!status) { simpleKernel(c, "saturation", p.width, p.rp, p.ip); return; }
    emitWithSlices(c, "saturation", inputWidths(c), {p.width, p.width, p.width}, p.rp, p.ip);
}

void buildDeadZone(BuildContext& c) {
    const std::vector<double> lower = nonEmpty(c, "LowerValue"), upper = nonEmpty(c, "UpperValue");
    const PackedParams p = pack(c, {{"Start of dead zone", &lower}, {"End of dead zone", &upper}});
    for (size_t i = 0; i < p.width; ++i)
        if (lower[lower.size() == 1 ? 0 : i] > upper[upper.size() == 1 ? 0 : i]) c.fail("Start of dead zone precisa ser <= End of dead zone");
    simpleKernel(c, "dead_zone", p.width, p.rp, p.ip);
}

void buildSaturationDynamic(BuildContext& c) { simpleKernel(c, "saturation_dynamic", elementwiseWidth(c)); }
void buildDeadZoneDynamic(BuildContext& c) { simpleKernel(c, "dead_zone_dynamic", elementwiseWidth(c)); }

void buildRelay(BuildContext& c) {
    const std::vector<double> on = nonEmpty(c, "OnSwitchValue"), off = nonEmpty(c, "OffSwitchValue");
    const std::vector<double> onOut = nonEmpty(c, "OnOutputValue"), offOut = nonEmpty(c, "OffOutputValue");
    const PackedParams p = pack(c, {{"Switch on point", &on}, {"Switch off point", &off}, {"Output when on", &onOut}, {"Output when off", &offOut}});
    for (size_t i = 0; i < p.width; ++i)
        if (on[on.size() == 1 ? 0 : i] < off[off.size() == 1 ? 0 : i]) c.fail("Switch on point precisa ser >= Switch off point");
    simpleKernel(c, "relay", p.width, p.rp, p.ip);
}

void buildRateLimiter(BuildContext& c) {
    const std::vector<double> rising = nonEmpty(c, "RisingSlewLimit"), falling = nonEmpty(c, "FallingSlewLimit");
    const std::vector<double> initial = nonEmpty(c, "InitialCondition");
    for (double value : initial) if (!std::isfinite(value)) c.fail("Initial condition nao pode ser Inf ou NaN");
    const uint16_t width = elementwiseWidth(c, {rising.size(), falling.size(), initial.size()});
    std::vector<double> rp = expandTo(c, rising, width, "Rising slew rate");
    const std::vector<double> f = expandTo(c, falling, width, "Falling slew rate"), ic = expandTo(c, initial, width, "Initial condition");
    rp.insert(rp.end(), f.begin(), f.end());
    rp.insert(rp.end(), ic.begin(), ic.end());
    // SampleTimeMode = continuous: o bloco roda na partição contínua mesmo com entrada discreta;
    // herdado: discreto se a entrada for discreta (Ts do sinal), contínuo se ela for contínua.
    const bool forcedContinuous = c.text("SampleTimeMode") == "continuous";
    const bool continuous = forcedContinuous || c.resolution.rate.continuous();
    c.outputWidths = {width};
    if (c.widthsOnly) return;
    simulation::SignalBlockDefinition& block = c.kernel("", "rate_limiter", inputWidths(c), width, rp, {width, continuous ? 1 : 0});
    if (forcedContinuous) block.rate = simulation::SignalRate{0, 0, 0};
    c.connectInputs(c.outputBlock(0));
}

void buildRateLimiterDynamic(BuildContext& c) {
    requireDiscrete(c);
    simpleKernel(c, "rate_limiter_dynamic", elementwiseWidth(c));
}

void buildBacklash(BuildContext& c) {
    const std::vector<double> width = nonEmpty(c, "BacklashWidth"), initial = nonEmpty(c, "InitialOutput");
    for (double w : width) if (!(w >= 0.0) || !std::isfinite(w)) c.fail("Deadband width precisa ser finita e >= 0");
    for (double y : initial) if (!std::isfinite(y)) c.fail("Initial output precisa ser finita");
    const PackedParams p = pack(c, {{"Deadband width", &width}, {"Initial output", &initial}});
    simpleKernel(c, "backlash", p.width, p.rp, p.ip);
}

void buildCoulomb(BuildContext& c) {
    const std::vector<double> offset = nonEmpty(c, "offset"), gain = nonEmpty(c, "gain");
    const PackedParams p = pack(c, {{"Coulomb friction value", &offset}, {"Coefficient of viscous friction", &gain}});
    simpleKernel(c, "coulomb_viscous_friction", p.width, p.rp, p.ip);
}

void buildQuantizer(BuildContext& c) {
    const std::vector<double> q = nonEmpty(c, "QuantizationInterval");
    for (double value : q) if (value == 0.0 || !std::isfinite(value)) c.fail("Quantization interval precisa ser finito e diferente de zero");
    const uint16_t width = elementwiseWidth(c, {q.size()});
    requireWidth(c, q, width, "Quantization interval");
    simpleKernel(c, "quantizer", width, q);
}

void buildWrapToZero(BuildContext& c) {
    const std::vector<double> threshold = nonEmpty(c, "Threshold");
    const uint16_t width = elementwiseWidth(c, {threshold.size()});
    requireWidth(c, threshold, width, "Threshold");
    simpleKernel(c, "wrap_to_zero", width, threshold);
}

void buildHitCrossing(BuildContext& c) {
    if (!c.flag("ShowOutputPort")) {
        // Sem porta de saída o bloco só pede ao solver o instante do cruzamento; aqui não há
        // localização de cruzamento por zero, então nada a emitir.
        c.outputWidths = {};
        return;
    }
    if (c.text("HitCrossingOutputType") != "Signal")
        c.fail("Output type '" + c.text("HitCrossingOutputType") + "' nao suportado: so 'Signal' (sem mensagens nem chamadas de funcao)");
    const std::string direction = c.text("HitCrossingDirection");
    const int64_t code = direction == "rising" ? 1 : direction == "falling" ? 2 : direction == "either" ? 0 : -1;
    if (code < 0) c.fail("Hit crossing direction invalida: " + direction);
    const std::vector<double> offset = nonEmpty(c, "HitCrossingOffset");
    const uint16_t width = elementwiseWidth(c, {offset.size()});
    requireWidth(c, offset, width, "Hit crossing offset");
    simpleKernel(c, "hit_crossing", width, offset, {code});
}

void buildPwm(BuildContext& c) {
    const double period = c.scalar("Period"), delay = c.scalar("InitialDelay");
    if (!(period > 0.0) || !std::isfinite(period)) c.fail("Period precisa ser > 0");
    if (!(delay >= 0.0) || !std::isfinite(delay)) c.fail("Initial Delay precisa ser >= 0");
    const bool fixed = c.flag("RunAtFixedTimeIntervals");
    double ts = 0.0;
    if (fixed) {
        ts = c.scalar("SampleTime");
        if (!(ts > 0.0) || !std::isfinite(ts)) c.fail("Sample Time precisa ser > 0");
        if (period / ts + 1e-9 < 1.0) c.fail("Period precisa ser >= Sample Time");
    }
    if (c.inputWidth(0) != 1) c.fail("D precisa ser escalar (largura " + std::to_string(c.inputWidth(0)) + ")");
    c.outputWidths = {1};
    if (c.widthsOnly) return;
    simulation::SignalBlockDefinition& block =
        c.kernel("", "pwm", inputWidths(c), 1, {period, delay}, {fixed ? 1 : 0, c.flag("DisallowZeroDutyCycle") ? 1 : 0});
    if (fixed) block.rate = simulation::SignalRate{static_cast<uint64_t>(nanoseconds(c, ts, "Sample Time")), 0, 0};
    c.connectInputs(c.outputBlock(0));
}

} // namespace

void registerDiscontinuityBuilders(BuilderTable& table) {
    table.add("saturation", buildSaturation);
    table.add("dead_zone", buildDeadZone);
    table.add("saturation_dynamic", buildSaturationDynamic);
    table.add("dead_zone_dynamic", buildDeadZoneDynamic);
    table.add("relay", buildRelay);
    table.add("rate_limiter", buildRateLimiter);
    table.add("rate_limiter_dynamic", buildRateLimiterDynamic);
    table.add("backlash", buildBacklash);
    table.add("coulomb_viscous_friction", buildCoulomb);
    table.add("quantizer", buildQuantizer);
    table.add("wrap_to_zero", buildWrapToZero);
    table.add("hit_crossing", buildHitCrossing);
    table.add("pwm", buildPwm);
}

} // namespace lasecsimul::components::blocks::builders
