# Plano de revisão arquitetural completa do Core — desempenho, latência e concorrência

Documento de planejamento. **Nenhuma mudança de código foi feita para produzir este documento**, com
exceção dos 5 fixes já implementados, medidos e commitados nas sessões anteriores desta mesma
investigação (listados na seção 0, mantidos aqui como linha de base, não como propostas). Todas as
referências a arquivo/linha apontam para o estado atual do repositório
(`c:\SourceCode\LasecSimul\core\src`, `core\include\lasecsimul`, `core\test`).

Contexto de origem: esta investigação começou com o sintoma "taxa de simulação em ~1%" e evoluiu,
através de perfilamento ao vivo real (GDB attach contra os processos Core e QEMU rodando o firmware do
usuário, não suposição), por uma cadeia de achados que levou a taxa a ~24-27% para o firmware de teste
mais leve, e a um salto de ~5.9% para ~25.5% no benchmark de estresse interno (PWM contínuo). O usuário
pediu, nesta etapa, uma revisão de ponta a ponta de TODO o Core — não mais caça a bugs pontuais — com
liberdade total para redesenhar contratos internos, ABI, IPC e o modelo de concorrência, desde que
nenhuma funcionalidade existente seja perdida.

---

## 0. Linha de base: o que já foi corrigido, medido e commitado

Estes 5 itens não são propostas — são fatos já estabelecidos que todo o resto deste documento assume
como ponto de partida.

| # | O quê | Onde | Ganho medido |
|---|---|---|---|
| F0 | Corrida de inicialização desconectava o MCU do resto do circuito silenciosamente (`resolveCustomEditor` podia rodar antes de `loadDeviceLibrary` terminar) | `extension/src/extension.ts`, `state.ts`, `coreLifecycle.ts` | Estava mascarando TUDO abaixo como "1%" — não era um problema de desempenho do Core |
| F1 | `analogTraceEnabled()` chamava `std::getenv()` (que varre o bloco de ambiente inteiro) em toda leitura/escrita de GPIO/ADC | `mcu-adapters/espressif-esp32/src/Esp32Adapter.cpp` | **O maior ganho de toda a investigação**: 2-3% → 26% ao vivo |
| F2 | QEMU segurava o BQL (Big QEMU Lock) durante o busy-wait esperando o Core responder | `qemu_lasecSimul/softmmu/simuliface.c` (`waitForSynch`, `readReg`) | +3-9%, modesto mas real |
| F3 | Cache de translation block do QEMU (`CPUJumpCache`) direto-mapeado com só 4096 entradas, colisões forçando fallback caro | `qemu_lasecSimul/accel/tcg/tb-jmp-cache.h` | +10-13% isolado (inicialmente super-atribuído a 4-5x por comparação contra baseline desatualizada — erro corrigido nesta mesma investigação) |
| F4 | `enqueueCommand()` sempre passava pela fila de comandos (aloca `std::promise`, bloqueia em `future.get()`) mesmo quando quem chamava já era a própria thread do Scheduler | `core/src/session/SimulationSession.cpp`, `core/src/simulation/Scheduler.hpp/.cpp` | Correto e validado (14 rodadas completas da suíte + 80 execuções isoladas, zero falhas), mas sem ganho visível mensurável no firmware de teste específico — mantido por ser uma correção real |

Conclusão da linha de base: **os dois achados que realmente mudaram o resultado foram a correção de
uma corrida de dados (não desempenho) e uma alocação de sistema (`getenv`) escondida no caminho quente.
Tudo depois disso rendeu cada vez menos** — um padrão de retornos decrescentes que motiva diretamente a
pergunta central deste documento: não há mais nenhum bug único e óbvio sobrando; o que resta é uma
combinação de dezenas de ineficiências pequenas e um teto arquitetural real (o ping-pong síncrono
Core↔QEMU, e o modelo de concorrência do Core como um todo).

---

## 1. Diagnóstico completo da arquitetura atual

### 1.1 Visão geral de processos

```
Extension (Node.js/TS, processo separado, mandado pelo VS Code)
    │  JSON linha-a-linha sobre named pipe / unix socket
    ▼
Core (C++ nativo, ESTE documento)
    │  memória compartilhada (arena de 1 slot), handshake síncrono
    ▼
QEMU (processo separado por MCU com firmware carregado)
```

Três processos, dois protocolos de fronteira completamente diferentes: IPC baseado em texto JSON entre
Extension↔Core (existe porque a Extension É uma extensão do VS Code, Node.js, não pode ser evitado sem
deixar de ser uma extensão do VS Code); e uma arena de memória compartilhada binária entre Core↔QEMU
(mesmo protocolo que o SimulIDE usa, confirmado nesta investigação, fork idêntico).

### 1.2 O Core por dentro: threads confirmadas (7 pontos de criação de thread)

| Thread | Criada em | Ciclo de vida | Toca |
|---|---|---|---|
| **Scheduler worker** | `Scheduler.cpp:198`, no primeiro `start()`/`resume()` | Preguiçosa — só existe depois do usuário apertar Play | Netlist, instâncias de componente, MnaSolver, TUDO que `settleStep()` toca |
| **Leitor stdout/stderr do QEMU** | `QemuProcessManager.cpp:111`/`:140`, uma por `McuController`/`McuComponent` com firmware carregado | Por instância de MCU | Só `m_logs`/`m_logBytes` sob `m_logMutex` — nunca toca a arena |
| **Notificação IPC** | `IpcServer.cpp:23`, no construtor — existe desde o início do processo | Vida inteira do processo | Consome `m_notificationQueue`, escreve no pipe via `sendLine()` |
| **Watchdog de plugin (efêmera)** | `PluginWatchdog.hpp:38`, uma por chamada com timeout≠0 | Uma por chamada — `join()` se terminar a tempo, `detach()` pra sempre se não | O que quer que a chamada ABI protegida toque |
| **Pool do MnaSolver** | `ThreadPool.hpp:24`, `hardware_concurrency()-1` workers persistentes, criados uma vez na construção da `SimulationSession` | Vida inteira do processo | Só grupos `CircuitGroup` dirty, só quando `estimatedWork ≥ 250.000` |
| **`IpcServer::processLoop()`** | **NÃO é uma thread separada** — roda na thread PRINCIPAL do processo (`main.cpp` → `CoreApplication::run()`) | Vida inteira do processo | Lê, despacha (`handleMessage()`, uma cadeia sequencial de 39 `if`), escreve — tudo inline, síncrono |
| — | — | — | — |

Máquina de 12 threads de hardware disponíveis (`hardware_concurrency()`); na prática, para um circuito
pequeno/médio típico do LasecSimul, **apenas 2 threads fazem qualquer trabalho real durante uma
simulação em execução** (Scheduler worker + thread principal/IPC) — o pool do MnaSolver existe mas fica
parado (ver achado ARCH-03 abaixo), e a thread leitora de log do QEMU e a de notificação IPC são
essencialmente ociosas na maior parte do tempo.

### 1.3 Mapa de dependências

