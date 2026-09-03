# STATUS - Current authoritative state

Consolidated 2026-09-03. Start at `QEMU_HANDOFF.md`; this file is the detail
behind it and the preserved iteration history.

## Current state in one paragraph

The production VNEXT_B ESP32 integration is functionally complete except for a
small tail of audit gates. The single behavioural gate that had blocked the
work for weeks - `ESP32_MWDT_BEHAVIOR` / `ESP32_MWDT_LOAD_INDEPENDENCE` - is
now PASS at the device level, proven with a framework-free bare-metal fixture
(`vnext_prototype/guest_mwdt_baremetal`, evidence E097-E101). The MWDT model
was never defective; the investigation simply had no guest that could be
trusted not to feed the watchdog.

Through the production Core/VNEXT_B path the gate does **not** yet pass: a fed
guest took a `MWDT_SYS_STAGE` reset at 16 sessions. That run exposed three
unbounded per-operation diagnostic sites producing 99.97% of all QEMU output,
one of them positioned outside the watchdog's compensated pause window so its
host time is charged to the guest's deadline (E102, E103). Guard-only fixes are
applied to the QEMU source but are **unbuilt** - this host has no C toolchain,
which is the single external blocker. See `NEXT_ACTION.md`.

## Facts established 2026-09-03

- Fed bare-metal guest, 16 concurrent QEMU sessions, 180 s, literal
  `WDT_SCALE=1`: **0** MWDT-attributed resets, 0/16 instances.
- Unfed bare-metal guest, same conditions: **82** MWDT resets, 16/16 instances.
- Validity arm sharing the fed code path: **78** resets, 16/16 instances -
  so the fed zero is attributable to feeding, not to guests that never ran.
- Reset routing: TG0 expiry yields `cause0=7` (`ESP32_TG0WDT_SYS_RESET`), TG1
  yields `cause0=8`.
- The opt-in TG/VNEXT traces cost a median **2.2 s per line** and inflate a 1 s
  virtual deadline to 12.7 s. Historical trace-derived timings are void (E099).
- `qemu_init` costs about **7 s per instance** before any guest code runs, with
  process spawn at 0.03 s (E100).
- Through the production Core/VNEXT_B path the gate still **fails**: a fed guest
  took a `MWDT_SYS_STAGE` reset at 16 sessions and none at 1 (E102).
- **99.97%** of all QEMU output in that 16-session run came from three unbounded
  diagnostic sites, one of which sits outside the watchdog's compensated pause
  window. Fixed in source, unbuilt - no C toolchain on this host (E102, E103).

## Corrections to the earlier record

- **`ESP32_MWDT_BEHAVIOR` did not require ESP-IDF.** The premise behind
  iterations 55-90 was wrong. See the postmortem in `CLOSED_HYPOTHESES.md`.
- **E061-E063 timings are instrument artifacts**, not guest behaviour. Their
  functional observations stand; their times do not (E099).
- **`TEST_GATES.md` and `FINAL_CHECKLIST.md` had drifted.** Several gates
  recorded as reviewer-closed in the former were still unticked in the latter.
  Reconciled 2026-09-03 in `FINAL_CHECKLIST.md`.
- **The claim that the unconditional I2C ackERR logging was fixed is false.**
  Recorded under "Fast-fail status" below and in `DECISION-003`, but
  `hw/i2c/esp32_i2c.c:305,508` were still unconditional four weeks later and
  emitted 22,930 lines in a single 60 s 16-session run (E103). Now gated.
- **"No residual hot-path diagnostic I/O" was closed prematurely.** The
  E041-E044 audit covered `[VNEXT_PROBE]` tags in `vnext_b.c` only and missed
  the unconditional `[VNEXT_B]` backpressure writes in the same file and the
  I2C sites above (E102, E103). Re-opened in `FINAL_CHECKLIST.md`.
- **The iteration-90 `NEXT_ACTION` is obsolete.** It asked for a `reedsolo`
  availability probe on a hand-assembled CPython 3.8.10 - the last step of the
  closed route.

## Immediate objective

See `NEXT_ACTION.md`.

---

# Preserved iteration history

Everything below is the original per-iteration record, kept unedited so the
sequence of attempts stays auditable. Iterations 61-90 concern the closed
CPython/ESP-IDF route and produced no watchdog evidence; read the postmortem in
`CLOSED_HYPOTHESES.md` before spending time on them.

## Iteration 90 result - 2026-09-01

The assembled literal CPython 3.8.10 runtime created a fresh project-local
child venv successfully (`Python 3.8`, pip `21.1.1`). The first IDF 4.4.7
download-only probe exposed that pip 21.1.1 does not expand the literal
`file://${IDF_PATH}/...` requirement on Windows; no packages were retained.
The bounded rerun resolved that local path to the existing
`esp-windows-curses` source package and reached official PyPI, downloading
metadata/artifacts for the preceding requirements before stopping at the
first unavailable constraint: `reedsolo>=1.5.3,<=1.5.4`. PyPI exposed only
1.7.0+ for the cp38/win_amd64-compatible query. The wheelhouse remained
empty and no target environment, firmware, QEMU, production, watchdog/reset,
ABI, transport, or Git artifact changed. `ESP32_MWDT_BEHAVIOR` remains open.

## Iteration 89 result - 2026-09-01

The three exact signed CPython 3.8.10 x64 base MSIs were processed with the
dependency-free read-only `msi.dll` procedure into
`orchestrator/.ai/python38_runtime_assembly_89_20260901T074000Z/`. Embedded
`cab1.cab` streams were exported and expanded locally; no MSI action,
installer, PATH/registry/ACL mutation, or dependency install occurred.
The MSI File tables mapped 841 files (core 2, exe 9, lib 830) to unique
assembled paths. A full size/SHA-256 recheck reported zero mismatches.
Literal runtime probes passed: `Python 3.8.10`, `sys/ssl/hashlib/venv/`
`ensurepip` imports, and `pip 21.1.1` from ensurepip. Firmware, QEMU,
production, watchdog/reset, ABI, transport, and Git artifacts remain
unchanged; `ESP32_MWDT_BEHAVIOR` remains open.

## Iteration 88 result - 2026-09-01

Reviewer-approved acquisition of the exact official CPython 3.8.10 x64 base
MSIs completed into `orchestrator/.ai/python38_base_msis_88_20260901T073100Z/`.
`core.msi`, `exe.msi`, and `lib.msi` each returned HTTP 200 from the exact
same-origin `python.org/ftp/python/3.8.10/amd64/` URL, were staged with `.part`
and atomically renamed, and passed Authenticode `Valid` with signer Python
Software Foundation. Read-only MSI identity returned ProductVersion
`3.8.10150.0`, Template `x64;1033`, and distinct ProductCodes for all three.
No CAB export/extraction, MSI action, runtime execution, dependency install,
firmware build, QEMU run, or production/semantic artifact changed.
`ESP32_MWDT_BEHAVIOR` remains open.

## Iteration 80 result - 2026-09-01

The bounded IDF 4.4.7 dependency/bootstrap preflight used the literal
project-local Python 3.10.11 assembly. The active PlatformIO framework is
`.piohome/packages/framework-espidf@3.40407.240606`; its 57-line
`requirements.txt` is readable and includes setuptools, packaging, click,
pyserial, future, cryptography, pyparsing, pyelftools,
idf-component-manager, urllib3, kconfiglib, esptool dependencies, construct,
and the local `esp-windows-curses` source package.

The assembly has bundled `pip-23.0.1` and `setuptools-65.5.0` wheels under
`lib/ensurepip/_bundled`, but no installed `pip` module: literal
`python.exe -m pip --version` returned `No module named pip`. Expected
third-party imports were absent except `packaging`; no compatible wheel/archive
was found under `.piohome/cache`. This is an infrastructure/bootstrap
boundary only; no package was installed, no PATH/registry/system artifact,
firmware, QEMU runtime, production source, watchdog/reset semantic, ABI,
transport, or Git artifact changed. `ESP32_MWDT_BEHAVIOR` remains open.

## Iteration 78 result - 2026-09-01

