#include "lasecsimul/device_abi.h"
#include <stddef.h>
#include <stdint.h>

#if defined(_WIN32)
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#else
#include <errno.h>
#include <fcntl.h>
#include <termios.h>
#include <unistd.h>
#endif

/* MinGW on Windows: replace CRT so ucrtbase.dll is never loaded alongside ucrtbased.dll.
 * MSVC builds use the normal CRT (matching the Core), no action needed. */
#if defined(_WIN32) && !defined(_MSC_VER)
BOOL WINAPI DllMainCRTStartup(HINSTANCE h, DWORD r, LPVOID p) {
    (void)h; (void)r; (void)p; return TRUE;
}

static void *_lsdn_calloc(size_t n) {
    return HeapAlloc(GetProcessHeap(), HEAP_ZERO_MEMORY, n);
}
static void _lsdn_free(void *p) {
    if (p) HeapFree(GetProcessHeap(), 0, p);
}

void *memset(void *s, int c, size_t n) {
    unsigned char *p = (unsigned char *)s;
    while (n--) *p++ = (unsigned char)c;
    return s;
}
void *memcpy(void *d, const void *s, size_t n) {
    char *dp = (char *)d;
    const char *sp = (const char *)s;
    while (n--) *dp++ = *sp++;
    return d;
}

static int _lsdn_strcmp(const char *a, const char *b) {
    while (*a && *a == *b) { ++a; ++b; }
    return (unsigned char)*a - (unsigned char)*b;
}
static void _lsdn_strncpy(char *d, const char *s, size_t n) {
    size_t i;
    for (i = 0; i < n && s[i]; i++) d[i] = s[i];
    for (; i < n; i++) d[i] = '\0';
}
static const char *_lsdn_strstr(const char *h, const char *needle) {
    if (!*needle) return h;
    for (; *h; ++h) {
        const char *p = h, *q = needle;
        while (*p && *q && *p == *q) { ++p; ++q; }
        if (!*q) return h;
    }
    return 0;
}

#define calloc(n, sz)    _lsdn_calloc((size_t)(n) * (size_t)(sz))
#define free(p)          _lsdn_free(p)
#define strcmp(a, b)     _lsdn_strcmp(a, b)
#define strncpy(d, s, n) _lsdn_strncpy(d, s, n)
#define strstr(h, nd)    _lsdn_strstr(h, nd)

#else  /* MSVC or non-Windows: use normal CRT */
#include <string.h>
#include <stdlib.h>
#endif

enum {
    KIND_KY023      = 0,
    KIND_KY040      = 1,
    KIND_TOUCHPAD   = 2,
    KIND_DS1307     = 3,
    KIND_SERIALTERM = 4,
    KIND_SERIALPORT = 5,
    KIND_SDCARD     = 6,
    KIND_ESP01      = 7,
    KIND_LASECPLOT  = 8,
};

/* Achado 2026-07-22 (921600 baud perdendo dados): 4096 bytes enchiam em ~44,5ms nesse baud, perto
 * demais do intervalo de poll do consumidor (ver extension/src/lasecplot/broker.ts,
 * UART_RING_CAP_BYTES -- MESMO valor, duas linguagens/repositórios diferentes, não compartilham a
 * constante de verdade). A correção principal é o poll do consumidor se adaptar ao baud
 * configurado; aumentar o anel aqui é só margem extra de segurança, não a correção sozinha. */
#define UART_RING_CAP 16384

typedef struct {
    void *host_ctx;
    const LsdnHostApi *api;
    int kind;

    /* KY-023 */
    int joy_x, joy_y, joy_sw;

    /* KY-040 */
    int32_t enc_pos;
    int     enc_steps_rev, enc_sw, enc_clk_prev;

    /* TouchPad */
    int    tp_width, tp_height;
    int    tp_touch_x, tp_touch_y;
    int    tp_pressed, tp_transparent;
    double tp_rx_min, tp_rx_max;
    double tp_ry_min, tp_ry_max;

    /* DS1307 — BCD time registers [0]=sec [1]=min [2]=hr [3]=dow [4]=date [5]=mon [6]=yr */
    uint8_t rtc_regs[8];
    uint8_t rtc_ptr;
    int     rtc_i2c_addr;
    int     rtc_i2c_state;
    int     rtc_time_updated;
    int     rtc_sqw_freq;
    /* raw user fields */
    int rtc_year, rtc_month, rtc_day;
    int rtc_hour, rtc_min, rtc_sec;

    /* Serial Terminal */
    uint32_t ser_baudrate;
    uint32_t ser_bit_period_ns;
    int      ser_data_bits, ser_stop_bits, ser_parity;
    char     ser_rx_buf[256];
    char     ser_tx_buf[256];
    int      ser_tx_pos;
    int      ser_rx_active, ser_rx_bit_idx, ser_rx_stop_idx, ser_rx_parity_done;
    uint8_t  ser_rx_byte;

    /* Ponte UART genérica usada pelo LasecPlot. O Core drena RX em lotes e enfileira TX.
     *
     * Achado 2026-07-22: corrida de dados real confirmada entre uart_rx_push() (chamado de dentro
     * do callback LSDN_EVT_TIMER que completa um byte -- o host entrega esse callback com o mutex
     * do Scheduler DELIBERADAMENTE liberado, ver hostScheduleEvent/processNextEventUntilLocked em
     * PluginRuntime.cpp/Scheduler.hpp) e uart_drain_hex() (chamado por qualquer leitura concorrente
     * de "uart_rx_hex", ex.: LasecPlotBroker fazendo poll via tryDrainUartRx -- essa leitura usa
     * trySynchronized(), que consegue pegar o mesmo mutex exatamente durante a janela liberada).
     * As duas mexem em uart_rx_head/tail/count/uart_rx_ring sem nenhuma seção crítica compartilhada
     * -- reproduzido com firmware ESP32 real gerando o mesmo padrão de corrupção relatado pelo
     * usuário (bytes embaralhados, sempre no mesmo lugar pro mesmo firmware, já que o tempo virtual
     * determinístico faz a corrida "resolver" sempre igual). uart_ring_lock protege as quatro
     * funções que tocam os aneis RX/TX (uart_rx_push/uart_drain_hex/uart_tx_push/uart_start_tx) --
     * spinlock, não mutex de SO: seções críticas minúsculas (poucas instruções, sem I/O), e o
     * arquivo já evita dependências extras de biblioteca (ver os shims de CRT acima). */
    uint8_t  uart_rx_ring[UART_RING_CAP];
    uint32_t uart_rx_head, uart_rx_tail, uart_rx_count;
    uint32_t uart_rx_dropped;
    uint8_t  uart_tx_ring[UART_RING_CAP];
    uint32_t uart_tx_head, uart_tx_tail, uart_tx_count;
    uint32_t uart_tx_dropped;
    int      uart_tx_active, uart_tx_waiting_stop, uart_tx_bit_idx;
    uint8_t  uart_tx_byte;
    volatile long uart_ring_lock;
    char     uart_hex[(UART_RING_CAP * 2) + 1];
    char     source_name[128];
    char     uart_mode[24];
    int      uart_expose;

    /* Serial Port */
    char     port_name[64];
    uint32_t port_baudrate;
    int      port_data_bits, port_stop_bits;
    int      port_auto_open;
    int      port_open_requested;
    int      port_is_open;
    int      port_initialized;
    int      port_poll_scheduled;
    uint32_t port_rx_bytes;
    uint32_t port_tx_bytes;
    char     port_error[192];
#if defined(_WIN32)
    HANDLE   port_handle;
#else
    int      port_fd;
#endif

    /* SD Card */
    char sd_file[256];

    /* ESP-01 */
    uint32_t esp_baudrate;
    int      esp_debug;
    char     esp_at_buf[256];
    int      esp_at_pos, esp_rx_active, esp_rx_bit_idx;
    uint8_t  esp_rx_byte;
} PeriphState;