```
CoreApplication (thread principal)
 ├─ IpcServer (mesma thread — processLoop() é inline, não uma thread própria)
 │   └─ handleMessage() [39 branches if/else sequenciais] ──┐
 │                                                            │
 ├─ SimulationSession                                        │
 │   ├─ Netlist / Topology (std::vector, integer-indexed)     │
 │   ├─ CommandQueue (fila pra mutação vinda da thread IPC)   │
 │   ├─ MnaSolver → ThreadPool (12 threads, raramente ativa)  │
 │   ├─ std::vector<unique_ptr<IComponentModel>> (40 tipos)   │
 │   │    ├─ 39 built-ins (chamada virtual direta)            │
 │   │    └─ NativeDeviceProxy (+ device_abi.h, CrashGuard)   │
 │   │         └─ GlobalPluginCache (DLL, cacheado 1x)        │
 │   └─ McuComponent (IComponentModel também)                 │
 │        ├─ QemuModuleProxy (ponte por-pino)                 │
 │        ├─ McuController → QemuProcessManager                │
 │        │    ├─ processo QEMU real (arena de memória)       │
 │        │    └─ thread leitora de stdout/stderr             │
 │        └─ m_callbackState->mutex (recursive, ver PERF-09)  │
 │                                                              │
 └─ Scheduler (thread própria, m_thread) ◄─────────────────────┘
      └─ settleUntilStableLocked() → CircuitGroup::solve()
```

### 1.4 Caminhos quentes confirmados por perfilamento ao vivo (não suposição)

Medição direta e intercalada (GDB attach simultâneo em Core e QEMU, mesma janela de tempo, firmware
real do usuário rodando):

- **QEMU: 73% do tempo ocupado, 27% ocioso** — dispatch TCG genuíno (`tb_lookup`, `mmu_lookup`,
  `xtensa_restore_state_to_opc`, `memory_region_dispatch_read1`), sem mais contenção de lock (BQL já
  corrigido).
- **Core: 100% do tempo ocupado, NUNCA pego ocioso em 30 amostras** — significa que hoje **o Core é o
  lado mais lento do par Core↔QEMU**, não o QEMU. 27 pontos percentuais de folga do QEMU sendo
  desperdiçados esperando o Core.
- Dentro do Core, a thread única resolvida via mapa de símbolos MSVC mostrou: solve Eigen/Newton-Raphson
  real (`CircuitGroup::solve`, `Eigen::general_matrix_vector_product`), parsing/serialização JSON
  (`nlohmann::json::sax_parse_internal`), despacho de plugin (`CrashGuard::call`,
  `QemuModuleProxy::isOutputEnabled/setInputVoltageAt`), bookkeeping do Scheduler
  (`settleUntilStableLocked`, `publishSnapshot`, `drainCommandQueue`) — um mix genuinamente distribuído,
  sem mais nenhum vilão único e óbvio.

---

## 2. Gargalos encontrados (síntese, detalhe na matriz da seção 6)

Categorizando tudo que foi encontrado nesta revisão (incluindo os 3 agentes de pesquisa despachados
especificamente pra esta etapa), por natureza:

1. **Alocação dinâmica em caminho quente** — `NativeDeviceProxy::stamp()` (heap por chamada,
   `std::make_unique<AbiMatrixContext>`), `CommandQueue::takeAll()` (já mitigado por F4, mas o
   `std::deque` em si ainda aloca quando não-vazio).
2. **Reconstrução redundante** — `propertyDescriptors()` recria `std::vector<PropertyDescriptor>` +
   closures `std::function` frescos a cada chamada, mesmo fora do caminho de settle.
3. **Retransmissão de payload completo em vez de delta** — `getMcuLogs` sempre devolve o buffer INTEIRO
   (até 1 MiB) a cada poll de ~500ms, não só o que mudou.
4. **Overhead de codificação** — `getComponentStates`/`getComponentState` hex-codificam bytes (dobra o
   tamanho) antes do JSON; barato por byte (tabela de lookup, não `sprintf`), mas ainda 2x o volume
   necessário.
5. **Lock mantido por mais tempo do que precisa** — `McuComponent::m_callbackState->mutex` (recursive)
   fica preso durante TODO o corpo de `onPollEvent()`, incluindo o laço de busy-wait inteiro — mesma
   classe do bug de head-of-line-blocking que o time já caçou e corrigiu em vários outros lugares
   (`getNodeVoltage`, `drainUart`, `componentHealth`), mas que ainda não chegou aqui.
6. **Zero pipelining na camada de transporte IPC** — `IpcServer::processLoop()` é estritamente
   ler→despachar→escrever→ler, sem nenhuma sobreposição; e a escrita pode travar a MESMA thread que
   precisaria ler a próxima mensagem se o cliente (a Extension) for lento pra drenar o pipe.
7. **Serialização do trabalho entre múltiplos MCUs** — TODOS os callbacks agendados (inclusive
   `onPollEvent()` de CADA MCU) rodam na ÚNICA thread do Scheduler, sequencialmente — um projeto com 2+
   MCUs não ganha paralelismo nenhum entre eles hoje, mesmo sendo trabalho genuinamente independente
   (arenas/processos QEMU distintos).
8. **Paralelismo que já existe mas raramente ativa** — o `ThreadPool` do `MnaSolver` só desperta acima
   de 250.000 unidades de trabalho estimado; circuitos pequenos/médios típicos do LasecSimul
   provavelmente nunca cruzam esse limiar, deixando 10 dos 12 núcleos ociosos na prática.
9. **O ping-pong síncrono Core↔QEMU** — arquitetural, tratado em detalhe na seção 5 (é o requisito
   obrigatório do usuário).
10. **Cobertura de teste insuficiente para uma refatoração segura** — 22 dos 39 tipos de mensagem IPC
    não têm nenhuma cobertura via JSON real (só chamadas C++ diretas em `SimulationSession`); nenhum
    teste com múltiplos MCUs simultâneos; testes de plugin real que **silenciosamente viram sucesso**
    (`return 0`) se o artefato não estiver compilado — risco de visibilidade de cobertura, não só de
    cobertura.

---

## 3. Oportunidades de ganho — pequenas e de baixo risco

Estas podem ser implementadas isoladamente, uma de cada vez, medidas individualmente, sem depender de
nenhuma mudança maior.

### PERF-05 — `NativeDeviceProxy::stamp()` aloca heap a cada chamada

**Problema atual**: `core/src/plugins/NativeDeviceProxy.cpp:128` — `std::make_unique<AbiMatrixContext>`
toda vez que QUALQUER dispositivo baseado em plugin (não built-in) é estampado, uma vez por settle, por
componente.

**Por que prejudica**: mesma classe do bug `getenv()` (F1) — uma alocação de heap isoladamente barata,
mas paga em TODO stamp de TODO dispositivo-plugin, toda iteração de settle.

**Proposta**: mover `AbiMatrixContext` para um membro reutilizável de `NativeDeviceProxy` (um por
instância, não um por chamada), reinicializado in-place a cada `stamp()` em vez de recriado.

**Ganho esperado**: pequeno a moderado — depende de quantos dispositivos-plugin (vs. built-in) o
projeto do usuário tem. Para um projeto pesado em plugins (ex.: muitos dispositivos SimulIDE-portados
via `device_abi.h`), pode ser comparável ao ganho do `getenv()` em proporção; pra um projeto majoritário
em built-ins, pequeno.

**Como medir**: perfilamento ao vivo antes/depois (mesma técnica desta investigação), contando
alocações/segundo via um contador temporário em `operator new`/`operator delete` (mesmo padrão já usado
pra medir o achado do `CommandQueue`).

