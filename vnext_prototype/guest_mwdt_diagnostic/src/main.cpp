#include <Arduino.h>
#include <esp_task_wdt.h>
#include <soc/soc.h>
#include <soc/timer_group_reg.h>

// Guest-only MWDT boundary fixture.  It deliberately uses the public ESP32
// register map and never feeds the watchdog.  Production firmware is not
// modified or linked by this target.
static constexpr uint32_t TG1 = 1;
// Keep stage 0 silent: the interrupt action enters the Arduino/IDF watchdog
// handler, which reprograms TG1 before stage 1 can be observed.  Stage 1 is
// still the real CPU-reset action under test.
static constexpr uint32_t STAGE0_OFF = TIMG_WDT_STG_SEL_OFF;
static constexpr uint32_t STAGE1_CPU_RESET = 2;
static bool tg1_configured = false;

static void configure_tg1_mwdt_once() {
    // Disable Arduino's task watchdogs before touching TG1, so framework
    // maintenance cannot turn this no-feed experiment into a feed path.
    disableCore0WDT();
    disableCore1WDT();
    esp_task_wdt_deinit();

    REG_WRITE(TIMG_WDTWPROTECT_REG(TG1), TIMG_WDT_WKEY_VALUE);
    REG_WRITE(TIMG_WDTCONFIG1_REG(TG1), 40000);
    // With the diagnostic's explicit realtime scale this gives a bounded
    // stage-0-to-stage-1 observation window.
    REG_WRITE(TIMG_WDTCONFIG2_REG(TG1), 50);
    REG_WRITE(TIMG_WDTCONFIG3_REG(TG1), 100);
    REG_WRITE(TIMG_WDTCONFIG4_REG(TG1), 0);
    REG_WRITE(TIMG_WDTCONFIG5_REG(TG1), 0);

    const uint32_t config = TIMG_WDT_EN
        | (STAGE0_OFF << TIMG_WDT_STG0_S)
        | (STAGE1_CPU_RESET << TIMG_WDT_STG1_S)
        | (TIMG_WDT_RESET_LENGTH_200_NS << TIMG_WDT_CPU_RESET_LENGTH_S)
        | (TIMG_WDT_RESET_LENGTH_200_NS << TIMG_WDT_SYS_RESET_LENGTH_S);
    REG_WRITE(TIMG_WDTCONFIG0_REG(TG1), config);
    REG_WRITE(TIMG_WDTWPROTECT_REG(TG1), 0);
}

void setup() {
    Serial.begin(115200);
    Serial.println("MWDT_DIAGNOSTIC_BOOT");
}

void loop() {
    // Let Arduino/IDF finish APP-CPU watchdog startup before taking the TG1
    // registers.  Configure exactly once, then never feed TG1.
    if (!tg1_configured) {
        delay(2000);
        configure_tg1_mwdt_once();
        tg1_configured = true;
        Serial.println("MWDT_DIAGNOSTIC_TG1_CONFIG_ARM_NO_FEED");
    }
    // Keep the guest alive long enough for stage 0 and 1.
    delay(1000);
}
