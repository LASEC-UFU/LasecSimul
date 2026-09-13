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
        if (component.typeId == "connectors.tunnel" || component.typeId == "connectors.signal_tunnel") {
            // Legacy process documents used the electrical tunnel as a signal relay. New authoring
            // uses SignalTunnel; accepting both here preserves old process files while all new
            // `domain:signal` boundaries stay in the generic Signal Graph domain.
            const std::string portId = component.typeId == "connectors.signal_tunnel" ? "value" : "pin";
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
                ports[component.id].inputs[portId] = {component.id, "in"};
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

        // Blocos de controle publicados como subcircuitos de um único estágio. Eles são apenas
        // nomes de autoria: o hot path continua sendo o mesmo SignalEngine usado pelos processos
        // TDPS (nenhum motor paralelo ou busca por string por tick).
        const auto controlUnary = [&](SignalBlockKind kind, std::vector<double> parameters) {
            result.graph.blocks.push_back(realBlock(component.id, kind, {"in"}, std::move(parameters), periodNs));
            ports[component.id].inputs["in"] = {component.id, "in"};
            ports[component.id].output = {component.id, "out"};
        };
        if (component.typeId == "control.gain") { controlUnary(SignalBlockKind::Gain, {number(properties, "gain", 1.0)}); continue; }
        if (component.typeId == "control.integrator") { controlUnary(SignalBlockKind::Integrator, {number(properties, "gain", 1.0), number(properties, "initial", 0.0)}); continue; }
        if (component.typeId == "control.filtered_derivative") { controlUnary(SignalBlockKind::FilteredDerivative, {number(properties, "gain", 1.0), number(properties, "filterTau", 0.01), number(properties, "initial", 0.0)}); continue; }
        if (component.typeId == "control.unit_delay") { controlUnary(SignalBlockKind::UnitDelay, {number(properties, "initial", 0.0)}); continue; }
        if (component.typeId == "control.dead_time") { controlUnary(SignalBlockKind::DeadTime, {number(properties, "delay", 0.1), number(properties, "initial", 0.0)}); continue; }
        if (component.typeId == "control.first_order") { controlUnary(SignalBlockKind::FirstOrder, {number(properties, "gain", 1.0), number(properties, "tau", 1.0), number(properties, "initial", 0.0)}); continue; }
        if (component.typeId == "control.second_order") { controlUnary(SignalBlockKind::SecondOrder, {number(properties, "gain", 1.0), number(properties, "omega", 1.0), number(properties, "zeta", 1.0), number(properties, "initial", 0.0), number(properties, "initialDerivative", 0.0)}); continue; }
        if (component.typeId == "control.lead_lag") { controlUnary(SignalBlockKind::LeadLag, {number(properties, "gain", 1.0), number(properties, "leadTau", 0.0), number(properties, "lagTau", 1.0), number(properties, "initial", 0.0)}); continue; }
        if (component.typeId == "control.fopdt") { controlUnary(SignalBlockKind::Fopdt, {number(properties, "gain", 1.0), number(properties, "tau", 1.0), number(properties, "delay", 0.1), number(properties, "initial", 0.0)}); continue; }
        if (component.typeId == "control.tank") {
            // Bug real corrigido aqui: `Tank` calcula d(nivel)/dt = (entrada - saida) / area (ver
            // SignalEngine.cpp's execute(), block.inputs[1] = vazao de saida) e
            // `expectedInputCount(Tank) == 2` -- nunca cabe no helper `controlUnary` de UMA entrada
            // usado por todos os outros blocos dinamicos aqui. Publicar "Tanque" via `controlUnary`
            // (como acontecia antes desta correcao) sempre lancava "quantidade de entradas invalida
            // no bloco dinamico" ao compilar -- nunca chegou a funcionar desde que foi publicado.
            result.graph.blocks.push_back(realBlock(component.id, SignalBlockKind::Tank, {"in", "outflow"},
                {number(properties, "area", 1.0), number(properties, "initial", 0.0)}, periodNs));
            ports[component.id].inputs = {{"in", {component.id, "in"}}, {"outflow", {component.id, "outflow"}}};
            ports[component.id].output = {component.id, "out"};
            continue;
        }
        if (component.typeId == "control.valve_characteristic") { controlUnary(SignalBlockKind::ValveCharacteristic, {number(properties, "coefficient", 1.0), number(properties, "exponent", 1.0)}); continue; }
        if (component.typeId == "control.saturation" || component.typeId == "control.limiter") { controlUnary(component.typeId == "control.limiter" ? SignalBlockKind::Limiter : SignalBlockKind::Saturation, {number(properties, "minimum", 0.0), number(properties, "maximum", 100.0)}); continue; }
        if (component.typeId == "control.deadband") { controlUnary(SignalBlockKind::Deadband, {number(properties, "width", 0.0)}); continue; }
        if (component.typeId == "control.hysteresis") { controlUnary(SignalBlockKind::Hysteresis, {number(properties, "low", 0.0), number(properties, "high", 1.0), number(properties, "lowOutput", 0.0), number(properties, "highOutput", 1.0), number(properties, "initial", 0.0)}); continue; }
        if (component.typeId == "control.stiction") { controlUnary(SignalBlockKind::Stiction, {number(properties, "breakaway", 0.0), number(properties, "slip", 0.0), number(properties, "initial", 0.0)}); continue; }
        if (component.typeId == "control.rate_limiter") { controlUnary(SignalBlockKind::RateLimiter, {number(properties, "riseRate", 1.0), number(properties, "fallRate", 1.0), number(properties, "initial", 0.0)}); continue; }
        if (component.typeId == "control.transfer_function") {
            const std::string model = properties.value("model", std::string("first_order"));
            if (model == "first_order") { controlUnary(SignalBlockKind::FirstOrder, {number(properties, "gain", 1.0), number(properties, "tau", 1.0), number(properties, "initial", 0.0)}); continue; }
            if (model == "second_order") { controlUnary(SignalBlockKind::SecondOrder, {number(properties, "gain", 1.0), number(properties, "omega", 1.0), number(properties, "zeta", 1.0), number(properties, "initial", 0.0), number(properties, "initialDerivative", 0.0)}); continue; }
            if (model == "lead_lag") { controlUnary(SignalBlockKind::LeadLag, {number(properties, "gain", 1.0), number(properties, "leadTau", 0.0), number(properties, "lagTau", 1.0), number(properties, "initial", 0.0)}); continue; }
            if (model == "fopdt") { controlUnary(SignalBlockKind::Fopdt, {number(properties, "gain", 1.0), number(properties, "tau", 1.0), number(properties, "delay", 0.1), number(properties, "initial", 0.0)}); continue; }
            throw std::invalid_argument("modelo de funcao de transferencia desconhecido: " + model);
        }
        if (component.typeId == "control.sum" || component.typeId == "control.product") {
            std::vector<std::string> inputIds;
            if (properties.contains("inputs") && properties["inputs"].is_array())
                for (const auto& input : properties["inputs"]) if (input.is_string()) inputIds.push_back(input.get<std::string>());
            if (inputIds.empty()) inputIds = {"in0", "in1"};
            const auto kind = component.typeId == "control.sum" ? SignalBlockKind::Sum : SignalBlockKind::Product;
            result.graph.blocks.push_back(realBlock(component.id, kind, inputIds, {}, periodNs));
            for (const auto& input : inputIds) ports[component.id].inputs[input] = {component.id, input};
            ports[component.id].output = {component.id, "out"};
            continue;
        }
        if (component.typeId == "control.bias" || component.typeId == "control.subtract" || component.typeId == "control.divide") {
            std::vector<std::string> inputIds;
            if (properties.contains("inputs") && properties["inputs"].is_array())
                for (const auto& input : properties["inputs"]) if (input.is_string()) inputIds.push_back(input.get<std::string>());
            if (component.typeId == "control.bias") inputIds = {"in"};
            else if (inputIds.size() < 2) inputIds = {"in0", "in1"};
            // Bug real corrigido aqui: a expressao usava os tokens literais "x0"/"x1", mas
            // CalcExpression resolve variaveis pelo NOME declarado em `inputIds` (ver
            // SignalEngine.cpp -- nada mapeia posicao pra "x0"/"x1" automaticamente). Como
            // `inputIds` aqui e' "in"/"in0"+"in1" (nunca "x0"/"x1"), toda instancia de
            // control.bias/subtract/divide lancava "CalcExpression invalida: entrada desconhecida"
            // ao compilar -- nunca funcionou desde que esses typeIds foram introduzidos. Monta a
            // expressao com os nomes REAIS de `inputIds` em vez de literais hardcoded.
            const std::string expression = component.typeId == "control.bias"
                ? inputIds.at(0) + "+" + std::to_string(number(properties, "bias", 0.0))
                : (component.typeId == "control.subtract" ? inputIds.at(0) + "-" + inputIds.at(1) : inputIds.at(0) + "/" + inputIds.at(1));
            SignalBlockDefinition calc = realBlock(component.id, SignalBlockKind::CalcExpression, inputIds, {}, periodNs);
            calc.expression = expression;
            result.graph.blocks.push_back(std::move(calc));
            for (const auto& input : inputIds) ports[component.id].inputs[input] = {component.id, input};
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
    // As malhas TDPS são amostradas em um único scan virtual. Declarar a
    // política aqui mantém cada realimentação no mesmo scheduler determinístico
    // em vez de introduzir timers ou uma engine paralela.
    if (typeId.starts_with("subcircuits.tdps.")) {
        for (auto& block : result.graph.blocks) {
            block.loopPolicy = AlgebraicLoopPolicy::FixedPoint;
            block.maxIterations = 16;
            block.tolerance = 1e-9;
        }
    }
    // Validacao cold-path: a topologia TDPS so e aceita se o Signal Graph
    // canônico puder ser compilado pela mesma infraestrutura de producao.
    (void)SignalCompiler::compile(result.graph);
    return result;
}

} // namespace lasecsimul::simulation
