#include "FpgaPortMapper.hpp"

#include <sstream>
#include <stdexcept>

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
            const int64_t defaultLeft = port.downto ? static_cast<int64_t>(width) - 1 : 0;
            const int64_t left = port.leftIndex.value_or(static_cast<int32_t>(defaultLeft));
            const int64_t vhdlIndex = left + (port.downto ? -static_cast<int64_t>(bitIndex)
                                                          : static_cast<int64_t>(bitIndex));
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
        if (line.rfind("LSDN_FPGA_ERROR ", 0) == 0) {
            throw std::runtime_error("descoberta VPI falhou: " + line.substr(17));
        }
        if (line.compare(0, kPrefix.size(), kPrefix) != 0) continue;
        PortSpec spec;
        std::string direction;
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
                direction = value;
            } else if (key == "width") {
                try {
                    spec.width = static_cast<uint32_t>(std::stoul(value));
                } catch (const std::exception&) {
                    spec.width = 1; // linha corrompida/inesperada -- nunca propaga exceção daqui
                }
            } else if (key == "left") {
                try { spec.leftIndex = static_cast<int32_t>(std::stol(value)); } catch (...) {}
            } else if (key == "right") {
                try { spec.rightIndex = static_cast<int32_t>(std::stol(value)); } catch (...) {}
            }
        }
        if (spec.name.empty()) continue;
        if (direction != "in" && direction != "out") {
            throw std::runtime_error("porta VHDL '" + spec.name + "' usa direção não suportada: " + direction);
        }
        spec.isInput = direction == "in";
        if (spec.leftIndex && spec.rightIndex) spec.downto = *spec.leftIndex > *spec.rightIndex;
        ports.push_back(spec);
    }
    return ports;
}

} // namespace lasecsimul::fpga
