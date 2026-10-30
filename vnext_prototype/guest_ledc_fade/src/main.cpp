#include <Arduino.h>
#include "driver/ledc.h"

// Fade do LEDC por hardware (ESP-IDF): ledc_fade_start(WAIT_DONE) só volta com a interrupção
// DUTY_CHNG_END. Mede a duração de cada fade e o duty lido de volta (DUTY_R).
static const ledc_mode_t kMode = LEDC_HIGH_SPEED_MODE;
static const ledc_channel_t kChannel = LEDC_CHANNEL_0;

void setup() {
    Serial.begin(115200);
    ledc_timer_config_t timer = {};
    timer.speed_mode = kMode;
    timer.duty_resolution = LEDC_TIMER_8_BIT;
    timer.timer_num = LEDC_TIMER_0;
    timer.freq_hz = 5000;
    timer.clk_cfg = LEDC_AUTO_CLK;
    ledc_timer_config(&timer);
    ledc_channel_config_t channel = {};
    channel.gpio_num = 18;
    channel.speed_mode = kMode;
    channel.channel = kChannel;
    channel.intr_type = LEDC_INTR_DISABLE;
    channel.timer_sel = LEDC_TIMER_0;
    channel.duty = 0;
    channel.hpoint = 0;
    ledc_channel_config(&channel);
    ledc_fade_func_install(0);
    Serial.print("FADE_READY\n");
}

void loop() {
    uint32_t t0 = micros();
    ledc_set_fade_with_time(kMode, kChannel, 255, 500);
    ledc_fade_start(kMode, kChannel, LEDC_FADE_WAIT_DONE);
    const uint32_t upUs = micros() - t0;
    const uint32_t upDuty = ledc_get_duty(kMode, kChannel);
    t0 = micros();
    ledc_set_fade_with_time(kMode, kChannel, 0, 300);
    ledc_fade_start(kMode, kChannel, LEDC_FADE_WAIT_DONE);
    const uint32_t downUs = micros() - t0;
    const uint32_t downDuty = ledc_get_duty(kMode, kChannel);
    Serial.printf("FADE up_us=%u up_duty=%u down_us=%u down_duty=%u\n", upUs, upDuty, downUs, downDuty);
    delay(50);
}
