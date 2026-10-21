// Math Operations: parâmetros oficiais -> kernels de `simulation/library/kernels/MathKernels.cpp`
// (e `concat` de RoutingKernels para Vector/Matrix Concatenate). Sinais só reais e 1-D: opções que
// produzem sinal complexo ou matriz são recusadas com mensagem explícita.
#include "BuilderCommon.hpp"
#include "simulation/library/kernels/KernelOps.hpp"

namespace lasecsimul::components::blocks::builders {
namespace {

constexpr double kTwoPi = 6.283185307179586476925286766559;

bool constantRate(const BuildContext& c) { return c.resolution.rate.periodNs >= simulation::kConstantSamplePeriodNs; }

double positiveInteger(const BuildContext& c, const char* name) {
    const double value = c.scalar(name);
    if (!(value >= 1.0) || value != std::floor(value) || value > 65536.0) c.fail(std::string(name) + " precisa ser inteiro >= 1");
    return value;
}

void rejectComplexOutput(const BuildContext& c) {
    if (c.spec.param("OutputSignalType") && c.text("OutputSignalType") == "complex")
        c.fail("Output signal type 'complex' nao suportado (o engine so tem sinais reais)");
}

/** Parameter minimum/maximum: verificação de faixa do parâmetro (o Simulink recusa valor fora). */
void checkParamRange(const BuildContext& c, const lib::ParamValue& value, const char* what) {
    const lib::ParamValue minimum = c.value("ParamMin"), maximum = c.value("ParamMax");
    if (minimum.numel() > 1 || maximum.numel() > 1) c.fail("Parameter minimum/maximum precisam ser escalares ou []");
    for (double x : value.data) {
        if (!minimum.empty() && x < minimum.data[0]) c.fail(std::string(what) + " abaixo de Parameter minimum");
        if (!maximum.empty() && x > maximum.data[0]) c.fail(std::string(what) + " acima de Parameter maximum");
    }
}

void buildGain(BuildContext& c) {
    const lib::ParamValue k = c.value("Gain");
    if (k.empty()) c.fail("Gain vazio");
    checkParamRange(c, k, "Gain");
    const std::string mode = c.text("Multiplication");
    const uint16_t in = c.inputWidth(0);
    // Ganho escalar: K*u = u*K = K.*u em todos os modos.
    if (mode == "Element-wise(K.*u)" || k.isScalar()) {
        const uint16_t width = elementwiseWidth(c, {k.numel()});
        if (k.numel() != 1 && k.numel() != width) c.fail("Gain com largura incompativel com o sinal");
        simpleKernel(c, "gain", width, k.linear(), {0, 1, static_cast<int64_t>(k.numel())});
        return;
    }
    if (mode != "Matrix(K*u)" && mode != "Matrix(u*K)" && mode != "Matrix(K*u) (u vector)") c.fail("Multiplication desconhecido: " + mode);
    const bool leftMultiply = mode != "Matrix(u*K)";
    const size_t rows = k.rows, cols = k.cols;
    if (leftMultiply && in != cols) c.fail("K*u exige colunas(K) = largura(u) (" + std::to_string(cols) + " x " + std::to_string(in) + ")");
    if (!leftMultiply && in != rows) c.fail("u*K exige largura(u) = linhas(K) (" + std::to_string(rows) + " x " + std::to_string(in) + ")");
    const uint16_t width = static_cast<uint16_t>(leftMultiply ? rows : cols);
    simpleKernel(c, "gain", width, k.data, {leftMultiply ? 1 : 2, static_cast<int64_t>(rows), static_cast<int64_t>(cols)});
}

void buildSliderGain(BuildContext& c) {
    const double gain = c.scalar("gain");
    if (!std::isfinite(gain)) c.fail("Slider gain precisa ser finito");
    simpleKernel(c, "gain", elementwiseWidth(c), {gain}, {0, 1, 1});
}

/** Lista de sinais/operadores (`Inputs` do Sum/Product): símbolos de `symbols` na ordem, `|` e
 * espaço são espaçadores; um número N significa N vezes o primeiro símbolo. Mesma regra de contagem
 * de portas de `BlockLibrary.cpp::repeatCount`. */
std::vector<char> parseSymbols(const BuildContext& c, const std::string& text, const char* symbols) {
    std::vector<char> result;
    bool symbolic = false;
    for (char ch : text) {
        if (ch == '|' || ch == ' ' || ch == '+' || ch == '-' || ch == '*' || ch == '/') symbolic = true;
    }
    if (symbolic) {
        for (char ch : text) {
            if (ch == '|' || ch == ' ') continue;
            if (std::string(symbols).find(ch) == std::string::npos) c.fail(std::string("caractere invalido na lista de entradas: '") + ch + "'");
            result.push_back(ch);
        }
        return result;
    }
    const double count = c.scalar("Inputs");
    if (!(count >= 1) || count != std::floor(count) || count > 4096) c.fail("numero de entradas invalido");
    return std::vector<char>(static_cast<size_t>(count), symbols[0]);
}

/** Uma entrada só: reduz os elementos (Sum of Elements, Product of Elements, MinMax de 1 entrada).
 * "Specified dimension" com sinais 1-D: a dimensão 1 é o vetor inteiro; maior que 1 é recusada,
 * como o Simulink recusa dimensão maior que a dimensionalidade da entrada. */
void checkCollapse(const BuildContext& c) {
    if (c.text("CollapseMode") != "Specified dimension") return;
    const double dimension = positiveInteger(c, "CollapseDim");
    if (dimension > 1.0 && c.inputWidth(0) > 1) c.fail("Dimension maior que a dimensionalidade da entrada (sinais 1-D)");
}

void buildSum(BuildContext& c) {
    const std::vector<char> signs = parseSymbols(c, c.text("Inputs"), "+-");
    if (signs.empty()) c.fail("lista de sinais vazia");
    if (signs.size() != c.inputPorts.size()) c.fail("lista de sinais nao corresponde as portas");
    std::vector<double> rp;
    for (char sign : signs) rp.push_back(sign == '-' ? -1.0 : 1.0);
    const bool collapse = signs.size() == 1;
    if (collapse) checkCollapse(c);
    simpleKernel(c, "sum", collapse ? 1 : elementwiseWidth(c), rp, {collapse ? 1 : 0});
}

void buildProduct(BuildContext& c) {
    const std::vector<char> ops = parseSymbols(c, c.text("Inputs"), "*/");
    if (ops.empty()) c.fail("lista de operadores vazia");
    if (ops.size() != c.inputPorts.size()) c.fail("operadores nao correspondem as portas");
    std::vector<double> rp;
    for (char op : ops) rp.push_back(op == '/' ? -1.0 : 1.0);
    const std::string multiplication = c.text("Multiplication");
    if (multiplication == "Matrix(*)") {
        // Produto matricial com sinais 1-D: só é definido com no máximo um operando não escalar, e a
        // inversa ('/') só de escalar (matriz 1x1). Uma entrada '*' é a própria entrada (não reduz).
        size_t vectors = 0;
        for (size_t port = 0; port < ops.size(); ++port) {
            if (c.inputWidth(port) == 1) continue;
            ++vectors;
            if (ops[port] == '/') c.fail("Matrix(*): inversa exige matriz quadrada (sinal 1-D de largura " + std::to_string(c.inputWidth(port)) + ")");
        }
        if (vectors > 1) c.fail("Matrix(*): produto de dois vetores 1-D com largura incompativel (sinais so 1-D)");
        simpleKernel(c, "product", elementwiseWidth(c), rp, {0});
        return;
    }
    if (multiplication != "Element-wise(.*)") c.fail("Multiplication desconhecido: " + multiplication);
    const bool collapse = ops.size() == 1;
    if (collapse) checkCollapse(c);
    simpleKernel(c, "product", collapse ? 1 : elementwiseWidth(c), rp, {collapse ? 1 : 0});
}

void buildDotProduct(BuildContext& c) {
    if (c.inputWidth(0) != c.inputWidth(1))
        c.fail("as entradas precisam ter a mesma largura (" + std::to_string(c.inputWidth(0)) + " e " + std::to_string(c.inputWidth(1)) + ")");
    simpleKernel(c, "dot_product", 1);
}

void buildBias(BuildContext& c) {
    const lib::ParamValue bias = c.value("Bias");
    if (bias.empty()) c.fail("Bias vazio");
    for (double value : bias.data) if (!std::isfinite(value)) c.fail("Bias precisa ser real e finito");
    const uint16_t width = elementwiseWidth(c, {bias.numel()});
    if (bias.numel() != 1 && bias.numel() != width) c.fail("Bias com largura incompativel");
    simpleKernel(c, "bias", width, bias.linear());
}

void buildWeightedSampleTimeMath(BuildContext& c) {
    // Ts = período do sinal (herdado da entrada); contínuo ou constante não tem Ts.
    if (c.resolution.rate.continuous() || constantRate(c))
        c.fail("exige tempo de amostragem discreto (Ts vem do sinal de entrada)");
    const double ts = static_cast<double>(c.resolution.rate.periodNs) * 1e-9;
    const double weight = c.scalar("weightValue");
    if (!std::isfinite(weight)) c.fail("Weight value precisa ser real e finito");
    const double tsw = ts * weight;
    const std::string op = c.text("TsampMathOp");
    if (op == "Ts Only" || op == "1/Ts Only") {
        c.outputWidths = {1};
        if (c.widthsOnly) return;
        c.kernel("", "constant", {}, 1, {op == "Ts Only" ? tsw : 1.0 / tsw});
        return;
    }
    const uint16_t width = elementwiseWidth(c);
    if (op == "+" || op == "-") simpleKernel(c, "bias", width, {op == "+" ? tsw : -tsw});
    else if (op == "*" || op == "/") simpleKernel(c, "gain", width, {op == "*" ? tsw : 1.0 / tsw}, {0, 1, 1});
    else c.fail("Operation desconhecida: " + op);
}

void unaryBlock(BuildContext& c, int64_t op) { simpleKernel(c, "unary", elementwiseWidth(c), {}, {op}); }

void buildAbs(BuildContext& c) { unaryBlock(c, lib::OpAbs); }
void buildSign(BuildContext& c) { unaryBlock(c, lib::OpSign); }
void buildUnaryMinus(BuildContext& c) { unaryBlock(c, lib::OpNegate); }

void buildSqrt(BuildContext& c) {
    rejectComplexOutput(c);
    const std::string op = c.text("Operator");
    if (op != "sqrt" && op != "signedSqrt" && op != "rSqrt") c.fail("funcao desconhecida: " + op);
    unaryBlock(c, op == "signedSqrt" ? lib::OpSignedSqrt : op == "rSqrt" ? lib::OpRsqrt : lib::OpSqrt);
}

void buildMathFunction(BuildContext& c) {
    rejectComplexOutput(c);
    const std::string op = c.text("Operator");
    struct Entry { const char* name; int64_t code; bool binary; };
    static constexpr Entry kOps[] = {
        {"exp", lib::OpExp, false}, {"log", lib::OpLog, false}, {"2^u", lib::OpPow2, false}, {"10^u", lib::OpPow10, false},
        {"log10", lib::OpLog10, false}, {"magnitude^2", lib::OpMagnitude2, false}, {"square", lib::OpSquare, false},
        {"conj", lib::OpIdentity, false}, {"reciprocal", lib::OpReciprocal, false}, {"transpose", lib::OpIdentity, false},
        {"hermitian", lib::OpIdentity, false}, {"pow", lib::OpPow, true}, {"hypot", lib::OpHypot, true},
        {"rem", lib::OpRem, true}, {"mod", lib::OpMod, true},
    };
    for (const Entry& entry : kOps) {
        if (op != entry.name) continue;
        const int64_t code = entry.code == lib::OpPow && entry.binary && c.flag("SignedPower") ? lib::OpSignedPow : entry.code;
        simpleKernel(c, entry.binary ? "binary" : "unary", elementwiseWidth(c), {}, {code});
        return;
    }
    c.fail("funcao desconhecida: " + op);
}

void buildTrigonometric(BuildContext& c) {
    rejectComplexOutput(c);
    const std::string op = c.text("Operator");
    if (op == "cos + jsin") c.fail("'cos + jsin' produz sinal complexo, nao suportado");
    // AngleUnit só vale com o método Lookup (sin, cos, sincos, atan2): o ângulo em revoluções entra
    // multiplicado por 2*pi (saída do atan2 dividida por 2*pi). A função é calculada exata (sem a
    // tabela de aproximação).
    const bool angled = op == "sin" || op == "cos" || op == "sincos" || op == "atan2";
    const bool revolution = angled && c.text("ApproximationMethod") == "Lookup" && c.text("AngleUnit") == "revolution";
    const bool protect = !c.flag("RemoveProtectionAgainstOutOfRangeInput");
    const uint16_t width = elementwiseWidth(c);
    if (op == "atan2") {
        c.outputWidths = {width};
        if (c.widthsOnly) return;
        if (!revolution) {
            c.kernel("", "binary", inputWidths(c), width, {}, {lib::OpAtan2});
            c.connectInputs(c.outputBlock(0));
            return;
        }
        const std::string radians = c.outputBlock(0) + "::rad";
        c.kernel(radians, "binary", inputWidths(c), width, {}, {lib::OpAtan2});
        c.connectInputs(radians);
        c.kernel("", "gain", {width}, width, {1.0 / kTwoPi}, {0, 1, 1});
        c.connect(radians, c.outputBlock(0), 1);
        return;
    }
    struct Entry { const char* name; int64_t code; };
    const Entry ops[] = {
        {"sin", lib::OpSin}, {"cos", lib::OpCos}, {"tan", lib::OpTan}, {"asin", protect ? lib::OpAsinSat : lib::OpAsin},
        {"acos", protect ? lib::OpAcosSat : lib::OpAcos}, {"atan", lib::OpAtan}, {"sinh", lib::OpSinh}, {"cosh", lib::OpCosh},
        {"tanh", lib::OpTanh}, {"asinh", lib::OpAsinh}, {"acosh", lib::OpAcosh}, {"atanh", lib::OpAtanh},
    };
    const bool sincos = op == "sincos";
    int64_t code = -1;
    for (const Entry& entry : ops) if (op == entry.name) code = entry.code;
    if (!sincos && code < 0) c.fail("funcao desconhecida: " + op);
    c.outputWidths = sincos ? std::vector<uint16_t>{width, width} : std::vector<uint16_t>{width};
    if (c.widthsOnly) return;
    std::string angle = c.inputBlock(0);
    if (revolution) {
        angle = c.outputBlock(0) + "::rad";
        c.kernel(angle, "gain", {c.inputWidth(0)}, width, {kTwoPi}, {0, 1, 1});
        c.connectInputs(angle);
    }
    const auto emit = [&](size_t port, int64_t unary) {
        c.kernel(c.outputBlock(port), "unary", {revolution ? width : c.inputWidth(0)}, width, {}, {unary});
        c.connect(angle, c.outputBlock(port), 1);
    };
    if (sincos) { emit(0, lib::OpSin); emit(1, lib::OpCos); return; }
    emit(0, code);
}

void buildRounding(BuildContext& c) {
    const std::string op = c.text("Operator");
    if (op != "floor" && op != "ceil" && op != "round" && op != "fix") c.fail("funcao desconhecida: " + op);
    unaryBlock(c, op == "ceil" ? lib::OpCeil : op == "round" ? lib::OpRound : op == "fix" ? lib::OpFix : lib::OpFloor);
}

void buildMinMax(BuildContext& c) {
    if (c.inputPorts.empty()) c.fail("Number of input ports precisa ser >= 1");
    const bool collapse = c.inputPorts.size() == 1;
    if (collapse) checkCollapse(c);
    simpleKernel(c, "minmax", collapse ? 1 : elementwiseWidth(c), {}, {c.text("Function") == "max" ? 1 : 0, collapse ? 1 : 0});
}

void buildMinMaxRunningResettable(BuildContext& c) {
    const std::vector<double> initial = c.value("vinit").linear();
    if (initial.empty()) c.fail("Initial condition vazia");
    const size_t width = std::max<size_t>(c.inputWidth(0), initial.size());
    if (initial.size() != 1 && initial.size() != width) c.fail("Initial condition com largura incompativel com u");
    if (c.inputWidth(0) != 1 && c.inputWidth(0) != width) c.fail("largura de u incompativel com a Initial condition");
    if (c.inputWidth(1) != 1 && c.inputWidth(1) != width) c.fail("largura de R difere da de u");
    simpleKernel(c, "minmax_running", static_cast<uint16_t>(width), initial, {c.text("Function") == "max" ? 1 : 0, static_cast<int64_t>(width)});
}

void buildPolynomial(BuildContext& c) {
    const std::vector<double> coefficients = c.value("coefs").linear();
    if (coefficients.empty()) c.fail("coeficientes vazios");
    simpleKernel(c, "polynomial", elementwiseWidth(c), coefficients);
}

/** Vector/Matrix Concatenate com sinais 1-D: modo Vector, ou Multidimensional array na dimensão 1
 * (empilha os vetores-coluna), é a concatenação [u1; u2; ...]. Dimensão >= 2 só é representável com
 * entradas escalares (vira o vetor [u1 u2 ...]); com vetores geraria matriz/array N-D. */
void buildConcatenate(BuildContext& c) {
    positiveInteger(c, "NumInputs");
    if (c.inputPorts.empty()) c.fail("Number of inputs invalido");
    if (c.text("Mode") == "Multidimensional array") {
        const double dimension = positiveInteger(c, "ConcatenateDimension");
        if (dimension >= 2.0)
            for (size_t port = 0; port < c.inputPorts.size(); ++port)
                if (c.inputWidth(port) > 1) c.fail("concatenar vetores na dimensao " + std::to_string(static_cast<int>(dimension)) +
                                                   " gera matriz (sinais so 1-D; use a dimensao 1)");
    } else if (c.text("Mode") != "Vector") {
        c.fail("Mode desconhecido: " + c.text("Mode"));
    }
    size_t total = 0;
    for (size_t port = 0; port < c.inputPorts.size(); ++port) total += c.inputWidth(port);
    if (total > 4096) c.fail("largura de sinal grande demais");
    simpleKernel(c, "concat", static_cast<uint16_t>(total));
}

void buildAssignment(BuildContext& c) {
    if (c.scalar("NumberOfDimensions") != 1.0) c.fail("Number of output dimensions: so 1 (sinais 1-D)");
    const std::string option = c.text("IndexOptionArray");
    const int64_t mode = option == "Assign all" ? 0 : option == "Index vector (dialog)" ? 1 : option == "Index vector (port)" ? 2
                       : option == "Starting index (dialog)" ? 3 : option == "Starting index (port)" ? 4 : -1;
    if (mode < 0) c.fail("Index Option desconhecida: " + option);
    const int64_t base = c.text("IndexMode") == "Zero-based" ? 0 : 1;
    const bool portIndex = mode == 2 || mode == 4;
    const bool hasY0 = !portIndex || c.text("OutputInitialize") == "Initialize using input port <Y0>";
    const size_t uPort = hasY0 ? 1 : 0;
    if (c.inputPorts.size() != uPort + 1 + (portIndex ? 1 : 0)) c.fail("portas incompativeis com Index Option/Initialize output");
    size_t outWidth = 0;
    if (hasY0) outWidth = c.inputWidth(0);
    else outWidth = static_cast<size_t>(positiveInteger(c, "OutputSizeArray"));
    const size_t uWidth = c.inputWidth(uPort);
    std::vector<int64_t> indices;
    if (mode == 1 || mode == 3) {
        for (double index : c.value("IndexParamArray").linear()) {
            if (!std::isfinite(index) || index != std::floor(index)) c.fail("Index precisa ser inteiro");
            const double zeroBased = index - static_cast<double>(base);
            if (zeroBased < 0.0 || zeroBased >= static_cast<double>(outWidth))
                c.fail("faixa fora do vetor: indice " + std::to_string(static_cast<long long>(index)) + " para largura " + std::to_string(outWidth));
            indices.push_back(static_cast<int64_t>(zeroBased));
        }
        if (indices.empty()) c.fail("Index vazio");
        if (mode == 3 && indices.size() != 1) c.fail("Starting index precisa ser escalar");
        if (mode == 3 && static_cast<size_t>(indices[0]) + uWidth > outWidth) c.fail("faixa fora do vetor: U nao cabe a partir do indice inicial");
        if (mode == 1 && uWidth != 1 && uWidth != indices.size()) c.fail("largura de U difere do numero de indices");
    }
    if (mode == 0 && uWidth != 1 && uWidth != outWidth) c.fail("Assign all: largura de U difere da de Y0");
    if (mode == 2 && uWidth != 1 && uWidth != c.inputWidth(uPort + 1)) c.fail("largura de U difere da de Idx1");
    if (mode == 4 && c.inputWidth(uPort + 1) != 1) c.fail("Idx1 (indice inicial) precisa ser escalar");
    if (outWidth > 4096) c.fail("largura de sinal grande demais");
    std::vector<int64_t> ip{mode, base, hasY0 ? 1 : 0, portIndex ? 1 : 0, static_cast<int64_t>(indices.size())};
    ip.insert(ip.end(), indices.begin(), indices.end());
    simpleKernel(c, "assignment", static_cast<uint16_t>(outWidth), {}, ip);
}

void buildReshape(BuildContext& c) {
    const std::string mode = c.text("OutputDimensionality");
    const uint16_t width = c.inputWidth(0);
    if (mode == "Customize") {
        const std::vector<double> dims = c.value("OutputDimensions").linear();
        if (dims.empty() || dims.size() > 2) c.fail("Output dimensions deve ser [N] ou [M N]");
        double count = 1.0;
        for (double d : dims) {
            if (!(d >= 1.0) || d != std::floor(d)) c.fail("Output dimensions precisa de inteiros >= 1");
            count *= d;
        }
        if (count != static_cast<double>(width))
            c.fail("Output dimensions com " + std::to_string(static_cast<long long>(count)) + " elementos para entrada de largura " + std::to_string(width));
    } else if (mode == "Derive from reference input port") {
        if (c.inputWidth(1) != width) c.fail("largura de U difere da de Ref");
    } else if (mode != "1-D array" && mode != "Column vector (2-D)" && mode != "Row vector (2-D)") {
        c.fail("Output dimensionality desconhecida: " + mode);
    }
    // Sinais 1-D: reshape não muda os elementos (ordem por coluna preservada) -- é identidade.
    c.outputWidths = {width};
    if (c.widthsOnly) return;
    c.kernel("", "unary", {width}, width, {}, {lib::OpIdentity});
    c.connect(c.inputBlock(0), c.outputBlock(0), 1);
}

} // namespace

void registerMathBuilders(BuilderTable& table) {
    table.add("gain", buildGain);
    table.add("slider_gain", buildSliderGain);
    table.add("sum", buildSum);
    table.add("product", buildProduct);
    table.add("dot_product", buildDotProduct);
    table.add("bias", buildBias);
    table.add("weighted_sample_time_math", buildWeightedSampleTimeMath);
    table.add("abs", buildAbs);
    table.add("sign", buildSign);
    table.add("unary_minus", buildUnaryMinus);
    table.add("sqrt", buildSqrt);
    table.add("math_function", buildMathFunction);
    table.add("trigonometric_function", buildTrigonometric);
    table.add("rounding_function", buildRounding);
    table.add("minmax", buildMinMax);
    table.add("minmax_running_resettable", buildMinMaxRunningResettable);
    table.add("polynomial", buildPolynomial);
    table.add("vector_concatenate", buildConcatenate);
    table.add("matrix_concatenate", buildConcatenate);
    table.add("assignment", buildAssignment);
    table.add("reshape", buildReshape);
}

} // namespace lasecsimul::components::blocks::builders
