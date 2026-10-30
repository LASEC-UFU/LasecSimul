#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Internal regression test: include the implementation to drive the electrical I2C slave edge by
 * edge, with the bus as a wired-AND of master and slave (open drain + pull-up), as on the chip.
 * The DLL is built separately. */
#include "../src/lib.c"

static int master_sda = 1;
static int scl = 1;
static int slave_edges_with_scl_high = 0;

static int check(int condition, const char* message) {
    if (!condition) fprintf(stderr, "FAILED: %s\n", message);
    return condition;
}

static int bus_sda(const LogicDevice* s) { return master_sda && !(s->i2c_ack || s->tx_drive_low); }

static void deliver(LogicDevice* s, uint32_t pin, int level) {
    LsdnEvent ev;
    memset(&ev, 0, sizeof(ev));
    ev.tag = LSDN_EVT_PIN_CHANGE;
    ev.a = pin;
    ev.b = (uint32_t)level;
    on_event((LsdnDevice*)s, &ev);
}

/* What the slave drives reaches its own SDA pin in the next solve, like in the Core. */
static void settle(LogicDevice* s, int master_moved_sda) {
    for (int i = 0; i < 4 && s->pin_level[0] != bus_sda(s); ++i) {
        if (scl && !master_moved_sda) ++slave_edges_with_scl_high;
        deliver(s, 0, bus_sda(s));
        master_moved_sda = 0;
    }
}

static void set_scl(LogicDevice* s, int level) {
    scl = level;
    deliver(s, 1, level);
    settle(s, 0);
}

static void set_sda(LogicDevice* s, int level) {
    master_sda = level;
    settle(s, 1);
}

static void start(LogicDevice* s) {
    set_sda(s, 1);
    set_scl(s, 1);
    set_sda(s, 0);
    set_scl(s, 0);
}

static void stop(LogicDevice* s) {
    set_sda(s, 0);
    set_scl(s, 1);
    set_sda(s, 1);
}

/* Returns 1 when the slave ACKed, sampled with SCL high as the ESP32 controller does. */
static int write_byte(LogicDevice* s, uint8_t byte) {
    for (int bit = 7; bit >= 0; --bit) {
        set_sda(s, (byte >> bit) & 1);
        set_scl(s, 1);
        set_scl(s, 0);
    }
    set_sda(s, 1);
    set_scl(s, 1);
    const int ack = !bus_sda(s);
    set_scl(s, 0);
    return ack;
}

static uint8_t read_byte(LogicDevice* s, int nack) {
    uint8_t value = 0;
    set_sda(s, 1);
    for (int bit = 0; bit < 8; ++bit) {
        set_scl(s, 1);
        value = (uint8_t)((value << 1) | bus_sda(s));
        set_scl(s, 0);
    }
    set_sda(s, nack);
    set_scl(s, 1);
    set_scl(s, 0);
    set_sda(s, 1);
    return value;
}

int main(void) {
    LogicDevice* ram = (LogicDevice*)calloc(1, sizeof(LogicDevice));
    if (!ram) return 2;
    strcpy(ram->type_id, "logic.i2c_ram");
    ram->mem_size = 256;
    ram->control_code = 0x3c;
    ram->i2c_phase = 1;
    ram->pin_level[0] = 1;
    ram->pin_level[1] = 1;

    const uint8_t address = 0x3c << 1;
    start(ram);
    int ok = check(write_byte(ram, address), "address (write) must be ACKed while SCL is high");
    ok &= check(write_byte(ram, 0x05), "word address must be ACKed");
    ok &= check(write_byte(ram, 0xa5), "first data byte must be ACKed");
    ok &= check(write_byte(ram, 0x5a), "second data byte must be ACKed");
    stop(ram);
    ok &= check(ram->mem[5] == 0xa5 && ram->mem[6] == 0x5a, "written bytes must land at the word address");

    /* Register read: pointer write, repeated START, read with ACK then NACK. */
    start(ram);
    ok &= check(write_byte(ram, address), "address (write) of the register read must be ACKed");
    ok &= check(write_byte(ram, 0x05), "register pointer must be ACKed");
    set_sda(ram, 1);
    set_scl(ram, 1);
    set_sda(ram, 0); /* repeated START */
    set_scl(ram, 0);
    ok &= check(write_byte(ram, address | 1u), "address (read) must be ACKed");
    const uint8_t first = read_byte(ram, 0);
    const uint8_t second = read_byte(ram, 1);
    stop(ram);
    ok &= check(first == 0xa5, "first byte read must be the one at the pointer");
    ok &= check(second == 0x5a, "second byte read must follow it");

    /* A read right after the address, without a pointer write, continues where the pointer is. */
    start(ram);
    ok &= check(write_byte(ram, address | 1u), "plain read address must be ACKed");
    ok &= check(read_byte(ram, 1) == 0x00, "plain read returns the byte after the last one read");
    stop(ram);

    start(ram);
    ok &= check(!write_byte(ram, (0x3d << 1)), "another address must be NACKed");
    stop(ram);

    ok &= check(slave_edges_with_scl_high == 0, "the slave must only move SDA while SCL is low");
    free(ram);
    if (!ok) return 1;
    printf("i2c_slave_timing: ACK held through the 9th clock, read/write/NACK OK\n");
    return 0;
}
