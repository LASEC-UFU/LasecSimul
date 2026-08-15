#pragma once

#include <array>
#include <string>
#include <unordered_map>
#include <variant>
#include <vector>
#include "fpga/FpgaPortMapper.hpp"
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

    /** Configuração VHDL de `digital.generic_fpga` -- fora do mapa `properties` (que só aceita
     * `PropertyValue` escalar, ver `lasecsimul::PropertyValue`) de propósito, mesmo precedente já
     * usado por `pinList`/`signalAliases` acima. Preenchido a partir da chave irmã `"fpga"` do
     * payload de `addComponent` (mesma ideia do `.lsproj`, onde `"fpga"` também é uma chave irmã
     * de `"properties"`/`"visual"` no componente salvo -- ver plano FPGA, seção "Property/config
     * storage"). Vazio para todo componente que não seja FPGA. */
    std::vector<std::string> fpgaSources;
    std::string fpgaTop;
    std::string fpgaStandard = "08";
    std::vector<fpga::PortSpec> fpgaPorts;
    /** Toolchain GHDL resolvido pela Extension e enviado fresco a cada `addComponent` -- nunca
     * um valor de sessão cacheado no Core (ver CoreApplication.cpp, parsing da chave "fpga"). A
     * factory de `digital.generic_fpga` usa isto pra construir o `GhdlBackend` desta instância. */
    std::string fpgaGhdlBinary = "ghdl";
    std::string fpgaVpiModulePath;
    std::string fpgaCacheRootDir;

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
