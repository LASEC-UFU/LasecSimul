#include <Arduino.h>

// Rajada de UART para o LasecPlot: firmware de mcu_firmware_lasecplot
// (LASECSIMUL_TEST_LASECPLOT_FIRMWARE). Como o sketch que embaralhava o gráfico em 2026-07, cada
// volta faz vários Serial.print() seguidos e espera 1 ms. Uma linha tem ~22 bytes (1,9 ms a
// 115200), então a FIFO de TX nunca esvazia e os bytes saem colados, sem intervalo ocioso. O
// segundo campo é uma sequência para o teste achar linha perdida ou repetida.
static uint32_t sequence = 0;

void setup() {
    Serial.begin(115200);
}

void loop() {
    Serial.print(">graf:");
    Serial.print(millis());
    Serial.print(":");
    Serial.print(sequence++);
    Serial.print("|g\r\n");
    delay(1);
}
