# 23 — Auditoria "pente fino" completa (2026-07-08)

> Pedido do usuário: auditoria completa do projeto inteiro (código, arquitetura, interface,
> documentação, testes, funcionalidades), com autorização prévia para implementar todas as
> correções encontradas sem pedir confirmação, comparando continuamente com o SimulIDE real.
> Executada em fases: (1) levantamento paralelo com 4 agentes de pesquisa cobrindo paridade de
> dispositivos, dead code/arquitetura, paridade de UI, e consistência de docs/testes; (2) correções
> em lotes verificados por build+teste, priorizando bugs de comportamento incorreto antes de
> funcionalidades novas; (3) segunda passagem de revisão; (4) este relatório.

## Resumo executivo

O achado mais grave: **11 componentes built-in do catálogo eram eletricamente inertes** —
existiam na paleta, tinham símbolo visual e propriedades editáveis, mas seu `stamp()` era um no-op
puro (`SimulidePassiveState`), então nunca produziam corrente ou tensão real numa simulação. Para um
simulador de circuitos, isso é o bug de correção mais grave possível (o oposto de "impreciso": era
"não faz nada"). Todos os 11 foram corrigidos com física real, seguida de uma investigação que
descobriu e corrigiu um problema de arquitetura mais profundo (grupos topológicos ficando singulares
por causa de sub-redes parcialmente fiadas) que afetava — e continuaria afetando — qualquer
componente multi-pino futuro com a mesma forma.

Além disso: um bug de duplicação sério (sensores resistivos falsos escondendo os reais), um gap de
paridade fundamental com o SimulIDE (NAND/NOR/NOT/XNOR inconstruíveis), um risco real de perda de
dados (sem indicação de alterações não salvas), e uma dúzia de itens menores de código morto,
tratamento de erro ausente e documentação desatualizada.

**Validação**: 31/31 testes do Core (`ctest`, Debug e Release) e 15/15 arquivos de teste da Extension
(165 asserções individuais) passam limpos após todas as mudanças — nenhuma regressão introduzida.

---

## 1. Correções de comportamento incorreto (bugs)

### 1.1 — 11 componentes eletricamente inertes (CRÍTICO)

| typeId | Causa raiz | Classe nova |
|---|---|---|
| `active.opamp` | `stamp()` no-op | `components::OpAmp` — nullor simplificado, ganho configurável |
| `active.comparator` | idem | mesma classe, ganho fixo mais alto |
| `active.analog_mux` | idem | `components::AnalogMux` — chaveamento resistivo real por canal |
| `outputs.led_rgb` | idem | `components::DiodeLegArray` — 3 pernas de diodo (R/G/B → catodo comum) |
| `outputs.led_bar` | idem | mesma classe — pares P/N independentes |
| `outputs.led_matrix` | idem | mesma classe — `rows×columns` pernas (uma por interseção) |
| `outputs.seven_segment` | idem | mesma classe — 8 pernas + 2 pinos comuns unidos internamente |
| `outputs.dc_motor` | idem | `components::Resistor` direto (carga resistiva real) |
| `outputs.incandescent_lamp` | idem | idem |
| `outputs.stepper` | idem | `components::ResistorArray` — 2 bobinas independentes |
| `switches.keypad` | idem | `components::Keypad` — matriz linha×coluna real, com/sem diodo anti-ghosting |

Todos reaproveitam a mesma física já validada de `active.diode` (Shockley com amortecimento de
Newton) ou de `passive.resistor` — sem inventar modelos novos. Simplificações deliberadas e
documentadas nos comentários de cada classe: sem modelo de torque/rotação/back-EMF para motores, sem
clamping de trilho de alimentação para o opamp, sem clique interativo do mouse para o keypad
(substituído por uma propriedade `pressedMask`, bitmask de teclas pressionadas).

**Achado de arquitetura descoberto durante os testes** (não é um bug pré-existente do `Netlist`, é
uma característica que qualquer componente multi-pino precisa respeitar): `Netlist::rebuildTopology`
funde todos os pinos do MESMO componente no MESMO grupo topológico, sempre — mesmo sem fio nenhum
entre eles. Um componente com sub-redes eletricamente independentes (pares de `ResistorArray`, pinos
só-lidos como `en`/`addr-*` do mux, `powerPos`/`powerNeg` do opamp) fica com o grupo INTEIRO singular
se o usuário só fiar parte dessas sub-redes (uso normal — ninguém fia os 16 pinos de um DIP sempre),
e o solver zera TODAS as tensões do grupo, inclusive as sub-redes que tinham referência real. Fix
padrão aplicado nas 4 classes novas: uma condutância de fuga insignificante (`1e-9 S`) até a terra em
todo pino sem outra garantia de estampa. Documentado em `.spec/lasecsimul.spec` §7.5 como padrão
obrigatório para componentes multi-pino futuros.

