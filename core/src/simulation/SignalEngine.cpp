#include "SignalEngine.hpp"
#include "library/Kernel.hpp"

#include <algorithm>
#include <bit>
#include <cmath>
#include <functional>
#include <limits>
#include <queue>
#include <stdexcept>
#include <unordered_map>
#include <utility>

namespace lasecsimul::simulation {
namespace {

struct UnitInfo {
    const char* dimension;
    double scale;
    double offset;
};

UnitInfo unitInfo(std::string_view symbol) {
    if (symbol.empty() || symbol == "1") return {"dimensionless", 1.0, 0.0};
    if (symbol == "V") return {"voltage", 1.0, 0.0};
    if (symbol == "mV") return {"voltage", 1e-3, 0.0};
    if (symbol == "kV") return {"voltage", 1e3, 0.0};
    if (symbol == "A") return {"current", 1.0, 0.0};
    if (symbol == "mA") return {"current", 1e-3, 0.0};
    if (symbol == "s") return {"time", 1.0, 0.0};
    if (symbol == "ms") return {"time", 1e-3, 0.0};
    if (symbol == "us") return {"time", 1e-6, 0.0};
    if (symbol == "Hz") return {"frequency", 1.0, 0.0};
    if (symbol == "kHz") return {"frequency", 1e3, 0.0};
    if (symbol == "Pa") return {"pressure", 1.0, 0.0};
    if (symbol == "kPa") return {"pressure", 1e3, 0.0};
    if (symbol == "K") return {"temperature", 1.0, 0.0};
    if (symbol == "degC") return {"temperature", 1.0, 273.15};
    // Grandezas de processo/hidráulica (Laboratório de Cálculo, tanques): mesma tabela espelhada em
    // extension/src/ui/webview/lab/units.ts -- um teste da Extension compara as duas.
    if (symbol == "bar") return {"pressure", 1e5, 0.0};
    if (symbol == "min") return {"time", 60.0, 0.0};
    if (symbol == "h") return {"time", 3600.0, 0.0};
    if (symbol == "m") return {"length", 1.0, 0.0};
    if (symbol == "cm") return {"length", 1e-2, 0.0};
    if (symbol == "mm") return {"length", 1e-3, 0.0};
    if (symbol == "m2") return {"area", 1.0, 0.0};
    if (symbol == "cm2") return {"area", 1e-4, 0.0};
    if (symbol == "m3") return {"volume", 1.0, 0.0};
    if (symbol == "cm3") return {"volume", 1e-6, 0.0};
    if (symbol == "L") return {"volume", 1e-3, 0.0};
    if (symbol == "mL") return {"volume", 1e-6, 0.0};
    if (symbol == "m3/s") return {"volumetricFlow", 1.0, 0.0};
    if (symbol == "m3/h") return {"volumetricFlow", 1.0 / 3600.0, 0.0};
    if (symbol == "L/s") return {"volumetricFlow", 1e-3, 0.0};
    if (symbol == "L/min") return {"volumetricFlow", 1e-3 / 60.0, 0.0};
    if (symbol == "m/s") return {"velocity", 1.0, 0.0};
    if (symbol == "cm/s") return {"velocity", 1e-2, 0.0};
    if (symbol == "rad") return {"angle", 1.0, 0.0};
    if (symbol == "deg") return {"angle", 3.14159265358979323846 / 180.0, 0.0};
    throw std::invalid_argument("unidade de sinal desconhecida: " + std::string(symbol));
}

struct LinearConversion { double scale = 1.0; double offset = 0.0; };

LinearConversion conversion(std::string_view source, std::string_view target, bool explicitlyAllowed) {
    const UnitInfo from = unitInfo(source);
    const UnitInfo to = unitInfo(target);
    if (std::string_view(from.dimension) != to.dimension) {
        throw std::invalid_argument("unidades de sinal incompativeis: " + std::string(source) + " -> " +
                                    std::string(target));
    }
    if (source != target && !explicitlyAllowed) {
        throw std::invalid_argument("conversao de unidade exige declaracao explicita: " +
                                    std::string(source) + " -> " + std::string(target));
    }
    return {from.scale / to.scale, (from.offset - to.offset) / to.scale};
}

struct InputBinding {
    SignalSlotHandle source;
    LinearConversion conversion;
};

// CalcExpression é também a semântica canônica dos blocos de cálculo TDPS.
// Comparações retornam 0.0/1.0, como no legado, e potência evita transformar
// uma expressão de processo válida em um valor constante durante a importação.
enum class ExpressionOp : uint8_t { Constant, Input, Add, Subtract, Multiply, Divide, Power, Greater, Less, Negate };
struct ExpressionInstruction { ExpressionOp op; double value = 0.0; uint16_t input = 0; };

class ExpressionParser {
public:
    ExpressionParser(std::string_view text, const std::vector<SignalPortDefinition>& inputs,
                     std::vector<ExpressionInstruction>& code)
        : m_text(text), m_inputs(inputs), m_code(code) {}

    uint16_t parse() {
        comparison();
        whitespace();
        if (m_position != m_text.size()) fail("token inesperado");
        int depth = 0;
        int maximum = 0;
        for (const auto& instruction : m_code) {
            if (instruction.op == ExpressionOp::Constant || instruction.op == ExpressionOp::Input) ++depth;
            else if (instruction.op == ExpressionOp::Negate) {
                if (depth < 1) fail("expressao incompleta");
            } else {
                if (depth < 2) fail("expressao incompleta");
                --depth;
            }
            maximum = std::max(maximum, depth);
        }
        if (depth != 1) fail("expressao incompleta");
        return static_cast<uint16_t>(maximum);
    }

private:
    [[noreturn]] void fail(const char* reason) const {
        throw std::invalid_argument("CalcExpression invalida na coluna " + std::to_string(m_position + 1) +
                                    ": " + reason);
    }
    void whitespace() { while (m_position < m_text.size() && (m_text[m_position] == ' ' || m_text[m_position] == '\t')) ++m_position; }
    bool consume(char value) { whitespace(); if (m_position < m_text.size() && m_text[m_position] == value) { ++m_position; return true; } return false; }
    void comparison() {
        expression();
        while (true) {
            if (consume('>')) { expression(); m_code.push_back({ExpressionOp::Greater}); }
            else if (consume('<')) { expression(); m_code.push_back({ExpressionOp::Less}); }
            else return;
        }
    }
    void expression() {
        term();
        while (true) {
            if (consume('+')) { term(); m_code.push_back({ExpressionOp::Add}); }
            else if (consume('-')) { term(); m_code.push_back({ExpressionOp::Subtract}); }
            else return;
        }
    }
    void term() {
        power();
        while (true) {
            if (consume('*')) { power(); m_code.push_back({ExpressionOp::Multiply}); }
            else if (consume('/')) { power(); m_code.push_back({ExpressionOp::Divide}); }
            else return;
        }
    }
    void power() {
        factor();
        if (consume('^')) { power(); m_code.push_back({ExpressionOp::Power}); }
    }
    void factor() {
        whitespace();
        if (consume('-')) { factor(); m_code.push_back({ExpressionOp::Negate}); return; }
        if (consume('(')) { comparison(); if (!consume(')')) fail("')' ausente"); return; }
        if (m_position >= m_text.size()) fail("operando ausente");
        const size_t begin = m_position;
        if ((m_text[m_position] >= '0' && m_text[m_position] <= '9') || m_text[m_position] == '.') {
            while (m_position < m_text.size() && ((m_text[m_position] >= '0' && m_text[m_position] <= '9') ||
                   m_text[m_position] == '.' || m_text[m_position] == 'e' || m_text[m_position] == 'E' ||
                   m_text[m_position] == '+' || m_text[m_position] == '-')) {
                if ((m_text[m_position] == '+' || m_text[m_position] == '-') && m_position > begin &&
                    m_text[m_position - 1] != 'e' && m_text[m_position - 1] != 'E') break;
                ++m_position;
            }
            try { m_code.push_back({ExpressionOp::Constant, std::stod(std::string(m_text.substr(begin, m_position - begin)))}); }
            catch (...) { fail("numero invalido"); }
            return;
        }
        if ((m_text[m_position] >= 'A' && m_text[m_position] <= 'Z') ||
            (m_text[m_position] >= 'a' && m_text[m_position] <= 'z') || m_text[m_position] == '_') {
            ++m_position;
            while (m_position < m_text.size() && ((m_text[m_position] >= 'A' && m_text[m_position] <= 'Z') ||
                   (m_text[m_position] >= 'a' && m_text[m_position] <= 'z') ||
                   (m_text[m_position] >= '0' && m_text[m_position] <= '9') || m_text[m_position] == '_')) ++m_position;
            const std::string_view name = m_text.substr(begin, m_position - begin);
            for (uint16_t index = 0; index < m_inputs.size(); ++index) if (m_inputs[index].id == name) {
                m_code.push_back({ExpressionOp::Input, 0.0, index}); return;
            }
            fail("entrada desconhecida");
        }
        fail("operando invalido");
    }

