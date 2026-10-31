#include <Arduino.h>
#include <SPI.h>

// Nokia 5110 (PCD8544) por SPI de hardware, um byte por SPI.transfer(): comandos com D/C baixo
// (inicializacao e endereco no inicio de cada quadro) e 504 bytes de dado com D/C alto. Imprime
// "SPIFRAME n=... us=..." a cada quadro.
static const int kSck = 18, kMosi = 23, kMiso = 19, kCe = 5, kDc = 16, kRst = 17;

static void command(uint8_t c) {
    digitalWrite(kDc, LOW);
    digitalWrite(kCe, LOW);
    SPI.transfer(c);
    digitalWrite(kCe, HIGH);
}

void setup() {
    Serial.begin(115200);
    pinMode(kCe, OUTPUT);
    pinMode(kDc, OUTPUT);
    pinMode(kRst, OUTPUT);
    digitalWrite(kCe, HIGH);
    digitalWrite(kRst, LOW);
    delay(1);
    digitalWrite(kRst, HIGH);
    SPI.begin(kSck, kMiso, kMosi, -1);
    SPI.beginTransaction(SPISettings(4000000, MSBFIRST, SPI_MODE0));
    command(0x21); // estendido
    command(0xB1); // Vop
    command(0x04); // temperatura
    command(0x14); // bias
    command(0x20); // basico
    command(0x0C); // modo normal
    Serial.print("SPI_DISPLAY_READY\n");
}

void loop() {
    static uint32_t frames = 0;
    const uint32_t t0 = micros();
    command(0x80); // X = 0
    command(0x40); // Y = 0
    digitalWrite(kDc, HIGH);
    digitalWrite(kCe, LOW);
    for (int i = 0; i < 504; ++i) SPI.transfer(static_cast<uint8_t>((i * 7 + (i >> 3)) & 0xFF));
    digitalWrite(kCe, HIGH);
    Serial.printf("SPIFRAME n=%u us=%u\n", ++frames, static_cast<unsigned>(micros() - t0));
}
