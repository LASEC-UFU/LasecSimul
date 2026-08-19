---
id: FEAT-011
kind: feature
status: active
dependsOn: [ARCH-001]
supersedes: []
---

# Navegação por domínio na paleta

## Onde vivem as 4 abas

As 4 categorias de domínio (`Analógico`, `Digital`, `Controle`, `Processo`) existem exclusivamente
como abas de filtro na **paleta de componentes** (painel lateral `lasecsimul.componentPalette`,
`extension/src/ui/webview/palette.ts`). Elas nunca aparecem no editor de esquemático (`main.ts`): o
editor é um único canvas elétrico sempre completo, sem seções, sem placeholder e sem gates de
ferramenta por domínio — qualquer componente do catálogo pode ser colocado e conectado livremente ao
mesmo circuito, independentemente de qual aba está ativa na paleta no momento.

```text
Paleta (painel lateral)
├── Analógico
├── Digital
├── Controle
└── Processo
```

- não existe mais aba principal com subabas (`Circuit > Analog/Digital`, `Process > Ctrl/Autom`);
  as 4 categorias existem diretamente no mesmo nível;
- a ordem é fixa e não pode ser alterada pelo usuário — vem de uma única fonte de verdade
  (`WORKSPACE_SECTION_ORDER` em `extension/src/ui/webview/workspace.ts`), nunca duplicada como
  literal em outro lugar da navegação;
- `Analógico` é a aba inicial;
- os botões exibem somente ícone, sem texto visível; o nome de cada aba aparece exclusivamente como
  tooltip/hint ao passar o mouse (`title`/`aria-label`), com o texto exato: `Analógico`, `Digital`,
  `Controle`, `Processo`;
- a navegação segue o padrão de acessibilidade `role="tablist"`/`role="tab"`/`aria-selected`, com
  `ArrowLeft`/`ArrowRight` movendo foco e seleção entre as 4 abas (com wrap nas pontas);
- trocar de aba na paleta é puramente um filtro de busca/listagem — nunca cancela ferramentas
  ativas, nunca afeta seleção, viewport ou qualquer estado de autoria do editor, porque o editor não
  tem noção de "aba ativa" nenhuma;
- selecionar a aba já ativa é no-op: não refaz a árvore da paleta.

O editor (`main.ts`) não lê nem escreve `workspaceSection`/`WorkspaceSelection` em nenhum momento —
esse conceito é interno à paleta.

## Separação do catálogo na paleta

Cada entrada do catálogo pertence a exatamente uma seção: `analog`, `digital`, `control` ou
`process`. Essa classificação é só um agrupamento de descoberta na paleta — não restringe o que pode
ser inserido ou conectado no circuito. Somente entradas da seção ativa aparecem na listagem/busca da
paleta.

- `digital` é deliberadamente estreita: só a família `logic.*` (pastas `Portas`, `Aritmeticos`,
  `Memorias`, `Conversores`, `Outros logicos`, direto na raiz da aba — sem um nível `Logicos`
  envolvendo-as) e o bloco programável FPGA (pasta `GHDL`, `digital.generic_fpga`) pertencem a ela;
- todo o resto do catálogo legado sem `workspaceSection` explícito — MCUs, periféricos digitais
  (displays, RTC, cartão SD, Wi-Fi, encoder, touchpad etc.) e qualquer componente que não seja
  `logic.*`/`digital.*` — cai em `analog` por padrão; a divisão Analógico/Digital deixou de espelhar
  "é eletricamente digital?" e passou a significar só "é porta lógica pura ou bloco FPGA/GHDL?";
- o botão de inserção rápida de FPGA na barra de ferramentas do editor fica sempre disponível (o
  editor não tem abas, então não há gate por seção — ver [FEAT-005](fpga-ghdl.md));
- `control` (controladores, PID, blocos de controle, PLC/IEC 61131-3) e `process` (tanques, bombas,
  válvulas, motores, tubulações, sensores de processo) não possuem entradas enquanto as respectivas
  bibliotecas não forem implementadas;
- um item não pode ser duplicado entre seções para facilitar descoberta.

