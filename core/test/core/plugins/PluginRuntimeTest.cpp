#include <cstdio>
#include <memory>
#include <string>
#include <vector>
#include "plugins/GlobalPluginCache.hpp"
#include "plugins/PluginLoader.hpp"
#include "plugins/PluginRuntime.hpp"
#include "registry/ComponentParams.hpp"
#include "simulation/Scheduler.hpp"
#include "lasecsimul/IComponentModel.hpp"
#include "lasecsimul/IMcuAdapter.hpp"

using namespace lasecsimul;
using namespace lasecsimul::plugins;

namespace {

struct RecordingMatrix final : MnaMatrixView {
    int conductanceCount = 0;
    int voltageCount = 0;
    int currentCount = 0;
    int groundCount = 0;
    std::vector<std::string> calls;

    void addConductance(const Pin& a, const Pin& b, double) override {
        ++conductanceCount;
        calls.push_back(a.id + "-" + b.id);
    }
    void addCurrent(const Pin&, const Pin&, double) override { ++currentCount; }
    void addVoltageSource(const Pin&, const Pin&, double) override { ++voltageCount; }
    void addConductanceToGround(const Pin&, double) override { ++groundCount; }
    void addCurrentToGround(const Pin&, double) override { ++groundCurrentCount; }
    double getNodeVoltage(const Pin&) const override { return 1.23; }
    double getBranchCurrent() const override { return 0.0; }

    int groundCurrentCount = 0;
};

int device1StampCount = 0;
int device1PostStepCount = 0;
int device1DestroyCount = 0;
int device2StampCount = 0;
int device2PostStepCount = 0;
int device2DestroyCount = 0;
int mcuDestroyCount = 0;

struct DeviceState {};
struct McuState {};

LsdnDevice* createDevice1(void*, const LsdnHostApi*) { return reinterpret_cast<LsdnDevice*>(new DeviceState{}); }
void initDevice1(LsdnDevice*) {}
void stampDevice1(LsdnDevice*, LsdnMatrixView* matrix) {
    ++device1StampCount;
    matrix->add_conductance(matrix->opaque, 0, 1, 1.0);
}
void postStepDevice1(LsdnDevice*, uint64_t) { ++device1PostStepCount; }
void onEventDevice(LsdnDevice*, const LsdnEvent*) {}
uint32_t getPropertyDevice(LsdnDevice*, const char*, LsdnPropertyValue*) { return 0; }
uint32_t setPropertyDevice(LsdnDevice*, const char*, const LsdnPropertyValue*) { return 0; }
uint32_t getStateDevice(LsdnDevice*, uint8_t* out, uint32_t cap) {
    if (cap < 1) return 0;
    out[0] = 7;
    return 1;
}
void setStateDevice(LsdnDevice*, const uint8_t*, uint32_t) {}
void destroyDevice1(LsdnDevice* dev) {
    ++device1DestroyCount;
    delete reinterpret_cast<DeviceState*>(dev);
}

LsdnDevice* createDevice2(void*, const LsdnHostApi*) { return reinterpret_cast<LsdnDevice*>(new DeviceState{}); }
void initDevice2(LsdnDevice*) {}
void stampDevice2(LsdnDevice*, LsdnMatrixView* matrix) {
    ++device2StampCount;
    matrix->add_voltage_source(matrix->opaque, 1, 0, 2.0);
}
void postStepDevice2(LsdnDevice*, uint64_t) { ++device2PostStepCount; }
void destroyDevice2(LsdnDevice* dev) {
    ++device2DestroyCount;
    delete reinterpret_cast<DeviceState*>(dev);
}

const LsdnDeviceVTable kDeviceVTable1 = {
    &createDevice1, &initDevice1, &stampDevice1, &postStepDevice1, &onEventDevice, &getPropertyDevice,
    &setPropertyDevice, &getStateDevice, &setStateDevice, &destroyDevice1,
};
const LsdnDeviceVTable kDeviceVTable2 = {
    &createDevice2, &initDevice2, &stampDevice2, &postStepDevice2, &onEventDevice, &getPropertyDevice,
    &setPropertyDevice, &getStateDevice, &setStateDevice, &destroyDevice2,
};

const LsdnDeviceVTable* getDeviceVTable1(uint32_t* major, uint32_t* minor) {
    *major = LSDN_ABI_VERSION_MAJOR;
    *minor = LSDN_ABI_VERSION_MINOR;
    return &kDeviceVTable1;
}
const LsdnDeviceVTable* getDeviceVTable2(uint32_t* major, uint32_t* minor) {
    *major = LSDN_ABI_VERSION_MAJOR;
    *minor = LSDN_ABI_VERSION_MINOR;
    return &kDeviceVTable2;
}

LsdnMcuAdapter* createMcu(void*, const LsdnMcuHostApi*) { return reinterpret_cast<LsdnMcuAdapter*>(new McuState{}); }
LsdnQemuLaunchSpec buildLaunchArgs(LsdnMcuAdapter*, const char*) {
    static const char* args[] = {"-machine", "esp32", nullptr};
    return LsdnQemuLaunchSpec{"qemu-fake", args, 2};
}
uint32_t getMemoryRegions(LsdnMcuAdapter*, LsdnMemoryRegion* out, uint32_t cap) {
    const LsdnMemoryRegion region{0x1000, 0x10ff, LSDN_MODULE_GPIO, 0};
    if (out && cap >= 1) out[0] = region;
    return 1;
}
uint32_t getPinMap(LsdnMcuAdapter*, LsdnPinMapping* out, uint32_t cap) {
    const LsdnPinMapping pins[] = {
        {"GPIO2", LSDN_MODULE_GPIO, 0, 2},
        {"UART0_TX", LSDN_MODULE_USART, 0, 1},
    };
    if (out && cap >= 2) {
        out[0] = pins[0];
        out[1] = pins[1];
    }
    return 2;
}
void destroyMcu(LsdnMcuAdapter* adapter) {
    ++mcuDestroyCount;
    delete reinterpret_cast<McuState*>(adapter);
}
const LsdnMcuVTable kMcuVTable = {&createMcu, &buildLaunchArgs, &getMemoryRegions, &getPinMap, nullptr, &destroyMcu};

const LsdnDeviceVTable* getDeviceVTable1Wrapper(uint32_t* major, uint32_t* minor) { return getDeviceVTable1(major, minor); }
const LsdnDeviceVTable* getDeviceVTable2Wrapper(uint32_t* major, uint32_t* minor) { return getDeviceVTable2(major, minor); }
const LsdnMcuVTable* getMcuVTable(uint32_t* major, uint32_t* minor) {
    *major = LSDN_MCU_ABI_VERSION_MAJOR;
    *minor = LSDN_MCU_ABI_VERSION_MINOR;
    return &kMcuVTable;
}

bool expect(bool condition, const char* label) {
    if (!condition) std::fprintf(stderr, "FAILED: %s\n", label);
    return condition;
}

} // namespace

