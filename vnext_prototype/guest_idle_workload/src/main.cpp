#include <Arduino.h>

// Real guest idle workload: boot normally, then yield through the Arduino
// framework without touching UART, GPIO, I2C, or any other peripheral MMIO.
void setup() {
}

void loop() {
    delay(1000);
}
