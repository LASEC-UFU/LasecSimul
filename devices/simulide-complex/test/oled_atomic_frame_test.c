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

    fake_now_ns = 2000000;
    for (int i = 0; i < 32; ++i) oled_data(display, 0x55);
    fake_now_ns += 1000000000ull;
    ok &= check(display->oled_presented[0] == 0xaa,
                "idle time must not publish an incomplete full-frame transfer");
    oled_command(display, 0xae);
    ok &= check(display->oled_presented[0] == 0x55 && display->oled_presented[31] == 0x55 &&
                    display->oled_presented[32] == 0xaa,
                "a command boundary must publish an intentionally partial update");

    free(display);
    if (ok) printf("OK: SSD1306 publishes only complete frames or explicit partial boundaries.\n");
    return ok ? 0 : 1;
}
