#include <cstdio>
#include <string>
#include "session/PauseExpression.hpp"

using namespace lasecsimul::session;

int main() {
    int failures = 0;
    auto value = [](PauseSignalMode, const std::string& name) -> PauseScalar {
        if (name == "out") return 3.4;
        if (name == "GPIO23") return true;
        if (name == "DATA[3]") return uint64_t{1};
        if (name == "BUS[7:4]") return uint64_t{0xA};
        if (name == "CLK") return false;
        throw std::invalid_argument("símbolo desconhecido: " + name);
    };

    if (!PauseExpression::compile("V(out) > 3.3").evaluate(value).value) ++failures;
    if (!PauseExpression::compile("digital(GPIO23) == 1").evaluate(value).value) ++failures;
    if (!PauseExpression::compile("V(out) > 3.3 && (DATA[3] == 1 || false)").evaluate(value).value) ++failures;
    if (!PauseExpression::compile("BUS[7:4] == 0xA").evaluate(value).value) ++failures;
    if (PauseExpression::compile("false || true && false").evaluate(value).value) ++failures;

    bool invalidOperator = false;
    try { (void)PauseExpression::compile("V(out) + 1 > 2"); }
    catch (const PauseExpressionError& error) { invalidOperator = error.column == 8; }
    if (!invalidOperator) ++failures;

    bool unknown = false;
    try { (void)PauseExpression::compile("GPIO99 == 1").evaluate(value); }
    catch (const PauseExpressionError& error) { unknown = error.column == 1; }
    if (!unknown) ++failures;

    bool clock = false;
    auto edgeResolver = [&](PauseSignalMode, const std::string&) -> PauseScalar { return clock; };
    auto rising = PauseExpression::compile("rising(CLK)");
    if (rising.evaluate(edgeResolver).value) ++failures;
    clock = true;
    if (!rising.evaluate(edgeResolver).value) ++failures;
    if (rising.evaluate(edgeResolver).value) ++failures;
    auto falling = PauseExpression::compile("falling(CLK)");
    if (falling.evaluate(edgeResolver).value) ++failures;
    clock = false;
    if (!falling.evaluate(edgeResolver).value) ++failures;

    std::printf("Pause expression AST: %s\n", failures == 0 ? "OK" : "FALHOU");
    return failures == 0 ? 0 : 1;
}
