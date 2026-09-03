.section .text.entry, "ax"
.global _start
.type _start, @function

_start:
    /* Disable TIMER_GROUP0 MWDT using the ESP32 protected-register sequence. */
    movi    a4, 0x3f
    slli    a4, a4, 24
    movi    a5, 15
    slli    a5, a5, 20
    add     a4, a4, a5

    movi    a5, 5
    slli    a5, a5, 16
    add     a4, a4, a5
    movi    a5, 15
    slli    a5, a5, 12
    add     a4, a4, a5
    movi    a5, 80
    slli    a5, a5, 24
    movi    a6, 13
    slli    a6, a6, 20
    add     a5, a5, a6
    movi    a6, 8
    slli    a6, a6, 16
    add     a5, a5, a6
    movi    a6, 58
    slli    a6, a6, 8
    add     a5, a5, a6
    movi    a6, 127
    addi    a6, a6, 34
    slli    a6, a6, 0
    add     a5, a5, a6
    s32i    a5, a4, 0x64
    movi    a5, 0
    s32i    a5, a4, 0x48
    s32i    a5, a4, 0x64

    /* Let the host-side Core scheduler attach before the first synchronous
     * VNEXT register publication.  This is guest startup settling time, not
     * transport polling or a protocol wait. */
    movi    a7, 0x3ff
startup_settle:
    movi    a6, 0x3ff
startup_settle_inner:
    addi    a6, a6, -1
    bnez    a6, startup_settle_inner
    addi    a7, a7, -1
    bnez    a7, startup_settle

    /* Route I2C0 through the real GPIO matrix to GPIO21 (SDA) and GPIO22 (SCL).
     * The adapter models these as open-drain outputs and matrix inputs. */
    movi    a2, 0x3f
    slli    a2, a2, 24
    movi    a3, 15
    slli    a3, a3, 20
    add     a2, a2, a3
    movi    a3, 4
    slli    a3, a3, 16
    add     a2, a2, a3
    movi    a3, 9
    slli    a3, a3, 12
    add     a2, a2, a3
    movi    a3, 0x7c
    add     a3, a3, a2
    movi    a5, 2
    slli    a5, a5, 12
    s32i    a5, a3, 0
    movi    a3, 0x80
    add     a3, a3, a2
    s32i    a5, a3, 0

    /* GPIO matrix input selections: function 29=SCL, 30=SDA. Output
     * selections use the open-drain bit (bit 9) on GPIO21/22. */
    movi    a2, 0x3f
    slli    a2, a2, 24
    movi    a3, 15
    slli    a3, a3, 20
    add     a2, a2, a3
    movi    a3, 4
    slli    a3, a3, 16
    add     a2, a2, a3
    movi    a3, 4
    slli    a3, a3, 12
    add     a2, a2, a3
    movi    a3, 0x1a4
    add     a3, a3, a2
    movi    a5, 22
    s32i    a5, a3, 0
    movi    a3, 0x1a8
    add     a3, a3, a2
    movi    a5, 21
    s32i    a5, a3, 0
    movi    a3, 0x584
    add     a3, a3, a2
    movi    a5, 0x21d
    s32i    a5, a3, 0
    movi    a3, 0x588
    add     a3, a3, a2
    movi    a5, 0x21e
    s32i    a5, a3, 0

    movi    a2, 0x3f
    slli    a2, a2, 24
    movi    a3, 15
    slli    a3, a3, 20
    add     a2, a2, a3
    movi    a3, 5
    slli    a3, a3, 16
    add     a2, a2, a3
    movi    a3, 3
    slli    a3, a3, 12
    add     a2, a2, a3
    movi    a3, 0x3c
    slli    a3, a3, 1
    addi    a3, a3, 1
    s32i    a3, a2, 0x1c

    /* command 0: one-byte WRITE; no external slave is required for the
     * machine-level MMIO baseline, so leave ACK checking disabled. */
    movi    a3, 0
    s32i    a3, a2, 0x58
    movi    a3, 9
    slli    a3, a3, 8
    addi    a3, a3, 1
    s32i    a3, a2, 0x5c

    /* command 2: one-byte READ, NACK the final byte */
    movi    a3, 2
    slli    a3, a3, 11
    movi    a6, 1
    slli    a6, a6, 10
    add     a3, a3, a6
    addi    a3, a3, 1
    s32i    a3, a2, 0x60

    /* command 3: STOP */
    movi    a3, 3
    slli    a3, a3, 11
    s32i    a3, a2, 0x64

    /* I2C_CTR.TRANS_START */
    movi    a3, 0x20
    s32i    a3, a2, 0x04

wait_i2c:
    l32i    a6, a2, 0x08
    extui   a6, a6, 4, 1
    bnez    a6, wait_i2c

    /* Observe completion/status and the guest-visible RX FIFO. */
    l32i    a6, a2, 0x08
    l32i    a6, a2, 0x1c

1:
    /* Keep the modeled TIMER_GROUP0 watchdog fed while the minimal guest
     * remains alive for the host-side observation window. */
    movi    a3, -1
    slli    a3, a3, 31
    s32i    a3, a4, 0x60
    j       1b
.size _start, .-_start