static uint32_t uart_tx_push(PeriphState *s, uint8_t byte);
static void uart_start_tx(PeriphState *s);
static void serial_port_close(PeriphState *s);

static void port_set_error(PeriphState *s, const char *prefix, uint32_t code) {
    static const char digits[] = "0123456789";
    char number[16];
    uint32_t n = code;
    int pos = 15;
    size_t used = 0;
    number[pos] = '\0';
    do { number[--pos] = digits[n % 10u]; n /= 10u; } while (n && pos > 0);
    while (prefix[used] && used + 1 < sizeof(s->port_error)) {
        s->port_error[used] = prefix[used]; used++;
    }
    if (used + 2 < sizeof(s->port_error)) { s->port_error[used++] = ' '; s->port_error[used++] = '('; }
    while (number[pos] && used + 2 < sizeof(s->port_error)) s->port_error[used++] = number[pos++];
    if (used + 1 < sizeof(s->port_error)) s->port_error[used++] = ')';
#if defined(_WIN32)
    if (code && used + 3 < sizeof(s->port_error)) {
        WCHAR wide_message[96];
        char utf8_message[128];
        DWORD wide_length = FormatMessageW(FORMAT_MESSAGE_FROM_SYSTEM | FORMAT_MESSAGE_IGNORE_INSERTS,
                                           NULL, code, 0, wide_message, sizeof(wide_message) / sizeof(wide_message[0]), NULL);
        int length = wide_length ? WideCharToMultiByte(CP_UTF8, 0, wide_message, (int)wide_length,
                                                       utf8_message, sizeof(utf8_message), NULL, NULL) : 0;
        int i;
        if (length > 0) {
            s->port_error[used++] = ':'; s->port_error[used++] = ' ';
            for (i = 0; i < length && used + 1 < sizeof(s->port_error); ++i) {
                if (utf8_message[i] != '\r' && utf8_message[i] != '\n') s->port_error[used++] = utf8_message[i];
            }
        }
    }
#else
    if (code && used + 3 < sizeof(s->port_error)) {
        const char *system_message = strerror((int)code);
        size_t i = 0;
        s->port_error[used++] = ':'; s->port_error[used++] = ' ';
        while (system_message[i] && used + 1 < sizeof(s->port_error)) s->port_error[used++] = system_message[i++];
    }
#endif
    s->port_error[used] = '\0';
}

#if !defined(_WIN32)
static speed_t serial_port_speed(uint32_t baud) {
    switch (baud) {
        case 1200: return B1200;
        case 2400: return B2400;
        case 4800: return B4800;
        case 9600: return B9600;
        case 19200: return B19200;
        case 38400: return B38400;
#ifdef B57600
        case 57600: return B57600;
#endif
#ifdef B115200
        case 115200: return B115200;
#endif
        default: return (speed_t)0;
    }
}
#endif

static int serial_port_open(PeriphState *s) {
    serial_port_close(s);
    s->port_open_requested = 1;
    s->port_error[0] = '\0';
    if (!s->port_name[0]) {
        port_set_error(s, "Nome da porta serial vazio", 0);
        return 0;
    }
#if defined(_WIN32)
    {
        char path[80] = "\\\\.\\";
        size_t i = 4, j = 0;
        DCB dcb;
        COMMTIMEOUTS timeouts;
        while (s->port_name[j] && i + 1 < sizeof(path)) path[i++] = s->port_name[j++];
        path[i] = '\0';
        s->port_handle = CreateFileA(path, GENERIC_READ | GENERIC_WRITE, 0, NULL, OPEN_EXISTING,
                                     FILE_ATTRIBUTE_NORMAL, NULL);
        if (s->port_handle == INVALID_HANDLE_VALUE) {
            port_set_error(s, "Nao foi possivel abrir a porta serial; erro do Windows", GetLastError());
            return 0;
        }
        memset(&dcb, 0, sizeof(dcb)); dcb.DCBlength = sizeof(dcb);
        if (!GetCommState(s->port_handle, &dcb)) {
            port_set_error(s, "Falha ao consultar a porta serial; erro do Windows", GetLastError());
            serial_port_close(s); return 0;
        }
        dcb.BaudRate = s->port_baudrate;
        dcb.ByteSize = (BYTE)s->port_data_bits;
        dcb.Parity = s->ser_parity == 1 ? EVENPARITY : s->ser_parity == 2 ? ODDPARITY : NOPARITY;
        dcb.StopBits = s->port_stop_bits == 2 ? TWOSTOPBITS : ONESTOPBIT;
        dcb.fBinary = TRUE; dcb.fParity = s->ser_parity != 0;
        dcb.fOutxCtsFlow = FALSE; dcb.fOutxDsrFlow = FALSE; dcb.fDtrControl = DTR_CONTROL_DISABLE;
        dcb.fDsrSensitivity = FALSE; dcb.fOutX = FALSE; dcb.fInX = FALSE;
        dcb.fRtsControl = RTS_CONTROL_DISABLE; dcb.fAbortOnError = FALSE;
        if (!SetCommState(s->port_handle, &dcb)) {
            port_set_error(s, "Configuracao serial invalida; erro do Windows", GetLastError());
            serial_port_close(s); return 0;
        }
        memset(&timeouts, 0, sizeof(timeouts));
        timeouts.ReadIntervalTimeout = MAXDWORD;
        if (!SetCommTimeouts(s->port_handle, &timeouts)) {
            port_set_error(s, "Falha ao configurar I/O serial; erro do Windows", GetLastError());
            serial_port_close(s); return 0;
        }
        SetupComm(s->port_handle, UART_RING_CAP, UART_RING_CAP);
        PurgeComm(s->port_handle, PURGE_RXCLEAR | PURGE_TXCLEAR);
    }
#else
    {
        struct termios tty;
        speed_t speed = serial_port_speed(s->port_baudrate);
        if (!speed) { port_set_error(s, "Baud rate nao suportado", s->port_baudrate); return 0; }
        s->port_fd = open(s->port_name, O_RDWR | O_NOCTTY | O_NONBLOCK);
        if (s->port_fd < 0) { port_set_error(s, "Nao foi possivel abrir a porta serial", (uint32_t)errno); return 0; }
        if (tcgetattr(s->port_fd, &tty) != 0) {
            port_set_error(s, "Falha ao consultar a porta serial", (uint32_t)errno); serial_port_close(s); return 0;
        }
        tty.c_iflag = 0; tty.c_oflag = 0; tty.c_lflag = 0;
        tty.c_cflag &= ~(CSIZE | PARENB | PARODD | CSTOPB);
#ifdef CRTSCTS
        tty.c_cflag &= ~CRTSCTS;
#endif
        tty.c_cflag |= CLOCAL | CREAD;
        tty.c_cflag |= s->port_data_bits == 5 ? CS5 : s->port_data_bits == 6 ? CS6 : s->port_data_bits == 7 ? CS7 : CS8;
        if (s->ser_parity) { tty.c_cflag |= PARENB; if (s->ser_parity == 2) tty.c_cflag |= PARODD; }
        if (s->port_stop_bits == 2) tty.c_cflag |= CSTOPB;
        tty.c_cc[VMIN] = 0; tty.c_cc[VTIME] = 0;
        cfsetispeed(&tty, speed); cfsetospeed(&tty, speed);
        if (tcsetattr(s->port_fd, TCSANOW, &tty) != 0) {
            port_set_error(s, "Configuracao serial invalida", (uint32_t)errno); serial_port_close(s); return 0;
        }
        tcflush(s->port_fd, TCIOFLUSH);
    }
#endif
    s->port_is_open = 1;
    s->port_error[0] = '\0';
    return 1;
}

