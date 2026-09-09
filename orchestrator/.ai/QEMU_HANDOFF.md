# START HERE - LasecSimul VNEXT_B / ESP32

## CURRENT HANDOFF — E145 closed H143 for Release and shipped a production-path MTTCG capacity guard; two narrow open findings; B12 not attempted (2026-09-09)

CURRENT_OBJECTIVE = Decide on two open findings (RESET_WAIT/E131's oracle
depends on QEMU diagnostics E141 removed; a narrow early-cycle/N=1 timing
intermittency, not H143, not capacity-related) and on when/whether to run
B11 N=13, before any further B12 attempt.

WHERE_I_STOPPED = H143 (the post-ack `now+1ns` starvation bug) is closed
and confirmed wired to production. This host's safe MTTCG capacity (13
sessions: `floor((32-6)/2)`) is now computed from real topology and
enforced fail-closed inside `McuController::start()` itself, not just in
test runners (`core/src/mcu/qemu/VnextBCapacityGuard.hpp`). Release
validation: 2/4 full 15-cycle `session_restart_stress_test` runs clean,
2/4 with 1-2 early-cycle-only misses (zero H143 storm signature in any of
them); two full 14/14 `VNEXT_B+MTTCG` regressions; B11 N=1 (1 intermittent
miss then PASS), N=8 PASS 8/8, N=12 PASS 12/12. B11 N=13 not executed
(user decision, see below). RESET_WAIT/E131 not validated (harness/oracle
issue, see below). B12 not attempted.

WHY_I_STOPPED = Two things block an unconditional close: (1)
`cache_wait_e2e_real_qemu_test.exe`'s own pass/fail oracle greps QEMU log
output for markers from 4 diagnostic env vars (`LASECSIMUL_E131_TCG_TRACE`
and 3 others) that E141 correctly removed from the production-clean QEMU
(confirmed absent via a full-tree grep) -- this is the first time E131/
RESET_WAIT has run against the E141 candidate at all, and it surfaces a
harness/oracle incompatibility, not a functional regression, not caused by
H143; out of scope to fix here (reopening E131, reintroducing removed
traces are both forbidden this episode). (2) A second host freeze occurred
during this episode's own planning for the B11 N=13 step (before any N=13
command was issued -- `-Force` was never used this episode); when asked
explicitly, the user chose to skip N=13 for this episode.

LAST_ACTION = Ran B11 N=1 (1 fail then 1 pass), N=8 (8/8 PASS), N=12
(12/12 PASS), all Release, all without `-Force`, against candidate
`475C0FC956E43FFC0CB83CECE0DC384457A9E1F01D2C6A3F6C21C4665C7EB23D`. Did
NOT run B11 N=13, N=16, B12, or any SINGLE_REALTIME/ICOUNT/LEGACY
configuration. See EVIDENCE.md's E145 entry, TEST_GATES.md, and
NEXT_ACTION.md for the full account and the pending decision.

## CURRENT HANDOFF — E138 reclassified E137 as ROM/EFUSE boot reset; review required (2026-09-08)

CURRENT_OBJECTIVE = Review the E138 classification before any semantic EFUSE
fix, B12, promotion or broader investigation.

WHERE_I_STOPPED = E138 corrected the previous E137 panic/CACHEERR
classification. E137 sessions 6/PID 3120 and 14/PID 15540, plus E138 session
14/PID 6588, are now classified as E121 ROM/EFUSE boot resets, not E135
post-boot panic.

WHY_I_STOPPED = The family and ROM reset point are proven, but the exact
sub-branch inside `_reload_efuses_and_check`, per-call RDATA, and correct
ESP32-classic EFUSE operation duration are not yet proven. A semantic fix would
be premature without review.

LAST_ACTION = Ran B11 N=16 using candidate
`3D951D7C7A83578DED9FA20E7B9F0E0BABA705025C05618E90DCB079693A96F6`, real
firmware, `VNEXT_B+MTTCG`, `ReserveCores=6`, `Force`, and only
`LASECSIMUL_RTC_SYS_RESET_CAUSAL_TRACE`.

LAST_RESULT = The run failed fail-closed with one red session. The captured
trace hit ROM `pc=0x4000fdcd`, `boot_epoch=1`, before APP CPU startup, with
`efuse_read_trigger_count=3`, `efuse_timer_fired_count=2`, and reset following
as `RTC_RESET pc0=0x4000fdd0 pc1=0x40000400 wdt0=0 wdt1=0`.

CURRENT_BLOCKER = Review decision. If more proof is required, authorize only a
bounded opt-in EFUSE memory ring. Do not investigate cache/TG1/WDT/transport or
run B12/promotion before review.

## CURRENT HANDOFF — E136 low-rate rare panic not reproduced; review required (2026-09-07)

CURRENT_OBJECTIVE = Review the E136 classification before any further
promotion/B12 path.

WHERE_I_STOPPED = E136 reconstructed the original E135 B11 N=16 session 0
offline, symbolized the PCs against the exact firmware ELF, audited existing
panic/WDT causal trace coverage, ran deterministic trace tests, then ran a
bounded N=16 reproduction campaign using the candidate directly.

WHY_I_STOPPED = The original event did not reproduce in three valid
trace-enabled attempts. Because root cause was not captured, the allowed result
is `LOW_RATE_ANOMALY_NOT_REPRODUCED_REVIEW_REQUIRED`, not promotion.

LAST_ACTION = Ran B11 N=16 with candidate
`3D951D7C7A83578DED9FA20E7B9F0E0BABA705025C05618E90DCB079693A96F6`, real
firmware, `VNEXT_B+MTTCG`, `ReserveCores=6`, `Force`, and only
`LASECSIMUL_PANIC_CAUSAL_TRACE` plus `LASECSIMUL_WDT_CAUSAL_TRACE`.

