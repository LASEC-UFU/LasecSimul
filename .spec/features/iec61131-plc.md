---
id: FEAT-007
kind: feature
status: active
dependsOn: [FEAT-001, ARCH-002, ARCH-003, ARCH-006, ARCH-009, SCHEMA-003, ADR-0007]
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

Estado (2026-10-10, etapa 1, ver `docs/clp-etapa1-st.md`): ST de ponta a ponta no produto. Compilar no editor e ao Rodar via `lasecsimul-core --plc-compile`, cache por hash, diagnóstico com POU e linha do corpo, tabela de variáveis com `ioId` estável, uma TASK cíclica por recurso executando uma instância de PROGRAM, pinos do bloco derivados da interface antes de compilar, monitor com escrever/forçar/liberar/reiniciar. STruCpp roda só com as bibliotecas da norma e os blocos adicionais do OpenPLC (a OSCAT colide com nomes de FBs do usuário). O instalador Windows leva um g++ mínimo (`bundled/plc/ucrt64`); o `.deb` depende de `g++`.

Etapa 2 (2026-10-10, `docs/clp-etapa2-il.md`): IL completa pela 3ª edição (seção 7.2) traduzida para o ST canônico com resultado corrente tipado, modificadores N/C/(, rótulos e JMP (máquina de estados `WHILE`/`CASE`), CAL formal, operadores de entrada de FB, funções com o CR como primeiro argumento ou formais, RET; diagnósticos com POU e linha IL; programas IL executados no Core real.

Etapa 3 (2026-10-10, `docs/clp-etapa3-sfc.md`): SFC pela seção 6.7 com editor gráfico na notação da norma; controle das ações pelo ACTION_CONTROL da norma (3ª ed., saídas Q e A), regras de evolução 6.7.5, divergências/convergências seletivas (prioridade esquerda→direita ou numerada) e simultâneas, `PASSO.X`/`PASSO.T`, `ACAO.Q`/`ACAO.A`; ordem interna do ciclo (ações da situação atual, depois transições, uma evolução por ciclo) documentada como escolha da implementação; programas SFC executados no Core real.

Etapa 4 (2026-10-10, `docs/clp-etapa4-ld.md`): LD pela seção 8.2 com editor gráfico em grade por rede; tabelas 74 (barras, ligação horizontal e vertical = OU), 75 (contatos NA, NF, P, N e de comparação), 76 (bobina, negada, set, reset, P, N; sem as retentivas da 2ª ed.), 18 (EN/ENO) e 73 (salto e retorno); redes de cima para baixo, elemento só depois das suas entradas; fluxo de energia no monitor; programas LD executados no Core real. O formato antigo de LD (nós/arestas) segue lido quando não há `rungs`.

Etapa 5 (2026-10-11, `docs/clp-etapa5-fbd.md`): editor FBD por redes, nós móveis, junções gráficas para distribuir sinais e ligações de realimentação com atraso de um scan e valor inicial configurável; operadores BOOL, aritméticos e de comparação, tipos IEC genéricos/variádicos, browser comum de POUs e lowering determinístico com chamadas de FB/FUNCTION por portas formais. Erros de portas, referências, ciclos sem atraso, variáveis e tipos são reportados. Execução no Core real, isolamento de instâncias, realimentação e matriz de linguagens 5×5 passaram.

Etapa 6 (2026-10-11, integração parcial, `docs/clp-etapa1-st.md`): tipos definidos pelo usuário, GVL/`VAR_EXTERNAL`, edição RETAIN, Cold/Warm Reset e hot reload quando interface e período da TASK não mudam. Tasks por evento concluídas na etapa 12; múltiplas tasks na etapa 10; persistência durável RETAIN por scan/evento na etapa 11.

Etapa 7 (2026-10-11, barreira de scans): o Core reúne os PLCs vencidos no mesmo timestamp, coleta as entradas de todo o lote antes de avaliar os workers e publica as saídas somente depois das avaliações, com ordem estável pelo índice do componente. O teste de integração usa fontes e destinos independentes e confirma a mesma saída TON e o timestamp de 700 ms para 1, 2 e 5 workers. Isso cobre configurações representativas; não é prova para qualquer N nem para todas as ordenações possíveis.

Etapa 8 (2026-10-11, monitor composto): o parser do artefato lê alias, STRUCT, ARRAY e definições de FUNCTION_BLOCK do ST canônico; o driver publica campos e elementos escalares por caminho qualificado; o workspace oferece esses mesmos caminhos no watch/force. Arrays longos expõem até 2048 posições ao monitor. Build nativo e SCAN/GET no worker real confirmaram campos de struct, elemento indexado e estado de FB.

Etapa 9 (2026-10-11, seleção do POU de entrada): quando o ST canônico contém vários PROGRAMs, o compilador escolhe agora o POU correspondente ao nome do arquivo de entrada, em vez do primeiro PROGRAM encontrado. O teste nativo cobre um HELPER antes do MAIN e confirmou que somente os pinos do MAIN são exportados.

Etapa 10 (2026-10-11, tasks cíclicas): o `PlcNativeModule` transporta configuração, tasks (período em ns e prioridade) e ligações de instâncias. O worker instancia a CONFIGURATION da STruCpp e despacha as instâncias nos vencimentos virtuais, em ordem de prioridade e nome; o Core agenda a união dos vencimentos cíclicos, mesmo para períodos que não são múltiplos. O teste nativo compilou duas instâncias do mesmo PROGRAM em tasks de 5 ms e 10 ms: ao avançar de 5 ms para 20 ms, confirmou quatro execuções da instância FAST, duas da SLOW e a ordem por prioridade. O teste de integração do Core confirmou scans em 5/10/15/20 ms apesar de um fallback de 100 ms. A UI agora edita e valida listas completas de resources, tasks cíclicas e instâncias; tasks por evento foram concluídas na etapa 12.

Etapa 11 (2026-10-11, retenção no lifecycle do worker): o `PlcNativeModule` publica `retainLayout` com nomes e tipos IEC; o protocolo exporta/importa o snapshot tipado do PROGRAM de entrada. Após cada scan/evento e alteração via SET, o Core sincroniza o snapshot em arquivo temporário, sincroniza os dados e publica por rename atômico; no Linux também sincroniza o diretório. No Windows usa `FlushFileBuffers` e `MOVEFILE_WRITE_THROUGH`. Ao reabrir o projeto, o worker restaura os valores antes do próximo scan. Os testes compilam um contador `DINT RETAIN`, confirmam restauração após encerramento limpo e após `forceKill()` abrupto do worker, e verificam que Cold Reset apaga o checkpoint. Em caso de falha de persistência, o runtime transita para Faulted em vez de publicar saída sem checkpoint confirmado.

Etapa 12 (2026-10-11, tasks por evento): o lowering do projeto emite `TASK ... (SINGLE := BOOL_INPUT, PRIORITY := ...)`; parser/artefato preservam variável e prioridade; editor/runtime config valida uma entrada `BOOL` exportada. O Core detecta borda de subida após estabilizar entradas, não agenda polling para módulos somente por evento e despacha `EVENT` no worker com latch de entrada e commit após avaliação. Tasks do mesmo instante seguem prioridade decrescente e nome estável; o worker executa somente a task de evento solicitada, sem consumir vencimentos cíclicos. Testes de lowering, dispatch do worker e integração Core/sinal confirmaram autoria, validação, ausência de fallback periódico e disparo na borda. Teste de integração `plc_session_integration` passou.

Etapa 13 (2026-10-11, monitor de FBs IEC da biblioteca padrão): o driver expõe os membros públicos de TON/TOF/TP, R_TRIG/F_TRIG, SR/RS e CTU/CTD/CTUD como caminhos qualificados; o workspace oferece os mesmos campos em watch/force sem exigir a definição do FB no projeto. O teste nativo usa `GET HELLO.TIMER0.Q` sobre o TON da biblioteca; o teste de build cobre a lista de watch.

Etapa 14 (2026-10-11, equivalência de avanço virtual): o cenário PLC com TON produziu a mesma saída e o mesmo tempo final em `runUntil` (headless), passos explícitos e perfis Desktop/SharedHost. Cenários realtime e acelerado usam o Scheduler vivo; o teste de integração passou três execuções consecutivas sob CTest após corrigir a ordem de locks do `stopSimulation()`.

Etapa 15 (2026-10-11, identidade e containment de lifecycle): cada componente PLC recebe `runtimeInstanceId` estável, `sessionExecutionId` por execução e `launchGeneration` monotônica. HELLO valida os campos; eventos detalhados usam o recorder causal compartilhado, e trace OFF mantém ausência de recorder/buffer por PLC. O Scheduler rearma tasks após stop/start. O budget limita memória do worker via Job Object no Windows e `RLIMIT_AS` no Linux. SharedHost agora cria diretório exclusivo por worker sob `LASECSIMUL_PLC_SHAREDHOST_WORK_ROOT` (ou temporário privado por padrão), usa ambiente mínimo, remove o diretório no encerramento e aplica contenção de filesystem/rede: AppContainer LPAC sem capabilities de rede e Job Object com limite de processos no Windows; Landlock e seccomp fail-closed no Linux, incluindo bloqueio de rede, criação de processos e sinais a outros processos. No Linux, a política Landlock/seccomp é preparada no pai e aplicada por worker iniciado com `vfork`; o filho faz somente chamadas de sistema até `execve`, fecha todos os descritores herdados e falha fechado se `close_range` não estiver disponível. O teste probe no Windows confirmou bloqueio de leitura de arquivo fora da workdir, loopback e variável secreta do Core; verificou também limpeza da workdir configurável.

Etapa 16 (2026-10-11, determinismo e validacao integrada): CTest confirma o mesmo resultado TON e timestamp final com 1, 2 e 5 workers; cenarios ao vivo realtime/acelerado passaram em tres repeticoes apos corrigir o encerramento do Scheduler. A matriz IEC 5x5 passou no Core real, e os cinco cenarios FBD no Core real passaram. Nesta retomada, SFC temporizado tambem produziu a mesma saida e instante de transicao (100 ms) em step, headless, realtime e acelerado. Um rebuild com erro manteve o modulo valido carregado e executando no worker. Na auditoria Windows, `plc_scan_session`, `plc_compiler`, `plc_runtime`, `plc_runtime_hang` e `plc_session_integration` passaram juntos (5/5); a fixture `hang.st` foi alinhada ao nome do PROGRAM de entrada. Tambem passaram `npm --prefix extension run test:plc`, `npm --prefix extension run test:plc:fbd-core` (5 cenarios FBD e matriz 5x5 no Core real), os testes reais de IL (8), LD (7), SFC (9) e ST ponta a ponta (11), `npm run test:strucpp-smoke`, `npm run check:plc-toolchain` e `npm run license:check-ipd`. O probe SharedHost Windows confirma bloqueio de leitura fora da workdir, loopback e variável secreta do Core, além da limpeza da workdir configurável. O workflow obrigatório `.github/workflows/plc-linux.yml` está preparado para Ubuntu 24.04; sua validação Linux segue pendente e não faz parte desta rodada focada em Windows.

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

Cada instância possui input image, output image, memória local/global runtime, instâncias de FB, estado de steps/actions SFC, timers/counters, área RETAIN/PERSISTENT e tabela force/watch. Cold Reset, Warm Reset e política RETAIN têm semântica explícita e testes. Warm Reset mantém RETAIN; o Core persiste atomicamente o snapshot após cada scan/evento e alteração via SET; Cold Reset apaga o snapshot e reinicia com valores iniciais. O snapshot tipado limita-se ao PROGRAM de entrada. Testes confirmam restauração após encerramento normal e abrupto do worker; falha de persistência marca o runtime como Faulted.

## Segurança e isolamento

Por ADR-0007, o isolamento ocorre no processo do worker; código nativo compilado não é sandbox forte por construção.

- PlcNativeModule malformado ou com hash/versão incompatível é rejeitado antes de iniciar worker/publicar plano;
- crash/timeout pausa a instância afetada e marca Faulted sem derrubar Core ou outros domínios;
- cada instância executa em processo próprio;
- workers herdam a identidade do usuário Core e recebem limites de memória (Job Object Windows; RLIMIT_AS Linux). Em SharedHost, o administrador pode definir `LASECSIMUL_PLC_SHAREDHOST_WORK_ROOT` como caminho absoluto; cada worker usa subdiretório descartável, ambiente mínimo e filesystem restrito. O perfil nega rede por padrão: AppContainer LPAC sem capabilities no Windows; seccomp bloqueia sockets no Linux. Se o isolamento não puder ser aplicado, o worker sai antes do HELLO. Desktop não recebe estas restrições.
- watchdog e limites de processo contêm recursão/uso de memória;
- compilador STruCpp e cache não mantêm estado mutável no artefato.

## Lifecycle e observabilidade do worker PLC

Processos PLC seguem ARCH-009: identidade/provenance no cold path, geração monotônica em relaunch e watchdog separado do tempo IEC. Trace OFF não cria recorder/buffer por PLC.

## Compatibilidade futura

PLCopen XML e atualizações do OpenPLC v4/STruCpp podem ser formatos de intercâmbio/toolchain; não substituem schema canônico nem PlcNativeModule.

## Aceitação

- LD, FBD, ST, SFC e IL criam FUNCTION e FUNCTION_BLOCK válidos;
- matriz 5x5 automatizada executa cada linguagem como caller/callee;
- FB stateful preserva estado por instância;
- alterar linguagem caller não altera resultado;
- PLC novo tem zero pinos; após load, pinos correspondem a exportedIo;
- rename com ioId preserva binding; remoção gera orphan diagnosticável;
- scan reproduzível com 1, 2 e N workers;
- tasks SINGLE executam somente na borda de subida e respeitam latch/commit;
- timers/SFC equivalentes em realtime, accelerated, step e headless;
- erro de build preserva artefato válido e runtime ativo;
- nenhuma linguagem exige runtime próprio nem OpenPLC Runtime externo;
- crash/timeout não derruba Core/outras instâncias;
- RETAIN sobrevive a encerramento abrupto e sincroniza atomicamente após cada scan/evento;
- limite de memória por perfil aplica-se ao worker Windows/Linux;
- SharedHost restringe workdir, ambiente, filesystem e rede conforme deployment; Windows tem probe real aprovado, Linux tem Landlock/seccomp fail-closed e o workflow `.github/workflows/plc-linux.yml` deve passar com os probes Linux;
- usuário pode distribuir PlcNativeModule sob licenção de sua escolha pela Runtime Library Exception;
- relaunch não reutiliza identidade/generation; trace OFF sem thread/buffer por instância.
