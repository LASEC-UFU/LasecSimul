---
id: ARCH-008
kind: architecture
status: active
dependsOn: [ARCH-001, BENCH-001]
supersedes: []
---

# Estratégia de testes e regressão

## Pirâmide

1. unidades puras: schemas, grafos, SCC, unidades, filas;
2. Core headless: Scheduler, Netlist, solver, planos;
3. processo real: IPC, restart, cleanup, QEMU/GHDL/Python;
4. Extension integrada: persistência, rebuild e telemetria;
5. stress/capacidade: múltiplas sessões e longa duração.

## Contratos obrigatórios

- determinismo com 1, 2 e N workers;
- golden numérico com tolerância documentada;
- tempo virtual independente de wall clock;
- memória/filas limitadas;
- falhas de runtimes externos contidas;
- build e testes a partir de checkout limpo;
- benchmarks não substituem assertions semânticas.

## Baselines

Todo baseline registra commit, toolchain, CPU, RAM, SO, perfil, comando, cenário e versão do formato. Resultado sem ambiente definido é diagnóstico, não gate de capacidade.

## Aceitação

- CI separa testes herméticos de testes que exigem toolchain externo;
- flaky test não é promovido a gate até ter causa e política;
- regressão de performance exige limiar estatístico, não uma única execução;
- cada feature normativa aponta para testes concretos antes de `status: active`.
