#include <Arduino.h>

// Blink no GPIO13 (500 ms aceso, 500 ms apagado): firmware de mcu_blink_long_run
// (LASECSIMUL_TEST_FIRMWARE).
static const int kLedPin = 13;

void setup() {
    pinMode(kLedPin, OUTPUT);
}

void loop() {
    digitalWrite(kLedPin, HIGH);
    delay(500);
    digitalWrite(kLedPin, LOW);
    delay(500);
}
