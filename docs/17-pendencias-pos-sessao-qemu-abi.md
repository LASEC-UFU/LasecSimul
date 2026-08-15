# 17 - Pendências pós-sessão (leitura de corrente, ABI v3, bit a bit, QEMU/MCU real)

## Objetivo deste documento

Uma sessão de trabalho longa (2026-06-28) mudou uma quantidade grande de coisa no Core e na ABI —
o suficiente para deixar `.spec/*.spec`, `docs/16-roadmap-pendencias-spec.md`,
`docs/mvp-limitacoes.md`, `docs/11-qemu-esp32.md` e `.skill/lasecsimul.skill` **contradizendo o
código atual** em vários pontos, e para abrir pendências novas de código que ainda não foram pra
nenhum desses documentos.

Este documento é o **handoff pra outro agente continuar** — pente fino do que mudou, do que ficou
desalinhado, e do que falta implementar de fato. Não é um roadmap de produto; é uma lista de
trabalho concreta, com arquivo:linha sempre que possível.

**Leia primeiro a seção "O que mudou nesta sessão" inteira antes de tocar em qualquer arquivo** —
ela é o contexto que faltava nos `.spec`/docs atuais.

---

## 0. O que mudou nesta sessão (contexto obrigatório)

### 0.1 Leitura de corrente (`current()`)

- `IComponentModel::current()` (novo, `core/include/lasecsimul/IComponentModel.hpp`) — opção de
  baixo custo: sem incógnita nova na matriz, lê estado já cacheado na última `stamp()`.
- `MnaMatrixView::getBranchCurrent()` — leitura gratuita da corrente de ramo de fontes de tensão
  ideal (variável extra já resolvida).
- `SimulationSession::componentCurrent(componentIndex)` — nunca dispara solve novo, `nullopt` se o
  componente não implementa ou já foi removido.
- IPC `getComponentCurrent` (`CoreApplication.cpp`) + `CoreClient.getComponentCurrent`
  (`extension/src/ipc/CoreClient.ts`) do lado da Extension.
- Convenção de sinal **validada empiricamente, não só derivada**: convenção passiva (positiva
  entrando no primeiro pino/saindo no segundo, ou na terra implícita pra componente de 1 pino) —
  fonte fornecendo energia aparece **negativa**. Implementado em: Resistor, Inductor, Capacitor
  (sempre 0.0 — modelo atual não contribui nada pra matriz), Diode, DcVoltageSource, Battery, Rail,
  FixedVolt, VoltSource, CurrSource, Csource, Clock, WaveGen, Ampmeter.
- Bug achado e corrigido no caminho: `WaveGen` no modo não-bipolar deixava o pino `gnd` com linha
  inteiramente zerada na matriz (singular) — corrigido fixando esse pino em 0V via
  `addConductanceToGround`. Padrão a reaproveitar: **qualquer componente com pino "decorativo"
  sempre precisa de alguma contribuição na matriz, nunca zero absoluto.**

### 0.2 Robustez de plugin nativo

- `CrashGuard` agora protege `NativeDeviceProxy::getState/setState` e o getter/setter de
  propriedade (antes só `stamp()`/`onEvent()` tinham proteção — um plugin podia derrubar o Core
  inteiro lendo uma propriedade).
- Leak corrigido: `AbiMatrixContext` em `NativeDeviceProxy::stamp()` agora é `unique_ptr` (RAII),
  antes vazava se a lambda do `CrashGuard::call` lançasse exceção C++ antes do `delete` manual.
- `PluginLoader.cpp`: agora só checa **major** da ABI, nunca minor — decisão deliberada (zero
  plugin de terceiro existe ainda, todo device deste repo recompila a cada mudança de ABI via
  `npm run build:devices`; checar minor exato só travaria builds legítimos por atrito).

### 0.3 ABI de devices (`device_abi.h`) — bump 1 → 3 nesta sessão

- **Major 2**: removidos `bus_attach`/`bus_write`/`bus_read` de `LsdnHostApi` e
  `LSDN_EVT_BUS_WRITE`/`LSDN_EVT_BUS_READ_REQUEST` de `LsdnEventTag` — esse caminho (barramento por
  bytes, sem simular SDA/SCL/SCK reais) **nunca foi ligado a um `SimulationSession` real**, só os
  próprios testes do subsistema o exercitavam.
- **Major 3**: `pin_write`/`pin_write_analog`/`pin_read`/`now_ns`/`schedule_event` deixaram de ser
  stubs vazios e passaram a ser reais; `pin_watch` saiu (redundante — todo pino já recebe
  `LSDN_EVT_PIN_CHANGE` automaticamente, sem precisar de registro prévio); entrou `pin_name`.
- `LSDN_ABI_VERSION_MAJOR` atual: **3**. `LSDN_ABI_VERSION_MINOR`: **0**.

### 0.4 Mecanismo bit a bit substituiu o barramento por bytes

- **Removidos por completo** (código morto, nunca ligado a um `SimulationSession` real):
  `core/src/bus/BusController.hpp`, `core/src/bus/I2cBusModule.hpp`, `core/src/bus/SpiBusModule.hpp`,
  `core/include/lasecsimul/IBusParticipant.hpp`, e os testes
  `core/test/core/bus/{I2cBusModuleTest,SpiBusModuleTest}.cpp`.
- **Construído do zero**: detecção de borda digital real em `SimulationSession::settleStep()`
  (passo "3b") — quando a tensão de um nó cruza `kDigitalLevelThreshold` (2.5V, constante
  compartilhada em `core/include/lasecsimul/Types.hpp`), o Core dispara
  `ComponentEvent{kPinChangeEventTag, localPinIndex, nivel, nsDesdeABordaAnterior}` para **todo**
  componente/pino presente naquele nó — built-in ou plugin, sem distinção.
- Infraestrutura nova de suporte: `Netlist::Topology::pinRefsByNode` (novo campo, paralelo a
  `listenersByNode` mas sem dedup), `Scheduler::nowNsUnlocked()`/`scheduleEventUnlocked()` (variantes
  sem mutex, seguras de chamar de dentro do próprio settle-loop — existem porque `nowNs()`/
  `scheduleEvent()` normais tomam o mesmo mutex que `settleStep()` já tem preso, causando deadlock
  se chamadas de dentro de `stamp()`/`onEvent()` de um plugin).
