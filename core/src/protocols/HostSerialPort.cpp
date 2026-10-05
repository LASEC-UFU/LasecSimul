#include "HostSerialPort.hpp"

#if defined(_WIN32)
#ifndef NOMINMAX
#define NOMINMAX
#endif
#ifndef WIN32_LEAN_AND_MEAN
#define WIN32_LEAN_AND_MEAN
#endif
#include <windows.h>
#else
#include <cerrno>
#include <fcntl.h>
#include <termios.h>
#include <unistd.h>
#endif

namespace lasecsimul::protocols {

void HostSerialPort::fail(const std::string& message, unsigned long code) {
    m_error = message + (code != 0 ? " (" + std::to_string(code) + ")" : std::string{});
    close();
}

#if defined(_WIN32)

bool HostSerialPort::open(const std::string& name, uint32_t baud, uint8_t dataBits, Parity parity, uint8_t stopBits) {
    close();
    m_error.clear();
    if (name.empty()) {
        m_error = "Nome da porta serial vazio";
        return false;
    }
    const std::string path = "\\\\.\\" + name;
    HANDLE handle = CreateFileA(path.c_str(), GENERIC_READ | GENERIC_WRITE, 0, nullptr, OPEN_EXISTING, FILE_ATTRIBUTE_NORMAL, nullptr);
    if (handle == INVALID_HANDLE_VALUE) {
        m_error = "Nao foi possivel abrir " + name + "; erro do Windows " + std::to_string(GetLastError());
        return false;
    }
    m_handle = handle;
    m_open = true;
    DCB dcb{};
    dcb.DCBlength = sizeof dcb;
    if (!GetCommState(handle, &dcb)) { fail("Falha ao consultar a porta serial", GetLastError()); return false; }
    dcb.BaudRate = baud;
    dcb.ByteSize = dataBits;
    dcb.Parity = parity == Parity::Even ? EVENPARITY : parity == Parity::Odd ? ODDPARITY : NOPARITY;
    dcb.StopBits = stopBits == 2 ? TWOSTOPBITS : ONESTOPBIT;
    dcb.fBinary = TRUE;
    dcb.fParity = parity != Parity::None;
    dcb.fOutxCtsFlow = FALSE;
    dcb.fOutxDsrFlow = FALSE;
    dcb.fDtrControl = DTR_CONTROL_ENABLE;
    dcb.fDsrSensitivity = FALSE;
    dcb.fOutX = FALSE;
    dcb.fInX = FALSE;
    dcb.fRtsControl = RTS_CONTROL_ENABLE;
    dcb.fAbortOnError = FALSE;
    if (!SetCommState(handle, &dcb)) { fail("Configuracao serial invalida", GetLastError()); return false; }
    COMMTIMEOUTS timeouts{};
    timeouts.ReadIntervalTimeout = MAXDWORD; // ReadFile returns at once with what arrived
    if (!SetCommTimeouts(handle, &timeouts)) { fail("Falha ao configurar I/O serial", GetLastError()); return false; }
    SetupComm(handle, 4096, 4096);
    PurgeComm(handle, PURGE_RXCLEAR | PURGE_TXCLEAR);
    return true;
}

void HostSerialPort::close() {
    if (m_handle) CloseHandle(static_cast<HANDLE>(m_handle));
    m_handle = nullptr;
    m_open = false;
}

size_t HostSerialPort::read(uint8_t* out, size_t capacity) {
    if (!m_open || capacity == 0) return 0;
    DWORD got = 0;
    if (!ReadFile(static_cast<HANDLE>(m_handle), out, static_cast<DWORD>(capacity), &got, nullptr)) {
        fail("Erro lendo a porta serial", GetLastError());
        return 0;
    }
    return got;
}

size_t HostSerialPort::write(std::span<const uint8_t> bytes) {
    if (!m_open || bytes.empty()) return 0;
    DWORD sent = 0;
    if (!WriteFile(static_cast<HANDLE>(m_handle), bytes.data(), static_cast<DWORD>(bytes.size()), &sent, nullptr)) {
        fail("Erro escrevendo na porta serial", GetLastError());
        return 0;
    }
    return sent;
}

#else

namespace {
speed_t speedOf(uint32_t baud) {
    switch (baud) {
        case 1200: return B1200;
        case 2400: return B2400;
        case 4800: return B4800;
        case 9600: return B9600;
        case 19200: return B19200;
        case 38400: return B38400;
        default: return 0;
    }
}
} // namespace

bool HostSerialPort::open(const std::string& name, uint32_t baud, uint8_t dataBits, Parity parity, uint8_t stopBits) {
    close();
    m_error.clear();
    const speed_t speed = speedOf(baud);
    if (!speed) { m_error = "Baud rate nao suportado"; return false; }
    m_fd = ::open(name.c_str(), O_RDWR | O_NOCTTY | O_NONBLOCK);
    if (m_fd < 0) { m_error = "Nao foi possivel abrir " + name + " (" + std::to_string(errno) + ")"; return false; }
    m_open = true;
    termios tty{};
    if (tcgetattr(m_fd, &tty) != 0) { fail("Falha ao consultar a porta serial", static_cast<unsigned long>(errno)); return false; }
    tty.c_iflag = 0;
    tty.c_oflag = 0;
    tty.c_lflag = 0;
    tty.c_cflag &= ~(CSIZE | PARENB | PARODD | CSTOPB);
#ifdef CRTSCTS
    tty.c_cflag &= ~CRTSCTS;
#endif
    tty.c_cflag |= CLOCAL | CREAD;
    tty.c_cflag |= dataBits == 7 ? CS7 : CS8;
    if (parity != Parity::None) {
        tty.c_cflag |= PARENB;
        if (parity == Parity::Odd) tty.c_cflag |= PARODD;
    }
    if (stopBits == 2) tty.c_cflag |= CSTOPB;
    tty.c_cc[VMIN] = 0;
    tty.c_cc[VTIME] = 0;
    cfsetispeed(&tty, speed);
    cfsetospeed(&tty, speed);
    if (tcsetattr(m_fd, TCSANOW, &tty) != 0) { fail("Configuracao serial invalida", static_cast<unsigned long>(errno)); return false; }
    tcflush(m_fd, TCIOFLUSH);
    return true;
}

void HostSerialPort::close() {
    if (m_fd >= 0) ::close(m_fd);
    m_fd = -1;
    m_open = false;
}

size_t HostSerialPort::read(uint8_t* out, size_t capacity) {
    if (!m_open || capacity == 0) return 0;
    const ssize_t got = ::read(m_fd, out, capacity);
    if (got < 0) {
        if (errno != EAGAIN && errno != EWOULDBLOCK) fail("Erro lendo a porta serial", static_cast<unsigned long>(errno));
        return 0;
    }
    return static_cast<size_t>(got);
}

size_t HostSerialPort::write(std::span<const uint8_t> bytes) {
    if (!m_open || bytes.empty()) return 0;
    const ssize_t sent = ::write(m_fd, bytes.data(), bytes.size());
    if (sent < 0) {
        if (errno != EAGAIN && errno != EWOULDBLOCK) fail("Erro escrevendo na porta serial", static_cast<unsigned long>(errno));
        return 0;
    }
    return static_cast<size_t>(sent);
}

#endif

} // namespace lasecsimul::protocols
