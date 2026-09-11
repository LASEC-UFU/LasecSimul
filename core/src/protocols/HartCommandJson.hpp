#pragma once

#include "HartCommandProgram.hpp"

#include <nlohmann/json.hpp>

#include <string>
#include <vector>

namespace lasecsimul::protocols {

/** Authoring-side JSON <-> semantic DSL bridge for the Property Inspector's
 * Commands editor (FEAT-013 Property Inspector). The semantic authoring
 * definition is the persistence authority (section 67 of the Property
 * Inspector contract); this is the (de)serializer for it, not a second
 * compiled representation.
 *
 * Scope of this iteration: a FLAT response-step subset (Hex Constant,
 * built-in Variable reference, Request Body, Body Slice appended in order) --
 * enough to author real read-only commands (matching the shape of the
 * already-migrated 0x00/0x01/0x03) end-to-end through the UI. `write`/`after`
 * stages and the control-flow primitives (`If`, `Map`, `ForCodes`) are not
 * yet exposed to JSON authoring; they remain C++-only
 * (`HartReferenceCatalog::commandProgramDefinitions()`). This is a documented
 * scope boundary, not a silent omission -- see
 * .spec/features/hart-device-engine.md "Anexo B". */
class HartCommandJson final {
public:
    struct ParseResult {
        bool success = false;
        std::string error;
        HartCommandDefinition definition;
    };

    /** One command object: `{id, name, enabled, responseSteps:[...]}`. */
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
