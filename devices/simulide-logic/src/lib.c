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

/* Contrato elétrico de I/O digital (achado real 2026-08-19, lendo `logicfamily.h`/`iopin.cpp` do
 * SimulIDE real): nomes espelham `logicFamily_t` real, mas aqui já em VOLTS/OHMS ABSOLUTOS (a
 * conversão Family-proporção x SupplyV acontece uma vez em `resolve_io_config`, não a cada
 * stamp()). `inputHighV`/`inputLowV` DIFERENTES criam uma janela de histerese real --
 * `IoPin::getInpState()` real preserva o nível anterior enquanto a tensão está entre os dois
 * (nem HIGH nem LOW), não é um único corte -- por isso o estado por pino precisa ser persistido
 * (`LogicDevice.inpHystState`), não recalculado do zero a cada stamp(). Quando o manifest não
 * declara nenhuma destas properties, `resolve_io_config` cai exatamente nos valores fixos que já
 * existiam (`LOGIC_THRESHOLD`/`LOGIC_HIGH`/`DRIVE_G`) -- comportamento numérico de qualquer
 * circuito salvo antes desta mudança não muda (ver teste de retroatividade). */
typedef struct {
    double inputHighV;
    double inputLowV;
    double inputImpedance;   /* Ohms; 0 = sem carga extra no nó (mesmo padrão real: 1e9 default) */
    double inputPullupR;     /* Ohms; 0 = sem pullup de entrada */
    double outputHighV;
    double outputLowV;
    double outputImpedance;  /* Ohms; forma Thevenin/Norton -- ver drive_volts() */
    double outputPullupR;    /* Ohms; 0 = sem pullup de saída (só relevante c/ openCollector) */
    int openCollector;
    int invertInputs;
} LogicIoConfig;

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
    LogicIoConfig io;             /* resolvido 1x em init(), nunca lido por string em stamp() */
    uint8_t inpHystState[32];     /* estado lógico anterior por pino de ENTRADA, p/ histerese --
                                      array dedicado, não reaproveita pin_level[]/prev[] (esses já
                                      têm semântica própria em i2c/latch/decoder no mesmo arquivo) */
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

/* Resolvido 1x em init() (mesmo padrão de pin_count/functions/mem_size logo abaixo), nunca a
 * cada stamp() -- ver comentário do LogicIoConfig. Quando o manifest não declara uma destas
 * properties, `cfg_num`/`cfg_bool` caem no fallback já usado antes desta mudança
 * (LOGIC_THRESHOLD/LOGIC_HIGH/DRIVE_G-equivalente), preservando o comportamento numérico de
 * qualquer device/circuito que ainda não foi migrado -- ver teste de retroatividade A/B. */
static void resolve_io_config(LogicDevice* s) {
    s->io.inputHighV = cfg_num(s, "inputHighV", LOGIC_THRESHOLD);
    s->io.inputLowV = cfg_num(s, "inputLowV", LOGIC_THRESHOLD);
    s->io.inputImpedance = cfg_num(s, "inputImpedance", 0.0);
    s->io.inputPullupR = cfg_num(s, "inputPullupR", 0.0);
    s->io.outputHighV = cfg_num(s, "outputHighV", LOGIC_HIGH);
    s->io.outputLowV = cfg_num(s, "outputLowV", 0.0);
    s->io.outputImpedance = cfg_num(s, "outputImpedance", 1.0 / DRIVE_G);
    s->io.outputPullupR = cfg_num(s, "outputPullupR", 0.0);
    s->io.openCollector = cfg_bool(s, "openCollector", 0);
    s->io.invertInputs = cfg_bool(s, "invertInputs", 0);
}

/* Único ponto de leitura de nível digital de TODO stamp_* -- thresholds/histerese/inversão
 * resolvidos aqui uma única vez, nunca duplicados por device (achado real: `IoPin::getInpState()`
 * preserva o nível anterior quando a tensão cai entre inputLowV e inputHighV -- não é um único
 * corte). `invertInputs` inverte o nível LÓGICO já resolvido (depois da histerese), nunca a
 * tensão bruta -- espelha a ordem real (medição elétrica primeiro, inversão de config depois). */
