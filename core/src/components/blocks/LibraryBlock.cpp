#include "LibraryBlock.hpp"

#include <algorithm>
#include <cmath>
#include <stdexcept>

#include "simulation/library/Kernel.hpp"

namespace lasecsimul::components::blocks {

namespace lib = simulation::library;

// ---------------------------------------------------------------- BuildContext

lib::ParamValue BuildContext::value(std::string_view name) const {
    const auto it = props.find(std::string(name));
    const std::string text = it == props.end() ? std::string() : propertyText(it->second);
    try {
        return lib::evaluateParam(text, resolution.workspace);
    } catch (const std::exception& error) {
        fail(std::string(name) + ": " + error.what());
    }
}

double BuildContext::scalar(std::string_view name) const {
    const lib::ParamValue parsed = value(name);
    if (!parsed.isScalar()) fail(std::string(name) + " precisa ser escalar");
    return parsed.data[0];
}

std::vector<double> BuildContext::vector(std::string_view name) const {
    const lib::ParamValue parsed = value(name);
    if (!parsed.isVector()) fail(std::string(name) + " precisa ser vetor");
    return parsed.data;
}

std::string BuildContext::text(std::string_view name) const {
    const auto it = props.find(std::string(name));
    return it == props.end() ? std::string() : propertyText(it->second);
}

bool BuildContext::flag(std::string_view name) const {
    const auto it = props.find(std::string(name));
    if (it == props.end()) return false;
    if (const bool* value = std::get_if<bool>(&it->second)) return *value;
    return propertyText(it->second) == "on";
}

std::string BuildContext::inputBlock(size_t port) const { return signalPortBlockId(componentIndex, inputPorts.at(port)); }
std::string BuildContext::outputBlock(size_t port) const { return signalPortBlockId(componentIndex, outputPorts.at(port)); }

simulation::SignalBlockDefinition& BuildContext::kernel(std::string id, std::string kernelId, std::vector<uint16_t> inputWidths,
                                                        uint16_t outWidth, std::vector<double> rp, std::vector<int64_t> ip) {
    simulation::SignalBlockDefinition block;
    block.id = id.empty() ? outputBlock(0) : std::move(id);
    block.kind = simulation::SignalBlockKind::Kernel;
    block.kernel = std::move(kernelId);
    for (size_t i = 0; i < inputWidths.size(); ++i)
        block.inputs.push_back({"in" + std::to_string(i + 1), {simulation::SignalScalarType::Real, inputWidths[i]}, ""});
    block.output = {"out", {simulation::SignalScalarType::Real, outWidth}, ""};
    block.realParameters = std::move(rp);
    block.intParameters = std::move(ip);
    block.rate = resolution.rate;
    // Laço algébrico entre blocos da biblioteca é resolvido por iteração (o Simulink também resolve
    // laços algébricos); blocos fora de qualquer ciclo ignoram a política.
    block.loopPolicy = simulation::AlgebraicLoopPolicy::FixedPoint;
    block.maxIterations = 50;
    block.tolerance = 1e-12;
    graph.blocks.push_back(std::move(block));
    return graph.blocks.back();
}

void BuildContext::connect(const std::string& from, const std::string& to, int targetPort) {
    graph.connections.push_back({from, "out", to, "in" + std::to_string(targetPort), false});
}

void BuildContext::connectInputs(const std::string& to, size_t firstInput, size_t count) {
    const size_t end = count == SIZE_MAX ? inputPorts.size() : std::min(inputPorts.size(), firstInput + count);
    for (size_t port = firstInput; port < end; ++port) connect(inputBlock(port), to, static_cast<int>(port - firstInput + 1));
}

void BuildContext::fail(const std::string& message) const {
    throw std::invalid_argument(spec.name + ": " + message);
}

// ---------------------------------------------------------------- LibraryBlock

LibraryBlock::LibraryBlock(const BlockSpec& spec, const registry::ComponentParams& params)
    : m_spec(spec), m_properties(withDefaults(spec, params.properties)) {}

std::vector<SignalPortDescriptor> LibraryBlock::signalPorts() const {
    std::vector<SignalPortDescriptor> ports;
    for (const std::string& id : inputPortIds()) ports.push_back({id, SignalPortDirection::Input, SignalValueKind::Analog, ""});
    for (const std::string& id : outputPortIds()) ports.push_back({id, SignalPortDirection::Output, SignalValueKind::Analog, ""});
    return ports;
}

namespace {
bool paramAffectsPorts(const BlockSpec& spec, const std::string& name) {
    for (const auto* rules : {&spec.inputs, &spec.outputs})
        for (const PortRule& rule : *rules) {
            if (rule.repeat && rule.param == name) return true;
            for (const auto& [condition, values] : rule.when) if (condition == name) return true;
        }
    return false;
}
} // namespace

std::vector<PropertySchema> LibraryBlock::propertySchema(const BlockSpec& spec) {
    std::vector<PropertySchema> schemas;
    for (const ParamSpec& param : spec.params) {
        PropertySchema schema;
        schema.id = param.name;
        schema.label = param.titlePt;
        schema.group = param.group.empty() ? "Parâmetros" : param.group;
        schema.valueKind = param.type == ParamType::Bool ? PropertyValueKind::Bool : PropertyValueKind::String;
        schema.editor = param.type == ParamType::Bool ? "checkbox" : param.type == ParamType::Enum ? "select" : "text";
        schema.defaultValue = param.defaultValue;
        for (const std::string& option : param.options) schema.options.push_back({option, option});
        schema.flags = param.tunable ? PropertySchemaNone : PropertySchemaAffectsTopology;
        if (paramAffectsPorts(spec, param.name)) schema.flags |= PropertySchemaAffectsPinCount | PropertySchemaAffectsTopology;
        schemas.push_back(std::move(schema));
    }
    return schemas;
}

std::vector<PropertyDescriptor> LibraryBlock::propertyDescriptors() {
    std::vector<PropertyDescriptor> descriptors;
    for (PropertySchema& schema : propertySchema(m_spec)) {
        PropertyDescriptor descriptor;
        descriptor.name = schema.id;
        const std::string name = schema.id;
        const bool isBool = schema.valueKind == PropertyValueKind::Bool;
        descriptor.schema = std::move(schema);
        descriptor.get = [this, name]() -> PropertyValue {
            const auto it = m_properties.find(name);
            return it == m_properties.end() ? PropertyValue{std::string()} : it->second;
        };
        descriptor.set = [this, name, isBool](const PropertyValue& next) {
            if (isBool) {
                if (const bool* flag = std::get_if<bool>(&next)) m_properties[name] = *flag;
                else m_properties[name] = PropertyValue{propertyText(next) == "on" || propertyText(next) == "true"};
            } else {
                m_properties[name] = PropertyValue{propertyText(next)};
            }
        };
        descriptors.push_back(std::move(descriptor));
    }
    return descriptors;
}

DeclaredRate LibraryBlock::declaredRate(const lib::ParamWorkspace* workspace) const {
    DeclaredRate rate;
    switch (m_spec.sampleTime) {
    case SampleTimeKind::Continuous: rate.kind = DeclaredRate::Kind::Continuous; return rate;
    case SampleTimeKind::Constant: rate.kind = DeclaredRate::Kind::Constant; return rate;
    case SampleTimeKind::Inherited: rate.kind = DeclaredRate::Kind::Inherited; return rate;
    case SampleTimeKind::Param: break;
    }
    const auto it = m_properties.find(m_spec.sampleTimeParam);
    const std::string text = it == m_properties.end() ? std::string("-1") : propertyText(it->second);
    lib::ParamValue value;
    try {
        value = lib::evaluateParam(text, workspace);
    } catch (const std::exception& error) {
        throw std::invalid_argument(m_spec.name + ": " + m_spec.sampleTimeParam + ": " + error.what());
    }
    if (value.numel() < 1 || value.numel() > 2)
        throw std::invalid_argument(m_spec.name + ": tempo de amostragem deve ser Ts ou [Ts, offset]");
    const double period = value.data[0];
    const double offset = value.numel() == 2 ? value.data[1] : 0.0;
    if (period == -1.0) { rate.kind = DeclaredRate::Kind::Inherited; return rate; }
    if (period == 0.0) { rate.kind = DeclaredRate::Kind::Continuous; return rate; }
    if (std::isinf(period) && period > 0) { rate.kind = DeclaredRate::Kind::Constant; return rate; }
    if (!(period > 0.0) || !(offset >= 0.0) || offset >= period)
        throw std::invalid_argument(m_spec.name + ": tempo de amostragem invalido (Ts > 0 e 0 <= offset < Ts)");
    rate.kind = DeclaredRate::Kind::Discrete;
    rate.periodNs = lib::secondsToNs(period);
    rate.offsetNs = lib::secondsToNs(offset);
    if (rate.periodNs == 0) throw std::invalid_argument(m_spec.name + ": tempo de amostragem menor que 1 ns");
    return rate;
}

std::vector<uint16_t> LibraryBlock::outputWidths(const BlockResolution& resolution, uint32_t componentIndex) const {
    const BlockBuilder builder = findBuilder(m_spec.id);
    if (!builder) throw std::invalid_argument(m_spec.name + ": bloco sem implementacao no Core");
    BuildContext context{*this, m_spec, m_properties, resolution, componentIndex, inputPortIds(), outputPortIds(), true, {}, {}};
    builder(context);
    context.outputWidths.resize(context.outputPorts.size(), 1);
    return context.outputWidths;
}

simulation::SignalGraphDefinition LibraryBlock::computeGraph(uint32_t componentIndex, const BlockResolution& resolution) const {
    const BlockBuilder builder = findBuilder(m_spec.id);
    if (!builder) throw std::invalid_argument(m_spec.name + ": bloco sem implementacao no Core");
    BuildContext context{*this, m_spec, m_properties, resolution, componentIndex, inputPortIds(), outputPortIds(), false, {}, {}};
    builder(context);
    return std::move(context.graph);
}

std::string LibraryBlock::readoutPort() const {
    const std::vector<std::string> outputs = outputPortIds();
    if (!outputs.empty()) return outputs.front();
    const std::vector<std::string> inputs = inputPortIds();
    return inputs.empty() ? std::string() : inputs.front();
}

ReadoutFormat LibraryBlock::readoutFormat() {
    ReadoutFormat format;
    format.kind = ReadoutKind::Scalar;
    format.unit = "";
    return format;
}

} // namespace lasecsimul::components::blocks
