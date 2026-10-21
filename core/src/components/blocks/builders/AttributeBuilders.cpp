// Signal Attributes: parâmetros oficiais -> kernels de `AttributeKernels.cpp` (ic,
// data_type_conversion, attribute_value, weighted_sample_time) e de `RoutingKernels.cpp`
// (passthrough, rate_transition_delay). Sinais do engine são só `double` (docs/66 §4.6): tipos de
// dado são emulados no domínio do valor; atributos sem efeito numérico (tipo, unidade, faixa) são
// validados e documentados.
#include <cctype>
#include <cmath>
#include <limits>
#include <optional>

#include "BuilderCommon.hpp"

namespace lasecsimul::components::blocks::builders {

namespace {

std::string trimmed(const std::string& text) {
    size_t begin = 0, end = text.size();
    while (begin < end && std::isspace(static_cast<unsigned char>(text[begin]))) ++begin;
    while (end > begin && std::isspace(static_cast<unsigned char>(text[end - 1]))) --end;
    return text.substr(begin, end - begin);
}

/** Argumentos de nível superior de `nome(a, b(c, d), e)` (vírgulas fora de parênteses/colchetes). */
std::vector<std::string> topLevelArguments(const std::string& inner) {
    std::vector<std::string> args;
    int depth = 0;
    std::string current;
    for (char ch : inner) {
        if (ch == '(' || ch == '[' || ch == '{') ++depth;
        if (ch == ')' || ch == ']' || ch == '}') --depth;
        if (ch == ',' && depth == 0) { args.push_back(trimmed(current)); current.clear(); continue; }
        current += ch;
    }
    if (!trimmed(current).empty() || !args.empty()) args.push_back(trimmed(current));
    return args;
}

/** Tipo de dado de saída (OutDataTypeStr) traduzido para o kernel `data_type_conversion`. */
struct DataType {
    int64_t kind = 0; // 0 identidade, 1 single, 2 half, 3 boolean, 4 inteiro/ponto fixo
    double slope = 1.0, bias = 0.0, qmin = 0.0, qmax = 0.0;
};

DataType fixedType(const BuildContext& c, bool isSigned, double bits, double slope, double bias) {
    if (!(bits >= 1.0) || bits > 64.0 || bits != std::floor(bits)) c.fail("tamanho de palavra do tipo de dado precisa ser inteiro entre 1 e 64");
    if (!(slope > 0.0) || !std::isfinite(slope) || !std::isfinite(bias)) c.fail("escala do tipo de ponto fixo invalida");
    DataType type;
    type.kind = 4;
    type.slope = slope;
    type.bias = bias;
    type.qmin = isSigned ? -std::ldexp(1.0, static_cast<int>(bits) - 1) : 0.0;
    type.qmax = isSigned ? std::ldexp(1.0, static_cast<int>(bits) - 1) - 1.0 : std::ldexp(1.0, static_cast<int>(bits)) - 1.0;
    return type;
}

double evaluatedScalar(const BuildContext& c, const std::string& text, const char* what) {
    try {
        const lib::ParamValue value = lib::evaluateParam(text, c.resolution.workspace);
        if (!value.isScalar()) c.fail(std::string(what) + " precisa ser escalar");
        return value.data[0];
    } catch (const std::invalid_argument& error) {
        c.fail(std::string(what) + ": " + error.what());
    }
}

/** `OutDataTypeStr` -> conversão emulada. Herança (`Inherit: ...`) e `double` são identidade (todo
 * sinal é double). Aceita os tipos embutidos, `fixdt(s,w,f)`, `fixdt(s,w,slope,bias)`,
 * `fixdt(s,w,ajuste,expoente,bias)`, `fixdt('single'|'double'|'half')` e nomes `sfixW_EnF`/`ufixW`.
 * Enum/Bus/string/ValueType não existem aqui (recusa explícita). Usada também pelos builders de
 * Signal Routing (Switch, Multiport Switch). */
DataType parseDataType(const BuildContext& c, const std::string& raw) {
    const std::string text = trimmed(raw);
    if (text.empty()) c.fail("tipo de dado vazio");
    if (text.rfind("Inherit", 0) == 0 || text == "double" || text == "auto") return {};
    if (text == "single") return {1};
    if (text == "half") return {2};
    if (text == "boolean") return {3};
    static const std::pair<const char*, std::pair<bool, int>> integers[] = {
        {"int8", {true, 8}}, {"uint8", {false, 8}}, {"int16", {true, 16}}, {"uint16", {false, 16}},
        {"int32", {true, 32}}, {"uint32", {false, 32}}, {"int64", {true, 64}}, {"uint64", {false, 64}}};
    for (const auto& [name, info] : integers) if (text == name) return fixedType(c, info.first, info.second, 1.0, 0.0);
    if (text.rfind("fixdt(", 0) == 0 && text.back() == ')') {
        const std::vector<std::string> args = topLevelArguments(text.substr(6, text.size() - 7));
        if (args.size() == 1) {
            const std::string name = args[0];
            if (name == "'double'" || name == "\"double\"") return {};
            if (name == "'single'" || name == "\"single\"") return {1};
            if (name == "'half'" || name == "\"half\"") return {2};
            c.fail("fixdt com argumento nao suportado: " + text);
        }
        if (args.size() == 2) c.fail("fixdt(s,w) sem escala (Best precision) nao e suportado: informe a escala, ex. fixdt(1,16,4)");
        const bool isSigned = evaluatedScalar(c, args[0], "fixdt: sinal") != 0.0;
        const double bits = evaluatedScalar(c, args[1], "fixdt: tamanho de palavra");
        if (args.size() == 3) {
            const double fraction = evaluatedScalar(c, args[2], "fixdt: fracao");
            if (fraction != std::floor(fraction) || std::abs(fraction) > 1024.0) c.fail("fixdt(s,w,f): o tamanho da fracao precisa ser inteiro");
            return fixedType(c, isSigned, bits, std::ldexp(1.0, -static_cast<int>(fraction)), 0.0);
        }
        if (args.size() == 4) return fixedType(c, isSigned, bits, evaluatedScalar(c, args[2], "fixdt: inclinacao"), evaluatedScalar(c, args[3], "fixdt: vies"));
        if (args.size() == 5)
            return fixedType(c, isSigned, bits,
                             evaluatedScalar(c, args[2], "fixdt: ajuste da inclinacao") * std::ldexp(1.0, static_cast<int>(evaluatedScalar(c, args[3], "fixdt: expoente"))),
                             evaluatedScalar(c, args[4], "fixdt: vies"));
        c.fail("fixdt com numero de argumentos invalido: " + text);
    }
    // Nomes compactos de ponto fixo: sfix16, ufix8, sfix16_En4 (2^-4), sfix16_E2 (2^2).
    if ((text.rfind("sfix", 0) == 0 || text.rfind("ufix", 0) == 0) && text.size() > 4) {
        size_t position = 4;
        int bits = 0;
        while (position < text.size() && std::isdigit(static_cast<unsigned char>(text[position]))) bits = bits * 10 + (text[position++] - '0');
        int exponent = 0;
        bool valid = bits > 0;
        if (valid && position < text.size()) {
            const bool negative = text.compare(position, 3, "_En") == 0;
            if (!negative && text.compare(position, 2, "_E") != 0) valid = false;
            position += negative ? 3 : 2;
            int magnitude = 0;
            const size_t digits = position;
            while (position < text.size() && std::isdigit(static_cast<unsigned char>(text[position]))) magnitude = magnitude * 10 + (text[position++] - '0');
            valid = valid && position == text.size() && position > digits;
            exponent = negative ? -magnitude : magnitude;
        }
        if (valid) return fixedType(c, text[0] == 's', bits, std::ldexp(1.0, exponent), 0.0);
    }
    if (text.rfind("Enum:", 0) == 0 || text.rfind("Bus:", 0) == 0 || text.rfind("ValueType:", 0) == 0 || text == "string" || text.rfind("Simulink.", 0) == 0)
        c.fail("tipo de dado '" + text + "' nao suportado: os sinais do LasecSimul sao double (sem enumeracoes, barramentos ou strings)");
    c.fail("tipo de dado nao reconhecido: '" + text + "'");
}

} // namespace

/** RndMeth (texto oficial) -> código do kernel `data_type_conversion`. */
int64_t roundingMode(const BuildContext& c, const std::string& text) {
    static const char* const names[] = {"Ceiling", "Convergent", "Floor", "Nearest", "Round", "Simplest", "Zero"};
    for (int64_t i = 0; i < 7; ++i) if (text == names[i]) return i;
    c.fail("Integer rounding mode invalido: " + text);
}

/** `OutDataTypeStr` do bloco não muda o valor (herança/double)? Valida o texto. */
bool isIdentityDataType(const BuildContext& c, const std::string& text) { return parseDataType(c, text).kind == 0; }

/** Kernel de conversão `id` lendo `source` (largura `width`) para o tipo `text`, com o
 * arredondamento/saturação dados (Real World Value: valor real preservado). */
void emitDataTypeConversion(BuildContext& c, const std::string& id, const std::string& source, uint16_t width, const std::string& text,
                            const std::string& rounding, bool saturate, bool storedInteger) {
    const DataType type = parseDataType(c, text);
    std::vector<double> rp;
    if (type.kind == 4) rp = {type.slope, type.bias, type.qmin, type.qmax};
    c.kernel(id, "data_type_conversion", {width}, width, rp, {type.kind, roundingMode(c, rounding), saturate ? 1 : 0, storedInteger ? 1 : 0});
    c.connect(source, id, 1);
}

/** `[]` ou escalar finito (Output minimum/maximum: só verificação de faixa, nunca satura). */
std::optional<double> optionalLimit(const BuildContext& c, const char* name) {
    const lib::ParamValue value = c.value(name);
    if (value.empty()) return std::nullopt;
    if (!value.isScalar() || std::isnan(value.data[0])) c.fail(std::string(name) + " precisa ser [] ou escalar");
    return value.data[0];
}

namespace {

constexpr uint64_t kConstantNs = simulation::kConstantSamplePeriodNs;

bool constantRate(const simulation::SignalRate& rate) { return !rate.continuous() && rate.periodNs >= kConstantNs; }

/** Saída 1 = entrada 1 (cópia contígua; na taxa do bloco). */
void identity(BuildContext& c, size_t inputPort = 0) {
    const uint16_t width = c.inputWidth(inputPort);
    c.outputWidths = {width};
    if (c.widthsOnly) return;
    c.kernel("", "passthrough", {width}, width);
    c.connect(c.inputBlock(inputPort), c.outputBlock(0), 1);
}

void buildIc(BuildContext& c) {
    const std::vector<double> value = c.value("Value").linear();
    if (value.empty()) c.fail("Initial value vazio");
    for (double v : value) if (!std::isfinite(v)) c.fail("Initial value precisa ser real e finito");
    const uint16_t width = c.inputWidth(0);
    c.outputWidths = {width};
    if (value.size() != 1 && value.size() != width)
        c.fail("Initial value com largura " + std::to_string(value.size()) + " incompativel com a entrada (largura " + std::to_string(width) + ")");
    if (c.widthsOnly) return;
    simulation::SignalBlockDefinition& block = c.kernel("", "ic", {width}, width, value);
    // Entrada constante: a saída ainda precisa mudar de Value para u depois de tstart, e um bloco de
    // taxa constante só executa uma vez -- o IC passa a ser avaliado em todo passo maior.
    if (constantRate(block.rate)) block.rate = {0, 0, 0};
    c.connectInputs(c.outputBlock(0));
}

void buildSignalConversion(BuildContext& c) {
    const std::string output = c.text("ConversionOutput");
    if (output != "Signal copy")
        c.fail("Output '" + output + "' converte barramentos, que nao existem no LasecSimul (use 'Signal copy')");
    identity(c);
}

void buildDataTypeConversion(BuildContext& c) {
    (void)optionalLimit(c, "OutMin");
    (void)optionalLimit(c, "OutMax");
    const std::string type = c.text("OutDataTypeStr");
    const uint16_t width = c.inputWidth(0);
    if (isIdentityDataType(c, type)) { identity(c); return; }
    c.outputWidths = {width};
    if (c.widthsOnly) return;
    emitDataTypeConversion(c, c.outputBlock(0), c.inputBlock(0), width, type, c.text("RndMeth"), c.flag("SaturateOnIntegerOverflow"),
                           c.text("ConvertRealWorld") == "Stored Integer (SI)");
}

/** Data Type Conversion Inherited: u convertido para o tipo da referência (porta 1). A referência é
 * sempre double aqui, então y = u. */
void buildDataTypeConversionInherited(BuildContext& c) {
    (void)roundingMode(c, c.text("RndMeth"));
    identity(c, 1);
}

/** Blocos só de tipo de dado, sem saída (Data Type Duplicate, Data Type Propagation): sem efeito
 * numérico nenhum -- no Simulink também só restringem/propagam tipos. */
void buildTypeOnlySink(BuildContext& c) { c.outputWidths = {}; }

void buildDataTypeDuplicate(BuildContext& c) {
    const double n = c.scalar("NumInputPorts");
    if (!(n >= 1.0) || n != std::floor(n)) c.fail("Number of input ports precisa ser inteiro positivo");
    buildTypeOnlySink(c);
}

void buildWidth(BuildContext& c) {
    const uint16_t width = c.inputWidth(0);
    c.outputWidths = {1};
    const std::string mode = c.text("OutputDataTypeScalingMode");
    if (mode == "Choose intrinsic data type") {
        const std::string type = c.text("DataType");
        const double limit = type == "int8" ? 127.0 : type == "uint8" ? 255.0 : 65535.0;
        if (width > limit) c.fail("largura " + std::to_string(width) + " nao cabe no tipo " + type);
    }
    if (c.widthsOnly) return;
    simulation::SignalBlockDefinition& block = c.kernel("", "attribute_value", {}, 1, {static_cast<double>(width)});
    if (c.flag("AlwaysUseConstantSampleTime")) block.rate = {kConstantNs, 0, 0};
}

/** Probe: uma saída constante por atributo habilitado (W, Ts, C, D), na ordem das portas. */
void buildProbe(BuildContext& c) {
    const uint16_t width = c.inputWidth(0);
    const simulation::SignalRate& rate = c.resolution.rate;
    std::vector<std::vector<double>> values;
    for (const std::string& port : c.outputPorts) {
        if (port == "W" || port == "D") values.push_back({static_cast<double>(width)});
        else if (port == "C") values.push_back({0.0});
        else if (rate.continuous()) values.push_back({0.0, 0.0});
        else if (constantRate(rate)) values.push_back({std::numeric_limits<double>::infinity(), 0.0});
        else values.push_back({static_cast<double>(rate.periodNs) * 1e-9, static_cast<double>(rate.offsetNs) * 1e-9});
    }
    c.outputWidths.clear();
    for (const auto& value : values) c.outputWidths.push_back(static_cast<uint16_t>(value.size()));
    if (c.widthsOnly) return;
    for (size_t port = 0; port < values.size(); ++port) {
        simulation::SignalBlockDefinition& block = c.kernel(c.outputBlock(port), "attribute_value", {}, c.outputWidths[port], values[port]);
        block.rate = {kConstantNs, 0, 0};
    }
}

/** Rate Transition. A taxa do bloco é a herdada da ENTRADA (a sessão só propaga taxas para frente);
 * a taxa de saída vem de OutPortSampleTimeOpt e os kernels são emitidos nela:
 *  - mesma taxa, ou Integrity/Deterministic desligados, ou transição com tempo contínuo/constante:
 *    cópia (na taxa de saída);
 *  - rápida -> lenta determinística: ZOH (passagem amostrada na taxa lenta);
 *  - lenta -> rápida determinística: atraso unitário na taxa lenta (InitialCondition no primeiro
 *    período) seguido de passagem na taxa rápida.
 * Combinações que o Simulink recusa com integridade+determinismo (razão não inteira, deslocamento
 * não nulo, mesmo período com deslocamentos diferentes) são recusadas aqui também. */
void buildRateTransition(BuildContext& c) {
    const uint16_t width = c.inputWidth(0);
    const std::vector<double> ic = c.value("InitialCondition").linear();
    if (ic.empty()) c.fail("Initial conditions vazia");
    for (double v : ic) if (!std::isfinite(v)) c.fail("Initial conditions nao pode ser Inf ou NaN");
    if (ic.size() != 1 && ic.size() != width)
        c.fail("Initial conditions com largura " + std::to_string(ic.size()) + " incompativel com a entrada (largura " + std::to_string(width) + ")");
    const simulation::SignalRate input = c.resolution.rate;
    simulation::SignalRate output = input;
    const std::string option = c.text("OutPortSampleTimeOpt");
    if (option == "Specify") {
        const lib::ParamValue ts = c.value("OutPortSampleTime");
        if (ts.numel() < 1 || ts.numel() > 2) c.fail("Output port sample time deve ser Ts ou [Ts, offset]");
        const double period = ts.data[0], offset = ts.numel() == 2 ? ts.data[1] : 0.0;
        if (period == -1.0) output = input;
        else if (period == 0.0) output = {0, 0, 0};
        else if (std::isinf(period) && period > 0) output = {kConstantNs, 0, 0};
        else {
            if (!(period > 0.0) || !(offset >= 0.0) || offset >= period) c.fail("Output port sample time invalido (Ts > 0 e 0 <= offset < Ts)");
            output = {static_cast<uint64_t>(nanoseconds(c, period, "Output port sample time")), static_cast<uint64_t>(nanoseconds(c, offset, "offset")), 0};
            if (output.periodNs == 0) c.fail("Output port sample time menor que 1 ns");
        }
    } else if (option == "Multiple of input port sample time") {
        const double multiple = c.scalar("OutPortSampleTimeMultiple");
        if (!(multiple > 0.0) || !std::isfinite(multiple)) c.fail("Sample time multiple precisa ser > 0");
        if (input.continuous() || constantRate(input)) c.fail("Sample time multiple exige tempo de amostragem discreto na entrada");
        output.periodNs = static_cast<uint64_t>(std::llround(static_cast<double>(input.periodNs) * multiple));
        if (output.periodNs == 0 || output.offsetNs >= output.periodNs) c.fail("Sample time multiple gera tempo de amostragem invalido");
    } else if (option != "Inherit") {
        c.fail("Output port sample time options invalido: " + option);
    }
    c.outputWidths = {width};

    enum class Mode { Copy, Hold, Delay };
    Mode mode = Mode::Copy;
    const bool discreteBoth = !input.continuous() && !output.continuous() && !constantRate(input) && !constantRate(output);
    const bool integrity = c.flag("Integrity"), deterministic = c.flag("Deterministic");
    if (discreteBoth && integrity && deterministic) {
        const uint64_t in = input.periodNs, out = output.periodNs;
        if (in == out) {
            if (input.offsetNs != output.offsetNs) c.fail("transicao com mesmo periodo e deslocamentos diferentes exige desligar 'Ensure deterministic data transfer'");
        } else if (in < out) {
            if (out % in != 0 || input.offsetNs != 0 || output.offsetNs != 0)
                c.fail("transicao rapida->lenta deterministica exige periodo de saida multiplo inteiro do de entrada e deslocamentos nulos");
            mode = Mode::Hold;
        } else {
            if (in % out != 0 || input.offsetNs != 0 || output.offsetNs != 0)
                c.fail("transicao lenta->rapida deterministica exige periodo de entrada multiplo inteiro do de saida e deslocamentos nulos");
            mode = Mode::Delay;
        }
    }
    if (c.widthsOnly) return;
    if (mode == Mode::Delay) {
        const std::string held = c.outputBlock(0) + "::1/z";
        c.kernel(held, "rate_transition_delay", {width}, width, ic).rate = input;
        c.connect(c.inputBlock(0), held, 1);
        c.kernel("", "passthrough", {width}, width).rate = output;
        c.connect(held, c.outputBlock(0), 1);
        return;
    }
    c.kernel("", "passthrough", {width}, width).rate = output;
    c.connect(c.inputBlock(0), c.outputBlock(0), 1);
}

/** Signal Specification: bloco virtual (y = u) que só confere atributos. */
void buildSignalSpecification(BuildContext& c) {
    (void)optionalLimit(c, "OutMin");
    (void)optionalLimit(c, "OutMax");
    // Tipos numéricos não são verificados (todo sinal é double); os não numéricos são recusados.
    (void)parseDataType(c, c.text("OutDataTypeStr"));
    if (c.text("SignalType") == "complex") c.fail("Signal type 'complex': sinais complexos nao existem no LasecSimul");
    if (c.text("VarSizeSig") == "Yes") c.fail("Variable-size signal 'Yes': sinais de tamanho variavel nao existem no LasecSimul");
    const lib::ParamValue dims = c.value("Dimensions");
    const uint16_t width = c.inputWidth(0);
    if (!(dims.isScalar() && dims.data[0] == -1.0)) {
        if (dims.numel() < 1 || dims.numel() > 2) c.fail("Dimensions deve ser -1, n ou [m n]");
        for (double d : dims.data) if (!(d >= 1.0) || d != std::floor(d)) c.fail("Dimensions com valor invalido");
        if (dims.numel() == 2 && dims.data[0] != 1.0 && dims.data[1] != 1.0) c.fail("Dimensions [m n] com m, n > 1: sinais matriciais nao existem no LasecSimul");
        const double expected = dims.numel() == 2 ? dims.data[0] * dims.data[1] : dims.data[0];
        if (expected != width) c.fail("largura da entrada (" + std::to_string(width) + ") difere de Dimensions (" + std::to_string(static_cast<int>(expected)) + ")");
    }
    identity(c);
}

void buildWeightedSampleTime(BuildContext& c) {
    const simulation::SignalRate& rate = c.resolution.rate;
    if (rate.continuous() || constantRate(rate))
        c.fail("exige tempo de amostragem discreto (o bloco usa o Ts do sinal de entrada)");
    const double weight = c.scalar("weightValue");
    static const char* const ops[] = {"+", "-", "*", "/", "Ts Only", "1/Ts Only"};
    const std::string op = c.text("TsampMathOp");
    int64_t code = -1;
    for (int64_t i = 0; i < 6; ++i) if (op == ops[i]) code = i;
    if (code < 0) c.fail("Operation invalida: " + op);
    if (code < 4 && !isIdentityDataType(c, c.text("OutDataTypeStr"))) c.fail("Output data type inteiro/ponto fixo ainda nao suportado neste bloco");
    const double ts = static_cast<double>(rate.periodNs) * 1e-9;
    const uint16_t width = code >= 4 ? 1 : c.inputWidth(0);
    c.outputWidths = {width};
    if (c.widthsOnly) return;
    c.kernel("", "weighted_sample_time", {c.inputWidth(0)}, width, {ts * weight}, {code});
    c.connectInputs(c.outputBlock(0));
}

} // namespace

void registerAttributeBuilders(BuilderTable& table) {
    table.add("ic", buildIc);
    table.add("signal_conversion", buildSignalConversion);
    table.add("data_type_conversion", buildDataTypeConversion);
    table.add("data_type_conversion_inherited", buildDataTypeConversionInherited);
    table.add("data_type_duplicate", buildDataTypeDuplicate);
    table.add("data_type_propagation", buildTypeOnlySink);
    table.add("data_type_scaling_strip", [](BuildContext& c) { identity(c); });
    table.add("width", buildWidth);
    table.add("probe", buildProbe);
    table.add("rate_transition", buildRateTransition);
    table.add("signal_specification", buildSignalSpecification);
    table.add("unit_conversion", [](BuildContext& c) { identity(c); });
    table.add("weighted_sample_time", buildWeightedSampleTime);
}

} // namespace lasecsimul::components::blocks::builders