**Risco de regressão**: baixo — mudança isolada, sem alterar semântica observável.

**Funcionalidades afetadas**: todo dispositivo carregado via `device_abi.h` (ver inventário completo,
seção 8).

**Testes necessários**: `plugin_runtime`, `plugin_checksum`, `logic_gate_plugin` (já existentes,
suficientes pra confirmar comportamento funcional idêntico).

**Dependências**: nenhuma.

**Prioridade**: Alta (barato, isolado, mesma classe de bug que já rendeu o maior ganho da investigação).

**Isolada ou precisa de refatoração maior?**: Totalmente isolada.

---

### PERF-06 — `getMcuLogs` sempre retransmite o buffer inteiro

**Problema atual**: `app/CoreApplication.cpp:1870`, polled a cada ~500ms
(`QemuProcessManager.cpp:234-236`'s próprio comentário confirma a cadência do lado
`mcuCommands.ts::pollLogs`) enquanto o monitor serial está aberto — sempre devolve TODO o buffer de log
acumulado (até 1 MiB, já limitado por um fix anterior de 2026-07-08), não um delta.

**Por que prejudica**: cópia + serialização JSON de até 1 MiB a cada 500ms é desperdício puro quando só
algumas linhas novas foram adicionadas desde o poll anterior.

**Proposta**: adicionar um cursor/offset (ex.: "byte a partir de onde continuar") ao protocolo —
`getMcuLogs` aceita um `sinceOffset` opcional e devolve só o que é novo, ou um verbo separado
`getMcuLogsDelta`.

**Ganho esperado**: moderado, proporcional a quanto log o firmware realmente produz — pra firmware
silencioso, quase todo esse tráfego de 500ms em 500ms é desperdiçado carregando o MESMO 1 MiB repetido.

**Como medir**: bytes transmitidos por segundo neste verbo especificamente, antes/depois, com um
firmware que produz log continuamente (pior caso) e um que não produz nada (melhor caso pro fix).

**Risco de regressão**: baixo-médio — muda o contrato da mensagem (retrocompatibilidade não é exigida,
projeto em beta), mas precisa cuidado pra não perder linhas se o offset for mal calculado.

**Funcionalidades afetadas**: monitor serial / logs do MCU na UI.

**Testes necessários**: novo teste de caracterização do formato atual antes de mudar (ver seção 9), mais
teste do novo comportamento incremental.

**Dependências**: nenhuma, mas se combinado com PERF-10 (transporte IPC) vale desenhar junto.

**Prioridade**: Média.

---

### PERF-07 — `propertyDescriptors()` reconstrói vetor + closures a cada chamada

**Problema atual**: `NativeDeviceProxy::propertyDescriptors()` (`NativeDeviceProxy.cpp:207-272`) aloca
um `std::vector<PropertyDescriptor>` novo com `std::function` frescos toda vez que é chamado — não está
no caminho de settle (confirmado pelos agentes de pesquisa), mas É chamado sempre que a UI abre/atualiza
um painel de propriedades.

**Proposta**: cachear o vetor de descritores por instância, invalidando só quando o schema realmente
muda (raro — normalmente fixo por typeId).

**Ganho esperado**: pequeno — não é caminho quente de settle, só importa pra responsividade da UI de
propriedades quando aberta.

**Como medir**: tempo de resposta do verbo `getPropertySchemas`/`getProperty` antes/depois com muitos
dispositivos-plugin no projeto.

**Risco de regressão**: baixo.

**Funcionalidades afetadas**: painel de propriedades.

**Testes necessários**: `property_definition` (já existe).

**Dependências**: nenhuma.

**Prioridade**: Baixa.

---

### PERF-08 — Codificação hex duplica o volume de `getComponentState(s)`

**Problema atual**: `CoreApplication.cpp:1679,1691-1693` (e o equivalente em `getComponentState`
singular) hex-codifica bytes brutos antes de embutir no JSON — cada byte vira 2 caracteres.

**Proposta**: usar Base64 (overhead de ~33% em vez de 100%) ou, se uma mudança maior de transporte
(PERF-10/PERF-13) acontecer, um framing binário que não precise de codificação de texto nenhuma.

**Ganho esperado**: pequeno a moderado, proporcional ao volume de telemetria por poll — mais relevante
se combinado com uma mudança maior de transporte.

**Como medir**: bytes/segundo no verbo `getComponentStates` com muitos componentes de telemetria ativos
(osciloscópio, múltiplos voltímetros).

**Risco de regressão**: baixo — é troca de codec, não de semântica.

**Funcionalidades afetadas**: qualquer instrumento/telemetria lida via `getComponentState(s)`.

**Testes necessários**: cobrir o formato atual antes de mudar (não existe teste de caracterização deste
formato específico hoje — ver seção 9).

**Dependências**: nenhuma isoladamente; ganho maior se parte de PERF-10.

**Prioridade**: Baixa-Média.

---

### PERF-15 — Validação de propriedade duplicada

**Problema atual**: `SimulationSession::setPropertyUnlocked` (`SimulationSession.cpp:678-705`)
reimplementa a mesma lógica de `PropertyDefinition::validatePropertyValue` (`PropertyDefinition.hpp:26-56`)
em vez de chamá-la.

**Por que prejudica desempenho**: não prejudica diretamente — é principalmente um risco de manutenção
(as duas implementações podem divergir silenciosamente). Incluído aqui porque o usuário pediu para
registrar TODA oportunidade encontrada, mesmo as que não são de desempenho puro.

**Proposta**: unificar em uma única função chamada dos dois lugares.

**Ganho esperado**: nenhum ganho de desempenho direto; ganho de corretude/manutenibilidade.

**Risco de regressão**: baixo, mas precisa confirmar que as duas implementações são de fato idênticas
hoje antes de unificar (podem ter divergido sem teste que capture a diferença).

**Prioridade**: Baixa (não é desempenho, mas barato de resolver quando outras mudanças tocarem essa
área).

---

## 4. Oportunidades de ganho — intermediárias

### PERF-09 — Mutex recursivo do `McuComponent` mantido durante todo o busy-wait

**Problema atual**: `m_callbackState->mutex` (`McuComponent.hpp:99`, `std::recursive_mutex`) é adquirido
pela lambda que agenda `onPollEvent()` (`McuComponent.cpp:100`) e permanece travado durante TODO o corpo
de `onPollEvent()`, incluindo o laço de busy-wait com `yield()` inteiro (`:110-135`) — não é
travado/destravado por iteração, é travado uma vez e mantido pela duração inteira da espera.

**Por que prejudica**: é exatamente a mesma classe de bug de head-of-line-blocking que o time já
encontrou e corrigiu repetidamente em outros lugares (`getNodeVoltage` → snapshot publicado,
`drainUart` → `tryDrainUartRx`, `componentHealth` → `trySynchronized`) — mas este ponto específico ainda
não recebeu o mesmo tratamento. Qualquer outro código que precise deste mutex (ex.: `stamp()`,
`health()`, o destrutor) fica bloqueado pela duração inteira da espera do QEMU.

**Mitigação parcial já existente**: `health()` (chamado via IPC `getComponentHealth`) já passa por
`m_scheduler.trySynchronized()` no nível do Scheduler, então não trava a thread IPC indefinidamente —
mas isso não elimina a contenção no PRÓPRIO `m_callbackState->mutex`, só evita que a thread IPC fique
presa esperando por ele.

