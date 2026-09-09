# E109 - MWDT B0 baseline preservation and correction (2026-09-04)

Classification: `MEASURED_SIMULATOR`

This entry corrects the N=1 finding in E108 before further MWDT attribution.
The two latest N=1 stderr captures were preserved with the exact staged runtime,
firmware, harness, source-only QEMU diff, and a machine-readable manifest at:

`vnext_prototype/mwdt_baselines/2026-09-04-pre-b01`

SHA-256:

- `qemu-system-xtensa.exe`: `F989F7D449748C700280B22EBE1BEF3788A77D081A36FAB3B0C0208F6402A936`
- `merged.bin`: `965DF6EDBC11BD190BDDF6C48BEF97DD314AB4CF330F34E98B07D392E4CA3B38`
- `firmware.elf`: `C00CA7478B454EEC7BA63B95E4C1C8CA652043283FB5E8FBBF40FC09E6DD3420`
- `vnext_b_production_scale_test.exe`: `DD3E79581706C07DFE93551AF18E79376717BFE739CF3F6889840775D2BC9D50`

The capture contains 89 total resets: one initial `OTHER`, one expected APP CPU
startup reset, and 87 unexpected `SW_CPU_RESET_REGISTER` resets. The reset source
names the final mechanism, not the initiating cause; it is not MWDT attribution.

`mcu_component_test` is not an equivalent firmware control: it creates a blank
4 MiB flash rather than using `guest_i2c_workload/merged.bin`. B7's one-shot session
summary remains unimplemented. Residual diagnostics were still active in the CPU
execution hot path, ESP32 I2C paths, and the unconditional 500 Hz PC sampler; B0.1
must be completed and validated before the N=1 reset finding is classified.

`DECISIONS.md` is intentionally unchanged: no watchdog, reset, transport, or other
runtime semantic change is recorded here.

## B0.1 implementation and validation status

Diagnostic-only hygiene was applied in the QEMU fork and staged as runtime SHA-256
`4777D21ABE83F3D69A471EC2653E7E19E0BA74F941427B4A137D112CEB246F1D`:

- `cpu_exec()` now caches its VNEXT probe gate once and does not query the
	environment on every vCPU entry when the probe is disabled.
- I2C `[VNEXT_PROBE]` reads and bounded empty-FIFO reports now require the cached
	`LASECSIMUL_VNEXT_TRACE` gate.
- The 500 Hz PC sampler requires `LASECSIMUL_XTENSA_PC_SAMPLER`; when unset it
	allocates no timer, schedules no callback, and writes no sampler file.

The QEMU target rebuilt successfully with the required `nice -n 19 ninja -j 8`
limit. One complete Core regression passed 13/13. An isolated rerun of
`mcu_scheduler_pacing_sync_real_qemu_test` passed in 91.6 s after making the
new gate initialization thread-safe. A second full 13/13 regression has not yet
produced an admissible final result because its wrapper was interrupted before
completion; therefore B0.1 is not closed and B10-R/B9/B12 remain blocked.

## B0.1 validation blocker: pacing backstop

`run_regression.ps1` now returns exit code 1 whenever any test is not `PASS`,
including `NOT_BUILT`; its negative check against an empty build directory emitted
`FAILED=13` and returned 1.

The post-B0.1 runtime `36F65C1F6EE5F1B58BED75A1AAD15058BD8D4A843B95C4C9933958C71E3B7E2D`
has two documented full 13/13 runs, but later full runs failed the pacing test at
77.55 s and 20.80 s. Isolated repetitions with diagnostics disabled, BelowNormal
priority, and the 26-core affinity produced 2/3 pass and 1/3 controlled QEMU
shutdown at 37.4 s; the failure was `waitForSynch TIMEOUT (fila cheia, HOST
PROCESS-HEALTH BACKSTOP)`, with no orphan QEMU process. The same isolated protocol
against preserved pre-B0.1 runtime `F989F7D4...` passed 3/3.

This is insufficient to attribute the instability to the runtime change: the
backstop is a deliberate host-health protection triggered only after the Core has
not drained the 32-entry arena queue for three host seconds, and it requests a
clean QEMU shutdown rather than a watchdog reset. B0.1 remains blocked pending a
narrow investigation of the Core consumer/pacing path. No N=1 smoke, B10-R, B7.1,
B9, B11, or B12 execution is admissible yet.

The intermediate runtime SHA-256 `4777D21ABE83F3D69A471EC2653E7E19E0BA74F941427B4A137D112CEB246F1D`
was not preserved and is no longer present in the approved local runtime, baseline,
build, or pacing-artifact locations. It cannot serve as an exact paired control.
Reconstructing its source state would create a new binary with different provenance
and SHA, so that experiment is intentionally not substituted. Preserve every future
runtime used in a causal comparison before staging the next executable.

That restriction was revised: a reconstructed control is valid when explicitly
labeled as reconstructed. The current gate-enabled sources match the preserved
pre-control copies byte-for-byte, but their rebuild produced SHA-256 `E968858C...`
rather than `36F65C1F...`; this establishes byte-level build nondeterminism, not a
source mismatch. The paired experiment therefore compares the reconstructed control
`61BEE35E...` against the source-identical, gate-enabled runtime `E968858C...`, with
both SHA values and the two intentional code differences recorded in
`vnext_prototype/mwdt_controls/2026-09-04-gate-control-reconstructed`.

A non-gating 15 s N=1 sanity check against `36F65C1F...` directly validated the
implemented hygiene: zero `[VNEXT_PROBE]` lines, zero PC-sampler files, and 63
stderr lines. It still observed one initial `OTHER` reset and 22
`SW_CPU_RESET_REGISTER` resets, with zero MWDT-attributed resets; this does not
authorize B10-R.

The original paired runner subsequently completed all five pairs; its persisted
results are `paired-pacing-runs/results.json`. The reconstructed control
(`61BEE35E...`) had 2/5 queue-full backstop timeouts (29.6 s and 76.4 s), while
the gate-enabled reconstructed runtime (`E968858C...`) also had 2/5 (15.0 s and
60.3 s). Pair 3 produced the same unexplained `exit=0xffffffff` after reaching
the QEMU main loop in both arms, with no `waitForSynch TIMEOUT`; these two runs
are invalid but balanced. The remaining three pairs passed in both arms. Host
samples were low before runs (4.2-17.0% CPU utility; queue length 0), and no
QEMU process remained after any run.

Conclusion: this five-pair reconstructed comparison finds no evidence that the
two final probe gates increase pacing failures. It does not close B0.1: two
independent full `run_regression.ps1` executions with an explicit `PASS=13 of 13`
result are still required, and the intermittent queue-full/`0xffffffff` pacing
failure remains a separate test-stability problem.