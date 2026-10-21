#pragma once

#include <cstdint>

// Códigos de operação compartilhados entre os kernels de função (`MathKernels.cpp`) e os builders
// que os escolhem a partir do parâmetro oficial (`Operator` do Math Function, Trigonometric
// Function, Rounding Function, Sqrt...). Um único lugar, para os dois lados nunca divergirem.
namespace lasecsimul::simulation::library {

enum UnaryOp : int64_t {
    OpAbs = 0, OpSign, OpSqrt, OpSignedSqrt, OpRsqrt, OpNegate, OpExp, OpLog, OpPow10, OpLog10, OpMagnitude2,
    OpSquare, OpIdentity, OpReciprocal, OpSin, OpCos, OpTan, OpAsin, OpAcos, OpAtan, OpSinh, OpCosh, OpTanh,
    OpAsinh, OpAcosh, OpAtanh, OpFloor, OpCeil, OpRound, OpFix, OpNot, OpPow2,
    // Acrescentados depois (códigos novos no fim; os anteriores não mudam): asin/acos com a proteção
    // padrão do Trigonometric Function (entrada saturada em [-1, 1] antes da função).
    OpAsinSat, OpAcosSat, OpUnaryCount
};

enum BinaryOp : int64_t {
    OpPow = 0, OpHypot, OpRem, OpMod, OpAtan2,
    // Acrescentado depois: pow do Math Function com "Signed power" (padrão): sign(u)*|u|^v.
    OpSignedPow, OpBinaryCount
};

/** Bytecode pós-fixo do bloco Fcn: `intParameters = [profundidade, op0, arg0, op1, arg1, ...]`,
 * `realParameters` = constantes. `arg` é o índice da constante (PushConst) ou do elemento de u
 * (PushInput, base 0); nas demais operações é ignorado. */
enum FcnOp : int64_t {
    FcnPushConst = 0, FcnPushInput, FcnNeg, FcnNot, FcnAdd, FcnSub, FcnMul, FcnDiv, FcnPow, FcnGt, FcnLt, FcnGe, FcnLe,
    FcnEq, FcnNe, FcnAnd, FcnOr, FcnAbs, FcnAcos, FcnAsin, FcnAtan, FcnAtan2, FcnCeil, FcnCos, FcnCosh, FcnExp, FcnFloor,
    FcnHypot, FcnLog, FcnLog10, FcnRem, FcnSgn, FcnSin, FcnSinh, FcnSqrt, FcnTan, FcnTanh, FcnOpCount
};

} // namespace lasecsimul::simulation::library
