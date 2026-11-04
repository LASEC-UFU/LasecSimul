#include <Arduino.h>
#include <SPI.h>
#include "driver/mcpwm.h"
#include "driver/pcnt.h"
#include "driver/spi_master.h"
#include "esp_heap_caps.h"
#include "driver/periph_ctrl.h"
#include "soc/spi_reg.h"

// O SPI do ESP32 alem do MODE0 byte a byte, conferido no fio pela captura do MCPWM (12,5 ns):
//  - VSPI pelo SPI do Arduino (SCK 18, MOSI 23, MISO 19 ligado ao MOSI), SCK -> GPIO26 (CAP0 da unidade 0) e
//    MOSI -> GPIO27 (CAP1), 10 kHz:
//      "MODE m rx=.. idle=.. shift=leading|trailing first=before|edge bits=.. cycles=.. pcnt=.." nos quatro modos
//      (pcnt: as bordas do SCK contadas pelo PCNT no mesmo pino), e
//      "BITS9 out=.. bits=.. cycles=.." com transferBits de 9 bits;
//  - HSPI pelo driver spi_master do ESP-IDF (SCK 14, MOSI 13, MISO 21 ligado ao MOSI, CS 15), SCK -> GPIO32
//    (CAP0 da unidade 1) e MOSI -> GPIO33 (CAP1):
//      "PHASES cycles=.. mosi=.." com comando 0x9F, endereco 0x123456, 8 ciclos de dummy e 24 bits lidos
//      (meia via, 10 kHz); "IRQ rx=.." com spi_device_transmit (a interrupcao de fim de transacao) em
//      dupla via; "DMA n=.. errors=.." com 5000 bytes por DMA a 4 MHz em dupla via.
struct Edge { uint8_t ch; uint8_t rising; uint32_t value; };
static volatile Edge ring[1024];
static volatile uint32_t head = 0;

static bool IRAM_ATTR onCapture(mcpwm_unit_t unit, mcpwm_capture_channel_id_t channel, const cap_event_data_t* edata, void*) {
    const uint32_t at = head;
    if (at < 1024) {
        ring[at].ch = (unit == MCPWM_UNIT_1 ? 2 : 0) + (channel == MCPWM_SELECT_CAP0 ? 0 : 1);
        ring[at].rising = edata->cap_edge == MCPWM_POS_EDGE;
        ring[at].value = edata->cap_value;
        head = at + 1;
    }
    return false;
}

static void captureOn(mcpwm_unit_t unit, int sckPin, int mosiPin) {
    mcpwm_gpio_init(unit, MCPWM_CAP_0, sckPin);
    mcpwm_gpio_init(unit, MCPWM_CAP_1, mosiPin);
    mcpwm_capture_config_t c = {};
    c.cap_edge = MCPWM_BOTH_EDGE;
    c.cap_prescale = 1;
    c.capture_cb = onCapture;
    mcpwm_capture_enable_channel(unit, MCPWM_SELECT_CAP0, &c);
    mcpwm_capture_enable_channel(unit, MCPWM_SELECT_CAP1, &c);
}

// O que as capturas mostram: SCK do canal `sck`, MOSI do `mosi`, nivel inicial do MOSI `mosi0`, e o modo
// (CPHA) para saber em que borda cada bit vale.
struct Wire { int idle; int shiftLeading; int shiftTrailing; int before; uint32_t cycles; char bits[80]; };
static Wire decode(uint8_t sck, uint8_t mosi, int mosi0, int cpha, uint32_t maxBits) {
    Wire w = {};
    w.idle = -1;
    uint32_t sckAt[200], mosiAt[200];
    uint8_t mosiRise[200];
    uint32_t ns = 0, nm = 0;
    for (uint32_t i = 0; i < head; ++i) {
        if (ring[i].ch == sck && ns < 200) {
            if (w.idle < 0) w.idle = ring[i].rising ? 0 : 1;
            sckAt[ns++] = ring[i].value;
        } else if (ring[i].ch == mosi && nm < 200) {
            mosiRise[nm] = ring[i].rising;
            mosiAt[nm++] = ring[i].value;
        }
    }
    w.cycles = ns / 2;
    for (uint32_t m = 0; m < nm; ++m) {
        int found = -1;
        for (uint32_t k = 0; k < ns; ++k) {
            const int32_t d = (int32_t)(mosiAt[m] - sckAt[k]);
            if (d >= -1 && d <= 1) { found = (int)k; break; }
        }
        if (found < 0) {
            if (ns == 0 || (int32_t)(mosiAt[m] - sckAt[0]) < 0) ++w.before;
        } else if (found % 2 == 0) ++w.shiftLeading;
        else ++w.shiftTrailing;
    }
    // Bit i vale na borda de captura: a de ida (CPHA 0) ou a de volta (CPHA 1) do ciclo i.
    uint32_t nbits = 0;
    for (uint32_t i = 0; i < w.cycles && nbits < maxBits && nbits < 79; ++i) {
        const uint32_t t = sckAt[2 * i + (cpha ? 1 : 0)];
        int level = mosi0;
        for (uint32_t m = 0; m < nm; ++m)
            if ((int32_t)(mosiAt[m] - t) < 0) level = mosiRise[m];
        w.bits[nbits++] = level ? '1' : '0';
    }
    w.bits[nbits] = 0;
    return w;
}

