#include <stdint.h>

void _start(void)
{
    volatile uint32_t *const i2c = (volatile uint32_t *)0x3ff53000u;
    for (;;) {
        i2c[0x1c / 4] = 0x78u;
        i2c[0x58 / 4] = 0x101u;
        i2c[0x5c / 4] = 0x1800u;
        i2c[0x04 / 4] = 0x20u;
    }
}