The reviewer-directed dependency-free MSI read-only diagnostic succeeded for
the validated official `exe.msi`, `lib.msi`, and `pip.msi` payloads. `exe.msi`
hash is `B3A9F745AA598C1773923A45DCC4AA5B4C906F55D5559B568069F74E04CD4808`
and its CAB lists 9 members including `python.exe`. `lib.msi` hash is
`6F16EC2506DD3D0B269EF6D367B97795214DA5F9E1EEC77108122F86D36C59C3`, with
836 File rows/CAB members including the standard library, `venv`, `ensurepip`,
and bundled pip 23.0.1/setuptools 65.5.0. `pip.msi` hash is
`E42F9F0C9DEF8A7B8B142F3F03BBE0C91D9EE2B72041BAB21BF42C9BB00658EF`; it has
one optional-feature component, no File rows, no Media/CAB payload, and only a
`Binary.WixCA` stream. Normalized mappings are in
`orchestrator/.ai/msi_readonly_78_20260901T20260901T002905Z/`. `expand.exe -D`
was used for listing only; no CAB member was extracted and no MSI action ran.
Package Cache, Python uninstall registry, and process/user/machine PATH
snapshots remained equal. Runtime completeness is proven at package-layout
level, but no runtime was assembled or run; `ESP32_MWDT_BEHAVIOR` remains open.

## Iteration 77 result - 2026-09-01

The reviewer-directed dependency-free MSI diagnostic succeeded using the
built-in `msi.dll` read-only database API. The validated `core.msi` hash is
`C5DECE7FB0F13B86A7AC721EF1575992A6A6D076FFAA0B6B6BA7DE120B2E64F4`.
Its Media table references embedded `#cab1.cab`; the stream was exported to a
new project-local disposable directory and measured at 65,536 bytes with
SHA-256 `f6f008a2ca0165cea9ecd086957d911539bd808aa2e092736ecffefe69f4ef22`.
Built-in `expand.exe -D` listed exactly `python.dll` and `python_stable.dll`.
The File table contains only `python3.dll` (66,328 bytes) and
`python310.dll` (4,458,776 bytes), so this core MSI cannot supply a complete
Python runtime. Pre/post Package Cache, Python uninstall registry, and
process/user/machine PATH snapshots were unchanged. No MSI action, Python
installation, firmware build, QEMU run, or semantic artifact changed;
`ESP32_MWDT_BEHAVIOR` remains open.

## Iteration 76 result - 2026-09-01

The reviewer-directed bounded inventory found no pre-existing `lessmsi.exe`,
WiX `dark.exe`, or signed 7-Zip executable (`7z.exe`, `7za.exe`, `7zz.exe`)
in PATH or the inspected local installed-program roots. No extractor was
available, so the validated `core.msi` was not touched. The Python 3.10
runtime remains unavailable; `ESP32_MWDT_BEHAVIOR` remains open and the
non-installing extraction route is exhausted pending review direction.

## Iteration 74 result - 2026-08-31

The reviewer-directed Python 3.12 verified-HTTPS continuation acquired all 21
distinct official Python 3.10.11 x64 MSI payloads plus the already verified
bundle EXE into `.ai/python310_payloads_74`. The complete inventory records
same-origin final URLs, sizes, and SHA-256 values. Re-running the bundle in
project-local `/layout` mode consumed every payload and passed Burn validation
with exit code 0 (`52` planned packages; `Apply complete, result: 0x0`). No MSI
was executed and no installation occurred. The compatible Python runtime is
still absent; `ESP32_MWDT_BEHAVIOR` remains open and the next infrastructure
route requires reviewer direction.

## Iteration 75 result - 2026-09-01

The single reviewer-approved administrative extraction of validated
`core.msi` passed hash/signature validation but `msiexec /a /qn` returned
1603 with MSI error 2502 and extracted zero files. Pre/post snapshots show
no Package Cache, Python uninstall registry, or process/user/machine PATH
mutation. No Python runtime, firmware, QEMU, or semantic artifact changed;
`ESP32_MWDT_BEHAVIOR` remains open and the MSI route requires review.

## Iteration 73 result - 2026-08-31

The reviewer-directed Python 3.10.11 `/layout` experiment used the already
hash- and Authenticode-verified installer and a new project-local destination
with no installation, PATH, registry, ACL, or all-users operation. Burn planned
52 packages in Layout mode and did not fail at Package Cache creation. It
copied only `python-3.10.11-amd64.exe`; acquisition of the first absent payload
`ucrt.msi` failed against the official URL with `0x80072efd`, then
`0x80090305` on retries. Exit code was 773 (`0x305`), and no core/exe/lib/pip
MSI payloads were produced. The Python runtime remains unavailable and
`ESP32_MWDT_BEHAVIOR` remains open. The exact divergence is network payload
acquisition, not the previously measured Package Cache ACL boundary.

## Iteration 72 result - 2026-08-31

The reviewer-directed cache boundary audit found the exact latest Burn bundle
path as `C:\Users\josuemorais\AppData\Local\Package Cache\{a10fbb63-03ff-4b8c-a176-f5fd355f715b}`;
the GUID directory does not exist. `Package Cache` is owned by
`BUILTIN\\Administradores` and grants the current sandbox group only
`ReadAndExecute, Synchronize`; the process identity is
`PC_UFU_Josue\\CodexSandboxOffline` (SID `S-1-5-21-3846247477-1191926843-2878787821-1004`),
not the `PC_UFU_Josue\\josuemorais` principal that has FullControl. A bounded
new-child sentinel failed at directory creation with access denied.
`icacls /verify` passed for `Package Cache`, `Local`, and `AppData`. No ACL,
installer, Python, firmware, QEMU, production, or semantic artifact changed.
`ESP32_MWDT_BEHAVIOR` remains open; ACL repair or extraction requires review.

## Iteration 71 result - 2026-08-31

The validated official Python 3.10.11 x64 installer was executed with a
project-local target, `InstallAllUsers=0`, `PrependPath=0`, and launcher/test
features disabled. The installer returned exit code 5 before installing
Python. Its Burn log records `0x80070005` while creating the per-user bundle
cache under `C:\Users\josuemorais\AppData\Local\Package Cache`, including
when `/nocache` was supplied. The project target contains no `python.exe`.
The artifact remains hash- and Authenticode-valid. No PATH/global mutation,
venv, package install, firmware build, QEMU run, production source/binary, or
watchdog/reset semantic artifact changed. `ESP32_MWDT_BEHAVIOR` remains open.

## Iteration 70 result - 2026-08-31

The reviewed Python 3.12 standard-library urllib path successfully acquired
the exact official Python 3.10.11 x64 installer. The response was HTTP 200
from the approved final URL with Content-Length 29037240; the streamed file
matched the required SHA-256
`D8DEDE5005564B408BA50317108B765ED9C3C510342A598F9FD42681CBE0648B`.
Windows Authenticode reported `Valid`, with signer `Python Software
Foundation`. The artifact was atomically named under
`orchestrator/.ai/python310_staging/python-3.10.11-amd64.exe` and was not
executed. No Python installation, venv, package install, firmware build, QEMU
run, production source/binary, watchdog/reset semantic, ABI, transport, or
Git artifact changed. `ESP32_MWDT_BEHAVIOR` remains open.

## Iteration 69 result - 2026-08-31

The reviewed Python 3.10.11 x64 installation could not begin: the bounded
`Invoke-WebRequest` download failed with an unexpected TLS receive error and
left only a zero-byte staging file; the native `curl.exe` retry failed before
transfer with Schannel `SEC_E_NO_CREDENTIALS (0x8009030e)`. Hash and
Authenticode validation therefore did not run on a valid artifact. No
interpreter, venv, package, firmware build, QEMU run, or production/watchdog
semantic artifact changed. `ESP32_MWDT_BEHAVIOR` remains open.

## Iteration 68 result - 2026-08-31

The bounded interpreter/artifact inventory found only Python 3.12 x64; no
Python 3.10/3.11 executable or compatible local wheel/archive is available.
The official Python 3.10.11 x64 installer was identified for the next reviewed
infrastructure step, with URL and SHA-256 recorded in E076. Nothing was
installed or built, and no QEMU or watchdog conclusion exists.

## Iteration 67 result - 2026-08-31

The pure ESP-IDF fixture reached the official 4.4.7 CMake boundary after
forcing PlatformIO core to local `.piohome` and selecting `espressif32@6.4.0`
with Xtensa 8.4.0. Its builder imports pass, but the dependency check requires
`cryptography<35`; the only host Python is 3.12 and no compatible wheel is
available from official PyPI. Build artifacts and QEMU evidence remain absent.
This is infrastructure only; no production or watchdog/reset semantic change
was made.

## Iteration 63 result - 2026-08-31

The bounded full requirements wheelhouse attempt reached the local
`esp-windows-curses` package and stalled in isolated-build dependency
resolution at PyPI `setuptools` (HTTP 304). The fresh wheelhouse is empty and
the target Python environment remains unchanged with only `pip==24.2`. The
same requirements command with `--no-build-isolation` fails immediately with
`ModuleNotFoundError: No module named 'setuptools'`. The pure ESP-IDF IWDT
fixture remains blocked before build; no QEMU or watchdog conclusion exists.

