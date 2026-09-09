# Plano de implementação — causalidade, pacing e relógio no QEMU/VNEXT_B

Data de elaboração: 2026-09-04

Status: plano para execução por outro agente. Este documento não registra implementação concluída.

## 1. Objetivo

Determinar, sem misturar causas, se os resets e travamentos observados decorrem de:

1. concorrência real entre as duas vCPUs no modo MTTCG;
2. mudança de domínio de tempo ao sair de `-icount`;
3. ordenação/dreno incorretos das lanes do transporte VNEXT_B;
4. uma falha comum ao firmware, dispositivos ESP32 ou lógica de watchdog.

Depois da medição causal, corrigir somente os defeitos comprovados e retomar os gates B0.1 e
B10–B12. O objetivo **não** é voltar permanentemente para `-icount`: `-icount` será um controle
experimental, enquanto MTTCG continua sendo o candidato de produção.

## 2. Fatos já estabelecidos — não reinvestigar do zero

- O QEMU de `C:\SourceCode\qemu_simulide.zip` foi concebido em torno de `-icount` e de uma
  ponte síncrona/serial. No QEMU genérico, `-icount` impede MTTCG; as duas vCPUs Xtensa são
  intercaladas por uma única thread TCG.
- O target Xtensa suporta MTTCG. O impedimento histórico não era o target, mas as invariantes da
  integração SimulIDE/Core: relógio por instruções, produtor efetivamente serial e arena única.
- A migração atual mudou três dimensões de uma vez: domínio de relógio, concorrência entre vCPUs e
  ordenação dos eventos. O diagnóstico deve voltar a separá-las.
- O teste que apresentou `waitForSynch TIMEOUT` usou o transporte legado: a mensagem vem de
  `C:\SourceCode\qemu_lasecSimul\softmmu\simuliface.c`, não das lanes VNEXT_B. Portanto esse
  resultado mede uma instabilidade real do caminho legado, mas não valida nem reprova B0.1/VNEXT_B.
- `vnext_prototype/run_regression.ps1` atualmente não seleciona
  `LASECSIMUL_MCU_TRANSPORT=VNEXT_B`; por isso o transporte de cada resultado não pode ficar
  implícito.
- O QEMU atual já contém estas correções; não as reaplique às cegas:
  - probes de `cpu_exec()` e I2C gated por `LASECSIMUL_VNEXT_TRACE`;
  - PC sampler gated por `LASECSIMUL_XTENSA_PC_SAMPLER`;
  - log `final-credit` gated e emitido depois de abrir a pausa de transporte.
- Permanecem observáveis no código atual:
  - `mwdt_accounting_enabled()` usa lazy init não sincronizado em
    `softmmu/vnext_b.c` e `softmmu/cpus.c`;
  - `vnext_trace_enabled()` em `softmmu/vnext_b.c` ainda chama `getenv()` no hot path;
  - o consumidor VNEXT_B percorre lane 0 antes da lane 1, sem merge por timestamp;
  - o caminho VNEXT_B consome eventos antes de comparar `timestamp_ns` com o relógio do Scheduler;
  - um único wake pode consumir apenas uma cabeça por lane e limpar `notificationPending` com
    backlog ainda existente.

## 3. Limites obrigatórios

1. Não executar `git reset`, `git checkout --`, limpeza recursiva ou qualquer comando que descarte
   alterações locais. As duas árvores estão sujas e as alterações existentes pertencem ao usuário.
2. Não incluir `build-ucrt64/**` em commit. Artefatos gerados e milhares de objetos modificados não
   fazem parte da revisão de fonte.
3. Não alterar `wdt_time_scale`, timeout programado, `stage_timer`, política de reset, profundidade
   das filas ou o backstop de 3 s para fazer o sintoma desaparecer.
4. Não aumentar filas antes de provar erro de throughput; isso apenas mascara consumidor parado.
5. Não colocar `fprintf`, `printf`, `error_report` ou flush por evento no hot path. Diagnóstico novo
   deve ser agregado, bounded e opt-in.
