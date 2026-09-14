# E148 — ESP32 Arduino 3.3.9 / VNEXT_B real LED and UART (2026-09-14)

Status: scoped user-project LED/UART acceptance and focused regression complete on local development runtime. Not a release or canonical runtime promotion.

## Scope and reproducible fixture

- User firmware: `C:/SourceCode/EININDI01_GitHub_VSCode_PIO/sourcecode/merged.bin`, PlatformIO espressif32 55.3.39 / Arduino 3.3.9. GPIO13 `digitalWrite`, millis-based 500 ms toggles, UART0 115200 `LED alternado`.
- Real project: `lasecSimul/blink_led.lsproj`, expanded DevKitC, LED/resistor, motor, potentiometer, probe and LasecPlot. 58 active components.
- VNEXT_B + MTTCG, network disabled. No queue-depth, ABI, watchdog scale or polling timeout tuning.

## Evidence, including failures

1. MEASURED_SIMULATOR: isolated MCU firmware test passed 30 s: 56 complete application lines, 56 GPIO edges, max wall interval 512 ms. This did NOT validate F5 or the full circuit.
2. SOURCE_PROVEN + controlled simulator RED/GREEN: unconditional synthetic 0x60000000 MMIO mapping masks the actual Arduino 3.3.9 UART AHB FIFO. Opt-in mapping fixes UART in isolated test; explicit synthetic mapping restores failure (0 application lines). Historical claim that this address is unreachable by real firmware is contradicted by GDB at `uart_ll_write_txfifo`, a10=0x60000000.
3. MEASURED_SIMULATOR: full-project baseline returned matching UART streams but ROM-only; this was a FALSE acceptance because byte equality alone permits two equally incomplete streams. Dedicated application/edge acceptance now added.
4. MEASURED_SIMULATOR: 60 s full-project trace had 494 UART clock-config forwards vs 316 bytes and only four GPIO_OUT writes. SOURCE_PROVEN: replaying the entire config after partial credit success can repeatedly occupy the next returned slot; CONF0 reset replay is not side-effect-free. UART now checkpoints accepted config operations and retries only pending operations/byte.
5. SOURCE_PROVEN: vnext_resume still unconditionally signaled the artifact in its RUNNING handshake branch, despite a later comment forbidding such wakes. Gated handshake signal to first RUNNING transition.
6. SOURCE_PROVEN: VNEXT module `writeRegisterAt` received raw QEMU timestamps, while module callbacks use scheduler absolute time. Corrected to origin-adjusted timestamp.
7. SOURCE_PROVEN: requested MCU pin metadata was associated positionally with adapter module lines. Semantic ID matching preserves mapping regardless of enumeration order; dedicated reordered-pin unit test passes. This is hardening, not independently proven to cause the user's current failure.
8. MEASURED_SIMULATOR: replacing final pacing yield-spin with quantum CV sleep reduced CPU contention, but real-time Core rate became 0.9136 over 30 s, only 205 ROM bytes. SOURCE_PROVEN: lateness reanchor discarded every oversleep while QEMU host clock advanced. Keeping absolute pacing anchor restored 55 lines and 55 edges in 30 s, first visible edge 3.02 s; no malformed application lines. STILL FAILED max visible gap 957 ms. Pause/rate changes explicitly reanchor, ordinary lateness does not. Reviewer approved narrow experimental direction, not closure.
9. MEASURED_SIMULATOR: exact GPIO event trace over 55 toggles has 500 ms virtual spacing and approximately 500 ms wall spacing (one 554 ms interval), while visual telemetry reports recurring 950 ms / 50 ms edge pairs.
10. MEASURED_SIMULATOR: side-by-side `getNodeVoltage` and `getTelemetryFrame` over 15 s: direct voltage transitions about 500 ms; telemetry frames retain old values until next electrical event/heartbeat. SOURCE_PROVEN: telemetry requests increment generation but do not wake/service the worker when the advance cap holds a quiet circuit. Added coalesced refresh via existing bounded CommandQueue, worker-only capture when dirty set empty and last settle converged. If dirty, existing stable-step publisher captures instead. Build/tests pending.

## Acceptance and next work

`scripts/benchmark-real-esp32.mjs` now fixes unstable junction union roots, actual probe pin lookup and pre-stop simulation-time measurement. With `LASECSIMUL_BENCHMARK_EXPECTED_LINE=LED alternado`, requires boot/first edge <5 s, sufficient complete exact lines and edges, no bad application lines, max visual edge interval <=650 ms. UART monitor and LasecPlot must remain byte-identical. Direct node-voltage timeline is a separate comparator, not a substitute for visible telemetry.

## Final-candidate validation (2026-09-14)

- Final QEMU SHA256: `64E021AC7CA67E29EC224800FE4A5B18B14EC5BC616F33D7627894E97F0ECC4C`. User firmware rebuilt successfully with the installed PlatformIO espressif32 55.3.39 / Arduino 3.3.9; merged firmware SHA256 remains `CCBA8880EA86EF580930F5CD6BED8BC984CC4E25AACA52BA47E1B5B89F9B46E7`.
- Full development/F5 prelaunch build (`node scripts/build-development.js`): PASS, Core, device DLLs, adapter and extension/webview. This is the actual configured prelaunch command, not a claim of manually pressing F5 in the GUI.
- Final connected full-project 120 s gate: PASS (exit 0), UART monitor/LasecPlot byte-identical (3936 bytes), average Core rate 0.99933, no Guru Meditation or I2C ACK errors; actual LED visual-state, exact application-line and maximum-gap gates enforced.
- Final disconnected-LasecPlot full-project 30 s gate: PASS, 56 complete `LED alternado` lines, zero bad application lines, 56 electrical/visual transitions, first edge 2.266 s, maximum visible interval 555.266 ms, clean stop in 1.011 s. Fixture removal is in-memory only; original project unchanged.
- Earlier connected 60 s and disconnected 120 s candidates also passed 116 and 236 complete lines/visual transitions, respectively. These precede final callback/fatal hardening and are not substituted for the final-candidate gates above.
- Final McuComponent (including reordered semantic pin IDs), Scheduler and SimulationPlan session tests: PASS. Quiet-circuit telemetry test verifies requests are serviced without requiring electrical time advancement. Four singular-system notices come from the existing disconnected-capacitor fixture, not this user circuit.
- `npm.cmd test` extension suite including lifecycle, broker, serial formatting, geometry and IEC 5x5 matrix: PASS.
- Read-only independent review prompted additional hardening: defer scheduler calls until after callback lifetime-lock release (poll and module wakeup); preserve absolute target timestamps; treat fatal UART publication as fatal rather than successful credit. Patch/provenance updated to final native candidate.

Final focused regression `VNEXT_B_MTTCG_E148_final`: PASS 14/14, exit 0. Includes 25/25 restart cycles (zero failed boots or mid-run stalls), 90 s real-QEMU scheduler synchronization, independent multiple-controller teardown, crash resilience, adapter/arena/process/I2C and drain-cutoff gates. Logs: `vnext_prototype/regression_runs/VNEXT_B_MTTCG_E148_final/`. Independent read-only review found no new scoped blocker. `git diff --check` passed.

Historical multi-reader telemetry subscription ownership findings remain separate from this single-reader project acceptance. The corrected QEMU candidate is now the release canonical runtime (`QEMU_RUNTIME.json`, SHA `64E021...F0ECC4C`); the pre-E148 executable remains as a rollback artifact. Do not claim all historical findings closed.