static int read_level(LogicDevice* s, LsdnMatrixView* matrix, uint32_t pin) {
    if (!matrix || !matrix->get_node_voltage) return 0;
    const double v = matrix->get_node_voltage(matrix->opaque, pin);
    int level;
    if (v > s->io.inputHighV) level = 1;
    else if (v < s->io.inputLowV) level = 0;
    else level = pin < 32 ? s->inpHystState[pin] : 0; /* região intermediária: mantém o anterior */
    if (pin < 32) s->inpHystState[pin] = (uint8_t)level;
    return s->io.invertInputs ? !level : level;
}

static double read_volts(LsdnMatrixView* matrix, uint32_t pin) {
    return (matrix && matrix->get_node_voltage) ? matrix->get_node_voltage(matrix->opaque, pin) : 0.0;
}

/* Fonte Norton referenciada ao nó de terra do circuito -- eletricamente equivalente a uma fonte
 * Thevenin `target_volts` em série com `1/conductance` (não "puxa pra GND": o valor resultante no
 * nó, em circuito aberto, é `target_volts`, não 0V). Primitivo único reaproveitado por
 * `drive_volts`/`drive_level`/pullup -- não um mecanismo por conceito. */
static void stamp_source(LsdnMatrixView* matrix, uint32_t pin, double conductance, double target_volts) {
    if (!matrix || !matrix->add_conductance_to_ground || !matrix->add_current_to_ground || conductance <= 0.0) return;
    matrix->add_conductance_to_ground(matrix->opaque, pin, conductance);
    matrix->add_current_to_ground(matrix->opaque, pin, target_volts * conductance);
}

/* Impedância de saída real (achado 2026-08-19): `1/outputImpedance` no lugar do `DRIVE_G` fixo
 * já modela um driver não-ideal com o MESMO primitivo Norton -- não precisou de mecanismo novo.
 * Pullup de saída soma-se por cima, mais fraco por construção (outputPullupR tipicamente >>
 * outputImpedance), sempre em direção a `outputHighV` (não a 0V -- pullup real referencia o
 * supply, não o terra). */
static void drive_volts(LogicDevice* s, LsdnMatrixView* matrix, uint32_t pin, double volts) {
    const double g = s->io.outputImpedance > 0.0 ? 1.0 / s->io.outputImpedance : DRIVE_G;
    stamp_source(matrix, pin, g, volts);
    if (s->io.outputPullupR > 0.0) stamp_source(matrix, pin, 1.0 / s->io.outputPullupR, s->io.outputHighV);
}

/* Open-collector: só puxa ativamente quando o nível lógico é LOW; quando seria HIGH, o driver
 * NÃO estampa condutância nenhuma (alta impedância de verdade) -- só o pullup, se configurado,
 * decide o nó. Sem pullup, o nó fica livre pra outro device/pullup externo decidir -- não é
 * forçado artificialmente pra HIGH (achado real, `IoComponent::openCol`/uso real do padrão já
 * existente em `open_collector_out()` mais abaixo pro barramento I2C, generalizado aqui). */
static void drive_level(LogicDevice* s, LsdnMatrixView* matrix, uint32_t pin, int level) {
    if (s->io.openCollector) {
        if (level) {
            if (s->io.outputPullupR > 0.0) stamp_source(matrix, pin, 1.0 / s->io.outputPullupR, s->io.outputHighV);
            return;
        }
        const double g = s->io.outputImpedance > 0.0 ? 1.0 / s->io.outputImpedance : DRIVE_G;
        stamp_source(matrix, pin, g, s->io.outputLowV);
        return;
    }
    drive_volts(s, matrix, pin, level ? s->io.outputHighV : s->io.outputLowV);
}

static int rising(LogicDevice* s, uint32_t pin, int now) {
    const int was = pin < 32 ? s->prev[pin] != 0 : 0;
    if (pin < 32) s->prev[pin] = (uint8_t)(now ? 1 : 0);
    return now && !was;
}

static uint32_t bits_in(LogicDevice* s, LsdnMatrixView* matrix, uint32_t first, uint32_t count) {
    uint32_t value = 0;
    for (uint32_t i = 0; i < count; ++i) {
        if (read_level(s, matrix, first + i)) value |= (1u << i);
    }
    return value;
}

