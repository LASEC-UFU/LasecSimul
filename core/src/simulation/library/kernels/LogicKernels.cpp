// Logic and Bit Operations. Sinais lógicos são `double` 0/1 (docs/66 §4.6: equivale a "Implement
// logic signals as Boolean data" desligado); uma entrada é verdadeira quando é diferente de zero.
// Não há tipos inteiros no engine, então os blocos de bits (Bit Set/Clear, Bitwise Operator, Shift
// Arithmetic, Extract Bits...) não existem aqui.
// Blocos de comparação com `ZeroCross` ligado (Relational Operator, Compare To Constant/Zero) só
// trocam a saída em passo MAIOR: nos estágios menores do integrador a saída fica no valor do último
// passo maior, como o Simulink faz com a detecção de cruzamento ligada (sem a localização do
// instante, que o engine não tem -- docs/66). Com `ZeroCross` desligado a comparação é direta.
#include <algorithm>
#include <cmath>

#include "../KernelCommon.hpp"
#include "Families.hpp"

namespace lasecsimul::simulation::library {
namespace {
using namespace detail;

inline bool truth(double value) { return value != 0.0; }
inline double logical(bool value) { return value ? 1.0 : 0.0; }

// ---- Logical Operator: ip = [op, collapse]. op: AND, OR, NAND, NOR, XOR, NXOR, NOT.
// Várias entradas: elemento a elemento com expansão escalar. Uma entrada (op != NOT): o operador
// reduz os elementos do vetor (saída escalar). XOR = número ímpar de verdadeiros; NXOR = par.
enum LogicOp : int64_t { LogicAnd = 0, LogicOr, LogicNand, LogicNor, LogicXor, LogicNxor, LogicNot, LogicOpCount };
KernelShape logicalConfigure(const KernelConfig& c) {
    if (c.intParameters.size() != 2 || c.intParameters[0] < 0 || c.intParameters[0] >= LogicOpCount) fail("Logical Operator: operador invalido");
    if (c.inputWidths.empty()) fail("Logical Operator: sem entradas");
    const bool collapse = c.intParameters[1] != 0;
    if (c.intParameters[0] == LogicNot && c.inputWidths.size() != 1) fail("Logical Operator: NOT tem exatamente uma entrada");
    if (collapse) {
        if (c.inputWidths.size() != 1 || c.outputWidth != 1) fail("Logical Operator: reducao exige uma entrada e saida escalar");
    } else {
        requireExpandable(c, "Logical Operator");
    }
    return {0, 0, allFeedthrough(c.inputWidths.size())};
}
double logicReduce(int64_t op, size_t trueCount, size_t total) {
    switch (op) {
    case LogicAnd: return logical(trueCount == total);
    case LogicOr: return logical(trueCount > 0);
    case LogicNand: return logical(trueCount != total);
    case LogicNor: return logical(trueCount == 0);
    case LogicXor: return logical(trueCount % 2 == 1);
    case LogicNxor: return logical(trueCount % 2 == 0);
    default: return logical(trueCount == 0); // NOT de um elemento
    }
}
void logicalOutputs(KernelContext& k) {
    const int64_t op = k.ip[0];
    if (k.ip[1] != 0) {
        size_t count = 0;
        for (uint16_t i = 0; i < k.inWidth[0]; ++i) count += truth(k.in[0][i]) ? 1 : 0;
        k.out[0] = logicReduce(op, count, k.inWidth[0]);
        return;
    }
    for (uint16_t i = 0; i < k.outWidth; ++i) {
        size_t count = 0;
        for (uint16_t port = 0; port < k.inputCount; ++port) count += truth(k.input(port, i)) ? 1 : 0;
        k.out[i] = logicReduce(op, count, k.inputCount);
    }
}

// ---- Relational Operator / Compare To Constant / Compare To Zero: ip = [op, zeroCross, constante].
// op: ==, ~=, <, <=, >=, >, isInf, isNaN, isFinite. Entradas: [u1, u2] (Relational binário), [u] com
// a constante em rp (Compare To Constant/Zero: rp = const, 1 ou n) ou [u] unário (isInf...).
// d = [y comprometido x n] (saída congelada nos estágios menores quando zeroCross).
enum RelOp : int64_t { RelEq = 0, RelNe, RelLt, RelLe, RelGe, RelGt, RelIsInf, RelIsNan, RelIsFinite, RelOpCount };
KernelShape relationalConfigure(const KernelConfig& c) {
    if (c.intParameters.size() != 3 || c.intParameters[0] < 0 || c.intParameters[0] >= RelOpCount) fail("Relational Operator: operador invalido");
    const int64_t op = c.intParameters[0];
    const bool constant = c.intParameters[2] != 0;
    const size_t expected = op >= RelIsInf || constant ? 1 : 2;
    requireInputs(c, expected, "Relational Operator");
    requireExpandable(c, "Relational Operator");
    if (constant && c.realParameters.size() != 1 && c.realParameters.size() != c.outputWidth) fail("Compare To Constant: constante com largura incompativel");
    return {0, c.outputWidth, allFeedthrough(expected)};
}
double relational(int64_t op, double a, double b) {
    switch (op) {
    case RelEq: return logical(a == b);
    case RelNe: return logical(a != b);
    case RelLt: return logical(a < b);
    case RelLe: return logical(a <= b);
    case RelGe: return logical(a >= b);
    case RelGt: return logical(a > b);
    case RelIsInf: return logical(std::isinf(a));
    case RelIsNan: return logical(std::isnan(a));
    default: return logical(std::isfinite(a));
    }
}
double relationalValue(const KernelContext& k, uint16_t i) {
    const int64_t op = k.ip[0];
    const double a = k.input(0, i);
    if (op >= RelIsInf) return relational(op, a, 0.0);
    const double b = k.ip[2] != 0 ? k.rp[k.rpCount == 1 ? 0 : i] : k.input(1, i);
    return relational(op, a, b);
}
void relationalOutputs(KernelContext& k) {
    const bool frozen = !k.major && k.ip[1] != 0;
    for (uint16_t i = 0; i < k.outWidth; ++i) k.out[i] = frozen ? k.d[i] : relationalValue(k, i);
}
void relationalUpdate(KernelContext& k) { for (uint16_t i = 0; i < k.outWidth; ++i) k.d[i] = relationalValue(k, i); }

// ---- Detect Change/Decrease/Increase e Detect Fall/Rise: ip = [tipo]; rp = vinit (1 ou n).
// d = [memória x n]. Tipos 0..2 guardam a entrada anterior U/z (inicial = vinit):
//   Change: y = u ~= U/z; Decrease: y = u < U/z; Increase: y = u > U/z.
// Tipos 3..6 guardam o booleano anterior da expressão (inicial = vinit ~= 0):
//   Fall Negative: y = (u < 0) & ~(U/z < 0); Fall Nonpositive: (u <= 0) & ~(U/z <= 0);
//   Rise Nonnegative: (u >= 0) & ~(U/z >= 0); Rise Positive: (u > 0) & ~(U/z > 0).
enum DetectKind : int64_t { DetChange = 0, DetDecrease, DetIncrease, DetFallNegative, DetFallNonpositive, DetRiseNonnegative, DetRisePositive, DetCount };
KernelShape detectConfigure(const KernelConfig& c) {
    requireInputs(c, 1, "Detect");
    requireExpandable(c, "Detect");
    if (c.intParameters.size() != 1 || c.intParameters[0] < 0 || c.intParameters[0] >= DetCount) fail("Detect: tipo invalido");
    if (c.realParameters.size() != 1 && c.realParameters.size() != c.outputWidth) fail("Detect: Initial condition com largura incompativel");
    if (!(c.samplePeriod > 0.0)) fail("Detect: exige tempo de amostragem discreto");
    return {0, c.outputWidth, {1}};
}
bool detectFlag(int64_t kind, double u) {
    switch (kind) {
    case DetFallNegative: return u < 0.0;
    case DetFallNonpositive: return u <= 0.0;
    case DetRiseNonnegative: return u >= 0.0;
    default: return u > 0.0;
    }
}
void detectInit(KernelContext& k) {
    const int64_t kind = k.ip[0];
    for (uint16_t i = 0; i < k.outWidth; ++i) {
        const double vinit = k.rp[k.rpCount == 1 ? 0 : i];
        k.d[i] = kind <= DetIncrease ? vinit : logical(truth(vinit));
    }
}
void detectOutputs(KernelContext& k) {
    const int64_t kind = k.ip[0];
    for (uint16_t i = 0; i < k.outWidth; ++i) {
        const double u = k.input(0, i), memory = k.d[i];
        switch (kind) {
        case DetChange: k.out[i] = logical(u != memory); break;
        case DetDecrease: k.out[i] = logical(u < memory); break;
        case DetIncrease: k.out[i] = logical(u > memory); break;
        default: k.out[i] = logical(detectFlag(kind, u) && !truth(memory)); break;
        }
    }
}
void detectUpdate(KernelContext& k) {
    const int64_t kind = k.ip[0];
    for (uint16_t i = 0; i < k.outWidth; ++i) {
        const double u = k.input(0, i);
        k.d[i] = kind <= DetIncrease ? u : logical(detectFlag(kind, u));
    }
}

// ---- Interval Test / Interval Test Dynamic: ip = [fechadoDireita, fechadoEsquerda, dinâmico, nUp].
// Estático: rp = [uplimit x nUp, lowlimit x nLow], entrada [u]. Dinâmico: entradas [up, u, lo].
// y = (lo <= u ou lo < u) & (u <= up ou u < up) conforme os intervalos fechados/abertos.
KernelShape intervalConfigure(const KernelConfig& c) {
    if (c.intParameters.size() != 4) fail("Interval Test: parametros internos invalidos");
    const bool dynamic = c.intParameters[2] != 0;
    requireInputs(c, dynamic ? 3 : 1, "Interval Test");
    requireExpandable(c, "Interval Test");
    if (!dynamic) {
        const auto nUp = static_cast<size_t>(c.intParameters[3]);
        if (nUp == 0 || nUp >= c.realParameters.size()) fail("Interval Test: limites invalidos");
        const size_t nLow = c.realParameters.size() - nUp;
        if ((nUp != 1 && nUp != c.outputWidth) || (nLow != 1 && nLow != c.outputWidth)) fail("Interval Test: limites com largura incompativel");
    }
    return {0, 0, allFeedthrough(dynamic ? 3 : 1)};
}
void intervalOutputs(KernelContext& k) {
    const bool closedRight = k.ip[0] != 0, closedLeft = k.ip[1] != 0, dynamic = k.ip[2] != 0;
    const auto nUp = static_cast<size_t>(k.ip[3]);
    const size_t nLow = k.rpCount - nUp;
    for (uint16_t i = 0; i < k.outWidth; ++i) {
        double upper, u, lower;
        if (dynamic) { upper = k.input(0, i); u = k.input(1, i); lower = k.input(2, i); }
        else { upper = k.rp[nUp == 1 ? 0 : i]; u = k.input(0, i); lower = k.rp[nUp + (nLow == 1 ? 0 : i)]; }
        const bool left = closedLeft ? lower <= u : lower < u;
        const bool right = closedRight ? u <= upper : u < upper;
        k.out[i] = logical(left && right);
    }
}

// ---- Combinatorial Logic: ip = [m, colunas]; rp = TruthTable em ordem de linha (2^m linhas).
// linha = 1 + u(m)*2^0 + u(m-1)*2^1 + ... + u(1)*2^(m-1) (cada u(i) vale 1 se ~= 0); y = linha da tabela.
KernelShape combinatorialConfigure(const KernelConfig& c) {
    requireInputs(c, 1, "Combinatorial Logic");
    if (c.intParameters.size() != 2) fail("Combinatorial Logic: parametros internos invalidos");
    const auto m = static_cast<size_t>(c.intParameters[0]), columns = static_cast<size_t>(c.intParameters[1]);
    if (m < 1 || m > 20 || c.inputWidths[0] != m) fail("Combinatorial Logic: largura da entrada incompativel com a tabela verdade");
    if (columns < 1 || c.outputWidth != columns || c.realParameters.size() != (size_t{1} << m) * columns)
        fail("Combinatorial Logic: tabela verdade com dimensao incompativel");
    return {0, 0, {1}};
}
void combinatorialOutputs(KernelContext& k) {
    const auto m = static_cast<size_t>(k.ip[0]), columns = static_cast<size_t>(k.ip[1]);
    size_t row = 0;
    for (size_t i = 0; i < m; ++i) row = (row << 1) | (truth(k.in[0][i]) ? 1u : 0u);
    for (size_t column = 0; column < columns; ++column) k.out[column] = k.rp[row * columns + column];
}

const KernelSpec kLogical{"logical_operator", logicalConfigure, nullptr, logicalOutputs, nullptr, nullptr, nullptr};
const KernelSpec kRelational{"relational_operator", relationalConfigure, nullptr, relationalOutputs, relationalUpdate, nullptr, nullptr};
const KernelSpec kDetect{"detect", detectConfigure, detectInit, detectOutputs, detectUpdate, nullptr, nullptr};
const KernelSpec kInterval{"interval_test", intervalConfigure, nullptr, intervalOutputs, nullptr, nullptr, nullptr};
const KernelSpec kCombinatorial{"combinatorial_logic", combinatorialConfigure, nullptr, combinatorialOutputs, nullptr, nullptr, nullptr};

const KernelSpec* const kLogic[] = {&kLogical, &kRelational, &kDetect, &kInterval, &kCombinatorial};
} // namespace

std::span<const KernelSpec* const> logicKernels() { return kLogic; }

} // namespace lasecsimul::simulation::library
