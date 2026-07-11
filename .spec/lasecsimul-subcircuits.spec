<!-- Claude Code Spec Header v1 -->
## Claude Code Operating Contract (English)

Purpose: Defines data-driven reusable subcircuits as a first-class component type.
Audience: coding agents for project schema, editor flow, netlist/session expansion, and persistence.
Mode: normative design contract.

Keywords: subcircuit, data-driven, reusable-component, interface-pins, package-visual, tunnel, nesting, serialization, no-native-code

Priority Rules:
1. MUST keep subcircuits data-only (no custom native code required).
2. MUST preserve compatibility with project and package schemas.
3. MUST perform expansion/instantiation in Core session flow, not pre-flatten in UI.
4. SHOULD reuse existing contracts (tunnel, package, lsproj schema) instead of inventing parallel formats.

Agent Workflow:
1. Validate schema compatibility first.
2. Ensure pin/interface mapping remains deterministic.
3. Add/adjust acceptance tests for persistence and instantiation behavior.

Decision Keywords:
- MUST, SHOULD, MAY, OUT OF SCOPE follow RFC 2119 intent.

---
# LasecSimul — Subcircuitos como Componente Reutilizável Definido por Dados (v0.1)

Status: rascunho inicial | Depende de: [`.spec/lasecsimul.spec`](./lasecsimul.spec) (v0.2+, seção 9, RF10,
RNF10) | Reaproveita: bloco `package`/`pins[]` de `.lsdevice`, ver `lasecsimul-native-devices.spec` seção 21

---

## 0. Relação com a especificação principal e decisão de design

Terceiro caminho de extensibilidade do LasecSimul (ver `lasecsimul.spec` seção 9), ao lado de biblioteca
padrão (C++ built-in) e plugin nativo (DLL/SO via `device_abi.h`). Decisão registrada na conversa de design:

- Um **subcircuito** é um circuito desenhado no próprio editor, salvo em disco como `.lssubcircuit`, com pinos de I/O
  e um símbolo visual definidos pelo usuário — **dado, nunca código**. Não exige compilador, não exige DLL/SO,
  não exige reiniciar o Core.
- Mecanismo de referência validado pelo `simulide_2` (não suposição de design) — ver
  `C:\SourceCode\simulide_2\src\components\subcircuits\{subcircuit,chip}.{h,cpp}`,
  `C:\SourceCode\simulide_2\src\components\other\{subpackage,packagepin}.{h,cpp}` e
  `C:\SourceCode\simulide_2\src\components\connectors\tunnel.{h,cpp}`. O SimulIDE resolve isso com três peças que o
  LasecSimul já tem equivalente parcial: (a) serialização XML do circuito interno → no LasecSimul já existe
  serialização JSON (`.lsproj`, ver `lasecsimul.spec` RF01); (b) `Tunnel` unindo pinos por nome compartilhado
  → o LasecSimul **já implementa isso** (`connectors.tunnel`, `Netlist::setTunnelName`, ver `lasecsimul.spec`
  seção 7.2); (c) editor visual de símbolo (`SubPackage`) → o LasecSimul **já especificou isso** pro caso de
  plugin nativo (`lasecsimul-native-devices.spec` seção 21). Subcircuito não inventa mecanismo novo — é a
  composição dos três que já existem ou já estão especificados, sem nenhum deles ser código C++.
- **Sem flattening antecipado pela Extension.** Igual ao SimulIDE (`Simulator::createNodes()` — todos os
  pinos, internos e externos, caem no mesmo `m_pinMap`; `Tunnel`s com mesmo nome compartilham `eNode`), o
  Core expande um subcircuito na própria `SimulationSession` no momento em que ele é instanciado — não existe
  uma matriz MNA separada por subcircuito, nem a Extension acha "achatar" o circuito antes de mandar pro
  Core. Ver seção 5.
- **Sem TrustStore/consentimento.** A cerimônia de confiança de `lasecsimul-native-devices.spec` seção 12
  existe porque um plugin é código nativo sem sandbox (pode travar/corromper memória do processo Core). Um
  subcircuito é só uma composição de componentes que o próprio Core já sabe instanciar — abrir um
  subcircuito malicioso, na pior hipótese, monta um circuito sem sentido elétrico (já tratado: nó sem
  referência cai pra 0V com aviso, seção 7.3 de `lasecsimul.spec`), nunca executa nada. Não precisa de
  verificação de hash, publisher nem diálogo de consentimento.

## 1. Modelo de subcircuito

Um subcircuito é definido por um único arquivo `*.lssubcircuit`, com três blocos:

1. **Circuito interno** (`components`/`wires`) — mesmo schema de `.lsproj` (RF01 de `lasecsimul.spec`):
   lista de componentes (typeId + properties + pins) e fios entre eles. Pode incluir QUALQUER tipo de
   componente já disponível no catálogo — built-in, plugin, **ou outro subcircuito** (nesting, seção 5.3).
2. **Interface** (`interface`) — quais pinos do circuito interno ficam expostos como pinos do subcircuito,
   e com que nome/label públicos. Mecanismo: cada pino exposto é um `connectors.tunnel` dentro do circuito
   interno (ver seção 2) — não um tipo de pino novo.
3. **Símbolo visual** (`package`) — mesmo bloco `package`/`pins[]` já especificado em `.lsdevice`
   (`lasecsimul-native-devices.spec` seção 21), **reaproveitado tal e qual**, não redesenhado. Um campo só:
   `package.pins[].id` precisa bater com uma entrada de `interface[].pinId`.
4. **Portas seriais expostas** (`serialPorts[]`) — obrigatorio quando o subcircuito pretende oferecer
   monitor serial para um MCU interno; cada entrada descreve um periferico UART/USART monitoravel,
   nao um pino fisico. A UI nao inventa USART/UART por `typeId`.

```json
{
  "schemaVersion": 1,
  "typeId": "subcircuits.divisor_5v",
  "name": "Divisor 5V (R/R)",

  "folderPath": ["Subcircuitos", "Fontes auxiliares"],
  "icon": "<svg viewBox=\"0 0 20 20\" xmlns=\"http://www.w3.org/2000/svg\">...</svg>",

  "components": [
    { "id": "r1", "typeId": "passive.resistor", "properties": { "resistance": 1000 } },
    { "id": "r2", "typeId": "passive.resistor", "properties": { "resistance": 1000 } },
    { "id": "tunnel_in",  "typeId": "connectors.tunnel", "properties": { "name": "VIN" } },
    { "id": "tunnel_out", "typeId": "connectors.tunnel", "properties": { "name": "VOUT" } },
    { "id": "tunnel_gnd", "typeId": "connectors.tunnel", "properties": { "name": "GND" } }
  ],
  "wires": [
    { "from": { "componentId": "tunnel_in",  "pinId": "pin" }, "to": { "componentId": "r1", "pinId": "p1" } },
    { "from": { "componentId": "r1",         "pinId": "p2" },  "to": { "componentId": "r2", "pinId": "p1" } },
    { "from": { "componentId": "r1",         "pinId": "p2" },  "to": { "componentId": "tunnel_out", "pinId": "pin" } },
    { "from": { "componentId": "r2",         "pinId": "p2" },  "to": { "componentId": "tunnel_gnd", "pinId": "pin" } }
  ],

  "interface": [
    { "pinId": "VIN",  "label": "Entrada",  "internalTunnel": "VIN" },
    { "pinId": "VOUT", "label": "Saída",    "internalTunnel": "VOUT" },
    { "pinId": "GND",  "label": "Terra",    "internalTunnel": "GND" }
  ],

  "package": {
    "width": 60, "height": 50, "border": true,
    "background": { "kind": "color", "value": "#ffffff" },
    "shapes": [{ "kind": "text", "x": 12, "y": 28, "value": "DIV", "fontSize": 12, "color": "#000000" }],
    "pins": [
      { "id": "VIN",  "kind": "ANALOG_IN",  "x": 0,  "y": 15, "angle": 180, "length": 8, "label": "VIN" },
      { "id": "VOUT", "kind": "ANALOG_OUT", "x": 60, "y": 15, "angle": 0,   "length": 8, "label": "VOUT" },
      { "id": "GND",  "kind": "POWER",      "x": 30, "y": 50, "angle": 90,  "length": 8, "label": "GND" }
    ]
  }
}
```

Por que um arquivo único (sem separar circuito interno de `package`, ao contrário de como o SimulIDE permite
`.sim2`+`.package` separados): mesma razão da decisão de `lasecsimul-native-devices.spec` seção 21.1 — JSON
não tem o problema de mistura de formato (texto+binário) que motivava separar no SimulIDE; um arquivo só
elimina risco de referência pendente entre dois arquivos.

`language`/`translations` na raiz seguem exatamente a mesma convenção de `.lsdevice`
(`lasecsimul-native-devices.spec` seção 4.2.2.1, que já cobre subcircuitos explicitamente) — omitidos do
exemplo acima só por brevidade. Exemplo real em uso: `subcircuits/esp32_devkitc_v4.lssubcircuit`/
`esp32_wroom32.lssubcircuit` (`"language": "pt-BR"`, `"translations": {"en": {"name": "..."}}`).

## 2. Definição de I/O — `Tunnel` com nome no escopo da instância

Validado contra `Tunnel::registerEnode()` do SimulIDE (`tunnel.cpp` linhas ~80-106): todos os `Tunnel` com o
mesmo nome compartilham o mesmo nó elétrico (`eNode`), via um registro global por nome. O LasecSimul **já
tem isso** (`Netlist::setTunnelName`, `lasecsimul.spec` seção 7.2) — a única peça nova é como o **nome**
fica isolado por instância de subcircuito, pra duas instâncias do mesmo subcircuito não colidirem.

**Mecanismo**: ao expandir uma instância de subcircuito (seção 5), o Core prefixa todo nome de túnel interno
do subcircuito com um identificador único da instância:

```
nome real do túnel = "<subcircuitInstanceId>::<internalTunnel>"
```

Exemplo: duas instâncias do `subcircuits.divisor_5v` da seção 1, instâncias `42` e `43`, geram internamente
os túneis `42::VIN`/`42::VOUT`/`42::GND` e `43::VIN`/`43::VOUT`/`43::GND` — nomes diferentes, nunca se unem
entre si por acidente, exatamente como `SubCircuit::addPin()` do SimulIDE faz com `m_id + "-" + id`.

O pino **público** que o circuito externo vê (`VIN`/`VOUT`/`GND` na paleta) é, internamente, o próprio pino
do `Tunnel` renomeado — não existe um componente "subcircuito" com pinos próprios fazendo ponte; o túnel
expandido **é** o pino externo (seção 5.2 detalha o que isso implica pra `addComponent`/`connectWire`).

## 3. Modelo visual — reaproveita `package`/`pins[]` de `.lsdevice`

Sem campo novo. O bloco `package` de um `.lssubcircuit` é **estruturalmente idêntico** ao de `.lsdevice`
(`lasecsimul-native-devices.spec` seção 21.2: `width`/`height`/`border`/`background`/`shapes[]`,
`pins[].x/y/angle/length/label`). Única regra adicional: todo `id` em `package.pins[]` precisa existir em
`interface[].pinId` (validado ao carregar; subcircuito com pino de símbolo sem pino de interface
correspondente é rejeitado com erro claro, mesmo espírito de `addComponent` com `typeId` desconhecido hoje).