### 1.2 — Sensores resistivos falsos duplicando os reais

`passive.ldr`/`passive.thermistor`/`passive.rtd`/`passive.force_strain_gauge` eram resistores
estáticos disfarçados (zero resposta a luz/temperatura/força), catalogados em "Passivos > Resistive
Sensors" — duplicando, sob nomes e pasta diferentes, os sensores REAIS já existentes em
`devices/simulide-sensors` (`sensors.ldr`/`thermistor`/`rtd`/`strain`, física de verdade incluindo
curva gamma real para o LDR), catalogados em "Sensores". Um usuário pegando "LDR" pela pasta óbvia
ganhava o componente errado, sem aviso. **Removidos os 4 builtins falsos** e suas entradas de
catálogo — `sensors.*` é agora a única fonte.

### 1.3 — `passive.resistor_dip`: 14 de 16 pinos flutuando

Registrava só os 2 primeiros pinos via `SimulideTwoPinResistor` — os outros 14 (declarados no
símbolo visual como 8 resistores independentes) não existiam eletricamente. Corrigido com
`components::ResistorArray` (8 pares reais, resistência única compartilhada, igual ao
`resistordip.cpp` real). Redimensionamento dinâmico e modo "Pullup" (barramento) do original não
implementados — o catálogo atual já declara os 16 pinos como fixos.

### 1.4 — Placement incorreto ao criar subcircuito da seleção

`createSubcircuitFromSelectionHandler` (`extension.ts`) calculava `centerY` com uma fórmula inventada
(`minY + (minY + (n-1)*16)`) em vez do `maxY` real dos componentes selecionados — `maxY` nem era
calculado. Para qualquer seleção não espaçada por exatamente 16px verticalmente (praticamente sempre),
o bloco do novo subcircuito nascia num Y arbitrário. Corrigido: `maxY` calculado no mesmo loop que já
calculava `maxX`, `centerY = (minY+maxY)/2` como já era feito para X.

### 1.5 — NAND/NOR/NOT/XNOR inconstruíveis

`devices/simulide-logic` só tinha AND/OR/XOR/Buffer fixos em 2 entradas, sem flag de inversão — as
portas mais fundamentais de projeto digital real (mais que XOR) eram impossíveis de montar. Mesma
solução do SimulIDE real (propriedade "Inverted Outs" na MESMA porta, não um device separado): os 4
`.lsdevice` ganharam a propriedade `inverted`; `lib.c` inverte a saída quando ativa. NOT = Buffer
invertido. Testado contra o DLL real do plugin. **Atualização 2026-07-09**: a bolha visual de inversão
foi implementada nos 4 `.lsdevice`; AND/OR também ganharam contagem de entradas variável 2-8 via
`pinSpec.dynamicGroups`, `package.dynamicLayout`, `viewSpec.statePath` e leitura N-entradas no plugin.

---

## 2. Pendências resolvidas (funcionalidades parciais/ausentes)

- **Verbo IPC `"step"` estava "não implementado" apesar do `Scheduler::step(deltaNs)` já existir e
  funcionar** — só faltava ligar um no outro. Corrigido em `CoreApplication.cpp`; o wrapper
  `CoreClient.step()` (antes código morto, zero chamadores) agora aciona um mecanismo real.
- **Sem indicação de alterações não salvas** (risco real de perda de dados — achado de maior
  prioridade da auditoria de UI): `vscode.WebviewPanel` não suporta o diálogo nativo "unsaved
  changes" (diferente de `CustomEditorProvider`, migração de arquitetura maior, fora de escopo).
  Implementado o que a API permite: indicador "●" no título da aba quando há alteração não salva
  (`SchematicPanel.setDirty`), e confirmação modal (Salvar/Descartar) antes de `openProjectCommand`
  substituir o projeto atual.
- **`projectCommands.ts`: `load`/`save` sem tratamento de erro** — um `.lsproj` corrompido ou erro de
  disco falhava silenciosamente (promise rejeitada sem handler). Ambos os comandos agora capturam e
  mostram `vscode.window.showErrorMessage`, mesmo padrão já usado em todo o resto do código de
  arquivo da Extension.
