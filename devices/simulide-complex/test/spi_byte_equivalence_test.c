#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* device_abi.h 4.1: spi_clock_byte() precisa ter o mesmo efeito das 8 bordas de subida do clock
 * com os bits do byte no pino de dado. Dois dispositivos iguais recebem a mesma sequência (CS, D/C,
 * bytes de comando e de dado, e um byte já parcialmente recebido pelo fio) -- um pelas bordas, o
 * outro por spi_clock_byte -- e o estado visível tem de sair idêntico. Inclui a implementação, como
 * oled_atomic_frame_test.c. */
#include "../src/lib.c"

typedef struct {
    const char* type_id;
    const char* const* pins;
    uint32_t pin_count;
} FakeHost;

static uint32_t fake_config_get(void* ctx, const char* name, LsdnPropertyValue* out) {
    const FakeHost* host = (const FakeHost*)ctx;
    if (strcmp(name, "__typeId") != 0) return 0;
    memset(out, 0, sizeof(*out));
    out->kind = LSDN_PROPERTY_STRING;
    out->string_value = host->type_id;
    return 1;
}

static const char* fake_pin_name(void* ctx, uint32_t index) {
    const FakeHost* host = (const FakeHost*)ctx;
    return index < host->pin_count ? host->pins[index] : "";
}

static SimDevice* make_device(FakeHost* host, LsdnHostApi* api) {
    memset(api, 0, sizeof(*api));
    api->config_get = fake_config_get;
    api->pin_name = fake_pin_name;
    SimDevice* s = (SimDevice*)create(host, api);
    init((LsdnDevice*)s);
    return s;
}

/* O byte pelo fio: dado preparado com o clock baixo, amostrado na subida (MSB primeiro). */
static void wire_bits(SimDevice* s, uint32_t clock_pin, uint32_t data_pin, uint8_t value, int bits) {
    for (int bit = 7; bit > 7 - bits; --bit) {
        handle_pin_change(s, clock_pin, 0);
        handle_pin_change(s, data_pin, (value >> bit) & 1u);
        handle_pin_change(s, clock_pin, 1);
    }
    handle_pin_change(s, clock_pin, 0);
}

static int same_state(SimDevice* a, SimDevice* b, const char* label) {
    const uint32_t need = get_state((LsdnDevice*)a, NULL, 0);
    uint8_t* sa = (uint8_t*)calloc(need, 1);
    uint8_t* sb = (uint8_t*)calloc(need, 1);
    get_state((LsdnDevice*)a, sa, need);
    get_state((LsdnDevice*)b, sb, need);
    uint32_t nonzero = 0;
    for (uint32_t i = SIMULIDE_COMPLEX_STATE_HEADER_BYTES; i < need; ++i) nonzero += sa[i] != 0;
    const int equal = memcmp(sa, sb, need) == 0;
    const int ok = equal && nonzero > 0;
    if (!equal) fprintf(stderr, "FAILED: %s -- estado pelas bordas difere do estado por bytes\n", label);
    else if (!nonzero) fprintf(stderr, "FAILED: %s -- estado vazio, o teste nao exercitou o dispositivo\n", label);
    else printf("OK: %s (%u bytes de estado iguais, %u nao nulos)\n", label, need, nonzero);
    free(sa);
    free(sb);
    return ok;
}

/* `select_pin`: CS/CE (ativo baixo); `dc_pin`: D/C (UINT32_MAX = sem D/C). */
static int run_case(const char* type_id, const char* const* pins, uint32_t pin_count, uint32_t select_pin,
                    uint32_t dc_pin, const uint8_t* commands, int command_count, int data_count) {
    FakeHost host = {type_id, pins, pin_count};
    LsdnHostApi api_wire, api_bytes;
    SimDevice* wire = make_device(&host, &api_wire);
    SimDevice* bytes = make_device(&host, &api_bytes);
    uint32_t clock_pin = 0, data_pin = 0;
    if (!spi_input((LsdnDevice*)wire, &clock_pin, &data_pin)) {
        fprintf(stderr, "FAILED: %s nao declara entrada SPI\n", type_id);
        return 0;
    }
    SimDevice* both[2] = {wire, bytes};
    for (int d = 0; d < 2; ++d) {
        handle_pin_change(both[d], select_pin, 1);
        handle_pin_change(both[d], select_pin, 0);
        if (dc_pin != UINT32_MAX) handle_pin_change(both[d], dc_pin, 0);
    }
    for (int i = 0; i < command_count; ++i) {
        wire_bits(wire, clock_pin, data_pin, commands[i], 8);
        spi_clock_byte((LsdnDevice*)bytes, commands[i]);
    }
    for (int d = 0; d < 2 && dc_pin != UINT32_MAX; ++d) handle_pin_change(both[d], dc_pin, 1);
    /* Três bits já recebidos pelo fio nos dois; o byte seguinte completa o deslocamento. */
    wire_bits(wire, clock_pin, data_pin, 0xA0, 3);
    wire_bits(bytes, clock_pin, data_pin, 0xA0, 3);
    for (int i = 0; i < data_count; ++i) {
        const uint8_t value = (uint8_t)((i * 37 + 11) & 0xFF);
        wire_bits(wire, clock_pin, data_pin, value, 8);
        spi_clock_byte((LsdnDevice*)bytes, value);
    }
    const int ok = same_state(wire, bytes, type_id);
    destroy((LsdnDevice*)wire);
    destroy((LsdnDevice*)bytes);
    return ok;
}

int main(void) {
    static const char* const pcd_pins[] = {"rst", "ce", "dc", "din", "clk"};
    static const uint8_t pcd_init[] = {0x21, 0xB1, 0x04, 0x14, 0x20, 0x0C, 0x80, 0x40};
    static const char* const max_pins[] = {"cs", "din", "sck"};
    /* Palavras de 16 bits em cascata (cada uma vai ao chip seguinte, de 16 em 16): shutdown desligado
     * nos chips 0-3, 12 palavras nulas para dar a volta, e o dígito 1 com um padrão nos chips 0-3. */
    static const uint8_t max_init[] = {0x0C, 0x01, 0x0C, 0x01, 0x0C, 0x01, 0x0C, 0x01,
                                       0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0,
                                       0x01, 0x81, 0x01, 0x42, 0x01, 0x24, 0x01, 0x18};
    static const char* const tft_pins[] = {"dc", "cs", "sda", "sck", "reset"};
    static const uint8_t tft_init[] = {0x11, 0x29, 0x2C}; /* sleep out, display on, RAMWR */

    int ok = 1;
    ok &= run_case("outputs.pcd8544", pcd_pins, 5, 1, 2, pcd_init, (int)sizeof(pcd_init), 504);
    ok &= run_case("outputs.max72xx_matrix", max_pins, 3, 0, UINT32_MAX, max_init, (int)sizeof(max_init), 0);
    ok &= run_case("outputs.st7735", tft_pins, 5, 1, 0, tft_init, (int)sizeof(tft_init), 2048);
    if (!ok) return 1;
    printf("spi_clock_byte equivale as bordas do fio nos tres escravos SPI\n");
    return 0;
}
