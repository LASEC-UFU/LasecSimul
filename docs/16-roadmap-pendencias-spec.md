# 16 - Roadmap de Pendências das `.spec`

## Objetivo

Transformar as pendências abertas em `lasecsimul.spec`, `lasecsimul-native-devices.spec` e
`lasecsimul-subcircuits.spec` em uma fila de produção prática, com épicos, dependências, entregáveis e ordem
recomendada.

## Escopo

Este documento descreve o **estado atual do backlog estrutural do projeto**, não o roadmap histórico do MVP.
Ele deve ser lido junto com:

- `docs/02-roadmap-mvp.md` — visão do MVP original;
- `docs/03-plano-de-execucao.md` — divisão por ondas/agentes;
- `docs/mvp-limitacoes.md` — lacunas conscientemente abertas no código atual;
- `.spec/lasecsimul.spec`;
- `.spec/lasecsimul-native-devices.spec`;
- `.spec/lasecsimul-subcircuits.spec`.

## Leitura executiva

Hoje as pendências se concentram em seis frentes:

1. fechar o comportamento normativo já especificado do Core;
2. completar o pipeline MCU/QEMU;
3. completar periféricos de chip restantes (IOMUX/TWI/SPI/USART do ESP32) e fault handling de plugins;
4. construir a suíte de testes faltante da Extension;
5. entregar subcircuitos como produto;
6. atacar o backlog avançado do editor.

## Critérios de priorização

Ordem usada neste roadmap:

1. primeiro o que bloqueia RF/RNF centrais já assumidos na spec;
2. depois o que reduz risco arquitetural e risco de regressão;
3. depois o que habilita novos catálogos/produtos inteiros;
4. por fim refinamentos de UX e editor que não mudam a arquitetura base.

## Épico A - Fechar o contrato de propriedades e metadata no Core

**Status: concluído.** Validação de tipo/faixa/enum em `setProperty` (A1), efeito real de
`affectsTopology` (A2) e `requiresRestart` reportado na resposta IPC (A3) já estão implementados e
testados (`core/test/core/CoreBootstrapTest.cpp::testSetPropertyValidationOverIpc`,
`core/test/core/PropertyTopologyEffectTest.cpp`). O contrato de erro estável (A4) e a aposentadoria
de `listComponents()`/`ComponentDisplayMeta` (A5) foram concluídos do lado da Extension
(`extension/src/ipc/protocol.ts::IpcError`/`errorCodeFromPayload`, `CoreClient.ts`, `types.ts`).
Corrigido também um bug em `core/src/ipc/IpcServer.cpp::buildResponse` que descartava o `payload`
(com o `errorCode`) sempre que a resposta tinha `ok: false`, quebrando o contrato de erro na prática
mesmo com A1/A4 corretos isoladamente.

### Motivação

O schema de propriedades já existe de ponta a ponta, mas parte do comportamento normativo ainda não. As specs
explicitam isso em `lasecsimul.spec` seção 6.1.2 e `lasecsimul-native-devices.spec` seção 4.2.2.

### Pendências

- Validar tipo do valor recebido em `SimulationSession::setProperty()` contra `PropertySchema`.
- Validar faixa (`min`/`max`) e regras de enum/opções antes de aplicar `set`.
- Dar efeito real a `affectsTopology`.
- Dar efeito real a `requiresRestart`.
- Definir feedback de erro coerente no IPC quando a propriedade for inválida.
- Fechar o gap remanescente de `listComponents()`/metadata por instância, hoje separado de
  `getPropertySchemas`.

### Entregáveis

- validação completa de propriedade no Core;
- resposta IPC consistente para erro de edição;
- rebuild/restart automático ou aviso explícito conforme flags;
- decisão formal: manter ou aposentar `listComponents()`.

### Dependências

- nenhuma forte; pode começar imediatamente.

### Arquivos alvo

- `core/src/session/SimulationSession.*`
- `core/src/app/CoreApplication.cpp`
- `extension/src/ipc/CoreClient.ts`
- `docs/mvp-limitacoes.md`

### Critério de aceite

- editar uma propriedade inválida nunca deixa o componente em estado parcial;
- `affectsTopology` refaz o que precisar no netlist;
- `requiresRestart` produz comportamento explícito e testado;
- testes headless cobrindo tipo, faixa, enum e flags.

### Nota adicional: leitura de corrente (`current()`) — entregue em 2026-06-28

Fora do escopo original deste épico, mas no mesmo espírito (expor mais estado do componente sem
disparar solve novo): `IComponentModel::current()` + `SimulationSession::componentCurrent()` + IPC
`getComponentCurrent` + `CoreClient.getComponentCurrent`. Convenção de sinal passiva validada
empiricamente (fonte fornecendo energia aparece negativa). Detalhe completo em
`.spec/lasecsimul.spec` seção 6.1.4 e `docs/17-pendencias-pos-sessao-qemu-abi.md` seção 0.1.

## Épico B - Completar o pipeline MCU/QEMU

