#pragma once

#include <algorithm>
#include <cmath>
#include <cstdio>
#include <functional>
#include <optional>
#include <stdexcept>
#include <string>
#include <unordered_map>
#include <vector>
#include "IComponentModel.hpp"
#include "Types.hpp"

namespace lasecsimul {

/**
 * Valida um `PropertyValue` contra um `PropertySchema` -- mesma regra que
 * `SimulationSession::setProperty` já aplicava (readOnly/tipo/min/max/opções), agora extraída pra
 * cá e usada por ELE (não duplicada) e por `PropertyDefinition::set` (achado de auditoria
 * arquitetural 2026-07-09, D4: antes disto, `ComponentParams::property()` na criação não validava
 * NADA contra o schema -- só caía num default silencioso em qualquer mismatch -- enquanto
 * `SimulationSession::setProperty` em runtime validava tudo; a mesma "propriedade" tinha duas
 * regras diferentes dependendo de SE foi lida na criação ou editada depois. Já causou bug real 2x
 * (`SimulidePassiveState`, `Probe`): fábrica que esquece de ler um campo perde o valor salvo
 * silenciosamente ao reabrir um projeto). Devolve `std::nullopt` se `value` é aceitável.
 */
inline std::optional<std::string> validatePropertyValue(const PropertySchema& schema, const PropertyValue& value) {
    if ((schema.flags & PropertySchemaReadOnly) != 0) return "propriedade somente leitura";

    switch (schema.valueKind) {
        case PropertyValueKind::Number: {
            const double* numericValue = std::get_if<double>(&value);
            if (!numericValue) return "tipo inválido: esperado number";
            if (schema.minValue && *numericValue < *schema.minValue) return "valor abaixo do mínimo";
            if (schema.maxValue && *numericValue > *schema.maxValue) return "valor acima do máximo";
            break;
        }
        case PropertyValueKind::Bool:
            if (!std::holds_alternative<bool>(value)) return "tipo inválido: esperado bool";
            break;
        case PropertyValueKind::Point:
            if (!std::holds_alternative<PropertyPoint>(value)) return "tipo inválido: esperado point";
            break;
        case PropertyValueKind::String:
        default:
            if (!std::holds_alternative<std::string>(value)) return "tipo inválido: esperado string";
            break;
    }

    if (!schema.options.empty()) {
        // Achado de revisão arquitetural 2026-07-20: esta checagem só aceitava PropertyValue::string
        // contra option.value, enquanto SimulationSession::setPropertyUnlocked (a via de edição em
        // runtime) já aceitava bool/number coagidos pra string -- a MESMA divergência criação-vs-edição
        // que o comentário desta função documenta ter corrigido em 2026-07-09 (D4), só que reaparecida
        // aqui especificamente pra propriedades com `options`. Unificado pra aceitar a mesma coerção
        // nos dois caminhos.
        const bool validOption = std::any_of(schema.options.begin(), schema.options.end(), [&](const PropertyOption& option) {
            if (const std::string* text = std::get_if<std::string>(&value)) return option.value == *text;
            if (const bool* flag = std::get_if<bool>(&value)) return option.value == (*flag ? "true" : "false");
            if (const double* number = std::get_if<double>(&value)) {
                try {
                    return std::abs(std::stod(option.value) - *number) <= 1e-12;
                } catch (const std::exception&) {
                    return false;
                }
            }
            return false;
        });
        if (!validOption) return "opção inválida";
    }
    return std::nullopt;
}

struct PropertyBindResult {
    bool applied = false;
    std::string error; // vazio quando applied == true
};

/** Acha um schema por id numa lista -- usado tanto por componentes migrados (o `properties()` de
 * uma classe casa get/set ao schema certo por NOME, nunca por índice -- ver `Probe` como exemplo)
 * quanto por fábricas em `CoreApplication.cpp` (junto com `propertyOrDefault` abaixo, pra ler
 * `ComponentParams` validado contra o schema certo por nome). Devolve um schema "vazio" (id/label
 * = id pedido) se não encontrado -- nunca deveria acontecer se `schemas` vier do `propertySchema()`
 * da própria classe. */
inline PropertySchema schemaById(const std::vector<PropertySchema>& schemas, const std::string& id) {
    for (const PropertySchema& schema : schemas) {
        if (schema.id == id) return schema;
    }
    return PropertySchema{id, id, {}, {}};
}

/**
 * Uma propriedade editável, declarada UMA vez: schema (metadado estático) + `get`/`set` num só
 * lugar -- substitui o par "static propertySchema() + propertyDescriptors() de instância" que
 * hoje se repete em cada built-in (Resistor/OpAmp/Rail/Probe/...), sempre reescrevendo o mesmo id
 * duas vezes sem vínculo verificado pelo compilador (D1/D2/D3 do relatório de auditoria
 * arquitetural 2026-07-09). `set` já valida (reaproveita `validatePropertyValue`), então tanto uma
 * fábrica na criação quanto `SimulationSession::setProperty` em runtime podem chamar o MESMO
 * caminho -- fecha D4 de vez, não só documenta.
 *
 * Migração é opt-in: uma classe que já tem `propertyDescriptors()`/`propertySchema()` funcionando
 * não precisa mudar pra usar `IComponentModel`; `properties()` é só uma forma nova, mais compacta,
 * de implementar a MESMA interface (ver `Resistor`/`Probe` como exemplo já migrado).
 */
struct PropertyDefinition {
    PropertySchema schema;
    std::function<PropertyValue()> get;
    std::function<PropertyBindResult(const PropertyValue&)> set;
};

/** Projeta `std::vector<PropertyDefinition>` (formato "de autoria", compacto) pro
 * `std::vector<PropertyDescriptor>` que `IComponentModel::propertyDescriptors()` precisa devolver
 * -- mecânico, nunca reescrito por classe. `PropertyDescriptor::set` ignora o resultado da
 * validação por compatibilidade de assinatura (`void(const PropertyValue&)`, herdada do contrato
 * já existente) -- quem quiser o motivo da rejeição chama `PropertyDefinition::set` direto (ver
 * `bindPropertyByName`, usado por `ComponentParams`-aware factories). */
inline std::vector<PropertyDescriptor> toPropertyDescriptors(std::vector<PropertyDefinition> definitions) {
    std::vector<PropertyDescriptor> descriptors;
    descriptors.reserve(definitions.size());
    for (PropertyDefinition& def : definitions) {
        PropertySchema schema = def.schema;
        descriptors.push_back(PropertyDescriptor{
            schema.id,
            schema.unit,
            def.get,
            [set = def.set](const PropertyValue& value) { set(value); },
            std::move(schema),
        });
    }
    return descriptors;
}

/** Acha a definição por id e aplica `value` através da MESMA validação de `set` -- usado por
 * fábricas de componente na criação (lendo de `ComponentParams::properties`), pra que um valor
 * salvo num projeto passe pela mesma regra que a edição em runtime já usa. Retorna
 * `applied == false` (com o valor default do schema preservado) se a propriedade não existir nesse
 * `typeId` ou o valor não validar -- nunca lança, mesmo espírito de `ComponentParams::property()`
 * hoje (cai no default em vez de abortar a criação inteira por um campo ruim). */
inline PropertyBindResult bindPropertyByName(const std::vector<PropertyDefinition>& definitions, const std::string& id,
                                              const PropertyValue& value) {
    for (const PropertyDefinition& def : definitions) {
        if (def.schema.id != id) continue;
        return def.set(value);
    }
    return PropertyBindResult{false, "propriedade desconhecida: " + id};
}

/** Lê `schema.id` de um mapa de propriedades bruto (`ComponentParams::properties`, vindo de um
 * `.lsproj` salvo ou de `addComponent` via IPC) validando contra `schema` -- cai no
 * `schema.defaultValue` tanto se a chave estiver ausente (comportamento de sempre) QUANTO se o
 * valor presente for inválido (tipo errado, fora de min/max, opção inexistente -- comportamento
 * NOVO: antes `ComponentParams::property()` também caía no default nesse caso, mas em silêncio
 * total, sem log nenhum -- é exatamente o padrão que já causou 2 bugs reais confirmados, ver
 * `PropertyDefinition` acima). Loga em stderr quando descarta um valor inválido, pra parar de ser
 * silencioso. Não lança -- criação de componente nunca deveria abortar por um campo salvo ruim. */
inline PropertyValue propertyOrDefault(const std::unordered_map<std::string, PropertyValue>& properties,
                                        const PropertySchema& schema) {
    const auto it = properties.find(schema.id);
    if (it == properties.end()) return schema.defaultValue;
    if (const std::optional<std::string> error = validatePropertyValue(schema, it->second)) {
        std::fprintf(stderr,
                      "[PropertyDefinition] valor salvo para '%s' é inválido (%s) -- usando default do schema "
                      "em vez de aceitar em silêncio.\n",
                      schema.id.c_str(), error->c_str());
        return schema.defaultValue;
    }
    return it->second;
}

} // namespace lasecsimul