`workspaceSection` é o metadado extensível e preferencial do catálogo — é a ÚNICA fonte de
classificação; a paleta (renderização das abas, seleção, filtragem) nunca contém lógica condicional
por `typeId`/componente além dos dois prefixos fixos `logic.`/`digital.` usados como fallback. O valor
explícito sempre tem prioridade. A classificação por prefixo existe somente como compatibilidade para
entradas legadas sem o metadado, e produz apenas `analog`/`digital` — um componente novo destinado a
`control` ou `process` precisa declarar `workspaceSection` explicitamente; isso impede que um futuro
PLC, PID ou tanque seja classificado silenciosamente na seção errada. O mesmo contrato é propagado por
catálogos integrados, componentes externos e subcircuitos, sem lógica específica de renderização por
componente.

## Estado e persistência

A aba ativa é estado de navegação da própria Webview da paleta (`vscode.getState()`/`setState()`
locais a `palette.ts`), nunca compartilhada com a Webview do editor e nunca serializada no `.lsproj`.
Fechar/reabrir a paleta ou o editor não afeta o outro.

Estado persistido no formato anterior (aba principal + subaba, ou o antigo `WorkspaceSelection`
compartilhado com o editor) é migrado uma única vez na leitura pela mesma função
(`normalizeWorkspaceSelection`), preservando a aba em que o usuário estava: `Circuit/Analog →
analog`, `Circuit/Digital → digital`, `Process/Ctrl → control`, `Process/Autom → process`. Depois da
primeira leitura, só o formato achatado (`{ section }`) volta a ser persistido.

## Modularidade

Novas bibliotecas são adicionadas declarando a seção no catálogo e implementando o renderer/editor do
domínio quando necessário (dentro do MESMO canvas elétrico unificado, nunca um canvas separado por
seção). A filtragem da paleta não deve conter listas paralelas de componentes nem exigir um novo
painel para cada item.

## Aceitação

- existem exatamente 4 abas fixas na paleta, num único nível, sempre nesta ordem: `Analógico`,
  `Digital`, `Controle`, `Processo`;
- as abas ficam no topo da paleta, exibem somente ícone (sem texto visível) e o nome aparece só como
  tooltip/hint;
- `Analógico` é a seleção inicial e filtra a paleta para exibir todo o catálogo legado sem
  `workspaceSection` explícito, exceto `logic.*`/`digital.*` (MCUs, periféricos digitais, displays,
  sensores etc. incluídos);
- `Digital` filtra a paleta para exibir só `logic.*` (pastas `Portas`, `Aritmeticos`, `Memorias`,
  `Conversores`, `Outros logicos` direto na raiz, sem um nível `Logicos` agrupando-as) e o bloco
  programável FPGA na pasta `GHDL`;
- buscas e comandos visuais não fazem itens de outra seção reaparecerem na paleta;
- `Controle` e `Processo` existem como abas de filtro na paleta e permanecem vazias nesta entrega;
- o editor de esquemático nunca exibe abas, placeholder ou qualquer restrição de ferramenta por
  seção — todo o catálogo pode ser inserido e conectado no mesmo circuito a qualquer momento;
- trocar de aba na paleta nunca emite alteração de projeto, nunca modifica o `.lsproj` e nunca afeta
  o editor (seleção, viewport, componentes, fios);
- catálogo legado sem `workspaceSection` continua classificado em uma única seção, sempre
  `analog`/`digital` (nunca `control`/`process`), com `digital` restrita ao prefixo `logic.`/`digital.`;
- uma entrada com `workspaceSection` explícito é exibida somente na seção declarada;
- estado de navegação persistido no formato anterior é migrado preservando a aba do usuário;
- a filtragem (`palette.ts`/`workspace.ts`) não contém `if`/`switch` por `typeId`/componente além dos
  dois prefixos fixos `logic.`/`digital.` usados como fallback de classificação legada.

## Evidência automatizada

- `extension/src/ui/webview/workspace.test.ts`: ordem fixa das 4 abas, normalização/migração da
  seleção persistida, prioridade do metadado e classificação legada restrita a `analog`/`digital`
  (com `digital` limitada a `logic.`/`digital.`);
- `extension/src/ui/webview/paletteTree.test.ts`: isolamento rigoroso de `analog`/`digital` e
  ausência inicial de itens em `control`/`process`.
