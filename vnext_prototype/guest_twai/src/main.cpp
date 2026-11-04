#include <Arduino.h>
#include "driver/mcpwm.h"
#include "driver/twai.h"

// TWAI no GPIO5 (TX) e GPIO4 (RX), ligados um no outro pelo teste: o barramento de um no' so'. O GPIO5 vai
// tambem ao GPIO26 (MCPWM CAP0), que marca cada borda do fio em ticks de APB (12,5 ns).
//
// Fase 1, TWAI_MODE_NO_ACK a 125 kbit/s: cinco quadros com auto-recepcao. Para cada um imprime o recebido
// ("RX id=.. ext=.. rtr=.. dlc=.. data=..") e o fio decodificado aqui a partir das bordas ("WIRE id=..
// ext=.. rtr=.. dlc=.. data=.. crc=ok ack=1 bits=.. stuff=.. dev=..": bits do SOF ao fim do EOF, bits de
// stuffing, desvio maximo de uma borda da grade de 8 us em ticks).
// Fase 2, TWAI_MODE_NORMAL, sozinho no barramento: sem ACK o TEC sobe 8 por tentativa ate' 128 (error
// passive) e para ali (excecao 1 da regra 3). Imprime "NOACK tec=.. rec=.. state=.. bus_errors=..".
struct Edge { uint32_t value; uint8_t rising; };
static volatile Edge ring[512];
static volatile uint32_t head = 0;
static const uint32_t kBitTicks = 640; // 8 us a 80 MHz

static bool IRAM_ATTR onCapture(mcpwm_unit_t, mcpwm_capture_channel_id_t, const cap_event_data_t* edata, void*) {
    const uint32_t at = head;
    if (at < 512) {
        ring[at].value = edata->cap_value;
        ring[at].rising = edata->cap_edge == MCPWM_POS_EDGE;
        head = at + 1;
    }
    return false;
}

static uint16_t crcBit(uint16_t crc, int bit) {
    const int next = bit ^ ((crc >> 14) & 1);
    crc = (crc << 1) & 0x7FFF;
    return next ? crc ^ 0x4599 : crc;
}

// Os bits do barramento a partir das bordas (SOF = a primeira descida), depois o quadro sem stuffing.
static void decodeWire() {
    const uint32_t count = head;
    static uint8_t bus[600];
    uint32_t nbits = 0, dev = 0, first = 0;
    while (first < count && ring[first].rising) ++first;
    for (uint32_t i = first; i + 1 < count && nbits < 560; ++i) {
        const uint32_t dt = ring[i + 1].value - ring[i].value;
        const uint32_t n = (dt + kBitTicks / 2) / kBitTicks;
        const uint32_t d = dt > n * kBitTicks ? dt - n * kBitTicks : n * kBitTicks - dt;
        if (d > dev) dev = d;
        for (uint32_t k = 0; k < n && nbits < 560; ++k) bus[nbits++] = ring[i].rising ? 1 : 0;
    }
    for (int k = 0; k < 24 && nbits < 600; ++k) bus[nbits++] = 1; // depois da ultima borda o barramento fica recessivo
    uint32_t pos = 0, run = 0, stuff = 0, n = 0, id = 0, dlc = 0, dataLen = 0, crcStart = 0, crcRx = 0;
    int last = -1, ide = 0, rtr = 0, b12 = 0;
    uint8_t data[8] = {0};
    uint16_t crc = 0;
    bool stuffed = true;
    while (stuffed && pos < nbits) {
        const int bit = bus[pos++];
        if (run == 5) { // stuffing
            if (bit == last) { Serial.printf("WIRE stuff_error at=%u\n", pos); return; }
            ++stuff; last = bit; run = 1;
            if (crcStart && n == crcStart + 15) stuffed = false;
            continue;
        }
        if (bit == last) ++run; else { last = bit; run = 1; }
        if (!crcStart || n < crcStart) crc = crcBit(crc, bit);
        const uint32_t dlcEnd = ide ? 38 : 18;
        if (n == 0) { if (bit) { Serial.printf("WIRE no_sof\n"); return; } }
        else if (n <= 11) id = (id << 1) | bit;
        else if (n == 12) b12 = bit;
        else if (n == 13) { ide = bit; rtr = !bit && b12; }
        else if (ide && n <= 31) id = (id << 1) | bit;
        else if (ide && n == 32) rtr = bit;
        else if (n <= dlcEnd - 4) {}
        else if (n <= dlcEnd) {
            dlc = (dlc << 1) | bit;
            if (n == dlcEnd) { dataLen = rtr ? 0 : (dlc > 8 ? 8 : dlc); crcStart = dlcEnd + 1 + 8 * dataLen; }
        } else if (n < crcStart) data[(n - dlcEnd - 1) / 8] = (data[(n - dlcEnd - 1) / 8] << 1) | bit;
        else crcRx = ((crcRx << 1) | bit) & 0x7FFF;
        ++n;
        if (crcStart && n == crcStart + 15 && run != 5) stuffed = false;
    }
    // Delimitador do CRC, slot e delimitador do ACK, EOF: tudo recessivo (ninguem da' ACK no self test).
    int tail = 1;
    for (int k = 0; k < 10 && pos < nbits; ++k) tail &= bus[pos++];
    char hex[20] = {0};
    for (uint32_t i = 0; i < dataLen; ++i) sprintf(hex + 2 * i, "%02x", data[i]);
    Serial.printf("WIRE id=0x%x ext=%d rtr=%d dlc=%u data=%s crc=%s ack=%d bits=%u stuff=%u dev=%u\n", id, ide, rtr, dlc,
                  dataLen ? hex : "-", crc == crcRx ? "ok" : "bad", tail, pos, stuff, dev);
}

