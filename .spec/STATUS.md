# Status das especificações

> Arquivo gerado por `node .spec/governance/generate-status.mjs`. Não editar manualmente.

Total: 26 documentos. accepted: 5; active: 11; deferred: 3; planned: 7.

| ID | Kind | Status | Documento | Dependências |
|---|---|---|---|---|
| ADR-0001 | adr | accepted | [Uma arquitetura de Core para todos os perfis](adr/0001-one-core-architecture.md) | — |
| ADR-0002 | adr | accepted | [Separar autoria, plano compilado e estado runtime](adr/0002-authoring-plan-runtime.md) | ADR-0001 |
| ADR-0003 | adr | accepted | [Coordenador único e workers limitados](adr/0003-coordinator-and-bounded-workers.md) | ADR-0001, ADR-0002 |
| ADR-0004 | adr | accepted | [Evolução incremental da telemetria](adr/0004-telemetry-evolution.md) | ADR-0001 |
| ADR-0005 | adr | accepted | [Política de schemas durante beta](adr/0005-beta-schema-policy.md) | — |
| ARCH-001 | architecture | active | [Fronteiras do sistema](architecture/system-boundaries.md) | — |
| ARCH-002 | architecture | active | [Runtime e SimulationPlan](architecture/runtime-and-simulation-plan.md) | ARCH-001, ARCH-006 |
| ARCH-003 | architecture | active | [Scheduler e tempo virtual](architecture/scheduler-and-time.md) | ARCH-002 |
| ARCH-004 | architecture | active | [Recursos e concorrência](architecture/resource-and-concurrency.md) | ARCH-001, ARCH-002, BENCH-001 |
| ARCH-005 | architecture | active | [IPC e telemetria](architecture/ipc-and-telemetry.md) | ARCH-001, ARCH-004 |
| ARCH-006 | architecture | active | [Topologia e bindings por domínio](architecture/topology-and-bindings.md) | ARCH-001 |
| ARCH-007 | architecture | planned | [Perfis de implantação](architecture/deployment-profiles.md) | ARCH-001, ARCH-004, ARCH-005 |
| ARCH-008 | architecture | active | [Estratégia de testes e regressão](architecture/testing-strategy.md) | ARCH-001, BENCH-001 |
| BENCH-001 | benchmark | active | [Plano de benchmarks e capacidade](benchmarks/capacity-plan.md) | ARCH-001 |
| FEAT-001 | feature | planned | [Signal Engine](features/signal-engine.md) | ARCH-002, ARCH-003, ARCH-006, SCHEMA-001 |
| FEAT-002 | feature | planned | [Dinâmica contínua e discreta](features/continuous-discrete-dynamics.md) | FEAT-001, ARCH-003 |
| FEAT-003 | feature | planned | [Bridges elétrico ↔ sinal](features/electrical-signal-bridges.md) | FEAT-001, FEAT-002, ARCH-006 |
| FEAT-004 | feature | planned | [Subsistemas e templates compilados](features/subsystems.md) | ARCH-002, ARCH-006, SCHEMA-002 |
| FEAT-005 | feature | active | [FPGA/VHDL com GHDL](features/fpga-ghdl.md) | ARCH-001, ARCH-003, ARCH-004 |
| FEAT-006 | feature | deferred | [Runtime Python](features/python-runtime.md) | FEAT-001, ARCH-004, ARCH-005 |
| FEAT-007 | feature | deferred | [Protocolos industriais e PLC](features/protocols-and-plc.md) | FEAT-001, ARCH-003, ARCH-006 |
| FEAT-008 | feature | deferred | [Visualização animada de processo](features/process-visualization.md) | FEAT-001, ARCH-005 |
| GOV-001 | governance | active | [Governança das especificações](governance/governance.md) | — |
| ROADMAP-001 | roadmap | active | [Roadmap arquitetural F0–F10](ROADMAP.md) | GOV-001, BENCH-001 |
| SCHEMA-001 | schema | planned | [Projeto vNext](schemas/project-vnext.md) | ARCH-001, ARCH-006 |
| SCHEMA-002 | schema | planned | [Subsistema vNext](schemas/subsystem-vnext.md) | SCHEMA-001, ARCH-006 |

## Próximo gate

F1 — reconstruir o baseline a partir de checkout/build limpo. Features novas permanecem bloqueadas até F1–F4.