LAST_RESULT = Attempts 1, 2 and replacement attempt 4 were valid PASS runs:
16/16 sessions, zero unexpected resets, no panic trace, no WDT expiry ring dump,
clean teardown. Attempt 3 was preserved but invalid for the rare-panic question
because one session did not reach app-cpu startup/workload, with zero
unexpected resets.

CURRENT_BLOCKER = Review decision. The original panic/reset cascade remains
`GUEST_PANIC_RESET_CASCADE_UNCLASSIFIED`.

NEXT_EXACT_ACTION = Review
`C:\SourceCode\LasecSimul\orchestrator\.ai\REVIEW_PACKET.md` and decide whether
to accept/adjust `LOW_RATE_ANOMALY_NOT_REPRODUCED_REVIEW_REQUIRED`, authorize
one more bounded diagnostic campaign, or require minimal diagnostic coverage
changes.

NEXT_COMMAND = No executor command until review decision.

EXPECTED_PASS = Review defines a bounded next step without semantic production
changes.

EXPECTED_FAIL = Review rejects low-rate classification and identifies a
specific missing causal coverage field.

IF_PASS = Follow only the reviewed bounded diagnostic or closure path.

IF_FAIL = Keep candidate unpromoted and instrument only the reviewed gap.

WHAT_CHANGED_THIS_TURN = No production semantics changed. Added E136 artifacts,
report and review packet; ran unit tests and bounded reproduction only.

OPEN_PROBLEMS = Original E135 session 0 panic cause unknown; B11/B12/promotion
remain blocked.

DO_NOT_CHANGE = QEMU runtime canonical, `QEMU_RUNTIME.json`, watchdog scale,
cache/reset/transport/scheduler semantics, classifier, vendored runtime.

DO_NOT_REPEAT = Do not retry promotion or repeat N=16 indefinitely.

FILES_TO_INSPECT_FIRST =
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E136-b11-n16-panic-classification_20260907_220542\E136_classification_report.md`,
`C:\SourceCode\LasecSimul\orchestrator\.ai\REVIEW_PACKET.md`.

## CURRENT HANDOFF — E135 rolled back at real B11 N=16 red (2026-09-07)

CURRENT_OBJECTIVE = Classificar o primeiro vermelho real pós-promoção do B11
N=16 antes de qualquer nova promoção.

WHERE_I_STOPPED = A correção mínima do conflito E135 foi aplicada: o subcaso
LEGACY-only de gateway/TAP em `mcu_controller_real_qemu_test` agora emite
`NOT_APPLICABLE: test=mcu_controller_real_qemu_test subcase=legacy_gateway_tap_fallback reason=transport_vnext_b`
sob VNEXT_B. O executor foi endurecido para aceitar somente esse marcador
exato, uma vez, apenas nesse gate e transporte.

LAST_ACTION = O alvo `mcu_controller_real_qemu_test` foi recompilado; o teste
direto contra o candidato `3D951D7C...`, a regressão oficial `VNEXT_B+MTTCG`
14/14 contra o candidato e o B11 N=1 candidato passaram. A promoção final foi
tentada em
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\runtime-promotion_E135_final_20260907_192655`.

LAST_RESULT = A promoção foi revertida no primeiro vermelho real: B11 N=16 em
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\E135-gate-executor_20260907_181428\final_post_B11_N16`.
O runner usou QEMU `3D951D7C...`, teve 16/16 sessões e exit 0, mas reportou
`B11_CELL_PASS = False`, `RUNNER_PASS = False` e
`RUNNER_FAILURES = classifier_cellPass_false`.

CURRENT_STATE = Canônico restaurado para
`B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`;
`QEMU_RUNTIME.json` restaurado para
`ADF0D79B9E533E17A3F8CA62FD890B1867973FBB1AFF1C95239142D03644B369` e
read-only; zero QEMU restante.

NEXT_EXACT_ACTION = Inspecionar o artefato `final_post_B11_N16` e classificar o
red como issue do candidato E134, issue de classificador/oráculo B11, ou
instabilidade pré-existente de stress. Não repetir promoção sem classificação.

DO_NOT = Não rodar B12/promoção, não promover runtime, não copiar para
`devices\qemu-esp32\bin`, não alterar semântica QEMU/Core/firmware/transporte/
ABI, não cleanup/commit/push/tag/package/release.

## CURRENT HANDOFF — E135 blocked by fail-closed `PULADO:` conflict (2026-09-07)

CURRENT_OBJECTIVE = Resolver decisão de gate/protocolo antes de nova promoção
do `dev_qemu_runtime`.

WHERE_I_STOPPED = E135 criou e validou um executor fail-closed, passou preflight
direto com o candidato `3D951D7C...`, tentou promoção controlada com rollback
novo, mas reverteu no primeiro vermelho fail-closed da regressão.

WHY_I_STOPPED = O E135 exige rejeitar qualquer `PULADO:`. A regressão histórica
14/14 `VNEXT_B+MTTCG` inclui `mcu_controller_real_qemu_test`, que sai 0 e
imprime `Todos os testes passaram`, mas também imprime um `PULADO:` conhecido
para subcaso LEGACY-only de gateway/TAP não aplicável sob VNEXT_B. O executor
corretamente rejeitou isso; portanto a promoção não pode permanecer ativa sem
decisão explícita.

LAST_ACTION = Executor criado em
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\E135-gate-executor_20260907_181428\Invoke-E135PromotionGate.ps1`,
SHA256 `25A367AB2196EB21C090F9E41D013E1B06B3588FF950A5CA9F66749E3E6974A1`.
Self-test passou (`selftest13`). Preflight direto com candidato passou
(`preflight6`). Promoções E135 `runtime-promotion_E135_20260907_183710` e
`runtime-promotion_E135_20260907_184029` foram revertidas no primeiro vermelho
fail-closed.

