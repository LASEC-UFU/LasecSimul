---
id: FEAT-010
kind: feature
status: planned
dependsOn: [FEAT-007, ADR-0007, SCHEMA-003]
supersedes: []
---

# Editor IEC 61131-3 e biblioteca comum de POUs

## Objetivo

Detalhar a experiência de autoria dos editores LD, FBD, ST, SFC e IL dentro do LasecSimul e, em particular, o mecanismo pelo qual um `FUNCTION_BLOCK` (ou `FUNCTION`) recém-criado em qualquer uma das cinco linguagens passa a existir imediatamente na biblioteca comum de blocos, visível e utilizável a partir das outras quatro.

[features/iec61131-plc.md](iec61131-plc.md) define o contrato de interoperabilidade cross-language, o pipeline de compilação e o `PlcNativeModule`. Esta especificação detalha a camada de UX/autoria que torna essa interoperabilidade **visível e imediata** para quem está editando: como o workspace é organizado, como o browser de blocos funciona e o que acontece, passo a passo, entre "o usuário termina de declarar a interface de um FB" e "esse FB aparece arrastável em uma network FBD ou em um rung LD".

## OpenPLC Editor v4 incorporado

Por decisão de [ADR-0007](../adr/0007-openplc-v4-incorporation-and-native-plc-pipeline.md), o LasecSimul **vendoriza diretamente** as peças de UI abaixo do OpenPLC Editor v4 ([Autonomy-Logic/openplc-editor](https://github.com/Autonomy-Logic/openplc-editor), GPL-3.0) para dentro da Webview, em vez de reimplementá-las do zero:

- `src/frontend/components/_organisms/explorer/project.tsx` organiza a árvore do projeto por **kind** do POU (Function, Function Block, Program, Data Type), não por linguagem; cada folha carrega apenas uma tag `PouLeafLang` (`il | st | ld | sfc | fbd | ...`) usada para abrir a aba certa, nunca para segregar onde o POU pode ser usado — árvore portada tal qual;
- `src/frontend/components/_organisms/graphical-editor` (LD e FBD, react-flow) e `src/frontend/components/_atoms/graphical-editor/{ladder,fbd}` são portados como os editores gráficos LD/FBD do LasecSimul;
- `src/frontend/components/_features/[workspace]/editor/monaco/configs/languages/il` é reaproveitado para o editor textual de IL; a mesma base Monaco serve ST;
- `src/frontend/store/slices/library/` distingue bibliotecas **system** (`bundled`, sempre ativas, não desabilitáveis por projeto) de bibliotecas **user** (instaladas por projeto, habilitadas/desabilitadas individualmente) — ambas convivem no mesmo pool de símbolos; o mesmo modelo de dados é portado para o store da Webview do LasecSimul;
- `src/middleware/shared/ports/library-types.ts` define `SystemLibraryPou` com `variables[]` tipadas (`class: input | output | local | inOut`, `type: base-type | derived-type | generic-type`) e uma flag `extensible` para funções IEC variádicas (`ADD`, `MUL`, `AND`, `MUX`), onde o editor gráfico desenha um handle "+" para crescer pinos — o mesmo sistema de tipos serve blocos de biblioteca e POUs do usuário e é portado como está;
- `_organisms/instances-editor` lista instâncias de FB dentro de um POU chamador independentemente da linguagem em que o FB foi implementado — portado tal qual.

**SFC é a exceção**: o OpenPLC Editor v4 não tem um editor SFC maduro (apenas placeholder de tela e ícones, sem lowering associado). O editor gráfico SFC deste documento — steps, transitions, actions — é implementação própria do LasecSimul, seguindo a mesma convenção visual/de organismo dos editores LD/FBD portados, para que o usuário não perceba qual editor é vendorizado e qual é nativo do LasecSimul.

Todo arquivo portado preserva o aviso de copyright/licença GPL-3.0 original do OpenPLC Editor v4, conforme o aviso de proveniência do ADR-0007. O LasecSimul não replica a arquitetura de processo/IPC do OpenPLC (Electron + backend Node separado); o editor IEC roda como uma superfície da própria Webview do LasecSimul, com os componentes de UI portados adaptados a esse host.

## Estrutura do workspace do editor

```text
+-- Explorer (árvore do projeto) ---+  +-- Editor (aba ativa) --------+
| Functions                          |  | LD | FBD | ST | SFC | IL   |
|   FC_SCALE          (fbd)          |  |  network/rung/texto/chart  |
| Function Blocks                    |  +----------------------------+
|   FB_PID             (st)          |
|   FB_MOTOR            (ld)         |  +-- Block browser -----------+
|   FB_SEQ              (sfc)        |  | busca                      |
| Programs                           |  | Funções IEC padrão          |
|   MAIN                 (st)        |  | Function Blocks IEC padrão  |
| Data Types                         |  | Bibliotecas instaladas      |
| Global Variable Lists              |  | POUs do projeto             |
+-------------------------------------+  +----------------------------+
```

A árvore do Explorer agrupa por `kind` (`function`, `functionBlock`, `program`, `dataType`), exatamente como em `iec61131-plc.md`. O browser de blocos é um painel separado, disponível a partir de qualquer editor gráfico ou textual aberto.

## Editores gráficos: LD, FBD, SFC

- `LD`: rungs com contatos, coils e blocos (FC/FB) inseridos em série/paralelo; IDs de nó/edge estáveis por `SCHEMA-003`;
- `FBD`: networks com nodes/ports/edges; blocos IEC padrão e POUs do usuário aparecem com a mesma aparência visual, diferenciados apenas por categoria no browser;
- `SFC`: steps, transitions e actions; uma action pode chamar um `FUNCTION`/instanciar um `FUNCTION_BLOCK` do projeto como qualquer outro POU;
- em todos os três, um bloco (FC/FB) é inserido por **arrastar do browser** ou por atalho de inserção com autocomplete pelo nome qualificado; a ferramenta nunca obriga o usuário a digitar/reescrever a assinatura manualmente;
- funções `extensible` (variádicas, ex. `ADD`) mostram um handle de expansão de pinos, unificando o tipo dos pinos extras com o último parâmetro declarado — mesmo comportamento independentemente da linguagem do bloco chamador.

## Editores textuais: ST e IL

- editor de código com highlighting, indentação e navegação a erro;
- autocomplete resolve POUs do projeto e de bibliotecas pelo mesmo symbol table usado pelos editores gráficos — nenhuma lista de símbolos é exclusiva de ST/IL;
- IL recebe indicação visual de legado na UI (tooltip/badge), mas usa o mesmo pipeline de resolução e o mesmo browser de blocos que as demais linguagens, sem editor ou fluxo de menor capacidade.

## Browser de blocos comum às cinco linguagens

O browser é uma única lista, filtrável mas nunca particionada por linguagem de implementação:

```text
Browser
├── Funções IEC padrão         (biblioteca de sistema, bundled)
├── Function Blocks IEC padrão (biblioteca de sistema, bundled)
├── Bibliotecas do projeto     (instaladas, habilitadas por projeto)
└── POUs do projeto
    ├── Functions
    └── Function Blocks
```

Regras:

- a categoria "POUs do projeto" é derivada ao vivo do symbol table do projeto aberto, não de um artefato compilado;
- um filtro por linguagem de origem é puramente de exibição — nunca controla se o bloco pode ser inserido no editor atual;
- namespacing evita colisão entre nome de biblioteca instalada e POU do projeto; conflito de símbolo qualificado é erro de build, não resolução silenciosa por prioridade.

## Publicação automática de um `FUNCTION_BLOCK` novo

Este é o comportamento central desta especificação: **não existe passo de publicar/exportar**. O fluxo observável é:

1. o usuário cria um novo POU, escolhe `kind = functionBlock` (ou `function`) e uma das cinco linguagens de implementação;
2. assim que o POU tem nome válido e `interface` (inputs/outputs/inOut) sem erro de tipo, ele aparece na árvore do Explorer sob "Function Blocks" **e** no browser de blocos comum, mesmo que o corpo ainda esteja incompleto ou com erro;
3. a partir desse momento o FB é arrastável/inserível a partir de qualquer editor LD, FBD, ST, SFC ou IL aberto no mesmo projeto — não é necessário rodar Build/Rebuild do projeto inteiro para que ele fique visível;
4. instanciar o FB em outro POU só passa a compilar com sucesso quando o corpo do FB também compila; até lá, o Build reporta o erro localizado no POU de origem, sem impedir a edição de quem o está instanciando;
5. isso é possível porque existe **um único symbol table incremental** por projeto (ADR-0006) atualizado a cada save de POU, não cinco symbol tables por linguagem nem um symbol table que só existe pós-Build;
6. renomear o FB mantendo o `pouId` preserva toda referência já colocada em outros editores — nada é resolvido por nome exibido;
7. remover o FB não apaga silenciosamente as instâncias existentes: elas ficam com referência órfã diagnosticável (mesmo padrão de `orphan bindings` de `iec61131-plc.md`), reportada no editor onde aparecem;
8. alterar a interface do FB de forma incompatível (remover/renomear pino, mudar tipo) marca as instâncias existentes como pendentes de resolução antes do próximo Build bem-sucedido, sem travar a edição de outras partes do projeto;
9. bibliotecas instaladas (system ou de projeto) seguem um fluxo diferente e mais pesado — import de arquivo, versionamento, habilitação por projeto — porque são pacotes externos; POUs do projeto nunca passam por esse fluxo, pois já nascem dentro do mesmo symbol table.

```text
usuário salva interface válida de FB_PID (ST)
        |
        v
symbol table do projeto atualizado (incremental, sem Build completo)
        |
        +--> Explorer: FB_PID aparece em "Function Blocks"
        +--> Browser: FB_PID aparece em "POUs do projeto"
        |
        v
FB_PID arrastável em LD / FBD / SFC; resolvível por autocomplete em ST / IL
```

## Gestão de instâncias

Um POU chamador (LD, FBD, ST, SFC ou IL) mantém sua própria lista de instâncias de `FUNCTION_BLOCK` (nome da instância : tipo do FB), visível em um painel de variáveis/instâncias comum às cinco linguagens. Duas instâncias do mesmo tipo em POUs diferentes — ou no mesmo POU — nunca compartilham estado; isso é reafirmado aqui como requisito de UX (o painel nunca lista/edita estado como se fosse compartilhado) e já é requisito de runtime em `iec61131-plc.md`.

## Sincronização entre abas abertas

- editar o corpo de um POU não invalida abas abertas de POUs chamadores, a menos que a interface mude de forma incompatível;
- quando isso ocorre, cada aba afetada recebe um indicador local de "precisa resolver" no(s) nó(s)/linha(s) específicos, sem fechar ou recarregar a aba inteira;
- Build/Rebuild permanece a operação que valida o projeto inteiro e produz o `PlcNativeModule` (via ST canônico e STruCpp); o browser e o autocomplete refletem o estado de autoria mais recente independentemente de quando o último Build ocorreu.

## Aceitação

- criar um `FUNCTION_BLOCK` em qualquer uma das cinco linguagens faz seu bloco aparecer no Explorer e no browser de blocos comum sem nenhuma ação manual de publicar/exportar;
- o mesmo bloco é arrastável/inserível a partir das outras quatro linguagens antes de um Build completo do projeto, desde que sua `interface` seja válida;
- um filtro de linguagem no browser nunca impede a inserção de um bloco de outra linguagem de origem;
- renomear o FB mantendo o `pouId` preserva todas as instâncias já colocadas em outros editores/linguagens;
- remover o FB não apaga instâncias existentes; produz diagnóstico de referência órfã localizado, nunca falha silenciosa;
- alterar a interface de forma incompatível marca as instâncias existentes como pendentes de resolução, sem bloquear a edição do resto do projeto;
- duas instâncias do mesmo FB, no mesmo POU ou em POUs diferentes, nunca compartilham estado exibido ou simulado;
- bibliotecas instaladas (system/projeto) e POUs do projeto aparecem no mesmo browser, namespaced separadamente, sem colisão silenciosa de símbolo qualificado.
