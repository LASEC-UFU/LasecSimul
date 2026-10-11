# CLP IEC 61131-3, etapa 3: SFC

O SFC (Sequential Function Chart, IEC 61131-3 3ª ed., seção 6.7) tem editor gráfico próprio e é
traduzido para o ST canônico das etapas anteriores: STruCpp → C++ → executável → bloco PLC. Pode ser o
corpo de um PROGRAM ou de um FUNCTION_BLOCK (a norma não permite SFC em FUNCTION).

## Editor

- **Adicionar POU** com a linguagem SFC; para ser o programa executado, escolha-o em *Configuração*.
- Desenho na notação da norma: passo = retângulo, passo inicial com borda dupla, transição = traço com
  a condição, divergência/convergência seletiva = linha simples, simultânea = linha dupla, salto =
  seta com o nome do passo de destino, bloco de ação = qualificador | ação | duração ao lado do passo.
- Clique num **passo**: nome, passo inicial, blocos de ação (qualificador, ação, duração),
  **+ Transição e passo abaixo** (repetido no mesmo passo cria uma divergência seletiva), excluir.
- Clique numa **transição**: condição (expressão ST, pode usar `PASSO.X` e `PASSO.T`), prioridade
  numerada para a divergência seletiva, passos antes (mais de um = convergência simultânea), passos
  depois (mais de um = divergência simultânea; um passo acima = salto), **+ Ramo paralelo**, excluir.
- **Ações**: nome, linguagem (ST ou IL) e corpo. Uma variável BOOL também pode ser usada como ação
  (ação booleana).
- As verificações da norma aparecem em *Problemas* enquanto se edita, e o elemento fica com a borda
  vermelha; clicar no problema seleciona o elemento.
- Com a simulação rodando, o programa principal em SFC mostra os **passos ativos em verde** com o
  `PASSO.T` embaixo.
- Exemplo: [trm/plc/semaforo_sfc.lsproj](../trm/plc/semaforo_sfc.lsproj), um semáforo com botão de
  pedestre (divergência seletiva com prioridade, salto, ação P1 em ST, LEDs como ações booleanas N).

## O que segue a norma

| Elemento | Implementação |
|---|---|
| Passo, passo inicial | exatamente um passo inicial por rede (erro se 0 ou mais de 1) |
| `PASSO.X`, `PASSO.T` | atividade e tempo desde a ativação; `.T` fica com o último valor quando o passo é desativado e volta a `T#0s` na ativação; ambos só leitura |
| Transição | condição em expressão ST; habilitada quando todos os passos imediatamente anteriores estão ativos; transposta quando habilitada e a condição é TRUE |
| Transpor | desativa todos os passos anteriores e ativa todos os seguintes |
| Simultaneidade | todas as transições transponíveis no ciclo são transpostas juntas |
| Passo desativado e ativado ao mesmo tempo | continua ativo (sem nova ativação: `.T` não reinicia) |
| Divergência seletiva | só uma transição de um passo é transposta: prioridade da esquerda para a direita (ordem da lista) ou numerada (menor número primeiro) |
| Divergência / convergência simultânea | uma transição com vários passos depois / antes |
| Qualificadores | N, R, S, L, D, P, P1, P0, SD, DS, SL (L, D, SD, DS e SL exigem duração) |
| Controle da ação | o bloco **ACTION_CONTROL** da norma, uma instância por ação; cada entrada de qualificador é o OU da atividade dos passos que associam a ação com ele; saídas Q e A (3ª ed.: A = Q ou a borda de descida de Q) |
| Ação de código | executa enquanto A é TRUE, inclusive a última execução depois que Q cai; `ACAO.Q` e `ACAO.A` podem ser lidos (ex.: `IF CONTA.Q THEN ...` para não contar a última execução) |
| Ação booleana | qualquer variável BOOL de VAR ou VAR_OUTPUT (tabela 56); recebe Q |
| Controle de ação (tabela 60) | a norma tem duas variantes, com e sem última execução; aqui a **com última execução** |

O ACTION_CONTROL tem uma só entrada T, então uma ação associada com qualificadores temporizados em
vários passos precisa da mesma duração em todos (erro se forem diferentes).

### O que a norma deixa à implementação

A norma diz que o tempo de transposição pode ser tão curto quanto se queira, mas nunca zero, e deixa a
ordem interna do ciclo à implementação. Aqui, a cada ciclo da tarefa:

1. `.T` dos passos ativos;
2. controle (ACTION_CONTROL) e execução das ações da situação atual, na ordem em que as ações
   aparecem;
3. avaliação de todas as transições com essa situação, e aplicação de todas juntas.

Consequências: há no máximo **uma evolução por ciclo** (uma sequência de transições TRUE avança um
passo por ciclo) e todo passo ativado executa suas ações pelo menos uma vez antes de ser deixado.

## Ainda não

- transição com corpo nomeado (`TRANSITION ... END_TRANSITION`) em IL, LD ou FBD (só expressão ST);
- corpo de ação em SFC, LD ou FBD (só ST e IL); `RETURN`/`RET` dentro de ação (sairia do POU inteiro,
  por isso é recusado);
- variável indicadora no bloco de ação (obsoleta na 3ª edição, tabela 58; o campo existe no modelo, não é desenhado);
- monitor de passos de SFC dentro de instâncias de FUNCTION_BLOCK (só o PROGRAM principal).

## Testes

| Teste | O que prova |
|---|---|
| `sfcPrograms.realCore.test.ts` (8, Core real) | sequência com um passo por ciclo e retorno por `S3.T`; N S R L D SD DS SL P1 P0 com os valores que a definição de cada qualificador dá a +20 ms, +80 ms, no passo seguinte e depois do R; A com a última execução; DS sem memorizar quando o passo dura menos que T; prioridade numerada e da esquerda para a direita; ramos paralelos e sincronização; ações IL e ST; passo reativado continua ativo; exemplo do semáforo (3 s / 4 s / 1 s, pedestre encurta o verde para 1 s, P1 conta um ciclo); erros com o elemento |
| `sfcLowering.test.ts` (`npm test`) | corpo do ACTION_CONTROL, verificações da norma, entradas por qualificador, prioridade, convergência, texto entre aspas intocado, ações antes da evolução |

Fora do `npm test`: `npm run compile && node out/plc/sfcPrograms.realCore.test.js` em `extension/`.

Código: `extension/src/plc/sfcLowering.ts` (verificações e tradução), `extension/media/iec-editor/sfc.js`
(editor gráfico), modelo em `iecProject.ts` (`SfcStep`, `SfcTransition`, `SfcAction`,
`SfcActionAssociation`). O formato antigo (um passo de cada lado na transição, código direto no passo)
continua sendo lido.

## Próximas etapas

4. LD: feito, `docs/clp-etapa4-ld.md`; 5. FBD: tradução completa e editor gráfico;
6. matriz 5×5 executada e roteiro de aula.
