#include "lasecsimul/device_abi.h"
#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

enum {
    KIND_HD44780,
    KIND_AIP31068,
    KIND_OLED,
    KIND_SH1107,
    KIND_PCD8544,
    KIND_KS0108,
    KIND_TFT,
    KIND_MAX72XX,
    KIND_WS2812,
    KIND_SERVO,
    KIND_AUDIO,
    KIND_TRANSFORMER,
    KIND_DIAC,
    KIND_SCR,
    KIND_TRIAC,
    KIND_BJT,
    KIND_MOSFET,
    KIND_JFET
};

enum {
    EV_PIN_CHANGE = LSDN_EVT_PIN_CHANGE
};

typedef struct {
    void* host_ctx;
    const LsdnHostApi* api;
    int kind;
    char type_id[64];
    uint8_t bytes[65536];
    /* Maior framebuffer suportado hoje: 240x320 (ILI9341/ST7789). O array antigo de 65536
     * pixels escrevia 11264 pixels além do fim e corrompia todo o estado seguinte do device. */
    uint32_t pixels[240 * 320];
    uint32_t width, height, rows, cols;
    uint32_t x, y, start_x, end_x, start_y, end_y;
    uint8_t display_on, invert, full_on, remap, scan_inv, addr_mode;
    uint8_t oled_display_offset, oled_start_line, oled_rotate, oled_x_offset;
    uint8_t oled_scroll, oled_scroll_vertical, oled_scroll_right, oled_scroll_single;
    uint8_t oled_scroll_start, oled_scroll_end, oled_scroll_offset;
    uint16_t oled_scroll_interval;
    uint64_t oled_scroll_elapsed_ns;
    uint8_t tft_madctl;
    uint8_t pending_cmd, pending_count, pending_index, control, i2c_phase;
    uint32_t data_acc, data_index, data_bytes, pixel_mode;
    uint8_t ddram[80], cgram[64];
    int ddaddr, cgaddr, write_ddram, direction, shift_display, line_length, data_length, nibble, input;
    uint8_t max_ram[16][8], max_intensity[16], max_decode[16], max_scan[16], max_shutdown[16], max_test[16];
    uint16_t max_shift;
    uint8_t ks_page[2], ks_col[2], ks_start_line, ks_reset, ks_cs_active_low;
    uint8_t pin_level[32];
    uint32_t shift_reg;
    uint8_t bit_count;
    uint8_t i2c_started, i2c_ack, i2c_ack_pending, i2c_ack_clocked;
    uint8_t i2c_seen_address, i2c_addressed, i2c_address;
    uint8_t ws_rgb[3], ws_bit, ws_byte;
    uint32_t ws_led, ws_count, ws_t0h, ws_t0l, ws_t1h, ws_t1l, ws_reset_us;
    uint8_t ws_last_h, ws_new_word;
    double servo_pos, servo_target, servo_speed, servo_min, servo_max, servo_pulse_start;
    double audio_sample, audio_frequency, audio_impedance;
    double p[12];
    int latch;
    double last_a, last_b, last_c;
    /* ABI v2 (.spec/archive/legacy-v2/lasecsimul-native-devices.spec) -- setado por validate_pin_order() quando o
     * device.json declara pins[] fora da ordem que este arquivo espera. Antes só logava e
     * continuava decodificando ERRADO silenciosamente; agora handle_pin_change() vira no-op
     * (device fica inerte, visivelmente quebrado -- ex: display em branco) em vez de produzir
     * leitura incorreta sem aviso visual nenhum. */
    int misconfigured;
} SimDevice;

static const char* cfg_string(SimDevice* s, const char* name, const char* fallback) {
    static char buf[96];
    LsdnPropertyValue v;
    memset(&v, 0, sizeof(v));
    if (s->api && s->api->config_get && s->api->config_get(s->host_ctx, name, &v) && v.kind == LSDN_PROPERTY_STRING && v.string_value) {
        strncpy(buf, v.string_value, sizeof(buf) - 1);
        buf[sizeof(buf) - 1] = 0;
        return buf;
    }
    return fallback;
}

static double cfg_number(SimDevice* s, const char* name, double fallback) {
    LsdnPropertyValue v;
    memset(&v, 0, sizeof(v));
    if (s->api && s->api->config_get && s->api->config_get(s->host_ctx, name, &v) && v.kind == LSDN_PROPERTY_NUMBER) {
        return v.number_value;
    }
    return fallback;
}

static int cfg_bool(SimDevice* s, const char* name, int fallback) {
    LsdnPropertyValue v;
    memset(&v, 0, sizeof(v));
    if (s->api && s->api->config_get && s->api->config_get(s->host_ctx, name, &v) &&
        v.kind == LSDN_PROPERTY_BOOL) return v.bool_value ? 1 : 0;
    return fallback;
}

static int is_type(SimDevice* s, const char* suffix) {
    return strstr(s->type_id, suffix) != 0;
}

/* Toda a lógica deste arquivo (handle_pin_change/i2c_clock_bit/etc) indexa pino por NÚMERO,
 * confiando que device.json declara `pins[]` na mesma ordem esperada aqui -- sem isso, o device
 * "funciona" (compila, carrega) mas decodificava o protocolo errado silenciosamente (foi
 * exatamente o bug real de aip31068_i2c.json, que tinha sda/scl trocados). Chamado 1x no fim de
 * init(); loga (s->api->log nível 2 = erro) E marca `s->misconfigured` -- a vtable C
 * (`device_abi.h`) não tem como `init()` recusar a instância (retorna void, ver ABI v2 em
 * .spec/archive/legacy-v2/lasecsimul-native-devices.spec), então em vez de travar o Core, handle_pin_change() vira
 * no-op pra essa instância: o device fica inerte/visivelmente quebrado (ex: display em branco) em
 * vez de decodificar errado sem nenhum aviso visual -- bem melhor que o log-e-continua de antes,
 * que produzia leitura ERRADA silenciosa. */
static void validate_pin_order(SimDevice* s, const char* const* expected, uint32_t count) {
    if (!s->api->pin_name) return;
    for (uint32_t i = 0; i < count; ++i) {
        const char* actual = s->api->pin_name(s->host_ctx, i);
        if (actual && strcmp(actual, expected[i]) == 0) continue;
        char msg[192];
        snprintf(msg, sizeof(msg),
                 "%s: pino %u esperado \"%s\", device.json declara \"%s\" -- ordem errada, "
                 "device fica inerte (sem decodificar protocolo) ate o manifesto ser corrigido",
                 s->type_id, i, expected[i], actual ? actual : "(nenhum)");
        s->api->log(s->host_ctx, 2, msg);
        s->misconfigured = 1;
    }
}

static void hd_clear(SimDevice* s) {
    for (int i = 0; i < 80; ++i) s->ddram[i] = 32;
    s->ddaddr = 0;
    s->cgaddr = 0;
    s->write_ddram = 1;
}

static void hd_command(SimDevice* s, uint8_t command) {
    if (command == 0) return;
    if (command & 0x80) { s->ddaddr = command & 0x7f; s->write_ddram = 1; return; }
    if (command & 0x40) { s->cgaddr = command & 0x3f; s->write_ddram = 0; return; }
    if (command & 0x20) { s->data_length = (command & 0x10) ? 8 : 4; s->line_length = (command & 0x08) ? 40 : 80; return; }
    if (command & 0x10) {
        int dir = (command & 0x04) ? -1 : 1;
        if (command & 0x08) s->x = (uint32_t)((int)s->x + dir);
        else s->ddaddr = (s->ddaddr - dir + 80) % 80;
        return;
    }
    if (command & 0x08) { s->display_on = (command & 0x04) != 0; return; }
    if (command & 0x04) { s->direction = (command & 0x02) ? 1 : -1; s->shift_display = command & 1; return; }
    if (command & 0x02) { s->ddaddr = 0; s->x = 0; return; }
    if (command & 0x01) { hd_clear(s); return; }
}

