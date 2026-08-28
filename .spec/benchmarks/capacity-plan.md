---
id: BENCH-001
kind: benchmark
status: active
dependsOn: [ARCH-001, ADR-0009]
supersedes: []
---

# Plano de benchmarks e capacidade

## Princípio

Não declarar “suporta N alunos/sessões” sem cenário, host, toolchain, perfil e percentis definidos. Build deve partir de checkout limpo.

## Tiers

### A — Core headless

- vazio, passivo, RC/RLC, digital e instrumentos;
- 1/2/N workers;
- muitos grupos pequenos e poucos grupos grandes;
- topologia estável versus mutações.

### B — IPC/Extension

- latência de controle sob telemetria saturada;
- JSON batelado versus binário;
- Webview aberta, oculta e fechada;
- volume e drops por stream.

### C — runtimes externos

- 1/N QEMUs e FPGAs;
- cache GHDL cold/hot/concorrente;
- Python batch, timeout e restart;
- RSS, processos, handles e cleanup.

### D — SharedHost

- 1, 5, 10, 20... sessões no mesmo host;
- startup simultâneo e escalonado;
- fair-share, p95/p99 de controle e taxa virtual;
- encerramento/restart e pressão de memória/disco.

### E — fidelidade/IPC causal

- fixed host wall-clock versus fixed guest workload;
- QEMU/Core request-completion e waits no caminho crítico;
- observer effect `OFF|COUNTERS|DETAILED`;
- backend fast/reference versus hardware/datasheet;
- lifecycle identity sob restart/relaunch/múltiplos runtimes;
- densidade 1/4/8/20 sessões antes de promover footprint/threads/wakeups novos.

O protocolo detalhado está em [BENCH-005](ipc-hardware-fidelity-and-causal-trace.md).

## Métricas

Throughput, latência p50/p95/p99, CPU por máquina e processo, RSS/commit, threads, processos, handles/FDs, context switches/wakeups quando disponíveis, bytes/requests IPC, queue depth/drops, eventos, settles, stamps, fatorações, erro numérico, virtual-time/host-time ratio e erro temporal contra hardware quando houver referência.

## Gates iniciais

- sessão vazia: zero worker adicional;
- fila: crescimento limitado sob consumidor lento;
- determinismo: hash/fixtures equivalentes em 1/2/N workers;
- regressão: mínimo de 10 amostras após warm-up e limiar definido por cenário;
- SharedHost: nenhuma sessão monopoliza todos os CPUs por decisão local;
- trace OFF: zero buffer/arquivo/thread/wake específico;
- causal trace: análise só é válida com zero drops e integridade comprovada.

## Baseline observado

O arquivo `baseline-2026-08-15.json` registra medições exploratórias dos binários Release existentes. Não é baseline oficial porque a árvore local não foi reconstruída do zero.
