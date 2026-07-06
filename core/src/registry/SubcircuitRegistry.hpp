#pragma once

#include <string>
#include <stdexcept>
#include <unordered_map>
#include <vector>

namespace lasecsimul::registry {

/** Componente interno declarado em `components[]` de um `.lssubcircuit` -- propriedades já vêm como
 * JSON serializado (não tipa aqui, quem aplica via `SimulationSession::setProperty` decide o
 * `PropertyValue` certo a partir do schema do `typeId`, igual a qualquer outro `addComponent`). */
struct SubcircuitComponentDef {
    std::string id;
    std::string typeId;
    std::string propertiesJson; // "{}" quando ausente
};

struct SubcircuitWireDef {
    std::string fromComponentId;
    std::string fromPinId;
    std::string toComponentId;
    std::string toPinId;
};

/** `interface[]` -- `pinId` é o nome público (visto de fora), `internalTunnel` é o
 * `properties.name` do `connectors.tunnel` interno correspondente (ver
 * .spec/lasecsimul-subcircuits.spec, seção 2). */
struct SubcircuitInterfaceDef {
    std::string pinId;
    std::string label;
    std::string internalTunnel;
};

/** Definição completa de um subcircuito, já parseada de `.lssubcircuit` -- `packageJson` fica opaco
 * (a Extension é quem desenha o símbolo; o Core nunca precisa interpretar `package`/`pins[]`
 * visuais, só validar que todo `package.pins[].id` existe em `interface[].pinId`, ver seção 3). */
struct SubcircuitDefinition {
    std::string typeId;
    std::string name;
    std::string sourcePath;
    std::vector<SubcircuitComponentDef> components;
    std::vector<SubcircuitWireDef> wires;
    std::vector<SubcircuitInterfaceDef> interfaceDefs;
    std::string packageJson; // "{}" quando ausente
};

class SubcircuitRegistry {
public:
    void registerDefinition(SubcircuitDefinition def, bool allowReplace = true) {
        if (!allowReplace && contains(def.typeId)) {
            throw std::invalid_argument("subcircuito duplicado: " + def.typeId);
        }
        m_byTypeId[def.typeId] = std::move(def);
    }

    const SubcircuitDefinition* find(const std::string& typeId) const {
        auto it = m_byTypeId.find(typeId);
        return it == m_byTypeId.end() ? nullptr : &it->second;
    }

    bool contains(const std::string& typeId) const { return m_byTypeId.count(typeId) > 0; }

    const std::unordered_map<std::string, SubcircuitDefinition>& all() const { return m_byTypeId; }

private:
    std::unordered_map<std::string, SubcircuitDefinition> m_byTypeId;
};

} // namespace lasecsimul::registry