static void hd_data(SimDevice* s, uint8_t data) {
    if (s->write_ddram) {
        s->ddram[s->ddaddr & 0x7f] = data;
        s->ddaddr += s->direction ? s->direction : 1;
        if (s->ddaddr > 79) s->ddaddr = 0;
        if (s->ddaddr < 0) s->ddaddr = 79;
    } else {
        s->cgram[s->cgaddr & 0x3f] = data;
        s->cgaddr = (s->cgaddr + 1) & 0x3f;
    }
}

static void oled_reset(SimDevice* s) {
    memset(s->bytes, 0, sizeof(s->bytes));
    s->x = s->y = s->start_x = s->start_y = 0;
    s->end_x = s->width ? s->width - 1 : 127;
    s->end_y = s->rows ? s->rows - 1 : 7;
    s->display_on = 0;
    s->invert = 0;
    s->full_on = 0;
    s->addr_mode = 2;
    s->pending_count = 0;
    s->oled_display_offset = 0;
    s->oled_start_line = 0;
    s->oled_scroll = s->oled_scroll_vertical = s->oled_scroll_right = s->oled_scroll_single = 0;
    s->oled_scroll_start = 0;
    s->oled_scroll_end = s->rows ? (uint8_t)(s->rows - 1) : 7;
    s->oled_scroll_offset = 0;
    s->oled_scroll_interval = 5;
    s->oled_scroll_elapsed_ns = 0;
}

static void oled_data(SimDevice* s, uint8_t data) {
    uint32_t write_x = s->x;
    if (s->kind == KIND_SH1107 && s->oled_x_offset && s->width) {
        write_x = s->x >= 96 ? s->x - 96 : s->x + s->width - 96;
        write_x %= s->width;
    }
    if (write_x < s->width && s->y < s->rows) s->bytes[s->y * s->width + write_x] = data;
    if (s->addr_mode & 1) {
        s->y++;
        if (s->y > s->end_y) { s->y = s->start_y; if (s->addr_mode == 1 && ++s->x > s->end_x) s->x = s->start_x; }
    } else {
        s->x++;
        if (s->x > s->end_x) { s->x = s->start_x; if (s->addr_mode == 0 && ++s->y > s->end_y) s->y = s->start_y; }
    }
}

static void oled_param(SimDevice* s, uint8_t data) {
    s->pending_index++;
    if (s->pending_cmd == 0x20) s->addr_mode = data & 3;
    else if (s->pending_cmd == 0x21) { if (s->pending_index == 1) s->x = s->start_x = data & 0x7f; else s->end_x = data & 0x7f; }
    else if (s->pending_cmd == 0x22) { if (s->pending_index == 1) s->y = s->start_y = data & 0x0f; else s->end_y = data & 0x0f; }
    /* Multiplex ratio não redimensiona fisicamente o módulo escolhido pelo usuário. */
    else if (s->pending_cmd == 0xd3) s->oled_display_offset = data & 0x7f;
    else if (s->pending_cmd == 0xdc) s->oled_start_line = data & 0x7f;
    else if (s->pending_cmd == 0x26 || s->pending_cmd == 0x27 ||
             s->pending_cmd == 0x29 || s->pending_cmd == 0x2a ||
             s->pending_cmd == 0x2c || s->pending_cmd == 0x2d) {
        static const uint16_t intervals[8] = {5, 64, 128, 256, 3, 4, 25, 2};
        if (s->pending_index == 2) s->oled_scroll_start = data & 0x0f;
        else if (s->pending_index == 3) s->oled_scroll_interval = intervals[data & 7];
        else if (s->pending_index == 4) s->oled_scroll_end = data & 0x0f;
        else if (s->pending_index == 5) s->oled_scroll_offset = data & 0x7f;
    }
    if (s->pending_index >= s->pending_count) s->pending_count = 0;
}

static void oled_command(SimDevice* s, uint8_t c) {
    s->pending_cmd = c; s->pending_index = 0; s->pending_count = 0;
    if (c < 0x10 && s->addr_mode == 2) s->x = (s->x & 0xf0) | (c & 0x0f);
    else if (c < 0x20 && s->addr_mode == 2) {
        uint8_t high = s->kind == KIND_SH1107 ? (c & 0x07) : (c & 0x0f);
        s->x = (s->x & 0x0f) | ((uint32_t)high << 4);
    }
    else if (c >= 0x40 && c <= 0x7f) s->oled_start_line = c & 0x7f;
    else if (c >= 0xb0 && c <= 0xbf) s->y = c & 0x0f;
    else if (s->kind == KIND_SH1107 && c == 0x20) s->addr_mode = 2;
    else if (s->kind == KIND_SH1107 && c == 0x21) s->addr_mode = 1;
    else if (c == 0x20 || c == 0x23 || c == 0x81 || c == 0x8d || c == 0xa8 || c == 0xd3 || c == 0xd5 || c == 0xd9 || c == 0xda || c == 0xdb || c == 0xdc) s->pending_count = 1;
    else if (c == 0x21 || c == 0x22 || c == 0xa3) s->pending_count = 2;
    else if (c == 0x26 || c == 0x27 || c == 0x2c || c == 0x2d) {
        s->pending_count = 6;
        s->oled_scroll_vertical = 0;
        s->oled_scroll_right = (c == 0x26 || c == 0x2c);
        s->oled_scroll_single = (c == 0x2c || c == 0x2d);
    }
    else if (c == 0x29 || c == 0x2a) {
        s->pending_count = 5;
        s->oled_scroll_vertical = 1;
        s->oled_scroll_right = c == 0x29;
        s->oled_scroll_single = 0;
    }
    else if (c == 0x2e) { s->latch = 0; s->oled_scroll = 0; }
    else if (c == 0x2f) { s->latch = 1; s->oled_scroll = 1; s->oled_scroll_elapsed_ns = 0; }
    else if (c == 0xa0) s->remap = 0;
    else if (c == 0xa1) s->remap = 1;
    else if (c == 0xa4) s->full_on = 0;
    else if (c == 0xa5) s->full_on = 1;
    else if (c == 0xa6) s->invert = 0;
    else if (c == 0xa7) s->invert = 1;
    /* DISPLAYOFF preserva GDDRAM e configuração; limpar tudo aqui fazia o conteúdo desaparecer
     * após um ciclo normal AE/AF de economia de energia. */
    else if (c == 0xae) s->display_on = 0;
    else if (c == 0xaf) s->display_on = 1;
    else if (c == 0xc0) s->scan_inv = 0;
    else if (c == 0xc8) s->scan_inv = 1;
}

