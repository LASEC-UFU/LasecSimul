# Plano de engenharia: MTTCG real para ESP32 Xtensa dual-core no LasecSimul

Documento de planejamento arquitetural. **Nenhuma linha de código foi alterada para produzir este
documento.** Todas as referências a arquivo/linha abaixo apontam para o estado atual do fork QEMU em
`C:\SourceCode\qemu_lasecSimul` (QEMU 8.1.3), já incluindo os 4 fixes commitados nesta investigação
(`2ea68be`, `ee4775f`, `12f645a`, `823f588`).

Contexto de origem: esta investigação começou com o sintoma "taxa de simulação em ~1%" reportado na UI
do LasecSimul. Perfilamento ao vivo (GDB attach contra os processos Core e QEMU reais, não apenas
raciocínio) encontrou e corrigiu, nesta ordem: uma condição de corrida na ativação da extensão que
desconectava o MCU do resto do circuito silenciosamente; uma chamada `getenv()` não cacheada no hot
path de GPIO/ADC (o ganho dominante, 2-3% → 26%); contenção no BQL durante o busy-wait do arena
(~3-9%); e colisões no cache direto-mapeado de translation blocks (~10-13%). Depois de tudo isso, o
teto ficou em ~26% de velocidade real para o firmware de referência (Blink+ADC+PWM, ESP32 dual-core
real via FreeRTOS). O usuário quer avaliar se paralelismo real entre PRO_CPU e APP_CPU pode quebrar
esse teto.

---

## 1. Estado atual da arquitetura

### 1.1 Como o QEMU executa CPUs virtuais hoje

QEMU tem dois modos de execução de vCPU sob o acelerador TCG (Tiny Code Generator, o interpretador/JIT
que traduz código de máquina do guest para código nativo do host), selecionados uma única vez na
inicialização e nunca trocados durante a execução:

- **Round-Robin (RR)** — `accel/tcg/tcg-accel-ops-rr.c`. TODAS as vCPUs compartilham UMA thread de
  host (`"ALL CPUs/TCG"`, nome literal do thread, `rr_start_vcpu_thread` linha 325-328). Um laço
  (`rr_cpu_thread_fn`, linhas 180-308) itera a lista de CPUs (`CPU_NEXT(cpu)`) e dá a cada uma um
  "turno" de execução (`tcg_cpus_exec(cpu)`, linha 261) limitado por um orçamento de instruções
  (`cpu_budget`), depois passa para a próxima. Um timer (`rr_kick_vcpu_timer`,
  `TCG_KICK_PERIOD = 100ms`, linha 13 de `tcg-accel-ops-rr.h`) força a troca se uma vCPU monopolizar o
  turno.
- **Multi-Threaded (MTTCG)** — `accel/tcg/tcg-accel-ops-mttcg.c`. Cada vCPU tem SUA PRÓPRIA thread de
  host (`"CPU %d/TCG"`, `mttcg_start_vcpu_thread` linhas 132-150), executando
  `mttcg_cpu_thread_fn` (linhas 62-124) em loop infinito e independente. Não há orçamento de
  instruções, não há troca forçada — cada CPU roda até parar sozinha (halt, exceção, ou
  `cpu_exit()` externo).

A escolha entre os dois é decidida uma vez, na inicialização (`accel/tcg/tcg-all.c`,
`default_mttcg_enabled()`, linhas 71-89), e todo o resto do QEMU (device models, timers, memory
dispatch) é escrito assumindo que essa escolha não muda em runtime.

### 1.2 Como o TCG funciona (o essencial para este plano)

TCG traduz blocos de código do guest (Translation Blocks, TBs) para código de máquina nativo do host,
uma vez, e reaproveita a tradução em execuções futuras via dois níveis de cache:

1. **Cache rápido por-CPU** (`CPUJumpCache`, `accel/tcg/tb-jmp-cache.h`) — array direto-mapeado
   (`TB_JMP_CACHE_SIZE = 16384` entradas após o fix `823f588` desta investigação; 4096 antes). Um
   `CPUJumpCache` **por CPUState**, não compartilhado entre CPUs.
2. **Hash table global** (`tb_ctx.htable`, `accel/tcg/tb-maint.c`) — compartilhada por TODAS as CPUs,
   protegida por locks finos por-página (`page_lock`/`PageDesc`, `tb-maint.c` linhas 336-410) e RCU
   para leitura concorrente. **Esta infraestrutura já é thread-safe hoje**, porque o QEMU genérico
   precisa suportar MTTCG para outros alvos (ARM multi-core, x86 multi-core, etc.) — não foi
   construída pensando no Xtensa especificamente, mas o Xtensa não tem nenhuma exceção documentada que
   a desabilite.

Ou seja: **o mecanismo de tradução e cache de TBs em si não é o bloqueio para MTTCG no Xtensa.** O
bloqueio é inteiramente sobre o modelo de tempo (`-icount`), como a seção 3 detalha.

### 1.3 Onde exatamente está o bloqueio no código

`accel/tcg/tcg-all.c`, função `default_mttcg_enabled()`:

```c
static bool default_mttcg_enabled(void)
{
    if (icount_enabled() || TCG_OVERSIZED_GUEST) {
        return false;
    }
    ...
}
```

E, mais adiante na mesma função (em torno da linha 144), forçar `-accel tcg,thread=multi`
explicitamente junto com `-icount` é um erro rígido:

```c
} else if (icount_enabled()) {
    error_setg(errp, "No MTTCG when icount is enabled");
```

E o cinto-e-suspensórios: `mttcg_cpu_thread_fn` (`tcg-accel-ops-mttcg.c` linha 71) tem
`g_assert(!icount_enabled());` logo na entrada da thread — mesmo que alguém contornasse o check
anterior, a thread MTTCG aborta o processo se `-icount` estiver ativo.

**Por que o LasecSimul precisa de `-icount`**: não é para determinismo/replay (o LasecSimul não usa o
recurso de record/replay do QEMU). É porque `-icount` é o único mecanismo do QEMU que faz o **relógio
virtual avançar proporcionalmente a instruções executadas**, em vez de tempo de parede. Isso é o que
permite que `simu_event()` (`softmmu/simuliface.c` linha 188) dispare o heartbeat periódico em
instantes de tempo virtual coerentes com o que o Core espera, e que `icount_get_ns()` dê ao Core um
timestamp que corresponde a "quantas instruções Xtensa já rodaram", não "quanto tempo de relógio real
passou" — essencial para sincronizar bordas de GPIO/PWM com o solver analógico do Core no instante
certo.

### 1.4 Arquivos e estruturas relevantes (mapa de referência)

