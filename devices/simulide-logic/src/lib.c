#include "lasecsimul/device_abi.h"

#include <math.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#define LOGIC_HIGH 5.0
#define LOGIC_THRESHOLD 2.5
#define DRIVE_G 1000000000.0
#define DISCHARGE_G 1000.0
#define I2C_PULLDOWN_G 0.005
#define OPEN_COLLECTOR_PULLUP_G 0.00001

enum {
    I2C_IDLE = 0,
    I2C_ADDRESS,
    I2C_RX,
    I2C_TX,
    I2C_TX_ACK
};

typedef struct {
    void* host_ctx;
    const LsdnHostApi* api;
    char type_id[96];
    char functions[512];
    uint32_t pin_count;
    uint32_t state;
    uint32_t latch;
    uint8_t mem[65536];
    uint8_t prev[32];
    uint8_t pin_level[32];
    uint8_t scheduled;
    uint8_t out_level;
    uint8_t i2c_state;
    uint8_t i2c_addressed;
    uint8_t i2c_ack;
    uint8_t i2c_rw;
    uint8_t i2c_tx_byte;
    uint8_t i2c_tx_bit;
    uint8_t i2c_reading_ack;
    uint8_t i2c_phase;
    uint8_t i2c_port_state;
    uint8_t i2c_output_state;
    uint8_t i2c_int_state;
    uint8_t bit_count;
    uint8_t rx_reg;
    uint8_t tx_drive_low;
    uint8_t control_code;
    uint32_t mem_size;
    uint32_t addr_ptr;
} LogicDevice;

static int streq(const LogicDevice* s, const char* id) { return strcmp(s->type_id, id) == 0; }

static double cfg_num(LogicDevice* s, const char* name, double fallback) {
    LsdnPropertyValue value;
    memset(&value, 0, sizeof(value));
    if (s->api->config_get && s->api->config_get(s->host_ctx, name, &value) && value.kind == LSDN_PROPERTY_NUMBER) {
        return value.number_value;
    }
    return fallback;
}

static const char* cfg_string(LogicDevice* s, const char* name, const char* fallback) {
    LsdnPropertyValue value;
    memset(&value, 0, sizeof(value));
    if (s->api->config_get && s->api->config_get(s->host_ctx, name, &value) && value.kind == LSDN_PROPERTY_STRING && value.string_value) {
        return value.string_value;
    }
    return fallback;
}

static int cfg_bool(LogicDevice* s, const char* name, int fallback) {
    LsdnPropertyValue value;
    memset(&value, 0, sizeof(value));
    if (s->api->config_get && s->api->config_get(s->host_ctx, name, &value) && value.kind == LSDN_PROPERTY_BOOL) {
        return value.bool_value != 0;
    }
    return fallback;
}

static int read_level(LsdnMatrixView* matrix, uint32_t pin) {
    return matrix && matrix->get_node_voltage && matrix->get_node_voltage(matrix->opaque, pin) > LOGIC_THRESHOLD;
}

static double read_volts(LsdnMatrixView* matrix, uint32_t pin) {
    return (matrix && matrix->get_node_voltage) ? matrix->get_node_voltage(matrix->opaque, pin) : 0.0;
}

static void drive_volts(LsdnMatrixView* matrix, uint32_t pin, double volts) {
    if (!matrix || !matrix->add_conductance_to_ground || !matrix->add_current_to_ground) return;
    matrix->add_conductance_to_ground(matrix->opaque, pin, DRIVE_G);
    matrix->add_current_to_ground(matrix->opaque, pin, volts * DRIVE_G);
}

static void drive_level(LsdnMatrixView* matrix, uint32_t pin, int level) {
    drive_volts(matrix, pin, level ? LOGIC_HIGH : 0.0);
}

static int rising(LogicDevice* s, uint32_t pin, int now) {
    const int was = pin < 32 ? s->prev[pin] != 0 : 0;
    if (pin < 32) s->prev[pin] = (uint8_t)(now ? 1 : 0);
    return now && !was;
}

static uint32_t bits_in(LsdnMatrixView* matrix, uint32_t first, uint32_t count) {
    uint32_t value = 0;
    for (uint32_t i = 0; i < count; ++i) {
        if (read_level(matrix, first + i)) value |= (1u << i);
    }
    return value;
}

static void bits_out(LsdnMatrixView* matrix, uint32_t first, uint32_t count, uint32_t value) {
    for (uint32_t i = 0; i < count; ++i) drive_level(matrix, first + i, (value >> i) & 1u);
}

