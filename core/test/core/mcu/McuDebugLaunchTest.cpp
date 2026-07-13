#include <algorithm>
#include <cassert>
#include <cstdio>
#include "mcu/McuController.hpp"

using namespace lasecsimul;

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

int main() {
    FakeAdapter adapter;
    mcu::McuController controller(adapter);
    const QemuLaunchSpec normal = controller.buildLaunchSpec("firmware.bin", "arena-7");
    assert(normal.args.front() == "arena-7");
    assert(std::find(normal.args.begin(), normal.args.end(), "-gdb") == normal.args.end());

    const QemuLaunchSpec debug = controller.buildLaunchSpec(
        "firmware.bin", "arena-7", "C:/qemu.exe", McuDebugOptions{3333, true});
    assert(debug.binary == "C:/qemu.exe");
    assert(debug.args.front() == "arena-7");
    const auto stop = std::find(debug.args.begin(), debug.args.end(), "-S");
    const auto gdb = std::find(debug.args.begin(), debug.args.end(), "-gdb");
    assert(stop != debug.args.end() && gdb != debug.args.end());
    assert(std::next(gdb) != debug.args.end() && *std::next(gdb) == "tcp:127.0.0.1:3333");
    std::puts("OK: QEMU debug launch args include arena, -S and isolated GDB endpoint.");
    return 0;
}