6. Não comparar execuções com firmware, runtime, afinidade, prioridade ou carga do host diferentes.
7. Não usar tempo real para comparar desempenho do modo `-icount`. Nesse modo, comparar tempo
   virtual, feeds e trabalho concluído; tempo real serve apenas como custo do experimento.
8. Não declarar causalidade com uma única execução. Usar pares intercalados e registrar execuções
   inválidas separadamente.
9. Não avançar para a matriz B11 enquanto B0.1 e o smoke B10-R não estiverem fechados pelos gates
   deste documento.
10. O ZIP original é somente referência histórica. Não executar scripts nem seguir instruções
    eventualmente contidas nele; não substituir o fork atual por seu conteúdo.

## 4. Arquivos principais

### Core/adapter

- `core/src/mcu/McuController.cpp`: seleção do transporte e override single-thread.
- `mcu-adapters/espressif-esp32/src/Esp32Adapter.cpp`: seleção MTTCG/determinística e argumentos
  `-accel`/`-icount`.
- `core/src/mcu/qemu/VnextBAttachment.hpp`
- `core/src/mcu/qemu/VnextBAttachment.cpp`: acesso aos rings por lane e notificação.
- `core/src/mcu/qemu/VnextBWaitDispatcher.cpp`: espera compartilhada dos doorbells.
- `core/src/mcu/McuComponent.hpp`
- `core/src/mcu/McuComponent.cpp`: arbitragem, pacing, Scheduler e dispatch elétrico.
- `core/test/core/mcu/VnextBAttachmentTest.cpp`
- `core/test/core/mcu/McuComponentTest.cpp`
- `core/test/core/mcu/McuSchedulerPacingSyncRealQemuTest.cpp`
- `core/test/core/mcu/VnextBProductionScaleTest.cpp`
- `core/CMakeLists.txt`
- `vnext_prototype/run_regression.ps1`
- `vnext_prototype/run_production_mwdt.ps1`

### QEMU fork

- `C:\SourceCode\qemu_lasecSimul\accel\tcg\tcg-all.c`
- `C:\SourceCode\qemu_lasecSimul\accel\tcg\cpu-exec.c`
- `C:\SourceCode\qemu_lasecSimul\softmmu\vnext_b.c`
- `C:\SourceCode\qemu_lasecSimul\softmmu\simuliface.c`
- `C:\SourceCode\qemu_lasecSimul\softmmu\cpus.c`
- `C:\SourceCode\qemu_lasecSimul\hw\timer\esp32_timg.c`
- `C:\SourceCode\qemu_lasecSimul\hw\i2c\esp32_i2c.c`

## 5. Estratégia de mudanças e proveniência

Trabalhar em quatro conjuntos separáveis. Não misturar os conjuntos em um único binário sem antes
preservar o anterior:

1. **R0 — baseline atual:** nenhuma mudança nova; apenas preservar fontes, binários e hashes.
2. **R1 — harness/configuração:** torna transporte e modo de execução explícitos; não muda QEMU.
3. **R2 — higiene thread-safe do QEMU:** somente gates/caches diagnósticos; sem mudança funcional.
4. **R3 — consumidor causal VNEXT_B:** merge, evento futuro e dreno; mudança funcional de correção.

Para cada conjunto:

- salvar `git status --short`, `git diff -- <arquivos-fonte>` e `git rev-parse HEAD` das duas árvores;
- calcular SHA-256 do QEMU, firmware, adapter DLL e executável de teste;
- copiar o QEMU utilizado para uma pasta imutável do run antes de restagear outro;
- registrar um manifesto JSON com `sourceHead`, `sourceDiffSha256`, `binarySha256`, variáveis de
  ambiente, comando, horários e resultado;