static void bits_out(LogicDevice* s, LsdnMatrixView* matrix, uint32_t first, uint32_t count, uint32_t value) {
    for (uint32_t i = 0; i < count; ++i) drive_level(s, matrix, first + i, (value >> i) & 1u);
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

/* NAND/NOR/XNOR/NOT não são typeIds separados -- mesma solução do SimulIDE real
 * (`gate.cpp`/`gate_and.cpp`: propriedade "Inverted Outs" na MESMA porta AND/OR/XOR/Buffer, achado
 * de auditoria 2026-07-08 -- LasecSimul não tinha essa flag, tornando NAND/NOR/NOT/XNOR
 * inconstruíveis). `logic.buffer` com `inverted=true` É o NOT. AND/OR seguem o SimulIDE real em
 * `Num_Inputs`: o manifesto declara `out` primeiro e `in1..inN` dinamicamente; este stamp lê essas N
 * entradas -- SEM teto (achado 2026-08-19, lendo `gate.cpp`/`gate_and.cpp`/`gate_or.cpp` reais: o
 * `IntProp` de `Num_Inputs` não declara `min`/`max` nenhum; um teto de 8 aqui era invenção do port,
 * não algo do SimulIDE original -- auditado antes de remover: nenhuma das duas camadas por baixo,
 * `LsdnMatrixView`/`read_level`/`drive_level` (`device_abi.h`) nem `Component::m_pins` no core C++,
 * usa buffer/array de tamanho fixo por pino, então N maior não estoura nada aqui). XOR/Buffer
 * continuam fixos porque a referência SimulIDE 2 não expõe `Num_Inputs` nesses dois. */
static void stamp_gate(LogicDevice* s, LsdnMatrixView* matrix) {
    if (streq(s, "logic.and_gate") || streq(s, "logic.or_gate")) {
        uint32_t inputs = (uint32_t)cfg_num(s, "inputs", 2);
        if (inputs < 2) inputs = 2;
        uint32_t high = 0;
        for (uint32_t i = 0; i < inputs; ++i) {
            if (read_level(s, matrix, i + 1)) high++;
        }
        int out = streq(s, "logic.and_gate") ? (high == inputs) : (high > 0);
        if (cfg_bool(s, "inverted", 0)) out = !out;
        drive_level(s, matrix, 0, out);
        return;
    }

    const int a = read_level(s, matrix, 0);
    const int b = read_level(s, matrix, 1);
    int out = a;
    if (streq(s, "logic.xor_gate")) out = !!(a ^ b);
    if (cfg_bool(s, "inverted", 0)) out = !out;
    drive_level(s, matrix, streq(s, "logic.buffer") ? 1 : 2, out);
}

static void stamp_counter(LogicDevice* s, LsdnMatrixView* matrix) {
    const int clk = read_level(s, matrix, 0);
    const int rst = read_level(s, matrix, 1);
    const uint32_t bits = streq(s, "logic.counter") ? 1u : 4u;
    const uint32_t max_value = streq(s, "logic.counter") ? (uint32_t)cfg_num(s, "maxValue", 1) : 15u;
    if (rst) s->state = 0;
    else if (rising(s, 0, clk)) {
        s->state++;
        if (s->state > max_value) s->state = 0;
    }
    if (streq(s, "logic.counter")) drive_level(s, matrix, 2, s->state == max_value);
    else bits_out(s, matrix, 2, bits, s->state);
}

static void stamp_full_adder(LogicDevice* s, LsdnMatrixView* matrix) {
    const int a = read_level(s, matrix, 0);
    const int b = read_level(s, matrix, 1);
    const int cin = read_level(s, matrix, 2);
    const int sum = a ^ b ^ cin;
    const int cout = (a && b) || (a && cin) || (b && cin);
    drive_level(s, matrix, 3, sum);
    drive_level(s, matrix, 4, cout);
}

static void stamp_magnitude_comp(LogicDevice* s, LsdnMatrixView* matrix) {
    const uint32_t a = bits_in(s, matrix, 0, 4);
    const uint32_t b = bits_in(s, matrix, 4, 4);
    drive_level(s, matrix, 8, a > b);
    drive_level(s, matrix, 9, a == b);
    drive_level(s, matrix, 10, a < b);
}

static void stamp_shift_reg(LogicDevice* s, LsdnMatrixView* matrix) {
    const int clk = read_level(s, matrix, 0);
    const int data = read_level(s, matrix, 1);
    const int rst = read_level(s, matrix, 2);
    if (rst) s->state = 0;
    else if (rising(s, 0, clk)) s->state = ((s->state << 1) | (uint32_t)data) & 0xffu;
    bits_out(s, matrix, 3, 8, s->state);
}

typedef struct {
    const char* p;
    LogicDevice* s;
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
        return pin < p->input_count ? (double)read_level(p->s, p->matrix, pin) : 0.0;
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
    parser.s = s;
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
            drive_volts(s, matrix, parser.input_count + out, result);
        } else {
            parser.output_volts[out] = result ? LOGIC_HIGH : 0.0;
            drive_level(s, matrix, parser.input_count + out, result != 0.0);
        }
        cursor = next;
    }
}