static void open_collector_out(LsdnMatrixView* matrix, uint32_t pin, int released) {
    if (!matrix || !matrix->add_conductance_to_ground || !matrix->add_current_to_ground) return;
    if (released) {
        matrix->add_conductance_to_ground(matrix->opaque, pin, OPEN_COLLECTOR_PULLUP_G);
        matrix->add_current_to_ground(matrix->opaque, pin, LOGIC_HIGH * OPEN_COLLECTOR_PULLUP_G);
    } else {
        matrix->add_conductance_to_ground(matrix->opaque, pin, I2C_PULLDOWN_G);
    }
}

static uint32_t seven_seg(uint32_t value) {
    static const uint8_t map[16] = {
        0x3f, 0x06, 0x5b, 0x4f, 0x66, 0x6d, 0x7d, 0x07,
        0x7f, 0x6f, 0x77, 0x7c, 0x39, 0x5e, 0x79, 0x71
    };
    return map[value & 0x0f];
}

static void stamp_gate(LogicDevice* s, LsdnMatrixView* matrix) {
    const int a = read_level(matrix, 0);
    const int b = read_level(matrix, 1);
    int out = a;
    if (streq(s, "logic.and_gate")) out = a && b;
    else if (streq(s, "logic.or_gate")) out = a || b;
    else if (streq(s, "logic.xor_gate")) out = !!(a ^ b);
    drive_level(matrix, streq(s, "logic.buffer") ? 1 : 2, out);
}

static void stamp_counter(LogicDevice* s, LsdnMatrixView* matrix) {
    const int clk = read_level(matrix, 0);
    const int rst = read_level(matrix, 1);
    const uint32_t bits = streq(s, "logic.counter") ? 1u : 4u;
    const uint32_t max_value = streq(s, "logic.counter") ? (uint32_t)cfg_num(s, "maxValue", 1) : 15u;
    if (rst) s->state = 0;
    else if (rising(s, 0, clk)) {
        s->state++;
        if (s->state > max_value) s->state = 0;
    }
    if (streq(s, "logic.counter")) drive_level(matrix, 2, s->state == max_value);
    else bits_out(matrix, 2, bits, s->state);
}

static void stamp_full_adder(LsdnMatrixView* matrix) {
    const int a = read_level(matrix, 0);
    const int b = read_level(matrix, 1);
    const int cin = read_level(matrix, 2);
    const int sum = a ^ b ^ cin;
    const int cout = (a && b) || (a && cin) || (b && cin);
    drive_level(matrix, 3, sum);
    drive_level(matrix, 4, cout);
}

static void stamp_magnitude_comp(LsdnMatrixView* matrix) {
    const uint32_t a = bits_in(matrix, 0, 4);
    const uint32_t b = bits_in(matrix, 4, 4);
    drive_level(matrix, 8, a > b);
    drive_level(matrix, 9, a == b);
    drive_level(matrix, 10, a < b);
}

static void stamp_shift_reg(LogicDevice* s, LsdnMatrixView* matrix) {
    const int clk = read_level(matrix, 0);
    const int data = read_level(matrix, 1);
    const int rst = read_level(matrix, 2);
    if (rst) s->state = 0;
    else if (rising(s, 0, clk)) s->state = ((s->state << 1) | (uint32_t)data) & 0xffu;
    bits_out(matrix, 3, 8, s->state);
}

typedef struct {
    const char* p;
    LsdnMatrixView* matrix;
    uint32_t input_count;
    uint32_t output_count;
    double output_volts[8];
} ExprParser;

static void expr_ws(ExprParser* p) {
    while (*p->p == ' ' || *p->p == '\t' || *p->p == '\r' || *p->p == '\n') p->p++;
}

static int expr_match(ExprParser* p, const char* text) {
    expr_ws(p);
    const size_t n = strlen(text);
    if (strncmp(p->p, text, n) != 0) return 0;
    p->p += n;
    return 1;
}

static double expr_or(ExprParser* p);

