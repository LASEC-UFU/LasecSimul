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
     * shape from the previous iteration). */
    static ParseResult parseCommandDefinition(const nlohmann::json& value);

    struct CollectionParseResult {
        bool success = false;
        std::string error;
        std::vector<HartCommandDefinition> definitions;
    };

    /** A JSON array of command objects. Rejects duplicate command ids and any
     * id already owned by the reference catalog's built-in commands (0x00,
     * 0x01, 0x03, 0x0B, 0x21) -- a custom command may not silently shadow a
     * standard one (HART-FR-007 tombstone spirit: explicit, not accidental). */
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
