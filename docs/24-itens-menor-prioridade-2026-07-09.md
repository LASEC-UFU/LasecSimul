# 24 — Itens de menor prioridade da auditoria "pente fino" (2026-07-09)

> Continuação de `docs/23-auditoria-pente-fino-2026-07-08.md` — pedido explícito do usuário: "agora
> faça os itens de menor prioridade que ficaram de fora". Lista-fonte: seção 6 de `docs/23` (itens
> do SimulIDE ainda ausentes) + o levantamento de paridade de UI do dia anterior (menu de contexto,
> zoom, unit-multiplier, MRU, drag-to-duplicate, show-on-symbol, taxa de simulação, probe
> pause-on-change, importar circuito, painel de ajuda, gate de entradas variáveis, dial interativo).

## Resumo

**Atualização final (2026-07-09, rodada "sem helper interno")**: os 2 itens que estavam
conscientemente deferidos foram reabertos por decisão explícita do usuário e fechados:

- **Gate lógico com contagem de entradas variável (2-8)**: `logic.and_gate` e `logic.or_gate`
  agora usam `inputs` como propriedade declarativa, `pinSpec.dynamicGroups` para `in1..inN`,
  `package.dynamicLayout` para altura/pinos e `viewSpec.paint[].statePath` para trocar a geometria
  do path sem helper por `typeId`. A lógica nativa do plugin lê N entradas reais no DLL. `xor_gate`
  e `buffer` permanecem fixos porque, no SimulIDE 2 de referência, a propriedade de número de
  entradas é exposta em AND/OR, não em XOR/Buffer.
- **`Dialed`/QDial para R/L/C variável e osciloscópio**: o renderer ganhou suporte genérico a
  `viewSpec.overlayPaint`, `ViewSpecProjection.rotate` com `propRange/angleRange` e
  `dragAngular.continuous` com `limits`; `passive.variable_resistor`, `passive.variable_capacitor`
  e `passive.variable_inductor` usam `simulidePaint` para o corpo C++ e overlay declarativo para o
  dial. A popup do osciloscópio deixou de ter disco meramente decorativo e passou a aceitar
  wheel/drag com os deltas relativos do `oscwidget.cpp` real (`timeDiv/100`, `voltDiv/100`, etc.).

11 dos 13 itens implementados, testados e verificados (Core: 32/32 `ctest` Debug+Release; Extension:
15/15 arquivos de teste, 165+ asserções, 3 `tsc` limpos). 2 itens conscientemente deferidos com
justificativa técnica (seção "Itens deferidos" abaixo) — ambos exigiriam trabalho de layout visual
dinâmico não verificável sem GUI interativa (mesma categoria de risco já documentada em sessões
anteriores) ou uma nova classe de interação (edição de valor durante simulação rodando) fora do
padrão "correção pontual" desta rodada.

**Achado de brinde durante os testes**: `meters.probe` tinha o MESMO bug de classe já corrigido antes
pra `SimulidePassiveState` — o construtor/factory só lia `threshold` de `ComponentParams`, ignorando
`showVolt`/a nova `pauseOnChange` se viessem de um projeto salvo (`.lsproj`) na CRIAÇÃO da instância.
Corrigido junto (`CoreApplication.cpp` + `Probe.hpp`).

## 1. Bolha visual de inversão (NAND/NOR/NOT/XNOR)

A correção elétrica de `inverted` (rodada anterior) não tinha contrapartida visual — o símbolo de um
AND com `inverted=true` continuava idêntico a um AND normal. Adicionado um círculo pequeno
(`partId: "invertBubble"`) ao `package.viewSpec.paint` dos 4 `.lsdevice`
(`and_gate`/`or_gate`/`xor_gate`/`buffer`), com `stateProjection: { invertBubble: [{kind: "visible",
prop: "inverted"}] }` — mecanismo `ViewSpecProjection` já existente (`model.ts`), só nunca usado pra
esse propósito. Posição derivada da geometria real dos 4 `.lsdevice` (corpo termina em x≈24-25, pino
de saída em x=24→32). Teste novo em `componentSymbols.test.ts` (48 testes no arquivo, 0 falhas).

## 2. Seletor de múltiplo de unidade (pF/nF/µF, Ω/kΩ/MΩ...)