static void serial_port_close(PeriphState *s) {
#if defined(_WIN32)
    if (s->port_handle && s->port_handle != INVALID_HANDLE_VALUE) CloseHandle(s->port_handle);
    s->port_handle = INVALID_HANDLE_VALUE;
#else
    if (s->port_fd >= 0) close(s->port_fd);
    s->port_fd = -1;
#endif
    s->port_is_open = 0;
}

static void serial_port_pump(PeriphState *s) {
    uint8_t buffer[512];
    uint32_t count = 0;
    if (!s->port_is_open) return;
#if defined(_WIN32)
    {
        DWORD got = 0;
        if (!ReadFile(s->port_handle, buffer, sizeof(buffer), &got, NULL)) {
            port_set_error(s, "Erro lendo a porta serial; erro do Windows", GetLastError());
            serial_port_close(s); return;
        }
        count = (uint32_t)got;
    }
#else
    {
        ssize_t got = read(s->port_fd, buffer, sizeof(buffer));
        if (got < 0 && errno != EAGAIN && errno != EWOULDBLOCK) {
            port_set_error(s, "Erro lendo a porta serial", (uint32_t)errno); serial_port_close(s); return;
        }
        if (got > 0) count = (uint32_t)got;
    }
#endif
    {
        uint32_t i;
        s->port_tx_bytes += count;
        for (i = 0; i < count; ++i) uart_tx_push(s, buffer[i]);
        if (count && !s->uart_tx_active && !s->uart_tx_waiting_stop) uart_start_tx(s);
    }
    if (s->uart_rx_count) {
        uint32_t contiguous = UART_RING_CAP - s->uart_rx_tail;
        uint32_t wanted = s->uart_rx_count < contiguous ? s->uart_rx_count : contiguous;
        uint32_t written = 0;
        if (wanted > sizeof(buffer)) wanted = sizeof(buffer);
#if defined(_WIN32)
        {
            DWORD errors = 0;
            COMSTAT status;
            DWORD sent = 0;
            memset(&status, 0, sizeof(status));
            if (!ClearCommError(s->port_handle, &errors, &status)) {
                port_set_error(s, "Erro consultando a porta serial; erro do Windows", GetLastError());
                serial_port_close(s); return;
            }
            if (status.cbOutQue >= UART_RING_CAP) return;
            if (wanted > UART_RING_CAP - status.cbOutQue) wanted = UART_RING_CAP - status.cbOutQue;
            if (!WriteFile(s->port_handle, s->uart_rx_ring + s->uart_rx_tail, wanted, &sent, NULL)) {
                port_set_error(s, "Erro escrevendo na porta serial; erro do Windows", GetLastError());
                serial_port_close(s); return;
            }
            written = (uint32_t)sent;
        }
#else
        {
            ssize_t sent = write(s->port_fd, s->uart_rx_ring + s->uart_rx_tail, wanted);
            if (sent < 0 && errno != EAGAIN && errno != EWOULDBLOCK) {
                port_set_error(s, "Erro escrevendo na porta serial", (uint32_t)errno); serial_port_close(s); return;
            }
            if (sent > 0) written = (uint32_t)sent;
        }
#endif
        s->uart_rx_tail = (s->uart_rx_tail + written) % UART_RING_CAP;
        s->uart_rx_count -= written;
        s->port_rx_bytes += written;
    }
}

/* ------------------------------------------------------------------ */
/*  Config helpers                                                      */
/* ------------------------------------------------------------------ */
static const char *cfg_str(PeriphState *s, const char *name, const char *fallback) {
    static char buf[96];
    LsdnPropertyValue v;
    memset(&v, 0, sizeof(v));
    if (s->api->config_get && s->api->config_get(s->host_ctx, name, &v)
            && v.kind == LSDN_PROPERTY_STRING && v.string_value) {
        strncpy(buf, v.string_value, sizeof(buf) - 1);
        buf[sizeof(buf) - 1] = '\0';
        return buf;
    }
    return fallback;
}

static double cfg_num(PeriphState *s, const char *name, double fallback) {
    LsdnPropertyValue v;
    memset(&v, 0, sizeof(v));
    if (s->api->config_get && s->api->config_get(s->host_ctx, name, &v)
            && v.kind == LSDN_PROPERTY_NUMBER)
        return v.number_value;
    return fallback;
}

static int cfg_bool(PeriphState *s, const char *name, int fallback) {
    LsdnPropertyValue v;
    memset(&v, 0, sizeof(v));
    if (s->api->config_get && s->api->config_get(s->host_ctx, name, &v)
            && v.kind == LSDN_PROPERTY_BOOL)
        return v.bool_value != 0;
    return fallback;
}

static int hex_value(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}

/* Spinlock mínimo (não mutex de SO) para as seções críticas dos anéis RX/TX -- ver comentário em
 * uart_ring_lock. Seções protegidas são poucas instruções sem I/O, então girar é mais barato e
 * mais simples que trazer pthread/CRT threading pra um plugin que já evita dependências extras. */
static void uart_ring_lock_acquire(volatile long *lock) {
#if defined(_WIN32)
    while (InterlockedExchange(lock, 1) != 0) { /* spin */ }
#else
    while (__sync_lock_test_and_set(lock, 1)) { /* spin */ }
#endif
}
static void uart_ring_lock_release(volatile long *lock) {
#if defined(_WIN32)
    InterlockedExchange(lock, 0);
#else
    __sync_lock_release(lock);
#endif
}

/* UartTR/UsartModule do SimulIDE: uma fila opaca em cada direção, compartilhada pelos consumidores
 * SerialTerm e LasecPlot. RX aqui significa "recebido do MCU"; TX significa "a transmitir ao MCU". */
static void uart_rx_push(PeriphState *s, uint8_t byte) {
    uart_ring_lock_acquire(&s->uart_ring_lock);
    if (s->uart_rx_count == UART_RING_CAP) { /* bounded: discard oldest, preserve newest stream */
        s->uart_rx_tail = (s->uart_rx_tail + 1u) % UART_RING_CAP;
        s->uart_rx_count--;
        s->uart_rx_dropped++;
    }
    s->uart_rx_ring[s->uart_rx_head] = byte;
    s->uart_rx_head = (s->uart_rx_head + 1u) % UART_RING_CAP;
    s->uart_rx_count++;
    uart_ring_lock_release(&s->uart_ring_lock);
}

static uint32_t uart_tx_push(PeriphState *s, uint8_t byte) {
    uint32_t accepted;
    uart_ring_lock_acquire(&s->uart_ring_lock);
    if (s->uart_tx_count == UART_RING_CAP) {
        s->uart_tx_dropped++;
        accepted = 0;
    } else {
        s->uart_tx_ring[s->uart_tx_head] = byte;
        s->uart_tx_head = (s->uart_tx_head + 1u) % UART_RING_CAP;
        s->uart_tx_count++;
        accepted = 1;
    }
    uart_ring_lock_release(&s->uart_ring_lock);
    return accepted;
}

static int uart_parity_bit(PeriphState *s, uint8_t byte) {
    int parity = 0, i;
    for (i = 0; i < s->ser_data_bits; ++i) parity ^= (byte >> (unsigned)i) & 1u;
    return s->ser_parity == 2 ? !parity : parity; /* 1=even, 2=odd */
}

static uint32_t uart_enqueue_hex(PeriphState *s, const char *p) {
    uint32_t accepted = 0;
    while (p && p[0] && p[1]) {
        int hi = hex_value(p[0]), lo = hex_value(p[1]);
        if (hi < 0 || lo < 0 || !uart_tx_push(s, (uint8_t)((hi << 4) | lo))) break;
        accepted++; p += 2;
    }
    return accepted;
}

