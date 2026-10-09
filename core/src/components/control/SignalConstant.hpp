#pragma once

#include <cmath>
#include <cstring>
#include <span>
#include <string>
#include <vector>

#include "lasecsimul/IComponentModel.hpp"
#include "lasecsimul/PropertyDefinition.hpp"
#include "registry/ComponentParams.hpp"

namespace lasecsimul::components {

/** Bloco Constante (`control.constant`): uma saída de sinal com valor fixo e configurável, sem
 * terminal elétrico. É o parâmetro de um modelo montado com blocos (altura do tanque, densidade de
 * um fluido, pressão de gás...): exportado pelo `.lssubcircuit`, vira um campo da janela
 * "Propriedades Exportadas".
 *
 * Entra no Signal Graph exatamente como o slider de operador (`ManualSignalSlider`): uma entrada
 * externa com o valor inicial, e a sessão empurra o valor novo quando a propriedade muda
 * (`SimulationSession::setPropertyUnlocked`). Por isso `value` NÃO é estrutural: muda com a
 * simulação rodando, sem recompilar o plano. A unidade é só rótulo -- a porta é adimensional, como
 * a do slider, para ligar em qualquer entrada sem a checagem de unidades do Signal Engine. */
class SignalConstant final : public IComponentModel {
public:
    static constexpr const char* kTypeId = "control.constant";

    explicit SignalConstant(const registry::ComponentParams& params) : m_value(params.property("value", 0.0)) {
        if (!std::isfinite(m_value)) m_value = 0.0;
        if (const auto it = params.properties.find("unit"); it != params.properties.end())
            if (const auto* unit = std::get_if<std::string>(&it->second)) m_unit = *unit;
        if (const auto it = params.properties.find("options"); it != params.properties.end())
            if (const auto* options = std::get_if<std::string>(&it->second)) m_options = *options;
    }

    const char* typeId() const override { return kTypeId; }
    std::span<Pin> pins() override { return {}; }
    void stamp(MnaMatrixView&) override {}
    void postStep(uint64_t) override {}

    std::vector<SignalPortDescriptor> signalPorts() const override {
        return {{"out", SignalPortDirection::Output, SignalValueKind::Analog, ""}};
    }

    double value() const noexcept { return m_value; }

    /** Leitura escalar (mesmo formato de voltímetro/sonda): o valor pode ser mostrado por um
     * elemento gráfico de supervisório ligado a este bloco. */
    static ReadoutFormat readoutFormat() {
        ReadoutFormat format;
        format.kind = ReadoutKind::Scalar;
        format.unit = "";
        return format;
    }
    size_t getState(uint8_t* out, size_t cap) const override {
        if (!out || cap < sizeof(double)) return 0;
        std::memcpy(out, &m_value, sizeof(double));
        return sizeof(double);
    }
    void setState(const uint8_t*, size_t) override {}

    std::vector<PropertyDescriptor> propertyDescriptors() override {
        const auto schemas = propertySchema();
        PropertyDescriptor value;
        value.name = "value";
        value.schema = schemas[0];
        value.get = [this] { return PropertyValue{m_value}; };
        value.set = [this](const PropertyValue& next) {
            if (const double* number = std::get_if<double>(&next); number && std::isfinite(*number)) m_value = *number;
        };
        PropertyDescriptor unit;
        unit.name = "unit";
        unit.schema = schemas[1];
        unit.get = [this] { return PropertyValue{m_unit}; };
        unit.set = [this](const PropertyValue& next) {
            if (const auto* text = std::get_if<std::string>(&next)) m_unit = *text;
        };
        PropertyDescriptor options;
        options.name = "options";
        options.schema = schemas[2];
        options.get = [this] { return PropertyValue{m_options}; };
        options.set = [this](const PropertyValue& next) {
            if (const auto* text = std::get_if<std::string>(&next)) m_options = *text;
        };
        return {std::move(value), std::move(unit), std::move(options)};
    }

    static std::vector<PropertySchema> propertySchema() {
        PropertySchema value;
        value.id = "value";
        value.label = "Valor";
        value.group = "Sinal";
        value.valueKind = PropertyValueKind::Number;
        value.editor = "number";
        value.defaultValue = 0.0;
        PropertySchema unit;
        unit.id = "unit";
        unit.label = "Unidade";
        unit.group = "Sinal";
        unit.valueKind = PropertyValueKind::String;
        unit.editor = "text";
        unit.defaultValue = std::string();
        // Lista de escolha opcional "1=Aço carbono;2=Aço inox 316;..." -- o valor continua sendo o
        // número; a Extension mostra uma caixa de seleção com os nomes (material, tipo de tomada...).
        PropertySchema options;
        options.id = "options";
        options.label = "Opções (valor=nome;...)";
        options.group = "Sinal";
        options.valueKind = PropertyValueKind::String;
        options.editor = "text";
        options.defaultValue = std::string();
        return {value, unit, options};
    }

private:
    double m_value = 0.0;
    std::string m_unit;
    std::string m_options;
};

} // namespace lasecsimul::components