LAST_RESULT = `BLOCKED_BEFORE_FINAL_PROMOTION — FAIL_CLOSED_GATE_CONFLICT`.
Canônico restaurado para SHA
`B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`;
`QEMU_RUNTIME.json` restaurado para SHA
`ADF0D79B9E533E17A3F8CA62FD890B1867973FBB1AFF1C95239142D03644B369`; zero QEMU
restante.

NEXT_EXACT_ACTION = Escolher uma das três opções bounded: (1) remover/substituir
o `PULADO:` LEGACY-only do gate VNEXT_B; (2) autorizar exceção estreita e
documentada para essa linha; ou (3) redefinir a lista 14/14 da promoção E135.
Não promover novamente antes dessa decisão.

DO_NOT = Não alterar semântica QEMU/Core/firmware/ABI/backpressure/cache-wait/
watchdog/transporte/CMake, não copiar para `devices\qemu-esp32\bin`, não rodar
LEGACY/ICOUNT/SINGLE_REALTIME, não fazer cleanup/commit/push/tag/package/release.

## CURRENT HANDOFF — promotion rolled back; fix gate invocation before retry (2026-09-07)

CURRENT_OBJECTIVE = Corrigir a invocação dos gates pós-promoção para que os
testes Core usem o runtime canônico promovido, então repetir a promoção
controlada a partir do rollback.
WHERE_I_STOPPED = A promoção foi tentada e revertida automaticamente no primeiro
vermelho pós-promoção.
WHY_I_STOPPED = `session_restart_stress_test` falhou usando
`devices/qemu-esp32/bin/qemu-system-xtensa.exe`, não o caminho canônico
promovido; `vnext_b_attachment_test` também não exercitou porque
`LASECSIMUL_TEST_QEMU_BINARY` estava ausente.
LAST_ACTION = Precondições passaram, rollback `rollback_B375A9E8` foi criado,
candidato `3D951D7C...` foi promovido temporariamente, DLLs preservadas,
`qemu --version` passou, QEMU unit gates passaram, Core gate falhou, rollback
restaurou canônico e `QEMU_RUNTIME.json`.
LAST_RESULT = `PROMOTION_ROLLED_BACK — FIRST_POST_PROMOTION_RED`. Canônico
restaurado para SHA
`B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`; zero QEMU
processes remain.
CURRENT_BLOCKER = Gate invocation/path, not a new production semantic fix:
Core post-promotion gates did not exercise the promoted canonical QEMU.
NEXT_EXACT_ACTION = Determine the exact env/path expected by
`vnext_b_attachment_test` and `session_restart_stress_test` to force
`C:\SourceCode\LasecSimul\vnext_prototype\dev_qemu_runtime\qemu-system-xtensa.exe`,
then rerun the same controlled promotion from rollback. Do not change QEMU/Core
production semantics in this step.
NEXT_COMMAND = Inspect the Core test/runtime path resolution for
`LASECSIMUL_TEST_QEMU_BINARY` and the session restart path before reattempting
promotion.
EXPECTED_PASS = Reattempted promotion gates exercise canonical `3D951D7C...`.
EXPECTED_FAIL = If the gate path cannot be forced cleanly, request review
instead of promoting.
IF_PASS = Reattempt controlled promotion and bounded gates.
IF_FAIL = Keep rollback canonical and do not promote.

DO_NOT_CHANGE = production semantics, candidate artifacts, rollback snapshot,
firmware, transport, ABI, cleanup, commit, push, tag, package, release.
ARTIFACTS = `C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\runtime-promotion_20260907_175847`.

## CURRENT HANDOFF — B12_PASS; promotion review authorized, no promotion yet (2026-09-07)

CURRENT_OBJECTIVE = Executar um review separado de promoção para o candidato
E134, sem refazer B11 automaticamente e sem ampliar escopo além de
`VNEXT_B+MTTCG`.
WHERE_I_STOPPED = B12 foi concluído por auditoria offline dos artefatos
aprovados E134/B11.
WHY_I_STOPPED = B12 autorizou somente review de promoção; não promoveu runtime.
LAST_ACTION = Auditei manifests, summaries, JSONL e logs B11 preservados;
confirmei SHA do candidato, firmware e harness; verifiquei `QEMU_RUNTIME.json`,
runtime canônico e ausência atual de processos QEMU órfãos; registrei relatório
B12.
LAST_RESULT = `B12_PASS — PROMOTION_REVIEW_AUTHORIZED` para `VNEXT_B+MTTCG`.
B11 aprovado: N=1 1/1, N=8 1/1, N=12 1/1 e N=16 3/3, com todos os workloads
válidos, `submissions==completions>0`, zero resets inesperados, zero
`artifactFatal`, sem CACHEERR/Guru/TG expiry indevida/SW reset inesperado/UART
loss/I2C loss/desync/reentrância/timeout/fail-open, teardown limpo e zero
órfãos.
CURRENT_BLOCKER = Promoção do runtime ainda requer review/etapa separada.
NEXT_EXACT_ACTION = Review separado de promoção para copiar, registrar e validar
o candidato SHA `3D951D7C7A83578DED9FA20E7B9F0E0BABA705025C05618E90DCB079693A96F6`,
mantendo o runtime canônico SHA
`B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E` como
rollback até a promoção ser explicitamente aprovada e registrada.
NEXT_COMMAND = Abrir o relatório
`vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\B12-final-decision_20260907_1735\B12_final_decision_report.md`
e `orchestrator\.ai\WORK_RESULT.json`.
EXPECTED_PASS = Review de promoção aprova promover o candidato E134 para o
runtime canônico e atualizar `QEMU_RUNTIME.json` em uma etapa própria.
EXPECTED_FAIL = Qualquer inconsistência de SHA, runtime, rollback ou protocolo
mantém a promoção bloqueada.
IF_PASS = Executar somente a promoção explicitamente aprovada e registrar
rollback/canônico.
IF_FAIL = Não promover; preservar candidato e canônico.

