#include "FpgaPortMapper.hpp"

#include <sstream>

namespace lasecsimul::fpga {

std::vector<FpgaPinBit> mapPorts(const std::vector<PortSpec>& ports) {
    std::vector<FpgaPinBit> result;
    for (uint32_t portIndex = 0; portIndex < ports.size(); ++portIndex) {
        const PortSpec& port = ports[portIndex];
        const uint32_t width = port.width == 0 ? 1 : port.width;

        if (width == 1) {
            result.push_back(FpgaPinBit{port.name, portIndex, 0, port.isInput});
            continue;
        }

        // bitIndex 0 = posição mais à esquerda do BinStr = índice VHDL mais à esquerda na
        // declaração (ver comentário de FpgaPinBit::bitIndex). Pra "(N-1 downto 0)" isso desce de
        // N-1 até 0; pra "(0 to N-1)" isso sobe de 0 até N-1 -- em ambos os casos, `bitIndex`
        // simplesmente conta 0..width-1 na ordem de geração, e `vhdlIndex` é o número real que
        // aparece no id do pino.
        for (uint32_t bitIndex = 0; bitIndex < width; ++bitIndex) {
            const uint32_t vhdlIndex = port.downto ? (width - 1 - bitIndex) : bitIndex;
            result.push_back(
                FpgaPinBit{port.name + "(" + std::to_string(vhdlIndex) + ")", portIndex, bitIndex, port.isInput});
        }
    }
    return result;
}

uint32_t countInputBits(const std::vector<PortSpec>& ports) {
    uint32_t total = 0;
    for (const PortSpec& port : ports) {
        if (port.isInput) total += port.width == 0 ? 1 : port.width;
    }
    return total;
}

uint32_t countOutputBits(const std::vector<PortSpec>& ports) {
    uint32_t total = 0;
    for (const PortSpec& port : ports) {
        if (!port.isInput) total += port.width == 0 ? 1 : port.width;
    }
    return total;
}

std::vector<PortSpec> parseDiscoveredPorts(const std::string& vpiDiscoverOutput) {
    static const std::string kPrefix = "LSDN_FPGA_PORT ";
    std::vector<PortSpec> ports;
    std::istringstream lines(vpiDiscoverOutput);
    std::string line;
    while (std::getline(lines, line)) {
        if (!line.empty() && line.back() == '\r') line.pop_back(); // CRLF do pipe do Windows
        if (line.compare(0, kPrefix.size(), kPrefix) != 0) continue;

        PortSpec spec;
        spec.downto = true; // ver comentário do header -- discover não relata downto/to
        std::istringstream fields(line.substr(kPrefix.size()));
        std::string token;
        while (fields >> token) {
            const size_t eq = token.find('=');
            if (eq == std::string::npos) continue;
            const std::string key = token.substr(0, eq);
            const std::string value = token.substr(eq + 1);
            if (key == "name") {
                spec.name = value;
            } else if (key == "direction") {
                spec.isInput = (value == "in");
            } else if (key == "width") {
                try {
                    spec.width = static_cast<uint32_t>(std::stoul(value));
                } catch (const std::exception&) {
                    spec.width = 1; // linha corrompida/inesperada -- nunca propaga exceção daqui
                }
            }
        }
        if (!spec.name.empty()) ports.push_back(spec);
    }
    return ports;
}

} // namespace lasecsimul::fpga
