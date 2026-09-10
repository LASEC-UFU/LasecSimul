# STATUS - Current authoritative state

## E145 — H143 fechada para Release; capacidade MTTCG segura calculada e imposta em produção; RESET_WAIT/E131 bloqueados por oráculo pré-existente incompatível com a limpeza E141; B12 NÃO executado (2026-09-09, ~06:32-07:20)

Resultado atual: **REVIEW_REQUIRED — H143 FECHADA; GUARDA DE CAPACIDADE ENTREGUE EM PRODUÇÃO; B12 NÃO TENTADO**.

Confirmei em código, antes de qualquer teste, que a correção H143 (E143/E144)
continua conectada ao caminho de produção real
(`McuComponent::pollAndDispatchPendingEvents()` chama
`qemu::decidePostAckRearm()` diretamente). Auditei o caminho de lançamento
de produção (`McuController::start()`) e confirmei que **não existia
nenhuma guarda de capacidade** ali — só o runner de teste tinha uma
(`run_production_mwdt.ps1`, desde E133/DECISION-010). Implementei uma:
`safe_sessions = floor((processadores_lógicos - reserva) / vCPUs_por_sessão)`,
calculado a partir da topologia REAL do host (`std::thread::
hardware_concurrency()`, nunca uma constante fixa desta máquina) — neste
host, `floor((32-6)/2) = 13`. A guarda rejeita, ANTES de criar qualquer
processo QEMU, uma nova sessão que ultrapasse esse teto, com uma válvula de
escape só-experimental (`LASECSIMUL_VNEXT_B_CAPACITY_OVERRIDE=1`) nunca
usada por nenhum runner/gate/config deste repositório. 20/20 testes puros
passam (12 do H143 + 8 novos da guarda: abaixo do limite, exatamente no
limite, acima do limite, casos de borda, e uma topologia DIFERENTE
provando que a fórmula não está fixa nesta máquina).

Quatro execuções completas de 15 ciclos do `session_restart_stress_test`
em Release: 2/4 limpas (15/15), 2/4 com 1-2 falhas SÓ nos ciclos iniciais
(0 e/ou 1) — em TODAS elas `m_pollGeneration=0` (zero tempestade H143) e
90-100% da lane real drenada, ou seja, estruturalmente NÃO é H143: é um
achado novo, separado, mais estreito, ainda não caracterizado antes desta
etapa. Duas regressões completas `VNEXT_B+MTTCG` em Release: 14/14 nas
duas. B11 (Release, `-Force` nunca usado): N=1 teve uma falha intermitente
(mesmo formato do achado do restart-test, resolvida na repetição) e depois
PASSOU; N=8 PASSOU 8/8; N=12 PASSOU 12/12; **N=13 (o teto seguro calculado
para este host) NÃO foi executado** — ao ser informado de que a máquina
havia travado de novo durante o planejamento desta própria etapa, o
usuário, questionado explicitamente, escolheu pular o B11 N=13 nesta
etapa em vez de tentar o caso limite de novo imediatamente.

**RESET_WAIT/E131 não puderam ser validados**: o oráculo do
`cache_wait_e2e_real_qemu_test.exe` depende de variáveis de diagnóstico do
lado QEMU (`LASECSIMUL_E131_TCG_TRACE` e mais 3) e de grep no log do QEMU
por marcadores que esses diagnósticos produziam — as quatro confirmadas
ausentes em toda a árvore `qemu_lasecSimul` (removidas corretamente pelo
E141). O PASS histórico do E131 no E132-E usou um QEMU DIFERENTE, anterior
ao E141, ainda com esses diagnósticos. Esta é a primeira vez que o
E131/RESET_WAIT roda contra o candidato E141 — e revela uma incompatibilidade
de oráculo/harness, NÃO uma regressão funcional, NÃO causada pelo H143.
Não corrigido nesta etapa (fora de escopo: reabrir E131 como investigação
exploratória e reintroduzir traces removidos são ambos proibidos
explicitamente).

Pela própria regra da tarefa, **B12 NÃO foi tentado**: a Fase 3 está
bloqueada estruturalmente e a célula N=13 da Fase 5 não foi executada.
Nenhuma edição de `QEMU_RUNTIME.json`, promoção, cleanup, commit, push, tag,
release ou package. Zero QEMU órfão em todo checkpoint, inclusive durante
um segundo travamento do host que ocorreu no PLANEJAMENTO desta etapa
(antes de qualquer comando N=13 ser emitido — `-Force` nunca foi usado
nesta etapa). Ver `EVIDENCE.md`/`TEST_GATES.md`/`NEXT_ACTION.md` para o
relato completo.

## E144 — classificação corrigida (E132-E era Release, E142/E143 eram Debug); H143 restaurada e validada; gate formal Release chega a 15/15; B11 N=16 parou em 1/3 por segurança de host após um travamento (2026-09-08/09, ~18:48-19:25)

Resultado atual: **REVIEW_REQUIRED — H143 CORRIGIDA E VALIDADA NO RELEASE;
B11 N=16 INCOMPLETO POR TRAVAMENTO DE HOST; RESET_WAIT/E131 NÃO
REEXECUTADOS**.

Confirmei diretamente nos artefatos preservados (não por memória): o
"session_restart_stress_test 15/15" histórico do E132-E rodou build
**Release** (`build_manifest.json`: `/p:Configuration=Release`). Todo o
E142/E143 vinha recompilando e rodando **Debug**, sem perceber a
discrepância. Isso NÃO reabre a conclusão do E142 sobre a limpeza E141
(continua corretamente refutada — Core pré/pós-limpeza falhava igual em
Debug, isso permanece verdade) — mas significa que a classificação
"sempre vermelho" do E142/E143 estava incompleta: era vermelho em Debug
especificamente. Reli `PLAN_MTTCG_VNEXT_B_CAUSALITY.md` seção 10.4 passo 5
e seção 10.2: o mecanismo H143 viola ambas literalmente — um bug real,
independente de qual configuração de build não é bloqueada por ele hoje.

Baseline Release ANTES de qualquer edição: 3/3 PASS (1 ciclo) mesmo com o
bug H143 ainda presente — confirma que Release simplesmente não é travado
pelo busy loop hoje (rápido o bastante pra atravessá-lo), enquanto Debug é.
Restaurei a correção H143 em `McuComponent.cpp` reusando
`decidePostAckRearm()` do E143 (sem mudança de desenho, 12/12 puros
continuam verdes em Release). Rebuild completo (full relink) Debug e
Release.