- **Buffer de log do QEMU sem limite** — `QemuProcessManager::m_logs` crescia sem parar durante toda
  uma sessão de simulação, e `logs()` retransmitia o buffer INTEIRO a cada poll de 500ms do monitor
  serial (O(n²) ao longo de uma sessão longa). Cap de 1 MiB com histerese (corta pra metade do teto,
  não repetidamente). Protocolo de IPC "desde o offset X" (eliminaria a retransmissão completamente)
  não implementado — mudança de protocolo maior, o cap de memória já resolve a parte mais grave.

## 3. Funcionalidades adicionadas (paridade SimulIDE, UI)

- **Menu de contexto do canvas vazio**: agora inclui Colar/Desfazer/Refazer/Zoom (antes só
  "Selecionar tudo") — SimulIDE oferece os mesmos no menu de fundo vazio.
- **Zoom to Fit / Zoom to Selection / Zoom 1:1**: 3 botões novos na barra de ferramentas (grupo
  "view"), mesma lógica de ancoragem por ponto de tela já usada pelo zoom de scroll. Bounding box
  aproximada (posição declarada + margem fixa, mesma simplificação já aceita no cálculo de centro do
  "Criar Subcircuito"), não a caixa exata do símbolo.

## 4. Dispositivos/componentes implementados nesta rodada

Nenhum componente NOVO (typeId inédito) foi adicionado — o trabalho foi consertar 11 typeIds já
existentes no catálogo que estavam inertes, e remover 4 typeIds falsos/duplicados. O catálogo
efetivo de componentes eletricamente funcionais aumentou (11 componentes passam a fazer algo),
mesmo com a contagem total de itens caindo (63→59, pela remoção dos sensores falsos).

## 5. Refatorações executadas

- `extension/src/mcu/mcuCommands.ts`: `openMcuSerialMonitorCommand`/`openExposedMcuSerialMonitorCommand`
  duplicavam ~40 linhas idênticas (canal de saída, polling, cálculo de delta) — extraído
  `openSerialMonitor(key, label, serialPortLabel, targetCoreId)` compartilhado.
- `core/src/mcu/McuComponent.hpp`: comentário desatualizado dizendo que `loadFirmware` "ainda não é
  exposto via IPC" — já era, há tempo (`loadMcuFirmware`). Corrigido para referenciar o caminho real.

## 6. Itens do SimulIDE ainda não existentes (com justificativa)

**Atualização (2026-07-09)**: os dois primeiros itens desta seção foram fechados depois de decisão
explícita do usuário. `logic.and_gate`/`logic.or_gate` agora têm `inputs` 2-8 com pinos e geometria
declarativos (`pinSpec.dynamicGroups`, `package.dynamicLayout`, `viewSpec.statePath`) e lógica nativa
N-entradas no plugin. `Dialed` foi implementado como capacidade genérica do renderer (`overlayPaint`,
`rotate` por faixa e `dragAngular.continuous`) e aplicado a R/L/C variável; a popup do osciloscópio
também passou a usar dial interativo relativo como o `oscwidget.cpp` real. O texto abaixo fica como
histórico do estado da auditoria original, não como pendência atual.

Levantamento feito comparando `C:\SourceCode\simulide_2\src\components\**` inteiro contra o catálogo
+ built-ins + os 6 plugins ABI. A cobertura de componentes é essencialmente completa — os gaps de
gate/dial abaixo foram fechados em 2026-07-09; o que ainda falta de verdade é pontual, principalmente
modelo analógico simplificado:

- **Gate lógico com contagem de entradas variável (2-8)** — fechado em 2026-07-09 para AND/OR:
  `inputs`, `pinSpec.dynamicGroups`, `package.dynamicLayout`, `viewSpec.statePath` e leitura N-entradas
  em `devices/simulide-logic/src/lib.c`. XOR/Buffer continuam fixos por fidelidade ao SimulIDE 2.
- **`Dialed` (dial interativo em tempo real de execução)** — fechado em 2026-07-09 como capacidade
  genérica do renderer (`overlayPaint`, `rotate` por faixa, `dragAngular.continuous`) e aplicado a
  R/L/C variável; a popup do osciloscópio também usa dial interativo relativo.
- **Contagem de entradas de `Csource` genérico e alguns modelos analógicos simplificados** (BJT/
  MOSFET/JFET/SCR/DIAC/TRIAC com modelo limiar simplificado, tanto no built-in quanto no plugin
  `devices/simulide-complex`) — já documentado como achado aceito em `.spec/lasecsimul.spec` §7.4
  desde antes desta auditoria; confirmado ainda válido, não re-trabalhado (portar Newton-Raphson
  completo pra esses 6 exigiria reescrever o `lib.c` do plugin, escopo grande à parte).