static void vspiMode(uint8_t mode) {
    Serial.flush(); // a interrupcao da UART nao disputa com a da captura
    SPI.beginTransaction(SPISettings(10000, MSBFIRST, mode));
    delay(1);
    const int mosi0 = digitalRead(27);
    pcnt_counter_clear(PCNT_UNIT_0);
    head = 0;
    const uint8_t rx = SPI.transfer(0xA5);
    delay(1);
    SPI.endTransaction();
    int16_t pads = 0;
    pcnt_get_counter_value(PCNT_UNIT_0, &pads); // as bordas do SCK contadas a parte, pelo PCNT
    const Wire w = decode(0, 1, mosi0, mode & 1, 8);
    const char* shift = w.shiftLeading > w.shiftTrailing ? "leading" : "trailing";
    Serial.printf("MODE %u rx=%02x idle=%d shift=%s first=%s bits=%s cycles=%u pcnt=%d\n", mode, rx, w.idle, shift,
                  w.before ? "before" : "edge", w.bits, w.cycles, pads);
}

static void hexOf(const uint8_t* data, int n, char* out) {
    for (int i = 0; i < n; ++i) sprintf(out + 2 * i, "%02x", data[i]);
}

// HSPI direto nos registradores antes de qualquer driver: os valores de reset do chip (SPI_CLOCK = SCK no
// APB, SPI_USER com uma fase de comando de 8 bits ligada) e um byte com eles -- 8 ciclos de comando e 8 de
// dados = 32 bordas no SCK, contadas pelo PCNT no GPIO32; o byte volta pelo MISO.
static void resetValues() {
    const uint32_t clockAtReset = REG_READ(SPI_CLOCK_REG(2));
    const uint32_t userAtReset = REG_READ(SPI_USER_REG(2));
    periph_module_enable(PERIPH_HSPI_MODULE);
    pinMode(14, OUTPUT);
    pinMode(13, OUTPUT);
    pinMode(21, INPUT);
    pinMatrixOutAttach(14, HSPICLK_OUT_IDX, false, false);
    pinMatrixOutAttach(13, HSPID_OUT_IDX, false, false);
    pinMatrixInAttach(21, HSPIQ_IN_IDX, false);
    pcnt_config_t pc = {};
    pc.pulse_gpio_num = 32;
    pc.ctrl_gpio_num = PCNT_PIN_NOT_USED;
    pc.channel = PCNT_CHANNEL_0;
    pc.unit = PCNT_UNIT_1;
    pc.pos_mode = PCNT_COUNT_INC;
    pc.neg_mode = PCNT_COUNT_INC;
    pc.counter_h_lim = 30000;
    pcnt_unit_config(&pc);
    pcnt_filter_disable(PCNT_UNIT_1);
    pcnt_counter_clear(PCNT_UNIT_1);
    pcnt_counter_resume(PCNT_UNIT_1);
    REG_WRITE(SPI_USER_REG(2), userAtReset | SPI_USR_MOSI | SPI_USR_MISO | SPI_DOUTDIN);
    REG_WRITE(SPI_MOSI_DLEN_REG(2), 7);
    REG_WRITE(SPI_MISO_DLEN_REG(2), 7);
    REG_WRITE(SPI_W0_REG(2), 0x5A);
    REG_SET_BIT(SPI_CMD_REG(2), SPI_USR);
    while (REG_GET_BIT(SPI_CMD_REG(2), SPI_USR)) {}
    const uint32_t rx = REG_READ(SPI_W0_REG(2)) & 0xFFu;
    delay(1);
    int16_t edges = 0;
    pcnt_get_counter_value(PCNT_UNIT_1, &edges);
    Serial.printf("RESET clock=%08x user=%08x sck_edges=%d rx=%02x\n", clockAtReset, userAtReset, edges, rx);
}

