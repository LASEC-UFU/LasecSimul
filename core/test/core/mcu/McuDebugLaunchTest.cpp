#include <algorithm>
#include <cassert>
#include <cstdio>
#include <cstdlib>
#include "mcu/McuController.hpp"

using namespace lasecsimul;

class FakeAdapter final : public IMcuAdapter {
public:
    const char* chipId() const override { return "fake.cpu"; }
    QemuLaunchSpec buildLaunchArgs(std::string_view firmware) const override {
        return {"qemu-fake", {"qemu-fake", "-kernel", std::string(firmware), "-nic",
                              "user,model=open_eth,net=192.168.4.0/24,host=192.168.4.2,dhcpstart=192.168.4.15,dns=192.168.4.3"}};
    }
    std::span<const MemoryRegion> memoryRegions() const override { return {}; }
    std::span<const PinMapping> pinMap() const override { return {}; }
    std::vector<std::unique_ptr<QemuModule>> createModules() const override { return {}; }
};

int main() {
#ifdef _WIN32
    _putenv_s("LASECSIMUL_NETWORK_NAMESPACE", "42");
    _putenv_s("LASECSIMUL_NETWORK_MODE", "");
    _putenv_s("LASECSIMUL_GATEWAY_PORT", "9011");
#else
    setenv("LASECSIMUL_NETWORK_NAMESPACE", "42", 1);
    unsetenv("LASECSIMUL_NETWORK_MODE");
    setenv("LASECSIMUL_GATEWAY_PORT", "9011", 1);
#endif
    FakeAdapter adapter;
    mcu::McuController controller(adapter);

    const QemuLaunchSpec defaultBridge = controller.buildLaunchSpec(
        "firmware.bin", "lasecsimul-mcu-1234-7");
    const std::string expectedDefaultBridge =
        "socket,model=open_eth,mac=02:4c:7c:7d:b8:e4,connect=127.0.0.1:9011";
#ifdef _WIN32
    _putenv_s("LASECSIMUL_NETWORK_MODE", "isolated");
#else
    setenv("LASECSIMUL_NETWORK_MODE", "isolated", 1);
#endif
    assert(std::find(defaultBridge.args.begin(), defaultBridge.args.end(), expectedDefaultBridge) !=
           defaultBridge.args.end());

    const QemuLaunchSpec normal = controller.buildLaunchSpec("firmware.bin", "lasecsimul-mcu-1234-7");
    assert(normal.args.front() == "lasecsimul-mcu-1234-7");
    assert(std::find(normal.args.begin(), normal.args.end(), "-gdb") == normal.args.end());
    assert(std::find(normal.args.begin(), normal.args.end(),
                     "user,model=open_eth,mac=02:4c:7c:7d:b8:e4,net=10.42.7.0/24,host=10.42.7.2,dhcpstart=10.42.7.15,dns=10.42.7.3") !=
           normal.args.end());

#ifdef _WIN32
    _putenv_s("LASECSIMUL_NETWORK_MODE", "lab-bridge");
#else
    setenv("LASECSIMUL_NETWORK_MODE", "lab-bridge", 1);
#endif
    const QemuLaunchSpec bridged = controller.buildLaunchSpec(
        "firmware.bin", "lasecsimul-mcu-1234-7");
    const std::string expectedBridge =
        "socket,model=open_eth,mac=02:4c:7c:7d:b8:e4,connect=127.0.0.1:9011";
    assert(std::find(bridged.args.begin(), bridged.args.end(), expectedBridge) != bridged.args.end());

    const QemuLaunchSpec debug = controller.buildLaunchSpec(
        "firmware.bin", "arena-7", "C:/qemu.exe", McuDebugOptions{3333, true});
    assert(debug.binary == "C:/qemu.exe");
    assert(debug.args.front() == "arena-7");
    const auto stop = std::find(debug.args.begin(), debug.args.end(), "-S");
    const auto gdb = std::find(debug.args.begin(), debug.args.end(), "-gdb");
    assert(stop != debug.args.end() && gdb != debug.args.end());
    assert(std::next(gdb) != debug.args.end() && *std::next(gdb) == "tcp:127.0.0.1:3333");
#ifdef _WIN32
    _putenv_s("LASECSIMUL_NETWORK_NAMESPACE", "");
    _putenv_s("LASECSIMUL_NETWORK_MODE", "");
    _putenv_s("LASECSIMUL_GATEWAY_PORT", "");
#else
    unsetenv("LASECSIMUL_NETWORK_NAMESPACE");
    unsetenv("LASECSIMUL_NETWORK_MODE");
    unsetenv("LASECSIMUL_GATEWAY_PORT");
#endif
    std::puts("OK: QEMU launch supports isolated and lab-bridge networking; debug args preserved.");
    return 0;
}
