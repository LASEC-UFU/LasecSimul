#include <Arduino.h>
#include <cstring>
#include "driver/uart.h"
#include "esp_timer.h"
#include "soc/uart_reg.h"

// O formato do quadro da UART com o driver do ESP-IDF. O teste liga o TX da UART2 (GPIO17) ao RX da UART1
// (GPIO18) e ao GPIO34, que ve a linha.
//  "FMT <nome> n=.. ok=.. us=.. pe=.. fe=.. brk=.."  32 bytes num formato (os dois lados iguais): quantos
//      chegaram, se iguais, o tempo do envio ate' o TX_DONE e os erros que o receptor acusou;
//  "ERR parity ..."  a UART2 em 8E1 e a UART1 em 8O1: 4 bytes, um a um -- cada um com erro de paridade;
//  "ERR frame ..."   a UART2 em 57600 manda 0x01 e a UART1 le em 115200: 0x06 com erro de quadro (o stop cai no d3);
//  "ERR break ..."   a UART2 em 57600 manda 0x00: 0x00 com break (e erro de quadro);
//  "TXBRK n=.. first=.. second=.. brk=.. us=.."  uart_write_bytes_with_break de 'U' com 100 bits de break: o
//      'U' e um 0x00 com break chegam, e a chamada volta no TX_BRK_DONE (10 + 100 bits);
//  "INV n=.. ok=.. idle=.. idleinv=.."  TXD_INV na UART2 e RXD_INV na UART1: os bytes chegam e a linha em
//      repouso fica em baixo.
static const uart_port_t kTx = UART_NUM_2, kRx = UART_NUM_1;
static QueueHandle_t rxEvents;

struct Format {
    const char* name;
    int baud;
    uart_word_length_t bits;
    uart_parity_t parity;
    uart_stop_bits_t stop;
};

static void apply(uart_port_t port, const Format& f) {
    uart_set_baudrate(port, f.baud);
    uart_set_word_length(port, f.bits);
    uart_set_parity(port, f.parity);
    uart_set_stop_bits(port, f.stop);
}

static void restart() {
    delay(3);
    uart_flush_input(kRx);
    xQueueReset(rxEvents);
}

static void countErrors(int& pe, int& fe, int& brk) {
    pe = fe = brk = 0;
    uart_event_t e;
    while (xQueueReceive(rxEvents, &e, 0) == pdTRUE) {
        if (e.type == UART_PARITY_ERR) ++pe;
        else if (e.type == UART_FRAME_ERR) ++fe;
        else if (e.type == UART_BREAK) ++brk;
    }
}

static void format(const Format& f) {
    apply(kTx, f);
    apply(kRx, f);
    restart();
    uint8_t out[32];
    const unsigned mask = (1u << (5 + f.bits)) - 1u;
    for (int i = 0; i < 32; ++i) out[i] = static_cast<uint8_t>((i * 37 + 11) & mask);
    const int64_t t0 = esp_timer_get_time();
    uart_write_bytes(kTx, out, sizeof out);
    uart_wait_tx_done(kTx, pdMS_TO_TICKS(100));
    const int64_t t1 = esp_timer_get_time();
    delay(5);
    uint8_t in[64];
    const int n = uart_read_bytes(kRx, in, sizeof in, pdMS_TO_TICKS(20));
    int pe, fe, brk;
    countErrors(pe, fe, brk);
    Serial.printf("FMT %s n=%d ok=%d us=%lld pe=%d fe=%d brk=%d\n", f.name, n, n == 32 && memcmp(in, out, 32) == 0,
                  static_cast<long long>(t1 - t0), pe, fe, brk);
}

static void errors(const char* name, const Format& tx, const Format& rx, const uint8_t* bytes, int count) {
    apply(kTx, tx);
    apply(kRx, rx);
    restart();
    for (int i = 0; i < count; ++i) {
        uart_write_bytes(kTx, &bytes[i], 1);
        uart_wait_tx_done(kTx, pdMS_TO_TICKS(100));
        delay(2);
    }
    delay(5);
    uint8_t in[16] = {};
    const int n = uart_read_bytes(kRx, in, sizeof in, pdMS_TO_TICKS(20));
    int pe, fe, brk;
    countErrors(pe, fe, brk);
    Serial.printf("ERR %s n=%d first=%02x pe=%d fe=%d brk=%d\n", name, n, in[0], pe, fe, brk);
}