## Iteration 58 result - 2026-08-31

The pure ESP-IDF IWDT fixture was created at `vnext_prototype/guest_iwdt_espidf`
with the official-IDF contract and separate control/starvation modes. Build
proof is blocked: PlatformIO attempted to install missing
`toolchain-xtensa-esp-elf 14.2.0+20251107` and failed unpacking with
`Errno 28 No space left on device`. Direct IDF Python verification also found
missing requirements including `click`, `cryptography`, `pyparsing`,
`idf-component-manager`, `urllib3<2`, `pygdbmi`, `reedsolo`, `bitstring`,
`ecdsa`, and `construct`. No generated sdkconfig/header/map/ELF/image exists
beyond a checksum stub, and no QEMU run occurred. This is infrastructure
evidence only; no production or semantic watchdog change was made.

## Iteration 60 result - 2026-08-31

The read-only capacity/toolchain/Python preflight found 11.569 GB free on C:
(`System.IO.DriveInfo`); CIM/fsutil disk queries are denied in this sandbox.
The project-local `.piohome` already contains ESP-IDF 4.4.7 and the compatible
`toolchain-xtensa-esp32` 8.4.0+2021r2-patch5, including a working
`xtensa-esp32-elf-gcc.exe`. The project-local IDF Python environment is Python
3.12.5 but contains only pip; required IDF imports are absent. The global
PlatformIO Python environment is not a substitute and lacks most required IDF
packages. Read-only cache sizing identified approximately 0.623 GB in
`.piohome/cache`, 1.060 GB in the historical diagnostic `.piohome/.cache`,
0.052 GB in the user PlatformIO cache, and 0.084 GB in pip cache. No files were
deleted, installed, built, or executed beyond version/import probes; no QEMU or
watchdog evidence was produced.

## Iteration 57 result - 2026-08-31

The project-local IDF environment repair advanced the mixed fixture through
Kconfig, but that path is superseded by the deep-review handoff: it is not the
official ESP-IDF IWDT oracle. Generated config showed `CONFIG_ESP_INT_WDT` off,
then Arduino rejected `CONFIG_FREERTOS_HZ=100` before compile/link. No ELF,
map, image, or QEMU session exists. The next action is the pure ESP-IDF IWDT
fixture required by `MWDT_DEEP_REVIEW_PLAN.md`; no production or QEMU semantic
change was made.

## Iteration 56 result - 2026-08-31

The reviewer-selected ESP-IDF interrupt-WDT-disabled fixture was configured by
adding `framework = arduino, espidf` and `sdkconfig.defaults` with
`CONFIG_ESP_INT_WDT=n` and `CONFIG_ESP_INT_WDT_CHECK_CPU1=n`. The first build
failed because PlatformIO tried to create its IDF venv under the non-writable
user PlatformIO directory. A second attempt redirected `PLATFORMIO_CORE_DIR`
to the writable project cache, installed the missing ESP-IDF/tool packages,
and stalled during IDF Python dependency installation; it was stopped after
repeated bounded polls. No generated sdkconfig, map, valid fixture image, or
QEMU session exists from this attempt. `ESP32_MWDT_BEHAVIOR` remains open and
no QEMU or production semantic change was made.

## Iteration 55 result - 2026-08-31

The guest-only TG1 isolation attempt was inconclusive. The fixture already disables Arduino task/core watchdog subscriptions; the attempted correction changed stage 0 to `OFF`, moved one-time programming to the first loop after 2 s, and reduced holds to 50/100. The guest build passed with merged image SHA `80D21D1FBEB8002D8135266DC39A682F0A33ECB2C8CDBA85084C70055D394527`. The bounded 12 s canonical run stopped cleanly, but no fixture-specific TG1 configuration appeared; framework TG1 activity remained (21 configs, 1 feed, stage-0/mode-1 expiry), with no `MWDT_CPU_STAGE` or `MWDT_SYS_STAGE`. No root cause or QEMU watchdog/reset semantic change is declared. Reviewer decision is required for the next guest isolation method.

## Iteration 54 result - 2026-08-31

Reviewer-authorized TG1-only watchdog diagnostics were added at the existing config/feed/arm/expiry observation sites under `LASECSIMUL_TG1_WDT_TRACE`. QEMU build passed (981/981), canonical SHA is `427888AD4E50B7DDB2B98E03037675BB43FB6A13275397D432B6485C1401DE09`, and the guest fixture build passed with merged image SHA `86C40759AF69A04588EECA5AFF64A96F46D64F5269C40EF179C113428F02D394`. One bounded 12 s run exited cleanly with no residual QEMU. TG1 produced 22 config, 1 feed, 4 arm, and 1 expiry records. Expiry was stage 0/mode 1; no `MWDT_CPU_STAGE`, `MWDT_SYS_STAGE`, or stage-1 CPU reset attribution appeared. Framework activity reconfigured TG1 after arm, so the no-feed path remains unclassified. No root cause or watchdog/reset semantic change is declared.

## Iteration 53 result - 2026-08-31

The reviewer-authorized TG1 guest-only MWDT fixture built successfully and one bounded canonical-QEMU session stopped cleanly. The run produced no TG1, MWDT_CPU_STAGE, or MWDT_SYS_STAGE marker; retained output showed only expected APP-CPU startup reset plus unrelated TG0 Arduino framework activity. Existing QEMU watchdog diagnostics are TG0-only, so this run cannot establish TG1 feed, stage expiry, or APP-CPU/CPU1 routing. `ESP32_MWDT_BEHAVIOR` remains open and review is required to select the next diagnostic observation path. Canonical QEMU SHA remains `4B5CA32823DD7B0049DB63BB46B42C695F6A5D922EB402DF0633D46AF2809B82`.

## Iteration 51 result - 2026-08-31

The bounded source/test audit found no existing diagnostic target that can
observe TG0 stage-1 expiry or APP-CPU reset routing on a no-feed path without
changing firmware, watchdog/reset semantics, or adding instrumentation. The
existing Release diagnostic only exercises the continuously fed success path.
QEMU source does expose the relevant transitions: `esp32_timg_wdt_cb()` logs
the current stage/mode, pulses CPU/SYS reset outputs, and advances stages;
`esp32_timg_cpu_reset()` labels the source `MWDT_CPU_STAGE` and routes `n==1`
through `async_run_on_cpu(CPU(&s->cpu[1]), ...)`; `esp32_timg_sys_reset()` sets
both reset causes and requests a guest reset. Canonical runtime SHA remains
`4B5CA32823DD7B0049DB63BB46B42C695F6A5D922EB402DF0633D46AF2809B82`.
`ESP32_MWDT_BEHAVIOR` remains open; no source/build/runtime semantic change.

## Iteration 50 result - 2026-08-31

The existing bounded Release one-session diagnostic ran for 6 s with the
canonical QEMU, `runtime_inputs/mwdt_behavior/merged.bin`, and effective TG0
reset/feed traces. It exited 0 with 84 submissions and 84 completions, zero
semantic failure counts, and a retained 1,178,824-byte log. The trace captured
framework TG0 CONFIG0 transitions, about 3,005 feed events, and about 3,017
arm events, with no TG0 expiry, MWDT CPU-stage reset, or unexpected reset.
This classifies framework TG0 activity in the simulator but not reset routing,
CPU1 scope, or a production root cause; `ESP32_MWDT_BEHAVIOR` remains open.
No semantic source change was made.

## Iteration 49 result - 2026-08-31

The corrected six-second canonical low-volume trace passed with 848/848
submissions/completions and no loss, misroute, overwrite, or deadlock. Startup
reset markers and 3392 CPU1 `MWDT_PAUSE ignored` records were retained; no TG0
feed/config/arm/expiry/accounting or `MWDT_CPU_STAGE` marker appeared. The
first invocation used ineffective unprefixed names; source audit identified the
effective prefixed names and the experiment was repeated. No semantic change.

The follow-up boot/configuration audit found no explicit TG0 WDT CONFIG0/FEED
access in `guest_i2c_workload/src/main.cpp`; watchdog symbols in the ELF map are
generic framework support only. E057 keeps the no-feed observation
non-classifying.

## Iteration 48 result - 2026-08-31

The 3 s bounded low-volume diagnostic retained startup/reset markers but ended
before workload progress: QEMU was running with zero submissions/completions.
It captured the initial `source=OTHER` reset and the expected app-CPU startup
reset (`source=SW_CPU_RESET_REGISTER`, `expected=app-cpu-startup`) with R2/R4/R6
markers. No TG0 feed, expiry/accounting, or `MWDT_CPU_STAGE` marker appeared.
`ESP32_MWDT_BEHAVIOR` remains open; no semantic change was made.