**Proposta**: restringir o escopo do lock — travar só pra ler o estado necessário no início e escrever
o resultado no final, soltando durante o próprio laço de espera (que não precisa do lock pra fazer
`arena.poll()`, já que a arena tem seu próprio protocolo de sincronização entre processos independente
deste mutex).

**Ganho esperado**: precisa validar por benchmark — a natureza exata do ganho depende de quem mais
tenta usar este lock durante a janela de espera (hoje possivelmente ninguém, dado que é tudo
Scheduler-thread-confined na prática), mas o RISCO de head-of-line-blocking latente é real e vale
eliminar preventivamente, na mesma linha da disciplina já aplicada em todo o resto do código.

**Como medir**: mesmo teste de responsividade usado pra validar os fixes anteriores de HOL blocking —
chamar `health()`/`stamp()` durante um período de espera longa do QEMU e medir latência de resposta
antes/depois.

**Risco de regressão**: médio — precisa reconfirmar que nada dentro do laço de `onPollEvent()`
genuinamente precisa do lock mantido (ex.: reentrância documentada com `scheduleModuleWakeup`).

**Funcionalidades afetadas**: qualquer coisa que toque `McuComponent` durante uma espera ativa do QEMU.

**Testes necessários**: `mcu_component`, `mcu_controller_real_qemu`, `mcu_blink_long_run` (rodar
repetidamente, como sempre nesta investigação para mudanças de concorrência).

**Dependências**: nenhuma, mas relacionado conceitualmente a PERF-13 (decoupling Core↔QEMU) — se
PERF-13 for implementado, este ponto pode precisar de redesenho de qualquer forma.

**Prioridade**: Média-Alta.

---

### PERF-11 — `m_sendMutex` compartilhado entre resposta e notificação cria travamento cross-thread

**Problema atual**: `IpcServer.hpp:70`, `m_sendMutex` protege TODA escrita no pipe/socket, e é disputado
por DUAS threads: a principal (`processLoop()`, respostas) e a de notificação
(`notificationLoop()`, pushes assíncronos como `pauseConditionTriggered`). Como as duas escrevem no
MESMO pipe físico, o mutex é necessário pra corretude (evitar interleaving corrompendo o framing
newline-delimitado) — mas significa que uma escrita lenta de QUALQUER lado trava o outro.

**Por que prejudica**: se a Extension for lenta pra drenar o pipe bem no momento em que uma notificação
está sendo escrita, a thread PRINCIPAL (que processa TODAS as mensagens request/response, inclusive as
hot paths como `getNodeVoltage`) fica bloqueada esperando o mutex, mesmo que a resposta dela não tenha
nada a ver com a notificação em trânsito.

**Proposta**: fila de saída única com um único escritor dedicado (uma terceira thread, ou reaproveitar a
de notificação como "a única que escreve", com `processLoop()` só enfileirando respostas em vez de
escrever diretamente) — elimina a disputa de mutex entre dois ESCRITORES concorrentes, trocando por um
produtor-consumidor com um único consumidor.

**Ganho esperado**: precisa validar por benchmark — depende de quão frequentes são as notificações
assíncronas (hoje, principalmente `pauseConditionTriggered`, relativamente raro) versus quão sensível é
a latência dos hot paths de resposta. Provavelmente pequeno na prática atual, mas remove um risco
estrutural real.

**Como medir**: latência de resposta a `getNodeVoltage` sob uma carga sintética de notificações
frequentes, antes/depois.

**Risco de regressão**: médio — mexe na camada de transporte IPC, usada por TUDO.

**Funcionalidades afetadas**: toda comunicação Core↔Extension.

**Testes necessários**: `core_bootstrap` (o único teste real de IPC hoje — ver lacuna de cobertura,
seção 9), mais testes novos especificamente pra esta mudança.

**Dependências**: relacionado a PERF-10 (pipelining geral do IPC) — melhor decidido junto.

**Prioridade**: Média.

---

### PERF-14 — Paralelismo do `MnaSolver` provavelmente nunca ativa para circuitos típicos

**Problema atual**: `MnaSolver.hpp:53`, `m_parallelWorkThreshold = 250.000` (unidades de trabalho
estimado, O(n³) pra grupos que precisam refatorar, O(n²) pra substituição). Um pool de 11 threads
persistentes (`hardware_concurrency()-1`) existe e é mantido vivo o processo inteiro, mas só é acionado
acima desse limiar — para os circuitos pequenos/médios típicos do LasecSimul (poucas dezenas de nós por
grupo), este limiar provavelmente nunca é cruzado, deixando o solve real sempre no caminho sequencial de
fallback (`MnaSolver.hpp:44`).

**Por que prejudica**: não é bug — é uma decisão de engenharia deliberada e correta (o comentário do
próprio código explica: "Thread dispatch custa mais que uma substituição LU pequena"), mas significa
que, na prática, **10-11 dos 12 núcleos disponíveis ficam ociosos durante o solve pra praticamente todo
projeto real do usuário**, mesmo com a infraestrutura pronta.

**Proposta — não é "baixar o limiar"** (isso pioraria as coisas pra circuitos pequenos, contrariando o
próprio raciocínio documentado no código). Duas alternativas reais valem avaliar:
  - **Opção A**: reaproveitar o MESMO `ThreadPool` pra paralelizar OUTRO trabalho que não seja o solve
    em si — por exemplo, o laço de `stamp()` de componentes independentes (linha 1271 de
    `SimulationSession.cpp`), que hoje é sequencial componente-por-componente mesmo quando dois
    componentes não compartilham nenhum estado.
  - **Opção B**: usar o pool pra paralelizar entre MÚLTIPLOS MCUs (ver PERF-12 abaixo) — um uso
    genuinamente mais alinhado com "trabalho grande o bastante pra valer a pena", já que cada MCU
    representa um processo QEMU inteiro com sua própria espera de I/O, não uma substituição LU pequena.

**Ganho esperado**: **precisa de validação por benchmark antes de qualquer decisão** — não há dados
hoje sobre se paralelizar `stamp()` cruza o limiar de valer a pena (`stamp()` de um componente
built-in simples é provavelmente mais barato ainda que uma substituição LU pequena). Marcar
explicitamente como "ganho desconhecido, medir antes de investir".

**Como medir**: instrumentar `estimatedWork` real observado durante uma sessão de uso típica (não
sintética) e comparar contra o limiar de 250.000 — se o valor real observado estiver consistentemente
1-2 ordens de grandeza abaixo, confirma que o pool está dormente na prática; se estiver perto, o limiar
pode só precisar de ajuste fino, não de redesenho.

**Risco de regressão**: baixo pra só medir; médio pra qualquer mudança real de onde/como o pool é usado.

**Funcionalidades afetadas**: desempenho geral do solve, potencialmente nada funcional.

**Testes necessários**: `mna_solver`, `circuit_group`, mais instrumentação nova de medição (não
regressão funcional).

**Dependências**: informa a decisão em PERF-12.

**Prioridade**: Média (a MEDIÇÃO é alta prioridade e barata; a AÇÃO depende do resultado dela).

---

## 5. Mudanças estruturais — o desacoplamento Core↔QEMU (obrigatório)

### 5.1 O modelo atual, exatamente como é

