---
id: ROADMAP-001
kind: roadmap
status: active
currentGate: release-lab
dependsOn: [GOV-001, BENCH-001, BENCH-005]
supersedes: []
---

# Roadmap arquitetural F0–F10

O roadmap substitui a ordem histórica que iniciava pelo Signal Engine. Cada fase só começa após os critérios da fase anterior estarem automatizados.

| Fase | Objetivo | Entregáveis | Aceitação | Bloqueia |
|---|---|---|---|---|
| F0 | Governança | árvore canônica, archive, checker, status gerado | IDs únicos, DAG válida, links íntegros | todas |
| F1 | Baseline | runner limpo, cenários Core/IPC/processos, baseline versionado | build do zero e métricas reproduzíveis | F2–F10 |
| F2 | Recursos | `ResourceGovernor`, pool preguiçoso, filas limitadas | sessão vazia sem workers extras; 1/2/N workers determinísticos | F3, F8, F9, F10 |
| F3 | Execução | `SimulationPlan`, `RuntimeState`, listas densas, invalidação por domínio | sem scans globais no passo; plano publicável parado | F5–F9 |
| F4 | Telemetria | lanes, frame batelado e coalescência | memória limitada; controle nunca descartado | F5, F8, F9, F10 |
| F5 | Signal Engine | slots tipados, SCCs, RateGroups, microsteps | tipos/unidades, loops diagnosticados, zero alocação steady-state | F6–F9 |
| F6 | Dinâmica | integradores e blocos contínuos/discretos | golden models e erro/timestep controlados | F7 |
| F7 | Bridges/subsystems + referência TDPS | bridges explícitos, shell externo + grafo interno, templates por conteúdo e biblioteca/importador TDPS | cache hit, equivalência composite/expansão, estado isolado e goldens TDPS | F8–F9 |
| F8 | Python | worker por sessão, `STEP_BATCH`, watchdog | timeout/crash/restart e limites comprovados | F9–F10 |
| F9 | PLC IEC 61131-3 + protocolos | editores 5 linguagens (LD/FBD vendorizados), lowering para ST, STruCpp, worker PLC nativo, bloco PLC, cross-language POUs, Modbus/HART | matriz 5×5, scan virtual, pinos dinâmicos, cache seguro, sem portas implícitas | F10 |
| F10 | SharedHost | perfis administrativos e capacidade multi-sessão | fair-share e N sessões em host definido | release lab |


## F7 — decomposição obrigatória

### F7A — hierarquia e shell/implementation graph

- `ADR-0008`, `SCHEMA-002` e `FEAT-004`;
- interface externa tipada com `pinId` estavel e tunnel de fronteira;
- `symbol` externo separado da semantica interna;
- `components`/`topology`, `exportedPropertyComponentIds` e telemetria/Probe existentes;
- editor de subcircuito existente, nesting e tuneis de fronteira;
- hash semantico/cache transitivo e compilacao cold-path para o plano de sinal normal;
- nested composites com rejeição de ciclo.

Gate: composto e expansão manual são numericamente equivalentes, duas instâncias não compartilham estado e mudança visual não quebra bindings.

### F7B — biblioteca de processo e compatibilidade de autoria TDPS

- `FEAT-012`;
- PID e primitivas de processo necessárias;
- `PROCESSO` TDPS-like como composite quando decomponível;
- `CalcExpression` segura;
- Scope/XYRecorder/AnimatedValue;
- parser `.smp` e conversão de `Mnn`/índices globais para edges explícitos;
- basic flow loop e Smith predictor como primeiros goldens.

Gate: os 24 `.smp` de referência são parseados sem crash; pelo menos dois cenários convertidos compilam e reproduzem os goldens dentro da tolerância documentada.

## F9 — decomposição obrigatória

### F9A — autoria e compilador IEC

- schema `SCHEMA-003`;
- editores LD, FBD, ST, SFC e IL — LD/FBD/ST/IL vendorizados do OpenPLC v4, SFC próprio do LasecSimul —, com browser de blocos comum às cinco (`FEAT-010`);
- interface POU independente da linguagem;
- symbol table e type checker únicos;
- lowering de LD/FBD/SFC para ST canônico (`ADR-0007`);
- linker cross-language;
- STruCpp vendorizado (ST -> C++17), manifesto, hashes e debug map.

Gate: exemplos unitários das cinco linguagens compilam e `PlcNativeModule` inválido/incompatível é rejeitado.

### F9B — PLC virtual no Core

- worker `PlcNativeModule` isolado (padrão coordenador/workers de `ADR-0003`);
- `PlcPlan` e estado por instância;
- scan `InputLatch -> TaskEvaluate -> OutputCommit` via IPC com o worker;
- timers/counters/SFC em tempo virtual;
- bloco vazio antes do load e pinos derivados de `exportedIo[]`;
- watch/force/step/reset;
- matriz automatizada **5×5** de interoperabilidade entre linguagens.

Gate: um FB implementado em cada linguagem é usado a partir de todas as cinco e duas instâncias nunca compartilham estado.

### F9C — protocolos

- Modbus semântico;
- binding explícito PLC/Signal ↔ Modbus;
- HART semântico;
- transportes reais somente opt-in.

Gate: PLC funciona sem protocolos e protocolos funcionam sem PLC.

## Gate atual

F0–F10 estão concluídos e automatizados. O próximo gate é o release lab, que deve repetir os
baselines de capacidade e os testes externos no ambiente de distribuição antes de publicar.

O release lab também fecha o track cross-cutting de fidelidade/IPC de `ADR-0009`/`BENCH-005`:

- provenance dos binários efetivamente carregados;
- identidade sem colisão em pause/resume, stop/start, relaunch, múltiplos runtimes e sessões;
- trace causal bounded sem observer effect não documentado;
- comparação fast/reference/hardware para os periféricos críticos disponíveis;
- nenhuma otimização de latência promovida se alterar semântica guest-visible ou multiplicar recursos por sessão sem benchmark SharedHost.

## Política de exceção

Correções de segurança, perda de dados, regressão numérica ou crash podem atravessar o gate. A exceção deve ter teste de regressão e não pode introduzir uma segunda arquitetura.
