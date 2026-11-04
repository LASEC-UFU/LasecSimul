#include <Arduino.h>
#include "driver/adc.h"
#include "driver/i2s.h"
#include "esp_timer.h"

// O ADC pelo I2S0 (I2S_MODE_ADC_BUILT_IN do driver do ESP-IDF). O teste liga o GPIO25 (DAC1) ao GPIO35
// (ADC1_CH7) e o GPIO27 (LEDC, 1 kHz, 50%) ao GPIO34 (ADC1_CH6).
//  "ADCDC raw=.. avg=.. chan_ok=.. n=.."  o DAC em 128: o adc1_get_raw e a media das amostras do I2S (12
//      bits, 11 dB) no canal 7, e quantas tem o campo de canal certo;
//  "ADCSQ n=.. edges=.. period_x100=.. highs=.. us=.."  a quadrada de 1 kHz a 20 kHz: as amostras (com os
//      pares desfeitos -- o ESP32 entrega o par de 16 bits trocado), as subidas, a distancia media entre elas
//      em centesimos de amostra, quantas em alto e o tempo de 4000 amostras.
static uint16_t s[4000];

static size_t readAll(void* dst, size_t bytes) {
    size_t total = 0;
    while (total < bytes) {
        size_t got = 0;
        i2s_read(I2S_NUM_0, static_cast<uint8_t*>(dst) + total, bytes - total, &got, portMAX_DELAY);
        total += got;
    }
    return total;
}

void setup() {
    Serial.begin(115200);
    delay(50);
    ledcSetup(0, 1000, 8);
    ledcAttachPin(27, 0);
    ledcWrite(0, 128);
    dacWrite(25, 128);
    adc1_config_width(ADC_WIDTH_BIT_12);
    adc1_config_channel_atten(ADC1_CHANNEL_7, ADC_ATTEN_DB_12);
    adc1_config_channel_atten(ADC1_CHANNEL_6, ADC_ATTEN_DB_12);
    delay(5);
    const int raw = adc1_get_raw(ADC1_CHANNEL_7);

    i2s_config_t cfg = {};
    cfg.mode = static_cast<i2s_mode_t>(I2S_MODE_MASTER | I2S_MODE_RX | I2S_MODE_ADC_BUILT_IN);
    cfg.sample_rate = 20000;
    cfg.bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT;
    cfg.channel_format = I2S_CHANNEL_FMT_ONLY_LEFT;
    cfg.communication_format = I2S_COMM_FORMAT_STAND_MSB;
    cfg.dma_buf_count = 4;
    cfg.dma_buf_len = 500;
    i2s_driver_install(I2S_NUM_0, &cfg, 0, nullptr);
    i2s_set_adc_mode(ADC_UNIT_1, ADC1_CHANNEL_7);
    i2s_adc_enable(I2S_NUM_0);
    readAll(s, 2000); // o que os buffers ja' tinham
    readAll(s, 2000);
    long sum = 0;
    int chanOk = 0;
    for (int i = 0; i < 1000; ++i) {
        sum += s[i] & 0xFFF;
        chanOk += (s[i] >> 12) == 7;
    }
    Serial.printf("ADCDC raw=%d avg=%ld chan_ok=%d n=%d\n", raw, sum / 1000, chanOk, 1000);
    i2s_adc_disable(I2S_NUM_0);

    i2s_set_adc_mode(ADC_UNIT_1, ADC1_CHANNEL_6);
    i2s_adc_enable(I2S_NUM_0);
    readAll(s, 4000);
    const int64_t t0 = esp_timer_get_time();
    readAll(s, sizeof s);
    const int64_t t1 = esp_timer_get_time();
    i2s_adc_disable(I2S_NUM_0);
    for (int i = 0; i + 1 < 4000; i += 2) {
        const uint16_t t = s[i];
        s[i] = s[i + 1];
        s[i + 1] = t;
    }
    int edges = 0, first = -1, last = -1, highs = 0, prev = -1;
    for (int i = 0; i < 4000; ++i) {
        const int high = (s[i] & 0xFFF) > 2048;
        highs += high;
        if (prev == 0 && high) {
            if (first < 0) first = i;
            last = i;
            ++edges;
        }
        prev = high;
    }
    Serial.printf("ADCSQ n=%d edges=%d period_x100=%d highs=%d us=%lld\n", 4000, edges,
                  edges > 1 ? (last - first) * 100 / (edges - 1) : -1, highs, static_cast<long long>(t1 - t0));
    Serial.println("ADCI fim");
}

void loop() { delay(1000); }
