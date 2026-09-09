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
        // Mirrors the real Esp32Adapter's MTTCG default (-accel tcg,thread=multi,
        // no -icount) so McuController's LASECSIMUL_QEMU_TCG_THREAD override and
        // its execution= diagnostic have something realistic to act on.
        return {"qemu-fake",
                {"qemu-fake", "-kernel", std::string(firmware), "-accel", "tcg,thread=multi"}};
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
    _putenv_s("LASECSIMUL_QEMU_TB_SIZE", "");
    _putenv_s("LASECSIMUL_QEMU_TCG_THREAD", "");
    _putenv_s("LASECSIMUL_ESP32_EXECUTION_MODE", "");
#else
    unsetenv("LASECSIMUL_QEMU_TB_SIZE");
    unsetenv("LASECSIMUL_QEMU_TCG_THREAD");
    unsetenv("LASECSIMUL_ESP32_EXECUTION_MODE");
#endif
    assert(accelArgument(controller.buildLaunchSpec("firmware.bin", "accel-multi")) == "tcg,thread=multi");
#ifdef _WIN32
    _putenv_s("LASECSIMUL_QEMU_TCG_THREAD", "single");
#else
    setenv("LASECSIMUL_QEMU_TCG_THREAD", "single", 1);
#endif
    assert(accelArgument(controller.buildLaunchSpec("firmware.bin", "accel-single")) == "tcg,thread=single");
#ifdef _WIN32
    _putenv_s("LASECSIMUL_QEMU_TB_SIZE", "64");
    _putenv_s("LASECSIMUL_QEMU_TCG_THREAD", "");
#else
    setenv("LASECSIMUL_QEMU_TB_SIZE", "64", 1);
    unsetenv("LASECSIMUL_QEMU_TCG_THREAD");
#endif
    assert(accelArgument(controller.buildLaunchSpec("firmware.bin", "accel-multi-tb")) == "tcg,thread=multi,tb-size=64");
#ifdef _WIN32
    _putenv_s("LASECSIMUL_QEMU_TCG_THREAD", "single");
#else
    setenv("LASECSIMUL_QEMU_TCG_THREAD", "single", 1);
#endif
    const QemuLaunchSpec singleTb = controller.buildLaunchSpec("firmware.bin", "accel-single-tb");
    assert(accelArgument(singleTb) == "tcg,thread=single,tb-size=64");
    assert(singleTb.diagnostics.find("execution=single-realtime") != std::string::npos);
#ifdef _WIN32
    _putenv_s("LASECSIMUL_QEMU_TCG_THREAD", "");
    _putenv_s("LASECSIMUL_ESP32_EXECUTION_MODE", "deterministic");
#else
    unsetenv("LASECSIMUL_QEMU_TCG_THREAD");
    setenv("LASECSIMUL_ESP32_EXECUTION_MODE", "deterministic", 1);
#endif
    const QemuLaunchSpec icount = controller.buildLaunchSpec("firmware.bin", "accel-icount");
    assert(accelArgument(icount) == "tcg,thread=single,tb-size=64");
    assert(std::find(icount.args.begin(), icount.args.end(), "-icount") != icount.args.end());
    assert(icount.diagnostics.find("execution=deterministic-icount") != std::string::npos);
#ifdef _WIN32
    _putenv_s("LASECSIMUL_NETWORK_NAMESPACE", "");
    _putenv_s("LASECSIMUL_NETWORK_MODE", "");
    _putenv_s("LASECSIMUL_GATEWAY_PORT", "");
    _putenv_s("LASECSIMUL_QEMU_TB_SIZE", "");
    _putenv_s("LASECSIMUL_QEMU_TCG_THREAD", "");
    _putenv_s("LASECSIMUL_ESP32_EXECUTION_MODE", "");