static const char *uart_drain_hex(PeriphState *s) {
    static const char digits[] = "0123456789abcdef";
    uint32_t n = 0;
    uart_ring_lock_acquire(&s->uart_ring_lock);
    while (s->uart_rx_count && n < UART_RING_CAP) {
        uint8_t byte = s->uart_rx_ring[s->uart_rx_tail];
        s->uart_rx_tail = (s->uart_rx_tail + 1u) % UART_RING_CAP;
        s->uart_rx_count--;
        s->uart_hex[n*2] = digits[byte >> 4];
        s->uart_hex[n*2+1] = digits[byte & 15];
        n++;
    }
    s->uart_hex[n*2] = '\0';
    uart_ring_lock_release(&s->uart_ring_lock);
    return s->uart_hex;
}

static void uart_start_tx(PeriphState *s) {
    uart_ring_lock_acquire(&s->uart_ring_lock);
    if (s->uart_tx_active || s->uart_tx_waiting_stop || s->uart_tx_count == 0) {
        uart_ring_lock_release(&s->uart_ring_lock);
        return;
    }
    s->uart_tx_byte = s->uart_tx_ring[s->uart_tx_tail];
    s->uart_tx_tail = (s->uart_tx_tail + 1u) % UART_RING_CAP;
    s->uart_tx_count--;
    uart_ring_lock_release(&s->uart_ring_lock);
    s->uart_tx_active = 1;
    s->uart_tx_bit_idx = -1; /* start bit */
    s->api->pin_write(s->host_ctx, 0, 0);
    s->api->schedule_event(s->host_ctx, s->ser_bit_period_ns, 21u);
}

/* ------------------------------------------------------------------ */
/*  BCD helpers                                                         */
/* ------------------------------------------------------------------ */
static uint8_t to_bcd(int v) { return (uint8_t)(((v / 10) << 4) | (v % 10)); }
static int     from_bcd(uint8_t b) { return ((b >> 4) * 10) + (b & 0x0F); }

static void rtc_load_regs(PeriphState *s) {
    int yr = s->rtc_year % 100;
    s->rtc_regs[0] = to_bcd(s->rtc_sec   & 0x3F);  /* CH bit cleared = clock running */
    s->rtc_regs[1] = to_bcd(s->rtc_min   & 0x3F);
    s->rtc_regs[2] = to_bcd(s->rtc_hour  & 0x3F);  /* 24h mode */
    s->rtc_regs[3] = 1;                              /* day-of-week = Monday */
    s->rtc_regs[4] = to_bcd(s->rtc_day   & 0x3F);
    s->rtc_regs[5] = to_bcd(s->rtc_month & 0x1F);
    s->rtc_regs[6] = to_bcd(yr & 0xFF);
    s->rtc_regs[7] = 0x10; /* 1Hz SQW */
}

static void rtc_tick(PeriphState *s) {
    s->rtc_sec++;
    if (s->rtc_sec >= 60) { s->rtc_sec = 0; s->rtc_min++; }
    if (s->rtc_min >= 60) { s->rtc_min = 0; s->rtc_hour++; }
    if (s->rtc_hour >= 24){ s->rtc_hour = 0; s->rtc_day++; }
    /* Simplified: no month-end rollover */
    if (s->rtc_day > 31)  { s->rtc_day = 1; s->rtc_month++; }
    if (s->rtc_month > 12){ s->rtc_month = 1; s->rtc_year++; }
    rtc_load_regs(s);
}

/* ------------------------------------------------------------------ */
/*  KY-040 quadrature output                                            */
/* ------------------------------------------------------------------ */
static void enc_update(PeriphState *s) {
    int steps = s->enc_steps_rev > 0 ? s->enc_steps_rev : 1;
    int phase = ((s->enc_pos % steps) + steps) % 4;
    int clk   = (phase == 0 || phase == 1) ? 1 : 0;
    int dt    = (phase == 0 || phase == 3) ? 1 : 0;
    /* SimulIDE pin order: SW=0, DT=1, CLK=2 */
    s->api->pin_write(s->host_ctx, 2, clk);
    s->api->pin_write(s->host_ctx, 1, dt);
    s->api->pin_write(s->host_ctx, 0, s->enc_sw ? 0 : 1);
}

/* ------------------------------------------------------------------ */
/*  VTable                                                              */
/* ------------------------------------------------------------------ */
static LsdnDevice *periph_create(void *host_ctx, const LsdnHostApi *api) {
    PeriphState *s = (PeriphState *)calloc(1, sizeof(PeriphState));
    if (!s) return NULL;
    s->host_ctx = host_ctx;
    s->api      = api;
    return (LsdnDevice *)s;
}

static void periph_init(LsdnDevice *dev) {
    PeriphState *s = (PeriphState *)dev;

    const char *tid = cfg_str(s, "__typeId", "peripherals.ky023");
    if      (strstr(tid, "ky023"))      s->kind = KIND_KY023;
    else if (strstr(tid, "ky040"))      s->kind = KIND_KY040;
    else if (strstr(tid, "touchpad"))   s->kind = KIND_TOUCHPAD;
    else if (strstr(tid, "ds1307"))     s->kind = KIND_DS1307;
    else if (strstr(tid, "serialterm")) s->kind = KIND_SERIALTERM;
    else if (strstr(tid, "serialport")) s->kind = KIND_SERIALPORT;
    else if (strstr(tid, "sdcard"))     s->kind = KIND_SDCARD;
    else if (strstr(tid, "esp01"))      s->kind = KIND_ESP01;
    else if (strstr(tid, "lasecplot"))  s->kind = KIND_LASECPLOT;

    s->joy_x  = (int)cfg_num(s, "x_pos",      512.0);
    s->joy_y  = (int)cfg_num(s, "y_pos",       512.0);
    s->joy_sw = (int)cfg_num(s, "sw_pressed",  0.0);

    s->enc_steps_rev = (int)cfg_num(s, "steps_rev", 20.0);
    s->enc_pos       = (int32_t)cfg_num(s, "position", 0.0);

    s->tp_width       = (int)cfg_num(s, "width",       240.0);
    s->tp_height      = (int)cfg_num(s, "height",      320.0);
    s->tp_touch_x     = (int)cfg_num(s, "touch_x",     120.0);
    s->tp_touch_y     = (int)cfg_num(s, "touch_y",     160.0);
    s->tp_pressed     = (int)cfg_num(s, "pressed",     0.0);
    s->tp_transparent = (int)cfg_num(s, "transparent", 0.0);
    s->tp_rx_min      = cfg_num(s, "rx_min", 100.0);
    s->tp_rx_max      = cfg_num(s, "rx_max", 500.0);
    s->tp_ry_min      = cfg_num(s, "ry_min", 100.0);
    s->tp_ry_max      = cfg_num(s, "ry_max", 500.0);

    s->rtc_year  = (int)cfg_num(s, "year",   2024.0);
    s->rtc_month = (int)cfg_num(s, "month",  1.0);
    s->rtc_day   = (int)cfg_num(s, "day",    1.0);
    s->rtc_hour  = (int)cfg_num(s, "hour",   0.0);
    s->rtc_min   = (int)cfg_num(s, "minute", 0.0);
    s->rtc_sec   = (int)cfg_num(s, "second", 0.0);
    s->rtc_sqw_freq = (int)cfg_num(s, "sqw_freq", 1.0);
    rtc_load_regs(s);

    s->ser_baudrate      = (uint32_t)cfg_num(s, "baudrate",  9600.0);
    s->ser_bit_period_ns = s->ser_baudrate > 0 ? 1000000000u / s->ser_baudrate : 104167u;
    s->ser_data_bits     = (int)cfg_num(s, "data_bits", 8.0);
    s->ser_stop_bits     = (int)cfg_num(s, "stop_bits", 1.0);
    {
        const char *parity = cfg_str(s, "parity", "none");
        s->ser_parity = !strcmp(parity, "even") ? 1 : !strcmp(parity, "odd") ? 2 : 0;
    }
    strncpy(s->source_name, cfg_str(s, "source_name", "LasecPlot 1"), sizeof(s->source_name)-1);
    strncpy(s->uart_mode, cfg_str(s, "mode", "read-only"), sizeof(s->uart_mode)-1);
    s->uart_expose = (int)cfg_num(s, "expose", 1.0);

    strncpy(s->port_name, cfg_str(s, "port_name", "COM1"), sizeof(s->port_name) - 1);
    s->port_baudrate  = (uint32_t)cfg_num(s, "baudrate",   9600.0);
    s->port_data_bits = (int)cfg_num(s, "data_bits", 8.0);
    s->port_stop_bits = (int)cfg_num(s, "stop_bits", 1.0);
    s->port_auto_open = cfg_bool(s, "auto_open", 0);
    s->port_open_requested = s->port_auto_open;
#if defined(_WIN32)
    s->port_handle = INVALID_HANDLE_VALUE;
#else
    s->port_fd = -1;
#endif

    strncpy(s->sd_file, cfg_str(s, "file", ""), sizeof(s->sd_file) - 1);

    s->esp_baudrate = (uint32_t)cfg_num(s, "baudrate", 115200.0);
    s->esp_debug    = (int)cfg_num(s, "debug", 0.0);

    if (s->kind == KIND_DS1307)
        s->api->schedule_event(s->host_ctx, 1000000000u, 10u);
}