- Teste novo: `core/test/core/session/PinChangeDispatchTest.cpp` (`pin_change_dispatch` no ctest).
- `devices/simulide-complex/src/lib.c` migrado pra só usar `LSDN_EVT_PIN_CHANGE` (já tinha toda a
  lógica de decodificação bit a bit pronta — `i2c_clock_bit`, `pcd8544_clock_bit`, `max_clock_bit`,
  `ws_edge`, etc. — só faltava o Core gerar o evento).
- **Bugs reais achados e corrigidos nesse processo**: `aip31068_i2c.json` tinha SCL/SDA trocados
  (endereço de pino errado, decodificava o protocolo errado silenciosamente); `ili9341.json` usava
  nomes inconsistentes (`mosi`/`rst` em vez de `sda`/`reset`). Mitigação: `pin_name()` na ABI +
  `validate_pin_order()` em `devices/simulide-complex/src/lib.c`, chamado no `init()` de cada
  device, loga erro se a ordem declarada no `.lsdevice` não bate com o esperado.
- I2C ganhou endereço configurável (`i2cAddress`) + ACK elétrico real (antes era só uma flag
  interna, nunca puxava SDA de verdade) — só ACKa quando o endereço bate.
- MAX72xx corrigido: antes latchava a cada 16 bits clocados; agora só na borda de subida de
  LOAD/CS, igual ao chip real (importante pra cascata de vários chips no mesmo SCK/DIN).

### 0.5 QEMU/MCU — pipeline corrigido com auditoria real (não suposição)

**Fontes de referência usadas** (todas confirmadas acessíveis nesta máquina):
- `C:\SourceCode\qemu_simulide` — fork QEMU real (`git@github.com:Arcachofo/qemu_simulide.git`),
  protocolo **atual/novo** (`softmmu/simuliface.{h,c}`).
- `C:\SourceCode\simulide_2` — fonte C++ atual do SimulIDE (substituiu o antigo
  `SimulIDE-dev`, que não existe mais neste disco — **qualquer referência a `SimulIDE-dev` nos
  `.spec`/skill está apontando pra um caminho que não existe mais**).
