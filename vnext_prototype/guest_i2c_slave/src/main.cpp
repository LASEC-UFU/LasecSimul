#include <Arduino.h>
#include <Wire.h>

// I2C entre dois ESP32: um mestre (Wire) e um escravo no endereco 0x42 (Wire.begin(endereco)). O teste liga
// o GPIO12 ao GPIO13 no mestre (o papel), SDA (GPIO21) e SCL (GPIO22) dos dois com pull-ups de 4,7 kOhm.
//  mestre: "I2CM i=.. err=.. n=.. data=XXXXXXXX"  tres vezes: escreve "hi<i>" e le 4 bytes; "I2CM fim";
//  escravo: "I2CS rx n=.. data=.."  cada mensagem recebida; "I2CS fim" depois de tres.
// O escravo comeca com "ABCD" na FIFO e o onRequest de cada leitura poe o proximo ("EFGH", "IJKL"): no ESP32
// original o escravo nao estica o clock, e a resposta e' a que ja' estava la' quando o mestre le.
static volatile int received = 0;
static char lastRx[16];
static volatile int lastLen = 0;
static int requests = 0;
static const char* kAnswers[] = {"EFGH", "IJKL", "MNOP", "QRST"};

static void onReceive(int len) {
    int n = 0;
    while (Wire.available() && n < 15) lastRx[n++] = static_cast<char>(Wire.read());
    lastRx[n] = 0;
    lastLen = n;
    received = received + 1;
}

static void onRequest() {
    Wire.write(reinterpret_cast<const uint8_t*>(kAnswers[requests % 4]), 4);
    ++requests;
}

void setup() {
    Serial.begin(115200);
    pinMode(12, OUTPUT);
    digitalWrite(12, HIGH);
    pinMode(13, INPUT_PULLDOWN);
    delay(5);
    const bool master = digitalRead(13);
    if (master) {
        Wire.begin(21, 22, 100000);
        delay(200); // o escravo termina de subir
        for (int i = 0; i < 3; ++i) {
            char msg[4] = {'h', 'i', static_cast<char>('0' + i), 0};
            Wire.beginTransmission(0x42);
            Wire.write(reinterpret_cast<const uint8_t*>(msg), 3);
            const int err = Wire.endTransmission();
            delay(5);
            const int n = Wire.requestFrom(0x42, 4);
            uint8_t data[4] = {0, 0, 0, 0};
            for (int k = 0; k < n && k < 4; ++k) data[k] = Wire.read();
            Serial.printf("I2CM i=%d err=%d n=%d data=%02X%02X%02X%02X\n", i, err, n, data[0], data[1], data[2], data[3]);
            delay(5);
        }
        Serial.println("I2CM fim");
    } else {
        Wire.onReceive(onReceive);
        Wire.onRequest(onRequest);
        Wire.begin(0x42, 21, 22, 100000);
        Wire.slaveWrite(reinterpret_cast<const uint8_t*>("ABCD"), 4);
        int printed = 0;
        const uint32_t until = millis() + 3000;
        while (printed < 3 && millis() < until) {
            if (received > printed) {
                Serial.printf("I2CS rx n=%d data=%s\n", lastLen, lastRx);
                ++printed;
            }
            delay(1);
        }
        Serial.println("I2CS fim");
    }
}

void loop() { delay(1000); }
