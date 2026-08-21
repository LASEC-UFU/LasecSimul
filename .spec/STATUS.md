# Status das especificações

> Arquivo gerado por `node .spec/governance/generate-status.mjs`. Não editar manualmente.

Total: 37 documentos. accepted: 7; active: 27; deferred: 1; planned: 1; superseded: 1.

| ID | Kind | Status | Documento | Dependências |
|---|---|---|---|---|
| ADR-0001 | adr | accepted | [Uma arquitetura de Core para todos os perfis](adr/0001-one-core-architecture.md) | — |
| ADR-0002 | adr | accepted | [Separar autoria, plano compilado e estado runtime](adr/0002-authoring-plan-runtime.md) | ADR-0001 |
| ADR-0003 | adr | accepted | [Coordenador único e workers limitados](adr/0003-coordinator-and-bounded-workers.md) | ADR-0001, ADR-0002 |
| ADR-0004 | adr | accepted | [Evolução incremental da telemetria](adr/0004-telemetry-evolution.md) | ADR-0001 |
| ADR-0005 | adr | accepted | [Política de schemas durante beta](adr/0005-beta-schema-policy.md) | — |
| ADR-0006 | adr | superseded | [IEC 61131-3: POUs cross-language sobre IR e ABI comuns](adr/0006-iec61131-common-ir-and-cross-language-pous.md) | ADR-0001, ADR-0002 |
| ADR-0007 | adr | accepted | [Incorporação do OpenPLC v4/STruCpp, relicenciamento GPL-3.0 e pipeline PLC nativo](adr/0007-openplc-v4-incorporation-and-native-plc-pipeline.md) | ADR-0001, ADR-0002, ADR-0003 |
| ADR-0008 | adr | accepted | [Processos TDPS-like como subcircuitos nativos do LasecSimul](adr/0008-hierarchical-composite-devices-and-tdps-reference.md) | ADR-0001, ADR-0002, ADR-0005 |
| ARCH-001 | architecture | active | [Fronteiras do sistema](architecture/system-boundaries.md) | — |
| ARCH-002 | architecture | active | [Runtime e SimulationPlan](architecture/runtime-and-simulation-plan.md) | ARCH-001, ARCH-006 |
| ARCH-003 | architecture | active | [Scheduler e tempo virtual](architecture/scheduler-and-time.md) | ARCH-002 |
| ARCH-004 | architecture | active | [Recursos e concorrência](architecture/resource-and-concurrency.md) | ARCH-001, ARCH-002, BENCH-001 |
| ARCH-005 | architecture | active | [IPC e telemetria](architecture/ipc-and-telemetry.md) | ARCH-001, ARCH-004 |
| ARCH-006 | architecture | active | [Topologia e bindings por domínio](architecture/topology-and-bindings.md) | ARCH-001 |
| ARCH-007 | architecture | active | [Perfis de implantação](architecture/deployment-profiles.md) | ARCH-001, ARCH-004, ARCH-005 |
| ARCH-008 | architecture | active | [Estratégia de testes e regressão](architecture/testing-strategy.md) | ARCH-001, BENCH-001 |
| BENCH-001 | benchmark | active | [Plano de benchmarks e capacidade](benchmarks/capacity-plan.md) | ARCH-001 |
| BENCH-002 | benchmark | active | [Matriz de cobertura F7 — controle/processo TDPS](fixtures/f7-process-coverage.md) | BENCH-001, FEAT-012 |
| BENCH-003 | benchmark | active | [Goldens de processo do gate F7](fixtures/f7-process-goldens.md) | BENCH-001, FEAT-002, FEAT-012 |
| BENCH-004 | benchmark | active | [Capacidade SharedHost — 2026-08-20](benchmarks/shared-host-capacity-2026-08-20.md) | BENCH-001, ARCH-004, ARCH-007, FEAT-007 |
| FEAT-001 | feature | active | [Signal Engine](features/signal-engine.md) | ARCH-002, ARCH-003, ARCH-006, SCHEMA-001 |
| FEAT-002 | feature | active | [Dinâmica contínua e discreta](features/continuous-discrete-dynamics.md) | FEAT-001, ARCH-003 |
| FEAT-003 | feature | active | [Bridges elétrico ↔ sinal](features/electrical-signal-bridges.md) | FEAT-001, FEAT-002, ARCH-006 |
| FEAT-004 | feature | active | [Evolução do subcircuito para modelos de processo e controle](features/subsystems.md) | ARCH-002, ARCH-006, SCHEMA-002, ADR-0008, FEAT-001 |
| FEAT-005 | feature | active | [FPGA/VHDL com GHDL](features/fpga-ghdl.md) | ARCH-001, ARCH-003, ARCH-004, FEAT-011 |
| FEAT-006 | feature | active | [Runtime Python](features/python-runtime.md) | FEAT-001, ARCH-004, ARCH-005 |
| FEAT-007 | feature | active | [PLC IEC 61131-3 integrado ao LasecSimul](features/iec61131-plc.md) | FEAT-001, ARCH-002, ARCH-003, ARCH-006, SCHEMA-003, ADR-0007 |
| FEAT-008 | feature | deferred | [Visualização animada de processo](features/process-visualization.md) | FEAT-001, ARCH-005, FEAT-011 |
| FEAT-009 | feature | active | [Protocolos industriais](features/industrial-protocols.md) | FEAT-001, ARCH-003, ARCH-006 |
| FEAT-010 | feature | active | [Editor IEC 61131-3 e biblioteca comum de POUs](features/iec61131-editor.md) | FEAT-007, ADR-0007, SCHEMA-003 |
| FEAT-011 | feature | active | [Navegação por domínio na paleta](features/workspace-navigation.md) | ARCH-001 |
| FEAT-012 | feature | active | [Biblioteca de controle/processo inspirada no TDPS e importação `.smp`](features/tdps-reference-library.md) | FEAT-001, FEAT-002, FEAT-004, SCHEMA-002, ADR-0008 |
| GOV-001 | governance | active | [Governança das especificações](governance/governance.md) | — |
| ROADMAP-001 | roadmap | active | [Roadmap arquitetural F0–F10](ROADMAP.md) | GOV-001, BENCH-001 |
| SCHEMA-001 | schema | planned | [Projeto vNext](schemas/project-vnext.md) | ARCH-001, ARCH-006 |
| SCHEMA-002 | schema | active | [Subcircuito hierarquico nativo — schemaVersion 3](schemas/subsystem-vnext.md) | SCHEMA-001, ARCH-006, ADR-0008 |
| SCHEMA-003 | schema | active | [Projeto IEC 61131-3 e artefato PLC](schemas/iec61131-project.md) | SCHEMA-001, ARCH-002, ARCH-006, ADR-0007 |

## Próximo gate

Gate atual: release-lab. Ver ROADMAP.md para objetivo/entregáveis/aceitação desta fase.