static double expr_primary(ExprParser* p) {
    expr_ws(p);
    if (expr_match(p, "(")) {
        const double v = expr_or(p);
        (void)expr_match(p, ")");
        return v;
    }
    if ((*p->p >= '0' && *p->p <= '9') || *p->p == '.') {
        char* end = 0;
        const double v = strtod(p->p, &end);
        p->p = end;
        return v;
    }
    if ((*p->p == 'i' || *p->p == 'I') && p->p[1] >= '0' && p->p[1] <= '9') {
        p->p++;
        const uint32_t pin = (uint32_t)strtoul(p->p, (char**)&p->p, 10);
        return pin < p->input_count ? (double)read_level(p->matrix, pin) : 0.0;
    }
    if ((*p->p == 'v' || *p->p == 'V') && (p->p[1] == 'i' || p->p[1] == 'I') && p->p[2] >= '0' && p->p[2] <= '9') {
        p->p += 2;
        const uint32_t pin = (uint32_t)strtoul(p->p, (char**)&p->p, 10);
        return pin < p->input_count ? read_volts(p->matrix, pin) : 0.0;
    }
    if ((*p->p == 'v' || *p->p == 'V') && (p->p[1] == 'o' || p->p[1] == 'O') && p->p[2] >= '0' && p->p[2] <= '9') {
        p->p += 2;
        const uint32_t pin = (uint32_t)strtoul(p->p, (char**)&p->p, 10);
        return pin < p->output_count ? p->output_volts[pin] : 0.0;
    }
    if ((*p->p == 'o' || *p->p == 'O') && p->p[1] >= '0' && p->p[1] <= '9') {
        p->p++;
        const uint32_t pin = (uint32_t)strtoul(p->p, (char**)&p->p, 10);
        return pin < p->output_count ? p->output_volts[pin] > LOGIC_THRESHOLD : 0.0;
    }
    if (strncmp(p->p, "true", 4) == 0) {
        p->p += 4;
        return 1.0;
    }
    if (strncmp(p->p, "false", 5) == 0) {
        p->p += 5;
        return 0.0;
    }
    return 0.0;
}

static double expr_unary(ExprParser* p) {
    if (expr_match(p, "!")) return expr_unary(p) == 0.0;
    if (expr_match(p, "-")) return -expr_unary(p);
    return expr_primary(p);
}

static double expr_mul(ExprParser* p) {
    double v = expr_unary(p);
    for (;;) {
        if (expr_match(p, "*")) v *= expr_unary(p);
        else if (expr_match(p, "/")) {
            const double d = expr_unary(p);
            v = d == 0.0 ? 0.0 : v / d;
        } else return v;
    }
}

static double expr_add(ExprParser* p) {
    double v = expr_mul(p);
    for (;;) {
        if (expr_match(p, "+")) v += expr_mul(p);
        else if (expr_match(p, "-")) v -= expr_mul(p);
        else return v;
    }
}

static double expr_cmp(ExprParser* p) {
    double v = expr_add(p);
    for (;;) {
        if (expr_match(p, ">=")) v = v >= expr_add(p);
        else if (expr_match(p, "<=")) v = v <= expr_add(p);
        else if (expr_match(p, "==")) v = fabs(v - expr_add(p)) < 1e-9;
        else if (expr_match(p, "!=")) v = fabs(v - expr_add(p)) >= 1e-9;
        else if (expr_match(p, ">")) v = v > expr_add(p);
        else if (expr_match(p, "<")) v = v < expr_add(p);
        else return v;
    }
}

static double expr_and(ExprParser* p) {
    double v = expr_cmp(p);
    for (;;) {
        if (expr_match(p, "&&") || expr_match(p, "&")) v = (v != 0.0) && (expr_cmp(p) != 0.0);
        else return v;
    }
}

static double expr_xor(ExprParser* p) {
    double v = expr_and(p);
    for (;;) {
        if (expr_match(p, "^^") || expr_match(p, "^")) v = ((v != 0.0) != (expr_and(p) != 0.0));
        else return v;
    }
}

static double expr_or(ExprParser* p) {
    double v = expr_xor(p);
    for (;;) {
        if (expr_match(p, "||") || expr_match(p, "|")) v = (v != 0.0) || (expr_xor(p) != 0.0);
        else return v;
    }
}

static void stamp_function(LogicDevice* s, LsdnMatrixView* matrix) {
    char local[sizeof(s->functions)];
    strncpy(local, s->functions[0] ? s->functions : "i0 | i1", sizeof(local) - 1);
    local[sizeof(local) - 1] = 0;

    ExprParser parser;
    memset(&parser, 0, sizeof(parser));
    parser.matrix = matrix;
    parser.input_count = 2;
    parser.output_count = 1;
    for (uint32_t i = 0; i < parser.output_count; ++i) parser.output_volts[i] = read_volts(matrix, parser.input_count + i);

    char* cursor = local;
    for (uint32_t out = 0; out < parser.output_count && cursor; ++out) {
        char* next = strchr(cursor, ',');
        if (next) *next++ = 0;
        while (*cursor == ' ' || *cursor == '\t') cursor++;
        int voltage_expr = 0;
        if ((cursor[0] == 'v' || cursor[0] == 'V') && (cursor[1] == 'o' || cursor[1] == 'O')) {
            char* eq = strchr(cursor, '=');
            if (eq) {
                cursor = eq + 1;
                voltage_expr = 1;
            }
        }
        parser.p = cursor;
        const double result = expr_or(&parser);
        if (voltage_expr) {
            parser.output_volts[out] = result;
            drive_volts(matrix, parser.input_count + out, result);
        } else {
            parser.output_volts[out] = result ? LOGIC_HIGH : 0.0;
            drive_level(matrix, parser.input_count + out, result != 0.0);
        }
        cursor = next;
    }
}

