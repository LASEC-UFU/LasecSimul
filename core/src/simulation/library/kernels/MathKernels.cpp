// Operações matemáticas (biblioteca Math Operations). Entradas escalares expandem para a largura
// da saída; com UMA entrada e `collapse` (Sum "|+", Product "*", MinMax de 1 entrada) a operação
// reduz os elementos do vetor, como na documentação oficial.
#include <algorithm>
#include <cmath>
#include <limits>

#include "../KernelCommon.hpp"
#include "Families.hpp"
#include "KernelOps.hpp"

namespace lasecsimul::simulation::library {
namespace {
using namespace detail;

// ---- Gain: ip = [mode, rows, cols]; rp = K (ordem de linha).
// mode 0: K.*u (elemento a elemento); 1: K*u; 2: u*K (u linha); 3: K*u com u vetor (= 1).
KernelShape gainConfigure(const KernelConfig& c) {
    requireInputs(c, 1, "Gain");
    if (c.intParameters.size() != 3) fail("Gain: parametros internos invalidos");
    const auto mode = c.intParameters[0];
    const size_t rows = static_cast<size_t>(c.intParameters[1]), cols = static_cast<size_t>(c.intParameters[2]);
    if (rows * cols != c.realParameters.size() || c.realParameters.empty()) fail("Gain: K vazio ou com dimensao inconsistente");
    if (mode == 0) {
        if (c.realParameters.size() != 1 && c.realParameters.size() != c.outputWidth) fail("Gain: K com largura incompativel com o sinal");
        requireExpandable(c, "Gain");
    } else if (mode == 1 || mode == 3) {
        if (c.inputWidths[0] != cols || c.outputWidth != rows) fail("Gain: K*u exige colunas(K) == largura(u)");
    } else if (mode == 2) {
        if (c.inputWidths[0] != rows || c.outputWidth != cols) fail("Gain: u*K exige largura(u) == linhas(K)");
    } else fail("Gain: modo de multiplicacao invalido");
    return {0, 0, {1}};
}
void gainOutputs(KernelContext& k) {
    const auto mode = k.ip[0];
    const size_t rows = static_cast<size_t>(k.ip[1]), cols = static_cast<size_t>(k.ip[2]);
    if (mode == 0) {
        for (uint16_t i = 0; i < k.outWidth; ++i) k.out[i] = k.rp[k.rpCount == 1 ? 0 : i] * k.input(0, i);
        return;
    }
    const double* u = k.in[0];
    if (mode == 2) {
        for (size_t c = 0; c < cols; ++c) { double sum = 0.0; for (size_t r = 0; r < rows; ++r) sum += u[r] * k.rp[r * cols + c]; k.out[c] = sum; }
        return;
    }
    for (size_t r = 0; r < rows; ++r) { double sum = 0.0; for (size_t c = 0; c < cols; ++c) sum += k.rp[r * cols + c] * u[c]; k.out[r] = sum; }
}

// ---- Sum: ip = [collapse]; rp = sinais (+1/-1) por entrada. ----
KernelShape sumConfigure(const KernelConfig& c) {
    if (c.inputWidths.empty() || c.realParameters.size() != c.inputWidths.size()) fail("Sum: lista de sinais incompativel com as entradas");
    if (c.intParameters.size() != 1) fail("Sum: parametros internos invalidos");
    if (c.intParameters[0] != 0) {
        if (c.inputWidths.size() != 1 || c.outputWidth != 1) fail("Sum: soma dos elementos exige uma entrada e saida escalar");
    } else requireExpandable(c, "Sum");
    return {0, 0, allFeedthrough(c.inputWidths.size())};
}
void sumOutputs(KernelContext& k) {
    if (k.ip[0] != 0) {
        double sum = 0.0;
        for (uint16_t i = 0; i < k.inWidth[0]; ++i) sum += k.in[0][i];
        k.out[0] = k.rp[0] * sum;
        return;
    }
    for (uint16_t i = 0; i < k.outWidth; ++i) {
        double sum = 0.0;
        for (uint16_t port = 0; port < k.inputCount; ++port) sum += k.rp[port] * k.input(port, i);
        k.out[i] = sum;
    }
}

// ---- Product: ip = [collapse]; rp = +1 (multiplica) / -1 (divide) por entrada (elemento a elemento). ----
KernelShape productConfigure(const KernelConfig& c) {
    if (c.inputWidths.empty() || c.realParameters.size() != c.inputWidths.size()) fail("Product: operadores incompativeis com as entradas");
    if (c.intParameters.size() != 1) fail("Product: parametros internos invalidos");
    if (c.intParameters[0] != 0) {
        if (c.inputWidths.size() != 1 || c.outputWidth != 1) fail("Product: produto dos elementos exige uma entrada e saida escalar");
    } else requireExpandable(c, "Product");
    return {0, 0, allFeedthrough(c.inputWidths.size())};
}
void productOutputs(KernelContext& k) {
    if (k.ip[0] != 0) {
        double product = 1.0;
        for (uint16_t i = 0; i < k.inWidth[0]; ++i) product *= k.in[0][i];
        k.out[0] = k.rp[0] > 0.0 ? product : 1.0 / product;
        return;
    }
    for (uint16_t i = 0; i < k.outWidth; ++i) {
        double product = 1.0;
        for (uint16_t port = 0; port < k.inputCount; ++port) {
            const double value = k.input(port, i);
            product = k.rp[port] > 0.0 ? product * value : product / value;
        }
        k.out[i] = product;
    }
}

// ---- Bias: rp = Bias (1 ou largura). y = u + Bias. ----
KernelShape biasConfigure(const KernelConfig& c) {
    requireInputs(c, 1, "Bias");
    requireExpandable(c, "Bias");
    if (c.realParameters.size() != 1 && c.realParameters.size() != c.outputWidth) fail("Bias: largura incompativel");
    return {0, 0, {1}};
}
void biasOutputs(KernelContext& k) {
    for (uint16_t i = 0; i < k.outWidth; ++i) k.out[i] = k.input(0, i) + k.rp[k.rpCount == 1 ? 0 : i];
}

// ---- Funções de um argumento: ip = [opcode]. Abs, Sign, Sqrt, Math Function, Trigonometric
// Function, Rounding Function, Unary Minus, Signal Conversion compartilham este kernel. ----
double applyUnary(int64_t op, double u) {
    switch (op) {
    case OpAbs: return std::abs(u);
    case OpSign: return sgn(u);
    case OpSqrt: return std::sqrt(u);
    case OpSignedSqrt: return sgn(u) * std::sqrt(std::abs(u));
    case OpRsqrt: return 1.0 / std::sqrt(u);
    case OpNegate: return -u;
    case OpExp: return std::exp(u);
    case OpLog: return std::log(u);
    case OpPow10: return std::pow(10.0, u);
    case OpLog10: return std::log10(u);
    case OpMagnitude2: case OpSquare: return u * u;
    case OpIdentity: return u;
    case OpReciprocal: return 1.0 / u;
    case OpSin: return std::sin(u);
    case OpCos: return std::cos(u);
    case OpTan: return std::tan(u);
    case OpAsin: return std::asin(u);
    case OpAcos: return std::acos(u);
    case OpAtan: return std::atan(u);
    case OpSinh: return std::sinh(u);
    case OpCosh: return std::cosh(u);
    case OpTanh: return std::tanh(u);
    case OpAsinh: return std::asinh(u);
    case OpAcosh: return std::acosh(u);
    case OpAtanh: return std::atanh(u);
    case OpFloor: return std::floor(u);
    case OpCeil: return std::ceil(u);
    case OpRound: return std::round(u);
    case OpFix: return std::trunc(u);
    case OpNot: return u == 0.0 ? 1.0 : 0.0;
    case OpPow2: return std::exp2(u);
    case OpAsinSat: return std::asin(std::clamp(u, -1.0, 1.0));
    case OpAcosSat: return std::acos(std::clamp(u, -1.0, 1.0));
    default: return std::numeric_limits<double>::quiet_NaN();
    }
}
KernelShape unaryConfigure(const KernelConfig& c) {
    requireInputs(c, 1, "funcao");
    if (c.intParameters.size() != 1 || c.intParameters[0] < 0 || c.intParameters[0] >= OpUnaryCount) fail("funcao: operacao invalida");
    requireExpandable(c, "funcao");
    return {0, 0, {1}};
}
void unaryOutputs(KernelContext& k) {
    for (uint16_t i = 0; i < k.outWidth; ++i) k.out[i] = applyUnary(k.ip[0], k.input(0, i));
}

// ---- Funções de dois argumentos: ip = [opcode] (Math Function pow/hypot/rem/mod, atan2). ----
// pow com "Signed power" (padrão do bloco): y = sign(u)*|u|^v; sem ele y = u^v (NaN para base
// negativa com expoente não inteiro). rem(u, 0) = NaN e mod(u, 0) = u, como no MATLAB.
KernelShape binaryConfigure(const KernelConfig& c) {
    requireInputs(c, 2, "funcao");
    if (c.intParameters.size() != 1 || c.intParameters[0] < 0 || c.intParameters[0] >= OpBinaryCount) fail("funcao: operacao invalida");
    requireExpandable(c, "funcao");
    return {0, 0, {1, 1}};
}
void binaryOutputs(KernelContext& k) {
    for (uint16_t i = 0; i < k.outWidth; ++i) {
        const double a = k.input(0, i), b = k.input(1, i);
        double y = 0.0;
        switch (k.ip[0]) {
        case OpPow: y = std::pow(a, b); break;
        case OpHypot: y = std::hypot(a, b); break;
        case OpRem: y = b == 0.0 ? std::numeric_limits<double>::quiet_NaN() : a - std::trunc(a / b) * b; break;
        case OpMod: y = b == 0.0 ? a : a - std::floor(a / b) * b; break;
        case OpAtan2: y = std::atan2(a, b); break;
        case OpSignedPow: y = sgn(a) * std::pow(std::abs(a), b); break;
        default: y = std::numeric_limits<double>::quiet_NaN(); break;
        }
        k.out[i] = y;
    }
}

// ---- MinMax: ip = [isMax, collapse]. ----
// NaN é ignorado (resultado NaN só se todos os valores comparados forem NaN), como na documentação.
double pickExtreme(bool isMax, double a, double b) {
    if (std::isnan(a)) return b;
    if (std::isnan(b)) return a;
    return isMax ? (b > a ? b : a) : (b < a ? b : a);
}
KernelShape minmaxConfigure(const KernelConfig& c) {
    if (c.inputWidths.empty() || c.intParameters.size() != 2) fail("MinMax: configuracao invalida");
    if (c.intParameters[1] != 0) {
        if (c.inputWidths.size() != 1 || c.outputWidth != 1) fail("MinMax: reducao exige uma entrada e saida escalar");
    } else requireExpandable(c, "MinMax");
    return {0, 0, allFeedthrough(c.inputWidths.size())};
}
void minmaxOutputs(KernelContext& k) {
    const bool isMax = k.ip[0] != 0;
    const auto pick = [isMax](double a, double b) { return pickExtreme(isMax, a, b); };
    if (k.ip[1] != 0) {
        double best = k.in[0][0];
        for (uint16_t i = 1; i < k.inWidth[0]; ++i) best = pick(best, k.in[0][i]);
        k.out[0] = best;
        return;
    }
    for (uint16_t i = 0; i < k.outWidth; ++i) {
        double best = k.input(0, i);
        for (uint16_t port = 1; port < k.inputCount; ++port) best = pick(best, k.input(port, i));
        k.out[i] = best;
    }
}

// ---- Polynomial: rp = coeficientes em potências decrescentes (polyval). ----
KernelShape polynomialConfigure(const KernelConfig& c) {
    requireInputs(c, 1, "Polynomial");
    requireExpandable(c, "Polynomial");
    if (c.realParameters.empty()) fail("Polynomial: coeficientes vazios");
    return {0, 0, {1}};
}
void polynomialOutputs(KernelContext& k) {
    for (uint16_t i = 0; i < k.outWidth; ++i) {
        const double u = k.input(0, i);
        double y = 0.0;
        for (uint32_t c = 0; c < k.rpCount; ++c) y = y * u + k.rp[c];
        k.out[i] = y;
    }
}

// ---- Dot Product: y = sum(u1 .* u2) (sinais reais: conj(u1) = u1). Larguras iguais. ----
KernelShape dotConfigure(const KernelConfig& c) {
    requireInputs(c, 2, "Dot Product");
    if (c.inputWidths[0] != c.inputWidths[1] || c.outputWidth != 1) fail("Dot Product: as entradas precisam ter a mesma largura");
    return {0, 0, {1, 1}};
}
void dotOutputs(KernelContext& k) {
    double sum = 0.0;
    for (uint16_t i = 0; i < k.inWidth[0]; ++i) sum += k.in[0][i] * k.in[1][i];
    k.out[0] = sum;
}

// ---- MinMax Running Resettable: ip = [isMax, n]; rp = vinit (1 ou n); d = [y anterior x n]. ----
// y_k = min/max(u_k, y_{k-1}) com y_{-1} = vinit; com R_k != 0: y_k = min/max(u_k, vinit) (a
// comparação recomeça da condição inicial). R escalar ou da largura de u. Em tempo contínuo
// y_{k-1} é o valor do último passo maior (como o Memory interno do bloco). NaN ignorado como no MinMax.
KernelShape runningConfigure(const KernelConfig& c) {
    requireInputs(c, 2, "MinMax Running Resettable");
    requireExpandable(c, "MinMax Running Resettable");
    if (c.intParameters.size() != 2 || static_cast<size_t>(c.intParameters[1]) != c.outputWidth)
        fail("MinMax Running Resettable: parametros internos invalidos");
    if (c.realParameters.size() != 1 && c.realParameters.size() != c.outputWidth)
        fail("MinMax Running Resettable: Initial condition com largura incompativel");
    return {0, c.outputWidth, {1, 1}};
}
void runningInit(KernelContext& k) { for (uint16_t i = 0; i < k.outWidth; ++i) k.d[i] = k.rp[k.rpCount == 1 ? 0 : i]; }
void runningOutputs(KernelContext& k) {
    const bool isMax = k.ip[0] != 0;
    for (uint16_t i = 0; i < k.outWidth; ++i) {
        const double base = k.input(1, i) != 0.0 ? k.rp[k.rpCount == 1 ? 0 : i] : k.d[i];
        k.out[i] = pickExtreme(isMax, k.input(0, i), base);
    }
}
void runningUpdate(KernelContext& k) { for (uint16_t i = 0; i < k.outWidth; ++i) k.d[i] = k.out[i]; }

// ---- Assignment (sinais 1-D): ip = [modo, base, temY0, temIdx, quantidade, índices...]. ----
// Entradas: [Y0], U, [Idx1]. Y = Y0 (ou zeros sem Y0, como o modo Normal do Simulink); depois
// Y(idx) = U. Modo 0 "Assign all" (Y(:) = U); 1 "Index vector (dialog)" (índices em ip, base 0);
// 2 "Index vector (port)" (Idx1 na base `base`); 3 "Starting index (dialog)" (Y(s:s+largura(U)-1) = U,
// s em ip, base 0); 4 "Starting index (port)". U escalar expande. Índice vindo de porta fora da
// faixa é ignorado (o Simulink para a simulação com erro; o engine não tem erro em tempo de execução).
enum AssignMode : int64_t { AssignAll = 0, AssignIndexDialog, AssignIndexPort, AssignStartDialog, AssignStartPort };
enum AssignIp : size_t { AsMode = 0, AsBase, AsHasY0, AsHasIdx, AsCount, AsIpHeader };

KernelShape assignmentConfigure(const KernelConfig& c) {
    if (c.intParameters.size() < AsIpHeader || c.intParameters[AsMode] < AssignAll || c.intParameters[AsMode] > AssignStartPort)
        fail("Assignment: parametros internos invalidos");
    const bool hasY0 = c.intParameters[AsHasY0] != 0, hasIdx = c.intParameters[AsHasIdx] != 0;
    requireInputs(c, 1 + (hasY0 ? 1 : 0) + (hasIdx ? 1 : 0), "Assignment");
    const size_t count = static_cast<size_t>(c.intParameters[AsCount]);
    if (c.intParameters.size() != AsIpHeader + count) fail("Assignment: parametros internos invalidos");
    if (hasY0 && c.inputWidths[0] != c.outputWidth) fail("Assignment: largura de Y0 difere da saida");
    const uint16_t uWidth = c.inputWidths[hasY0 ? 1 : 0];
    const int64_t mode = c.intParameters[AsMode];
    if ((mode == AssignAll && uWidth != 1 && uWidth != c.outputWidth) || (mode == AssignIndexDialog && uWidth != 1 && uWidth != count))
        fail("Assignment: largura de U incompativel com os indices");
    if (mode == AssignIndexPort && (!hasIdx || (uWidth != 1 && uWidth != c.inputWidths.back()))) fail("Assignment: largura de U difere da de Idx1");
    if (mode == AssignStartPort && (!hasIdx || c.inputWidths.back() != 1)) fail("Assignment: Idx1 (indice inicial) precisa ser escalar");
    if ((mode == AssignStartDialog && count != 1) || (mode == AssignStartDialog && c.intParameters[AsIpHeader] + uWidth > static_cast<int64_t>(c.outputWidth)))
        fail("Assignment: faixa fora do vetor de saida");
    for (size_t j = 0; j < count; ++j)
        if (c.intParameters[AsIpHeader + j] < 0 || static_cast<size_t>(c.intParameters[AsIpHeader + j]) >= c.outputWidth)
            fail("Assignment: indice fora da faixa da saida");
    return {0, 0, allFeedthrough(c.inputWidths.size())};
}
void assignmentOutputs(KernelContext& k) {
    const int64_t mode = k.ip[AsMode];
    const bool hasY0 = k.ip[AsHasY0] != 0;
    const uint16_t uPort = hasY0 ? 1 : 0;
    const uint16_t idxPort = static_cast<uint16_t>(uPort + 1);
    const double base = static_cast<double>(k.ip[AsBase]);
    for (uint16_t i = 0; i < k.outWidth; ++i) k.out[i] = hasY0 ? k.in[0][i] : 0.0;
    const auto assign = [&](double index, uint16_t element) {
        if (!std::isfinite(index) || index < 0.0 || index >= static_cast<double>(k.outWidth)) return;
        k.out[static_cast<size_t>(index)] = k.input(uPort, element);
    };
    switch (mode) {
    case AssignAll:
        for (uint16_t i = 0; i < k.outWidth; ++i) k.out[i] = k.input(uPort, i);
        break;
    case AssignIndexDialog:
        for (int64_t j = 0; j < k.ip[AsCount]; ++j) assign(static_cast<double>(k.ip[AsIpHeader + j]), static_cast<uint16_t>(j));
        break;
    case AssignIndexPort:
        for (uint16_t j = 0; j < k.inWidth[idxPort]; ++j) assign(std::round(k.in[idxPort][j]) - base, j);
        break;
    case AssignStartDialog:
    case AssignStartPort: {
        const double start = mode == AssignStartDialog ? static_cast<double>(k.ip[AsIpHeader]) : std::round(k.in[idxPort][0]) - base;
        for (uint16_t j = 0; j < k.inWidth[uPort]; ++j) assign(start + j, j);
        break;
    }
    default: break;
    }
}

const KernelSpec kGain{"gain", gainConfigure, nullptr, gainOutputs, nullptr, nullptr, nullptr};
const KernelSpec kSum{"sum", sumConfigure, nullptr, sumOutputs, nullptr, nullptr, nullptr};
const KernelSpec kProduct{"product", productConfigure, nullptr, productOutputs, nullptr, nullptr, nullptr};
const KernelSpec kBias{"bias", biasConfigure, nullptr, biasOutputs, nullptr, nullptr, nullptr};
const KernelSpec kUnary{"unary", unaryConfigure, nullptr, unaryOutputs, nullptr, nullptr, nullptr};
const KernelSpec kBinary{"binary", binaryConfigure, nullptr, binaryOutputs, nullptr, nullptr, nullptr};
const KernelSpec kMinMax{"minmax", minmaxConfigure, nullptr, minmaxOutputs, nullptr, nullptr, nullptr};
const KernelSpec kPolynomial{"polynomial", polynomialConfigure, nullptr, polynomialOutputs, nullptr, nullptr, nullptr};

const KernelSpec kDot{"dot_product", dotConfigure, nullptr, dotOutputs, nullptr, nullptr, nullptr};
const KernelSpec kRunning{"minmax_running", runningConfigure, runningInit, runningOutputs, runningUpdate, nullptr, nullptr};
const KernelSpec kAssignment{"assignment", assignmentConfigure, nullptr, assignmentOutputs, nullptr, nullptr, nullptr};

const KernelSpec* const kMath[] = {&kGain, &kSum, &kProduct, &kBias, &kUnary, &kBinary, &kMinMax, &kPolynomial,
                                   &kDot, &kRunning, &kAssignment};
} // namespace

std::span<const KernelSpec* const> mathKernels() { return kMath; }

} // namespace lasecsimul::simulation::library
