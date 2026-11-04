#include <Arduino.h>
#include <SPI.h>

// Registrador de deslocamento de 8 bits (logic.shift_reg) no VSPI: MOSI -> data, SCK -> clk e
// q7 -> MISO. Cada bit que entra sai 8 clocks depois, e o mestre amostra o MISO na borda de subida,
// antes do registrador deslocar: SPI.transfer(b) devolve o byte anterior. Tres casos por rodada --
// um byte por transacao (MSB primeiro), 48 bytes numa transacao so' (W0..W15) e LSB primeiro -- e
// imprime "SPIMISO round=... ok=... bad=..." ao fim de cada rodada.
static const int kSck = 18, kMosi = 23, kMiso = 19, kRst = 4;
static uint32_t ok = 0, bad = 0;
static uint8_t last = 0;
static bool lastLsbFirst = false; // ordem de bits com que `last` entrou no registrador

static uint8_t mirror(uint8_t byte) {
    uint8_t out = 0;
    for (int bit = 0; bit < 8; ++bit) if (byte & (1u << bit)) out |= 0x80u >> bit;
    return out;
}

// O registrador guarda os bits na ordem em que entraram: lido na outra ordem, o byte sai espelhado.
static uint8_t previous(bool lsbFirst) { return lsbFirst == lastLsbFirst ? last : mirror(last); }

static void check(uint8_t got, uint8_t expected) {
    if (got == expected) {
        ++ok;
        return;
    }
    ++bad;
    if (bad <= 8) Serial.printf("SPIMISO bad got=%02X exp=%02X\n", got, expected);
}

void setup() {
    Serial.begin(115200);
    pinMode(kRst, OUTPUT);
    digitalWrite(kRst, HIGH); // zera o registrador
    delay(1);
    digitalWrite(kRst, LOW);
    SPI.begin(kSck, kMiso, kMosi, -1);
}

void loop() {
    static uint32_t round = 0;
    SPI.beginTransaction(SPISettings(4000000, MSBFIRST, SPI_MODE0));
    for (int i = 0; i < 32; ++i) {
        const uint8_t value = static_cast<uint8_t>(round * 37 + i * 11 + 0x5A);
        check(SPI.transfer(value), previous(false));
        last = value;
        lastLsbFirst = false;
    }
    uint8_t tx[48], rx[48];
    for (int i = 0; i < 48; ++i) tx[i] = static_cast<uint8_t>(round + i * 29);
    SPI.transferBytes(tx, rx, sizeof(tx));
    for (int i = 0; i < 48; ++i) check(rx[i], i ? tx[i - 1] : previous(false));
    last = tx[47];
    SPI.endTransaction();

    SPI.beginTransaction(SPISettings(1000000, LSBFIRST, SPI_MODE0));
    for (int i = 0; i < 16; ++i) {
        const uint8_t value = static_cast<uint8_t>(round * 13 + i * 7 + 1);
        check(SPI.transfer(value), previous(true));
        last = value;
        lastLsbFirst = true;
    }
    SPI.endTransaction();

    ++round;
    Serial.printf("SPIMISO round=%u ok=%u bad=%u ms=%lu\n", round, ok, bad, millis());
    delay(5);
}