```
QEMU (thread TCG única)              Core (thread do Scheduler)
   │                                       │
   │ executa N instruções                  │
   │ escreve na arena (1 slot)             │
   │ ─────────────────────────────────────▶│
   │ gira esperando (busy-spin)             │ onPollEvent() nota o evento
   │                                        │ despacha pro McuComponent
   │                                        │ (pode marcar dirty → resolve)
   │◀───────────────────────────────────── │ reconhece (acknowledgeWrite/Read)
   │ retoma execução                       │
```

Cada acesso a registrador (leitura OU escrita) e cada heartbeat periódico (`simu_event`, a cada ~3125
instruções reais a shift=4) passa por este ciclo completo. **Os dois lados nunca calculam ao mesmo
tempo** — confirmado pela medição intercalada da seção 1.4 (QEMU 27% ocioso esperando o Core; Core 100%
ocupado, nunca visto esperando o QEMU nas amostras).

### 5.2 Por que síncrono hoje, e o que genuinamente precisa continuar síncrono

- **Escritas** (`writeReg`) já são "dispara e esquece" no protocolo atual — não esperam confirmação de
  processamento, só esperam o slot anterior estar livre.
- **Leituras** (`readReg`) precisam de um valor de volta — inerentemente têm que esperar pelo menos até
  o Core ter processado tudo que pode afetar aquele valor.
- **O heartbeat** (`simu_event`) existe pra manter o relógio virtual do QEMU sincronizado com o tempo do
  Core — mas ele mesmo não carrega nenhum dado que precise de resposta imediata, só precisa que a arena
  esteja livre pra registrar o evento.

**Insight central**: a exigência REAL de sincronia é só sobre LEITURAS que dependem de ESCRITAS
anteriores ainda não aplicadas. Escritas entre si, e o heartbeat, não têm essa dependência — podem ser
enfileiradas e aplicadas em ordem, sem que o QEMU precise parar e esperar CADA uma individualmente.

### 5.3 Alternativas de design

#### Alternativa A — Fila/anel de múltiplos slots para escritas, leitura ainda síncrona

Amplia a arena de 1 slot pra uma fila circular limitada (N entradas, ex.: 16-64) de eventos
pendentes. `writeReg`/heartbeat só bloqueiam se a fila estiver CHEIA (mecanismo de backpressure natural
e explícito); `readReg` continua exigindo que a fila esteja COMPLETAMENTE drenada antes de ler (garante
que a leitura reflita todas as escritas anteriores).

- **Vantagens**: mudança cirúrgica, mantém a MAIOR PARTE do protocolo existente intacta (ainda é uma
  arena de memória compartilhada, ainda é polling do lado Core); backpressure explícito e correto por
  construção (fila cheia = quem produz espera); leituras continuam determinísticas/corretas sem
  nenhuma mudança de semântica.
- **Desvantagens**: leituras continuam pagando o custo de drenar TUDO que está pendente — se o firmware
  intercalar muitas escritas com leituras frequentes, o ganho encolhe; dimensionamento da fila (N) é um
  parâmetro que precisa de medição real, não chute.
- **Impacto no desempenho**: alto pra firmware write-heavy (GPIO/PWM contínuo, exatamente o padrão do
  benchmark de estresse desta investigação); baixo pra firmware read-heavy (ADC polling constante).
- **Complexidade de implementação**: média — muda o ABI da arena (`qemu_arena_abi.h`), precisa
  coordenar os dois lados (QEMU fork E Core) simultaneamente, mas o CONCEITO é uma extensão natural do
  que já existe.
- **Risco técnico**: médio — risco real de corromper ordem de eventos se a implementação da fila
  tiver um bug sutil; mitigável com o mesmo rigor de teste (rodar repetidamente, checar determinismo)
  já usado nesta investigação pros fixes de concorrência do Scheduler.
- **Impacto em dispositivos existentes**: nenhum diretamente — é uma mudança interna ao bridge
  Core↔QEMU, não ao modelo de dispositivo genérico (`device_abi.h` não muda).
- **Capacidade de evolução futura**: boa — a fila pode crescer/encolher, o tamanho pode virar
  configurável por firmware/perfil de uso.

#### Alternativa B — Duas arenas independentes (comandos vs. eventos), cada uma com seu próprio ritmo

Separa completamente o canal de "Core→QEMU" (interrupções, GPIO de entrada) do canal "QEMU→Core"
(escritas de registrador, heartbeat), cada um com seu próprio protocolo de sincronização, permitindo que
QEMU processe comandos de entrada e gere eventos de saída em paralelo genuíno, não apenas intercalado.

- **Vantagens**: paralelismo mais completo que a Alternativa A — não há mais UM ponto de
  sincronização compartilhado, então nem heartbeat nem GPIO-de-entrada competem pelo mesmo gargalo.
- **Desvantagens**: mais complexa de raciocinar corretamente — duas arenas independentes precisam de
  uma noção clara de ORDEM RELATIVA quando ambas importam ao mesmo tempo (ex.: uma interrupção chegando
  exatamente quando uma escrita de GPIO está em trânsito) — risco de reordenamento incorreto se não for
  cuidadosamente desenhado.
- **Impacto no desempenho**: potencialmente maior que a Alternativa A no caso ideal, mas com mais
  incerteza — precisa de validação extensa antes de confiar no ganho.
- **Complexidade de implementação**: alta — duas máquinas de estado de sincronização em vez de uma,
  dos dois lados do fork QEMU.
- **Risco técnico**: alto — esta é a alternativa com maior chance de introduzir um bug de ordenação
  sutil e raro (a categoria de bug mais cara de encontrar, por experiência direta desta mesma
  investigação com o flake de 1-em-21 do `scheduler_test`).
- **Impacto em dispositivos existentes**: nenhum diretamente.
- **Capacidade de evolução futura**: muito boa, mas o custo de manutenção contínua é maior.

#### Alternativa C — Núcleo do protocolo inalterado, mas mover o polling do Core pra fora da thread do Scheduler

Sem mudar o ABI da arena em si (ainda 1 slot, ainda busy-wait do lado QEMU), mover
`McuComponent::onPollEvent()` pra uma thread DEDICADA por MCU (não mais um callback síncrono na thread
única do Scheduler) — a thread dedicada drena a arena e empurra eventos processados pra fila de comandos
já existente (`CommandQueue`, já validada nesta investigação), deixando a thread do Scheduler livre pra
processar OUTROS eventos (inclusive de OUTROS MCUs) enquanto esta espera especificamente.

- **Vantagens**: não muda o ABI cross-processo — risco muito menor que A ou B; reaproveita
  infraestrutura já existente e testada (`CommandQueue`); resolve DIRETAMENTE o achado PERF-12 (múltiplos
  MCUs serializados numa única thread) de graça, já que cada MCU ganharia sua própria thread de espera.
- **Desvantagens**: não resolve o ping-pong em si — QEMU ainda espera o Core por evento individual,
  só que agora numa thread dedicada em vez da thread compartilhada do Scheduler; o ganho vem de
  DESBLOQUEAR outros MCUs/trabalho, não de acelerar o par QEMU↔MCU individual.
- **Impacto no desempenho**: alto especificamente pra projetos com MÚLTIPLOS MCUs (paralelismo real
  entre eles pela primeira vez); baixo-médio pra projetos com um único MCU (não ataca o ping-pong
  individual).
