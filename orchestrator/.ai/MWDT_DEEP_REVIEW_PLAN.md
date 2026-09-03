# MWDT/IWDT — DEEP REVIEW AND EXECUTOR CONTRACT

Date: 2026-08-31  
Role: adversarial technical review  
Scope: determine the next causal experiment; no production-code change; no commit/push.

## 1. REVIEW DECISION

Stop the current attempt to use the mixed Arduino+ESP-IDF TG1 fixture as if it reproduced the production Interrupt Watchdog (IWDT).

The next experiment SHALL be a **pure ESP-IDF IWDT conformance fixture**, run first directly on the canonical QEMU in literal deterministic time. It must exercise the official ESP-IDF IWDT implementation, not a guest-written TG1 configuration. Only after that direct test passes may the same image be exercised through one ABI v5 session. The 1/4/8/16-session matrix comes later.

This is the minimum experiment that separates:

1. official ESP-IDF IWDT policy and tick feeding;
2. QEMU TG1/MWDT interrupt and reset implementation;
3. Core/transport/ABI v5 integration.

The old fixture is not discarded. Reclassify it as a **synthetic MWDT peripheral/routing fixture**. Its stage-1 `CPU_RESET` expectation is valid only for that synthetic register-level test and must not be used as the oracle for production IWDT behavior.

## 2. WHY THE PREVIOUS PATH COULD LOOP

The evidence contains three distinct test subjects that were being treated as one:

| Subject | Actual oracle | What it can prove | What it cannot prove |
|---|---|---|---|
| Raw TG1 fixture | guest-written TG1 registers | peripheral stage/routing capability | official ESP-IDF IWDT behavior |
| Official ESP-IDF IWDT | `int_wdt.c`, effective sdkconfig, tick hooks | real IWDT feed, interrupt, panic/fallback reset policy | ABI v5 stability by itself |
| Production ABI v5 workload | Core+guest+QEMU integration | load/resource behavior under the frozen architecture | isolated correctness of TG1 without an independent fixture |

Consequences already visible in the record:

- E060 through E063 repeatedly observed framework-owned watchdog activity rather than the intended isolated guest program.
- The current fixture asks for TG1 stage 0 `OFF` and stage 1 `CPU_RESET`. ESP-IDF 4.4.7 configures the IWDT as stage 0 `INT` and stage 1 `RESET_SYSTEM`.
- `sdkconfig.defaults` is not evidence of the effective configuration of a mixed Arduino+ESP-IDF build. The build never produced the generated sdkconfig/config header/map required to prove that the official IWDT had actually been removed.
- The installed precompiled Arduino ESP32 configuration explicitly has `CONFIG_ESP_INT_WDT=y`, `CONFIG_ESP_INT_WDT_CHECK_CPU1=y`, and a 300 ms timeout.
- The canonical QEMU is built from a dirty diagnostic worktree whose current realtime watchdog default scales TG0 and TG1 by 100 and contains TG0 transport-pause compensation. It is therefore the implementation under test, not an independent timing oracle.
- `MWDT_CPU_STAGE n=1` is a correct expected marker only for a synthetic TG1 `CPU_RESET` stage. It is the wrong required result for the official IWDT, whose fallback stage is a system reset.

Continuing the mixed fixture would answer only whether framework interference could be removed. It would still not reproduce the production IWDT and would not close the causal gap.

## 3. SOURCE-LOCKED FACTS FOR THE ORACLE

Use the exact locally installed ESP-IDF 4.4.7 implementation as the primary software oracle:

- `.piohome/packages/framework-espidf/package.json` identifies version `3.40407.240606` / ESP-IDF 4.4.7.
- `.piohome/packages/framework-espidf/components/esp_system/int_wdt.c` selects `WDT_MWDT1`.
- With `CONFIG_ESP_INT_WDT_CHECK_CPU1`, CPU1's tick records liveness and CPU0 feeds only after observing that liveness. A timeout reported for CPU1 therefore means CPU1 stopped ticking; it does **not** mean the hardware policy is CPU1-only reset.
- Stage 0 is `WDT_STAGE_ACTION_INT`.
- Stage 1 is `WDT_STAGE_ACTION_RESET_SYSTEM`, with the fallback timeout configured at twice the IWDT timeout.
- The FreeRTOS port calls `esp_int_wdt_init`, `esp_int_wdt_cpu_init`, and the per-CPU tick hook only when the effective build has `CONFIG_ESP_INT_WDT` enabled.

QEMU action encoding in `hw/timer/esp32_timg.c` is:

- `0 = OFF`
- `1 = INT`
- `2 = CPU_RESET`
- `3 = SYS_RESET`

These facts define the expected trace. Do not alter the oracle to match the current log.

## 4. CLOSED AREAS — DO NOT REOPEN

Do not spend another cycle on these unless genuinely new evidence contradicts them:

