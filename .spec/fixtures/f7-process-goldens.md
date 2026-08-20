---
id: BENCH-003
kind: benchmark
status: active
dependsOn: [BENCH-001, FEAT-002, FEAT-012]
supersedes: []
---

# Goldens de processo do gate F7

Todos os cenarios usam tempo virtual, passo continuo de 5 ms e os parametros versionados nos
arquivos `.lssubcircuit`. A observacao visual/Probe nao participa do resultado numerico.

| Cenario | Entrada/tempo | Saida esperada | Tolerancia |
|---|---:|---:|---:|
| `process_fopdt` | degrau `u=1`, 1 s | `1-exp(-(1-0.1)/1) = 0.593430340259...` | `2e-3` |
| `tdps_basic_flow_loop` | defaults do artefato, 5 s | `flow = 60.237406934994816` | `1e-6` |
| `tdps_smith_predictor` | defaults do artefato, 30 s | `pv = 26.796154343045458` | `1e-6` |

O primeiro valor e analitico para `K=1`, `tau=1 s`, `deadTime=0.1 s`. Os dois traces TDPS sao
goldens deterministas da composicao canonica PID/processo/CalcExpression, nao uma tentativa de
replicar detalhes internos do executavel Delphi. O caso Smith exige pelo menos 1204 amostras no
buffer do atraso de 12 s a 10 ms; o teste falha explicitamente se a janela for truncada.

Equacoes/discretizacao das primitivas estao em `features/continuous-discrete-dynamics.md`. Campos TDPS sem
semantica confirmada permanecem no relatorio sidecar do importador como `unsupported`.
