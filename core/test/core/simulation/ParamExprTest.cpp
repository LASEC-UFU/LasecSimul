#include <cmath>
#include <cstdio>
#include <fstream>
#include <string>

#include <nlohmann/json.hpp>

#include "simulation/library/ParamExpr.hpp"

using namespace lasecsimul::simulation::library;

namespace {
int failures = 0;
#define CHECK(expr, message) do { if (!(expr)) { std::fprintf(stderr, "FALHOU: %s -- %s\n", std::string(message).c_str(), #expr); ++failures; } } while (false)

double expectedNumber(const nlohmann::json& value) {
    if (value.is_string()) {
        const std::string text = value.get<std::string>();
        if (text == "Inf") return INFINITY;
        if (text == "-Inf") return -INFINITY;
        return NAN;
    }
    return value.get<double>();
}

bool sameNumber(double actual, double expected) {
    if (std::isnan(expected)) return std::isnan(actual);
    if (std::isinf(expected)) return actual == expected;
    return std::abs(actual - expected) <= 1e-12 * std::max(1.0, std::abs(expected));
}

/** Mesmos vetores que o avaliador TS da Extension usa (docs/66 §5). */
void sharedVectors() {
    std::ifstream input(PARAM_EXPR_VECTORS);
    CHECK(input.good(), "arquivo de vetores compartilhados existe");
    if (!input.good()) return;
    const nlohmann::json root = nlohmann::json::parse(input);
    for (const auto& vector : root.at("vectors")) {
        const std::string expr = vector.at("expr").get<std::string>();
        ParamWorkspace workspace;
        if (vector.contains("vars")) {
            for (const auto& [name, value] : vector.at("vars").items()) {
                std::vector<double> data;
                for (const auto& element : value.at("value")) data.push_back(expectedNumber(element));
                workspace.set(name, ParamValue::matrix(value.at("rows").get<size_t>(), value.at("cols").get<size_t>(), data));
            }
        }
        const bool expectError = vector.value("error", false);
        try {
            const ParamValue value = evaluateParam(expr, &workspace);
            CHECK(!expectError, "deveria recusar: " + expr);
            if (expectError) continue;
            CHECK(value.rows == vector.at("rows").get<size_t>() && value.cols == vector.at("cols").get<size_t>(),
                  "dimensao de '" + expr + "': " + std::to_string(value.rows) + "x" + std::to_string(value.cols));
            const auto& expected = vector.at("value");
            CHECK(value.data.size() == expected.size(), "quantidade de elementos de '" + expr + "'");
            for (size_t i = 0; i < std::min(value.data.size(), expected.size()); ++i)
                CHECK(sameNumber(value.data[i], expectedNumber(expected[i])), "elemento " + std::to_string(i) + " de '" + expr + "' = " + std::to_string(value.data[i]));
        } catch (const std::exception& error) {
            CHECK(expectError, "erro inesperado em '" + expr + "': " + error.what());
        }
    }
}

void errorsCarryColumn() {
    try {
        (void)evaluateParam("1 + foo");
        CHECK(false, "variavel inexistente recusada");
    } catch (const ParamError& error) {
        CHECK(error.column() == 5, "coluna apontada no identificador desconhecido");
    }
}

void helpers() {
    CHECK(evaluateScalarParam("Gain", "2*3") == 6.0, "atalho escalar");
    CHECK(evaluateVectorParam("Numerator", "[1 2 1]").size() == 3, "atalho vetor");
    bool rejected = false;
    try { (void)evaluateScalarParam("Gain", "[1 2]"); } catch (const std::invalid_argument&) { rejected = true; }
    CHECK(rejected, "atalho escalar recusa vetor");
    CHECK(formatParam(evaluateParam("[1 2; 3 4]")) == "[1 2; 3 4]", "formatacao de matriz");
    CHECK(formatParam(evaluateParam("0.1")) == "0.1", "formatacao de escalar");
    const ParamValue m = evaluateParam("[1 2; 3 4]");
    CHECK((m.linear() == std::vector<double>{1, 3, 2, 4}), "ordem linear por coluna como o MATLAB");
}

} // namespace

int main() {
    sharedVectors();
    errorsCarryColumn();
    helpers();
    if (failures == 0) std::puts("ParamExprTest: OK");
    return failures == 0 ? 0 : 1;
}