**Implementado em 2026-06-28** (era só "preparar desde já" até esta data): `WebviewComponentCatalogEntry`
(`extension/src/ui/webview/model.ts`) ganhou `package?: PackageDescriptor`, populado em
`extension.ts::resolveRegisteredItem` a partir do `package` real do manifesto (`.lsdevice`/`.lssubcircuit`).
O renderizador (`extension/src/ui/webview/componentSymbols.ts`) passou a desenhar **genericamente** a
partir desse campo quando presente — `registerPackage`/`pinLocalPosition`/`packageSymbolSvg`, cada pino na
posição/lado real declarado, casado por `id` (nunca por posição no array) — caindo no `switch(typeId)`
hardcoded só para built-ins sem `package` (resistor, capacitor, etc. — ver seção 11). Prova real: os dois
subcircuitos da ESP32 (`subcircuits/esp32_devkitc_v4.lssubcircuit`, `esp32_wroom32.lssubcircuit`, ver
`docs/11-qemu-esp32.md`). **O que isto NÃO é**: não existe editor visual (arrastar pino, redimensionar,
upload de imagem) — só o caminho de leitura; ver Épico G do roadmap de pendências.

Regras normativas adicionais para a UI:

1. Subcircuitos com `package` e/ou `authoringScene` MUST ser renderizados por parser/tradutor genérico,
  nunca por helper específico daquele `typeId`.
2. `if/switch` por `typeId` para montagem de geometria/pinos/fios é permitido apenas em fallback legado
  para tipos sem payload declarativo equivalente.
3. Introduzir hardcode visual para um subcircuito que já traz payload declarativo é OUT OF SCOPE.

## 4. Fluxo de criação no editor

Sem ferramenta nova — reaproveita o canvas do `SchematicEditorPanel` que já existe (mesmo princípio de
`lasecsimul-native-devices.spec` seção 21.3 para o editor de `package`):

1. Usuário desenha/seleciona um conjunto de componentes e fios no esquemático aberto.
2. Comando **"Criar Subcircuito a partir da Seleção"**: para cada fio com **uma ponta dentro da seleção e
   outra fora**, a Extension propõe um pino exposto — pede um nome público (`pinId`/`label`) e insere um
   `connectors.tunnel` no lugar do fio cruzando a fronteira, dentro do novo subcircuito (equivalente direto a
   marcar um pino do circuito interno como I/O — sem isso o subcircuito não teria como se conectar a nada).
3. Editor de símbolo (modo de edição já especificado em `lasecsimul-native-devices.spec` seção 21.3):
   redimensionar corpo, adicionar formas/imagem de fundo, posicionar os pinos do `package` — os mesmos
   `pinId` já coletados no passo 2, sem poder inventar um novo aqui (a interface elétrica vem do passo 2, o
   símbolo só posiciona visualmente).
4. Salvar grava `components`/`wires`/`interface`/`package` num `.lssubcircuit` — é o mesmo arquivo que alguém
   poderia escrever à mão; o editor é conveniência, nunca um formato/estado paralelo (mesma garantia da
   seção 21.3 do spec de plugins nativos).
5. O novo subcircuito aparece na paleta de componentes da mesma forma que um built-in ou plugin — ver seção 7.

**Revogação em 2026-07-09**: a UI não oferece mais um EDITOR SEPARADO/modo dedicado de símbolo/package
(`lasecsimul.palette.editSymbol`, `symbolAuthoring.ts`, "Editar Símbolo Visual", "Salvar Símbolo",
sessão de autoria própria) -- essa decisão continua de pé, nunca revertida. Qualquer menção abaixo a
esses nomes é histórico do fluxo removido. **Atualização 2026-07-10 (seção 17)**: dentro da MESMA
sessão "Abrir Subcircuito" (seção 16, sem editor/modo novo nenhum), passou a ser possível colocar
componentes normais (`other.package`/`other.package_pin`/`graphics.image`) que representam
visualmente o `package`/ícone e são compilados de volta ao salvar -- não é o editor revogado voltando,
é o `package` deixando de ser 100% somente-leitura, editado com as mesmas ferramentas do circuito
interno. Pra `.lsdevice` (fora de subcircuito) e pra `logicSymbolPackage`, a revogação permanece
integral: continuam somente-leitura, sem nenhum caminho de edição.

**Status em 2026-06-29** (revisado de novo no mesmo dia — depois de fechar o editor de `package`
sozinho, o usuário pediu pra ir além e cobrir o que SimulIDE chama de "Open Subcircuit": editar o
circuito INTERNO real de um subcircuito, não só o símbolo visual). Passo 3 ficou mais completo:

- Editor de símbolo (`package`/`logicSymbolPackage`) está **implementado**, sem distinção de código
  entre device/mcu-adapter (`.lsdevice`) e subcircuito (`.lssubcircuit`) (mesmo comando `lasecsimul.palette.editSymbol`, mesmo
  `extension/src/catalog/symbolAuthoring.ts`).
- **NOVO**: pra `subcircuit-file` especificamente, a MESMA sessão agora também semeia o circuito
  INTERNO real (`components[]`/`wires[]`, igual ao "Open Subcircuit" do SimulIDE real mostrar
  `Package` + circuito juntos na mesma cena) — `extractInternalCircuit`/
  `seedSubcircuitInternalComponents`/`compileSubcircuitInternalComponents` em
  `extension.ts`/`symbolAuthoring.ts`. `.lssubcircuit` ganhou campos aditivos `components[].visual`/
  `boardVisual` e `wires[].points` (Core ignora o que não reconhece, zero mudança em
  `SubcircuitRegistry.hpp`).
- **NOVO**: "Modo Placa" (`SubPackage::boardModeSlot()` do SimulIDE real) — dentro da sessão, um
  componente interno tem 2 posições independentes (circuito/placa); ligar o modo esconde tudo que
  não for `graphical: true` no catálogo (LED, motor, display, switch...) e deixa arrastar os
  visíveis pra uma posição de placa separada, sem afetar a posição no circuito.
- **NOVO**: "Logic Symbol" (`SubPackage::Logic_Symbol` do SimulIDE real) — aparência alternativa
  opcional (`logicSymbolPackage`), trocável por um botão "Ver: Físico/Símbolo Lógico" na barra —
  vale pra `subcircuit-file` E `mcu-adapter`, nunca `abi-device` puro (decisão explícita do usuário).
- Passos 1-2 (**"Criar Subcircuito a partir da Seleção"** — detecção de fronteira de seleção e
  inserção automática de `connectors.tunnel`, criar um `.lssubcircuit` NOVO do zero)
  **IMPLEMENTADOS em 2026-07-03** — ver seção 11 (algoritmo completo, comando
  `lasecsimul.newSubcircuit`, `createSubcircuitFromSelectionHandler` em `extension.ts`). Esta seção
  (4) descreve o estado ANTES dessa implementação (2026-06-29) — mantida como registro histórico do
  fluxo de edição de um `.lssubcircuit` já existente, que continua válido; só a frase "ainda não
  existem" ficou desatualizada. Hoje a sessão de "Abrir Subcircuito" edita um `.lssubcircuit` que já
  existe (mesmo que com `components[]`/`wires[]` escritos à mão, sem `visual` ainda — nesse caso cai
  num layout em grade simples na primeira abertura). Ver Épico G do roadmap de pendências para o
  escopo restante (sem simulação elétrica ao vivo dentro da sessão; sem `BoardSubc`/`ShieldSubc` —
  Arduino+Shield empilhado, feature à parte do SimulIDE).

**Fora de escopo nesta v0.1**: editar um subcircuito "por dentro" depois de já ter instâncias colocadas
(SimulIDE tem "Open Subcircuit" abrindo uma segunda instância do programa, `subcircuit.cpp` linha ~480) —
abordagem inicial é editar o `.lssubcircuit` como um projeto normal (`lasecsimul.openProject` aceitaria a
extensão), salvar, e instâncias já no esquemático só veem a versão nova na próxima vez que forem recriadas.
Hot-reload de subcircuito em uso fica como refinamento futuro, mesmo espírito do *versioned swap* de plugins
(RF09) mas não implementado agora.

### 4.1 Selecionar componentes expostos (dentro da sessão de edição) e usá-los na instância colocada
(implementado 2026-06-29/30, documentado aqui pela primeira vez)

Dentro da sessão de "Abrir Subcircuito" (passo 3, seção 4 acima), clicar com o botão direito num
componente interno mostra a opção **"Exposto"** (toggle, `internalSubcircuitMenuItems` em
`main.ts::createComponentElement`) junto das demais opções de contexto já existentes daquele
componente — marca `component.exposed = true` no `.lssubcircuit` (campo aditivo, igual `visual`/
`boardVisual`, Core ignora). Não existe mais um campo "Modo Placa" separado FORA do subcircuito — só
dentro da edição, e só pra escolher QUAIS componentes internos exportam suas propriedades.

Na instância JÁ COLOCADA no esquemático principal (fora da sessão de edição), o menu de contexto
("clicar com botão direito" na instância do subcircuito) ganha um SUBMENU por componente interno
EXPOSTO (`buildExposedComponentMenuItems` em `main.ts`) — selecionar um item do submenu abre um
diálogo NOVO (`openExposedInternalPropertyDialog`), só com as propriedades DAQUELE componente interno
(não as do subcircuito como um todo). Editar um campo nesse diálogo viaja por
`setSubcircuitChildProperty` (seção 6 abaixo), não por `setProperty` comum — o Core resolve o
componente interno por `localId` (não tem `componentIndex` próprio que a Extension conheça, ver
`findSubcircuitChildByLocalId`/`SimulationSession`).

**Duas coisas chamadas "Modo Placa" que NÃO são a mesma feature** — distinção que vale deixar
explícita, porque o nome é o mesmo e o contexto confunde:

1. **Modo Placa DENTRO da sessão de edição** (já documentado acima, seção 4): alterna entre posição-
   circuito e posição-placa de cada componente `graphical: true`, só existe enquanto a sessão de
   "Abrir Subcircuito" está aberta. Persistido em `component.boardVisual` no `.lssubcircuit`.
2. **Overlay de Modo Placa no esquemático PRINCIPAL** (fora de qualquer sessão de edição), pra uma
   instância de subcircuito JÁ COLOCADA com componentes expostos: retângulos arrastáveis sobre o
   símbolo da instância, um por componente exposto com `graphical: true`, refletindo a posição salva
   em `boardVisual` (fallback pra posição padrão em grade se nunca foi posicionado manualmente —
   `fallbackBoardVisualPosition` em `main.ts`). Arrastar um desses retângulos persiste de volta no
   `.lssubcircuit` via `requestUpdateBoardOverlayProperty`/`updateBoardOverlayPropertyCommand`
   (`extension.ts`) -- BoardVisual.x/y, não uma propriedade elétrica. Dados carregados sob demanda via
   IPC (`boardOverlayData`, ver seção 6) quando a instância tem `properties.boardModeEnabled === true`.

