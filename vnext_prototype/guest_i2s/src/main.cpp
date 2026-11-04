#include <Arduino.h>
#include "driver/i2s.h"
#include "esp_timer.h"

// I2S com o driver do ESP-IDF (o legado, do Arduino 2.0). O teste liga o GPIO4 ao GPIO35, o DIN da I2S1.
//  "TX rate=.. events=.. avg_us=.."  a I2S0 em TX (16 bits, estereo): o intervalo medio entre os
//      I2S_EVENT_TX_DONE de 441 quadros, a 44100 e a 8000 Hz;
//  "TXW bytes=.. us=.."               um segundo de audio (44100 quadros) por i2s_write;
//  "TXA rate=.. events=.. avg_us=.." o mesmo intervalo com use_apll (o clock do APLL);
//  "RX lvl=.. n=.. match=.. us=.."   a I2S1 em RX (16 kHz, 16 bits, mono) com o DIN em alto e em baixo:
//      1600 amostras (100 ms), quantas iguais ao nivel do pino, e o tempo.
static QueueHandle_t txEvents;

static void txRate(int rate, const char* tag = "TX") {
    i2s_set_clk(I2S_NUM_0, rate, I2S_BITS_PER_SAMPLE_16BIT, I2S_CHANNEL_STEREO);
    xQueueReset(txEvents);
    i2s_event_t e;
    int64_t first = 0, last = 0;
    int events = 0;
    const int64_t deadline = esp_timer_get_time() + 3000000;
    while (events < 21 && esp_timer_get_time() < deadline) {
        if (xQueueReceive(txEvents, &e, pdMS_TO_TICKS(200)) != pdTRUE || e.type != I2S_EVENT_TX_DONE) continue;
        const int64_t now = esp_timer_get_time();
        if (events++ == 0) first = now;
        last = now;
    }
    Serial.printf("%s rate=%d events=%d avg_us=%lld\n", tag, rate, events, events > 1 ? (last - first) / (events - 1) : -1LL);
}

static void rxLevel(int level) {
    digitalWrite(4, level);
    delay(20);
    i2s_zero_dma_buffer(I2S_NUM_1);
    size_t got = 0;
    static uint16_t junk[640];
    i2s_read(I2S_NUM_1, junk, sizeof junk, &got, portMAX_DELAY); // o que ja' estava nos buffers
    static uint16_t samples[1600];
    const int64_t t0 = esp_timer_get_time();
    i2s_read(I2S_NUM_1, samples, sizeof samples, &got, portMAX_DELAY);
    const int64_t t1 = esp_timer_get_time();
    int match = 0;
    for (size_t i = 0; i < got / 2; ++i) match += samples[i] == (level ? 0xFFFF : 0x0000);
    Serial.printf("RX lvl=%d n=%u match=%d us=%lld\n", level, unsigned(got / 2), match, static_cast<long long>(t1 - t0));
}

void setup() {
    Serial.begin(115200);
    delay(50);
    pinMode(4, OUTPUT);

    i2s_config_t tx = {};
    tx.mode = static_cast<i2s_mode_t>(I2S_MODE_MASTER | I2S_MODE_TX);
    tx.sample_rate = 44100;
    tx.bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT;
    tx.channel_format = I2S_CHANNEL_FMT_RIGHT_LEFT;
    tx.communication_format = I2S_COMM_FORMAT_STAND_I2S;
    tx.dma_buf_count = 4;
    tx.dma_buf_len = 441;
    tx.tx_desc_auto_clear = true;
    i2s_driver_install(I2S_NUM_0, &tx, 32, &txEvents);
    i2s_pin_config_t txPins = {};
    txPins.mck_io_num = I2S_PIN_NO_CHANGE;
    txPins.bck_io_num = 26;
    txPins.ws_io_num = 25;
    txPins.data_out_num = 22;
    txPins.data_in_num = I2S_PIN_NO_CHANGE;
    i2s_set_pin(I2S_NUM_0, &txPins);

    txRate(44100);
    txRate(8000);

    i2s_set_clk(I2S_NUM_0, 44100, I2S_BITS_PER_SAMPLE_16BIT, I2S_CHANNEL_STEREO);
    static int16_t audio[2 * 441];
    for (int i = 0; i < 441; ++i) audio[2 * i] = audio[2 * i + 1] = static_cast<int16_t>(i * 64);
    size_t total = 0;
    const int64_t w0 = esp_timer_get_time();
    for (int b = 0; b < 100; ++b) {
        size_t written = 0;
        i2s_write(I2S_NUM_0, audio, sizeof audio, &written, portMAX_DELAY);
        total += written;
    }
    const int64_t w1 = esp_timer_get_time();
    Serial.printf("TXW bytes=%u us=%lld\n", unsigned(total), static_cast<long long>(w1 - w0));

    // A mesma I2S0 com o APLL (use_apll): o clock sai do APLL que o ESP-IDF configurou.
    i2s_driver_uninstall(I2S_NUM_0);
    tx.use_apll = true;
    i2s_driver_install(I2S_NUM_0, &tx, 32, &txEvents);
    i2s_set_pin(I2S_NUM_0, &txPins);
    txRate(44100, "TXA");

    i2s_config_t rx = {};
    rx.mode = static_cast<i2s_mode_t>(I2S_MODE_MASTER | I2S_MODE_RX);
    rx.sample_rate = 16000;
    rx.bits_per_sample = I2S_BITS_PER_SAMPLE_16BIT;
    rx.channel_format = I2S_CHANNEL_FMT_ONLY_LEFT;
    rx.communication_format = I2S_COMM_FORMAT_STAND_I2S;
    rx.dma_buf_count = 4;
    rx.dma_buf_len = 160;
    i2s_driver_install(I2S_NUM_1, &rx, 0, nullptr);
    i2s_pin_config_t rxPins = {};
    rxPins.mck_io_num = I2S_PIN_NO_CHANGE;
    rxPins.bck_io_num = 14;
    rxPins.ws_io_num = 15;
    rxPins.data_out_num = I2S_PIN_NO_CHANGE;
    rxPins.data_in_num = 35;
    i2s_set_pin(I2S_NUM_1, &rxPins);
    rxLevel(1);
    rxLevel(0);
    Serial.println("I2S fim");
}

void loop() { delay(1000); }
