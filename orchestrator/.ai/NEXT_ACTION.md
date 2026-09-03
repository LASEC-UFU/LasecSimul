# NEXT ACTION

Set 2026-09-03 after the build/test/validate pass. There is **no external
blocker**: the MSYS2 UCRT64 toolchain is installed and QEMU rebuilds here.

## Where we are

- `ESP32_MWDT_BEHAVIOR` / `ESP32_MWDT_LOAD_INDEPENDENCE`: **PASS at device
  level** (E098, E101), reproduced on the rebuilt binary.
- Production Core/VNEXT_B path: **OPEN**. Clean at 1/4/8 sessions; intermittent
  MWDT-attributed resets at 12 and 16 (E105).
- Two real defects found, fixed, built and regression-tested (E102, E103,
  E106) — 99.97% of QEMU output removed, reset records now retained — but they
  were **not** the cause of the residual resets. That hypothesis is refuted.

## Next action — test the oversubscription hypothesis

At 16 sessions there are 32 spinning vCPU threads on 26 usable cores. In
MTTCG-realtime `QEMU_CLOCK_VIRTUAL` follows wall time while emulated
instruction throughput does not, so an oversubscribed guest can miss a deadline
it would meet unloaded. That is the leading explanation for the E105 shape
(clean ≤8, intermittent ≥12) and it is **unproven**.

Hold the population fixed at 16 and vary only the core budget:

```powershell
# 26 usable cores  -> 32 threads on 26 -> oversubscribed   (the E105 baseline)
.\vnext_prototype\run_production_mwdt.ps1 -Sessions 16 -ReserveCores 6

# 30 usable cores  -> 32 threads on 30 -> marginal
.\vnext_prototype\run_production_mwdt.ps1 -Sessions 16 -ReserveCores 2
```

Run each at least five times: at N=16 the effect appeared in four runs of five,
so a single run proves nothing either way. If MWDT resets scale down as the
core budget rises, the hypothesis holds and the finding is that this workload
needs roughly two cores per session. If they do not move, the cause is
elsewhere and the next suspect is the TG0/CPU0 transport-pause compensation
(`esp32_timg.c:646-705`), which covers CPU0 only, so a lane-1/CPU1 stall is
never credited back.

**Do not raise `wdt_time_scale` past its cap of 100 to make the symptom go
away.** That is a watchdog semantic change, frozen by DECISION-004; it needs
review first.

## Rules for these runs

- Traces off (E099: ~2 s per emitted line).
- Constrain priority and affinity — the runners do it for you (DECISION-010).
- Every scale result carries a validity arm (DECISION-008).
- Allow for the ~7 s per-instance QEMU construction cost (E100).

## Also open, in rough priority order

1. **Harness teardown hang** (E104). `vnext_b_production_scale_test` never
   exits for more than one session; it blocks in `stopSimulation()` at
   `VnextBProductionScaleTest.cpp:697`. Pre-existing, reproduced on the
   pre-patch binary. It does not affect measurements, but it makes the harness
   unusable unattended.
2. **Three pre-existing Core test failures** (E106): `mcu_component_test`,
   `mcu_controller_real_qemu_test`, `qemu_icount_calibrator_test`. The Debug
   binaries date from 2026-08-26..30 and are stale against the current headers.
   Rebuilding them needs MSVC, which is not installed on this host — only the
   MSYS2 toolchain for QEMU was added. Install VS Build Tools and rebuild
   before judging these.
3. **Attribute the ~7 s `qemu_init` cost** (E100) and test whether 16 × 7 s of
   serial machine construction explains the historical `ADMISSION_1` timeouts.
   Add a per-session "QEMU ready" timestamp to the harness diagnostic.
4. **Explain the backpressure rate.** ~400 lane-credit exhaustions per second
   at one session, but none at all at eight (E105). That inversion is odd and
   was not investigated.