| Componente | Arquivo | Papel |
|---|---|---|
| Loop RR (atual) | `accel/tcg/tcg-accel-ops-rr.c` | Uma thread, todas as vCPUs, orçamento de instruções dividido |
| Loop MTTCG (não usado hoje) | `accel/tcg/tcg-accel-ops-mttcg.c` | Uma thread por vCPU, sem orçamento, roda livre |
| Seleção RR vs MTTCG | `accel/tcg/tcg-all.c` | `default_mttcg_enabled()`, o bloqueio central |
| icount: orçamento/tempo | `accel/tcg/tcg-accel-ops-icount.c` | `icount_percpu_budget()`, `icount_prepare_for_run()` |
| icount: opções de linha de comando | `softmmu/icount.c` | `icount_configure()`, parsing de `shift=`/`align=`/`sleep=` |
| Cache de TB por-CPU | `accel/tcg/tb-jmp-cache.h` | `CPUJumpCache`, já por-CPU, não precisa mudar |
| Cache de TB global | `accel/tcg/tb-maint.c` | Hash table + locks por-página, já thread-safe |
| Dispatch de execução | `accel/tcg/cpu-exec.c` | `tb_lookup()`, `cpu_exec()`, `tb_htable_lookup()` |
| MMIO + BQL | `accel/tcg/cputlb.c` | `QEMU_IOTHREAD_LOCK_GUARD()` em todo acesso MMIO |
| Estado por-CPU | `include/hw/core/cpu.h` | `CPUState`, `halted`, `stop`, `thread` |
| Interrupção cross-core | `hw/xtensa/mx_pic.c` | `XtensaMxPic`, roteamento de IPI entre PRO/APP CPU |
| Máquina ESP32 | `hw/xtensa/esp32-simul.c` | Criação das 2 CPUs (`default_cpus=2`), mapa de memória |
| Instrução atômica Xtensa | `target/xtensa/translate.c` | `translate_s32c1i()`, usa `tcg_gen_atomic_cmpxchg_i32` |
| Ponte com o Core | `softmmu/simuliface.c` | `readReg`/`writeReg`/`waitForSynch`/`simu_event`, arena única |

---

## 2. Objetivo da mudança

```
ANTES:                          DEPOIS:

  ESP32 PRO_CPU                   ESP32 PRO_CPU          ESP32 APP_CPU
        |                               |                      |
        |                          host thread A          host thread B
   uma thread host                     |                      |
        |                          (executa TBs             (executa TBs
  ESP32 APP_CPU                    Xtensa livremente,       Xtensa livremente,
                                    paralelo de verdade)     paralelo de verdade)
```

### O que realmente precisa rodar em paralelo

Só uma coisa: **o laço de busca/tradução/execução de instruções Xtensa por núcleo**
(`tcg_cpus_exec()` por CPU). É a única parte cujo custo cresce linearmente com o trabalho de CADA
núcleo individualmente — hoje, com RR, o orçamento de instruções é literalmente dividido pela metade
sempre que as 2 CPUs estão configuradas (fix `ee4775f` já mitigou parte disso para o caso de um núcleo
ocioso, mas quando AMBOS os núcleos estão ativos ao mesmo tempo, o RR ainda os intercala, nunca
executa os dois literalmente ao mesmo tempo).

### O que precisa continuar sincronizado

- **O relógio virtual** — não pode haver dois "tempos virtuais" independentes sem reconciliação; o
  Core espera UM timestamp coerente por evento.
- **A arena compartilhada** (`softmmu/simuliface.c`) — protocolo de handshake de UM slot (`regAddr`,
  `regData`, `simuAction`, `qemuAction`), assume hoje um único chamador sequencial.
- **O controlador de interrupção cross-core** (`hw/xtensa/mx_pic.c`) — uma CPU escreve um registrador
  que precisa afetar IMEDIATAMENTE e corretamente o estado de interrupção da OUTRA CPU.
- **Os periféricos compartilhados** (GPIO, DPORT, UART, timers — `hw/misc/esp32_*.c`,
  `hw/xtensa/esp32-simul.c`) — fisicamente, no ESP32 real, são um único bloco de hardware endereçável
  pelas duas CPUs; no QEMU, hoje, o BQL (`QEMU_IOTHREAD_LOCK_GUARD()`, `cputlb.c`) serializa o acesso
  disso automaticamente porque só uma CPU roda por vez. Com paralelismo real, essa serialização
  precisa continuar existindo, mas agora como proteção de fato (contenção real, não coincidência de
  nunca haver dois acessos simultâneos).

### O que continua compartilhado (sem trocar de "dono")

- O binário do firmware, a flash, a RAM física (`MemoryRegion` únicas, isso já é seguro no QEMU
  genérico — memória física sempre foi compartilhável entre CPUs mesmo em RR).
- O processo QEMU como um todo continua sendo UM processo, UMA arena, UMA conexão com o Core — nada
  disso muda; MTTCG é uma mudança interna ao QEMU, não à topologia de processos do LasecSimul.

---

## 3. Problema principal: icount

### 3.1 Como o icount funciona hoje

`-icount shift=N` (LasecSimul usa `shift=4,align=off,sleep=off`,
`mcu-adapters/espressif-esp32/src/Esp32Adapter.cpp::buildLaunchArgs`) faz o QEMU contar instruções
executadas e derivar o relógio virtual delas: **1 instrução real executada = 2^N ns de tempo virtual**
(2^4 = 16ns/instrução no caso do LasecSimul). Mecanicamente, isso acontece em
`accel/tcg/tcg-accel-ops-icount.c`:

1. `icount_get_limit()` (linhas 37-67) calcula quantas instruções podem rodar antes do PRÓXIMO
   evento de timer agendado precisar de atenção (ex.: o heartbeat de `simu_event`, ou timers internos
   do próprio QEMU) — não é uma constante, é derivado dinamicamente do deadline mais próximo.
2. `icount_percpu_budget(cpu_count)` (linhas 92-103) divide esse limite pelo número de CPUs
   consideradas (após o fix `ee4775f`, só CPUs não-`halted`) — **este número já é o orçamento POR
   RODADA, não o total do sistema**.
3. `icount_prepare_for_run(cpu, cpu_budget)` (linha 105+) grava esse orçamento em
   `cpu_neg(cpu)->icount_decr` antes de chamar `tcg_cpus_exec()` — o TCG decrementa esse contador a
   cada instrução traduzida/executada e força a CPU a sair do laço de execução quando chega a zero.
4. De volta no laço RR, o relógio virtual (`QEMU_CLOCK_VIRTUAL`) só avança quando TODAS as CPUs do
   sistema já "gastaram" seu turno da rodada atual — ou seja, o relógio virtual representa um ÚNICO
   fluxo de instruções TOTAL do sistema, não de uma CPU isolada.

### 3.2 Como ele mantém determinismo (e por que isso não importa aqui)

O propósito original do `-icount` no QEMU upstream é permitir **record/replay bit-a-bit
determinístico**: gravar uma execução e reproduzi-la EXATAMENTE, instrução por instrução, útil para
depuração de bugs raros. Isso exige uma ordem TOTAL e determinística de execução entre todas as CPUs —
impossível de garantir se CPUs rodam em paralelo real (a ordem de intercalação entre 2 threads de host
depende do agendador do SO, não é reproduzível).

**O LasecSimul não usa record/replay.** Usa `-icount` puramente pelo efeito colateral de "relógio
virtual proporcional a instruções executadas". Isso é uma distinção crítica para este plano: **não
precisamos preservar determinismo bit-a-bit entre PRO_CPU e APP_CPU** — só precisamos de um relógio
virtual que continue fazendo sentido físico (avança de forma monotônica e proporcional ao trabalho
real feito) o suficiente para o Core sincronizar eventos de hardware corretamente.

### 3.3 Como ele relaciona instruções executadas com tempo virtual

A relação é: `tempo_virtual_avançado = instruções_executadas × 2^shift` — mas hoje isso é calculado
sobre um ÚNICO contador de instruções agregado do sistema (porque só uma CPU executa por vez em
qualquer instante). Com 2 CPUs rodando em paralelo real, "quantas instruções o sistema executou" deixa
de ter um significado único e sequencial — as duas CPUs produzem contagens de instrução
**concorrentes e independentes**, cada uma avançando seu próprio "tempo local".

### 3.4 Por que isso conflita com múltiplas threads

Três problemas concretos, não hipotéticos:

