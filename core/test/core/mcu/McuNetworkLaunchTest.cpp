#include <algorithm>
#include <cstdlib>
#include <iostream>
#include <string>
#include <vector>

#include "mcu/McuController.hpp"

using namespace lasecsimul;

namespace {

class FakeAdapter final : public IMcuAdapter {
public:
    const char* chipId() const override { return "fake.cpu"; }

    QemuLaunchSpec buildLaunchArgs(std::string_view firmware) const override {
        return {"qemu-fake", {"qemu-fake", "-kernel", std::string(firmware)}};
    }

    std::span<const MemoryRegion> memoryRegions() const override { return {}; }
    std::span<const PinMapping> pinMap() const override { return {}; }
    std::vector<std::unique_ptr<QemuModule>> createModules() const override { return {}; }
};

void setEnvironment(const char* name, const char* value) {
#ifdef _WIN32
    _putenv_s(name, value);
#else
    setenv(name, value, 1);
#endif
}

void clearEnvironment(const char* name) {
#ifdef _WIN32
    _putenv_s(name, "");
#else
    unsetenv(name);
#endif
}

std::string findNic(const QemuLaunchSpec& spec) {
    const auto nic = std::find(spec.args.begin(), spec.args.end(), "-nic");
    if (nic == spec.args.end() || std::next(nic) == spec.args.end()) return {};
    return *std::next(nic);
}

void require(bool condition, const char* message) {
    if (condition) return;
    std::cerr << "FAIL: " << message << '\n';
    std::exit(1);
}

} // namespace

int main() {
    setEnvironment("LASECSIMUL_NETWORK_MODE", "lab-router");
    setEnvironment("LASECSIMUL_NETWORK_NAMESPACE", "42");
    setEnvironment("LASECSIMUL_GATEWAY_PORT", "9011");

    FakeAdapter adapter;
    mcu::McuController controller(adapter);

    const std::string explicitNamespace = findNic(
        controller.buildLaunchSpec("firmware.bin", "lasecsimul-mcu-1234-7"));
    require(explicitNamespace ==
                "socket,model=open_eth,mac=02:4c:2a:07:b8:e4,connect=127.0.0.1:9011",
            "lab-router codifica namespace 42 e slot 7 no MAC OpenETH");

    setEnvironment("LASECSIMUL_NETWORK_NAMESPACE", "99");
    const std::string boundaryNamespace = findNic(
        controller.buildLaunchSpec("firmware.bin", "lasecsimul-mcu-1234-255"));
    require(boundaryNamespace.rfind("socket,model=open_eth,mac=02:4c:63:ff:", 0) == 0,
            "lab-router preserva os bytes de namespace e slot nos limites 99/255");

    clearEnvironment("LASECSIMUL_NETWORK_NAMESPACE");
    const std::string defaultNamespace = findNic(
        controller.buildLaunchSpec("firmware.bin", "lasecsimul-mcu-1234-7"));
    require(defaultNamespace.rfind("socket,model=open_eth,mac=02:4c:2a:07:", 0) == 0,
            "lab-router usa o namespace provisionado 42 quando nenhum valor foi configurado");

    setEnvironment("LASECSIMUL_NETWORK_MODE", "disabled");
    const QemuLaunchSpec disabled = controller.buildLaunchSpec(
        "firmware.bin", "lasecsimul-mcu-1234-7");
    require(std::find(disabled.args.begin(), disabled.args.end(), "-nic") == disabled.args.end(),
            "disabled continua sem criar NIC ou backend de rede");

    clearEnvironment("LASECSIMUL_NETWORK_MODE");
    clearEnvironment("LASECSIMUL_NETWORK_NAMESPACE");
    clearEnvironment("LASECSIMUL_GATEWAY_PORT");
    std::cout << "OK: OpenETH codifica namespace/slot e disabled permanece sem NIC.\n";
    return 0;
}
