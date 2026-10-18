# ADR 0013 - `control.accumulator` conservativo substitui `control.tank`

## Objetivo

Substituir o integrador com recorte silencioso em zero (`SignalBlockKind::Tank`) por um acumulador cujo balanço fecha
em qualquer instante, e que sirva a tanques, temperaturas, posições e temporizadores.

## Status

Aceita e implementada (2026-10-17): `SignalBlockKind::Accumulator` + `Element`, `control.accumulator` com 10 saídas
(o derramamento ficou em `cumSpill`, separado de `cumOverflow`; fronteiras projetadas na ativação; demandas com sinal —
ver [`docs/54 §0`](../54-laboratorio-calculo-validacao-e-riscos.md)). `Tank` removido e instâncias migradas. Oráculo executável:
[`docs/poc/laboratorio-calculo-limites/accumulator.mjs`](../poc/laboratorio-calculo-limites/accumulator.mjs).

Complemento (2026-10-18): 12 saídas publicadas, com `upperContactTime`/`lowerContactTime` (instante exato do contato dentro
do passo, −1 sem contato); somas compensadas de Neumaier em 5 posições ocultas do vetor (largura 17) — resíduo de balanço
7,1·10⁻¹⁴ depois de 600 mil passos.

## Contexto

`Tank` integra `(in − outflow)/area` e aplica `max(0, …)`: o volume que "atravessaria" zero desaparece sem registro.
Não há capacidade, transbordo nem vazão realizada. Os 10 usos atuais (5 subcircuitos) usam `area = 1` como integrador
não negativo genérico (°C, mm, bar, s, m).

## Decisão

- Novo bloco com entradas `in`/`out` (demandas ≥ 0) e entradas opcionais `lower`/`upper` (que sobrepõem os parâmetros e
  podem mudar em execução). Com entradas ZOH no passo, o contato com a fronteira é analítico; o excesso vira
  `overflow` (topo) ou `unmet` (fundo). Saídas: estado, `inActual`, `outActual`, `overflow`, `unmet` e acumulados
  `cumIn`, `cumOut`, `cumOverflow`, `cumUnmet`. Identidade: `x − x0 = cumIn − cumOut − cumOverflow`.
- `upper` reduzido abaixo do estado gera **derramamento discreto** (volume, evento `spill`).
- Saída vetorial + bloco `Element` para expor portas nomeadas sem criar blocos de várias saídas.
- `control.tank` deixa de existir; os consumidores migram para `control.accumulator` (`lower = 0`, `upper = +∞`
  reproduz o comportamento atual dentro da faixa). `subcircuits.control.tank` passa a ser o tanque hidráulico.

## Consequências

- Beta: sem leitor do typeId antigo; exemplos, subcircuitos e testes são atualizados juntos.
- O erro estimado do passo continua zero para entradas ZOH (exato); leis de saída dependentes do estado ficam O(Δt).