1. **`icount_decr` é por-CPU, mas o orçamento (`cpu_budget`) hoje é calculado globalmente e distribuído
   por RODADA** — esse cálculo (`icount_percpu_budget`) pressupõe que só uma CPU consome seu orçamento
   por vez, dentro de uma janela de tempo real conhecida (o tempo entre duas iterações do laço RR). Com
   threads paralelas de verdade, duas CPUs podem estar consumindo orçamento SIMULTANEAMENTE, sem
   nenhuma noção compartilhada de "quanto tempo real passou desde a última rodada".
2. **O relógio virtual (`QEMU_CLOCK_VIRTUAL`) é uma variável global única** (`timers_state` em
   `include/sysemu/cpu-timers.h`) — hoje só é avançado depois que TODAS as CPUs terminam sua rodada
   (serialização implícita do RR). Com paralelismo real, quem decide quando avançar esse relógio, e
   baseado em qual das duas CPUs?
3. **`simu_event()` dispara com base nesse relógio único** — se duas CPUs progridem em taxas
   diferentes (uma presa em uma ISR longa, outra livre), qual das duas "é" o tempo virtual atual no
   momento do heartbeat? O protocolo de arena de hoje (`softmmu/simuliface.c`) assume implicitamente
   que existe UM "agora" bem definido.

### 3.5 Alternativas

#### Alternativa A — manter icount global compartilhado, mas com CPUs em threads separadas

Cada CPU roda em sua própria thread, mas todas continuam consultando/decrementando um único contador
de instruções globalmente compartilhado (com operações atômicas) em vez de um orçamento pré-calculado
por rodada.

- **Vantagens**: menor mudança conceitual — o relógio virtual continua tendo um significado único e
  bem definido (soma total de instruções de todas as CPUs). O protocolo de arena do LasecSimul não
  precisaria mudar (ainda existe um "agora" único).
- **Problemas**: o contador global vira um ponto de contenção entre as 2 threads a CADA instrução (ou
  a cada pequeno lote de instruções) — potencialmente um `qatomic_fetch_add` por bloco traduzido, em
  AMBAS as threads, disputando a mesma linha de cache. Isso é exatamente o tipo de contenção que
  MTTCG foi desenhado para EVITAR (é por isso que o MTTCG upstream não faz isso para nenhum alvo).
  Na prática, isso pode consumir boa parte do ganho de paralelismo em overhead de sincronização —
  quanto mais fina a granularidade da sincronização, menos paralelismo real se ganha.
- **Condições de corrida**: decremento do orçamento por-CPU (`icount_decr`) teria que virar uma
  variável compartilhada ATOMICAMENTE decrementada por ambas as threads — TCG hoje gera código
  inline não-atômico para esse decremento (é local por design, pensando em UMA CPU por thread em
  MTTCG puro, ou uma CPU por vez em RR). Tornar esse decremento atômico exigiria mudar o gerador de
  código TCG para o Xtensa (ou globalmente), não é um ajuste superficial.
- **Impacto no determinismo**: já não importa para o LasecSimul (seção 3.2), mas vale registrar: essa
  alternativa AINDA seria não-determinística (a ordem de chegada ao contador global depende do
  agendador do SO), então não haveria ganho de determinismo por manter o contador único — só o custo
  de contenção, sem o benefício que motivou originalmente esse desenho no QEMU upstream.

#### Alternativa B — cada vCPU com contador próprio, reconciliado periodicamente

Cada CPU mantém seu PRÓPRIO contador de instruções/tempo virtual local, sem nenhuma sincronização a
cada instrução. Periodicamente (ex.: a cada N instruções, ou a cada vez que uma CPU precisa tocar
estado compartilhado), os dois contadores são reconciliados/alinhados por uma barreira explícita.

- **Sincronização periódica**: o ponto natural de reconciliação já existe conceitualmente —
  exatamente o "kick timer" do RR (`TCG_KICK_PERIOD`) ou o próprio heartbeat de `simu_event`. A ideia
  seria: cada CPU roda livre por um "quantum" de tempo virtual local (ex.: equivalente a um heartbeat),
  depois PARA e espera a outra CPU também terminar seu quantum, aí os dois avanços são somados/
  reconciliados num tempo virtual "de sistema", análogo a uma barreira de barril (barrier).
- **Barreiras**: isso significa que as duas CPUs NÃO rodam livres indefinidamente — há sincronização
  forçada a cada quantum. O paralelismo real fica limitado ao tamanho do quantum: se o quantum for
  pequeno (ex.: os ~3125 instruções do heartbeat atual), o overhead de sincronização por barreira
  pode dominar da mesma forma que a Alternativa A, só que em granularidade maior (por quantum, não por
  instrução) — melhor, mas ainda não é paralelismo livre.
- **Reconciliação de tempo**: definir "tempo virtual do sistema" quando as duas CPUs progridem em
  ritmos diferentes exige uma política explícita — a mais simples e correta fisicamente é
  `tempo_sistema = min(tempo_cpu0, tempo_cpu1)` (a CPU mais atrasada define o "agora" observável
  externamente, e a mais adiantada tem que ser impedida de continuar até a mais lenta alcançar — isso
  é exatamente como o QEMU upstream faz record/replay determinístico multi-core hoje, aliás, então
  não seria um design inédito, seria adaptar um padrão existente).

#### Alternativa C — modelo híbrido: paralelismo real só quando seguro, RR como fallback

Detectar em runtime se as duas CPUs estão em uma janela onde paralelismo real é seguro (ex.: nenhuma
das duas está prestes a cruzar um ponto de sincronização de hardware — heartbeat, MMIO, interrupção
cross-core) e permitir paralelismo livre SÓ nessas janelas; fora delas, cair de volta para
comportamento RR-like (serializado).

- É essencialmente uma versão mais sofisticada (e mais arriscada de implementar corretamente) da
  Alternativa B, com quantum ADAPTATIVO em vez de fixo. Ganha mais paralelismo em código
  "compute-bound" (sem MMIO), mas exige detectar corretamente "prestes a tocar hardware compartilhado"
  ANTES de acontecer — o que é difícil de prever de forma barata sem já estar rodando devagar o
  suficiente para verificar a cada instrução (derrotando o propósito).

### 3.6 Qual é mais viável

**Alternativa B (contadores locais + reconciliação periódica por barreira), com o quantum inicial
igual ao heartbeat atual (`period_ns`, hoje 50000ns virtuais / ~3125 instruções a shift=4).** Razões:

- Reaproveita um ponto de sincronização que JÁ EXISTE no protocolo (`simu_event`), em vez de inventar
  um novo mecanismo do zero.
- Evita o pior problema da Alternativa A (contenção por-instrução), aceitando um overhead de
  sincronização bem mais raro (uma vez por quantum, não por instrução).
- É estruturalmente o mesmo padrão que o QEMU upstream já usa para MTTCG determinístico
  (`record/replay` multi-core), o que significa que existe precedente real de como fazer isso
  corretamente, não é território totalmente inexplorado dentro do próprio QEMU.
- A Alternativa C não compensa a complexidade adicional para este caso específico: o ESP32 com
  firmware típico do LasecSimul já é fortemente MMIO-bound (achado do profiling: metade das amostras
  do QEMU em contenção de BQL antes do fix `12f645a`), então as janelas "seguras para paralelismo
  livre" seriam curtas e frequentes de qualquer forma — a Alternativa B com quantum pequeno já cobre
  bem esse caso sem a complexidade extra de detecção adaptativa.

---

## 4. Modelo de sincronização proposto

