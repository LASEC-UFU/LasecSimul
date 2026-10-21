#pragma once

#include <algorithm>
#include <cmath>
#include <cstdint>
#include <span>
#include <stdexcept>
#include <string>
#include <vector>

#include "Kernel.hpp"

/**
 * Utilitários compartilhados pelos arquivos de família de kernels. Convenções:
 *  - `realParameters` é o vetor plano montado pelo componente (`LibraryBlock`) na ordem que o
 *    kernel documenta no próprio arquivo; `intParameters` carrega modos/enumerações/tamanhos;
 *  - entrada de largura 1 expande para a largura da saída (expansão escalar do Simulink);
 *  - `fail` produz a mensagem padronizada que o inspetor mostra.
 */
namespace lasecsimul::simulation::library::detail {

[[noreturn]] inline void fail(const std::string& message) { throw std::invalid_argument(message); }

inline void requireInputs(const KernelConfig& config, size_t count, const char* block) {
    if (config.inputWidths.size() != count)
        fail(std::string(block) + ": esperado " + std::to_string(count) + " entrada(s), recebido " +
             std::to_string(config.inputWidths.size()));
}

/** Toda entrada precisa ser escalar ou ter a largura da saída. */
inline void requireExpandable(const KernelConfig& config, const char* block) {
    for (uint16_t width : config.inputWidths)
        if (width != 1 && width != config.outputWidth)
            fail(std::string(block) + ": largura de entrada " + std::to_string(width) + " incompativel com a saida " +
                 std::to_string(config.outputWidth));
}

inline void requireParams(const KernelConfig& config, size_t count, const char* block) {
    if (config.realParameters.size() < count) fail(std::string(block) + ": parametros insuficientes");
}

inline std::vector<uint8_t> allFeedthrough(size_t inputs, uint8_t value = 1) { return std::vector<uint8_t>(inputs, value); }

/** Parâmetro vetorial com expansão escalar: `values[i]` ou o único valor. */
inline double expanded(std::span<const double> values, size_t element) {
    return values.size() == 1 ? values[0] : values[element];
}

inline double sgn(double x) { return x > 0.0 ? 1.0 : x < 0.0 ? -1.0 : 0.0; }

} // namespace lasecsimul::simulation::library::detail
