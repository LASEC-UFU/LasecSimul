---
id: FEAT-011
kind: feature
status: active
dependsOn: [ARCH-001]
supersedes: []
---

# Workspace por domínio

## Hierarquia e navegação

A área de trabalho possui duas abas principais, sempre localizadas na sua borda inferior:

```text
Workspace
├── Circuit
│   ├── Analog
│   └── Digital
└── Process
    ├── Ctrl
    └── Autom
```

- `Circuit` é a aba principal inicial e `Analog` é sua subaba inicial;
- ao selecionar `Circuit`, somente as subabas `Analog` e `Digital` são oferecidas;
- ao selecionar `Process`, somente as subabas `Ctrl` e `Autom` são oferecidas;
- `Ctrl` é a subaba inicial de `Process`;
- a troca de aba cancela apenas ferramentas ou ligações interativas ainda incompletas. Ela não remove
  componentes, fios, viewport nem qualquer outro estado de autoria já confirmado.

`Analog` e `Digital` são duas projeções da mesma autoria elétrica. A troca entre elas não cria uma
cópia do circuito nem desmonta/remonta seu modelo. `Process` possui área própria; enquanto suas
funcionalidades não forem implementadas, `Ctrl` e `Autom` exibem uma área vazia e não alteram o
circuito ao serem visitadas.

## Separação do catálogo e das ferramentas

Cada entrada do catálogo pertence a exatamente uma seção: `analog`, `digital`, `ctrl` ou `autom`.
Somente entradas da seção ativa podem aparecer na paleta, em resultados de busca ou em atalhos de
inserção da barra de ferramentas.

- componentes e ferramentas de circuito analógico pertencem exclusivamente a `analog`;
- lógica digital, MCUs, periféricos digitais e o bloco programável FPGA pertencem exclusivamente a
  `digital`;
- `ctrl` e `autom` não possuem entradas enquanto as respectivas bibliotecas não forem implementadas;
- um item não pode ser duplicado entre seções para facilitar descoberta.

`workspaceSection` é o metadado extensível e preferencial do catálogo. O valor explícito sempre tem
prioridade. A classificação por famílias/type IDs existe somente como compatibilidade para entradas
legadas sem o metadado; componentes novos devem declarar seu destino. O mesmo contrato é propagado
por catálogos integrados, componentes externos e subcircuitos, sem lógica específica de renderização
por componente.

## Estado e persistência

A seleção das abas é estado de navegação da Webview, não autoria do projeto: pode ser restaurada pela
sessão visual, mas não suja nem é serializada no `.lsproj`. O documento de autoria e o estado do Core
continuam únicos e independentes da seção visível.

Ao introduzir conteúdo em `Ctrl` ou `Autom`, cada área deve manter seu próprio estado de autoria. A
navegação pode ocultar uma área, mas não pode apagá-la ou recriá-la desnecessariamente.

## Modularidade

Novas bibliotecas são adicionadas declarando a seção no catálogo e implementando o renderer/editor do
domínio quando necessário. A navegação, filtragem e sincronização entre editor e paleta não devem
conter listas paralelas de componentes nem exigir um novo painel para cada item.

## Aceitação

- as abas principais `Circuit` e `Process` ficam na parte inferior da área de trabalho;
- `Circuit/Analog` é a seleção inicial e exibe somente itens analógicos;
- `Circuit/Digital` exibe somente itens digitais, incluindo o bloco programável FPGA;
- buscas e comandos visuais não fazem itens de outra seção reaparecerem;
- `Process/Ctrl` e `Process/Autom` existem e permanecem vazias nesta entrega;
- alternar entre todas as abas preserva componentes, fios, seleção confirmada e viewport do circuito;
- trocar apenas a aba não emite alteração de projeto nem modifica o `.lsproj`;
- catálogo legado sem `workspaceSection` continua classificado em uma única seção;
- uma entrada com `workspaceSection` explícito é exibida somente na seção declarada.

## Evidência automatizada

- `extension/src/ui/webview/workspace.test.ts`: normalização da seleção, resolução da seção ativa,
  prioridade do metadado e classificação legada sem duplicação;
- `extension/src/ui/webview/paletteTree.test.ts`: isolamento rigoroso de `Analog`/`Digital` e ausência
  inicial de itens em `Ctrl`/`Autom`.
