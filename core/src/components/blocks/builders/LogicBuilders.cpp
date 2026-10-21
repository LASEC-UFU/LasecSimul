// Logic and Bit Operations: parâmetros oficiais -> kernels de `simulation/library/kernels/LogicKernels.cpp`.
// Saídas lógicas são `double` 0/1 (docs/66 §4.6); os parâmetros de tipo de dado (OutDataTypeStr,
// AllPortsSameDT, InputSameDT, RndMeth) não existem aqui porque o engine só tem `double`.
#include "BuilderCommon.hpp"

namespace lasecsimul::components::blocks::builders {
namespace {

int64_t indexOf(const BuildContext& c, const std::string& value, std::initializer_list<const char*> options, const char* what) {
    int64_t index = 0;
    for (const char* option : options) {
        if (value == option) return index;
        ++index;
    }
    c.fail(std::string(what) + " invalido: " + value);
}

void buildLogicalOperator(BuildContext& c) {
    const int64_t op = indexOf(c, c.text("Operator"), {"AND", "OR", "NAND", "NOR", "XOR", "NXOR", "NOT"}, "Operator");
    if (op != 6) {
        const double inputs = c.scalar("Inputs");
        if (!(inputs >= 1.0) || inputs != std::floor(inputs)) c.fail("Number of input ports precisa ser inteiro positivo");
    }
    if (c.inputPorts.empty()) c.fail("sem entradas");
    const bool collapse = op != 6 && c.inputPorts.size() == 1;
    simpleKernel(c, "logical_operator", collapse ? 1 : elementwiseWidth(c), {}, {op, collapse ? 1 : 0});
}

void relationalKernel(BuildContext& c, int64_t op, std::vector<double> constant) {
    const bool hasConstant = !constant.empty();
    const uint16_t width = elementwiseWidth(c, {hasConstant ? constant.size() : 1});
    if (hasConstant && constant.size() != 1 && constant.size() != width)
        c.fail("Constant value: largura " + std::to_string(constant.size()) + " incompativel com o sinal (" + std::to_string(width) + ")");
    simpleKernel(c, "relational_operator", width, std::move(constant), {op, c.flag("ZeroCross") ? 1 : 0, hasConstant ? 1 : 0});
}

constexpr std::initializer_list<const char*> kRelOps = {"==", "~=", "<", "<=", ">=", ">", "isInf", "isNaN", "isFinite"};

void buildRelationalOperator(BuildContext& c) { relationalKernel(c, indexOf(c, c.text("Operator"), kRelOps, "Relational operator"), {}); }

void buildCompareToConstant(BuildContext& c) {
    const int64_t op = indexOf(c, c.text("relop"), {"==", "~=", "<", "<=", ">=", ">"}, "Operator");
    std::vector<double> constant = c.value("const").linear();
    if (constant.empty()) c.fail("Constant value vazio");
    relationalKernel(c, op, std::move(constant));
}

void buildCompareToZero(BuildContext& c) {
    relationalKernel(c, indexOf(c, c.text("relop"), {"==", "~=", "<", "<=", ">=", ">"}, "Operator"), {0.0});
}

void detectBlock(BuildContext& c, int64_t kind) {
    if (c.resolution.rate.continuous())
        c.fail("exige tempo de amostragem discreto (tempo continuo nao e suportado pelo bloco)");
    const std::vector<double> vinit = c.value("vinit").linear();
    if (vinit.empty()) c.fail("Initial condition vazia");
    const uint16_t width = elementwiseWidth(c, {vinit.size()});
    if (vinit.size() != 1 && vinit.size() != width) c.fail("Initial condition: largura incompativel com o sinal");
    simpleKernel(c, "detect", width, vinit, {kind});
}

void buildIntervalTest(BuildContext& c) {
    const std::vector<double> upper = c.value("uplimit").linear(), lower = c.value("lowlimit").linear();
    if (upper.empty() || lower.empty()) c.fail("limites vazios");
    const uint16_t width = elementwiseWidth(c, {upper.size(), lower.size()});
    if ((upper.size() != 1 && upper.size() != width) || (lower.size() != 1 && lower.size() != width)) c.fail("limites com largura incompativel com o sinal");
    std::vector<double> rp = upper;
    rp.insert(rp.end(), lower.begin(), lower.end());
    simpleKernel(c, "interval_test", width, rp,
                 {c.flag("IntervalClosedRight") ? 1 : 0, c.flag("IntervalClosedLeft") ? 1 : 0, 0, static_cast<int64_t>(upper.size())});
}

void buildIntervalTestDynamic(BuildContext& c) {
    simpleKernel(c, "interval_test", elementwiseWidth(c), {}, {c.flag("IntervalClosedRight") ? 1 : 0, c.flag("IntervalClosedLeft") ? 1 : 0, 1, 0});
}

void buildCombinatorialLogic(BuildContext& c) {
    const lib::ParamValue table = c.value("TruthTable");
    if (table.empty()) c.fail("Truth table vazia");
    size_t m = 0;
    while ((size_t{1} << m) < table.rows && m < 21) ++m;
    if ((size_t{1} << m) != table.rows || m < 1 || m > 20)
        c.fail("Truth table precisa ter 2^m linhas (m entradas, 1 <= m <= 20); tem " + std::to_string(table.rows));
    const uint16_t input = c.inputWidth(0);
    if (input != m)
        c.fail("largura da entrada (" + std::to_string(input) + ") incompativel com a tabela verdade de " + std::to_string(table.rows) +
               " linhas (exige " + std::to_string(m) + " elementos)");
    simpleKernel(c, "combinatorial_logic", static_cast<uint16_t>(table.cols), table.data, {static_cast<int64_t>(m), static_cast<int64_t>(table.cols)});
}

} // namespace

void registerLogicBuilders(BuilderTable& table) {
    table.add("logical_operator", buildLogicalOperator);
    table.add("relational_operator", buildRelationalOperator);
    table.add("compare_to_constant", buildCompareToConstant);
    table.add("compare_to_zero", buildCompareToZero);
    table.add("detect_change", [](BuildContext& c) { detectBlock(c, 0); });
    table.add("detect_decrease", [](BuildContext& c) { detectBlock(c, 1); });
    table.add("detect_increase", [](BuildContext& c) { detectBlock(c, 2); });
    table.add("detect_fall_negative", [](BuildContext& c) { detectBlock(c, 3); });
    table.add("detect_fall_nonpositive", [](BuildContext& c) { detectBlock(c, 4); });
    table.add("detect_rise_nonnegative", [](BuildContext& c) { detectBlock(c, 5); });
    table.add("detect_rise_positive", [](BuildContext& c) { detectBlock(c, 6); });
    table.add("interval_test", buildIntervalTest);
    table.add("interval_test_dynamic", buildIntervalTestDynamic);
    table.add("combinatorial_logic", buildCombinatorialLogic);
}

} // namespace lasecsimul::components::blocks::builders
