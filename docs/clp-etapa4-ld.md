# CLP IEC 61131-3, etapa 4: Ladder (LD)

O Ladder (IEC 61131-3 3ª ed., seção 8.2) tem editor gráfico próprio e é traduzido para o ST canônico
das etapas anteriores: STruCpp → C++ → executável → bloco PLC. Um POU em LD pode ser PROGRAM,
FUNCTION_BLOCK ou FUNCTION e chamar blocos escritos em qualquer outra linguagem.

As tabelas citadas são as da 3ª edição, conferidas numa declaração de conformidade que as reproduz
linha a linha (Siemens, *Standards compliance according to IEC 61131-3 (3rd Edition)*, 04/2015).

## Editor

- **Adicionar POU** com a linguagem LD; cada **rede** é uma grade entre a barra de alimentação
  esquerda e a direita, com rótulo (destino de saltos) e comentário.
- Clique numa posição e escolha na paleta: ligação horizontal, contatos `┤ ├` `┤/├` `┤P├` `┤N├`,
  contato de comparação, bobinas `( )` `(/)` `(S)` `(R)` `(P)` `(N)`, bloco, salto `>>`, retorno e a
  ligação vertical `│` (une a borda direita da posição à da linha de baixo).
- Propriedades do elemento selecionado: variável e tipo do contato/bobina; operandos, operador e tipo
  do contato de comparação; no bloco, função ou FB, instância, **qual entrada e qual saída ficam no
  degrau** (EN/ENO ou uma entrada/saída BOOL do bloco, como IN e Q do TON) e as demais entradas e
  saídas com variáveis ou literais.
- Redes: + linha, + coluna, remover vazias, subir, descer, + rede, excluir.
- Os erros aparecem em *Problemas* enquanto se edita, com a posição marcada em vermelho.
- Com a simulação rodando, o programa principal em LD mostra o **fluxo de energia**: cada elemento
  cuja saída está ON fica verde, e as ligações verticais acendem pelo OU das linhas unidas.
- Exemplo: [trm/plc/partida_pisca_ld.lsproj](../trm/plc/partida_pisca_ld.lsproj), o mesmo circuito e
  comportamento de `partida_pisca.lsproj`, com o MAIN em Ladder chamando o bloco TOGGLE escrito em ST.

## O que segue a norma

| Tabela | Elemento | Implementação |
|---|---|---|
| 74 | barra de alimentação esquerda e direita | a esquerda está sempre ON; a direita é implícita na avaliação e desenhada |
| 74 | ligação horizontal | passa o estado do elemento à esquerda para o da direita |
| 74 | ligação vertical | estado = OU dos estados ON das ligações horizontais à sua esquerda, copiado para as da direita |
| 75 | contato normalmente aberto / fechado | conduz com a variável ON / OFF |
| 75 | contato de transição positiva / negativa | ON por uma avaliação quando a variável muda OFF→ON / ON→OFF com a esquerda ON (R_TRIG / F_TRIG sobre a variável, avaliado todo ciclo) |
| 75 | contato de comparação tipado / sobrecarregado | conduz quando `esquerdo <op> direito` (`=`, `<>`, `>`, `>=`, `<`, `<=`); na forma tipada os operandos têm de ser do tipo indicado |
| 76 | bobina / bobina negada | a variável recebe o estado da esquerda / o inverso |
| 76 | bobina set / reset | ligam / desligam a variável quando a esquerda está ON |
| 76 | bobina de transição positiva / negativa | a variável fica ON por uma avaliação na borda de subida / descida da esquerda |
| 76 | toda bobina | passa o estado da esquerda para a direita |
| 18 | EN/ENO | sem EN o bloco executa sempre; com EN só executa com EN = TRUE; ENO acompanha a execução; as quatro combinações (nenhum, só EN, só ENO, ambos) |
| 73 | salto | condicional pelo estado da linha, incondicional ligado direto à barra; destino = rótulo de rede |
| 73 | retorno | condicional e incondicional |

As bobinas retentivas da 2ª edição não estão na tabela 76 da 3ª e não foram implementadas.

Blocos: funções e blocos de função da biblioteca padrão (TON, CTU, R_TRIG, ADD, MUL, GT, SEL,
conversões...) e os do projeto. A norma pede que o bloco tenha pelo menos uma entrada e uma saída
booleanas para o fluxo de energia; no editor escolhe-se quais (EN/ENO ou, por exemplo, IN e Q de um
TON). Um FB precisa de uma instância declarada na tabela de variáveis. A saída de uma função é OUT.

### Ordem de avaliação (8.1.7 e 8.2.7)

As redes são avaliadas de cima para baixo. Dentro da rede, nenhum elemento é avaliado antes das suas
entradas: aqui, coluna a coluna da esquerda para a direita e, na coluna, de cima para baixo. O estado
de saída de cada elemento é gravado no momento em que ele é avaliado. Saltos e retornos agem depois que
a rede inteira foi avaliada (a norma diz que a avaliação de uma rede só está completa quando as saídas
de todos os seus elementos foram avaliadas). Com saltos, as redes viram uma máquina de estados em ST,
que não tem GOTO; um laço infinito estoura o watchdog do worker.

## Ainda não

- conectores e ligações entre páginas; realimentação explícita dentro de uma rede;
- arrastar elementos (a edição é por posição selecionada e paleta);
- fluxo de energia de LD dentro de instâncias de FUNCTION_BLOCK (só o PROGRAM principal);
- LD como corpo de ação ou de condição de transição do SFC.

## Testes

| Teste | O que prova |
|---|---|
| `ldPrograms.realCore.test.ts` (7, Core real) | tabela-verdade de NA/NF, bobina, negada, set/reset, série, paralelo e ramo no meio; contatos e bobinas P/N contando uma avaliação por borda; TON e CTU no degrau, MUL com EN/ENO (não executa com EN falso), GT como saída do degrau, contato de comparação tipado; redes de cima para baixo (cadeia resolve em 1 ciclo na ordem direta e em 3 na inversa) e selo; salto condicional e incondicional e retorno; exemplo em LD com as mesmas saídas do ST a cada 50 ms e o fluxo de energia do selo; erros com a posição |
| `ldLowering.test.ts` (`npm test`) | ST gerado para cada tabela, ligação vertical, bordas, blocos, saltos e todas as verificações |

Fora do `npm test`: `npm run compile && node out/plc/ldPrograms.realCore.test.js` em `extension/`.

Código: `extension/src/plc/ldLowering.ts`, `extension/media/iec-editor/ld.js`, modelo em `iecProject.ts`
(`LdRung`, `LdCell`). O formato antigo de LD (nós e arestas) continua sendo lido quando o POU não tem
`rungs`.

## Próximas etapas

5. FBD: tradução completa e editor gráfico;
6. matriz 5×5 executada e roteiro de aula.