DO_NOT_CHANGE = QEMU/Core/firmware semantics, transport, scheduler, watchdog
semantics, `QEMU_RUNTIME.json` before explicit promotion review approval.
DO_NOT_REPEAT = Não rerodar B11/N16 só para confiança; não executar LEGACY,
ICOUNT, SINGLE_REALTIME, 2x3 historical matrix, Phase C, cleanup, commit, tag,
push or release.
ARTIFACTS = `C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218`.

## CURRENT HANDOFF — E134 REVIEW_REQUIRED before watchdog scale/reanchor fix (2026-09-07)

CURRENT_OBJECTIVE = Obter review para a correção semântica do reanchor/escala do Interrupt WDT antes de editar `esp32_timg_wdt_arm()` de produção.
WHERE_I_STOPPED = E134 phase 1 confirmou H134 por fonte, reconstrução numérica e teste RED. Nenhuma campanha B11 foi iniciada e nenhuma correção semântica foi aplicada.
WHY_I_STOPPED = A própria E134 exige review obrigatório antes da alteração semântica de watchdog.
LAST_ACTION = Criei snapshot E134, preservei hashes/status/diffs/fontes TIMG iniciais, li a autoridade `.ai`, auditei `esp32_timg_wdt_get_count/update_config/feed/arm/cb`, handlers WDTCONFIG0..5/WDTFEED/INT_CLR/reset, inicialização de escala e compensação E114; adicionei helper/teste puro RED para a matemática atual.
LAST_RESULT = H134 confirmada: a sequência E133 esperava deadline reancorado `33122494200 ns`, mas a matemática atual produz `3426994200 ns` porque `count_base=609` literal é comparado com raw timeout `600`. Teste RED falha com exit 3 e saída preservada em `E134-wdt-scale-reanchor_20260907_152218\phase1_red_test.out`.
CURRENT_BLOCKER = Review pendente para autorizar correção que usa timeout efetivo em ticks escalados.
NEXT_EXACT_ACTION = Se review aprovar: corrigir `esp32_timg_wdt_scale_math.h`, fazer `esp32_timg_wdt_arm()` usar o helper, ampliar ring causal bounded/off-by-default com config address/old-new/CPU/guest PC/raw-effective/remaining/deadline, e executar as validações E134 em camadas. Se rejeitar: preservar decisão e não improvisar.
NEXT_COMMAND = Abrir `orchestrator\.ai\REVIEW_PACKET.md` e `C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\E134_phase1_red_review.md`.
EXPECTED_PASS = Reviewer autoriza a correção de representação interna em ticks efetivos escalados.
EXPECTED_FAIL = Reviewer rejeita a semântica contínua de escala; nesse caso não corrigir por heurística.
IF_PASS = Implementar menor correção e rodar validações E134 antes de B11.
IF_FAIL = Manter B11/B12/promoção bloqueados e registrar decisão.

WHAT_CHANGED_THIS_TURN = Adicionados apenas `include/hw/timer/esp32_timg_wdt_scale_math.h`, `tests/unit/test-esp32-timg-wdt-scale.c` e registro Meson; esses arquivos provam RED, mas ainda não mudam produção. Atualizados `.ai` e `REVIEW_PACKET.md`.
OPEN_PROBLEMS = Correção semântica não aplicada; ring ainda não possui endereço CONFIG/old-new/CPU/PC guest; B11 permanece aberto.
DO_NOT_CHANGE = transporte, cache-wait, scheduler, firmware produção, ABI, filas, backpressure, topologia MTTCG, escala default/cap, timeouts guest, alimentação sintética, `QEMU_RUNTIME.json`.
DO_NOT_REPEAT = Não iniciar B11 antes do review/correção/validações; não chamar host load de refutação; não aumentar scale; não ignorar expiração; não promover runtime.
FILES_TO_INSPECT_FIRST = `orchestrator\.ai\REVIEW_PACKET.md`; `vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\E134_phase1_red_review.md`; `C:\SourceCode\qemu_lasecSimul\hw\timer\esp32_timg.c`; `C:\SourceCode\qemu_lasecSimul\include\hw\timer\esp32_timg_wdt_scale_math.h`; `C:\SourceCode\qemu_lasecSimul\tests\unit\test-esp32-timg-wdt-scale.c`.

FROZEN = ABI, dispatcher, ProducerLane, ResponseSlot/C2A, backpressure, watchdog/reset/scheduler beyond the specific reviewed WDT scale arithmetic, queue depth, runtime canônico.
ARTIFACTS = `C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218`.

## CURRENT HANDOFF — E133 B11 N=16 narrowed but still OPEN (2026-09-07)