- chamar rebuilds que gerem SHAs diferentes a partir de fontes iguais de "source-identical
  rebuilds"; isso não é diferença causal de fonte.

Diretório sugerido:

`vnext_prototype/mttcg_causality/<UTC-YYYYMMDD-HHMMSS>/`

Subpastas: `manifests`, `binaries`, `logs`, `results` e `source-diffs`.

## 6. Fase R0 — congelar o baseline

Antes de editar:

1. Capturar os estados das duas árvores, limitando o diff do QEMU a arquivos-fonte e excluindo
   `build-ucrt64`.
2. Confirmar o SHA do runtime staged em
   `vnext_prototype/dev_qemu_runtime/qemu-system-xtensa.exe` e compará-lo a
   `orchestrator/.ai/QEMU_RUNTIME.json`.
3. Confirmar SHA de:
   - `vnext_prototype/guest_i2c_workload/.pio/build/esp32/merged.bin`;
   - `core/build/Debug/vnext_b_production_scale_test.exe`;
   - adapter ESP32 usado pelo build.
4. Executar apenas um sanity check curto N=1, explicitamente VNEXT_B + MTTCG, traces desligados.
   Aceitar como sanity check somente se o log declarar o transporte e o modo de execução.
5. Se o log não declarar ambos, não interpretar o resultado; implementar R1 primeiro.

Resultado esperado: baseline reproduzível, sem alegação de causa.

## 7. Fase R1 — tornar transporte e execução explícitos

### 7.1 Runner de regressão

Editar `vnext_prototype/run_regression.ps1`:

- adicionar parâmetros com `ValidateSet`:
  - `Transport`: `LEGACY` ou `VNEXT_B`;
  - `ExecutionMode`: `MTTCG`, `SINGLE_REALTIME` ou `ICOUNT`;
- limpar no início, além das variáveis diagnósticas atuais:
  - `LASECSIMUL_MCU_TRANSPORT`;
  - `LASECSIMUL_ESP32_EXECUTION_MODE`;
  - `LASECSIMUL_QEMU_TCG_THREAD`;
  - `LASECSIMUL_QEMU_ICOUNT_SHIFT`;
- depois da limpeza, materializar exatamente uma configuração:
  - `MTTCG`: `LASECSIMUL_ESP32_EXECUTION_MODE=mttcg`, sem `QEMU_TCG_THREAD`;
  - `SINGLE_REALTIME`: `ESP32_EXECUTION_MODE=mttcg` e `QEMU_TCG_THREAD=single`;
  - `ICOUNT`: `ESP32_EXECUTION_MODE=deterministic`, sem `QEMU_TCG_THREAD`;
  - `VNEXT_B`: `LASECSIMUL_MCU_TRANSPORT=VNEXT_B`;
  - `LEGACY`: deixar a variável ausente, porque esse é o contrato compatível atual;
- imprimir no cabeçalho transporte, modo, afinidade, prioridade, firmware e SHA do runtime;
- manter a correção atual de exit code: qualquer `FAIL`, `TIMEOUT` ou `NOT_BUILT` retorna 1;
- gravar nomes de log que contenham transporte, modo e run id, evitando sobrescrever a execução
  anterior.

Não definir globalmente `LASECSIMUL_MCU_TRANSPORT=VNEXT_B` sem parametrização: ainda precisamos da
cobertura do legado e da comparação 2 × 3.

### 7.2 Diagnóstico de launch

Em `McuController.cpp`, completar o diagnóstico para que os três modos sejam inequívocos:

- `execution=mttcg-realtime` quando houver `tcg,thread=multi` e não houver `-icount`;
- `execution=single-realtime` quando houver `tcg,thread=single` e não houver `-icount`;
- `execution=deterministic-icount shift=<N>` quando houver `-icount`;
- imprimir também `transport=legacy` ou `transport=vnext_b`.

Adicionar teste unitário ao teste de launch existente para inspecionar os argumentos, sem iniciar
QEMU:

- MTTCG contém `tcg,thread=multi` e não contém `-icount`;
- SINGLE_REALTIME contém `tcg,thread=single` e não contém `-icount`;
- ICOUNT contém `tcg,thread=single` e `-icount shift=...`;
- nenhuma combinação contém simultaneamente `thread=multi` e `-icount`.

### 7.3 Critério de saída de R1

- teste de launch verde;
- teste negativo do runner continua retornando 1;
- logs de um launch de cada modo mostram exatamente o modo solicitado;
- nenhum runtime QEMU foi recompilado nesta fase.

## 8. Fase R2 — remover data races e custo diagnóstico residual

Alterar somente o QEMU fork:

1. Em `softmmu/cpus.c`, substituir o `static int cached = -1` de
   `mwdt_accounting_enabled()` por `static gsize initialized` + `g_once_init_enter/leave` e um bool
   estático, seguindo o padrão já usado em `cpu-exec.c` e `hw/i2c/esp32_i2c.c`.
2. Fazer o mesmo em `softmmu/vnext_b.c` para:
   - `mwdt_accounting_enabled()`;
   - `vnext_trace_enabled()`.
3. Não criar cache compartilhado entre processos ou bibliotecas. O cache é por processo QEMU; as
   variáveis não mudam depois do launch.
4. Não tocar em `cpu_wait_account_transition`, `cpu_stop_current`, `cpu_resume`,
   `esp32_timg_transport_pause`, `ns_base` ou timers.
5. Auditar com `rg` todas as ocorrências de `LASECSIMUL_VNEXT_TRACE`,
   `LASECSIMUL_MWDT_ACCOUNTING` e `static int cached`; cada gate acessado por múltiplas threads deve
   ter inicialização sincronizada.

### Testes de R2

- rebuild QEMU isolado;
- sanity N=1 de 15 s com todos os traces ausentes:
  - zero `[VNEXT_PROBE]`;
  - zero arquivos do PC sampler;
  - volume de log dentro do limite já definido em B0.1;
- sanity curto com cada gate ligado para provar que o gate ainda funciona;
- duas regressões completas e independentes por transporte relevante, sem carga concorrente.

Não usar um resultado do pacing legado para reprovar especificamente o runtime VNEXT_B. Relatar o
resultado na célula correta (`LEGACY`, modo correspondente).

## 9. Fase R3a — criar testes sintéticos que falham antes da correção

Não implementar o merge antes dos testes abaixo demonstrarem o defeito.

### 9.1 API de ring testável

Em `VnextBAttachment`, introduzir operações separadas:

- `peekLane(lane)`: copia a cabeça com acquire, mas não avança `read_seq` e não sinaliza crédito;
- `consumeLane(lane)`: mantém a responsabilidade atual de avançar `read_seq` com release e sinalizar
  o QEMU;
- `laneHasPending(lane)` e/ou `hasPendingLaneEvents()`: consulta índices sem consumir.

Invariantes a testar em `VnextBAttachmentTest.cpp`:

- dois peeks devolvem o mesmo evento e não mudam `read_seq`;
- consume devolve a cabeça espiada, avança exatamente 1 e sinaliza crédito uma vez;
- FIFO dentro de cada lane é preservado;
- lane vazia não é consumida;
- wraparound não altera a ordem;
- `write_seq - read_seq` nunca excede depth nos testes.

Há um único consumidor Core serializado por `CallbackState::mutex`; não introduzir CAS complexo ou
múltiplos consumidores sem necessidade. O produtor de cada lane publica o slot antes do
`write_seq` release; o Core deve ler `write_seq` com acquire.

### 9.2 Ordenação global

Criar teste sintético do arbiter com duas lanes e registrar a ordem de dispatch:

- lane 0: timestamps 120 e 140;
- lane 1: timestamps 100 e 130;
- ordem obrigatória: 100/L1, 120/L0, 130/L1, 140/L0.