- ABI v5 protocol/dispatcher architecture;
- SPSC ownership and publication ordering;
- backpressure and admission-timeout semantics;
- resource accounting and 16-session support matrix already closed by their respective gates;
- software APP-CPU reset as the primary fix;
- CPU1 MWDT compensation as a proposed fix;
- polling, queue-depth, watchdog-timeout, or reset-semantic tuning;
- the claim that a scale-100 realtime run is literal ESP32 timing.

The inconsistencies between `TEST_GATES.md` and `FINAL_CHECKLIST.md` must be reconciled administratively after this investigation so closed gates do not get selected again. They are not grounds to rerun them now.

## 5. EXACT NEXT ACTION

Build one minimal, pure ESP-IDF diagnostic image whose only purpose is to prove the official IWDT path. Do not use Arduino, Core, VNEXT_B, session queues, I2C, or the production harness in the first run.

### Phase 0 — write the test contract before implementation

Record, in the fixture README or evidence preamble, the following immutable contract:

- ESP-IDF version: exact locally installed 4.4.7 package.
- watchdog instance: TG1/MWDT1 through official `int_wdt.c`.
- effective options required: `CONFIG_ESP_INT_WDT=y`, `CONFIG_ESP_INT_WDT_CHECK_CPU1=y`, explicit timeout value.
- healthy control: both cores continue ticking for at least three configured IWDT timeouts and no reset occurs.
- injected fault: a highest-priority task pinned to CPU1 emits a final marker, then prevents CPU1's FreeRTOS tick from running while CPU0 remains schedulable.
- expected causal sequence: healthy TG1 feeds -> CPU1-starve marker -> no new CPU1 liveness -> CPU0 stops feeding TG1 -> stage-0 interrupt/panic attributed to CPU1 -> restart; if panic handling cannot complete, stage-1 system-reset fallback.
- forbidden expected result: requiring a CPU1-only hardware reset from the official IWDT.

If this contract cannot be represented by the exact IDF source/configuration, stop and report a contract error. Do not run QEMU.

### Phase 1 — make the build environment a binary precondition

Repair only the project-local ESP-IDF Python environment using the pinned requirements belonging to the installed ESP-IDF package. Do not change global Python and do not change production dependencies.

Pass conditions before any runtime:

1. the ESP-IDF tool can report its version from the project-local environment;
2. dependency verification completes without a resolver/install hang;
3. the pure ESP-IDF fixture builds reproducibly;
4. generated `sdkconfig`, generated config header, ELF map, and image are preserved as artifacts.

If dependency installation stalls again, classify the result as **INFRASTRUCTURE BLOCKED**. Do not interpret it as watchdog evidence and do not fall back to the mixed Arduino fixture.

### Phase 2 — prove configuration and linkage statically

Before starting QEMU, prove all of the following from generated artifacts:

- `CONFIG_ESP_INT_WDT=y`;
- `CONFIG_ESP_INT_WDT_CHECK_CPU1=y`;
- the effective timeout equals the contract;
- `esp_int_wdt_init` is linked/reachable;
- `esp_int_wdt_cpu_init` is linked/reachable;
- the FreeRTOS tick hook that calls `esp_int_wdt_cpu_tick` is present for both CPUs;
- the linked IDF source/configuration corresponds to stage 0 `INT` and stage 1 `RESET_SYSTEM`.

Preserve exact firmware SHA-256, sdkconfig SHA-256, map SHA-256, QEMU SHA-256, QEMU git commit, and dirty status.

Any failed item is a hard stop. No QEMU run is allowed because the experiment would no longer exercise the declared subject.

### Phase 3 — run the direct literal-time conformance test

Invoke QEMU directly, outside Mcu/ABI v5, using:

- canonical QEMU identity from `QEMU_RUNTIME.json`;
- deterministic single-thread TCG;
- `-icount shift=4,align=off,sleep=off`;
- `LASECSIMUL_ESP32_EXECUTION_MODE=deterministic`;
- `LASECSIMUL_ESP32_WDT_SCALE=1`;
- opt-in TG1 watchdog trace;
- bounded outer timeout that is large enough for boot plus both control and fault phases but cannot hang the review session.

The diagnostic should contain two explicitly separated subtests. They may be selected by a build-time constant or a minimal boot selector; do not add complex persistence logic merely to combine them.

#### Test A — Good/control

- boot both cores;
- allow normal scheduler ticks for at least `3 x IWDT timeout` after initialization;
- emit beginning/end control markers;
- require repeated TG1 feeds and no expiry, panic, CPU reset, system reset, or reboot during the control window.

#### Test B — Bad/CPU1 starvation

- boot identically;
- verify at least two ordinary TG1 feed cycles before injection;
- pin the injector to CPU1 at highest priority;
- emit and flush `IWDT_INJECT_CPU1_STARVE` before disabling CPU1 tick progress;
- keep CPU0 schedulable;
- observe the official IWDT consequence within a contract-derived deadline.