- **Complexidade de implementação**: baixa-média — não mexe no ABI, só na alocação de threads do lado
  Core.
- **Risco técnico**: baixo-médio — mesma classe de mudança de concorrência já validada com sucesso
  nesta investigação (mover trabalho pra uma thread dedicada, coordenar via fila existente).
- **Impacto em dispositivos existentes**: nenhum.
- **Capacidade de evolução futura**: boa base pra combinar DEPOIS com A ou B (não são mutuamente
  exclusivas).

### 5.4 Recomendação

**Combinar C primeiro (baixo risco, resolve o achado real de múltiplos MCUs, reaproveita
infraestrutura já validada), depois A (fila de escritas com backpressão explícito) como a segunda
etapa, medindo o ganho de cada uma isoladamente antes de avançar.** B fica descartada por enquanto —
risco desproporcional ao ganho incremental sobre A, dado o padrão desta investigação inteira de "meça
antes de acreditar" já ter mostrado mais de uma vez que ganhos teóricos grandes viram pequenos na
prática (o caso do TB cache "4-5x" que na realidade era ~10%). Não decidir isso silenciosamente — esta é
uma decisão que o documento está deliberadamente trazendo pro usuário, conforme pedido.

---

## 6. Matriz completa de oportunidades

| ID | Área | Problema atual | Proposta | Ganho esperado | Complexidade | Risco | Dependências | Testes | Prioridade |
|---|---|---|---|---|---|---|---|---|---|
| PERF-05 | Plugin ABI | `NativeDeviceProxy::stamp()` aloca heap por chamada | Membro reutilizável em vez de `make_unique` por chamada | Pequeno-Moderado (medir) | Baixa | Baixo | Nenhuma | plugin_runtime, plugin_checksum | Alta |
| PERF-06 | IPC/MCU | `getMcuLogs` retransmite buffer inteiro a cada poll | Cursor/offset incremental | Moderado (medir) | Baixa-Média | Baixo-Médio | — | Novo teste de caracterização | Média |
| PERF-07 | Property system | `propertyDescriptors()` reconstrói vetor+closures por chamada | Cache por instância, invalida no schema | Pequeno | Baixa | Baixo | — | property_definition | Baixa |
| PERF-08 | IPC/Telemetria | Hex-encoding dobra volume de `getComponentState(s)` | Base64 ou framing binário | Pequeno-Moderado | Baixa-Média | Baixo | Melhor junto com PERF-10 | Novo teste de caracterização | Baixa-Média |
| PERF-09 | MCU/Concorrência | Mutex recursivo do McuComponent preso durante todo o busy-wait | Reduzir escopo do lock | A validar | Média | Médio | Relacionado a PERF-13 | mcu_component, mcu_controller_real_qemu, mcu_blink_long_run (repetido) | Média-Alta |
| PERF-11 | IPC/Transporte | `m_sendMutex` disputado entre resposta e notificação | Escritor único dedicado | A validar | Média | Médio | Junto com PERF-10 | core_bootstrap + novos | Média |
| PERF-12 | Scheduler/Multi-MCU | Todos os MCUs serializados na única thread do Scheduler | Thread dedicada por MCU (= Alternativa C da seção 5) | Alto pra multi-MCU | Média | Médio | Habilita/combina com PERF-13 | Novo: múltiplos MCUs simultâneos (não existe hoje) | **Alta** |
| PERF-13 | Core↔QEMU | Ping-pong síncrono, ambos os lados nunca calculam ao mesmo tempo | Ver seção 5 (Alternativas A/B/C) | Alto (medir por alternativa) | Alta | Alto | Mudança de ABI cross-processo | Extensivo, novo | **Obrigatório (usuário)** |
| PERF-14 | Solver/Paralelismo | ThreadPool do MnaSolver provavelmente nunca ativa em circuitos típicos | Medir primeiro; possível uso alternativo do pool (stamp paralelo ou multi-MCU) | Desconhecido — medir antes | Baixa (medir) / Média (agir) | Baixo (medir) | Informa PERF-12 | mna_solver, circuit_group + instrumentação | Média (medição), condicional depois |
| PERF-15 | Property system | Validação de propriedade duplicada (correção, não desempenho) | Unificar numa função | Nenhum (perf); manutenibilidade | Baixa | Baixo | — | property_definition | Baixa |

Legenda de Ganho: pequeno / moderado / alto / muito alto. Complexidade: baixa / média / alta /
reconstrução arquitetural. Onde os dados existentes não permitem estimar com confiança, isso está
marcado explicitamente ("a validar"/"medir antes") em vez de inventar um número.

---

## 7. Alterações estruturais além do Core↔QEMU

Além do item obrigatório (seção 5), a única outra mudança genuinamente estrutural (não incremental)
identificada nesta revisão é **PERF-12 (thread dedicada por MCU)** — que, como notado, é também a base
da Alternativa C do desacoplamento Core↔QEMU. Não foram encontradas outras mudanças de "reconstrução
arquitetural" com evidência real de ganho — a arquitetura de dados (Netlist com vetores indexados por
inteiro, mapas string-keyed só em setup), o modelo de dispositivo (ABI plano, sem JSON/string no
caminho quente), e o solver (MNA com particionamento em grupos independentes + LU cacheada) já estão,
de forma geral, bem desenhados — a conclusão da seção 12 detalha isso.

---

## 8. Inventário de funcionalidades a preservar

Levantamento direto do que o Core suporta hoje, com o teste (se existir) que garante cada item —
baseado no inventário completo dos 47 testes da suíte (ver seção 9 para lacunas).

| Funcionalidade | Coberta por |
|---|---|
| Componentes built-in (39 tipos: passivos, fontes, medidores, lógica, SimulIDE-portados) | `passive_components`, `simulide_sources_meters`, `voltmeter`, `logic_components`, `dynamic_pins`, `inert_components_fix`, `zener_led`, `diode`, `bus` |
| Dispositivos via plugin ABI (`device_abi.h`) | `plugin_loader`, `plugin_loader_real_dll`, `plugin_checksum`, `plugin_duplicate_device_id`, `plugin_runtime`, `logic_gate_plugin` |
| MCU via QEMU (ESP32) | `qemu_process_manager`, `mcu_debug_launch`, `qemu_arena_bridge`, `esp32_adapter`, `mcu_controller_real_qemu`, `mcu_component`, `mcu_blink_long_run` (só roda de fato com firmware real fornecido) |
| Simulação digital | `logic_components`, `bus`, `logic_analyzer_vector`, `pin_change_dispatch` |
| Simulação analógica | `voltage_divider`, `diode`, `zener_led`, `transient_rc`, `transient_rlc` |
| Simulação mista | `esp32_devkitc_subcircuit`, `mcu_blink_long_run` (ADC+PWM+digital simultâneo) |
| UART | `app/CoreApplication.cpp` `drainUart`/`writeUart`/`getUartStatus` — **sem teste IPC real** (ver lacuna) |
| Timers | `simulide_sources_meters` (Clock), cobertura indireta via MCU real |
| Interrupções | `mx_pic`-equivalente coberto indiretamente via `mcu_blink_long_run` (reset dual-core), sem teste dedicado de IPI |
| Pausar/Parar/Reiniciar | `scheduler`, `command_queue_session`, `mcu_blink_long_run` (pause/resume + stop completo) |
| Carregamento de firmware | `mcu_controller_real_qemu`, `mcu_blink_long_run` — **verbo IPC `loadMcuFirmware` sem teste IPC real** |
| Comunicação com a interface (IPC) | `core_bootstrap` — **cobre só 17 de 39 tipos de mensagem** |
| Logs e diagnóstico | `QemuProcessManagerTest` (nível C++), **verbo IPC `getMcuLogs` sem teste IPC real** |
| Subcircuitos | `subcircuit`, `esp32_devkitc_subcircuit` |
| Execução determinística | `scheduler` (ordem de eventos, timestamps iguais), `circuit_group_reuse` |
| Plugins built-in vs. ABI vs. MCU coexistindo | `mna_solver`, `command_queue_session` |