Para timestamps iguais, definir desempate determinístico:

1. menor `timestamp_ns`;
2. menor `lane_sequence` somente quando útil para consistência local;
3. menor número da lane como desempate final.

Nunca usar apenas `lane_sequence` para ordenar timestamps diferentes. `lane_sequence` só é
monotônico dentro da própria lane.

### 9.3 Evento futuro

Com Scheduler em 100 ns e cabeças em 120/130 ns:

- nenhum evento pode ser consumido ou produzir efeito elétrico em 100 ns;
- a cabeça global de 120 ns deve alimentar `m_nextPendingEventNs`;
- deve existir um único callback agendado em 120 ns;
- ao chegar a 120 ns, consumir apenas eventos `<= nowNs`;
- `m_latestVirtualTimePs`/posição aplicada não pode avançar pelo mero peek;
- depois do dispatch de 120 ns, a fronteira futura deve passar a 130 ns.

Use a origem da sessão para converter timestamp QEMU em timeline do Scheduler. Não compare
`timestamp_ns` cru com `Scheduler::nowNs()` se a sessão começou com `nowNs != 0`. Criar um helper
explícito para nanossegundos, em vez de reutilizar silenciosamente uma função que recebe
picosegundos. Incluir overflow check/saturação ao somar origem + timestamp.

### 9.4 Dreno e wake perdido

Publicar mais de um evento por lane antes de um único doorbell, incluindo eventos de controle/I2C
que não mudam o fingerprint elétrico. Depois de um único wake:

- todos os eventos prontos devem acabar consumidos, ou deve existir um repoll imediato já
  agendado;
- retorno `false` por ausência de mudança elétrica não pode abandonar backlog;
- `notificationPending=false` só é aceitável quando não há trabalho pronto sem outro mecanismo de
  repoll;
- publicação concorrente entre o último scan e o acknowledge precisa resultar em novo wake ou ser
  detectada pelo scan pós-ack;
- limitar o trabalho por turno (por exemplo, orçamento de eventos) para não monopolizar o
  Scheduler, mas ao esgotar o orçamento deve-se agendar continuação imediata.

O teste deve repetir a janela de corrida milhares de vezes sem sleeps usados como sincronização.
Usar barrier/evento de teste determinístico para publicar exatamente na janela scan/ack.

## 10. Fase R3b — implementar o arbiter causal VNEXT_B

Implementar somente depois de R3a ficar vermelho no código anterior.

### 10.1 Seleção da próxima cabeça

Em cada passo:

1. fazer peek de todas as lanes não vazias;
2. escolher a cabeça com menor chave `(eventTimeNs, laneId)`; FIFO interno já é garantido pelo ring;
3. se `eventTimeNs > nowNs`, não consumir nada;
4. publicar essa cabeça em `m_nextPendingEventNs`, notificar mudança do advance limit e agendar poll
   exatamente em `eventTimeNs`;
5. se pronta, consumir somente a lane escolhida;
6. verificar em build de teste que o evento consumido corresponde à cabeça selecionada
   (`lane_sequence`, kind e timestamp); divergência é erro de protocolo, não motivo para consumir
   outra entrada silenciosamente;
7. despachar e repetir enquanto houver evento pronto e orçamento disponível.

Não iterar `for lane=0..N` consumindo uma entrada de cada lane: isso mantém o viés de lane e não é
um merge temporal.

### 10.2 Integração com `PollStep`

Refatorar o ramo VNEXT_B de `pollStepLocked()` para retornar corretamente:

- `DispatchedReady`: pelo menos um evento pronto foi consumido ou há continuação imediata;
- `DeferredFuture`: a menor cabeça existe, está no futuro e o callback foi agendado;
- `NoEvent`: todas as lanes estão vazias e não há mailbox pendente.

Não reduzir o resultado a `changed || notified`: mudança elétrica, consumo de protocolo e
necessidade de continuar drenando são estados diferentes.

