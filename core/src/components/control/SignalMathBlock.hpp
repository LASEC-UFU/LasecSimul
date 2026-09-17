#pragma once

#include <algorithm>
#include <cctype>
#include <cmath>
#include <cstdint>
#include <limits>
#include <span>
#include <stdexcept>
#include <string>
#include <string_view>
#include <unordered_map>
#include <variant>
#include <vector>

#include <nlohmann/json.hpp>

#include "lasecsimul/IComponentModel.hpp"
#include "registry/ComponentParams.hpp"
#include "simulation/SignalEngine.hpp"

namespace lasecsimul::components {

/**
 * Bloco matemático do Signal Engine publicado como componente de verdade (`control.*`).
 *
 * Os `.lssubcircuit` da biblioteca Ctrl/TDPS (`process_fopdt`, `tdps_*`, `control_*`) declaram seus
 * blocos internos com typeIds `control.gain`, `control.pid`, `control.process`... -- ou seja,
 * `SimulationSession::expandSubcircuit` tenta instanciá-los pelo MESMO caminho de qualquer outro
 * filho de subcircuito (`ComponentRegistry::create`). Antes desta classe nenhum `control.*` tinha
 * factory registrada: só existia a tradução typeId->SignalBlockKind dentro de
 * `ProcessSubcircuitCompiler`, que nunca foi ligada ao runtime (é chamada apenas pelos próprios
 * testes). Resultado: instanciar QUALQUER dispositivo TDPS falhava com "Unknown component typeId:
 * control.process" -- a biblioteca inteira era inalcançável pela Extension.
 *
 * Por que componente, e não um caminho especial de "subcircuito de processo": ADR-0008 decide que
 * processo TDPS é um subcircuito normal, expandido na MESMA sessão, sem engine/solver paralelo.
 * Compilar o subcircuito inteiro como uma unidade fecharia cada malha dentro de uma fronteira
 * própria -- uma realimentação montada pelo usuário ligando blocos Ctrl avulsos no canvas (o caso
 * de uso principal da biblioteca) atravessaria fronteiras e nunca compartilharia o RateGroup/SCC
 * que `SignalCompiler` exige de um loop algébrico. Como componente, todo bloco vive no MESMO
 * `SignalGraphDefinition` materializado da sessão, então a malha fecha igual estando dentro de um
 * `.lssubcircuit` ou montada à mão.
 *
 * Contrato de materialização (ver `SimulationSession::materializeSignalGraphUnlocked`):
 *  - `pins()` é SEMPRE vazio -- um bloco de controle nunca participa do Netlist/MNA;
 *  - cada porta de ENTRADA vira o relay padrão de porta genérica (`Probe` quando fiada,
 *    `ExternalInput` com default quando não) -- é isso que mantém um bloco com entrada solta ainda
 *    compilável, mesma regra de qualquer `signalPorts()`;
 *  - a porta de SAÍDA NÃO vira relay: quem publica `signalPortBlockId(index, "out")` é o próprio
 *    bloco de cálculo devolvido por `computeGraph()`. Por isso um consumidor externo ligado nela lê
 *    o resultado real, sem nenhum salto extra.
 */
class SignalMathBlock final : public IComponentModel {
public:
    SignalMathBlock(std::string typeId, const registry::ComponentParams& params)
        : m_typeId(std::move(typeId)), m_properties(params.properties) {}

    /** `true` para todo typeId que ESTA classe sabe materializar -- a mesma lista que
     * `registerBuiltinComponents` registra e que `computeGraph` cobre, em um único lugar. */
    static bool isSignalMathTypeId(std::string_view typeId) {
        const std::span<const std::string_view> all = signalMathTypeIds();
        return std::find(all.begin(), all.end(), typeId) != all.end();
    }