static void stamp_flipflop(LogicDevice* s, LsdnMatrixView* matrix) {
    uint32_t q = s->state & 1u;
    if (streq(s, "logic.flipflop_rs")) {
        const int set = read_level(matrix, 0);
        const int rst = read_level(matrix, 1);
        if (rst && !set) q = 0;
        else if (set && !rst) q = 1;
        else if (set && rst) q = 0;
        drive_level(matrix, 2, q);
        drive_level(matrix, 3, !q);
        s->state = q;
        return;
    }

    const int set = streq(s, "logic.flipflop_t") ? read_level(matrix, 2) :
                    streq(s, "logic.flipflop_jk") ? read_level(matrix, 2) : read_level(matrix, 1);
    const int rst = streq(s, "logic.flipflop_t") ? read_level(matrix, 3) :
                    streq(s, "logic.flipflop_jk") ? read_level(matrix, 3) : read_level(matrix, 2);
    const int clk_pin = streq(s, "logic.flipflop_t") ? 1 : streq(s, "logic.flipflop_jk") ? 4 : 3;
    const int clk = read_level(matrix, (uint32_t)clk_pin);
    if (rst) q = 0;
    else if (set) q = 1;
    else if (rising(s, (uint32_t)clk_pin, clk)) {
        if (streq(s, "logic.flipflop_d")) q = read_level(matrix, 0);
        else if (streq(s, "logic.flipflop_t")) q = read_level(matrix, 0) ? !q : q;
        else {
            const int j = read_level(matrix, 0);
            const int k = read_level(matrix, 1);
            if (j && k) q = !q;
            else if (j) q = 1;
            else if (k) q = 0;
        }
    }
    s->state = q;
    const uint32_t out = streq(s, "logic.flipflop_jk") ? 5u : streq(s, "logic.flipflop_t") ? 4u : 4u;
    drive_level(matrix, out, q);
    drive_level(matrix, out + 1, !q);
}

static void stamp_latch_d(LogicDevice* s, LsdnMatrixView* matrix) {
    if (read_level(matrix, 1)) s->state = read_level(matrix, 0) ? 1u : 0u;
    drive_level(matrix, 2, s->state & 1u);
    drive_level(matrix, 3, !(s->state & 1u));
}

static uint32_t memory_address(LsdnMatrixView* matrix) { return bits_in(matrix, 3, 4) & 0x0fu; }

static void stamp_memory(LogicDevice* s, LsdnMatrixView* matrix) {
    const int clk = read_level(matrix, 0);
    const int we = read_level(matrix, 1);
    const int oe = read_level(matrix, 2);
    const uint32_t addr = memory_address(matrix);
    if (we && rising(s, 0, clk)) s->mem[addr] = (uint8_t)bits_in(matrix, 7, 4);
    if (oe) bits_out(matrix, 11, 4, s->mem[addr] & 0x0fu);
}

static void stamp_mux(LsdnMatrixView* matrix) {
    const uint32_t sel = bits_in(matrix, 0, 3) & 7u;
    drive_level(matrix, 11, read_level(matrix, 3 + sel));
    drive_level(matrix, 12, !read_level(matrix, 3 + sel));
}

static void stamp_demux(LsdnMatrixView* matrix) {
    const uint32_t sel = bits_in(matrix, 0, 3) & 7u;
    const int data = read_level(matrix, 3);
    for (uint32_t i = 0; i < 8; ++i) drive_level(matrix, 4 + i, data && i == sel);
}

static void stamp_bcd_to_dec(LsdnMatrixView* matrix) {
    const uint32_t value = bits_in(matrix, 0, 4);
    for (uint32_t i = 0; i < 10; ++i) drive_level(matrix, 4 + i, value == i);
}

static void stamp_dec_to_bcd(LsdnMatrixView* matrix) {
    uint32_t value = 0;
    for (uint32_t i = 0; i < 10; ++i) {
        if (read_level(matrix, i)) {
            value = i;
            break;
        }
    }
    bits_out(matrix, 10, 4, value);
}