O VNEXT_B atual **não** chama `startPolling()` em `loadFirmwareLocked()`; seu wake normal é o
callback do `VnextBWaitDispatcher`, que chama `Scheduler::markDirty()`, e então `stamp()` faz o
consumo. Não copiar mecanicamente o lifecycle do legado. Para a cabeça futura, criar um wake
temporal VNEXT_B deduplicado que apenas torna o MCU dirty no instante devido:

- quando chamado de `stamp()`, o mutex do Scheduler já está tomado; enfileirar com
  `Scheduler::scheduleEventUnlocked()` e nunca chamar `scheduleAt()`/`scheduleEvent()` que tentem
  tomar o mesmo mutex;
- o callback agendado será executado pelo Scheduler fora do mutex e pode então usar
  `markDirty(componentIndex)`;
- proteger o callback com weak lifetime + geração de sessão/poll, para um callback antigo não agir
  sobre MCU destruído ou firmware recarregado;
- deduplicar por menor prazo: uma cabeça nova mais cedo invalida a geração anterior; uma mais tarde
  não duplica o callback já adequado;
- ao parar/recarregar, invalidar a geração e limpar prazo/posição pendentes.

Não mudar VNEXT_B para polling periódico de `now+1 ns`: isso elimina a vantagem do doorbell e pode
criar um laço quente no Scheduler. O repoll imediato só existe quando há backlog pronto/orçamento
esgotado; sem evento, aguardar novo doorbell.

### 10.3 Eventos síncronos

Pedidos de leitura e BATCH I2C bloqueiam a vCPU aguardando resposta. Ainda assim, não devem furar
uma cabeça causal anterior de outra lane.

- Ordenar pedidos síncronos pela mesma cabeça global.
- Se a cabeça síncrona estiver no futuro, publicar a fronteira em `m_nextPendingEventNs` e agendar o
  callback; isso permite ao pacing alcançar o instante sem aplicar o dispositivo antes da hora.
- Confirmar por teste que o Scheduler consegue chegar ao callback enquanto a vCPU está parada.
- Se esse teste revelar deadlock, não contornar atendendo o pedido cedo. Corrigir a fronteira de
  pacing/wakeup e documentar a invariante quebrada.

### 10.4 Acknowledge seguro

O evento Win32 é manual-reset e o dispatcher o rearma antes do callback. A solução precisa cobrir
dois casos:

- backlog já presente antes do callback;
- nova publicação concorrente durante/depois do callback.

Implementação aceitável:

1. drenar eventos prontos até vazio/futuro/orçamento;
2. limpar a flag lógica de notificação;
3. executar um scan acquire pós-ack;
4. se houver evento pronto ou o orçamento acabou, preservar/recriar a pendência e solicitar repoll;
5. se houver somente evento futuro, manter o callback temporal; não criar busy loop.

Não depender de uma segunda transição do doorbell para backlog que já estava no ring.

### 10.5 Atualização de posição

- Atualizar a posição aplicada apenas depois de confirmar `eventTimeNs <= nowNs` e consumir o
  evento.
- Hoje o ramo VNEXT_B não atualiza `m_latestVirtualTimePs`. Corrigir isso deliberadamente: ou
  converter `timestamp_ns` para picosegundos com multiplicação checked/saturada antes de atualizar
  esse campo, ou introduzir um campo VNEXT_B em nanossegundos e adaptar `pacingPositionNs()`/
  `latestVirtualTimeNs()` sem mudar o contrato público. Não gravar nanossegundos diretamente em um
  campo nomeado/interpretado como picosegundos.
- Limpar `m_nextPendingEventNs` apenas quando a cabeça publicada deixou de ser a fronteira; em
  seguida recalcular pela próxima cabeça global.
- Nunca deixar a posição regredir.
- Não misturar `QEMU_CLOCK_HOST` (accounting de espera) com `QEMU_CLOCK_VIRTUAL` (timestamp do
  evento) em uma mesma subtração.