    static std::span<const std::string_view> signalMathTypeIds() {
        static constexpr std::string_view kIds[] = {
            "control.gain", "control.sum", "control.product", "control.subtract", "control.divide",
            "control.bias", "control.integrator", "control.filtered_derivative", "control.unit_delay",
            "control.dead_time", "control.first_order", "control.second_order", "control.lead_lag",
            "control.fopdt", "control.transfer_function", "control.tank", "control.valve_characteristic",
            "control.saturation", "control.limiter", "control.deadband", "control.hysteresis",
            "control.stiction", "control.rate_limiter", "control.pid", "control.calc_expression",
            "control.probe", "control.process",
        };
        return {kIds, std::size(kIds)};
    }

    const char* typeId() const override { return m_typeId.c_str(); }
    std::span<Pin> pins() override { return {}; }
    void stamp(MnaMatrixView&) override {}
    void postStep(uint64_t) override {}
    size_t getState(uint8_t*, size_t) const override { return 0; }
    void setState(const uint8_t*, size_t) override {}

    std::vector<SignalPortDescriptor> signalPorts() const override {
        std::vector<SignalPortDescriptor> ports;
        for (const std::string& input : inputPortIds())
            ports.push_back({input, SignalPortDirection::Input, SignalValueKind::Analog, ""});
        ports.push_back({"out", SignalPortDirection::Output, SignalValueKind::Analog, ""});
        return ports;
    }

    /** Descritores derivados das propriedades que a instância REALMENTE carrega (autoria do
     * `.lssubcircuit`), não de uma segunda tabela por typeId -- é o que faz
     * `exportedPropertyComponentIds` (ex: os ganhos do "plant" do `process_fopdt`) aparecer no
     * inspector sem duplicar o schema em dois lugares. `AffectsTopology` porque o parâmetro é
     * assado no `SignalBlockDefinition` em tempo de compilação: mudar exige republicar o
     * SignalPlan, o que só acontece com a simulação parada. */
    std::vector<PropertyDescriptor> propertyDescriptors() override {
        std::vector<PropertyDescriptor> descriptors;
        // Ordem estável: `m_properties` é um hash map, e o inspector mostra os campos na ordem em
        // que chegam -- sem ordenar, a mesma instância reabriria com os campos embaralhados.
        std::vector<std::string> names;
        names.reserve(m_properties.size());
        for (const auto& [name, value] : m_properties) names.push_back(name);
        std::sort(names.begin(), names.end());
        for (const std::string& name : names) {
            const PropertyValue& value = m_properties.at(name);
            PropertySchema schema;
            schema.id = name;
            schema.label = name;
            schema.group = "Controle";
            schema.valueKind = std::holds_alternative<bool>(value)     ? PropertyValueKind::Bool
                               : std::holds_alternative<double>(value) ? PropertyValueKind::Number
                                                                        : PropertyValueKind::String;
            schema.editor = schema.valueKind == PropertyValueKind::Bool     ? "checkbox"
                            : schema.valueKind == PropertyValueKind::Number ? "number"
                                                                            : "text";
            schema.defaultValue = value;
            schema.flags = PropertySchemaAffectsTopology;
            PropertyDescriptor descriptor;
            descriptor.name = name;
            descriptor.schema = schema;
            descriptor.get = [this, name]() -> PropertyValue {
                const auto it = m_properties.find(name);
                return it == m_properties.end() ? PropertyValue{0.0} : it->second;
            };
            descriptor.set = [this, name](const PropertyValue& next) { m_properties[name] = next; };
            descriptors.push_back(std::move(descriptor));
        }
        return descriptors;
    }

    uint64_t samplePeriodNs() const {
        return static_cast<uint64_t>(std::max(1.0, number("samplePeriodNs", 100'000'000.0)));
    }

