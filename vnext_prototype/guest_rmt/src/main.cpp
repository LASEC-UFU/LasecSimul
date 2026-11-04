#include <Arduino.h>

// RMT do ESP32, dois canais:
// - tres WS2812 no GPIO25: 72 itens (24 bits por LED, 0,8/0,4 us para 1 e 0,4/0,8 us para 0, tick de
//   100 ns), mais que os 64 de um bloco de RAM -- o driver recarrega a RAM pelo evento TX_THR enquanto
//   o transmissor anda (modo wrap);
// - portadora de 38 kHz (80 MHz / 2105, no nivel alto) por 1 ms no GPIO26, ligado de volta ao GPIO27:
//   uma interrupcao de borda de subida conta os pulsos.
// Imprime "RMT frame=.. ir_rises=.." por quadro.
static const int kLedPin = 25, kIrPin = 26, kIrSense = 27;
static const uint8_t kColors[3][3] = {{0x12, 0x34, 0x56}, {0xAB, 0xCD, 0xEF}, {0x80, 0x01, 0xFF}}; // R, G, B
static volatile uint32_t rises = 0;
static rmt_obj_t* leds = nullptr;
static rmt_obj_t* ir = nullptr;

static void IRAM_ATTR onRise() { ++rises; }

static void encode(rmt_data_t* out, uint8_t value) {
    for (int bit = 0; bit < 8; ++bit) {
        const bool one = value & (0x80 >> bit);
        out[bit].level0 = 1;
        out[bit].duration0 = one ? 8 : 4;
        out[bit].level1 = 0;
        out[bit].duration1 = one ? 4 : 8;
    }
}

void setup() {
    Serial.begin(115200);
    leds = rmtInit(kLedPin, RMT_TX_MODE, RMT_MEM_64);
    rmtSetTick(leds, 100);
    ir = rmtInit(kIrPin, RMT_TX_MODE, RMT_MEM_64);
    // 500 ns: so' o APB chega la' (divisor 40), e a portadora conta ciclos do clock base -- com 1000 ns o
    // core escolheria o REF_TICK de 1 MHz e um periodo de portadora de 2,1 ms.
    rmtSetTick(ir, 500);
    rmtSetCarrier(ir, true, 1, 1053, 1052);
    pinMode(kIrSense, INPUT);
    attachInterrupt(kIrSense, onRise, RISING);
}

void loop() {
    static uint32_t frame = 0;
    rmt_data_t data[72];
    for (int led = 0; led < 3; ++led) {
        encode(&data[led * 24], kColors[led][1]);      // G
        encode(&data[led * 24 + 8], kColors[led][0]);  // R
        encode(&data[led * 24 + 16], kColors[led][2]); // B
    }
    rmtWriteBlocking(leds, data, 72);

    rmt_data_t burst[1];
    burst[0].level0 = 1;
    burst[0].duration0 = 2000; // 1 ms com portadora
    burst[0].level1 = 0;
    burst[0].duration1 = 2000;
    rises = 0;
    rmtWriteBlocking(ir, burst, 1);
    delay(3);
    Serial.printf("RMT frame=%u ir_rises=%u\n", ++frame, rises);
    delay(10);
}