## 11. Testes após R3

Ordem obrigatória, interrompendo na primeira falha:

1. testes unitários novos de ring/arbiter/futuro/dreno;
2. `vnext_b_attachment_test`;
3. `mcu_component_test`;
4. testes de Scheduler/pacing sintéticos;
5. testes reais VNEXT_B com N=1 e firmware real;
6. regressão completa `VNEXT_B + MTTCG`, duas vezes, em processos novos;
7. regressão completa `LEGACY + MTTCG`, para detectar regressão lateral;
8. smoke N=1 de 15 s, depois a duração de B10-R.

Critérios mínimos:

- ordem global igual à esperada em 100% das repetições;
- zero dispatch de evento futuro;
- zero backlog abandonado após um único wake;
- zero duplicação, perda, overwrite, wrong-session ou response-misroute;
- zero `[VNEXT_PROBE]` com trace ausente;
- nenhuma alteração na contagem de reset explicada apenas por mudança de logging;
- nenhum QEMU órfão após cada teste;
- logs registram inequivocamente transporte e modo.

## 12. Matriz causal 2 × 3

Executar com o mesmo runtime R3, mesmo firmware, mesmo binário Core, mesma afinidade e prioridade.
As seis células são:

| Transporte | MTTCG | single realtime | single + icount |
|---|---:|---:|---:|
| VNEXT_B | A | B | C |
| LEGACY | D | E | F |

Usar no mínimo cinco blocos intercalados. Dentro de cada bloco, rotacionar a ordem das seis células
para evitar viés de aquecimento/carga. Não rodar células em paralelo.

Antes e depois de cada célula:

- verificar e registrar processos QEMU existentes;
- registrar CPU total, fila do processador e memória disponível;
- aplicar cooldown curto somente até a carga voltar ao limiar registrado; não usar sleep fixo como
  explicação causal;
- registrar exit code, wall time, virtual time, feeds, resets por fonte, backpressure por lane,
  submissions/completions e motivo terminal;
- marcar a execução `VALID`, `INVALID_HOST_LOAD`, `INVALID_SETUP`, `TIMEOUT_BACKSTOP` ou
  `PROCESS_EXIT_UNEXPLAINED`.

Interpretação:

- A falha, B passa, C passa: forte evidência de concorrência/ordenação MTTCG no VNEXT_B.
- A e B falham, C passa: forte evidência de domínio de relógio/starvation sem `-icount`.
- A/B/C falham, D/E/F passam: falha específica do transporte VNEXT_B.
- A/D falham e B/E passam: falha comum à concorrência MTTCG, fora do transporte.
- todas falham: investigar firmware/dispositivo/watchdog comum; não mexer no arbiter para explicar.
- somente legado falha com `waitForSynch TIMEOUT`: manter como problema legado separado.
- diferenças sem repetição consistente: inconclusivo; aumentar pares, não escolher a narrativa mais
  conveniente.

No modo ICOUNT, comparar progresso por tempo virtual e feeds. Não exigir que 15 s virtuais acabem em
15 s reais; a medição histórica indicou execução real muito mais lenta.

## 13. Gates para retomar B0.1 e B10–B12

### Fechar B0.1 somente se

- a higiene diagnóstica estiver coberta por testes;
- duas regressões completas VNEXT_B + MTTCG resultarem explicitamente em todos os testes PASS;
- a regressão legado for relatada separadamente, sem contaminar a decisão VNEXT_B;
- N=1 sem gates produzir zero probes e zero sampler;
- runtime, firmware, harness e manifests estiverem preservados por SHA.

### Executar B10-R somente depois de B0.1

B10-R deve usar explicitamente:

- `LASECSIMUL_MCU_TRANSPORT=VNEXT_B`;
- MTTCG;
- firmware real `guest_i2c_workload/merged.bin`;
- traces operacionais desligados;
- accounting ligado somente no braço instrumentado e desligado no controle.

