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
- subcircuito `subcircuits/esp32_devkitc_v4.lssubcircuit` carrega e expande contra o plugin real
  (`esp32_devkitc_subcircuit_test`, ctest) — ver seção "Placa DevKitC V4" abaixo.

## Placa DevKitC V4 (subcircuito real, port do SimulIDE)

`subcircuits/esp32_devkitc_v4.lssubcircuit` é uma placa completa (2026-06-28), pinout traduzido do
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
- Visual vem do `package` real do `.lssubcircuit` (`width`/`height`/`background`/`shapes[]`/`pins[]`),
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
inventado): adaptador ESP32 nu (`mcu-adapters/espressif-esp32/.lsdevice`, 48 pinos em 4 lados — 34
GPIO reais/wireáveis + 14 decorativos como `Vdd`/`Lna`/`XTALi`/`Rst`, mesmo padrão `type=nc` do
`esp32.package` original do SimulIDE), placa DevKitC V4 (seção acima) e módulo WROOM-32
(`subcircuits/esp32_wroom32.lssubcircuit` — mesmo princípio da DevKitC, pinout do `Wroom32.sim2` real:
38 pinos, sem pino `5V` — só `3v3` —, com `SVP`/`SVN` em vez de `VP`/`VN`, sem botão BOOT). Teste:
`componentSymbols.test.ts` (lógica de layout) e `esp32_devkitc_subcircuit_test` (os dois
subcircuitos, ctest).

