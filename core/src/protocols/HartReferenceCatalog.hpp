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
    static HartDeviceProfile makeProfile(const HartReferenceDeviceDefinition& definition);

    /** Concrete SMAR field-device profiles (FEAT: HART concrete devices). Device Type/Manufacturer
     * ID are the real HCF-assigned codes (cross-checked against josuemoraisgh/process_simul's
     * hart_types_template.dart, which itself mirrors the original Python hrt_enum.py seed table:
     * table 1 "Device Type Codes" 01=LD301/02=TT301/03=FY301, table 8 "Manufacturer Identification
     * Codes" 3E=Smar -- the SAME 0x3E already used by every generic profile above). Primary
     * variable unit codes are the real HCF Common Table 2 codes (0x20=Celsius, 0x0C=kilopascals,
     * 0x39=percent). Range values are labeled example defaults (user-editable afterwards via the
     * existing Command 23/1408 write path) since the real factory-calibrated span depends on the
     * ordered sensor cell/probe option, which this catalog cannot know -- never fabricated as if
     * they were a fixed spec value. */
    static HartDeviceProfile makeSmarLd301Profile();
    static HartDeviceProfile makeSmarTt301Profile();
    static HartDeviceProfile makeSmarFy301Profile();

    static bool registerProfiles(HartProfileRegistry& registry);
    static bool registerGenericProfile(HartProfileRegistry& registry);
    static std::vector<HartDevicePlan> makeDevicePlans(std::string_view bus = "hart-1");

    /** Semantic Hart Command DSL programs for every Universal command with a
     * real, spec-corroborated production body: 0x00/0x01/0x03/0x0B/0x21
     * (FASE 19 proof gate) plus 0x0C/0x0D/0x10/0x11/0x12/0x13 (Message,
     * Tag/Descriptor/Date, Final Assembly Number -- Anexo F). Every entry
     * here is StandardCore per HartCommandClassification.hpp: all eleven ids
     * classify as Universal, so HartCommandJson already refuses to let a
     * manufacturer command shadow any of them. See
     * .spec/features/hart-device-engine.md "Anexo A"/"Anexo F" for the
     * request/response layout each program encodes. */
    static std::vector<HartCommandDefinition> commandProgramDefinitions();

    /** Compiles `commandProgramDefinitions()` and wires them into `engine` via
     * `HartEngine::setCommandProgramHook`. Returns false if any program fails
     * to compile (bound/validation error) -- the engine is left without a hook
     * in that case, matching "no partial/unsafe install". */
    static bool installCommandPrograms(HartEngine& engine);

    struct InstallResult { bool success = false; std::string error; };

    /** Same as `installCommandPrograms(engine)`, plus `additional` (typically
     * Property Inspector-authored, parsed via `HartCommandJson`): every entry
     * is compiled and merged into the SAME hook as the 5 built-ins. All-or-
     * nothing for `additional` -- if any one fails to compile, none of
     * `additional` is installed (the built-ins still are, so a broken custom
     * edit never takes down the standard commands), and `.error` names the
     * failing command so the Property Inspector can surface it. */
    static InstallResult installCommandPrograms(HartEngine& engine, std::vector<HartCommandDefinition> additional);
};

} // namespace lasecsimul::protocols