static void stamp_flipflop(LogicDevice* s, LsdnMatrixView* matrix) {
    uint32_t q = s->state & 1u;
    if (streq(s, "logic.flipflop_rs")) {
        const int set = read_level(s, matrix, 0);
        const int rst = read_level(s, matrix, 1);
        if (rst && !set) q = 0;
        else if (set && !rst) q = 1;
        else if (set && rst) q = 0;
        drive_level(s, matrix, 2, q);
        drive_level(s, matrix, 3, !q);
        s->state = q;
        return;
    }

    const int set = streq(s, "logic.flipflop_t") ? read_level(s, matrix, 2) :
                    streq(s, "logic.flipflop_jk") ? read_level(s, matrix, 2) : read_level(s, matrix, 1);
    const int rst = streq(s, "logic.flipflop_t") ? read_level(s, matrix, 3) :
                    streq(s, "logic.flipflop_jk") ? read_level(s, matrix, 3) : read_level(s, matrix, 2);
    const int clk_pin = streq(s, "logic.flipflop_t") ? 1 : streq(s, "logic.flipflop_jk") ? 4 : 3;
    const int clk = read_level(s, matrix, (uint32_t)clk_pin);
    if (rst) q = 0;
    else if (set) q = 1;
    else if (rising(s, (uint32_t)clk_pin, clk)) {
        if (streq(s, "logic.flipflop_d")) q = read_level(s, matrix, 0);
        else if (streq(s, "logic.flipflop_t")) q = read_level(s, matrix, 0) ? !q : q;
        else {
            const int j = read_level(s, matrix, 0);
            const int k = read_level(s, matrix, 1);
            if (j && k) q = !q;
            else if (j) q = 1;
            else if (k) q = 0;
        }
    }
    s->state = q;
    const uint32_t out = streq(s, "logic.flipflop_jk") ? 5u : streq(s, "logic.flipflop_t") ? 4u : 4u;
    drive_level(s, matrix, out, q);
    drive_level(s, matrix, out + 1, !q);
}

static void stamp_latch_d(LogicDevice* s, LsdnMatrixView* matrix) {
    if (read_level(s, matrix, 1)) s->state = read_level(s, matrix, 0) ? 1u : 0u;
    drive_level(s, matrix, 2, s->state & 1u);
    drive_level(s, matrix, 3, !(s->state & 1u));
}

static uint32_t memory_address(LogicDevice* s, LsdnMatrixView* matrix) { return bits_in(s, matrix, 3, 4) & 0x0fu; }

static void stamp_memory(LogicDevice* s, LsdnMatrixView* matrix) {
    const int clk = read_level(s, matrix, 0);
    const int we = read_level(s, matrix, 1);
    const int oe = read_level(s, matrix, 2);
    const uint32_t addr = memory_address(s, matrix);
    if (we && rising(s, 0, clk)) s->mem[addr] = (uint8_t)bits_in(s, matrix, 7, 4);
    if (oe) bits_out(s, matrix, 11, 4, s->mem[addr] & 0x0fu);
}

static void stamp_mux(LogicDevice* s, LsdnMatrixView* matrix) {
    const uint32_t sel = bits_in(s, matrix, 0, 3) & 7u;
    drive_level(s, matrix, 11, read_level(s, matrix, 3 + sel));
    drive_level(s, matrix, 12, !read_level(s, matrix, 3 + sel));
}

static void stamp_demux(LogicDevice* s, LsdnMatrixView* matrix) {
    const uint32_t sel = bits_in(s, matrix, 0, 3) & 7u;
    const int data = read_level(s, matrix, 3);
    for (uint32_t i = 0; i < 8; ++i) drive_level(s, matrix, 4 + i, data && i == sel);
}

static void stamp_bcd_to_dec(LogicDevice* s, LsdnMatrixView* matrix) {
    const uint32_t value = bits_in(s, matrix, 0, 4);
    for (uint32_t i = 0; i < 10; ++i) drive_level(s, matrix, 4 + i, value == i);
}

