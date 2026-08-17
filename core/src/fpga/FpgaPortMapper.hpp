#pragma once

#include <cstdint>
#include <optional>
#include <string>
#include <vector>

#include "lasecsimul/Types.hpp"

namespace lasecsimul::fpga {

/** Declaração de UMA porta da entity VHDL top-level -- vem de `LSDN_FPGA_PORT` (modo discover de
 * `lasecsimul_vpi`, ver Step 4) ou de uma declaração manual no `.lsproj` (fallback do MVP, ver
 * plano seção 13). `downto`/`to` importa só pra portas vetoriais (`width > 1`). */
struct PortSpec {
    std::string name;
    bool isInput = true; // MVP: `in`/`out` só -- `inout` não suportado (fora de escopo do plano, seção 39)
    uint32_t width = 1;
    /** true: declarado `(N-1 downto 0)` (índice mais alto primeiro); false: `(0 to N-1)`.
     * Irrelevante quando width==1. */
    bool downto = true;
    /** Limites VHDL reais, quando informados pela descoberta VPI ou pelo projeto. Ausentes mantêm
     * compatibilidade com projetos antigos e derivam `width-1 downto 0`/`0 to width-1`. */
    std::optional<int32_t> leftIndex;
    std::optional<int32_t> rightIndex;
};

/** Um bit elétrico concreto derivado de um `PortSpec` -- a unidade que `FpgaComponent` realmente
 * manipula (um `Pin` do Netlist por bit) e que a arena `fpga_arena_abi.h` transporta
 * (`portIndex`/`bitIndex`).
 *
 * Convenção de `bitIndex` (bate com `lasecsimul_vpi.c`, que preenche/lê BinStr posição-a-posição):
 * `bitIndex 0` = caractere MAIS À ESQUERDA do `vpiBinStrVal`, que por sua vez -- assumido a partir
 * da semântica padrão do LRM VHDL pra impressão textual de arrays (`to_string`/`image`: esquerda
 * pra direita na ordem de DECLARAÇÃO, não de valor numérico) -- corresponde ao índice mais à
 * ESQUERDA na declaração da porta: pra `(N-1 downto 0)` isso é o bit N-1 (MSB); pra `(0 to N-1)`
 * isso é o bit 0. Esta suposição não foi verificada empiricamente contra GHDL real com um vetor
 * `to` (só `downto`, no Step 4) -- ver memória de projeto
 * `project_lasecsimul_fpga_vhdl_ghdl_integration.md` antes de confiar nisto pra um projeto `to`
 * real. */
struct FpgaPinBit {
    std::string pinId; // "nome" pra width==1; "nome(N)" pra width>1, N = índice VHDL real do bit
    uint32_t portIndex = 0; // índice do PortSpec na lista original (mesma ordem = portIndex da arena)
    uint32_t bitIndex = 0; // posição no BinStr (ver comentário acima) -- 0-based, sempre width-1 no máximo
    bool isInput = true;
};

/** Traduz uma lista de `PortSpec` (na ordem de declaração da entity) pra uma lista plana de
 * `FpgaPinBit` -- uma entrada por bit elétrico, na MESMA ordem que os pinos devem aparecer no
 * componente (`IComponentModel::pins()`). Portas de largura 0 são tratadas como largura 1
 * (defensivo -- nunca gera zero pinos pra uma porta declarada). */
std::vector<FpgaPinBit> mapPorts(const std::vector<PortSpec>& ports);

/** Conta total de bits de entrada/saída -- usado pra dimensionar `GhdlArenaOpenOptions::
 * inputChangeCapacity`/`outputChangeCapacity` (ver fpga_arena_abi.h: a arena é dimensionada pela
 * contagem REAL de bits do componente, nunca um número arbitrário). */
uint32_t countInputBits(const std::vector<PortSpec>& ports);
uint32_t countOutputBits(const std::vector<PortSpec>& ports);

/** Parseia a saída do modo "discover" de `lasecsimul_vpi.c` (linhas
 * `LSDN_FPGA_PORT name=X direction=in|out width=N`, ver `runDiscoverMode()`) numa lista de
 * `PortSpec` -- mecanismo de "LasecSimul: Analyze VHDL" (plano, seção 13), reusa 100% da
 * infraestrutura de processo/VPI em vez de um parser VHDL próprio via regex.
 *
 * O VPI publica também `left`/`right`; o parser preserva direção e limites. Direções não
 * suportadas (`inout`/unknown) e erros explícitos do módulo são rejeitados, nunca convertidos
 * silenciosamente em saída. Ruído sem prefixo continua ignorado. */
std::vector<PortSpec> parseDiscoveredPorts(const std::string& vpiDiscoverOutput);

} // namespace lasecsimul::fpga
