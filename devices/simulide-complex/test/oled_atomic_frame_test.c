#include <stdio.h>
#include <stdlib.h>
#include <string.h>

/* Internal regression test: include the implementation to exercise the GDDRAM/front-buffer
 * boundary without depending on IPC, QEMU, or screen timing. The DLL is built separately. */
#include "../src/lib.c"

static uint64_t fake_now_ns;

static uint64_t test_now_ns(void* context) {
    (void)context;
    return fake_now_ns;
}

static int check(int condition, const char* message) {
    if (!condition) fprintf(stderr, "FAILED: %s\n", message);
    return condition;
}

int main(void) {
    LsdnHostApi api;
    memset(&api, 0, sizeof(api));
    api.now_ns = test_now_ns;

    SimDevice* display = (SimDevice*)calloc(1, sizeof(SimDevice));
    if (!display) return 2;
    display->api = &api;
    display->kind = KIND_OLED;
    display->width = 128;
    display->height = 64;
    display->rows = 8;
    oled_reset(display);
    display->display_on = 1;
    display->addr_mode = 0;
    display->start_x = display->start_y = display->x = display->y = 0;
    display->end_x = 127;
    display->end_y = 7;

    memset(display->bytes, 0x11, 1024);
    oled_present(display);

    fake_now_ns = 1000000;
    for (int i = 0; i < 512; ++i) oled_data(display, 0xaa);
    int ok = check(display->oled_frame_active, "frame must remain pending at its halfway point") &&
             check(display->oled_presented[0] == 0x11 && display->oled_presented[511] == 0x11,
                   "front buffer must not expose half of the new frame");

    for (int i = 512; i < 1024; ++i) oled_data(display, 0xaa);
    ok &= check(!display->oled_frame_active, "complete frame must be published atomically");
    ok &= check(display->oled_presented[0] == 0xaa && display->oled_presented[1023] == 0xaa,
                "front buffer must contain the complete new frame");

    /* A page-window update is also split across I2C transactions. The visible
     * image must not contain columns from both the old and new text positions. */
    display->start_x = display->x = 0;
    display->end_x = 127;
    display->start_y = display->y = 2;
    display->end_y = 4;
    for (int i = 0; i < 31; ++i) oled_data(display, 0x55);
    ok &= check(display->oled_frame_active && display->oled_presented[2 * 128] == 0xaa,
                "a partial page-window transaction must stay pending");
    for (int i = 31; i < 3 * 128; ++i) oled_data(display, 0x55);
    ok &= check(!display->oled_frame_active &&
                    display->oled_presented[2 * 128] == 0x55 &&
                    display->oled_presented[4 * 128 + 127] == 0x55 &&
                    display->oled_presented[128] == 0xaa,
                "the complete page window must publish without changing other pages");

    fake_now_ns = 2000000;
    display->start_y = display->y = 0;
    display->end_y = 7;
    display->x = 0;
    for (int i = 0; i < 32; ++i) oled_data(display, 0x55);
    fake_now_ns += 1000000000ull;
    ok &= check(display->oled_presented[0] == 0xaa,
                "idle time must not publish an incomplete full-frame transfer");
    oled_command(display, 0xae);
    ok &= check(display->oled_presented[0] == 0x55 && display->oled_presented[31] == 0x55 &&
                    display->oled_presented[32] == 0xaa,
                "a command boundary must publish an intentionally partial update");

    /* SSD1306 scroll changes the glass read address, never the GDDRAM. Stopping it must
     * restore the original pixels; other pages remain stationary. */
    memset(display->bytes, 0, 1024);
    display->bytes[0] = 1;
    display->bytes[128 + 10] = 1;
    oled_present(display);
    display->display_on = 1;
    display->oled_scroll_start = display->oled_scroll_end = 0;
    display->oled_scroll_right = 0;
    oled_command(display, 0x2f);
    oled_scroll_once(display);
    uint8_t visible[1024];
    visible_mono_payload(display, visible, sizeof visible);
    ok &= check(visible[127] == 1 && visible[128 + 10] == 1,
                "hardware scroll must wrap only its configured page");
    ok &= check(display->bytes[0] == 1 && display->oled_presented[0] == 1,
                "hardware scroll must not modify GDDRAM or front buffer");
    oled_command(display, 0x2e);
    visible_mono_payload(display, visible, sizeof visible);
    ok &= check(visible[0] == 1 && visible[127] == 0 && visible[128 + 10] == 1,
                "stopscroll must restore the unshifted GDDRAM image");

    /* A split fast-path FIFO write may continue with START=0 after pin-edge
     * notifications. Those notifications cannot replace its I2C control phase. */
    oled_reset(display);
    display->addr_mode = 0;
    display->i2c_address = 0x3c;
    uint8_t first_slice[] = {0x40, 0xa5};
    LsdnI2cTransfer transfer = {0};
    LsdnI2cTransferResult result;
    transfer.address = 0x3c;
    transfer.start = transfer.stop = 1;
    transfer.tx_data = first_slice;
    transfer.tx_size = sizeof first_slice;
    i2c_transfer((LsdnDevice*)display, &transfer, &result);
    display->pin_level[0] = display->pin_level[1] = 1;
    handle_pin_change(display, 1, 0);
    uint8_t second_slice[] = {0x5a};
    transfer.start = 0;
    transfer.tx_data = second_slice;
    transfer.tx_size = sizeof second_slice;
    i2c_transfer((LsdnDevice*)display, &transfer, &result);
    ok &= check(display->bytes[0] == 0xa5 && display->bytes[1] == 0x5a &&
                    display->fast_i2c_phase == 1,
                "fast continuation must remain in data mode across unrelated pin edges");

    free(display);
    if (ok) printf("OK: SSD1306 publishes only complete frames or explicit partial boundaries.\n");
    return ok ? 0 : 1;
}