static void periph_stamp(LsdnDevice *dev, LsdnMatrixView *m) {
    PeriphState *s = (PeriphState *)dev;
    if (!m) return;

    if (s->kind == KIND_SERIALTERM || s->kind == KIND_LASECPLOT || s->kind == KIND_SERIALPORT) {
        /* IoPin(input) do SimulIDE nunca é uma linha matematicamente sem impedância. Sem esta fuga
         * de 1 GOhm o RX aberto deixa o grupo MNA (que também contém TX) singular e zera a UART.
         * É parte do modelo de entrada, não um pino/terminal GND do dispositivo. */
        m->add_conductance_to_ground(m->opaque, 1, 1e-9);
        if (!s->uart_tx_active && !s->uart_tx_waiting_stop && s->uart_tx_count > 0) uart_start_tx(s);
        else if (!s->uart_tx_active) s->api->pin_write(s->host_ctx, 0, 1); /* stop/idle UART */
        if (s->kind == KIND_SERIALPORT && !s->port_initialized) {
            s->port_initialized = 1;
            if (s->port_open_requested) serial_port_open(s);
        }
        if (s->kind == KIND_SERIALPORT && !s->port_poll_scheduled) {
            s->port_poll_scheduled = 1;
            s->api->schedule_event(s->host_ctx, 1000000u, 40u);
        }
    }

    switch (s->kind) {
        case KIND_KY023: {
            /* SimulIDE pin order: VRX=0, VRY=1, SW=2 */
            double vcc = 5.0;
            double vx  = (s->joy_x / 1023.0) * vcc;
            double vy  = (s->joy_y / 1023.0) * vcc;
            double vsw = s->joy_sw ? 0.0 : vcc;
            double G   = 1e6;
            m->add_conductance_to_ground(m->opaque, 0, G);
            m->add_current_to_ground(m->opaque, 0, vx  * G);
            m->add_conductance_to_ground(m->opaque, 1, G);
            m->add_current_to_ground(m->opaque, 1, vy  * G);
            m->add_conductance_to_ground(m->opaque, 2, G);
            m->add_current_to_ground(m->opaque, 2, vsw * G);
            break;
        }
        case KIND_TOUCHPAD: {
            /*
             * 4-wire resistive model:
             * pins: XP=0, XM=1, YP=2, YM=3
             * When pressed, X position appears on YP (pin2) and Y position on XM (pin1)
             * using Thevenin equivalent with Rx/Ry resistances.
             */
            if (s->tp_pressed) {
                double w   = s->tp_width  > 0 ? (double)s->tp_width  : 1.0;
                double h   = s->tp_height > 0 ? (double)s->tp_height : 1.0;
                double vcc = 5.0;
                /* X measurement: XP=VCC, XM=GND → voltage divider on Y axis */
                double rx  = s->tp_rx_min + (s->tp_rx_max - s->tp_rx_min) * (s->tp_touch_x / w);
                double ry  = s->tp_ry_min + (s->tp_ry_max - s->tp_ry_min) * (s->tp_touch_y / h);
                double vx  = vcc * rx / (s->tp_rx_max > 0.0 ? s->tp_rx_max : 1.0);
                double vy  = vcc * ry / (s->tp_ry_max > 0.0 ? s->tp_ry_max : 1.0);
                double G   = 1e6;
                /* YP output = X position voltage */
                m->add_conductance_to_ground(m->opaque, 2, G);
                m->add_current_to_ground(m->opaque, 2, vx * G);
                /* XM output = Y position voltage */
                m->add_conductance_to_ground(m->opaque, 1, G);
                m->add_current_to_ground(m->opaque, 1, vy * G);
            }
            break;
        }
        default:
            break;
    }
}

static void periph_post_step(LsdnDevice *dev, uint64_t dt_ns) {
    PeriphState *s = (PeriphState *)dev;
    (void)dt_ns;
    (void)s;
}