static void oled_scroll_once(SimDevice* s) {
    if (!s->width || !s->rows) return;
    uint32_t start = s->oled_scroll_start < s->rows ? s->oled_scroll_start : 0;
    uint32_t end = s->oled_scroll_end < s->rows ? s->oled_scroll_end : s->rows - 1;
    if (end < start) return;
    for (uint32_t page = start; page <= end; ++page) {
        uint8_t* row = s->bytes + page * s->width;
        if (s->oled_scroll_right) {
            uint8_t last = row[s->width - 1];
            memmove(row + 1, row, s->width - 1);
            row[0] = last;
        } else {
            uint8_t first = row[0];
            memmove(row, row + 1, s->width - 1);
            row[s->width - 1] = first;
        }
    }
    if (s->oled_scroll_vertical && s->oled_scroll_offset) {
        const uint32_t bit_start = start * 8;
        const uint32_t bit_count = (end - start + 1) * 8;
        const uint32_t shift = s->oled_scroll_offset % bit_count;
        uint8_t column_bits[128];
        for (uint32_t col = 0; col < s->width; ++col) {
            memset(column_bits, 0, bit_count);
            for (uint32_t bit = 0; bit < bit_count; ++bit) {
                const uint32_t source_y = bit_start + bit;
                column_bits[bit] = (s->bytes[(source_y / 8) * s->width + col] >> (source_y & 7)) & 1;
            }
            for (uint32_t bit = 0; bit < bit_count; ++bit) {
                const uint32_t dest_y = bit_start + bit;
                uint8_t* cell = &s->bytes[(dest_y / 8) * s->width + col];
                const uint8_t mask = (uint8_t)(1u << (dest_y & 7));
                const uint32_t source_bit = (bit + shift) % bit_count;
                if (column_bits[source_bit]) *cell |= mask;
                else *cell &= (uint8_t)~mask;
            }
        }
    }
}

static void i2c_payload_byte(SimDevice* s, uint8_t byte) {
    if (s->kind == KIND_AIP31068) {
        if (s->i2c_phase == 0) {
            s->control = byte;
            s->i2c_phase = 1;
        } else {
            if (s->control & 0x40) hd_data(s, byte);
            else hd_command(s, byte);
            /* Co=1: o próximo byte volta a ser controle. Co=0: D/C permanece válido para todos
             * os bytes restantes da transação (modo usado pelas bibliotecas LCD comuns). */
            if (s->control & 0x80) s->i2c_phase = 0;
        }
    } else if (s->kind == KIND_OLED || s->kind == KIND_SH1107) {
        if (s->i2c_phase == 0) {
            s->control = byte;
            s->i2c_phase = 1;
        } else if (s->control & 0x40) {
            oled_data(s, byte);
            if (s->control & 0x80) s->i2c_phase = 0;
        } else if (s->pending_count) {
            oled_param(s, byte);
            if (s->control & 0x80) s->i2c_phase = 0;
        } else {
            oled_command(s, byte);
            if (s->control & 0x80) s->i2c_phase = 0;
        }
    }
}

static void tft_reset(SimDevice* s) {
    memset(s->pixels, 0, sizeof(s->pixels));
    s->x = s->y = s->start_x = s->start_y = 0;
    s->end_x = s->width - 1;
    s->end_y = s->height - 1;
    s->display_on = s->invert = s->remap = s->scan_inv = 0;
    s->tft_madctl = 0;
    s->data_bytes = is_type(s, "ili9341") ? 2 : 3;
    s->pending_count = 0;
}

static void tft_write_pixel(SimDevice* s, uint32_t rgb) {
    uint32_t ax = s->x, ay = s->y;
    if (s->tft_madctl & 0x20) {
        uint32_t swap = ax; ax = ay; ay = swap;
    }
    /* Só espelha coordenadas válidas. Subtrair um endereço fora da janela de width/height em
     * uint32_t causava underflow e podia mascarar comandos CASET/PASET inválidos. */
    if ((s->tft_madctl & 0x40) && ax < s->width) ax = s->width - 1 - ax;
    if ((s->tft_madctl & 0x80) && ay < s->height) ay = s->height - 1 - ay;
    if (s->tft_madctl & 0x08) {
        rgb = ((rgb & 0x0000ffu) << 16) | (rgb & 0x00ff00u) | ((rgb & 0xff0000u) >> 16);
    }
    if (ax < s->width && ay < s->height) s->pixels[ay * s->width + ax] = rgb;
    s->x++;
    if (s->x > s->end_x) { s->x = s->start_x; s->y++; if (s->y > s->end_y) s->y = s->start_y; }
}

static void tft_command(SimDevice* s, uint8_t c) {
    s->pending_cmd = c; s->pending_index = 0; s->pending_count = 0; s->data_acc = 0; s->data_index = 0;
    if (c == 0x00 || c == 0x01) tft_reset(s);
    else if (c == 0x20) s->invert = 0;
    else if (c == 0x21) s->invert = 1;
    else if (c == 0x28) s->display_on = 0;
    else if (c == 0x29) s->display_on = 1;
    else if (c == 0x2a || c == 0x2b) s->pending_count = 4;
    else if (c == 0x2c) { s->x = s->start_x; s->y = s->start_y; s->pending_count = 255; }
    else if (c == 0x36 || c == 0x3a) s->pending_count = 1;
    else if (c == 0x33) s->pending_count = 6;
    else if (c == 0x37) s->pending_count = 2;
}

static void tft_data(SimDevice* s, uint8_t d) {
    if (s->pending_cmd == 0x2c) {
        s->data_acc = (s->data_acc << 8) | d;
        s->data_index++;
        if (s->data_index >= s->data_bytes) {
            uint32_t rgb = 0;
            if (s->data_bytes == 2) {
                uint32_t v = s->data_acc;
                rgb = ((v & 0xf800) << 8) | ((v & 0x07e0) << 5) | ((v & 0x001f) << 3);
            } else {
                rgb = s->data_acc & 0xffffff;
            }
            tft_write_pixel(s, rgb);
            s->data_acc = 0; s->data_index = 0;
        }
        return;
    }
    s->data_acc = (s->data_acc << 8) | d;
    s->pending_index++;
    if (s->pending_cmd == 0x2a && s->pending_index == 2) { s->start_x = s->data_acc; s->x = s->start_x; s->data_acc = 0; }
    else if (s->pending_cmd == 0x2a && s->pending_index == 4) { s->end_x = s->data_acc; s->data_acc = 0; }
    else if (s->pending_cmd == 0x2b && s->pending_index == 2) { s->start_y = s->data_acc; s->y = s->start_y; s->data_acc = 0; }
    else if (s->pending_cmd == 0x2b && s->pending_index == 4) { s->end_y = s->data_acc; s->data_acc = 0; }
    else if (s->pending_cmd == 0x36 && s->pending_index == 1) {
        s->tft_madctl = d;
        s->remap = (d & 0x40) != 0;
        s->scan_inv = (d & 0x80) != 0;
    }
    else if (s->pending_cmd == 0x3a && s->pending_index == 1) { s->data_bytes = (d & 0x10) ? 2 : 3; }
}

static void max_word(SimDevice* s, uint16_t word) {
    uint8_t addr = (uint8_t)((word >> 8) & 0x0f);
    uint8_t data = (uint8_t)(word & 0xff);
    uint8_t display = (uint8_t)(s->x % 16);
    if (addr >= 1 && addr <= 8) s->max_ram[display][addr - 1] = data;
    else if (addr == 9) s->max_decode[display] = data;
    else if (addr == 10) s->max_intensity[display] = 1 + (data & 0x0f);
    else if (addr == 11) s->max_scan[display] = data & 7;
    else if (addr == 12) s->max_shutdown[display] = !(data & 1);
    else if (addr == 15) s->max_test[display] = data & 1;
    s->x = (s->x + 1) & 15;
}

static void max_byte(SimDevice* s, uint8_t byte) {
    s->max_shift = (uint16_t)((s->max_shift << 8) | byte);
    s->data_index++;
    if (s->data_index < 2) return;
    s->data_index = 0;
    max_word(s, s->max_shift);
}