CURRENT_OBJECTIVE = Fechar a causalidade remanescente do B11 N=16 antes de qualquer B12/promoção.
WHERE_I_STOPPED = E133 corrigiu somente runner/harness e consolidou evidência nova em `VNEXT_B+MTTCG`; QEMU/Core/firmware production semantics não foram alterados.
WHY_I_STOPPED = O primeiro vermelho N=16 foi estreitado, mas não fechado. Há expiração genuína TG1 seguida por reset guest de software/pânico, mas o frame/causa exata de pânico e a sessão silenciosa ainda não foram provados.
LAST_ACTION = Saneei fail-closed do runner, removi cleanup amplo de QEMU, rodei testes determinísticos 14/14, auditei B11 N=16 preservado, executei R0 mínimo, um bloco intercalado R6+Force/R0, e uma única execução diagnóstica R0 com panic/WDT/MWDT accounting/PC sampler.
LAST_RESULT = R0 mínimo passou; controle R6+Force falhou; tratamento R0/sem Force falhou; diagnóstico R0 falhou. Diagnóstico observou `tg=1 first_genuine_expiry`, `first_actual_stage_expiry`, reset `SW_CPU_RESET_REGISTER` via `SW_APPCPU_RESET`, `MWDT_ATTRIB_RESETS=0`, zero CACHEERR/Guru/reentrância/teardown-hang, frames ambíguos e sintoma separado de sessão sem workload com CPU1 em `panic_handler`.
CURRENT_BLOCKER = B11 N=16 continua aberto: falta prova exata do ponto causal entre a primeira expiração TG1 e a decisão guest de reset/pânico/sessão silenciosa.
NEXT_EXACT_ACTION = Construir prova dirigida com correlação por sessão/PID/boot_epoch/PC/amostras imediatamente anteriores ao TG1 expiry e ao `SW_APPCPU_RESET`. Se surgir necessidade de mudança QEMU/Core/firmware, preparar prova mínima e review antes de editar.
NEXT_COMMAND = Abrir `NEXT_ACTION.md` E133 e `EVIDENCE.md` E133. Usar `C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E133-b11-n16-causality_20260907_141445\E133_consolidated_result.md` como índice dos artefatos.
EXPECTED_PASS = Causalidade B11 N=16 provada ou correção mínima/review preparada com evidência antes de qualquer rerun de promoção.
EXPECTED_FAIL = Se a evidência continuar ambígua, manter B11 aberto e não promover.
IF_PASS = Só então decidir gate mínimo a rerodar antes de B12.
IF_FAIL = Não executar B12/promoção/cleanup/commit/tag/release.

FROZEN = ABI, dispatcher, ProducerLane, ResponseSlot/C2A, backpressure, watchdog/reset/scheduler, queue depth, runtime canônico, e semântica QEMU/Core/firmware até review.
DO_NOT_REPEAT = Não tratar R6+Force como causa única; não chamar o caso de MWDT direto; não usar exit code isolado; não usar logs diagnósticos como gate formal; não retry N=16 às cegas.
ARTIFACTS = `C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E133-b11-n16-causality_20260907_141445`.

## CURRENT HANDOFF — E132-F STOPPED AT B11 N=16 FIRST RED (2026-09-07)

CURRENT_OBJECTIVE = Classificar o B11 N=16 vermelho preservado antes de qualquer B12/promoção.
WHERE_I_STOPPED = Depois de E132-E, rodei a sequência pós-review estrita `VNEXT_B+MTTCG` com o QEMU candidato SHA `5E0F51664C88685EA986A2F7F975A728CD02190D05AB76EA17D9AB52A2C74F7A`. Determinísticos 8/8, RESET_WAIT 3/3, E131 6/6, duas regressões 14/14, B11 N=1/N=8/N=12 passaram. B11 N=16 foi o primeiro vermelho real.
WHY_I_STOPPED = Regra fail-closed no primeiro vermelho. N=16 retornou harness exit 1 e `b11_classify.ps1` marcou `cellPass=false`.
LAST_ACTION = Executei B11 N=16 com `RunMs=60000`, `ReserveCores=6`, `-Force` para oversubscription explícita, traces formais OFF, QEMU absoluto candidato e firmware `guest_i2c_workload`.
LAST_RESULT = FAIL: N=16 teve 16/16 sessions dumped, 16/16 JSONL, `sessionsWorkloadPass=13/16`, `totalUnexpectedResets=14`, `MWDT_ATTRIB_RESETS=0`, zero `CACHEERR`/`exccause=7`, zero `Guru Meditation Error`, zero `Blocked re-entrant IO`, zero `TEARDOWN_HANG`, teardown limpo e zero QEMU órfão. Sessões 7/9/12 ficaram `submissions=0/completions=0`; sessões 2/5/7/9/12 contribuíram resets inesperados `SW_CPU_RESET_REGISTER` e um `RTC_RESET` na sessão 2.
CURRENT_BLOCKER = B11 N=16 vermelho de resets inesperados/3 workloads sem progresso; causa ainda não classificada. Não é comprovadamente MWDT/CACHEERR/reentrância/teardown.
NEXT_EXACT_ACTION = Investigar o artefato `...\phase_next_B11_formal\N16` comparando com N=12/N=8: reset source/session/boot_epoch/PCs, JSONL por sessão, stderr por bloco `SUCCESS_QEMU_LOG`, e diferenças de progresso. Não retry N=16 antes dessa classificação.
NEXT_COMMAND = Abrir `NEXT_ACTION.md` E132-F e `EVIDENCE.md` E132-F. Começar por `C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E132-post-review_20260907_113506\E132-E_session_restart_oracle_20260907_123456\E132F_post_review_resume_summary.json`.
EXPECTED_PASS = Classificação causal honesta do N=16 com separação entre comprovado em log/JSONL e hipótese pendente.
EXPECTED_FAIL = Se a causa exigir mudança de produção, preparar prova mínima antes de editar; se for harness/oráculo, sanear e rerodar somente o menor teste causal.
IF_PASS = Só após classificação/revisão, decidir se há correção e qual gate rerodar.
IF_FAIL = Não promover; manter B12/release bloqueados.

