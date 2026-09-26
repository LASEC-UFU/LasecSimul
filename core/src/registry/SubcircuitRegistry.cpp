#include "SubcircuitRegistry.hpp"

#include <algorithm>
#include <unordered_set>
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

// Existing schema v3 documents may have used the electrical tunnel as a signal
// relay. Classify those relays from control wires and signal interfaces before
// the definition reaches the runtime. The electrical Tunnel remains electrical.
void migrateLegacySignalTunnels(SubcircuitDefinition& def) {
    std::unordered_map<std::string, size_t> componentById;
    std::unordered_map<std::string, std::vector<size_t>> tunnelsByName;
    for (size_t index = 0; index < def.components.size(); ++index) {
        const auto& component = def.components[index];
        componentById.emplace(component.id, index);
        if (component.typeId != "connectors.tunnel") continue;
        const auto properties = nlohmann::json::parse(component.propertiesJson);
        if (properties.contains("name") && properties["name"].is_string())
            tunnelsByName[properties["name"].get<std::string>()].push_back(index);
    }
    std::unordered_set<size_t> signalTunnels;
    for (const auto& iface : def.interfaceDefs) {
        if (iface.domain != "signal") continue;
        if (const auto found = tunnelsByName.find(iface.internalTunnel); found != tunnelsByName.end())
            signalTunnels.insert(found->second.begin(), found->second.end());
    }
    bool changed;
    do {
        changed = false;
        for (const auto& wire : def.wires) {
            const auto from = componentById.find(wire.fromComponentId);
            const auto to = componentById.find(wire.toComponentId);
            if (from == componentById.end() || to == componentById.end()) continue;
            const auto isSignal = [&](size_t index) {
                const auto& component = def.components[index];
                return component.typeId.rfind("control.", 0) == 0 ||
                       component.typeId == "connectors.signal_tunnel" || signalTunnels.contains(index);
            };
            if (def.components[from->second].typeId == "connectors.tunnel" && isSignal(to->second))
                changed |= signalTunnels.insert(from->second).second;
            if (def.components[to->second].typeId == "connectors.tunnel" && isSignal(from->second))
                changed |= signalTunnels.insert(to->second).second;
        }
        for (const auto& [name, members] : tunnelsByName) {
            const bool active = std::any_of(members.begin(), members.end(),
                [&](size_t index) { return signalTunnels.contains(index); });
            if (!active) continue;
            for (size_t index : members) changed |= signalTunnels.insert(index).second;
        }
    } while (changed);
    if (signalTunnels.empty()) return;

    for (auto& iface : def.interfaceDefs) {
        const auto found = tunnelsByName.find(iface.internalTunnel);
        if (found == tunnelsByName.end() || !signalTunnels.contains(found->second.front())) continue;
        iface.domain = "signal";
        if (iface.direction == "inout") {
            const auto properties = nlohmann::json::parse(def.components[found->second.front()].propertiesJson);
            iface.direction = properties.value("direction", std::string{}) == "Output" ? "out" : "in";
        }
    }
    for (size_t index : signalTunnels) def.components[index].typeId = "connectors.signal_tunnel";
    for (auto& wire : def.wires) {
        if (const auto found = componentById.find(wire.fromComponentId);
            found != componentById.end() && signalTunnels.contains(found->second) && wire.fromPinId == "pin")
            wire.fromPinId = "value";
        if (const auto found = componentById.find(wire.toComponentId);
            found != componentById.end() && signalTunnels.contains(found->second) && wire.toPinId == "pin")
            wire.toPinId = "value";
    }
}

} // namespace

void SubcircuitRegistry::registerDefinition(SubcircuitDefinition def, bool allowReplace) {
    if (def.typeId.empty()) throw std::invalid_argument("subcircuito sem typeId");
    if (!allowReplace && contains(def.typeId)) {
        throw std::invalid_argument("subcircuito duplicado: " + def.typeId);
    }
    // A camada de supervisório (`graphics.*`) é autoria/Extension, nunca runtime: FEAT-008 decide
    // que assets e bindings pertencem à autoria e que o Core apenas publica valores. Um tanque, um
    // rótulo ou uma válvula desenhada não tem -- e não deve ter -- factory de componente; deixar
    // esses filhos na definição faria `expandSubcircuit` falhar com "Unknown component typeId" ao
    // instanciar qualquer processo que tenha tela.
    //
    // O corte vive AQUI, e não em quem lê o manifesto, porque este é o único ponto por onde TODA
    // definição passa (carga de biblioteca, registro ad-hoc e testes que montam a definição à mão).
    // Wires que tocariam um elemento visual também saem junto -- um objeto de tela nunca participa
    // de topologia elétrica nem de grafo de sinal.
    const auto isVisualOnly = [](const std::string& typeId) { return typeId.rfind("graphics.", 0) == 0; };
    std::unordered_set<std::string> visualIds;
    for (const auto& component : def.components) if (isVisualOnly(component.typeId)) visualIds.insert(component.id);
    if (!visualIds.empty()) {
        def.components.erase(std::remove_if(def.components.begin(), def.components.end(),
            [&](const SubcircuitComponentDef& component) { return isVisualOnly(component.typeId); }), def.components.end());
        def.wires.erase(std::remove_if(def.wires.begin(), def.wires.end(),
            [&](const SubcircuitWireDef& wire) {
                return visualIds.count(wire.fromComponentId) > 0 || visualIds.count(wire.toComponentId) > 0;
            }), def.wires.end());
    }
    migrateLegacySignalTunnels(def);
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