    /** Blocos de cálculo desta instância + as ligações que os alimentam a partir dos relays das
     * portas de entrada. O bloco terminal SEMPRE tem id `signalPortBlockId(index, "out")`. */
    simulation::SignalGraphDefinition computeGraph(uint32_t componentIndex) const {
        simulation::SignalGraphDefinition graph;
        const std::string outId = signalPortBlockId(componentIndex, "out");
        const uint64_t periodNs = samplePeriodNs();
        const std::vector<std::string> inputs = inputPortIds();

        // Cadeia de estágios (só `control.process` e `control.calc_expression` com limite usam mais
        // de um): estágios intermediários recebem ids derivados do id canônico de saída, e o ÚLTIMO
        // é renomeado pro id canônico no final -- assim o consumidor externo sempre acha a saída no
        // mesmo lugar, independente de quantos estágios a parametrização gerou.
        std::vector<std::string> chain;
        const auto appendStage = [&](simulation::SignalBlockKind kind, std::vector<double> parameters) {
            simulation::SignalBlockDefinition block =
                makeBlock(outId + "::s" + std::to_string(chain.size()), kind, {"in"}, std::move(parameters), periodNs);
            if (kind == simulation::SignalBlockKind::DeadTime) block.historyCapacity = deadTimeCapacity(block.realParameters.front(), periodNs);
            if (!chain.empty()) graph.connections.push_back({chain.back(), "out", block.id, "in", false});
            chain.push_back(block.id);
            graph.blocks.push_back(std::move(block));
        };

        if (m_typeId == "control.process") {
            // Mesma composição do TDPS: atuador (histerese/stiction/rate/tau) -> ganho -> atrasos
            // dinâmicos -> lead-lag -> tempo morto -> saturação opcional. Estágio só existe quando
            // o parâmetro correspondente está ativo, exatamente como no modelo original.
            const double hysteresis = number("hysteresis", 0.0);
            const double stiction = number("stiction", 0.0);
            const double rateLimit = number("rateLimiter", 0.0);
            const double actuatorTau = number("actuatorTau", 0.0);
            const double tau1 = number("tau1", 0.0);
            const double tau2 = number("tau2", 0.0);
            const double lead = number("lead", 0.0);
            const double lag = number("lag", 0.0);
            const double deadTime = number("deadTime", 0.0);
            if (hysteresis > 0.0) appendStage(simulation::SignalBlockKind::Deadband, {hysteresis});
            if (stiction > 0.0) appendStage(simulation::SignalBlockKind::Stiction, {stiction, 0.0, 0.0});
            if (rateLimit > 0.0) appendStage(simulation::SignalBlockKind::RateLimiter, {rateLimit, rateLimit, 0.0});
            if (actuatorTau > 0.0) appendStage(simulation::SignalBlockKind::FirstOrder, {1.0, actuatorTau, 0.0});
            appendStage(simulation::SignalBlockKind::Gain, {number("gain", 1.0)});
            if (tau1 > 0.0) appendStage(simulation::SignalBlockKind::FirstOrder, {1.0, tau1, 0.0});
            if (tau2 > 0.0) appendStage(simulation::SignalBlockKind::FirstOrder, {1.0, tau2, 0.0});
            if (lag > 0.0) appendStage(simulation::SignalBlockKind::LeadLag, {1.0, std::max(0.0, lead), lag, 0.0});
            if (deadTime > 0.0) appendStage(simulation::SignalBlockKind::DeadTime, {deadTime, 0.0});
            if (boolean("saturationEnabled", false))
                appendStage(simulation::SignalBlockKind::Saturation, {number("outputMin", 0.0), number("outputMax", 100.0)});
            graph.connections.push_back({signalPortBlockId(componentIndex, inputs.front()), "out", chain.front(), "in", false});
            renameTerminal(graph, chain.back(), outId);
            return graph;
        }

        if (m_typeId == "control.calc_expression" || m_typeId == "control.bias" ||
            m_typeId == "control.subtract" || m_typeId == "control.divide") {
            // `CalcExpression` resolve variáveis pelo NOME declarado em `inputs` -- a expressão dos
            // aliases é montada com os nomes REAIS das portas, nunca com literais posicionais.
            const std::string expression = m_typeId == "control.calc_expression"
                ? text("expression", "")
                : (m_typeId == "control.bias" ? inputs.at(0) + "+" + formatDouble(number("bias", 0.0))
                   : m_typeId == "control.subtract" ? inputs.at(0) + "-" + inputs.at(1)
                                                     : inputs.at(0) + "/" + inputs.at(1));
            simulation::SignalBlockDefinition calc =
                makeBlock(outId, simulation::SignalBlockKind::CalcExpression, inputs, {}, periodNs);
            calc.expression = expression;
            graph.blocks.push_back(std::move(calc));
            const bool upperEnabled = m_typeId == "control.calc_expression" && boolean("upperLimitEnabled", false);
            const bool lowerEnabled = m_typeId == "control.calc_expression" && boolean("lowerLimitEnabled", false);
            if (upperEnabled || lowerEnabled) {
                const double lower = lowerEnabled ? number("lowerLimit", 0.0) : -std::numeric_limits<double>::max();
                const double upper = upperEnabled ? number("upperLimit", 0.0) : std::numeric_limits<double>::max();
                graph.blocks.front().id = outId + "::calc";
                simulation::SignalBlockDefinition saturation =
                    makeBlock(outId, simulation::SignalBlockKind::Saturation, {"in"}, {lower, upper}, periodNs);
                graph.connections.push_back({outId + "::calc", "out", outId, "in", false});
                graph.blocks.push_back(std::move(saturation));
                connectInputs(graph, componentIndex, inputs, outId + "::calc");
                return graph;
            }
            connectInputs(graph, componentIndex, inputs, outId);
            return graph;
        }

        simulation::SignalBlockDefinition block = makeBlock(outId, kindOf(), inputs, parametersOf(), periodNs);
        if (block.kind == simulation::SignalBlockKind::DeadTime)
            block.historyCapacity = deadTimeCapacity(block.realParameters.front(), periodNs);
        if (block.kind == simulation::SignalBlockKind::Fopdt)
            block.historyCapacity = deadTimeCapacity(block.realParameters.at(2), periodNs);
        graph.blocks.push_back(std::move(block));
        connectInputs(graph, componentIndex, inputs, outId);
        return graph;
    }

private:
    std::vector<std::string> inputPortIds() const {
        if (m_typeId == "control.pid") return {"sp", "pv"};
        if (m_typeId == "control.tank") return {"in", "outflow"};
        if (m_typeId == "control.bias") {
            const std::vector<std::string> declared = declaredInputIds();
            return declared.empty() ? std::vector<std::string>{"in"} : std::vector<std::string>{declared.front()};
        }
        if (m_typeId == "control.calc_expression" || m_typeId == "control.sum" || m_typeId == "control.product" ||
            m_typeId == "control.subtract" || m_typeId == "control.divide") {
            std::vector<std::string> declared = declaredInputIds();
            if (m_typeId == "control.calc_expression") {
                if (declared.empty()) declared = {"in"};
                return declared;
            }
            if (declared.size() < 2) declared = {"in0", "in1"};
            return declared;
        }
        return {"in"};
    }