```
   PRO_CPU thread                                    APP_CPU thread
   ───────────────                                    ───────────────
   executa até completar quantum                      executa até completar quantum
   de tempo virtual local (~3125 instr)                de tempo virtual local (~3125 instr)
          │                                                    │
          ▼                                                    ▼
   ┌──────────────────────────── barreira de reconciliação ────────────────────────────┐
   │  tempo_sistema = min(tempo_local_PRO, tempo_local_APP)                            │
   │  CPU mais adiantada BLOQUEIA até a mais atrasada alcançar (ou até o próximo       │
   │  ponto de parada dela, o que vier primeiro)                                       │
   │  simu_event() dispara aqui, com tempo_sistema coerente                            │
   └─────────────────────────────────────────────────────────────────────────────────┘
          │                                                    │
          ▼                                                    ▼
   retoma quantum seguinte                             retoma quantum seguinte
```

### Quando uma CPU precisa parar

Três gatilhos, cada um exigindo tratamento diferente:

1. **Fim do quantum de tempo virtual** (~3125 instruções) — para e espera a barreira, como acima.
2. **Necessidade de tocar hardware compartilhado ANTES do fim do quantum** (MMIO — GPIO, UART, DPORT,
   qualquer periférico) — não pode esperar a barreira; precisa do BQL imediatamente, IGUAL AO QUE JÁ
   ACONTECE hoje via `QEMU_IOTHREAD_LOCK_GUARD()` em `cputlb.c`. Isso continua funcionando sem mudança
   estrutural — o BQL já serializa isso corretamente independente do modelo de tempo. A ÚNICA
   diferença é que agora pode haver CONTENÇÃO REAL entre PRO_CPU e APP_CPU no BQL (hoje é impossível,
   já que só uma roda por vez) — ver seção 6 para o que isso implica.
3. **Recebimento de interrupção cross-core** (uma CPU escreve `MIPISET` via `hw/xtensa/mx_pic.c`,
   visando a outra) — a CPU alvo precisa notar isso o mais rápido possível, não esperar o fim do
   quantum. Mecanismo: `cpu_exit(target_cpu)` (já existe, usado por `rr_kick_next_cpu`/
   `mttcg_kick_vcpu_thread`) força a CPU alvo a sair do laço de execução TCG na próxima oportunidade
   seura (entre TBs), independente de quantum.

### Como tratar acesso aos periféricos

Sem mudança de modelo — continua sendo o BQL (`QEMU_IOTHREAD_LOCK_GUARD()`) protegendo TODO acesso
MMIO, exatamente como já funciona para MTTCG em outros alvos upstream. O que muda é a FREQUÊNCIA de
contenção real nesse lock (de zero, hoje, para potencialmente frequente).

### Como tratar interrupções

O mecanismo de `hw/xtensa/mx_pic.c` já é escrito em termos de callbacks de `MemoryRegionOps`
(`xtensa_mx_pic_ext_reg_write`) disparados via acesso MMIO — ou seja, JÁ PASSA pelo BQL hoje (porque
todo MMIO passa). A parte que precisa de atenção extra é `xtensa_mx_pic_update_cpu()` →
`qemu_set_irq()` → o efeito final na CPU ALVO (setar uma exceção pendente no `CPUState` dela) — esse
caminho não tem nenhuma anotação de lock visível no código atual (`mx_pic.c` não usa nenhum mutex
próprio), o que é seguro hoje só porque nunca há duas CPUs "vivas" ao mesmo tempo. Com paralelismo
real, esse caminho especificamente precisa ser auditado — provavelmente já está coberto pelo BQL (quem
chama `xtensa_mx_pic_ext_reg_write` já está dentro do guard do BQL), mas é o primeiro lugar a verificar
com cuidado antes de confiar cegamente.

### Como tratar timers

Timers do QEMU (`QEMUTimer`, incluindo o próprio `qtimer` de `simu_event`) já são thread-safe no nível
genérico (usam uma lista protegida internamente), mas o CALLBACK de um timer roda no contexto de QUEM
processou o timer — hoje isso é sempre a thread RR única. Com duas threads, é preciso decidir
explicitamente QUAL thread processa `simu_event` (proposta: SÓ na barreira de reconciliação, nunca
dentro do quantum livre de uma CPU individual — mantém a lógica atual do heartbeat praticamente
intacta, só muda quem a invoca).

### Como tratar memória compartilhada

RAM física e flash já são `MemoryRegion`s compartilháveis por design do QEMU — nenhuma mudança
necessária aí. O ponto realmente sensível é o **cache de instrução/dados do TB relacionado a
self-modifying code** (`tb_invalidate_phys_page_range`, que já apareceu no profiling desta sessão) —
esse mecanismo já usa os locks por-página descritos na seção 1.2, então já é seguro para múltiplas
CPUs invalidando TBs simultaneamente.

### Como manter ordem dos eventos

A arena (`softmmu/simuliface.c`) manda para o Core eventos com um timestamp (`simuTime`), e o Core
processa na ordem que CHEGAM, não necessariamente na ordem que os timestamps sugerem hoje (o protocolo
é síncrono: QEMU espera o Core confirmar antes de mandar o próximo). Com duas CPUs gerando eventos
concorrentemente, a arena de UM slot atual não suporta duas escritas simultâneas — ver seção 7, esta é
provavelmente a mudança de maior risco de todo o plano.

---

## 5. Impacto no ESP32

### Xtensa dual-core / FreeRTOS

O ESP-IDF (framework oficial usado pela maioria dos firmwares ESP32, incluindo o de teste usado nesta
investigação) roda FreeRTOS em modo SMP real: PRO_CPU e APP_CPU cada um roda seu próprio agendador,
com tarefas podendo ser fixadas (`xTaskCreatePinnedToCore`) ou migrarem entre núcleos. Sincronização
entre núcleos usa:

- **Spinlocks baseados em `S32C1I`** (compare-and-swap) — confirmado seguro para MTTCG real no nível
  QEMU/TCG (`target/xtensa/translate.c::translate_s32c1i`, usa `tcg_gen_atomic_cmpxchg_i32`, que
  compila para uma instrução atômica de host de verdade). **Não é um risco novo introduzido por
  MTTCG** — já funciona corretamente em outros alvos MTTCG do QEMU upstream hoje.
- **Interrupção cross-core (IPI)** via `hw/xtensa/mx_pic.c` — usado por `esp_crosscore_int_send_yield`
  e primitivas semelhantes do ESP-IDF sempre que uma tarefa em um núcleo precisa acordar/preemptar algo
  no outro núcleo (extremamente comum em qualquer firmware SMP real, não um caso raro). Risco: médio,
  precisa de auditoria (seção 4).

### PRO_CPU / APP_CPU

Simetria de hardware real (ambos podem, em teoria, tocar qualquer periférico), mas convenção do
ESP-IDF tipicamente concentra Wi-Fi/BT no APP_CPU e a maior parte da lógica de aplicação no PRO_CPU. Na
prática, isso significa que o padrão de contenção de MMIO entre os dois núcleos varia MUITO
dependendo do firmware — um firmware sem Wi-Fi (como o "código pequeno sem wifi" mencionado nesta
sessão) provavelmente tem APP_CPU relativamente ocioso, reduzindo o benefício potencial de paralelismo
real (ver seção 11).

### Interrupções

Além do IPI cross-core, cada CPU tem seu PRÓPRIO controlador de interrupção local (registradores
`INTERRUPT`/`INTENABLE` no `CPUXtensaState`, por-CPU, já isolado corretamente hoje). Sem risco
adicional aqui — é estado genuinamente local por CPU.