FROZEN = ABI, dispatcher, ProducerLane, ResponseSlot/C2A, backpressure, watchdog/reset/scheduler, queue depth e runtime canônico.
DO_NOT_REPEAT = Não usar linhas de tradução TCG como prova de execução; não usar task FreeRTOS pós-reset como oráculo; não aceitar exit code isolado.
ARTIFACTS = `C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E132-post-review_20260907_113506\E132-E_session_restart_oracle_20260907_123456`; B11 N=16 em `...\phase_next_B11_formal\N16`.

Single entry point for this work. Read this file first, then only the sections
of `STATUS.md` / `EVIDENCE.md` it points you at. Everything else in this folder
is supporting detail.

Last consolidated: **2026-09-03** (full re-audit of the `.ai` notebook against
source and fresh measurements).

---

## 1. What are we trying to solve?

Finish the production **VNEXT_B ESP32 integration** so that roughly 16 isolated
QEMU sessions run on one shared classroom host without losing ESP32
functional/timing fidelity. Definition of done is `FINAL_CHECKLIST.md`.

Almost all of that checklist was already green before this consolidation. The
work had been stuck for weeks on **one** remaining behavioural gate:

```text
ESP32_MWDT_BEHAVIOR  - fed survives load; unfed still resets
ESP32_MWDT_LOAD_INDEPENDENCE
```

## 2. What is the state right now?

**Device level: both MWDT gates PASS.** Proven with a framework-free bare-metal
fixture (E097-E101), reproduced on the rebuilt binary.

**Production Core/VNEXT_B path: still OPEN, but the picture is now clear.**

Two real defects were found and fixed, and the fixes are **built, staged and
regression-tested** (the earlier "no C toolchain" blocker is closed - MSYS2
UCRT64 is installed at `C:\SourceCode\tools\msys64`):

- `softmmu/vnext_b.c` emitted an unconditional, unbounded `fprintf(stderr)` on
  the lane-credit backpressure path, positioned *before*
  `esp32_timg_transport_pause(lane, true)` so its host time was charged to the
  guest watchdog instead of credited back (E102).
- `hw/i2c/esp32_i2c.c` had two unconditional per-operation `ackERR` writes -
  the ones `STATUS.md` and `DECISION-003` both recorded as already fixed - plus
  an unbounded empty-FIFO report (E103).

Together those three sites produced **99.97% of all QEMU output**. After the
fix, a 16-session run emits ~2,600 lines instead of 258,247, and the decisive
consequence is that **every session's reset records now survive Core's 1 MiB
retained log** instead of being evicted. That is why earlier investigations kept
finding logs with no reset evidence in them (E045, E051).

**But the watchdog resets did not go away**, so E102's causal hypothesis is
refuted (E105):

```text
sessions   MWDT-attributed resets
   1, 4, 8    0
  12          2
  16          4, 0, 6, 4, 4     (five runs)
```

Clean through 8 sessions; intermittent from 12 upward. The remaining suspect is
host CPU oversubscription in MTTCG-realtime - `QEMU_CLOCK_VIRTUAL` follows wall
time while emulated throughput does not - not the transport and not the
diagnostics. **Unproven**; see section 8.

Regression status: the same ten Core tests give **identical results** on the
patched and pre-patch binaries (7/10, three pre-existing failures), so the
fixes introduce nothing new (E106).

### Why it stayed stuck for weeks

None of that was visible earlier, because the investigation could not run the
experiment at all. It was a **test-vehicle problem**: there was no guest
firmware that could be trusted to *not* feed the watchdog.
Every earlier attempt used the Arduino or ESP-IDF framework, which owns and
feeds `TIMG_WDT` itself, so no "unfed" precondition could ever be established
(E060-E063). Trying to build a framework-free ESP-IDF fixture then consumed
**iterations 61-90 (~30 iterations over two days) entirely on Python packaging**
and produced zero watchdog evidence.

The fix was to stop needing a framework at all. See section 4.

## 3. What was already settled before this (do not redo)

Closed and reviewer-approved: `PRODUCTION_SESSION_FAILURE_ISOLATION`,
`PRODUCTION_COMBINED_WORKLOAD`, `SHARED_DISPATCHER_FAIRNESS`,
`FINAL_RESOURCE_ACCOUNTING`, `VNEXT_PRODUCTION_TCG_CONFIGURATION`,
`FINAL ABI ALIGNMENT`, `VNEXT_LEGACY_DEPENDENCY_AUDIT`,
`ESP32_SUPPORT_MATRIX_AUDIT`, `VNEXT_TRACE / HOT-PATH DIAGNOSTIC I/O`.

Frozen architecture (`PROJECT_CONSTITUTION.md`) is unchanged and was **not**
touched by this work: ABI v5, dispatcher, ProducerLane, ResponseSlot/C2A,
backpressure, watchdog/reset policy, queue depth, canonical runtime, rollback
artifact, Git history.

## 4. The thing previous agents missed

Three facts, all verifiable in this repository, none of which required any
Python, ESP-IDF, or PlatformIO runtime:

1. **`hw/xtensa/esp32.c:1140-1172` implements a `-kernel <elf>` boot path.**
   It loads an ELF and sets the architectural entry point directly, bypassing
   the ROM and second-stage bootloader. `esp32_soc_reset` re-applies
   `elf_entry` on every reset, so a bare-metal ELF also survives reboots.
2. **A working bare-metal Xtensa build already existed in the repo**
   (`vnext_prototype/guest_i2c_baremetal`). It needs only
   `xtensa-esp32-elf-gcc` + `objcopy` from
   `.piohome/packages/toolchain-xtensa-esp32`, which are present and working.
   Build time: about 2 seconds.
3. **`-M esp32-simul` runs standalone.** It skips the `serial0/1/2` chardev
   properties that the plain `esp32` machine requires (and which this fork does
   not declare), and with no arena mapped `m_arena` is `NULL`, so `simu_event`
   and `waitForSynch` return immediately. No Core, no shared memory, no session.

