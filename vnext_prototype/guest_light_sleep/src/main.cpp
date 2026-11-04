#include <Arduino.h>
#include "driver/gpio.h"
#include "esp_sleep.h"
#include "esp_timer.h"

// Light sleep com o ESP-IDF; o teste poe uma onda quadrada de 2 Hz no GPIO33 e no GPIO27.
//  1: acorda pelo timer em 200 ms -- "LIGHT timer cause=.. slept_us=.." (esp_timer antes/depois);
//  2: pelo ext0 com o GPIO33 em alto -- "LIGHT ext0 cause=..";
//  3: pelo GPIO (esp_sleep_enable_gpio_wakeup) com o GPIO27 em alto -- "LIGHT gpio cause=..".
// Cada um mede tambem o CCOUNT do sono ("ccount=..", milhares de ciclos: no chip o clock da CPU para) e o
// timer de hardware do TIMG ("timg=..", us que ele contou: o APB para). Termina com "LIGHT fim".
static hw_timer_t* timg = nullptr;

static void report(const char* name, int64_t before, uint32_t ccountBefore, uint64_t timgBefore) {
    const int64_t after = esp_timer_get_time();
    const uint32_t ccount = ESP.getCycleCount() - ccountBefore;
    const uint64_t timgUs = timerRead(timg) - timgBefore;
    Serial.printf("LIGHT %s cause=%d slept_us=%lld ccount=%u timg=%llu\n", name, (int)esp_sleep_get_wakeup_cause(),
                  (long long)(after - before), ccount / 1000u, (unsigned long long)timgUs);
}

static void sleepAndReport(const char* name) {
    Serial.flush();
    const int64_t before = esp_timer_get_time();
    const uint32_t ccountBefore = ESP.getCycleCount();
    const uint64_t timgBefore = timerRead(timg);
    esp_light_sleep_start();
    report(name, before, ccountBefore, timgBefore);
}

void setup() {
    Serial.begin(115200);
    timg = timerBegin(0, 80, true); // 1 MHz
    timerStart(timg);

    esp_sleep_enable_timer_wakeup(200000);
    sleepAndReport("timer");
    esp_sleep_disable_wakeup_source(ESP_SLEEP_WAKEUP_TIMER);

    while (digitalRead(33)) delay(1); // o ext0 espera o proximo alto
    esp_sleep_enable_ext0_wakeup(GPIO_NUM_33, 1);
    sleepAndReport("ext0");
    esp_sleep_disable_wakeup_source(ESP_SLEEP_WAKEUP_EXT0);

    pinMode(27, INPUT);
    while (digitalRead(27)) delay(1);
    gpio_wakeup_enable(GPIO_NUM_27, GPIO_INTR_HIGH_LEVEL);
    esp_sleep_enable_gpio_wakeup();
    sleepAndReport("gpio");
    Serial.println("LIGHT fim");
}

void loop() { delay(1000); }