### GPIO / UART / Timers / DPORT

Todos modelados como `MemoryRegion`s ÚNICAS compartilhadas pelas duas CPUs (fisicamente correto — é
como o hardware real funciona). Hoje protegidos implicitamente pelo RR (só uma CPU acessa por vez).
Com MTTCG real, a proteção explícita via BQL PRECISA estar correta em 100% dos caminhos de acesso — a
auditoria da seção 6 precisa cobrir cada um desses arquivos (`hw/misc/esp32_*.c`).

### Memória compartilhada (heap, filas do FreeRTOS)

Isso é responsabilidade do FIRMWARE (FreeRTOS + código do usuário), não do QEMU — o QEMU só precisa
garantir que a EXECUÇÃO das instruções que implementam essa sincronização (load/store normais e
`S32C1I`) tenha semântica de memória correta entre as duas threads de host. Já coberto pela análise de
`S32C1I` acima; loads/stores normais em `MemoryRegion`s compartilhadas já passam pelo mesmo mecanismo
de `cputlb.c`/BQL que MMIO.

### Lista de possíveis bugs de sincronização a esperar

1. **`mx_pic.c` sem lock explícito** — provavelmente coberto pelo BQL indiretamente (chamado só de
   dentro de `MemoryRegionOps` callbacks), mas precisa confirmação explícita, não assumir.
2. **Estado do heartbeat (`m_lastQemuTime`, `period_ns` globais em `simuliface.c`)** — hoje variáveis
   globais simples (`uint64_t m_lastQemuTime;`), sem nenhuma proteção — seguro só porque uma única
   thread as toca hoje. Com 2 threads, viram estado compartilhado que precisa de proteção explícita
   (seção 7).
3. **A arena de um slot** — maior risco de todos, ver seção 7.
4. **Reset assimétrico de um núcleo** (`esp32_machine_init`, `SW_CPU_RESET` do APP_CPU durante boot,
   já visto nos logs desta investigação: `"count=2 mask=0x02 ... expected=app-cpu-startup"`) — a
   sequência de reset/boot de um núcleo enquanto o outro já roda precisa continuar funcionando
   corretamente sob paralelismo real; hoje é sequencial "de graça" via RR.
5. **Timing de watchdog** (`timg[0].wdt`, `timg[1].wdt`, um por CPU, `hw/xtensa/esp32.c` linha 174) —
   se um núcleo trava/atrasa sob depuração de um bug de MTTCG durante o desenvolvimento, o watchdog do
   OUTRO núcleo pode disparar incorretamente, gerando falsos positivos de "bug" durante o
   desenvolvimento desta feature — vale desabilitar watchdogs explicitamente nos testes iniciais.

---

## 6. Mudanças necessárias no QEMU

| # | Arquivo | Mudança | Motivo | Risco |
|---|---|---|---|---|
| 1 | `accel/tcg/tcg-all.c` | Permitir `mttcg_enabled=true` quando `icount_enabled()` — remover/condicionar o bloqueio de `default_mttcg_enabled()` e o `error_setg` correspondente | É o gate central; sem isso nada mais funciona | Alto — é literalmente desabilitar uma trava de segurança que existe há anos por um motivo real (mesmo que não se aplique ao nosso caso de uso) |
| 2 | `accel/tcg/tcg-accel-ops-mttcg.c` | Remover/substituir `g_assert(!icount_enabled())`; adaptar `mttcg_cpu_thread_fn` para consultar orçamento de icount por-CPU (hoje ela não usa `icount_prepare_for_run` nenhuma vez, porque hoje é logicamente impossível MTTCG+icount coexistirem) | A thread MTTCG precisa aprender a operar sob icount, algo que nunca foi escrito | Alto — código novo, não uma adaptação de código existente |
| 3 | `accel/tcg/tcg-accel-ops-icount.c` | Novo mecanismo de orçamento por-CPU independente (Alternativa B da seção 3) substituindo/complementando `icount_percpu_budget()`; nova função de barreira/reconciliação entre CPUs | Núcleo da Alternativa B | Alto — é a peça mais nova e mais crítica de todo o plano |
| 4 | `include/sysemu/cpu-timers.h` / `softmmu/icount.c` | Adaptar `timers_state`/`QEMU_CLOCK_VIRTUAL` para suportar a semântica "tempo do sistema = min dos tempos locais" em vez de um contador único diretamente incrementado | O relógio virtual precisa de uma nova regra de avanço | Alto |
| 5 | `hw/xtensa/mx_pic.c` | Auditoria + possivelmente locks explícitos (não assumir que o BQL cobre 100% dos caminhos sem verificar cada callback) | Ponto de IPI cross-core, crítico para FreeRTOS SMP | Médio-Alto |
| 6 | `hw/xtensa/esp32-simul.c`, `hw/misc/esp32_*.c` | Auditoria de cada `MemoryRegionOps` — confirmar que todo caminho de leitura/escrita passa pelo BQL corretamente (a maioria já passa via `cputlb.c` genérico, mas dispositivos que fazem callbacks assíncronos próprios — como `esp32_cache_data_sync`/`blk_pread`, já visto no profiling desta sessão — precisam de atenção extra) | Correção de todos os periféricos sob acesso concorrente real | Médio |
| 7 | `softmmu/simuliface.c` | Reescrita significativa — ver seção 7 em detalhe | Protocolo de arena de um slot não suporta 2 chamadores concorrentes | **Muito alto — provavelmente o item de maior risco de todo o plano** |
| 8 | `accel/tcg/cpu-exec.c` | Provavelmente NENHUMA mudança — `tb_lookup`/`tb_htable_lookup` já são thread-safe (seção 1.2). Validar com testes, não assumir | — | Baixo (a validar) |
| 9 | `target/xtensa/*` | Provavelmente NENHUMA mudança no tradutor em si — a geração de código TCG já é agnóstica a RR-vs-MTTCG (é a MESMA tradução, só muda quem/quando executa). Auditoria de qualquer estado global `static`/módulo em `target/xtensa/` que hoje é seguro só por causa do RR | Confirmar ausência de estado oculto não-thread-safe | Médio (auditoria, não mudança de código esperada) |
| 10 | `mcu-adapters/espressif-esp32/src/Esp32Adapter.cpp` | Trocar `-icount shift=4,align=off,sleep=off` por `-accel tcg,thread=multi` + o novo suporte a icount (item 1-4) | Habilitar a feature na configuração de lançamento real | Baixo (mudança pequena, mas só funciona depois de tudo mais estar pronto) |

---

## 7. Mudanças no simuliface/Core

### O protocolo atual

```
QEMU (1 ou 2 threads de vCPU, agora)
    │
    │  UM slot de handshake: regAddr, regData, simuAction, qemuAction, simuTime, irqNumber
    ▼
shared memory arena (qemuArena_t, tamanho fixo, CreateFileMapping)
    │
    ▼
Core (McuComponent::onPollEvent, thread do Scheduler)
```

### O protocolo atual é thread-safe?

**Não, e nunca precisou ser** — foi escrito assumindo (corretamente, até agora) que só existe UM
"escritor" do lado QEMU a qualquer momento, porque RR garante isso por construção. Evidência direta no
código:

- `m_arena`, `m_lastQemuTime`, `m_timeout`, `period_ns`, `qtimer` (`softmmu/simuliface.c` linhas 39-49)
  são **variáveis globais de módulo simples**, sem nenhum `_Atomic`/mutex/lock.
