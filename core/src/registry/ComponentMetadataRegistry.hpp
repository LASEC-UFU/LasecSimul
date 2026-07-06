#pragma once

#include <optional>
#include <string>
#include <unordered_map>
#include <vector>
#include "lasecsimul/Types.hpp"

namespace lasecsimul::registry {

/** Schema de UI por typeId — pinos, propriedades editáveis, ícone. Não depende de o plugin ter
 * carregado com sucesso como factory instanciável: vem direto do manifesto parseado. Separado de
 * ComponentRegistry (factory) de propósito — ver .spec/lasecsimul-native-devices.spec, seção 1. */
struct ComponentMetadata {
    std::string typeId;
    std::string displayName;
    std::vector<Pin> pins;
    std::vector<PropertySchema> propertySchema;
    std::string iconPath;
    /** Língua em que `displayName`/`propertySchema[].label`/`.group`/`.options[].label` estão escritos
     * — declaração obrigatória (RNF12 de `lasecsimul.spec`), default "pt-BR" pra built-in e pra
     * `.lsdevice` que ainda não declara `language` explicitamente (compatibilidade). */
    std::string language = "pt-BR";
    /** JSON crú de `.lsdevice`'s `translations` (vazio = nenhuma tradução) — texto, não struct
     * tipada, pra não acoplar este header a `nlohmann::json`; quem resolve é `CoreApplication.cpp`
     * (`resolvePropertySchemaForLanguage`), que já depende disso em todo lugar. Formato:
     * `{"<lang>": {"name": "...", "properties": {"<id>": {"label": "...", "group": "..."}}}}`. */
    std::string translationsJson;
    /** `limits.stepTimeoutMs` do `.lsdevice` -- 0 == sem watchdog. Ver
     * .spec/lasecsimul-native-devices.spec, seção 13. */
    uint32_t stepTimeoutMs = 0;
    /** ABI v2 (.spec/lasecsimul-native-devices.spec): como a UI decodifica leitura/interage com o
     * componente sem checar typeId. `std::nullopt` é uma declaração válida ("sem leitura
     * estruturada"/"sem interação especial"), não um estado "ainda não migrado". */
    std::optional<ReadoutFormat> readoutFormat;
    std::optional<InteractionKind> interactionKind;
};

class ComponentMetadataRegistry {
public:
    void registerMetadata(ComponentMetadata meta) {
        m_metadata[meta.typeId] = std::move(meta);
    }

    const ComponentMetadata* find(const std::string& typeId) const {
        auto it = m_metadata.find(typeId);
        return it != m_metadata.end() ? &it->second : nullptr;
    }

    /** Enumera tudo já registrado (built-in + plugin) — usado pelo handler IPC `getPropertySchemas`
     * pra devolver o catálogo inteiro de uma vez, em vez de uma consulta por typeId. */
    const std::unordered_map<std::string, ComponentMetadata>& all() const { return m_metadata; }

private:
    std::unordered_map<std::string, ComponentMetadata> m_metadata;
};

} // namespace lasecsimul::registry