static uint8_t hd_data_pins(SimDevice* s) {
    uint8_t value = 0;
    if (s->data_length == 4) {
        for (uint32_t bit = 4; bit < 8; ++bit) {
            if (s->pin_level[3 + bit]) value |= (uint8_t)(1u << bit);
        }
    } else {
        for (uint32_t bit = 0; bit < 8; ++bit) {
            if (s->pin_level[3 + bit]) value |= (uint8_t)(1u << bit);
        }
    }
    return value;
}

static void hd_latch_parallel(SimDevice* s) {
    uint8_t rs = s->pin_level[0];
    uint8_t rw = s->pin_level[1];
    uint8_t value = hd_data_pins(s);
    if (rw) return;
    if (s->data_length == 4) {
        if (!s->nibble) {
            s->input = value & 0xf0;
            s->nibble = 1;
            return;
        }
        s->input |= (value >> 4) & 0x0f;
        value = (uint8_t)s->input;
        s->nibble = 0;
    }
    if (rs) hd_data(s, value);
    else hd_command(s, value);
}

static void pcd8544_command(SimDevice* s, uint8_t byte) {
    if ((byte & 0xf8) == 0x20) s->latch = byte;
    else if ((byte & 0xf8) == 0x40) s->y = byte & 7;
    else if (byte & 0x80) s->x = byte & 0x7f;
    else if ((byte & 0xf8) == 0x08) {
        const uint8_t normal = (byte & 0x04) != 0;
        const uint8_t alternate = (byte & 0x01) != 0;
        s->display_on = normal || alternate;
        s->full_on = !normal && alternate;
        s->invert = normal && alternate;
    }
}

static void pcd8544_data(SimDevice* s, uint8_t byte) {
    if (s->x < 84 && s->y < 6) s->bytes[s->y * 84 + s->x++] = byte;
    if (s->x >= 84) { s->x = 0; s->y = (s->y + 1) % 6; }
}

static void pcd8544_clock_bit(SimDevice* s) {
    s->shift_reg = ((s->shift_reg << 1) | (s->pin_level[3] ? 1u : 0u)) & 0xffu;
    if (++s->bit_count < 8) return;
    uint8_t byte = (uint8_t)(s->shift_reg & 0xffu);
    s->bit_count = 0;
    if (s->pin_level[2]) pcd8544_data(s, byte);
    else pcd8544_command(s, byte);
}

static void ks0108_selected(const SimDevice* s, uint8_t* chip0, uint8_t* chip1) {
    *chip0 = s->pin_level[10] != 0; /* CS1 */
    *chip1 = s->pin_level[9] != 0;  /* CS2 */
    if (!*chip0 && !*chip1) *chip1 = 1; /* comportamento do componente SimulIDE */
    if (s->ks_cs_active_low) {
        *chip0 = !*chip0;
        *chip1 = !*chip1;
    }
}

static void ks0108_reset(SimDevice* s) {
    s->ks_page[0] = s->ks_page[1] = 0;
    s->ks_col[0] = s->ks_col[1] = 0;
    s->ks_start_line = 0;
    s->display_on = 0;
    s->ks_reset = 1;
}

static void ks0108_command(SimDevice* s, uint8_t byte, uint8_t chip0, uint8_t chip1) {
    if (byte >= 62 && byte < 64) s->display_on = byte & 1;
    else if (byte >= 64 && byte < 128) {
        if (chip0) s->ks_col[0] = byte & 63;
        if (chip1) s->ks_col[1] = byte & 63;
    } else if (byte >= 184 && byte < 192) {
        if (chip0) s->ks_page[0] = byte & 7;
        if (chip1) s->ks_page[1] = byte & 7;
    } else if (byte >= 192) s->ks_start_line = byte & 63;
}

static void ks0108_data(SimDevice* s, uint8_t byte, uint8_t chip0, uint8_t chip1) {
    if (chip0) {
        s->bytes[s->ks_page[0] * 128 + s->ks_col[0]] = byte;
        s->ks_col[0] = (s->ks_col[0] + 1) & 63;
    }
    if (chip1) {
        s->bytes[s->ks_page[1] * 128 + 64 + s->ks_col[1]] = byte;
        s->ks_col[1] = (s->ks_col[1] + 1) & 63;
    }
}

static uint8_t ks0108_bus_value(SimDevice* s) {
    uint8_t value = 0;
    for (uint32_t bit = 0; bit < 8; ++bit)
        if (s->pin_level[bit]) value |= (uint8_t)(1u << bit);
    return value;
}

static void ks0108_latch_parallel(SimDevice* s, uint8_t rising) {
    uint8_t chip0, chip1;
    ks0108_selected(s, &chip0, &chip1);
    const uint8_t read = s->pin_level[12];
    const uint8_t data = s->pin_level[13];
    if (rising && read) {
        uint8_t value = 0;
        if (data) {
            if (chip0) value = s->bytes[s->ks_page[0] * 128 + s->ks_col[0]];
            if (chip1) value = s->bytes[s->ks_page[1] * 128 + 64 + s->ks_col[1]];
        } else {
            if (s->ks_reset) value |= 0x10;
            if (!s->display_on) value |= 0x20;
        }
        if (s->api->pin_write)
            for (uint32_t bit = 0; bit < 8; ++bit) s->api->pin_write(s->host_ctx, bit, (value >> bit) & 1);
        return;
    }
    if (rising || read || s->ks_reset) return;
    const uint8_t value = ks0108_bus_value(s);
    if (data) ks0108_data(s, value, chip0, chip1);
    else ks0108_command(s, value, chip0, chip1);
}

/* Só desloca -- NÃO aplica no estado visível (max_ram/intensity/etc) ainda. O MAX7219 real só
 * latcha no registrador interno na borda de SUBIDA de LOAD/CS (ver max_latch()); aplicar a cada
 * 16 bits, como antes, "funciona" com exatamente 1 word por janela de CS mas quebra com clock
 * extra ou cascata de vários chips no mesmo SCK/DIN (cada chip da cadeia só deveria latchar o seu
 * próprio word quando o LOAD comum sobe, não a cada 16 pulsos individuais). */
static void max_clock_bit(SimDevice* s) {
    s->shift_reg = ((s->shift_reg << 1) | (s->pin_level[1] ? 1u : 0u)) & 0xffffu;
    if (++s->bit_count < 16) return;
    max_word(s, (uint16_t)s->shift_reg);
    s->bit_count = 0;
    s->shift_reg = 0;
}

/* Chamado na borda de SUBIDA de LOAD/CS (pino 0) -- aqui sim o shift register afeta o estado
 * visível do chip, igual ao datasheet real ("data is latched on LOAD/CS rising edge"). */
static void max_latch(SimDevice* s) {
    s->bit_count = 0;
    s->shift_reg = 0;
    s->x = 0;
}

static void tft_clock_bit(SimDevice* s) {
    s->shift_reg = ((s->shift_reg << 1) | (s->pin_level[2] ? 1u : 0u)) & 0xffu;
    if (++s->bit_count < 8) return;
    uint8_t byte = (uint8_t)(s->shift_reg & 0xffu);
    s->bit_count = 0;
    if (s->pin_level[0]) tft_data(s, byte);
    else tft_command(s, byte);
}

/* Endereço real (7 bits, byte>>1) + ACK só quando o endereço bate -- se não bater, este device
 * nunca seta i2c_ack (nem aqui nem em stamp()), então SDA fica flutuando nesse ciclo: outro
 * device endereçado (ou o pull-up externo, se nenhum bater) decide o ACK/NACK real do barramento,
 * exatamente como múltiplos chips compartilhando o mesmo SCL/SDA fariam de verdade. */
