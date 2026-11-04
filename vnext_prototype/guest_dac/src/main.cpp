#include <Arduino.h>
#include "driver/rtc_io.h"

// DAC com o Arduino (dacWrite/dacDisable do ESP-IDF). O teste liga o GPIO25 (DAC1) ao GPIO34 e o GPIO26
// (DAC2) ao GPIO35, com 1 kOhm do GPIO26 ao GND; o ADC le as duas tensoes.
//  "DAC <passo> code=.. mv25=.. mv26=.."  para os codigos 64, 128 e 192 no DAC1 (o DAC2 em 200);
//  "DAC off ..."                           com o DAC1 desligado (o pad solto).
// E o GPIO de RTC, com o GPIO27 ligado ao GPIO39: "RTCGPIO dig=.. lo=.. hi=.." -- o nivel com o GPIO27 em
// alto pela saida digital, e depois de rtc_gpio_init (a saida digital ainda em alto, mas desligada do pad)
// com rtc_gpio_set_level 0 e 1.
static void report(const char* name, int code) {
    delay(5);
    Serial.printf("DAC %s code=%d mv25=%u mv26=%u\n", name, code, analogReadMilliVolts(34), analogReadMilliVolts(35));
}

void setup() {
    Serial.begin(115200);
    delay(50);
    dacWrite(26, 200);
    dacWrite(25, 64);
    report("a", 64);
    dacWrite(25, 128);
    report("b", 128);
    dacWrite(25, 192);
    report("c", 192);
    dacDisable(25);
    report("off", 0);

    pinMode(27, OUTPUT);
    digitalWrite(27, HIGH);
    delay(2);
    const int dig = digitalRead(39);
    rtc_gpio_init(GPIO_NUM_27);
    rtc_gpio_set_direction(GPIO_NUM_27, RTC_GPIO_MODE_OUTPUT_ONLY);
    rtc_gpio_set_level(GPIO_NUM_27, 0);
    delay(2);
    const int lo = digitalRead(39);
    rtc_gpio_set_level(GPIO_NUM_27, 1);
    delay(2);
    const int hi = digitalRead(39);
    Serial.printf("RTCGPIO dig=%d lo=%d hi=%d\n", dig, lo, hi);
    Serial.println("DAC fim");
}

void loop() { delay(1000); }