## Iteration 41 result - 2026-08-31

Read-only comparison established that QEMU argv/controller construction is
shared by the historical I2C workload and staged GPIO-debug image. The images
are not equivalent workloads: the historical image starts explicit Wire I2C,
while the staged image reaches I2C through SSD1306 display initialization and
update after boot. E048 records the source proof. The 3 s result is compatible
with this path; 10 s remains unresolved. No root cause or semantic change.

Bootstrap date: 2026-08-31

## Iteration 47 result - 2026-08-31

The approved test-only success-path dump was added behind
`LASECSIMUL_DUMP_SUCCESS_QEMU_LOG`; it reads the existing bounded
`qemuLogs()` buffer before normal teardown and is disabled unless explicitly
requested. The canonical one-session Release run used 20 s, I2C trace off,
`APP_CPU_RESET_TRACE=1`, and `TG0_WDT_FEED_TRACE=1`. It passed with 3,631
submissions and 3,631 completions, zero loss/misroute/overwrite/deadlock.
The retained 956,792-byte child-log window began around virtual 8.114 s and
contained 9,395 `MWDT_PAUSE ignored cpu=1` records, but no retained
`TG0WDT EXPIRE`, `TG0_FIRST_RESET_ACCOUNTING`, APP-CPU reset, or reset-source
marker. Because the bounded window starts after boot, marker absence is not
evidence of absence before the window; MWDT behavior remains open. No QEMU,
watchdog/reset, ABI, transport, or production semantic change was made.

## Iteration 46 result - 2026-08-31

E053 ran the existing low-volume normal one-session path with I2C trace off
and APP-CPU/TG0 traces on. It passed 288/288 with no loss, misroute,
overwrite, or deadlock, but successful normal mode does not expose child
qemuLogs(), so no reset/MWDT markers were retained. `ESP32_MWDT_BEHAVIOR`
remains open; a diagnostic-only retention decision requires review.

## Iteration 43 result - 2026-08-31

E050 completed the bounded read-only Good-vs-Bad source audit. The staged
GPIO-debug image reaches I2C only through SSD1306 initialization and a later
1024-byte framebuffer update, while the historical workload starts Wire at
100 kHz and submits a short write immediately. QEMU's existing I2C trace sites
require guest MMIO command submission, and existing reset traces distinguish
normal APP-CPU startup from `MWDT_CPU_STAGE`. E049 remains pre-workload
evidence; `ESP32_MWDT_BEHAVIOR` stays open with no semantic change.

## Iteration 32 result

The bounded certificate trust-path diagnosis found no clock, proxy, or explicit
CA override problem. Default Node TLS validates the presented Google Trust
Services/GlobalSign chain, but the authenticated delegated `codex exec` still
fails before execution with `UnknownIssuer` on WebSocket and HTTPS fallback.
No source, build, binary, runtime, manifest, or Git change occurred. The
VNEXT trace/hot-path gate remains open pending reviewer/orchestrator resolution
of the Codex trust/dispatch path.

## Iteration 29 result

The canonical QEMU source was re-inspected after reviewer-directed re-rooting.
The approved guard-only VNEXT_PROBE patch remains unapplied because this
executor session cannot write outside `C:\SourceCode\LasecSimul`. No build,
runtime launch, binary refresh, or semantic change occurred. The trace/hot-path
gate remains open and requires a writable canonical task.

## Iteration 19 result

Work closed `VNEXT_PRODUCTION_TCG_CONFIGURATION` from E025. The smallest
final ABI alignment audit found no concrete mismatch between the shared Core
ABI and the QEMU vNext-B field mirror; no build or semantic change was made.
The ABI gate is audited and awaits reviewer closure. No root cause is declared.

## Current open problem

`PRODUCTION_SESSION_FAILURE_ISOLATION` is CLOSED from E019 after reviewer
approval. No root cause is declared and no frozen architecture or timeout
behavior was changed. The next open gate is final ABI alignment, pending
reviewer closure after the iteration-19 audit.

Latest valid dual-purpose run:

```text
VNEXT_HOT_PATH_UNCONDITIONAL_LOGGING = 0
ENV_TB_SIZE = 64
QEMU_ARG_TB_SIZE = 64

ADMISSION = 12/12 PASS
SETUP_QUALIFICATION = PASS

VICTIM_KILL = PASS
victim PID = 28344
victim executionId = 11568953154194306969
reclaim = 12 -> 11 PASS

FIRST_FATAL_PROCESS = NONE
FAST_FAIL_DUMP_CAPTURED = NOT APPLICABLE
```

The run then remained in `SURVIVORS_POST_KILL` for roughly one minute with all 11 survivor QEMU processes still alive.

No valid Good-vs-Bad R0→R10 comparison was obtained.

## Iteration 8 bounded admission rerun

The planned 10-session comparison did not reach victim kill or
`SURVIVORS_POST_KILL`: it timed out at `ADMISSION_1` with exit code 1.
`ADMISSION_FAILURE_DIAGNOSTIC` recorded `firmware_running=true`,
`submissions=0`, `completions=0`, and `start_error=none` for QEMU PID 12664.
The bounded QEMU log tail contained repeated `esp32_i2c_event ackERR` lines and
SW_CPU_RESET reset records. A repeated one-session baseline also timed out at
`ADMISSION_1` with the same counters (`firmware_running=true`, zero
submissions/completions, `start_error=none`) for QEMU PID 20348. No harness or
QEMU process remained after either run.

This is admission-time evidence only; it does not classify post-kill
survivors. Source audit additionally found unconditional `printf/fflush` at
`qemu_lasecSimul/hw/i2c/esp32_i2c.c` in the `ackERR` paths. Its relationship to
the functional NACK behavior and to the current staged binary is unresolved;
no root cause or production fix is declared.

## Resource snapshot during stalled phase

```text
physical RAM free ≈ 322 MiB
aggregate QEMU private bytes ≈ 2.25 GiB
aggregate QEMU working set ≈ 988 MiB
aggregate QEMU handles = 10,408
aggregate QEMU threads = 74
```

Classification:

`HOST_RESOURCE_EXHAUSTION_EVIDENCE = INCONCLUSIVE`

Do not call this OOM without commit/page/resource evidence.

## Fast-fail status

Historical intermittent:

```text
0xC0000409
subcode 7
FAST_FAIL_CLASS = FATAL_APP_EXIT
```

Direct abort/terminate caller was never captured. It did NOT reproduce in the latest valid run.

Residual unconditional I2C stderr logging was fixed so it executes only when `LASECSIMUL_VNEXT_TRACE` is active.

Correct statement: residual hot diagnostic output was inappropriate and removed; timing/resource contribution was possible; direct causality with the FATAL_APP_EXIT was not proven.

## Current guest restart facts

Source/runtime established:

```text
CPU0
PC 0x40083e7a
soc_ll_reset_core()
→ RTC_CNTL_OPTIONS0.SW_APPCPU_RESET
→ APP CPU reset mask 0x02
→ CPU0 software reset mask 0x01
→ next CPU0 boot epoch
```

The same low-level APP CPU reset operation occurs in healthy and unhealthy sessions.

`SW_APP_CPU_RESET_REQUEST = SECONDARY_BOOT/RESTART_BEHAVIOR`

Do not suppress it.

Previously observed APP CPU R6 candidate state:

```text
CPU1:
stop=0
stopped=0
halted=1
exit_request=1
```

This is NOT a proven defect without Good-vs-Bad evidence.

## Frozen

```text
MWDT_COMPENSABLE_TIME_SET = CPU0_ONLY
CPU1 MWDT compensation = disabled
dispatcher = unchanged
ABI = unchanged
backpressure = unchanged
```

## Immediate objective

Before adding more QEMU reset instrumentation, determine whether `SURVIVORS_POST_KILL` waits because:

1. one or more survivor guests truly stop making semantic progress;
2. survivor guests progress but harness observation/predicate does not complete;
3. post-kill host/resource pressure causes severe latency;
4. victim/harness output/process resources are not reclaimed.

## Iteration 7 build and baseline result

The existing `core/build` Visual Studio tree successfully rebuilt the Release
target `vnext_b_production_scale_test.exe` on 2026-08-31. Eigen was already
available in `core/build/_deps`, and the target linked successfully.

The requested one-session baseline was attempted with failure-isolation mode,
but the executable returned `SKIPPED` before creating any session because the
required external environment inputs were absent:

```text
LASECSIMUL_TEST_FIRMWARE = unset
LASECSIMUL_TEST_QEMU_BINARY = unset
```

