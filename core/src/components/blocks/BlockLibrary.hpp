#pragma once

#include <optional>
#include <string>
#include <string_view>
#include <unordered_map>
#include <utility>
#include <vector>

#include <nlohmann/json.hpp>

#include "lasecsimul/Types.hpp"

/**
 * Especificação declarativa da biblioteca de blocos equivalente ao Simulink (docs/66 §3), lida de
 * `project/schema/block-library/*.json` embutido no executável. É a MESMA especificação que a
 * Extension usa para paleta, inspetor, pinos e ícones; as regras de porta têm duas implementações
 * (aqui e em `extension/src/blockLibrary/`) verificadas uma contra a outra por teste.
 */
namespace lasecsimul::components::blocks {

using PropertyMap = std::unordered_map<std::string, PropertyValue>;

enum class ParamType { Expr, Enum, Bool, String };

struct ParamSpec {
    std::string name;
    ParamType type = ParamType::Expr;
    PropertyValue defaultValue;
    std::vector<std::string> options;
    std::string group;
    /** Visível quando TODAS as condições valem (parâmetro -> valores aceitos). */
    std::vector<std::pair<std::string, std::vector<nlohmann::json>>> visibleWhen;
    bool tunable = false;
    std::string titleEn;
    std::string titlePt;
};

struct PortRule {
    std::string id;
    std::string label;
    std::vector<std::pair<std::string, std::vector<nlohmann::json>>> when;
    /** `repeat`: N portas `prefix<start..>` com N vindo de `param` pela regra `rule`. */
    bool repeat = false;
    std::string param;
    std::string rule;
    std::string prefix;
    int start = 1;
};

enum class SampleTimeKind { Param, Continuous, Inherited, Constant };

struct BlockSpec {
    std::string id;
    std::string typeId;
    std::string library;
    std::string name;
    std::string titlePt;
    std::string doc;
    SampleTimeKind sampleTime = SampleTimeKind::Inherited;
    std::string sampleTimeParam;
    std::vector<ParamSpec> params;
    std::vector<PortRule> inputs;
    std::vector<PortRule> outputs;

    const ParamSpec* param(std::string_view name) const;
};

/** Todos os blocos (ordem dos arquivos/blocos na especificação). */
const std::vector<BlockSpec>& blockLibrary();
const BlockSpec* findBlockSpec(std::string_view typeId);
bool isLibraryTypeId(std::string_view typeId);

/** Propriedades da instância completadas com os padrões da especificação. */
PropertyMap withDefaults(const BlockSpec& spec, const PropertyMap& properties);

/** Uma condição `when`/`visibleWhen` vale para estas propriedades. */
bool conditionsHold(const std::vector<std::pair<std::string, std::vector<nlohmann::json>>>& conditions,
                    const PropertyMap& properties);

/** Ids das portas habilitadas, na ordem do Simulink (é a numeração 1..N de `in:N`/`out:N`). */
std::vector<std::string> resolvePorts(const std::vector<PortRule>& rules, const PropertyMap& properties);

/** Quantidade pela regra de repetição: `signs` (+/- do Sum, `|` ignorado; número = N entradas),
 * `ops` (`*`/`/` do Product; número = N), `count` (inteiro) e `vectorLength` (escalar = N, vetor =
 * quantidade de elementos -- Mux `[2 3]`). */
size_t repeatCount(const std::string& rule, const PropertyValue& value);

/** Texto do valor como o inspetor o guarda (número vira "%g"). */
std::string propertyText(const PropertyValue& value);

} // namespace lasecsimul::components::blocks
