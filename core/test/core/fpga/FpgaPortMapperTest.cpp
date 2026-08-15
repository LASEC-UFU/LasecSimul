// Passo 5 do plano FPGA/VHDL (golden-puzzling-quasar.md): FpgaPortMapper isolado, sem GHDL/arena.
#include "fpga/FpgaPortMapper.hpp"
#include <cstdio>
#include <stdexcept>
#include <string>

using namespace lasecsimul::fpga;

namespace {

int failures = 0;
#define CHECK(expr, msg) \
    do { \
        if (!(expr)) { \
            std::fprintf(stderr, "  FALHOU: %s -- %s\n", msg, #expr); \
            failures++; \
        } else { \
            std::fprintf(stderr, "  OK: %s\n", msg); \
        } \
    } while (false)

void testScalarPortsMapOneToOne() {
    const std::vector<PortSpec> ports = {
        PortSpec{"clk", true, 1, true},
        PortSpec{"sw0", true, 1, true},
        PortSpec{"led0", false, 1, true},
    };
    const std::vector<FpgaPinBit> bits = mapPorts(ports);
    CHECK(bits.size() == 3, "3 portas escalares viram 3 bits");
    CHECK(bits[0].pinId == "clk" && bits[0].portIndex == 0 && bits[0].bitIndex == 0 && bits[0].isInput, "clk mapeado corretamente");
    CHECK(bits[1].pinId == "sw0" && bits[1].portIndex == 1, "sw0 mapeado corretamente");
    CHECK(bits[2].pinId == "led0" && bits[2].portIndex == 2 && !bits[2].isInput, "led0 mapeado como saida");
}

void testDowntoVectorOrdersMsbFirst() {
    const std::vector<PortSpec> ports = {PortSpec{"sw", true, 4, true}}; // sw(3 downto 0)
    const std::vector<FpgaPinBit> bits = mapPorts(ports);
    CHECK(bits.size() == 4, "vetor de 4 bits gera 4 entradas");
    CHECK(bits[0].pinId == "sw(3)" && bits[0].bitIndex == 0, "bitIndex 0 = sw(3), MSB primeiro (downto)");
    CHECK(bits[1].pinId == "sw(2)" && bits[1].bitIndex == 1, "bitIndex 1 = sw(2)");
    CHECK(bits[2].pinId == "sw(1)" && bits[2].bitIndex == 2, "bitIndex 2 = sw(1)");
    CHECK(bits[3].pinId == "sw(0)" && bits[3].bitIndex == 3, "bitIndex 3 = sw(0), LSB por ultimo");
    for (const FpgaPinBit& bit : bits) CHECK(bit.portIndex == 0, "todos os bits do vetor compartilham portIndex 0");
}

void testToVectorOrdersLowIndexFirst() {
    const std::vector<PortSpec> ports = {PortSpec{"data", false, 3, false}}; // data(0 to 2)
    const std::vector<FpgaPinBit> bits = mapPorts(ports);
    CHECK(bits.size() == 3, "vetor 'to' de 3 bits gera 3 entradas");
    CHECK(bits[0].pinId == "data(0)" && bits[0].bitIndex == 0, "bitIndex 0 = data(0) pra declaracao 'to'");
    CHECK(bits[1].pinId == "data(1)" && bits[1].bitIndex == 1, "bitIndex 1 = data(1)");
    CHECK(bits[2].pinId == "data(2)" && bits[2].bitIndex == 2, "bitIndex 2 = data(2)");
}

void testMixedScalarAndVectorPorts() {
    const std::vector<PortSpec> ports = {
        PortSpec{"clk", true, 1, true},
        PortSpec{"sw", true, 4, true},
        PortSpec{"led", false, 8, true},
    };
    const std::vector<FpgaPinBit> bits = mapPorts(ports);
    CHECK(bits.size() == 1 + 4 + 8, "1 escalar + vetor 4 + vetor 8 = 13 bits totais");
    CHECK(bits[0].portIndex == 0, "clk e portIndex 0");
    CHECK(bits[1].portIndex == 1 && bits[4].portIndex == 1, "os 4 bits de sw compartilham portIndex 1");
    CHECK(bits[5].portIndex == 2 && bits[12].portIndex == 2, "os 8 bits de led compartilham portIndex 2");
}

void testZeroWidthTreatedAsOne() {
    const std::vector<PortSpec> ports = {PortSpec{"weird", true, 0, true}};
    const std::vector<FpgaPinBit> bits = mapPorts(ports);
    CHECK(bits.size() == 1, "largura 0 (declaracao invalida/defensivo) vira 1 pino, nunca zero");
    CHECK(bits[0].pinId == "weird", "porta de largura 0 vira pino escalar simples");
}

void testCountInputOutputBits() {
    const std::vector<PortSpec> ports = {
        PortSpec{"clk", true, 1, true},
        PortSpec{"sw", true, 4, true},
        PortSpec{"led", false, 8, true},
        PortSpec{"bus_out", false, 4, false},
    };
    CHECK(countInputBits(ports) == 5, "clk(1)+sw(4) = 5 bits de entrada");
    CHECK(countOutputBits(ports) == 12, "led(8)+bus_out(4) = 12 bits de saida");
}

void testParseDiscoveredPortsMatchesRealVpiOutputFormat() {
    // Formato EXATO produzido por lasecsimul_vpi.c::runDiscoverMode (ver
    // "LSDN_FPGA_PORT name=%s direction=%s width=%d\n") -- inclui ruido tipico do stdout do GHDL
    // (linhas "loading VPI module..."/"VPI module loaded!") misturado, igual a uma captura real.
    const std::string output =
        "loading VPI module 'lasecsimul_vpi.dll'\n"
        "VPI module loaded!\n"
        "LSDN_FPGA_PORT name=clk direction=in width=1\n"
        "LSDN_FPGA_PORT name=sw direction=in width=4\n"
        "LSDN_FPGA_PORT name=led direction=out width=8\n"
        "LSDN_FPGA_PORTS_DONE\n";
    const std::vector<PortSpec> ports = parseDiscoveredPorts(output);
    CHECK(ports.size() == 3, "3 linhas LSDN_FPGA_PORT viram 3 PortSpec, ruido ignorado");
    CHECK(ports[0].name == "clk" && ports[0].isInput && ports[0].width == 1, "clk parseado corretamente");
    CHECK(ports[1].name == "sw" && ports[1].isInput && ports[1].width == 4, "sw parseado corretamente");
    CHECK(ports[2].name == "led" && !ports[2].isInput && ports[2].width == 8, "led parseado corretamente");
    for (const PortSpec& port : ports) CHECK(port.downto, "descoberta automatica sempre assume downto (ver header)");
}

void testParseDiscoveredPortsHandlesCrlfAndEmptyInput() {
    const std::vector<PortSpec> crlf = parseDiscoveredPorts("LSDN_FPGA_PORT name=a direction=in width=1\r\n");
    CHECK(crlf.size() == 1 && crlf[0].name == "a", "CRLF (pipe do Windows) nao quebra o parser");
    CHECK(parseDiscoveredPorts("").empty(), "entrada vazia nao lanca, devolve lista vazia");
    CHECK(parseDiscoveredPorts("apenas ruido sem prefixo\n").empty(), "linha sem o prefixo e ignorada");
}

} // namespace

int main() {
    std::fprintf(stderr, "=== FpgaPortMapperTest ===\n");
    testScalarPortsMapOneToOne();
    testDowntoVectorOrdersMsbFirst();
    testToVectorOrdersLowIndexFirst();
    testMixedScalarAndVectorPorts();
    testZeroWidthTreatedAsOne();
    testCountInputOutputBits();
    testParseDiscoveredPortsMatchesRealVpiOutputFormat();
    testParseDiscoveredPortsHandlesCrlfAndEmptyInput();

    if (failures == 0) {
        std::fprintf(stderr, "\nTodos os testes passaram.\n");
        return 0;
    }
    std::fprintf(stderr, "\n%d teste(s) FALHARAM.\n", failures);
    return 1;
}