Campo numérico com `unit` no schema agora mostra um `<select>` de prefixo SI (reaproveita
`SI_PREFIXES`, já existente em `valueFormatting.ts` pra formatação read-only, agora também exportado
e usado pra escolher o multiplicador inicial via novo `defaultSiPrefixFactor`). Valor ARMAZENADO
sempre em unidade base — só a exibição escala; trocar o multiplicador RE-ESCALA o número mostrado
mantendo o valor absoluto (mesmo comportamento do `NumVal` real do SimulIDE), não multiplica.
6 testes novos em `valueFormatting.test.ts` (19 no arquivo, 0 falhas).

## 3. Exportar Esquemático como Imagem (SVG)

Novo botão na toolbar + item no menu de contexto do canvas vazio. A Webview clona o `canvas-content`
REAL (já visualmente correto — reaproveita posição/rotação/flip/símbolo tal qual renderizados, evita
reconstruir do zero e arriscar uma divergência sutil não verificável sem GUI) dentro de um
`<foreignObject>`, com o CSS da própria página embutido inline (`document.styleSheets`, já que o
arquivo exportado é aberto fora deste contexto). A Extension só mostra o diálogo nativo de salvar e
grava o arquivo (`exportSchematicImageCommand`, mesma divisão de responsabilidade de
`saveProjectCommand` — Webview nunca tem `fs`). **Só SVG** — rasterizar pra PNG/JPEG/BMP dentro da
Webview arriscaria "tainted canvas" com um `<foreignObject>`, não implementado (limitação
documentada, não bug).

## 4. Lista de arquivos recentes (MRU)

`ExtensionContext.globalState` (mesmo padrão de `TrustStore.ts`), até 10 caminhos, filtrados contra o
disco na leitura (entrada morta nunca aparece). Comando `lasecsimul.openRecentProject` (Command
Palette, QuickPick nativo) + hook de gravação em `saveProjectCommand`/`openProjectCommand`.

## 5. Arrastar-para-duplicar (`Ctrl+Shift`-drag)

Mesmo gesto do SimulIDE real. Achado de arquitetura durante a implementação: o `render()` completo
NÃO pode ser chamado no meio de um arrasto em andamento — reparentear o elemento sendo arrastado
(que já tem `setPointerCapture` ativo) libera a captura implicitamente (mesmo bug documentado
2026-06-30 sobre `componentElementsById`/telemetria). Corrigido inserindo os componentes/fios
duplicados diretamente no DOM/estado (`createComponentElement` + `componentElementsById.set` +
`canvasContentElement.appendChild`), sem tocar o elemento original em arrasto.

## 6. "Show value on symbol" selecionável por propriedade

Antes, só a ÚNICA propriedade marcada `showOnSymbol` no catálogo podia aparecer no rótulo de valor
(fixo por typeId). Novo campo `component.valueLabelPropertyKey` (instância, não catálogo) + rádio
"mostrar no símbolo" ao lado de cada campo numérico, só exibido quando o typeId tem MAIS de 1
candidato numérico (com 1 só, a pergunta "qual" não existe). Persistência completa: `WebviewComponentModel`
→ `ProjectComponent` → `ProjectSerializer` (validação) → round-trip de save/load, não só a sessão
corrente.

## 7. Indicador de taxa de simulação na toolbar

Novo verbo IPC `getSimulationTime` (`Scheduler::nowNs()` já existia, só faltava expor) — a Extension
amostra `(tempo simulado, tempo de parede)` a cada ~300ms (reaproveita o timer de polling já
existente de tensão/leitura de instrumento) e calcula `Δsimulado/Δparede` como percentual, mostrado
ao lado do rótulo Rodando/Pausado/Parado. Atualização pontual do texto (sem `render()` completo a
cada 300ms).

## 8. Importar Circuito

Comando novo (`lasecsimul.importProject` + item no menu de contexto) que MESCLA outro `.lsproj` no
esquemático ABERTO (diferente de "Abrir Projeto", que substitui) — paridade com
`Circuit::importCircuit()` real do SimulIDE. IDs de componente/fio remapeados (mesma técnica de
colar), posições NÃO deslocadas (um circuito importado já tem layout próprio coerente).