static void stamp_bcd_to_7seg(LsdnMatrixView* matrix) {
    bits_out(matrix, 4, 7, seven_seg(bits_in(matrix, 0, 4)));
}

static void stamp_adc(LogicDevice* s, LsdnMatrixView* matrix) {
    const double vref = cfg_num(s, "vref", 5.0);
    const double vin = read_volts(matrix, 0);
    uint32_t value = vin <= 0.0 ? 0u : (uint32_t)((vin / vref) * 255.0 + 0.1);
    if (value > 255u) value = 255u;
    bits_out(matrix, 1, 8, value);
}

static void stamp_dac(LogicDevice* s, LsdnMatrixView* matrix) {
    const double vref = cfg_num(s, "vref", 5.0);
    const uint32_t value = bits_in(matrix, 0, 8);
    drive_volts(matrix, 8, vref * ((double)value / 255.0));
}

static uint8_t i2c_address(LogicDevice* s) {
    uint8_t address = s->control_code;
    if (s->pin_level[2]) address += 1;
    if (s->pin_level[3]) address += 2;
    if (s->pin_level[4]) address += 4;
    return address;
}

static void i2c_reset_frame(LogicDevice* s, uint8_t next_state) {
    s->i2c_state = next_state;
    s->i2c_addressed = 0;
    s->i2c_ack = 0;
    s->i2c_rw = 0;
    s->i2c_tx_bit = 7;
    s->i2c_reading_ack = 0;
    s->bit_count = 0;
    s->rx_reg = 0;
    s->tx_drive_low = 0;
}

static void i2c_ram_rx_byte(LogicDevice* s, uint8_t byte) {
    if (s->i2c_phase == 0) {
        s->addr_ptr = ((uint32_t)byte) << 8;
        s->i2c_phase = 1;
    } else if (s->i2c_phase == 1) {
        if (s->mem_size > 256) s->addr_ptr += byte;
        else s->addr_ptr = byte;
        s->i2c_phase = 2;
    } else {
        while (s->addr_ptr >= s->mem_size) s->addr_ptr -= s->mem_size;
        s->mem[s->addr_ptr++] = byte;
        if (s->addr_ptr >= s->mem_size) s->addr_ptr = 0;
    }
}

static uint8_t i2c_ram_tx_byte(LogicDevice* s) {
    while (s->addr_ptr >= s->mem_size) s->addr_ptr -= s->mem_size;
    const uint8_t byte = s->mem[s->addr_ptr++];
    if (s->addr_ptr >= s->mem_size) s->addr_ptr = 0;
    return byte;
}

static void i2c_parallel_load_port_from_bus(LogicDevice* s) {
    uint8_t value = 0;
    for (uint32_t i = 0; i < 8; ++i) {
        if (s->pin_level[6 + i]) value |= (uint8_t)(1u << i);
    }
    if (value != s->i2c_port_state) s->i2c_int_state = 0;
}

static void i2c_parallel_rx_byte(LogicDevice* s, uint8_t byte) {
    s->i2c_output_state = byte;
    s->i2c_port_state = byte;
    s->i2c_int_state = 1;
}

static uint8_t i2c_parallel_tx_byte(LogicDevice* s) {
    uint8_t value = 0;
    for (uint32_t i = 0; i < 8; ++i) {
        if (s->pin_level[6 + i]) value |= (uint8_t)(1u << i);
    }
    s->i2c_port_state = value;
    s->i2c_int_state = 1;
    return value;
}

static void i2c_prepare_tx_byte(LogicDevice* s) {
    if (streq(s, "logic.i2c_ram")) s->i2c_tx_byte = i2c_ram_tx_byte(s);
    else s->i2c_tx_byte = i2c_parallel_tx_byte(s);
    s->i2c_tx_bit = 7;
    s->bit_count = 0;
    s->tx_drive_low = ((s->i2c_tx_byte >> s->i2c_tx_bit) & 1u) == 0;
}

static void i2c_accept_rx_byte(LogicDevice* s, uint8_t byte) {
    if (streq(s, "logic.i2c_ram")) i2c_ram_rx_byte(s, byte);
    else i2c_parallel_rx_byte(s, byte);
}

static void i2c_start_write(LogicDevice* s) {
    if (streq(s, "logic.i2c_ram")) s->i2c_phase = s->mem_size > 256 ? 0 : 1;
}

