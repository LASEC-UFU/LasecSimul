#pragma once

#include "HartCommandProgram.hpp"

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

namespace lasecsimul::protocols {

/** Authoring-side JSON <-> semantic DSL bridge for HART command definitions.
 * The semantic authoring definition is the persistence authority (section 67
 * of the Property Inspector contract); this is the (de)serializer for it,
 * not a second compiled representation.
 *
 * Covers the FULL `HartStatement`/`HartExpr` vocabulary: `write`/`resp`/
 * `after` stages, `Set`, `If`/EQ, `Map`, `ForCodes`, and expression nodes
 * (Hex Constant, built-in Variable, user-variable-by-id, Request Body, Body
 * Slice, `$code`). This is the JSON the Lasec HART Command DSL parser
 * (`extension/src/dsl/HartCommandDsl.ts`) lowers to -- it is a compiler
 * target, not something a human is expected to hand-write (see
 * .spec/features/hart-device-engine.md "Anexo D"). */
class HartCommandJson final {
public:
    struct ParseResult {
        bool success = false;
        std::string error;
        HartCommandDefinition definition;
    };

    /** One command object: `{id, name, enabled, writeSteps:[...],
     * responseSteps:[...], afterSteps:[...]}`. `writeSteps`/`afterSteps`
     * default to empty when absent (back-compat with the flat-`resp`-only
     * shape from the previous iteration).
     *
     * `consumedDeviceSpecificCount` is the number of OTHER manufacturer
     * commands already declared in the same collection whose id falls in
     * the Device-Specific range (128-253) -- it gates the Additional
     * Device-Specific range (64768-65021) via the normative >90% rule (see
     * `isDeviceSpecificRangeOver90PercentConsumed`). Callers validating a
     * single definition in isolation (e.g. a unit test) may leave it at the
     * default of 0, which conservatively rejects that range. */
    static ParseResult parseCommandDefinition(const nlohmann::json& value, uint32_t consumedDeviceSpecificCount = 0);

    struct CollectionParseResult {
        bool success = false;
        std::string error;
        std::vector<HartCommandDefinition> definitions;
    };

    /** A JSON array of command objects. Rejects duplicate command ids and any
     * id whose HCF_SPEC-99 Table 9 class is not manufacturer-authorable (see
     * `HartCommandClassification.hpp`): Universal / Common Practice /
     * Additional Common Practice / WirelessHART / Device Family commands are
     * HART-standardized and may never be redefined by a manufacturer body;
     * Reserved ranges accept no definition at all; Non-Public (122-126) is
     * rejected because this build has no factory-authoring mode; Wireless
     * Device-Specific (64512-64765) is rejected because this build has no
     * WirelessHART device-capability model. Only Device-Specific (128-253),
     * and Additional Device-Specific once 128-253 is >90% consumed, may be
     * authored. */
    static CollectionParseResult parseCommandCollection(const std::string& json);

    /** Round-trips a definition built from this subset back to JSON, so the
     * UI can re-render what it just sent without re-deriving field names by
     * hand. Definitions containing a node outside this subset (parsed from
     * hand-authored C++ or a future UI version) serialize their response as
     * an empty step list with `"unsupported": true` rather than crash or
     * silently drop data the caller didn't ask to lose. */
    static nlohmann::json toJson(const HartCommandDefinition& definition);
};

} // namespace lasecsimul::protocols
