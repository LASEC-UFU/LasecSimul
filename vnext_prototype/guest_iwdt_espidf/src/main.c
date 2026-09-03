#include <stdio.h>
#include "freertos/FreeRTOS.h"
#include "freertos/task.h"
#include "esp_system.h"

#ifndef IWDT_TEST_MODE
#define IWDT_TEST_MODE 0
#endif

static void cpu0_observer(void *arg)
{
    (void)arg;
    for (;;) {
        printf("IWDT_CPU0_ALIVE\n");
        vTaskDelay(pdMS_TO_TICKS(50));
    }
}

#if IWDT_TEST_MODE
static void cpu1_starver(void *arg)
{
    (void)arg;
    vTaskDelay(pdMS_TO_TICKS(700));
    printf("IWDT_INJECT_CPU1_STARVE\n");
    fflush(stdout);
    /* Highest-priority CPU1 task: do not yield or delay after the marker. */
    for (;;) {
        __asm__ __volatile__("nop");
    }
}
#endif

void app_main(void)
{
    printf("IWDT_FIXTURE_BOOT mode=%d\n", IWDT_TEST_MODE);
    xTaskCreatePinnedToCore(cpu0_observer, "cpu0_observer", 2048, NULL,
                            1, NULL, 0);
#if IWDT_TEST_MODE
    xTaskCreatePinnedToCore(cpu1_starver, "cpu1_starver", 2048, NULL,
                            configMAX_PRIORITIES - 1, NULL, 1);
#else
    printf("IWDT_CONTROL_BEGIN\n");
    vTaskDelay(pdMS_TO_TICKS(1000));
    printf("IWDT_CONTROL_END\n");
#endif
}