static void i2c_clock_bit(SimDevice* s) {
    if (!s->i2c_started) return;
    if (s->i2c_ack) {
        /* O escravo precisa manter SDA baixo durante TODO o nono pulso de SCL. Antes o ACK era
         * removido nesta propria borda de subida; o solver entao via SDA subir ainda com SCL alto,
         * interpretava essa subida como STOP e o master amostrava NACK. Marque que a borda de ACK
         * aconteceu, mas deixe a liberacao real para a borda de descida de SCL. */
        s->i2c_ack_clocked = 1;
        s->bit_count = 0;
        s->shift_reg = 0;
        return;
    }
    s->shift_reg = ((s->shift_reg << 1) | (s->pin_level[1] ? 1u : 0u)) & 0xffu;
    if (++s->bit_count < 8) return;
    uint8_t byte = (uint8_t)(s->shift_reg & 0xffu);
    if (!s->i2c_seen_address) {
        s->i2c_seen_address = 1;
        s->i2c_addressed = (uint8_t)((byte >> 1) == s->i2c_address);
        if (s->i2c_addressed) s->i2c_ack_pending = 1;
    } else if (s->i2c_addressed) {
        i2c_payload_byte(s, byte);
        s->i2c_ack_pending = 1;
    }
}

static void handle_pin_change(SimDevice* s, uint32_t pin, uint32_t level) {
    if (s->misconfigured) return; /* ver validate_pin_order() -- ordem de pinos errada, fica inerte */
    if (pin >= 32) return;
    uint8_t old = s->pin_level[pin];
    uint8_t now = level ? 1 : 0;
    s->pin_level[pin] = now;
    if (old == now) return;

    if ((s->kind == KIND_AIP31068 || s->kind == KIND_OLED || s->kind == KIND_SH1107) && pin == 1 && s->pin_level[0]) {
        if (old && !now) {
            s->i2c_started = 1;
            s->i2c_ack = 0;
            s->i2c_ack_pending = 0;
            s->i2c_ack_clocked = 0;
            s->i2c_seen_address = 0;
            s->i2c_addressed = 0;
            s->i2c_phase = 0;
            s->bit_count = 0;
            s->shift_reg = 0;
        } else if (!old && now) {
            s->i2c_started = 0;
            s->i2c_ack = 0;
            s->i2c_ack_pending = 0;
            s->i2c_ack_clocked = 0;
            s->bit_count = 0;
            s->shift_reg = 0;
        }
    }

    if ((s->kind == KIND_AIP31068 || s->kind == KIND_OLED || s->kind == KIND_SH1107) && pin == 0) {
        if (!old && now) {
            i2c_clock_bit(s);
        } else if (old && !now && s->i2c_ack_pending) {
            /* O byte foi fechado na oitava borda de subida, mas o escravo so pode puxar SDA
             * depois que SCL baixar. Fazer isto ainda com SCL alto transforma o proprio ACK
             * (especialmente depois de byte terminado em bit 1) num falso START. */
            s->i2c_ack_pending = 0;
            s->i2c_ack = 1;
        } else if (old && !now && s->i2c_ack && s->i2c_ack_clocked) {
            /* Fim do nono pulso: agora SCL ja esta baixo e SDA pode ser liberado sem gerar um
             * falso STOP. O proximo byte volta a ser contado normalmente a partir de zero. */
            s->i2c_ack = 0;
            s->i2c_ack_clocked = 0;
            s->bit_count = 0;
            s->shift_reg = 0;
        }
    } else if (s->kind == KIND_HD44780 && pin == 2 && old && !now) {
        hd_latch_parallel(s);
    } else if (s->kind == KIND_KS0108) {
        if (pin == 8 && !now) ks0108_reset(s);
        else if (pin == 8 && now) s->ks_reset = 0;
        else if (pin == 11 && !old && now) ks0108_latch_parallel(s, 1);
        else if (pin == 11 && old && !now) ks0108_latch_parallel(s, 0);
    } else if (s->kind == KIND_PCD8544) {
        if (pin == 0 && !now) {
            memset(s->bytes, 0, sizeof(s->bytes));
            s->x = s->y = s->bit_count = s->shift_reg = 0;
        } else if (pin == 1 && now) {
            s->bit_count = 0;
            s->shift_reg = 0;
        } else if (pin == 4 && !old && now && !s->pin_level[1]) {
            pcd8544_clock_bit(s);
        }
    } else if (s->kind == KIND_MAX72XX) {
        if (pin == 0 && !old && now) {
            max_latch(s);
        } else if (pin == 2 && !old && now && !s->pin_level[0]) {
            max_clock_bit(s);
        }
    } else if (s->kind == KIND_TFT) {
        if (pin == 4 && !now) {
            tft_reset(s);
            s->bit_count = 0;
            s->shift_reg = 0;
        } else if (pin == 1 && now) {
            s->bit_count = 0;
            s->shift_reg = 0;
        } else if (pin == 3 && !old && now && !s->pin_level[1]) {
            tft_clock_bit(s);
        }
    }
}

static void ws_save_bit(SimDevice* s, uint8_t bit) {
    if (bit) s->data_acc |= (1u << s->ws_bit);
    else s->data_acc &= ~(1u << s->ws_bit);
    if (s->ws_bit-- != 0) return;
    s->ws_rgb[s->ws_byte++] = (uint8_t)s->data_acc;
    s->data_acc = 0;
    s->ws_bit = 7;
    if (s->ws_byte < 3) return;
    const uint32_t color = ((uint32_t)s->ws_rgb[1] << 16) |
                           ((uint32_t)s->ws_rgb[0] << 8) | s->ws_rgb[2];
    if (s->ws_led < s->ws_count) s->pixels[s->ws_led++] = color;
    s->ws_byte = 0;
}

static void ws_edge(SimDevice* s, uint32_t level, uint32_t elapsed_ns) {
    const uint32_t tolerance = 150;
    if (level) {
        if (elapsed_ns > s->ws_reset_us * 1000u) {
            s->data_acc = 0;
            s->ws_led = s->ws_byte = 0;
            s->ws_bit = 7;
            s->ws_new_word = 0;
            if (s->api->pin_write) s->api->pin_write(s->host_ctx, 1, 1);
            return;
        }
        const uint32_t low_ns = elapsed_ns;
        const uint32_t low_min = s->ws_t1l > tolerance ? s->ws_t1l - tolerance : 0;
        const uint32_t low_max = s->ws_t0l + tolerance;
        if (low_ns > low_min && low_ns < low_max) {
            if (s->ws_led >= s->ws_count) {
                if (s->api->pin_write) s->api->pin_write(s->host_ctx, 1, 1);
            } else if (s->ws_new_word) {
                if (s->ws_last_h && low_ns < s->ws_t1l + tolerance) ws_save_bit(s, 1);
                else if (!s->ws_last_h &&
                         low_ns > (s->ws_t0l > tolerance ? s->ws_t0l - tolerance : 0)) ws_save_bit(s, 0);
            }
        }
        s->ws_new_word = 1;
    } else {
        if (s->ws_led >= s->ws_count) {
            if (s->api->pin_write) s->api->pin_write(s->host_ctx, 1, 0);
            return;
        }
        const uint32_t high_ns = elapsed_ns;
        const uint32_t high_min = s->ws_t0h > tolerance ? s->ws_t0h - tolerance : 0;
        const uint32_t high_max = s->ws_t1h + tolerance;
        if (high_ns > high_min && high_ns < high_max) {
            s->ws_last_h = high_ns > (s->ws_t1h > tolerance ? s->ws_t1h - tolerance : 0);
            if (s->ws_byte == 2 && s->ws_bit == 0) {
                ws_save_bit(s, s->ws_last_h);
                s->ws_new_word = 0;
            }
        }
    }
}

