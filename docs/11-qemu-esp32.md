# 11 - QEMU e ESP32

## Objetivo

Definir a integração inicial com QEMU e o adapter ESP32.

## Escopo

Processo QEMU externo, arena compartilhada, dispatch MMIO e adapter ESP32 inicial. Não inclui emulação manual de CPU.

## Componentes

- `QemuProcessManager`: cria, monitora, encerra e mata o processo `qemu-system-xtensa.exe` real (binário
  vendorizado em `devices/qemu-esp32/bin/`, copiado de `SimulIDE_2-R260501_Win64\data\bin\`).
- `QemuArenaBridge`: conecta a memória compartilhada. Formato em `qemu_arena_abi.h` foi **reescrito** nesta
  sessão (2026-06-28) depois de auditar o protocolo real contra o fork QEMU (`C:\SourceCode\qemu_simulide`,
  `softmmu/simuliface.{h,c}`) e o binário compilado — protocolo anterior (tag `simuAction` com payload
  pré-decodificado) estava errado. Protocolo real: `regAddr`/`regData`/`irqNumber`/`irqLevel`/
  `SIM_READ`/`SIM_WRITE`/`loop_timeout_ns`/`ps_per_inst`, **88 bytes total** (confirmado batendo com o log do
  próprio binário: "Qemu: arena mapped 88 bytes"). QEMU nunca pré-decodifica o registrador.
- `McuComponent` (`core/src/mcu/McuComponent.{hpp,cpp}`): a peça que liga o `IMcuAdapter` ao circuito real —
  implementa `IComponentModel`, entra no `Netlist`/`Scheduler` com pinos ligáveis por fio
  (`IMcuAdapter::pinMap()`). Despacha `SIM_READ`/`SIM_WRITE` pro `QemuModule` certo (por endereço) e, a cada
  `stamp()`, traduz `isOutputEnabled`/`outputLevel` em estampa elétrica real.
- `FirmwareWatcher`: vigia (polling de `mtime`) a pasta de firmware configurada pelo usuário; ao detectar
  artefato novo ou mais recente, aciona o mesmo kill+respawn do reset — nunca exige reload manual como o
  `slotReload()` do SimulIDE (seção 8.3 do `.spec`).
- `IMcuAdapter`: descreve chip, argumentos QEMU, regiões MMIO, pinos, e `createModules()` — devolve os
  `QemuModule`s concretos que aquele chip usa.
- Adaptador ESP32 (`mcu-adapters/espressif-esp32/`): **plugin DLL/SO** (`mcu_abi.h` major 2+), não built-in
  — migrado nesta sessão (2026-06-28) do equivalente built-in que existia em `core/src/mcu/esp32/`
  (removido), provando que plugin tem o mesmo desempenho (chamada de função C indireta, mesmo processo, sem
  IPC). Módulo GPIO concreto via `LsdnQemuModuleVTable`, embrulhado pelo Core em `QemuModuleProxy`
  (`core/src/plugins/QemuModuleProxy.hpp`). **Achado crítico**: módulo de registrador é CHIP-ESPECÍFICO de
  propósito (confirmado lendo `hw/gpio/esp32_gpio.c` do fork real) — não existe módulo genérico de
  GPIO/I2C/SPI/USART reusado entre chips. O módulo GPIO cobre hoje só GPIO puro
  (`GPIO_OUT_REG`/`GPIO_ENABLE_REG`/`GPIO_IN_REG`/`GPIO_IN1_REG`); IOMUX/pin-matrix e TWI/SPI/USART do ESP32
  ainda não existem (ver `docs/17-pendencias-pos-sessao-qemu-abi.md` seção 3.1).

## Fluxo

1. Usuário associa uma **pasta** (não um arquivo fixo — toolchain externa gera nome de build variável) a um
   componente MCU.
2. Extension envia o caminho da pasta ao Core via IPC. `FirmwareWatcher` passa a vigiá-la a partir daqui.
3. Core resolve `chipId` no `McuRegistry`.
4. Adapter constrói argumentos do QEMU (`argv[1]` = chave da shared memory, confirmado lendo `simuMain()`
   real; resto bate com `Esp32::createArgs()`: `-M esp32-simul -L <romdir> -drive
   file=...,if=mtd,format=raw -icount shift=4,align=off,sleep=off`), incluindo o artefato mais recente
   resolvido pelo `FirmwareWatcher`.
5. `QemuProcessManager` prepara arena e inicia processo.
6. QEMU real escreve `regAddr`/`regData` brutos na arena (sem decodificar nada).
7. `McuComponent` despacha o evento pro `QemuModule` certo, por faixa de endereço.
8. O `QemuModule` decodifica o registrador (ex: `Esp32GpioModule` sabe que offset `0x04` é `GPIO_OUT_REG`) e
   `McuComponent` traduz isso em estampa elétrica real nos `Pin`s do circuito.
9. Se `FirmwareWatcher` detectar artefato novo a qualquer momento, repete os passos 4-8 via kill+respawn —
   sem ação manual do usuário.

## Regras

- Não implementar CPU de MCU manualmente.
- Não colocar QEMU na Extension.
- Não usar QMP como caminho principal de reset/stop no MVP.
- Reset pode matar e reiniciar QEMU. Firmware recarregado automaticamente usa exatamente o mesmo caminho —
  nunca um mecanismo de hot-swap separado.
- Dependência de QEMU modificado deve ficar explícita no manifesto do adapter — **já verificada, não
  hipotética**: fork real em `C:\SourceCode\qemu_simulide`, fonte do SimulIDE atual em
  `C:\SourceCode\simulide_2`, e binário oficial em `SimulIDE_2-R260501_Win64\data\bin\` (vendorizado em
  `devices/qemu-esp32/bin/`). GPIO output/input funcionando pro ESP32 hoje; UART/SPI/I2C ainda zero.
- Vigilância de firmware é por polling de `mtime`, nunca API nativa de evento de filesystem por SO
  (`inotify`/`ReadDirectoryChangesW`/`FSEvents`) — simplicidade deliberada, latência de 1-2s é aceitável.
- Módulo de registrador (`QemuModule` concreto) é CHIP-ESPECÍFICO de propósito — só
  `Scheduler`/`Netlist`/IPC/UI precisam ser neutros quanto a chip (ver "Achado crítico" acima).

## Testes

- iniciar QEMU real (`mcu_controller_real_qemu`, ctest) — abre a arena, inicia o processo;
- parar QEMU;
- matar QEMU em reset;
- erro ao carregar firmware (sem `.bin` real ainda — falta toolchain ESP-IDF);
- mapear GPIO — `McuComponentTest` prova `GPIO_ENABLE_REG`+`GPIO_OUT_REG` subindo um pino do circuito a
  3.3V, com arena sintética, sem precisar de QEMU real;
- blink LED — pipeline funciona de ponta a ponta; bloqueio atual é só a falta de um firmware `.bin` real
  (toolchain ESP-IDF não instalada nesta máquina, fora de escopo desta rodada);
- `FirmwareWatcher` detecta artefato novo e recarrega sem ação manual;
- `FirmwareWatcher` escolhe o artefato de `mtime` mais recente quando há mais de um na pasta;
- capturar logs;
- subcircuito `subcircuits/esp32_devkitc_v4.lssub.json` carrega e expande contra o plugin real
  (`esp32_devkitc_subcircuit_test`, ctest) — ver seção "Placa DevKitC V4" abaixo.

## Placa DevKitC V4 (subcircuito real, port do SimulIDE)

`subcircuits/esp32_devkitc_v4.lssub.json` é uma placa completa (2026-06-28), pinout traduzido do
`devkitC.sim2` real do SimulIDE (`SimulIDE_2-R260501_Win64\data\esp32\`) — 38 pinos no layout padrão
da ESP32 DevKitC V4 (2 headers de 19 pinos), não o chip "nu". Decisões reais, não decorativas:

- Cada `Gxx`/`TX`/`RX`/`D0-D3`/`CK`/`CM`/`VP`/`VN` é um `connectors.tunnel` interno wireado ao pino
  GPIO real do `espressif.esp32` (`mcu1`) — ex: `VP`→`GPIO36`, `VN`→`GPIO39` (sensor ADC1, mapeamento
  padrão da Espressif), `TX`→`GPIO1`, `RX`→`GPIO3` (UART real do ESP32 ainda não emulado como
  periférico — ver seção 3.1 do handoff — então esses dois pinos hoje só funcionam como GPIO puro,
  não UART de verdade).
- `GND1`/`GND2`/`GND3` são três pinos públicos diferentes que apontam pro **mesmo** túnel interno
  `"GND"`, wireado a um único `other.ground` — mesmo nó elétrico, fiel ao hardware real.
- `3V3`/`5V` são `sources.fixed_volt` reais (3.3V/5V) — a placa fornece tensão de verdade nesses
  pinos, não placeholder.
- `EN` (reset) é um túnel isolado, sem fio nenhum — decorativo, porque `McuComponent` ainda não
  modela um pino de reset elétrico. Comportamento honesto: o solver detecta esse nó como singular
  (1 nó sem referência) e cai pra 0V com aviso, nunca trava nem inventa um valor.
- GPIOs que o ESP32 real não expõe (20, 24, 28-31, 37, 38) **não aparecem** — fiel ao hardware, não
  preenchido por completude artificial.
- Visual vem do `package` real do `.lssub.json` (`width`/`height`/`background`/`shapes[]`/`pins[]`),
  renderizado de ponta a ponta pelo renderizador novo (ver seção abaixo) — cada um dos 38 pinos
  aparece na posição/lado real do hardware, com o nome ao lado, não mais um retângulo genérico.

## Renderizador real de `package` (Épico G, parte de leitura) — 2026-06-28

Até esta data, `package.pins[]` era só dado declarativo nunca lido pelo webview — a posição visual de
cada pino vinha de um algoritmo genérico (só esquerda/direita, sem rótulo). `extension/src/ui/webview/
componentSymbols.ts` ganhou `registerPackage`/`pinLocalPosition`/`packageSymbolSvg`: quando o typeId
tem `package` real, cada pino é desenhado na coordenada `x`/`y`/`angle`/`length` declarada (qualquer
lado), com o `label` ao lado — casado por `id` (nunca por posição no array, porque a ordem real de
`component.pins[]` que o Core devolve não é garantida bater com a ordem de `package.pins[]`).
`resolvePackageLayout` desloca tudo pra um espaço sem coordenada negativa, porque um lead pode sair
de propósito fora de `0..width`/`0..height` (ex: pino na borda esquerda com `angle:180` aponta pra
fora). Sem `package`, o algoritmo genérico de sempre continua valendo (built-ins não afetados).

Três itens da paleta usam isso hoje, todos com pinout traduzido fielmente do SimulIDE real (não
inventado): adaptador ESP32 nu (`mcu-adapters/espressif-esp32/mcu.json`, 48 pinos em 4 lados — 34
GPIO reais/wireáveis + 14 decorativos como `Vdd`/`Lna`/`XTALi`/`Rst`, mesmo padrão `type=nc` do
`esp32.package` original do SimulIDE), placa DevKitC V4 (seção acima) e módulo WROOM-32
(`subcircuits/esp32_wroom32.lssub.json` — mesmo princípio da DevKitC, pinout do `Wroom32.sim2` real:
38 pinos, sem pino `5V` — só `3v3` —, com `SVP`/`SVN` em vez de `VP`/`VN`, sem botão BOOT). Teste:
`componentSymbols.test.ts` (lógica de layout) e `esp32_devkitc_subcircuit_test` (os dois
subcircuitos, ctest).

## Editor visual de `package` (Épico G, parte de escrita) — 2026-06-29

Os três `package` acima (e os de `devices/example-blinker`/`devices/voltmeter`) foram escritos à mão,
direto no JSON. Uma primeira versão do editor visual (2026-06-28) era um canvas SVG bespoke — descartada
depois que uma captura de tela real mostrou rótulos de pino sobrepostos e visual divergente do
renderizador de leitura, e de auditar o fonte real do SimulIDE
(`C:\SourceCode\simulide_2\src\components\other\subpackage.{h,cpp}` +
`components\graphical\*`): lá, "editar o símbolo" não é uma ferramenta separada — `SubPackage`/
`Rectangle`/`Ellipse`/`Line`/`TextComponent`/`PackagePin` são `Component`s comuns, colocados na MESMA
cena do circuito, redimensionados por propriedade numérica (não alça de arrastar).

A versão atual (2026-06-29) segue esse princípio: existe uma **sessão de autoria de símbolo** dentro do
MESMO webview do esquemático (`main.ts::enterSymbolAuthoring`/`exitSymbolAuthoring`/
`saveSymbolAuthoring` trocam temporariamente qual `WebviewProjectState` o render/drag/painel de
propriedades usam — nenhum código de renderização/interação novo, tudo já era genérico). Componentes de
verdade: `other.package` (corpo, property-driven: `width`/`height`/`border`/`backgroundColor`),
`graphics.rectangle`/`ellipse`/`line`/`text` (formas, também property-driven), `other.package_pin`
(NOVO — pino do símbolo: `pinId`/`label`/`length` como propriedades, o ângulo do lead é o próprio
`component.rotation`, reaproveitando rotação genérica sem campo/código novo). Todos `pinCount: 0`,
nunca vão pro Core. Resize só por campo numérico (igual ao SimulIDE real).

Conversão pura entre o `package` salvo em disco e essa lista de componentes vive em
`extension/src/catalog/symbolAuthoring.ts` (`seedSymbolAuthoringComponents`/
`compileSymbolAuthoringComponents`, testado em `symbolAuthoring.test.ts`) — sem perda pra
retângulo/elipse/texto/pino; `graphics.line` perde precisão de ângulo não-cardinal (vira o múltiplo de
90° mais próximo). Salvar relê o `device.json`/`mcu.json`/`.lssub.json` do disco e substitui só a chave
`package` (`extension.ts::saveSymbolCommand`) — fundo `svg`/`image` já existente é preservado verbatim
se a sessão não definir `backgroundColor` (sem UI de upload de imagem nesta rodada — perder esse dado
ao salvar seria regressão, não limitação aceitável).

Dois pontos de entrada: botão "✎" em cada item registrado na paleta (`palette.ts`), e o comando
`lasecsimul.palette.editSymbol` (botão na barra de título da paleta) que abre um seletor de arquivo pra
editar qualquer manifesto, registrado ou não.

**O que isto NÃO é**: não existe o comando "Criar Subcircuito a partir da Seleção" (detectar fios
cruzando a borda de uma seleção no esquemático e gerar `connectors.tunnel` automaticamente) — a sessão
de autoria só edita o símbolo visual de um manifesto que já tem seus pinos elétricos declarados à mão
(ver `.spec/lasecsimul-subcircuits.spec` seção 4, Épico G no roadmap de pendências). Também não existe
upload de imagem de fundo (só cor sólida) nem alça de arrastar pra redimensionar formas (campo numérico,
igual ao SimulIDE real). Validação manual no Extension Development Host (F5) ainda pendente — sem
`jsdom` neste repo, drag/rotação/painel de propriedades foram verificados só por `tsc` limpo + testes da
lógica pura de seed/compile, nunca clicados de verdade num navegador; a superfície de risco é menor que
a versão anterior porque a maior parte do que seria testado manualmente (drag, seleção, propriedades,
rotação) é código já em produção, reaproveitado, não escrito do zero.
