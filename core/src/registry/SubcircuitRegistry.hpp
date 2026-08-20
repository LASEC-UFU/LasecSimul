#pragma once

#include <string>
#include <stdexcept>
#include <cstdint>
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
 * .spec/archive/legacy-v2/lasecsimul-subcircuits.spec, seção 2). */
struct SubcircuitInterfaceDef {
    std::string pinId;
    std::string label;
    std::string internalTunnel;
    std::string domain = "electrical";
    std::string direction = "inout";
    std::string valueType = "Real";
    uint16_t width = 1;
    std::string unit;
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
    void registerDefinition(SubcircuitDefinition def, bool allowReplace = true);

    const SubcircuitDefinition* find(const std::string& typeId) const {
        auto it = m_byTypeId.find(typeId);
        return it == m_byTypeId.end() ? nullptr : &it->second;
    }

    bool contains(const std::string& typeId) const { return m_byTypeId.count(typeId) > 0; }

    const std::unordered_map<std::string, SubcircuitDefinition>& all() const { return m_byTypeId; }

    /** Hash somente do conteúdo que participa da simulação. `packageJson`, nome, origem e layout
     * são deliberadamente ignorados. Dependências aninhadas entram transitivamente e ciclos são
     * rejeitados antes de qualquer expansão de runtime. */
    std::string semanticHash(const std::string& typeId) const;
    uint64_t semanticHashCacheHits() const { return m_semanticHashCacheHits; }

private:
    std::string semanticHashImpl(const std::string& typeId, std::vector<std::string>& stack) const;

    std::unordered_map<std::string, SubcircuitDefinition> m_byTypeId;
    mutable std::unordered_map<std::string, std::string> m_semanticHashCache;
    mutable uint64_t m_semanticHashCacheHits = 0;
};

} // namespace lasecsimul::registry
