// User-Defined Functions: Fcn (expressão compilada para bytecode pelo builder do bloco).
#include <cmath>
#include <limits>

#include "../KernelCommon.hpp"
#include "Families.hpp"
#include "KernelOps.hpp"

namespace lasecsimul::simulation::library {
namespace {
using namespace detail;

KernelShape fcnConfigure(const KernelConfig& c) {
    requireInputs(c, 1, "Fcn");
    if (c.outputWidth != 1) fail("Fcn: saida e sempre escalar");
    if (c.intParameters.size() < 3 || c.intParameters.size() % 2 != 1) fail("Fcn: programa invalido");
    const int64_t depth = c.intParameters[0];
    if (depth < 1 || depth > 256) fail("Fcn: expressao profunda demais");
    for (size_t i = 1; i < c.intParameters.size(); i += 2) {
        const int64_t op = c.intParameters[i], arg = c.intParameters[i + 1];
        if (op < 0 || op >= FcnOpCount) fail("Fcn: operacao invalida");
        if (op == FcnPushConst && (arg < 0 || static_cast<size_t>(arg) >= c.realParameters.size())) fail("Fcn: constante invalida");
        if (op == FcnPushInput && (arg < 0 || arg >= c.inputWidths[0]))
            fail("Fcn: u(" + std::to_string(arg + 1) + ") fora da largura da entrada (" + std::to_string(c.inputWidths[0]) + ")");
    }
    return {0, static_cast<uint32_t>(depth), {1}};
}

void fcnOutputs(KernelContext& k) {
    double* stack = k.d;
    int64_t top = 0;
    const auto b = [](bool value) { return value ? 1.0 : 0.0; };
    for (uint32_t i = 1; i < k.ipCount; i += 2) {
        const int64_t op = k.ip[i], arg = k.ip[i + 1];
        switch (op) {
        case FcnPushConst: stack[top++] = k.rp[arg]; continue;
        case FcnPushInput: stack[top++] = k.in[0][arg]; continue;
        case FcnNeg: stack[top - 1] = -stack[top - 1]; continue;
        case FcnNot: stack[top - 1] = b(stack[top - 1] == 0.0); continue;
        case FcnAbs: stack[top - 1] = std::abs(stack[top - 1]); continue;
        case FcnAcos: stack[top - 1] = std::acos(stack[top - 1]); continue;
        case FcnAsin: stack[top - 1] = std::asin(stack[top - 1]); continue;
        case FcnAtan: stack[top - 1] = std::atan(stack[top - 1]); continue;
        case FcnCeil: stack[top - 1] = std::ceil(stack[top - 1]); continue;
        case FcnCos: stack[top - 1] = std::cos(stack[top - 1]); continue;
        case FcnCosh: stack[top - 1] = std::cosh(stack[top - 1]); continue;
        case FcnExp: stack[top - 1] = std::exp(stack[top - 1]); continue;
        case FcnFloor: stack[top - 1] = std::floor(stack[top - 1]); continue;
        case FcnLog: stack[top - 1] = std::log(stack[top - 1]); continue;
        case FcnLog10: stack[top - 1] = std::log10(stack[top - 1]); continue;
        case FcnSgn: stack[top - 1] = sgn(stack[top - 1]); continue;
        case FcnSin: stack[top - 1] = std::sin(stack[top - 1]); continue;
        case FcnSinh: stack[top - 1] = std::sinh(stack[top - 1]); continue;
        case FcnSqrt: stack[top - 1] = std::sqrt(stack[top - 1]); continue;
        case FcnTan: stack[top - 1] = std::tan(stack[top - 1]); continue;
        case FcnTanh: stack[top - 1] = std::tanh(stack[top - 1]); continue;
        default: break;
        }
        const double y = stack[--top];
        double& x = stack[top - 1];
        switch (op) {
        case FcnAdd: x = x + y; break;
        case FcnSub: x = x - y; break;
        case FcnMul: x = x * y; break;
        case FcnDiv: x = x / y; break;
        case FcnPow: x = std::pow(x, y); break;
        case FcnGt: x = b(x > y); break;
        case FcnLt: x = b(x < y); break;
        case FcnGe: x = b(x >= y); break;
        case FcnLe: x = b(x <= y); break;
        case FcnEq: x = b(x == y); break;
        case FcnNe: x = b(x != y); break;
        case FcnAnd: x = b(x != 0.0 && y != 0.0); break;
        case FcnOr: x = b(x != 0.0 || y != 0.0); break;
        case FcnAtan2: x = std::atan2(x, y); break;
        case FcnHypot: x = std::hypot(x, y); break;
        case FcnRem: x = y == 0.0 ? std::numeric_limits<double>::quiet_NaN() : x - std::trunc(x / y) * y; break;
        default: x = std::numeric_limits<double>::quiet_NaN(); break;
        }
    }
    k.out[0] = stack[0];
}

const KernelSpec kFcn{"fcn", fcnConfigure, nullptr, fcnOutputs, nullptr, nullptr, nullptr};
const KernelSpec* const kUserDefined[] = {&kFcn};
} // namespace

std::span<const KernelSpec* const> userDefinedKernels() { return kUserDefined; }

} // namespace lasecsimul::simulation::library