    /** As DUAS formas que a autoria real produz, exatamente como a Extension já as lê
     * (`catalog/controlGraphCatalog.ts::controlGraphPinIds`): array JSON (o `.lssubcircuit`, que
     * chega aqui como texto porque `PropertyValue` só guarda escalar -- ver
     * `paramsFromPropertiesJson`) e lista separada por vírgula (os defaults do catálogo e a edição
     * pelo inspector). Divergir da Extension aqui significaria pinos desenhados num lugar e portas
     * de sinal em outro. */
    std::vector<std::string> declaredInputIds() const {
        std::string raw = text("inputs", "");
        while (!raw.empty() && std::isspace(static_cast<unsigned char>(raw.front()))) raw.erase(raw.begin());
        if (raw.empty()) return {};
        std::vector<std::string> ids;
        if (raw.front() == '[') {
            try {
                const nlohmann::json parsed = nlohmann::json::parse(raw);
                if (!parsed.is_array()) return {};
                for (const auto& entry : parsed)
                    if (entry.is_string() && !entry.get<std::string>().empty()) ids.push_back(entry.get<std::string>());
            } catch (const std::exception&) {
                return {};
            }
            return ids;
        }
        size_t start = 0;
        while (start <= raw.size()) {
            const size_t comma = raw.find(',', start);
            std::string token = raw.substr(start, comma == std::string::npos ? std::string::npos : comma - start);
            const size_t first = token.find_first_not_of(" \t");
            const size_t last = token.find_last_not_of(" \t");
            if (first != std::string::npos) ids.push_back(token.substr(first, last - first + 1));
            if (comma == std::string::npos) break;
            start = comma + 1;
        }
        return ids;
    }

