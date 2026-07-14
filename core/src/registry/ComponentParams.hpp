#pragma once

#include <array>
#include <string>
#include <unordered_map>
#include <variant>
#include <vector>
#include "lasecsimul/Types.hpp"

namespace lasecsimul::registry {

using lasecsimul::PropertyValue; // mesmo tipo usado por PropertyDescriptor (IComponentModel.hpp)

/**
 * Parâmetros de criação de uma instância — posição dos pinos (id/kind vêm do esquema fixo do
 * `typeId`, não daqui) e propriedades editáveis (ex: resistência). Quem monta isto é
 * `SimulationSession::addComponent`, a partir do que chegou da Extension via IPC.
 */
struct ComponentParams {
    std::string instanceName;
    std::vector<std::string> signalAliases;
    std::vector<lasecsimul::Pin> pinList;
    std::unordered_map<std::string, PropertyValue> properties;

    template <size_t N>
    std::array<lasecsimul::Pin, N> pins() const {
        std::array<lasecsimul::Pin, N> result{};
        for (size_t i = 0; i < N && i < pinList.size(); ++i) result[i] = pinList[i];
        return result;
    }

    double property(const std::string& name, double defaultValue) const {
        auto it = properties.find(name);
        if (it == properties.end()) return defaultValue;
        if (const double* v = std::get_if<double>(&it->second)) return *v;
        return defaultValue;
    }

    bool property(const std::string& name, bool defaultValue) const {
        auto it = properties.find(name);
        if (it == properties.end()) return defaultValue;
        if (const bool* v = std::get_if<bool>(&it->second)) return *v;
        return defaultValue;
    }
};

} // namespace lasecsimul::registry
