#pragma once

#include <algorithm>
#include <array>
#include <cctype>
#include <cstdint>
#include <cstring>
#include <deque>
#include <span>
#include <stdexcept>
#include <string>
#include <unordered_set>
#include <unordered_map>
#include <variant>
#include <vector>

#include <nlohmann/json.hpp>

#include "lasecsimul/IComponentModel.hpp"
#include "registry/ComponentParams.hpp"

namespace lasecsimul::python {

enum class PythonPortType : uint8_t { Real, Bool, Int64 };

struct PythonPort {
    std::string name;
    PythonPortType type = PythonPortType::Real;
    std::string unit;
    std::string description;
    std::variant<bool, int64_t, double> initialValue = 0.0;
};

/** Authoring component for Python logic. It exposes only typed Signal Engine ports: electrical
 * coupling remains the responsibility of the existing sensor/actuator bridges. */
class PythonProgramBlock final : public IComponentModel {
public:
    static constexpr const char* kTypeId = "python.programmable";

    explicit PythonProgramBlock(const registry::ComponentParams& params) {
        m_source = "# Escreva aqui a logica Python do bloco.\npass\n";
        if (const auto it = params.properties.find("source"); it != params.properties.end())
            if (const auto* value = std::get_if<std::string>(&it->second); value && !value->empty()) m_source = *value;
        if (const auto it = params.properties.find("periodNs"); it != params.properties.end())
            if (const auto* value = std::get_if<double>(&it->second); value && *value >= 0.0 && *value <= 1.0e15)
                m_periodNs = static_cast<uint64_t>(*value);
        if (const auto it = params.properties.find("failureMode"); it != params.properties.end())
            if (const auto* value = std::get_if<std::string>(&it->second); value &&
                (*value == "hold" || *value == "initial" || *value == "zero")) m_failureMode = *value;
        if (const auto it = params.properties.find("ports"); it != params.properties.end()) {
            if (const auto* raw = std::get_if<std::string>(&it->second); raw && !raw->empty()) parsePorts(*raw);
        }
        if (m_inputs.empty()) m_inputs.push_back({"x", PythonPortType::Real, "", ""});
        if (m_outputs.empty()) m_outputs.push_back({"y", PythonPortType::Real, "", ""});
        refreshSignalPorts();
    }

    const char* typeId() const override { return kTypeId; }
    std::span<Pin> pins() override { return {}; }
    void stamp(MnaMatrixView&) override {}
    void postStep(uint64_t) override {}
    std::vector<SignalPortDescriptor> signalPorts() const override { return m_signalPorts; }

    const std::string& source() const noexcept { return m_source; }
    uint64_t periodNs() const noexcept { return m_periodNs; }
    const std::string& failureMode() const noexcept { return m_failureMode; }
    const std::vector<PythonPort>& inputs() const noexcept { return m_inputs; }
    const std::vector<PythonPort>& outputs() const noexcept { return m_outputs; }

    void recordOutputs(const std::unordered_map<std::string, std::variant<bool, int64_t, double>>& values,
                       uint64_t timestampNs) {
        for (size_t index = 0; index < m_outputs.size() && index < m_lastOutputs.size(); ++index) {
            const auto value = values.find(m_outputs[index].name);
            if (value != values.end()) m_lastOutputs[index] = std::visit([](const auto& item) { return static_cast<double>(item); }, value->second);
        }
        OutputSample sample;
        sample.timestampNs = timestampNs;
        sample.values = m_lastOutputs;
        m_history.push_back(std::move(sample));
        while (m_history.size() > kHistoryCapacity) m_history.pop_front();
    }

    static ReadoutFormat readoutFormat() {
        return {ReadoutKind::ChannelHistory, "", kReadoutChannelCount};
    }

    size_t getState(uint8_t* out, size_t capacity) const override {
        const uint32_t count = static_cast<uint32_t>(m_history.size());
        const size_t headerBytes = sizeof(m_lastOutputs) + sizeof(count);
        const size_t needed = headerBytes + kReadoutChannelCount * count * kSampleBytes;
        if (!out || capacity < needed) return needed;
        std::memcpy(out, m_lastOutputs.data(), sizeof(m_lastOutputs));
        std::memcpy(out + sizeof(m_lastOutputs), &count, sizeof(count));
        size_t offset = headerBytes;
        for (size_t channel = 0; channel < kReadoutChannelCount; ++channel) {
            for (const OutputSample& sample : m_history) {
                std::memcpy(out + offset, &sample.timestampNs, sizeof(sample.timestampNs)); offset += sizeof(sample.timestampNs);
                std::memcpy(out + offset, &sample.values[channel], sizeof(sample.values[channel])); offset += sizeof(sample.values[channel]);
            }
        }
        return offset;
    }
    size_t getTelemetryState(uint8_t* out, size_t capacity) const override {
        if (!out || capacity < sizeof(m_lastOutputs)) return sizeof(m_lastOutputs);
        std::memcpy(out, m_lastOutputs.data(), sizeof(m_lastOutputs));
        return sizeof(m_lastOutputs);
    }
    void setState(const uint8_t* in, size_t size) override {
        if (!in || size < sizeof(m_lastOutputs)) return;
        std::memcpy(m_lastOutputs.data(), in, sizeof(m_lastOutputs));
        m_history.clear();
    }