- **Paridade visual do símbolo pra portas invertidas** (bolha de NAND/NOR/NOT/XNOR) — a correção
  desta rodada é elétrica; o desenho do símbolo continua idêntico ao da porta não-invertida.
- **Numeric unit-multiplier selector, recent-files (MRU), "Save as Image", drag-to-duplicate,
  pause-on-state-change do Probe** — gaps de UI/UX identificados no levantamento paralelo, priorizados
  abaixo de correções de comportamento incorreto (categoria que o próprio pedido do usuário listou em
  primeiro lugar). Não implementados nesta rodada por escopo/tempo — nenhum é um bug, são melhorias
  de produtividade.

## 7. Achados de documentação corrigidos (drift entre spec/docs e código real)

Mesma classe de problema encontrada e corrigida uma vez nesta sessão para o diodo (spec dizia "não
implementado" quando já estava); desta vez, uma varredura sistemática achou mais 5 ocorrências:

- `.spec/lasecsimul.spec` §6.1.2 — validação de propriedade + reação a `affectsTopology`/
  `requiresRestart` estava marcada "Pendente"; já estava implementada e testada.
- `README.md` — spec de subcircuitos descrita como "ainda não implementado" (falso); contagem de
  testes desatualizada (19→31 Core, 7→15 Extension).
- `docs/mvp-limitacoes.md` — mesma falsa pendência de subcircuitos, e diodo/transistor Newton-Raphson
  descrito como "implementar antes de reintroduzir `semiconductors.*`" quando já estava implementado.
- `docs/16-roadmap-pendencias-spec.md` — undo/redo, copiar/colar e flip listados como "conscientemente
  não implementados nesta rodada" numa seção que nunca foi atualizada depois que essas features
  foram, de fato, implementadas numa rodada posterior. Raciocínio histórico preservado com uma nota
  de atualização no topo, não apagado.

## 8. Impacto esperado

- **Correção**: o impacto mais direto — 11 componentes que antes não simulavam NADA agora produzem
  resultados eletricamente reais. Qualquer circuito educacional/de teste usando opamp, mux analógico,
  displays de LED, motor DC, stepper, lâmpada ou keypad estava silenciosamente errado antes desta
  correção (sem erro, sem aviso — só um resultado fisicamente impossível). Sensores resistivos
  reais (não mais escondidos atrás de uma pasta com nome idêntico e comportamento falso).
- **Estabilidade**: nenhuma regressão (31/31 + 15/15 testes, Debug e Release). O achado de arquitetura
  do grupo topológico singular é documentado como padrão a seguir, evitando a mesma classe de bug em
  componentes multi-pino futuros.
- **Desempenho**: buffer de log do QEMU limitado a 1 MiB (era ilimitado) — sessões de simulação longas
  com MCU não acumulam mais memória/tráfego IPC sem limite.
- **Manutenção**: duplicação removida (sensores falsos, monitor serial), documentação realinhada com
  o código real em 6 arquivos, achado de arquitetura documentado para não ser redescoberto do zero.
- **Cobertura de teste**: 3 arquivos de teste novos no Core (`inert_components_fix_test.cpp` — 5
  circuitos reais provando cada classe de componente corrigida; `logic_gate_plugin_test.cpp` — NAND
  via DLL real; mais o já existente `zener_led_test.cpp` desta sessão).

## 9. Verificação (segunda passagem)

- `node scripts/build-core.js --config=Debug` e `--config=Release`: ambos limpos.
- `ctest -C Debug` e `-C Release`: 31/31 testes passando nos dois.
- `npx tsc -p tsconfig.json / tsconfig.webview.json / tsconfig.test.json --noEmit`: limpos.
- `npm test` (Extension): 15/15 arquivos, 165 asserções individuais, 0 falhas.
- `project/schema/component-catalog.json`: JSON válido, 59 itens (63 − 4 sensores falsos removidos).
- Varredura manual por código morto/debug residual nos diffs de `CoreApplication.cpp`/`extension.ts`
  e nos 5 arquivos de componente novos: nada encontrado.
- Testes novos rodados isolados (fora do `ctest`) antes de entrar na suíte completa, mesma prática de
  segurança já estabelecida no projeto para novos executáveis de teste do Core.