**Correção 2026-06-29 — rótulos sobrepostos no topo do chip nu**: com 12 pinos em 170 unidades de
largura (chip ESP32 nu), o texto horizontal de cada rótulo colidia com o do vizinho (ex: "Ca1 Ca2 VddA1
XTALo..." virava um borrão ilegível). `packagePinLeadSvg` agora gira o `<text>` -90° (`transform="rotate
(-90 ...)"`) só quando o lead é vertical (`angle` 90 ou 270 — topo/base do corpo), passando a ler de
baixo pra cima alinhado ao lead, igual a qualquer diagrama de chip real — lead horizontal (esquerda/
direita) nunca girava, já tinha espaçamento vertical de sobra entre linhas e nunca teve esse problema.
Teste: `componentSymbols.test.ts`.

**Correção 2026-06-29 — terminal de fio fora da posição real do pino**: o chip ESP32 nu sintetizava
`component.pins[]` com ids genéricos (`pin-1`, `pin-2`...) que nunca batiam com os ids reais do
`package` (`GPIO23`, `deco_Ca1`...) — `pinLocalPosition` nunca achava o pino por `id`, caindo sempre no
algoritmo genérico (esquerda/direita por índice), então o PONTO DE CONEXÃO (onde o fio liga) ficava bem
longe da posição visual real do pino, mesmo com o desenho do chip certo. Causa raiz: `.lsdevice` só tinha
3 entradas placeholder em `pinMap` (devia ter as 42 reais — GPIO0-39 + UART0_RX/TX — que o plugin
(`Esp32Adapter.cpp::buildPinMap`) de fato expõe). Corrigido em duas pontas: `.lsdevice` ganhou o `pinMap`
completo (42 entradas, espelhando o C++ exatamente); a Extension ganhou
`WebviewComponentCatalogEntry.pinIds` (ids elétricos reais, na ordem que o Core espera) e tanto a
Webview (`makeComponentFromTypeId`) quanto o lado da Extension (`pinsForTypeId`) passaram a sintetizar
`component.pins[]` com esses ids reais — vale pra **qualquer** device/mcu-adapter/subcircuito registrado
com `package`, não só o ESP32. Resultado: 34 dos 38 pinos GPIO visíveis no chip nu agora têm terminal
exatamente na ponta do pino desenhado.

**Correção complementar, mesmo dia — bolinhas soltas/embaralhadas por cima do desenho**: os 8 pinos
elétricos que SOBRAM (GPIO20/24/28-31, sem lead físico no encapsulamento real, + UART0_RX/TX, alias
elétrico do GPIO3/GPIO1) ainda caíam no algoritmo genérico individualmente (`pinLocalPosition` por
índice GLOBAL entre os 42 pinos), aparecendo como terminais soltos espalhados por cima dos 34 já
corretos — pior visualmente que não desenhar nada, porque ficavam parecendo erros novos. Esses 8 não
têm NENHUMA posição real pra apontar (não existe ponto de solda aí no chip de verdade), então a
correção certa não é "achar uma posição melhor" — é não desenhar terminal nenhum pra eles.
`componentSymbols.ts` ganhou `hasRealPinPosition(typeId, pinId)`: falso só quando o typeId tem
`package` real e ESTE pino específico não está nele; `main.ts::renderComponent` pula o `<circle>` do
terminal (e a interação de clique) nesse caso — o pino continua em `component.pins[]` (contrato
posicional com o Core/`pinMap`, precisa dos 42 pra `McuComponent` casar certo), só não aparece nem é
clicável na Webview. Pra typeId sem `package` (built-ins), `hasRealPinPosition` é sempre `true` — o
algoritmo genérico de sempre não muda em nada. Teste: `componentSymbols.test.ts`.

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
(NOVO — pino do símbolo: `pinId`/`length` como propriedades, o ângulo do lead é o próprio
`component.rotation`, reaproveitando rotação genérica sem campo/código novo). Todos `pinCount: 0`,
nunca vão pro Core. Resize só por campo numérico (igual ao SimulIDE real).

**Rótulo de pino arrastável e independente (2026-06-29, mesmo dia)** — pedido explícito do usuário
depois de ver como o SimulIDE faz isso de verdade ("o user consegue movimentar sempre os textos de
tudo, dos pinos, do label do ci"): `other.package_pin` **não desenha mais o próprio texto** —
`componentsToAddForTypeId` (`main.ts`) sempre cria, junto com o pino, um `graphics.text` vinculado
(`linkedPinComponentId` == id ESTÁVEL do componente do pino, nunca o valor mutável da propriedade
`pinId` — sobrevive a renomear o pino depois). Esse texto é um componente comum, arrastável pra
QUALQUER lugar — inclusive pra dentro do corpo do `other.package`, exatamente como pedido. `PackagePin`
ganhou `labelX`/`labelY` opcionais (`model.ts`) — ausentes, o renderizador de leitura
(`packagePinLeadSvg`) continua calculando a posição padrão de sempre (ponta do lead + 9 unidades,
girada -90° se o lead for vertical); presentes, usa a posição exata que o usuário escolheu, sem girar
(ele já decidiu onde e como cabe). `seedSymbolAuthoringComponents`/`compileSymbolAuthoringComponents`
(`symbolAuthoring.ts`) fazem o caminho de ida e volta — abrir um `package` sem `labelX`/`labelY` semeia
o rótulo na posição padrão (visual idêntico a antes); arrastar e salvar grava a posição nova. Teste:
`symbolAuthoring.test.ts` (seed/compile com rótulo vinculado, round-trip de `labelX`/`labelY`),
`componentSymbols.test.ts` (renderizador de leitura respeita `labelX`/`labelY` quando presentes).

Conversão pura entre o `package` salvo em disco e essa lista de componentes vive em
`extension/src/catalog/symbolAuthoring.ts` (`seedSymbolAuthoringComponents`/
`compileSymbolAuthoringComponents`, testado em `symbolAuthoring.test.ts`) — sem perda pra
retângulo/elipse/texto/pino; `graphics.line` perde precisão de ângulo não-cardinal (vira o múltiplo de
90° mais próximo). Salvar relê o `.lsdevice`/`.lssubcircuit` do disco e substitui só a chave
`package` (`extension.ts::saveSymbolCommand`) — fundo `svg`/`image` já existente é preservado verbatim
se a sessão não definir `backgroundColor` (sem UI de upload de imagem nesta rodada — perder esse dado
ao salvar seria regressão, não limitação aceitável).

Três pontos de entrada: botão "✎" em cada item registrado na paleta (`palette.ts`); o comando
`lasecsimul.palette.editSymbol` (botão na barra de título da paleta) que abre um seletor de arquivo pra
editar qualquer manifesto, registrado ou não; e (2026-06-29, pedido explícito do usuário comparando com
o "Open Subcircuit" do menu de botão direito do SimulIDE) **"Editar Símbolo Visual" no menu de contexto
de uma instância já colocada no circuito** — mesmo `sourceId`, mesmo `editPackageSymbolCommand`, só
chamado a partir de `requestEditSymbol` (nova mensagem) em vez do clique na paleta.

**Como adicionar um pino na sessão de autoria, concretamente** (pergunta real do usuário): arraste
"Pino de Pacote" (`other.package_pin`) da paleta, pasta "Outros", pro lugar onde o terminal deve ficar
no desenho — posicionar é arrastar o componente normalmente, igual qualquer outro; orientar de qual
lado o lead sai é girar com os MESMOS atalhos de sempre (Ctrl+R/Ctrl+Shift+R/180°, sem atalho novo);
qual pino elétrico real ele representa é o campo "Id (pino real)" no painel de propriedades (duplo-
clique ou botão direito → Propriedades). O rótulo vem junto automaticamente (`graphics.text`
vinculado, ver seção do rótulo arrastável acima) e pode ser arrastado pra qualquer lugar, inclusive
dentro do corpo.

**Atualização 2026-07-07**: o comando "Criar Subcircuito a partir da Seleção" existe e gera
`connectors.tunnel` automaticamente para fios que cruzam a borda da seleção; ver
`.spec/lasecsimul-subcircuits.spec` seção 11 e `createSubcircuitFromSelectionHandler` em
`extension.ts`. Esta seção continua útil para o fluxo de autoria/edição de um manifesto que JÁ EXISTE
e para o escopo que segue fora dela. Ainda não existe upload de imagem de fundo (só cor sólida) nem
alça de arrastar pra
redimensionar formas (campo numérico, igual ao SimulIDE real). Validação manual no Extension
Development Host (F5) ainda pendente — sem `jsdom` neste repo, drag/rotação/painel de propriedades
foram verificados só por `tsc` limpo + testes da lógica pura de seed/compile, nunca clicados de
verdade num navegador; a superfície de risco é menor que a versão anterior porque a maior parte do
que seria testado manualmente (drag, seleção, propriedades, rotação) é código já em produção,
reaproveitado, não escrito do zero.

## "Abrir Subcircuito" — circuito interno real + Modo Placa + Logic Symbol — 2026-06-29 (mesmo dia)

Depois de fechar o editor de `package`, o usuário comparou com telas REAIS do SimulIDE (botão direito
→ "Open Subcircuit" abrindo outra view igual ao esquemático normal) e apontou que minha explicação do
conceito "Package" estava errada (eu tinha descrito como lista de N-variantes). Pesquisa real (fonte
em `C:\SourceCode\simulide_2\src` + https://simulidedocs.netlify.app + resposta de dev no fórum
oficial: *"A Package é apenas o invólucro, enquanto um Subcircuit é uma Package com um Circuito
dentro, como um IC"*) corrigiu isso e revelou o que realmente faltava — documentado em detalhe em
`.spec/lasecsimul-native-devices.spec` seção 21.4 e `.spec/lasecsimul-subcircuits.spec` seção 4:

- **Circuito interno real editável.** Pra `subcircuit-file` (nunca `abi-device`/`mcu-adapter` — não
  têm circuito interno, "Package ≠ Subcircuit"), a MESMA sessão de autoria agora também semeia
  `components[]`/`wires[]` reais do `.lssubcircuit` (`extension.ts::extractInternalCircuit` +
  `symbolAuthoring.ts::seedSubcircuitInternalComponents`) — igual ao SimulIDE real mostrar `Package`
  e circuito interno juntos na mesma cena. `.lssubcircuit` ganhou campos aditivos `components[].visual`/
  `boardVisual` e `wires[].points` — Core ignora o que não reconhece (confirmado, `ctest` 26/26 sem
  nenhuma mudança em `SubcircuitRegistry.hpp`). Sem `visual` salvo (caso dos 2 subcircuitos reais
  escritos à mão antes de hoje), cai num layout em grade simples na primeira abertura.
- **Modo Placa**, igual a `SubPackage::boardModeSlot()` do SimulIDE real
  (https://www.simulide.com/p/boards.html: *"hides all non-graphical components... allowing to place
  them in the position that will be shown"*): botão na barra da sessão; cada componente interno tem 2
  posições independentes (`x/y/rotation` do circuito, `boardX/boardY/boardRotation` da placa,
  `model.ts::WebviewComponentModel`) — ligar o modo esconde quem não tem `graphical: true` no
  catálogo (29 typeIds marcados: LEDs, motores, displays, switches, sonda — mesma lista de categorias
  "de interação do usuário" do SimulIDE real) e deixa arrastar os visíveis pra uma posição de placa
  separada, sem afetar a posição no circuito.
- **"Logic Symbol"** — depois de eu explicar errado (lista de N-variantes), a auditoria mostrou que é
  um BOOLEANO simples (`SubPackage::Logic_Symbol`, "Chip or Logic Symbol" no diálogo real de
  propriedades). `logicSymbolPackage` (irmã de `package` no manifesto) é a aparência alternativa
  opcional — `mcu-adapter`/`subcircuit-file` apenas, nunca `abi-device`. Botão "Ver: Físico/Símbolo
  Lógico" na barra troca qual chave está sendo editada — trocar de vista descarta sem confirmar
  mudanças não salvas na vista que está saindo (decisão de simplificação: sem `window.confirm()`, que
  nem sempre funciona dentro de uma Webview do VSCode), mas preserva o circuito interno como está.

Teste: `symbolAuthoring.test.ts` (seed/compile do circuito interno, `visual`/`boardVisual`
independentes, ignora componentes de autoria de símbolo), `componentSymbols.test.ts` (resolução por
`properties.logicSymbol`). **O que isto NÃO inclui**: simulação elétrica ao vivo dentro da sessão (só
posição/propriedades, sem IPC com o Core); `BoardSubc`/`ShieldSubc` (Arduino Uno + Shield empilhado do
SimulIDE real, feature à parte, não pedida). "Criar Subcircuito a partir da Seleção" foi implementado
depois deste desenho inicial; ver nota acima e `.spec/lasecsimul-subcircuits.spec` seção 11.
