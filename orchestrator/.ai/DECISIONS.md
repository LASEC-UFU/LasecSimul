# Decisions

## DECISION-001 — Canonical development QEMU runtime

**Status:** ACTIVE / FROZEN  
**Evidence:** SOURCE PROVEN + MEASURED RUNTIME

The canonical test executable is the staged runtime copy under
`C:\SourceCode\LasecSimul\vnext_prototype\dev_qemu_runtime`. It has the same
SHA-256 as the `build-ucrt64` executable and includes the adjacent MSYS2 UCRT64
DLL set required for standalone launch. The raw build executable is not a
standalone runtime and returned `0xC0000135` when launched without those DLLs.
The packaged historical rollback executable is not substituted.

## DECISION-002 — Historical rollback binary preservation

**Status:** ACTIVE / FROZEN  
**Evidence:** MEASURED HASH

`devices/qemu-esp32/bin/qemu-system-xtensa.exe` remains unchanged as the
rollback artifact with SHA-256
`471AE54193CC7A86F6A448D53BC1E810F5B50D6EBAD1FE48FC34AA04F56F74CE`.

## DECISION-003 — Diagnostic logging policy

**Status:** ACTIVE  
**Evidence:** SOURCE PROVEN

Per-operation I2C diagnostic output is gated by `LASECSIMUL_VNEXT_TRACE` and
is off by default. This is diagnostic-only; no transport, ABI, scheduler,
backpressure, or reset semantic change is inferred from it.

## DECISION-004 — Architecture remains frozen during localization

**Status:** ACTIVE / FROZEN  
**Evidence:** DERIVED FROM FROZEN CONTRACT

Do not change the VNEXT ABI, dispatcher, ProducerLane, ResponseSlot/C2A,
backpressure, reset semantics, or polling architecture while the remaining
survivor localization is being compared. Any semantic production change must
first set `REVIEW_REQUIRED=YES`.

## DECISION-005 — Handoff persistence

**Status:** ACTIVE  
**Evidence:** PROCESS DECISION

Every future session must update the handoff/state documents with exact
current paths, hashes, commands, results, blocker, and next action,
independent of the value of `REVIEW_REQUIRED`.

## DECISION-006 — Bare-metal fixtures are the oracle for device-level watchdog behaviour

**Status:** ACTIVE
**Date:** 2026-09-03
**Evidence:** E097, E098, E101

Watchdog *hardware model* behaviour is tested with
`vnext_prototype/guest_mwdt_baremetal`, a framework-free Xtensa image booted
through QEMU's `-kernel` ELF path. Arduino and ESP-IDF guests are rejected for
this purpose: their frameworks own and feed `TIMG_WDT`, so no unfed
precondition can be established (E060-E063).

The fixture builds with `xtensa-esp32-elf-gcc` + `objcopy` only, in about two
seconds, with no Python, ESP-IDF or PlatformIO runtime.

This decision is scoped to *device* behaviour. Official ESP-IDF IWDT *policy*
conformance, if it is ever required, is a separate subject and a separate
fixture.

## DECISION-007 — Diagnostic traces are not a timing instrument

**Status:** ACTIVE
**Date:** 2026-09-03
**Evidence:** E099

`LASECSIMUL_TG0_WDT_TRACE`, `LASECSIMUL_TG1_WDT_TRACE` and
`LASECSIMUL_VNEXT_TRACE` cost a median 2.2 s per emitted line on this host and
shift the MTTCG-realtime virtual clock by an order of magnitude. They may be
used to answer *what happened*; they may not be used to answer *when*.

Timing and reset classification use the unconditional
`[LasecSimul][ESP32 reset]` line and harness counters.

## DECISION-008 — Every scale result carries a validity arm

**Status:** ACTIVE
**Date:** 2026-09-03
**Evidence:** E101

A multi-session run may not be recorded as PASS on the absence of a symptom
alone. It must include an arm that shares the code path under test and is
expected to produce the symptom, demonstrating that each instance actually
reached the condition being measured.

Rationale: the first 16-session run in E101 showed zero MWDT resets for both
the fed and the unfed variant, because at a 60 s window no guest had finished
QEMU construction. Without the control that would have been recorded as a PASS.

## DECISION-009 — The CPython / ESP-IDF assembly route is closed

**Status:** CLOSED
**Date:** 2026-09-03
**Evidence:** `CLOSED_HYPOTHESES.md` postmortem

Iterations 61-90 are terminated with no result. Do not acquire, extract or
assemble CPython runtimes, and do not resume IDF wheelhouse work, in service of
the MWDT gates. The ~452 MB of artifacts in this folder and the ~16 MB of
wheelhouses under the repository-root `.ai/` were **deleted on 2026-09-03**
together with the acquisition scripts; the postmortem in
`CLOSED_HYPOTHESES.md` is the surviving record.

If an ESP-IDF build is ever genuinely required for a different reason, the
starting point is that `.piohome/python_env/idf4.4_py3.12_env` is broken only
because its base interpreter path (`C:\Program Files\Python312`) no longer
exists; a working CPython 3.12 is present at
`C:\Users\Administrator\AppData\Local\Programs\Python\Python312`, and
`.ai/wheelhouse_idf_requirements_66/` already holds a complete cp312 wheelhouse
that was proven to install (E066).

## DECISION-010 — Test runs must leave the host usable

**Status:** ACTIVE
**Date:** 2026-09-03
**Evidence:** incident below, plus E100/E101 run shapes

The bare-metal fixture guest is a tight infinite loop: every emulated vCPU
thread holds a core at 100% and never yields. Multi-session runs therefore
consume exactly as much CPU as they are allowed to, for the whole window.

**Incident.** A 32-instance run on this 32-core host, at normal priority with
no affinity restriction, left nothing for the interactive session. Display and
input stopped responding and the machine had to be powered off at the wall.
The power-off truncated an in-flight QEMU build, leaving zero-byte object files
and NUL-filled generated headers (`qapi/qapi-introspect.h`,
`qapi/qapi-events-cryptodev.h`, `qapi/qapi-events-cxl.h`), which then failed to
link with thousands of `undefined reference to visit_type_*`. Recovery required
`ninja -t clean` and a full rebuild.

**Rules.**

1. Every QEMU process launched by a test runner is set to `Idle` priority.
2. Multi-session runners confine guests with a processor-affinity mask that
   leaves cores free for the OS. `run_scale.ps1` reserves 6 of 32 by default
   (`-ReserveCores`) and refuses a population larger than the usable cores
   unless `-Force` is passed.
3. Builds cap parallelism. Use `ninja -j 8` under `nice -n 19`, never bare
   `ninja` — its default of cores+2 saturates the machine just as badly as the
   test runs do.
4. These limits change scheduling, not semantics. A fed guest that survives on
   26 confined cores survives on 32 unconfined ones; the watchdog deadlines come
   from `QEMU_CLOCK_VIRTUAL`, not from host CPU share.
