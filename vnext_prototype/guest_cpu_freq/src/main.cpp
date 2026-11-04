#include <Arduino.h>
#include "esp_timer.h"

// setCpuFrequencyMhz do Arduino em 240/160/80 (PLL) e 40/20/10 MHz (o XTAL dividido por SYSCLK_CONF). O teste
// liga o GPIO25 (LEDC) ao GPIO26.
//  "CPU set=.. cpu=.. apb=.. ccount_per_us=.. ledc_us=.."  em cada frequencia: o que o ESP-IDF le do chip, o
//      ritmo do CCOUNT contra o esp_timer e o periodo de um LEDC de 1 kHz configurado de novo (no ESP32 a UART
//      e o LEDC contam no APB: o Arduino 2.0 nao os reajusta numa troca, o sketch o faz).
static volatile int64_t edges[16];
static volatile int edgeCount;
static void IRAM_ATTR onEdge() {
    if (edgeCount < 16) edges[edgeCount++] = esp_timer_get_time();
}

static void measure(int mhz) {
    Serial.flush();
    setCpuFrequencyMhz(mhz);
    Serial.updateBaudRate(115200);
    ledcSetup(0, 1000, 8);
    ledcAttachPin(25, 0);
    ledcWrite(0, 128);
    delay(5);
    const uint32_t c0 = ESP.getCycleCount();
    const int64_t t0 = esp_timer_get_time();
    delay(10);
    const uint32_t c1 = ESP.getCycleCount();
    const int64_t t1 = esp_timer_get_time();
    edgeCount = 0;
    attachInterrupt(26, onEdge, RISING);
    const int64_t until = esp_timer_get_time() + 100000;
    while (edgeCount < 11 && esp_timer_get_time() < until) {
    }
    detachInterrupt(26);
    const int n = edgeCount;
    Serial.printf("CPU set=%d cpu=%u apb=%u ccount_per_us=%u ledc_us=%lld\n", mhz, getCpuFrequencyMhz(), getApbFrequency(),
                  static_cast<unsigned>((c1 - c0) / (t1 - t0)), n >= 11 ? (edges[10] - edges[0]) / 10 : -1LL);
}

void setup() {
    Serial.begin(115200);
    delay(50);
    pinMode(26, INPUT);
    for (const int mhz : {240, 160, 80, 40, 20, 10}) measure(mhz);
    Serial.flush();
    setCpuFrequencyMhz(240);
    Serial.updateBaudRate(115200);
    Serial.println("CPU fim");
}

void loop() { delay(1000); }
