#pragma once

#include <algorithm>
#include <cmath>
#include <string>
#include <vector>

#include "../LibraryBlock.hpp"
#include "simulation/library/Kernel.hpp"

namespace lasecsimul::components::blocks::builders {

namespace lib = simulation::library;

/** Largura de saída de uma operação elemento a elemento: a maior entre as entradas e os parâmetros
 * vetoriais (expansão escalar do Simulink). */
inline uint16_t elementwiseWidth(const BuildContext& c, std::initializer_list<size_t> parameterSizes = {}) {
    size_t width = 1;
    for (size_t port = 0; port < c.inputPorts.size(); ++port) width = std::max<size_t>(width, c.inputWidth(port));
    for (size_t size : parameterSizes) width = std::max(width, size);
    if (width > 4096) c.fail("largura de sinal grande demais");
    return static_cast<uint16_t>(width);
}

inline std::vector<uint16_t> inputWidths(const BuildContext& c) {
    std::vector<uint16_t> widths;
    for (size_t port = 0; port < c.inputPorts.size(); ++port) widths.push_back(c.inputWidth(port));
    return widths;
}

/** Repete `values` até `width` (escalar expande; vetor precisa ter a largura). */
inline std::vector<double> expandTo(const BuildContext& c, std::vector<double> values, size_t width, const char* what) {
    if (values.size() == width) return values;
    if (values.size() == 1) return std::vector<double>(width, values[0]);
    c.fail(std::string(what) + ": largura " + std::to_string(values.size()) + " incompativel com " + std::to_string(width));
}

/** Um único kernel elemento a elemento alimentado por todas as entradas, publicando a saída 1. */
inline void simpleKernel(BuildContext& c, const char* kernelId, uint16_t width, std::vector<double> rp = {}, std::vector<int64_t> ip = {}) {
    c.outputWidths = {width};
    if (c.widthsOnly) return;
    c.kernel("", kernelId, inputWidths(c), width, std::move(rp), std::move(ip));
    c.connectInputs(c.outputBlock(0));
}

inline int64_t nanoseconds(const BuildContext& c, double seconds, const char* what) {
    try {
        return static_cast<int64_t>(lib::secondsToNs(seconds));
    } catch (const std::exception&) {
        c.fail(std::string(what) + " precisa ser um tempo >= 0");
    }
}

/** Polinômio (potências decrescentes) -> realização canônica controlável (como `tf2ss` do MATLAB).
 * Devolve A (n x n), B (n x 1), C (rows x n), D (rows x 1) em ordem de linha. `numerators` tem uma
 * linha por saída (Transfer Fcn SIMO). Lança se impróprio ou denominador inválido. */
struct Realization { size_t n = 0, outputs = 1; std::vector<double> a, b, c, d; };
Realization controllableCanonical(const BuildContext& c, const std::vector<std::vector<double>>& numerators, std::vector<double> denominator);

/** Kernel com várias saídas: vetor concatenado `<saída1>::v` e um Slice por porta de saída. */
void emitWithSlices(BuildContext& c, const char* kernelId, std::vector<uint16_t> inputs, std::vector<uint16_t> portWidths,
                    std::vector<double> rp, std::vector<int64_t> ip);
/** Modo de reset externo (texto do diálogo) -> código de `ResetMode`. */
int64_t resetMode(const std::string& mode);
/** A, B, C, D (+ InitialCondition) -> kernel `state_space` ou `discrete_state_space`. */
void buildStateSpaceKernel(BuildContext& c, const char* kernelId);
/** Realização + estado inicial -> kernel de espaço de estados (entrada escalar). */
void emitRealization(BuildContext& c, const Realization& r, const char* kernelId, const std::vector<double>& x0);
/** Numerador como matriz: uma linha por saída. */
std::vector<std::vector<double>> numeratorRows(const lib::ParamValue& numerator);
/** Coeficientes (potências decrescentes) do polinômio com as raízes reais dadas. */
std::vector<double> polyFromRoots(const std::vector<double>& roots);

/** Tabela id do bloco -> builder; um registrador por arquivo de biblioteca. */
struct BuilderTable {
    std::vector<std::pair<std::string, BlockBuilder>> entries;
    void add(const char* id, BlockBuilder builder) { entries.emplace_back(id, builder); }
};
void registerSourceBuilders(BuilderTable& table);
void registerMathBuilders(BuilderTable& table);
void registerContinuousBuilders(BuilderTable& table);
void registerDiscreteBuilders(BuilderTable& table);
void registerDiscontinuityBuilders(BuilderTable& table);
void registerRoutingBuilders(BuilderTable& table);
void registerSinkBuilders(BuilderTable& table);
void registerUserDefinedBuilders(BuilderTable& table);
void registerPidBuilders(BuilderTable& table);
void registerLogicBuilders(BuilderTable& table);
void registerLookupBuilders(BuilderTable& table);
void registerAttributeBuilders(BuilderTable& table);

} // namespace lasecsimul::components::blocks::builders