Together these give a deterministic, framework-free MWDT oracle that builds in
seconds. That is the vehicle the investigation lacked for four weeks.

## 5. Evidence that the gates now pass

Fixture: `vnext_prototype/guest_mwdt_baremetal` (fixture source, build and
runner scripts; see its `README.md`). All runs use the canonical QEMU
`dev_qemu_runtime\qemu-system-xtensa.exe`, `-accel tcg,thread=multi`,
`LASECSIMUL_ESP32_WDT_SCALE=1` (literal timing, the strictest case), and the
opt-in watchdog traces **off** (see section 6).

Three-arm experiment at the 16-session classroom population, 180 s window:

| Arm | Guest behaviour | MWDT resets | Instances resetting |
|---|---|---|---|
| `tg0_unfed` - negative control | configure, never feed | 82 | **16/16** |
| `tg0_fed_then_starve` - validity | configure, feed 3000x, then starve | 78 | **16/16** |
| `tg0_fed` - positive | configure, feed forever | **0** | **0/16** |

The validity arm is byte-identical to the positive arm up to and including the
instruction that enables the watchdog; only the feed budget differs. All 16 of
its instances armed and reset, so the positive arm's zero cannot be a guest
that never ran. That is the check every previous "PASS" lacked.

Single-instance reset routing, 40 s window each:

| Variant | MWDT resets | `cause0` |
|---|---|---|
| `tg0_unfed` | 10 | 7 = `ESP32_TG0WDT_SYS_RESET` |
| `tg1_unfed` | 10 | 8 = `ESP32_TG1WDT_SYS_RESET` |
| `tg0_fed` | 0 | - |
| `tg1_fed` | 0 | - |

## 6. Two measurement hazards found on the way

**H1 - the opt-in watchdog traces cost about 2 s per line and destroy timing.**
With `LASECSIMUL_TG0_WDT_TRACE=1`, the host gap between two *adjacent guest
store instructions* was median **2.23 s** (min 0.91 s, max 4.63 s). Because
`QEMU_CLOCK_VIRTUAL` tracks wall time in MTTCG-realtime, a 1 s watchdog
deadline fired at **12.7 s of virtual time**. The same fixture with traces off
produced 10 resets in 40 s.

Consequence: **every timing number in `EVIDENCE.md` collected with
`LASECSIMUL_TG0_WDT_TRACE` / `LASECSIMUL_TG1_WDT_TRACE` / `LASECSIMUL_VNEXT_TRACE`
enabled is invalid as a timing measurement** - E062's "TG1 feed at 1.65 s,
expiry at 2.15 s" among them. Use the unconditional `[LasecSimul][ESP32 reset]`
line and the harness counters instead. This is the quantification of the hazard
`PROJECT_CONSTITUTION.md` already listed qualitatively.

**H2 - `qemu_init` costs about 7 s per instance before any guest code runs.**
Measured, traces off: first stderr output at 0.4 s, `[ESP32 reset] count=1` at
5.0 s, `count=2` at 6.9 s, first guest-caused watchdog reset at 10.2-12.7 s.
Process spawn itself is 0.03 s, so this is machine construction, not image
loading. `-m 0` does not help.

This is a strong candidate explanation for the historical `ADMISSION_1`
timeouts (E015-E019, E039-E051): failure isolation admits sessions **serially**
with a fixed 120 s per-session deadline
(`VnextBProductionScaleTest.cpp:311-331`), and 16 x 7 s = 112 s of pure QEMU
construction sits inside that budget before any I2C submission can happen.
**Not yet proven** - see section 8.

## 7. Do not repeat

- Do not build an ESP-IDF or Arduino fixture to test watchdog *hardware*
  behaviour. The framework owns and feeds `TIMG_WDT`; that is what defeated
  E060-E063. Use `vnext_prototype/guest_mwdt_baremetal`.
- Do not resume the CPython 3.8/3.10 MSI assembly route. It is closed. See the
  postmortem in `CLOSED_HYPOTHESES.md`.
- Do not use the opt-in TG/VNEXT traces to measure time. See H1.
- Do not run more than a few concurrent QEMU instances unconstrained. The
  fixture guest never idles; an unconstrained 32-instance run froze this host
  and forced a power-off, which corrupted an in-flight build. See DECISION-010;
  the runners now cap priority and affinity for you.
- Do not `git checkout` a file in the QEMU worktree to undo an edit.
  `softmmu/vnext_b.c` is untracked and several tracked files carry
  pre-existing uncommitted work; reverting through git destroys it.
- Do not audit "hot-path diagnostic I/O" by grepping for one tag. E032/E033
  checked `[VNEXT_PROBE]` and closed the gate; the unconditional `[VNEXT_B]`
  writes in the generic publish path survived that audit for weeks (E102).
- Do not declare a scale run PASS without a validity arm proving the guests
  actually reached the condition under test. A first attempt here reported
  "0 MWDT resets at 16 sessions" that was pure startup starvation: the guests
  never booted inside the window. The negative control caught it.

## 8. What is still open

1. **Why a fed guest still takes MWDT resets at 12+ sessions.** The leading
   hypothesis is host CPU oversubscription (16 sessions x 2 vCPU threads on 26
   usable cores), not the transport. Testing it means fixed populations against
   varying core budgets. Note that raising `wdt_time_scale` past its cap of 100
   would be a watchdog semantic change, frozen by DECISION-004 - request review
   before touching it.
2. **`vnext_b_production_scale_test` never exits for more than one session**
   (E104). It hangs in `stopSimulation()` teardown at
   `VnextBProductionScaleTest.cpp:697`. Pre-existing - reproduced on the
   pre-patch binary. Measurements are unaffected because the measurement loop
   completes first; `run_production_mwdt.ps1` works around it.