static void periph_on_event(LsdnDevice *dev, const LsdnEvent *ev) {
    PeriphState *s = (PeriphState *)dev;
    if (!ev) return;

    if (ev->tag == LSDN_EVT_PIN_CHANGE) {
        switch (s->kind) {
            case KIND_KY040:
                /* SimulIDE pin order: SW=0, DT=1, CLK=2 */
                if (ev->a == 2) {
                    int clk_now = (int)ev->b;
                    if (clk_now && !s->enc_clk_prev) {
                        int dt_level = s->api->pin_read(s->host_ctx, 1);
                        if (dt_level) s->enc_pos--;
                        else          s->enc_pos++;
                        enc_update(s);
                    }
                    s->enc_clk_prev = clk_now;
                }
                break;
            case KIND_SERIALTERM:
            case KIND_LASECPLOT:
            case KIND_SERIALPORT:
                /* RX = pin 1; detect start bit (high→low) */
                if (ev->a == 1 && ev->b == 0 && !s->ser_rx_active) {
                    s->ser_rx_active  = 1;
                    s->ser_rx_bit_idx = 0;
                    s->ser_rx_stop_idx = 0;
                    s->ser_rx_parity_done = 0;
                    s->ser_rx_byte    = 0;
                    s->api->schedule_event(s->host_ctx,
                        (uint64_t)(s->ser_bit_period_ns * 3 / 2), 20u);
                }
                break;
            case KIND_ESP01:
                /* RX = pin 1 */
                if (ev->a == 1 && ev->b == 0 && !s->esp_rx_active) {
                    uint64_t period_ns = s->esp_baudrate > 0 ? 1000000000u / s->esp_baudrate : 8681u;
                    s->esp_rx_active  = 1;
                    s->esp_rx_bit_idx = 0;
                    s->esp_rx_byte    = 0;
                    s->api->schedule_event(s->host_ctx, period_ns * 3 / 2, 30u);
                }
                break;
            default:
                break;
        }
    } else if (ev->tag == LSDN_EVT_TIMER) {
        uint32_t id = ev->a;
        switch (s->kind) {
            case KIND_DS1307:
                if (id == 10u) {
                    rtc_tick(s);
                    s->api->schedule_event(s->host_ctx, 1000000000u, 10u);
                    /* Toggle SQW at 1Hz */
                    int sqw = (s->rtc_sec & 1);
                    s->api->pin_write(s->host_ctx, 2, sqw);
                }
                break;
            case KIND_SERIALTERM:
            case KIND_LASECPLOT:
            case KIND_SERIALPORT:
                if (id == 40u) {
                    serial_port_pump(s);
                    s->api->schedule_event(s->host_ctx, 1000000u, 40u);
                    break;
                }
                if (id == 20u) {
                    int data_bits = s->ser_data_bits > 0 ? s->ser_data_bits : 8;
                    if (s->ser_rx_bit_idx < data_bits) {
                        int bit = s->api->pin_read(s->host_ctx, 1);
                        if (bit) s->ser_rx_byte |= (1u << (unsigned)s->ser_rx_bit_idx);
                        s->ser_rx_bit_idx++;
                        s->api->schedule_event(s->host_ctx, s->ser_bit_period_ns, 20u);
                    } else if (s->ser_parity && !s->ser_rx_parity_done) {
                        int parity = s->api->pin_read(s->host_ctx, 1);
                        s->ser_rx_parity_done = 1;
                        if (parity != uart_parity_bit(s, s->ser_rx_byte)) {
                            s->ser_rx_active = 0; s->ser_rx_bit_idx = 0; break;
                        }
                        s->api->schedule_event(s->host_ctx, s->ser_bit_period_ns, 20u);
                    } else {
                        /* Igual UartRx::byteReceived do SimulIDE: stop bit baixo invalida frame. */
                        if (!s->api->pin_read(s->host_ctx, 1)) {
                            s->ser_rx_active = 0; s->ser_rx_bit_idx = 0; break;
                        }
                        s->ser_rx_stop_idx++;
                        if (s->ser_rx_stop_idx < (s->ser_stop_bits > 0 ? s->ser_stop_bits : 1)) {
                            s->api->schedule_event(s->host_ctx, s->ser_bit_period_ns, 20u); break;
                        }
                        uart_rx_push(s, s->ser_rx_byte);
                        /* Compatibilidade com o antigo readout textual do SerialTerm. A ponte real
                         * usa uart_rx_hex e portanto preserva NUL/0xff e qualquer outro byte. */
                        if (s->kind == KIND_SERIALTERM) {
                            int pos = s->ser_tx_pos;
                            if (pos < 255) { s->ser_tx_buf[pos] = (char)s->ser_rx_byte; s->ser_tx_buf[pos+1] = '\0'; s->ser_tx_pos = pos + 1; }
                        }
                        s->ser_rx_active  = 0;
                        s->ser_rx_bit_idx = 0;
                    }
                }
                if (id == 21u && s->uart_tx_active) {
                    s->uart_tx_bit_idx++;
                    if (s->uart_tx_bit_idx < s->ser_data_bits) {
                        s->api->pin_write(s->host_ctx, 0,
                            (s->uart_tx_byte >> (unsigned)s->uart_tx_bit_idx) & 1u);
                        s->api->schedule_event(s->host_ctx, s->ser_bit_period_ns, 21u);
                    } else if (s->ser_parity && s->uart_tx_bit_idx == s->ser_data_bits) {
                        s->api->pin_write(s->host_ctx, 0, uart_parity_bit(s, s->uart_tx_byte));
                        s->api->schedule_event(s->host_ctx, s->ser_bit_period_ns, 21u);
                    } else {
                        s->api->pin_write(s->host_ctx, 0, 1);
                        s->uart_tx_active = 0;
                        s->uart_tx_waiting_stop = 1;
                        s->api->schedule_event(s->host_ctx,
                            s->ser_bit_period_ns * (uint64_t)(s->ser_stop_bits > 0 ? s->ser_stop_bits : 1), 22u);
                    }
                }
                if (id == 22u) { s->uart_tx_waiting_stop = 0; uart_start_tx(s); }
                break;
            case KIND_ESP01:
                if (id == 30u) {
                    if (s->esp_rx_bit_idx < 8) {
                        int bit = s->api->pin_read(s->host_ctx, 1);
                        if (bit) s->esp_rx_byte |= (1u << (unsigned)s->esp_rx_bit_idx);
                        s->esp_rx_bit_idx++;
                        uint64_t period_ns = s->esp_baudrate > 0 ? 1000000000u / s->esp_baudrate : 8681u;
                        s->api->schedule_event(s->host_ctx, period_ns, 30u);
                    } else {
                        int pos = s->esp_at_pos;
                        if (pos < 255) {
                            s->esp_at_buf[pos]   = (char)s->esp_rx_byte;
                            s->esp_at_buf[pos+1] = '\0';
                            s->esp_at_pos = pos + 1;
                        }
                        s->esp_rx_active  = 0;
                        s->esp_rx_bit_idx = 0;
                        if (s->esp_at_pos >= 4 && s->esp_at_buf[s->esp_at_pos-1] == '\n'
                                && s->esp_at_buf[s->esp_at_pos-2] == '\r') {
                            s->esp_at_pos = 0;
                        }
                    }
                }
                break;
            default:
                break;
        }
    }
}