The workspace contains the development QEMU binary, but no test firmware
(`merged.bin`/equivalent) is present. No admission, QEMU, survivor, or resource
evidence was produced in this iteration.

Use low-frequency harness-side observability and existing semantic counters first.

## Iteration 5 source/runtime result

Source trace completed for `SURVIVORS_POST_KILL`:

```text
SUCCESS_PREDICATE = every i != victimIndex has completion_count > beforeCompletions[i]
WAIT_PREDICATE = !allSurvivorsProgressed, sampled every 20 ms
TIMEOUT_SOURCE = postKillStart + 300 seconds
HARNESS_MAIN_WAIT_LOCATION = core/test/core/mcu/VnextBProductionScaleTest.cpp:463-489
```

The wait itself does not call `qemuLogs()`, join a reader, wait on a process
handle, or acquire a teardown mutex. Victim teardown happens before this phase;
`VnextBAttachment::stop()` unregisters the wait token and calls
`QemuProcessManager::stop()`. Windows reap is bounded to 3 s plus a 1 s retry;
the pipe reader is continuous and the log buffer is bounded.

The 10-session diagnostic attempt did not reach victim kill. It reached
`ADMISSION_10` and terminated with process exit code `-1073740791`
(`0xC0000409`, FATAL_APP_EXIT). No QEMU process remained afterward. This
reproduces the historical fast-fail class but does not identify its caller or
establish causality with `SURVIVORS_POST_KILL`.

Iteration 6 bounded reproductions did not reach victim kill:

```text
10 sessions: TIMEOUT_PHASE = ADMISSION_1 after 120 s
1 session:  TIMEOUT_PHASE = ADMISSION_1 after 120 s
harness exit: 1
QEMU/harness residual processes after each run: none observed
```

The timeout path now has a bounded diagnostic for the affected session (PID,
firmware-running state, submission/completion counters, start error, and the
last 2000 bytes of the QEMU log), but the rebuilt executable was not produced.
The incremental build was blocked when CMake reran and failed populating Eigen:
`CMake step for eigen failed: no such file or directory`.

## Current reviewer-action result

The missing external inputs are now configured for the valid development
runtime:

```text
LASECSIMUL_TEST_FIRMWARE=C:\SourceCode\LasecSimul\vnext_prototype\guest_i2c_workload\.pio\build\esp32\merged.bin
LASECSIMUL_TEST_QEMU_BINARY=C:\SourceCode\LasecSimul\vnext_prototype\dev_qemu_runtime\qemu-system-xtensa.exe
LASECSIMUL_MCU_TRANSPORT=VNEXT_B
LASECSIMUL_QEMU_TB_SIZE=64
```

The raw `build-ucrt64` executable was verified to require its adjacent DLLs
and returned `0xC0000135` when launched alone. It is not the standalone test
runtime. The `dev_qemu_runtime` copy is the canonical executable for these
tests.

The Release harness rebuilt successfully. The one-session baseline then
passed end-to-end:

```text
ADMISSION_1 PASS
SETUP_QUALIFICATION PASS
VICTIM_KILL PASS
FAILED_SESSION_RESOURCES_RECLAIMED PASS
FAILED_SLOT_REUSE PASS
SAME_DISPATCHER_INSTANCE_FOR_A_AND_A2 PASS
REPLACEMENT_SESSION_PROGRESS PASS
SURVIVORS_PROGRESS_DURING_REPLACEMENT PASS
STALE_A_EFFECT_ON_A2=0
PRODUCTION_SESSION_FAILURE_ISOLATION PASS
```

The prior 10/12-session survivor diagnosis remains valid and open; this
one-session result does not close `PRODUCTION_SESSION_FAILURE_ISOLATION`.
The earlier note that `.ai/DECISIONS.md` was absent is historical and is now
superseded by the provenance decisions recorded in that file. No commit, push,
reset, or clean was performed.

## Iteration 9 result - 2026-08-31

Read-only reconciliation confirmed the staged QEMU contains the source ackERR
paths and matches the build hash. A one-session trace baseline and the
follow-up 10-session diagnostic passed: 10/10 admission, 9/9 survivor
progress after victim reclaim, replacement progress, dispatcher reuse, and
stale-effect checks. `logic.i2c_ram` was identified as the intentional
electrical-fallback component. Final 16-session validation remains open; no
root cause or semantic production change is declared.

## E013 — Provenance and continuity audit — 2026-08-31

Confirmed from source and filesystem:

- QEMU repository `C:\SourceCode\qemu_lasecSimul`, branch `main`, HEAD
  `9dc30419a5372756b555ad7926563dcda2215c79`, upstream parity `0/0`; source
  worktree dirty with pre-existing source and build-output changes.
- Build: Meson/Ninja UCRT64, Windows, `CONFIG_WIN32=y`, TCG enabled,
  `xtensa-softmmu`, GCC 16.1.0, binutils 2.46.1.
- Build and staged canonical runtime SHA-256 are both
  `58ED43B801E75D87C0B92EEE1ED4AE3A3C6D1C2178D5D893A40EAE0609F459D4`.
- Raw build launch without DLL staging returned `0xC0000135`; staged runtime
  is the valid launch path. Historical rollback hash remains
  `471AE54193CC7A86F6A448D53BC1E810F5B50D6EBAD1FE48FC34AA04F56F74CE`.

The current executable is `LIKELY_CURRENT_WORKTREE`: build/runtime identity is
measured, but the dirty worktree prevents clean-commit provenance. No commit,
push, reset, checkout, clean, or production source change was performed by
this audit. One-session baseline remains PASS; 10-session diagnosis remains
open with semantic progress `7/9` and blocker set `{1,3}`.

## Iteration 10 result - 2026-08-31

The final 16-session invocation admitted 10 sessions, then timed out at
ADMISSION_11 before victim kill. The affected QEMU was alive with zero
submissions/completions and no start error; its bounded tail showed repeated
final-credit blocked/resumed-local messages and an RTC reset (count=6,
boot_epoch=3). No processes remained. The survivor gate remains open and no
root cause is declared.

## Iteration 11 result - 2026-08-31

The bounded 10-session repeat passed end-to-end with the canonical runtime:
10/10 admission in 163382 ms, victim reclaim 10->9,
`SURVIVORS_POST_KILL=9/9` in 41411 ms, replacement/dispatcher/stale-effect
checks PASS, and final `PRODUCTION_SESSION_FAILURE_ISOLATION PASS`. T+5/T+15/
T+30 snapshots showed temporary progress skew (7/9 then 8/9) but eventual
completion. No processes remained. The final 16-session gate remains open;
no root cause or semantic production change is declared.

## Iteration 12 result - 2026-08-31

The final 16-session canonical failure-isolation topology passed with exit code
0 and no residual harness/QEMU processes. Admission passed 16/16 in 278084 ms.
Victim session 10 was detected and reclaimed (16 -> 15). All 15 survivors
completed `SURVIVORS_POST_KILL` in 61532 ms. Replacement progress, slot reuse,
same-dispatcher identity, survivor continuity during replacement, stale-effect
checks, and final accounting all passed. Snapshots showed 10/15 at T+5s,
11/15 at T+15s, and 12/15 at T+30s before eventual 15/15 completion. This is
measured progress/latency evidence; no root cause or semantic production change
is declared. Gate closure was approved by the reviewer; architecture remains
frozen.

## Iteration 13 reviewer disposition - 2026-08-31

The Work reviewer approved closure of `PRODUCTION_SESSION_FAILURE_ISOLATION`
from E019. The canonical 16-session run passed all required admission, victim,
reclaim, survivor, replacement, stale-effect, accounting, cleanup, and exit
checks. Transient progress skew resolved within the existing completion barrier
and does not establish a deadlock or justify a semantic fix. Architecture and
timeout behavior remain frozen.

## Iteration 14 result - 2026-08-31

The corrected canonical production combined-workload invocation passed with
exit code 0 and no residual processes. The first invocation was discarded as
a setup mismatch because it used the wrong transport environment variable and
stopped at ADMISSION_1 with zero counters.

The valid retry admitted 16/16 sessions in 126656 ms, detected and reclaimed
the victim (16 -> 15), and reached `SURVIVORS_POST_KILL=15/15` in 12831 ms.
Replacement/A2 progress, slot reuse, same dispatcher, survivor continuity,
stale-effect checks, final accounting, and cleanup all passed. A T+5s snapshot
temporarily showed 14/15 progress, which resolved within the existing barrier;
no root cause is declared. Reviewer approval in iteration 15 closed
`PRODUCTION_COMBINED_WORKLOAD`; architecture and timeout behavior remain
frozen.

## Iteration 15 result - 2026-08-31

