#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include "mcu/McuController.hpp"
// assert() é a verificação deste teste. Em Release o CMake define NDEBUG e cada assert() viraria
// no-op: o baseline noturno (Release) aprovava o teste sem checar nada. <assert.h> redefine
// assert() conforme NDEBUG a cada inclusão; por isso vem depois dos outros includes.
#undef NDEBUG
#include <assert.h>

using namespace lasecsimul;

class FakeAdapter final : public IMcuAdapter {
public:
    const char* chipId() const override { return "fake.cpu"; }
    QemuLaunchSpec buildLaunchArgs(std::string_view firmware) const override {
        // Mirrors the real Esp32Adapter: single-thread TCG plus instruction-counted time (the MTTCG
        // mode was retired on 2026-10-30). McuController's LASECSIMUL_QEMU_TB_SIZE override and its
        // execution= diagnostic then have something realistic to act on.
        return {"qemu-fake", {"qemu-fake", "-kernel", std::string(firmware), "-accel", "tcg,thread=single",
                              "-icount", "shift=4,align=off,sleep=off"}};
    }
    std::span<const MemoryRegion> memoryRegions() const override { return {}; }
    std::span<const PinMapping> pinMap() const override { return {}; }
    std::vector<std::unique_ptr<QemuModule>> createModules() const override { return {}; }
};

