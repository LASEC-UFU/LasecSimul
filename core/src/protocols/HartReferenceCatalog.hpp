#pragma once

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
};

} // namespace lasecsimul::protocols
