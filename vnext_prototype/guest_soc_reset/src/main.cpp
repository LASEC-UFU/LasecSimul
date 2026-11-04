#include <Arduino.h>
#include "driver/pcnt.h"
#include "driver/periph_ctrl.h"
#include "esp32/rom/gpio.h"
#include "esp32/rom/rtc.h"
#include "soc/gpio_sig_map.h"
#include "soc/pcnt_reg.h"
#include "soc/rtc_cntl_reg.h"

// Os resets do ESP32 com o ESP-IDF, GPIO4 ligado ao GPIO5 pelo teste.
//  1o boot (POWERON): LEDC a 1 kHz no GPIO4 e o PCNT (unidade 0) contando as subidas no GPIO5 por 20 ms;
//      imprime "BOOT1 pcnt=.." e chama esp_restart(), que reinicia so' as CPUs (rst:0xc SW_CPU_RESET).
//  2o boot: nenhum periferico foi reiniciado -- a unidade 0 seguiu contando e o PWM continua. Depois o
//      periph_module_reset() do PCNT (contadores a 0) e o do LEDC (o PWM para, com o GPIO4 ainda na saida
//      do canal). Imprime "BOOT2 reason=12 pcnt_before=.. edges=.. pcnt_reset=.. ledc_reset_edges=..", liga
//      o PWM de novo ("PWM again edges=..") e pede o reset de sistema por software (RTC_CNTL_SW_SYS_RST,
//      rst:0x3 SW_RESET), que reinicia todo o digital.
//  3o boot: o PCNT e o LEDC voltaram ao reset -- a unidade 0 em 0 e o GPIO4 ligado direto 'a saida do
//      canal 0 do LEDC parado. Imprime "BOOT3 reason=3 pcnt_before=.. edges=..".
static void countOn(pcnt_unit_t unit, int pin) {
    pcnt_config_t pc = {};
    pc.pulse_gpio_num = pin;
    pc.ctrl_gpio_num = PCNT_PIN_NOT_USED;
    pc.channel = PCNT_CHANNEL_0;
    pc.unit = unit;
    pc.pos_mode = PCNT_COUNT_INC;
    pc.neg_mode = PCNT_COUNT_DIS;
    pc.counter_h_lim = 30000;
    pcnt_unit_config(&pc);
    pcnt_filter_disable(unit);
    pcnt_counter_clear(unit);
    pcnt_counter_resume(unit);
}

static int16_t countFor(pcnt_unit_t unit, int ms) {
    countOn(unit, 5);
    delay(ms);
    int16_t count = 0;
    pcnt_get_counter_value(unit, &count);
    return count;
}

static void pwmOn() {
    ledcSetup(0, 1000, 8);
    ledcAttachPin(4, 0);
    ledcWrite(0, 128);
}

void setup() {
    Serial.begin(115200);
    const int reason = (int)rtc_get_reset_reason(0);
    if (reason == POWERON_RESET) {
        pwmOn();
        const int16_t count = countFor(PCNT_UNIT_0, 20);
        Serial.printf("BOOT1 pcnt=%d\n", count);
        Serial.flush();
        esp_restart();
    }
    const int16_t before = (int16_t)(REG_READ(PCNT_U0_CNT_REG) & 0xFFFF);
    if (reason == SW_CPU_RESET) {
        const int16_t edges = countFor(PCNT_UNIT_1, 20);
        periph_module_reset(PERIPH_PCNT_MODULE);
        delay(2);
        const int16_t afterReset = (int16_t)((REG_READ(PCNT_U0_CNT_REG) | REG_READ(PCNT_U1_CNT_REG)) & 0xFFFF);
        periph_module_reset(PERIPH_LEDC_MODULE);
        const int16_t ledcEdges = countFor(PCNT_UNIT_1, 20);
        Serial.printf("BOOT2 reason=%d pcnt_before=%d edges=%d pcnt_reset=%d ledc_reset_edges=%d\n", reason, before, edges,
                      afterReset, ledcEdges);
        pwmOn();
        Serial.printf("PWM again edges=%d\n", countFor(PCNT_UNIT_0, 20));
        Serial.flush();
        SET_PERI_REG_MASK(RTC_CNTL_OPTIONS0_REG, RTC_CNTL_SW_SYS_RST);
        while (true) {}
    }
    pinMode(4, OUTPUT);
    gpio_matrix_out(4, LEDC_HS_SIG_OUT0_IDX, false, false);
    const int16_t edges = countFor(PCNT_UNIT_1, 20);
    Serial.printf("BOOT3 reason=%d pcnt_before=%d edges=%d\n", reason, before, edges);
}

void loop() { delay(1000); }