static LsdnDevice* create(void* host_ctx, const LsdnHostApi* api) {
    SimDevice* s = (SimDevice*)calloc(1, sizeof(SimDevice));
    s->host_ctx = host_ctx;
    s->api = api;
    return (LsdnDevice*)s;
}

static void init(LsdnDevice* dev) {
    SimDevice* s = (SimDevice*)dev;
    strncpy(s->type_id, cfg_string(s, "__typeId", ""), sizeof(s->type_id) - 1);
    if (is_type(s, "hd44780")) s->kind = KIND_HD44780;
    else if (is_type(s, "aip31068")) s->kind = KIND_AIP31068;
    else if (is_type(s, "ssd1306")) s->kind = KIND_OLED;
    else if (is_type(s, "sh1107")) s->kind = KIND_SH1107;
    else if (is_type(s, "pcd8544")) s->kind = KIND_PCD8544;
    else if (is_type(s, "ks0108")) s->kind = KIND_KS0108;
    else if (is_type(s, "st7735") || is_type(s, "st7789") || is_type(s, "ili9341") || is_type(s, "gc9a01a") || is_type(s, "pcf8833")) s->kind = KIND_TFT;
    else if (is_type(s, "max72xx")) s->kind = KIND_MAX72XX;
    else if (is_type(s, "ws2812")) s->kind = KIND_WS2812;
    else if (is_type(s, "servo")) s->kind = KIND_SERVO;
    else if (is_type(s, "audio")) s->kind = KIND_AUDIO;
    else if (is_type(s, "transformer")) s->kind = KIND_TRANSFORMER;
    else if (is_type(s, "diac")) s->kind = KIND_DIAC;
    else if (is_type(s, "scr")) s->kind = KIND_SCR;
    else if (is_type(s, "triac")) s->kind = KIND_TRIAC;
    else if (is_type(s, "bjt")) s->kind = KIND_BJT;
    else if (is_type(s, "mosfet")) s->kind = KIND_MOSFET;
    else if (is_type(s, "jfet")) s->kind = KIND_JFET;

    {
        const double i2cDefault = is_type(s, "aip31068") ? 0x3E : 0x3C; /* OLED (ssd1306/sh1107) = 0x3C */
        s->i2c_address = (uint8_t)cfg_number(s, "i2cAddress", i2cDefault);
    }

    s->rows = (uint32_t)cfg_number(s, "rows", 2);
    s->cols = (uint32_t)cfg_number(s, "columns", 16);
    s->width = (uint32_t)cfg_number(s, "width", is_type(s, "gc9a01a") ? 240 : (is_type(s, "st7735") ? 132 : 128));
    s->height = (uint32_t)cfg_number(s, "height", is_type(s, "sh1107") ? 128 : (is_type(s, "st") || is_type(s, "ili9341") ? 160 : 64));
    if (is_type(s, "st7789") || is_type(s, "ili9341")) { s->width = 240; s->height = 320; }
    if (is_type(s, "gc9a01a")) { s->width = 240; s->height = 240; }
    if (is_type(s, "pcf8833")) { s->width = 132; s->height = 132; }
    if (s->kind == KIND_OLED || s->kind == KIND_SH1107) s->rows = s->height / 8;
    else if (s->kind == KIND_PCD8544) { s->width = 84; s->height = 48; s->rows = 6; }
    else if (s->kind == KIND_KS0108) { s->width = 128; s->height = 64; s->rows = 8; }
    s->direction = 1; s->line_length = 80; s->data_length = 8; hd_clear(s);
    if (s->kind == KIND_OLED || s->kind == KIND_SH1107) oled_reset(s);
    s->oled_rotate = (uint8_t)cfg_bool(s, "imageRotated", s->kind == KIND_OLED);
    s->oled_x_offset = (uint8_t)cfg_bool(s, "xOffset", s->kind == KIND_SH1107);
    if (s->kind == KIND_TFT) tft_reset(s);
    for (uint32_t display = 0; display < 16; ++display) {
        s->max_scan[display] = 7;
        s->max_shutdown[display] = 1;
    }
    s->ws_count = (uint32_t)(cfg_number(s, "rows", 1) * cfg_number(s, "columns", 1));
    if (s->ws_count == 0) s->ws_count = 1;
    if (s->ws_count > 240u * 320u) s->ws_count = 240u * 320u;
    if (s->kind == KIND_WS2812) {
        s->width = (uint32_t)cfg_number(s, "columns", 1);
        s->height = (uint32_t)cfg_number(s, "rows", 1);
    }
    if (s->kind == KIND_MAX72XX) {
        uint32_t displays = (uint32_t)cfg_number(s, "numDisplays", 4);
        if (displays < 1) displays = 1;
        if (displays > 16) displays = 16;
        s->width = displays * 8;
        s->height = 8;
    }
    if (s->kind == KIND_KS0108) {
        s->ks_cs_active_low = (uint8_t)cfg_bool(s, "csActiveLow", 0);
        ks0108_reset(s);
    }
    s->ws_t0h = (uint32_t)cfg_number(s, "t0h", 400);
    s->ws_t0l = (uint32_t)cfg_number(s, "t0l", 850);
    s->ws_t1h = (uint32_t)cfg_number(s, "t1h", 850);
    s->ws_t1l = (uint32_t)cfg_number(s, "t1l", 400);
    s->ws_reset_us = (uint32_t)cfg_number(s, "resetPulse", 50);
    s->ws_bit = 7;
    s->servo_min = cfg_number(s, "minPulse", 1000);
    s->servo_max = cfg_number(s, "maxPulse", 2000);
    s->servo_speed = cfg_number(s, "speed", 0.2);
    s->servo_pos = s->servo_target = 90;
    s->audio_impedance = cfg_number(s, "impedance", 8);
    s->audio_frequency = cfg_number(s, "frequency", 1000);
    s->p[0] = cfg_number(s, "resOn", 500);
    s->p[1] = cfg_number(s, "resOff", 1e8);
    s->p[2] = cfg_number(s, "breakdown", 30);
    s->p[3] = cfg_number(s, "holdCurrent", 0.01);

    if (s->kind == KIND_HD44780) {
        static const char* const kExpected[] = {"rs", "rw", "en", "d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7"};
        validate_pin_order(s, kExpected, 11);
    } else if (s->kind == KIND_KS0108) {
        static const char* const kExpected[] = {
            "d0", "d1", "d2", "d3", "d4", "d5", "d6", "d7",
            "rst", "cs2", "cs1", "en", "rw", "rs"
        };
        validate_pin_order(s, kExpected, 14);
    } else if (s->kind == KIND_AIP31068 || s->kind == KIND_OLED || s->kind == KIND_SH1107) {
        static const char* const kExpected[] = {"scl", "sda"};
        validate_pin_order(s, kExpected, 2);
    } else if (s->kind == KIND_TFT) {
        static const char* const kExpected[] = {"dc", "cs", "sda", "sck", "reset"};
        validate_pin_order(s, kExpected, 5);
    } else if (s->kind == KIND_MAX72XX) {
        static const char* const kExpected[] = {"cs", "din", "sck"};
        validate_pin_order(s, kExpected, 3);
    } else if (s->kind == KIND_PCD8544) {
        static const char* const kExpected[] = {"rst", "ce", "dc", "din", "clk"};
        validate_pin_order(s, kExpected, 5);
    } else if (s->kind == KIND_SERVO) {
        static const char* const kExpected[] = {"vcc", "gnd", "sig"};
        validate_pin_order(s, kExpected, 3);
    } else if (s->kind == KIND_WS2812) {
        static const char* const kExpected[] = {"din", "dout"};
        validate_pin_order(s, kExpected, 2);
    }
}