---

## 9. Cobertura de teste — o que existe e o que falta antes de qualquer refatoração maior

### 9.1 O que existe (resumo — inventário completo dos 47 testes disponível junto com este documento
nas notas de pesquisa)

Boa cobertura em: solver MNA/CircuitGroup, componentes built-in, subcircuitos, carregamento de plugin
(incluindo DLLs reais), e — o ponto mais forte — concorrência do Scheduler (`scheduler`,
`command_queue_session`, ambos testam explicitamente cenários de corrida/timeout).

### 9.2 Lacunas críticas identificadas (bloqueantes para uma refatoração segura de IPC/Core↔QEMU)

1. **22 de 39 tipos de mensagem IPC nunca são exercitados via JSON real** — só via chamada C++ direta
   em `SimulationSession`, o que prova que o MÉTODO funciona, mas não que o PARSING/MARSHALLING/
   MAPEAMENTO DE ERRO da mensagem JSON correspondente está correto. Inclui exatamente os verbos que
   PERF-13 (Core↔QEMU) e PERF-10/11 (transporte IPC) vão tocar: `loadMcuFirmware`, `drainUart`,
   `writeUart`, `getMcuLogs`, `stopMcuFirmware`, `getComponentStates`. **Isto precisa ser fechado ANTES
   de tocar nesses caminhos**, não depois.
2. **Nenhum teste com múltiplos MCUs/processos QEMU simultâneos** — bloqueante direto pra validar
   PERF-12. Sem isso, não há como caracterizar hoje (baseline) nem confirmar depois (regressão) o
   comportamento de escala com múltiplos microcontroladores.
3. **Testes de plugin real "falham silenciosamente pra sucesso"** — `return 0` quando o artefato não
   está compilado é indistinguível, no relatório do CTest, de "passou de verdade". Antes de confiar
   nessa cobertura como rede de segurança pra uma refatoração grande, os artefatos precisam estar
   garantidamente compilados no ambiente de CI/validação (ou o teste precisa reportar `SKIPPED`
   explicitamente, não `PASSED`).
4. **`mcu_blink_long_run` — o teste mais abrangente de ponta-a-ponta que existe — não roda por padrão**
   (`node scripts/test-core.js` não configura `LASECSIMUL_TEST_FIRMWARE`). Precisa ser incluído
   explicitamente em qualquer validação desta revisão, não assumido como "já rodou".
5. **Nenhum teste de caracterização dos formatos de resposta que este documento propõe mudar**
   (`getMcuLogs`, `getComponentState(s)` hex encoding) — precisam existir ANTES da mudança, capturando o
   comportamento atual byte-a-byte, pra servir de guarda de regressão.

### 9.3 Testes de caracterização propostos antes de iniciar qualquer item da Estratégia A/B

- Teste IPC real (JSON sobre pipe, não chamada C++ direta) pra cada um dos 22 verbos sem cobertura,
  prioridade pros 6 listados acima que interceptam este plano.
- Teste sintético com 2+ `McuController`/processos QEMU reais simultâneos, verificando que arenas não
  colidem por nome, que o Scheduler processa eventos de ambos corretamente, e medindo overhead agregado.
- Snapshot binário exato do formato atual de `getMcuLogs` e `getComponentState(s)` (bytes exatos,
  incluindo o hex encoding), pra detectar qualquer mudança de formato não-intencional.

---

## 10. Plano de benchmarks

### 10.1 Metodologia — nunca aceitar "deve ficar mais rápido" sem medir

Toda mudança proposta neste documento, sem exceção, precisa de uma medição ANTES e DEPOIS, isolando essa
mudança especificamente (lição direta desta investigação: o erro de atribuir "4-5x" ao fix do TB cache,
quando na verdade era ~10%, veio exatamente de comparar contra uma baseline que já continha OUTRA
mudança não controlada).

### 10.2 Métricas a coletar (por cenário de benchmark)

- Tempo total de simulação / velocidade relativa ao tempo real (`sim_ns` por janela de parede, já usado
  em toda esta investigação).
- Latência de inicialização (tempo entre "Play" e primeira instrução executada).
- Latência de pausa/parada (tempo entre o comando e o estado efetivamente parado).
- Uso de CPU por thread (via a mesma técnica de amostragem GDB já validada, ou `Get-Process`/
  `TotalProcessorTime` pra granularidade de processo).
- Tempo de espera em lock (instrumentação temporária em cada mutex candidato desta revisão).
- Alocações por segundo (contador temporário em `operator new`/`delete`, mesma técnica já usada pro
  achado do `CommandQueue`).
- Tamanho/saturação da fila (se PERF-13-A for implementado: profundidade média/máxima da fila de
  escritas).
- Escalabilidade com 1, 2, 4 MCUs simultâneos (novo cenário, depende de PERF-12/lacuna de teste 9.2.2
  ser fechada primeiro).
- Consumo de memória e estabilidade em execução longa (mínimo 15 minutos contínuos, dado que bugs de
  concorrência desta base de código já mostraram flakes raros — ex.: 1-em-21 no `scheduler_test`).

### 10.3 Cenários de benchmark reproduzíveis

| Cenário | Cobre |
|---|---|
| Circuito simples com LED | Caso trivial, teto teórico de desempenho |
| Alta frequência de eventos digitais | Estresse do `settleStep`/dirty-set |
| Circuito analógico | Estresse do solver Eigen/MNA |
| Circuito misto (analógico+digital) | Caso real típico |
| Arduino Uno (se aplicável ao Core hoje) | MCU sem QEMU, se existir esse caminho — a confirmar no inventário de dispositivos |
| ESP32 via QEMU (o firmware já usado nesta investigação) | Caminho MCU/QEMU completo |
| Múltiplos MCUs (2+, novo) | Escalabilidade — bloqueado até fechar a lacuna 9.2.2 |
| UART ativo | `drainUart`/`writeUart` sob carga |
| Dispositivos com timer | `Clock`/`WaveGen` sob alta frequência |
| Carga alta de componentes (muitos built-ins/plugins) | Estresse geral do `settleStep`/plugin dispatch |
| Cenário estilo exemplos do SimulIDE | Comparação direta de desempenho contra a referência |

### 10.4 Linha de base

Registrar TODAS as métricas acima, pra TODOS os cenários, no estado ATUAL do Core (pós F0-F4, antes de
qualquer item novo deste documento) antes de tocar em qualquer coisa — esta linha de base ainda não
existe formalmente (as medições desta investigação foram pontuais, focadas em validar cada fix
individual, não um snapshot sistemático de todos os cenários acima).

---

## 11. Plano de testes contra regressão