- `waitForSynch()` (linha 152) lê e escreve `m_arena->simuTime`/`m_lastQemuTime` sem proteção —
  seguro hoje porque só uma vCPU chama isso por vez.
- `readReg()`/`writeReg()` escrevem `m_arena->regAddr`, `regData`, `simuAction`, `qemuAction` como uma
  sequência de passos NÃO-ATÔMICA (múltiplas escritas separadas ao arena antes do Core poder
  reagir) — se DUAS threads fizessem isso simultaneamente, os campos se misturariam (ex.: thread A
  escreve `regAddr`, thread B escreve `regAddr` por cima antes do Core ler, thread A escreve
  `regData` depois — corrupção clássica de protocolo de handshake de slot único sob 2 escritores).

### Onde existem suposições de thread única

Literalmente toda a arena. Não há UM caminho no protocolo atual que sobreviva a duas chamadas
concorrentes de `readReg`/`writeReg`/`waitForSynch` vindas de threads diferentes.

### O que seria necessário

Duas abordagens possíveis, em ordem de menor para maior mudança:

**Opção 1 — serializar o acesso à arena com um mutex, mantendo o protocolo de 1 slot.** A CPU que
perde a corrida espera. Simples de implementar (um `std::mutex`/`QemuMutex` em volta de cada
`readReg`/`writeReg`/`waitForSynch`), mas **isso recria artificialmente exatamente a serialização que
MTTCG deveria eliminar** — se as duas CPUs são MMIO-heavy (que é exatamente o achado desta
investigação: metade do tempo de QEMU em BQL antes do fix), essa mutex vira o novo gargalo, cancelando
boa parte do ganho de paralelismo esperado.

**Opção 2 — arena com 2 slots (um por CPU), ou uma fila real (não um slot único).** Muda o layout da
`qemuArena_t` (structure compartilhada por ABI entre QEMU e Core — **precisa mudar em
`include/lasecsimul/qemu_arena_abi.h` E do lado Core em `core/src/mcu/qemu/QemuArenaTypes.hpp`/
`QemuArenaBridge.cpp` simultaneamente, versionado com cuidado**) para suportar 2 handshakes
concorrentes de verdade, ou uma fila real (lock-free ou com um mutex por slot, não um mutex global).
Do lado Core, `McuComponent::onPollEvent()` (`core/src/mcu/McuComponent.cpp` linha 107) precisaria
processar eventos de AMBAS as CPUs, decidir qual atender primeiro se chegarem "ao mesmo tempo", e
`dispatchArenaEvent` precisaria saber a qual CPU cada evento pertence.

**Recomendação**: Opção 2 é a única que realmente entrega o benefício de paralelismo pretendido, mas é
uma mudança de protocolo cross-processo (QEMU ↔ Core), versionada, testada nos dois lados — não é uma
mudança isolada dentro do QEMU como as outras desta lista.

### Possíveis deadlocks

- Se a Opção 2 usar 2 mutexes (um por slot) e o código do Core algum dia precisar segurar os dois ao
  mesmo tempo (ex.: para processar um evento que depende de estado de AMBAS as CPUs simultaneamente,
  como uma leitura de registrador de IPI), a ORDEM de aquisição precisa ser consistente em todo lugar
  — um clássico risco de deadlock de "lock ordering" que não existe hoje simplesmente porque só existe
  um lock possível (nenhum).
- O padrão de liberar o BQL durante o busy-wait (fix `12f645a` desta investigação,
  `qemu_mutex_unlock_iothread()`/`lock_iothread()` em volta do spin) precisa ser revisitado: hoje isso
  é seguro porque só uma vCPU pode estar nesse spin por vez. Com 2 threads, duas CPUs podem estar
  simultaneamente soltando/re-adquirindo o BQL — isso é EXATAMENTE o padrão que MTTCG upstream já usa
  (não é um risco novo introduzido por nós), mas precisa ser reverificado especificamente em conjunto
  com a mudança da arena (Opção 2), já que a arena estará dentro dessa janela sem BQL.

---

## 8. Estratégia de implementação incremental

### Fase 0 — Instrumentação

**Objetivo**: ter visibilidade real de onde o tempo vai HOJE, com granularidade suficiente para medir
o impacto de cada fase seguinte, sem ainda mudar nenhum comportamento.

**Código alterado**: nenhuma mudança funcional. Adicionar contadores/timestamps não-intrusivos em
pontos-chave: tempo gasto por CPU dentro de `tcg_cpus_exec` por rodada RR, tempo gasto em espera de
BQL, frequência de acesso a `mx_pic.c`, tempo de vida útil de cada quantum de icount.

**Testes necessários**: nenhum teste novo — validar que a instrumentação em si não distorce a medição
(mesma disciplina desta investigação: medir antes/depois de CADA mudança, inclusive as de
instrumentação).

**Critério de sucesso**: dados quantitativos confiáveis sobre quanto tempo cada CPU passa
computando vs. esperando vs. em MMIO, para o firmware de referência — isso valida (ou refuta) a
premissa central deste plano ANTES de investir nas fases seguintes.

### Fase 1 — Habilitar duas threads sem paralelismo real

**Objetivo**: separar PRO_CPU e APP_CPU em duas threads de host, mas com uma barreira TRIVIAL que
força serialização total entre elas (equivalente funcional ao RR de hoje, só que implementado como
2 threads se revezando explicitamente em vez de 1 thread iterando uma lista). Isso isola o risco de
"threading básico" (criação de thread, lifecycle, cleanup) do risco de "paralelismo real" — se algo
quebrar nesta fase, sabe-se que não é sobre concorrência de dados, é sobre a mecânica de threads em si.

**Código alterado**: item 1 e 2 da seção 6 (gate do MTTCG, adaptação do loop MTTCG para aceitar
icount), MAS com uma barreira artificial extra que impede as duas threads de estarem dentro de
`tcg_cpus_exec` ao mesmo tempo (ex.: um semáforo binário simples "é minha vez").

**Testes necessários**: a suíte de regressão completa do LasecSimul (CTest, os 47 testes atuais) +
o benchmark de firmware real (`mcu_blink_long_run_test`) — resultado esperado é **velocidade
idêntica ao RR atual** (não deveria ganhar nem perder nada nesta fase, é só uma reestruturação
mecânica). Qualquer mudança de velocidade aqui é sinal de bug.

**Critério de sucesso**: 47/47 testes passando, velocidade do benchmark dentro de ±5% do RR atual,
zero crashes/deadlocks em execuções repetidas (mínimo 20 execuções seguidas, seguindo a disciplina já
estabelecida nesta investigação para mudanças de concorrência).

### Fase 2 — Executar CPUs independentes (paralelismo real, sem MMIO/IPI ainda)

**Objetivo**: remover a barreira artificial da Fase 1 e permitir paralelismo real, mas **testado
primeiro contra um cenário sintético sem MMIO** (um "firmware" de teste que só faz cálculo puro em
loop em ambos os núcleos, sem tocar hardware) — isola o risco de "paralelismo de execução pura" do
risco de "sincronização de periféricos" (seção 4).

**Código alterado**: item 3 (orçamento de icount por-CPU independente, Alternativa B) e item 4
(relógio virtual com semântica "min dos locais") da seção 6.

**Testes necessários**: novo teste sintético (dois loops de cálculo puro, sem MMIO), comparando tempo
de parede necessário para completar um número fixo de instruções em RR vs. nesta fase — aqui SIM se
espera ganho de velocidade mensurável.

