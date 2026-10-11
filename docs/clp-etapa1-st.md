# CLP IEC 61131-3, etapa 1: ST de ponta a ponta

O programa do CLP é escrito em Texto Estruturado (ST) no editor IEC do LasecSimul, compilado para um
executável nativo e executado pelo bloco **PLC IEC 61131-3** do esquemático, ligado ao circuito por
pinos elétricos. As outras quatro linguagens (LD, FBD, SFC, IL) ficam para as etapas seguintes; o
editor já aceita POUs nelas, com aviso de tradução experimental.

## Uso

1. **LasecSimul: Novo projeto IEC** cria um `*.iec.json` com o PROGRAM `MAIN` (entrada `DI0`, saída
   `DO0`), a tarefa `MAIN_TASK` de 10 ms e a instância `MAIN_INSTANCE`, e abre o editor.
2. No editor:
   - **Variáveis**: nome, classe (VAR_INPUT, VAR_OUTPUT, VAR, VAR_IN_OUT nos FBs), tipo, valor inicial
     e, para entradas e saídas do PROGRAM, o **pino** (`ioId`). O pino não muda quando a variável é
     renomeada, então os fios continuam ligados.
   - **Código**: só o corpo; as declarações saem da tabela. Tab insere dois espaços.
   - **Configuração**: TASK cíclica (nome, período em ms, prioridade) e a instância de PROGRAM que ela
     executa. O período vale no tempo da simulação. Tipos IEC e GVLs são mantidos em listas JSON
     estruturadas na seção de configuração; variáveis locais/globais podem ser marcadas como RETAIN.
   - **Compilar** (salva antes): ST → C++ (STruCpp 0.6.3) → executável. Os erros aparecem em
     *Problemas* com o POU e a linha do corpo; clicar leva à linha.
3. No esquemático, coloque **PLC IEC 61131-3** (pasta PLC IEC 61131-3) e escolha o projeto em
   Propriedades → *Projeto IEC 61131-3*. Os pinos aparecem na hora, na ordem das variáveis.
4. **Rodar** compila o que mudou (o mesmo programa não é recompilado), atualiza os pinos se a interface
   mudou e carrega o programa no bloco. Erro de compilação cancela a execução e aponta a linha.
5. **Monitor do CLP** (direita do editor), com a simulação carregada: valor de cada entrada, saída e
   variável local escalar; **Escrever** (uma vez), **Forçar** / **Liberar** (BOOL: botões TRUE/FALSE;
   o `F` indica forçado), **Cold Reset** e **Warm Reset** (preserva variáveis RETAIN).

## Elétrica dos pinos

Pinos referenciados ao terra do circuito. Entrada: alta impedância (1 nS); BOOL é TRUE acima do limiar
digital, números recebem a tensão em volts. Saída: fonte de tensão (1 µΩ); BOOL dá 0/5 V, números dão o
valor em volts. Para uma lâmpada, ligue a saída a um resistor e a um LED até o terra.

## Bibliotecas

Entram as da norma (`iec-standard-fb`: TON, TOF, TP, CTU, CTD, CTUD, R_TRIG, F_TRIG, SR, RS;
`iec-std-functions`: LIMIT, SEL, MUX, SQRT, CONCAT...) e os blocos adicionais do OpenPLC (PID, RAMP,
HYSTERESIS...). A OSCAT que vem com o STruCpp **não** entra: nomes como TOGGLE, BLINK e CLK_DIV
colidiriam com FBs do aluno (as duas definições iam para o mesmo C++).

## Por dentro

| Etapa | Onde |
|---|---|
| Projeto → ST canônico com mapa de linhas | `extension/src/plc/lowering.ts` (`generateCanonicalSt`) |
| CONFIGURATION → RESOURCE → TASK → instância → PROGRAM | `extension/src/plc/plcBuild.ts` (`resolvePlcEntryPoint`) |
| Compilação | `lasecsimul-core --plc-compile pedido.json` (`core/src/plc/PlcCompileCli.cpp` → `PlcCompiler`) |
| Cache | diretório por hash do ST e das ferramentas, no armazenamento global da extensão (`plc-builds/`) |
| Carga no bloco | `extension/src/plc/plcRuntimeBridge.ts` (rebuild do Core) e `plcSchematic.ts` (Rodar) |
| Editor | `extension/src/plc/IecProjectEditorProvider.ts` + `extension/media/iec-editor/` |

O executável do worker é linkado estaticamente no Windows (`-static`): roda sem DLL do MinGW.

### Ferramentas no instalador

`scripts/stage-plc-toolchain.js` (chamado pelo `package-release.js`) coloca em `bundled/plc/`:
STruCpp + licenças + as três bibliotecas, os headers de runtime, as fontes do driver e, no Windows,
um g++ mínimo do MSYS2 em `bundled/plc/ucrt64` (~99 MB, de 350 MB do pacote completo). O conjunto
sai de uma compilação real com `-H` e `-Wl,--trace`; no fim o Core empacotado compila um programa de
teste usando só o que foi copiado, com PATH limpo. O nome `ucrt64` é obrigatório: o g++ do MSYS2 procura
os headers do sistema em `bin/../../ucrt64/include`. No Linux o `.deb` depende de `g++`.
`scripts/test-bundled-plc.js` repete a compilação a partir do VSIX final, num caminho com espaço.

### Correções no Core feitas aqui

- Entradas elétricas do bloco PLC nunca chegavam ao programa: o laço das ligações de sinal sobrescrevia
  toda entrada, inclusive as sem bloco de sinal, com FALSE (`SimulationSession::runPlcScanUnlocked`). A
  tensão de entrada agora também é lida da solução do circuito (`observeSolution`), não só no `stamp()`.