Além dos testes de caracterização da seção 9.3 (pré-requisito), cada item da matriz da seção 6 lista
seus próprios testes na coluna "Testes". Regra geral: nenhuma mudança de concorrência (PERF-09, 11, 12,
13) é considerada validada com menos de 15-20 execuções repetidas da suíte completa + o teste específico
em isolamento repetido (mesma disciplina já aplicada com sucesso nesta investigação pro fix do
`CommandQueue`: 14 rodadas completas + 80 execuções isoladas dos dois testes mais diretamente
relevantes, sem nenhuma falha, antes de considerar seguro).

---

## 12. Estratégia de execução: A (incremental) vs. B (reconstrução) vs. híbrida

### Estratégia A — Evolução incremental

Ordem recomendada: PERF-05 → PERF-07 → PERF-06/08 → PERF-15 (baixo risco, isolados, medidos
individualmente) → PERF-09 (McuComponent lock) → PERF-14 (medição, decisão condicional) → PERF-11
(m_sendMutex) → **PERF-12 (thread por MCU)** → **PERF-13-A (fila de escritas)**.

Cada etapa: implementar, medir isoladamente contra a linha de base da seção 10.4, rodar a suíte completa
+ repetições se tocar concorrência, só então avançar. Critério de parar/aprofundar uma linha: se o ganho
medido de uma categoria de mudança (ex.: alocações pequenas) cair abaixo do ganho já obtido nas etapas
anteriores por uma margem grande (ex.: <1% quando os itens anteriores já deram double-digit), é sinal de
que aquela categoria está esgotada — mover pra próxima categoria em vez de insistir.

### Estratégia B — Reconstrução arquitetural completa

Dado tudo que esta revisão encontrou, **não há evidência que justifique uma reconstrução completa do
zero**. As peças fundamentais — modelo de dados (Netlist indexado por inteiro), modelo de dispositivo
(ABI plano, custo uniforme built-in vs. plugin), o solver (partição em grupos independentes + cache de
LU + pool de threads já existente) — já estão bem desenhadas, em alguns pontos JÁ NO MESMO NÍVEL ou
melhor que a referência (SimulIDE usa uma técnica de dirty-flag comparável, mas SEM paralelismo real
nenhum — o LasecSimul já tem um `ThreadPool` de verdade que o SimulIDE não tem). O que precisa de
mudança real é localizado: o modelo de concorrência do Scheduler (uma thread só, callbacks de MCU
serializados) e o protocolo Core↔QEMU (síncrono demais) — ambos endereçáveis via mudanças estruturais
DENTRO da arquitetura atual (seção 5, 7), não uma reescrita.

### Comparação direta

| Critério | A (incremental) | B (reconstrução) |
|---|---|---|
| Ganho potencial | Alto, cumulativo, mas cada etapa medida e conhecida | Teoricamente maior, mas nenhuma evidência concreta de que HAJA mais ganho disponível numa reconstrução do que nas peças já identificadas |
| Tempo/complexidade | Semanas, incremental | Meses, all-or-nothing até funcionar de novo |
| Risco | Controlado, uma mudança de cada vez, sempre com fallback conhecido | Altíssimo — risco de regressão em TUDO simultaneamente, sem uma linha de base funcional durante a transição |
| Facilidade de teste | Cada etapa testável isoladamente contra a suíte existente | Precisa de toda a suíte reescrita/adaptada ANTES de validar qualquer coisa |
| Dívida técnica residual | Baixa — cada fix já vem com justificativa e medição documentadas (mesmo padrão desta investigação inteira) | Alta durante a transição — o Core ficaria funcionalmente incompleto por um período indeterminado |
| Escalabilidade | PERF-12/13 já entregam o essencial do que uma reconstrução buscaria | Mesmo destino final, caminho mais arriscado |
| Proximidade/superioridade ao SimulIDE | Já superior em paralelismo do solver; ping-pong Core↔QEMU igual (não pior) hoje, PERF-13 o deixaria MELHOR que a referência | Mesmo destino final possível, sem necessidade de arriscar tanto pra chegar lá |

---

## 13. Riscos e mitigação

| Risco | Mitigação |
|---|---|
| Bug de concorrência raro/difícil de reproduzir (precedente real: flake 1-em-21 do `scheduler_test`) | Disciplina de repetição (15-20+ execuções) pra toda mudança de concorrência, já validada nesta investigação |
| Mudança de ABI cross-processo (PERF-13) quebra compatibilidade entre versões de QEMU/Core em desenvolvimento paralelo | Versionar o ABI explicitamente (já existe precedente: `LSDN_ABI_VERSION_MAJOR`/`MINOR` no `device_abi.h`), rejeitar mismatch em vez de silenciosamente corromper |
| Testes de plugin real mascarando falta de cobertura (skip vira "pass") | Corrigir pra reportar `SKIPPED` explicitamente antes de confiar neles como rede de segurança pra qualquer mudança desta revisão |
| Otimizações pequenas (PERF-05 a 08) consumirem tempo desproporcional ao ganho | Critério de parada da Estratégia A (seção 12) — abandonar uma categoria se o ganho cair muito abaixo do já obtido |
| PERF-12 (thread por MCU) introduzir contenção nova entre MCUs que compartilham periféricos/circuito | Os MCUs compartilham o MESMO `SimulationSession`/Netlist — qualquer efeito cruzado (ex.: dois MCUs escrevendo no mesmo nó elétrico) ainda precisa passar pela `CommandQueue` existente; a thread dedicada só paraleliza a ESPERA pelo QEMU, não a aplicação do resultado |

---

## 14. Recomendação final

**Estratégia híbrida, não puramente A nem puramente B.** Ordem concreta recomendada:

1. **PERF-05 a PERF-08 e PERF-15** (baixo risco, medição rápida, mesma classe de ganho que já rendeu
   os melhores resultados desta investigação) — semanas 1.
2. **Medição de PERF-14** (é barata e informa diretamente a decisão de PERF-12) — em paralelo com o
   item 1.
3. **Fechar as lacunas de teste da seção 9.2** (especialmente os 6 verbos IPC que os próximos itens vão
   tocar, e o teste de múltiplos MCUs) — pré-requisito, não opcional, antes do item 4.
4. **PERF-12 (thread dedicada por MCU)** — a mudança estrutural de menor risco com maior ganho
   comprovável (escalabilidade multi-MCU, e é a base da Alternativa C do desacoplamento).
5. **PERF-13, Alternativa A (fila de escritas com backpressure)** — só depois do item 4 validado, com
   a linha de base de benchmark da seção 10.4 já registrada.
6. **PERF-09 e PERF-11** — podem entrar em paralelo com 4-5, já que são mudanças mais isoladas
   (afetam concorrência mas não o ABI cross-processo).

Isto NÃO é uma reconstrução do Core — é uma evolução dirigida por medição real, mirando especificamente
nos dois pontos onde a arquitetura atual genuinamente fica aquém do que poderia: MCUs serializados numa
única thread, e o ping-pong síncrono Core↔QEMU. Tudo o mais que esta revisão encontrou (o solver, o
modelo de dados, o modelo de dispositivo) já está em bom estado — inclusive melhor que a referência
SimulIDE em pelo menos um aspecto concreto e verificado (paralelismo real do solver via `ThreadPool`,
algo que o SimulIDE não tem).
