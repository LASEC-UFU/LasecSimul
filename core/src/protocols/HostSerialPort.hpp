#pragma once

#include <cstddef>
#include <cstdint>
#include <span>
#include <string>

namespace lasecsimul::protocols {

/** A host serial port (COMx / /dev/tty*) in non-blocking mode: `read`
 * returns what has arrived, `write` queues bytes in the driver. Used by the
 * HART modem, whose PC side is a real (or com0com virtual) serial port. */
class HostSerialPort {
public:
    enum class Parity : uint8_t { None, Even, Odd };

    HostSerialPort() = default;
    HostSerialPort(const HostSerialPort&) = delete;
    HostSerialPort& operator=(const HostSerialPort&) = delete;
    ~HostSerialPort() { close(); }

    bool open(const std::string& name, uint32_t baud, uint8_t dataBits, Parity parity, uint8_t stopBits);
    void close();
    bool isOpen() const noexcept { return m_open; }
    /** Bytes available now (never blocks); 0 when none or on error. */
    size_t read(uint8_t* out, size_t capacity);
    /** Bytes accepted by the driver. */
    size_t write(std::span<const uint8_t> bytes);
    const std::string& error() const noexcept { return m_error; }

private:
    void fail(const std::string& message, unsigned long code);
    bool m_open = false;
    std::string m_error;
#if defined(_WIN32)
    void* m_handle = nullptr;
#else
    int m_fd = -1;
#endif
};

} // namespace lasecsimul::protocols
