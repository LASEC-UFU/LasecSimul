#include "ProcessSubcircuitCompiler.hpp"

#include <algorithm>
#include <cmath>
#include <limits>
#include <regex>
#include <stdexcept>
#include <unordered_set>

#include <nlohmann/json.hpp>

namespace lasecsimul::simulation {
namespace {

using Json = nlohmann::json;

struct ComponentPorts {
    std::unordered_map<std::string, std::pair<std::string, std::string>> inputs;
    std::pair<std::string, std::string> output;
};

double number(const Json& properties, std::string_view key, double fallback) {
    const auto it = properties.find(key);
    return it != properties.end() && it->is_number() ? it->get<double>() : fallback;
}

bool boolean(const Json& properties, std::string_view key, bool fallback) {
    const auto it = properties.find(key);
    return it != properties.end() && it->is_boolean() ? it->get<bool>() : fallback;
}

SignalBlockDefinition realBlock(std::string id, SignalBlockKind kind, std::vector<std::string> inputs,
                                std::vector<double> parameters, uint64_t periodNs) {
    SignalBlockDefinition block;
    block.id = std::move(id);
    block.kind = kind;
    for (std::string& input : inputs) block.inputs.push_back({std::move(input), {SignalScalarType::Real, 1}, ""});
    block.output = {"out", {SignalScalarType::Real, 1}, ""};
    block.realParameters = std::move(parameters);
    block.rate = {periodNs, 0, 0};
    return block;
}

std::string tunnelName(const registry::SubcircuitComponentDef& component) {
    const Json properties = Json::parse(component.propertiesJson);
    return properties.value("name", std::string{});
}

void applyOverrides(Json& properties, const std::string& componentId,
                    const std::unordered_map<std::string, double>& overrides) {
    const std::string prefix = componentId + ".";
    for (const auto& [target, value] : overrides) {
        if (target.starts_with(prefix)) properties[target.substr(prefix.size())] = value;
    }
}

} // namespace

CompiledProcessSubcircuit ProcessSubcircuitCompiler::compile(
    const registry::SubcircuitRegistry& registry,
    const std::string& typeId,
    const std::unordered_map<std::string, double>& parameterOverrides) {
    const registry::SubcircuitDefinition* definition = registry.find(typeId);
    if (!definition) throw std::invalid_argument("subcircuito de processo desconhecido: " + typeId);
    CompiledProcessSubcircuit result;
    result.semanticHash = registry.semanticHash(typeId);

    std::unordered_map<std::string, const registry::SubcircuitComponentDef*> components;
    std::unordered_map<std::string, ComponentPorts> ports;
    std::unordered_map<std::string, const registry::SubcircuitInterfaceDef*> interfaceByTunnel;
    for (const auto& interfaceDef : definition->interfaceDefs)
        interfaceByTunnel[interfaceDef.internalTunnel] = &interfaceDef;
    for (const auto& component : definition->components) components[component.id] = &component;

    const auto appendUnary = [&](const std::string& id, SignalBlockKind kind, std::vector<double> parameters,
                                 uint64_t periodNs, std::vector<std::string>& chain) {
        SignalBlockDefinition block = realBlock(id, kind, {"in"}, std::move(parameters), periodNs);
        if (kind == SignalBlockKind::DeadTime) {
            const double delayNs = block.realParameters.front() * 1'000'000'000.0;
            block.historyCapacity = static_cast<size_t>(std::max(2.0, std::ceil(delayNs / static_cast<double>(periodNs)) + 4.0));
        }
        result.graph.blocks.push_back(std::move(block));
        if (!chain.empty()) result.graph.connections.push_back({chain.back(), "out", id, "in", false});
        chain.push_back(id);
    };

    for (const auto& component : definition->components) {
        Json properties = Json::parse(component.propertiesJson);
        applyOverrides(properties, component.id, parameterOverrides);
        const uint64_t periodNs = static_cast<uint64_t>(std::max(1.0, number(properties, "samplePeriodNs", 100'000'000.0)));
        if (component.typeId == "connectors.tunnel") {
            const std::string name = properties.value("name", component.id);
            const auto interfaceIt = interfaceByTunnel.find(name);
            std::string direction = interfaceIt == interfaceByTunnel.end() ? std::string{} : interfaceIt->second->direction;
            if (direction.empty() || direction == "inout") {
                const bool outgoing = std::any_of(definition->wires.begin(), definition->wires.end(),
                    [&](const auto& wire) { return wire.fromComponentId == component.id; });
                const bool incoming = std::any_of(definition->wires.begin(), definition->wires.end(),
                    [&](const auto& wire) { return wire.toComponentId == component.id; });
                direction = outgoing && !incoming ? "in" : "out";
            }
            if (direction == "in") {
                SignalBlockDefinition input = realBlock(component.id, SignalBlockKind::ExternalInput, {},
                                                        {number(properties, "defaultValue", 0.0)}, periodNs);
                result.graph.blocks.push_back(std::move(input));
                ports[component.id].output = {component.id, "out"};
                if (interfaceIt != interfaceByTunnel.end()) result.externalInputs[interfaceIt->second->pinId] = component.id;
            } else if (direction == "out") {
                result.graph.blocks.push_back(realBlock(component.id, SignalBlockKind::Probe, {"in"}, {}, periodNs));
                ports[component.id].inputs["pin"] = {component.id, "in"};
                ports[component.id].output = {component.id, "out"};
                if (interfaceIt != interfaceByTunnel.end()) result.externalOutputs[interfaceIt->second->pinId] = component.id;
            } else {
                throw std::invalid_argument("tunnel de sinal exige direction in/out: " + component.id);
            }
            continue;
        }

        if (component.typeId == "control.pid") {
            const std::vector<double> parameters{
                number(properties, "kc", 1.0), number(properties, "ti", 0.0), number(properties, "td", 0.0),
                number(properties, "bias", 0.0), number(properties, "derivativeFilter", 0.1),
                number(properties, "outputMin", 0.0), number(properties, "outputMax", 100.0),
                number(properties, "action", 1.0), boolean(properties, "derivativeOnPv", true) ? 1.0 : 0.0,
                number(properties, "initialIntegral", 0.0)};
            result.graph.blocks.push_back(realBlock(component.id, SignalBlockKind::Pid, {"sp", "pv"}, parameters, periodNs));
            ports[component.id].inputs = {{"sp", {component.id, "sp"}}, {"pv", {component.id, "pv"}}};
            ports[component.id].output = {component.id, "out"};
            continue;
        }

        if (component.typeId == "control.calc_expression") {
            const std::string expression = properties.value("expression", std::string{});
            if (std::regex_search(expression, std::regex(R"(\bM\d+\b)", std::regex::icase)))
                throw std::invalid_argument("CalcExpression canonica ainda contem referencia Mnn: " + component.id);
            std::vector<std::string> inputIds;
            if (properties.contains("inputs") && properties["inputs"].is_array())
                for (const auto& input : properties["inputs"]) if (input.is_string()) inputIds.push_back(input.get<std::string>());
            SignalBlockDefinition calc = realBlock(component.id, SignalBlockKind::CalcExpression, inputIds, {}, periodNs);
            calc.expression = expression;
            result.graph.blocks.push_back(std::move(calc));
            for (const std::string& input : inputIds) ports[component.id].inputs[input] = {component.id, input};
            const bool upperEnabled = boolean(properties, "upperLimitEnabled", false);
            const bool lowerEnabled = boolean(properties, "lowerLimitEnabled", false);
            if (upperEnabled || lowerEnabled) {
                const std::string saturationId = component.id + "::saturation";
                const double lower = lowerEnabled ? number(properties, "lowerLimit", 0.0) : -std::numeric_limits<double>::max();
                const double upper = upperEnabled ? number(properties, "upperLimit", 0.0) : std::numeric_limits<double>::max();
                result.graph.blocks.push_back(realBlock(saturationId, SignalBlockKind::Saturation, {"in"}, {lower, upper}, periodNs));
                result.graph.connections.push_back({component.id, "out", saturationId, "in", false});
                ports[component.id].output = {saturationId, "out"};
            } else {
                ports[component.id].output = {component.id, "out"};
            }
            continue;
        }

        if (component.typeId == "control.probe") {
            result.graph.blocks.push_back(realBlock(component.id, SignalBlockKind::Probe, {"in"}, {}, periodNs));
            ports[component.id].inputs["in"] = {component.id, "in"};
            ports[component.id].output = {component.id, "out"};
            continue;
        }

        if (component.typeId == "control.process") {
            std::vector<std::string> chain;
            const double hysteresis = number(properties, "hysteresis", 0.0);
            const double stiction = number(properties, "stiction", 0.0);
            const double rateLimit = number(properties, "rateLimiter", 0.0);
            const double actuatorTau = number(properties, "actuatorTau", 0.0);
            const double gain = number(properties, "gain", 1.0);
            const double tau1 = number(properties, "tau1", 0.0);
            const double tau2 = number(properties, "tau2", 0.0);
            const double lead = number(properties, "lead", 0.0);
            const double lag = number(properties, "lag", 0.0);
            const double deadTime = number(properties, "deadTime", 0.0);
            if (hysteresis > 0.0) appendUnary(component.id + "::deadband", SignalBlockKind::Deadband, {hysteresis}, periodNs, chain);
            if (stiction > 0.0) appendUnary(component.id + "::stiction", SignalBlockKind::Stiction, {stiction, 0.0, 0.0}, periodNs, chain);
            if (rateLimit > 0.0) appendUnary(component.id + "::rate", SignalBlockKind::RateLimiter, {rateLimit, rateLimit, 0.0}, periodNs, chain);
            if (actuatorTau > 0.0) appendUnary(component.id + "::actuator", SignalBlockKind::FirstOrder, {1.0, actuatorTau, 0.0}, periodNs, chain);
            appendUnary(component.id + "::gain", SignalBlockKind::Gain, {gain}, periodNs, chain);
            if (tau1 > 0.0) appendUnary(component.id + "::tau1", SignalBlockKind::FirstOrder, {1.0, tau1, 0.0}, periodNs, chain);
            if (tau2 > 0.0) appendUnary(component.id + "::tau2", SignalBlockKind::FirstOrder, {1.0, tau2, 0.0}, periodNs, chain);
            if (lag > 0.0) appendUnary(component.id + "::leadlag", SignalBlockKind::LeadLag, {1.0, std::max(0.0, lead), lag, 0.0}, periodNs, chain);
            if (deadTime > 0.0) appendUnary(component.id + "::delay", SignalBlockKind::DeadTime, {deadTime, 0.0}, periodNs, chain);
            if (boolean(properties, "saturationEnabled", false)) appendUnary(
                component.id + "::saturation", SignalBlockKind::Saturation,
                {number(properties, "outputMin", 0.0), number(properties, "outputMax", 100.0)}, periodNs, chain);
            ports[component.id].inputs["in"] = {chain.front(), "in"};
            ports[component.id].output = {chain.back(), "out"};
            continue;
        }

        throw std::invalid_argument("tipo nao suportado no subcircuito de processo: " + component.typeId);
    }

    for (const auto& wire : definition->wires) {
        const auto sourceIt = ports.find(wire.fromComponentId);
        const auto targetIt = ports.find(wire.toComponentId);
        if (sourceIt == ports.end() || targetIt == ports.end())
            throw std::invalid_argument("wire de processo referencia componente inexistente");
        const auto targetPort = targetIt->second.inputs.find(wire.toPinId);
        if (targetPort == targetIt->second.inputs.end())
            throw std::invalid_argument("wire de processo referencia input inexistente: " + wire.toComponentId + "." + wire.toPinId);
        result.graph.connections.push_back({sourceIt->second.output.first, sourceIt->second.output.second,
                                            targetPort->second.first, targetPort->second.second, false});
    }
    (void)SignalCompiler::compile(result.graph);
    return result;
}

} // namespace lasecsimul::simulation