Se o storm `SW_CPU_RESET_REGISTER` continuar, classificar mecanismo final e causa iniciadora
separadamente. Não chamar todo `SW_CPU_RESET_REGISTER` de watchdog sem evidência do estágio MWDT.

### B11/B12

Somente após smoke limpo e válido, retomar a matriz original N=1/8/12/16. A matriz 2 × 3 deste plano
é de diagnóstico arquitetural e não substitui a matriz de escala B11.

## 14. Build seguro

QEMU deve ser compilado no UCRT64 com limite de carga:

```bash
export MSYSTEM=UCRT64
source /etc/profile
cd /c/SourceCode/qemu_lasecSimul/build-ucrt64
nice -n 19 ninja -j 8 qemu-system-xtensa.exe
```

Nunca executar `ninja` sem `-j 8` nesta máquina. Restagear somente depois de preservar o binário
anterior e calcular seu SHA.

Core: usar a árvore já configurada e limitar paralelismo a `/m:4`. Não criar uma nova árvore de
build sem necessidade, pois o adapter e os testes precisam apontar para o mesmo conjunto de
artefatos.

## 15. Entregáveis do agente

1. Código e testes em mudanças separáveis R1/R2/R3.
2. Manifestos e logs da matriz causal, sem sobrescrever execuções anteriores.
3. Atualização de `orchestrator/.ai/EVIDENCE.md` com fatos medidos, incluindo execuções inválidas.
4. Atualização de `orchestrator/.ai/QEMU_RUNTIME.json` a cada runtime promovido.
5. Atualização de `orchestrator/.ai/TEST_GATES.md` somente para gates realmente satisfeitos.
6. Atualização de `orchestrator/.ai/DECISIONS.md` porque R3 muda a semântica de consumo para restaurar
   causalidade; registrar a invariante, não apenas a implementação.
7. Atualização de `orchestrator/.ai/NEXT_ACTION.md` com o próximo gate ainda aberto.
8. Relatório final contendo:
   - arquivos alterados;
   - SHAs de todos os binários;
   - comandos executados;
   - tabela das seis células e repetições;
   - resets raw vs. deduplicados;
   - processos órfãos encontrados;
   - conclusão com grau de evidência e hipóteses rejeitadas.

## 16. Condições de parada

O agente deve parar e registrar evidência, sem avançar de fase, se:

- o baseline não puder ser associado a hashes verificáveis;
- algum teste novo não ficar vermelho antes da correção que pretende provar;
- surgir diferença de firmware/runtime entre braços de um par;
- houver erro de protocolo, overwrite ou misroute;
- uma mudança exigir alterar watchdog, timer, profundidade de fila ou backstop;
- o build produzir artefato sem proveniência;
- uma regressão falhar fora da célula esperada;
- o host permanecer carregado a ponto de invalidar pares;
- houver QEMU órfão que não possa ser associado e encerrado com segurança.

Nessas situações, o relatório deve dizer exatamente qual invariante falhou e qual evidência falta.
Não preencher lacunas com inferência.

## 17. Definição de pronto

Este plano estará concluído quando:

- transporte e modo forem explícitos em todo resultado;
- caches diagnósticos do QEMU estiverem thread-safe e sem custo de `getenv()` no hot path;
- o consumidor VNEXT_B fizer merge temporal determinístico entre lanes;
- eventos futuros permanecerem no ring até o Scheduler alcançar seu instante;
- um único wake não puder abandonar backlog;
- testes sintéticos demonstrarem as três invariantes e falharem contra a implementação anterior;
- a matriz 2 × 3 separar concorrência de domínio de relógio com repetições válidas;
- B0.1 estiver formalmente fechada;
- houver uma decisão baseada em evidência sobre continuar em MTTCG, corrigir pacing/relógio ou
  investigar uma causa comum antes de B10–B12.
