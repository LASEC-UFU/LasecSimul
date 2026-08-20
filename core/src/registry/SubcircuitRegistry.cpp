#include "SubcircuitRegistry.hpp"

#include <algorithm>
#include <iomanip>
#include <sstream>
#include <string_view>
#include <tuple>

#include <nlohmann/json.hpp>

namespace lasecsimul::registry {
namespace {

constexpr uint64_t kFnvOffset = 14695981039346656037ull;
constexpr uint64_t kFnvPrime = 1099511628211ull;

void hashText(uint64_t& hash, std::string_view text) {
    for (unsigned char byte : text) {
        hash ^= byte;
        hash *= kFnvPrime;
    }
    hash ^= 0xff;
    hash *= kFnvPrime;
}

std::string canonicalProperties(std::string_view raw) {
    try {
        return nlohmann::json::parse(raw).dump();
    } catch (const nlohmann::json::exception& error) {
        throw std::invalid_argument("properties JSON invalido em subcircuito: " + std::string(error.what()));
    }
}

std::string hexHash(uint64_t hash) {
    std::ostringstream output;
    output << std::hex << std::setfill('0') << std::setw(16) << hash;
    return output.str();
}

} // namespace

void SubcircuitRegistry::registerDefinition(SubcircuitDefinition def, bool allowReplace) {
    if (def.typeId.empty()) throw std::invalid_argument("subcircuito sem typeId");
    if (!allowReplace && contains(def.typeId)) {
        throw std::invalid_argument("subcircuito duplicado: " + def.typeId);
    }
    m_byTypeId[def.typeId] = std::move(def);
    // Um replacement pode alterar qualquer hash transitivo. A quantidade de definições é pequena
    // no cold path; invalidar tudo é determinístico e evita um grafo reverso só para cache.
    m_semanticHashCache.clear();
}

std::string SubcircuitRegistry::semanticHash(const std::string& typeId) const {
    std::vector<std::string> stack;
    return semanticHashImpl(typeId, stack);
}

std::string SubcircuitRegistry::semanticHashImpl(const std::string& typeId,
                                                 std::vector<std::string>& stack) const {
    if (const auto cached = m_semanticHashCache.find(typeId); cached != m_semanticHashCache.end()) {
        ++m_semanticHashCacheHits;
        return cached->second;
    }
    const auto definitionIt = m_byTypeId.find(typeId);
    if (definitionIt == m_byTypeId.end()) throw std::invalid_argument("subcircuito desconhecido: " + typeId);
    if (std::find(stack.begin(), stack.end(), typeId) != stack.end()) {
        throw std::runtime_error("ciclo de dependencia de subcircuito detectado envolvendo: " + typeId);
    }
    stack.push_back(typeId);
    const SubcircuitDefinition& definition = definitionIt->second;
    uint64_t hash = kFnvOffset;

    std::vector<const SubcircuitComponentDef*> components;
    components.reserve(definition.components.size());
    for (const auto& component : definition.components) components.push_back(&component);
    std::sort(components.begin(), components.end(), [](const auto* left, const auto* right) {
        return std::tie(left->id, left->typeId) < std::tie(right->id, right->typeId);
    });
    for (const SubcircuitComponentDef* component : components) {
        hashText(hash, component->id);
        hashText(hash, component->typeId);
        hashText(hash, canonicalProperties(component->propertiesJson));
        if (contains(component->typeId)) hashText(hash, semanticHashImpl(component->typeId, stack));
    }

    std::vector<SubcircuitWireDef> wires = definition.wires;
    std::sort(wires.begin(), wires.end(), [](const auto& left, const auto& right) {
        return std::tie(left.fromComponentId, left.fromPinId, left.toComponentId, left.toPinId) <
               std::tie(right.fromComponentId, right.fromPinId, right.toComponentId, right.toPinId);
    });
    for (const auto& wire : wires) {
        hashText(hash, wire.fromComponentId);
        hashText(hash, wire.fromPinId);
        hashText(hash, wire.toComponentId);
        hashText(hash, wire.toPinId);
    }

    std::vector<SubcircuitInterfaceDef> interfaces = definition.interfaceDefs;
    std::sort(interfaces.begin(), interfaces.end(), [](const auto& left, const auto& right) {
        return left.pinId < right.pinId;
    });
    for (const auto& interfaceDef : interfaces) {
        hashText(hash, interfaceDef.pinId);
        hashText(hash, interfaceDef.internalTunnel);
        hashText(hash, interfaceDef.domain);
        hashText(hash, interfaceDef.direction);
        hashText(hash, interfaceDef.valueType);
        hashText(hash, std::to_string(interfaceDef.width));
        hashText(hash, interfaceDef.unit);
        // label é apresentação e não participa do resultado numérico.
    }

    stack.pop_back();
    const std::string result = hexHash(hash);
    m_semanticHashCache[typeId] = result;
    return result;
}

} // namespace lasecsimul::registry
