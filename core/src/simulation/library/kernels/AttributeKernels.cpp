// Atributos de sinal (biblioteca Signal Attributes). Sinais do engine são só `double`: os blocos de
// tipo de dado emulam o efeito NUMÉRICO documentado da conversão (arredondamento, saturação ou
// estouro circular, precisão de single/half) e a saída continua `double` (docs/66 §4.6).
#include <cmath>
#include <limits>

#include "../KernelCommon.hpp"
#include "Families.hpp"

namespace lasecsimul::simulation::library {
namespace {
using namespace detail;

// ---- IC: rp = Value (1 ou largura); d = [iniciado, instante do primeiro acerto (ns)]. y = Value no
// primeiro acerto do bloco (t = tstart, ou o primeiro acerto n*Ts + offset >= tstart) e, depois,
// y = u. Na partição contínua o primeiro estágio do integrador em t = tstart ainda vê Value (o
// Simulink calcula as derivadas em tstart com a saída de tstart). ----
KernelShape icConfigure(const KernelConfig& c) {
    requireInputs(c, 1, "IC");
    requireExpandable(c, "IC");
    if (c.realParameters.size() != 1 && c.realParameters.size() != c.outputWidth) fail("IC: Initial value com largura incompativel");
    return {0, 2, {1}};
}
void icInit(KernelContext& k) { k.d[0] = 0.0; k.d[1] = 0.0; }
void icOutputs(KernelContext& k) {
    const bool initial = k.d[0] == 0.0 || static_cast<double>(k.tNs) == k.d[1];
    for (uint16_t i = 0; i < k.outWidth; ++i) k.out[i] = initial ? k.rp[k.rpCount == 1 ? 0 : i] : k.input(0, i);
}
void icUpdate(KernelContext& k) {
    if (k.d[0] != 0.0) return;
    k.d[0] = 1.0;
    k.d[1] = static_cast<double>(k.tNs);
}

// ---- Data Type Conversion (emulação no domínio do valor): ip = [tipo, arredondamento, satura,
// inteiro armazenado]; rp = [inclinação, viés, qmin, qmax] (tipo 4). Tipos: 0 double/herdado
// (identidade), 1 single (IEEE, arredonda ao par mais próximo), 2 half (IEEE binário de 16 bits), 3
// boolean (u ~= 0), 4 inteiro/ponto fixo: q = R((u - viés)/inclinação) (ou q = R(u) com Stored
// Integer), q saturado em [qmin, qmax] ou com estouro circular módulo 2^bits; y = q*inclinação +
// viés. R = modo de arredondamento (RndMeth). NaN -> 0 armazenado; +-Inf -> qmax/qmin. ----
enum ConversionKind : int64_t { ConvertIdentity = 0, ConvertSingle, ConvertHalf, ConvertBoolean, ConvertFixed };
enum RoundMode : int64_t { RoundCeiling = 0, RoundConvergent, RoundFloor, RoundNearest, RoundRound, RoundSimplest, RoundZero };

double roundWith(int64_t mode, double x) {
    switch (mode) {
    case RoundCeiling: return std::ceil(x);
    case RoundFloor: return std::floor(x);
    case RoundNearest: return std::floor(x + 0.5);
    case RoundRound: return std::round(x);
    case RoundConvergent: {
        const double lower = std::floor(x);
        const double fraction = x - lower;
        if (fraction > 0.5) return lower + 1.0;
        if (fraction < 0.5) return lower;
        return std::fmod(lower, 2.0) == 0.0 ? lower : lower + 1.0;
    }
    default: return std::trunc(x); // Zero; Simplest em conversão de ponto flutuante para inteiro
    }
}

/** IEEE 754 binário de 16 bits (half): 11 bits de mantissa, expoente mínimo -14, máximo 65504. */
double toHalf(double x) {
    if (!std::isfinite(x) || x == 0.0) return x;
    const double magnitude = std::abs(x);
    if (magnitude >= 65520.0) return std::copysign(std::numeric_limits<double>::infinity(), x);
    int exponent = 0;
    std::frexp(magnitude, &exponent); // magnitude = m * 2^exponent, m em [0.5, 1)
    const int unbiased = std::max(exponent - 1, -14);
    const double ulp = std::ldexp(1.0, unbiased - 10);
    return std::copysign(roundWith(RoundConvergent, magnitude / ulp) * ulp, x);
}

double convertValue(const KernelContext& k, double u) {
    switch (k.ip[0]) {
    case ConvertSingle: return static_cast<double>(static_cast<float>(u));
    case ConvertHalf: return toHalf(u);
    case ConvertBoolean: return u != 0.0 ? 1.0 : 0.0;
    case ConvertFixed: {
        const double slope = k.rp[0], bias = k.rp[1], qmin = k.rp[2], qmax = k.rp[3];
        double q;
        if (std::isnan(u)) q = 0.0;
        else if (std::isinf(u)) q = u > 0 ? qmax : qmin;
        else {
            q = roundWith(k.ip[1], k.ip[3] != 0 ? u : (u - bias) / slope);
            if (q < qmin || q > qmax) {
                if (k.ip[2] != 0) q = q < qmin ? qmin : qmax;
                else {
                    const double range = qmax - qmin + 1.0;
                    double wrapped = std::fmod(q - qmin, range);
                    if (wrapped < 0.0) wrapped += range;
                    q = qmin + wrapped;
                }
            }
        }
        return q * slope + bias;
    }
    default: return u;
    }
}

KernelShape conversionConfigure(const KernelConfig& c) {
    requireInputs(c, 1, "Data Type Conversion");
    requireExpandable(c, "Data Type Conversion");
    if (c.intParameters.size() != 4 || c.intParameters[0] < ConvertIdentity || c.intParameters[0] > ConvertFixed ||
        c.intParameters[1] < RoundCeiling || c.intParameters[1] > RoundZero)
        fail("Data Type Conversion: parametros internos invalidos");
    if (c.intParameters[0] == ConvertFixed &&
        (c.realParameters.size() != 4 || !(c.realParameters[0] > 0.0) || !(c.realParameters[2] <= c.realParameters[3])))
        fail("Data Type Conversion: escala de ponto fixo invalida");
    return {0, 0, {1}};
}
void conversionOutputs(KernelContext& k) { for (uint16_t i = 0; i < k.outWidth; ++i) k.out[i] = convertValue(k, k.input(0, i)); }

// ---- Valor de atributo constante (Width, saídas do Probe): sem entradas; rp = valores (largura). ----
KernelShape attributeValueConfigure(const KernelConfig& c) {
    requireInputs(c, 0, "atributo");
    if (c.realParameters.size() != c.outputWidth) fail("atributo: largura incompativel");
    return {0, 0, {}};
}
void attributeValueOutputs(KernelContext& k) { for (uint16_t i = 0; i < k.outWidth; ++i) k.out[i] = k.rp[i]; }

// ---- Weighted Sample Time: ip = [operação]; rp = [Ts*w]. Operações: 0 '+' (u + Ts*w), 1 '-'
// (u - Ts*w), 2 '*' (u*(Ts*w)), 3 '/' (u/(Ts*w)), 4 'Ts Only' (Ts*w), 5 '1/Ts Only' (1/(Ts*w)). ----
KernelShape weightedConfigure(const KernelConfig& c) {
    requireInputs(c, 1, "Weighted Sample Time");
    if (c.intParameters.size() != 1 || c.intParameters[0] < 0 || c.intParameters[0] > 5 || c.realParameters.size() != 1)
        fail("Weighted Sample Time: parametros internos invalidos");
    if (c.intParameters[0] >= 4 ? c.outputWidth != 1 : c.outputWidth != c.inputWidths[0]) fail("Weighted Sample Time: largura incompativel");
    return {0, 0, {static_cast<uint8_t>(c.intParameters[0] >= 4 ? 0 : 1)}};
}
void weightedOutputs(KernelContext& k) {
    const double weighted = k.rp[0];
    switch (k.ip[0]) {
    case 4: k.out[0] = weighted; return;
    case 5: k.out[0] = 1.0 / weighted; return;
    default: break;
    }
    for (uint16_t i = 0; i < k.outWidth; ++i) {
        const double u = k.in[0][i];
        k.out[i] = k.ip[0] == 0 ? u + weighted : k.ip[0] == 1 ? u - weighted : k.ip[0] == 2 ? u * weighted : u / weighted;
    }
}

const KernelSpec kIc{"ic", icConfigure, icInit, icOutputs, icUpdate, nullptr, nullptr};
const KernelSpec kConversion{"data_type_conversion", conversionConfigure, nullptr, conversionOutputs, nullptr, nullptr, nullptr};
const KernelSpec kAttributeValue{"attribute_value", attributeValueConfigure, nullptr, attributeValueOutputs, nullptr, nullptr, nullptr};
const KernelSpec kWeighted{"weighted_sample_time", weightedConfigure, nullptr, weightedOutputs, nullptr, nullptr, nullptr};

const KernelSpec* const kAttributes[] = {&kIc, &kConversion, &kAttributeValue, &kWeighted};
} // namespace

std::span<const KernelSpec* const> attributeKernels() { return kAttributes; }

} // namespace lasecsimul::simulation::library