    std::string_view m_text;
    const std::vector<SignalPortDefinition>& m_inputs;
    std::vector<ExpressionInstruction>& m_code;
    size_t m_position = 0;
};

struct CompiledBlock {
    SignalBlockKind kind;
    SignalSlotHandle output;
    std::string outputUnit;
    std::vector<InputBinding> inputs;
    std::vector<double> realParameters;
    std::vector<int64_t> intParameters;
    std::vector<uint8_t> boolParameters;
    std::vector<ExpressionInstruction> expression;
    uint16_t expressionDepth = 0;
    uint32_t stateOffset = UINT32_MAX;
    uint16_t stateWidth = 0;
    uint32_t delayIndex = UINT32_MAX;
    uint64_t delayNs = 0;
    uint32_t historyCapacity = 0;
    // Kernel (biblioteca equivalente ao Simulink, docs/66 §4)
    const library::KernelSpec* kernel = nullptr;
    std::vector<uint8_t> feedthrough;
    std::vector<uint16_t> inputWidths;
    uint32_t discreteOffset = 0;
    uint32_t discreteCount = 0;
    uint32_t paramOffset = 0;
    uint32_t paramCount = 0;
    /** Índice do RateGroup; `kContinuousGroup` para a partição contínua. */
    uint32_t group = UINT32_MAX;
    double samplePeriod = 0.0;
};

constexpr uint32_t kContinuousGroup = UINT32_MAX - 1;
constexpr uint32_t kMixedRateGroup = UINT32_MAX - 2;

struct ExecutionItem {
    std::vector<uint32_t> blocks;
    std::vector<uint32_t> continuousBlocks;
    uint32_t group = 0;
    bool fixedPoint = false;
    uint32_t maxIterations = 1;
    double tolerance = 0.0;
    uint32_t microstep = 0;
};

struct RateGroup {
    SignalRate rate;
    std::vector<ExecutionItem> items;
};

} // namespace

class CompiledSignalGraph {
public:
    std::vector<std::string> blockIds;
    std::vector<CompiledBlock> blocks;
    std::vector<RateGroup> rateGroups;
    uint32_t realCount = 0;
    uint32_t boolCount = 0;
    uint32_t intCount = 0;
    uint16_t expressionDepth = 0;
    uint32_t maxMicrosteps = 0;
    uint32_t dynamicStateCount = 0;
    std::vector<uint32_t> continuousBlocks;
    std::vector<uint32_t> discreteStateBlocks;
    std::vector<uint32_t> delayBlocks;
    /** Ordem topológica GLOBAL (todas as taxas): no mesmo instante, os grupos devidos executam
     * nesta ordem, como a execução single-tasking do Simulink (docs/66 §4.3). */
    std::vector<ExecutionItem> items;
    /** Itens da partição contínua (Kernel de tempo contínuo), na ordem global. */
    std::vector<uint32_t> continuousItems;
    std::vector<uint32_t> continuousPartition;
    std::vector<uint32_t> kernelBlocks;
    std::vector<double> kernelParamInit;
    uint32_t kernelDiscreteCount = 0;
    uint16_t maxKernelInputs = 0;
    uint32_t maxKernelInputElements = 0;
    std::unordered_map<std::string, uint32_t> blockIndexById;
};

namespace {

bool isContinuous(SignalBlockKind kind) {
    switch (kind) {
    case SignalBlockKind::Integrator:
    case SignalBlockKind::FilteredDerivative:
    case SignalBlockKind::DeadTime:
    case SignalBlockKind::FirstOrder:
    case SignalBlockKind::SecondOrder:
    case SignalBlockKind::LeadLag:
    case SignalBlockKind::Fopdt:
    case SignalBlockKind::Accumulator:
    case SignalBlockKind::RateLimiter:
    case SignalBlockKind::StateSpaceContinuous:
        return true;
    default:
        return false;
    }
}

bool isDiscreteState(SignalBlockKind kind) {
    return kind == SignalBlockKind::UnitDelay || kind == SignalBlockKind::Hysteresis ||
           kind == SignalBlockKind::Stiction || kind == SignalBlockKind::Pid ||
           kind == SignalBlockKind::DiscreteTransferFunction || kind == SignalBlockKind::StateSpaceDiscrete;
}

bool usesDelay(SignalBlockKind kind) {
    return kind == SignalBlockKind::DeadTime || kind == SignalBlockKind::Fopdt;
}

size_t expectedInputCount(SignalBlockKind kind) {
    switch (kind) {
    case SignalBlockKind::Integrator:
    case SignalBlockKind::FilteredDerivative:
    case SignalBlockKind::UnitDelay:
    case SignalBlockKind::DiscreteTransferFunction:
    case SignalBlockKind::StateSpaceContinuous:
    case SignalBlockKind::StateSpaceDiscrete:
    case SignalBlockKind::DeadTime:
    case SignalBlockKind::FirstOrder:
    case SignalBlockKind::SecondOrder:
    case SignalBlockKind::LeadLag:
    case SignalBlockKind::Fopdt:
    case SignalBlockKind::ValveCharacteristic:
    case SignalBlockKind::Saturation:
    case SignalBlockKind::Deadband:
    case SignalBlockKind::Hysteresis:
    case SignalBlockKind::Stiction:
    case SignalBlockKind::RateLimiter:
        return 1;
    case SignalBlockKind::Pid:
        return std::numeric_limits<size_t>::max();
    default:
        return std::numeric_limits<size_t>::max();
    }
}

size_t minimumParameterCount(SignalBlockKind kind) {
    switch (kind) {
    case SignalBlockKind::Integrator: return 2;             // gain, initial
    case SignalBlockKind::FilteredDerivative: return 3;    // gain, filter tau, initial filter
    case SignalBlockKind::UnitDelay: return 1;              // initial
    case SignalBlockKind::DiscreteTransferFunction: return 1; // dynamic coefficient count is validated separately
    case SignalBlockKind::DeadTime: return 2;               // delay seconds, initial
    case SignalBlockKind::FirstOrder: return 3;             // gain, tau, initial
    case SignalBlockKind::SecondOrder: return 5;            // gain, omega, zeta, y0, dy0
    case SignalBlockKind::LeadLag: return 4;                 // gain, lead tau, lag tau, initial filter
    case SignalBlockKind::Fopdt: return 4;                   // gain, tau, delay seconds, initial
    case SignalBlockKind::Accumulator: return 5;             // initial, lower, upper, lower/upper por entrada
    case SignalBlockKind::ValveCharacteristic: return 2;    // coefficient, exponent
    case SignalBlockKind::Saturation: return 2;              // minimum, maximum
    case SignalBlockKind::Deadband: return 1;                // full width
    case SignalBlockKind::Hysteresis: return 5;              // low/high thresholds, low/high outputs, initial
    case SignalBlockKind::Stiction: return 3;                // breakaway, slip, initial
    case SignalBlockKind::RateLimiter: return 3;             // rise/s, fall/s, initial
    case SignalBlockKind::Pid: return 10;                    // Kc,Ti,Td,bias,Tf,min,max,action,D-on-PV,I0
    default: return 0;
    }
}

uint16_t stateWidthFor(const SignalBlockDefinition& block) {
    if (!isContinuous(block.kind) && !isDiscreteState(block.kind)) return 0;
    if (block.kind == SignalBlockKind::StateSpaceContinuous || block.kind == SignalBlockKind::StateSpaceDiscrete) {
        if (block.intParameters.size() != 1 || block.intParameters[0] < 1 || block.intParameters[0] > 24)
            throw std::invalid_argument("realizacao de espaco de estados exige de 1 a 24 estados: " + block.id);
        return static_cast<uint16_t>(block.intParameters[0]);
    }
    if (block.kind == SignalBlockKind::DiscreteTransferFunction) {
        if (block.intParameters.size() != 2 || block.intParameters[1] < 2) return 0;
        const uint64_t width = 2ull * static_cast<uint64_t>(block.intParameters[1] - 1);
        if (width > std::numeric_limits<uint16_t>::max()) throw std::invalid_argument("ordem do controlador discreto excede o limite do bloco: " + block.id);
        return static_cast<uint16_t>(width);
    }
    return static_cast<uint16_t>(block.output.type.width *
        (block.kind == SignalBlockKind::SecondOrder ? 2u : block.kind == SignalBlockKind::Pid ? 4u : 1u));
}

uint64_t secondsToNanoseconds(double seconds, const std::string& blockId) {
    if (!std::isfinite(seconds) || seconds < 0.0 || seconds > static_cast<double>(UINT64_MAX) * 1e-9)
        throw std::invalid_argument("atraso invalido no bloco: " + blockId);
    return static_cast<uint64_t>(std::llround(seconds * 1e9));
}

void validateBlock(const SignalBlockDefinition& block, uint16_t maxWidth) {
    if (block.id.empty()) throw std::invalid_argument("bloco de sinal exige id");
    if (block.output.id.empty()) throw std::invalid_argument("saida de sinal exige id: " + block.id);
    if (block.output.type.width == 0 || block.output.type.width > maxWidth)
        throw std::invalid_argument("largura de vetor invalida no bloco: " + block.id);
    if (block.rate.periodNs == 0 && block.kind != SignalBlockKind::Kernel)
        throw std::invalid_argument("periodo de RateGroup deve ser positivo: " + block.id);
    if (block.kind == SignalBlockKind::Kernel) {
        if (!library::findKernel(block.kernel)) throw std::invalid_argument("kernel desconhecido '" + block.kernel + "' no bloco: " + block.id);
        if (block.output.type.scalar != SignalScalarType::Real) throw std::invalid_argument("bloco Kernel exige saida Real: " + block.id);
        for (const auto& input : block.inputs)
            if (input.type.scalar != SignalScalarType::Real) throw std::invalid_argument("bloco Kernel exige entradas Real: " + block.id);
        if (block.rate.continuous() && block.rate.offsetNs != 0) throw std::invalid_argument("bloco continuo nao tem deslocamento: " + block.id);
    }
    unitInfo(block.output.unit);
    std::unordered_map<std::string, bool> ports;
    for (const auto& input : block.inputs) {
        if (input.id.empty() || !ports.emplace(input.id, true).second)
            throw std::invalid_argument("porta de entrada invalida/duplicada no bloco: " + block.id);
        if (input.type.width == 0 || input.type.width > maxWidth)
            throw std::invalid_argument("largura de vetor invalida no bloco: " + block.id);
        unitInfo(input.unit);
    }
    const size_t count = block.inputs.size();
    if ((block.kind == SignalBlockKind::Source || block.kind == SignalBlockKind::ExternalInput) && count != 0)
        throw std::invalid_argument("Source/ExternalInput nao aceita entradas: " + block.id);
    if ((block.kind == SignalBlockKind::Gain || block.kind == SignalBlockKind::Limiter || block.kind == SignalBlockKind::Probe) && count != 1)
        throw std::invalid_argument("bloco exige exatamente uma entrada: " + block.id);
    if ((block.kind == SignalBlockKind::Sum || block.kind == SignalBlockKind::Product) && count == 0)
        throw std::invalid_argument("bloco exige ao menos uma entrada: " + block.id);
    if (block.kind == SignalBlockKind::Selector && count != 3)
        throw std::invalid_argument("Selector exige condicao, verdadeiro e falso: " + block.id);
    if (block.kind == SignalBlockKind::CalcExpression && block.output.type.scalar != SignalScalarType::Real)
        throw std::invalid_argument("CalcExpression exige saida Real: " + block.id);
    if (block.kind == SignalBlockKind::Selector && block.inputs.front().type.scalar != SignalScalarType::Bool)
        throw std::invalid_argument("primeira entrada de Selector deve ser Bool: " + block.id);
    const auto sameAsOutput = [&](size_t input) { return block.inputs[input].type == block.output.type; };
    if (block.kind == SignalBlockKind::Probe && !sameAsOutput(0))
        throw std::invalid_argument("Probe exige entrada e saida do mesmo tipo: " + block.id);
    if (block.kind == SignalBlockKind::Selector) {
        if (block.inputs[0].type.width != block.output.type.width || !sameAsOutput(1) || !sameAsOutput(2))
            throw std::invalid_argument("Selector exige vetores de mesma largura/tipo: " + block.id);
    }
    if (block.kind == SignalBlockKind::Gain || block.kind == SignalBlockKind::Sum ||
        block.kind == SignalBlockKind::Product || block.kind == SignalBlockKind::Limiter) {
        if (block.output.type.scalar == SignalScalarType::Bool)
            throw std::invalid_argument("operacao numerica nao aceita Bool: " + block.id);
        for (size_t input = 0; input < count; ++input) if (!sameAsOutput(input))
            throw std::invalid_argument("operacao numerica exige portas do mesmo tipo: " + block.id);
    }
    if (block.kind == SignalBlockKind::CalcExpression) for (const auto& input : block.inputs)
        if (input.type.scalar != SignalScalarType::Real || input.type.width != block.output.type.width)
            throw std::invalid_argument("CalcExpression exige entradas Real da largura da saida: " + block.id);
    const size_t parameterCount = block.output.type.scalar == SignalScalarType::Real ? block.realParameters.size()
                                  : block.output.type.scalar == SignalScalarType::Int64 ? block.intParameters.size()
                                  : block.boolParameters.size();
    if ((block.kind == SignalBlockKind::Source || block.kind == SignalBlockKind::ExternalInput) &&
        parameterCount != 1 && parameterCount != block.output.type.width)
        throw std::invalid_argument("Source/ExternalInput exige um valor escalar ou um por elemento: " + block.id);
    if (block.kind == SignalBlockKind::Gain && parameterCount != 1)
        throw std::invalid_argument("Gain exige um parametro: " + block.id);
    if (block.kind == SignalBlockKind::Limiter && parameterCount != 2)
        throw std::invalid_argument("Limiter exige limites minimo e maximo: " + block.id);
    if (block.kind == SignalBlockKind::Limiter) {
        const bool reversed = block.output.type.scalar == SignalScalarType::Real
                                  ? block.realParameters[0] > block.realParameters[1]
                                  : block.intParameters[0] > block.intParameters[1];
        if (reversed) throw std::invalid_argument("Limiter exige minimo <= maximo: " + block.id);
    }
    const size_t dynamicInputs = expectedInputCount(block.kind);
    if (block.kind == SignalBlockKind::DiscreteTransferFunction) {
        if (count != 1 || block.output.type != SignalDataType{SignalScalarType::Real, 1} ||
            block.inputs[0].type != SignalDataType{SignalScalarType::Real, 1})
            throw std::invalid_argument("funcao discreta exige uma entrada e uma saida Real escalar: " + block.id);
        if (block.intParameters.size() != 2 || block.intParameters[0] < 1 || block.intParameters[1] < 2 ||
            block.intParameters[0] > block.intParameters[1] ||
            (block.realParameters.size() != static_cast<size_t>(block.intParameters[0] + block.intParameters[1]) &&
             block.realParameters.size() != static_cast<size_t>(block.intParameters[0] + block.intParameters[1] + 2 * (block.intParameters[1] - 1))))
            throw std::invalid_argument("coeficientes invalidos na funcao discreta: " + block.id);
        if (block.realParameters[static_cast<size_t>(block.intParameters[0])] == 0.0 ||
            !std::all_of(block.realParameters.begin(), block.realParameters.end(), [](double value) { return std::isfinite(value); }))
            throw std::invalid_argument("funcao discreta exige coeficientes finitos e denominador nao nulo: " + block.id);
    }
    if (block.kind == SignalBlockKind::StateSpaceContinuous || block.kind == SignalBlockKind::StateSpaceDiscrete) {
        if (block.intParameters.size() != 1 || block.intParameters[0] < 1 || block.intParameters[0] > 24)
            throw std::invalid_argument("espaco de estados exige de 1 a 24 estados: " + block.id);
        const size_t n = static_cast<size_t>(block.intParameters[0]);
        if (count != 1 || block.output.type != SignalDataType{SignalScalarType::Real, 1} ||
            block.inputs[0].type != SignalDataType{SignalScalarType::Real, 1} ||
            (block.realParameters.size() != n * n + 2 * n + 1 && block.realParameters.size() != n * n + 3 * n + 1) ||
            !std::all_of(block.realParameters.begin(), block.realParameters.end(), [](double value) { return std::isfinite(value); }))
            throw std::invalid_argument("matrizes SISO A/B/C/D invalidas no bloco: " + block.id);
    }
    if (block.kind == SignalBlockKind::Pid) {
        if (count != 2 && count != 4)
            throw std::invalid_argument("PID exige entradas SP/PV e, opcionalmente, A/M e L/R: " + block.id);
        if (block.output.type.scalar != SignalScalarType::Real)
            throw std::invalid_argument("PID exige saida Real: " + block.id);
        for (const auto& input : block.inputs)
            if (input.type != block.output.type)
                throw std::invalid_argument("PID exige entradas Real da largura da saida: " + block.id);
    }
    if (dynamicInputs != std::numeric_limits<size_t>::max()) {
        if (count != dynamicInputs) throw std::invalid_argument("quantidade de entradas invalida no bloco dinamico: " + block.id);
        if (block.output.type.scalar != SignalScalarType::Real)
            throw std::invalid_argument("bloco dinamico exige saida Real: " + block.id);
        for (const auto& input : block.inputs)
            if (input.type != block.output.type) throw std::invalid_argument("bloco dinamico exige entradas Real da largura da saida: " + block.id);
        if (block.realParameters.size() < minimumParameterCount(block.kind))
            throw std::invalid_argument("parametros insuficientes no bloco dinamico: " + block.id);
    }
    if ((block.kind == SignalBlockKind::FilteredDerivative || block.kind == SignalBlockKind::FirstOrder ||
         block.kind == SignalBlockKind::Fopdt) && !(block.realParameters[1] > 0.0))
        throw std::invalid_argument("constante de tempo deve ser positiva: " + block.id);
    if (block.kind == SignalBlockKind::SecondOrder && (!(block.realParameters[1] > 0.0) || block.realParameters[2] < 0.0))
        throw std::invalid_argument("SecondOrder exige frequencia positiva e amortecimento nao negativo: " + block.id);
    if (block.kind == SignalBlockKind::LeadLag && (!(block.realParameters[2] > 0.0) || block.realParameters[1] < 0.0))
        throw std::invalid_argument("LeadLag exige constantes de tempo validas: " + block.id);
    if (block.kind == SignalBlockKind::Accumulator) {
        const auto& p = block.realParameters;
        if (p.size() < minimumParameterCount(block.kind))
            throw std::invalid_argument("Accumulator exige initial, lower, upper e as flags de entrada: " + block.id);
        const size_t expected = 2 + (p[3] != 0.0 ? 1 : 0) + (p[4] != 0.0 ? 1 : 0);
        if (count != expected)
            throw std::invalid_argument("Accumulator exige entradas in, outflow e as fronteiras declaradas: " + block.id);
        if (block.output.type != SignalDataType{SignalScalarType::Real, AccumulatorWidth})
            throw std::invalid_argument("Accumulator exige saida Real de largura 17: " + block.id);
        for (const auto& input : block.inputs)
            if (input.type != SignalDataType{SignalScalarType::Real, 1})
                throw std::invalid_argument("Accumulator exige entradas Real escalares: " + block.id);
        if (std::isnan(p[0]) || std::isnan(p[1]) || std::isnan(p[2]) || !(p[2] > p[1]))
            throw std::invalid_argument("Accumulator exige lower < upper: " + block.id);
    }
    if (block.kind == SignalBlockKind::Element) {
        if (count != 1 || block.inputs[0].type.scalar != SignalScalarType::Real)
            throw std::invalid_argument("Element exige uma entrada Real: " + block.id);
        if (block.output.type != SignalDataType{SignalScalarType::Real, 1})
            throw std::invalid_argument("Element exige saida Real escalar: " + block.id);
        const double index = block.realParameters.empty() ? -1.0 : block.realParameters[0];
        if (!(index >= 0.0) || index != std::floor(index) || index >= block.inputs[0].type.width)
            throw std::invalid_argument("Element exige indice inteiro dentro do vetor de entrada: " + block.id);
    }
    if ((block.kind == SignalBlockKind::DeadTime || block.kind == SignalBlockKind::Fopdt) && block.historyCapacity < 2)
        throw std::invalid_argument("atraso exige historyCapacity >= 2: " + block.id);
    if (block.kind == SignalBlockKind::Saturation && block.realParameters[0] > block.realParameters[1])
        throw std::invalid_argument("Saturation exige minimo <= maximo: " + block.id);
    if (block.kind == SignalBlockKind::Deadband && block.realParameters[0] < 0.0)
        throw std::invalid_argument("Deadband exige largura nao negativa: " + block.id);
    if (block.kind == SignalBlockKind::Hysteresis && block.realParameters[0] > block.realParameters[1])
        throw std::invalid_argument("Hysteresis exige limiar baixo <= alto: " + block.id);
    if (block.kind == SignalBlockKind::Stiction && (block.realParameters[0] < 0.0 || block.realParameters[1] < 0.0 ||
                                                    block.realParameters[1] > block.realParameters[0]))
        throw std::invalid_argument("Stiction exige 0 <= slip <= breakaway: " + block.id);
    if (block.kind == SignalBlockKind::RateLimiter && (block.realParameters[0] < 0.0 || block.realParameters[1] < 0.0))
        throw std::invalid_argument("RateLimiter exige taxas nao negativas: " + block.id);
    if (block.kind == SignalBlockKind::Pid) {
        const auto& p = block.realParameters;
        if (p[1] < 0.0 || p[2] < 0.0 || (p[2] > 0.0 && !(p[4] > 0.0)) || p[5] > p[6] || p[7] == 0.0)
            throw std::invalid_argument("PID possui Ti/Td/filtro/limites/acao invalidos: " + block.id);
    }
}

SignalSlotHandle allocateSlot(const SignalDataType& type, CompiledSignalGraph& graph) {
    uint32_t* count = type.scalar == SignalScalarType::Real ? &graph.realCount
                      : type.scalar == SignalScalarType::Bool ? &graph.boolCount : &graph.intCount;
    SignalSlotHandle result{type.scalar, *count, type.width};
    *count += type.width;
    return result;
}

bool sameRate(const SignalRate& a, const SignalRate& b) { return a == b; }

} // namespace

std::shared_ptr<const CompiledSignalGraph> SignalCompiler::compile(const SignalGraphDefinition& definition) {
    if (definition.maxVectorWidth == 0) throw std::invalid_argument("maxVectorWidth deve ser positivo");
    if (definition.maxMicrosteps == 0) throw std::invalid_argument("maxMicrosteps deve ser positivo");
    auto graph = std::make_shared<CompiledSignalGraph>();
    graph->maxMicrosteps = definition.maxMicrosteps;
    const uint32_t count = static_cast<uint32_t>(definition.blocks.size());
    graph->blocks.resize(count);
    graph->blockIds.resize(count);
    std::unordered_map<std::string, uint32_t> blockById;
    for (uint32_t index = 0; index < count; ++index) {
        const auto& source = definition.blocks[index];
        validateBlock(source, definition.maxVectorWidth);
        if (!blockById.emplace(source.id, index).second) throw std::invalid_argument("id de bloco duplicado: " + source.id);
        graph->blockIds[index] = source.id;
        auto& target = graph->blocks[index];
        target.kind = source.kind;
        target.output = allocateSlot(source.output.type, *graph);
        target.outputUnit = source.output.unit;
        target.realParameters = source.realParameters;
        target.intParameters = source.intParameters;
        target.boolParameters = source.boolParameters;
        target.inputs.resize(source.inputs.size());
        target.stateWidth = stateWidthFor(source);
        if (source.kind == SignalBlockKind::Kernel) {
            target.kernel = library::findKernel(source.kernel);
            for (const auto& input : source.inputs) target.inputWidths.push_back(input.type.width);
            target.samplePeriod = source.rate.continuous() ? 0.0 : static_cast<double>(source.rate.periodNs) * 1e-9;
            const library::KernelConfig config{source.realParameters, source.intParameters, target.inputWidths,
                                               source.output.type.width, target.samplePeriod};
            library::KernelShape shape;
            try {
                shape = target.kernel->configure(config);
            } catch (const std::invalid_argument& error) {
                throw std::invalid_argument(std::string(error.what()) + " [" + source.id + "]");
            }
            if (shape.feedthrough.size() != source.inputs.size())
                throw std::logic_error("kernel '" + source.kernel + "' declarou feedthrough para um numero errado de entradas");
            if (shape.continuousStates > 0 && !source.rate.continuous())
                throw std::invalid_argument("bloco com estados continuos exige tempo de amostragem continuo: " + source.id);
            if (shape.continuousStates > std::numeric_limits<uint16_t>::max())
                throw std::invalid_argument("estados continuos demais no bloco: " + source.id);
            target.feedthrough = std::move(shape.feedthrough);
            target.stateWidth = static_cast<uint16_t>(shape.continuousStates);
            target.discreteOffset = graph->kernelDiscreteCount;
            target.discreteCount = shape.discreteStates;
            graph->kernelDiscreteCount += shape.discreteStates;
            target.paramOffset = static_cast<uint32_t>(graph->kernelParamInit.size());
            target.paramCount = static_cast<uint32_t>(source.realParameters.size());
            graph->kernelParamInit.insert(graph->kernelParamInit.end(), source.realParameters.begin(), source.realParameters.end());
            graph->maxKernelInputs = std::max<uint16_t>(graph->maxKernelInputs, static_cast<uint16_t>(source.inputs.size()));
            uint32_t elements = 0;
            for (uint16_t width : target.inputWidths) elements += width;
            graph->maxKernelInputElements = std::max(graph->maxKernelInputElements, elements);
        }
        if (target.stateWidth > 0) {
            target.stateOffset = graph->dynamicStateCount;
            graph->dynamicStateCount += target.stateWidth;
        }
        if (isContinuous(source.kind)) graph->continuousBlocks.push_back(index);
        if (isDiscreteState(source.kind)) graph->discreteStateBlocks.push_back(index);
        if (usesDelay(source.kind)) {
            target.delayIndex = static_cast<uint32_t>(graph->delayBlocks.size());
            target.delayNs = secondsToNanoseconds(
                source.realParameters[source.kind == SignalBlockKind::Fopdt ? 2 : 0], source.id);
            target.historyCapacity = source.historyCapacity;
            graph->delayBlocks.push_back(index);
        }
        if (source.kind == SignalBlockKind::CalcExpression) {
            target.expressionDepth = ExpressionParser(source.expression, source.inputs, target.expression).parse();
            graph->expressionDepth = std::max(graph->expressionDepth, target.expressionDepth);
        }
    }

    std::vector<std::vector<uint32_t>> edges(count);
    std::vector<std::vector<uint32_t>> inputSources(count);
    for (uint32_t block = 0; block < count; ++block) inputSources[block].assign(definition.blocks[block].inputs.size(), UINT32_MAX);
    for (const auto& edge : definition.connections) {
        const auto sourceIt = blockById.find(edge.sourceBlock);
        const auto targetIt = blockById.find(edge.targetBlock);
        if (sourceIt == blockById.end() || targetIt == blockById.end()) throw std::invalid_argument("conexao referencia bloco inexistente");
        const uint32_t sourceIndex = sourceIt->second;
        const uint32_t targetIndex = targetIt->second;
        const auto& source = definition.blocks[sourceIndex];
        const auto& target = definition.blocks[targetIndex];
        if (edge.sourcePort != source.output.id) throw std::invalid_argument("porta de saida inexistente: " + edge.sourceBlock + "." + edge.sourcePort);
        auto portIt = std::find_if(target.inputs.begin(), target.inputs.end(), [&](const auto& port) { return port.id == edge.targetPort; });
        if (portIt == target.inputs.end()) throw std::invalid_argument("porta de entrada inexistente: " + edge.targetBlock + "." + edge.targetPort);
        const uint32_t port = static_cast<uint32_t>(portIt - target.inputs.begin());
        if (inputSources[targetIndex][port] != UINT32_MAX) throw std::invalid_argument("entrada de sinal conectada mais de uma vez");
        if (!(source.output.type == portIt->type)) throw std::invalid_argument("tipos de sinal incompativeis na conexao " + edge.sourceBlock + " -> " + edge.targetBlock);
        LinearConversion converted = conversion(source.output.unit, portIt->unit, edge.allowUnitConversion);
        if (source.output.type.scalar != SignalScalarType::Real && (converted.scale != 1.0 || converted.offset != 0.0))
            throw std::invalid_argument("conversao de unidade so e suportada para Real");
        graph->blocks[targetIndex].inputs[port] = {graph->blocks[sourceIndex].output, converted};
        inputSources[targetIndex][port] = sourceIndex;
        // Continuous state and UnitDelay consume their input for a future accepted state. Their
        // incoming edge is therefore not an instantaneous algebraic dependency and breaks SCCs.
        // Exceção: as fronteiras do Accumulator (portas 2+) são lidas na própria ativação
        // (`projectedAccumulator`), então quem as calcula precisa rodar antes.
        const bool accumulatorBound = target.kind == SignalBlockKind::Accumulator && port >= 2;
        bool delayedInput = target.kind == SignalBlockKind::UnitDelay;
        if (target.kind == SignalBlockKind::Kernel) delayedInput = graph->blocks[targetIndex].feedthrough[port] == 0;
        if (target.kind == SignalBlockKind::DiscreteTransferFunction) {
            const size_t numeratorCount = static_cast<size_t>(target.intParameters.at(0));
            const size_t denominatorCount = static_cast<size_t>(target.intParameters.at(1));
            const double direct = denominatorCount == numeratorCount ? target.realParameters.front() : 0.0;
            delayedInput = direct == 0.0;
        }
        if ((!isContinuous(target.kind) && !delayedInput) || accumulatorBound)
            edges[sourceIndex].push_back(targetIndex);
    }
    for (uint32_t block = 0; block < count; ++block) for (uint32_t source : inputSources[block])
        if (source == UINT32_MAX) throw std::invalid_argument("entrada de sinal sem conexao no bloco: " + definition.blocks[block].id);

    // Tarjan SCC, deterministic because blocks and edges retain authoring order.
    std::vector<int32_t> discovery(count, -1), low(count), stack;
    std::vector<uint8_t> onStack(count, 0);
    std::vector<std::vector<uint32_t>> components;
    int32_t cursor = 0;
    std::function<void(uint32_t)> visit = [&](uint32_t node) {
        discovery[node] = low[node] = cursor++;
        stack.push_back(static_cast<int32_t>(node)); onStack[node] = 1;
        for (uint32_t next : edges[node]) {
            if (discovery[next] < 0) { visit(next); low[node] = std::min(low[node], low[next]); }
            else if (onStack[next]) low[node] = std::min(low[node], discovery[next]);
        }
        if (low[node] != discovery[node]) return;
        components.emplace_back();
        while (true) {
            const uint32_t member = static_cast<uint32_t>(stack.back()); stack.pop_back(); onStack[member] = 0;
            components.back().push_back(member);
            if (member == node) break;
        }
        std::sort(components.back().begin(), components.back().end());
    };
    for (uint32_t block = 0; block < count; ++block) if (discovery[block] < 0) visit(block);
    std::sort(components.begin(), components.end(), [](const auto& a, const auto& b) { return a.front() < b.front(); });
    std::vector<uint32_t> componentOf(count);
    for (uint32_t component = 0; component < components.size(); ++component)
        for (uint32_t block : components[component]) componentOf[block] = component;

    std::vector<uint8_t> cyclic(components.size(), 0);
    for (uint32_t component = 0; component < components.size(); ++component) {
        cyclic[component] = components[component].size() > 1;
        if (!cyclic[component]) for (uint32_t next : edges[components[component].front()])
            if (next == components[component].front()) cyclic[component] = 1;
        if (!cyclic[component]) continue;
        const auto& first = definition.blocks[components[component].front()];
        for (uint32_t blockIndex : components[component]) if (definition.blocks[blockIndex].kind == SignalBlockKind::DiscreteTransferFunction) {
            const auto& discrete = definition.blocks[blockIndex];
            const size_t numeratorCount = static_cast<size_t>(discrete.intParameters.at(0));
            const size_t denominatorCount = static_cast<size_t>(discrete.intParameters.at(1));
            if (denominatorCount == numeratorCount && discrete.realParameters.front() != 0.0)
                throw std::invalid_argument("funcao discreta com transmissao direta cria uma malha algebrica nao suportada: " + discrete.id);
        }
        if (first.loopPolicy != AlgebraicLoopPolicy::FixedPoint)
            throw std::invalid_argument("loop algebrico sem politica explicita no bloco: " + first.id);
        for (uint32_t block : components[component]) {
            const auto& member = definition.blocks[block];
            if (member.loopPolicy != AlgebraicLoopPolicy::FixedPoint)
                throw std::invalid_argument("todos os blocos do SCC devem declarar FixedPoint");
        }
    }

    // Grupos de taxa: só blocos discretos/externos. Blocos Kernel de tempo contínuo formam a partição
    // contínua acoplada (docs/66 §4.2) e não pertencem a nenhum RateGroup.
    std::vector<SignalRate> rates;
    for (const auto& block : definition.blocks)
        if (!block.rate.continuous() && std::find(rates.begin(), rates.end(), block.rate) == rates.end()) rates.push_back(block.rate);
    std::sort(rates.begin(), rates.end(), [](const auto& a, const auto& b) {
        if (a.periodNs != b.periodNs) return a.periodNs < b.periodNs;
        if (a.offsetNs != b.offsetNs) return a.offsetNs < b.offsetNs;
        return a.phase < b.phase;
    });
    for (const SignalRate& rate : rates) { RateGroup group; group.rate = rate; graph->rateGroups.push_back(std::move(group)); }
    const auto groupOf = [&](uint32_t blockIndex) -> uint32_t {
        const SignalRate& rate = definition.blocks[blockIndex].rate;
        if (rate.continuous()) return kContinuousGroup;
        return static_cast<uint32_t>(std::find(rates.begin(), rates.end(), rate) - rates.begin());
    };
    for (uint32_t index = 0; index < count; ++index) graph->blocks[index].group = groupOf(index);

    // Ordem topológica GLOBAL (todas as taxas). No mesmo instante, os grupos devidos executam nesta
    // ordem -- execução single-tasking do Simulink: um bloco lento que alimenta um rápido é visto no
    // mesmo instante (docs/66 §4.3). Empate entre componentes independentes: fase da taxa e depois
    // ordem de autoria (determinístico).
    std::vector<uint32_t> indegree(components.size(), 0), level(components.size(), 0);
    for (uint32_t from = 0; from < count; ++from) for (uint32_t to : edges[from]) {
        const uint32_t a = componentOf[from], b = componentOf[to];
        if (a != b) ++indegree[b];
    }
    const auto phaseOf = [&](uint32_t component) -> uint32_t {
        const SignalRate& rate = definition.blocks[components[component].front()].rate;
        return rate.continuous() ? 0u : rate.phase;
    };
    auto later = [&](uint32_t a, uint32_t b) {
        if (phaseOf(a) != phaseOf(b)) return phaseOf(a) > phaseOf(b);
        return components[a].front() > components[b].front();
    };
    std::priority_queue<uint32_t, std::vector<uint32_t>, decltype(later)> ready(later);
    for (uint32_t component = 0; component < components.size(); ++component) if (indegree[component] == 0) ready.push(component);
    std::vector<ExecutionItem> items;
    while (!ready.empty()) {
        const uint32_t component = ready.top(); ready.pop();
        ExecutionItem item;
        item.blocks = components[component]; item.fixedPoint = cyclic[component] != 0; item.microstep = level[component];
        item.group = groupOf(components[component].front());
        for (uint32_t block : item.blocks) {
            const uint32_t blockGroup = groupOf(block);
            if (blockGroup == kContinuousGroup) item.continuousBlocks.push_back(block);
            else if (blockGroup != item.group) item.group = kMixedRateGroup;
        }
        if (item.microstep >= definition.maxMicrosteps) throw std::invalid_argument("limite de microsteps excedido");
        if (item.fixedPoint) {
            item.maxIterations = std::numeric_limits<uint32_t>::max(); item.tolerance = 0.0;
            for (uint32_t block : item.blocks) {
                item.maxIterations = std::min(item.maxIterations, definition.blocks[block].maxIterations);
                item.tolerance = std::max(item.tolerance, definition.blocks[block].tolerance);
            }
            if (item.maxIterations == 0) throw std::invalid_argument("FixedPoint exige maxIterations positivo");
        }
        items.push_back(std::move(item));
        for (uint32_t from : components[component]) for (uint32_t to : edges[from]) {
            const uint32_t next = componentOf[to];
            if (next == component) continue;
            level[next] = std::max(level[next], level[component] + 1);
            if (--indegree[next] == 0) ready.push(next);
        }
    }
    if (items.size() != components.size()) throw std::logic_error("falha ao ordenar plano de sinais");
    std::stable_sort(items.begin(), items.end(), [](const auto& a, const auto& b) { return a.microstep < b.microstep; });
    graph->items = std::move(items);
    for (uint32_t itemIndex = 0; itemIndex < graph->items.size(); ++itemIndex) {
        const ExecutionItem& item = graph->items[itemIndex];
        if (!item.continuousBlocks.empty()) {
            graph->continuousItems.push_back(itemIndex);
            graph->continuousPartition.insert(graph->continuousPartition.end(), item.continuousBlocks.begin(), item.continuousBlocks.end());
        }
        for (uint32_t block : item.blocks)
            if (graph->blocks[block].kind == SignalBlockKind::Kernel) graph->kernelBlocks.push_back(block);
    }
    graph->blockIndexById = blockById;
    return graph;
}

namespace {

template <class T> T convertedValue(T value, const LinearConversion&) { return value; }
template <> double convertedValue(double value, const LinearConversion& conversion) { return value * conversion.scale + conversion.offset; }

template <class T>
T readSlot(const std::vector<T>& values, const InputBinding& binding, uint16_t element) {
    return convertedValue(values[binding.source.offset + element], binding.conversion);
}

/** Fronteira NaN = ausente; topo abaixo do fundo colapsa no fundo (estado preso, tudo transborda). */
void normalizeAccumulatorBounds(double& lower, double& upper) {
    if (std::isnan(lower)) lower = -std::numeric_limits<double>::infinity();
    if (std::isnan(upper) || upper < lower) upper = lower;
}

/** Fronteiras vigentes: parâmetro compilado ou entrada amostrada (`realParameters[3]`/`[4]`). */
template <class Read>
std::pair<double, double> accumulatorBounds(const CompiledBlock& block, Read read) {
    const bool lowerInput = block.realParameters[3] != 0.0;
    const bool upperInput = block.realParameters[4] != 0.0;
    double lower = lowerInput ? read(block.inputs[2]) : block.realParameters[1];
    double upper = upperInput ? read(block.inputs[lowerInput ? 3 : 2]) : block.realParameters[2];
    normalizeAccumulatorBounds(lower, upper);
    return {lower, upper};
}

/**
 * Projeção do estado nas fronteiras AMOSTRADAS, na própria ativação do bloco: quando `upper` passa a
 * valer menos que o estado (ex.: Vmax = A·hmax com A ajustável), o excesso sai como derramamento
 * discreto no mesmo instante em que a nova fronteira é lida -- quem lê o estado nessa ativação
 * (h = V/A) já vê o tanque no topo, nunca acima dele. Função pura do snapshot: idempotente nas
 * iterações de ponto fixo.
 */
double projectedAccumulator(const CompiledBlock& block, const std::vector<double>& reals, uint16_t element) {
    const uint32_t offset = block.output.offset;
    const auto [lower, upper] = accumulatorBounds(block, [&](const InputBinding& input) { return readSlot(reals, input, 0); });
    const double x = reals[offset + AccumulatorState];
    const double projected = std::clamp(x, lower, upper);
    if (element == AccumulatorState) return projected;
    if (element == AccumulatorCumSpill) return reals[offset + AccumulatorCumSpill] + (x - projected);
    return reals[offset + element];
}

/**
 * Um passo do acumulador conservativo com entradas ZOH em [t, t+dt] (docs/53 §2.2; oráculo:
 * docs/poc/laboratorio-calculo-limites/accumulator.mjs). O estado é linear por partes; o contato com
 * a fronteira é analítico; depois dele o estado fica na fronteira e o excesso vira overflow (topo) ou
 * unmet (fundo). Uma fronteira que se moveu para dentro do estado (upper ao vivo, ex.: Vmax = A·hmax
 * com A ajustável) gera derramamento DISCRETO contabilizado em cumOverflow. Os acumulados fecham
 * x - x0 = cumIn - cumOut - cumOverflow a menos de arredondamento.
 */
/** Soma de Neumaier: `sum + compensation` acompanha o valor exato da série de parcelas. */
void neumaierAdd(double& sum, double& compensation, double value) {
    const double total = sum + value;
    compensation += std::abs(sum) >= std::abs(value) ? (sum - total) + value : (value - total) + sum;
    sum = total;
}

/** Vetor publicado: igual ao estado, com as somas compensadas (x e acumulados) já combinadas. */
void publishAccumulator(const double* state, double* output) {
    std::copy_n(state, AccumulatorWidth, output);
    output[AccumulatorState] = state[AccumulatorState] + state[AccumulatorCompState];
    output[AccumulatorCumIn] = state[AccumulatorCumIn] + state[AccumulatorCompCumIn];
    output[AccumulatorCumOut] = state[AccumulatorCumOut] + state[AccumulatorCompCumOut];
    output[AccumulatorCumOverflow] = state[AccumulatorCumOverflow] + state[AccumulatorCompCumOverflow];
    output[AccumulatorCumUnmet] = state[AccumulatorCumUnmet] + state[AccumulatorCompCumUnmet];
}

void stepAccumulator(const double* state, double* next, double* output, double demandIn, double demandOut,
                     double lower, double upper, double startS, double dt) {
    std::copy_n(state, AccumulatorWidth, next);
    normalizeAccumulatorBounds(lower, upper);
    // Demandas com sinal, como o Tank que este bloco substitui: os modelos térmicos usam "saída" =
    // k·(T - ambiente), negativa abaixo do ambiente. Não negatividade de vazão física (tanque do
    // Laboratório) é política de quem define o parâmetro (Host), não do bloco. NaN conta como 0.
    const double qIn = std::isnan(demandIn) ? 0.0 : demandIn;
    const double qOut = std::isnan(demandOut) ? 0.0 : demandOut;
    double& xs = next[AccumulatorState];
    double& xc = next[AccumulatorCompState];
    const auto pin = [&](double boundary) { xs = boundary; xc = 0.0; };
    double x = xs + xc;
    // Normalmente já projetado na ativação (`projectedAccumulator`); fica aqui para fronteiras que
    // mudam entre ativações (fonte mais rápida que o bloco).
    if (x > upper) { next[AccumulatorCumSpill] += x - upper; pin(upper); x = upper; }
    else if (x < lower) { next[AccumulatorCumSpill] -= lower - x; pin(lower); x = lower; }
    const double net = qIn - qOut;
    double overflowVolume = 0.0;
    double unmetVolume = 0.0;
    bool contactRecorded = false;
    if (net > 0.0 && std::isfinite(upper)) {
        const double contact = (upper - x) / net;
        // Contato vindo de dentro, inclusive exatamente no fim do passo: evento com o instante analítico.
        if (x < upper && contact <= dt) { next[AccumulatorUpperContactTime] = startS + contact; contactRecorded = true; }
        if (contact <= dt) { overflowVolume = net * (dt - std::max(contact, 0.0)); pin(upper); }
        else neumaierAdd(xs, xc, net * dt);
    } else if (net < 0.0 && std::isfinite(lower)) {
        const double contact = (x - lower) / -net;
        if (x > lower && contact <= dt) { next[AccumulatorLowerContactTime] = startS + contact; contactRecorded = true; }
        if (contact <= dt) { unmetVolume = -net * (dt - std::max(contact, 0.0)); pin(lower); }
        else neumaierAdd(xs, xc, net * dt);
    } else {
        neumaierAdd(xs, xc, net * dt);
    }
    // Arredondamento perto da fronteira entra na contabilidade, nunca some.
    const double reached = xs + xc;
    if (reached > upper) {
        overflowVolume += reached - upper;
        if (!contactRecorded && x < upper) next[AccumulatorUpperContactTime] = startS + dt;
        pin(upper);
    } else if (reached < lower) {
        unmetVolume += lower - reached;
        if (!contactRecorded && x > lower) next[AccumulatorLowerContactTime] = startS + dt;
        pin(lower);
    }
    neumaierAdd(next[AccumulatorCumIn], next[AccumulatorCompCumIn], qIn * dt);
    neumaierAdd(next[AccumulatorCumOut], next[AccumulatorCompCumOut], qOut * dt - unmetVolume);
    neumaierAdd(next[AccumulatorCumOverflow], next[AccumulatorCompCumOverflow], overflowVolume);
    neumaierAdd(next[AccumulatorCumUnmet], next[AccumulatorCompCumUnmet], unmetVolume);
    const double finalX = xs + xc;
    const bool atUpper = finalX >= upper && net > 0.0;
    const bool atLower = finalX <= lower && net < 0.0;
    next[AccumulatorInActual] = qIn;
    next[AccumulatorOutActual] = atLower ? qIn : qOut;
    next[AccumulatorOverflow] = atUpper ? net : 0.0;
    next[AccumulatorUnmet] = atLower ? -net : 0.0;
    publishAccumulator(next, output);
}

int64_t wrapAdd(int64_t left, int64_t right) {
    return std::bit_cast<int64_t>(std::bit_cast<uint64_t>(left) + std::bit_cast<uint64_t>(right));
}

int64_t wrapMultiply(int64_t left, int64_t right) {
    return std::bit_cast<int64_t>(std::bit_cast<uint64_t>(left) * std::bit_cast<uint64_t>(right));
}

void evaluate(const CompiledBlock& block, const std::vector<double>& reals, const std::vector<double>& dynamicState, const std::vector<int64_t>& ints,
              const std::vector<uint8_t>& bools, std::vector<double>& realOut, std::vector<int64_t>& intOut,
              std::vector<uint8_t>& boolOut, std::vector<double>& stack) {
    const uint16_t width = block.output.width;
    for (uint16_t element = 0; element < width; ++element) {
        if (block.output.scalar == SignalScalarType::Real) {
            double value = 0.0;
            switch (block.kind) {
            case SignalBlockKind::Source: value = block.realParameters.size() == 1 ? block.realParameters[0] : block.realParameters.at(element); break;
            case SignalBlockKind::ExternalInput: value = reals.at(block.output.offset + element); break;
            case SignalBlockKind::Gain: value = readSlot(reals, block.inputs[0], element) * (block.realParameters.empty() ? 1.0 : block.realParameters[0]); break;
            case SignalBlockKind::Sum: for (const auto& input : block.inputs) value += readSlot(reals, input, element); break;
            case SignalBlockKind::Product: value = 1.0; for (const auto& input : block.inputs) value *= readSlot(reals, input, element); break;
            case SignalBlockKind::Limiter: { const double input = readSlot(reals, block.inputs[0], element); const double low = block.realParameters.at(0), high = block.realParameters.at(1); value = std::clamp(input, low, high); break; }
            case SignalBlockKind::Selector: value = readSlot(bools, block.inputs[0], element) ? readSlot(reals, block.inputs[1], element) : readSlot(reals, block.inputs[2], element); break;
            case SignalBlockKind::Probe: value = readSlot(reals, block.inputs[0], element); break;
            case SignalBlockKind::ValveCharacteristic: {
                const double input = std::max(0.0, readSlot(reals, block.inputs[0], element));
                value = block.realParameters[0] * std::pow(input, block.realParameters[1]);
                break;
            }
            case SignalBlockKind::Saturation:
                value = std::clamp(readSlot(reals, block.inputs[0], element), block.realParameters[0], block.realParameters[1]);
                break;
            case SignalBlockKind::Deadband: {
                const double input = readSlot(reals, block.inputs[0], element);
                const double halfWidth = block.realParameters[0] * 0.5;
                value = std::abs(input) <= halfWidth ? 0.0 : input - std::copysign(halfWidth, input);
                break;
            }
            case SignalBlockKind::Element:
                value = readSlot(reals, block.inputs[0], static_cast<uint16_t>(block.realParameters[0]));
                break;
            case SignalBlockKind::Accumulator:
                value = projectedAccumulator(block, reals, element);
                break;
            case SignalBlockKind::Integrator:
            case SignalBlockKind::FilteredDerivative:
            case SignalBlockKind::UnitDelay:
            case SignalBlockKind::DeadTime:
            case SignalBlockKind::FirstOrder:
            case SignalBlockKind::SecondOrder:
            case SignalBlockKind::LeadLag:
            case SignalBlockKind::Fopdt:
            case SignalBlockKind::Hysteresis:
            case SignalBlockKind::Stiction:
            case SignalBlockKind::RateLimiter:
            case SignalBlockKind::Pid:
                value = reals[block.output.offset + element];
                break;
            case SignalBlockKind::StateSpaceContinuous:
            case SignalBlockKind::StateSpaceDiscrete: {
                const size_t n = static_cast<size_t>(block.intParameters[0]);
                const size_t cOffset = n * n + n;
                for (size_t state = 0; state < n; ++state)
                    value += block.realParameters[cOffset + state] * dynamicState[block.stateOffset + state];
                value += block.realParameters[n * n + 2 * n] * readSlot(reals, block.inputs[0], 0);
                break;
            }
            case SignalBlockKind::CalcExpression: {
                uint16_t top = 0;
                for (const auto& instruction : block.expression) switch (instruction.op) {
                case ExpressionOp::Constant: stack[top++] = instruction.value; break;
                case ExpressionOp::Input: stack[top++] = readSlot(reals, block.inputs[instruction.input], element); break;
                case ExpressionOp::Add: stack[top - 2] += stack[top - 1]; --top; break;
                case ExpressionOp::Subtract: stack[top - 2] -= stack[top - 1]; --top; break;
                case ExpressionOp::Multiply: stack[top - 2] *= stack[top - 1]; --top; break;
                case ExpressionOp::Divide: stack[top - 2] /= stack[top - 1]; --top; break;
                case ExpressionOp::Power: stack[top - 2] = std::pow(stack[top - 2], stack[top - 1]); --top; break;
                case ExpressionOp::Greater: stack[top - 2] = stack[top - 2] > stack[top - 1] ? 1.0 : 0.0; --top; break;
                case ExpressionOp::Less: stack[top - 2] = stack[top - 2] < stack[top - 1] ? 1.0 : 0.0; --top; break;
                case ExpressionOp::Negate: stack[top - 1] = -stack[top - 1]; break;
                }
                value = stack[0]; break;
            }
            }
            realOut[block.output.offset + element] = value;
        } else if (block.output.scalar == SignalScalarType::Int64) {
            int64_t value = 0;
            switch (block.kind) {
            case SignalBlockKind::Source: value = block.intParameters.size() == 1 ? block.intParameters[0] : block.intParameters.at(element); break;
            case SignalBlockKind::ExternalInput: value = ints.at(block.output.offset + element); break;
            case SignalBlockKind::Gain: value = wrapMultiply(readSlot(ints, block.inputs[0], element), block.intParameters[0]); break;
            case SignalBlockKind::Sum: for (const auto& input : block.inputs) value = wrapAdd(value, readSlot(ints, input, element)); break;
            case SignalBlockKind::Product: value = 1; for (const auto& input : block.inputs) value = wrapMultiply(value, readSlot(ints, input, element)); break;
            case SignalBlockKind::Limiter: value = std::clamp(readSlot(ints, block.inputs[0], element), block.intParameters.at(0), block.intParameters.at(1)); break;
            case SignalBlockKind::Selector: value = readSlot(bools, block.inputs[0], element) ? readSlot(ints, block.inputs[1], element) : readSlot(ints, block.inputs[2], element); break;
            case SignalBlockKind::Probe: value = readSlot(ints, block.inputs[0], element); break;
            default: throw std::logic_error("operacao nao suportada para Int64");
            }
            intOut[block.output.offset + element] = value;
        } else {
            bool value = false;
            switch (block.kind) {
            case SignalBlockKind::Source: value = (block.boolParameters.size() == 1 ? block.boolParameters[0] : block.boolParameters.at(element)) != 0; break;
            case SignalBlockKind::ExternalInput: value = bools.at(block.output.offset + element) != 0; break;
            case SignalBlockKind::Selector: value = readSlot(bools, block.inputs[0], element) ? readSlot(bools, block.inputs[1], element) : readSlot(bools, block.inputs[2], element); break;
            case SignalBlockKind::Probe: value = readSlot(bools, block.inputs[0], element); break;
            default: throw std::logic_error("operacao nao suportada para Bool");
            }
            boolOut[block.output.offset + element] = value ? 1 : 0;
        }
    }
}

template <class T>
void commitSlot(const SignalSlotHandle& slot, std::vector<T>& values, const std::vector<T>& candidates) {
    std::copy_n(candidates.begin() + slot.offset, slot.width, values.begin() + slot.offset);
}

double difference(const SignalSlotHandle& slot, const std::vector<double>& values, const std::vector<double>& before,
                  const std::vector<int64_t>& ints, const std::vector<int64_t>& intBefore,
                  const std::vector<uint8_t>& bools, const std::vector<uint8_t>& boolBefore) {
    double result = 0.0;
    for (uint16_t element = 0; element < slot.width; ++element) {
        const uint32_t index = slot.offset + element;
        if (slot.scalar == SignalScalarType::Real) result = std::max(result, std::abs(values[index] - before[index]));
        else if (slot.scalar == SignalScalarType::Int64) result = std::max(result, ints[index] == intBefore[index] ? 0.0 : 1.0);
        else result = std::max(result, bools[index] == boolBefore[index] ? 0.0 : 1.0);
    }
    return result;
}

template <class Derivative>
double rk4Scalar(double state, double dt, Derivative&& derivative) {
    const double k1 = derivative(state);
    const double k2 = derivative(state + 0.5 * dt * k1);
    const double k3 = derivative(state + 0.5 * dt * k2);
    const double k4 = derivative(state + dt * k3);
    return state + dt * (k1 + 2.0 * k2 + 2.0 * k3 + k4) / 6.0;
}

struct SecondOrderState { double position; double velocity; };

SecondOrderState rk4SecondOrder(SecondOrderState state, double dt, double input,
                                double gain, double omega, double damping) {
    const auto derivative = [&](SecondOrderState value) {
        return SecondOrderState{value.velocity,
            gain * omega * omega * input - 2.0 * damping * omega * value.velocity -
                omega * omega * value.position};
    };
    const auto add = [](SecondOrderState a, SecondOrderState b, double scale) {
        return SecondOrderState{a.position + scale * b.position, a.velocity + scale * b.velocity};
    };
    const SecondOrderState k1 = derivative(state);
    const SecondOrderState k2 = derivative(add(state, k1, 0.5 * dt));
    const SecondOrderState k3 = derivative(add(state, k2, 0.5 * dt));
    const SecondOrderState k4 = derivative(add(state, k3, dt));
    return {state.position + dt * (k1.position + 2.0 * k2.position + 2.0 * k3.position + k4.position) / 6.0,
            state.velocity + dt * (k1.velocity + 2.0 * k2.velocity + 2.0 * k3.velocity + k4.velocity) / 6.0};
}

} // namespace

void SignalRuntime::bind(std::shared_ptr<const CompiledSignalGraph> graph) {
    m_graph = std::move(graph);
    const uint32_t reals = m_graph ? m_graph->realCount : 0;
    const uint32_t bools = m_graph ? m_graph->boolCount : 0;
    const uint32_t ints = m_graph ? m_graph->intCount : 0;
    m_reals.assign(reals, 0.0); m_realSnapshot.assign(reals, 0.0); m_realCandidate.assign(reals, 0.0);
    m_bools.assign(bools, 0); m_boolSnapshot.assign(bools, 0); m_boolCandidate.assign(bools, 0);
    m_ints.assign(ints, 0); m_intSnapshot.assign(ints, 0); m_intCandidate.assign(ints, 0);
    m_expressionStack.assign(m_graph ? std::max<uint16_t>(1, m_graph->expressionDepth) : 1, 0.0);
    const uint32_t stateCount = m_graph ? m_graph->dynamicStateCount : 0;
    m_dynamicState.assign(stateCount, 0.0);
    m_dynamicCandidate.assign(stateCount, 0.0);
    m_dynamicFullStep.assign(stateCount, 0.0);
    m_dynamicScratch.assign(static_cast<size_t>(stateCount) * 5, 0.0);
    m_dynamicOutputCandidate.assign(reals, 0.0);
    m_delayBuffers.clear();
    m_passiveGroup.assign(m_graph ? m_graph->rateGroups.size() : 0, 1);
    for (size_t item = 0; m_graph && item < m_graph->items.size(); ++item) {
        const ExecutionItem& execution = m_graph->items[item];
        for (uint32_t block : execution.blocks) {
            const uint32_t group = m_graph->blocks[block].group;
            if (group != kContinuousGroup && m_graph->blocks[block].kind != SignalBlockKind::ExternalInput)
                m_passiveGroup[group] = 0;
        }
    }
    m_kernelDiscrete.assign(m_graph ? m_graph->kernelDiscreteCount : 0, 0.0);
    m_kernelParams = m_graph ? m_graph->kernelParamInit : std::vector<double>{};
    m_stageReals.assign(reals, 0.0);
    m_stageState.assign(stateCount, 0.0);
    m_halfState.assign(stateCount, 0.0);
    m_kernelInputs.assign(m_graph ? std::max<uint16_t>(1, m_graph->maxKernelInputs) : 1, nullptr);
    m_kernelInputWidths.assign(m_kernelInputs.size(), 1);
    m_kernelInputScratch.assign(m_graph ? std::max<uint32_t>(1, m_graph->maxKernelInputElements) : 1, 0.0);
    m_due.assign(m_graph ? m_graph->rateGroups.size() : 0, 0);
    m_constantGroupsDirty = false;
    if (m_graph) {
        m_delayBuffers.resize(m_graph->delayBlocks.size());
        for (uint32_t blockIndex = 0; blockIndex < m_graph->blocks.size(); ++blockIndex) {
            const CompiledBlock& block = m_graph->blocks[blockIndex];
            if (block.kind == SignalBlockKind::ExternalInput) {
                for (uint16_t element = 0; element < block.output.width; ++element) {
                    if (block.output.scalar == SignalScalarType::Real) {
                        m_reals[block.output.offset + element] = block.realParameters.size() == 1
                            ? block.realParameters[0] : block.realParameters.at(element);
                    } else if (block.output.scalar == SignalScalarType::Int64) {
                        m_ints[block.output.offset + element] = block.intParameters.size() == 1
                            ? block.intParameters[0] : block.intParameters.at(element);
                    } else {
                        m_bools[block.output.offset + element] = (block.boolParameters.size() == 1
                            ? block.boolParameters[0] : block.boolParameters.at(element)) != 0;
                    }
                }
            }
            if (block.stateOffset == UINT32_MAX || block.kind == SignalBlockKind::Kernel) continue;
            if (block.kind == SignalBlockKind::StateSpaceContinuous || block.kind == SignalBlockKind::StateSpaceDiscrete) {
                const size_t n = static_cast<size_t>(block.intParameters[0]);
                const size_t x0Offset = n * n + 2 * n + 1;
                for (size_t i = 0; i < n; ++i)
                    m_dynamicState[block.stateOffset + i] = block.realParameters.size() >= x0Offset + n
                        ? block.realParameters[x0Offset + i] : 0.0;
                double initialOutput = 0.0;
                const size_t cOffset = n * n + n;
                for (size_t i = 0; i < n; ++i)
                    initialOutput += block.realParameters[cOffset + i] * m_dynamicState[block.stateOffset + i];
                initialOutput += block.realParameters[n * n + 2 * n] * readSlot(m_reals, block.inputs[0], 0);
                m_reals[block.output.offset] = initialOutput;
                continue;
            }
            if (block.kind == SignalBlockKind::DiscreteTransferFunction) {
                const size_t numeratorCount = static_cast<size_t>(block.intParameters[0]);
                const size_t denominatorCount = static_cast<size_t>(block.intParameters[1]);
                const size_t coefficientCount = numeratorCount + denominatorCount;
                const size_t order = denominatorCount - 1;
                if (block.realParameters.size() == coefficientCount + 2 * order) {
                    std::copy_n(block.realParameters.data() + coefficientCount, 2 * order,
                                m_dynamicState.data() + block.stateOffset);
                    const size_t relativeDegree = denominatorCount - numeratorCount;
                    double initialOutput = relativeDegree == 0 ? block.realParameters[0] * readSlot(m_reals, block.inputs[0], 0) : 0.0;
                    for (size_t j = 1; j <= order; ++j) {
                        const size_t numeratorIndex = j >= relativeDegree ? j - relativeDegree : numeratorCount;
                        if (numeratorIndex < numeratorCount)
                            initialOutput += block.realParameters[numeratorIndex] * m_dynamicState[block.stateOffset + j - 1];
                        initialOutput -= block.realParameters[numeratorCount + j] * m_dynamicState[block.stateOffset + order + j - 1];
                    }
                    m_reals[block.output.offset] = initialOutput;
                }
                continue;
            }
            for (uint16_t element = 0; element < block.output.width; ++element) {
                if (block.kind == SignalBlockKind::Pid) {
                    m_dynamicState[block.stateOffset + element] = block.realParameters[9];
                    m_dynamicState[block.stateOffset + block.output.width + element] = 0.0;
                    m_dynamicState[block.stateOffset + 2 * block.output.width + element] = 0.0;
                    m_dynamicState[block.stateOffset + 3 * block.output.width + element] = 0.0;
                    const bool manual = block.realParameters.size() > 10 && block.realParameters[10] != 0.0;
                    const double initialOutput = manual && block.realParameters.size() > 11
                        ? block.realParameters[11] : block.realParameters[3] + block.realParameters[9];
                    m_reals[block.output.offset + element] = std::clamp(initialOutput, block.realParameters[5], block.realParameters[6]);
                    continue;
                }
                if (block.kind == SignalBlockKind::Accumulator) {
                    double initial = 0.0;
                    if (element == AccumulatorState)
                        initial = std::clamp(block.realParameters[0], block.realParameters[1], block.realParameters[2]);
                    else if (element == AccumulatorUpperContactTime || element == AccumulatorLowerContactTime)
                        initial = -1.0;
                    m_dynamicState[block.stateOffset + element] = initial;
                    m_reals[block.output.offset + element] = initial;
                    continue;
                }
                double initial = 0.0;
                switch (block.kind) {
                case SignalBlockKind::Integrator: initial = block.realParameters[1]; break;
                case SignalBlockKind::FilteredDerivative: initial = block.realParameters[2]; break;
                case SignalBlockKind::UnitDelay: initial = block.realParameters[0]; break;
                case SignalBlockKind::FirstOrder: initial = block.realParameters[2]; break;
                case SignalBlockKind::SecondOrder:
                    initial = block.realParameters[3];
                    m_dynamicState[block.stateOffset + block.output.width + element] = block.realParameters[4];
                    break;
                case SignalBlockKind::LeadLag: initial = block.realParameters[3]; break;
                case SignalBlockKind::Fopdt: initial = block.realParameters[3]; break;
                case SignalBlockKind::Hysteresis: initial = block.realParameters[4]; break;
                case SignalBlockKind::Stiction: initial = block.realParameters[2]; break;
                case SignalBlockKind::RateLimiter: initial = block.realParameters[2]; break;
                default: break;
                }
                m_dynamicState[block.stateOffset + element] = initial;
                m_reals[block.output.offset + element] = initial;
            }
            if (block.kind == SignalBlockKind::DeadTime) {
                for (uint16_t element = 0; element < block.output.width; ++element)
                    m_reals[block.output.offset + element] = block.realParameters[1];
            }
            if (block.delayIndex != UINT32_MAX) {
                DelayBuffer& buffer = m_delayBuffers[block.delayIndex];
                buffer.width = block.output.width;
                buffer.times.assign(block.historyCapacity, 0);
                buffer.values.assign(static_cast<size_t>(block.historyCapacity) * block.output.width, 0.0);
            }
        }
    }
    // Kernels: estados iniciais e uma passada de saídas em t = 0 sem efeito colateral (major = false),
    // para que quem lê o plano antes da primeira ativação veja os valores iniciais reais.
    if (m_graph) {
        for (uint32_t blockIndex : m_graph->kernelBlocks) {
            const CompiledBlock& block = m_graph->blocks[blockIndex];
            if (!block.kernel->init) continue;
            library::KernelContext context = kernelContext(blockIndex, 0, true, m_reals, m_dynamicState.data());
            block.kernel->init(context);
        }
        for (uint32_t blockIndex : m_graph->kernelBlocks) runKernelOutputs(blockIndex, 0, false, m_reals, m_dynamicState.data());
    }
    m_dynamicCandidate = m_dynamicState;
    m_dynamicFullStep = m_dynamicState;
    m_dynamicOutputCandidate = m_reals;
    m_dynamicTimeNs = 0;
    m_stageMajorNs = 0;
    m_lastExecutionNs = 0;
    m_pendingDynamicTimeNs = 0;
    m_pendingDynamicStepNs = 0;
    m_dynamicStepPending = false;
    m_nextActivationNs.clear();
    if (m_graph) for (const auto& group : m_graph->rateGroups) m_nextActivationNs.push_back(group.rate.offsetNs);
    m_metrics = {};
}

void SignalRuntime::reset() { bind(m_graph); }

void SignalRuntime::setTimeBase(uint64_t timestampNs) {
    if (m_dynamicStepPending) throw std::logic_error("nao e permitido alterar tempo com passo dinamico pendente");
    m_dynamicTimeNs = timestampNs;
    m_lastExecutionNs = timestampNs;
    for (uint32_t index = 0; m_graph && index < m_graph->rateGroups.size(); ++index) {
        const SignalRate& rate = m_graph->rateGroups[index].rate;
        // Tempo constante: avalia uma vez na base nova. Arredondar para o próximo "acerto" (2^62 ns)
        // deixava um plano religado no meio da sessão (pausa -> mudança de forma -> continua) com a
        // saída de toda Constant em zero.
        if (rate.periodNs >= kConstantSamplePeriodNs) { m_nextActivationNs[index] = timestampNs; continue; }
        if (timestampNs <= rate.offsetNs) m_nextActivationNs[index] = rate.offsetNs;
        else {
            const uint64_t elapsed = timestampNs - rate.offsetNs;
            const uint64_t periods = elapsed / rate.periodNs + (elapsed % rate.periodNs != 0);
            m_nextActivationNs[index] = periods > (std::numeric_limits<uint64_t>::max() - rate.offsetNs) / rate.periodNs
                                              ? std::numeric_limits<uint64_t>::max()
                                              : rate.offsetNs + periods * rate.periodNs;
        }
    }
}

void SignalRuntime::executeUntil(uint64_t timestampNs) {
    if (!m_graph) return;
    if (m_constantGroupsDirty) {
        // Parâmetro ajustável mudou num bloco de tempo constante: reavalia no próximo instante.
        for (uint32_t index = 0; index < m_graph->rateGroups.size(); ++index)
            if (m_graph->rateGroups[index].rate.periodNs >= kConstantSamplePeriodNs)
                m_nextActivationNs[index] = std::min(m_nextActivationNs[index], m_lastExecutionNs);
        m_constantGroupsDirty = false;
    }
    while (true) {
        uint64_t next = std::numeric_limits<uint64_t>::max();
        for (uint32_t index = 0; index < m_nextActivationNs.size(); ++index) {
            if (index < m_passiveGroup.size() && m_passiveGroup[index]) continue;
            if (m_nextActivationNs[index] <= timestampNs) next = std::min(next, m_nextActivationNs[index]);
        }
        if (next == std::numeric_limits<uint64_t>::max()) break;
        for (uint32_t index = 0; index < m_nextActivationNs.size(); ++index) {
            const bool passive = index < m_passiveGroup.size() && m_passiveGroup[index];
            m_due[index] = !passive && m_nextActivationNs[index] == next ? 1 : 0;
            if (m_due[index]) ++m_metrics.rateGroupActivations;
        }
        activateBatch(next);
        for (uint32_t index = 0; index < m_nextActivationNs.size(); ++index) {
            if (!m_due[index]) continue;
            const uint64_t period = m_graph->rateGroups[index].rate.periodNs;
            m_nextActivationNs[index] = next > std::numeric_limits<uint64_t>::max() - period
                                            ? std::numeric_limits<uint64_t>::max() : next + period;
        }
    }
    m_lastExecutionNs = std::max(m_lastExecutionNs, timestampNs);
}

library::KernelContext SignalRuntime::kernelContext(uint32_t blockIndex, uint64_t timestampNs, bool major,
                                                    std::vector<double>& reals, double* states) {
    const CompiledBlock& block = m_graph->blocks[blockIndex];
    library::KernelContext context;
    uint32_t scratch = 0;
    for (size_t port = 0; port < block.inputs.size(); ++port) {
        const InputBinding& binding = block.inputs[port];
        const double* source = reals.data() + binding.source.offset;
        const uint16_t width = block.inputWidths[port];
        if (binding.conversion.scale == 1.0 && binding.conversion.offset == 0.0) {
            m_kernelInputs[port] = source;
        } else {
            double* converted = m_kernelInputScratch.data() + scratch;
            for (uint16_t element = 0; element < width; ++element)
                converted[element] = source[element] * binding.conversion.scale + binding.conversion.offset;
            m_kernelInputs[port] = converted;
            scratch += width;
        }
        m_kernelInputWidths[port] = width;
    }
    context.tNs = timestampNs;
    context.t = static_cast<double>(timestampNs) * 1e-9;
    context.majorNs = major ? timestampNs : std::min(timestampNs, m_stageMajorNs);
    context.ts = block.samplePeriod;
    context.major = major;
    context.in = m_kernelInputs.data();
    context.inWidth = m_kernelInputWidths.data();
    context.inputCount = static_cast<uint16_t>(block.inputs.size());
    context.out = reals.data() + block.output.offset;
    context.outWidth = block.output.width;
    context.x = block.stateWidth > 0 ? states + block.stateOffset : nullptr;
    context.d = block.discreteCount > 0 ? m_kernelDiscrete.data() + block.discreteOffset : nullptr;
    context.rp = m_kernelParams.data() + block.paramOffset;
    context.rpCount = block.paramCount;
    context.ip = block.intParameters.data();
    context.ipCount = static_cast<uint32_t>(block.intParameters.size());
    return context;
}

void SignalRuntime::runKernelOutputs(uint32_t blockIndex, uint64_t timestampNs, bool major, std::vector<double>& reals,
                                     double* states) {
    library::KernelContext context = kernelContext(blockIndex, timestampNs, major, reals, states);
    m_graph->blocks[blockIndex].kernel->outputs(context);
}

void SignalRuntime::runKernelUpdate(uint32_t blockIndex, uint64_t timestampNs) {
    const CompiledBlock& block = m_graph->blocks[blockIndex];
    if (!block.kernel->update) return;
    library::KernelContext context = kernelContext(blockIndex, timestampNs, true, m_reals, m_dynamicState.data());
    block.kernel->update(context);
}

void SignalRuntime::activateBatch(uint64_t timestampNs) {
    const bool hasContinuous = !m_graph->continuousPartition.empty();
    uint32_t currentMicrostep = UINT32_MAX;
    for (const ExecutionItem& item : m_graph->items) {
        // A partição contínua é "devida" em todo passo maior: suas saídas com direct feedthrough
        // precisam refletir as saídas discretas novas deste instante.
        bool run = item.group == kContinuousGroup ? hasContinuous :
                   item.group == kMixedRateGroup ? hasContinuous : m_due[item.group] != 0;
        if (item.group == kMixedRateGroup && !run)
            for (uint32_t blockIndex : item.blocks) {
                const uint32_t group = m_graph->blocks[blockIndex].group;
                if (group != kContinuousGroup && m_due[group]) { run = true; break; }
            }
        if (!run) continue;
        if (item.microstep != currentMicrostep) {
            currentMicrostep = item.microstep;
            m_realSnapshot = m_reals; m_intSnapshot = m_ints; m_boolSnapshot = m_bools;
            ++m_metrics.microsteps;
        }
        if (!item.fixedPoint) {
            for (uint32_t blockIndex : item.blocks) {
                const CompiledBlock& block = m_graph->blocks[blockIndex];
                if (item.group == kMixedRateGroup && block.group != kContinuousGroup && !m_due[block.group]) continue;
                if (block.kind == SignalBlockKind::Kernel) {
                    runKernelOutputs(blockIndex, timestampNs, true, m_reals, m_dynamicState.data());
                    ++m_metrics.blockEvaluations;
                    continue;
                }
                if (isDiscreteState(block.kind)) {
                    for (uint16_t element = 0; element < block.output.width; ++element) {
                        if (block.kind == SignalBlockKind::DiscreteTransferFunction) {
                            const size_t numeratorCount = static_cast<size_t>(block.intParameters[0]);
                            const size_t denominatorCount = static_cast<size_t>(block.intParameters[1]);
                            const size_t order = denominatorCount - 1;
                            const size_t relativeDegree = denominatorCount - numeratorCount;
                            const double input = readSlot(m_realSnapshot, block.inputs[0], element);
                            double output = relativeDegree == 0 ? block.realParameters[0] * input : 0.0;
                            for (size_t j = 1; j <= order; ++j) {
                                const size_t numeratorIndex = j >= relativeDegree ? j - relativeDegree : numeratorCount;
                                if (numeratorIndex < numeratorCount)
                                    output += block.realParameters[numeratorIndex] * m_dynamicState[block.stateOffset + j - 1];
                                output -= block.realParameters[numeratorCount + j] *
                                          m_dynamicState[block.stateOffset + order + j - 1];
                            }
                            m_realCandidate[block.output.offset + element] = output;
                            continue;
                        }
                        if (block.kind == SignalBlockKind::Pid) {
                            const uint32_t width = block.output.width;
                            double& integral = m_dynamicState[block.stateOffset + element];
                            double& previousBasis = m_dynamicState[block.stateOffset + width + element];
                            double& filteredDerivative = m_dynamicState[block.stateOffset + 2 * width + element];
                            double& initialized = m_dynamicState[block.stateOffset + 3 * width + element];
                            const double remoteSp = readSlot(m_realSnapshot, block.inputs[0], element);
                            const double pv = readSlot(m_realSnapshot, block.inputs[1], element);
                            const double kc = block.realParameters[0];
                            const double ti = block.realParameters[1];
                            const double td = block.realParameters[2];
                            const double bias = block.realParameters[3];
                            const double filterTau = block.realParameters[4];
                            const double minimum = block.realParameters[5];
                            const double maximum = block.realParameters[6];
                            const double action = block.realParameters[7];
                            const bool derivativeOnPv = block.realParameters[8] != 0.0;
                            // Sinais industriais conforme pid_dialog.jsp: A/M=1 Auto, 0 Manual.
                            const bool manual = block.inputs.size() > 2
                                ? readSlot(m_realSnapshot, block.inputs[2], element) < 0.5
                                : block.realParameters.size() > 10 && block.realParameters[10] != 0.0;
                            const double manualOutput = block.realParameters.size() > 11 ? block.realParameters[11] : 0.0;
                            const bool localMode = block.inputs.size() > 3
                                ? readSlot(m_realSnapshot, block.inputs[3], element) >= 0.5
                                : block.realParameters.size() > 12 && block.realParameters[12] != 0.0;
                            const double sp = localMode && block.realParameters.size() > 13 ? block.realParameters[13] : remoteSp;
                            if (manual) {
                                const double basis = derivativeOnPv ? pv : action * (sp - pv);
                                previousBasis = basis;
                                filteredDerivative = 0.0;
                                integral = std::clamp(manualOutput, minimum, maximum) - bias - kc * action * (sp - pv);
                                initialized = 1.0;
                                m_realCandidate[block.output.offset + element] = std::clamp(manualOutput, minimum, maximum);
                                continue;
                            }
                            const double error = action * (sp - pv);
                            const double basis = derivativeOnPv ? pv : error;
                            double integralCandidate = integral;
                            if (initialized != 0.0) {
                                const double dt = static_cast<double>(m_graph->rateGroups[block.group].rate.periodNs) * 1e-9;
                                const double integralDelta = ti > 0.0 ? kc * error * dt / ti : 0.0;
                                integralCandidate += integralDelta;
                                if (td > 0.0) {
                                    const double rawDerivative = (basis - previousBasis) / dt;
                                    const double alpha = dt / (filterTau + dt);
                                    filteredDerivative += alpha * (rawDerivative - filteredDerivative);
                                }
                                const double derivativeTerm = kc * td * filteredDerivative * (derivativeOnPv ? -1.0 : 1.0);
                                const double unconstrained = bias + kc * error + integralCandidate + derivativeTerm;
                                if ((unconstrained > maximum && integralDelta > 0.0) ||
                                    (unconstrained < minimum && integralDelta < 0.0)) integralCandidate = integral;
                            } else {
                                initialized = 1.0;
                            }
                            integral = integralCandidate;
                            previousBasis = basis;
                            const double derivativeTerm = kc * td * filteredDerivative * (derivativeOnPv ? -1.0 : 1.0);
                            m_realCandidate[block.output.offset + element] = std::clamp(
                                bias + kc * error + integral + derivativeTerm, minimum, maximum);
                            continue;
                        }
                        const double previous = m_dynamicState[block.stateOffset + element];
                        const double input = readSlot(m_realSnapshot, block.inputs[0], element);
                        double output = previous;
                        if (block.kind == SignalBlockKind::Hysteresis) {
                            if (input <= block.realParameters[0]) output = block.realParameters[2];
                            else if (input >= block.realParameters[1]) output = block.realParameters[3];
                        } else if (block.kind == SignalBlockKind::Stiction) {
                            const double delta = input - previous;
                            if (std::abs(delta) >= block.realParameters[0])
                                output = input - std::copysign(block.realParameters[1], delta);
                        }
                        m_realCandidate[block.output.offset + element] = output;
                        if (block.kind != SignalBlockKind::UnitDelay)
                            m_dynamicState[block.stateOffset + element] = output;
                    }
                } else {
                    evaluate(block, m_realSnapshot, m_dynamicState, m_intSnapshot, m_boolSnapshot, m_realCandidate, m_intCandidate,
                             m_boolCandidate, m_expressionStack);
                }
                ++m_metrics.blockEvaluations;
            }
            for (uint32_t blockIndex : item.blocks) {
                const CompiledBlock& block = m_graph->blocks[blockIndex];
                if (item.group == kMixedRateGroup && block.group != kContinuousGroup && !m_due[block.group]) continue;
                if (block.kind == SignalBlockKind::Kernel) continue;
                const SignalSlotHandle slot = block.output;
                if (slot.scalar == SignalScalarType::Real) commitSlot(slot, m_reals, m_realCandidate);
                else if (slot.scalar == SignalScalarType::Bool) commitSlot(slot, m_bools, m_boolCandidate);
                else commitSlot(slot, m_ints, m_intCandidate);
            }
            continue;
        }
        bool converged = false;
        for (uint32_t iteration = 0; iteration < item.maxIterations; ++iteration) {
            m_realSnapshot = m_reals; m_intSnapshot = m_ints; m_boolSnapshot = m_bools;
            for (uint32_t blockIndex : item.blocks) {
                const CompiledBlock& block = m_graph->blocks[blockIndex];
                if (item.group == kMixedRateGroup && block.group != kContinuousGroup && !m_due[block.group]) continue;
                if (block.kind == SignalBlockKind::Kernel) runKernelOutputs(blockIndex, timestampNs, true, m_reals, m_dynamicState.data());
                else evaluate(block, m_realSnapshot, m_dynamicState, m_intSnapshot, m_boolSnapshot,
                              m_realCandidate, m_intCandidate, m_boolCandidate, m_expressionStack);
                ++m_metrics.blockEvaluations;
            }
            for (uint32_t blockIndex : item.blocks) {
                const CompiledBlock& block = m_graph->blocks[blockIndex];
                if (item.group == kMixedRateGroup && block.group != kContinuousGroup && !m_due[block.group]) continue;
                if (block.kind == SignalBlockKind::Kernel) continue;
                const SignalSlotHandle slot = block.output;
                if (slot.scalar == SignalScalarType::Real) commitSlot(slot, m_reals, m_realCandidate);
                else if (slot.scalar == SignalScalarType::Bool) commitSlot(slot, m_bools, m_boolCandidate);
                else commitSlot(slot, m_ints, m_intCandidate);
            }
            ++m_metrics.algebraicIterations; ++m_metrics.microsteps;
            double delta = 0.0;
            for (uint32_t blockIndex : item.blocks) {
                const CompiledBlock& block = m_graph->blocks[blockIndex];
                if (item.group == kMixedRateGroup && block.group != kContinuousGroup && !m_due[block.group]) continue;
                delta = std::max(delta, difference(block.output, m_reals, m_realSnapshot, m_ints, m_intSnapshot, m_bools, m_boolSnapshot));
            }
            if (delta <= item.tolerance) { converged = true; break; }
        }
        if (!converged) ++m_metrics.nonConvergentLoops;
    }

    // UnitDelay publishes the state captured on the previous activation and latches only after
    // every item has committed, so its input edge is a true discrete-time delay.
    for (const ExecutionItem& item : m_graph->items) {
        for (uint32_t blockIndex : item.blocks) {
        const CompiledBlock& block = m_graph->blocks[blockIndex];
        if (block.group == kContinuousGroup || !m_due[block.group]) continue;
        if (block.kind == SignalBlockKind::UnitDelay) for (uint16_t element = 0; element < block.output.width; ++element)
            m_dynamicState[block.stateOffset + element] = readSlot(m_reals, block.inputs[0], element);
        if (block.kind == SignalBlockKind::DiscreteTransferFunction) {
            const size_t order = static_cast<size_t>(block.intParameters[1] - 1);
            double* state = m_dynamicState.data() + block.stateOffset;
            for (size_t j = order; j > 1; --j) { state[j - 1] = state[j - 2]; state[order + j - 1] = state[order + j - 2]; }
            if (order) {
                state[0] = readSlot(m_reals, block.inputs[0], 0);
                state[order] = m_reals[block.output.offset];
            }
        }
        if (block.kind == SignalBlockKind::StateSpaceDiscrete) {
            const size_t n = static_cast<size_t>(block.intParameters[0]);
            const double input = readSlot(m_reals, block.inputs[0], 0);
            const double* a = block.realParameters.data();
            const double* b = a + n * n;
            for (size_t row = 0; row < n; ++row) {
                double next = b[row] * input;
                for (size_t column = 0; column < n; ++column)
                    next += a[row * n + column] * m_dynamicState[block.stateOffset + column];
                m_dynamicCandidate[block.stateOffset + row] = next;
            }
            std::copy_n(m_dynamicCandidate.data() + block.stateOffset, n, m_dynamicState.data() + block.stateOffset);
        }
        // Projeção nas fronteiras feita nesta ativação: só x e cumSpill mudam (o resto do estado,
        // inclusive as compensações, segue o passo contínuo).
        if (block.kind == SignalBlockKind::Accumulator) {
            double* state = m_dynamicState.data() + block.stateOffset;
            const double published = m_reals[block.output.offset + AccumulatorState];
            if (published != state[AccumulatorState] + state[AccumulatorCompState]) {
                state[AccumulatorState] = published;
                state[AccumulatorCompState] = 0.0;
            }
            state[AccumulatorCumSpill] = m_reals[block.output.offset + AccumulatorCumSpill];
        }
    }
    }

    // Kernels: `update` (estado discreto) depois de todas as saídas do instante, na ordem global. A
    // partição contínua também registra o passo maior (históricos de atraso, borda de reset).
    for (uint32_t blockIndex : m_graph->kernelBlocks) {
        const uint32_t group = m_graph->blocks[blockIndex].group;
        if (group == kContinuousGroup ? hasContinuous : m_due[group] != 0) runKernelUpdate(blockIndex, timestampNs);
    }

    // Record only input changes. Ring storage was allocated by bind(); no push_back occurs here.
    for (uint32_t blockIndex : m_graph->delayBlocks) {
        const CompiledBlock& block = m_graph->blocks[blockIndex];
        DelayBuffer& buffer = m_delayBuffers[block.delayIndex];
        bool changed = buffer.count == 0;
        if (!changed) {
            const uint32_t last = (buffer.head + buffer.count - 1) % static_cast<uint32_t>(buffer.times.size());
            for (uint16_t element = 0; element < buffer.width; ++element)
                changed = changed || buffer.values[static_cast<size_t>(last) * buffer.width + element] !=
                                       readSlot(m_reals, block.inputs[0], element);
        }
        if (!changed) continue;
        while (buffer.count > 1) {
            const uint32_t second = (buffer.head + 1) % static_cast<uint32_t>(buffer.times.size());
            if (buffer.times[second] + block.delayNs > timestampNs) break;
            buffer.head = second; --buffer.count;
        }
        if (buffer.count == buffer.times.size()) {
            buffer.head = (buffer.head + 1) % static_cast<uint32_t>(buffer.times.size());
            --buffer.count; ++m_metrics.delayHistoryDrops;
        }
        const uint32_t slot = (buffer.head + buffer.count) % static_cast<uint32_t>(buffer.times.size());
        buffer.times[slot] = timestampNs;
        for (uint16_t element = 0; element < buffer.width; ++element)
            buffer.values[static_cast<size_t>(slot) * buffer.width + element] =
                readSlot(m_reals, block.inputs[0], element);
        ++buffer.count;
    }
}

void SignalRuntime::beginContinuousStep(uint64_t previousNs, uint64_t currentNs) {
    if (!m_graph || (m_graph->continuousBlocks.empty() && m_graph->continuousPartition.empty()) || currentNs <= previousNs) return;
    if (m_dynamicStepPending) throw std::logic_error("passo dinamico anterior ainda pendente");
    if (previousNs != m_dynamicTimeNs)
        throw std::logic_error("tempo do SignalRuntime divergiu do Scheduler");
    m_dynamicCandidate = m_dynamicState;
    m_dynamicFullStep = m_dynamicState;
    m_dynamicOutputCandidate = m_reals;
    const double dt = static_cast<double>(currentNs - previousNs) * 1e-9;

    const auto delayedInput = [&](const CompiledBlock& block, uint64_t timeNs, uint16_t element) {
        const double initial = block.kind == SignalBlockKind::Fopdt ? block.realParameters[3]
                                                                   : block.realParameters[1];
        if (timeNs < block.delayNs) return initial;
        const uint64_t query = timeNs - block.delayNs;
        const DelayBuffer& buffer = m_delayBuffers[block.delayIndex];
        double result = initial;
        for (uint32_t position = 0; position < buffer.count; ++position) {
            const uint32_t slot = (buffer.head + position) % static_cast<uint32_t>(buffer.times.size());
            if (buffer.times[slot] > query) break;
            result = buffer.values[static_cast<size_t>(slot) * buffer.width + element];
        }
        return result;
    };

    for (uint32_t blockIndex : m_graph->continuousBlocks) {
        const CompiledBlock& block = m_graph->blocks[blockIndex];
        if (block.kind == SignalBlockKind::StateSpaceContinuous) {
            const size_t n = static_cast<size_t>(block.intParameters[0]);
            const double* a = block.realParameters.data();
            const double* b = a + n * n;
            const double* c = b + n;
            const double d = block.realParameters[n * n + 2 * n];
            const double input = readSlot(m_reals, block.inputs[0], 0);
            const size_t totalStates = m_dynamicState.size(), offset = block.stateOffset;
            double* k1 = m_dynamicScratch.data() + offset;
            double* k2 = m_dynamicScratch.data() + totalStates + offset;
            double* k3 = m_dynamicScratch.data() + 2 * totalStates + offset;
            double* k4 = m_dynamicScratch.data() + 3 * totalStates + offset;
            double* temporary = m_dynamicScratch.data() + 4 * totalStates + offset;
            const auto rk4 = [&](const double* initial, double* result, double step) {
                for (size_t row = 0; row < n; ++row) {
                    k1[row] = b[row] * input;
                    for (size_t column = 0; column < n; ++column) k1[row] += a[row * n + column] * initial[column];
                    temporary[row] = initial[row] + 0.5 * step * k1[row];
                }
                for (size_t row = 0; row < n; ++row) {
                    k2[row] = b[row] * input;
                    for (size_t column = 0; column < n; ++column) k2[row] += a[row * n + column] * temporary[column];
                    temporary[row] = initial[row] + 0.5 * step * k2[row];
                }
                for (size_t row = 0; row < n; ++row) {
                    k3[row] = b[row] * input;
                    for (size_t column = 0; column < n; ++column) k3[row] += a[row * n + column] * temporary[column];
                    temporary[row] = initial[row] + step * k3[row];
                }
                for (size_t row = 0; row < n; ++row) {
                    k4[row] = b[row] * input;
                    for (size_t column = 0; column < n; ++column) k4[row] += a[row * n + column] * temporary[column];
                    result[row] = initial[row] + step * (k1[row] + 2.0 * k2[row] + 2.0 * k3[row] + k4[row]) / 6.0;
                }
            };
            const double* state = m_dynamicState.data() + offset;
            double* full = m_dynamicFullStep.data() + offset;
            double* half = m_dynamicCandidate.data() + offset;
            rk4(state, full, dt);
            rk4(state, half, dt * 0.5);
            rk4(half, half, dt * 0.5);
            double output = d * input;
            for (size_t state = 0; state < n; ++state)
                output += c[state] * m_dynamicCandidate[block.stateOffset + state];
            m_dynamicOutputCandidate[block.output.offset] = output;
            continue;
        }
        if (block.kind == SignalBlockKind::Accumulator) {
            // Exato para entradas ZOH no passo: full == half, erro estimado 0 (como o Tank que substitui).
            const auto [lower, upper] = accumulatorBounds(block, [&](const InputBinding& input) { return readSlot(m_reals, input, 0); });
            double* candidate = m_dynamicCandidate.data() + block.stateOffset;
            stepAccumulator(m_dynamicState.data() + block.stateOffset, candidate,
                            m_dynamicOutputCandidate.data() + block.output.offset, readSlot(m_reals, block.inputs[0], 0),
                            readSlot(m_reals, block.inputs[1], 0), lower, upper, static_cast<double>(previousNs) * 1e-9, dt);
            std::copy_n(candidate, AccumulatorWidth, m_dynamicFullStep.data() + block.stateOffset);
            continue;
        }
        for (uint16_t element = 0; element < block.output.width; ++element) {
            const uint32_t stateIndex = block.stateOffset + element;
            const double state = m_dynamicState[stateIndex];
            const double rawInput = readSlot(m_reals, block.inputs[0], element);
            const double input = usesDelay(block.kind) ? delayedInput(block, previousNs, element) : rawInput;
            double full = state;
            double half = state;
            double output = state;
            switch (block.kind) {
            case SignalBlockKind::Integrator: {
                const double derivative = block.realParameters[0] * input;
                full = state + dt * derivative;
                half = state + 0.5 * dt * derivative;
                half += 0.5 * dt * derivative;
                output = half;
                break;
            }
            case SignalBlockKind::FilteredDerivative: {
                const double tau = block.realParameters[1];
                const auto derivative = [&](double value) { return (input - value) / tau; };
                full = rk4Scalar(state, dt, derivative);
                half = rk4Scalar(rk4Scalar(state, dt * 0.5, derivative), dt * 0.5, derivative);
                output = block.realParameters[0] * (rawInput - half) / tau;
                break;
            }
            case SignalBlockKind::FirstOrder:
            case SignalBlockKind::Fopdt: {
                const double gain = block.realParameters[0], tau = block.realParameters[1];
                const auto derivative = [&](double value) { return (gain * input - value) / tau; };
                full = rk4Scalar(state, dt, derivative);
                half = rk4Scalar(rk4Scalar(state, dt * 0.5, derivative), dt * 0.5, derivative);
                output = half;
                break;
            }
            case SignalBlockKind::SecondOrder: {
                const uint32_t velocityIndex = block.stateOffset + block.output.width + element;
                const SecondOrderState initial{state, m_dynamicState[velocityIndex]};
                const double gain = block.realParameters[0], omega = block.realParameters[1], damping = block.realParameters[2];
                const SecondOrderState fullState = rk4SecondOrder(initial, dt, input, gain, omega, damping);
                const SecondOrderState halfState = rk4SecondOrder(
                    rk4SecondOrder(initial, dt * 0.5, input, gain, omega, damping),
                    dt * 0.5, input, gain, omega, damping);
                full = fullState.position; half = halfState.position; output = half;
                m_dynamicFullStep[velocityIndex] = fullState.velocity;
                m_dynamicCandidate[velocityIndex] = halfState.velocity;
                break;
            }
            case SignalBlockKind::LeadLag: {
                const double lag = block.realParameters[2];
                const auto derivative = [&](double value) { return (input - value) / lag; };
                full = rk4Scalar(state, dt, derivative);
                half = rk4Scalar(rk4Scalar(state, dt * 0.5, derivative), dt * 0.5, derivative);
                const double ratio = block.realParameters[1] / lag;
                output = block.realParameters[0] * (ratio * rawInput + (1.0 - ratio) * half);
                break;
            }
            case SignalBlockKind::RateLimiter: {
                const double delta = rawInput - state;
                const double limit = (delta >= 0.0 ? block.realParameters[0] : block.realParameters[1]) * dt;
                full = state + std::clamp(delta, -limit, limit);
                half = full; output = half;
                break;
            }
            case SignalBlockKind::DeadTime:
                output = delayedInput(block, currentNs, element);
                full = half = state;
                break;
            default: break;
            }
            m_dynamicFullStep[stateIndex] = full;
            m_dynamicCandidate[stateIndex] = half;
            m_dynamicOutputCandidate[block.output.offset + element] = output;
        }
    }
    if (!m_graph->continuousPartition.empty()) integrateContinuousPartition(previousNs, currentNs);
    m_pendingDynamicTimeNs = currentNs;
    m_pendingDynamicStepNs = currentNs - previousNs;
    m_pendingDynamicErrorRatio = 0.0;
    m_dynamicStepPending = true;
}

void SignalRuntime::evaluateContinuousPartition(uint64_t timestampNs, double* states, double* derivatives) {
    for (uint32_t itemIndex : m_graph->continuousItems) {
        const ExecutionItem& item = m_graph->items[itemIndex];
        if (!item.fixedPoint) {
            for (uint32_t blockIndex : item.continuousBlocks) runKernelOutputs(blockIndex, timestampNs, false, m_stageReals, states);
            continue;
        }
        // Laço algébrico dentro da partição contínua: Gauss-Seidel limitado, mesma tolerância do item.
        for (uint32_t iteration = 0; iteration < item.maxIterations; ++iteration) {
            double delta = 0.0;
            for (uint32_t blockIndex : item.continuousBlocks) {
                const SignalSlotHandle slot = m_graph->blocks[blockIndex].output;
                std::copy_n(m_stageReals.begin() + slot.offset, slot.width, m_realSnapshot.begin() + slot.offset);
                runKernelOutputs(blockIndex, timestampNs, false, m_stageReals, states);
                for (uint16_t element = 0; element < slot.width; ++element)
                    delta = std::max(delta, std::abs(m_stageReals[slot.offset + element] - m_realSnapshot[slot.offset + element]));
            }
            if (delta <= item.tolerance) break;
        }
    }
    if (!derivatives) return;
    for (uint32_t blockIndex : m_graph->continuousPartition) {
        const CompiledBlock& block = m_graph->blocks[blockIndex];
        if (block.stateWidth == 0 || !block.kernel->derivatives) continue;
        library::KernelContext context = kernelContext(blockIndex, timestampNs, false, m_stageReals, states);
        context.dx = derivatives + block.stateOffset;
        block.kernel->derivatives(context);
    }
}

void SignalRuntime::integrateContinuousPartition(uint64_t previousNs, uint64_t currentNs) {
    const size_t stateCount = m_dynamicState.size();
    double* k1 = m_dynamicScratch.data();
    double* k2 = k1 + stateCount;
    double* k3 = k2 + stateCount;
    double* k4 = k3 + stateCount;
    m_stageReals = m_reals;
    const auto forEachState = [&](auto&& fn) {
        for (uint32_t blockIndex : m_graph->continuousPartition) {
            const CompiledBlock& block = m_graph->blocks[blockIndex];
            for (uint32_t i = block.stateOffset; block.stateWidth > 0 && i < block.stateOffset + block.stateWidth; ++i) fn(i);
        }
    };
    // RK4 clássico sobre TODOS os estados da partição, reavaliando as saídas acopladas em cada
    // estágio (o que um solver do Simulink faz nos passos menores). Entradas de fora da partição
    // (blocos discretos, pontes) ficam seguradas no valor do início do passo.
    const auto rk4 = [&](const double* base, double* result, uint64_t startNs, uint64_t lengthNs) {
        const double h = static_cast<double>(lengthNs) * 1e-9;
        const uint64_t midNs = startNs + lengthNs / 2;
        std::copy_n(base, stateCount, m_stageState.data());
        evaluateContinuousPartition(startNs, m_stageState.data(), k1);
        forEachState([&](uint32_t i) { m_stageState[i] = base[i] + 0.5 * h * k1[i]; });
        evaluateContinuousPartition(midNs, m_stageState.data(), k2);
        forEachState([&](uint32_t i) { m_stageState[i] = base[i] + 0.5 * h * k2[i]; });
        evaluateContinuousPartition(midNs, m_stageState.data(), k3);
        forEachState([&](uint32_t i) { m_stageState[i] = base[i] + h * k3[i]; });
        evaluateContinuousPartition(startNs + lengthNs, m_stageState.data(), k4);
        forEachState([&](uint32_t i) { result[i] = base[i] + h * (k1[i] + 2.0 * k2[i] + 2.0 * k3[i] + k4[i]) / 6.0; });
    };
    const uint64_t stepNs = currentNs - previousNs;
    const uint64_t halfNs = stepNs / 2;
    m_stageMajorNs = previousNs;
    rk4(m_dynamicState.data(), m_dynamicFullStep.data(), previousNs, stepNs);
    rk4(m_dynamicState.data(), m_halfState.data(), previousNs, halfNs);
    rk4(m_halfState.data(), m_dynamicCandidate.data(), previousNs + halfNs, stepNs - halfNs);
    // Saídas candidatas no fim do passo, com o estado de duas meias-etapas (o que será aceito).
    std::copy_n(m_dynamicCandidate.data(), stateCount, m_stageState.data());
    evaluateContinuousPartition(currentNs, m_stageState.data(), nullptr);
    for (uint32_t blockIndex : m_graph->continuousPartition) {
        const SignalSlotHandle slot = m_graph->blocks[blockIndex].output;
        std::copy_n(m_stageReals.begin() + slot.offset, slot.width, m_dynamicOutputCandidate.begin() + slot.offset);
    }
}

void SignalRuntime::continuousPartitionMajorStep(uint64_t timestampNs) {
    for (uint32_t itemIndex : m_graph->continuousItems)
        for (uint32_t blockIndex : m_graph->items[itemIndex].continuousBlocks)
            runKernelOutputs(blockIndex, timestampNs, true, m_reals, m_dynamicState.data());
    for (uint32_t blockIndex : m_graph->continuousPartition) runKernelUpdate(blockIndex, timestampNs);
}

double SignalRuntime::continuousErrorRatio(double absoluteTolerance, double relativeTolerance) {
    if (!m_dynamicStepPending) return 0.0;
    double maximum = 0.0;
    for (uint32_t index = 0; index < m_dynamicState.size(); ++index) {
        const double scale = absoluteTolerance + relativeTolerance *
            std::max(std::abs(m_dynamicState[index]), std::abs(m_dynamicCandidate[index]));
        maximum = std::max(maximum, std::abs(m_dynamicCandidate[index] - m_dynamicFullStep[index]) / scale);
    }
    m_pendingDynamicErrorRatio = maximum;
    return maximum;
}

void SignalRuntime::commitContinuousStep() {
    if (!m_dynamicStepPending) return;
    m_dynamicState = m_dynamicCandidate;
    for (uint32_t blockIndex : m_graph->continuousBlocks) {
        const SignalSlotHandle output = m_graph->blocks[blockIndex].output;
        std::copy_n(m_dynamicOutputCandidate.begin() + output.offset, output.width, m_reals.begin() + output.offset);
    }
    for (uint32_t blockIndex : m_graph->continuousPartition) {
        const SignalSlotHandle output = m_graph->blocks[blockIndex].output;
        std::copy_n(m_dynamicOutputCandidate.begin() + output.offset, output.width, m_reals.begin() + output.offset);
    }
    // Passo maior da partição contínua: reset/limite com efeito no estado e registro de históricos.
    if (!m_graph->continuousPartition.empty()) continuousPartitionMajorStep(m_pendingDynamicTimeNs);
    m_dynamicTimeNs = m_pendingDynamicTimeNs;
    ++m_metrics.acceptedDynamicSteps;
    m_metrics.lastAcceptedDynamicStepNs = m_pendingDynamicStepNs;
    m_metrics.lastDynamicErrorRatio = m_pendingDynamicErrorRatio;
    m_dynamicStepPending = false;
}

void SignalRuntime::rollbackContinuousStep() {
    if (!m_dynamicStepPending) return;
    ++m_metrics.rejectedDynamicSteps;
    m_metrics.lastDynamicErrorRatio = m_pendingDynamicErrorRatio;
    m_dynamicStepPending = false;
}

std::optional<uint64_t> SignalRuntime::nextEventNs() const {
    if (!m_graph) return std::nullopt;
    uint64_t next = std::numeric_limits<uint64_t>::max();
    for (size_t index = 0; index < m_nextActivationNs.size(); ++index) {
        if (index < m_passiveGroup.size() && m_passiveGroup[index]) continue;
        if (m_nextActivationNs[index] > m_lastExecutionNs) next = std::min(next, m_nextActivationNs[index]);
    }
    for (uint32_t blockIndex : m_graph->delayBlocks) {
        const CompiledBlock& block = m_graph->blocks[blockIndex];
        const DelayBuffer& buffer = m_delayBuffers[block.delayIndex];
        for (uint32_t position = 0; position < buffer.count; ++position) {
            const uint32_t slot = (buffer.head + position) % static_cast<uint32_t>(buffer.times.size());
            if (buffer.times[slot] > std::numeric_limits<uint64_t>::max() - block.delayNs) continue;
            const uint64_t due = buffer.times[slot] + block.delayNs;
            if (due > m_lastExecutionNs) next = std::min(next, due);
        }
    }
    // Instantes que a partição contínua precisa acertar exatamente (degrau, borda de pulso, atraso).
    const uint64_t reference = std::max(m_lastExecutionNs, m_dynamicTimeNs);
    for (uint32_t blockIndex : m_graph->continuousPartition) {
        const CompiledBlock& block = m_graph->blocks[blockIndex];
        if (!block.kernel->nextBreakpoint) continue;
        library::KernelContext context;
        context.tNs = reference;
        context.majorNs = reference;
        context.t = static_cast<double>(reference) * 1e-9;
        context.outWidth = block.output.width;
        context.d = block.discreteCount > 0 ? const_cast<double*>(m_kernelDiscrete.data()) + block.discreteOffset : nullptr;
        context.rp = m_kernelParams.data() + block.paramOffset;
        context.rpCount = block.paramCount;
        context.ip = block.intParameters.data();
        context.ipCount = static_cast<uint32_t>(block.intParameters.size());
        const uint64_t due = block.kernel->nextBreakpoint(context);
        if (due != library::kNoBreakpoint && due > m_lastExecutionNs) next = std::min(next, due);
    }
    return next == std::numeric_limits<uint64_t>::max() ? std::nullopt : std::optional<uint64_t>(next);
}

void SignalRuntime::noteExplicitBoundary(uint64_t timestampNs) {
    if (!m_graph) return;
    for (uint32_t blockIndex : m_graph->delayBlocks) {
        const CompiledBlock& block = m_graph->blocks[blockIndex];
        const DelayBuffer& buffer = m_delayBuffers[block.delayIndex];
        for (uint32_t position = 0; position < buffer.count; ++position) {
            const uint32_t slot = (buffer.head + position) % static_cast<uint32_t>(buffer.times.size());
            if (buffer.times[slot] <= std::numeric_limits<uint64_t>::max() - block.delayNs &&
                buffer.times[slot] + block.delayNs == timestampNs) {
                ++m_metrics.discontinuityEvents;
                return;
            }
        }
    }
}

SignalExpression::SignalExpression(std::vector<std::string> inputIds, std::string expression) {
    compile(std::move(inputIds), std::move(expression));
}

void SignalExpression::compile(std::vector<std::string> inputIds, std::string expression) {
    if (inputIds.size() > 64) throw std::invalid_argument("expressao excede 64 entradas");
    SignalGraphDefinition graph;
    graph.maxVectorWidth = 1;
    graph.maxMicrosteps = 64;
    for (const std::string& id : inputIds) {
        if (id.empty()) throw std::invalid_argument("entrada de expressao vazia");
        SignalBlockDefinition input;
        input.id = id;
        input.kind = SignalBlockKind::ExternalInput;
        input.output = {"out", {SignalScalarType::Real, 1}, ""};
        input.realParameters = {0.0};
        graph.blocks.push_back(std::move(input));
    }
    SignalBlockDefinition calc;
    calc.id = "__core_expression_output";
    calc.kind = SignalBlockKind::CalcExpression;
    calc.output = {"out", {SignalScalarType::Real, 1}, ""};
    calc.expression = expression;
    for (const std::string& id : inputIds)
        calc.inputs.push_back({id, {SignalScalarType::Real, 1}, ""});
    graph.blocks.push_back(std::move(calc));
    for (const std::string& id : inputIds)
        graph.connections.push_back({id, "out", "__core_expression_output", id, false});
    m_graph = SignalCompiler::compile(graph);
    m_runtime.bind(m_graph);
    m_inputIds = std::move(inputIds);
    m_expression = std::move(expression);
}

double SignalExpression::evaluate(std::span<const double> values, uint64_t timestampNs) {
    if (!m_graph || values.size() != m_inputIds.size())
        throw std::invalid_argument("quantidade de entradas da expressao incorreta");
    for (size_t i = 0; i < values.size(); ++i)
        m_runtime.setExternalReal(m_inputIds[i], values[i]);
    m_runtime.executeUntil(timestampNs);
    return m_runtime.real(m_runtime.output("__core_expression_output"));
}

SignalSlotHandle SignalRuntime::output(std::string_view blockId) const {
    return SignalCompiler::output(m_graph, blockId);
}

SignalSlotHandle SignalCompiler::output(const std::shared_ptr<const CompiledSignalGraph>& graph,
                                        std::string_view blockId) {
    if (!graph) throw std::logic_error("SignalGraph ausente");
    for (uint32_t index = 0; index < graph->blockIds.size(); ++index)
        if (graph->blockIds[index] == blockId) return graph->blocks[index].output;
    throw std::out_of_range("bloco de sinal inexistente: " + std::string(blockId));
}

SignalPortDefinition SignalCompiler::outputDefinition(const std::shared_ptr<const CompiledSignalGraph>& graph,
                                                      std::string_view blockId) {
    if (!graph) throw std::logic_error("SignalGraph ausente");
    for (uint32_t index = 0; index < graph->blockIds.size(); ++index) {
        if (graph->blockIds[index] == blockId) {
            const SignalSlotHandle slot = graph->blocks[index].output;
            return {"out", {slot.scalar, slot.width}, graph->blocks[index].outputUnit};
        }
    }
    throw std::out_of_range("bloco de sinal inexistente: " + std::string(blockId));
}

bool SignalCompiler::isExternalInput(const std::shared_ptr<const CompiledSignalGraph>& graph,
                                     std::string_view blockId) {
    if (!graph) return false;
    for (uint32_t index = 0; index < graph->blockIds.size(); ++index)
        if (graph->blockIds[index] == blockId) return graph->blocks[index].kind == SignalBlockKind::ExternalInput;
    return false;
}

double SignalRuntime::real(SignalSlotHandle slot, uint16_t element) const {
    if (slot.scalar != SignalScalarType::Real || element >= slot.width) throw std::invalid_argument("slot nao e Real/elemento invalido");
    return m_reals.at(slot.offset + element);
}
bool SignalRuntime::boolean(SignalSlotHandle slot, uint16_t element) const {
    if (slot.scalar != SignalScalarType::Bool || element >= slot.width) throw std::invalid_argument("slot nao e Bool/elemento invalido");
    return m_bools.at(slot.offset + element) != 0;
}
int64_t SignalRuntime::integer(SignalSlotHandle slot, uint16_t element) const {
    if (slot.scalar != SignalScalarType::Int64 || element >= slot.width) throw std::invalid_argument("slot nao e Int64/elemento invalido");
    return m_ints.at(slot.offset + element);
}

void SignalRuntime::setExternalReal(std::string_view blockId, double value, uint16_t element) {
    if (!SignalCompiler::isExternalInput(m_graph, blockId))
        throw std::invalid_argument("bridge so pode publicar em ExternalInput: " + std::string(blockId));
    const SignalSlotHandle slot = output(blockId);
    if (slot.scalar != SignalScalarType::Real || element >= slot.width)
        throw std::invalid_argument("ExternalInput nao e Real/elemento invalido");
    const uint32_t offset = slot.offset + element;
    m_reals.at(offset) = value;
    m_realSnapshot.at(offset) = value;
    m_realCandidate.at(offset) = value;
    if (offset < m_dynamicOutputCandidate.size()) m_dynamicOutputCandidate[offset] = value;
}

void SignalRuntime::setKernelParameters(std::string_view blockId, std::span<const double> values) {
    if (!m_graph) throw std::logic_error("SignalGraph ausente");
    const auto it = m_graph->blockIndexById.find(std::string(blockId));
    if (it == m_graph->blockIndexById.end()) throw std::out_of_range("bloco de sinal inexistente: " + std::string(blockId));
    const CompiledBlock& block = m_graph->blocks[it->second];
    if (block.kind != SignalBlockKind::Kernel) throw std::invalid_argument("bloco nao e Kernel: " + std::string(blockId));
    if (values.size() != block.paramCount)
        throw std::invalid_argument("parametro ajustavel mudou de tamanho (exige recompilar): " + std::string(blockId));
    std::copy(values.begin(), values.end(), m_kernelParams.begin() + block.paramOffset);
    if (block.group != kContinuousGroup && m_graph->rateGroups[block.group].rate.periodNs >= kConstantSamplePeriodNs)
        m_constantGroupsDirty = true;
}

std::span<const double> SignalRuntime::kernelParameters(std::string_view blockId) const {
    if (!m_graph) throw std::logic_error("SignalGraph ausente");
    const auto it = m_graph->blockIndexById.find(std::string(blockId));
    if (it == m_graph->blockIndexById.end()) throw std::out_of_range("bloco de sinal inexistente: " + std::string(blockId));
    const CompiledBlock& block = m_graph->blocks[it->second];
    return {m_kernelParams.data() + block.paramOffset, block.paramCount};
}

std::span<const int64_t> SignalRuntime::kernelIntParameters(std::string_view blockId) const {
    if (!m_graph) throw std::logic_error("SignalGraph ausente");
    const auto it = m_graph->blockIndexById.find(std::string(blockId));
    if (it == m_graph->blockIndexById.end()) throw std::out_of_range("bloco de sinal inexistente: " + std::string(blockId));
    return m_graph->blocks[it->second].intParameters;
}

void SignalRuntime::setExternalBool(std::string_view blockId, bool value, uint16_t element) {
    if (!SignalCompiler::isExternalInput(m_graph, blockId))
        throw std::invalid_argument("bridge so pode publicar em ExternalInput: " + std::string(blockId));
    const SignalSlotHandle slot = output(blockId);
    if (slot.scalar != SignalScalarType::Bool || element >= slot.width)
        throw std::invalid_argument("ExternalInput nao e Bool/elemento invalido");
    const uint32_t offset = slot.offset + element;
    const uint8_t stored = value ? 1 : 0;
    m_bools.at(offset) = stored;
    m_boolSnapshot.at(offset) = stored;
    m_boolCandidate.at(offset) = stored;
}

void SignalRuntime::setExternalInt64(std::string_view blockId, int64_t value, uint16_t element) {
    if (!SignalCompiler::isExternalInput(m_graph, blockId))
        throw std::invalid_argument("bridge so pode publicar em ExternalInput: " + std::string(blockId));
    const SignalSlotHandle slot = output(blockId);
    if (slot.scalar != SignalScalarType::Int64 || element >= slot.width)
        throw std::invalid_argument("ExternalInput nao e Int64/elemento invalido");
    const uint32_t offset = slot.offset + element;
    m_ints.at(offset) = value;
    m_intSnapshot.at(offset) = value;
    m_intCandidate.at(offset) = value;
}

} // namespace lasecsimul::simulation
