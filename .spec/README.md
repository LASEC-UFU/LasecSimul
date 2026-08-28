# LasecSimul specifications

Esta pasta contém a especificação técnica canônica do LasecSimul. A arquitetura é única para Desktop, SharedHost e um futuro backend remoto; perfis de implantação alteram orçamentos e transporte, nunca a semântica da simulação.

## Autoridade e precedência

Em caso de conflito, vale a seguinte ordem:

1. requisito explícito da tarefa em andamento;
2. ADR com `status: accepted`;
3. documento de arquitetura com `status: active`;
4. schema ativo;
5. feature ativa ou planejada;
6. roadmap e status, que ordenam trabalho mas não alteram contratos.

Conteúdo em `archive/` é histórico e **não normativo**. Ele pode explicar uma decisão, mas não pode sobrepor esta árvore.

## Estrutura

- `architecture/`: fronteiras e contratos duráveis do sistema;
- `features/`: comportamento e aceitação de funcionalidades, incluindo PLC IEC 61131-3 e protocolos;
- `schemas/`: formatos persistidos e contratos versionados;
- `adr/`: decisões arquiteturais imutáveis, uma por arquivo;
- `benchmarks/`: método, cenários e baselines;
- `governance/`: schema documental e verificadores;
- `archive/legacy-v2/`: especificações anteriores preservadas integralmente.

## Regras de evolução beta

- Formatos experimentais podem sofrer ruptura deliberada com incremento de versão e erro acionável.
- Não é obrigatório manter leitura indefinida de todo formato beta antigo.
- Quando barato e seguro, deve existir conversor explícito de uma versão anterior para a atual.
- Resultados numéricos, determinismo, autoridade do tempo virtual, fidelidade guest-visible ao hardware real e isolamento entre sessões são contratos estáveis e exigem regressão.
- Diagnóstico/trace de alta resolução é opt-in, bounded e não pode alterar semântica nem footprint padrão do SharedHost.
- O projeto persiste autoria; `SimulationPlan` e `RuntimeState` são derivados e não são fontes de verdade.

## Fluxo obrigatório

1. Identificar o documento e o ADR aplicáveis.
2. Atualizar arquitetura/schema antes ou junto de uma mudança incompatível.
3. Vincular critérios de aceitação a testes ou benchmarks reproduzíveis.
4. Executar `node .spec/governance/check-specs.mjs`.
5. Regenerar o índice com `node .spec/governance/generate-status.mjs` quando metadados mudarem.

## Documentos principais

- [Fronteiras do sistema](architecture/system-boundaries.md)
- [Runtime e SimulationPlan](architecture/runtime-and-simulation-plan.md)
- [Scheduler e tempo](architecture/scheduler-and-time.md)
- [Recursos e concorrência](architecture/resource-and-concurrency.md)
- [IPC e telemetria](architecture/ipc-and-telemetry.md)
- [Identidade de runtime, fidelidade e observabilidade causal](architecture/runtime-identity-fidelity-and-observability.md)
- [IPC, fidelidade ao hardware e trace causal](benchmarks/ipc-hardware-fidelity-and-causal-trace.md)
- [Roadmap F0–F10](ROADMAP.md)
- [PLC IEC 61131-3 integrado](features/iec61131-plc.md)
- [Editor IEC 61131-3 e biblioteca comum de POUs](features/iec61131-editor.md)
- [Workspace por domínio](features/workspace-navigation.md)
- [Subsistemas/dispositivos compostos](features/subsystems.md)
- [Biblioteca de referência TDPS](features/tdps-reference-library.md)
- [FPGA/VHDL com GHDL](features/fpga-ghdl.md)
- [Schema IEC 61131-3](schemas/iec61131-project.md)
- [Schema de subsistema/dispositivo composto](schemas/subsystem-vnext.md)
- [ADR de incorporação do OpenPLC v4/STruCpp e pipeline PLC nativo](adr/0007-openplc-v4-incorporation-and-native-plc-pipeline.md)
- [ADR de dispositivos compostos hierárquicos e referência TDPS](adr/0008-hierarchical-composite-devices-and-tdps-reference.md)
- [Plano de benchmarks](benchmarks/capacity-plan.md)
- [Migração do legado](archive/MIGRATION.md)