Required ordered evidence for Test B:

1. official TG1 configuration reflects stage 0 mode 1 and stage 1 mode 3;
2. healthy feeds occur before injection;
3. the CPU1-starve marker occurs once;
4. the last TG1 feed follows the last observed CPU1-liveness cycle;
5. stage 0 expires in interrupt mode;
6. panic/watchdog attribution identifies CPU1, or stage 1 reaches system-reset fallback if the panic path cannot complete;
7. a reboot/reset reason is captured and is consistent with the observed path;
8. no guest code writes a synthetic TG1 `CPU_RESET` configuration.

Do not require `MWDT_CPU_STAGE n=1`. For the official IWDT, the hardware fallback marker is a TG1 system stage/reset.

Timing pass/fail limits must be derived from the effective timeout and the documented two-stage policy. Do not reuse the 100x realtime tolerance in this run.

### Phase 4 — classify, do not patch

Use this decision table immediately after the direct run:

| Good/control | Bad/starve | Classification | Next step |
|---|---|---|---|
| PASS | PASS | Direct QEMU IWDT path conforms | Proceed to one ABI v5 integration run |
| FAIL (expiry/reset while fed) | any | QEMU timing/feed implementation suspect | Minimize from the first divergent TG1 event; no ABI/load run |
| PASS | FAIL (no stage-0 action) | QEMU TG1 interrupt delivery/expiry suspect | Trace TG1 IRQ connection and CPU interrupt level only |
| PASS | stage 0 PASS, no restart/fallback | panic/reset-chain or TG1 stage progression suspect | Trace reset cause and stage transition only |
| build/config proof FAIL | not run | fixture/infrastructure invalid | repair proof; no runtime conclusion |

No production or QEMU semantic change is authorized by a failure. First produce a Good-vs-Bad comparison with the first divergent event and obtain review.

### Phase 5 — only after direct conformance, test integration

Run the **same firmware image and same literal watchdog policy** through exactly one VNEXT_B/ABI v5 session. The purpose is only to discover whether Core/transport changes the already-proven IWDT sequence.

- If direct QEMU passes and one-session ABI fails, investigate the integration boundary.
- If both pass, run the normal fed workload at 1/4/8/16 sessions for resource/load confirmation.
- Do not start at 16 sessions; it multiplies noise before isolation.
- Keep realtime scale-100 results in a separate `OPERATIONAL_HOST_TOLERANCE` class. Never use them to close literal timing conformance.

## 6. REAL ESP32 FIDELITY REQUIREMENT

No simulator-only result can close full hardware fidelity. For final closure, flash the same minimal ESP-IDF image, with the same effective sdkconfig, onto a physical dual-core ESP32 and collect:

- serial boot/control/injection/panic sequence;
- reset reason after the fault;
- measured healthy window and fault-to-reset interval;
- firmware/sdkconfig hashes;
- board/chip revision and clock configuration.

Compare the physical run to the direct scale-1 QEMU run at the level of event order, action type, reset domain, reset reason, and bounded timing. If no board is available, explicitly classify the gate as `SIMULATOR_CONFORMANCE_ONLY`; do not call it complete hardware fidelity.

## 7. ARTIFACTS REQUIRED FOR A REVIEWABLE RESULT

Return one compact evidence packet containing:

1. test contract and exact pass/fail predicates;
2. toolchain/package versions;
3. generated sdkconfig/config-header/map proof;
4. firmware and QEMU identities/hashes;
5. exact launch arguments and relevant environment values;
6. Good/control raw log plus normalized event timeline;
7. Bad/starve raw log plus normalized event timeline;
8. first divergence and decision-table classification;
9. statement that production code, ABI, backpressure, reset semantics, and timeouts were not changed;
10. whether the physical ESP32 comparison exists or remains pending.

## 8. STOP RULES

- No QEMU before static configuration/link proof.
- No mixed Arduino fixture as a substitute for official-IWDT conformance.
- No 16-session run before direct and one-session integration pass.
- No watchdog timeout/scale/transport compensation change based only on a timeout.
- No semantic QEMU patch before a source-backed Good-vs-Bad first divergence.
- No reopening CLOSED hypotheses without new contradictory evidence.
- No production-code edit.
- No commit or push without explicit user authorization.

## 9. SUCCESS DEFINITION

This action succeeds when it yields one of two useful outcomes:

1. a source-locked, literal-time proof that the official ESP-IDF IWDT behaves correctly in direct QEMU, allowing the investigation to move once to ABI integration; or
2. a reproducible first divergent IWDT event that identifies exactly one implementation boundary (feed, expiry, interrupt, panic, stage progression, or reset cause).

It does not succeed merely because a bounded process exits, a log contains the word watchdog, or a 100x-scaled workload completes.
