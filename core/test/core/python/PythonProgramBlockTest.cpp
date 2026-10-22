#include "python/PythonProgramBlock.hpp"

#include <cstdio>
#include <stdexcept>

using namespace lasecsimul;

int main() {
    registry::ComponentParams params;
    params.properties["source"] = std::string{"reference = temperature * 1.5\nactive = habilitar"};
    params.properties["periodNs"] = 2'000'000.0;
    params.properties["ports"] = std::string{
        R"({"inputs":[{"name":"temperature","type":"real","unit":"°C","description":"Sensor do processo","initialValue":22.5},{"name":"habilitar","type":"bool","initialValue":true}],"outputs":[{"name":"reference","type":"int64","initialValue":3},{"name":"active","type":"bool","initialValue":false}]})"};

    python::PythonProgramBlock block(params);
    const auto ports = block.signalPorts();
    if (std::string_view{block.typeId()} != "python.programmable" || !block.pins().empty() ||
        block.periodNs() != 2'000'000 || ports.size() != 4 ||
        ports[0].id != "temperature" || ports[0].kind != SignalValueKind::Analog ||
        ports[1].id != "habilitar" || ports[1].kind != SignalValueKind::Digital ||
        ports[2].id != "reference" || ports[2].kind != SignalValueKind::Unsigned ||
        ports[3].id != "active" || ports[3].kind != SignalValueKind::Digital ||
        block.inputs()[0].description != "Sensor do processo" ||
        std::get<double>(block.inputs()[0].initialValue) != 22.5 ||
        !std::get<bool>(block.inputs()[1].initialValue) ||
        std::get<int64_t>(block.outputs()[0].initialValue) != 3) {
        std::fprintf(stderr, "PythonProgramBlock: dynamic ports, types, or signal-only domain mismatch\n");
        return 1;
    }
    if (block.failureMode() != "hold") {
        std::fprintf(stderr, "PythonProgramBlock: default failure mode must hold the last output\n");
        return 1;
    }

    bool duplicateRejected = false;
    try {
        for (auto& property : block.propertyDescriptors()) {
            if (property.name == "ports") property.set(std::string{
                R"({"inputs":[{"name":"same"}],"outputs":[{"name":"same"}]})"});
        }
    } catch (const std::invalid_argument&) { duplicateRejected = true; }
    if (!duplicateRejected) {
        std::fprintf(stderr, "PythonProgramBlock: duplicate names must be rejected\n");
        return 1;
    }

    bool keywordRejected = false;
    try {
        for (auto& property : block.propertyDescriptors()) {
            if (property.name == "ports") property.set(std::string{
                R"({"inputs":[{"name":"class"}],"outputs":[]})"});
        }
    } catch (const std::invalid_argument&) { keywordRejected = true; }
    if (!keywordRejected) {
        std::fprintf(stderr, "PythonProgramBlock: Python keywords must be rejected\n");
        return 1;
    }

    std::printf("PythonProgramBlock dynamic typed signal ports: OK\n");
    return 0;
}