    simulation::SignalBlockKind kindOf() const {
        using Kind = simulation::SignalBlockKind;
        if (m_typeId == "control.gain") return Kind::Gain;
        if (m_typeId == "control.sum") return Kind::Sum;
        if (m_typeId == "control.product") return Kind::Product;
        if (m_typeId == "control.integrator") return Kind::Integrator;
        if (m_typeId == "control.filtered_derivative") return Kind::FilteredDerivative;
        if (m_typeId == "control.unit_delay") return Kind::UnitDelay;
        if (m_typeId == "control.dead_time") return Kind::DeadTime;
        if (m_typeId == "control.first_order") return Kind::FirstOrder;
        if (m_typeId == "control.second_order") return Kind::SecondOrder;
        if (m_typeId == "control.lead_lag") return Kind::LeadLag;
        if (m_typeId == "control.fopdt") return Kind::Fopdt;
        if (m_typeId == "control.tank") return Kind::Tank;
        if (m_typeId == "control.valve_characteristic") return Kind::ValveCharacteristic;
        if (m_typeId == "control.saturation") return Kind::Saturation;
        if (m_typeId == "control.limiter") return Kind::Limiter;
        if (m_typeId == "control.deadband") return Kind::Deadband;
        if (m_typeId == "control.hysteresis") return Kind::Hysteresis;
        if (m_typeId == "control.stiction") return Kind::Stiction;
        if (m_typeId == "control.rate_limiter") return Kind::RateLimiter;
        if (m_typeId == "control.pid") return Kind::Pid;
        if (m_typeId == "control.probe") return Kind::Probe;
        if (m_typeId == "control.transfer_function") return transferFunctionKind();
        throw std::invalid_argument("tipo de bloco de controle nao suportado: " + m_typeId);
    }

    simulation::SignalBlockKind transferFunctionKind() const {
        const std::string model = text("model", "first_order");
        if (model == "first_order") return simulation::SignalBlockKind::FirstOrder;
        if (model == "second_order") return simulation::SignalBlockKind::SecondOrder;
        if (model == "lead_lag") return simulation::SignalBlockKind::LeadLag;
        if (model == "fopdt") return simulation::SignalBlockKind::Fopdt;
        throw std::invalid_argument("modelo de funcao de transferencia desconhecido: " + model);
    }

    std::vector<double> parametersOf() const {
        using Kind = simulation::SignalBlockKind;
        switch (kindOf()) {
            case Kind::Gain: return {number("gain", 1.0)};
            case Kind::Sum:
            case Kind::Product:
            case Kind::Probe: return {};
            case Kind::Integrator: return {number("gain", 1.0), number("initial", 0.0)};
            case Kind::FilteredDerivative:
                return {number("gain", 1.0), number("filterTau", 0.01), number("initial", 0.0)};
            case Kind::UnitDelay: return {number("initial", 0.0)};
            case Kind::DeadTime: return {number("delay", 0.1), number("initial", 0.0)};
            case Kind::FirstOrder: return {number("gain", 1.0), number("tau", 1.0), number("initial", 0.0)};
            case Kind::SecondOrder:
                return {number("gain", 1.0), number("omega", 1.0), number("zeta", 1.0), number("initial", 0.0),
                        number("initialDerivative", 0.0)};
            case Kind::LeadLag:
                return {number("gain", 1.0), number("leadTau", 0.0), number("lagTau", 1.0), number("initial", 0.0)};
            case Kind::Fopdt:
                return {number("gain", 1.0), number("tau", 1.0), number("delay", 0.1), number("initial", 0.0)};
            case Kind::Tank: return {number("area", 1.0), number("initial", 0.0)};
            case Kind::ValveCharacteristic: return {number("coefficient", 1.0), number("exponent", 1.0)};
            case Kind::Saturation:
            case Kind::Limiter: return {number("minimum", 0.0), number("maximum", 100.0)};
            case Kind::Deadband: return {number("width", 0.0)};
            case Kind::Hysteresis:
                return {number("low", 0.0), number("high", 1.0), number("lowOutput", 0.0), number("highOutput", 1.0),
                        number("initial", 0.0)};
            case Kind::Stiction: return {number("breakaway", 0.0), number("slip", 0.0), number("initial", 0.0)};
            case Kind::RateLimiter: return {number("riseRate", 1.0), number("fallRate", 1.0), number("initial", 0.0)};
            case Kind::Pid:
                return {number("kc", 1.0), number("ti", 0.0), number("td", 0.0), number("bias", 0.0),
                        number("derivativeFilter", 0.1), number("outputMin", 0.0), number("outputMax", 100.0),
                        number("action", 1.0), boolean("derivativeOnPv", true) ? 1.0 : 0.0,
                        number("initialIntegral", 0.0)};
            default: return {};
        }
    }

