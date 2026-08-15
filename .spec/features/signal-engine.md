---
id: FEAT-001
kind: feature
status: planned
dependsOn: [ARCH-002, ARCH-003, ARCH-006, SCHEMA-001]
supersedes: []
---

# Signal Engine

## Escopo MVP

- tipos `Real`, `Bool`, `Int64` e vetores limitados;
- unidade como metadado compilável, com conversões lineares explícitas;
- slots densos separados por tipo;
- blocos Source, Gain, Sum, Product, Limiter, Selector e Probe;
- ordem topológica para grafo acíclico;
- SCCs para realimentação e diagnóstico de loop algébrico;
- RateGroups e microsteps conforme `ARCH-003`;
- zero resolução de strings no hot path.

## Semântica

Um bloco lê snapshot de entradas do microstep e escreve em saída própria. Commit ocorre em ordem do plano. Blocos combinacionais não usam wall clock. Blocos periódicos são ativados por RateGroup.

Qualidade/timestamp podem ser reservados no layout, mas propagação completa de quality fica fora do MVP. `double` não deve contaminar a representação dos outros tipos.

## Alocação

Compilação pode alocar. Execução steady-state reutiliza arrays, dirty bitsets, filas e scratch. Nenhum `unordered_map`, nome de porta ou `std::function` por bloco no passo normal.

## Aceitação

- conexão incompatível falha na compilação;
- conversão de unidade conhecida é pré-compilada;
- grafo acíclico executa uma vez por ativação;
- SCC sem política de solução produz diagnóstico;
- mesmos valores e ordem com 1/2/N workers;
- benchmark cobre 100, 10k e 100k blocos simples.