#else
    unsetenv("LASECSIMUL_NETWORK_NAMESPACE");
    unsetenv("LASECSIMUL_NETWORK_MODE");
    unsetenv("LASECSIMUL_GATEWAY_PORT");
    unsetenv("LASECSIMUL_QEMU_TB_SIZE");
    unsetenv("LASECSIMUL_QEMU_TCG_THREAD");
    unsetenv("LASECSIMUL_ESP32_EXECUTION_MODE");
#endif
    std::puts("OK: QEMU launch defaults to no NIC and supports opt-in isolated/lab-bridge; debug args preserved.");

    // PLAN_MTTCG_VNEXT_B_CAUSALITY.md section 7.2: execution mode and transport must be
    // unambiguous in the diagnostics, inspected via buildLaunchSpec()/args alone -- no real
    // QEMU is started here. FakeAdapter's fixed MTTCG-shaped response (tcg,thread=multi, no
    // -icount) lets this file exercise McuController's own LASECSIMUL_QEMU_TCG_THREAD override
    // and the execution=/transport= diagnostic lines; the ICOUNT/MTTCG split coming from
    // configuredExecutionMode() itself is covered against the real adapter in
    // Esp32AdapterTest.cpp.
    auto containsArg = [](const QemuLaunchSpec& spec, const std::string& value) {
        return std::find(spec.args.begin(), spec.args.end(), value) != spec.args.end();
    };
    auto containsArgPair = [](const QemuLaunchSpec& spec, const std::string& option,
                              const std::string& value) {
        for (size_t i = 0; i + 1 < spec.args.size(); ++i) {
            if (spec.args[i] == option && spec.args[i + 1] == value) return true;
        }
        return false;
    };

#ifdef _WIN32
    _putenv_s("LASECSIMUL_QEMU_TCG_THREAD", "");
    _putenv_s("LASECSIMUL_MCU_TRANSPORT", "");
#else
    unsetenv("LASECSIMUL_QEMU_TCG_THREAD");
    unsetenv("LASECSIMUL_MCU_TRANSPORT");
#endif
    const QemuLaunchSpec mttcgDefault =
        controller.buildLaunchSpec("firmware.bin", "lasecsimul-mcu-1234-7");
    assert(containsArgPair(mttcgDefault, "-accel", "tcg,thread=multi"));
    assert(!containsArg(mttcgDefault, "-icount"));
    assert(mttcgDefault.diagnostics.find("execution=mttcg-realtime") != std::string::npos);

#ifdef _WIN32
    _putenv_s("LASECSIMUL_QEMU_TCG_THREAD", "single");
#else
    setenv("LASECSIMUL_QEMU_TCG_THREAD", "single", 1);
#endif
    const QemuLaunchSpec singleRealtime =
        controller.buildLaunchSpec("firmware.bin", "lasecsimul-mcu-1234-7");
    assert(containsArgPair(singleRealtime, "-accel", "tcg,thread=single"));
    assert(!containsArg(singleRealtime, "-icount"));
    // The invariant that must never be violated by any mode combination: MTTCG's
    // thread=multi and -icount are mutually exclusive (QEMU itself refuses that pairing).
    assert(!(containsArgPair(singleRealtime, "-accel", "tcg,thread=multi") &&
             containsArg(singleRealtime, "-icount")));
    assert(singleRealtime.diagnostics.find("execution=single-realtime") != std::string::npos);
    assert(singleRealtime.diagnostics.find("execution=mttcg-realtime") == std::string::npos);
#ifdef _WIN32
    _putenv_s("LASECSIMUL_QEMU_TCG_THREAD", "");
#else
    unsetenv("LASECSIMUL_QEMU_TCG_THREAD");
#endif

    // transport= must be unambiguous in every launch, legacy or VNEXT_B.
    assert(mttcgDefault.diagnostics.find("transport=legacy") != std::string::npos);
    assert(mttcgDefault.diagnostics.find("transport=vnext_b") == std::string::npos);
    std::puts("OK: execution mode and transport are unambiguous in launch diagnostics "
              "(mttcg-realtime default, single-realtime override, legacy transport).");

    return 0;
}