The reviewer approved closure of `PRODUCTION_COMBINED_WORKLOAD` from E021.
The smallest existing shared-dispatcher runtime validation used two concurrent
VNEXT_B sessions with the canonical staged QEMU and Release harness. Exit code
was 0: both admissions passed (first progress at 7855 ms and 16997 ms), the
victim was reclaimed, the survivor completed, the failed slot was reused, the
same dispatcher instance was retained, replacement progress and survivor
continuity passed, and both stale-effect checks were 0. No residual processes
remained after cleanup. A prior 3-second active-scale attempt was setup-window
insufficient (`submissions=0`) and is not gate evidence; its test-created
processes were explicitly cleaned. No production semantic change was made.

## Iteration 16 result - 2026-08-31

Repeated the smallest shared-dispatcher fairness validation with two
concurrent VNEXT_B sessions. The canonical QEMU hash matched the manifest and
the Release harness exited 0. Admissions passed 2/2, reclaim passed 2 -> 1,
survivor progress completed, replacement and failed-slot reuse passed, the
same dispatcher instance was retained, continuity passed, stale-effect checks
were zero, and final accounting passed. No residual test processes remained.
No production semantic change was made.

The next open gate is `FINAL_RESOURCE_ACCOUNTING`; architecture, timeout,
dispatcher, and transport semantics remain frozen.

## Iteration 17 result - 2026-08-31

The smallest existing final resource-accounting runner was audited and run:
`vnext_prototype/run_foundation_tests.ps1`, using the UCRT64 toolchain. Exit
code was 0 and the captured bounded log contains PASS for all foundation and
remaining-gate checks, including `FINAL_RESOURCE_ACCOUNTING PASS` and
`VNEXT FOUNDATION PROTOTYPE PASS`. No QEMU runtime was launched, no source or
semantic architecture changed, and the next open gate is
`VNEXT_PRODUCTION_TCG_CONFIGURATION`.

## Iteration 18 result - 2026-08-31

The TCG configuration audit found no separately named runner; the smallest
existing direct validation is `core/build/Debug/esp32_adapter_test.exe`.
It exited 0 and passed the default MTTCG (`tcg,thread=multi`) assertion, the
absence of `-icount` in the default launch, and the explicit deterministic
fallback assertions. Source proof remains in `core/test/core/mcu/Esp32AdapterTest.cpp`
and `core/src/mcu/McuController.cpp`; production logs show numeric
`tb-size=64` with `tcg,thread=multi`. The canonical QEMU SHA matched the
manifest. Captured output is `vnext_prototype/iteration18_vnext_production_tcg_configuration.log`.
No source, binary, transport, scheduler, ABI, or architecture change was made.

## Iteration 20 result - 2026-08-31

Applied reviewer-approved closure of `FINAL ABI ALIGNMENT` from E026 without
changing source or transport semantics. E027 source audit proves virtual-time/
APB-based MWDT accounting and CPU0/TG0-only transport pause compensation;
CPU1 calls are ignored. No dedicated load/behavior runner was found, so the
MWDT gates remain open and no root cause is declared.

## Iteration 21 result - 2026-08-31

The smallest existing real-QEMU controller check exposed a setup mismatch:
the Debug Core harness negotiated arena ABI v4 while canonical QEMU reported
an incompatible ABI v5 descriptor. The result is not admissible MWDT behavior
evidence; no watchdog/reset conclusion or semantic change is made. The
test-created harness was cleaned and no QEMU process remained.

## Iteration 22 result - 2026-08-31

Ran the existing Release vNext-B production-scale runner as the smallest
compatible MWDT diagnostic. The canonical QEMU run with two sessions and
explicit WDT scale 1 exited 0: admission, reclaim, survivor/replacement
progress, dispatcher reuse, continuity, stale checks, and cleanup passed. No
TG0 feed records were emitted; reset lines were cold-start and
SW_CPU_RESET_REGISTER only, with no MWDT-attributed expiry. E029 is partial
runtime evidence, so both ESP32 MWDT gates remain open and no semantic change
was made.
## Iteration 23 result - 2026-08-31

The read-only legacy dependency audit is source-proven PASS. Core selects
VNEXT_B explicitly and does not open the legacy arena in that path; QEMU uses
vNext-B register dispatch when active and the legacy arena only otherwise.
Legacy-looking peripheral hooks are shared MMIO plumbing, not independent
transports. The support matrix has no `NEEDS_VNEXT_MIGRATION` row and keeps
local, unsupported, and limited peripherals explicit. No source, binary, ABI,
transport, watchdog, reset, or Git change was made. Gate closure is pending
reviewer approval.

## Iteration 24 result - 2026-08-31

The ESP32 support matrix audit is source-proven PASS. Every declared capability
has an explicit classification, the modeled vNext peripherals match the ESP32
SoC composition, and unsupported/limited capabilities remain explicitly bounded.
No `NEEDS_VNEXT_MIGRATION` row exists. I2C vNext binding is present for both
controllers; I2S is explicitly unimplemented and no DAC/TWAI/DMA device was
composed. No source, binary, ABI, transport, watchdog, reset, or Git change was
made. Gate closure is pending reviewer approval.

## Iteration 25 result - 2026-08-31

Applied reviewer-approved closure of `ESP32_SUPPORT_MATRIX_AUDIT` from E031.
The next read-only audit found that `LASECSIMUL_VNEXT_TRACE` is opt-in, but
`vnext_b_gpio_write()` still performs unconditional `[VNEXT_PROBE]` stderr
writes and flushes on MMIO activity. This leaves the VNEXT trace/hot-path
diagnostic-I/O gate open. No source, binary, transport, watchdog, reset, ABI,
Git, or rollback artifact changed.

## Iteration 26 result - 2026-08-31

The bounded source audit confirmed that all `[VNEXT_PROBE]` output is
diagnostic-only and has no semantic consumer. The MMIO and startup probe sites
bypass the existing `LASECSIMUL_VNEXT_TRACE` opt-in, while the counter remains
bounded. The next correction is a guard-only diagnostic-I/O cleanup using that
helper; frozen transport, watchdog/reset, ABI, dispatcher, and backpressure
semantics remain untouched. No source or binary was edited.

## Iteration 27 result - 2026-08-31

The planned guard-only VNEXT probe cleanup could not be applied because the
canonical QEMU source repository is outside the executor's writable sandbox.
The approved patch tool rejected the write before modifying any file. No build
or runtime check was run; the source, binary, architecture, Git history, and
rollback artifact remain unchanged. The trace/hot-path gate stays open and a
compact review packet records the exact environment boundary.

## Iteration 28 result - 2026-08-31

The canonical-source boundary was rechecked after the reviewer handoff. The
exact guard-only patch remains unapplied because this executor's patch tool
rejects writes to `C:\SourceCode\qemu_lasecSimul` outside the writable project
root. No shell-write workaround was used; no build or runtime check ran. The
trace/hot-path gate remains open pending a task re-rooted at the canonical QEMU
repository.

## Iteration 30 result - 2026-08-31

The reviewer-directed delegated Codex task was launched with the canonical
QEMU repository as its root, but failed before task execution while connecting
to the API (`invalid peer certificate: UnknownIssuer`). No patch, build,
staging, runtime check, source, binary, manifest, architecture, or Git change
resulted. The VNEXT trace/hot-path gate remains open and the exact guard-only
cleanup is still pending a functioning canonical-root dispatch mechanism.

## Iteration 31 result - 2026-08-31

The canonical-root delegated retry failed before execution with the same
certificate-trust error (`invalid peer certificate: UnknownIssuer`) on
WebSocket and HTTPS fallback. No source, build, staged runtime, manifest, or
test output changed. E038 records the retryable infrastructure failure; the
VNEXT trace/hot-path gate remains open and review is required.

## Iteration 33 result - 2026-08-31

The canonical runtime manifest and source state were revalidated. The staged
runtime identity remains SHA-256
58ED43B801E75D87C0B92EEE1ED4AE3A3C6D1C2178D5D893A40EAE0609F459D, and the
canonical source still contains the unconditional VNEXT_PROBE sites identified
by E032/E033. One bounded authenticated canonical-root app task was dispatched
for the approved guard-only patch/build/trace verification; it had not returned
by turn end. No QEMU source, binary, runtime manifest, architecture, or Git
change was made. The VNEXT trace/hot-path gate remains open.

## Iteration 33 final result - 2026-08-31

Authenticated canonical-root app task reached the source audit but its approved
patch write was rejected by filesystem policy. It found 10 VNEXT_PROBE sites and
pre-patch SHA-256 cf94ed1eda9e32baddf70f804ef3a19893b0c20bdfcd45bb8257bfe8ddf54c35.
No build, trace check, manifest refresh, QEMU, architecture, or Git change.
The gate remains open pending reviewer resolution of the write boundary.