static void stamp(LsdnDevice* dev, LsdnMatrixView* m) {
    SimDevice* s = (SimDevice*)dev;
    if (!m) return;
    if (s->kind == KIND_AUDIO && s->audio_impedance > 0) m->add_conductance(m->opaque, 0, 1, 1.0 / s->audio_impedance);
    else if (s->kind == KIND_DIAC) {
        double v = m->get_node_voltage(m->opaque, 0) - m->get_node_voltage(m->opaque, 1);
        if (fabs(v) > s->p[2]) s->latch = 1;
        m->add_conductance(m->opaque, 0, 1, s->latch ? 1.0 / s->p[0] : 1.0 / s->p[1]);
    } else if (s->kind == KIND_SCR || s->kind == KIND_TRIAC) {
        double gate = fabs(m->get_node_voltage(m->opaque, 2) - m->get_node_voltage(m->opaque, 1));
        if (gate / 100.0 > 0.01) s->latch = 1;
        m->add_conductance(m->opaque, 2, 1, 1.0 / 100.0);
        m->add_conductance(m->opaque, 0, 1, s->latch ? 100.0 : 1e-6);
    } else if (s->kind == KIND_BJT) {
        double vbe = m->get_node_voltage(m->opaque, 1) - m->get_node_voltage(m->opaque, 2);
        double on = vbe > 0.65 ? 1.0 : 0.0;
        m->add_conductance(m->opaque, 1, 2, on ? 1e-3 : 1e-9);
        m->add_conductance(m->opaque, 0, 2, on ? 0.1 : 1e-9);
    } else if (s->kind == KIND_MOSFET || s->kind == KIND_JFET) {
        double vgs = m->get_node_voltage(m->opaque, 2) - m->get_node_voltage(m->opaque, 1);
        double th = s->kind == KIND_JFET ? -3.0 : 3.0;
        double on = s->kind == KIND_JFET ? (vgs > th) : (vgs > th);
        m->add_conductance(m->opaque, 0, 1, on ? 1.0 : 1e-9);
    } else if (s->kind == KIND_TRANSFORMER) {
        m->add_conductance(m->opaque, 0, 1, 1e-6);
        m->add_conductance(m->opaque, 2, 3, 1e-6);
    }

    /* ACK elétrico real de I2C: puxa SDA (pino 1) pra GND só durante o ciclo de ACK -- ver
     * i2c_clock_bit(). 200ohm: baixo o bastante pra "vencer" o pull-up externo que o circuito
     * precisa desenhar (igual hardware real -- sem pull-up no barramento, nada flutua pra 1
     * sozinho, exatamente como I2C de verdade). Fora do ciclo de ACK isto não estampa nada -- SDA
     * fica livre pro master ou pra outro device decidirem o nível. */
    if ((s->kind == KIND_AIP31068 || s->kind == KIND_OLED || s->kind == KIND_SH1107) && s->i2c_ack && s->i2c_addressed) {
        m->add_conductance_to_ground(m->opaque, 1, 1.0 / 200.0);
    }
}

static void post_step(LsdnDevice* dev, uint64_t dt_ns) {
    SimDevice* s = (SimDevice*)dev;
    if (s->kind == KIND_SERVO) {
        double max_move = s->servo_speed > 0 ? ((double)dt_ns / 1e9) / s->servo_speed * 60.0 : 180.0;
        double delta = s->servo_target - s->servo_pos;
        if (fabs(delta) > max_move) delta = delta < 0 ? -max_move : max_move;
        s->servo_pos += delta;
    } else if ((s->kind == KIND_OLED || s->kind == KIND_SH1107) &&
               (s->oled_scroll || s->oled_scroll_single)) {
        s->oled_scroll_elapsed_ns += dt_ns;
        const uint64_t interval_ns = (uint64_t)(s->oled_scroll_interval ? s->oled_scroll_interval : 1) * 16666667ull;
        if (s->oled_scroll_single || s->oled_scroll_elapsed_ns >= interval_ns) {
            oled_scroll_once(s);
            s->oled_scroll_elapsed_ns = 0;
            s->oled_scroll_single = 0;
        }
    }
}

/* Único caminho de entrada de dado de protocolo (I2C/SPI paralelo/1-wire/PWM): borda real de pino,
 * decodificada bit a bit por cada `*_clock_bit`/`*_latch_parallel`/`ws_edge` chamado a partir de
 * `handle_pin_change` -- nunca um "byte já pronto" entregue por um barramento que pulasse a
 * simulação elétrica (ver nota da ABI 2.0 em device_abi.h). */
static void on_event(LsdnDevice* dev, const LsdnEvent* ev) {
    SimDevice* s = (SimDevice*)dev;
    if (!ev || ev->tag != EV_PIN_CHANGE) return;

    handle_pin_change(s, ev->a, ev->b);
    if (s->kind == KIND_WS2812) ws_edge(s, ev->b, ev->c);
    else if (s->kind == KIND_SERVO) {
        const uint8_t powered = s->pin_level[0] && !s->pin_level[1];
        if (!powered) {
            s->servo_target = 90;
            s->servo_pulse_start = 0;
        } else if (ev->a != 2) {
            return;
        } else if (ev->b) s->servo_pulse_start = 0;
        else {
            double pulse = (double)ev->c / 1000.0;
            const double range = s->servo_max - s->servo_min;
            if (range <= 0) return;
            s->servo_target = (pulse - s->servo_min) * 180.0 / range;
            if (s->servo_target < 0) s->servo_target = 0;
            if (s->servo_target > 180) s->servo_target = 180;
        }
    }
}

static uint32_t get_property(LsdnDevice* dev, const char* name, LsdnPropertyValue* out) {
    SimDevice* s = (SimDevice*)dev;
    if (!name || !out) return 0;
    memset(out, 0, sizeof(*out));
    out->kind = LSDN_PROPERTY_NUMBER;
    if (strcmp(name, "angle") == 0) out->number_value = s->servo_pos;
    else if (strcmp(name, "displayOn") == 0) out->number_value = s->display_on;
    else return 0;
    return 1;
}

static uint32_t set_property(LsdnDevice* dev, const char* name, const LsdnPropertyValue* value) {
    SimDevice* s = (SimDevice*)dev;
    if (!name || !value || value->kind != LSDN_PROPERTY_NUMBER) return 0;
    if (strcmp(name, "minPulse") == 0) s->servo_min = value->number_value;
    else if (strcmp(name, "maxPulse") == 0) s->servo_max = value->number_value;
    else if (strcmp(name, "speed") == 0) s->servo_speed = value->number_value;
    else return 0;
    return 1;
}

/* ABI v2 (.spec/archive/legacy-v2/lasecsimul-native-devices.spec): header[0] passa a ser um uint32 de versão de
 * layout, antes dos campos que já existiam (deslocados +1 posição) -- set_state rejeita
 * (loga e ignora, mantém estado atual) um blob de versão diferente da que este binário entende,
 * em vez de interpretar offsets de um layout potencialmente diferente às cegas. */