    std::vector<PropertyDescriptor> propertyDescriptors() override {
        PropertySchema code;
        code.id = "source"; code.label = "Código Python"; code.group = "Python";
        code.valueKind = PropertyValueKind::String; code.editor = "multiline";
        code.defaultValue = std::string{"# Escreva aqui a logica Python do bloco.\npass\n"}; code.flags = PropertySchemaAffectsTopology | PropertySchemaHidden;
        PropertyDescriptor source;
        source.name = "source"; source.schema = code;
        source.get = [this] { return PropertyValue{m_source}; };
        source.set = [this](const PropertyValue& next) { if (const auto* text = std::get_if<std::string>(&next)) m_source = *text; };

        PropertySchema ports;
        ports.id = "ports"; ports.label = "Portas (JSON)"; ports.group = "Python";
        ports.valueKind = PropertyValueKind::String; ports.editor = "multiline";
        ports.defaultValue = std::string{}; ports.flags = PropertySchemaAffectsTopology | PropertySchemaAffectsPinCount | PropertySchemaHidden;
        PropertyDescriptor schema;
        schema.name = "ports"; schema.schema = ports;
        schema.get = [this] { return PropertyValue{serializePorts()}; };
        schema.set = [this](const PropertyValue& next) {
            if (const auto* text = std::get_if<std::string>(&next)) {
                parsePorts(*text);
                refreshSignalPorts();
            }
        };

        PropertySchema period;
        period.id = "periodNs"; period.label = "Período (ns)"; period.group = "Execução";
        period.valueKind = PropertyValueKind::Number; period.editor = "number";
        period.defaultValue = 1'000'000.0; period.minValue = 1.0; period.maxValue = 1.0e15;
        period.flags = PropertySchemaAffectsTopology;
        PropertyDescriptor rate;
        rate.name = "periodNs"; rate.schema = period;
        rate.get = [this] { return PropertyValue{static_cast<double>(m_periodNs)}; };
        rate.set = [this](const PropertyValue& next) {
            if (const auto* value = std::get_if<double>(&next); value && *value >= 1.0 && *value <= 1.0e15)
                m_periodNs = static_cast<uint64_t>(*value);
        };

        PropertySchema failure;
        failure.id = "failureMode"; failure.label = "Saídas em caso de erro"; failure.group = "Execução";
        failure.valueKind = PropertyValueKind::String; failure.editor = "select";
        failure.defaultValue = std::string{"hold"};
        failure.options = {{"hold", "Manter últimas saídas"}, {"initial", "Usar valores iniciais"}, {"zero", "Zerar saídas"}};
        PropertyDescriptor errorPolicy;
        errorPolicy.name = "failureMode"; errorPolicy.schema = failure;
        errorPolicy.get = [this] { return PropertyValue{m_failureMode}; };
        errorPolicy.set = [this](const PropertyValue& next) {
            if (const auto* value = std::get_if<std::string>(&next); value &&
                (*value == "hold" || *value == "initial" || *value == "zero")) m_failureMode = *value;
        };
        return {std::move(source), std::move(schema), std::move(rate), std::move(errorPolicy)};
    }

