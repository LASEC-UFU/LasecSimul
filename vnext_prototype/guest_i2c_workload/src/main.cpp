#include <Arduino.h>
#include <Wire.h>

// Deterministic real-guest workload. Wire drives the ESP32 I2C peripheral MMIO;
// it does not know about or access VNEXT shared memory.
static constexpr int SDA_PIN = 21;
static constexpr int SCL_PIN = 22;
static constexpr uint8_t TARGET = 0x3c;

static volatile uint32_t completed = 0;
static bool writeDone = false;

void setup() {
    Serial.begin(115200);
    Wire.begin(SDA_PIN, SCL_PIN, 100000);
    Serial.println("REAL_I2C_WORKLOAD_READY");
}

void loop() {
    if (!writeDone) {
        Wire.beginTransmission(TARGET);
        Wire.write(0x00);
        Wire.write(0x5a);
        const uint8_t result = Wire.endTransmission(true);
        writeDone = true;
        Serial.printf("REAL_I2C_WRITE %u\n", result);
        delay(10);
        return;
    }
    /* The read is intentionally isolated after one completed write. */
    Wire.requestFrom(TARGET, static_cast<size_t>(1), true);
    const int readValue = Wire.available() ? Wire.read() : -1;
    ++completed;
    Serial.printf("REAL_I2C_READ %lu %d\n", static_cast<unsigned long>(completed), readValue);
    delay(1);
}