## 9. Probe: "Pause at state change"

`meters.probe` ganhou a propriedade `pauseOnChange` — quando ativa, chama `Scheduler::pause()`
(referência já recebida no construtor, mesmo padrão de `Oscope`/`WaveGen`) na primeira mudança de
estado digital (cruzar `threshold`) depois de ativado. `Scheduler::isPaused()` novo (getter puro,
antes só existia o `pause()`/`resume()` sem leitura). 3 asserções num teste novo dedicado
(`probe_pause_on_change_test.cpp`), incluindo o achado-de-brinde da seção "Resumo" acima.

## 10. Painel de ajuda inline expansível

O botão "Ajuda" agora alterna um painel inline (em vez de só abrir URL externa direto — achado de
brinde: com só `help.description` e sem `help.url`, o botão ficava HABILITADO mas sem handler nenhum,
morto ao clicar). Mostra `help.description` como texto simples (`textContent`, seguro) + um link pra
`help.url` se presente. `help.file` (Markdown local) continua reservado mas não consumido — exigiria
I/O de arquivo (Webview não tem `fs`) e um parser Markdown→HTML sanitizado contra XSS, feature maior
e mais arriscada, deixada de fora desta rodada (mesmo raciocínio da seção seguinte).

## Itens deferidos (histórico; fechados em 2026-07-09)

> O texto abaixo é o registro da decisão anterior. Ele não representa mais o estado atual do código:
> os dois itens foram implementados na rodada final descrita no Resumo acima.

- **Gate lógico com contagem de entradas variável (2-8)** — a correção elétrica desta auditoria
  (`inverted`, NAND/NOR/NOT/XNOR) já era o item de maior prioridade desta categoria e foi entregue na
  rodada anterior. Contagem variável exigiria: (a) reordenar os pinos do plugin (`out` primeiro,
  entradas dinâmicas depois — a estrutura atual de `ComponentPinSpec`/`resolveDynamicPins` sempre põe
  pinos fixos ANTES dos dinâmicos, então `out` não pode ficar por último sem essa reordenação); (b)
  reescrever `stamp_gate()` em `lib.c` pra ler N entradas em vez de 2 fixas; (c) um `dynamicLayout`
  visual novo posicionando de 2 a 8 pinos de entrada — a MESMA classe de trabalho que exigiu leitura
  cuidadosa do C++ real do SimulIDE e verificação pixel a pixel nas rodadas anteriores (led_matrix/
  led_bar/analog_mux), sem GUI disponível pra confirmar visualmente o resultado. Risco de produzir um
  símbolo com pinos mal posicionados sem conseguir verificar supera o ganho desta melhoria específica
  (a correção elétrica, o item de maior valor, já está entregue).
- **Dial interativo em tempo real (`Dialed`) pra resistor/capacitor/indutor variável** — o MECANISMO
  de interação (arrastar → atualizar propriedade → `setProperty` no Core → re-estampar) já existe e
  está provado (`passive.potentiometer`, joystick, encoder). O que falta é uma NOVA classe de recurso,
  não uma correção: um gesto de arrasto dedicado + geometria de símbolo (knob/dial) pra 3 typeIds,
  incluindo decidir a curva de mapeamento ângulo→valor (linear vs logarítmica, o SimulIDE real usa
  faixas bem diferentes pra R/L/C) — decisão de produto melhor tomada com o usuário testando
  interativamente do que suposta sem GUI. Ver `.spec/lasecsimul.spec` §7.5 (achado documentado desde
  a rodada anterior) pra referência futura.

## Verificação

- `node scripts/build-core.js --config=Debug` e `--config=Release`: ambos limpos.
- `ctest -C Debug` e `-C Release`: **32/32** testes passando nos dois (2 novos:
  `probe_pause_on_change`; `logic_gate_plugin` já existia da rodada anterior).
- `npx tsc` nos 3 tsconfigs da Extension (host/webview/test): todos limpos.
- `npm test` (Extension): **15/15** arquivos, 0 falhas (contagens individuais sobem em
  `valueFormatting.test.ts` 13→19 e `componentSymbols.test.ts` 47→48 pelos testes novos).
- `package.json`/`component-catalog.json`: JSON válido.