static void stamp_dec_to_bcd(LogicDevice* s, LsdnMatrixView* matrix) {
    uint32_t value = 0;
    for (uint32_t i = 0; i < 10; ++i) {
        if (read_level(s, matrix, i)) {
            value = i;
            break;
        }
    }
    bits_out(s, matrix, 10, 4, value);
}

static void stamp_bcd_to_7seg(LogicDevice* s, LsdnMatrixView* matrix) {
    bits_out(s, matrix, 4, 7, seven_seg(bits_in(s, matrix, 0, 4)));
}

static void stamp_adc(LogicDevice* s, LsdnMatrixView* matrix) {
    const double vref = cfg_num(s, "vref", 5.0);
    const double vin = read_volts(matrix, 0);
    uint32_t value = vin <= 0.0 ? 0u : (uint32_t)((vin / vref) * 255.0 + 0.1);
    if (value > 255u) value = 255u;
    bits_out(s, matrix, 1, 8, value);
}

static void stamp_dac(LogicDevice* s, LsdnMatrixView* matrix) {
    const double vref = cfg_num(s, "vref", 5.0);
    const uint32_t value = bits_in(s, matrix, 0, 8);
    drive_volts(s, matrix, 8, vref * ((double)value / 255.0));
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
    drive_volts(s, matrix, 2, s->out_level ? fmax(gnd, vcc - 1.3) : gnd);
    if (!s->out_level && matrix->add_conductance) matrix->add_conductance(matrix->opaque, 6, 0, DISCHARGE_G);
}

/* --- Familia adicionada pra fechar a lacuna de aritmetica/memoria/plexers frente ao Logisim
 * Evolution (varredura 2026-08-18) -- mesmo padrao dos stamps acima: pinos ABI na ordem
 * declarada no .lsdevice (esquerda depois direita), leitura/escrita via bits_in/bits_out. */

static void stamp_subtractor(LogicDevice* s, LsdnMatrixView* matrix) {
    const int a = read_level(s, matrix, 0);
    const int b = read_level(s, matrix, 1);
    const int bin = read_level(s, matrix, 2);
    const int diff = a ^ b ^ bin;
    const int bout = (!a && b) || (!a && bin) || (b && bin);
    drive_level(s, matrix, 3, diff);
    drive_level(s, matrix, 4, bout);
}

static void stamp_multiplier(LogicDevice* s, LsdnMatrixView* matrix) {
    const uint32_t a = bits_in(s, matrix, 0, 4);
    const uint32_t b = bits_in(s, matrix, 4, 4);
    bits_out(s, matrix, 8, 8, a * b);
}

static void stamp_divider(LogicDevice* s, LsdnMatrixView* matrix) {
    const uint32_t a = bits_in(s, matrix, 0, 4);
    const uint32_t b = bits_in(s, matrix, 4, 4);
    const uint32_t q = b == 0 ? 15u : a / b;
    const uint32_t r = b == 0 ? a : a % b;
    bits_out(s, matrix, 8, 4, q);
    bits_out(s, matrix, 12, 4, r);
}

static void stamp_shifter(LogicDevice* s, LsdnMatrixView* matrix) {
    const uint32_t d = bits_in(s, matrix, 0, 8);
    const uint32_t amt = bits_in(s, matrix, 8, 3);
    const int dir = read_level(s, matrix, 11);
    const int arithmetic = cfg_bool(s, "arithmetic", 0);
    uint32_t q;
    if (!dir) {
        q = (d << amt) & 0xffu;
    } else {
        const int msb = (d & 0x80u) != 0;
        const uint32_t logical = d >> amt;
        const uint32_t fill = (arithmetic && msb && amt > 0) ? ((0xffu << (8 - amt)) & 0xffu) : 0u;
        q = logical | fill;
    }
    bits_out(s, matrix, 12, 8, q);
}

static void stamp_negator(LogicDevice* s, LsdnMatrixView* matrix) {
    const uint32_t d = bits_in(s, matrix, 0, 8);
    bits_out(s, matrix, 8, 8, (~d + 1u) & 0xffu);
}

static void stamp_minmax(LogicDevice* s, LsdnMatrixView* matrix) {
    const uint32_t a = bits_in(s, matrix, 0, 4);
    const uint32_t b = bits_in(s, matrix, 4, 4);
    bits_out(s, matrix, 8, 4, a < b ? a : b);
    bits_out(s, matrix, 12, 4, a > b ? a : b);
}