## Iteration 35 result - 2026-08-31

The canonical write boundary became available. The exact diagnostic-only
`vnext_trace_enabled()` guards were applied to all ten `[VNEXT_PROBE]` sites,
the canonical UCRT64 xtensa-softmmu target built successfully, and the staged
runtime was refreshed with matching SHA-256
`4B5CA32823DD7B0049DB63BB46B42C695F6A5D922EB402DF0633D46AF2809B82`.
A bounded one-session production check passed with trace disabled (52/52,
zero stderr and zero probes) and with trace enabled (51/51, PASS). The
aggregate harness did not expose QEMU startup probes in the trace-enabled log,
so the diagnostic-I/O gate is not closed; reviewer disposition is required.
No frozen runtime semantics changed.
No frozen runtime semantics changed.

## Iteration 36 result - 2026-08-31

The trace-enabled one-session attempt used canonical QEMU and stderr capture but hit intermittent admission failure before workload progress (exit 1, zero submissions/completions, no functional PASS, zero VNEXT_PROBE lines). QEMU startup/reset output was captured; the staged SHA stayed `4B5CA32823DD7B0049DB63BB46B42C695F6A5D922EB402DF0633D46AF2809B82`. No root cause is inferred and the VNEXT trace gate remains open.

## Iteration 37 result - 2026-08-31

The bounded canonical one-session retry with `LASECSIMUL_VNEXT_TRACE=1`
completed successfully: exit 0, `PRODUCTION_SCALE_1_ACTIVE PASS`, 982/982
submissions/completions, and all reported semantic counters zero. The staged
QEMU SHA remained `4B5CA32823DD7B0049DB63BB46B42C695F6A5D922EB402DF0633D46AF2809B82`,
and no test-created process remained. Literal inspection of the separately
captured stdout/stderr found zero `[VNEXT_PROBE]` lines, so the opt-in probe
retention predicate was not observed and the VNEXT trace/hot-path gate remains
open. No root cause or frozen semantic change is declared.

## Iteration 38 result - 2026-08-31

Reviewer-approved closure of `VNEXT_TRACE / HOT-PATH DIAGNOSTIC I/O` was
applied from E041-E043 and historical direct-QEMU probe evidence. The first
bounded attempt to advance `ESP32_MWDT_BEHAVIOR` was blocked at setup because
the child QEMU process received Windows `Acesso negado` opening the existing
external merged firmware. This yielded no MWDT or workload evidence; no
semantic change was made. Review is requested to resolve the firmware-access
boundary before repeating the bounded diagnostic.

## Iteration 39 result - 2026-08-31

The existing merged firmware was copied into the writable project and verified
byte-identical (4 MiB, SHA-256
`275C7D097C0379F638E8FE1A4E6C4EFB5C4EDFE30650A7E6818743FD9944A6D6`). One
unchanged bounded MWDT diagnostic invocation using that staged input reached
only `FAILURE_ISOLATION_PHASE = ADMISSION_1`, then reported
`TIMEOUT_PHASE = ADMISSION_1` with QEMU initialized and
`firmware_running=true`, but zero submissions/completions and no start error.
It emitted no MWDT or reset evidence and left no process running. The result
is a diagnostic admission-timeout observation, not watchdog evidence. Next
step is a read-only audit of the harness admission timeout/reporting path.
## Iteration 40 result - 2026-08-31

The read-only source audit explains the incomplete admission result without
implicating QEMU or MWDT. In `VnextBProductionScaleTest.cpp:311-331`, failure
isolation admits sessions serially and gives each session a fixed 120-second
deadline. The predicate requires simultaneously `firmwareRunning()`, a
submission count greater than zero, and a completion count greater than zero;
the loop sleeps 20 ms and has no intermediate progress report. On expiry it
prints the phase, captures a bounded 2000-byte QEMU-log tail, stops every
session, and returns 1. The staged log matches this path: QEMU was alive and
initialized with zero submissions/completions, then `TIMEOUT_PHASE =
ADMISSION_1` was reported. The QEMU log reader is continuous and bounded to
1 MiB (`QemuProcessManager.cpp:296-306,363-387`), so output capture is not the
cause of the admission stall. No source, build, runtime, ABI, transport,
watchdog/reset, Git, or rollback artifact changed. `ESP32_MWDT_BEHAVIOR`
remains open.

## Iteration 40 bounded progress follow-up - 2026-08-31

The existing one-session runner was executed twice for 3 s and once for 10 s
with staged GPIO-debug firmware and canonical QEMU. All runs reached
`firmware_running=true` but ended with zero I2C submissions/completions.
Startup traces remained limited to initial reset and
`SW_CPU_RESET_REGISTER`; no MWDT expiry/reset was observed. The staged
firmware SHA differs from the historical I2C workload binary. This is not a
root-cause declaration. `ESP32_MWDT_BEHAVIOR` remains open pending a directed
boot/firmware-path comparison.

## Iteration 42 bounded staged-firmware direct diagnostic - 2026-08-31

One artifact-appropriate, non-failure-isolation run used canonical QEMU, the
staged GPIO-debug firmware copy, trace enabled, and a bounded 20-second window.
The harness reported `firmware_running=true` with zero I2C submissions and
completions. QEMU output contained only the initial reset and expected
app-CPU-startup `SW_CPU_RESET_REGISTER`; it contained no I2C, TG0/MWDT feed,
expiry, or MWDT reset record. Hashes remained unchanged. This is not MWDT
evidence or a root-cause declaration; `ESP32_MWDT_BEHAVIOR` remains open.

## Iteration 44 result - 2026-08-31

The prescribed one-session staged-firmware failure-isolation diagnostic timed
out at `ADMISSION_1` with `firmware_running=true`, zero submissions/completions,
and no start error. The bounded log shows continuous TG0 stage-0 feed/rearm and
I2C fast-path diagnostics, but no APP CPU reset trace, MWDT expiry/reset, or
ESP32 reset record. This remains inconclusive pre-admission evidence;
`ESP32_MWDT_BEHAVIOR` stays open and no root cause or semantic change is declared.

## Iteration 45 result - 2026-08-31

The read-only audit identified the bounded-observation limitation behind E051.
QEMU drains combined stdout/stderr continuously, but `QemuProcessManager`
retains 1 MiB and trims to 512 KiB; the admission diagnostic retains only the
last 2000 bytes. The E051 outer log is 43.85 MiB with about 303k I2C diagnostic
matches, so startup/reset records can be evicted before the tail is printed.
Reset producers and the environment gate are present in the canonical QEMU
source, with MWDT CPU reset routed through the async APP-CPU reset path. No
reset cause or root cause is inferred, and no source/binary/semantic change was
made. `ESP32_MWDT_BEHAVIOR` remains open.
## Iteration 52 result - 2026-08-31

The reviewer-authorized guest-only TG0 diagnostic was created and built
successfully. Its first 12 s canonical-QEMU run was not a valid no-feed test:
after the fixture configuration, Arduino framework code emitted TG0 feeds and
rewrote stage configuration. Source audit also confirms TG0 reset output is
wired to reset index 0, while TG1 is wired to index 1/APP CPU. No valid MWDT
expiry or root cause was declared; review is required to select bare-metal TG0
or TG1 for the next isolated diagnostic.

## Iteration 61 result - 2026-08-31

The authorized project-local IDF requirements installation was attempted with
`--no-cache-dir` and `IDF_PATH` set to the reusable ESP-IDF 4.4.7 package.
Pip processed the local `esp-windows-curses` requirement, then produced no
further output for more than 90 seconds and was stopped. The environment still
lists only `pip==24.2`; importing the required packages still fails at `click`.
No build, QEMU run, source, production binary, or semantic change occurred.
The infrastructure blocker remains unresolved.

A second pip attempt with `--timeout 10 --retries 1` also stalled immediately
after the local curses package and was stopped with only its test-created
processes affected. Dependency installation remains unresolved; no build or
QEMU run is authorized from this state.

The follow-up read-only artifact/index discovery found no local wheel, source
archive, or configured pip index override. The adjacent PlatformIO IDF
environment contains only partial `future`/`kconfiglib` remnants and cannot
serve as a complete dependency source.

## Iteration 62 result - 2026-08-31

The reviewer-directed bounded download-only probe reached the explicit official
PyPI index successfully: `GET https://pypi.org/simple/click/` returned HTTP 200,
and pip downloaded `click-8.5.0-py3-none-any.whl` into the project-local
`.ai/wheelhouse_probe_click` directory. The wheel is 125251 bytes with SHA-256
`255BC9599CF7748B4B1A446CCC735421BD08A2AE529A8B88597D3DE5664EE360`.