**Status: concluído, e mais avançado do que quando este épico foi escrito.** `QemuProcessManager`,
`FirmwareWatcher` e `McuComponent` (peça que faltava: liga `IMcuAdapter` ao circuito real via pinos,
seção 8 do `.spec/lasecsimul.spec`) estão implementados. Adaptador ESP32 migrado em 2026-06-28 do
caminho built-in (que existia em `core/src/mcu/esp32/`, removido) para **plugin DLL/SO**
(`mcu-adapters/espressif-esp32/`, `mcu_abi.h` major 2+, `LsdnQemuModuleVTable`/`create_modules`) — mesmo
desempenho, sem precisar recompilar o Core pra cada chip novo. Binário real do QEMU **vendorizado** em
`devices/qemu-esp32/bin/` (copiado de
`SimulIDE_2-R260501_Win64\data\bin\`) e teste de integração ponta a ponta lança o processo real
(`core/test/core/mcu/McuControllerRealQemuTest.cpp`, target `mcu_controller_real_qemu`) — abre a arena,
inicia o processo, só falha no firmware porque ainda não existe um `.bin` real (falta toolchain
ESP-IDF). `core/test/core/mcu/McuComponentTest.cpp` prova `GPIO_ENABLE_REG`+`GPIO_OUT_REG` subindo um
pino do circuito pra 3.3V sem precisar de QEMU real (arena sintética). Protocolo da arena
(`qemu_arena_abi.h`) foi reescrito nesta sessão (regAddr/regData/SIM_READ/SIM_WRITE, 88 bytes,
confirmado contra o binário real) — ver `docs/17-pendencias-pos-sessao-qemu-abi.md` seção 0.5.
**O que ainda falta** (não bloqueia o critério de aceite original, mas seria necessário pra periféricos
alem de GPIO simples): IOMUX/pin-matrix e módulos TWI/SPI/USART do ESP32 (seção 3.1 do handoff),
`McuRuntimeManager` pra múltiplas instâncias de MCU por projeto (seção 3.2), expor
`loadFirmware`/`stopFirmware` via IPC (seção 3.3).

### Motivação (histórica — RF04/RF05/RF08 já atendidos pelo que está implementado)

### Pendências reais que restam

- IOMUX/pin-matrix e módulos `Esp32TwiModule`/`Esp32SpiModule`/`Esp32UsartModule` (só GPIO existe).
- `McuRuntimeManager` pra múltiplas instâncias de MCU por projeto.
- Expor `loadFirmware`/`stopFirmware` via IPC (hoje só exercitado por teste C++ direto).
- Toolchain ESP-IDF pra gerar um firmware `.bin` real (dependência externa, não é trabalho do Core).

### Entregáveis (já alcançados)

- processo QEMU real controlado pelo Core (`QemuProcessManager`), binário vendorizado;
- arena de memória lida/escrita com dispatch por endereço (`QemuArenaBridge` + `McuComponent` + módulo
  GPIO do plugin ESP32, via `QemuModuleProxy`);
- `McuComponentTest` prova GPIO subindo um pino do circuito a 3.3V sem precisar de QEMU real;
- ciclo de reload automático de firmware via `FirmwareWatcher` (poll de mtime).
- **Falta** (não bloqueia o que já existe): teste blink ponta a ponta com firmware `.bin` real (precisa
  da toolchain ESP-IDF).

### Dependências

- Épico C (decodificação bit a bit) já não é bloqueio — mecanismo substituído e funcionando
  independente deste épico.

### Arquivos alvo

- `core/src/mcu/qemu/QemuProcessManager.*`
- `core/src/mcu/qemu/QemuArenaBridge.*`
- `core/src/mcu/qemu/FirmwareWatcher.*`
- `core/src/mcu/McuComponent.*`
- `core/src/plugins/QemuModuleProxy.hpp`
- `core/src/mcu/`
- `mcu-adapters/espressif-esp32/`

### Critério de aceite

- firmware inicia, reinicia e para sem derrubar o Core;
- alterações no artefato observado acionam reload automático;
- teste integrado de blink passa de forma reproduzível.

## Épico C - Decodificação bit a bit de protocolo (substituiu módulos genéricos de barramento)

**Status: substituído por completo em 2026-06-28.** A abordagem original deste épico
(`BusController`/`I2cBusModule`/`SpiBusModule` genéricos, `core/src/bus/`) foi avaliada, implementada
e testada — mas **nunca foi ligada a um `SimulationSession` real**, só os próprios testes do
subsistema o exercitavam. Não é uma continuação: é uma substituição arquitetural. Removidos por
completo: `core/src/bus/{BusController,I2cBusModule,SpiBusModule}.hpp`, `IBusParticipant.hpp`, e os
testes `core/test/core/bus/{I2cBusModuleTest,SpiBusModuleTest}.cpp`.

**O que existe agora**: detecção de borda digital real em `SimulationSession::settleStep()` — quando a
tensão de um nó cruza `kDigitalLevelThreshold` (2.5V, `core/include/lasecsimul/Types.hpp`), o Core
dispara `ComponentEvent{kPinChangeEventTag, localPinIndex, nivel, nsDesdeABordaAnterior}` para todo
componente/pino presente naquele nó — built-in ou plugin, sem distinção, sem precisar de registro
prévio. Protocolo (I2C/SPI/UART) é decodificado bit a bit pelo próprio device/componente a partir
desses eventos — nunca por um módulo de barramento intermediário. Infraestrutura de suporte:
`Netlist::Topology::pinRefsByNode` (paralelo a `listenersByNode`, sem dedup),
`Scheduler::nowNsUnlocked()`/`scheduleEventUnlocked()` (variantes sem mutex, seguras de dentro do
próprio settle-loop). Teste: `core/test/core/session/PinChangeDispatchTest.cpp` (`pin_change_dispatch`
no ctest). `devices/simulide-complex/src/lib.c` migrado pra usar só `LSDN_EVT_PIN_CHANGE`.

**Achado crítico relacionado** (afeta também o Épico B/MCU): a crença de que "módulos de
periférico devem ser genéricos, reusados por qualquer chip" estava errada — confirmado lendo
`hw/gpio/esp32_gpio.c` do fork QEMU real. O QEMU manda registrador bruto, sem decodificar nada; quem
decodifica é o módulo do lado do Core, e esse módulo é CHIP-ESPECÍFICO de propósito (ver
`core/include/lasecsimul/QemuModule.hpp`, `Esp32GpioModule`). Só `Scheduler`/`Netlist`/IPC/UI precisam
ser neutros quanto a chip.

Detalhe completo da sessão que fez essa substituição:
`docs/17-pendencias-pos-sessao-qemu-abi.md`, seções 0.1/0.4/0.5.

### Pendências reais que restam (não é mais sobre módulo de barramento)

- ESP32: IOMUX/pin-matrix (tabela de 512 entradas) e módulos `Esp32TwiModule`/`Esp32SpiModule`/
  `Esp32UsartModule` (só GPIO puro existe hoje) — ver `docs/17-pendencias-pos-sessao-qemu-abi.md`
  seção 3.1.
- `mcu_abi.h` (ABI de MCU plugin de terceiro) não tem equivalente a `QemuModule`/`createModules()` —
  só adaptadores built-in conseguem declarar módulos concretos hoje (seção 3.4 do mesmo documento).

### Critério de aceite (revisado)

- protocolo (I2C/SPI/UART) decodificado pelo device a partir de `LSDN_EVT_PIN_CHANGE`, sem módulo de
  barramento intermediário;
- um adaptador de MCU novo declara seus próprios `QemuModule`s concretos via `createModules()` — não
  reimplementa o despacho por endereço (`McuComponent` faz isso), mas também não finge que o registrador
  é genérico entre chips;
- testes de decodificação de protocolo não dependem da UI nem de QEMU real (`PinChangeDispatchTest`).

## Épico D - Robustez de plugins nativos: timeout, fault, trust e recovery

**Status: parcialmente concluído.** Implementado: watchdog por thread dedicada
(`core/src/plugins/PluginWatchdog.hpp`, sem `TerminateThread`/`pthread_cancel`, thread presa é
desanexada), estado `Ok`/`Lagging`/`Faulted` em `IComponentModel::health()` (default `Ok` pra
built-in, `NativeDeviceProxy` escalona pra `Faulted` após 3 timeouts consecutivos), visibilidade
via IPC (`getComponentHealth`, `CoreClient.getComponentHealth`), e fluxo de trust/consentimento de
publisher na Extension (`extension/src/trust/{TrustStore,trustDecision}.ts`, diálogo modal
Bloquear/Permitir uma vez/Sempre confiar, decisão persistida em `globalState`, bibliotecas
`trust: "first-party"` como `devices/library.json` nunca pedem consentimento). Testes em
`core/test/core/plugins/PluginWatchdogTest.cpp` e `extension/src/trust/trustDecision.test.ts`.

Decisão de escopo registrada aqui (não escondida): o watchdog se aplica só a `postStep` (onde
"zero-order hold" é seguro -- segue com o último valor conhecido). `stamp()` continua síncrono, sem
watchdog, porque roda inline na mesma iteração do `MnaSolver` (seção 10) e não tem fallback seguro
de "adiar a contribuição desta rodada" sem arriscar resultado fisicamente incoerente.

**Ainda pendente, conscientemente não implementado nesta rodada** (cada um é um projeto à parte,
não uma tarefa pequena dentro deste épico):
- `yield_check` cooperativo no SDK do plugin (é o autor do plugin que chamaria isso dentro do seu
  próprio loop -- o host já tem o watchdog independente disso; falta só documentar no SDK/exemplo).
- Recovery do Core após crash não contido com restauro de snapshot (item 5 da seção 12) -- exige
  supervisor de processo + serialização periódica de snapshot + relançamento do Core pela Extension;
  nenhuma peça disso existe ainda.

### Motivação

O modelo ABI já existe, mas a parte operacional pesada ainda precisa de entrega real para o sistema ficar
seguro o suficiente para uso contínuo.

### Pendências

- Implementar `yield_check`/convenção cooperativa no host ABI.
- Implementar watchdog por thread dedicada.
- Marcar device como `lagging` e depois `faulted` conforme política da spec.
- Decidir e implementar a telemetria/visibilidade desse estado para a Extension.
- Implementar fluxo de trust/consentimento de publisher na Extension.
- Implementar recovery do Core após crash com restauro de snapshot.

### Entregáveis

- fault handling real para plugins mal comportados;
- mensagens de diagnóstico ao usuário;
- consentimento persistido por publisher;
- reinício automático do Core com restauração do último snapshot viável.

### Dependências

- Core e Extension juntos; atravessa fronteira de processo.

### Arquivos alvo

- `core/src/plugins/`
- `core/src/app/`
- `extension/src/extension.ts`
- `extension/src/ipc/`

### Critério de aceite

- plugin que falha não destrói a sessão silenciosamente;
- usuário recebe motivo claro;
- trust não é decidido dentro do Core;
- crash recovery consegue restaurar o projeto com perda limitada.

## Épico E - Testes faltantes da Extension

### Motivação

A própria estrutura da documentação já aponta que os testes da camada TypeScript ainda não foram escritos.
Sem isso, o backlog de editor e i18n fica caro de manter.

### Pendências

- Criar suíte de testes da Extension com mock do Core/IpcServer.
- Cobrir `CoreClient`.
- Cobrir sincronização de catálogo e schemas.
- Cobrir i18n `pt-BR`/`en` na paleta e na folha de propriedades.
- Cobrir fluxos básicos da Webview sem exigir Core real quando não necessário.

### Entregáveis

- infraestrutura de testes TS estável;
- smoke tests da extensão;
- regressão para idioma, catálogo, propriedades e mensagens IPC.

### Dependências

- nenhuma forte; pode começar logo após o fechamento do Épico A.

### Arquivos alvo

- `test/extension/`
- `extension/src/`
- `extension/package.json`

### Critério de aceite

- mudanças em catálogo/propriedade/idioma quebram teste antes de quebrar a UI;
- o pipeline da Extension não depende sempre do Core real.

## Épico F - Subcircuitos como produto

**Status (atualizado 2026-07-07): fundação do Core concluída E integração na Extension também —
"Criar Subcircuito a partir da Seleção" foi implementado em 2026-07-03 (ver seção 11 de
`.spec/lasecsimul-subcircuits.spec`), fechando o que este Épico ainda listava como pendente. O texto
abaixo (escrito em 2026-06-28/29) usa o formato de arquivo ANTIGO (`.lssub.json`+`.lsconfig`
separados) como exemplo — já migrado pra `.lssubcircuit` único em 2026-07-06, ver a nota
"Atualização 2026-07-06" logo abaixo. Mantido como registro histórico da fundação do Core; as
pendências reais de então já foram todas resolvidas (ver lista de Pendências atualizada mais
abaixo).** Implementado em `core/src/registry/SubcircuitRegistry.hpp` e
`core/src/session/SimulationSession.{hpp,cpp}`, seguindo `.spec/lasecsimul-subcircuits.spec` seção 5
à risca:
- Loader de `.lssub.json`/`subcircuits/library.json` (histórico -- hoje é `.lssubcircuit`, ver nota
  de migração 2026-07-06 abaixo) (`loadSubcircuitLibraryFile` em
  `CoreApplication.cpp`, reaproveita o verbo IPC `loadDeviceLibrary` já existente — um
  `library.json` com `"devices"` cai no caminho de plugin, um com `"subcircuits"` cai aqui).
- `SimulationSession::addSubcircuitInstance()` -- expansão recursiva (`addComponent`/`connectWire`
  por componente/fio interno, nesting automático quando um componente interno é outro
  subcircuito), renomeio de `Tunnel` por `interface[]` com prefixo `"<subcircuitInstanceId>::"`
  (seção 2 -- duas instâncias do mesmo subcircuito não colidem, testado).
- Detecção de ciclo (pilha de `typeId`s em expansão) e `removeSubcircuitInstance()` com remoção em
  cascata (seção 5.4), incluindo nesting.
- `subcircuitInstanceId` sintético (bit alto reservado, `kSubcircuitInstanceFlag`) para distinguir
  de um `componentIndex` comum no mesmo `instanceId` numérico da fronteira IPC -- decisão de
  implementação explicitamente liberada pela spec (seção 5.1, item 2).
- IPC: `addComponent` com `typeId` de subcircuito devolve `{"instanceId", "exposedPins"}` (seção
  6); `removeComponent` despacha pra `removeSubcircuitInstance` quando o id é de subcircuito.
- Teste de integração ponta a ponta em `core/test/subcircuit_test.cpp`: expande o exemplo exato da
  seção 1 (`divisor_5v`), liga fonte/terra externas aos pinos expostos, confirma que o circuito
  resolve eletricamente igual ao mesmo divisor montado componente a componente; cobre também
  não-colisão entre instâncias, cascata de remoção e ciclo.

**Integração na paleta — concluída em 2026-06-28** (estava parcialmente escrita mas com um gate
fixo: `extension.ts::resolveRegisteredItem` desabilitava incondicionalmente qualquer
`kind: "subcircuit-file"` com a razão hardcoded "execução ainda indisponível no Core atual" —
desatualizado desde que o Core ganhou suporte de ponta a ponta, descrito acima). Corrigido pra
seguir o mesmo tratamento de `abi-device` (lê `lsconfig` pra label/folderPath/icon/`symbolSvg`/
`pinCount`/`defaultProperties`, infere `library.json` na mesma pasta do `.lssub.json` — convenção de
arquivo único da seção 7 do spec — e só desabilita se esse `library.json` não existir). Prova real:
`subcircuits/esp32_devkitc_v4.lssub.json` (placa ESP32 DevKitC V4, ver `docs/11-qemu-esp32.md`),
registrado via `registeredSources` (`project/schema/component-catalog.json`) com seu próprio
`esp32_devkitc_v4.lsconfig`, aparece habilitado na paleta e instancia de verdade.

**Atualização 2026-07-06 (migração de extensões)**: o `.lsconfig` descrito acima era exatamente a
duplicação que contrariava o "princípio do arquivo único" já valendo pra `device.json`/`.lsdevice`
desde 2026-07-02 — corrigido nesta data. `esp32_devkitc_v4.lssub.json`+`esp32_devkitc_v4.lsconfig`
(e o par `esp32_wroom32.*`) foram fundidos num único `esp32_devkitc_v4.lssubcircuit` (campo
`iconPath` movido pro manifesto raiz, `.lsconfig` apagado). `mcu-adapters/espressif-esp32/mcu.json`
também virou `.lsdevice`, fundindo seu `device.lsconfig`. Ver `.spec/lasecsimul-subcircuits.spec`
seção 7.1 e `.spec/lasecsimul-native-devices.spec` seção 14/21.2 (já atualizadas).

**Atualização 2026-07-03**: comando "Criar Subcircuito a partir da Seleção" **implementado** —
`lasecsimul.newSubcircuit`, algoritmo completo em `createSubcircuitFromSelectionHandler`
(`extension.ts`), detalhado em `.spec/lasecsimul-subcircuits.spec` seção 11. Editor de símbolo
(Épico G) e persistência `.lssubcircuit` a partir do editor também já implementados (ver Épico G
abaixo) — nenhuma das três pendências listadas aqui em 2026-06-28 continua em aberto.

### Motivação

Subcircuitos são o próximo grande multiplicador de catálogo sem custo de ABI. A spec já está madura o
suficiente para começar a implementação por fases.

### Pendências

- Definir e implementar loader de `subcircuits/library.json`.
- Permitir registrar subcircuitos no mesmo catálogo unificado.
- Implementar `addComponent` de subcircuito com `exposedPins`.
- Implementar `removeSubcircuitInstance()` e remoção em cascata.
- Implementar expansão recursiva de subcircuito dentro da `SimulationSession`.
- Detectar ciclo de dependência entre subcircuitos.
- ~~Criar comando "Criar Subcircuito a partir da Seleção".~~ **Feito** (2026-07-03, ver
  `.spec/lasecsimul-subcircuits.spec` seção 11).
- ~~Criar persistência `.lssubcircuit`.~~ **Feito**.
- ~~Integrar subcircuitos à paleta com `folderPath`, i18n e `deviceLibraries[]`.~~ **Feito**
  (2026-06-28) — ver nota acima.

### Entregáveis

- suporte headless do Core a subcircuitos;
- ~~fluxo de criação a partir de seleção no editor~~ **feito** (2026-07-03) — `lasecsimul.newSubcircuit`;
- ~~subcircuito aparecendo e sendo instanciado pela paleta~~ **feito** — `subcircuits.esp32_devkitc_v4`
  é a prova real;
- biblioteca `subcircuits/` funcional.

### Dependências

- Épico A pronto;
- i18n e catálogo unificado já estabilizados;
- editor de package minimamente utilizável ajuda, mas não precisa bloquear o primeiro slice.

### Arquivos alvo

- `core/src/session/`
- `core/src/registry/`
- `extension/src/extension.ts`
- `extension/src/ui/webview/`
- `project/schema/component-catalog.json`
- `subcircuits/`

### Critério de aceite

- instanciar/remover subcircuito funciona sem vazamento de componentes internos;
- fios conectam aos `exposedPins` corretamente;
- nesting funciona;
- ciclo é rejeitado com erro claro.

## Épico G - Editor de package/símbolo visual de dispositivos

**Renderizador (leitura) implementado em 2026-06-28** — ver seção anterior deste arquivo/
`docs/11-qemu-esp32.md` ("Renderizador real de `package`").

**Editor (escrita) reimplementado em 2026-06-29.** A primeira versão (2026-06-28,
`extension/src/ui/webview/packageEditor.ts` + `packageEditorGeometry.ts`, um canvas SVG bespoke com
alças feitas à mão) foi **descartada** depois de revisão com captura de tela real (rótulos de pino
sobrepostos, visual divergente do renderizador de leitura) e de uma auditoria do fonte real do SimulIDE
(`C:\SourceCode\simulide_2\src\components\other\subpackage.{h,cpp}` + `components\graphical\*`), que
mostrou que o SimulIDE não tem editor separado: `SubPackage`/`Rectangle`/`Ellipse`/`Line`/
`TextComponent`/`PackagePin` são `Component`s comuns na MESMA cena do circuito, redimensionados por
propriedade numérica (nunca alça de arrastar).

A versão atual segue esse princípio — não existe mais canvas/sidebar bespoke. `main.ts` ganhou uma
**sessão de autoria de símbolo** (`enterSymbolAuthoring`/`exitSymbolAuthoring`/`saveSymbolAuthoring`)
que troca temporariamente qual `WebviewProjectState` o render/drag/painel de propriedades operam em
cima — zero código de renderização/interação novo, tudo já era genérico sobre `state`. Os "objetos
gráficos" viram componentes de catálogo de verdade: `other.package` (corpo, antes desabilitado, agora
property-driven: `width`/`height`/`border`/`backgroundColor`), `graphics.rectangle`/`ellipse`/`line`/
`text` (formas, antes decorativas com tamanho fixo, agora property-driven), e `other.package_pin` (NOVO
typeId — pino do símbolo, ângulo = `component.rotation` genérico, sem campo/código de ângulo
dedicado). Todos `pinCount: 0`, nunca tocam o Core. Conversão pura package↔componentes em
`extension/src/catalog/symbolAuthoring.ts` (`seedSymbolAuthoringComponents`/
`compileSymbolAuthoringComponents`, 7 testes em `symbolAuthoring.test.ts`). Salvar relê o
`.lsdevice`/`.lssubcircuit` do disco e substitui só `package`
(`extension.ts::saveSymbolCommand`); fundo `svg`/`image` já existente é preservado verbatim (sem UI de
upload nesta rodada). Dois pontos de entrada: botão "✎" por item registrado na paleta, comando
`lasecsimul.palette.editSymbol` (seletor de arquivo, pra manifesto ainda não registrado). Detalhe
completo em `docs/11-qemu-esp32.md` e `.spec/lasecsimul-native-devices.spec` seção 21.3.

**Limite real desta entrega — verificação manual no Extension Development Host ainda não foi feita.**
Não há `jsdom`/navegador headless neste repositório (decisão consciente da Onda 1, Épico E/E4), então o
que foi verificado é `tsc` limpo nos dois `tsconfig` (extensão + webview) e os testes automatizados da
conversão PURA package↔componentes (`symbolAuthoring.test.ts`) — nenhum clique real foi simulado contra
o drag/seleção/painel de propriedades. A superfície de risco é menor que a da versão descartada porque a
maior parte do que seria testado manualmente (drag, seleção, rotação, propriedades) é código JÁ EM
PRODUÇÃO, reaproveitado por ~30 outros typeIds do catálogo — não escrito do zero pra este épico. Ainda
assim, antes de considerar isto encerrado de fato, alguém precisa abrir a Extension via `F5` (Extension
Development Host), clicar "✎" num item registrado da paleta, e confirmar visualmente: arrastar/girar um
`other.package_pin`, redimensionar um `graphics.rectangle` pelo painel de propriedades, e "Salvar
Símbolo" reproduzindo o visual original.

**Estendido no MESMO dia (2026-06-29) — "Open Subcircuit" + Modo Placa + Logic Symbol.** Depois de
fechar o editor de `package` sozinho, o usuário apontou (com razão) que minha primeira explicação do
conceito "Package" do SimulIDE estava errada (eu tinha descrito como lista de N-variantes) — pesquisa
real corrigiu (fonte + https://simulidedocs.netlify.app + fórum oficial, ver `.spec/
lasecsimul-native-devices.spec` seção 21.4) e revelou que faltava mais coisa fiel ao SimulIDE real:

- **"Logic Symbol"** (seção 21.4 do spec de plugins nativos): aparência alternativa booleana
  (`logicSymbolPackage`), trocável por botão na barra da sessão de autoria — pra `mcu-adapter` e
  `subcircuit-file`, nunca `abi-device`.
- **Circuito interno real editável** (`.spec/lasecsimul-subcircuits.spec` seção 4): a sessão de
  autoria de um `subcircuit-file` agora TAMBÉM semeia `components[]`/`wires[]` reais (não só o
  `package`) — igual ao "Open Subcircuit" do SimulIDE mostrar os dois juntos na mesma cena.
  `.lssubcircuit` ganhou campos aditivos (`visual`/`boardVisual`/`points`), Core ignora o que não
  reconhece, zero mudança em `SubcircuitRegistry.hpp` (confirmado, `ctest` 26/26 sem alteração).
- **Modo Placa** (`SubPackage::boardModeSlot()` do SimulIDE real): dentro da sessão, componente
  interno tem 2 posições independentes (circuito/placa); ligar o modo esconde quem não for
  `graphical: true` no catálogo (29 typeIds marcados — LED, motor, display, switch...) e deixa
  organizar os visíveis sobre a arte da placa.

### Motivação

A spec do `package` está detalhada, e isso prepara tanto devices ABI quanto subcircuitos. Antes desta
rodada, o contrato existia melhor do que a ferramenta visual para produzi-lo.

### Pendências

- ~~modo de edição de package reaproveitando o esquemático~~ **feito** (2026-06-29, redesenhado a
  partir da auditoria do SimulIDE real — ver nota acima);
- ~~resize do corpo (via propriedade, não alça)~~ **feito**;
- ~~inserção/edição de formas (`graphics.*` property-driven)~~ **feito**;
- ~~posicionamento/rotação visual de pinos (`other.package_pin`)~~ **feito**;
- ~~aparência alternativa "Logic Symbol"~~ **feito** (2026-06-29, mesmo dia);
- ~~circuito interno real editável + Modo Placa pra subcircuito~~ **feito** (2026-06-29, mesmo dia);
- upload e embed de imagem em `background.data` — **não implementado** nesta rodada (só cor sólida via
  `backgroundColor`; fundo `svg`/`image` já existente é preservado, nunca perdido, mas não editável
  visualmente ainda);
- simulação elétrica ao vivo dentro da sessão de "Abrir Subcircuito" — **não implementado**, decisão
  explícita de escopo (a sessão é só posição/propriedades, sem IPC com o Core);
- `BoardSubc`/`ShieldSubc` (Arduino Uno + Shield empilhado, do SimulIDE real) — **não implementado**,
  feature à parte, não pedida;
- round-trip fiel (abrir JSON manual e renderizar igual; editar na UI e salvar igual) — implementado e
  testado (`symbolAuthoring.test.ts`), mas ainda sem confirmação visual manual no Extension Development
  Host (ver ressalva acima);
- ~~comando "Criar Subcircuito a partir da Seleção" (detectar fios cruzando a borda de uma seleção,
  inserir `connectors.tunnel` automaticamente)~~ **feito** (2026-07-03, ver Épico F acima e
  `.spec/lasecsimul-subcircuits.spec` seção 11).

### Entregáveis

- editor visual de package;
- serialização de `package`/`pins[]`;
- reutilização para devices ABI e subcircuitos.

### Dependências

- pode começar em paralelo ao Épico F, mas o Épico F consome seus resultados.

### Arquivos alvo

- `extension/src/ui/webview/` (`main.ts`, `componentSymbols.ts`, `model.ts`, `messages.ts`)
- `extension/src/catalog/symbolAuthoring.ts`
- `extension/src/extension.ts` (`extractInternalCircuit`, `editPackageSymbolCommand`,
  `saveSymbolCommand`, `switchSymbolViewCommand`, `resolveRegisteredItem`)
- `project/schema/component-catalog.json` (`other.package`/`other.package_pin`/`graphics.*`,
  `graphical: true` nos typeIds de interação do usuário)
- `devices/*/*.lsdevice`, `mcu-adapters/*/*.lsdevice`, `subcircuits/*.lssubcircuit`

### Critério de aceite

- um `.lsdevice` sem edição manual extensa já pode ser produzido pela UI;
- abrir/salvar preserva fidelidade sem formato paralelo.

## Épico H - Solver e componentes não lineares

**Status: concluído (primeiro slice).** Implementado `active.diode`
(`core/src/components/active/Diode.hpp`) — modelo companion (condutância + fonte de corrente
equivalente) linearizado a cada `stamp()` em torno do ponto de operação da última `solve()`, com
amortecimento de Newton (limite de passo de `2·Vt` por iteração quando `Vd` já passou do `vCrit`) e
critério de convergência por componente (`hasConverged()` compara `Vd` desta iteração com a
anterior, tolerância `1e-6V`). Teste de integração ponta a ponta em `core/test/diode_test.cpp`:
fonte 10V + resistor 1kΩ + diodo + terra, valida que o laço de Newton-Raphson do `settleStep()`
genérico (sem nenhuma mudança nele) converge pra um ponto de operação que satisfaz KCL (corrente do
resistor bate com a equação do diodo na mesma `Vd`, dentro de tolerância numérica). Loop de
iteração não linear do `Scheduler`/`SimulationSession` não precisou de nenhuma mudança — já estava
pronto pra isto desde a primeira versão do `settleStep()`, só faltava um componente real pra
exercitá-lo.

Métrica/threshold pra solver esparso: NÃO medido nesta rodada (continua guiado por intuição) --
exigiria um circuito com centenas/milhares de componentes não lineares pra medir de verdade, o que
não existe ainda no catálogo. Revisitar quando subcircuitos (Épico F) tornarem viável montar um
circuito grande o bastante pra medir.

### Motivação

A arquitetura para não lineares já foi desenhada; falta transformá-la em comportamento elétrico real.

### Pendências

- implementar primeiro componente não linear real;
- implementar critério de convergência por componente;
- validar loop de iteração não linear do `Scheduler`;
- medir quando um grupo justifica migrar para solver esparso;
- decidir fila de componentes ativos: diodo, BJT, MOSFET, op-amp ideal.

### Entregáveis

- um caso não linear real funcionando;
- testes de convergência e regressão;
- métrica/threshold para futura adoção de `Eigen::SparseLU`.

### Dependências

- Core base estável;
- Épico A concluído.

### Critério de aceite

- pelo menos um ativo real simulado corretamente;
- iteração converge ou falha de forma explícita;
- backlog de solver esparso passa a ser guiado por medição, não intuição.

## Épico I - Backlog avançado do editor

**Status: parcialmente concluído.** Implementado:
- **Flip horizontal/vertical** -- `flipH`/`flipV` em `WebviewComponentModel`/`ProjectComponent`,
  comandos `lasecsimul.flipSelectionHorizontal`/`Vertical` (teclas `h`/`v` com o esquemático em
  foco, mesmo padrão de `rotateSelectionCw`), persistido no `.lsproj`. Puramente visual (como a
  rotação): pinos continuam identificados por `pinId`, fios já conectados não precisam de ajuste
  no Core. Geometria: `flipPoint` aplicado ANTES de `rotatePoint` no cálculo de posição de pino,
  mesma ordem do `transform: rotate(...) scale(...)` no CSS (que aplica da direita pra esquerda).
- **Batch test headless de circuitos salvos** -- `extension/test/project/ProjectSerializer.test.ts`
  agora itera todo `.lsproj` em `test/fixtures/projects/` automaticamente (convenção de nome:
  "invalid" no arquivo == deveria rejeitar no load); fixture nova nesse diretório já é coberta sem
  precisar editar o teste.

**Atualização 2026-07-08** (auditoria "pente fino" achou este parágrafo desatualizado, mesma classe
de drift já documentada em `docs/mvp-limitacoes.md`/`.spec/lasecsimul.spec` pro diode/subcircuitos):
copiar/colar, undo/redo E flip horizontal/vertical foram TODOS implementados numa rodada posterior a
esta -- ver `.spec/lasecsimul.spec` seções 13.4 e 17 pro design final (undo/redo por snapshot
completo via `persistState()`/`syncState`, não o "diff Webview→Core" que o parágrafo original abaixo
concluía ser necessário -- a solução real contornou esse obstáculo em vez de resolvê-lo). O raciocínio
abaixo é preservado como registro histórico de POR QUE parecia difícil na época, não como estado atual.

**Conscientemente não implementado NESTA RODADA (histórico, ver atualização acima)** (decisão de
escopo, não esquecimento):
- **Copiar/colar e undo/redo** -- a arquitetura atual sincroniza Webview↔Core por AÇÃO específica
  (`requestAddComponent`/`requestRemoveComponent`/`requestConnectPins`/etc.), não por estado
  completo (`projectChanged` só espelha o lado Extension, nunca re-sincroniza o Core). Um undo/redo
  genérico por snapshot precisaria de um motor de diff Webview→Core que não existe pra NENHUMA
  mutação hoje -- não é uma tarefa pequena dentro deste épico, é pré-requisito de arquitetura
  novo. Copiar/colar tem o mesmo obstáculo pra qualquer componente que precise existir no Core
  (não só visualmente). Candidato a primeira fatia futura: undo/redo só das mutações puramente
  visuais que já não tocam o Core (rotação, flip, posição, label) -- ainda não feito.
- **Arrastar rótulo independentemente do símbolo** -- exigiria um modelo de posição de label
  separado do símbolo e testes de interação de mouse; testar isso sem DOM real (`jsdom`) não dá pra
  fazer com qualidade, e a Onda 1 já decidiu deixar teste de Webview com DOM fora de propósito (ver
  Épico E). Revisitar junto com essa decisão, não isolado.
- Eventual shell alternativo além do VSCode: fora de propósito enquanto protocolo/formato de
  arquivo continuam estabilizando (ver "O que NÃO deve entrar antes da hora" no fim deste roadmap).

### Motivação

Esses itens não bloqueiam a arquitetura, mas melhoram bastante produtividade do usuário.

### Pendências

- arrastar rótulo independentemente do símbolo;
- ~~copiar/colar~~ -- feito, ver `.spec/lasecsimul.spec` seção 13.4;
- ~~flip horizontal~~ -- feito, ver `.spec/lasecsimul.spec` seção 13.4;
- ~~flip vertical~~ -- feito, ver `.spec/lasecsimul.spec` seção 13.4;
- ~~undo/redo~~ -- feito, ver `.spec/lasecsimul.spec` seção 17;
- ~~batch test headless de circuitos salvos~~ -- feito, ver início desta seção;
- eventual shell alternativo além do VSCode, quando o custo fizer sentido.

### Entregáveis

- ergonomia de edição mais próxima do SimulIDE;
- infraestrutura de histórico/ações reversíveis;
- ferramenta de regressão headless para CI.

### Dependências

- testes da Extension prontos;
- modelo de estado do editor estabilizado.

## Ondas recomendadas

### Onda 1 - Fechamento normativo do que já existe

- Épico A
- Épico E

Resultado esperado:

- propriedades seguras;
- contratos realmente cumpridos;
- base de testes da Extension pronta.

## Onda 1 — tarefas concretas (prontas para implementação)

Estado atual verificado diretamente no código (não suposto) antes de quebrar as tarefas:

- `SimulationSession::setProperty` (`core/src/session/SimulationSession.cpp:79-91`) só confere se a
  propriedade existe pelo nome — chama `descriptor.set(value)` sem checar `descriptor.schema.valueKind`/
  `minValue`/`maxValue`/`options`/flags. O schema **já está disponível ali** (todo `PropertyDescriptor`
  carrega `.schema` desde a rodada de "fim da inferência na Webview") — a validação não precisa de
  nenhuma plumbing nova, só da lógica.
- `affectsTopology`/`requiresRestart` (`PropertySchemaFlags`, `Types.hpp`) existem só como bits — nenhum
  componente built-in/plugin atual os declara, e nada no Core os lê de volta.
- O handler IPC `setProperty` (`CoreApplication.cpp:500-514`) só distingue "propriedade desconhecida" de
  "erro genérico" (`catch` do `nlohmann::json`) — sem código de erro estável, só texto livre.
- `listComponents()` (`CoreClient.ts:139-141`, `ComponentDisplayMeta` em `ipc/types.ts`) **não é chamado
  por nenhum outro lugar do código** — confirmado por busca no repo inteiro. Sem handler no Core. A
  necessidade que motivou ele (metadata por typeId pra UI) já está 100% coberta por `getPropertySchemas`.
- Testes da Extension hoje: `test/project/ProjectSerializer.test.ts`, `src/ipc/CoreClient.test.ts`
  (com um `MockCoreServer` ad-hoc dentro do próprio arquivo), `src/catalog/UnifiedCatalog.test.ts`
  (só a função pura `resolveLocalizedItems`). Nada testa `extension.ts` (handlers de mensagem,
  `attachPropertySchemas`, `currentLasecSimulLanguage`, `nextIndexedLabel`) nem nenhuma lógica pura de
  `main.ts` (`formatEngineeringValue`, geometria de fio) — hoje é tudo só código vivendo dentro de
  funções que também tocam `vscode.*`/DOM, então não tem como importar e testar isolado.

### Épico A — tarefas

**A1. Validação de tipo/faixa/enum em `setProperty`**
- Arquivo: `core/src/session/SimulationSession.hpp`/`.cpp`.
- Trocar o retorno de `setProperty` de `bool` pra `std::optional<std::string>` (`std::nullopt` = sucesso;
  string presente = mensagem de erro) — única mudança de assinatura necessária, sem precisar de struct
  nova. Dentro do laço que já acha o `PropertyDescriptor` certo, antes de chamar `descriptor.set(value)`:
  - `descriptor.schema.flags & PropertySchemaReadOnly` → rejeita sempre.
  - `valueKind` do schema não bate com o tipo de `PropertyValue` recebido → rejeita (`"tipo inválido"`).
  - `valueKind == Number` e `minValue`/`maxValue` presentes → rejeita fora da faixa.
  - `!schema.options.empty()` (enum) → valor (`string`) precisa casar com algum `options[].value`.
- Arquivo: `core/src/app/CoreApplication.cpp` (handler `"setProperty"`, linha ~500) — adapta pro novo
  retorno; `resp.error` recebe a mensagem; novo campo `resp.payloadJson` com
  `{"errorCode": "unknown_property"|"read_only"|"type_mismatch"|"out_of_range"|"invalid_option"}` quando
  `!ok` (ver A4).
- Teste: `core/test/core/CoreBootstrapTest.cpp`, novo `testSetPropertyValidationOverIpc` — usa o
  resistor built-in (`resistance`, `min: 0.01`, `valueKind: number`): edição válida ok; `"resistance":
  "abc"` (tipo errado) rejeitada; `"resistance": -5` (fora da faixa) rejeitada; nome inexistente
  rejeitada — cada uma checando `errorCode` certo.

**A2. Efeito real de `affectsTopology`**
- Arquivo: `core/src/session/SimulationSession.cpp` — em `setProperty`, depois de validar e ANTES de só
  `markDirty`: se `descriptor.schema.flags & PropertySchemaAffectsTopology`, marcar
  `m_topologyDirty = true` também (mesmo flag que `addComponent`/`connectWire`/`removeComponent` já
  usam) — força `rebuildTopologyIfNeeded()` no próximo `settleStep()`.
- Nenhum componente real declara essa flag hoje (não existe caso de uso natural nos built-ins atuais —
  `Tunnel.name` usa o caminho especial `setTunnelName`, não o genérico). Teste precisa de um
  `IComponentModel` só-de-teste com uma propriedade `affectsTopology`, instanciado direto via
  `ComponentRegistry::registerFactory` dentro do próprio arquivo de teste (sem expor nada novo em
  produção) — confirma que `rebuildTopologyIfNeeded` de fato roda de novo (ex: checando que a topologia
  resultante reflete uma mudança que só apareceria depois de um rebuild).
- Arquivo de teste: novo `core/test/core/PropertyTopologyEffectTest.cpp` (ou função dentro de
  `CoreBootstrapTest.cpp`, se preferir não criar executável novo no `CMakeLists.txt`).

**A3. `requiresRestart` — decisão de UX (Onda 1 escolhe a opção simples)**
- Decisão: **não** implementar reinício automático em produção nesta rodada (built-ins não têm um
  "reinit in-place" limpo; plugins teriam via `destroy`+`create`+`init`, mas isso é uma mudança de
  runtime maior, não uma validação). Em vez disso: `setProperty` aplica a mudança normalmente, e a
  resposta IPC ganha `{"requiresRestart": true}` quando a propriedade alterada tiver essa flag; a
  Extension mostra um aviso ("este componente precisa ser recriado pra aplicar") em vez de recriar
  sozinha. Reinício automático fica documentado como extensão futura do mesmo mecanismo, não decidido
  agora — evita comportamento implícito arriscado sem nenhum caso de uso real ainda.
- Arquivos: `CoreApplication.cpp` (resposta), `extension/src/ipc/CoreClient.ts::setProperty` (devolve
  `{requiresRestart}` em vez de `void`), `extension.ts::pushPropertyToCore` (mostra o aviso).

**A4. Contrato de erro estável no IPC**
- Arquivo: `extension/src/ipc/protocol.ts` — `ResponseEnvelope` ganha `errorCode?: string` opcional
  (sem quebrar nada que já lê só `error`/`ok`).
- Arquivo: `extension/src/ipc/CoreClient.ts` — `setProperty` passa a devolver
  `{ ok: true } | { ok: false; errorCode: string; message: string }` em vez de lançar genérico (ou
  lança um `PropertyValidationError` tipado com `.code` — escolher um padrão e aplicar igual nos dois
  lugares que já lançam erro de IPC pra manter consistência, ver `_dispatch` em `CoreClient.ts`).

**A5. Aposentar `listComponents()`/`ComponentDisplayMeta`**
- Remover de `extension/src/ipc/CoreClient.ts` (método `listComponents`) e `extension/src/ipc/types.ts`
  (interface `ComponentDisplayMeta`) — confirmado sem nenhum chamador no repositório inteiro.
  `getPropertySchemas` já cobre 100% da necessidade original (metadata por typeId).
- Atualizar `docs/mvp-limitacoes.md`: remover a entrada que documentava esse gap (deixa de existir, não
  fica mais pendente).

### Épico E — tarefas

**E1. Extrair `MockCoreServer` reutilizável**
- Novo arquivo: `extension/src/ipc/testSupport/MockCoreServer.ts` — move a classe que hoje vive dentro
  de `CoreClient.test.ts` (linhas iniciais do arquivo). `CoreClient.test.ts` passa a importar dali.
  Sem isso, qualquer teste novo que precise de um Core falso (A1-A4 acima são só Core real via
  `core_bootstrap_test`, mas testes futuros do lado Extension vão precisar do mesmo mock) reimplementaria
  a mesma classe.

**E2. Extrair lógica pura de `extension.ts`**
- Novo arquivo: `extension/src/catalog/catalogMerge.ts` — move `nextIndexedLabel`,
  `hasShowOnSymbolProperty`, `toWebviewPropertySchema` e a parte de `attachPropertySchemas` que só
  combina `WebviewComponentCatalogEntry[]` com `Record<typeId, PropertySchemaDto[]>` (sem o `coreClient`/
  `await` — recebe o mapa já resolvido). `extension.ts` importa e chama.
- Novo arquivo: `extension/src/language.ts` — extrai a lógica PURA de `currentLasecSimulLanguage` pra
  `resolveLasecSimulLanguage(configured: string, systemLanguage: string): "pt-BR" | "en"` (recebe as
  duas strings já lidas, sem chamar `vscode.*` dentro da função pura). `extension.ts` mantém um wrapper
  fino que só lê `vscode.workspace.getConfiguration(...)`/`vscode.env.language` e chama a função pura.

**E3. Testes novos cobrindo o que falta**
- `extension/src/catalog/catalogMerge.test.ts`: contador de índice por tipo com tipos intercalados (ex:
  Resistor, Capacitor, Resistor → "Resistor-1", "Capacitor-1", "Resistor-2"); default de `showValue`
  baseado em `showOnSymbol`; merge de schema por typeId — incluindo um caso com DUAS versões do mesmo
  mapa de schemas (uma "pt-BR", uma "en" simuladas) pra confirmar que o merge usa a que foi passada,
  cobrindo "i18n na folha de propriedades" do lado Extension (o fallback em si já é testado no Core via
  `testGetPropertySchemasOverIpc`; o que falta testar aqui é o ENCAIXE do resultado no catálogo).
- `extension/src/language.test.ts`: `resolveLasecSimulLanguage` — configuração explícita
  ("pt-BR"/"en") sempre vence; `"system"` cai pro idioto do VSCode (prefixo "pt"→pt-BR, resto→en) —
  cobre "i18n na paleta" do lado Extension (qual idioma é PEDIDO, não como o fallback é resolvido, que já
  é testado em `UnifiedCatalog.test.ts`/Core).
- Estender `test/project/ProjectSerializer.test.ts` (ou novo arquivo ao lado): round-trip de
  `ProjectComponent.label`/`showId`/`showValue` — regressão pro bug já corrigido nesta sessão (`label`
  não era persistido).

**E4. Extrair lógica pura de `main.ts` pra testabilidade sem DOM**
- Novo arquivo: `extension/src/ui/webview/wireGeometry.ts` — move `orthogonalSegmentPoints`,
  `buildOrthogonalPath`, `snapToWireGrid`, `samePoint` (funções puras, só `Point`→`Point[]`, sem DOM).
- Novo arquivo: `extension/src/ui/webview/valueFormatting.ts` — move `formatEngineeringValue`.
- Testes: `wireGeometry.test.ts` (segmento ortogonal reto vs. em L, snap pro grid), `valueFormatting.
  test.ts` (prefixos SI p/n/µ/m/—/k/M/G, valor zero, unidade vazia).
- **Decisão**: testar a Webview de ponta a ponta (DOM real ou `jsdom`) fica FORA da Onda 1 de propósito
  — exigiria escolher e configurar um toolchain de DOM novo (investimento de infra à parte, não pedido
  pela própria priorização do roadmap, que deixa refino de editor pra depois de Core/QEMU/subcircuitos).
  Maximizar extração de função pura (este item) cobre a lógica de maior risco (geometria de fio, zoom,
  formatação) sem essa dependência nova; revisitar `jsdom` só se um bug de interação specific justificar.

**E5. Atualizar scripts**
- `extension/package.json` (`"test"`): adicionar cada `.test.js` novo à cadeia (`&&` entre eles, mesmo
  padrão já usado).
- `extension/tsconfig.test.json`: nenhuma mudança necessária — já inclui `src/**/*.test.ts`.

### Ordem recomendada dentro da Onda 1

1. A1 (validação) → A4 (contrato de erro) — A4 depende do formato de erro que A1 introduz.
2. A2 (affectsTopology) e A3 (requiresRestart) podem rodar em paralelo com A1/A4 (não dependem um do
   outro), mas A2 precisa do mesmo `setProperty` já tocado por A1 — fazer na mesma leva evita conflito.
3. A5 (aposentar `listComponents`) é independente, pode ir em qualquer ordem — recomendo por último,
   só limpeza.
4. E1 (mock reutilizável) primeiro entre os itens de teste — E3 depende dele indiretamente (mesmo
   padrão de mock, mesmo se um teste específico não precisar de IPC).
5. E2 (extração) antes de E3 (testes) — não dá pra testar o que ainda não foi extraído.
6. E4 é independente do resto do Épico E, pode rodar em paralelo com A1-A5.

### Onda 2 - MCU/QEMU e barramentos

- Épico B
- Épico C
- parte operacional do Épico D

Resultado esperado (alcançado — ver Épico B/C):

- pipeline real de MCU (GPIO);
- decodificação bit a bit de protocolo via `LSDN_EVT_PIN_CHANGE`;
- base para RF04/RF05/RF08.

### Onda 3 - Robustez operacional de plugins

- restante do Épico D

Resultado esperado:

- trust, watchdog, `faulted`, recovery, snapshot.

### Onda 4 - Catálogo expansível sem ABI novo

- Épico G
- Épico F

Resultado esperado:

- editor de package;
- subcircuitos utilizáveis na prática.

### Onda 5 - Profundidade elétrica e UX avançada

- Épico H
- Épico I

Resultado esperado:

- não lineares reais;
- editor mais maduro;
- base de regressão mais forte.

## Plano de produção sugerido

### Sprint 1

- fechar validação de propriedade;
- implementar efeito de `affectsTopology`;
- decidir UX de `requiresRestart`;
- criar testes TS mínimos da Extension.

### Sprint 2

- concluir `QemuProcessManager`;
- concluir `QemuArenaBridge`;
- integrar `FirmwareWatcher`;
- executar teste blink.

### Sprint 3 (realizado com abordagem diferente da planejada — ver Épico C)

- decodificação bit a bit de protocolo via `LSDN_EVT_PIN_CHANGE`, não módulo de barramento genérico;
- adaptador ESP32 integrado ao caminho completo (GPIO; TWI/SPI/USART ainda pendentes);
- iniciar watchdog/fault policy de plugin.

### Sprint 4

- implementar loader de subcircuitos;
- implementar `exposedPins` + remoção em cascata;
- começar comando “Criar Subcircuito a partir da Seleção”.

### Sprint 5

- editor de package;
- integração total de subcircuito na paleta;
- round-trip JSON visual.

### Sprint 6+

- componentes não lineares;
- undo/redo;
- copy/paste;
- flip;
- labels livres;
- batch test.

## Dependências cruzadas

- Subcircuito depende de catálogo unificado estável e bom suporte de UI.
- MCU/QEMU depende de barramentos genéricos ou, no mínimo, de uma primeira fatia coerente deles.
- Watchdog/trust/recovery dependem de Core e Extension trabalhando juntos.
- Backlog de editor depende fortemente de testes da Extension para não virar regressão permanente.

## O que NÃO deve entrar antes da hora

- solver esparso antes de medir grupos grandes reais;
- shell alternativo antes de o protocolo e os formatos de arquivo estabilizarem mais;
- hot-reload de subcircuito em uso antes da primeira versão simples de subcircuito funcionar;
- refino pesado de UX antes de propriedades, QEMU e subcircuitos terem a base pronta.

## Primeira fila recomendada

Se o time for começar imediatamente, a ordem mais eficiente é:

1. Épico A
2. Épico E
3. Épico B
4. Épico C
5. Épico D
6. Épico G
7. Épico F
8. Épico H
9. Épico I

## Saída esperada deste roadmap

Ao final das três primeiras ondas, o projeto deve sair do estado "base arquitetural boa, mas com frentes
abertas" para "plataforma operacional reproduzível", com:

- Core mais normativo e seguro;
- Extension coberta por testes;
- QEMU funcional;
- plugins mais robustos em produção;
- caminho pronto para expandir catálogo via subcircuito e package editor.
