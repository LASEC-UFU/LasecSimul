#include <Arduino.h>
#include "driver/twai.h"
#include "soc/gpio_struct.h"

// Dois ESP32 num barramento CAN sem transceptor: TX (GPIO5) em dreno aberto e RX (GPIO4) dos dois no mesmo
// fio, com um pull-up -- o "E" com fio do CAN, recessivo = alto. O papel vem do GPIO13 (pull-down): o teste
// liga o GPIO12 (alto) ao GPIO13 so' no no' A. O GPIO14 de A vai ao de B (sincronismo da arbitragem).
//
// 1. A manda 0x100..0x102; B recebe ("B RX ..."), da' o ACK e responde 0x200+n com o primeiro byte + 1
//    ("A RX ...").
// 2. Arbitragem: A sobe o GPIO14 e manda 0x700 (8 bytes) e logo atras 0x050; B, 200 us depois do GPIO14,
//    pede 0x060. No fim de 0x700 os dois comecam juntos: 0x050 ganha no bit 5 do ID, B perde, recebe 0x050 e
//    manda 0x060 depois. Cada no' imprime "X fim tec=.. rec=.. arb_lost=.. bus_errors=..".
static bool isA;

static void printRx(const twai_message_t& rx) {
    char hex[20] = {0};
    const int len = (rx.flags & TWAI_MSG_FLAG_RTR) ? 0 : (rx.data_length_code > 8 ? 8 : rx.data_length_code);
    for (int i = 0; i < len; ++i) sprintf(hex + 2 * i, "%02x", rx.data[i]);
    Serial.printf("%c RX id=0x%x dlc=%u data=%s\n", isA ? 'A' : 'B', rx.identifier, rx.data_length_code, len ? hex : "-");
}

static void send(uint32_t id, uint8_t dlc, const uint8_t* bytes) {
    twai_message_t msg = {};
    msg.identifier = id;
    msg.data_length_code = dlc;
    for (int i = 0; i < dlc && i < 8; ++i) msg.data[i] = bytes[i];
    if (twai_transmit(&msg, pdMS_TO_TICKS(100)) != ESP_OK) Serial.printf("%c TX falhou id=0x%x\n", isA ? 'A' : 'B', id);
}

static bool receive(twai_message_t& rx, int ms) {
    if (twai_receive(&rx, pdMS_TO_TICKS(ms)) == ESP_OK) return true;
    Serial.printf("%c RX nada\n", isA ? 'A' : 'B');
    return false;
}

void setup() {
    Serial.begin(115200);
    pinMode(12, OUTPUT);
    digitalWrite(12, HIGH);
    pinMode(13, INPUT_PULLDOWN);
    delay(2);
    isA = digitalRead(13);
    if (isA) {
        pinMode(14, OUTPUT);
        digitalWrite(14, LOW);
    } else {
        pinMode(14, INPUT_PULLDOWN);
    }
    twai_general_config_t g = TWAI_GENERAL_CONFIG_DEFAULT(GPIO_NUM_5, GPIO_NUM_4, TWAI_MODE_NORMAL);
    g.tx_queue_len = 5;
    twai_timing_config_t t = TWAI_TIMING_CONFIG_125KBITS();
    twai_filter_config_t f = TWAI_FILTER_CONFIG_ACCEPT_ALL();
    if (twai_driver_install(&g, &t, &f) != ESP_OK || twai_start() != ESP_OK) {
        Serial.println("install falhou");
        return;
    }
    GPIO.pin[5].pad_driver = 1; // dreno aberto: o pull-up faz o recessivo
    delay(50);

    twai_message_t rx = {};
    if (isA) {
        for (uint8_t n = 0; n < 3; ++n) {
            const uint8_t data[] = {n, static_cast<uint8_t>(0xA0 + n)};
            send(0x100 + n, 2, data);
            if (receive(rx, 300)) printRx(rx);
        }
        delay(20);
        const uint8_t longData[] = {0xF0, 0xE1, 0xD2, 0xC3, 0xB4, 0xA5, 0x96, 0x87};
        const uint8_t winner[] = {0x0A};
        digitalWrite(14, HIGH);
        send(0x700, 8, longData);
        send(0x050, 1, winner);
        if (receive(rx, 500)) printRx(rx);
    } else {
        for (int n = 0; n < 3; ++n) {
            if (!receive(rx, 1000)) break;
            printRx(rx);
            const uint8_t data[] = {static_cast<uint8_t>(rx.data[0] + 1), rx.data[1]};
            send(0x200 + n, 2, data);
        }
        const uint32_t until = millis() + 1000;
        while (!digitalRead(14) && millis() < until) {}
        delayMicroseconds(200);
        const uint8_t loser[] = {0x0B};
        send(0x060, 1, loser);
        if (receive(rx, 500)) printRx(rx);
        if (receive(rx, 500)) printRx(rx);
    }
    delay(50);
    twai_status_info_t info = {};
    twai_get_status_info(&info);
    Serial.printf("%c fim tec=%u rec=%u arb_lost=%u bus_errors=%u\n", isA ? 'A' : 'B', info.tx_error_counter,
                  info.rx_error_counter, info.arb_lost_count, info.bus_error_count);
}

void loop() { delay(1000); }
