#pragma once

#include <cstdint>
#include <limits>
#include <span>
#include <string_view>
#include <vector>

namespace lasecsimul::simulation::library {

/**
 * Kernel de bloco da biblioteca equivalente ao Simulink (`docs/66` §4) -- os mesmos papéis do
 * modelo de execução de uma S-function: `init`, `outputs`, `update`, `derivatives` e o instante do
 * próximo evento. Um kernel é um conjunto de funções livres sem estado próprio: TODO o estado vive
 * nos vetores do `SignalRuntime` (estados contínuos no vetor dinâmico, que o RK4 com duplicação de
 * passo já integra e cujo erro já entra no passo adaptativo; estados discretos/trabalho num vetor à
 * parte). Nada aloca depois do `bind()`.
 */

/** O que o compilador sabe da instância quando chama `configure` (frio). */
struct KernelConfig {
    std::span<const double> realParameters;
    std::span<const int64_t> intParameters;
    std::span<const uint16_t> inputWidths;
    uint16_t outputWidth = 1;
    /** Tempo de amostragem resolvido: 0 = contínuo; > 0 = período discreto (s). */
    double samplePeriod = 0.0;
};

/** Forma da instância, devolvida por `configure` (que valida e lança `std::invalid_argument`). */
struct KernelShape {
    uint32_t continuousStates = 0;
    /** Estados discretos E vetores de trabalho (históricos de atraso, sementes...). */
    uint32_t discreteStates = 0;
    /** Uma entrada por porta: 1 = a saída do MESMO instante depende dela (direct feedthrough). Só
     * essas arestas entram na ordenação/SCC, exatamente como no Simulink. */
    std::vector<uint8_t> feedthrough;
};

struct KernelContext {
    /** Instante do cálculo: em ns (comparações exatas de evento) e em segundos. */
    uint64_t tNs = 0;
    double t = 0.0;
    /** Instante do último passo MAIOR (= `tNs` quando `major`; início do passo nos estágios do
     * integrador). Uma descontinuidade com instante E só vale quando E <= `majorNs` -- regra do
     * Simulink: o modo de um bloco descontínuo só muda em passo maior. */
    uint64_t majorNs = 0;
    /** Período do bloco (s); 0 quando de tempo contínuo. */
    double ts = 0.0;
    /** `true` em instante de passo maior (ativação ou fim de passo aceito); `false` nos estágios do
     * integrador. Só com `major` o kernel pode alterar `x`/`d` em `outputs` (reset, limite). */
    bool major = true;
    const double* const* in = nullptr;
    const uint16_t* inWidth = nullptr;
    uint16_t inputCount = 0;
    double* out = nullptr;
    uint16_t outWidth = 1;
    /** Estados contínuos do estágio (`outputs`/`derivatives`) ou do passo aceito (`major`). */
    double* x = nullptr;
    /** Derivadas a preencher em `derivatives`. */
    double* dx = nullptr;
    double* d = nullptr;
    const double* rp = nullptr;
    uint32_t rpCount = 0;
    const int64_t* ip = nullptr;
    uint32_t ipCount = 0;

    double input(uint16_t port, uint16_t element = 0) const {
        return in[port][inWidth[port] == 1 ? 0 : element];
    }
};

inline constexpr uint64_t kNoBreakpoint = std::numeric_limits<uint64_t>::max();

struct KernelSpec {
    const char* id;
    KernelShape (*configure)(const KernelConfig&);
    void (*init)(KernelContext&);
    void (*outputs)(KernelContext&);
    void (*update)(KernelContext&);
    void (*derivatives)(KernelContext&);
    /** Próximo instante (ns, > `tNs`) que o passo precisa acertar; `kNoBreakpoint` se nenhum. */
    uint64_t (*nextBreakpoint)(const KernelContext&);
};

/** Busca por id (tabela estática montada a partir dos arquivos de família). */
const KernelSpec* findKernel(std::string_view id);
/** Todos os kernels registrados (testes de cobertura e de consistência com a especificação). */
std::span<const KernelSpec* const> allKernels();

/** Converte segundos (parâmetro de bloco) para ns com arredondamento, recusando negativos. */
uint64_t secondsToNs(double seconds);

} // namespace lasecsimul::simulation::library