**Critério de sucesso**: ganho de velocidade real e reproduzível no cenário sintético sem MMIO
(evidência de que o paralelismo básico funciona); zero divergência no relógio virtual final entre
execuções repetidas do mesmo teste determinístico.

### Fase 3 — Sincronização de tempo com periféricos reais

**Objetivo**: reintroduzir MMIO — GPIO, UART, DPORT, IPI cross-core — sob paralelismo real.

**Código alterado**: item 5 e 6 (auditoria/locks de `mx_pic.c` e periféricos ESP32), item 7 (reescrita
do `simuliface.c`, Opção 2 da seção 7) — **esta é a fase que efetivamente entrega o valor do plano
inteiro, e também a de maior risco.**

**Testes necessários**: o firmware de referência completo (Blink+ADC+PWM+dual-core real), MÚLTIPLAS
execuções repetidas (mínimo 20-30, dado o histórico desta investigação de bugs de concorrência que só
aparecem ocasionalmente — ver `project_lasecsimul_scheduler_test_rare_hang_watch` como precedente de
um flake real de 1-em-21 encontrado nesta mesma base de código), testes específicos de IPI cross-core
(um firmware sintético que dispara `esp_crosscore_int_send_yield` em loop apertado, o pior caso de
contenção), e comparação de comportamento funcional bit-a-bit contra RR para o MESMO firmware
(transições de GPIO, valores de ADC, timing de PWM devem ser equivalentes, não precisam ser idênticos
no timestamp exato, mas o comportamento OBSERVÁVEL do circuito não pode mudar).

**Critério de sucesso**: nenhuma regressão funcional detectável no firmware de referência através de
30 execuções consecutivas; nenhum deadlock; interrupções cross-core entregues corretamente
(validado pelo teste sintético de IPI); ganho de velocidade mensurável (mesmo que menor que o cenário
sintético da Fase 2, dado o overhead de sincronização real).

### Fase 4 — Otimizações

**Objetivo**: só depois de tudo funcionalmente correto, otimizar o tamanho do quantum de
reconciliação (seção 3.6), reduzir overhead de qualquer lock que a Fase 3 precisou introduzir, revisar
se a Opção 2 da arena pode usar uma estrutura lock-free em vez de mutex por slot.

**Código alterado**: ajustes finos, guiados por profiling ao vivo (a MESMA técnica desta investigação
— GDB attach contra o processo real rodando o firmware de referência, não suposição).

**Testes necessários**: mesma suíte da Fase 3, repetida a cada ajuste, com medição de velocidade antes/
depois de cada mudança individual (nunca mudar duas coisas ao mesmo tempo sem medir separadamente —
lição direta desta investigação, onde uma comparação contra baseline desatualizado levou a atribuir
"4-5x" a uma mudança que na verdade contribuiu ~10%).

**Critério de sucesso**: velocidade final estável, reproduzível, e explicada (cada ganho atribuído
corretamente à mudança que o causou, não a um efeito combinado não-isolado).

---

## 9. Estratégia de testes

### Determinismo

Não determinismo bit-a-bit entre execuções (já não é uma garantia que o LasecSimul precisa ou tem
hoje sob RR+icount de qualquer forma, no sentido estrito) — mas sim **determinismo de comportamento
observável**: mesmo firmware, mesma sequência de entradas externas (nenhuma, no caso de um circuito
fixo), deve produzir a mesma sequência de transições de GPIO/ADC/PWM em toda execução, mesmo que os
timestamps exatos variem por alguns nanosegundos de tempo virtual entre execuções.

### Sincronização de periféricos

Teste sintético dedicado: dois "firmwares" mínimos (podem ser handcrafted, não precisam ser ESP-IDF
completo) — um que escreve GPIO do PRO_CPU em loop apertado, outro que LÊ esse mesmo GPIO do APP_CPU
em loop apertado — validando que a leitura sempre observa um valor que foi de fato escrito (nunca lixo
intermediário de uma escrita parcial), sob dezenas de execuções.

### Interrupções corretas

Teste sintético de IPI: PRO_CPU dispara uma interrupção cross-core para APP_CPU em um instante
conhecido (medido em instruções executadas pelo APP_CPU, não em tempo de parede), validar que
APP_CPU realmente processa a interrupção dentro de uma janela aceitável (não perdida, não duplicada,
não drasticamente atrasada).

### Ausência de race conditions

- Rodar a suíte completa (Fase 3 em diante) sob um sanitizador de threads se disponível para o
  toolchain MinGW/UCRT64 usado (`-fsanitize=thread`, TSan) — vale investigar disponibilidade antes de
  assumir; se não disponível nativamente no MinGW, considerar rodar uma build de validação sob WSL2/
  Linux com TSan como um passo de CI adicional só para essa validação específica (não precisa ser o
  build de produção Windows).
- Repetição estatística: mínimo 30 execuções consecutivas de cada teste de concorrência antes de
  considerar uma fase validada — precedente direto desta investigação (`scheduler_test` teve 1 flake
  em 21 execuções, só detectado por repetição, nunca apareceria em uma única run).

### Compatibilidade com firmware existente

O firmware de referência usado em toda esta investigação (`merged.bin`, Blink+ADC+PWM dual-core real)
é o teste de aceitação mínimo. Idealmente, complementar com pelo menos mais 1-2 firmwares reais de
projetos ESP-IDF típicos (algo com Wi-Fi ativo, já que o fork tem trabalho de WiFi/rede em andamento
per o commit `d4b1f77` desta mesma árvore) para cobrir um padrão de uso de MMIO mais pesado no
APP_CPU.

### Testes sintéticos vs. reais vs. comparação

| Tipo | Propósito | Quando |
|---|---|---|
| Sintético (cálculo puro, sem MMIO) | Isolar ganho de paralelismo puro | Fase 2 |
| Sintético (MMIO cross-core apertado) | Estressar o pior caso de contenção | Fase 3 |
| Sintético (IPI em loop) | Validar entrega de interrupção | Fase 3 |
| Real (firmware de referência) | Validar comportamento funcional fim-a-fim | Fase 3 e 4 |
| Comparação RR vs. MTTCG (mesmo firmware) | Quantificar ganho real, não estimado | Toda fase, obrigatório antes de declarar sucesso |

---

## 10. Estimativa realista

| Item | TB cache (já feito) | JSON/IPC (não feito) | MTTCG real (este plano) |
|---|---|---|---|
| Dificuldade | Baixa (1 constante) | Média-alta (protocolo inteiro) | **Muito alta** |
| Tempo estimado | Horas (já validado) | 1-3 semanas | **Múltiplas semanas a poucos meses**, não dias |
| Quantidade de código | ~10 linhas | Centenas de linhas, dezenas de arquivos | **Centenas a milhares de linhas**, dezenas de arquivos, em DOIS projetos (QEMU + Core) |
| Risco de regressão | Baixo (isolado, mensurável) | Médio-alto (superfície grande) | **Muito alto** (concorrência é a categoria de bug mais cara de encontrar e mais fácil de esconder — precedente direto: o flake de 1-em-21 já visto nesta mesma base) |
| Reversibilidade | Trivial (reverter 1 linha) | Moderada | **Difícil** — uma vez que o protocolo de arena muda de layout (seção 7), reverter exige coordenar o rollback dos dois lados (QEMU e Core) simultaneamente |

Este plano é, honestamente, de uma categoria de esforço completamente diferente dos 4 fixes já
entregues nesta investigação — cada um deles foi encontrado via profiling real e corrigido em uma
tarde. Isto aqui é um projeto de várias semanas com risco real de não terminar, ou de terminar e não
entregar o ganho esperado (seção 11).

