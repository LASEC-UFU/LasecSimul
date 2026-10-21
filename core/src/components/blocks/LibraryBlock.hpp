#pragma once

#include <cstdint>
#include <cstring>
#include <optional>
#include <span>
#include <string>
#include <vector>

#include "BlockLibrary.hpp"
#include "lasecsimul/IComponentModel.hpp"
#include "registry/ComponentParams.hpp"
#include "simulation/SignalEngine.hpp"
#include "simulation/library/ParamExpr.hpp"

namespace lasecsimul::components::blocks {

/** Tempo de amostragem DECLARADO (antes da herança, docs/66 §4.1). */
struct DeclaredRate {
    enum class Kind { Inherited, Continuous, Constant, Discrete } kind = Kind::Inherited;
    uint64_t periodNs = 0;
    uint64_t offsetNs = 0;
};

/** Tudo que a sessão resolveu para a instância antes de compilar (larguras e taxa herdadas). */
struct BlockResolution {
    std::vector<uint16_t> inputWidths;
    simulation::SignalRate rate;
    const simulation::library::ParamWorkspace* workspace = nullptr;
    /** Passo máximo do integrador (dimensiona históricos de atraso). */
    uint64_t maxStepNs = 100'000;
};

class LibraryBlock;

/** Contexto de um builder: lê parâmetros avaliados e emite blocos `Kernel` no grafo. */
struct BuildContext {
    const LibraryBlock& block;
    const BlockSpec& spec;
    const PropertyMap& props;
    const BlockResolution& resolution;
    uint32_t componentIndex = 0;
    std::vector<std::string> inputPorts;
    std::vector<std::string> outputPorts;
    /** Só calcular as larguras de saída (propagação de larguras), sem montar o grafo. */
    bool widthsOnly = false;
    std::vector<uint16_t> outputWidths;
    simulation::SignalGraphDefinition graph;

    simulation::library::ParamValue value(std::string_view name) const;
    double scalar(std::string_view name) const;
    std::vector<double> vector(std::string_view name) const;
    std::string text(std::string_view name) const;
    bool flag(std::string_view name) const;
    uint16_t inputWidth(size_t port) const { return port < resolution.inputWidths.size() ? resolution.inputWidths[port] : 1; }
    std::string inputBlock(size_t port) const;
    std::string outputBlock(size_t port) const;

    /** Emite um kernel. `id` vazio = id da porta de saída 1. */
    simulation::SignalBlockDefinition& kernel(std::string id, std::string kernelId, std::vector<uint16_t> inputWidths,
                                              uint16_t outWidth, std::vector<double> rp = {}, std::vector<int64_t> ip = {});
    void connect(const std::string& from, const std::string& to, int targetPort);
    /** Liga as portas de entrada da instância (relays) às entradas `in1..` do kernel `to`. */
    void connectInputs(const std::string& to, size_t firstInput = 0, size_t count = SIZE_MAX);
    [[noreturn]] void fail(const std::string& message) const;
};

using BlockBuilder = void (*)(BuildContext&);
BlockBuilder findBuilder(std::string_view blockId);

/**
 * Bloco da biblioteca equivalente ao Simulink publicado como componente (`sl.*`). Mesmo contrato de
 * materialização do `SignalMathBlock`: sem pinos elétricos; cada porta de entrada vira um relay
 * (Probe/ExternalInput, ou kernel de passagem quando de tempo contínuo); as portas de saída são
 * publicadas pelos próprios kernels emitidos pelo builder do bloco.
 */
class LibraryBlock final : public IComponentModel {
public:
    LibraryBlock(const BlockSpec& spec, const registry::ComponentParams& params);

    const char* typeId() const override { return m_spec.typeId.c_str(); }
    std::span<Pin> pins() override { return {}; }
    void stamp(MnaMatrixView&) override {}
    void postStep(uint64_t) override {}

    const BlockSpec& spec() const { return m_spec; }
    const PropertyMap& properties() const { return m_properties; }
    std::vector<std::string> inputPortIds() const { return resolvePorts(m_spec.inputs, m_properties); }
    std::vector<std::string> outputPortIds() const { return resolvePorts(m_spec.outputs, m_properties); }

    std::vector<SignalPortDescriptor> signalPorts() const override;
    std::vector<PropertyDescriptor> propertyDescriptors() override;
    static std::vector<PropertySchema> propertySchema(const BlockSpec& spec);

    DeclaredRate declaredRate(const simulation::library::ParamWorkspace* workspace) const;
    /** Larguras de saída para as larguras de entrada dadas (propagação na sessão). */
    std::vector<uint16_t> outputWidths(const BlockResolution& resolution, uint32_t componentIndex) const;
    simulation::SignalGraphDefinition computeGraph(uint32_t componentIndex, const BlockResolution& resolution) const;
    /** Porta cujo valor é a leitura escalar do bloco (saída 1, ou entrada 1 num sink). */
    std::string readoutPort() const;

    void setLastOutput(double value) { m_lastOutput = value; }
    static ReadoutFormat readoutFormat();
    size_t getState(uint8_t* buffer, size_t capacity) const override {
        if (!buffer || capacity < sizeof(double)) return 0;
        std::memcpy(buffer, &m_lastOutput, sizeof(double));
        return sizeof(double);
    }
    void setState(const uint8_t* buffer, size_t size) override {
        if (buffer && size >= sizeof(double)) std::memcpy(&m_lastOutput, buffer, sizeof(double));
    }

private:
    const BlockSpec& m_spec;
    PropertyMap m_properties;
    double m_lastOutput = 0.0;
};

} // namespace lasecsimul::components::blocks
