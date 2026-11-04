#include <Arduino.h>
#include "driver/i2s.h"
#include "esp_timer.h"

// O DAC pelo I2S0 (I2S_MODE_DAC_BUILT_IN do driver do ESP-IDF). O teste liga o GPIO25 (DAC1) ao GPIO34 e ao
// GPIO27, e o GPIO26 (DAC2) ao GPIO35.
//  "DACI <passo> mv25=.. mv26=.."  o buffer estereo com o primeiro de cada par em 64 e o segundo em 192
//      (passo a) e trocados (passo b), lidos pelo ADC;
//  "DACSQ edges=.. period_us=.."   o DAC1 alternando 255 e 0 a cada 441 amostras a 44100 Hz: o periodo
//      medido pelas bordas de subida no GPIO27 (20 ms);
//  "DACOFF mv25=.."                depois do i2s_driver_uninstall, o dacWrite(25, 100) de novo.
static void fill(int16_t* buf, int frames, uint8_t first, uint8_t second) {
    for (int i = 0; i < frames; ++i) {
        buf[2 * i] = static_cast<int16_t>(first << 8);
        buf[2 * i + 1] = static_cast<int16_t>(second << 8);
    }
}

static void put(const int16_t* buf, size_t bytes) {
    size_t written = 0;
    i2s_write(I2S_NUM_0, buf, bytes, &written, portMAX_DELAY);
}

static volatile int64_t edges[16];
static volatile int edgeCount;
static void IRAM_ATTR onEdge() {
    if (edgeCount < 16) edges[edgeCount++] = esp_timer_get_time();
}

static int16_t buf[2 * 441], hi[2 * 441], lo[2 * 441];

void setup() {
    Serial.begin(115200);
    delay(50);
    i2s_config_t cfg = {};
    cfg.mode = static_cast<i2s_mode_t>(I2S_MODE_MASTER | I2S_MODE_TX | I2S_MODE_DAC_BUILT_IN);
    cfg.sample_rate = 44100;
    cfg.bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT;
    cfg.channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT;
    cfg.communication_format = I2S_COMM_FORMAT_STAND_MSB;
    cfg.dma_buf_count = 4;
    cfg.dma_buf_len = 441;
    cfg.tx_desc_auto_clear = false; // o anel repete o que tem
    i2s_driver_install(I2S_NUM_0, &cfg, 0, nullptr);
    i2s_set_pin(I2S_NUM_0, nullptr);
    i2s_set_dac_mode(I2S_DAC_CHANNEL_BOTH_EN);

    fill(buf, 441, 64, 192);
    for (int i = 0; i < 6; ++i) put(buf, sizeof buf);
    delay(30);
    Serial.printf("DACI a mv25=%u mv26=%u\n", analogReadMilliVolts(34), analogReadMilliVolts(35));
    fill(buf, 441, 192, 64);
    for (int i = 0; i < 6; ++i) put(buf, sizeof buf);
    delay(30);
    Serial.printf("DACI b mv25=%u mv26=%u\n", analogReadMilliVolts(34), analogReadMilliVolts(35));

    fill(hi, 441, 255, 128);
    fill(lo, 441, 0, 128);
    for (int i = 0; i < 4; ++i) {
        put(hi, sizeof hi);
        put(lo, sizeof lo);
    }
    pinMode(27, INPUT);
    edgeCount = 0;
    attachInterrupt(27, onEdge, RISING);
    const int64_t until = esp_timer_get_time() + 500000;
    while (edgeCount < 11 && esp_timer_get_time() < until) delay(1);
    detachInterrupt(27);
    const int n = edgeCount;
    Serial.printf("DACSQ edges=%d period_us=%lld\n", n, n >= 11 ? (edges[10] - edges[0]) / 10 : -1LL);

    i2s_driver_uninstall(I2S_NUM_0);
    dacWrite(25, 100);
    delay(5);
    Serial.printf("DACOFF mv25=%u\n", analogReadMilliVolts(34));
    Serial.println("DACI fim");
}

void loop() { delay(1000); }