---

## 11. Expectativa de ganho

**Não assumir 2x.** A premissa "duas CPUs em paralelo = 2x mais rápido" só vale se AMBAS as CPUs
estiverem 100% ocupadas com trabalho computacional independente o tempo todo, e se o overhead de
sincronização entre elas for desprezível — nenhuma das duas condições é garantida aqui.

### Cenário: firmware single-core (só usa PRO_CPU ativamente)

**Ganho esperado: próximo de zero, possivelmente negativo.** Se APP_CPU está majoritariamente em
`waiti` (idle), o fix `ee4775f` desta investigação já capturou a maior parte do benefício possível
disso (orçamento de icount não dividido por um núcleo ocioso). MTTCG real adicionaria overhead de
sincronização (barreiras, mutex da arena) sem nenhum trabalho paralelo real para compensar. **Este é
provavelmente o cenário do "código pequeno sem WiFi" mencionado nesta sessão** — se for esse o caso,
MTTCG não resolveria o problema que motivou a pergunta.

### Cenário: firmware dual-core pesado (ambos núcleos com trabalho computacional real e independente)

**Ganho esperado: melhor caso, mas bem abaixo de 2x na prática** — algo na faixa de 1.3x-1.6x seria um
resultado respeitável, considerando: overhead de sincronização por quantum (seção 3.6), contenção real
de BQL que hoje é zero (achado do profiling: BQL já era ~50% do tempo do QEMU ANTES do fix `12f645a`
mesmo com só uma CPU ativa por vez — com duas CPUs competindo pelo MESMO lock, isso pode piorar
proporcionalmente, não melhorar), e o custo da nova arena de 2 slots/fila (seção 7).

### Cenário: muito MMIO (GPIO/UART/PWM constante, como o firmware de referência desta investigação)

**Ganho esperado: o pior cenário para este plano.** Firmware MMIO-heavy é exatamente o que já mostrou
BQL como gargalo dominante mesmo em RR. Sob MTTCG real, esse MESMO gargalo (BQL) passa a ter
contenção genuína entre 2 CPUs simultâneas em vez de contenção com o iothread apenas — o overhead pode
CRESCER, não diminuir. Esta é uma descoberta contraintuitiva importante: **o firmware que mais
"precisaria" de paralelismo (por ser pesado) é o que menos se beneficiaria dele**, porque o gargalo
real dele já não é execução de instruções, é sincronização — que MTTCG não paraleliza, só reorganiza.

### Cenário: muito cálculo, pouco MMIO (hipotético — não é o perfil de nenhum firmware testado nesta investigação)

**Ganho esperado: o melhor caso real, potencialmente 1.5x-1.8x.** Mas esse perfil de firmware
(computação pesada, MMIO raro) não é representativo do uso típico do LasecSimul — a maioria dos
circuitos existe justamente para EXERCITAR periféricos (é o produto), então este cenário é mais teórico
que prático para os usuários reais do LasecSimul.

---

## 12. Recomendação final

**Se eu fosse responsável pelo projeto, NÃO implementaria MTTCG agora.**

### Por quê

1. **A relação esforço/ganho é desfavorável para o perfil de firmware real do LasecSimul.** O
   profiling desta própria investigação já mostrou que o firmware de referência é dominado por
   contenção de MMIO/BQL, não por execução pura de instruções — exatamente o cenário onde MTTCG ajuda
   MENOS (seção 11). Passar semanas implementando uma mudança cujo melhor caso realista é ~1.3-1.6x,
   quando o pior caso plausível é regressão de velocidade (mais contenção de BQL real, mais overhead
   de arena), é uma aposta ruim comparada ao ganho JÁ ENTREGUE de 26x nesta sessão via bugs muito mais
   baratos de corrigir.
2. **O risco de concorrência é qualitativamente diferente de tudo que foi corrigido até agora.** Os 4
   fixes desta investigação foram todos determinísticos e localmente verificáveis (uma constante, um
   `getenv()` cacheado, um lock/unlock em volta de um spin). MTTCG real introduz races cuja janela de
   manifestação pode ser rara (o precedente do flake de 1-em-21 já encontrado NESTA MESMA base de
   código, num contexto de concorrência muito mais simples que MTTCG, é um alerta direto e concreto).
3. **O protocolo de arena (`simuliface.c`) precisa ser reescrito, não ajustado** — isso é uma mudança
   cross-processo versionada (QEMU + Core), a categoria de mudança mais arriscada de todo o plano, e
   não pode ser feita isoladamente sem coordenar os dois lados.
4. **Existe uma alternativa mais barata e ainda não explorada**: o JSON/IPC entre Core e Extension
   (mencionado pelo usuário como próximo alvo) tem escopo grande mas é uma mudança DENTRO de um único
   projeto que o LasecSimul já controla totalmente (não precisa reconciliar com uma trava de segurança
   do QEMU upstream nem lidar com concorrência real entre CPUs), e tem precedente de sucesso desta
   mesma investigação (a arquitetura de `CommandQueue`/snapshot publicado do Scheduler, já implementada
   nesta sessão para o problema análogo entre Core e a fila de IPC, é diretamente reaproveitável como
   padrão de design).

### Qual seria a primeira etapa, se decidido seguir em frente mesmo assim

**Fase 0 apenas** (seção 8) — instrumentar e medir, com o firmware de referência real, exatamente
quanto tempo cada CPU passa em MMIO vs. computação pura HOJE, com granularidade por-núcleo (não só
agregada, como o profiling desta sessão já fez). Se essa medição mostrar que APP_CPU tem uma fração
substancial de tempo em computação pura e independente (não MMIO, não idle), a expectativa de ganho
da seção 11 fica mais favorável e justificaria avançar para a Fase 1. Se mostrar o que o profiling já
sugere (dominado por MMIO/BQL ou por ociosidade), a resposta already está nos dados: não vale a pena
para o firmware real que o LasecSimul precisa suportar, e o esforço deveria ir para JSON/IPC ou outras
otimizações de custo-benefício muito melhor, como as 4 já entregues nesta sessão.

### Motivos pelos quais esta ideia pode falhar, mesmo bem executada

- O overhead de sincronização da Alternativa B (seção 3.6) pode, na prática, consumir todo o ganho de
  paralelismo para firmware MMIO-heavy — só medição real (Fase 0/2) confirma isso, mas é uma
  possibilidade genuína, não hipotética.
- Bugs de concorrência em `mx_pic.c`/periféricos podem ser sutis o suficiente para passar despercebidos
  por semanas de teste e só aparecer em produção com firmware real de usuário (não o de referência) —
  o histórico desta mesma investigação (flake de scheduler) é evidência direta de que esse tipo de bug
  acontece nesta base de código especificamente, não é um risco abstrato.
- A reescrita da arena (Opção 2, seção 7) pode se revelar, na prática, mais cara que o Item 7 sozinho
  sugere — mudanças de protocolo cross-processo versionadas tendem a ter custo de coordenação maior do
  que o código em si sugere (testes, compatibilidade, rollback).
- Mesmo que tudo funcione, o ganho medido pode ficar abaixo até da estimativa conservadora da seção 11
  — CPUs modernas já têm ótima performance de branch prediction/cache para o padrão RR atual (uma
  thread, alternando CPUs, mas com working set pequeno o suficiente para caber em cache), e paralelismo
  real introduz o custo adicional clássico de MTTCG (cache-line bouncing entre threads reais em núcleos
  físicos diferentes) que pode compensar parte do ganho teórico de forma não-óbvia até medir.