    static std::vector<PropertySchema> propertySchema() {
        PythonProgramBlock empty(registry::ComponentParams{});
        std::vector<PropertySchema> result;
        for (auto& descriptor : empty.propertyDescriptors()) result.push_back(descriptor.schema);
        return result;
    }

private:
    static PythonPortType parseType(const std::string& type) {
        if (type == "bool") return PythonPortType::Bool;
        if (type == "int64") return PythonPortType::Int64;
        if (type == "real") return PythonPortType::Real;
        throw std::invalid_argument("tipo de porta Python inválido: " + type);
    }
    static SignalValueKind signalKind(PythonPortType type) {
        switch (type) {
        case PythonPortType::Bool: return SignalValueKind::Digital;
        case PythonPortType::Int64: return SignalValueKind::Unsigned;
        default: return SignalValueKind::Analog;
        }
    }
    static void validateName(const std::string& name, std::unordered_set<std::string>& names) {
        if (name.empty() || !(std::isalpha(static_cast<unsigned char>(name[0])) || name[0] == '_'))
            throw std::invalid_argument("nome de porta deve ser um identificador Python: " + name);
        for (unsigned char c : name)
            if (!(std::isalnum(c) || c == '_')) throw std::invalid_argument("nome de porta deve ser um identificador Python: " + name);
        static const std::unordered_set<std::string> keywords = {
            "False","None","True","and","as","assert","async","await","break","class","continue","def","del",
            "elif","else","except","finally","for","from","global","if","import","in","is","lambda","nonlocal",
            "not","or","pass","raise","return","try","while","with","yield","match","case"
        };
        if (keywords.contains(name)) throw std::invalid_argument("nome de porta é palavra reservada do Python: " + name);
        if (name == "sim" || name == "state" || name == "inputs" || name == "outputs")
            throw std::invalid_argument("nome de porta reservado pelo contexto Python: " + name);
        if (!names.insert(name).second) throw std::invalid_argument("nome de porta duplicado: " + name);
    }
    void parsePorts(const std::string& raw) {
        const auto json = nlohmann::json::parse(raw);
        if (!json.is_object()) throw std::invalid_argument("ports deve ser um objeto JSON");
        std::vector<PythonPort> inputs, outputs;
        std::unordered_set<std::string> names;
        const auto read = [&](const char* key, std::vector<PythonPort>& ports) {
            if (!json.contains(key)) return;
            if (!json[key].is_array() || json[key].size() > 64) throw std::invalid_argument("lista de portas inválida: " + std::string(key));
            for (const auto& item : json[key]) {
                if (!item.is_object() || !item.contains("name") || !item["name"].is_string()) throw std::invalid_argument("porta sem nome válido");
                PythonPort port;
                port.name = item["name"].get<std::string>();
                validateName(port.name, names);
                port.type = parseType(item.value("type", std::string{"real"}));
                port.unit = item.value("unit", std::string{});
                port.description = item.value("description", std::string{});
                if (port.type == PythonPortType::Bool) port.initialValue = item.value("initialValue", false);
                else if (port.type == PythonPortType::Int64) port.initialValue = item.value("initialValue", int64_t{0});
                else port.initialValue = item.value("initialValue", 0.0);
                ports.push_back(std::move(port));
            }
        };
        read("inputs", inputs); read("outputs", outputs);
        m_inputs = std::move(inputs); m_outputs = std::move(outputs);
    }
    std::string serializePorts() const {
        const auto write = [](const std::vector<PythonPort>& ports) {
            nlohmann::json result = nlohmann::json::array();
            for (const auto& port : ports) {
                const char* type = port.type == PythonPortType::Bool ? "bool" : port.type == PythonPortType::Int64 ? "int64" : "real";
                nlohmann::json initial = std::visit([](const auto& value) -> nlohmann::json { return value; }, port.initialValue);
                result.push_back({{"name", port.name}, {"type", type}, {"unit", port.unit}, {"description", port.description}, {"initialValue", initial}});
            }
            return result;
        };
        return nlohmann::json{{"inputs", write(m_inputs)}, {"outputs", write(m_outputs)}}.dump();
    }
    void refreshSignalPorts() {
        m_signalPorts.clear();
        m_history.clear();
        m_lastOutputs.fill(0.0);
        for (size_t index = 0; index < m_outputs.size() && index < m_lastOutputs.size(); ++index) {
            m_lastOutputs[index] = std::visit([](const auto& value) { return static_cast<double>(value); }, m_outputs[index].initialValue);
        }
        for (const auto& port : m_inputs) m_signalPorts.push_back({port.name, SignalPortDirection::Input, signalKind(port.type), port.unit});
        for (const auto& port : m_outputs) m_signalPorts.push_back({port.name, SignalPortDirection::Output, signalKind(port.type), port.unit});
    }

    std::string m_source;
    uint64_t m_periodNs = 1'000'000;
    std::string m_failureMode = "hold";
    std::vector<PythonPort> m_inputs;
    std::vector<PythonPort> m_outputs;
    std::vector<SignalPortDescriptor> m_signalPorts;
    static constexpr size_t kReadoutChannelCount = 64;
    static constexpr size_t kHistoryCapacity = 60;
    static constexpr size_t kSampleBytes = sizeof(uint64_t) + sizeof(double);
    struct OutputSample { uint64_t timestampNs = 0; std::array<double, kReadoutChannelCount> values{}; };
    std::array<double, kReadoutChannelCount> m_lastOutputs{};
    std::deque<OutputSample> m_history;
};

} // namespace lasecsimul::python
