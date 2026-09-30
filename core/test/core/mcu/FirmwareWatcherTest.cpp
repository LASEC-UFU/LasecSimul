#include "mcu/qemu/FirmwareWatcher.hpp"
#include <chrono>
#include <cstdio>
#include <filesystem>
#include <fstream>
#include <stdexcept>
#include <thread>
// assert() é a verificação deste teste. Em Release o CMake define NDEBUG e cada assert() viraria
// no-op: o baseline noturno (Release) aprovava o teste sem checar nada. <assert.h> redefine
// assert() conforme NDEBUG a cada inclusão; por isso vem depois dos outros includes.
#undef NDEBUG
#include <assert.h>

using lasecsimul::mcu::qemu::FirmwareWatcher;

namespace {

std::filesystem::path makeTempDir() {
    const auto base = std::filesystem::temp_directory_path();
    const auto name = "lasecsimul-fw-" + std::to_string(
                                          std::chrono::steady_clock::now().time_since_epoch().count());
    std::filesystem::path dir = base / name;
    std::filesystem::create_directories(dir);
    return dir;
}

void writeFile(const std::filesystem::path& path, const char* text) {
    std::ofstream out(path, std::ios::binary);
    out << text;
}

void testNewestArtifactAndChangeDetection() {
    const std::filesystem::path dir = makeTempDir();
    FirmwareWatcher watcher;

    writeFile(dir / "old.bin", "old");
    std::this_thread::sleep_for(std::chrono::milliseconds(30));
    writeFile(dir / "new.elf", "new");
    writeFile(dir / "ignored.txt", "ignored");

    auto first = watcher.poll(dir);
    assert(first.has_value());
    assert(first->filename() == "new.elf");
    assert(!watcher.poll(dir).has_value());

    std::this_thread::sleep_for(std::chrono::milliseconds(30));
    writeFile(dir / "latest.hex", "latest");
    auto second = watcher.poll(dir);
    assert(second.has_value());
    assert(second->filename() == "latest.hex");

    std::filesystem::remove_all(dir);
}

void testMissingFolderThrows() {
    FirmwareWatcher watcher;
    bool threw = false;
    try {
        (void)watcher.poll(std::filesystem::temp_directory_path() / "lasecsimul-missing-fw-folder");
    } catch (const std::runtime_error&) {
        threw = true;
    }
    assert(threw);
}

} // namespace

int main() {
    testNewestArtifactAndChangeDetection();
    testMissingFolderThrows();
    std::printf("OK: FirmwareWatcher selected newest artifact and reports missing folders.\n");
    return 0;
}