3. **Three pre-existing Core test failures** (E106): `mcu_component_test`,
   `mcu_controller_real_qemu_test`, `qemu_icount_calibrator_test`. The Debug
   test binaries date from 2026-08-26..30 and are stale against the current
   headers; rebuilding them needs MSVC, which is not installed (only the MSYS2
   toolchain for QEMU was added).
4. **H2 root cause.** The ~7 s per-instance `qemu_init` cost (E100) is measured
   but not attributed, and its link to the historical `ADMISSION_1` timeouts is
   a hypothesis.
5. **High backpressure rate.** ~400 lane-credit-exhaustion events per second
   for a single session (E102); at N=8 there are none at all (E105). Whether
   that is normal credit-window cycling was not investigated.
6. Remaining unticked items in `FINAL_CHECKLIST.md`.
7. Intermittent `0xC0000409` / FATAL_APP_EXIT - unchanged, still unreproduced.

## 9. Where things are

| What | Path |
|---|---|
| MWDT fixture + runners | `vnext_prototype/guest_mwdt_baremetal/` |
| Fixture run logs | `vnext_prototype/guest_mwdt_baremetal/runs/` |
| Canonical QEMU runtime | `vnext_prototype/dev_qemu_runtime/qemu-system-xtensa.exe` |
| QEMU source | `C:\SourceCode\qemu_lasecSimul` (branch `main`, dirty) |
| Xtensa toolchain | `.piohome/packages/toolchain-xtensa-esp32/bin` |
| Production scale harness | `core/test/core/mcu/VnextBProductionScaleTest.cpp` |
| Watchdog device model | `qemu_lasecSimul/hw/timer/esp32_timg.c` |
| ELF boot path | `qemu_lasecSimul/hw/xtensa/esp32.c:1140-1172` |

`QEMU_RUNTIME.json` holds the canonical runtime hash and provenance.
# QEMU handoff — E137 recurrence review required (2026-09-08)

Work item: E137 directed recurrence investigation for the rare B11 N=16
panic/reset signature under `VNEXT_B+MTTCG`.

Current state: **REVIEW_REQUIRED**. Do not promote runtime, run B12, update
`QEMU_RUNTIME.json`, or change QEMU semantics.

E137 artifact:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E137-cacheerr-signature-recurrence_20260908_053314`.

Classification:
`B11_N16_PANIC_RESET_RECURRENCE_REPRODUCED_FRAME_UNPROVEN_REVIEW_REQUIRED`.

Key facts:

- candidate used directly:
  `3D951D7C7A83578DED9FA20E7B9F0E0BABA705025C05618E90DCB079693A96F6`;
- canonical rollback runtime preserved:
  `B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`;
- firmware preserved:
  `merged.bin` `1DA8BF731830B2D2D9CE6EDBB0EA208636A1DB2A79497A8DB0CC98D72864C76A`,
  `firmware.elf` `1697587B58F9DF862765ADABC2F5A2E74387863438D8A6DF775196A542C9D9B6`;
- attempt 1 panic-only PASS;
- attempt 2 panic-only FAIL, campaign stopped;
- sessions 6 and 14 reproduced terminal `SW_SYS_RESET` followed by unexpected
  `RTC_RESET` and `SW_CPU_RESET_REGISTER`, but both cores had
  `g_exc_frames=NULL`;
- no `exccause=7`, `PANIC_RSN_CACHEERR`, frame CPU, vaddr, or exact E129
  predicate failure is proved.

Recommended next action for review: authorize a bounded, opt-in, memory-only
cache/wait/reset causal ring with terminal dump, then rerun only enough B11 N=16
to capture the missing frame/predicate. Do not repeat blind sampling.

# QEMU handoff — E134 closure review pending (2026-09-07)

Work item: E134 watchdog scale/reanchor fix for `VNEXT_B+MTTCG`.

Current state: implementation complete, validation GREEN so far, closure review
required before B12/promotion. Do not promote runtime or run B12 until
`orchestrator\.ai\REVIEW_PACKET.md` is approved.

Important artifacts:

- E134 directory:
  `C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218`
- Candidate QEMU:
  `...\candidate_qemu\qemu-system-xtensa.exe`
- Candidate SHA256:
  `3D951D7C7A83578DED9FA20E7B9F0E0BABA705025C05618E90DCB079693A96F6`
- Production firmware snapshot:
  `...\firmware_snapshot`
- Review packet:
  `orchestrator\.ai\REVIEW_PACKET.md`

Changes to audit:

- `C:\SourceCode\qemu_lasecSimul\include\hw\timer\esp32_timg_wdt_scale_math.h`
- `C:\SourceCode\qemu_lasecSimul\hw\timer\esp32_timg.c`
- `C:\SourceCode\qemu_lasecSimul\tests\unit\test-esp32-timg-wdt-scale.c`
- `C:\SourceCode\qemu_lasecSimul\tests\unit\meson.build`
- `C:\SourceCode\qemu_lasecSimul\net\slirp.c` (minimal QAPI `StringList`
  build compatibility only)
- `C:\SourceCode\LasecSimul\vnext_prototype\guest_mwdt_diagnostic\sdkconfig.esp32`
  (fixture-only build repair)

Validation already run:

- QEMU build PASS.
- WDT deterministic helper tests PASS 13/13 direct and Meson.
- `VNEXT_B+MTTCG` regression PASS 14/14 twice.
- B11 N=1, N=8, N=12 PASS; N=16 PASS 3/3.

Known limitation: no-feed MWDT fixture attempts produced no observable
stdout/stderr; do not claim integrated later-expiry proof from those runs.