static void stamp_absolute(LogicDevice* s, LsdnMatrixView* matrix) {
    const uint32_t d = bits_in(s, matrix, 0, 8);
    bits_out(s, matrix, 8, 8, (d & 0x80u) ? ((~d + 1u) & 0xffu) : d);
}

static void stamp_bit_adder(LogicDevice* s, LsdnMatrixView* matrix) {
    const uint32_t d = bits_in(s, matrix, 0, 8);
    uint32_t count = 0;
    for (uint32_t i = 0; i < 8; ++i) {
        if (d & (1u << i)) count++;
    }
    bits_out(s, matrix, 8, 4, count);
}

static void stamp_register(LogicDevice* s, LsdnMatrixView* matrix) {
    const int clk = read_level(s, matrix, 0);
    const int ld = read_level(s, matrix, 1);
    const int rst = read_level(s, matrix, 2);
    if (rst) s->state = 0;
    else if (rising(s, 0, clk) && ld) s->state = bits_in(s, matrix, 3, 8);
    bits_out(s, matrix, 11, 8, s->state & 0xffu);
}

static void stamp_random(LogicDevice* s, LsdnMatrixView* matrix) {
    const int clk = read_level(s, matrix, 0);
    const int rst = read_level(s, matrix, 1);
    if (rst) {
        uint32_t seed = (uint32_t)cfg_num(s, "seed", 1);
        if (seed < 1) seed = 1;
        if (seed > 255) seed = 255;
        s->state = seed;
    } else if (rising(s, 0, clk)) {
        uint32_t x = s->state & 0xffu;
        if (x == 0) x = 1;
        const uint32_t bit = ((x >> 7) ^ (x >> 5) ^ (x >> 4) ^ (x >> 3)) & 1u;
        s->state = ((x << 1) | bit) & 0xffu;
    }
    bits_out(s, matrix, 2, 8, s->state & 0xffu);
}

static void stamp_decoder(LogicDevice* s, LsdnMatrixView* matrix) {
    const uint32_t sel = bits_in(s, matrix, 0, 3);
    const int en = read_level(s, matrix, 3);
    for (uint32_t i = 0; i < 8; ++i) drive_level(s, matrix, 4 + i, en && i == sel);
}

static void stamp_priority_encoder(LogicDevice* s, LsdnMatrixView* matrix) {
    int idx = -1;
    for (int i = 7; i >= 0; --i) {
        if (read_level(s, matrix, (uint32_t)i)) {
            idx = i;
            break;
        }
    }
    bits_out(s, matrix, 8, 3, idx < 0 ? 0u : (uint32_t)idx);
    drive_level(s, matrix, 11, idx >= 0);
}

static void stamp_bit_selector(LogicDevice* s, LsdnMatrixView* matrix) {
    const uint32_t value = bits_in(s, matrix, 0, 8);
    const int high = read_level(s, matrix, 8);
    bits_out(s, matrix, 9, 4, high ? (value >> 4) & 0x0fu : value & 0x0fu);
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
    resolve_io_config(s);
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
    /* The manifest's canonical electrical names are part of the plugin contract:
     * NativeDeviceProxy resolves I2C by sda/scl, not by visual pin position. */
    static const char* const names[] = {"scl", "sda", "a0", "a1", "a2"};
    static const uint32_t kinds[] = {LSDN_PIN_DIGITAL_BIDIR, LSDN_PIN_DIGITAL_BIDIR,
                                     LSDN_PIN_DIGITAL_IN, LSDN_PIN_DIGITAL_IN,
                                     LSDN_PIN_DIGITAL_IN};
    for (uint32_t i = 0; i < s->pin_count; ++i)
        s->api->pin_declare(s->host_ctx, i, i < 5 ? kinds[i] : LSDN_PIN_DIGITAL_BIDIR,
                            i < 5 ? names[i] : "pin");
}

