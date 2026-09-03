# CLOSED / FROZEN HYPOTHESES

Do not reopen without contradictory new evidence.

## CLOSED

- Historical scheduler/safe-frontier line: closed as negligible guest-visible impact.
- Releasing BQL during synchronous peer wait: rejected; caused reentrant device access.
- Holding BQL through arenaOrderLock: rejected; caused severe hang.
- Redundant causal I2C C2A response notification: root cause proven and fixed.
- `latestVirtualTimeNs` as authoritative VNEXT progress: rejected.
- `tb-size=64M`: historical invalid/ignored configuration; use numeric 64.
- SW_APPCPU_RESET as primary failure cause: rejected; secondary/legitimate restart behavior.
- Stuck SW_APPCPU_RESET bit: rejected by pulse/self-clear model semantics.
- CPU1 MWDT compensation as current fix: not proven; frozen OFF, and no longer
  needed to explain anything - see `QEMU_HANDOFF.md` section 5.
- Unbounded QEMU stderr capture: rejected; current Core reader is continuous and bounded to 1 MiB/QEMU.
- **"The MWDT does not fire / fires spuriously"**: rejected 2026-09-03. The
  device model behaves correctly. E097-E101.
- **"A pure ESP-IDF IWDT fixture is required to close the MWDT gates"**:
  rejected 2026-09-03. See the postmortem below.

## POSTMORTEM - the ESP-IDF / CPython infrastructure spiral (iterations 61-90)

Preserved deliberately. This consumed roughly 30 orchestrator iterations across
two days and produced **zero watchdog evidence**. Do not restart any part of it.

### How it started

`MWDT_DEEP_REVIEW_PLAN.md` (2026-08-31) correctly observed that the mixed
Arduino+ESP-IDF TG1 fixture could not prove *official ESP-IDF IWDT policy*,
because the framework owns and rewrites `TIMG_WDT` configuration and feeds it
(E060-E063). Its conclusion - build a pure ESP-IDF IWDT conformance fixture -
then became the only path considered.

**The conflation.** The two open gates are

```text
ESP32_MWDT_LOAD_INDEPENDENCE
ESP32_MWDT_BEHAVIOR   - fed survives load; unfed still resets
```

Both are statements about the **QEMU MWDT device model** (`hw/timer/esp32_timg.c`),
not about ESP-IDF's `int_wdt.c` policy. ESP-IDF's IWDT is *a consumer* of that
device. Proving the device needs a guest that programs `TIMG_WDT` and either
feeds it or does not - which is far easier without a framework than with one.
The review made the fixture depend on the largest possible software stack in
order to test the smallest possible piece of hardware.

Its own escape hatch - "if dependency installation stalls again, classify the
result as INFRASTRUCTURE BLOCKED" (Phase 1) - was never taken.

### What the 30 iterations actually did

| Iterations | Activity | Result |
|---|---|---|
| 61-66 | Populate an IDF wheelhouse for the project Python 3.12 | **Succeeded.** E066: 31 artifacts, install passed, all IDF imports passed. |
| 67-75 | PlatformIO 6.4 pinned `cryptography<35`; hunted a "cryptography 34.x" wheel | Dead end; no such series exists (3.4.8 then 35.0.0). |
| 70-79 | Acquire and hand-assemble CPython **3.10.11** from official MSIs | Runtime assembled and ran. Still no fixture. |
| 80-84 | IDF deps on 3.10 blocked at `gdbgui` -> `gevent==1.5.0` | Dead end on 3.10. |
| 85-89 | Acquire and hand-assemble CPython **3.8.10** from official MSIs, including read-only `msi.dll` CAB export | Runtime assembled and ran. Still no fixture. |
| 90 | IDF deps on 3.8 blocked at `reedsolo>=1.5.3,<=1.5.4` binary-only | Dead end on 3.8. Session ended BLOCKED_USER. |

### Why it could never have terminated

1. **The Python downgrade created the dependency wall it was trying to climb.**
   ESP-IDF 4.4.7's `requirements.txt`
   (`.piohome/packages/framework-espidf@3.40407.240606/requirements.txt`) gates
   the entire `gdbgui` / `pygdbmi` / `python-socketio` / `jinja2` /
   `itsdangerous` chain behind `python_version < "3.11"`. On Python **3.12**
   those packages are simply **not required**. Moving to 3.10 and then 3.8 to
   "be faithful" is what *pulled in* `gdbgui`, which is what pulled in
   `gevent==1.5.0`, which is what became the blocker of iterations 82-84.
2. **The dependency problem had already been solved 24 iterations earlier.**
   E066 (iteration 66) records a successful full IDF requirements install on
   Python 3.12 with all imports passing. `.ai/wheelhouse_idf_requirements_66/`
   still holds that complete cp312 wheelhouse, `reedsolo-1.5.4.tar.gz` included.
3. **`cryptography<35` was never an ESP-IDF 4.4.7 requirement.** That file asks
   for `cryptography>=2.1.4` with `--only-binary`. The `<35` cap came from the
   PlatformIO platform package selected in iteration 75, and the search then
   looked for a nonexistent "cryptography 34.x".
4. **The real infrastructure fault was never diagnosed.** The project-local IDF
   virtualenv `.piohome/python_env/idf4.4_py3.12_env` is broken because its base
   interpreter is gone: `pyvenv.cfg` points at `C:\Program Files\Python312`,
   which does not exist on this machine. A working CPython 3.12 is installed at
   `C:\Users\Administrator\AppData\Local\Programs\Python\Python312`, and
   Anaconda's Python is on `PATH`. Recreating the venv was never attempted;
   assembling interpreters from MSIs was attempted for 20 iterations.
5. **None of it was necessary.** `QEMU_HANDOFF.md` section 4.

### Artifacts left behind

About **452 MB** across 26 directories in this folder
(`python310*`, `python38*`, `*_msi_*`, `idf_dependency_probe_*`,
`gevent_*`, `gdbgui_*`, `core_recovery_*`), plus ~16 MB of wheelhouses under
the repository-root `.ai/`. They are the output of a closed route and are not
referenced by anything current. **Recommended for deletion**, left in place
here because they were not created by this session.

### Rules this produced

- Test the smallest component that the gate is actually about. If a proposed
  fixture needs a larger software stack than the thing under test, that is a
  signal to redesign the fixture, not to build the stack.
- An "infrastructure blocked" classification is an instruction to change
  approach, not a status to report while continuing.
- When a dependency resolution moves backwards (a newer runtime worked, an
  older one does not), re-read the environment markers before changing runtime.

## OPEN BUT NOT CURRENT ROOT CAUSE

### Intermittent 0xC0000409 / FATAL_APP_EXIT

Direct abort caller was not captured. It did not reproduce after diagnostic
hot-path cleanup. Keep documented and capture if it returns, but do not block
current semantic investigation indefinitely.

### APP CPU R6 state

`stop=0 stopped=0 halted=1 exit_request=1` observed. Candidate only; requires
Good-vs-Bad R6->R9 evidence before semantic change.

### QEMU machine construction cost (~7 s per instance)

Measured 2026-09-03 (E100). Not attributed to a specific initialisation step.
Its proposed link to the historical `ADMISSION_1` timeouts is a **hypothesis**,
not a conclusion.
