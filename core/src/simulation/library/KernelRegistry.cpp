#include <cmath>
#include <stdexcept>
#include <string>
#include <vector>

#include "Kernel.hpp"
#include "kernels/Families.hpp"

namespace lasecsimul::simulation::library {
namespace {

const std::vector<const KernelSpec*>& table() {
    static const std::vector<const KernelSpec*> kernels = [] {
        std::vector<const KernelSpec*> all;
        for (auto family : {sourceKernels, mathKernels, continuousKernels, discreteKernels, discontinuityKernels, routingKernels, userDefinedKernels,
                              pidKernels, logicKernels, lookupKernels, attributeKernels})
            for (const KernelSpec* spec : family()) all.push_back(spec);
        for (size_t i = 0; i < all.size(); ++i)
            for (size_t j = i + 1; j < all.size(); ++j)
                if (std::string_view(all[i]->id) == all[j]->id)
                    throw std::logic_error(std::string("kernel duplicado: ") + all[i]->id);
        return all;
    }();
    return kernels;
}

} // namespace

const KernelSpec* findKernel(std::string_view id) {
    for (const KernelSpec* spec : table())
        if (id == spec->id) return spec;
    return nullptr;
}

std::span<const KernelSpec* const> allKernels() { return table(); }

uint64_t secondsToNs(double seconds) {
    if (!std::isfinite(seconds) || seconds < 0.0 || seconds > 1.8e10)
        throw std::invalid_argument("tempo invalido: " + std::to_string(seconds));
    return static_cast<uint64_t>(std::llround(seconds * 1e9));
}

} // namespace lasecsimul::simulation::library
