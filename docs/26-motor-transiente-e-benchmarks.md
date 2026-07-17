# Motor transiente e desempenho

O Core suporta `BackwardEuler`, `Trapezoidal`, `Gear2` e `Automatic`. Capacitores e indutores usam
modelos companion MNA com histórico confirmado somente após convergência. O modo automático inicia
por Backward Euler e usa controle adaptativo com rejeição e rollback.

## Caminho de alto desempenho

- grafo e grupos são reconstruídos somente quando a topologia muda;
- stamps armazenam apenas coeficientes não nulos e reutilizam buffers por componente;
- matrizes pequenas usam LU densa; matrizes a partir de 96 incógnitas usam SparseLU;
- grupos pequenos são resolvidos serialmente; trabalho grande usa pool persistente;
- solução e fatoração são cacheadas quando apenas o RHS muda;
- tensões e estados de instrumentos atravessam IPC em lotes;
- a frequência visual é independente da frequência do solver.

## Benchmarks de referência

Executados em Release em 2026-07-12 nesta máquina. São microbenchmarks comparativos, não promessa de
desempenho para todo circuito.

| Cenário | Resultado |
|---|---:|
| Stamp 256×256, denso antigo vs esparso | 1271× a 1685× |
| Fatoração 256×256, LU densa vs SparseLU | 5,32× |
| 8 ilhas 256×256, serial vs pool | 2,17× |
| Solves pequenos, seleção automática | 0,99× (sem regressão relevante) |
| RC 10 ms, Trap fixo vs Automatic adaptativo | 1,76× |

Diferença numérica observada entre fatoração densa e esparsa: `2,84e-14`.

Executáveis: `solver_benchmark` e `transient_benchmark`, definidos em `core/CMakeLists.txt`.

## Benchmark integrado da simulação

Desde 2026-07-17, `simulation_performance_benchmark` cobre circuito vazio, passivo, RC analógico,
transições digitais, instrumentos e escala configurável. O alvo CTest `simulation_performance_smoke`
detecta regressão abaixo de tempo real nos fixtures simples. O script
`scripts/benchmark-simulation.ps1` acrescenta amostragem de CPU, threads e memória sem ativar logs no
caminho quente.

O relatório completo, resultados, limitações e comandos de reprodução estão em
`docs/28-relatorio-desempenho-simulacao-2026-07-17.md`.