static void sendAndCheck(uint32_t id, uint32_t flags, uint8_t dlc, const uint8_t* bytes) {
    twai_message_t msg = {};
    msg.identifier = id;
    msg.flags = flags | TWAI_MSG_FLAG_SELF;
    msg.data_length_code = dlc;
    for (int i = 0; i < 8 && i < dlc; ++i) msg.data[i] = bytes ? bytes[i] : 0;
    // A UART ainda saindo com uma interrupcao de captura armada sincroniza a cada byte (a borda pode chegar
    // a ela): no modo realtime a CPU fica mais lenta e a interrupcao da captura perderia bordas de 8 us.
    Serial.flush();
    head = 0;
    if (twai_transmit(&msg, pdMS_TO_TICKS(100)) != ESP_OK) { Serial.printf("TX falhou id=0x%x\n", id); return; }
    twai_message_t rx = {};
    if (twai_receive(&rx, pdMS_TO_TICKS(100)) != ESP_OK) { Serial.printf("RX nada id=0x%x\n", id); return; }
    delay(3); // o resto do EOF e o intermission
    char hex[20] = {0};
    const int len = (rx.flags & TWAI_MSG_FLAG_RTR) ? 0 : (rx.data_length_code > 8 ? 8 : rx.data_length_code);
    for (int i = 0; i < len; ++i) sprintf(hex + 2 * i, "%02x", rx.data[i]);
    Serial.printf("RX id=0x%x ext=%d rtr=%d dlc=%u data=%s\n", rx.identifier, (rx.flags & TWAI_MSG_FLAG_EXTD) ? 1 : 0,
                  (rx.flags & TWAI_MSG_FLAG_RTR) ? 1 : 0, rx.data_length_code, len ? hex : "-");
    decodeWire();
}

static bool start(twai_mode_t mode) {
    twai_general_config_t g = TWAI_GENERAL_CONFIG_DEFAULT(GPIO_NUM_5, GPIO_NUM_4, mode);
    twai_timing_config_t t = TWAI_TIMING_CONFIG_125KBITS();
    twai_filter_config_t f = TWAI_FILTER_CONFIG_ACCEPT_ALL();
    if (twai_driver_install(&g, &t, &f) != ESP_OK) { Serial.println("install falhou"); return false; }
    if (twai_start() != ESP_OK) { Serial.println("start falhou"); return false; }
    return true;
}

static void stop() {
    twai_stop();
    twai_driver_uninstall();
}

void setup() {
    Serial.begin(115200);
    mcpwm_gpio_init(MCPWM_UNIT_0, MCPWM_CAP_0, 26);
    mcpwm_capture_config_t capture = {};
    capture.cap_edge = MCPWM_BOTH_EDGE;
    capture.cap_prescale = 1;
    capture.capture_cb = onCapture;
    mcpwm_capture_enable_channel(MCPWM_UNIT_0, MCPWM_SELECT_CAP0, &capture);

    if (start(TWAI_MODE_NO_ACK)) {
        const uint8_t a[] = {0x11, 0x22, 0x33};
        const uint8_t b[] = {0, 1, 2, 3, 4, 5, 6, 7};
        const uint8_t zeros[] = {0, 0, 0, 0};
        const uint8_t aa[] = {0xAA};
        sendAndCheck(0x123, 0, 3, a);
        sendAndCheck(0x1ABCDE12, TWAI_MSG_FLAG_EXTD, 8, b);
        sendAndCheck(0x7FF, TWAI_MSG_FLAG_RTR, 2, nullptr);
        sendAndCheck(0x000, 0, 4, zeros);
        sendAndCheck(0x555, 0, 1, aa);
        stop();
    }

    if (start(TWAI_MODE_NORMAL)) {
        twai_message_t msg = {};
        msg.identifier = 0x321;
        msg.data_length_code = 2;
        msg.data[0] = 0x5A;
        msg.data[1] = 0xA5;
        twai_transmit(&msg, 0);
        delay(100);
        twai_status_info_t info = {};
        twai_get_status_info(&info);
        Serial.printf("NOACK tec=%u rec=%u state=%d bus_errors=%u\n", info.tx_error_counter, info.rx_error_counter,
                      (int)info.state, info.bus_error_count);
        stop();
    }
    Serial.println("TWAI fim");
}

void loop() { delay(1000); }