int main() {
#ifdef _WIN32
    _putenv_s("LASECSIMUL_NETWORK_NAMESPACE", "42");
    _putenv_s("LASECSIMUL_NETWORK_MODE", "");
    _putenv_s("LASECSIMUL_NETWORK_FRONTEND", "");
    _putenv_s("LASECSIMUL_GATEWAY_PORT", "9011");
#else
    setenv("LASECSIMUL_NETWORK_NAMESPACE", "42", 1);
    unsetenv("LASECSIMUL_NETWORK_MODE");
    unsetenv("LASECSIMUL_NETWORK_FRONTEND");
    setenv("LASECSIMUL_GATEWAY_PORT", "9011", 1);
#endif
    FakeAdapter adapter;
    mcu::McuController controller(adapter);

    const auto accelArgument = [](const QemuLaunchSpec& spec) {
        const auto accel = std::find(spec.args.begin(), spec.args.end(), "-accel");
        assert(accel != spec.args.end() && std::next(accel) != spec.args.end());
        return *std::next(accel);
    };

    const QemuLaunchSpec disabled = controller.buildLaunchSpec(
        "firmware.bin", "lasecsimul-mcu-1234-7");
    assert(std::find(disabled.args.begin(), disabled.args.end(), "-nic") == disabled.args.end());
    assert(disabled.diagnostics.find("network=disabled") != std::string::npos);
#ifdef _WIN32
    _putenv_s("LASECSIMUL_NETWORK_MODE", "isolated");
#else
    setenv("LASECSIMUL_NETWORK_MODE", "isolated", 1);
#endif
    const QemuLaunchSpec normal = controller.buildLaunchSpec("firmware.bin", "lasecsimul-mcu-1234-7");
    assert(normal.args.front() == "lasecsimul-mcu-1234-7");
    assert(std::find(normal.args.begin(), normal.args.end(), "-gdb") == normal.args.end());
    // Frontend padrão desde docs/47: o modelo Wi-Fi transparente do ESP32 (esp32_wifi).
    assert(std::find(normal.args.begin(), normal.args.end(),
                     "user,model=esp32_wifi,mac=02:4c:2a:07:b8:e4,net=10.42.7.0/24,host=10.42.7.2,dhcpstart=10.42.7.15,dns=10.42.7.3") !=
           normal.args.end());
#ifdef _WIN32
    _putenv_s("LASECSIMUL_NETWORK_FRONTEND", "openeth");
#else
    setenv("LASECSIMUL_NETWORK_FRONTEND", "openeth", 1);
#endif
    // Rollback documentado (LASECSIMUL_NETWORK_FRONTEND=openeth): mesma rede e MAC, NIC Ethernet.
    const QemuLaunchSpec openEth = controller.buildLaunchSpec("firmware.bin", "lasecsimul-mcu-1234-7");
    assert(std::find(openEth.args.begin(), openEth.args.end(),
                     "user,model=open_eth,mac=02:4c:2a:07:b8:e4,net=10.42.7.0/24,host=10.42.7.2,dhcpstart=10.42.7.15,dns=10.42.7.3") !=
           openEth.args.end());
#ifdef _WIN32
    _putenv_s("LASECSIMUL_NETWORK_FRONTEND", "");
#else
    unsetenv("LASECSIMUL_NETWORK_FRONTEND");
#endif

#ifdef _WIN32
    _putenv_s("LASECSIMUL_NETWORK_MODE", "lab-router");
#else
    setenv("LASECSIMUL_NETWORK_MODE", "lab-router", 1);
#endif
    const QemuLaunchSpec routed = controller.buildLaunchSpec("firmware.bin", "lasecsimul-mcu-1234-7");
    const std::string expectedRouter =
        "socket,model=esp32_wifi,mac=02:4c:2a:07:b8:e4,connect=127.0.0.1:9011";
    assert(std::find(routed.args.begin(), routed.args.end(), expectedRouter) != routed.args.end());

#ifdef _WIN32
    _putenv_s("LASECSIMUL_NETWORK_MODE", "lab-bridge");
#else
    setenv("LASECSIMUL_NETWORK_MODE", "lab-bridge", 1);
#endif
    const QemuLaunchSpec bridged = controller.buildLaunchSpec(
        "firmware.bin", "lasecsimul-mcu-1234-7");
    const std::string expectedBridge =
        "socket,model=esp32_wifi,mac=02:4c:2a:07:b8:e4,connect=127.0.0.1:9011";
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
    _putenv_s("LASECSIMUL_QEMU_TB_SIZE", "");
#else
    unsetenv("LASECSIMUL_QEMU_TB_SIZE");
#endif
    const QemuLaunchSpec icount = controller.buildLaunchSpec("firmware.bin", "accel-icount");
    assert(accelArgument(icount) == "tcg,thread=single");
    assert(std::find(icount.args.begin(), icount.args.end(), "-icount") != icount.args.end());
    assert(icount.diagnostics.find("execution=deterministic-icount shift=4") != std::string::npos);
#ifdef _WIN32
    _putenv_s("LASECSIMUL_QEMU_TB_SIZE", "64");
#else
    setenv("LASECSIMUL_QEMU_TB_SIZE", "64", 1);
#endif
    const QemuLaunchSpec icountTb = controller.buildLaunchSpec("firmware.bin", "accel-icount-tb");
    assert(accelArgument(icountTb) == "tcg,thread=single,tb-size=64");
    assert(std::find(icountTb.args.begin(), icountTb.args.end(), "-icount") != icountTb.args.end());
#ifdef _WIN32
    _putenv_s("LASECSIMUL_NETWORK_NAMESPACE", "");
    _putenv_s("LASECSIMUL_NETWORK_MODE", "");
    _putenv_s("LASECSIMUL_GATEWAY_PORT", "");
    _putenv_s("LASECSIMUL_QEMU_TB_SIZE", "");
    _putenv_s("LASECSIMUL_MCU_TRANSPORT", "");
#else
    unsetenv("LASECSIMUL_NETWORK_NAMESPACE");
    unsetenv("LASECSIMUL_NETWORK_MODE");
    unsetenv("LASECSIMUL_GATEWAY_PORT");
    unsetenv("LASECSIMUL_QEMU_TB_SIZE");
    unsetenv("LASECSIMUL_MCU_TRANSPORT");
#endif
    std::puts("OK: QEMU launch supports disabled, lab-router, lab-bridge and internal isolated fallback; debug args preserved.");

    // PLAN_MTTCG_VNEXT_B_CAUSALITY.md section 7.2: execution mode and transport must be
    // unambiguous in the diagnostics, inspected via buildLaunchSpec() alone -- no real QEMU is
    // started here. The real adapter's launch arguments are covered in Esp32AdapterTest.cpp.
    const QemuLaunchSpec legacy = controller.buildLaunchSpec("firmware.bin", "lasecsimul-mcu-1234-7");
    assert(legacy.diagnostics.find("execution=deterministic-icount") != std::string::npos);
    assert(legacy.diagnostics.find("transport=legacy") != std::string::npos);
    assert(legacy.diagnostics.find("transport=vnext_b") == std::string::npos);
#ifdef _WIN32
    _putenv_s("LASECSIMUL_MCU_TRANSPORT", "VNEXT_B");
#else
    setenv("LASECSIMUL_MCU_TRANSPORT", "VNEXT_B", 1);
#endif
    const QemuLaunchSpec vnextB = controller.buildLaunchSpec("firmware.bin", "lasecsimul-mcu-1234-7");
    assert(vnextB.diagnostics.find("transport=vnext_b") != std::string::npos);
    assert(vnextB.diagnostics.find("transport=legacy") == std::string::npos);
#ifdef _WIN32
    _putenv_s("LASECSIMUL_MCU_TRANSPORT", "");
#else
    unsetenv("LASECSIMUL_MCU_TRANSPORT");
#endif
    std::puts("OK: execution mode and transport are unambiguous in launch diagnostics "
              "(deterministic-icount, legacy and vnext_b transports).");

    return 0;
}
