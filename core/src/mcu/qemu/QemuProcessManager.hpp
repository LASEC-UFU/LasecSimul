#pragma once

#include <chrono>
#include <memory>
#include <string>
#include "lasecsimul/Types.hpp"

namespace lasecsimul::mcu::qemu {

class QemuProcessManager {
public:
    QemuProcessManager();
    ~QemuProcessManager();

    QemuProcessManager(const QemuProcessManager&) = delete;
    QemuProcessManager& operator=(const QemuProcessManager&) = delete;

    void start(const QemuLaunchSpec& spec);
    bool stop(std::chrono::milliseconds timeout = std::chrono::milliseconds(1000));
    void kill();
    bool isRunning() const;
    uint64_t processId() const;
    std::string logs() const;

private:
    class Impl;
    std::unique_ptr<Impl> m_impl;
};

} // namespace lasecsimul::mcu::qemu
