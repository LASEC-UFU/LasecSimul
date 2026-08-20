#include "SignalEngine.hpp"

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

enum class ExpressionOp : uint8_t { Constant, Input, Add, Subtract, Multiply, Divide, Negate };
struct ExpressionInstruction { ExpressionOp op; double value = 0.0; uint16_t input = 0; };

class ExpressionParser {
public:
    ExpressionParser(std::string_view text, const std::vector<SignalPortDefinition>& inputs,
                     std::vector<ExpressionInstruction>& code)
        : m_text(text), m_inputs(inputs), m_code(code) {}

    uint16_t parse() {
        expression();
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
    void expression() {
        term();
        while (true) {
            if (consume('+')) { term(); m_code.push_back({ExpressionOp::Add}); }
            else if (consume('-')) { term(); m_code.push_back({ExpressionOp::Subtract}); }
            else return;
        }
    }
    void term() {
        factor();
        while (true) {
            if (consume('*')) { factor(); m_code.push_back({ExpressionOp::Multiply}); }
            else if (consume('/')) { factor(); m_code.push_back({ExpressionOp::Divide}); }
            else return;
        }
    }
    void factor() {
        whitespace();
        if (consume('-')) { factor(); m_code.push_back({ExpressionOp::Negate}); return; }
        if (consume('(')) { expression(); if (!consume(')')) fail("')' ausente"); return; }
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
    std::vector<InputBinding> inputs;
    std::vector<double> realParameters;
    std::vector<int64_t> intParameters;
    std::vector<uint8_t> boolParameters;
    std::vector<ExpressionInstruction> expression;
    uint16_t expressionDepth = 0;
};

struct ExecutionItem {
    std::vector<uint32_t> blocks;
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
};

namespace {

void validateBlock(const SignalBlockDefinition& block, uint16_t maxWidth) {
    if (block.id.empty()) throw std::invalid_argument("bloco de sinal exige id");
    if (block.output.id.empty()) throw std::invalid_argument("saida de sinal exige id: " + block.id);
    if (block.output.type.width == 0 || block.output.type.width > maxWidth)
        throw std::invalid_argument("largura de vetor invalida no bloco: " + block.id);
    if (block.rate.periodNs == 0) throw std::invalid_argument("periodo de RateGroup deve ser positivo: " + block.id);
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
    if (block.kind == SignalBlockKind::Source && count != 0) throw std::invalid_argument("Source nao aceita entradas: " + block.id);
    if ((block.kind == SignalBlockKind::Gain || block.kind == SignalBlockKind::Limiter || block.kind == SignalBlockKind::Probe) && count != 1)
        throw std::invalid_argument("bloco exige exatamente uma entrada: " + block.id);
    if ((block.kind == SignalBlockKind::Sum || block.kind == SignalBlockKind::Product) && count == 0)
        throw std::invalid_argument("bloco exige ao menos uma entrada: " + block.id);
    if (block.kind == SignalBlockKind::Selector && count != 3)
        throw std::invalid_argument("Selector exige condicao, verdadeiro e falso: " + block.id);
    if (block.kind == SignalBlockKind::CalcExpression && (count == 0 || block.output.type.scalar != SignalScalarType::Real))
        throw std::invalid_argument("CalcExpression exige entradas e saida Real: " + block.id);
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
    if (block.kind == SignalBlockKind::Source && parameterCount != 1 && parameterCount != block.output.type.width)
        throw std::invalid_argument("Source exige um valor escalar ou um por elemento: " + block.id);
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
        target.realParameters = source.realParameters;
        target.intParameters = source.intParameters;
        target.boolParameters = source.boolParameters;
        target.inputs.resize(source.inputs.size());
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
        if (first.loopPolicy != AlgebraicLoopPolicy::FixedPoint)
            throw std::invalid_argument("loop algebrico sem politica explicita no bloco: " + first.id);
        for (uint32_t block : components[component]) {
            const auto& member = definition.blocks[block];
            if (member.loopPolicy != AlgebraicLoopPolicy::FixedPoint)
                throw std::invalid_argument("todos os blocos do SCC devem declarar FixedPoint");
            if (!sameRate(member.rate, first.rate)) throw std::invalid_argument("blocos do mesmo SCC devem compartilhar RateGroup");
        }
    }

    std::vector<SignalRate> rates;
    for (const auto& block : definition.blocks) if (std::find(rates.begin(), rates.end(), block.rate) == rates.end()) rates.push_back(block.rate);
    std::sort(rates.begin(), rates.end(), [](const auto& a, const auto& b) {
        if (a.periodNs != b.periodNs) return a.periodNs < b.periodNs;
        if (a.offsetNs != b.offsetNs) return a.offsetNs < b.offsetNs;
        return a.phase < b.phase;
    });
    for (const SignalRate& rate : rates) {
        RateGroup group; group.rate = rate;
        std::vector<uint8_t> belongs(components.size(), 0);
        for (uint32_t component = 0; component < components.size(); ++component)
            belongs[component] = sameRate(definition.blocks[components[component].front()].rate, rate);
        std::vector<uint32_t> indegree(components.size(), 0), level(components.size(), 0);
        for (uint32_t from = 0; from < count; ++from) for (uint32_t to : edges[from]) {
            const uint32_t a = componentOf[from], b = componentOf[to];
            if (a != b && belongs[a] && belongs[b]) ++indegree[b];
        }
        auto later = [&](uint32_t a, uint32_t b) { return components[a].front() > components[b].front(); };
        std::priority_queue<uint32_t, std::vector<uint32_t>, decltype(later)> ready(later);
        for (uint32_t component = 0; component < components.size(); ++component) if (belongs[component] && indegree[component] == 0) ready.push(component);
        while (!ready.empty()) {
            const uint32_t component = ready.top(); ready.pop();
            ExecutionItem item;
            item.blocks = components[component]; item.fixedPoint = cyclic[component] != 0; item.microstep = level[component];
            if (item.microstep >= definition.maxMicrosteps) throw std::invalid_argument("limite de microsteps excedido");
            if (item.fixedPoint) {
                item.maxIterations = std::numeric_limits<uint32_t>::max(); item.tolerance = 0.0;
                for (uint32_t block : item.blocks) {
                    item.maxIterations = std::min(item.maxIterations, definition.blocks[block].maxIterations);
                    item.tolerance = std::max(item.tolerance, definition.blocks[block].tolerance);
                }
                if (item.maxIterations == 0) throw std::invalid_argument("FixedPoint exige maxIterations positivo");
            }
            group.items.push_back(std::move(item));
            for (uint32_t from : components[component]) for (uint32_t to : edges[from]) {
                const uint32_t next = componentOf[to];
                if (next == component || !belongs[next]) continue;
                level[next] = std::max(level[next], level[component] + 1);
                if (--indegree[next] == 0) ready.push(next);
            }
        }
        size_t expected = 0; for (uint8_t value : belongs) expected += value;
        if (group.items.size() != expected) throw std::logic_error("falha ao ordenar plano de sinais");
        std::stable_sort(group.items.begin(), group.items.end(), [](const auto& a, const auto& b) { return a.microstep < b.microstep; });
        graph->rateGroups.push_back(std::move(group));
    }
    return graph;
}

namespace {

template <class T> T convertedValue(T value, const LinearConversion&) { return value; }
template <> double convertedValue(double value, const LinearConversion& conversion) { return value * conversion.scale + conversion.offset; }

template <class T>
T readSlot(const std::vector<T>& values, const InputBinding& binding, uint16_t element) {
    return convertedValue(values[binding.source.offset + element], binding.conversion);
}

int64_t wrapAdd(int64_t left, int64_t right) {
    return std::bit_cast<int64_t>(std::bit_cast<uint64_t>(left) + std::bit_cast<uint64_t>(right));
}

int64_t wrapMultiply(int64_t left, int64_t right) {
    return std::bit_cast<int64_t>(std::bit_cast<uint64_t>(left) * std::bit_cast<uint64_t>(right));
}

void evaluate(const CompiledBlock& block, const std::vector<double>& reals, const std::vector<int64_t>& ints,
              const std::vector<uint8_t>& bools, std::vector<double>& realOut, std::vector<int64_t>& intOut,
              std::vector<uint8_t>& boolOut, std::vector<double>& stack) {
    const uint16_t width = block.output.width;
    for (uint16_t element = 0; element < width; ++element) {
        if (block.output.scalar == SignalScalarType::Real) {
            double value = 0.0;
            switch (block.kind) {
            case SignalBlockKind::Source: value = block.realParameters.size() == 1 ? block.realParameters[0] : block.realParameters.at(element); break;
            case SignalBlockKind::Gain: value = readSlot(reals, block.inputs[0], element) * (block.realParameters.empty() ? 1.0 : block.realParameters[0]); break;
            case SignalBlockKind::Sum: for (const auto& input : block.inputs) value += readSlot(reals, input, element); break;
            case SignalBlockKind::Product: value = 1.0; for (const auto& input : block.inputs) value *= readSlot(reals, input, element); break;
            case SignalBlockKind::Limiter: { const double input = readSlot(reals, block.inputs[0], element); const double low = block.realParameters.at(0), high = block.realParameters.at(1); value = std::clamp(input, low, high); break; }
            case SignalBlockKind::Selector: value = readSlot(bools, block.inputs[0], element) ? readSlot(reals, block.inputs[1], element) : readSlot(reals, block.inputs[2], element); break;
            case SignalBlockKind::Probe: value = readSlot(reals, block.inputs[0], element); break;
            case SignalBlockKind::CalcExpression: {
                uint16_t top = 0;
                for (const auto& instruction : block.expression) switch (instruction.op) {
                case ExpressionOp::Constant: stack[top++] = instruction.value; break;
                case ExpressionOp::Input: stack[top++] = readSlot(reals, block.inputs[instruction.input], element); break;
                case ExpressionOp::Add: stack[top - 2] += stack[top - 1]; --top; break;
                case ExpressionOp::Subtract: stack[top - 2] -= stack[top - 1]; --top; break;
                case ExpressionOp::Multiply: stack[top - 2] *= stack[top - 1]; --top; break;
                case ExpressionOp::Divide: stack[top - 2] /= stack[top - 1]; --top; break;
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
    m_nextActivationNs.clear();
    if (m_graph) for (const auto& group : m_graph->rateGroups) m_nextActivationNs.push_back(group.rate.offsetNs);
    m_metrics = {};
}

void SignalRuntime::reset() { bind(m_graph); }

void SignalRuntime::executeUntil(uint64_t timestampNs) {
    if (!m_graph) return;
    while (true) {
        uint32_t selected = UINT32_MAX;
        uint64_t next = std::numeric_limits<uint64_t>::max();
        for (uint32_t index = 0; index < m_nextActivationNs.size(); ++index) {
            const bool earlierPhase = selected != UINT32_MAX && m_nextActivationNs[index] == next &&
                                      m_graph->rateGroups[index].rate.phase <
                                          m_graph->rateGroups[selected].rate.phase;
            const bool earlierSequence = selected != UINT32_MAX && m_nextActivationNs[index] == next &&
                                         m_graph->rateGroups[index].rate.phase ==
                                             m_graph->rateGroups[selected].rate.phase && index < selected;
            if (m_nextActivationNs[index] <= timestampNs &&
                (m_nextActivationNs[index] < next || earlierPhase || earlierSequence)) {
                selected = index; next = m_nextActivationNs[index];
            }
        }
        if (selected == UINT32_MAX) break;
        activateGroup(selected);
        const uint64_t period = m_graph->rateGroups[selected].rate.periodNs;
        m_nextActivationNs[selected] = next > std::numeric_limits<uint64_t>::max() - period
                                          ? std::numeric_limits<uint64_t>::max() : next + period;
    }
}

void SignalRuntime::activateGroup(uint32_t groupIndex) {
    const RateGroup& group = m_graph->rateGroups[groupIndex];
    ++m_metrics.rateGroupActivations;
    uint32_t currentMicrostep = UINT32_MAX;
    for (const ExecutionItem& item : group.items) {
        if (item.microstep != currentMicrostep) {
            currentMicrostep = item.microstep;
            m_realSnapshot = m_reals; m_intSnapshot = m_ints; m_boolSnapshot = m_bools;
            ++m_metrics.microsteps;
        }
        if (!item.fixedPoint) {
            for (uint32_t blockIndex : item.blocks) {
                const CompiledBlock& block = m_graph->blocks[blockIndex];
                evaluate(block, m_realSnapshot, m_intSnapshot, m_boolSnapshot, m_realCandidate, m_intCandidate,
                         m_boolCandidate, m_expressionStack);
                ++m_metrics.blockEvaluations;
            }
            for (uint32_t blockIndex : item.blocks) {
                const SignalSlotHandle slot = m_graph->blocks[blockIndex].output;
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
                evaluate(m_graph->blocks[blockIndex], m_realSnapshot, m_intSnapshot, m_boolSnapshot,
                         m_realCandidate, m_intCandidate, m_boolCandidate, m_expressionStack);
                ++m_metrics.blockEvaluations;
            }
            for (uint32_t blockIndex : item.blocks) {
                const SignalSlotHandle slot = m_graph->blocks[blockIndex].output;
                if (slot.scalar == SignalScalarType::Real) commitSlot(slot, m_reals, m_realCandidate);
                else if (slot.scalar == SignalScalarType::Bool) commitSlot(slot, m_bools, m_boolCandidate);
                else commitSlot(slot, m_ints, m_intCandidate);
            }
            ++m_metrics.algebraicIterations; ++m_metrics.microsteps;
            double delta = 0.0;
            for (uint32_t blockIndex : item.blocks) delta = std::max(delta, difference(m_graph->blocks[blockIndex].output,
                m_reals, m_realSnapshot, m_ints, m_intSnapshot, m_bools, m_boolSnapshot));
            if (delta <= item.tolerance) { converged = true; break; }
        }
        if (!converged) ++m_metrics.nonConvergentLoops;
    }
}

SignalSlotHandle SignalRuntime::output(std::string_view blockId) const {
    if (!m_graph) throw std::logic_error("SignalRuntime sem plano");
    for (uint32_t index = 0; index < m_graph->blockIds.size(); ++index)
        if (m_graph->blockIds[index] == blockId) return m_graph->blocks[index].output;
    throw std::out_of_range("bloco de sinal inexistente");
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

} // namespace lasecsimul::simulation