static void i2c_scl_rising(LogicDevice* s) {
    const uint8_t sda = s->pin_level[0] ? 1u : 0u;
    if (s->i2c_state == I2C_IDLE) return;

    if (s->i2c_ack) {
        s->i2c_ack = 0;
        return;
    }

    if (s->i2c_state == I2C_TX_ACK) {
        if (!sda) {
            s->i2c_state = I2C_TX;
            i2c_prepare_tx_byte(s);
        } else {
            s->i2c_state = I2C_IDLE;
            s->tx_drive_low = 0;
        }
        return;
    }

    if (s->i2c_state == I2C_TX) return;

    s->rx_reg = (uint8_t)((s->rx_reg << 1) | sda);
    if (++s->bit_count < 8) return;

    if (s->i2c_state == I2C_ADDRESS) {
        const uint8_t byte = s->rx_reg;
        const uint8_t addr = byte >> 1;
        s->i2c_rw = byte & 1u;
        s->i2c_addressed = addr == i2c_address(s);
        s->i2c_ack = s->i2c_addressed;
        if (s->i2c_addressed) {
            if (s->i2c_rw) {
                s->i2c_state = I2C_TX;
                i2c_prepare_tx_byte(s);
            } else {
                s->i2c_state = I2C_RX;
                i2c_start_write(s);
            }
        } else {
            s->i2c_state = I2C_IDLE;
        }
    } else if (s->i2c_state == I2C_RX && s->i2c_addressed) {
        i2c_accept_rx_byte(s, s->rx_reg);
        s->i2c_ack = 1;
    }
    s->bit_count = 0;
    s->rx_reg = 0;
}

static void i2c_scl_falling(LogicDevice* s) {
    if (s->i2c_ack) return;
    if (s->i2c_state != I2C_TX || !s->i2c_addressed) return;
    if (s->bit_count == 0) {
        s->bit_count = 1;
        return;
    }
    if (s->i2c_tx_bit == 0) {
        s->tx_drive_low = 0;
        s->i2c_state = I2C_TX_ACK;
        return;
    }
    s->i2c_tx_bit--;
    s->tx_drive_low = ((s->i2c_tx_byte >> s->i2c_tx_bit) & 1u) == 0;
}

static void stamp_i2c_to_parallel(LogicDevice* s, LsdnMatrixView* matrix) {
    i2c_parallel_load_port_from_bus(s);
    open_collector_out(matrix, 5, s->i2c_int_state);
    for (uint32_t i = 0; i < 8; ++i) open_collector_out(matrix, 6 + i, (s->i2c_output_state >> i) & 1u);
    if (s->i2c_ack || s->tx_drive_low) open_collector_out(matrix, 0, 0);
}

static void stamp_i2c_ram(LogicDevice* s, LsdnMatrixView* matrix) {
    if (s->i2c_ack || s->tx_drive_low) open_collector_out(matrix, 0, 0);
}

static void stamp_lm555(LogicDevice* s, LsdnMatrixView* matrix) {
    const double gnd = read_volts(matrix, 0);
    const double trig = read_volts(matrix, 1);
    const double rst = read_volts(matrix, 3);
    const double cv = read_volts(matrix, 4);
    const double thr = read_volts(matrix, 5);
    const double vcc = read_volts(matrix, 7);
    const double ref = cv > gnd ? cv : vcc;
    const double trigger_ref = gnd + (ref - gnd) / 3.0;
    const double threshold_ref = gnd + (ref - gnd) * 2.0 / 3.0;
    if (rst - gnd < 0.7) s->out_level = 0;
    else if (trig < trigger_ref) s->out_level = 1;
    else if (thr > threshold_ref) s->out_level = 0;
    drive_volts(matrix, 2, s->out_level ? fmax(gnd, vcc - 1.3) : gnd);
    if (!s->out_level && matrix->add_conductance) matrix->add_conductance(matrix->opaque, 6, 0, DISCHARGE_G);
}

static LsdnDevice* create(void* host_ctx, const LsdnHostApi* api) {
    LogicDevice* s = (LogicDevice*)calloc(1, sizeof(LogicDevice));
    if (!s) return 0;
    s->host_ctx = host_ctx;
    s->api = api;
    LsdnPropertyValue value;
    memset(&value, 0, sizeof(value));
    if (api && api->config_get && api->config_get(host_ctx, "__typeId", &value) && value.kind == LSDN_PROPERTY_STRING && value.string_value) {
        strncpy(s->type_id, value.string_value, sizeof(s->type_id) - 1);
    }
    return (LsdnDevice*)s;
}