static void stamp(LsdnDevice* dev, LsdnMatrixView* matrix) {
    LogicDevice* s = (LogicDevice*)dev;
    if (streq(s, "logic.buffer") || streq(s, "logic.and_gate") || streq(s, "logic.or_gate") || streq(s, "logic.xor_gate")) stamp_gate(s, matrix);
    else if (streq(s, "logic.counter") || streq(s, "logic.bin_counter")) stamp_counter(s, matrix);
    else if (streq(s, "logic.full_adder")) stamp_full_adder(s, matrix);
    else if (streq(s, "logic.magnitude_comp")) stamp_magnitude_comp(s, matrix);
    else if (streq(s, "logic.shift_reg")) stamp_shift_reg(s, matrix);
    else if (streq(s, "logic.function")) stamp_function(s, matrix);
    else if (streq(s, "logic.flipflop_d") || streq(s, "logic.flipflop_t") || streq(s, "logic.flipflop_rs") || streq(s, "logic.flipflop_jk")) stamp_flipflop(s, matrix);
    else if (streq(s, "logic.latch_d")) stamp_latch_d(s, matrix);
    else if (streq(s, "logic.memory") || streq(s, "logic.dynamic_memory")) stamp_memory(s, matrix);
    else if (streq(s, "logic.i2c_ram")) stamp_i2c_ram(s, matrix);
    else if (streq(s, "logic.mux")) stamp_mux(s, matrix);
    else if (streq(s, "logic.demux")) stamp_demux(s, matrix);
    else if (streq(s, "logic.bcd_to_dec")) stamp_bcd_to_dec(s, matrix);
    else if (streq(s, "logic.dec_to_bcd")) stamp_dec_to_bcd(s, matrix);
    else if (streq(s, "logic.bcd_to_7seg") || streq(s, "logic.seven_segment_bcd")) stamp_bcd_to_7seg(s, matrix);
    else if (streq(s, "logic.i2c_to_parallel")) stamp_i2c_to_parallel(s, matrix);
    else if (streq(s, "logic.adc")) stamp_adc(s, matrix);
    else if (streq(s, "logic.dac")) stamp_dac(s, matrix);
    else if (streq(s, "logic.lm555")) stamp_lm555(s, matrix);
    else if (streq(s, "logic.subtractor")) stamp_subtractor(s, matrix);
    else if (streq(s, "logic.multiplier")) stamp_multiplier(s, matrix);
    else if (streq(s, "logic.divider")) stamp_divider(s, matrix);
    else if (streq(s, "logic.shifter")) stamp_shifter(s, matrix);
    else if (streq(s, "logic.negator")) stamp_negator(s, matrix);
    else if (streq(s, "logic.minmax")) stamp_minmax(s, matrix);
    else if (streq(s, "logic.absolute")) stamp_absolute(s, matrix);
    else if (streq(s, "logic.bit_adder")) stamp_bit_adder(s, matrix);
    else if (streq(s, "logic.register")) stamp_register(s, matrix);
    else if (streq(s, "logic.random")) stamp_random(s, matrix);
    else if (streq(s, "logic.decoder")) stamp_decoder(s, matrix);
    else if (streq(s, "logic.priority_encoder")) stamp_priority_encoder(s, matrix);
    else if (streq(s, "logic.bit_selector")) stamp_bit_selector(s, matrix);
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

/* ABI v2 (.spec/archive/legacy-v2/lasecsimul-native-devices.spec): get_state/set_state passam a se autoversionar --
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

/* Transaction-level adapter for the same deterministic RAM state machine used
 * by the electrical pins. This is intentionally a Core adapter operation: it
 * never fabricates an ACK in transport and keeps address/NACK/data semantics
 * identical to i2c_scl_rising()/i2c_prepare_tx_byte(). */
static uint32_t i2c_transfer(LsdnDevice* dev, const LsdnI2cTransfer* transfer,
                             LsdnI2cTransferResult* result) {
    LogicDevice* s = (LogicDevice*)dev;
    if (!transfer || !result || !streq(s, "logic.i2c_ram")) return 0;
    memset(result, 0, sizeof(*result));
    result->first_nack = LSDN_I2C_NO_NACK;
    result->handled = 1;
    result->address_ack = transfer->address == i2c_address(s);
    if (!result->address_ack) return 1;
    if (transfer->start) i2c_start_write(s);
    if (transfer->read) {
        for (uint32_t i = 0; i < transfer->rx_size; ++i)
            if (transfer->rx_data) transfer->rx_data[i] = i2c_ram_tx_byte(s);
        result->rx_size = transfer->rx_size;
    } else {
        for (uint32_t i = 0; i < transfer->tx_size; ++i) i2c_ram_rx_byte(s, transfer->tx_data[i]);
    }
    return 1;
}

static void destroy(LsdnDevice* dev) { free(dev); }

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
