#include <Arduino.h>
#include "driver/rmt.h"

// O receptor do RMT com o driver do ESP-IDF. O teste liga o GPIO18 (TX, canal 0) ao GPIO19 (RX, canal 2).
// Ticks de 1 us nos dois; o receptor com filtro de 100 ciclos de APB (1,25 us) e fim depois de 1000 ticks sem
// borda. O TX manda 10 x (alto 100, baixo 200), um alto de 50 + baixo de 1 + alto de 50 (o pulso de 1 us e'
// mais curto que o filtro) + baixo 100, e alto 300 + baixo 50, e volta ao repouso (baixo).
//  "RMTRX n=.. i0=.. ... "  quantos itens chegaram e cada um como nivel0:duracao0/nivel1:duracao1.
static rmt_item32_t item(uint32_t d0, uint32_t l0, uint32_t d1, uint32_t l1) {
    rmt_item32_t it;
    it.duration0 = d0;
    it.level0 = l0;
    it.duration1 = d1;
    it.level1 = l1;
    return it;
}

void setup() {
    Serial.begin(115200);
    delay(50);
    rmt_config_t tx = RMT_DEFAULT_CONFIG_TX(GPIO_NUM_18, RMT_CHANNEL_0);
    tx.clk_div = 80;
    rmt_config(&tx);
    rmt_driver_install(RMT_CHANNEL_0, 0, 0);

    rmt_config_t rx = RMT_DEFAULT_CONFIG_RX(GPIO_NUM_19, RMT_CHANNEL_2);
    rx.clk_div = 80;
    rx.rx_config.idle_threshold = 1000;
    rx.rx_config.filter_en = true;
    rx.rx_config.filter_ticks_thresh = 100;
    rmt_config(&rx);
    rmt_driver_install(RMT_CHANNEL_2, 2048, 0);
    RingbufHandle_t rb = nullptr;
    rmt_get_ringbuf_handle(RMT_CHANNEL_2, &rb);
    rmt_rx_start(RMT_CHANNEL_2, true);
    delay(5);

    rmt_item32_t items[14];
    int n = 0;
    for (int i = 0; i < 10; ++i) items[n++] = item(100, 1, 200, 0);
    items[n++] = item(50, 1, 1, 0);
    items[n++] = item(50, 1, 100, 0);
    items[n++] = item(300, 1, 50, 0);
    rmt_write_items(RMT_CHANNEL_0, items, n, true);

    size_t len = 0;
    rmt_item32_t* got = static_cast<rmt_item32_t*>(xRingbufferReceive(rb, &len, pdMS_TO_TICKS(200)));
    Serial.printf("RMTRX n=%u", unsigned(len / 4));
    for (size_t i = 0; got && i < len / 4; ++i)
        Serial.printf(" %u:%u/%u:%u", got[i].level0, got[i].duration0, got[i].level1, got[i].duration1);
    Serial.println();
    if (got) vRingbufferReturnItem(rb, got);
    Serial.println("RMTRX fim");
}

void loop() { delay(1000); }
