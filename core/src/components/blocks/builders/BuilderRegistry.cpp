#include <stdexcept>
#include <string>

#include "BuilderCommon.hpp"

namespace lasecsimul::components::blocks {

BlockBuilder findBuilder(std::string_view blockId) {
    static const builders::BuilderTable table = [] {
        builders::BuilderTable all;
        builders::registerSourceBuilders(all);
        builders::registerMathBuilders(all);
        builders::registerContinuousBuilders(all);
        builders::registerDiscreteBuilders(all);
        builders::registerDiscontinuityBuilders(all);
        builders::registerRoutingBuilders(all);
        builders::registerSinkBuilders(all);
        builders::registerUserDefinedBuilders(all);
        builders::registerPidBuilders(all);
        builders::registerLogicBuilders(all);
        builders::registerLookupBuilders(all);
        builders::registerAttributeBuilders(all);
        for (size_t i = 0; i < all.entries.size(); ++i)
            for (size_t j = i + 1; j < all.entries.size(); ++j)
                if (all.entries[i].first == all.entries[j].first)
                    throw std::logic_error("builder duplicado: " + all.entries[i].first);
        return all;
    }();
    for (const auto& [id, builder] : table.entries) if (id == blockId) return builder;
    return nullptr;
}

} // namespace lasecsimul::components::blocks
