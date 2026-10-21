#pragma once

#include <span>

#include "../Kernel.hpp"

// Uma função por arquivo de família; `KernelRegistry.cpp` concatena todas numa tabela única.
namespace lasecsimul::simulation::library {
std::span<const KernelSpec* const> sourceKernels();
std::span<const KernelSpec* const> mathKernels();
std::span<const KernelSpec* const> continuousKernels();
std::span<const KernelSpec* const> discreteKernels();
std::span<const KernelSpec* const> discontinuityKernels();
std::span<const KernelSpec* const> routingKernels();
std::span<const KernelSpec* const> userDefinedKernels();
std::span<const KernelSpec* const> pidKernels();
std::span<const KernelSpec* const> logicKernels();
std::span<const KernelSpec* const> lookupKernels();
std::span<const KernelSpec* const> attributeKernels();
} // namespace lasecsimul::simulation::library