static void init(LsdnDevice* dev) {
    LogicDevice* s = (LogicDevice*)dev;
    s->pin_count = (uint32_t)cfg_num(s, "pinCount", 0);
    strncpy(s->functions, cfg_string(s, "functions", "i0 | i1"), sizeof(s->functions) - 1);
    s->functions[sizeof(s->functions) - 1] = 0;
    s->mem_size = (uint32_t)cfg_num(s, "sizeBytes", 65536);
    if (s->mem_size < 1) s->mem_size = 1;
    if (s->mem_size > 65536) s->mem_size = 65536;
    if (!cfg_bool(s, "persistent", 0)) memset(s->mem, 0, sizeof(s->mem));
    s->i2c_phase = s->mem_size > 256 ? 0 : 1;
    s->control_code = (uint8_t)cfg_num(s, "controlCode", 0x50);
    s->i2c_output_state = 0xff;
    s->i2c_port_state = 0xff;
    s->i2c_int_state = 1;
    s->pin_level[0] = 1;
    s->pin_level[1] = 1;
    s->pin_level[5] = 1;
    for (uint32_t i = 6; i < 14 && i < 32; ++i) s->pin_level[i] = 1;
    if (!s->api || !s->api->pin_declare) return;
    for (uint32_t i = 0; i < s->pin_count; ++i) s->api->pin_declare(s->host_ctx, i, LSDN_PIN_DIGITAL_BIDIR, "");
}

static void stamp(LsdnDevice* dev, LsdnMatrixView* matrix) {
    LogicDevice* s = (LogicDevice*)dev;
    if (streq(s, "logic.buffer") || streq(s, "logic.and_gate") || streq(s, "logic.or_gate") || streq(s, "logic.xor_gate")) stamp_gate(s, matrix);
    else if (streq(s, "logic.counter") || streq(s, "logic.bin_counter")) stamp_counter(s, matrix);
    else if (streq(s, "logic.full_adder")) stamp_full_adder(matrix);
    else if (streq(s, "logic.magnitude_comp")) stamp_magnitude_comp(matrix);
    else if (streq(s, "logic.shift_reg")) stamp_shift_reg(s, matrix);
    else if (streq(s, "logic.function")) stamp_function(s, matrix);
    else if (streq(s, "logic.flipflop_d") || streq(s, "logic.flipflop_t") || streq(s, "logic.flipflop_rs") || streq(s, "logic.flipflop_jk")) stamp_flipflop(s, matrix);
    else if (streq(s, "logic.latch_d")) stamp_latch_d(s, matrix);
    else if (streq(s, "logic.memory") || streq(s, "logic.dynamic_memory")) stamp_memory(s, matrix);
    else if (streq(s, "logic.i2c_ram")) stamp_i2c_ram(s, matrix);
    else if (streq(s, "logic.mux")) stamp_mux(matrix);
    else if (streq(s, "logic.demux")) stamp_demux(matrix);
    else if (streq(s, "logic.bcd_to_dec")) stamp_bcd_to_dec(matrix);
    else if (streq(s, "logic.dec_to_bcd")) stamp_dec_to_bcd(matrix);
    else if (streq(s, "logic.bcd_to_7seg") || streq(s, "logic.seven_segment_bcd")) stamp_bcd_to_7seg(matrix);
    else if (streq(s, "logic.i2c_to_parallel")) stamp_i2c_to_parallel(s, matrix);
    else if (streq(s, "logic.adc")) stamp_adc(s, matrix);
    else if (streq(s, "logic.dac")) stamp_dac(s, matrix);
    else if (streq(s, "logic.lm555")) stamp_lm555(s, matrix);
}

static void post_step(LsdnDevice* dev, uint64_t time_ns) { (void)dev; (void)time_ns; }

static void on_event(LsdnDevice* dev, const LsdnEvent* ev) {
    LogicDevice* s = (LogicDevice*)dev;
    if (!ev || ev->tag != LSDN_EVT_PIN_CHANGE || ev->a >= 32) return;
    const uint8_t old = s->pin_level[ev->a];
    const uint8_t now = ev->b ? 1u : 0u;
    s->pin_level[ev->a] = now;
    if (old == now) return;

    if (streq(s, "logic.i2c_ram") || streq(s, "logic.i2c_to_parallel")) {
        if (ev->a == 0 && s->pin_level[1]) {
            if (old && !now) {
                i2c_reset_frame(s, I2C_ADDRESS);
            } else if (!old && now) {
                i2c_reset_frame(s, I2C_IDLE);
                if (streq(s, "logic.i2c_ram")) s->i2c_phase = 3;
            }
        } else if (ev->a == 1) {
            if (!old && now) i2c_scl_rising(s);
            else if (old && !now) i2c_scl_falling(s);
        } else if (streq(s, "logic.i2c_to_parallel") && ev->a >= 6 && ev->a < 14) {
            i2c_parallel_load_port_from_bus(s);
        }
    }
}