void setup() {
    Serial.begin(115200);
    resetValues();
    captureOn(MCPWM_UNIT_0, 26, 27);
    captureOn(MCPWM_UNIT_1, 32, 33);
    pcnt_config_t pc = {};
    pc.pulse_gpio_num = 26;
    pc.ctrl_gpio_num = PCNT_PIN_NOT_USED;
    pc.channel = PCNT_CHANNEL_0;
    pc.unit = PCNT_UNIT_0;
    pc.pos_mode = PCNT_COUNT_INC;
    pc.neg_mode = PCNT_COUNT_INC;
    pc.counter_h_lim = 30000;
    pcnt_unit_config(&pc);
    pcnt_filter_disable(PCNT_UNIT_0);
    pcnt_counter_resume(PCNT_UNIT_0);

    SPI.begin(18, 19, 23, 5);
    for (uint8_t mode = 0; mode < 4; ++mode) vspiMode(mode);
    Serial.flush();
    SPI.beginTransaction(SPISettings(10000, MSBFIRST, SPI_MODE0));
    delay(1);
    int mosi0 = digitalRead(27);
    head = 0;
    uint32_t out = 0;
    SPI.transferBits(0x1A5, &out, 9);
    delay(1);
    SPI.endTransaction();
    Wire w = decode(0, 1, mosi0, 0, 16);
    Serial.printf("BITS9 out=%04x bits=%s cycles=%u\n", out & 0xFF80u, w.bits, w.cycles);

    spi_bus_config_t bus = {};
    bus.mosi_io_num = 13;
    bus.miso_io_num = 21;
    bus.sclk_io_num = 14;
    bus.quadwp_io_num = -1;
    bus.quadhd_io_num = -1;
    bus.max_transfer_sz = 64;
    if (spi_bus_initialize(SPI2_HOST, &bus, SPI_DMA_DISABLED) != ESP_OK) Serial.println("bus falhou");
    spi_device_interface_config_t devcfg = {};
    devcfg.command_bits = 8;
    devcfg.address_bits = 24;
    devcfg.dummy_bits = 8;
    devcfg.mode = 0;
    devcfg.clock_speed_hz = 10000;
    devcfg.spics_io_num = 15;
    devcfg.queue_size = 2;
    devcfg.flags = SPI_DEVICE_HALFDUPLEX;
    spi_device_handle_t dev;
    spi_bus_add_device(SPI2_HOST, &devcfg, &dev);
    spi_transaction_t t = {};
    t.cmd = 0x9F;
    t.addr = 0x123456;
    t.rxlength = 24;
    t.flags = SPI_TRANS_USE_RXDATA;
    Serial.flush();
    mosi0 = digitalRead(33);
    head = 0;
    spi_device_polling_transmit(dev, &t);
    delay(1);
    w = decode(2, 3, mosi0, 0, 32);
    uint32_t value = 0;
    for (int i = 0; i < 32 && w.bits[i]; ++i) value = (value << 1) | (w.bits[i] == '1' ? 1u : 0u);
    Serial.printf("PHASES cycles=%u mosi=%08x\n", w.cycles, value);
    spi_bus_remove_device(dev);

    spi_device_interface_config_t full = {};
    full.mode = 0;
    full.clock_speed_hz = 50000;
    full.spics_io_num = 15;
    full.queue_size = 2;
    spi_bus_add_device(SPI2_HOST, &full, &dev);
    spi_transaction_t x = {};
    x.length = 32;
    x.flags = SPI_TRANS_USE_TXDATA | SPI_TRANS_USE_RXDATA;
    x.tx_data[0] = 0x11; x.tx_data[1] = 0x22; x.tx_data[2] = 0x33; x.tx_data[3] = 0x44;
    char hex[20] = {0};
    if (spi_device_transmit(dev, &x) == ESP_OK) hexOf(x.rx_data, 4, hex);
    Serial.printf("IRQ rx=%s\n", hex[0] ? hex : "-");
    spi_bus_remove_device(dev);
    spi_bus_free(SPI2_HOST);

    mcpwm_capture_disable_channel(MCPWM_UNIT_1, MCPWM_SELECT_CAP0);
    mcpwm_capture_disable_channel(MCPWM_UNIT_1, MCPWM_SELECT_CAP1);
    bus.max_transfer_sz = 8192;
    if (spi_bus_initialize(SPI2_HOST, &bus, SPI_DMA_CH_AUTO) != ESP_OK) Serial.println("bus dma falhou");
    full.clock_speed_hz = 4000000;
    spi_bus_add_device(SPI2_HOST, &full, &dev);
    const int n = 5000;
    uint8_t* tx = (uint8_t*)heap_caps_malloc(n, MALLOC_CAP_DMA);
    uint8_t* rxb = (uint8_t*)heap_caps_malloc(n, MALLOC_CAP_DMA);
    for (int i = 0; i < n; ++i) { tx[i] = (uint8_t)(i * 7 + 3); rxb[i] = 0; }
    spi_transaction_t d = {};
    d.length = n * 8;
    d.tx_buffer = tx;
    d.rx_buffer = rxb;
    int errors = -1;
    if (spi_device_transmit(dev, &d) == ESP_OK) {
        errors = 0;
        for (int i = 0; i < n; ++i) if (rxb[i] != tx[i]) ++errors;
    }
    Serial.printf("DMA n=%d errors=%d first=%02x last=%02x\n", n, errors, rxb[0], rxb[n - 1]);
    Serial.println("SPI fim");
}

void loop() { delay(1000); }