A feature 2 é o que o usuário pediu explicitamente ("tudo que estiver ligado a um componente no
subcircuit o user pode escolher quais elemento que ele quer externar suas propriedades ai no
scematico original quando clicar em propriedades tem um campo com o nome do dispositivo") — um campo
"Modo Placa" a mais FORA do subcircuito (ex: um toggle solto no menu da instância) seria confuso e
foi removido dessa ideia original; o controle real é só "Exposto" (feature 4.1, dentro da sessão) +
o submenu/overlay automático na instância (decorrência direta de quais componentes foram marcados
expostos, sem precisar de outro toggle).

## 5. Resolução em tempo de simulação no Core

### 5.1 Expansão na própria `SimulationSession`, sem matriz separada

Quando `addComponent` recebe um `typeId` que resolve para um subcircuito (registro descrito na seção 7, não
um `ComponentRegistry::Factory` de `IComponentModel`), o Core:

1. Lê o `.lssubcircuit` já carregado em memória (mesmo cache de manifesto que `GlobalPluginCache` mantém pra
   plugins, seção 7).
2. Gera um `subcircuitInstanceId` novo (pode ser o próprio próximo índice livre, ou um id sintético — decisão
   de implementação, não de contrato).
3. Para cada componente do bloco `components[]`, chama `SimulationSession::addComponent()` normalmente — se
   o `typeId` interno for **outro subcircuito**, este mesmo algoritmo roda recursivamente (nesting, seção
   5.3); cada instância interna recebe um `componentIndex` real e denso, igual a qualquer outro componente.
4. Para cada fio do bloco `wires[]`, chama `connectWire()` normalmente entre os `componentIndex` recém
   criados.
5. Para cada entrada de `interface[]`, localiza o `Tunnel` interno correspondente (pelo `id` do componente
   `connectors.tunnel` cujo `properties.name` bate com `internalTunnel`) e chama
   `setTunnelName(tunnelComponentIndex, "pin", oldName, "<subcircuitInstanceId>::<internalTunnel>")` —
   aplicando o prefixo da seção 2.
6. Devolve ao chamador (Extension) **não um `instanceId` só** — um mapa `subcircuitInstanceId` +
   `exposedPins: { [pinId]: { instanceId, pinId: "pin" } }`, ver seção 6.

**Sem flattening prévio**: o passo 3 já é, na prática, o mesmo efeito de "achatar" — mas acontece **dentro do
Core**, no momento da instanciação, igual ao SimulIDE resolver tudo numa `Circuit::self()->m_pinMap` única
(seção 6 do relatório de investigação, `Simulator::createNodes()`). A Extension nunca pré-processa nada —
manda o `.lssubcircuit` (ou seu caminho) pro Core uma vez, o Core decide como expandir.

### 5.2 O pino externo do subcircuito É o pino do `Tunnel`, não um proxy

Não existe um `IComponentModel` "SubcircuitInstance" com pinos próprios fazendo ponte pro `Tunnel` interno —
seria uma camada de indireção sem necessidade (o `Tunnel` já existe, já é um `IComponentModel` real, já tem
exatamente 1 pino). Consequência prática pro protocolo: quando o circuito **externo** conecta um fio a um
pino do subcircuito (ex: "VIN" do divisor), a Extension chama `connectWire` direto contra o
`instanceId`/`pinId` do `Tunnel` interno que a resposta da seção 5.1 devolveu pra aquele `pinId` público —
**não** existe um `componentIndex` separado "do subcircuito em si" pra esse fim.

### 5.3 Nesting (subcircuito dentro de subcircuito)

Suportado pela mesma recursão do passo 3 da seção 5.1, sem caso especial: um componente interno cujo
`typeId` é outro subcircuito dispara o mesmo algoritmo de novo, com um `subcircuitInstanceId` aninhado no
prefixo (`"<outerInstanceId>::<innerInstanceId>::<tunnel>"`) — garante nomes únicos em qualquer profundidade
sem precisar de um registro central de nomes já usados. Limite de profundidade: nenhum imposto pelo
contrato; ciclo (subcircuito A contém B que contém A) é erro de carregamento, detectado por uma pilha de
`typeId`s em expansão (se o `typeId` sendo expandido já está na pilha, rejeita com erro claro) — mesma
defesa que qualquer resolvedor de grafo de dependência recursivo precisa.

### 5.4 Remoção em cascata

`removeComponent` (seção 7.2 de `lasecsimul.spec`, já implementado para instância única) precisa de uma
variante pra subcircuito: remover a instância "de fora" deve remover **todos** os `componentIndex` internos
que a expansão da seção 5.1 criou (recursivamente, para nesting), não só um. Implementação sugerida: o Core
guarda, por `subcircuitInstanceId`, a lista de `componentIndex` filhos criados na expansão; um novo método
(`SimulationSession::removeSubcircuitInstance(subcircuitInstanceId)`) itera essa lista chamando
`removeComponent()` em cada um — reaproveita o mecanismo de remoção que já existe, não duplica lógica de
desconectar fio/túnel.

## 6. Protocolo IPC necessário

Extensões ao protocolo da seção 7 de `lasecsimul.spec` (payload, não verbo novo, onde possível):

- **`addComponent`** com um `typeId` de subcircuito devolve um payload diferente do caso comum:
  ```json
  { "instanceId": "100", "exposedPins": { "VIN": { "instanceId": "101", "pinId": "pin" },
                                            "VOUT": { "instanceId": "102", "pinId": "pin" },
                                            "GND": { "instanceId": "103", "pinId": "pin" } } }
  ```
  `instanceId` no nível raiz é o `subcircuitInstanceId` (usado só por `removeComponent`/depuração);
  `exposedPins[pinId]` é o que a Extension usa em `connectWire` (seção 5.2). Componentes comuns continuam
  devolvendo só `{"instanceId": "..."}` — `exposedPins` ausente nesse caso, a Extension trata como hoje.
- **`removeComponent`** com o `instanceId` raiz de um subcircuito dispara
  `removeSubcircuitInstance()` (seção 5.4) em vez de `removeComponent()` simples — o Core decide qual,
  a Extension não precisa saber se aquele id é "simples" ou "de subcircuito".
- **`loadDeviceLibrary`** (já implementado, `lasecsimul.spec`/código atual) segue como ponto de entrada
  de carregamento de bibliotecas. A lista de caminhos a carregar vem do catálogo unificado
  `LasecSimul/project/schema/component-catalog.json` (`deviceLibraries[]`) e pode incluir a biblioteca
  de subcircuitos (`../subcircuits/library.json`) quando presente.

Nenhum verbo novo de **leitura** é necessário — `getComponentState`/`getNodeVoltage` (se existirem) já
funcionam contra os `componentIndex` internos normalmente, porque são componentes reais.

### 6.1 Verbos pro overlay de Modo Placa / propriedades de componente interno exposto (seção 4.1)

- **`getSubcircuitChildInstanceId`** `{instanceId, localId}` → `{instanceId: childIndex}` — resolve o
  id local de um componente DENTRO de um `.lssubcircuit` (ex: `"button_en"`) pro índice REAL do Core,
  via `SimulationSession::findSubcircuitChildByLocalId(outerInstanceId, localId)`
  (`m_subcircuitChildIndexByLocalId`, mapa construído na expansão do subcircuito — seção 5.1). A
  Extension não tem como adivinhar esse índice sozinha (só conhece `componentIndex` de instâncias de
  TOPO, ver `coreInstanceIdByComponentId`).
- **`setSubcircuitChildProperty`** `{instanceId, localId, name, value}` → mesmo formato de resposta de
  `setProperty` comum (`ok`/`error`/`errorCode`/`requiresRestart`) — edita uma propriedade de um
  componente DENTRO de um subcircuito endereçando por id local em vez do índice Core, resolvendo
  `localId` → `childIndex` internamente (mesmo `findSubcircuitChildByLocalId` acima) antes de chamar
  `SimulationSession::setProperty(childIndex, name, value)`. Usado tanto pelo overlay de Modo Placa
  arrastável quanto pelo diálogo de propriedades do componente exposto (seção 4.1).
- **`boardOverlayData`** (notificação, não request/response) — a Extension envia sob demanda quando
  uma instância de subcircuito tem `properties.boardModeEnabled === true`: lê `boardVisual`/posição de
  cada componente interno `graphical: true` exposto e empurra pra Webview desenhar os retângulos
  arrastáveis sobre o símbolo da instância no esquemático principal.

## 7. Estrutura de pastas e biblioteca de subcircuitos

Mesmo padrão de `devices/library.json` (`lasecsimul-native-devices.spec` seção 14), por consistência:

```
LasecSimul/
└── subcircuits/
    ├── library.json                 # { "subcircuits": [ { "typeId": "...", "manifest": "divisor_5v.lssubcircuit" }, ... ] }
    └── divisor_5v.lssubcircuit        # arquivo único, seção 1 — sem pasta por subcircuito (não tem binário por plataforma)
```

Diferença deliberada de `devices/<nome>/.lsdevice` (uma pasta por dispositivo, porque tem binário +
manifesto): subcircuito é um arquivo só, então `library.json` referencia o `.lssubcircuit` direto na raiz de
`subcircuits/`, sem subpasta — menos estrutura do que dispositivos nativos exigem, porque não há nada além
do JSON pra versionar junto.

### 7.1 Registro canônico na paleta (princípio do arquivo único)

O registro aponta SOMENTE para o arquivo do subcircuito — sem duplicar metadados. A Extension lê
`folderPath`, `icon`, e `label` diretamente do `.lssubcircuit` ao resolver o item de paleta.

Em `LasecSimul/project/schema/component-catalog.json`, um subcircuito é registrado assim:

```json
{
  "kind": "subcircuit-file",
  "id": "bundled.subcircuits.divisor_5v",
  "filePath": "../subcircuits/divisor_5v.lssubcircuit",
  "removable": false
}
```

Toda informação de paleta (`folderPath`, `icon`, `label`) vem do `.lssubcircuit` — nunca repetida no catálogo.
O catálogo é apenas um ponteiro para o arquivo; o arquivo é a fonte de verdade completa.

Regras normativas:

1. Subcircuito NÃO ganha caminho de cadastro alternativo na UI; entra nos `registeredSources[]` do catálogo
  unificado como `"kind": "subcircuit-file"`.
2. A pasta/subpasta exibida na paleta vem de `folderPath` no `.lssubcircuit` e pode ter profundidade arbitrária.
3. O ícone da paleta vem do campo `icon` do `.lssubcircuit` (SVG inline de 20×20px começando com `<svg`).
4. A Extension usa o `icon`/`folderPath` do `.lssubcircuit` com precedência máxima; se ausentes, cai para
  `source.folderPath` do catálogo como fallback de último recurso.
5. `typeId` do `.lssubcircuit` é o identificador único; o catálogo não declara typeId — só caminho do arquivo.
6. Bibliotecas de subcircuito MUST ser registradas em `deviceLibraries[]` do catálogo quando fizerem parte
  da distribuição ativa.

## 8. Comparação com SimulIDE-dev

| Aspecto | SimulIDE-dev | LasecSimul (este spec) |
|---|---|---|
| Formato do circuito interno | `.sim1`/`.sim2` (XML) | mesmo schema de `.lsproj` (JSON), embutido no `.lssubcircuit` |
| Definição de I/O | `Tunnel` + propriedade `Pins` no item `Package` | `Tunnel` + bloco `interface[]` — mesmo mecanismo, nome explícito em vez de string codificada |
| Símbolo visual | arquivo `.package` separado (XML), ou inline no `.sim2` | bloco `package` único, reaproveitado de `.lsdevice` (seção 21 do native-devices.spec) |
| Editor de símbolo | `SubPackage` (modo "board" no próprio editor) | mesmo princípio: modo de edição no `SchematicEditorPanel` (seção 4), nada novo |
| Resolução em simulação | Sem flattening; `Tunnel`s com mesmo nome compartilham `eNode`; matriz MNA única | Sem flattening; expansão recursiva na mesma `SimulationSession` no momento do `addComponent` (seção 5.1); matriz MNA única (consequência, não mudança de mecanismo) |
| Nomeação de túnel entre instâncias | `m_id + "-" + id` (prefixo pelo id da instância) | `<subcircuitInstanceId>::<internalTunnel>` (mesmo princípio) |
| Isolamento/confiança | N/A (SimulIDE não tem modelo de plugin nativo nesse sentido) | Nenhum — é dado, não código (seção 0) |

## 9. O que isto NÃO é

- **Não é** um quarto tipo de `IComponentModel`. Não existe `SubcircuitComponent : IComponentModel` — a
  "instância de subcircuito" é só um agrupamento lógico de instâncias reais (seção 5.2).
- **Não é** flattening feito pela Extension. A Extension nunca lê o `.lssubcircuit` pra decidir topologia —
  manda o `typeId`/caminho, o Core decide tudo (consistente com "Extension nunca calcula simulação elétrica",
  `lasecsimul.spec` seção 1).
- **Não é** uma segunda matriz MNA por subcircuito. Um subcircuito nunca é uma "caixa-preta" resolvida
  separadamente — os componentes internos entram nos mesmos `CircuitGroup`s que tudo mais, exatamente como o
  SimulIDE resolve (seção 8).
- **Não tem**, nesta v0.1, edição "por dentro" de uma instância já colocada, nem hot-reload de subcircuito em
  uso (seção 4) — só editar o arquivo fora do contexto de instância e recriar.

## 10. Próximos passos / o que fazer desde já

Preparação de arquitetura recomendada **antes** de qualquer subcircuito existir de fato, pra não exigir
retrabalho quando a feature for implementada:

1. **`addComponent` (IPC) já devolve um payload extensível** (objeto, não só uma string) — já é o caso hoje
   (`{"instanceId": "..."}`), então adicionar `exposedPins` opcional (seção 6) é compatível sem versionar o
   protocolo; ainda assim, confirmar que o `CoreClient.addComponent()` do lado Extension não assume
   implicitamente "a resposta só tem instanceId" em algum lugar do código atual.
2. **Catálogo da Webview deve aceitar `package` por entrada** (seção 3) — extensão de tipo no catálogo
  unificado (`project/schema/component-catalog.json`), sem mudança de comportamento pros built-ins
  existentes.
3. **`removeComponent` do lado Core já existe e é idempotente** (`lasecsimul.spec` seção 7.2,
   `SimulationSession::removeComponent`) — a variante de cascata (seção 5.4) reaproveita, não substitui.
4. **`setTunnelName` já aceita renomear em runtime** (`Netlist::setTunnelName`) — é exatamente o que a
   expansão da seção 5.1, passo 5, precisa; nenhuma mudança nesse método é esperada.
5. ~~Implementação real (parser de `.lssubcircuit`, algoritmo de expansão recursiva, comando "Criar Subcircuito
   a partir da Seleção" na Extension) fica para uma rodada futura — este spec existe pra essa rodada não
   precisar redescobrir o desenho, só seguir.~~ **Feito** — ver seção 11.

## 11. "Criar Subcircuito da Seleção" — algoritmo implementado (2026-07-03)

Comando `lasecsimul.newSubcircuit` (também disponível no menu de contexto de multi-seleção na Webview).
Fluxo completo:

### 11.1 Ponto de entrada

- **Menu de contexto da Webview**: ao clicar com botão direito numa multi-seleção (≥ 2 componentes) fora
  de sessão de autoria de símbolo, o menu exibe "Criar Subcircuito da Seleção". Ao clicar, a Webview
  envia `requestCreateSubcircuitFromSelection { componentIds }` à Extension.
- **Comando VSCode**: `lasecsimul.newSubcircuit` envia `triggerCreateSubcircuitFromSelection` à Webview;
  a Webview verifica se há ≥ 2 componentes selecionados e, se sim, envia
  `requestCreateSubcircuitFromSelection` de volta.

### 11.2 Algoritmo na Extension (`createSubcircuitFromSelectionHandler`)

Dados de entrada: `componentIds[]` (IDs dos componentes selecionados no `schematicState`).

1. **Categorizar fios**: para cada fio em `schematicState.wires`:
   - Ambos os endpoints dentro de `componentIds` → **fio interno** (vai para `wires[]` do `.lssubcircuit`)
   - Um endpoint dentro, um fora → **fio de fronteira** (gera um túnel + entrada de interface)
   - Nenhum endpoint dentro → ignorado

2. **Gerar túneis**: um `connectors.tunnel` por fio de fronteira, nomeado `P1`, `P2`, etc.
   Posicionado em `(minX - 64, minY + i * 16)` dentro do espaço interno para não sobrepor os
   componentes selecionados quando o subcircuito for aberto para edição.

3. **Montar o `.lssubcircuit`**:
   ```json
   {
     "schemaVersion": 1,
     "typeId": "subcircuits.<slug>",
     "name": "<nome_do_arquivo>",
     "language": "pt-BR",
     "components": [ ...componentes_selecionados, ...túneis_gerados ],
     "wires": [ ...fios_internos, ...stubs_de_túnel ],
     "interface": [{ "pinId": "P1", "label": "P1", "internalTunnel": "P1" }, ...]
   }
   ```
   Stubs de túnel: cada túnel tem um fio `{ from: { componentId: tunnelId, pinId: "pin" }, to: { innerComponentId, innerPinId } }`.

4. **Salvar e registrar**: diálogo de save (`*.lssubcircuit`) → gravar arquivo → adicionar `RegisteredSource`
   com `kind: "subcircuit-file"` e `folderPath: ["Meus Subcircuitos"]` → `saveRegisteredSources` →
   `refreshUnifiedCatalogState(false)` (não recarrega DLLs, só atualiza catálogo).

5. **Atualizar esquemático**:
   - Remove todos os componentes selecionados e qualquer fio que toque neles.
   - Insere novo componente do tipo gerado no centro da bounding box dos componentes removidos.
   - Para cada fio de fronteira: cria um novo fio de `{ newSubcircuitId, pinName }` para o endpoint
     externo do fio original (preservando a conectividade externa sem alterar nenhum outro componente).
   - Atualiza o Core (pushRemoveToCore × N + pushComponentToCore × 1 + pushWireToCore × M) e
     chama `queueCoreRebuild`.

### 11.3 Limitações conhecidas

- O `.lssubcircuit` gerado não tem campo `package` — o símbolo visual usa o renderizador genérico até
  o usuário executar "Editar Símbolo Visual" manualmente.
- Posições internas dos componentes são absolutas (não re-centradas) — o espaço interno do subcircuito
  começa com as coordenadas originais do esquemático. Isso é funcionalmente correto (o Core não usa
  coordenadas visuais para simulação) mas pode exigir scroll quando o subcircuito for aberto para edição.
- Pins de fronteira são nomeados genericamente (P1, P2, ...) — o usuário pode renomeá-los via
  "Abrir Subcircuito" → "Salvar Subcircuito" depois da criação.

## 12. Bloco genérico de subcircuito por caminho (2026-07-06)

Segunda forma de usar um subcircuito num circuito normal, ADICIONAL ao registro na paleta (seção 7)
— um componente aponta direto pra um `.lssubcircuit` qualquer via uma propriedade, sem exigir
`RegisteredSource`/`component-catalog.json`. Motivação: usar um subcircuito emprestado/compartilhado
sem poluir a paleta global de todo mundo com um registro permanente.

### 12.1 Modelo

- Novo typeId built-in `subcircuits.external` (`project/schema/component-catalog.json::items[]`,
  `pinCount: 0`, sem `package`) — placeholder até o usuário escolher um arquivo. Propriedade
  `subcircuitPath` com `editor: "filePath"` (novo tipo de editor, `main.ts::renderPropertyField`) —
  campo só-leitura + botão "Procurar..." que dispara `requestChooseSubcircuitFile`.
- Ao escolher um arquivo, `chooseSubcircuitFileCommand` (`extension.ts`) faz o MESMO parse que
  `resolveRegisteredItem`'s subcircuit-file branch usa pra registro na paleta -- fatorado num
  helper compartilhado, `parseSubcircuitManifest(json, manifestDir, language)`, pra nunca duplicar
  `knownPinIdsForManifest`/`sanitizePackage`/derivação de ícone uma terceira vez.
- O `typeId` da INSTÂNCIA muda pro `typeId` real declarado no arquivo (ex:
  `subcircuits.divisor_5v`) — reaproveita o MESMO registro `typeId`-indexado de renderização
  (`registerPackage`/`packageSymbolSvg` em `componentSymbols.ts`) que já existe pra subcircuitos
  registrados, em vez de inventar um segundo pipeline de renderização por instância. A entrada de
  catálogo correspondente é EFÊMERA (`hidden: true`, nunca gravada em `component-catalog.json`) --
  não aparece na paleta (`paletteTree.ts` já filtra `hidden`), só serve pra resolução de
  pinos/package/label desta sessão.
- Core: novo verbo IPC leve `registerAdhocSubcircuit { path }` (`CoreApplication.cpp`, factory
  `registerSubcircuitFromManifest` compartilhada com o loop de `library.json`) registra UM
  `.lssubcircuit` avulso no `SubcircuitRegistry` sem exigir `library.json` — `addComponent` com o
  typeId resultante funciona exatamente igual a qualquer subcircuito registrado
  (`isSubcircuitType`/`addSubcircuitInstance` não mudam nada).

### 12.2 Referência persistida no `.lsproj`

Único campo novo em `ProjectComponent`/`WebviewComponentModel` (`ProjectTypes.ts`/`model.ts`),
aditivo, sem bump de `schemaVersion`:
```json
"subcircuitRef": {
  "path": "../subcircuits/divisor_5v.lssubcircuit",
  "lastKnownTypeId": "subcircuits.divisor_5v",
  "lastKnownPinIds": ["VIN", "VOUT", "GND"]
}
```
`path` é relativo ao diretório do `.lsproj` quando possível, absoluto senão. `lastKnownTypeId`/
`lastKnownPinIds` são a ÚNICA exceção deliberada à regra "nunca persistir pinos" (seção 5) —
sem um `RegisteredSource` pra consultar, não há de onde re-derivar os pinos quando o arquivo está
ausente; o snapshot preserva a integridade estrutural dos fios até o usuário relocalizar o arquivo.

### 12.3 Arquivo ausente ao reabrir o projeto

`resolveProjectSubcircuitReferences` (`extension.ts`) roda logo após `projectToWebviewState`, antes
de `rebuildCoreFromSchematicState`, pra cada componente com `subcircuitRef`:
- **Arquivo encontrado**: resolve silenciosamente (mesmo parse de 12.1), registra no Core, sem
  diálogo nem toast por item.
- **Arquivo ausente**: componente vira placeholder visual (borda tracejada vermelha + "?",
  `componentSymbols.ts::missingSubcircuitPlaceholderSvg`), preservando posição/propriedades/pinos
  (`lastKnownPinIds` via `pinsForProjectComponent`) — fios continuam estruturalmente íntegros, só
  sem simulação elétrica. `isUnresolvedSubcircuitRef` bloqueia qualquer tentativa de `addComponent`
  no Core enquanto não resolvido (nunca gera erro de "typeId desconhecido" à toa). UM aviso
  agregado no final ("N subcircuito(s) não encontrado(s)..."), nunca um toast por componente.
- **Relink**: mesmo comando `chooseSubcircuitFileCommand` de 12.1 (botão "Procurar..." na
  propriedade, ou menu de contexto "Localizar arquivo do subcircuito..." no bloco). Faz diff de
  fios contra `lastKnownPinIds`: quem sobrevive no novo arquivo é mantido, quem não existe mais é
  removido COM aviso explícito (nunca silencioso).

### 12.4 Limitações conhecidas

- Trocar de arquivo depois de já posicionado destrói e recria a instância no Core (pino é um
  `std::span` fixo desde a construção, `IComponentModel::pins()` não redimensiona in-place).
- Colocar `subcircuits.external` DENTRO de uma sessão de "Abrir Subcircuito" (circuito interno de
  outro subcircuito) não é bloqueado explicitamente -- `subcircuitRef` não faz parte do schema de
  `InternalComponentSeed`/`compileSubcircuitInternalComponents`, então salvar o subcircuito pai
  perderia a referência (o componente interno ficaria com o typeId resolvido mas sem
  `subcircuitRef` pra re-resolver depois). Degrada graciosamente (vira instância "typeId
  desconhecido" genérica no próximo carregamento), não corrompe nada, mas não é uma combinação
  suportada -- evitar.

## 13. Bug corrigido: distorção de componentes ao salvar/reabrir um subcircuito importado do SimulIDE (2026-07-06)

**Sintoma relatado**: ao editar um subcircuito com `authoringScene` (importado de uma cena real do
SimulIDE, `.sim2`, ver seção 4), inserir um componente novo aparecia com tamanho correto; depois de
salvar e reabrir, alguns componentes (não todos) voltavam com proporção/escala visivelmente errada
(ex: o corpo quadrado do chip ESP32 virava um retângulo achatado).

**Causa raiz**: `authoringScene.components[]`/`.transform`/`.wires[]` são um SNAPSHOT CONGELADO da
importação original -- `extension.ts::persistSubcircuitAuthoringScene` (chamado a cada "Salvar
Subcircuito") só reescreve a chave `.package` (posição do corpo do símbolo), NUNCA
`.components[]`/`.transform`/`.wires[]`. Mas
`simulideSceneTranslator.ts::translateSimulideSubcircuitAuthoringScene` reaplicava esse snapshot
CONGELADO em TODA reabertura, incondicionalmente:
- Sobrescrevia `x`/`y`/`rotation`/`flipH`/`flipV` de cada componente interno cujo id ainda constasse
  no snapshot, descartando silenciosamente qualquer edição manual feita depois da 1ª importação.
- Regravava `properties.__simulideSceneScaleX`/`__simulideSceneScaleY` (a conversão POR EIXO
  Qt-pixel → grid do LasecSimul, ex. `2.714442258`/`1.719123611` -- quase nunca 1:1) em todo
  componente cujo `typeId` tivesse um `package` real registrado (`componentSymbols.ts::componentBox`/
  `packageBodySvg` leem essa escala, ver seção 3). Como os dois eixos escalam por fatores
  DIFERENTES, um corpo originalmente quadrado (ex. `espressif.esp32`, 136×136) virava um retângulo
  não-quadrado (369×234) -- distorção real, mensurável, não um efeito colateral inofensivo.
- Regravava `wires[].points` a partir de `authoringScene.wires[]`, descartando qualquer rota de fio
  editada manualmente depois da importação.

**Por que só alguns componentes distorcem**: só quem tem (a) um `id` presente no snapshot
`authoringScene.components[]` E (b) um `package` REAL registrado pro seu `typeId`
(`passive.resistor`, `switches.push`, `espressif.esp32`, `other.ground`, etc. -- ver seção 3).
`connectors.tunnel` e qualquer componente NOVO (id nunca visto no snapshot original) nunca entram
nesse caminho -- por isso "aparece certo" recém-inserido, e o tunnel nunca distorce.

**Correção** (`simulideSceneTranslator.ts::translateSimulideSubcircuitAuthoringScene`): a tradução
do snapshot agora é IDEMPOTENTE -- aplicada no máximo UMA VEZ por componente. `properties.
__simulideQtOrigin === true` (marca já existente, gravada pela PRÓPRIA tradução na 1ª vez) é usada
como sinal "esta sessão de arquivo já consumiu o snapshot de importação"; se QUALQUER componente
interno já carregar essa marca, a tradução inteira (componentes E fios, sempre da MESMA importação)
é pulada e o circuito usa exatamente o que está salvo. Sem hardcode por componente/typeId -- reusa
um marcador que já fazia parte do design. Teste de regressão:
`simulideSceneTranslator.test.ts` ("NAO reaplica a cena ... num componente que já foi traduzido
antes") reproduz save→reload→edit manual→save→reload e confirma posição/escala/rota preservadas.

**Reverificado em 2026-07-06 (pedido de investigação adicional)**: reprodução fiel via
`out-test` chamando as funções REAIS de produção
(`seedSubcircuitInternalComponents`/`translateSimulideSubcircuitAuthoringScene`/
`compileSubcircuitInternalComponents`/`compileSymbolAuthoringComponents`/
`persistSubcircuitAuthoringScene`) com os 44 componentes reais de `esp32_devkitc_v4.lssubcircuit`
mais 3 componentes novos (resistor/tunnel/push button) e 1 fio novo, comparando estado
pré-salvamento × pós-reload: nenhuma diferença em x/y/rotation/flip/properties/SVG renderizado/
pontos de fio. Confirmado por leitura direta de código que `updateComponentElement` (`main.ts`) é
o MESMO renderer para o editor de subcircuito e o editor de circuito normal -- `symbolAuthoringContext`
só desvia INTERAÇÃO (fio local sem round-trip pro host), nunca renderização visual. A correção desta
seção continua cobrindo o fluxo corretamente; nenhuma nova causa de distorção foi encontrada.

## 14. `font-size`/`stroke-width` de rótulo de pino do `package`: SEMPRE valores literais, nunca escalados (estado final, 2026-07-06)

**Regra vigente**: `font-size` do rótulo de pino e `stroke-width` do lead/marcador são sempre os
valores LITERAIS declarados (`pin.labelFontSize ?? 7`, `3` pro lead, `0.5` pro marcador) -- em
`componentSymbols.ts::packagePinLeadSvg` E em `symbolAuthoring.ts` (sessão de autoria), idênticos nos
dois lugares, sem NENHUM fator de escala. `scaleX`/`scaleY` (`schematicWidth/width`,
`schematicHeight/height`) continuam existindo e são aplicados SÓ à POSIÇÃO (`pin.x/y`, extremidade
do lead, geometria de `shapes[]`) -- necessidade real e exclusiva do LasecSimul, já que pinos de um
`package` fotográfico como `esp32_devkitc_v4.lssubcircuit` são capturados em coordenada de pixel da
FOTO, não no espaço de grade final como no SimulIDE real, então PRECISAM ser comprimidos; fonte e
traço não, porque no SimulIDE real eles nunca dependeram dessa distinção pra começo de conversa
(confirmado lendo `subcircuits/chip.cpp::Chip::setWidth/setHeight` -- `m_area = QRect(0, 0,
8*m_width, 8*m_height)`, o `QPixmap` de fundo é desenhado ESTICADO pra caber nessa caixa, nunca o
inverso; `gui/circuitwidget/pin.cpp::Pin::paint()` usa `font.setPixelSize(7)`/`QPen(color, 3, ...)`
como CONSTANTES literais, nunca multiplicadas por fator de escala/zoom-por-`package` -- a única coisa
que reescala fonte+traço junto com a posição no SimulIDE real é o zoom do `QGraphicsView`, que
escala a CENA INTEIRA uniformemente; e o arquivo real `esp32.package` que o SimulIDE instala declara
pinos JÁ no espaço final, pitch de 8 unidades, mesma fonte de 7px, sem overlap).

Verificado numericamente contra `esp32_devkitc_v4.lssubcircuit`: sessão de autoria e instância normal
do schematic (`packageSymbolSvg`) desenham `font-size:7px` idêntico -- o MESMO valor que
`Pin::paint()` do SimulIDE real usa pro mesmo tipo de rótulo.

**Lição aprendida** (histórico resumido -- duas rodadas de diagnóstico ERRADO antes de chegar na
regra acima, motivo pelo qual esta seção existe): a 1ª rodada viu rótulos colando (retângulo sólido
`#FAFAC8`) e concluiu, sem comparar contra o SimulIDE real, que fonte/traço precisavam escalar junto
com a posição comprimida (`packageVisualScale = √(scaleX·scaleY)`) -- introduzido só em
`componentSymbols.ts`. A 2ª rodada notou que a sessão de autoria (`symbolAuthoring.ts`) não tinha o
MESMO fator, e o estendeu pra lá também (`authoringFontScale`), consistente mas ainda escalado. Só na
3ª rodada, comparando pixel-a-pixel com `C:\SourceCode\simulide_2` e com o `esp32.package` real
instalado pelo SimulIDE, ficou claro que a premissa inteira estava errada -- o pitch "denso" que
pareceu bug (~9.4px/~7-8px medidos nos dois `.lssubcircuit` reais do projeto) é IGUAL OU MAIS FOLGADO
que o pitch nativo do SimulIDE (8 unidades, mesma fonte 7px, sem problema há anos); o sintoma
original teve outra causa (provavelmente posição ainda não compactada corretamente numa versão
anterior do translator). As duas funções de escala (`packageVisualScale`/`scaledDimension` em
`componentSymbols.ts`, `authoringFontScale` em `symbolAuthoring.ts`) foram removidas por inteiro.
**Regra geral pra evitar repetir isto**: ao portar/corrigir comportamento visual do SimulIDE,
comparar contra a fonte C++ real (ou um arquivo `.package` real, quando existir) ANTES de escalar
qualquer constante -- "os dois lados da LasecSimul ficaram consistentes entre si" não é a mesma coisa
que "bate com o SimulIDE real".

## 15. Bug corrigido: `connectors.junction` do circuito interno vira um objeto visível "fantasma" com id cru (2026-07-07)

**Sintoma relatado**: dentro do circuito interno de um subcircuito (ex.
`esp32_devkitc_v4.lssubcircuit`, "Abrir Subcircuito"), aparecem círculos ligados a fio com um texto
tipo `component-1783414925016-10722` escrito ao lado -- permanecem mesmo depois de tentar apagar.

**Causa raiz**: `connectors.junction` (ponto de junção criado ao ligar fio→fio, ou colocado
manualmente da paleta sobre um fio existente) sempre nasce `hidden: true, label: "Junction"` (ver
`extension.ts::junctionComponentAt`, `main.ts::newJunctionComponent`) -- um marcador SEM símbolo
nem rótulo visível, igual ao SimulIDE real (uma junção nunca é um "componente" visualmente
identificável, só um ponto de topologia). Mas `InternalComponentSeed` (o formato realmente
persistido em `.lssubcircuit::components[]`, ver `symbolAuthoring.ts`) NÃO tem campo `hidden`/
`label` -- eles são DERIVADOS de novo toda vez que a sessão de autoria é semeada
(`seedSubcircuitInternalComponents`). Essa derivação tratava TODOS os typeIds igual:
`hidden: false, showId: true, label: component.id` -- ou seja, uma junção criada dentro de "Abrir
Subcircuito", ao ser salva e reaberta, perdia seu estado correto e reaparecia como um círculo
PERMANENTEMENTE visível com o id bruto (`component-<timestamp>-<random>`) escrito ao lado, sem
nenhuma serventia (não é editável de forma útil, seu "corpo" é só um ponto de fiação).

**Por que "mesmo depois de apagados ficam"**: dado real encontrado no arquivo do ESP32 DevKitC ao
investigar -- havia uma junção órfã (`component-1783414925016-10722`, ZERO fios conectados a ela,
puro lixo de dado) E um fio com uma ponta apontando pra outro id de junção que sequer existia mais
em `components[]` (`component-1783414855037-7397`, deixando `button_en` (botão EN) com o pino
`pin-2` sem nenhuma conexão de verdade). Ambos removidos diretamente do arquivo (dado morto, sem
como "adivinhar" a intenção original de fiação -- **o botão EN do ESP32 DevKitC ficou sem o pino 2
conectado**; se isso for eletricamente necessário, precisa ser refiado manualmente por quem conhece
o layout pretendido).

**Correção estrutural** (`symbolAuthoring.ts::seedSubcircuitInternalComponents`): `connectors.junction`
agora é EXCEÇÃO explícita na derivação -- nasce sempre `hidden: true, label: "Junction", showId:
false`, igual ao comportamento real de criação (não hardcoded por instância/arquivo -- vale pra
QUALQUER subcircuito, futuro incluso). `connectors.tunnel` (única outra exceção pré-existente,
mostra o nome do net) e o restante dos typeIds continuam com o comportamento de sempre.

**Mesma causa raiz também no circuito PRINCIPAL** (`extension.ts::projectToWebviewState`, usado ao
reabrir um `.lsproj`): `ProjectComponent` (formato persistido do projeto principal) TAMBÉM não tem
campo `hidden` -- a derivação usava `descriptor?.hidden ?? false` (o `hidden` do CATÁLOGO, que
significa "esconder da PALETA", não "instância invisível no canvas" -- "Junção" é colocável
manualmente de propósito, `component-catalog.json` documenta "Coloque sobre um fio pra criar uma
derivação", então marcar o catálogo como `hidden` removeria essa opção da paleta, uma regressão
diferente). Corrigido com a MESMA exceção explícita por typeId, sem tocar no catálogo -- uma junção
reaberta de um `.lsproj` salvo também volta a ficar invisível como deveria.

**Verificação**: teste de regressão novo em `symbolAuthoring.test.ts`
("`connectors.junction` nasce hidden/label 'Junction', nunca visível com id cru") mais toda a
suíte existente (76 testes) sem regressão. `projectToWebviewState` (`extension.ts`) não tem teste
dedicado (função privada, não exportada, arquivo sem suíte de testes -- consistente com o resto de
`extension.ts`) -- verificado só por leitura/compilação. Sem GUI neste ambiente pra confirmar
visualmente no VSCode real; recomenda-se reabrir o subcircuito ESP32 DevKitC e um projeto principal
com uma junção criada por fio→fio pra confirmar que nenhum círculo/rótulo aparece mais.

**Superseded em 2026-07-11** (seção 19): `connectors.junction` deixou de ser um componente
registrado no Core -- toda esta classe de bug (entidade de topologia persistida/serializada como se
fosse um componente de catálogo) ficou estruturalmente impossível a partir dali, não só mitigada no
render. Registro histórico mantido porque o sintoma e o diagnóstico continuam corretos para a
arquitetura da época.

## 16. "Abrir Subcircuito" reinstaurado, sem o antigo editor de símbolo, com Salvar/Cancelar/Descartar (2026-07-09)

Continuação da **Revogação em 2026-07-09** (fim da seção 4): naquele mesmo dia, depois de remover
todo `symbolAuthoring.ts`/`symbolCommands.ts` (autoria de símbolo visual), o usuário pediu de volta
só a parte de **editar o circuito INTERNO** de um `.lssubcircuit` já registrado -- não o símbolo
visual, que permanece somente leitura pela decisão da Revogação. Reimplementado do zero (não é
revert do código antigo), sem `SymbolAuthoringKind`/sessão de autoria genérica compartilhada com
`.lsdevice`.

### 16.1 Arquitetura: pilha na Extension, não sessão paralela na Webview

`state.subcircuitEditingStack` (`extension/src/state.ts`) -- array, não um único slot, pra suportar
abrir um subcircuito DENTRO de outro já em edição (nesting). Cada entrada guarda: `sourceId`/
`filePath`, `originalManifest` (JSON bruto lido do arquivo, preservado por inteiro exceto
`components`/`wires` na hora de salvar -- `package`/`interface`/`translations`/`authoringScene`
nunca são tocados por esta sessão), `outerSchematicState`/`outerProjectFilePath` (snapshot completo
do circuito de fora, restaurado ao sair) e `initialComponents`/`initialWires` (baseline pra
dirty-check, ver 16.3).

**"Abrir Subcircuito"** (`extension.ts::openSubcircuitForEditingCommand`, mensagem Webview→Host
`requestOpenSubcircuit{sourceId}`): lê o `.lssubcircuit`, converte `components[]`/`wires[]` (mesmo
shape `visual.x/y/rotation/flipH/flipV` de `ProjectComponent`) pra `WebviewComponentModel[]`/
`WebviewWireModel[]` (espelha `projectToWebviewState`, `projectCommands.ts`), empilha o circuito
ATUAL e troca `state.schematicState` pelo circuito interno. Nada é perdido em disco -- é uma troca
NA MEMÓRIA, diferente de "Abrir Projeto".

Diferente do fluxo de 2026-06-29 (histórico, seção 4): NÃO semeia `package`/Modo Placa/Logic Symbol
na mesma sessão -- só o circuito elétrico interno (`components`/`wires`). Overlay de Modo Placa
(seção 4.1) continua existindo, mas como recurso independente do circuito principal, sem precisar
"entrar" nesta sessão pra editar posição de placa.

### 16.2 Abrir/Salvar/Importar Projeto bloqueados durante a sessão

`.lsproj` (formato de "Abrir/Salvar/Importar Projeto") é incompatível com o circuito interno de um
`.lssubcircuit` em edição -- `projectCommands.ts::warnIfEditingSubcircuit()` bloqueia os 3 comandos
(`openProjectCommand`/`saveProjectCommand`/`importProjectCommand`) com aviso explícito enquanto
`state.subcircuitEditingStack.length > 0`. A toolbar do esquemático (`main.ts::renderAppBar`)
desabilita visualmente os botões Abrir/Salvar Projeto no mesmo caso, e mostra uma faixa
`"Editando subcircuito: <nome>"` com botão **"Voltar ao Circuito Principal"** -- só ela sai da
sessão.

### 16.3 Sair da sessão: Salvar / Cancelar / Descartar Alterações

Achado de auditoria 2026-07-09 (feedback direto do usuário): a versão inicial desta reimplementação
sempre gravava ao sair, sem opção de cancelar/descartar -- gerava insegurança ("não sei se minha
mudança foi aplicada"). Corrigido com dirty-check + diálogo modal de 3 opções
(`extension.ts::closeSubcircuitEditorCommand`):

- **Sem alteração** (`isSubcircuitEditingSessionDirty` compara `components`/`wires` ATUAIS contra
  `initialComponents`/`initialWires` da sessão, serializados -- mesmo princípio de
  `projectCommands.ts::isProjectDirty`): sai direto, sem perguntar nada.
- **Com alteração**: `vscode.window.showWarningMessage` modal com 3 botões explícitos -- **Salvar**
  (grava no `.lssubcircuit`, reregistra no Core, volta ao circuito de fora), **Descartar
  Alterações** (volta ao circuito de fora SEM gravar -- mudanças da sessão são perdidas de propósito,
  escolha informada do usuário) e **Cancelar** (ou fechar o diálogo/Escape -- não muda nada, sessão
  continua ativa, usuário pode seguir editando). Nenhum botão tem ação implícita/default -- as 3
  opções aparecem sempre que há algo pra decidir.

### 16.4 Bugs encontrados durante a reimplementação (não pré-existentes na sessão de autoria antiga)

1. **`connectors.tunnel` sem `pinIds` declarado**: nunca tinha sido instanciado "ao vivo" na Webview
   antes (só existia como JSON cru dentro de `.lssubcircuit`) -- o catálogo não declarava `pinIds`,
   então `pinsForTypeId` cairia no genérico `pin-1`, mas todo `.lssubcircuit` real (inclusive os
   gerados por `createSubcircuitFromSelectionHandler`) usa `pinId: "pin"` (sem sufixo) nos fios que
   tocam um túnel -- os fios de fronteira ficariam visualmente órfãos/desconectados dentro da sessão.
   Corrigido em `catalog.ts` (seed/fallback) E em `project/schema/component-catalog.json` (catálogo
   REAL usado em runtime).
2. **`boardVisual` perdido ao salvar**: campo de posição do overlay de Modo Placa (independente de
   `visual`, o circuito elétrico) que esta sessão nunca expõe/edita -- reconstruir cada componente do
   zero ao salvar apagaria esse campo silenciosamente pra quem já tinha posicionado o overlay antes.
   `closeSubcircuitEditorCommand` agora parte do objeto ORIGINAL de cada componente (por id) e só
   sobrescreve os campos que de fato passam pelo `WebviewComponentModel` desta sessão.
3. **Undo/redo cruzando contexto**: a pilha única do esquemático (seção 17.3 de `lasecsimul.spec`)
   trata QUALQUER `syncStatePatch` como uma transição normal -- sem tratamento especial, entrar/sair
   da sessão empilharia a troca de circuito inteiro como se fosse uma edição comum, e um Ctrl+Z
   dentro da sessão pularia de volta pro circuito de FORA enquanto a faixa "Editando subcircuito"
   continuava mostrando o de dentro (tela e contexto dessincronizados; o próximo "Voltar ao Circuito
   Principal" salvaria o conteúdo ERRADO no arquivo). Corrigido em `main.ts`: um patch que muda
   `subcircuitEditingContext` (chave presente, entrando OU saindo) reseta o histórico de undo/redo em
   vez de registrar transição -- mesmo tratamento que `"init"` já recebia.

### 16.5 Verificação

Compilação limpa (`tsc` main + webview + test) e suíte de testes completa (154 testes) sem
regressão. Simulação numérica (Node, fora do DOM) do round-trip abrir→editar→fechar sobre o arquivo
REAL `esp32_devkitc_v4.lssubcircuit` confirmando equivalência semântica (mesmos componentes/fios/
`package`/`interface`/`authoringScene` preservados, única diferença é `flipH`/`flipV` passando a
ficar explícitos em vez de omitidos quando `false` -- normalização inofensiva). Sem GUI disponível
neste ambiente pra confirmar interativamente no VSCode real; recomenda-se: abrir o ESP32 DevKitC,
editar algo, tentar "Voltar ao Circuito Principal" e confirmar que as 3 opções aparecem: Cancelar
mantém a sessão, Descartar Alterações volta sem gravar, Salvar grava e reabrir confirma a mudança
persistida.

## 17. Autoria visual do ícone (Figura) e do Package do SimulIDE, DENTRO da sessão "Abrir
Subcircuito" (2026-07-10)

**Decisão explícita**: isto NÃO é a "Revogação em 2026-07-09" (fim da seção 4) sendo desfeita, nem um
retorno ao antigo `symbolAuthoring.ts`/`symbolCommands.ts` (removido no commit `6c9e185`, que tinha
seu PRÓPRIO modo/toolbar de autoria, separado do circuito interno). O símbolo visual continua sem
nenhum editor dedicado -- o que existe agora é a possibilidade de colocar, na MESMA cena da seção 16
(mesmo canvas, mesmos fios/túneis/seleção/zoom/undo-redo/salvamento), componentes NORMAIS que
representam o `package`/ícone do subcircuito, compilados de volta ao salvar. Nenhum código do
subsistema removido foi restaurado, revertido ou copiado -- construído do zero sobre a arquitetura
atual (`extension/src/catalog/subcircuitPackageAuthoring.ts`, novo módulo puro, testável sem DOM,
`subcircuitPackageAuthoring.test.ts`).

### 17.1 O conceito de `Package` do SimulIDE real

Investigado no código-fonte real (`C:\SourceCode\simulide_2\src`): o "Package" do SimulIDE não é um
arquivo/objeto separado do subcircuito -- é a classe `SubPackage`
(`src/components/other/subpackage.h`/`.cpp`), um `Chip` normal que desenha seu próprio corpo (retângulo
+ fundo opcional) e possui uma lista de `PackagePin` (`packagepin.h`) posicionados em coordenadas
LOCAIS relativas à origem do próprio Package. Pinos são adicionados por manipulação direta no corpo
(Shift+hover perto da borda mostra um pino-fantasma encaixado na grade; clicar cria um `PackagePin`
real e abre um diálogo pra id/label/ângulo). `SubCircuit` (`subcircuit.h`/`.cpp`) NÃO possui o
`SubPackage` como objeto embutido -- ele parseia um bloco `.package`/`<packageB>` UMA VEZ na
construção, e cada `PackagePin` daquela lista vira um `Tunnel` dentro do circuito interno, casado POR
STRING DE ID (`tunnel->setTunnelUid(id)`, `subcircuit.cpp` ~305-345). **Não existe ícone separado**:
`SubPackage::paint()` desenha o mesmo corpo em qualquer contexto -- o que aparece expandido é
EXATAMENTE o que aparece no circuito pai, nunca uma imagem "de resumo" à parte.

Esta feature replica esse conceito com o vocabulário já existente do LasecSimul (`PackageDescriptor`/
`PackagePin`, `model.ts`) em vez de inventar um formato paralelo:

- **`other.package`** (typeId já existente no catálogo, antes um "código morto" render-only da era
  `symbolAuthoring.ts`) = o corpo do `SubPackage` -- largura/altura/borda/cor de fundo, um objeto por
  sessão.
- **`other.package_pin`** (idem) = um `PackagePin` -- posição/ângulo (via `component.rotation`, os
  mesmos 4 cardeais que qualquer outro componente já usa pra girar -- SEM campo novo, mesma convenção
  documentada em `componentSymbols.ts`), comprimento, identificador (`properties.pinId`).
- O RÓTULO de cada pino é um `graphics.text` companheiro, linkado por
  `properties.linkedPinComponentId` -- infraestrutura que JÁ EXISTIA viva (não desta feature; ver
  `main.ts::componentsToAddForTypeId`/`dragSelectionWithLinkedPinLabels`, arrastar um `other.
  package_pin` da paleta já criava esse rótulo companheiro antes desta sessão sequer materializar um
  Package existente).

### 17.2 A Figura/ícone = a MESMA imagem que `package.background` já suportava

`PackageDescriptor.background` (`model.ts`) já existia com `{kind: "image", data, mime}` -- o
"ícone"/corpo visual que aparece quando o subcircuito é colocado no circuito pai (ex:
`esp32_devkitc_v4.lssubcircuit`, uma foto real da placa). Antes desta feature, ISSO só podia ser
escrito à mão no JSON -- não havia jeito de trocar visualmente. Em vez de inventar um objeto novo, a
Figura reaproveita o typeId `graphics.image` JÁ EXISTENTE no catálogo geral (usado em qualquer
esquemático pra anotação visual) -- marcado, só durante a sessão, por um campo novo
`WebviewComponentModel.packageIconRole?: true` (mesmo estilo "marcador de papel especial" que
`subcircuitRef` já usa; nunca serializado no `.lssubcircuit` -- a fonte de verdade persistida
continua sendo `package.background`).

Trancada na mesma posição/tamanho do `other.package` (mesma decisão de design de `Estágio 3` do
plano de implementação): o que é compilado sempre esticado pro `width×height` do Package, então o
que aparece na cena de autoria precisa bater com isso, sem enganar visualmente.

Como PRÉ-REQUISITO desta feature (Estágios 1/2 do plano), `graphics.image`:

1. Ganhou `width`/`height` como propriedades reais (`propertyDrivenBox`, `componentSymbols.ts`) --
   antes tinha caixa fixa 80x80, sem jeito de redimensionar.
2. Passou a RENDERIZAR a imagem de verdade (`<image href="data:...">`) quando
   `properties.imageData`/`imageMime` estão presentes -- antes só desenhava um glifo decorativo
   "foto" fixo, em qualquer instância, independente do que fosse escolhido.
3. O editor de propriedade `filePath` (`main.ts`), antes hard-coded só pro caso único
   `subcircuits.external.subcircuitPath`, foi generalizado: qualquer `propertySchema` com
   `editor: "filePath"` que NÃO seja esse campo específico grava direto em
   `properties[propertyKey]` via a nova mensagem `requestChooseFile` (`extension.ts::
   chooseFilePropertyCommand`) -- o caso especial de `subcircuitPath` continua 100% intocado.

### 17.3 Vínculo pino↔túnel: identificador estável, nunca o nome editável

Diferente da convenção antiga de `interface[].internalTunnel` (nome do túnel, casado por STRING --
quebra se o túnel for renomeado, nunca detectado/avisado), esta feature adiciona
`interface[].internalTunnelId?: string`, o `id` ESTÁVEL do componente-túnel (o mesmo id usado em
`wires[].from/to.componentId`, nunca muda com rename). Contrato:

- `internalTunnelId` é a fonte de verdade do vínculo durante a autoria (`other.package_pin.
  properties.tunnelComponentId`, setado via menu de contexto **"Vincular a túnel..."** -- lista os
  túneis presentes na cena, com um "Desvincular túnel" quando já há vínculo).
- `internalTunnel` (nome) continua existindo e sendo OBRIGATÓRIO pro Core
  (`CoreApplication.cpp:1078-1106`/`SimulationSession.cpp:300-311` -- confirmado no código real: sem
  esse campo, ou apontando pra um nome que não existe, o Core REJEITA o arquivo inteiro com
  `throw std::runtime_error`) -- mas passa a ser RE-DERIVADO automaticamente do nome ATUAL do túnel
  a cada compilação (`compilePackageAuthoringComponents`), nunca mais escrito à mão. Renomear um
  túnel dentro da sessão e salvar já atualiza `internalTunnel` sozinho -- o bug que motivou a
  mudança.
- **Pino sem túnel associado**: excluído do `package.pins[]`/`interface[]` compilados (o Core rejeita
  um `internalTunnel` vazio/inexistente -- não dá pra gravar um pino "órfão" de qualquer jeito),
  warning não-bloqueante, salva normalmente.
- **Vários pinos (com `pinId` DIFERENTE) apontando pro mesmo túnel**: PERMITIDO, nunca erro --
  padrão comum em hardware real (ex: `esp32_devkitc_v4.lssubcircuit` tem `GND1`/`GND2`/`GND3`, 3
  pinos físicos na placa, todos na mesma malha de terra interna). **Correção 2026-07-10 (bug real de
  produção)**: a versão original desta feature tratava isso como erro bloqueante, por suposição
  errada de que só podia significar engano do usuário -- bloqueava salvar um arquivo já válido no
  mundo real. Confirmado contra `CoreApplication.cpp`: o Core só rejeita `pinId` duplicado
  (`interfacePinIds.insert(...)`), NUNCA verifica se dois `interface[]` diferentes repetem o mesmo
  `internalTunnel`. Removida a checagem; o único jeito de "aliasar 2 pinos externos na mesma rede"
  continua existindo (é exatamente o que múltiplos GND fazem, de propósito), só deixou de ser tratado
  como engano por padrão.
- **`pinId` duplicado entre pinos**, **mais de um `other.package` na cena**, **mais de uma Figura
  marcada como ícone** (ex: colar por engano -- `cloneComponent`, `main.ts`, já limpa
  `packageIconRole` de toda cópia, mas um usuário poderia arrastar um segundo `graphics.image` e
  marcar manualmente por engano se algum dia existir essa opção -- por ora só a seed cria um):
  erro BLOQUEANTE.

### 17.4 Validação ANTES de gravar, nunca depois

Achado durante o design (não um bug já em produção, uma armadilha que esta feature introduziria se
não fosse tratada): antes desta mudança, `writeSubcircuitEditingSessionBack` gravava
`fs.writeFileSync` incondicionalmente e só DEPOIS validava no Core (`registerAdhocSubcircuitDefinition`,
falha só virava um toast -- o arquivo já estava em disco). Com um compilador que pode produzir
`package`/`interface` genuinamente inválidos (pinId duplicado, vínculo duplicado), esse padrão
gravaria um `.lssubcircuit` inconsistente no disco. Corrigido: `compilePackageAuthoringComponents`
roda e é validado em MEMÓRIA antes de qualquer `fs.writeFileSync`; erros bloqueantes abortam o
salvamento (`writeSubcircuitEditingSessionBack` devolve `false`), e
`closeSubcircuitEditorCommand` NÃO desempilha a sessão nesse caso -- o usuário permanece na sessão de
edição, corrige, tenta salvar de novo. Nenhuma escrita parcial/inconsistente é possível.

### 17.5 Compatibilidade com arquivos antigos

`seedPackageAuthoringComponents` NUNCA sintetiza um `other.package` do zero quando `manifest.package`
está ausente ou não sanitiza -- um arquivo antigo sem Package não ganha um gratuitamente só por ser
aberto (evita diff espúrio em todo `.lssubcircuit` existente na primeira vez que alguém abre e fecha
sem editar nada). Migração de `interface[].internalTunnel` (nome) pra `internalTunnelId` (id) é por
melhor esforço na abertura (casa o nome salvo contra os túneis carregados no circuito interno) --
nunca falha a abertura se não achar; só fica com aquele pino sem vínculo (warning), até o usuário
vincular manualmente. Ao salvar, o arquivo ganha `internalTunnelId` daí em diante -- migração forward
natural, sem comando dedicado. `compilePackageAuthoringComponents` também distingue explicitamente
"sessão nunca tocou em autoria de Package" (cena sem nenhum `other.package`/`other.package_pin`/
ícone -- `package`/`interface` do manifesto ficam 100% intocados) de "sessão removeu o Package
deliberadamente" (existiam componentes de autoria antes, cena atual tem zero `other.package` --
`package`/`interface` são apagados do manifesto).

### 17.6 O que NÃO mudou

Mesma cena, mesmos componentes elétricos, mesmo sistema de fios/túneis/seleção/zoom/undo-redo/cópia/
salvamento da seção 16 -- os componentes de autoria (`other.package`/`other.package_pin`/o
`graphics.image` marcado) são só MAIS componentes na lista `state.schematicState.components`, com
`pinCount: 0` (nunca vão pro Core, `coreLifecycle.ts::shouldSyncComponentToCore`), sujeitos às MESMAS
ferramentas genéricas (arrastar, rotacionar, copiar, desfazer) sem nenhum código dedicado extra pra
isso. A renderização do subcircuito no circuito PAI (`registeredSources.ts`/`sanitizePackage`) não
mudou -- lê `package`/`interface` do mesmo arquivo de sempre; só precisa que o compilador produza
esses campos no formato exato que ela já esperava.

### 17.7 Verificação

Compilação limpa (`tsc` main + webview + test) e suíte de testes completa (169 testes) sem regressão.
Testes cobrem: seed materializa Package/pinos/rótulos/ícone corretamente a partir de um manifesto
real; seed NÃO sintetiza nada sem `manifest.package`; seed converte corretamente do espaço nativo
pro espaço exibido quando `schematicWidth`/`schematicHeight` existem (bug real corrigido, ver seção
18); round-trip seed→compile preserva dimensões/pinos/interface; renomear um túnel entre seed e
compile é refletido no `internalTunnel` re-derivado (o bug-alvo); pino sem túnel vira warning +
exclusão (nunca gravado órfão); vários pinos DIFERENTES no mesmo túnel são PERMITIDOS (bug real
corrigido, ver acima -- cenário de teste é literalmente GND1/GND2/GND3 do ESP32 DevKitC);
`pinId` duplicado/Package duplicado/ícone duplicado continuam erros bloqueantes; cena sem autoria não
toca `package`/`interface`; `isPackageAuthoringComponent` distingue rótulo linkado (meta) de anotação
solta (real, preservada); ângulo não-cardeal escrito à mão é ajustado com aviso, não quebra. Sem GUI
disponível neste ambiente pra confirmar drag visual de pino, menu de contexto "Vincular a túnel..."
ou copiar/colar pela UI real -- recomenda-se verificação manual no VSCode real: abrir um subcircuito
com `package.background` de imagem (ex: `esp32_devkitc_v4.lssubcircuit`), confirmar que a Figura
aparece na cena, mover um pino, vincular/desvincular um túnel pelo menu de contexto, salvar, reabrir
e confirmar que tudo persistiu; confirmar que o corpo/pinos/ícone aparecem no circuito PAI exatamente
como editado.

## 18. Bugs reais encontrados testando a feature da seção 17 no ESP32 DevKitC (2026-07-10)

Achados de teste manual real (usuário abriu `esp32_devkitc_v4.lssubcircuit` pra editar), cada um
corrigido no mesmo dia:

1. **Package nascia com o tamanho NATIVO em vez do exibido**: `seedPackageAuthoringComponents` usava
   `packageDescriptor.width/height` (espaço nativo, pixels da foto -- 308x601 no ESP32 DevKitC) direto
   pro `other.package`, ignorando `schematicWidth`/`schematicHeight` (88x176, o que de fato aparece no
   esquemático). Corrigido: seed agora calcula `scaleX`/`scaleY` (mesma fórmula de
   `resolvePackageLayout`, `componentSymbols.ts:221-222`) e aplica no tamanho do corpo E na
   posição/comprimento de cada pino.
2. **Fios "flutuantes" pré-existentes no arquivo**: nada a ver com a feature da seção 17 -- o próprio
   `esp32_devkitc_v4.lssubcircuit` tinha `wires[]` referenciando `pinId` desatualizado (`"p1"`/`"p2"`
   nos resistores de pull-up, quando o catálogo atual usa `"pin-1"`/`"pin-2"`) e 2 fios duplicados/
   mortos usando um `pinId` (`"out"`) que nunca existiu nos trilhos de tensão -- por baixo já havia uma
   cópia correta de cada um. Corrigido diretamente no arquivo (não é bug de código, é dado
   inconsistente herdado).
3. **Pino `RST` do MCU não conectava**: o Core (`McuComponent::stampResetPin`) e o adaptador nativo
   (`Esp32Adapter.cpp`, `LSDN_MODULE_RESET` no índice 42) já tinham suporte COMPLETO e funcional pra um
   pino de reset -- só o `mcu-adapters/espressif-esp32/mcu.lsdevice`'s `pinMap` JSON (o que a Extension
   lê pra saber quais pinos desenhar/deixar conectar) nunca listava `"RST"`. Corrigido: adicionado
   `"RST": {"moduleKind": "Reset", "moduleIndex": 0}` como a 43ª entrada (bate com o índice 42 do
   adaptador nativo). O circuito de reset do DevKitC (`button_en`/`pullup_en`, já existente mas sem
   nunca alcançar o chip) foi ligado ao novo pino `mcu1.RST`.
4. **Vínculo pino↔túnel duplicado bloqueava um arquivo já válido**: `compilePackageAuthoringComponents`
   tratava "dois pinos apontando pro mesmo túnel" como erro bloqueante (suposição errada de que só
   podia ser engano) -- o ESP32 DevKitC real tem `GND1`/`GND2`/`GND3` (3 pinos físicos, mesma malha de
   terra), um padrão VÁLIDO e comum em hardware real que o Core sempre permitiu. Bloqueava salvar até
   uma edição trivial. Corrigido removendo essa checagem (ver seção 17.3 acima, atualizada).
5. **Mensagem de erro cortada no toast do VSCode**: `vscode.window.showErrorMessage`/
   `showWarningMessage` sem `{modal:true}` corta o texto num toast estreito -- o achado 4 acima só foi
   diagnosticável depois de trocar pra diálogo modal (`detail` com uma linha por erro/aviso, nunca
   corta). Aplicado nos 3 pontos que juntam `errors[]`/`warnings[]` em `extension.ts`
   (`openSubcircuitForEditingCommand`, `writeSubcircuitEditingSessionBack` x2).

**Verificação**: compilação limpa e suíte completa (169 testes) sem regressão após cada correção;
script Node ad-hoc revalidando o `esp32_devkitc_v4.lssubcircuit` real (0 problemas de pinId, `pinMap`
com 43 entradas incluindo RST, seed produzindo Package 88x176 com 38 pinos e 0 avisos). Sem GUI
disponível neste ambiente -- todas as correções foram reportadas pelo usuário testando manualmente no
VSCode real; recomenda-se continuar essa verificação até fechar o roteiro da seção 17.7.

## 19. Manifesto `.lssubcircuit` v2: `topology{nodes,conductors}` substitui `wires[]`; junção deixa
de ser componente (2026-07-11)

Continuação de `.spec/lasecsimul.spec` seção 24 (reconstrução do sistema de fios/junções a partir de
`docs/auditoria-tecnica-fios-simulide-2026-07-11.md`) -- esta seção documenta a parte específica de
subcircuito: formato de arquivo e algoritmo de achatamento de junção no Core.

### 19.1 Formato do bloco `components`/`wires` (seção 1) substituído por `topology`

`.lssubcircuit` ganhou `schemaVersion: 2` e um bloco `topology{revision, nodes[], conductors[]}` --
mesmo formato de `ProjectTopology` (`.spec/lasecsimul.spec` seção 24.6). `conductors[].from`/`.to`
usam `{kind:"port", componentId, pinId}` ou `{kind:"node", nodeId}` em vez do antigo
`{componentId, pinId}` fixo. `topology.nodes[]` (posição visual de cada nó de topologia) substitui os
componentes `connectors.junction` que antes apareciam em `components[]` -- um nó de topologia nunca
mais é um item de `components[]`. Exemplo real migrado: `subcircuits/esp32_devkitc_v4.lssubcircuit`
(1 nó em `topology.nodes[]`, 45 condutores). `createSubcircuitFromSelectionHandler`
(`extension.ts`, seção 11) já grava `.lssubcircuit` novos direto no formato v2.

### 19.2 Parsing no Core: `CoreApplication.cpp::registerSubcircuitFromManifestRich`

Detecta o formato pelo campo raiz: `canonicalTopology = manifest.contains("topology") &&
manifest["topology"].is_object()`. Se presente, lê `topology.conductors[]` (em vez de `wires[]`) com
endpoints tipados (`kind: "node"` resolve pro pino sintético `pin-1` do nó; `kind: "port"` resolve
`componentId`/`pinId` normalmente) e junta `topology.nodes[].id` ao mesmo conjunto `topologyNodeIds`
que já recebia `id` de componentes `typeId == "connectors.junction"` -- **os dois formatos de nó de
topologia (componente `connectors.junction` antigo E `topology.nodes[]` novo) são aceitos ao mesmo
tempo**, pra continuar lendo `.lssubcircuit` mais antigos que ainda não foram migrados, sem exigir
migração de arquivo em lote. Se `topology` estiver ausente, cai pro parsing antigo (`wires[]` +
componentes `connectors.junction` em `components[]`) inalterado.

### 19.3 Achatamento: junção nunca chega ao Core como aresta com nó de passagem

Depois de coletar `topologyNodeIds` (de qualquer uma das duas fontes acima) e o grafo bruto de
arestas (`def.wires`, já no formato interno comum `{fromComponentId,fromPinId,toComponentId,
toPinId}`), um passo de achatamento roda ANTES de `def.wires` ser usado pra `connectWire` de
verdade: monta um grafo de adjacência por `(componentId,pinId)`, decompõe em redes conexas (BFS),
e para cada rede com 2+ portas REAIS (ignorando `topologyNodeIds` como vértices de passagem)
emite N-1 arestas em estrela a partir da primeira porta encontrada. O comentário no código resume a
motivação: "Junction é sintaxe topológica do arquivo, nunca componente de simulação." Uma rede com
menos de 2 portas reais (ex: um nó de topologia sem nenhum fio de verdade saindo dele) não gera
nenhuma aresta -- não é erro, só não tem o que achatar.

### 19.4 Duplicação deliberada em teste, e uma regressão real que ela causou

`core/test/esp32_devkitc_subcircuit_test.cpp` mantém um `parseLssubJson` PRÓPRIO (comentário no
código: "mesmo mapeamento de campos que `CoreApplication.cpp::loadSubcircuitLibraryFile` -- mantido
em sincronia manualmente"), com a MESMA lógica de achatamento replicada à mão -- decisão deliberada
pra manter esse teste isolado de `CoreApplication.cpp` (ele registra suas próprias factories
mínimas de componente, sem depender do bootstrap completo do Core). O custo dessa duplicação se
concretizou em 2026-07-11: ao migrar `esp32_devkitc_v4.lssubcircuit` pro formato `topology{...}`
(seção 19.1), o parser duplicado do teste não foi atualizado junto -- continuou lendo
`manifest["wires"]` (chave que não existe mais no arquivo migrado), registrando silenciosamente ZERO
fios e fazendo os testes de tensão de rede (3V3/5V/EN) falharem por sistema singular (só GND
sobrevivia, por depender de `connectors.tunnel`/nome, não de `wires[]`). Corrigido replicando a
mesma branch `canonicalTopology` da seção 19.2 neste parser de teste -- se este arquivo for tocado de
novo no futuro, qualquer mudança de formato em `registerSubcircuitFromManifestRich` precisa ser
espelhada aqui também, manualmente, do jeito que o comentário já avisava.

### 19.5 O que NÃO muda

`Tunnel`/`setTunnelName` (seção 2), a regra "pino externo é o pino do Tunnel, não um proxy" (seção
5.2), expansão recursiva/nesting (seção 5.3) e remoção em cascata (seção 5.4) continuam exatamente
como especificado -- só a representação de nó de topologia (junção) dentro do arquivo/parsing
mudou. Um subcircuito sem nenhum nó de topologia (a maioria dos exemplos deste documento, ex: seção
1) não é afetado por nada desta seção.
