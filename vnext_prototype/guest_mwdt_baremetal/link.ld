/* Bare-metal ESP32 MWDT fixture.
 *
 * The image is loaded through QEMU's `-kernel` ELF path (hw/xtensa/esp32.c),
 * which sets the architectural entry point directly.  No ROM bootloader, no
 * second-stage bootloader and no ESP-IDF runtime take part, so the only guest
 * code that touches TIMG_WDT is this fixture. */
ENTRY(_start)
SECTIONS
{
  /* ESP32 IRAM window: executable without ROM/MMU setup. */
  . = 0x40080000;
  .text : ALIGN(4) { *(.text.entry) *(.text*) *(.literal*) }
  .rodata : ALIGN(4) { *(.rodata*) }
  /DISCARD/ : { *(.comment) *(.note*) }
}