void setup() {
    Serial.begin(115200);
    delay(50);
    pinMode(34, INPUT);
    uart_config_t config = {};
    config.baud_rate = 115200;
    config.data_bits = UART_DATA_8_BITS;
    config.parity = UART_PARITY_DISABLE;
    config.stop_bits = UART_STOP_BITS_1;
    config.flow_ctrl = UART_HW_FLOWCTRL_DISABLE;
    config.source_clk = UART_SCLK_APB;
    uart_driver_install(kRx, 256, 0, 32, &rxEvents, 0);
    uart_param_config(kRx, &config);
    uart_set_pin(kRx, UART_PIN_NO_CHANGE, 18, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE);
    uart_enable_intr_mask(kRx, UART_FRM_ERR_INT_ENA); // o driver nao liga o erro de quadro por padrao
    uart_driver_install(kTx, 256, 0, 0, nullptr, 0);
    uart_param_config(kTx, &config);
    uart_set_pin(kTx, 17, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE, UART_PIN_NO_CHANGE);

    static const Format formats[] = {
        {"8N1", 115200, UART_DATA_8_BITS, UART_PARITY_DISABLE, UART_STOP_BITS_1},
        {"8E1", 115200, UART_DATA_8_BITS, UART_PARITY_EVEN, UART_STOP_BITS_1},
        {"7O1", 115200, UART_DATA_7_BITS, UART_PARITY_ODD, UART_STOP_BITS_1},
        {"8N2", 115200, UART_DATA_8_BITS, UART_PARITY_DISABLE, UART_STOP_BITS_2},
        {"8N1.5", 115200, UART_DATA_8_BITS, UART_PARITY_DISABLE, UART_STOP_BITS_1_5},
        {"6E2", 115200, UART_DATA_6_BITS, UART_PARITY_EVEN, UART_STOP_BITS_2},
        {"5N1", 115200, UART_DATA_5_BITS, UART_PARITY_DISABLE, UART_STOP_BITS_1},
    };
    for (const Format& f : formats) format(f);

    const Format f8n1 = formats[0];
    const Format f8e1 = formats[1];
    const Format f8o1 = {"8O1", 115200, UART_DATA_8_BITS, UART_PARITY_ODD, UART_STOP_BITS_1};
    const Format slow = {"slow", 57600, UART_DATA_8_BITS, UART_PARITY_DISABLE, UART_STOP_BITS_1};
    static const uint8_t parityBytes[] = {0x41, 0x42, 0x43, 0x44};
    errors("parity", f8e1, f8o1, parityBytes, 4);
    static const uint8_t frameByte = 0x01, breakByte = 0x00;
    errors("frame", slow, f8n1, &frameByte, 1);
    errors("break", slow, f8n1, &breakByte, 1);

    apply(kTx, f8n1);
    apply(kRx, f8n1);
    restart();
    const int64_t b0 = esp_timer_get_time();
    uart_write_bytes_with_break(kTx, "U", 1, 100);
    const int64_t b1 = esp_timer_get_time();
    delay(5);
    uint8_t got[8] = {};
    const int nb = uart_read_bytes(kRx, got, sizeof got, pdMS_TO_TICKS(20));
    int pe, fe, brk;
    countErrors(pe, fe, brk);
    Serial.printf("TXBRK n=%d first=%02x second=%02x brk=%d us=%lld\n", nb, got[0], got[1], brk,
                  static_cast<long long>(b1 - b0));

    apply(kTx, f8n1);
    apply(kRx, f8n1);
    delay(2);
    const int idle = digitalRead(34);
    uart_set_line_inverse(kTx, UART_SIGNAL_TXD_INV);
    uart_set_line_inverse(kRx, UART_SIGNAL_RXD_INV);
    delay(2);
    const int idleInv = digitalRead(34);
    restart();
    uint8_t out[32];
    for (int i = 0; i < 32; ++i) out[i] = static_cast<uint8_t>(i * 53 + 7);
    uart_write_bytes(kTx, out, sizeof out);
    uart_wait_tx_done(kTx, pdMS_TO_TICKS(100));
    delay(5);
    uint8_t in[64];
    const int n = uart_read_bytes(kRx, in, sizeof in, pdMS_TO_TICKS(20));
    Serial.printf("INV n=%d ok=%d idle=%d idleinv=%d\n", n, n == 32 && memcmp(in, out, 32) == 0, idle, idleInv);
    Serial.println("UART fim");
}

void loop() { delay(1000); }
