#include <Arduino.h>
#include <Wire.h>
#include <Adafruit_SSD1306.h>

namespace {
constexpr uint8_t kSda = 21;
constexpr uint8_t kScl = 22;
#ifndef PROBE_ADDRESS
#define PROBE_ADDRESS 0x3c
#endif
constexpr uint8_t kAddress = PROBE_ADDRESS;
Adafruit_SSD1306 display(128, 64, &Wire, -1);

void marker(const char* name, uint32_t clockHz, uint32_t frame) {
    Serial.printf("I2CPROBE,%s,%lu,%lu,%lu\n", name,
                  static_cast<unsigned long>(clockHz),
                  static_cast<unsigned long>(frame),
                  static_cast<unsigned long>(millis()));
    Serial.flush();
}

void sendFrame(uint32_t clockHz, uint32_t frame) {
    Wire.setClock(clockHz);
    display.clearDisplay();
    display.setTextColor(SSD1306_WHITE);
    display.setTextSize(1);
    display.setCursor(0, 0);
    display.printf("clock=%lu\nframe=%lu", static_cast<unsigned long>(clockHz),
                   static_cast<unsigned long>(frame));
    for (int x = 0; x < 128; x += 2) display.drawPixel(x, 63 - (x % 32), SSD1306_WHITE);
    marker("start", clockHz, frame);
    display.display();
    marker("end", clockHz, frame);
}
} // namespace

void setup() {
    Serial.begin(921600);
    delay(20);
    marker("boot", 0, 0);
    Wire.begin(kSda, kScl);
    Wire.setClock(400000);
    marker("begin-start", 400000, 0);
    const bool ready = display.begin(SSD1306_SWITCHCAPVCC, kAddress, false, false);
    marker(ready ? "begin-ok" : "begin-fail", 400000, 0);
}

void loop() {
    static const uint32_t clocks[] = {100000, 400000, 800000};
    static uint32_t frame = 0;
    sendFrame(clocks[frame % 3], frame);
    ++frame;
    delay(100);
}
