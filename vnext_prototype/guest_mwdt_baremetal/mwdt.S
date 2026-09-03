/*
 * Deterministic bare-metal ESP32 MWDT fixture.
 *
 * Purpose: provide the FED / UNFED oracle required by the
 * ESP32_MWDT_BEHAVIOR and ESP32_MWDT_LOAD_INDEPENDENCE gates without the
 * Arduino or ESP-IDF frameworks.  Framework code owns TIMG_WDT
 * configuration and feeding, which is why every framework-based attempt
 * (evidence E060-E063) failed to establish a no-feed precondition.  Here the
 * fixture is the only writer of TIMG_WDT.
 *
 * Assemble-time parameters (xtensa-esp32-elf-gcc --defsym):
 *   TG_BASE_HI / TG_BASE_LO  timer group base, split for literal building
 *   FEED_ENABLED             1 = feed forever, 0 = never feed
 *   STG0_MODE                0 OFF, 1 INT, 2 CPURESET, 3 SYSRESET
 *   STG1_MODE                same encoding
 *   STG0_TICKS / STG1_TICKS  stage timeouts, in prescaler ticks
 *   PRESCALE                 TIMG_WDTCONFIG1.PRESCALE (bits 31:16)
 *   FEED_DELAY               busy-loop iterations between feeds
 *   FEED_COUNT               0 = feed forever, N = feed N times then starve
 *   FEED_BUDGET              FEED_COUNT, or 1 when FEED_COUNT is 0
 *
 * Register map is hw/timer/esp32_timg.c / include/hw/timer/esp32_timg.h:
 *   0x48 WDTCONFIG0  EN(31) STG0(30:29) STG1(28:27) STG2(26:25) STG3(24:23)
 *                    EDGE_INT(22) LEVEL_INT(21) FLASHBOOT_MODE_EN(14)
 *   0x4c WDTCONFIG1  PRESCALE(31:16)
 *   0x50..0x5c       stage 0..3 timeouts
 *   0x60 WDTFEED
 *   0x64 WDTPROTECT  must hold 0x50D83AA1 for CONFIG/FEED writes to apply
 *
 * Literals are emitted before _start on purpose: l32r only reaches backwards,
 * so a literal pool placed after the code would be unreachable.
 */

    .section .text.entry, "ax"
    .align 4

lit_tg_base:    .word (TG_BASE_HI << 16) | TG_BASE_LO
lit_tg0_base:   .word 0x3ff5f000
lit_protect:    .word 0x50D83AA1
lit_config1:    .word (PRESCALE << 16)
lit_config0:    .word 0x80000000 | (STG0_MODE << 29) | (STG1_MODE << 27) | 0x00200000
lit_stg0:       .word STG0_TICKS
lit_stg1:       .word STG1_TICKS
lit_feed:       .word 0x80000000
lit_delay:      .word FEED_DELAY
lit_feedcount:  .word FEED_BUDGET

    .global _start
    .type _start, @function
_start:
    /* TIMER_GROUP0 comes out of reset with FLASHBOOT_MODE_EN set and a 650 ms
     * stage-0 SYSRESET.  Silence it unconditionally first: otherwise a TG1
     * fixture is reset by TG0 long before its own stage deadline, which shows
     * up as a fed guest that still resets (observed 2026-09-03, cause0=7). */
    l32r    a2, lit_tg0_base
    l32r    a3, lit_protect
    s32i    a3, a2, 0x64
    movi    a3, 0
    s32i    a3, a2, 0x48

    l32r    a2, lit_tg_base

    /* Unlock the protected register block and keep it unlocked: WDTFEED is
     * itself rejected while protected. */
    l32r    a3, lit_protect
    s32i    a3, a2, 0x64

    /* Disable before reprogramming.  Writing CONFIG0 also clears
     * FLASHBOOT_MODE_EN, which is set out of reset on TIMER_GROUP0 and would
     * otherwise keep the reset-default 650 ms SYSRESET stage armed. */
    movi    a3, 0
    s32i    a3, a2, 0x48

    l32r    a3, lit_config1
    s32i    a3, a2, 0x4c

    l32r    a3, lit_stg0
    s32i    a3, a2, 0x50
    l32r    a3, lit_stg1
    s32i    a3, a2, 0x54
    movi    a3, 0
    s32i    a3, a2, 0x58
    s32i    a3, a2, 0x5c

    /* Enable last, so the first armed deadline uses the stage table above. */
    l32r    a3, lit_config0
    s32i    a3, a2, 0x48

    /* a6 = remaining feed budget.  FEED_COUNT 0 means "feed forever": the
     * budget is loaded as 1 and never decremented, so the guard below never
     * trips. */
    l32r    a6, lit_feedcount

main_loop:
    .if FEED_ENABLED
    beqz    a6, starved
    l32r    a5, lit_delay
feed_delay:
    addi    a5, a5, -1
    bnez    a5, feed_delay
    l32r    a3, lit_feed
    s32i    a3, a2, 0x60
    .if FEED_COUNT
    addi    a6, a6, -1
    .endif
starved:
    .endif
    j       main_loop

    .size _start, .-_start
