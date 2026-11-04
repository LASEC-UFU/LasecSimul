#include <Arduino.h>
#include "driver/pcnt.h"

// Contador de pulsos (PCNT) com o driver do ESP-IDF. O LEDC gera 1 kHz no GPIO25, ligado ao GPIO26 (pulso
// da unidade 0, conta na subida); o GPIO14 (saida) vai ao GPIO27 (controle): alto mantem o sentido,
// baixo o inverte. Eventos: limiar 0 em 250 e limite alto em 1000 (o contador volta a 0), contados pela
// ISR. Imprime "PCNT up=.. down=.. thres=.. hlim=.. after=..".
static const int kGen = 25, kPulse = 26, kDirOut = 14, kCtrl = 27;
static volatile uint32_t thresEvents = 0, hlimEvents = 0;

static void IRAM_ATTR onPcnt(void*) {
    uint32_t status = 0;
    pcnt_get_event_status(PCNT_UNIT_0, &status);
    if (status & PCNT_EVT_THRES_0) ++thresEvents;
    if (status & PCNT_EVT_H_LIM) ++hlimEvents;
}

static int16_t count() {
    int16_t value = 0;
    pcnt_get_counter_value(PCNT_UNIT_0, &value);
    return value;
}

void setup() {
    Serial.begin(115200);
    pinMode(kDirOut, OUTPUT);
    digitalWrite(kDirOut, HIGH);
    pcnt_config_t config = {};
    config.pulse_gpio_num = kPulse;
    config.ctrl_gpio_num = kCtrl;
    config.channel = PCNT_CHANNEL_0;
    config.unit = PCNT_UNIT_0;
    config.pos_mode = PCNT_COUNT_INC;
    config.neg_mode = PCNT_COUNT_DIS;
    config.lctrl_mode = PCNT_MODE_REVERSE;
    config.hctrl_mode = PCNT_MODE_KEEP;
    config.counter_h_lim = 1000;
    config.counter_l_lim = -1000;
    pcnt_unit_config(&config);
    pcnt_set_filter_value(PCNT_UNIT_0, 100); // 1,25 us: um pulso de 1 kHz passa
    pcnt_filter_enable(PCNT_UNIT_0);
    pcnt_set_event_value(PCNT_UNIT_0, PCNT_EVT_THRES_0, 250);
    pcnt_event_enable(PCNT_UNIT_0, PCNT_EVT_THRES_0);
    pcnt_event_enable(PCNT_UNIT_0, PCNT_EVT_H_LIM);
    pcnt_isr_service_install(0);
    pcnt_isr_handler_add(PCNT_UNIT_0, onPcnt, nullptr);
    pcnt_counter_pause(PCNT_UNIT_0);
    pcnt_counter_clear(PCNT_UNIT_0);
    ledcSetup(0, 1000, 8);
    ledcAttachPin(kGen, 0);
    ledcWrite(0, 128);
}

void loop() {
    static uint32_t round = 0;
    digitalWrite(kDirOut, HIGH);
    pcnt_counter_clear(PCNT_UNIT_0);
    thresEvents = hlimEvents = 0;
    pcnt_counter_resume(PCNT_UNIT_0);
    delay(100);
    const int up = count();
    digitalWrite(kDirOut, LOW); // ao contrario
    delay(50);
    const int down = count();
    digitalWrite(kDirOut, HIGH);
    delay(1100); // passa de 250 e chega a 1000, que zera o contador
    const int after = count();
    pcnt_counter_pause(PCNT_UNIT_0);
    Serial.printf("PCNT round=%u up=%d down=%d thres=%u hlim=%u after=%d\n", ++round, up, down, thresEvents,
                  hlimEvents, after);
}
