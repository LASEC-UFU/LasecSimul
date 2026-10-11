# CLP IEC 61131-3, etapa 5: base de lowering FBD

O pipeline FBD gera ST canônico a partir de redes em grafo, resolvendo POUs pela identidade
`pouId` e conexões pelas portas formais da interface. O editor FBD permite editar redes, incluir
entradas/saídas e operadores, ligar portas por nome e inserir POUs pelo browser comum.

## Regras implementadas

- a ordem de avaliação é topológica e determinística, independente das coordenadas do canvas;
- entradas/contatos propagam a variável IEC, com negação opcional;
- ligações em bloco atribuem as entradas nomeadas antes de executar a instância de FB;
- saídas de FB são lidas pelo nome da porta, como `instancia.Q`;
- blocos `FUNCTION` geram chamadas com argumentos nomeados e seu resultado alimenta a próxima porta;
- operadores BOOL, aritméticos e de comparação (AND/OR/XOR/NOT, ADD/SUB/MUL/DIV/MOD,
  EQ/NE/GT/GE/LT/LE e NEG) são traduzidos para expressões ST; AND/OR/XOR/ADD/MUL aceitam de duas a
  oito portas;
- funções IEC `extensible` aceitam portas nomeadas `IN1` a `IN8`, com tipo genérico `ANY_NUM` /
  `ANY_INT` / `ANY_REAL` validado contra o tipo concreto ligado;
- junções gráficas aceitam um sinal de entrada e o distribuem para várias saídas;
- ciclos intencionais usam uma ligação marcada como realimentação, com atraso de um scan e valor inicial editável; ciclos sem essa marca continuam rejeitados;
- conexões a portas inexistentes, referências órfãs, nós sem valor e ciclos sem atraso são rejeitados;
- validação no editor reporta variáveis não resolvidas e incompatibilidade de famílias de tipos;
- redes mantêm a ordem armazenada no projeto.

Identidade, direção e tipo de portas vêm da interface do POU, não da posição do bloco. Essa regra
permite que o mesmo POU seja chamado de FBD mesmo quando foi implementado em ST, IL, LD ou SFC.

## Estado da etapa

Nao ha pendencias conhecidas para a etapa FBD. Redes, nos e arestas tem identidade estavel; ligacoes preservam portas formais pelo nome; o editor permite criar, remover, mover e ligar nos, inserir POUs pelo browser comum e declarar realimentacao de um scan. A interoperabilidade esta coberta pelo Core real e pela matriz 5x5.

## Proximo trabalho

Sem pendencias conhecidas para esta etapa.

## Testes

- `npm --prefix extension run test:plc`: testes de lowering FBD, portas nomeadas, erros e ciclo;
- `npm --prefix extension run test:plc:fbd-core`: operadores FBD e chamada de FB/FUNCTION no Core real, alem da matriz 5x5 de linguagens chamadoras e implementacoes.

Ultima verificacao (2026-10-11): ambas passaram; 5 cenarios FBD no Core real, incluindo feedback de um scan, e as 25 combinacoes da matriz 5x5. Juncoes, tipos genericos e operadores variadicos tem testes de lowering. O build TypeScript da extensao e `git diff --check` tambem passaram.
