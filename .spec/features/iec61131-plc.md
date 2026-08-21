---
id: FEAT-007
kind: feature
status: active
dependsOn: [FEAT-001, ARCH-002, ARCH-003, ARCH-006, SCHEMA-003, ADR-0007]
supersedes: []
---

# PLC IEC 61131-3 integrado ao LasecSimul

## Objetivo

O LasecSimul terá um **PLC virtual nativo**, editado, compilado, carregado e simulado dentro do próprio produto. O usuário não precisa abrir uma IDE PLC externa nem executar um OpenPLC Runtime separado para simular o controle.

O bloco PLC do canvas recebe um `PlcNativeModule` produzido pelo toolchain IEC do LasecSimul (LD/FBD/SFC baixados para ST, compilados por STruCpp para C++17 e por um toolchain C++ real). O Core executa esse módulo em um worker isolado, com tempo virtual, ciclo de varredura determinístico e estado isolado por instância.

## OpenPLC v4 incorporado

Por decisão de [ADR-0007](../adr/0007-openplc-v4-incorporation-and-native-plc-pipeline.md), o LasecSimul **incorpora diretamente** código-fonte do OpenPLC Editor v4 e do STruCpp, sob GPL-3.0-or-later, em vez de apenas estudar seus conceitos:

- os editores gráficos **LD** e **FBD** são portados do OpenPLC Editor v4 (`components/_organisms/graphical-editor`, `components/_atoms/graphical-editor/{ladder,fbd}`) para a Webview do LasecSimul;
- a configuração Monaco de **ST**/**IL** (`components/_features/[workspace]/editor/monaco/configs/languages/il`) é reaproveitada para os editores textuais;
- o lowering `LD -> ST` e `FBD -> ST` (`backend/shared/transpilers/st-transpiler/walker/{ld,fbd}.ts`, `emit/pou-graphical.ts`) é reaproveitado; **SFC não tem equivalente maduro no OpenPLC v4** (apenas placeholder de tela) e é implementado como código próprio do LasecSimul, produzindo o mesmo contrato de saída (ST canônico) que os walkers de LD/FBD;
- o compilador **STruCpp** (ST -> C++17) é vendorizado como o backend de compilação; a execução final continua isolada em um worker do Core do LasecSimul (ver "Scan e tasks"), nunca dependendo de um OpenPLC Runtime externo em produção;
- a separação entre autoria, compilação e runtime é preservada; a execução final pertence sempre ao Core do LasecSimul.

Cada arquivo vendorizado preserva seu aviso de copyright/licença original. A `LasecSimul PLC Runtime Library Exception` (`LICENSE-RUNTIME-EXCEPTION.txt`, na raiz do repositório) garante que o programa PLC compilado a partir do projeto IEC de um usuário — não o compilador em si — pode ser distribuído sob qualquer licença.

## Cinco linguagens obrigatórias

As cinco linguagens abaixo são de primeira classe no LasecSimul:

- `LD` — Ladder Diagram;
- `FBD` — Function Block Diagram;
- `ST` — Structured Text;
- `SFC` — Sequential Function Chart;
- `IL` — Instruction List, mantida intencionalmente para ensino, legado e interoperabilidade.

Nenhuma delas pode formar um ecossistema isolado. A linguagem define apenas o **corpo de implementação** do POU; a interface do POU é neutra em relação à linguagem.

## Interoperabilidade entre linguagens

Todo `FUNCTION` e `FUNCTION_BLOCK` definido em uma das cinco linguagens deve poder ser utilizado em qualquer uma das outras, desde que os tipos sejam compatíveis.

Exemplos obrigatórios:

```text
FB_PID_ST       implementado em ST  -> instanciável em LD, FBD, SFC e IL
FB_MOTOR_LD     implementado em LD  -> instanciável em ST, FBD, SFC e IL
FB_SEQ_SFC      implementado em SFC -> instanciável em LD, FBD, ST e IL
FC_SCALE_FBD    implementado em FBD -> chamável em LD, ST, SFC e IL
FB_LEGACY_IL    implementado em IL  -> instanciável em LD, FBD, ST e SFC
```

Regras:

- `FUNCTION` não possui memória persistente por instância;
- `FUNCTION_BLOCK` possui memória persistente e cada instância mantém estado independente;
- `PROGRAM` é ligado a uma task/resource e não é tratado como um bloco chamável comum;
- `VAR_INPUT`, `VAR_OUTPUT` e `VAR_IN_OUT` formam a assinatura pública;
- tipos derivados, enums, structs, arrays e tipos IEC suportados usam o mesmo sistema de tipos em todas as linguagens;
- o browser de blocos de LD/FBD/SFC mostra POUs do projeto sem filtrar pela linguagem em que foram implementados;
- ST e IL recebem autocomplete/resolução de símbolos para os mesmos POUs;
- nomes, tipos e direção das portas são resolvidos pelo `pouId`/`ioId`, nunca pela posição visual do pino.

## Fluxo de uso cross-language

Exemplo esperado no produto:

1. o usuário cria `FB_PID` como `FUNCTION_BLOCK` em **ST**;
2. declara `SP`, `PV` e `EN` como entradas e `CV` como saída;
3. compila o projeto IEC;
4. `FB_PID` passa a existir na biblioteca comum de POUs;
5. ao abrir um programa em **FBD**, o usuário arrasta `FB_PID` para a network;
6. ao abrir um programa em **LD**, o mesmo `FB_PID` pode ser inserido como bloco em um rung;
7. em **IL** ou **ST**, o mesmo símbolo é resolvido pelo compilador/autocomplete;
8. em **SFC**, uma action pode invocar/usar a mesma instância conforme a semântica do POU;
9. em todos os casos o linker aponta para a mesma implementação compilada de `FB_PID`; não existe cópia ou reescrita manual do algoritmo.

O mesmo fluxo vale invertendo as linguagens: um `FUNCTION_BLOCK` criado em LD, FBD, SFC ou IL também entra na mesma biblioteca e pode ser usado por um POU ST.

## Modelo de autoria

Cada POU possui duas partes independentes:

```text
PouDefinition
├── interface        # neutra de linguagem
│   ├── inputs
│   ├── outputs
│   ├── inOut
│   ├── locals
│   └── returnType?  # FUNCTION
└── implementation
    ├── language: LD | FBD | ST | SFC | IL
    └── body
```

Trocar a linguagem de implementação exige conversão explícita; nunca se perde ou reinterpreta silenciosamente o corpo original.

## Pipeline de compilação

```text
LD  ──> walker ld->st (vendorizado)   ──┐
FBD ──> walker fbd->st (vendorizado)  ──┤
SFC ──> lowering sfc->st (próprio)    ──┼─> ST canônico único ──> STruCpp (vendorizado) ──> C++17
ST  ──> autoral do usuário            ──┤                                                     |
IL  ──> autoral do usuário (via ST)   ──┘                                                      v
                                                                                     toolchain C++ real
                                                                                                 |
                                                                                                 v
                                                                                       PlcNativeModule
```

Contratos:

1. LD, FBD e SFC baixam para **ST textual canônico**; ST/IL autorais entram no mesmo compilador sem etapa de lowering adicional;
2. o front-end de lowering de cada linguagem gráfica resolve chamadas de POUs exclusivamente por interface/símbolo (`pouId`), independentemente da linguagem do corpo chamado;
3. o backend de execução é **STruCpp** (vendorizado, GPL-3.0) compilando ST para C++17, seguido de um toolchain C++ real produzindo `PlcNativeModule`;
4. compilação é uma operação de build, nunca executada no hot path do scan;
5. artefatos são endereçados por hash de conteúdo, versão do toolchain STruCpp e versão do toolchain C++;
6. o mesmo symbol table único (ADR-0007) resolve POUs de todas as cinco linguagens antes da geração de ST — não existem cinco compiladores independentes, mesmo com quatro linguagens roteadas por ST.

Baixar LD/FBD/SFC para ST comum é uma decisão deliberada: o runtime não terá cinco interpretadores diferentes e a interoperabilidade não depende de tradução textual entre pares de linguagens.

## `PlcNativeModule`

O artefato compilado é imutável e contém, no mínimo:

```text
PlcNativeModule
├── formatVersion
├── strucppVersion
├── cxxToolchainVersion
├── sourceHash
├── artifactHash
├── nativeBinaryRef      # biblioteca/executável do worker PLC
├── symbolTable
├── dataTypeTable
├── pouTable
├── taskTable
├── exportedIo[]
│   ├── ioId
│   ├── name
│   ├── direction
│   ├── iecType
│   ├── width
│   └── unit?
├── initialMemoryImage
├── retainLayout
└── debugMap        # ST gerado/autoral <-> POU/linguagem/origem
```

O mesmo artefato pode ser compartilhado read-only por várias instâncias do worker. Memória, timers, contadores, estados de FB, SFC, `RETAIN`, force e imagens de I/O pertencem à instância dentro do worker, nunca ao processo do Core.

## Bloco PLC no canvas

O componente `PLC` pode ser inserido mesmo sem código:

```text
+------------------+
|       PLC        |
|  no program      |
+------------------+
```

Nesse estado ele possui **zero entradas e zero saídas**.

Após compilar/carregar um `PlcNativeModule`, os pinos são criados a partir de `exportedIo[]`:

```text
 DI_0  ──> | PLC | ──> DO_0
 AI_0  ──> |     | ──> AO_0
```

Regras de atualização:

- `ioId` é estável e é a identidade da conexão;
- renomear uma variável mantendo `ioId` preserva a ligação;
- remover um I/O transforma ligações existentes em `orphan bindings` diagnosticáveis; nunca remapeia para outro pino por índice;
- alterar tipo/largura invalida bindings incompatíveis antes de `RUN`;
- carregar novo artefato só publica a nova interface com a simulação parada na primeira implementação.

## Edição integrada

O workspace IEC pertence ao LasecSimul e oferece criação de `PROGRAM`, `FUNCTION` e `FUNCTION_BLOCK`, editor textual para ST/IL, editor gráfico para LD/FBD/SFC, tabela de variáveis/interfaces comum às cinco linguagens, data types, GVLs, resources, tasks, Build/Rebuild com diagnóstico, e watch/trace/force com source map de execução sem colocar lógica de simulação na Webview.

O detalhamento de UX dos cinco editores, do browser de blocos comum e do mecanismo pelo qual um `FUNCTION_BLOCK` recém-criado fica imediatamente disponível para as outras quatro linguagens está em [features/iec61131-editor.md](iec61131-editor.md).

## Scan e tasks

Cada `PlcNativeModule` roda em um **worker próprio**, no mesmo padrão coordenador/workers limitados de ADR-0003 já usado para o worker Python (`features/python-runtime.md`) e para o processo GHDL (`features/fpga-ghdl.md`). O Core não faz `dlopen`/`LoadLibrary` do módulo nativo dentro do seu próprio processo.

Para cada ativação de task, o Scheduler executa uma barreira determinística sobre IPC com o worker, análoga ao `STEP_BATCH` do worker Python:

1. `PlcInputLatch`: copiar slots conectados para a imagem de entrada e enviar ao worker;
2. `PlcTaskEvaluate`: o worker executa o código nativo dos `PROGRAM`s/POUs associados para aquele timestamp;
3. `PlcOutputCommit`: o worker devolve a imagem de saída, publicada nos slots conectados;
4. observar/debuggar somente estados já commitados e devolvidos pelo worker.

Todos os PLCs que vencem no mesmo `timestampNs` fazem latch antes que qualquer saída PLC daquele instante seja publicada. Isso remove dependência acidental da ordem dos componentes do canvas. O Core fornece o timestamp; o worker não consulta wall clock para semântica, mesma regra já aplicada ao worker Python.

Timers IEC (`TON`, `TOF`, `TP`), contadores e SFC usam o tempo virtual do Scheduler. `pause`, aceleração, step e execução headless não podem depender de wall clock.

## Estado, RETAIN e reset

Cada instância possui:

- input image;
- output image;
- memória local/global runtime;
- instâncias de `FUNCTION_BLOCK`;
- estado de steps/actions SFC;
- timers e counters;
- área `RETAIN`/`PERSISTENT` quando habilitada;
- tabela de force/watch.

`Cold Reset`, `Warm Reset` e política de `RETAIN` devem ter semântica explícita e testes próprios. O projeto persiste autoria e configuração; checkpoints de runtime são uma feature separada.

## Segurança e isolamento

Por ADR-0007, o isolamento passa de validação em nível de VM (ADR-0006, superseded) para isolamento em nível de **processo do worker**, mesma admissão já feita para o worker Python: código nativo compilado não é sandbox de segurança forte por construção.

- `PlcNativeModule` malformado, com hash/versão de toolchain incompatível, é rejeitado antes de subir o worker e antes de publicar o plano;
- crash ou timeout do worker pausa a(s) instância(s) PLC afetada(s), marca o domínio como `Faulted` e não derruba o Core, mesmo contrato de falha do worker Python;
- uma instância PLC não acessa memória de outra porque cada `PlcNativeModule`/instância vive em seu próprio worker/processo, não por checagem de VM;
- SharedHost deve executar o worker sob identidade/containment do usuário, com workdir, ambiente, filesystem e rede definidos pelo perfil de implantação — mesma regra do worker Python;
- recursão ilimitada e uso de memória são limitados por watchdog e limites de processo (ulimits/job objects) do worker, não por validação de opcode;
- compilador (STruCpp vendorizado) e cache de build não mantêm estado mutável de sessão dentro do artefato publicado.

## Compatibilidade futura

PLCopen XML e importadores/atualizações do OpenPLC v4/STruCpp podem ser adicionados como formatos de intercâmbio e atualizações de toolchain vendorizado. Eles nunca substituem o schema canônico do LasecSimul nem o `PlcNativeModule` publicado.

## Aceitação

- LD, FBD, ST, SFC e IL podem criar `FUNCTION` e `FUNCTION_BLOCK` válidos;
- matriz **5×5** automatizada: POU implementado em cada linguagem é chamado/instanciado com sucesso a partir de cada uma das cinco linguagens;
- um FB stateful chamado a partir de outra linguagem preserva estado por instância e não compartilha memória entre instâncias;
- uma alteração apenas da linguagem do chamador não muda o resultado numérico/booleano do POU chamado;
- bloco PLC recém-inserido tem zero pinos; após carregar `PlcNativeModule`, os pinos refletem exatamente `exportedIo[]`;
- recompilar com rename e mesmo `ioId` preserva ligação; remoção gera orphan diagnosticável;
- scan é reproduzível com 1, 2 e N workers;
- timers e SFC produzem o mesmo resultado em tempo real, acelerado, step e headless;
- erro de compilação preserva o último `PlcNativeModule` válido e não corrompe o runtime ativo;
- nenhuma das cinco linguagens exige um runtime próprio;
- toda simulação PLC ocorre em um worker do LasecSimul, sem depender de um OpenPLC Runtime externo;
- crash/timeout do worker PLC não derruba o Core nem outras instâncias PLC/domínios;
- um projeto IEC compilado pelo usuário produz um `PlcNativeModule` que o usuário pode distribuir sob a licença de sua escolha, conforme a LasecSimul PLC Runtime Library Exception.