static uint32_t periph_get_property(LsdnDevice *dev, const char *name, LsdnPropertyValue *out) {
    PeriphState *s = (PeriphState *)dev;
    if (!name || !out) return 0;
    memset(out, 0, sizeof(*out));

#define RET_NUM(field)  do { out->kind = LSDN_PROPERTY_NUMBER; out->number_value = (double)(field); return 1; } while(0)
#define RET_BOOL(field) do { out->kind = LSDN_PROPERTY_BOOL;   out->bool_value   = (field) ? 1 : 0; return 1; } while(0)
#define RET_STR(field)  do { out->kind = LSDN_PROPERTY_STRING; out->string_value  = (field); return 1; } while(0)

    switch (s->kind) {
        case KIND_KY023:
            if (!strcmp(name,"x_pos"))      RET_NUM(s->joy_x);
            if (!strcmp(name,"y_pos"))      RET_NUM(s->joy_y);
            if (!strcmp(name,"sw_pressed")) RET_BOOL(s->joy_sw);
            break;
        case KIND_KY040:
            if (!strcmp(name,"position"))   RET_NUM(s->enc_pos);
            if (!strcmp(name,"steps_rev"))  RET_NUM(s->enc_steps_rev);
            if (!strcmp(name,"sw_pressed")) RET_BOOL(s->enc_sw);
            break;
        case KIND_TOUCHPAD:
            if (!strcmp(name,"width"))       RET_NUM(s->tp_width);
            if (!strcmp(name,"height"))      RET_NUM(s->tp_height);
            if (!strcmp(name,"touch_x"))    RET_NUM(s->tp_touch_x);
            if (!strcmp(name,"touch_y"))    RET_NUM(s->tp_touch_y);
            if (!strcmp(name,"pressed"))    RET_BOOL(s->tp_pressed);
            if (!strcmp(name,"transparent"))RET_BOOL(s->tp_transparent);
            if (!strcmp(name,"rx_min"))     RET_NUM(s->tp_rx_min);
            if (!strcmp(name,"rx_max"))     RET_NUM(s->tp_rx_max);
            if (!strcmp(name,"ry_min"))     RET_NUM(s->tp_ry_min);
            if (!strcmp(name,"ry_max"))     RET_NUM(s->tp_ry_max);
            break;
        case KIND_DS1307:
            if (!strcmp(name,"year"))         RET_NUM(s->rtc_year);
            if (!strcmp(name,"month"))        RET_NUM(s->rtc_month);
            if (!strcmp(name,"day"))          RET_NUM(s->rtc_day);
            if (!strcmp(name,"hour"))         RET_NUM(s->rtc_hour);
            if (!strcmp(name,"minute"))       RET_NUM(s->rtc_min);
            if (!strcmp(name,"second"))       RET_NUM(s->rtc_sec);
            if (!strcmp(name,"sqw_freq"))     RET_NUM(s->rtc_sqw_freq);
            if (!strcmp(name,"time_updated")) RET_BOOL(s->rtc_time_updated);
            break;
        case KIND_SERIALTERM:
            if (!strcmp(name,"baudrate"))  RET_NUM(s->ser_baudrate);
            if (!strcmp(name,"data_bits")) RET_NUM(s->ser_data_bits);
            if (!strcmp(name,"stop_bits")) RET_NUM(s->ser_stop_bits);
            if (!strcmp(name,"parity")) RET_STR(s->ser_parity == 1 ? "even" : s->ser_parity == 2 ? "odd" : "none");
            if (!strcmp(name,"rx_buffer")) RET_STR(s->ser_rx_buf);
            if (!strcmp(name,"tx_bytes"))  RET_STR(s->ser_tx_buf);
            if (!strcmp(name,"uart_tx_hex")) RET_STR("");
            if (!strcmp(name,"uart_rx_hex")) RET_STR(uart_drain_hex(s));
            if (!strcmp(name,"uart_rx_pending")) RET_NUM(s->uart_rx_count);
            if (!strcmp(name,"uart_tx_pending")) RET_NUM(s->uart_tx_count + ((s->uart_tx_active || s->uart_tx_waiting_stop) ? 1 : 0));
            if (!strcmp(name,"uart_rx_dropped")) RET_NUM(s->uart_rx_dropped);
            if (!strcmp(name,"uart_tx_dropped")) RET_NUM(s->uart_tx_dropped);
            break;
        case KIND_LASECPLOT:
            if (!strcmp(name,"source_name")) RET_STR(s->source_name);
            if (!strcmp(name,"baudrate")) RET_NUM(s->ser_baudrate);
            if (!strcmp(name,"data_bits")) RET_NUM(s->ser_data_bits);
            if (!strcmp(name,"stop_bits")) RET_NUM(s->ser_stop_bits);
            if (!strcmp(name,"parity")) RET_STR(s->ser_parity == 1 ? "even" : s->ser_parity == 2 ? "odd" : "none");
            if (!strcmp(name,"mode")) RET_STR(s->uart_mode);
            if (!strcmp(name,"expose")) RET_BOOL(s->uart_expose);
            if (!strcmp(name,"uart_tx_hex") || !strcmp(name,"interop_tx_hex")) RET_STR("");
            if (!strcmp(name,"uart_rx_hex") || !strcmp(name,"interop_rx_hex")) RET_STR(uart_drain_hex(s));
            if (!strcmp(name,"uart_rx_pending")) RET_NUM(s->uart_rx_count);
            if (!strcmp(name,"uart_tx_pending")) RET_NUM(s->uart_tx_count + ((s->uart_tx_active || s->uart_tx_waiting_stop) ? 1 : 0));
            if (!strcmp(name,"uart_rx_dropped")) RET_NUM(s->uart_rx_dropped);
            if (!strcmp(name,"uart_tx_dropped")) RET_NUM(s->uart_tx_dropped);
            break;
        case KIND_SERIALPORT:
            if (!strcmp(name,"port_name")) RET_STR(s->port_name);
            if (!strcmp(name,"baudrate"))  RET_NUM(s->port_baudrate);
            if (!strcmp(name,"data_bits")) RET_NUM(s->port_data_bits);
            if (!strcmp(name,"stop_bits")) RET_NUM(s->port_stop_bits);
            if (!strcmp(name,"auto_open")) RET_BOOL(s->port_auto_open);
            if (!strcmp(name,"port_open")) RET_BOOL(s->port_open_requested);
            if (!strcmp(name,"port_is_open")) RET_BOOL(s->port_is_open);
            if (!strcmp(name,"port_error")) RET_STR(s->port_error);
            if (!strcmp(name,"port_rx_bytes")) RET_NUM(s->port_rx_bytes);
            if (!strcmp(name,"port_tx_bytes")) RET_NUM(s->port_tx_bytes);
            break;
        case KIND_SDCARD:
            if (!strcmp(name,"file")) RET_STR(s->sd_file);
            break;
        case KIND_ESP01:
            if (!strcmp(name,"baudrate")) RET_NUM(s->esp_baudrate);
            if (!strcmp(name,"debug"))    RET_BOOL(s->esp_debug);
            break;
        default: break;
    }
#undef RET_NUM
#undef RET_BOOL
#undef RET_STR
    return 0;
}