- `C:\SourceCode\SimulIDE_2-R260501_Win64\data\bin\` — distribuição oficial, continha o
  `qemu-system-xtensa.exe` real (confirmado, via string embutida no binário, que implementa o
  protocolo NOVO) + ROMs do ESP32.

**Achado crítico**: havia (e parcialmente ainda há, fora do ESP32) uma crença arquitetural errada
de que "módulos de periférico (GPIO/I2C/SPI/USART) devem ser genéricos, reusados por qualquer
chip, sem que o adaptador conheça registrador específico". **Isso está errado** — confirmado lendo
`hw/gpio/esp32_gpio.c` do fork real: o QEMU manda **registrador bruto** (endereço + valor), sem
decodificar nada — quem decodifica é o módulo do lado do Core (`offset 0x04` só significa
"GPIO_OUT_REG" porque é assim que o ESP32 define seu mapa de registrador, não é universal). A
regra correta (alinhada com o usuário): **só `Scheduler`/`Netlist`/IPC/UI precisam ser neutros
quanto a chip; módulos de registrador concreto são CHIP-ESPECÍFICOS de propósito.**

**O que foi construído**:
- `core/include/lasecsimul/QemuModule.hpp` (novo) — base chip-específica:
  `memStart`/`memEnd`/`writeRegister`/`readRegister`/`reset`, + ponte genérica opcional
  `isOutputEnabled`/`outputLevel`/`setInputLevel` (default no-op; só GPIO-like sobrescreve).
- `core/src/mcu/esp32/Esp32GpioModule.hpp` (novo) — fiel a `Esp32Gpio::writeRegister/readRegister`
  real: offset `0x04`=GPIO_OUT_REG, `0x20`=GPIO_ENABLE_REG, `0x3C`/`0x40`=GPIO_IN_REG/GPIO_IN1_REG.
  **Deliberadamente sem IOMUX/pin-matrix** (ver pendência 3.1 abaixo).
- `core/src/mcu/McuComponent.hpp/.cpp` (novo) — **a peça que faltava por completo**: implementa
  `IComponentModel`, entra no `Netlist`/`Scheduler` com pinos reais ligáveis por fio
  (`IMcuAdapter::pinMap()`). Antes deste componente, **nenhum `IMcuAdapter` conseguia afetar o
  circuito eletricamente** — só existia como descrição declarativa isolada, sem ponte com
  `SimulationSession`. Por dentro: faz polling da arena (auto-agendado via
  `Scheduler::scheduleEvent`, mesmo padrão de `Clock`/`WaveGen`), despacha `SIM_READ`/`SIM_WRITE`
  pro módulo certo (por endereço), e a cada `stamp()` traduz `isOutputEnabled`/`outputLevel` em
  estampa elétrica real (Norton de baixa impedância) ou lê a tensão do nó de volta pro módulo.
- `IMcuAdapter` ganhou `createModules()` (pura virtual nova) — devolve
  `vector<unique_ptr<QemuModule>>`, quem cria sabe quais módulos concretos aquele chip usa.
- `qemu_arena_abi.h` **reescrito por completo**: protocolo antigo (tag `simuAction` com payload
  já decodificado, sem endereço) → protocolo real confirmado contra o binário (`regAddr`/`regData`/
  `irqNumber`/`irqLevel`/`SIM_READ`/`SIM_WRITE`/`loop_timeout_ns`/`ps_per_inst`, **88 bytes total**
  — confirmado batendo com o próprio log do binário real, "Qemu: arena mapped 88 bytes").
- `Esp32Adapter::buildLaunchArgs()`/`McuController::start()` corrigidos: agora prependam a chave
  da shared memory como `argv[1]` do processo (confirmado lendo `simuMain()` real em
  `simuliface.c`: `shMemKey = argv[1]; argv = &argv[2];`). Args agora batem com
  `Esp32::createArgs()` real (`-M esp32-simul -L <romdir> -drive file=...,if=mtd,format=raw -icount
  shift=4,align=off,sleep=off`), não mais o placeholder antigo `-machine esp32 -kernel ...`.
- **Binário real vendorizado**: `devices/qemu-esp32/bin/` (qemu-system-xtensa.exe + DLLs + ROMs do
  ESP32, copiado de `SimulIDE_2-R260501_Win64\data\bin\`). Teste
  `core/test/core/mcu/McuControllerRealQemuTest.cpp` (`mcu_controller_real_qemu` no ctest) agora
  **lança o processo real de verdade** (não fake/stub) — confirmado funcionando (abre arena,
  inicia processo, só falha no firmware porque não existe um `.bin` real ainda).
- Teste novo `core/test/core/mcu/McuComponentTest.cpp` (`mcu_component` no ctest) — prova
  `GPIO_ENABLE_REG`+`GPIO_OUT_REG` → pino do circuito sobe pra 3.3V, sem precisar de QEMU/firmware
  real (arena sintética, escrita manual nos campos).
- **Bug numérico real achado e corrigido**: `McuComponent` tem 42 pinos (ESP32), a maioria
  simultaneamente flutuante (sem fio). Usar a mesma convenção de outros componentes (drive=1e9,
  flutuante=1e-9) causou `rcond() ~1e-18` — abaixo do limite de singularidade do solver (`1e-14`,
  `CircuitGroup::singular()`), mesmo sendo uma matriz perfeitamente diagonal/bem-condicionada
  equação a equação. Corrigido com valores próprios pra esse componente (1e6/1e-6, rcond ~1e-12).
  **Lição pro próximo componente com muitos pinos simultaneamente flutuantes**: não copiar
  1e9/1e-9 sem checar o spread resultante contra o limite de `rcond` do solver.

---

## 1. `.spec/*.spec` — correções necessárias (pente fino feito, ainda não aplicado)

> Audit completo já feito por um agente Explore nesta sessão lendo os dois arquivos inteiros.
> Citações de linha abaixo são do estado dos arquivos no momento da auditoria — confirme o número
> exato antes de editar (o arquivo pode já ter mudado).

### 1.1 `.spec/archive/legacy-v2/lasecsimul.spec`

- **Estrutura de pastas (~linha 295)**: lista `core/src/bus/{BusController,I2cBusModule,
  SpiBusModule,UsartModule}.{h,cpp}` como parte da árvore — **esses arquivos não existem mais**.
  Remover da árvore, substituir pela árvore real (`core/include/lasecsimul/QemuModule.hpp`,
  `core/src/mcu/McuComponent.{hpp,cpp}`, `core/src/mcu/esp32/Esp32GpioModule.hpp`).
- **Tabela de responsabilidades de `SimulationSession` (~linha 228, 234)**: ainda lista
  `BusController` como membro/responsabilidade da sessão. Remover; documentar que o roteamento de
  protocolo agora é 100% via `ComponentEvent{kPinChangeEventTag}` (ver seção 0.4 acima).
- **Settle-loop (~linha 694-698)**: passos descritos ainda mencionam `BusController` resolvendo
  tráfego e `QemuArenaBridge` aplicando eventos como comportamento atual — **não existe mais
  `BusController`**; reescrever o passo "3b" do `settleStep()` real (detecção de borda + despacho
  de `ComponentEvent`).
- **Sem nenhuma menção** a `kDigitalLevelThreshold`, `Netlist::Topology::pinRefsByNode`,
  `Scheduler::nowNsUnlocked()`/`scheduleEventUnlocked()`, ou ao mecanismo de detecção de borda em
  si — precisa de uma seção nova (sugestão: virar a nova seção 8, renumerando o que hoje é 8/8.1/
  8.2, já que o assunto de barramento muda fundamentalmente).
- **ABI (`LsdnEventTag`, ~linha 1340-1350)**: ainda lista `LSDN_EVT_BUS_WRITE`/
  `LSDN_EVT_BUS_READ_REQUEST` como tags válidas — foram removidas. Atualizar para refletir só
  `LSDN_EVT_PIN_CHANGE`/`LSDN_EVT_TIMER`.
- **`IMcuAdapter` (~linha 354-360)**: interface documentada sem `createModules()`. Adicionar.
- **Seção 8.1 (arena, ~linha 872-920)**: ainda descreve o protocolo ANTIGO (sem `regAddr`, payload
  pré-decodificado por tag). Reescrever com o protocolo real (seção 0.5 acima) — 88 bytes,
  `regAddr`/`regData`/`SIM_READ`/`SIM_WRITE`, QEMU nunca pré-decodifica.
- **Launch args do QEMU (~linha 827-846)**: não documenta `argv[1]` = chave da arena, nem o
  formato real (`-M esp32-simul -L ... -drive ...`). Atualizar com o que está em
  `Esp32Adapter::buildLaunchArgs()`/`McuController::start()` hoje.
- **PluginLoader / versionamento de ABI**: spec ainda implica gate estrito de major+minor. Hoje
  é só major (deliberado, ver 0.2). Atualizar a regra de versionamento.
- **`current()`/leitura de corrente**: **sem nenhuma menção**. Precisa de seção nova (sugestão:
  perto da seção 6.1, junto de `PropertyDescriptor`/`getState`/`setState`).
- **Seção 6.2 item 3 (catálogo "package data-driven" pra built-in)**: ainda marca como aberto algo
  que a seção 13.5 (mais nova, já existe) documenta como entregue — alinhar as duas seções, uma
  contradiz a outra hoje.
- **Cuidado**: ao reescrever, qualquer referência a `SimulIDE-dev` como caminho de fonte de
  referência deve apontar pra `C:\SourceCode\simulide_2` (ver 0.5) — `SimulIDE-dev` não existe
  mais neste disco.

### 1.2 `.spec/archive/legacy-v2/lasecsimul-native-devices.spec`

- **Seção 8 inteira (~linha 502-560)**: descreve `BusController`/`I2cBusModule`/`SpiBusModule`/
  `UsartModule` como arquitetura atual ("mesma divisão de responsabilidade já validada"). **Essa
  seção precisa ser substituída por completo** pela descrição do mecanismo de detecção de borda +
  `ComponentEvent{kPinChangeEventTag}` (seção 0.4 acima) — incluindo a correção arquitetural sobre
  módulo chip-específico (seção 0.5, "Achado crítico").
- **Seção 8.2 (~linha 562)**: cabeçalho já diz "ainda não implementado" pro desenho interno do
  `I2cBusModule`/`SpiBusModule` — mas o resto da seção 8 trata como se já funcionasse. Essa
  contradição interna desaparece junto com a reescrita do item anterior (o conceito inteiro sai).
- **`LSDN_ABI_VERSION_MAJOR` (~linha 278)**: ainda mostra `1`. Atualizar pra `3`, com changelog das
  3 versões (bus removido, host API real, pin_watch removido/pin_name adicionado — ver 0.2/0.3).
- **`LsdnEventTag` (~linha 288-289)**: remover `LSDN_EVT_BUS_WRITE`/`LSDN_EVT_BUS_READ_REQUEST`.
- **Tabela de funções do `LsdnHostApi` (~linha 467-470)**: `pin_write`/`pin_write_analog`/
  `pin_read` ainda descritas como se fossem stub ("escreve nível..." sem dizer que dirige a
  matriz de verdade agora); `pin_watch` ainda listada (removida); `bus_attach`/`bus_write`/
  `bus_read` ainda listadas (removidas); falta `pin_name`.
- **`createModules()`**: sem nenhuma menção, em lugar nenhum do arquivo. Adicionar à descrição de
  `IMcuAdapter`/`LsdnMcuVTable`.
- **Launch args/`argv[1]`**: mesma lacuna do `lasecsimul.spec` (seção 8.2 antiga, ~linha 852-870)
  — sem menção ao mecanismo real de passagem da chave da arena.

### 1.3 `.spec/archive/legacy-v2/lasecsimul-subcircuits.spec`

Não auditado nesta sessão em detalhe (nada do que mudou tocou subcircuitos diretamente). **Ação
pro próximo agente**: ler por completo e confirmar que nada ficou desalinhado — é baixo risco, mas
não foi verificado. Confirmar especialmente se ainda reflete a realidade de
`SimulationSession::addSubcircuitInstance`/`removeSubcircuitInstance` atual.

### 1.4 `.spec/archive/lasecsimul-wasm-devices.spec`

Já marcado **SUPERSEDED** (histórico, abordagem descartada). Movido de `.spec/` pra `.spec/archive/`
em 2026-07-07 (auditoria de UI, achado SK-3) -- confirmado zero uso de wasm/worker_threads em todo o
código; ficar fora de `.spec/*.spec` evita que o próximo agente gaste orçamento de contexto nele
antes de perceber que é histórico.

---

## 2. `docs/` — correções necessárias

### 2.1 `docs/16-roadmap-pendencias-spec.md`

- **Épico C (~linha 141-191)**: marcado "concluído (primeira versão)" descrevendo
  `BusController`/`I2cBusModule`/`SpiBusModule` como implementados e testados. **Isso não é mais
  verdade da forma como está escrito** — o que existe hoje é uma arquitetura DIFERENTE (detecção
  de borda + `ComponentEvent`), não uma "primeira versão" do que o Épico C descrevia. Reescrever o
  Épico C inteiro pra descrever o que de fato existe agora (seção 0.4 acima), deixando claro que a
  abordagem original foi avaliada, implementada, testada, e **descartada** por não ter sido ligada
  a um circuito real nenhuma vez — não é uma continuação, é uma substituição.
  - Pendências listadas (~linha 162-169: "Implementar I2cBusModule", "Implementar SpiBusModule",
    "Integrar ao BusController") ficam **moot** — remover, substituir pelas pendências reais da
    seção 3 deste documento.
  - "Arquivos alvo" (~linha 180-185) cita `core/src/bus/` — não existe mais.
- **Épico B (MCU/QEMU, ~linha 93-140)**: marcado "concluído" — hoje está MAIS avançado do que
  quando foi escrito (o binário real agora está vendorizado e testado, `McuComponent` existe).
  Atualizar pra refletir o estado novo, deixando claro o que ainda falta (seção 3 abaixo: IOMUX/
  matrix, TWI/SPI/USART do ESP32, `McuRuntimeManager`).
- **Sem nenhuma menção** ao `current()`/leitura de corrente — adicionar uma entrada nova (épico ou
  nota) documentando a feature entregue.
- Conferir se o Épico H (diodo/não-linear) e Épico I (editor) continuam precisos — não foram
  tocados nesta sessão, baixo risco, mas não re-verificados linha a linha.

### 2.2 `docs/mvp-limitacoes.md`

- **ESP32/QEMU (~linha 212-220)**: item (b) — "mecanismo pelo qual o nome da arena chega até o
  processo QEMU... não está documentado neste repositório" — **resolvido nesta sessão** (`argv[1]`,
  confirmado contra o binário real). Marcar como resolvido, manter item (a) (falta toolchain
  ESP-IDF pra compilar firmware real) como genuinamente aberto.
- **"Próximos passos sugeridos" (~linha 228-242)**: dois itens resolvidos nesta sessão e devem
  saber pra fora da lista de pendente:
  - "Implementar o `LsdnHostApi` real" — feito (`pin_write`/`pin_read`/`now_ns`/`schedule_event`
    reais, ver 0.2/0.3). `example-blinker` (que dependia disso) foi migrado e funciona.
  - "Descobrir o mecanismo de passagem do nome da arena" — feito (ver item anterior).
  - Os demais itens da lista (diodo/transistor com Newton-Raphson real além do diodo já entregue,
    próximo instrumento tipo osciloscópio com UI) continuam abertos, sem mudança.
- Itens genuinamente não relacionados a esta sessão e ainda abertos, **confirmados, não tocar sem
  necessidade**: testes de ativação real do VSCode (`@vscode/test-electron`), índice de instância
  removida nunca reciclado, sincronização Extension→Core fire-and-forget, i18n de `name`/
  `pins[].label`.

### 2.3 `docs/11-qemu-esp32.md`

- **Linha ~14-16**: afirma "Formato já fixado em `qemu_arena_abi.h` — espelho exato de
  `qemuArena_t` do fork real... não um redesenho." **Isso ficou errado** — o formato FOI
  redesenhado nesta sessão (protocolo antigo descartado, novo confirmado contra o binário real).
  Reescrever esse trecho com o protocolo atual (seção 0.5).
- Resto do documento (64 linhas, curto): reler por completo e alinhar com `McuComponent`/
  `QemuModule`/`Esp32GpioModule` — hoje provavelmente não menciona nenhum dos três.

---

## 3. Pendências de código reais (ainda não implementadas, achadas nesta sessão)

Estas são lacunas que o PRÓPRIO código já documenta como pendência (comentário no fonte) ou que
ficaram evidentes durante o trabalho — não é re-trabalho de spec, é trabalho novo de fato.

### 3.1 ESP32: IOMUX/pin-matrix, e módulos TWI/SPI/USART — **RESOLVIDO, ver seção 7 (2026-07-25)**

> Texto original (2026-06-28) preservado abaixo por histórico — GPIO/IOMUX/matrix e USART já
> tinham sido implementados antes da sessão de 2026-07-25 (não descrito em nenhum doc até agora);
> I2C, SPI e pull-up/down+open-drain de GPIO foram implementados nessa sessão. Ver seção 7 pro
> estado real atual, limitações restantes e testes.

`Esp32GpioModule` cobre **só** GPIO puro (`GPIO_OUT_REG`/`GPIO_ENABLE_REG`/`GPIO_IN_REG`/
`GPIO_IN1_REG`) — suficiente pra "Blink Real" (pino digital simples), mas:
- **Sem IOMUX/pin-matrix**: a tabela real (`Esp32::createMatrix()` em
  `C:\SourceCode\simulide_2\src\microsim\cores\qemu\esp32\esp32.cpp`) tem **512 entradas** (256
  sinais de entrada + 256 de saída) roteando qualquer periférico pra qualquer pino. Sem isso, SPI/
  I2C/USART não conseguem ser roteados pra um pino físico via firmware real (só funcionariam se o
  pino já viesse fixo, o que não é como o ESP32 real funciona).
- **Sem `Esp32TwiModule`/`Esp32SpiModule`/`Esp32UsartModule`**: cada um tem seu próprio mapa de
  registrador, do mesmo tamanho/complexidade que o GPIO. Arquivos de referência REAIS (não
  inventar, copiar fielmente):
  `C:\SourceCode\simulide_2\src\microsim\cores\qemu\esp32\esp32{iomux,twi,spi,usart}.{h,cpp}`, e o
  lado QEMU em `C:\SourceCode\qemu_simulide\hw\{gpio,i2c,ssi}\esp32_*.c` (confirmar nome exato do
  arquivo SPI/I2C/USART no fork, não assumido nesta sessão).
- **Faixas de memória já corretas** pra todos esses periféricos em
  `core/src/mcu/esp32/Esp32MemoryMap.hpp` (`kI2c0Start`/`kSpi0Start`/`kUart0Start` etc. já batem
  com os endereços reais confirmados em `esp32.cpp`) — só falta o `QemuModule` concreto de cada
  um. **Reaproveitar esse arquivo, não recalcular endereços.**

### 3.2 `McuRuntimeManager` — múltiplas instâncias de MCU por projeto

Hoje `McuComponent` é 1 instância isolada; não existe nenhum gerenciador permitindo várias
ESP32/STM32 na mesma sessão com nomes de arena únicos garantidos (hoje quem chama
`loadFirmware()` escolhe o nome manualmente, sem checagem de colisão). Comentário no código
(`core/src/mcu/McuComponent.hpp:48-51`) já marca isso como pendência explícita. Decisão de design
ainda em aberto: o gerenciador vive em `SimulationSession` (1 por sessão, já existe o padrão de
`McuRegistry` lá) ou é um tipo novo? Resolver isso antes de implementar — não é óbvio.

### 3.3 `loadFirmware()`/`stopFirmware()` do `McuComponent` nunca exposto via IPC

`CoreApplication.cpp` não tem handler nenhum chamando `McuComponent::loadFirmware`/
`stopFirmware` — hoje só é exercitado via teste C++ direto. Precisa de:
- Handler IPC novo (ex: `loadMcuFirmware`/`stopMcuFirmware`, payload `{instanceId, firmwarePath}`).
- `CoreClient` na Extension (`extension/src/ipc/CoreClient.ts`) com o método correspondente.
- Decisão de UX: como o usuário escolhe o `.bin`/`.elf` na Extension (provavelmente o mesmo padrão
  de diálogo de arquivo já usado por outro lugar — checar `extension/src/` por precedente antes de
  inventar um novo).

### 3.4 `NativeMcuAdapterProxy::createModules()` sempre vazio (plugin de MCU de terceiro)

`core/src/plugins/NativeMcuAdapterProxy.hpp:26-30` documenta isso explicitamente: a ABI C
(`mcu_abi.h`, ainda em major 1, nunca tocada nesta sessão) não tem conceito de `QemuModule`
nenhum — só adaptadores **built-in** (Esp32Adapter) conseguem declarar módulos concretos hoje.
Se/quando precisar de um chip via plugin DLL (não compilado no Core), `mcu_abi.h` precisa de uma
extensão simétrica a `QemuModule` (provavelmente `LsdnQemuModuleVTable` com `read_register`/
`write_register`/`is_output_enabled`/`output_level`/`set_input_level`, espelhando
`QemuModule.hpp`). Não fazer isso especulativamente — só quando houver um chip via plugin de
verdade pra justificar.

### 3.5 IPC `"step"` (passo único de simulação) nunca implementado

`core/src/app/CoreApplication.cpp:875-879` — handler existe, mas sempre devolve erro
`"step não implementado"`. Pendência antiga, não tocada nesta sessão, mas vale registrar aqui
porque "Blink Real"/debug de firmware provavelmente vai querer step-by-step eventualmente.

### 3.6 Agendamento por timestamp exato do QEMU (simplificação documentada)

`McuComponent` processa cada evento da arena IMEDIATAMENTE no `stamp()` em que é detectado, não no
timestamp exato (`qemuTime`/`simuTime`) que o QEMU reportou — o SimulIDE real agenda via
`Simulator::addEventAt(nextTime,...)`, uma fila de eventos própria (ver `QemuDevice::runEvent()`
em `qemudevice.cpp`). Documentado como simplificação aceitável pra GPIO digital simples
(`McuComponent.hpp`, doc da classe) — **revisitar se/quando precisão de timing fino for
necessária** (ex: protocolo com timing crítico tipo WS2812 vindo de um MCU real, não só de um
componente built-in).

### 3.7 `mcu_abi.h` nunca recebeu bump de versão nesta sessão — **DESATUALIZADO, ver seção 7**

Texto original (2026-06-28): "`mcu_abi.h` continua em major 1, nada mudou". Isso já não reflete a
realidade bem antes de 2026-07-25 (o arquivo atual começa em major 2 minor 7 — `LsdnQemuModuleVTable`/
`create_modules`/monitor/inject_rx_bytes, todos de sessões não documentadas aqui). A sessão de
2026-07-25 bump para **minor 8** (`get_pull_state`, ver seção 7.4). Corrigir esta seção só registra
que o número "1" já estava errado há tempo, não é mais um "nada mudou" genuíno.

---

## 4. `.skill/lasecsimul.skill` — correções necessárias

Lido por completo nesta sessão. Contém **várias regras "inegociáveis" diretamente contraditas**
pelo trabalho desta sessão — é a fonte de orientação que qualquer agente lê primeiro, então
desalinhamento aqui é o que mais risco de causar retrabalho errado no futuro.

- **Linha ~22**: lista `BusController` como algo que "pertence à sessão" (junto de
  `Netlist`/`Scheduler`/`PluginRuntime`/`QemuProcessManager`). Remover `BusController` da lista.
- **Linhas ~126-129**: regra inteira sobre "Futuro `I2cBusModule`/`SpiBusModule` (ainda não
  implementado)... master agendado por evento, slave puramente reativo". **Substituir** pela regra
  nova: protocolo é decodificado bit a bit via `ComponentEvent{kPinChangeEventTag}`, nunca por um
  "módulo de barramento" que entrega byte pronto.
- **Linhas ~161-166**: regra "Integração com QEMU... módulo de barramento genérico reusado por
  qualquer chip — nunca pino-a-pino". **Isso está com a conclusão invertida** — é exatamente o
  contrário do que a auditoria desta sessão confirmou (seção 0.5, "Achado crítico"): módulo de
  registrador É chip-específico de propósito; só `Scheduler`/`Netlist`/IPC/UI são neutros. Reescrever
  com a conclusão certa, citando `Esp32GpioModule`/`QemuModule.hpp` como exemplo concreto.
- **Linhas ~167-169**: regra sobre `BusController` nunca saber nome de chip/plugin — `BusController`
  não existe mais; a regra equivalente agora é sobre `McuComponent`/`Scheduler`/`Netlist` nunca
  saberem nome de chip (módulos sim podem saber).
- **Linha ~124**: "Plugin nativo ainda não participa (`device_abi.h` não tem `set_property`)" —
  **isso já estava errado mesmo antes desta sessão** (a ABI já tinha `set_property`/`get_property`
  há tempo) — corrigir independente do resto.
- **Linhas ~78-80**: cita `IBusParticipant` como uma das três interfaces existentes
  (`IComponentModel`, `IMcuAdapter`, `IBusParticipant`) a checar antes de tocar
  `MnaSolver`/`Scheduler`. `IBusParticipant` foi removida. Atualizar a lista de interfaces.
- **Linha ~3 e várias outras**: referências a `SimulIDE-dev` como caminho de leitura precisam
  apontar pra `C:\SourceCode\simulide_2` (ver seção 0.5 — `SimulIDE-dev` não existe mais neste
  disco). Conferir TODAS as ocorrências de `SimulIDE-dev` no arquivo, não só as óbvias.
- **Sem nenhuma menção** a `current()`/leitura de corrente, nem à convenção de sinal validada —
  considerar adicionar uma regra curta (já que a skill documenta convenções de código, e essa é
  uma convenção real e não-óbvia: "convenção passiva, fonte fornecendo energia é negativa").
- **Falta uma regra nova** sobre o limite de `rcond()` do solver e o cuidado com spread de
  condutância em componentes de muitos pinos (lição da seção 0.5, "bug numérico real") — é
  exatamente o tipo de armadilha não-óbvia que essa skill existe pra prevenir no próximo
  componente parecido.

---

## 5. Limpeza solta (baixo risco, baixo esforço, não bloqueia nada)

- **Arquivos `.obj` soltos na raiz do repositório** (`CircuitGroupTest.obj`, `CrashGuard.obj`,
  `MnaSolverTest.obj`, `NativeDeviceProxy.obj`, `PassiveComponentsTest.obj`, `PluginLoader.obj`,
  `PluginModule.obj`, `Scheduler.obj`, `SimulationSession.obj`, `voltage_divider_test.obj`,
  `README.md` duplicado) — parecem artefato de build apontado pro diretório errado em algum
  momento. Confirmar com o usuário antes de apagar (pode ser working-in-progress de outra
  ferramenta) — não é claramente seguro decidir sozinho.
- Conferir se `.gitignore` cobre `*.obj` na raiz (se não, é por isso que apareceram rastreáveis).

---

## 6. Ordem recomendada de execução

1. **`.skill/lasecsimul.skill`** primeiro — é o que qualquer outro agente lê antes de tudo; deixar
   ele errado enquanto corrige o resto é como pintar a casa com a porta aberta pra poeira entrar.
2. **`.spec/README.md`** + documentos canônicos aplicáveis — fonte de verdade normativa. Os monólitos em
   `.spec/archive/legacy-v2/` servem apenas para localizar o contexto histórico citado na seção 1.
3. **`docs/16-roadmap-pendencias-spec.md`** + **`docs/mvp-limitacoes.md`** + **`docs/11-qemu-esp32.md`**
   — seção 2 deste documento.
4. Só depois, código novo: seção 3, na ordem 3.1 (IOMUX+TWI/SPI/USART, maior esforço, é o que
   desbloqueia mais coisa) → 3.3 (expor `loadFirmware` via IPC, médio esforço, desbloqueia testar
   "Blink Real" de ponta a ponta pela Extension) → 3.2 (`McuRuntimeManager`, precisa de decisão de
   design primeiro) → 3.4/3.5 (baixa prioridade, sem caso de uso real ainda).
5. Seção 5 (limpeza) pode ser feita em paralelo com qualquer item acima, é independente.

**Antes de começar a seção 3 (código novo)**: confirmar com o usuário que ainda quer seguir o
modelo "copiar fielmente do `simulide_2`/`qemu_simulide` reais", não inventar — é a instrução
explícita que guiou todo o trabalho desta sessão e não deve ser presumida silenciosamente continuar
valendo sem reconfirmar com uma sessão nova.

---

## 7. Atualização 2026-07-25 — I2C/SPI reais, pull-up/down + open-drain, SPI CS0 de hardware

Sessão nova, bem depois de 2026-06-28. **A seção 3.1 acima está desatualizada** — o que ela lista
como pendência (IOMUX/matrix, TWI/SPI/USART do ESP32) já estava PARCIALMENTE resolvido antes desta
sessão (GPIO/IOMUX/matrix e USART completos — ver `mcu-adapters/espressif-esp32/src/Esp32Adapter.cpp`,
nenhum dos dois foi tocado aqui) e a parte que faltava de verdade (I2C, SPI, pull-up/down interno,
CS0 de hardware) é o que esta sessão fecha. Contexto real do pedido: usuário reportou SSD1306 (I2C)
funcionando no SimulIDE real e em branco no LasecSimul com o MESMO firmware ESP32 — a causa raiz era
`i2cWriteRegister`/`i2cReadRegister`/`spiWriteRegister`/`spiReadRegister` serem stubs vazios em
`Esp32Adapter.cpp`: o QEMU "via" toda transação I2C/SPI completar sem erro (o motor de FIFO/
comando/interrupção dele é real e roda certo do ponto de vista do firmware), mas nenhum bit
elétrico de verdade saía pro barramento — o dispositivo (SSD1306 ou qualquer outro) nunca recebia
nada, ficando preso no estado de reset.

### 7.1 Princípio arquitetural mantido (não mudou)

QEMU (fork em `C:\SourceCode\qemu_lasecSimul`, não mais `qemu_simulide` — o caminho mudou entre
sessões, confirmar sempre `git -C <fork> remote -v`/`log` antes de assumir) continua sendo dono do
FIFO/registrador/interrupção de cada periférico — o Core nunca duplica esse motor. A mudança desta
sessão foi **fechar o elo que faltava**: fazer o QEMU espelhar (`writeReg()`/`readReg()`, mesmo
canal privado já usado por GPIO/USART) o suficiente de CADA opcode real (I2C: RSTART/WRITE/READ/
STOP; SPI: byte de dado + início/fim real de transação) pra o lado Core converter isso em edges
elétricos reais de SCL/SDA/SCLK/MOSI/CS0 — e ler de volta (ACK/NACK real, byte recebido) o que o
barramento elétrico de fato produziu, fechando o ciclo nos dois sentidos.

### 7.2 I2C — write, read, repeated-START, ACK/NACK real

**QEMU (`hw/i2c/esp32_i2c.c`, fork em `C:\SourceCode\qemu_lasecSimul`)**:
- `I2C_OPCODE_RSTART` agora espelha o próprio comando (`writeReg(A_I2C_CMD, cmd)`) antes de avançar
  — sem isso, o Core não tinha como distinguir "um START (ou repeated-START) está começando agora"
  de "só mais um byte do mesmo burst de escrita". Cobre tanto o START inicial quanto qualquer
  repeated-START no meio de uma transação (`i2c_master_write_read_device()` etc.) — eletricamente
  são a mesma coisa (SDA cai com SCL já alto), então um único mecanismo cobre os dois.
- `I2C_OPCODE_READ` estava vazio (comentado) — implementado: espelha o comando (opcode+ACK_VAL+
  BYTE_NUM) antes do timer, e no timer (`esp32_i2c_event`) lê de volta o byte que o Core já recebeu
  eletricamente (`readReg(A_I2C_CMD)`) e empurra pro `rx_fifo` real — dado real chega no firmware
  via `i2c_master_read()`/`Wire.requestFrom()`, não mais um FIFO vazio silencioso.
- ACK/NACK real: `esp32_i2c_event()` lia `A_I2C_STATUS` mas descartava o resultado (`ackT` fixo em
  0, comentário "TODO: get ACK from status" no fonte original) — agora usa o bit real espelhado
  pelo Core. `ACK_ERR` também estava com a fórmula errada (comparava só bits que o PRÓPRIO firmware
  escreveu, nunca contra o ACK real do barramento — um endereço sem resposta nenhuma nunca gerava
  erro) — corrigido pra comparar o ACK real contra o que o firmware esperava (`ACK_CHECK_EN`/
  `ACK_EXP`).
- `esp32_i2c_updt_frequency()` já espelhava o período de bit real (`writeReg(A_I2C_LOW_PERIOD,
  period_ns)`) antes desta sessão — só não estava sendo consumido do lado Core (ver 7.4).

**Core (`Esp32Adapter.cpp`)**: motor mestre reescrito do zero em torno de uma fila única de
operações (`I2cOp`: Restart/Write/Read/Stop, na ordem exata em que o QEMU as mirrora) — nenhuma
suposição sobre "primeiro byte é sempre endereço" ou sobre biblioteca/dispositivo específico, só
replica bit a bit qualquer sequência real de opcodes. START/repeated-START usam a MESMA sequência
de 4 fases (liberar SDA → subir SCL → derrubar SDA → descer SCL); WRITE dirige SDA (push-pull,
simplificação documentada — só a janela de ACK depende de verdade do open-drain) e libera SDA na
janela de ACK pro escravo confirmar (open-drain real, mesma convenção de
`devices/simulide-complex/src/lib.c::i2c_clock_bit`); READ libera SDA durante os 8 bits (escravo
dirige) e o MESTRE dirige o ACK/NACK depois (ACK=puxa baixo, NACK=libera — real open-drain, decidido
pelo `ACK_VAL` de cada comando `READ`, não por heurística de "é o último byte"). Período de bit
aprendido do próprio QEMU (`I2C_LOW_PERIOD`, ver 7.1) — sem isso, dependeria de um palpite fixo de
400kHz independente do que o firmware configurar.

**Limitação real, documentada, não escondida**: `I2C_OPCODE_READ` só foi implementado até onde o
PRÓPRIO fork QEMU permite — não há multi-master/arbitration (o ESP32 real, como mestre único, é o
único cenário que o hardware real deste projeto precisa cobrir).

### 7.3 SPI — CS0 de hardware automático

**QEMU (`hw/ssi/esp32_spi.c`)**: `esp32_spi_do_command()`/`esp32_spi_event()` (caminho `número>=2`,
HSPI/VSPI — SPI0/SPI1, dedicados a flash/PSRAM onboard, continuam 100% internos ao QEMU via
`ssi_transfer`, nunca chegam no Core) agora espelham `A_SPI_CMD=1` no início real de CADA transação
USR e `A_SPI_CMD=0` no fim real (quando o último byte termina) — mesmo bracket que
`esp32_spi_cs_set()` já aplicava pro caminho interno de SPI0/SPI1, só que exposto pro Core em vez de
`qemu_irq`. `A_SPI_PIN` (CS0_DIS/CS0_POL) também passou a ser espelhado em toda escrita.

**Core**: `SpiState` ganhou `pinReg`/`csAsserted`, recomputando `cs0OutputEnabled`/`cs0OutputLevel`
(`spiUpdateCs0`) a cada mudança de qualquer um dos dois — CS0 cai automaticamente no início real de
QUALQUER transação e sobe no fim, sem nenhum firmware/biblioteca precisar pilotar um GPIO manual
(esse continua funcionando também, exatamente como antes — a maioria das bibliotecas reais como
Adafruit_SPITFT gerencia CS via `digitalWrite()`/GPIO comum, nunca o CS de hardware do periférico, e
isso não muda em nada com esta correção).

**Limitação documentada**: a posição exata do bit `CS0_POL` (assumida bit13) não pôde ser
confirmada contra o TRM completo do ESP32 nesta sessão (só o bit0 `CS0_DIS`, confirmado contra o
próprio reset real `pin_reg=0x6` no fork QEMU) — o caso default (nunca escrito, a esmagadora maioria
das bibliotecas reais) não depende desse bit e funciona corretamente; só um firmware que configure
polaridade de CS não-padrão seria afetado se a posição estiver errada.

### 7.4 GPIO — pull-up/pull-down interno e open-drain

**ABI (`mcu_abi.h` minor 7→8)**: novo slot opcional `get_pull_state` em `LsdnQemuModuleVTable`
(bit0=pull-up, bit1=pull-down) + `QemuModule::pullState()` (C++, default `None`) +
`QemuModuleProxy::pullState()` (fallback `None` se o plugin não implementar, mesmo padrão de todo
slot opcional desta ABI).

**`McuComponent::stamp()`**: o ramo "pino flutuante" (módulo não está dirigindo agora) passou a
consultar `pullState()` antes de cair no floating genérico (`kFloatingConductance`, 1e7Ω) — pull-up
habilitado estampa a MESMA condutância fraca (`kWeakPullConductance`, 100kΩ, renomeado de
`kResetPullupConductance` — é o mesmo resistor físico que o pull-up dedicado do pino RST/EN já
usava, confirmado contra `Esp32Pin::m_pullAdmit`/`setPullup(1e5)` do SimulIDE real) puxando pra VDD
(3.3V); pull-down estampa a mesma condutância puxando pra GND; os dois habilitados ao mesmo tempo
(config incomum mas fisicamente válida — dois resistores em direções opostas) simplesmente somam as
duas stamps, sem tratamento especial.

**`Esp32Adapter.cpp`**: `gpioGetPullState()` lê IO_MUX_GPIOn_REG bits 7 (`FUN_PD`)/8 (`FUN_PU`) —
confirmado contra `Esp32Pin::writeIoMuxReg` do SimulIDE real ("PD bit 7 / PU bit 8"), não
independente/pins RTC (32-39) fora do modo IOMUX-digital (RTC_IO override) — não modelado, gap
honesto, pouco provável de importar pra uso comum de GPIO/I2C. Open-drain: `gpioIsOutputEnabled()`
passou a consultar GPIO_PINn_REG bit2 (`PAD_DRIVER`, mesmo bit que `gpio_set_direction(pin,
GPIO_MODE_OUTPUT_OD)` do ESP-IDF programa) — quando ligado e o nível pretendido for ALTO, o pino é
tratado como não-dirigido (reaproveita o MESMO ramo floating/pull acima, nenhum caminho elétrico
novo) em vez de forçar alto; nível BAIXO continua dirigido normalmente. Fonte do bit exata (posição
2) não pôde ser 100% confirmada contra um TRM local (nem SimulIDE real nem o fork QEMU implementam
isso — `Esp32Pin::writePinReg()` é um stub vazio mesmo na referência) — é o valor mais bem
documentado disponível sem acesso à documentação oficial completa da Espressif.

### 7.5 Testes adicionados

Tudo em `core/test/core/mcu/Esp32AdapterTest.cpp` (ctest `esp32_adapter`), contra o `adapter.dll`
real compilado — não mock: I2C (RSTART+2 WRITE+STOP contando pulsos reais de SCL, ACK real
simulado por um "escravo" de teste; RSTART+WRITE+2 READ com ACK/NACK reais e reconstrução do byte
recebido; ACK_ERR real quando nenhum escravo responde), SPI (contagem de pulsos de SCLK + bit a bit
de MOSI, CS0 caindo/subindo automaticamente ao redor de uma transação real + `CS0_DIS`), GPIO
(`FUN_PU`/`FUN_PD` isolados e juntos, open-drain liberando só o nível alto). **Rodado**: suíte
completa do Core (`ctest`, 58 alvos incluindo os testes reais de QEMU
`mcu_controller_real_qemu`/`mcu_scheduler_pacing_sync_real_qemu`/
`mcu_multiple_controllers_real_qemu`) — 100% passou, sem regressão.

### 7.6 Nota de processo — fork QEMU é um repositório separado

`C:\SourceCode\qemu_lasecSimul` é um git próprio, fora do repositório LasecSimul. O script oficial
de build/deploy (`scripts/build-qemu-windows.ps1`) **recusa rodar com alterações rastreadas não
commitadas** no fork (checagem deliberada de proveniência/supply-chain). As mudanças desta sessão
(`hw/i2c/esp32_i2c.c`, `hw/ssi/esp32_spi.c`) foram compiladas via `ninja` direto e o
`qemu-system-xtensa.exe` resultante foi copiado manualmente pra `devices/qemu-esp32/bin/` só pra
teste/desenvolvimento local — **isso contorna a checagem do script oficial de propósito**. Antes de
qualquer release, alguém precisa: revisar o diff em `C:\SourceCode\qemu_lasecSimul`, decidir se
commita, e então rodar `scripts/build-qemu-windows.ps1` de verdade (ele recalcula
`BUILD-PROVENANCE.txt`/SHA-256 e falha se o hash não bater).