static uint32_t get_property(LsdnDevice* dev, const char* name, LsdnPropertyValue* out) {
    LogicDevice* s = (LogicDevice*)dev;
    if (!name || !out) return 0;
    memset(out, 0, sizeof(*out));
    if (strcmp(name, "functions") == 0) {
        out->kind = LSDN_PROPERTY_STRING;
        out->string_value = s->functions;
        return 1;
    }
    if (strcmp(name, "sizeBytes") == 0) {
        out->kind = LSDN_PROPERTY_NUMBER;
        out->number_value = (double)s->mem_size;
        return 1;
    }
    if (strcmp(name, "controlCode") == 0) {
        out->kind = LSDN_PROPERTY_NUMBER;
        out->number_value = (double)s->control_code;
        return 1;
    }
    return 0;
}

static uint32_t set_property(LsdnDevice* dev, const char* name, const LsdnPropertyValue* value) {
    LogicDevice* s = (LogicDevice*)dev;
    if (!name || !value) return 0;
    if (strcmp(name, "functions") == 0 && value->kind == LSDN_PROPERTY_STRING) {
        strncpy(s->functions, value->string_value ? value->string_value : "", sizeof(s->functions) - 1);
        s->functions[sizeof(s->functions) - 1] = 0;
        return 1;
    }
    if (strcmp(name, "sizeBytes") == 0 && value->kind == LSDN_PROPERTY_NUMBER) {
        uint32_t size = (uint32_t)value->number_value;
        if (size < 1) size = 1;
        if (size > 65536) size = 65536;
        s->mem_size = size;
        if (s->addr_ptr >= s->mem_size) s->addr_ptr = 0;
        return 1;
    }
    if (strcmp(name, "controlCode") == 0 && value->kind == LSDN_PROPERTY_NUMBER) {
        int code = (int)value->number_value;
        if (code < 0) code = 0;
        if (code > 127) code = 127;
        s->control_code = (uint8_t)code;
        return 1;
    }
    return 0;
}

/* ABI v2 (.spec/lasecsimul-native-devices.spec): get_state/set_state passam a se autoversionar --
 * uint32 de versão antes do payload, mesmo padrão de example-blinker/simulide-complex. */
#define SIMULIDE_LOGIC_STATE_VERSION 1u

static uint32_t get_state(LsdnDevice* dev, uint8_t* out, uint32_t cap) {
    LogicDevice* s = (LogicDevice*)dev;
    const uint32_t need = (uint32_t)(sizeof(uint32_t) + sizeof(s->state) + sizeof(s->latch) + sizeof(s->mem));
    if (!out || cap < need) return 0;
    uint32_t version = SIMULIDE_LOGIC_STATE_VERSION;
    uint8_t* cursor = out;
    memcpy(cursor, &version, sizeof(version)); cursor += sizeof(version);
    memcpy(cursor, &s->state, sizeof(s->state)); cursor += sizeof(s->state);
    memcpy(cursor, &s->latch, sizeof(s->latch)); cursor += sizeof(s->latch);
    memcpy(cursor, s->mem, sizeof(s->mem));
    return need;
}

static void set_state(LsdnDevice* dev, const uint8_t* in, uint32_t len) {
    LogicDevice* s = (LogicDevice*)dev;
    const uint32_t need = (uint32_t)(sizeof(uint32_t) + sizeof(s->state) + sizeof(s->latch) + sizeof(s->mem));
    if (!in || len < need) return;
    uint32_t version = 0;
    memcpy(&version, in, sizeof(version));
    if (version != SIMULIDE_LOGIC_STATE_VERSION) {
        if (s->api->log) s->api->log(s->host_ctx, 1, "simulide-logic: set_state versao desconhecida, ignorado");
        return;
    }
    const uint8_t* cursor = in + sizeof(version);
    memcpy(&s->state, cursor, sizeof(s->state)); cursor += sizeof(s->state);
    memcpy(&s->latch, cursor, sizeof(s->latch)); cursor += sizeof(s->latch);
    memcpy(s->mem, cursor, sizeof(s->mem));
}

static void destroy(LsdnDevice* dev) { free(dev); }

static const LsdnDeviceVTable kVTable = {
    create, init, stamp, post_step, on_event, get_property, set_property, get_state, set_state, destroy
};

LSDN_EXPORT
const LsdnDeviceVTable* lsdn_get_vtable(uint32_t* abi_major, uint32_t* abi_minor) {
    *abi_major = LSDN_ABI_VERSION_MAJOR;
    *abi_minor = LSDN_ABI_VERSION_MINOR;
    return &kVTable;
}
