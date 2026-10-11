# CLP IEC 61131-3, etapa 2: Lista de Instruções (IL)

A IL da 3ª edição da IEC 61131-3 (seção 7.2) é traduzida para o mesmo ST canônico da etapa 1 e segue
o mesmo caminho: STruCpp → C++ → executável → bloco PLC. Um POU em IL pode ser PROGRAM,
FUNCTION_BLOCK ou FUNCTION e chamar ou ser chamado por POUs em ST. A 4ª edição (2025) retirou a IL; o
LasecSimul mantém a 3ª para o ensino.

## Uso

- **Novo projeto IEC** pergunta a linguagem do MAIN (ST ou IL). Em IL ele começa com `LD DI0` / `ST DO0`.
- No editor, **Adicionar POU** com a linguagem IL; para o PROGRAM em IL ser o executado, escolha-o em
  *Configuração → Programa*.
- Erros de tradução (operador desconhecido, variável não declarada, rótulo inexistente, `)` sobrando,
  `JMPC` com resultado não BOOL...) aparecem em *Problemas* com o POU e a linha, antes de chamar o
  compilador. Erros do compilador também apontam a linha IL.
- Exemplo: [trm/plc/partida_pisca_il.lsproj](../trm/plc/partida_pisca_il.lsproj), o mesmo circuito e
  comportamento de `partida_pisca.lsproj`, com MAIN e TOGGLE em IL.

## O que é aceito

| Recurso | Forma |
|---|---|
| Carga e armazenamento | `LD`, `LDN`, `ST`, `STN` |
| Set/Reset | `S`, `R` (BOOL: só quando o resultado corrente é TRUE) |
| Lógica | `AND`/`&`, `OR`, `XOR`, com `N` (`ANDN`, `&N`, `ORN`, `XORN`); `NOT` |
| Aritmética | `ADD`, `SUB`, `MUL`, `DIV`, `MOD` |
| Comparação | `GT`, `GE`, `EQ`, `NE`, `LE`, `LT` (resultado BOOL) |
| Operação adiada | `AND( B` ... `)` ou `AND(` e o operando nas linhas seguintes; aninhada |
| Saltos | rótulo `NOME:` (sozinho na linha ou antes da instrução), `JMP`, `JMPC`, `JMPCN` |
| Retorno | `RET`, `RETC`, `RETCN` |
| Blocos de função | `CAL inst`, `CAL inst(IN := x, PT := T#1s, Q => y)` (pode ocupar várias linhas), `CALC`, `CALCN` |
| Operadores de entrada | `S1`, `R1`, `CLK`, `CU`, `CD`, `PV`, `IN`, `PT`, e `S`, `R`, `LD` quando o operando é uma instância com essa entrada |
| Funções | `LIMIT 0, 100` (o resultado corrente é o 1º argumento), `INT_TO_REAL`, `SQRT`...; formal: `LIMIT( MN := 0, IN := X, MX := 100 )`; FUNCTIONs do projeto |
| FUNCTION | `ST NOME_DA_FUNCAO` define o retorno |
| Operandos | variáveis, membros de FB (`T1.Q`), arrays (`A[I]`), literais (`TRUE`, `5`, `2.5`, `16#0F`, `INT#3`, `T#500ms`, `'texto'`), endereços `%IX0.0` |
| Comentários | `(* ... *)` em várias linhas e `//` |

Tolerado, fora da norma: `;` no fim da instrução (hábito do ST). Depois de um `CAL` o resultado corrente
continua o mesmo (a norma o deixa indefinido).

### Cuidado ensinável: operador de entrada também chama o bloco

`PT T1` é `T1(PT := ...)`: o TON roda. Escrever `LD T#500ms` / `PT T1` e depois `IN T1` chama o
temporizador duas vezes no mesmo scan, e a segunda chamada pode desfazer o pulso de `T1.Q` que a
primeira gerou. Para só gravar uma entrada sem chamar, use `ST T1.PT`. O exemplo em IL faz isso; o
teste que compara os exemplos ST e IL pegou exatamente esse erro na primeira versão.

## Como a tradução funciona

O resultado corrente (CR) é um acumulador **tipado**. Na tradução ele é uma expressão ST com tipo:

- `LD`, operações e funções só montam a expressão; um literal sem tipo (`5`) assume o tipo do outro
  operando (`LD 5` / `ADD N` com `N : INT` é INT); comparações dão BOOL; o tipo de retorno das funções
  padrão vem das bibliotecas do STruCpp (`extension/src/plc/iecStandardLibrary.ts`, gerado por
  `scripts/generate-iec-standard-library.py`).
- Antes de qualquer instrução com efeito (`STN`, `S`, `R`, `CAL`, operadores de entrada, saltos), o CR
  é gravado em `__IL_CR_<TIPO>`: assim `LD A` / `ST Q` / `R Q` / `ST P` grava em `P` o valor que `Q`
  tinha antes do reset.
- `OP(` guarda o lado esquerdo em `__IL_S<nível>_<TIPO>`.
- Sem saltos, o ST sai em linha reta. Com `JMP`, o corpo vira uma máquina de estados
  (`WHILE __IL_PC >= 0 DO CASE __IL_PC OF ...`): ST não tem GOTO. Um laço infinito estoura o watchdog
  do worker, como no CLP real.

Código: `extension/src/plc/ilLowering.ts` (parser e gerador), integrado em `lowering.ts`
(`lowerPouBody`, `ilContextFor`).

## Correções no Core

- `plcGet`/`plcSet`/`plcForce`/`plcUnforce` antes do primeiro scan falhavam (worker ainda não
  iniciado). Agora iniciam o worker como o scan faz; um worker em falha continua exigindo reinício.

## Limitação do STruCpp 0.6.3

`CONCAT('a', 'b')` com os dois argumentos literais não compila (falta a sobrecarga em C++), também em
ST. Na IL o literal de string no resultado corrente vai para uma temporária antes da chamada.

## Testes

| Teste | O que prova |
|---|---|
| `ilPrograms.realCore.test.ts` (8, Core real) | tabela-verdade de `AND(`/`ORN`/`XOR`/`STN`/`S`/`R` nas 8 combinações; INT/REAL, `MOD`, comparação, conversão, `LIMIT`/`SEL` com o CR, chamada formal; laço 1..N com `JMP`/`JMPC`/`JMPCN` e `RETC`; TON por `CAL` formal, CTU por `CU`/`R`/`PV`, `CALC`; FB e FUNCTION em IL chamados de IL; `&N`, `ANDN(` aninhado, SR e R_TRIG por operador de entrada, TIME, WORD, ARRAY, STRING, `CALCN`, `RETCN`; exemplos ST e IL com saídas idênticas a cada 50 ms; erros com POU e linha |
| `ilLowering.test.ts` (`npm test`) | comentários, junção de `CAL` em várias linhas, forma do ST gerado, cópia do CR antes de efeitos, tipos, operadores de entrada, máquina de estados, linha de cada diagnóstico |

Fora do `npm test`: `npm run compile && node out/plc/ilPrograms.realCore.test.js` em `extension/`.

## Próximas etapas

3. SFC: feito, `docs/clp-etapa3-sfc.md`;
4. LD e 5. FBD com tradução completa e editores gráficos;
6. matriz 5×5 executada e roteiro de aula.