- O leitor da interface ST pegava VAR_INPUT de FUNCTION_BLOCKs declarados antes do PROGRAM e tratava
  `VARIAVEL := ...` no corpo como início de bloco VAR.

## Testes

| Teste | O que prova |
|---|---|
| `plcEndToEnd.realCore.test.ts` (10) | compila partida/parada com selo + pisca TON 500 ms + FB TOGGLE; cache; erro de sintaxe e variável não declarada na linha certa; no Core: botão liga acende o LED (7,9 mA) e o selo segura, pisca troca ~4 vezes em 2 s de simulação, forçar LAMP apaga, desliga apaga, forçar START liga |
| `plcBuild.test.ts` | configuração/tarefa, pinos sem compilar, tabela de variáveis (ioId estável), mapa de linhas, resposta do monitor, caminhos instalado/desenvolvimento |
| `plc_compiler` (ctest) | leitor de interface restrito ao PROGRAM, locais para o monitor |
| `test-bundled-plc.js` | VSIX final, caminho com espaço, PATH limpo |

Fora do `npm test` (precisa do Core, do STruCpp e de um g++):
`npm run compile && node out/plc/plcEndToEnd.realCore.test.js` em `extension/`.

## Pendências do PLC integrado

(Feitos depois: IL, `docs/clp-etapa2-il.md`; SFC, `docs/clp-etapa3-sfc.md`; LD, `docs/clp-etapa4-ld.md`; FBD, `docs/clp-etapa5-fbd.md`.)

- tasks cíclicas múltiplas e instâncias de PROGRAM vinculadas a elas rodam no worker e são agendadas pelos seus períodos virtuais; tasks por evento ainda estão pendentes;
- monitor de membros de FBs de biblioteca sem definição no projeto; variáveis locais escalares, campos de STRUCT, elementos de ARRAY e membros de FUNCTION_BLOCKs definidos no projeto são publicados pelo worker (até 2048 posições lineares por array);
- Warm Reset preserva variáveis RETAIN, mas armazenamento persistente entre encerramento do worker e nova sessão ainda não existe.

Tipos IEC definidos pelo usuário, GVLs, declarações `VAR_EXTERNAL`, variáveis RETAIN, Cold/Warm Reset e hot reload com I/O e período de TASK inalterados foram adicionados ao workspace/pipeline. Hot reload com mudança de pinos ou período exige parar a simulação.

## Fechamento da etapa FBD e estado do recurso integrado

Etapas 1–5 estão implementadas no fluxo atual, incluindo FBD. Isto fecha o escopo de FBD, mas não fecha FEAT-007: o status da feature continua `active` até as pendências de runtime e aceitação abaixo serem resolvidas.

O build seleciona um `PROGRAM` como entry point para os pinos e o monitor do bloco PLC. O worker instancia a `CONFIGURATION` gerada pela STruCpp e executa todas as instâncias de `PROGRAM` vinculadas às tasks cíclicas, respeitando período e prioridade no tempo virtual. A UI oferece edição validada das listas completas de resources, tasks e instâncias adicionais, além dos campos rápidos da task de entrada. Tasks acionadas por evento ainda não são despachadas.

O monitor do worker lista I/O e variáveis locais escalares do PROGRAM selecionado. Campos aninhados de FBs, arrays e structs ainda não têm caminho de watch/force. Warm Reset mantém valores RETAIN. Em encerramento limpo, o runtime exporta os RETAIN para armazenamento atômico em `LASECSIMUL_CORE_DATA_DIR/plc-retain/`, identificados pelo ID estável do componente e pelo artefato/layout do PROGRAM. Uma nova instância de runtime, inclusive após destruir o Core, restaura os valores antes do primeiro scan. O teste nativo destrói runtime e worker, restaura um contador de 1 para 2 em um novo runtime e confirma que Cold Reset apaga a retenção. Encerramento abrupto ainda pode perder mudanças posteriores ao último snapshot limpo.

Continuam pendentes da aceitação FEAT-007: varredura determinística demonstrada com 1/2/N workers, equivalência de temporizadores/SFC entre tempo real, aceleração, step e headless, isolamento de falhas entre múltiplos domínios PLC, e lifecycle/proveniência de processo com geração de relaunch. Esses itens precisam de implementação e validação de ponta a ponta antes de mudar o status da feature para `complete`.

Foi implementada no Core a barreira entre PLCs com scan vencendo no mesmo timestamp: todas as imagens de entrada são coletadas antes de avaliar qualquer worker; avaliação e commit seguem a ordem estável do índice do componente; as saídas só são commitadas depois de todos os scans do lote terminarem. O Core agenda a união dos períodos de todas as tasks cíclicas do artefato. Teste de integração confirmou scans em 5/10/15/20 ms com período de fallback de 100 ms; equivalência sob diferentes configurações de workers ainda requer validação.

O monitor agora achata tipos alias, campos de STRUCT, elementos de ARRAY e os campos de FUNCTION_BLOCKs definidos pelo projeto em caminhos escalares que aceitam GET/SET/FORCE/UNFORCE (por exemplo `MAIN.POSITION.X`, `MAIN.SAMPLES[2]` ou `MAIN.MOTOR.Q`). A tabela e o worker usam o mesmo limite de 2048 posições por array; variáveis de tipos compostos na interface de pinos são rejeitadas em vez de exportadas como uma porta escalar inválida. O build do artefato e uma execução real do worker confirmaram leituras de struct, array e estado de FB.

O parser C++ do artefato seleciona o `PROGRAM` de entrada pelo nome do arquivo ST. Isso evita que um POU auxiliar declarado antes do entry point forneça por engano os pinos exportados. O teste `plc_compiler` passou com um `HELPER` anterior a `MAIN`.