#define SIMULIDE_COMPLEX_STATE_VERSION 1u
#define SIMULIDE_COMPLEX_STATE_HEADER_BYTES 36u /* 9 * sizeof(uint32_t) */

static void visible_mono_payload(const SimDevice* s, uint8_t* payload, uint32_t payload_bytes) {
    memset(payload, 0, payload_bytes);
    if (!s->display_on) return;
    if (s->full_on) {
        memset(payload, 0xff, payload_bytes);
        return;
    }
    if (s->kind != KIND_OLED && s->kind != KIND_SH1107) {
        const uint32_t raw_bytes = s->width * ((s->height + 7) / 8);
        const uint32_t count = raw_bytes < payload_bytes ? raw_bytes : payload_bytes;
        memcpy(payload, s->bytes, count);
        if (s->invert)
            for (uint32_t i = 0; i < count; ++i) payload[i] = (uint8_t)~payload[i];
        return;
    }

    /* Converte GDDRAM em pixels já vistos no vidro. Assim o contrato da Webview continua genérico
     * (páginas LSB), enquanto remap, COM scan, start-line, display-offset e rotação pertencem ao
     * controlador nativo, como no paint() de OledController do SimulIDE. */
    for (uint32_t source_y = 0; source_y < s->height; ++source_y) {
        const uint32_t ram_y = (source_y + s->oled_start_line) % s->height;
        for (uint32_t source_x = 0; source_x < s->width; ++source_x) {
            const uint32_t source = (ram_y / 8) * s->width + source_x;
            uint8_t lit = (s->bytes[source] >> (ram_y & 7)) & 1;
            if (s->invert) lit = !lit;
            if (!lit) continue;
            uint32_t dest_x = s->remap ? s->width - 1 - source_x : source_x;
            uint32_t dest_y = (source_y + s->oled_display_offset) % s->height;
            if (s->scan_inv) dest_y = s->height - 1 - dest_y;
            if (s->oled_rotate) {
                dest_x = s->width - 1 - dest_x;
                dest_y = s->height - 1 - dest_y;
            }
            const uint32_t target = (dest_y / 8) * s->width + dest_x;
            if (target < payload_bytes) payload[target] |= (uint8_t)(1u << (dest_y & 7));
        }
    }
}

static void visible_max7219_payload(const SimDevice* s, uint8_t* payload, uint32_t payload_bytes) {
    const uint32_t displays = s->width / 8;
    memset(payload, 0, payload_bytes);
    for (uint32_t display = 0; display < displays && display < 16; ++display) {
        const uint8_t intensity = s->max_intensity[display];
        const uint8_t luma = (uint8_t)(25 + 230 * intensity / 16);
        for (uint32_t row = 0; row < 8; ++row) {
            for (uint32_t col = 0; col < 8; ++col) {
                const uint8_t bit = s->max_ram[display][row] & (0x80u >> col);
                const uint8_t lit = !s->max_shutdown[display] &&
                    (s->max_test[display] || (!s->max_decode[display] && row <= s->max_scan[display] && bit));
                const uint32_t target = row * s->width + display * 8 + col;
                if (target < payload_bytes) payload[target] = lit ? luma : 0;
            }
        }
    }
}

static uint32_t get_state(LsdnDevice* dev, uint8_t* out, uint32_t cap) {
    SimDevice* s = (SimDevice*)dev;
    uint32_t need = SIMULIDE_COMPLEX_STATE_HEADER_BYTES;
    if (s->kind == KIND_HD44780 || s->kind == KIND_AIP31068) need += 80;
    else if (s->kind == KIND_TFT) need += s->width * s->height * 4;
    else if (s->kind == KIND_MAX72XX) need += s->width * s->height;
    else if (s->kind == KIND_WS2812) need += s->ws_count * 4;
    else if (s->kind == KIND_SERVO || s->kind == KIND_AUDIO) need += 0;
    else need += s->width * (s->height / 8 ? s->height / 8 : 1);
    /* Consulta de tamanho / retry genérico: framebuffers TFT ultrapassam 64 KiB. */
    if (!out || cap < need) return need;
    uint32_t header[9] = {SIMULIDE_COMPLEX_STATE_VERSION, (uint32_t)s->kind, s->width, s->height,
                           s->display_on, s->x, s->y, (uint32_t)(s->servo_pos * 1000.0), need};
    memcpy(out, header, sizeof(header));
    uint8_t* payload = out + SIMULIDE_COMPLEX_STATE_HEADER_BYTES;
    const uint32_t payloadCap = need - SIMULIDE_COMPLEX_STATE_HEADER_BYTES;
    if (s->kind == KIND_HD44780 || s->kind == KIND_AIP31068) memcpy(payload, s->ddram, 80);
    else if (s->kind == KIND_TFT) {
        memcpy(payload, s->pixels, payloadCap);
        if (s->invert) {
            for (uint32_t pixel = 0; pixel < s->width * s->height; ++pixel) {
                payload[pixel * 4] ^= 0xff;
                payload[pixel * 4 + 1] ^= 0xff;
                payload[pixel * 4 + 2] ^= 0xff;
            }
        }
    }
    else if (s->kind == KIND_MAX72XX) visible_max7219_payload(s, payload, payloadCap);
    else if (s->kind == KIND_WS2812) memcpy(payload, s->pixels, s->ws_count * 4);
    else visible_mono_payload(s, payload, payloadCap);
    return need;
}

static void set_state(LsdnDevice* dev, const uint8_t* in, uint32_t len) {
    SimDevice* s = (SimDevice*)dev;
    if (!in || len < SIMULIDE_COMPLEX_STATE_HEADER_BYTES) return;
    const uint32_t* header = (const uint32_t*)in;
    if (header[0] != SIMULIDE_COMPLEX_STATE_VERSION) {
        if (s->api->log) s->api->log(s->host_ctx, 1, "simulide-complex: set_state versao desconhecida, ignorado");
        return;
    }
    s->display_on = (uint8_t)header[4];
    s->x = header[5];
    s->y = header[6];
    s->servo_pos = (double)header[7] / 1000.0;
}

static void destroy(LsdnDevice* dev) { free(dev); }

static uint32_t i2c_transfer(LsdnDevice* dev, const LsdnI2cTransfer* transfer,
                             LsdnI2cTransferResult* result) {
    SimDevice* s = (SimDevice*)dev;
    if (!transfer || !result) return 0;
    memset(result, 0, sizeof(*result));
    result->first_nack = LSDN_I2C_NO_NACK;
    if (s->kind != KIND_AIP31068 && s->kind != KIND_OLED && s->kind != KIND_SH1107) return 0;
    result->handled = 1;
    if (transfer->address != s->i2c_address) return 1;
    result->address_ack = 1;
    if (transfer->read) {
        /* Os displays modelados são write-only nesta implementação. O endereço existe, mas o
         * primeiro byte de leitura recebe NACK em vez de fabricar dados. */
        result->first_nack = 0;
        return 1;
    }
    if (transfer->start) s->i2c_phase = 0;
    for (uint32_t i = 0; i < transfer->tx_size; ++i) i2c_payload_byte(s, transfer->tx_data[i]);
    return 1;
}

static const LsdnDeviceVTable kVTable = {
    create, init, stamp, post_step, on_event, get_property, set_property, get_state, set_state,
    destroy, i2c_transfer
};

LSDN_EXPORT
const LsdnDeviceVTable* lsdn_get_vtable(uint32_t* abi_major, uint32_t* abi_minor) {
    *abi_major = LSDN_ABI_VERSION_MAJOR;
    *abi_minor = LSDN_ABI_VERSION_MINOR;
    return &kVTable;
}
