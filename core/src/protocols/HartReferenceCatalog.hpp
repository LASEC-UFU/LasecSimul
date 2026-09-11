#pragma once

#include "HartCommandProgram.hpp"
#include "HartEngine.hpp"

#include <string_view>
#include <vector>

namespace lasecsimul::protocols {

struct HartReferenceDeviceDefinition {
    std::string_view name;
    uint8_t pollingAddress;
    uint8_t manufacturerId;
    uint8_t deviceType;
    std::string_view uniqueId;
    std::string_view tag;
};

/** Cold-path catalog imported from process_simul's HART seed tables.
 * It contains the complete command/device mapping used by the reference app.
 * Response semantics are implemented separately and must be covered by golden vectors. */
class HartReferenceCatalog final {
public:
    static std::vector<HartCommandDescriptor> commandDescriptors();
    static std::vector<HartReferenceDeviceDefinition> deviceDefinitions();
    static HartDeviceProfile makeGenericProfile();
    static bool registerGenericProfile(HartProfileRegistry& registry);
    static std::vector<HartDevicePlan> makeDevicePlans(std::string_view bus = "hart-1");

    /** Semantic Hart Command DSL programs for the commands migrated off the
     * former central switch (FASE 19 proof gate: 0x00, 0x01, 0x03, 0x0B, 0x21).
     * See .spec/features/hart-device-engine.md "Anexo A" for the request/
     * response layout each program encodes. */
    static std::vector<HartCommandDefinition> commandProgramDefinitions();

    /** Compiles `commandProgramDefinitions()` and wires them into `engine` via
     * `HartEngine::setCommandProgramHook`. Returns false if any program fails
     * to compile (bound/validation error) -- the engine is left without a hook
     * in that case, matching "no partial/unsafe install". */
    static bool installCommandPrograms(HartEngine& engine);
};

} // namespace lasecsimul::protocols
