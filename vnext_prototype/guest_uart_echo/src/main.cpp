#include <Arduino.h>

// Eco de UART0 para o teste de RX no VNEXT_B: devolve cada byte recebido em maiúscula (distingue o
// eco da entrada) e marca o boot.
void setup() {
    Serial.begin(115200);
    Serial.print("ECHO_READY\n");
}

void loop() {
    while (Serial.available() > 0) {
        const int c = Serial.read();
        Serial.write(static_cast<uint8_t>(toupper(c)));
    }
    delay(1);
}
