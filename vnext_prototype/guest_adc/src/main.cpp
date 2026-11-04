#include <Arduino.h>

// ADC1 (GPIO34, 35, 32, 33) e ADC2 (GPIO25) com tensoes fixas do circuito. Para cada atenuacao (0,
// 2.5, 6 e 11 dB) e largura (9 a 12 bits) le cada pino com analogRead() -- analogReadResolution(w)
// tambem programa a largura do hardware, entao o valor e' o cru do SAR -- e mede quanto a leitura
// levou. Em 12 bits tambem imprime analogReadMilliVolts() -- a calibracao do proprio ESP-IDF, rodando
// aqui, converte o cru de volta em mV. Uma passada completa termina em "ADCDONE".
static const int kPins[] = {34, 35, 32, 33, 25};
static const adc_attenuation_t kAtten[] = {ADC_0db, ADC_2_5db, ADC_6db, ADC_11db};

void setup() {
    Serial.begin(115200);
}

void loop() {
    for (int a = 0; a < 4; ++a) {
        analogSetAttenuation(kAtten[a]);
        for (int width = 9; width <= 12; ++width) {
            analogReadResolution(width);
            for (int pin : kPins) {
                analogRead(pin); // primeira leitura do pino nesta configuracao: liga o pad
                const uint32_t t0 = micros();
                const int raw = analogRead(pin);
                const uint32_t us = micros() - t0;
                Serial.printf("ADC pin=%d atten=%d width=%d raw=%d us=%u\n", pin, a, width, raw, us);
            }
        }
        for (int pin : kPins) Serial.printf("ADCMV pin=%d atten=%d mv=%u\n", pin, a, analogReadMilliVolts(pin));
    }
    Serial.println("ADCDONE");
    delay(200);
}
