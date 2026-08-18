---
id: FEAT-011
kind: feature
status: active
dependsOn: [ARCH-001]
supersedes: []
---

# Workspace por domínio

## Hierarquia e navegação

A área de trabalho possui exatamente 4 abas fixas, num único nível, sempre localizadas na sua borda
inferior e sempre nesta ordem:

```text
Workspace
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
- a troca de aba cancela apenas ferramentas ou ligações interativas ainda incompletas. Ela não remove
  componentes, fios, viewport nem qualquer outro estado de autoria já confirmado;
- selecionar a aba já ativa é no-op: não recria canvas, placeholder nem estado da paleta, e não
  reenvia sincronização de estado.

`Analógico` e `Digital` são duas projeções da mesma autoria elétrica. A troca entre elas não cria uma
cópia do circuito nem desmonta/remonta seu modelo, e usam o canvas elétrico normal. `Controle` e
`Processo` ainda não têm editor próprio; enquanto suas funcionalidades não forem implementadas, ambas
exibem a mesma área de placeholder genérica e não alteram o circuito ao serem visitadas.

## Separação do catálogo e das ferramentas

Cada entrada do catálogo pertence a exatamente uma seção: `analog`, `digital`, `control` ou
`process`. Somente entradas da seção ativa podem aparecer na paleta, em resultados de busca ou em
atalhos de inserção da barra de ferramentas.

- componentes e ferramentas de circuito analógico pertencem exclusivamente a `analog`;
- lógica digital, MCUs, periféricos digitais e o bloco programável FPGA pertencem exclusivamente a
  `digital`;
- `control` (controladores, PID, blocos de controle, PLC/IEC 61131-3) e `process` (tanques, bombas,
  válvulas, motores, tubulações, sensores de processo) não possuem entradas enquanto as respectivas
  bibliotecas não forem implementadas;
- um item não pode ser duplicado entre seções para facilitar descoberta.

`workspaceSection` é o metadado extensível e preferencial do catálogo — é a ÚNICA fonte de
classificação; a navegação (renderização das abas, seleção, placeholder) nunca contém lógica
condicional por `typeId`/componente. O valor explícito sempre tem prioridade. A classificação por
famílias/type IDs existe somente como compatibilidade para entradas legadas sem o metadado, e produz
apenas `analog`/`digital` — um componente novo destinado a `control` ou `process` precisa declarar
`workspaceSection` explicitamente; isso impede que um futuro PLC, PID ou tanque seja classificado
silenciosamente na seção errada. O mesmo contrato é propagado por catálogos integrados, componentes
externos e subcircuitos, sem lógica específica de renderização por componente.

## Estado e persistência

A seleção da aba é estado de navegação da Webview, não autoria do projeto: pode ser restaurada pela
sessão visual (`vscode.getState()`), mas não suja nem é serializada no `.lsproj`. O documento de
autoria e o estado do Core continuam únicos e independentes da seção visível.

Estado persistido no formato anterior (aba principal + subaba) é migrado uma única vez na leitura,
preservando a aba em que o usuário estava: `Circuit/Analog → analog`, `Circuit/Digital → digital`,
`Process/Ctrl → control`, `Process/Autom → process`. Depois da primeira leitura, só o formato achatado
(`{ section }`) volta a ser persistido.

Ao introduzir conteúdo em `Controle` ou `Processo`, cada área deve manter seu próprio estado de
autoria. A navegação pode ocultar uma área, mas não pode apagá-la ou recriá-la desnecessariamente.

## Modularidade

Novas bibliotecas são adicionadas declarando a seção no catálogo e implementando o renderer/editor do
domínio quando necessário. A navegação, filtragem e sincronização entre editor e paleta não devem
conter listas paralelas de componentes nem exigir um novo painel para cada item.

## Aceitação

- existem exatamente 4 abas fixas, num único nível, sempre nesta ordem: `Analógico`, `Digital`,
  `Controle`, `Processo`;
- as abas ficam na parte inferior da área de trabalho, exibem somente ícone (sem texto visível) e o
  nome aparece só como tooltip/hint;
- `Analógico` é a seleção inicial e exibe somente itens analógicos;
- `Digital` exibe somente itens digitais, incluindo o bloco programável FPGA;
- buscas e comandos visuais não fazem itens de outra seção reaparecerem;
- `Controle` e `Processo` existem como abas de primeiro nível e permanecem vazias nesta entrega;
- alternar entre todas as abas preserva componentes, fios, seleção confirmada e viewport do circuito;
- selecionar a aba já ativa não recria canvas, placeholder, nem estado da paleta, e não reenvia
  sincronização de estado;
- trocar apenas a aba não emite alteração de projeto nem modifica o `.lsproj`;
- catálogo legado sem `workspaceSection` continua classificado em uma única seção, sempre
  `analog`/`digital`, nunca `control`/`process`;
- uma entrada com `workspaceSection` explícito é exibida somente na seção declarada;
- estado de navegação persistido no formato anterior é migrado preservando a aba do usuário;
- a navegação (`main.ts`/`workspace.ts`) não contém `if`/`switch` por `typeId`/componente — apenas
  leitura de `workspaceSection`.

## Evidência automatizada

- `extension/src/ui/webview/workspace.test.ts`: ordem fixa das 4 abas, normalização/migração da
  seleção persistida, prioridade do metadado e classificação legada restrita a `analog`/`digital`;
- `extension/src/ui/webview/paletteTree.test.ts`: isolamento rigoroso de `analog`/`digital` e
  ausência inicial de itens em `control`/`process`.
