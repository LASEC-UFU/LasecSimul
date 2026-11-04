#include <Arduino.h>
#include "driver/mcpwm.h"

// MCPWM0, timer 0 a 1 kHz, PWM0A no GPIO18 e PWM0B no GPIO19 em modo complementar com dead time de 2 us
// (RED = FED = 20 x 100 ns): PWM0A = A com a subida atrasada, PWM0B = A invertido com a descida atrasada.
// GPIO18 volta pelo GPIO26 (CAP0) e GPIO19 pelo GPIO27 (CAP1); a captura (APB_CLK, nas duas bordas) mede
// o periodo, os tempos em alto e os dois intervalos mortos. Duas fases: 25% e, depois de mcpwm_set_duty,
// 60%. Imprime "MCPWM duty=.. period=.. high_a=.. dead_ab=.. high_b=.. dead_ba=.." em ns.
struct Edge { uint8_t channel; uint8_t rising; uint32_t value; };
static volatile Edge ring[64];
static volatile uint32_t head = 0;

static bool IRAM_ATTR onCapture(mcpwm_unit_t, mcpwm_capture_channel_id_t channel, const cap_event_data_t* edata, void*) {
    const uint32_t at = head;
    ring[at % 64].channel = channel == MCPWM_SELECT_CAP0 ? 0 : 1;
    ring[at % 64].rising = edata->cap_edge == MCPWM_POS_EDGE;
    ring[at % 64].value = edata->cap_value;
    head = at + 1;
    return false;
}

static uint32_t ns(uint32_t ticks) { return (uint32_t)((uint64_t)ticks * 1000u / 80u); } // APB_CLK 80 MHz

// Procura A sobe, A desce, B sobe, B desce, A sobe nas ultimas capturas, em ordem de tempo: B desce e A
// sobe so' 2 us depois, e quando a ISR pega as duas de uma vez o ESP-IDF chama CAP0 antes de CAP1.
static void measure(int duty) {
    const uint32_t end = head;
    Edge sorted[48];
    uint32_t n = 0;
    for (uint32_t i = end > 48 ? end - 48 : 0; i < end; ++i) {
        Edge e = {ring[i % 64].channel, ring[i % 64].rising, ring[i % 64].value};
        uint32_t k = n++;
        while (k > 0 && (int32_t)(sorted[k - 1].value - e.value) > 0) { sorted[k] = sorted[k - 1]; --k; }
        sorted[k] = e;
    }
    for (uint32_t i = 0; i + 4 < n; ++i) {
        const Edge* e[5];
        for (int k = 0; k < 5; ++k) e[k] = &sorted[i + k];
        if (e[0]->channel == 0 && e[0]->rising && e[1]->channel == 0 && !e[1]->rising && e[2]->channel == 1 &&
            e[2]->rising && e[3]->channel == 1 && !e[3]->rising && e[4]->channel == 0 && e[4]->rising) {
            Serial.printf("MCPWM duty=%d period=%u high_a=%u dead_ab=%u high_b=%u dead_ba=%u\n", duty,
                          ns(e[4]->value - e[0]->value), ns(e[1]->value - e[0]->value), ns(e[2]->value - e[1]->value),
                          ns(e[3]->value - e[2]->value), ns(e[4]->value - e[3]->value));
            return;
        }
    }
    Serial.printf("MCPWM duty=%d sem sequencia (capturas=%u)\n", duty, end);
}

void setup() {
    Serial.begin(115200);
    mcpwm_gpio_init(MCPWM_UNIT_0, MCPWM0A, 18);
    mcpwm_gpio_init(MCPWM_UNIT_0, MCPWM0B, 19);
    mcpwm_gpio_init(MCPWM_UNIT_0, MCPWM_CAP_0, 26);
    mcpwm_gpio_init(MCPWM_UNIT_0, MCPWM_CAP_1, 27);
    mcpwm_config_t config = {};
    config.frequency = 1000;
    config.cmpr_a = 25.0;
    config.cmpr_b = 0.0;
    config.counter_mode = MCPWM_UP_COUNTER;
    config.duty_mode = MCPWM_DUTY_MODE_0;
    mcpwm_init(MCPWM_UNIT_0, MCPWM_TIMER_0, &config);
    mcpwm_deadtime_enable(MCPWM_UNIT_0, MCPWM_TIMER_0, MCPWM_ACTIVE_HIGH_COMPLIMENT_MODE, 20, 20);
    mcpwm_capture_config_t capture = {};
    capture.cap_edge = MCPWM_BOTH_EDGE;
    capture.cap_prescale = 1;
    capture.capture_cb = onCapture;
    mcpwm_capture_enable_channel(MCPWM_UNIT_0, MCPWM_SELECT_CAP0, &capture);
    mcpwm_capture_enable_channel(MCPWM_UNIT_0, MCPWM_SELECT_CAP1, &capture);
}

void loop() {
    mcpwm_set_duty(MCPWM_UNIT_0, MCPWM_TIMER_0, MCPWM_OPR_A, 25.0);
    delay(20);
    measure(25);
    mcpwm_set_duty(MCPWM_UNIT_0, MCPWM_TIMER_0, MCPWM_OPR_A, 60.0);
    delay(20);
    measure(60);
}
