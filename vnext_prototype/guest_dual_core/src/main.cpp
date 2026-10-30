#include <Arduino.h>
#include "esp_partition.h"
#include "esp_timer.h"
#include "freertos/semphr.h"

// Duas CPUs do ESP32 em paralelo: no chip cada núcleo executa no próprio ritmo, então N iterações
// levam o mesmo tempo com o outro núcleo parado ou ocupado. Imprime as três medidas.
// Depois, o núcleo 0 apaga e grava a flash (o ESP-IDF tira o núcleo 1 do cache durante a operação)
// enquanto o núcleo 1 roda um laço na flash: imprime quanto a operação levou.
static const uint32_t kIterations = 2000000;
static SemaphoreHandle_t g_start;
static SemaphoreHandle_t g_flashStart;
static volatile int64_t g_core0Us = -1;
static volatile int64_t g_flashUs = -1;

static void IRAM_ATTR spin(uint32_t n) {
    for (volatile uint32_t i = 0; i < n; i = i + 1) {
    }
}

static void core0Task(void*) {
    for (;;) {
        xSemaphoreTake(g_start, portMAX_DELAY);
        const int64_t t0 = esp_timer_get_time();
        spin(kIterations);
        g_core0Us = esp_timer_get_time() - t0;
    }
}

static void flashTask(void*) {
    const esp_partition_t* partition =
        esp_partition_find_first(ESP_PARTITION_TYPE_DATA, ESP_PARTITION_SUBTYPE_DATA_SPIFFS, nullptr);
    static uint8_t data[256];
    for (int i = 0; i < 256; ++i) data[i] = static_cast<uint8_t>(i);
    for (;;) {
        xSemaphoreTake(g_flashStart, portMAX_DELAY);
        const int64_t t0 = esp_timer_get_time();
        for (int k = 0; partition && k < 4; ++k) {
            esp_partition_erase_range(partition, 0, 4096);
            esp_partition_write(partition, 0, data, sizeof(data));
        }
        g_flashUs = partition ? esp_timer_get_time() - t0 : 0;
    }
}

void setup() {
    Serial.begin(115200);
    g_start = xSemaphoreCreateBinary();
    g_flashStart = xSemaphoreCreateBinary();
    xTaskCreatePinnedToCore(core0Task, "spin0", 4096, nullptr, 5, nullptr, 0);
    xTaskCreatePinnedToCore(flashTask, "flash0", 4096, nullptr, 5, nullptr, 0);
    Serial.print("DUAL_READY\n");
}

void loop() {
    int64_t t0 = esp_timer_get_time();
    spin(kIterations);
    const int64_t singleUs = esp_timer_get_time() - t0;
    delay(20);
    g_core0Us = -1;
    xSemaphoreGive(g_start);
    t0 = esp_timer_get_time();
    spin(kIterations);
    const int64_t bothCore1Us = esp_timer_get_time() - t0;
    while (g_core0Us < 0) delay(1);
    Serial.printf("DUAL single_us=%lld both_core1_us=%lld both_core0_us=%lld\n", singleUs, bothCore1Us,
                  static_cast<long long>(g_core0Us));
    // Laço na flash (não IRAM) no núcleo 1 enquanto o núcleo 0 grava a flash.
    g_flashUs = -1;
    xSemaphoreGive(g_flashStart);
    volatile uint32_t flashLoops = 0;
    while (g_flashUs < 0) flashLoops = flashLoops + 1;
    Serial.printf("FLASH us=%lld core1_loops=%u\n", static_cast<long long>(g_flashUs), static_cast<unsigned>(flashLoops));
    delay(50);
}
