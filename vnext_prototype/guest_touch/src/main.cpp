#include <Arduino.h>
#include "esp_sleep.h"

// Sensor de toque com o Arduino (ESP-IDF por baixo). O teste liga nada no T0 (GPIO4), 100 pF ao GND no T3
// (GPIO15) e 470 pF no T7 (GPIO27): mais capacitancia, menos ciclos de carga e descarga na medicao.
//  "TOUCH t0=.. t3=.. t7=.."  com a medicao padrao do Arduino (0x1000 ciclos de 8 MHz);
//  "TOUCH2 t0=.."             com o dobro (touchSetCycles): o dobro da contagem;
//  "TOUCHINT hits=.."         touchAttachInterrupt no T3 com limiar 40: a interrupcao do toque;
// e dorme com o despertar pelo toque: o T3 esta' abaixo do limiar, entao acorda logo, e o 2o boot imprime
// "WAKE cause=.. pad=.." (ESP_SLEEP_WAKEUP_TOUCHPAD = 5) e "TOUCH fim".
RTC_DATA_ATTR int bootCount = 0;
volatile int hits = 0;
static void onTouch() { hits++; }

void setup() {
    Serial.begin(115200);
    if (++bootCount > 1) {
        Serial.printf("WAKE cause=%d pad=%d\n", (int)esp_sleep_get_wakeup_cause(), (int)esp_sleep_get_touchpad_wakeup_status());
        Serial.println("TOUCH fim");
        return;
    }
    delay(100);
    const uint16_t t0 = touchRead(T0);
    const uint16_t t3 = touchRead(T3);
    const uint16_t t7 = touchRead(T7);
    Serial.printf("TOUCH t0=%u t3=%u t7=%u\n", t0, t3, t7);
    touchSetCycles(0x2000, 0x1000);
    delay(60);
    Serial.printf("TOUCH2 t0=%u\n", touchRead(T0));
    touchAttachInterrupt(T3, onTouch, 40);
    delay(200);
    Serial.printf("TOUCHINT hits=%d\n", hits > 0 ? 1 : 0);
    Serial.flush();
    esp_sleep_enable_touchpad_wakeup();
    esp_deep_sleep_start();
}

void loop() { delay(1000); }