Pós-correção: `session_restart_stress_test` Release, ciclo default de 15,
**15/15 PASS**, batendo exatamente com o histórico do E132-E, zero órfão.
Série temporal em Debug (30s, amostragem 250ms): `Scheduler::nowNs` avança
em TODAS as amostras, nunca fica travado por 2s ou mais — Debug é **lento,
não travado**. Adicionei auto-relato `HARNESS_BUILD_CONFIG=Debug/Release` e
gate fail-closed `LASECSIMUL_REQUIRE_RELEASE=1` (verificado: rejeita Debug
imediatamente, antes de subir QEMU).

Validação: `vnext_b_arbiter_test` 12/12 (Release); `vnext_b_attachment_test`
Release 3/3 execuções, 33/33 cada; duas regressões completas
`VNEXT_B+MTTCG` 14/14 cada; B11 N=1 PASS (submissions=1869=completions);
B11 N=8 PASS (8/8 sessões); B11 N=12 PASS (12/12 sessões) — todas com
`MWDT_ATTRIB_RESETS=0`.

**B11 N=16 chegou a 1 das 3 execuções exigidas.** A execução 1 passou limpa
(16/16 sessões, 32/32 resets, 0 atribuídos a MWDT). Ao iniciar a execução 2
imediatamente em seguida (mesmo padrão `-Force` de 32 slots de vCPU sobre
26 núcleos utilizáveis, sem intervalo de descanso), **o computador travou
por completo e o usuário precisou resetar a máquina manualmente**. Isto
bate exatamente com o incidente já documentado no próprio cabeçalho do
`run_production_mwdt.ps1` ("an unconstrained 16-session run is what froze
this host on 2026-09-03"). Após a recuperação: zero processo QEMU/teste
órfão, CPU ociosa (~0,5%), sem memória descontrolada, e todos os arquivos
editados nesta etapa verificados íntegros (sem corrupção). **Não tentei
novamente o B11 N=16 nesta sessão** — uma execução limpa é a evidência
obtida; uma segunda/terceira tentativa exige invocação mais segura
(intervalo real entre rajadas, menos sessões, ou margem real de
`ReserveCores` em vez de `-Force`) ou autorização explícita e consciente do
risco antes de tentar de novo nesta máquina.

`RESET_WAIT` (3/3) e a bateria completa `E131` (6/6) — QEMU-side, já
fechadas no E132-B, binário QEMU inalterado — NÃO foram reexecutadas nesta
etapa (correção é somente Core, fora do raio de alcance desta correção,
sinalizado explicitamente em vez de assumido).

Nenhum B12, promoção, edição de `QEMU_RUNTIME.json`, cleanup, commit, push,
tag ou release foi executado. Canônico (`B375A9E8...`) intocado. Ver
`EVIDENCE.md`/`TEST_GATES.md`/`NEXT_ACTION.md` para o relato completo.

## E143 — H143 confirmada em parte (storm real, eliminado), mas insuficiente para restaurar o avanço; correção revertida por regra explícita da própria tarefa (2026-09-08, ~18:40)

Resultado atual: **STOP — H143 REFUTADA COMO EXPLICAÇÃO ÚNICA/COMPLETA; CORREÇÃO REVERTIDA; CAUSA MAIS PROFUNDA AINDA NÃO IDENTIFICADA**.

Auditei `McuComponent::pollAndDispatchPendingEvents()` antes de qualquer
teste: o bloco pós-ack (`hasPendingLaneEvents() && !budgetExhausted ->
scheduleNextPoll()`, sempre `now+1ns`) realmente não distingue "cabeça
pronta" de "cabeça ainda futura" — confirma H143 exatamente. Extraí uma
função pura (`VnextBArbiter::decidePostAckRearm()`), criei uma simulação
determinística em processo (sem QEMU) na MESMA escala de nanossegundos que
o E142 mediu de verdade (gap de ~55.000.000ns) — RED: política antiga trava
em `finalNowNs=250.002.000` após 2000 iterações, nunca alcança o deadline
real (305.000.000); GREEN: política nova converge em 1 iteração, consome
exatamente uma vez em `finalNowNs=305.000.000`. Mais 11 testes puros
cobrindo toda a matriz da Fase 4 — 12/12 verdes.

Apliquei a correção em produção e testei contra o QEMU real (candidato
`475C0FC9...`) três vezes: `m_pollGeneration=0` nas três (a tempestade de
callbacks desapareceu por completo, confirmando que o mecanismo H143 é
real) — mas `Scheduler::nowNs` continuou sem alcançar o deadline real de
~305ms em nenhuma das três execuções (217,6ms / 150,8ms / 185,6ms medidos),
e `submissions=0/0 completions=0/0` persistiu nas três. Pela própria regra
explícita da tarefa ("impedir somente o now+1ns não restaurar o avanço" ->
parar, H143 refutada, nenhuma correção deve ser aplicada), **revertei a
correção em `McuComponent.cpp`** — confirmado exato recompilando e
reproduzindo a tempestade original (`m_pollGeneration=956`) mais uma vez.

Mantive em árvore (inertes, corretos, não usados por nenhum caminho de
produção após a reversão): a função pura `decidePostAckRearm()` em
`VnextBArbiter.hpp` e toda a suíte RED/GREEN em `VnextBArbiterTest.cpp`
(12/12 verdes) — prontas para serem religadas assim que a causa mais
profunda for identificada. NÃO toquei `Scheduler.cpp`/pacing nem
`scheduleEventUnlocked()`, por regra explícita (nenhum RED isolado provou
lost wake ali especificamente). Zero QEMU órfão em todo checkpoint. Ver
`EVIDENCE.md`/`TEST_GATES.md`/`NEXT_ACTION.md` para o relato completo.
Nenhum B11/B12/promoção/cleanup/commit/push/tag/release foi executado.

## E142 — bisseção causal: a regressão do session_restart_stress_test NÃO é da limpeza E141; defeito real, pré-existente, ainda não corrigido (2026-09-08, ~18:10)

Resultado atual: **STOP — HIPÓTESE DA LIMPEZA E141 REFUTADA; DEFEITO REAL PRÉ-EXISTENTE, SEM CORREÇÃO AUTORIZADA NESTA ETAPA**.

Seguindo exatamente a metodologia pedida (Fase 0-3): reconstruí o Core
pré-limpeza numa árvore descartável (`git worktree` + `pre_lasecsimul_full_diff.patch`
+ arquivos não rastreados preservados, sem stash/reset/checkout na árvore
principal) e comparei lado a lado, no MESMO ambiente (mesmo QEMU candidato
`475C0FC9...`, mesmo firmware, mesma prioridade/afinidade de DECISION-010),
contra o Core pós-limpeza atual. **Os dois falharam exatamente da mesma
forma**: `session_restart_stress_test` enche a lane 0 até a profundidade
configurada (`write_seq=8`) e o Core nunca drena nem um evento
(`read_seq=0`) durante toda a janela de 5s, sempre. Pela própria regra da
tarefa ("se ambos falharem, pare... não atribua a limpeza"), a hipótese de
que a limpeza E141 causou esta regressão está **refutada**.

Localizei a fronteira exata com instrumentação somente-leitura (dois
acessores de teste novos, inertes, sem stderr/env var/mudança de
comportamento — `vnextBAttachmentForTesting()`, `laneRingSeqForTesting()`):
o primeiro evento real do guest fica em `timestamp_ns≈305ms`
(relativo ao QEMU), o `VnextBArbiter` classifica corretamente como "ainda
não pronto" porque o `nowNs()` do `Scheduler` do Core nunca ultrapassa
~234-251ms na janela inteira — mesmo `McuComponent::pacingPositionNs()`
(o piso de avanço, via heartbeat) reportando ~4,03s, ou seja, o pacing NÃO é
o gargalo. Duas hipóteses de mecanismo real foram lidas no código mas **não
confirmadas experimentalmente** (registradas em `EVIDENCE.md`, entrada
E142): `Scheduler::scheduleEventUnlocked()` nunca chama
`signalWorkAvailable()` (diferente de todo outro ponto de entrada de
agendamento no mesmo arquivo); e a interação do throttle de pacing em
tempo real com deferimentos repetidos de evento futuro. Nenhuma correção foi
tentada — fora do escopo desta etapa assim que a atribuição à limpeza E141
foi refutada.

`vnext_b_attachment_test` (33/33), as duas regressões 14/14 anteriores e os
5 testes determinísticos do QEMU continuam verdes e não afetados — este
defeito é específico do pipeline de despacho de produção real sob o cenário
de restart-stress com firmware real.

Árvore principal restaurada e verificada por SHA-256 contra backup
pré-swap; `session_restart_stress_test` e `vnext_b_attachment_test`
recompilados limpos (0 avisos/0 erros) no estado final; zero QEMU órfão em
todo checkpoint. Ver `EVIDENCE.md`/`TEST_GATES.md`/`NEXT_ACTION.md` para o
relato completo. Nenhum B11/B12/promoção/cleanup/commit/push/tag/release foi
executado.

## E141 production-clean — attachment-test re-oracle DONE and green, but a new real regression found in session_restart_stress_test; STOP (2026-09-08, ~17:15)

Resultado atual: **STOP — VERMELHO FUNCIONAL FORA DO ESCOPO AUTORIZADO**.

Desde a entrada anterior (mesma sessão, ~15:10): sob a autorização explícita
`APPROVE_TEST_ORACLE_REPLACEMENT_ONLY` (restrita a
`core/test/core/mcu/VnextBAttachmentTest.cpp`), todo oráculo dependente de
`[VNEXT_B_STARTUP]`/`LASECSIMUL_VNEXT_STARTUP_TRACE` naquele arquivo foi
auditado e substituído por estado ABI/funcional já existente (estado de
lifecycle, `artifact_state`, watermark do heartbeat R3c, ocupação real do
ring, `artifact_progress_ns`) — zero log novo, zero contador de produção
novo, zero campo ABI novo, zero hook em caminho quente, zero reintrodução do
tracer removido. **PASS: 3/3 execuções limpas, 33/33 subtestes em cada uma,
zero QEMU órfão.** Um bug de ordenação no meu primeiro rascunho (checagem de
"sinal RUNNING repetido" rodando depois de `dataAttachment.stop()`, contra um
attachment já morto) foi encontrado via diagnóstico de valores no próprio
teste e corrigido. Os 5 testes determinísticos do QEMU e duas regressões
completas `VNEXT_B+MTTCG` (14/14 cada, SHA confirmado) também passaram depois
disso, contra o mesmo candidato.

Ao prosseguir para o próximo passo da sequência de validação do usuário
(`session_restart_stress_test`), encontrei um **vermelho novo, real e fora do
escopo desta autorização**: 15/15 ciclos com firmware real "TRAVOU NO MEIO" —
`submissions=0/0 completions=0/0 artifact_progress=0/0` durante toda a janela
de 5s de cada ciclo, apesar de o próprio QEMU mostrar um boot normal (ROM/APP
carregando, sequência de reset ESP32 correta, Scheduler com atividade real de
tempo virtual). Isolei a variável com quatro checagens somente-leitura antes
de classificar: (1) o mesmo teste, mesmo firmware, apontado para o candidato
E139 já preservado e re-verificado byte-idêntico
(`8F7F7A334FFA17A6B8FC080EB75F70BD9D85EBECFB3F07A1BCC2A6995BF612AD`) falha do
mesmo jeito; (2) o firmware está inalterado (SHA confere com o registrado);
(3) o fonte do teste `SessionRestartStressTest.cpp` está byte-idêntico à
versão E132-E já documentada como passando 15/15; (4) o log preservado desta
mesma sessão, de mais cedo hoje, mostra esse EXATO teste passando 15/15
contra esse MESMO binário QEMU E139 e esse MESMO firmware, com centenas de
submissões por ciclo. A única variável que resta é o binário Core compilado
hoje (`McuComponent.cpp`/`McuController.cpp`/`VnextBWaitDispatcher.cpp` —
todos editados durante a remoção de diagnósticos desta mesma sessão, Parte
A). Também notei que o único subteste de `VnextBAttachmentTest.cpp` que
exercita I2C com firmware real drena a lane manualmente num thread próprio do
teste, contornando de propósito `McuComponent`/`McuController`/
`VnextBWaitDispatcher` (o pipeline de despacho de produção real) — então seu
PASS não prova que esse pipeline continua funcionando.

Isto é um vermelho funcional real (contadores ABI reais, não um diagnóstico
removido) e está **fora** do escopo autorizado ("somente pelo saneamento dos
oráculos do vnext_b_attachment_test"). Não toquei em `McuComponent.cpp`,
`McuController.cpp`, `VnextBWaitDispatcher.cpp` nem em
`SessionRestartStressTest.cpp`. Ver `NEXT_ACTION.md` para a decisão
pendente. Detalhes completos em `EVIDENCE.md`, entrada E141 Partes A/B/C, e
gate correspondente em `TEST_GATES.md`.

Candidato QEMU (`475C0FC9...`) re-verificado byte-idêntico ao final desta
investigação; canônico e `QEMU_RUNTIME.json` intocados; zero QEMU órfão
confirmado (`tasklist`); nenhum B11/B12/promoção/cleanup/commit/push/tag/
release foi executado.

## E141 production-clean — Core side done too; stopped on a test-oracle dependency (2026-09-08, ~15:10)

Resultado atual: **REVIEW_REQUIRED — TEST_ORACLE_DEPENDS_ON_REMOVED_DIAGNOSTIC**.

Desde a entrada anterior (mesma sessão, ~14:05): concluída a auditoria e
remoção do lado Core (`C:\SourceCode\LasecSimul\core\src`) — `TeardownTrace.hpp`
e ~40 pontos de chamada em `McuComponent.cpp`, `McuController.cpp` (incluindo
`LASECSIMUL_VNEXT_CORE_STARTUP_TRACE`), `QemuProcessManager.cpp`,
`VnextBAttachment.cpp`, `VnextBWaitDispatcher.cpp`, `Scheduler.cpp`,
`SimulationSession.cpp`, e um ponto em
`core/test/core/mcu/VnextBProductionScaleTest.cpp` (só a chamada diagnóstica
foi removida; a asserção estrutural em volta foi preservada, não o teste
inteiro). `LASECSIMUL_MCU_TRANSPORT`, `LASECSIMUL_VNEXT_TRACE`,
`LASECSIMUL_MCU_CONSUMER_TRACE`, `LASECSIMUL_CAUSAL_TRACE` e outras variáveis
`LASECSIMUL_*` foram investigadas via `git log`/tamanho de diff e confirmadas
como funcionalidades de produto pré-existentes e committadas (não lixo de
investigação E099–E141) — preservadas sem alteração.

Achado importante: o estado de sincronização real do `VnextBWaitDispatcher`
(geração do wait-set, geração observada, callbacks em voo) estava vivendo
dentro do namespace `lasecsimul::diag`/`TeardownTrace.hpp`, mas é
funcionalmente indispensável para o contrato de drain de `unregister()`
(evita handle solto/use-after-free). Não foi apagado — foi corretamente
separado em membros de instância de `VnextBWaitDispatcher::Impl`, com nomes
não-diagnósticos, preservando exatamente a mesma semântica de sincronização.

`lasecsimul-core.lib`/`.exe` e `vnext_b_attachment_test.exe` compilam limpos
via MSBuild (0 avisos, 0 erros), recompilando exatamente os arquivos
editados.

Ao rodar `vnext_b_attachment_test` contra o novo candidato QEMU, o primeiro
subteste (P1) falhou de forma reproduzível (confirmado por retry limpo, não
é flakiness de tempo). Investigação de causa raiz (comparação controlada
contra o canônico `B375A9E8...` e contra o candidato E139 já validado em
B11; busca direta no fonte de `qemu_lasecSimul`; e o diff pré-edição
capturado às 08:33 desta manhã) **provou que isto não é uma regressão
funcional**: vários subtestes deste arquivo (pelo menos P1,
`E117_PHASE3_LIFECYCLE_ORDERING`, e subtestes de caminho de dados que leem
contadores de uart/lane por sessão) fazem parsing das linhas
`[VNEXT_B_STARTUP] transition=...` do próprio stdout do QEMU filho, geradas
por `LASECSIMUL_VNEXT_STARTUP_TRACE` — um diagnóstico que já tinha sido
corretamente removido (pela sessão E141 interrompida, antes mesmo desta
continuação começar) por ser um dos itens explicitamente nomeados na tarefa
para remoção. O canônico e o candidato E139 ainda carregam esse tracer
antigo (por isso passam os 34 subtestes, incluindo um —
`B11_DECISION_014_REENTRANCY_CONCURRENCY_PROBE` — que depende da sonda de
reentrância do lado QEMU, também já removida, e que por isso falha
corretamente contra o canônico, que já não tem essa sonda).

Isto bate exatamente com a stop condition da própria tarefa (seção 14): "um
teste depender exclusivamente de log de investigação e não houver oráculo
funcional seguro." Esta sessão não reinstalou o tracer nem corrigiu às
pressas os oráculos do teste sem revisão. Ver `NEXT_ACTION.md` para a decisão
pendente.

Candidato QEMU e binário Core preservados; zero QEMU órfão; canônico
`B375A9E8...` e `QEMU_RUNTIME.json` intocados; nenhum B11/B12/comparação/
promoção/cleanup/commit/push/tag/release foi executado.

## E141 production-clean consolidation — QEMU side complete, Core side pending (2026-09-08, ~14:05)

Resultado atual: **IN_PROGRESS — QEMU_SIDE_CLEAN_CORE_SIDE_PENDING**.

Esta é a continuação de uma sessão E141 cujos tokens acabaram no meio de uma
edição: vários arquivos-fonte do QEMU ficaram com referências pendentes a
funções diagnósticas já apagadas (não compilavam). Snapshot pré-edição
preservado em
`vnext_prototype\mttcg_causality\E141-production-clean_20260908_083000\`
(git status/diffs/hashes dos dois repositórios, fontes não rastreados
preservados em `pre_qemu_untracked_source_files\`, zero QEMU confirmado antes
de editar).

Concluído nesta continuação, somente `qemu_lasecSimul`:

- terminadas as remoções que a sessão anterior deixou pela metade: variável
  `skipCoreNotify` indefinida em `hw/char/esp32_uart.c` (bypass
  `LASECSIMUL_UART_DISABLE_CORE_NOTIFY`, agora removido — produção sempre
  notifica); `e131_tcg_trace_enabled()` chamado em `accel/tcg/translate-all.c`
  sem definição (família completa E131 TCG-trace removida de
  `translate-all.c`/`target/xtensa/translate.c`/`target/xtensa/exc_helper.c`/
  `target/xtensa/helper.h`, incluindo um hook de tempo de tradução disparando
  incondicionalmente a cada instrução); comentário órfão de
  `LASECSIMUL_MWDT_ACCOUNTING` em `util/qemu-thread-win32.c`;
- removidos diagnósticos adicionais que a sessão anterior não tinha alcançado:
  3 stubs no-op mortos `esp32_cache_trace_*` em `hw/misc/esp32_dport.c` (zero
  chamadores — removidos por inteiro, não deixados como stub);
  `LASECSIMUL_BQL_CAUSAL_TRACE` completo em `softmmu/simuliface.c` (3 pontos
  quentes: leitura de registrador, publicação de fila, burst I2C);
  contabilidade diagnóstica morta de EFUSE em `hw/nvram/esp32_efuse.c`/`.h`
  (alimentava um causal tracer de RTC já removido, zero chamadores restantes);
- encontradas e corrigidas 3 regressões funcionais reais (não diagnósticas),
  dano colateral das edições em massa da sessão anterior em
  `hw/misc/esp32_dport.c`: `#define`s do MMU de cache do DPORT, 2 forward
  declarations e as funções `get_mmu_entry()`/`set_mmu_entry()`/
  `esp32_cache_ill_write()`/`esp32_cache_ill_accepts()` tinham sido apagadas
  junto com o bloco CACHE-TRACE adjacente — restauradas literalmente a partir
  do `git show HEAD:...` após diff linha a linha para separar diagnóstico de
  funcional; completada `esp32_dport_appcpu_has_non_cache_stop()` (chamada mas
  nunca definida) usando a mesma expressão booleana já usada 3x no mesmo
  arquivo para o mesmo propósito; completada `esp32_dport_set_flash_device()`
  (setter simples, contrato já totalmente especificado no header). Também 2
  pontos em `hw/xtensa/esp32.c` onde texto literal de escape do PowerShell
  (`` `r`n ``) tinha sido gravado no fonte C em vez de uma quebra de linha
  real, quebrando o parser;
- corrigidos dois bugs reais de portabilidade Windows no sistema de build
  meson/tracetool do QEMU (`trace/meson.build` — cálculo de nome de grupo
  quebra com paths de barra invertida; `scripts/tracetool/backend/log.py` —
  path embutido em diretiva `#line` sem escapar barras invertidas, lidas como
  escapes `\u`/`\g`/`\q`), que bloqueavam qualquer reconfigure meson nesta
  máquina; limpo um `libblock.fa` obsoleto (e, defensivamente, todos os
  outros arquivos `.fa`/`.a` de topo) deixado por um `meson --internal
  regenerate` acidental que corrompeu o build e — combinado com paralelismo
  de build sem limite — travou a máquina; todos os rebuilds seguintes usaram
  `ninja -j 2`.

Resultado: `qemu-system-xtensa.exe` compila limpo (1252/1252, 0 erros), roda
(`--version` → `QEMU emulator version 8.1.3`, exit 0), SHA256
`475C0FC956E43FFC0CB83CECE0DC384457A9E1F01D2C6A3F6C21C4665C7EB23D`, preservado
em
`vnext_prototype\mttcg_causality\E141-production-clean_20260908_083000\candidate_qemu\`.
Passam os 5 testes unitários determinísticos do QEMU
(`test-esp32-dport-cache-race-stall`, `test-esp32-efuse-op-state` incluindo seu
caso `no_diagnostic_output_contract`, `test-esp32-timg-pause`,
`test-esp32-timg-wdt-scale`, `test-vnext-b-classify`). Varredura de
strings/símbolos no binário para todos os marcadores da lista mínima da seção
7 da tarefa, mais todos os removidos nesta sessão: zero ocorrências. Zero QEMU
rodando. Canônico `B375A9E8...` e `QEMU_RUNTIME.json` intocados.

Pendente: instrumentação diagnóstica do lado Core/C++
(`C:\SourceCode\LasecSimul\core\src`) — `TeardownTrace.hpp` e ~48 pontos de
chamada em `McuComponent.cpp`, `McuController.cpp`, `QemuProcessManager.cpp`,
`VnextBAttachment.cpp`, `VnextBWaitDispatcher.cpp`;
`LASECSIMUL_VNEXT_CORE_STARTUP_TRACE`; `LASECSIMUL_MCU_TRANSPORT`. Core ainda
não foi reconstruído. Nada da bateria de validação curta (seção 9), B11
N=1/8/12/16 x5, comparação (seção 11), B12 ou promoção foi executado ainda.

## E138 ROM/EFUSE reclassification — REVIEW REQUIRED (2026-09-08)

Resultado atual: **REVIEW_REQUIRED — E138_ROM_EFUSE_ROOT_CAUSE**.

Relatório:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E138-rom-efuse-classification_20260908_055000\E138_rom_efuse_classification_report.md`.

Pacote de review:
`C:\SourceCode\LasecSimul\orchestrator\.ai\REVIEW_PACKET.md`.

A E138 corrige a classificação da E137:
`E137_CAPTURED_E121_ROM_EFUSE_BOOT_RESET — E135_POST_BOOT_PANIC_NOT_REPRODUCED`.
As sessões E137 6/PID 3120 e 14/PID 15540, e a nova sessão E138 14/PID 6588,
batem com o caminho ROM/EFUSE de boot inicial da E121: APP CPU ainda não
iniciado, watchdogs desarmados, `pc0=0x4000fdd0`, `pc1=0x40000400`, e
`SW_SYS_RESET` disparado no ROM em `pc=0x4000fdcd`.

Canônico e manifest permaneceram intactos:

- runtime canônico `B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`;
- candidato investigado direto `3D951D7C7A83578DED9FA20E7B9F0E0BABA705025C05618E90DCB079693A96F6`;
- firmware `merged.bin` `1DA8BF731830B2D2D9CE6EDBB0EA208636A1DB2A79497A8DB0CC98D72864C76A`;
- firmware ELF `1697587B58F9DF862765ADABC2F5A2E74387863438D8A6DF775196A542C9D9B6`;
- `QEMU_RUNTIME.json` não alterado.

Bloqueado até review: correção semântica EFUSE, B12, promoção, atualização do
runtime canônico, pacote/release e investigações cache/TG1/WDT/transport/
scheduler.

## E136 rare B11 N=16 panic classification — REVIEW REQUIRED (2026-09-07)

Resultado atual: **LOW_RATE_ANOMALY_NOT_REPRODUCED_REVIEW_REQUIRED**.

Relatório:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E136-b11-n16-panic-classification_20260907_220542\E136_classification_report.md`.

Pacote de review:
`C:\SourceCode\LasecSimul\orchestrator\.ai\REVIEW_PACKET.md`.

O evento original da sessão 0/PID 15044 do B11 N=16 E135 foi reconstruído
offline: workload completo, `submissions=4380`, `completions=4380`,
`artifactFatal=false`, teardown limpo, mas dois resets inesperados. Os PCs
simbolizam para `panic_handler`, `esp_restart_noos_dig` e `start_other_core`,
mas o run formal não tinha causal trace; portanto `exccause`,
`pseudo_excause`, fonte de interrupção e estado cache/MMU anteriores ao panic
continuam desconhecidos.

Na E136, o candidato `3D951D7C...` foi usado diretamente, sem promoção, em B11
N=16 `VNEXT_B+MTTCG` com apenas `LASECSIMUL_PANIC_CAUSAL_TRACE` e
`LASECSIMUL_WDT_CAUSAL_TRACE`. Três tentativas válidas passaram 16/16, com zero
resets inesperados, zero frame de panic e zero dump de expiração WDT. Uma
tentativa adicional foi preservada como inválida para a pergunta causal porque
uma sessão não alcançou startup/workload; também teve zero reset inesperado.

Canônico e manifest permaneceram intactos:

- runtime canônico `B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`;
- `QEMU_RUNTIME.json` `ADF0D79B9E533E17A3F8CA62FD890B1867973FBB1AFF1C95239142D03644B369`,
  read-only;
- zero QEMU restante.

Promoção, B12, mudança semântica, cleanup, commit, push, tag, package e release
continuam bloqueados até review.

## E135 NOT_APPLICABLE fix and promotion retry — ROLLED BACK at B11 N=16 (2026-09-07)

Resultado atual: **PROMOTION_ROLLED_BACK — FIRST_REAL_POST_PROMOTION_RED_B11_N16**.

Relatório:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\E135-gate-executor_20260907_181428\E135_not_applicable_fix_and_promotion_attempt_report.md`.

Foi aplicada apenas a correção mínima autorizada no teste:
`C:\SourceCode\LasecSimul\core\test\core\mcu\McuControllerRealQemuTest.cpp`
agora usa o marcador estruturado
`NOT_APPLICABLE: test=mcu_controller_real_qemu_test subcase=legacy_gateway_tap_fallback reason=transport_vnext_b`
no subcaso LEGACY-only de gateway/TAP sob VNEXT_B. SHA final do fonte:
`786C34420C51E22B8638793C94E05EC9AC6AC3289EB011F3BFFC603AC4662B95`.

O executor E135 continua fail-closed para `SKIP:`, `SKIPPED:` e `PULADO:`, e
aceita somente esse marcador completo, exatamente uma vez, no gate
`mcu_controller_real_qemu_test` sob `VNEXT_B`. SHA final do executor:
`501470CC413937227B6EC26E64D563E8096B7AD76C070F3F9208770D136C3381`.

Passaram antes da promoção: self-test do executor com 17 casos, rebuild somente
de `mcu_controller_real_qemu_test`, execução direta desse teste contra o
candidato `3D951D7C...`, regressão oficial `VNEXT_B+MTTCG` 14/14 contra o
candidato, e B11 N=1 contra o candidato.

A promoção controlada final foi tentada em
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\runtime-promotion_E135_final_20260907_192655`.
Pelo caminho canônico temporariamente em `3D951D7C...`, passaram os três testes
unitários QEMU, `vnext_b_attachment_test`, `session_restart_stress_test`,
regressão oficial 14/14 e B11 N=1.

Primeiro vermelho real: B11 N=16 em
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\E135-gate-executor_20260907_181428\final_post_B11_N16`.
O runner usou QEMU `3D951D7C...`, teve 16/16 sessões, 16/16 JSONL e exit 0,
mas reportou `B11_CELL_PASS = False`, `RUNNER_PASS = False` e
`RUNNER_FAILURES = classifier_cellPass_false`; sessão 0 teve dois resets
inesperados, sem `MWDT_ATTRIB_RESETS`.

Rollback concluído:

- runtime canônico restaurado para
  `B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`;
- `QEMU_RUNTIME.json` restaurado para
  `ADF0D79B9E533E17A3F8CA62FD890B1867973FBB1AFF1C95239142D03644B369`;
- `QEMU_RUNTIME.json` permanece read-only;
- zero processos QEMU restantes.

Não foi feito cleanup, commit, push, tag, package ou release. O runtime
vendorizado em `devices\qemu-esp32\bin` continua antigo e bloqueando release
empacotada.

Próxima ação: classificar o B11 N=16 vermelho a partir do artefato
`final_post_B11_N16`; não repetir promoção cegamente.

## E135 fail-closed gate executor — BLOCKED / promotion rolled back (2026-09-07)

Resultado atual: **BLOCKED_BEFORE_FINAL_PROMOTION — FAIL_CLOSED_GATE_CONFLICT**.

Relatório:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\E135-gate-executor_20260907_181428\E135_fail_closed_gate_executor_report.md`.

Executor fail-closed criado/corrigido:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\E135-gate-executor_20260907_181428\Invoke-E135PromotionGate.ps1`
SHA256 `25A367AB2196EB21C090F9E41D013E1B06B3588FF950A5CA9F66749E3E6974A1`.

Self-test do executor: PASS. Preflight direto com candidato: PASS
(`vnext_b_attachment_test` e `session_restart_stress_test` 3/3, SHA candidato
`3D951D7C...`, sem fallback vendorizado).

A promoção foi tentada e revertida em dois diretórios E135 novos. A tentativa
`runtime-promotion_E135_20260907_184029` passou os gates Core pós-promoção
curtos, mas a regressão falhou corretamente no primeiro `PULADO:` observado em
`mcu_controller_real_qemu_test`. Esse teste imprime `Todos os testes passaram`,
mas contém um subcaso LEGACY-only explicitamente pulado sob VNEXT_B. Como E135
mandou rejeitar `PULADO:`, a promoção não pode ser fechada sem decisão de gate.

Estado seguro final:

- canônico restaurado para SHA
  `B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`;
- `QEMU_RUNTIME.json` restaurado para SHA
  `ADF0D79B9E533E17A3F8CA62FD890B1867973FBB1AFF1C95239142D03644B369`;
- zero QEMU restantes;
- runtime vendorizado em `devices\qemu-esp32\bin\qemu-system-xtensa.exe`
  continua bloqueio separado de release.

Não foi executado cleanup, commit, push, tag, package ou release.

## Update runtime promotion execution rollback (2026-09-07)

Promoção controlada do runtime foi tentada e revertida automaticamente no
primeiro vermelho pós-promoção.

Resultado: **PROMOTION_ROLLED_BACK — FIRST_POST_PROMOTION_RED**.

Artefato:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\runtime-promotion_20260907_175847`.

O candidato `3D951D7C...` foi promovido temporariamente para o caminho canônico
e `qemu --version` passou; DLLs adjacentes permaneceram inalteradas.
`QEMU_RUNTIME.json` foi atualizado temporariamente e depois restaurado.

Gates verdes antes do vermelho: `test-esp32-timg-wdt-scale` 13/13,
`test-esp32-timg-pause` 7/7, `test-vnext-b-classify` 9/9.

Primeiro vermelho: `vnext_b_attachment_test` apenas emitiu `SKIP:
LASECSIMUL_TEST_QEMU_BINARY is not available`; em seguida
`session_restart_stress_test` lançou `devices/qemu-esp32/bin/qemu-system-xtensa.exe`
em vez do runtime canônico promovido, encontrou incompatibilidade de ABI v5 e
falhou 15/15 ciclos ao iniciar.

Rollback concluído: canônico restaurado para SHA
`B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`,
`QEMU_RUNTIME.json` restaurado, zero QEMU órfão. Regressão 14/14 e B11 N=1/N=16
não foram executados após o vermelho. Próxima ação é corrigir a invocação dos
gates de promoção para forçar o caminho canônico promovido e repetir a promoção
controlada desde o rollback, sem mudar semântica de produção.

## Update B12 final decision (2026-09-07)

B12 foi concluído por auditoria offline dos artefatos E134/B11 aprovados, no
escopo exclusivo `VNEXT_B+MTTCG`.

Decisão: **B12_PASS — PROMOTION_REVIEW_AUTHORIZED**.

Relatório:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218\B12-final-decision_20260907_1735\B12_final_decision_report.md`.

O candidato auditado é
`3D951D7C7A83578DED9FA20E7B9F0E0BABA705025C05618E90DCB079693A96F6`.
Todos os manifests B11 aprovados usam esse SHA. Configurações aprovadas:
N=1 1/1, N=8 1/1, N=12 1/1 e N=16 3/3. Todas as sessões têm workload válido,
`submissions==completions>0`, zero resets inesperados, `artifactFatal=false`,
sem CACHEERR/Guru/TG expiry indevida/SW reset inesperado/UART loss/I2C
loss/desync/reentrância/timeout/fail-open, teardown limpo e zero órfãos.

Classificação: `NO_ACTIVE_ANOMALY_OBSERVED`. Não há população atual de falhas
para classificar como starvation, anomalia de transporte ou anomalia de caminho
de execução; Fase C não é justificada pelos resultados atuais.

Não houve promoção. `QEMU_RUNTIME.json` e o runtime canônico permanecem intactos
em SHA256 `B375A9E830705F673800C703A450871D2B3616D06938365671ABD6A3DFDD936E`.
Próxima ação: review separado de promoção, preservando o canônico como
rollback.

## Update E134 phase 1 (2026-09-07)

E134 iniciou a investigação de inconsistência `wdt_time_scale`/reanchor sem
campanha N=16 e sem alterar semântica de produção. Snapshot em
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218`.

H134 foi confirmada matematicamente: `get_count()` acumula ticks literais;
`update_config()` materializa esse contador em `count_base/ns_base`; `arm()`
compara contra timeout bruto e só depois multiplica `ns_to_timeout` por escala.
Na sequência E133, `609` ticks literais após FEED colapsam o rearm para
`3,426,994,200 ns`, quando a semântica contínua de escala 100 preservaria prazo
por volta de `33,122,494,200 ns`.

Foi adicionado um teste RED puro em QEMU:
`tests/unit/test-esp32-timg-wdt-scale.c`. Ele falha como esperado contra a
matemática atual (`3426994200 == 33122494200`). O pacote de review está em
`orchestrator\.ai\REVIEW_PACKET.md`.

Estado atual: `REVIEW_REQUIRED`. Nenhuma correção semântica de watchdog foi
aplicada ainda. `QEMU_RUNTIME.json` permanece inalterado. B11/B12/promoção
seguem bloqueados.

## Update E133 (2026-09-07)

E133 foi executada exclusivamente em `VNEXT_B+MTTCG`. Não houve mudança
semântica QEMU/Core/firmware, nem B12, promoção, cleanup, commit, tag ou
release.

Artefato:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E133-b11-n16-causality_20260907_141445`.
Consolidado:
`...\E133_consolidated_result.md` e `...\E133_consolidated_result.json`.

Resultado principal: B11 N=16 permanece **OPEN**. O runner antigo era fail-open
para B11 N=16 (`runner_exit=0` com `cellPass=false`); isso foi corrigido no
runner/harness, com 14/14 testes determinísticos passando e cleanup limitado a
QEMU filho da execução corrente.

Medições novas: R0/ReserveCores=0/sem Force passou uma vez, mas no primeiro
bloco intercalado o controle R6+Force falhou e o tratamento R0/sem Force também
falhou. Portanto R6+Force é fator contribuinte/agravante, não causa única
comprovada. O diagnóstico dirigido mostrou expiração genuína TG1 e
`first_actual_stage_expiry`, seguida por reset guest de software/pânico
(`SW_CPU_RESET_REGISTER` / `SW_APPCPU_RESET`), com `MWDT_ATTRIB_RESETS=0`, sem
CACHEERR/Guru/reentrância/teardown-hang. O quadro de pânico e a sessão sem
workload com CPU1 em `panic_handler` seguem pendentes.

Estado atual: `EXECUTE`. Próximo passo é uma prova causal dirigida entre a
primeira expiração TG1 e a decisão guest de reset/pânico, ou uma proposta de
correção semântica acompanhada de prova mínima e review. B12/promoção seguem
bloqueados.

## Update E132-F (2026-09-07)

Validação pós-review `VNEXT_B+MTTCG` avançou após E132-E: determinísticos 8/8,
RESET_WAIT 3/3, E131 6/6, duas regressões 14/14 e B11 N=1/N=8/N=12 passaram.
O primeiro vermelho real atual é B11 N=16.

B11 N=16: 16/16 sessões despejadas, 16/16 JSONL, classificador
`cellPass=false`, `sessionsWorkloadPass=13/16`, `totalUnexpectedResets=14`,
sem MWDT atribuído, sem CACHEERR/exccause=7, sem Guru, sem reentrância
bloqueada, teardown limpo e zero QEMU órfão. Sessões 7/9/12 ficaram sem
workload; sessões 2/5/7/9/12 contribuíram resets inesperados. Estado atual:
`EXECUTE`, parado fail-closed neste N=16. B12, promoção, cleanup, commit, tag e
release continuam bloqueados.

## Update E132-E (2026-09-07)

O primeiro vermelho determinístico pós-review foi saneado sem mudança semântica
QEMU/produção. `session_restart_stress_test` agora usa liveness estrutural em
`VNEXT_B`: `firmwareRunning()`, scheduler rodando e avanço de
`pacingPositionNs()`. Com flash vazia ele prova lifecycle/pacing/execId/stop
limpo/sem órfãos; com firmware real ele exige submissions/completions I2C e
artifact progress.

Validação nova: rebuild isolado verde; blank-flash 3 ciclos verde; firmware
real 2 ciclos verde; formal firmware real 15 ciclos verde. Tudo rodou com
traces operacionais OFF, zero timeout, zero QEMU órfão e sem marcadores
negativos. Consolidado determinístico pós-review: 8/8 PASS, preservando os 7
verdes anteriores e reexecutando somente o primeiro vermelho corrigido.

Estado atual: `EXECUTE`. Próximo passo é retomar a sequência pós-review
`VNEXT_B+MTTCG` com RESET_WAIT 3/3 e E131 6/6, depois duas regressões 13/13 e
B11 N=1/8/12/16. Runtime canônico ainda não foi promovido; B11, B12, cleanup,
commit, tag e release ainda não foram executados.

## Update E132-D (2026-09-07)

Validação pós-review parou no primeiro vermelho determinístico. Rebuilds QEMU,
Core/harness e firmware E131 passaram; 7 testes determinísticos passaram; o
primeiro red foi `session_restart_stress_test` com 15/15 ciclos sem liveness em
`VNEXT_B` + flash vazia. Classificação: provável defeito de oráculo/harness,
porque o teste exige `[VNEXT_PROBE] after qemu_init` enquanto os traces ficam
OFF por padrão. Não foram executados regressões 13/13, B11, B12, promoção,
cleanup, commit, tag ou release.

## Update E132-C (2026-09-07)

Reviewer independente aprovou `E132-B-review-20260907`. E131 está fechado
somente para `VNEXT_B+MTTCG`; runtime canônico ainda não foi promovido.
Snapshot inicial pós-review e auditoria de fonte foram concluídos. Estado atual:
`EXECUTE`, iniciando rebuild/testes determinísticos pós-review. B11, B12,
promoção, cleanup, commit, tag e release ainda não foram executados.

## Update E132-B (2026-09-07)

O falso PASS do supervisor e o falso negativo RESET_WAIT foram corrigidos sem
mudança semântica de produção. RESET_WAIT passou 3/3 e a bateria E131 completa
passou 6/6 sob VNEXT_B+MTTCG, com teardown limpo e zero órfãos. E131 está
`CLOSED_PENDING_REVIEW`; B11 e promoção permanecem não executados.

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
# E134 status — review de fechamento pendente (2026-09-07)

E134 está implementada e validada em `VNEXT_B+MTTCG`, sem B12/promoção.
Artefatos:
`C:\SourceCode\LasecSimul\vnext_prototype\mttcg_causality\E134-wdt-scale-reanchor_20260907_152218`.

Validações concluídas: QEMU build PASS, WDT scale deterministic 13/13 PASS
direto e via Meson, duas regressões `VNEXT_B+MTTCG` 14/14 PASS, B11 N=1/N=8/N=12
PASS e N=16 PASS 3/3. QEMU candidato:
`3D951D7C7A83578DED9FA20E7B9F0E0BABA705025C05618E90DCB079693A96F6`.

Pendência honesta: fixture MWDT no-feed reconstruído não produziu observabilidade
stdout/stderr em tentativas bounded; não contar como prova integrada de expiração
final. Próxima ação: review de fechamento E134 via `REVIEW_PACKET.md`.
# E137 status — review de recorrência pendente (2026-09-08)

E137 reproduziu um vermelho real de B11 N=16 em `VNEXT_B+MTTCG` com o candidato
`3D951D7C7A83578DED9FA20E7B9F0E0BABA705025C05618E90DCB079693A96F6` e somente
`LASECSIMUL_PANIC_CAUSAL_TRACE`. A tentativa 1 passou; a tentativa 2 falhou e a
campanha parou no primeiro vermelho. Sessões 6 e 14 tiveram workload válido,
`SW_SYS_RESET` terminal capturado, `RTC_RESET` inesperado e depois
`SW_CPU_RESET_REGISTER`, mas `g_exc_frames=NULL` nos dois cores.

Classificação:
`B11_N16_PANIC_RESET_RECURRENCE_REPRODUCED_FRAME_UNPROVEN_REVIEW_REQUIRED`.
Não há prova nova de `exccause=7`/`PANIC_RSN_CACHEERR`, CPU, EPC/PC, vaddr ou
predicado E129 específico. Nenhum código semântico foi alterado; nenhuma
promoção/B12 foi executada; runtime canônico e `QEMU_RUNTIME.json` preservados.

# E147-J status — candidate validation (2026-09-10)

The candidate QEMU SHA
`920D6E4DE78825A776E8EA3E4A5E8E1A8DF3F43393E271DAA9BA934A165AA0BF` contains
the bounded I2C continuation split for a 32-byte guest write. Focused QEMU and
Core tests pass, `session_restart_stress_test` is 15/15, and the full Release
VNEXT_B+MTTCG regression is 14/14. B11 N=1 and N=8 at 15/60 seconds also pass.

The candidate is not promoted. Full Release regression completed 14/14. A
locally generated VSIX was independently re-extracted and passed the real
VNEXT-B packaged gate (44/44 runtime hashes, QEMU version/machine, 33/33
handshake, packaged Core, zero orphans); the bundled GHDL runtime/backend gate
also passed. Local release assembly stops only at the Windows bootstrapper
because this workstation has .NET SDK 8 while the project targets .NET 10;
the GitHub workflow installs .NET 10. Temporary candidate replacement was
rolled back; canonical QEMU and `QEMU_RUNTIME.json` remain at `475C0FC9...`.