    static simulation::SignalBlockDefinition makeBlock(std::string id, simulation::SignalBlockKind kind,
                                                        const std::vector<std::string>& inputs,
                                                        std::vector<double> parameters, uint64_t periodNs) {
        simulation::SignalBlockDefinition block;
        block.id = std::move(id);
        block.kind = kind;
        for (const std::string& input : inputs)
            block.inputs.push_back({input, {simulation::SignalScalarType::Real, 1}, ""});
        block.output = {"out", {simulation::SignalScalarType::Real, 1}, ""};
        block.realParameters = std::move(parameters);
        block.rate = {periodNs, 0, 0};
        // Uma malha de controle É um loop algébrico (PID -> processo -> PID): sem política explícita
        // `SignalCompiler` recusa o SCC inteiro. Blocos fora de qualquer ciclo ignoram isto.
        block.loopPolicy = simulation::AlgebraicLoopPolicy::FixedPoint;
        block.maxIterations = 16;
        block.tolerance = 1e-9;
        return block;
    }

    static uint32_t deadTimeCapacity(double delaySeconds, uint64_t periodNs) {
        const double delayNs = delaySeconds * 1'000'000'000.0;
        return static_cast<uint32_t>(std::max(2.0, std::ceil(delayNs / static_cast<double>(periodNs)) + 4.0));
    }

    static void connectInputs(simulation::SignalGraphDefinition& graph, uint32_t componentIndex,
                              const std::vector<std::string>& inputs, const std::string& targetBlock) {
        for (const std::string& input : inputs)
            graph.connections.push_back({signalPortBlockId(componentIndex, input), "out", targetBlock, input, false});
    }

    static void renameTerminal(simulation::SignalGraphDefinition& graph, const std::string& from,
                               const std::string& to) {
        for (auto& block : graph.blocks) if (block.id == from) block.id = to;
        for (auto& connection : graph.connections) {
            if (connection.sourceBlock == from) connection.sourceBlock = to;
            if (connection.targetBlock == from) connection.targetBlock = to;
        }
    }

    static std::string formatDouble(double value) {
        std::string text = std::to_string(value);
        return value < 0.0 ? "(" + text + ")" : text;
    }

    double number(std::string_view key, double fallback) const {
        const auto it = m_properties.find(std::string(key));
        if (it == m_properties.end()) return fallback;
        if (const double* value = std::get_if<double>(&it->second)) return *value;
        return fallback;
    }

    bool boolean(std::string_view key, bool fallback) const {
        const auto it = m_properties.find(std::string(key));
        if (it == m_properties.end()) return fallback;
        if (const bool* value = std::get_if<bool>(&it->second)) return *value;
        return fallback;
    }

    std::string text(std::string_view key, std::string fallback) const {
        const auto it = m_properties.find(std::string(key));
        if (it == m_properties.end()) return fallback;
        if (const std::string* value = std::get_if<std::string>(&it->second)) return *value;
        return fallback;
    }

    std::string m_typeId;
    std::unordered_map<std::string, PropertyValue> m_properties;
};

} // namespace lasecsimul::components
