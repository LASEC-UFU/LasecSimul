---
id: ROADMAP-001
kind: roadmap
status: active
dependsOn: [GOV-001, BENCH-001]
supersedes: []
---

# Roadmap arquitetural F0–F10

O roadmap substitui a ordem histórica que iniciava pelo Signal Engine. Cada fase só começa após os critérios da fase anterior estarem automatizados.

| Fase | Objetivo | Entregáveis | Aceitação | Bloqueia |
|---|---|---|---|---|
| F0 | Governança | árvore canônica, archive, checker, status gerado | IDs únicos, DAG válida, links íntegros | todas |
| F1 | Baseline | runner limpo, cenários Core/IPC/processos, baseline versionado | build do zero e métricas reproduzíveis | F2–F10 |
| F2 | Recursos | `ResourceGovernor`, pool preguiçoso, filas limitadas | sessão vazia sem workers extras; 1/2/N workers determinísticos | F3, F8, F10 |
| F3 | Execução | `SimulationPlan`, `RuntimeState`, listas densas, invalidação por domínio | sem scans globais de reativos/FPGA no passo; plano publicável parado | F5–F9 |
| F4 | Telemetria | lanes, frame batelado e coalescência | memória limitada; controle nunca descartado | F5, F8, F10 |
| F5 | Signal Engine | slots tipados, SCCs, RateGroups, microsteps | tipos/unidades, loops diagnosticados, zero alocação steady-state | F6–F9 |
| F6 | Dinâmica | integradores e blocos contínuos/discretos | golden models e erro/timestep controlados | F7 |
| F7 | Bridges/subsystems | bridges explícitos e templates por conteúdo | cache hit, equivalência numérica e estado isolado | F8–F9 |
| F8 | Python | worker por sessão, `STEP_BATCH`, watchdog | timeout/crash/restart e limites comprovados | F9–F10 |
| F9 | Protocolos/externos | PLC, HART, Modbus e endurecimento GHDL | tempo virtual correto, cache seguro, sem portas implícitas | F10 |
| F10 | SharedHost | perfis administrativos e capacidade multi-sessão | fair-share e N sessões em host definido | release lab |

## Gate atual

F0 é concluído por esta reorganização quando o checker passa. O próximo trabalho de produto é F1; nenhuma feature nova deve furar F1–F4.

## Política de exceção

Correções de segurança, perda de dados, regressão numérica ou crash podem atravessar o gate. A exceção deve ter teste de regressão e não pode introduzir uma segunda arquitetura.