The target environment was not modified: `pip list` remains only
`pip==24.2`, and importing `click` still fails with `ModuleNotFoundError`.
This isolates official-index reachability as working and leaves the dependency
installation as a local wheelhouse population problem. No build, QEMU run,
source, production binary, or semantic watchdog change occurred.

## Iteration 64 result - 2026-08-31

The reviewer-directed bootstrap boundary completed. Setuptools 84.0.0 was
downloaded from official PyPI, installed into the target Python, and imported
successfully. The local `esp-windows-curses` package then built successfully
with no build isolation, no dependencies, and cache disabled. Artifact hashes
are recorded in E072. The first build exposed only a global pip-cache
permission failure; the bounded cache-disabled retry passed. No firmware,
QEMU, source, or watchdog/reset semantic artifact changed.

## Iteration 65 result - 2026-08-31

The verified local `esp-windows-curses` wheel was installed successfully into
the target Python. A fresh official-PyPI requirements download was then
attempted with the required timeout/retry/cache bounds. Pip still entered an
isolated build for the local wrapper and stalled after the official setuptools
simple-index request returned HTTP 304; the test-created process was stopped
after approximately 60 seconds. The fresh wheelhouse remains empty. The next
safe experiment is the same download with build isolation disabled, now that
setuptools and the wrapper are installed locally. No firmware build or QEMU
run is authorized from this state.

## Iteration 66 result - 2026-08-31

The no-build-isolation requirements download populated
`.ai/wheelhouse_idf_requirements_66` with 31 artifacts. Direct installation
from that wheelhouse succeeded, including building `reedsolo`; the target IDF
Python import probe passed for all required modules. The requirements file's
legacy `file://${IDF_PATH}` entry was not expanded by pip on this Windows
invocation and was bypassed without changing the framework or requirements
file. Pure fixture build preflight is next; no QEMU or watchdog conclusion
exists.
## Iteration 72 result - 2026-08-31

The reviewer-directed cache boundary audit found the exact latest Burn bundle
path as `C:\Users\josuemorais\AppData\Local\Package Cache\{a10fbb63-03ff-4b8c-a176-f5fd355f715b}`;
the GUID directory does not exist. `Package Cache` exists, is owned by
`BUILTIN\\Administradores`, and grants the current sandbox group only
`ReadAndExecute, Synchronize`; the current process identity is
`PC_UFU_Josue\\CodexSandboxOffline` (SID `S-1-5-21-3846247477-1191926843-2878787821-1004`),
not the `PC_UFU_Josue\\josuemorais` principal that has FullControl. A bounded
new-child create/write/read/delete sentinel failed at directory creation with
Win32 access denied. `icacls /verify` passed for `Package Cache`, `Local`, and
`AppData`. No ACL, installer, Python, firmware, QEMU, production, or semantic
artifact changed. `ESP32_MWDT_BEHAVIOR` remains open; ACL repair or extraction
route requires reviewer direction.
## Iteration 79 result - 2026-09-01

The reviewer-approved project-local assembly of the official Python 3.10.11
`core`/`exe`/`lib` payload passed: 847/847 expected files were reconstructed,
size and SHA-256 inventory checks passed, and the literal interpreter reported
Python 3.10.11. Standard-library imports, bundled ensurepip version, and a
child venv created without pip all passed. Pre/post PATH, Package Cache, and
Python uninstall registry snapshots were equal. The MSI-vs-PE four-part
version representation discrepancy for 30 versioned files is retained in the
inventory and is not treated as a payload mismatch. Next is bounded IDF
dependency/bootstrap validation using this project-local interpreter; no
firmware build or QEMU run has been performed.

## Iteration 81 result - 2026-09-01

The literal assembled Python 3.10.11 runtime successfully created a disposable
project-local child environment and bootstrapped only pip 23.0.1 and setuptools
65.5.0 from its embedded ensurepip wheels. An offline, no-index IDF dependency
metadata probe failed immediately because no package artifact exists for
setuptools>=21. The local esp-windows-curses metadata probe passed, but the
child still lacks all tested third-party imports except packaging. The direct
requirements entry using `${IDF_PATH}` is not expanded by pip on this Windows
invocation. No dependency install, firmware build, QEMU run, or watchdog/reset
semantic change occurred; `ESP32_MWDT_BEHAVIOR` remains open.

## Iteration 83 result - 2026-09-01

The downloaded official `gdbgui==0.13.2.0` wheel was read without
installation. Its target-applicable metadata declares `gevent (<2.0,>=1.2.2)`
with no environment marker, so the metadata does not pin `gevent==1.5.0`.
A bounded official-PyPI probe for exactly `gevent==1.5.0` using
`--only-binary=:all: --platform win_amd64 --implementation cp
--python-version 310 --abi cp310` returned exit code 1 and no artifact;
pip listed available binary candidates beginning at 21.8.0. The exact
dependency closure remains an infrastructure issue requiring reviewer direction
before probing another version. No package was installed, and no firmware,
QEMU, watchdog/reset, production, ABI, or Git artifact changed.

## Iteration 82 result - 2026-09-01

Official PyPI access through the validated Python 3.10 child succeeded. A
fresh project-local wheelhouse retained 20 direct IDF artifacts after a
bounded download-only inventory. Full resolution remains incomplete at the
Python 3.10 `gdbgui` dependency `gevent==1.5.0`, whose sdist metadata requires
`bdist_wheel` while build isolation is disabled. No dependency was installed
into the child, and no firmware build or QEMU/watchdog conclusion is valid.

## Iteration 84 result - 2026-09-01

The reviewer-directed exact `gevent==1.5.0` official-PyPI binary probe for
Windows CPython 3.8 tags passed. It retained the 1,559,340-byte
`gevent-1.5.0-cp38-cp38-win_amd64.whl` with SHA-256
`45A5AF965CC969DD06128740F5999B9BDB440CB0BA4E9C066E5C17A2C33C89A8`.
This establishes artifact availability for a possible faithful Python 3.8
route, not runtime availability or a completed IDF dependency closure. No
package was installed and no firmware/QEMU/watchdog conclusion is valid.

## Iteration 85 result - 2026-09-01

The reviewer-approved acquisition boundary passed for the official CPython
3.8.10 Windows x64 installer. The requested and final URL were identical:
`https://www.python.org/ftp/python/3.8.10/python-3.8.10-amd64.exe`; HTTP 200,
`application/octet-stream`, Content-Length 28,296,784, and ETag
`"608fe733-1afc650"`. The staged artifact is
`orchestrator/.ai/python38_acquisition_85_20260901T071500/python-3.8.10-amd64.exe`
with SHA-256
`7628244CB53408B50639D2C1287C659F4E29D3DFDB9084B11AED5870C0C6A48A`.
Windows Authenticode status is `Valid`; signer subject is Python Software
Foundation. No installer execution, layout, dependency installation, PATH,
registry, ACL, firmware, QEMU, or semantic artifact change occurred.
`ESP32_MWDT_BEHAVIOR` remains open.
## Iteration 86 result - 2026-09-01

The reviewer-approved official CPython 3.8.10 x64 layout boundary passed.
Burn planned 52 packages; its first run exposed `core_pdb.msi`, then the
bundle-declared same-origin payloads were acquired individually with verified
HTTPS, atomic staging, and SHA-256 recording. A rerun completed Burn `/layout`
with exit code 0 and `Apply complete, result: 0x0`. The project-local layout
contains 12 signed bundle/payload files; its inventory and Burn log are under
`orchestrator/.ai/python38_layout_86_20260901T072000/`.
No MSI action, CAB extraction, runtime assembly/execution, dependency install,
firmware build, QEMU run, PATH/registry/ACL, or semantic/Git artifact changed.
`ESP32_MWDT_BEHAVIOR` remains open; reviewer direction is required before
runtime assembly.

## Iteration 87 result - 2026-09-01

The approved CPython 3.8.10 runtime-assembly boundary was audited before
processing. The Burn-accepted layout has no base `core.msi`, `exe.msi`, or
`lib.msi`; it contains only the installer plus signed `_d`/`_pdb` packages.
The same-named files available locally belong to the previously validated
CPython 3.10 payload set and were not used. Assembly and execution therefore
did not start. E093 records the input-boundary mismatch; reviewer direction
is required before acquiring or sourcing any replacement 3.8.10 base MSI.
No firmware/QEMU/watchdog, production, semantic, ABI, PATH, registry, ACL, or
Git artifact changed.