static uint32_t periph_set_property(LsdnDevice *dev, const char *name, const LsdnPropertyValue *val) {
    PeriphState *s = (PeriphState *)dev;
    if (!name || !val) return 0;
    double n = val->number_value;
    int    b = val->bool_value;

    switch (s->kind) {
        case KIND_KY023:
            if (!strcmp(name,"x_pos"))      { s->joy_x  = (int)n; if (s->joy_x<0) s->joy_x=0; if (s->joy_x>1023) s->joy_x=1023; return 1; }
            if (!strcmp(name,"y_pos"))      { s->joy_y  = (int)n; if (s->joy_y<0) s->joy_y=0; if (s->joy_y>1023) s->joy_y=1023; return 1; }
            if (!strcmp(name,"sw_pressed")) { s->joy_sw = b; return 1; }
            break;
        case KIND_KY040:
            if (!strcmp(name,"position"))   { s->enc_pos = (int32_t)n; enc_update(s); return 1; }
            if (!strcmp(name,"steps_rev"))  { s->enc_steps_rev = (int)n > 0 ? (int)n : 1; return 1; }
            if (!strcmp(name,"sw_pressed")) { s->enc_sw = b; enc_update(s); return 1; }
            break;
        case KIND_TOUCHPAD:
            if (!strcmp(name,"width"))       { s->tp_width   = (int)n>0?(int)n:1; return 1; }
            if (!strcmp(name,"height"))      { s->tp_height  = (int)n>0?(int)n:1; return 1; }
            if (!strcmp(name,"touch_x"))    { s->tp_touch_x = (int)n; return 1; }
            if (!strcmp(name,"touch_y"))    { s->tp_touch_y = (int)n; return 1; }
            if (!strcmp(name,"pressed"))    { s->tp_pressed    = b; return 1; }
            if (!strcmp(name,"transparent")){ s->tp_transparent = b; return 1; }
            if (!strcmp(name,"rx_min"))     { s->tp_rx_min = n; return 1; }
            if (!strcmp(name,"rx_max"))     { s->tp_rx_max = n; return 1; }
            if (!strcmp(name,"ry_min"))     { s->tp_ry_min = n; return 1; }
            if (!strcmp(name,"ry_max"))     { s->tp_ry_max = n; return 1; }
            break;
        case KIND_DS1307:
            if (!strcmp(name,"year"))         { s->rtc_year  = (int)n; rtc_load_regs(s); return 1; }
            if (!strcmp(name,"month"))        { s->rtc_month = (int)n; rtc_load_regs(s); return 1; }
            if (!strcmp(name,"day"))          { s->rtc_day   = (int)n; rtc_load_regs(s); return 1; }
            if (!strcmp(name,"hour"))         { s->rtc_hour  = (int)n; rtc_load_regs(s); return 1; }
            if (!strcmp(name,"minute"))       { s->rtc_min   = (int)n; rtc_load_regs(s); return 1; }
            if (!strcmp(name,"second"))       { s->rtc_sec   = (int)n; rtc_load_regs(s); return 1; }
            if (!strcmp(name,"sqw_freq"))     { s->rtc_sqw_freq = (int)n; return 1; }
            if (!strcmp(name,"time_updated")) { s->rtc_time_updated = b; return 1; }
            break;
        case KIND_SERIALTERM:
            if (!strcmp(name,"baudrate")) {
                s->ser_baudrate      = (uint32_t)n;
                s->ser_bit_period_ns = s->ser_baudrate > 0 ? 1000000000u / s->ser_baudrate : 104167u;
                return 1;
            }
            if (!strcmp(name,"data_bits")) { s->ser_data_bits = (int)n; return 1; }
            if (!strcmp(name,"stop_bits")) { s->ser_stop_bits = (int)n; return 1; }
            if (!strcmp(name,"parity") && val->kind == LSDN_PROPERTY_STRING && val->string_value) {
                s->ser_parity = !strcmp(val->string_value,"even") ? 1 : !strcmp(val->string_value,"odd") ? 2 : 0; return 1;
            }
            if (!strcmp(name,"rx_buffer") && val->kind == LSDN_PROPERTY_STRING && val->string_value) {
                const char *p = val->string_value;
                strncpy(s->ser_rx_buf, p, sizeof(s->ser_rx_buf)-1);
                while (*p) { if (!uart_tx_push(s, (uint8_t)*p)) break; p++; }
                return 1;
            }
            if (!strcmp(name,"uart_rx_hex")) return 1;
            if (!strcmp(name,"uart_tx_hex") && val->kind == LSDN_PROPERTY_STRING && val->string_value) {
                uart_enqueue_hex(s, val->string_value); return 1;
            }
            break;
        case KIND_LASECPLOT:
            if (!strcmp(name,"source_name") && val->kind == LSDN_PROPERTY_STRING && val->string_value) {
                strncpy(s->source_name, val->string_value, sizeof(s->source_name)-1); return 1;
            }
            if (!strcmp(name,"baudrate")) {
                s->ser_baudrate = (uint32_t)n;
                s->ser_bit_period_ns = s->ser_baudrate > 0 ? 1000000000u / s->ser_baudrate : 8681u;
                return 1;
            }
            if (!strcmp(name,"data_bits")) { s->ser_data_bits = (int)n; return 1; }
            if (!strcmp(name,"stop_bits")) { s->ser_stop_bits = (int)n; return 1; }
            if (!strcmp(name,"parity") && val->kind == LSDN_PROPERTY_STRING && val->string_value) {
                s->ser_parity = !strcmp(val->string_value,"even") ? 1 : !strcmp(val->string_value,"odd") ? 2 : 0; return 1;
            }
            if (!strcmp(name,"mode") && val->kind == LSDN_PROPERTY_STRING && val->string_value) {
                strncpy(s->uart_mode, val->string_value, sizeof(s->uart_mode)-1); return 1;
            }
            if (!strcmp(name,"expose")) { s->uart_expose = b; return 1; }
            if (!strcmp(name,"uart_rx_hex") || !strcmp(name,"interop_rx_hex")) return 1;
            if ((!strcmp(name,"uart_tx_hex") || !strcmp(name,"interop_tx_hex")) && val->kind == LSDN_PROPERTY_STRING && val->string_value) {
                uart_enqueue_hex(s, val->string_value); return 1;
            }
            break;
        case KIND_SERIALPORT:
            if (!strcmp(name,"port_name") && val->kind == LSDN_PROPERTY_STRING && val->string_value) {
                strncpy(s->port_name, val->string_value, sizeof(s->port_name)-1); return 1;
            }
            if (!strcmp(name,"baudrate"))  { s->port_baudrate = s->ser_baudrate = (uint32_t)n; s->ser_bit_period_ns = s->ser_baudrate > 0 ? 1000000000u / s->ser_baudrate : 104167u; return 1; }
            if (!strcmp(name,"data_bits")) { s->port_data_bits = s->ser_data_bits = (int)n; return 1; }
            if (!strcmp(name,"stop_bits")) { s->port_stop_bits = s->ser_stop_bits = (int)n; return 1; }
            if (!strcmp(name,"auto_open")) { s->port_auto_open = b;            return 1; }
            if (!strcmp(name,"port_open")) {
                s->port_open_requested = b;
                if (b) serial_port_open(s); else serial_port_close(s);
                return 1;
            }
            if (!strcmp(name,"port_is_open") || !strcmp(name,"port_error") || !strcmp(name,"port_rx_bytes") || !strcmp(name,"port_tx_bytes")) return 1;
            break;
        case KIND_SDCARD:
            if (!strcmp(name,"file") && val->kind == LSDN_PROPERTY_STRING && val->string_value) {
                strncpy(s->sd_file, val->string_value, sizeof(s->sd_file)-1); return 1;
            }
            break;
        case KIND_ESP01:
            if (!strcmp(name,"baudrate")) { s->esp_baudrate = (uint32_t)n; return 1; }
            if (!strcmp(name,"debug"))    { s->esp_debug    = b;            return 1; }
            break;
        default: break;
    }
    return 0;
}

#define STATE_VERSION 2u

static uint32_t periph_get_state(LsdnDevice *dev, uint8_t *out, uint32_t cap) {
    PeriphState *s = (PeriphState *)dev;
    uint32_t need = sizeof(uint32_t) + sizeof(PeriphState);
    if (!out || cap < need) return need;
    uint32_t ver = STATE_VERSION;
    memcpy(out, &ver, sizeof(ver));
    memcpy(out + sizeof(ver), s, sizeof(PeriphState));
    memset(out + sizeof(ver) + offsetof(PeriphState, port_is_open), 0, sizeof(s->port_is_open));
    memset(out + sizeof(ver) + offsetof(PeriphState, port_initialized), 0, sizeof(s->port_initialized));
    memset(out + sizeof(ver) + offsetof(PeriphState, port_poll_scheduled), 0, sizeof(s->port_poll_scheduled));
#if defined(_WIN32)
    memset(out + sizeof(ver) + offsetof(PeriphState, port_handle), 0xff, sizeof(s->port_handle));
#else
    memset(out + sizeof(ver) + offsetof(PeriphState, port_fd), 0xff, sizeof(s->port_fd));
#endif
    return need;
}

static void periph_set_state(LsdnDevice *dev, const uint8_t *in, uint32_t len) {
    PeriphState *s = (PeriphState *)dev;
    if (!in || len < sizeof(uint32_t)) return;
    uint32_t ver;
    memcpy(&ver, in, sizeof(ver));
    if (ver != STATE_VERSION) return;
    if (len < sizeof(uint32_t) + sizeof(PeriphState)) return;
    int kind               = s->kind;
    void *host_ctx         = s->host_ctx;
    const LsdnHostApi *api = s->api;
    if (kind == KIND_SERIALPORT) serial_port_close(s);
    memcpy(s, in + sizeof(uint32_t), sizeof(PeriphState));
    s->kind     = kind;
    s->host_ctx = host_ctx;
    s->api      = api;
#if defined(_WIN32)
    s->port_handle = INVALID_HANDLE_VALUE;
#else
    s->port_fd = -1;
#endif
    s->port_is_open = 0;
    s->port_initialized = 0;
    s->port_poll_scheduled = 0;
}

static void periph_destroy(LsdnDevice *dev) {
    PeriphState *s = (PeriphState *)dev;
    if (s && s->kind == KIND_SERIALPORT) serial_port_close(s);
    free(dev);
}

static const LsdnDeviceVTable kVTable = {
    periph_create, periph_init, periph_stamp, periph_post_step,
    periph_on_event, periph_get_property, periph_set_property,
    periph_get_state, periph_set_state, periph_destroy
};

LSDN_EXPORT
const LsdnDeviceVTable *lsdn_get_vtable(uint32_t *abi_major, uint32_t *abi_minor) {
    *abi_major = LSDN_ABI_VERSION_MAJOR;
    *abi_minor = LSDN_ABI_VERSION_MINOR;
    return &kVTable;
}
