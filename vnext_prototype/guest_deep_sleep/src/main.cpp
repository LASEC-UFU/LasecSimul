#include <Arduino.h>
#include "esp_private/esp_clk.h"
#include "esp_sleep.h"

// Deep sleep com o ESP-IDF: cada boot imprime "BOOT n cause=.. reason=.. slept_ms=.." (causa de
// esp_sleep_get_wakeup_cause, motivo de esp_reset_reason, tempo de RTC desde que dormiu) e dorme de novo:
//  1: acorda pelo timer em 300 ms;  2: pelo ext0 com o GPIO33 em alto;  3: pelo ext1 (GPIO33, qualquer alto);
//  4: imprime "EXT1 status=.." e para. O contador e o instante de dormir ficam na memoria de RTC.
// O teste poe uma onda quadrada de 2 Hz no GPIO33.
RTC_DATA_ATTR int bootCount = 0;
RTC_DATA_ATTR uint64_t sleptAtUs = 0;

void setup() {
    Serial.begin(115200);
    ++bootCount;
    const uint64_t nowUs = esp_clk_rtc_time();
    Serial.printf("BOOT %d cause=%d reason=%d slept_ms=%u\n", bootCount, (int)esp_sleep_get_wakeup_cause(),
                  (int)esp_reset_reason(), bootCount > 1 ? (unsigned)((nowUs - sleptAtUs) / 1000) : 0u);
    if (bootCount >= 4) {
        Serial.printf("EXT1 status=%llx\n", (unsigned long long)esp_sleep_get_ext1_wakeup_status());
        Serial.println("SLEEP fim");
        return;
    }
    Serial.flush();
    if (bootCount == 1) esp_sleep_enable_timer_wakeup(300000);
    else if (bootCount == 2) esp_sleep_enable_ext0_wakeup(GPIO_NUM_33, 1);
    else esp_sleep_enable_ext1_wakeup(1ULL << 33, ESP_EXT1_WAKEUP_ANY_HIGH);
    sleptAtUs = esp_clk_rtc_time();
    esp_deep_sleep_start();
}

void loop() { delay(1000); }
