#include <Arduino.h>
#include "driver/ledc.h"
#include "driver/pcnt.h"
#include "esp_sleep.h"
#include "esp_timer.h"

// Light sleep gates APB peripherals but retains RTC8M when the low-speed LEDC selects it.
// Two LEDC outputs feed independent PCNT units; neither PCNT counter may accumulate during the 50 ms sleep.
static constexpr gpio_num_t kApbOut = GPIO_NUM_18, kRtc8mOut = GPIO_NUM_19;
static int16_t readCount(pcnt_unit_t unit) { int16_t value = 0; pcnt_get_counter_value(unit, &value); return value; }
static void setupCounter(pcnt_unit_t unit, gpio_num_t input) {
    pcnt_config_t cfg{}; cfg.pulse_gpio_num = input; cfg.ctrl_gpio_num = PCNT_PIN_NOT_USED;
    cfg.channel = PCNT_CHANNEL_0; cfg.unit = unit; cfg.pos_mode = PCNT_COUNT_INC;
    cfg.neg_mode = PCNT_COUNT_DIS; cfg.lctrl_mode = PCNT_MODE_KEEP; cfg.hctrl_mode = PCNT_MODE_KEEP;
    cfg.counter_h_lim = 30000; cfg.counter_l_lim = -30000;
    pcnt_unit_config(&cfg); pcnt_set_filter_value(unit, 10); pcnt_filter_enable(unit);
    pcnt_counter_clear(unit); pcnt_counter_resume(unit);
}
static void setupPwm(gpio_num_t pin, ledc_mode_t mode, ledc_timer_t timer, ledc_channel_t channel, ledc_clk_cfg_t clock) {
    ledc_timer_config_t t{}; t.speed_mode=mode; t.duty_resolution=LEDC_TIMER_8_BIT;
    t.timer_num=timer; t.freq_hz=1000; t.clk_cfg=clock; ledc_timer_config(&t);
    ledc_channel_config_t c{}; c.gpio_num=pin; c.speed_mode=mode; c.channel=channel;
    c.intr_type=LEDC_INTR_DISABLE; c.timer_sel=timer; c.duty=128; ledc_channel_config(&c);
}
void setup() {
    Serial.begin(115200);
    setupCounter(PCNT_UNIT_0, GPIO_NUM_34); // wired to APB LEDC output GPIO18
    setupCounter(PCNT_UNIT_1, GPIO_NUM_35); // wired to RTC8M LEDC output GPIO19
    setupPwm(kApbOut, LEDC_HIGH_SPEED_MODE, LEDC_TIMER_0, LEDC_CHANNEL_0, LEDC_USE_APB_CLK);
    setupPwm(kRtc8mOut, LEDC_LOW_SPEED_MODE, LEDC_TIMER_0, LEDC_CHANNEL_0, LEDC_USE_RTC8M_CLK);
    delay(100);
    const int16_t apbBefore=readCount(PCNT_UNIT_0), rtcBefore=readCount(PCNT_UNIT_1);
    esp_sleep_enable_timer_wakeup(50000); Serial.flush();
    const int64_t start=esp_timer_get_time(); esp_light_sleep_start();
    const int64_t slept=esp_timer_get_time()-start;
    const int16_t apbAfter=readCount(PCNT_UNIT_0), rtcAfter=readCount(PCNT_UNIT_1);
    Serial.printf("LIGHTPERIPH slept_us=%lld apb=%d:%d rtc8m=%d:%d\n", (long long)slept,
                  apbBefore,apbAfter,rtcBefore,rtcAfter);
    Serial.println("LIGHTPERIPH fim"); Serial.println("LIGHT fim");
}
void loop() { delay(1000); }