int main() {
    bool ok = true;
    GlobalPluginCache cache;
    PluginRuntime runtime(cache);
    simulation::Scheduler scheduler(16, [] { return false; });

    auto module1 = PluginLoader::createDeviceModuleFromExports(nullptr, &getDeviceVTable1Wrapper, "device.v1");
    auto module2 = PluginLoader::createDeviceModuleFromExports(nullptr, &getDeviceVTable2Wrapper, "device.v2");
    cache.setActiveDeviceModule("test.device", module1);

    ComponentMeta meta{"test.device", {Pin{"p1"}, Pin{"p2"}}};
    registry::ComponentParams params;
    auto proxy1 = runtime.createDeviceInstance("test.device", meta, params, scheduler);
    RecordingMatrix matrix;
    proxy1->stamp(matrix);
    proxy1->postStep(100);
    ok &= expect(device1StampCount == 1, "device v1 stamp called");
    ok &= expect(device1PostStepCount == 1, "device v1 postStep called");
    ok &= expect(matrix.conductanceCount == 1, "device v1 translated pin indices to matrix pins");
    ok &= expect(matrix.calls.size() == 1 && matrix.calls[0] == "p1-p2", "pin mapping preserved from component meta");

    std::weak_ptr<PluginModule> weak1 = module1;
    cache.setActiveDeviceModule("test.device", module2);
    module1.reset();
    ok &= expect(!weak1.expired(), "module v1 stays alive while proxy exists");

    auto proxy2 = runtime.createDeviceInstance("test.device", meta, params, scheduler);
    proxy2->stamp(matrix);
    proxy2->postStep(200);
    ok &= expect(device2StampCount == 1, "device v2 stamp called after versioned swap");
    ok &= expect(device2PostStepCount == 1, "device v2 postStep called after versioned swap");

    auto mcuModule = PluginLoader::createMcuModuleFromExports(nullptr, &getMcuVTable, "mcu.v1");
    cache.setActiveMcuModule("esp32.fake", mcuModule);
    auto mcu = runtime.createMcuAdapter("esp32.fake");
    ok &= expect(std::string(mcu->chipId()) == "esp32.fake", "MCU chipId preserved");
    ok &= expect(mcu->memoryRegions().size() == 1, "MCU memory regions exposed");
    ok &= expect(mcu->pinMap().size() == 2, "MCU pin map exposed");
    const QemuLaunchSpec spec = mcu->buildLaunchArgs("firmware.bin");
    ok &= expect(spec.binary == "qemu-fake", "MCU launch binary preserved");
    ok &= expect(spec.args.size() == 2, "MCU launch args preserved");

    proxy1.reset();
    ok &= expect(weak1.expired(), "module v1 can unload after proxy destruction");
    proxy2.reset();
    mcu.reset();
    ok &= expect(device1DestroyCount == 1, "device v1 destroy called once");
    ok &= expect(device2DestroyCount == 1, "device v2 destroy called once");
    ok &= expect(mcuDestroyCount == 1, "MCU destroy called once");

    if (ok) std::printf("OK: PluginRuntime and proxies passed.\n");
    return ok ? 0 : 1;
}
