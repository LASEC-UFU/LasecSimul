ENTRY(_start)
SECTIONS
{
  /* Use the ESP32 IRAM window, which is executable without ROM/MMU setup. */
  . = 0x40080000;
  .text : ALIGN(4) { *(.text.entry) *(.text*) *(.literal*) }
  .rodata : ALIGN(4) { *(.rodata*) }
  /DISCARD/ : { *(.comment) *(.note*) }
}
