---
id: ARCH-008
kind: architecture
status: active
dependsOn: [ARCH-001, BENCH-001]
supersedes: []
---

# Estratégia de testes e regressão

## Pirâmide

1. unidades puras: schemas, grafos, SCC, unidades, filas, parser/type-checker IEC;
2. compilador IEC: front-ends LD/FBD/ST/SFC/IL, linker cross-language, IR, bytecode e debug map;
3. Core headless: Scheduler, Netlist, solver, planos e PLC VM;
4. processo real: IPC, restart, cleanup, QEMU/GHDL/Python e build toolchains opcionais;
5. Extension integrada: persistência, editores IEC, rebuild, pinos dinâmicos e telemetria;
6. stress/capacidade: múltiplas sessões e longa duração.

## Contratos obrigatórios

- determinismo com 1, 2 e N workers;
- golden numérico com tolerância documentada;
- tempo virtual independente de wall clock;
- memória/filas limitadas;
- falhas de runtimes externos contidas;
- build e testes a partir de checkout limpo;
- benchmarks não substituem assertions semânticas.

## Matriz IEC obrigatória

Existe um suite de conformance 5×5:

```text
implementação \ chamador | LD | FBD | ST | SFC | IL
--------------------------+----+-----+----+-----+---
LD                        | ✓  | ✓   | ✓  | ✓   | ✓
FBD                       | ✓  | ✓   | ✓  | ✓   | ✓
ST                        | ✓  | ✓   | ✓  | ✓   | ✓
SFC                       | ✓  | ✓   | ✓  | ✓   | ✓
IL                        | ✓  | ✓   | ✓  | ✓   | ✓
```

A matriz cobre pelo menos:

- `FUNCTION` pura;
- `FUNCTION_BLOCK` stateful com duas instâncias independentes;
- BOOL, integer, REAL, enum e struct suportados;
- `VAR_IN_OUT` quando implementado;
- timers/counters;
- chamadas aninhadas entre três linguagens diferentes;
- erro de tipo e símbolo inexistente;
- source map de diagnóstico para a linguagem original.

Também existem goldens onde um mesmo algoritmo é implementado nas cinco linguagens e deve produzir a mesma sequência de saída.

## Bloco PLC

Testes obrigatórios:

- inserir sem programa -> zero pinos;
- load de artefato -> pinos exatamente conforme manifesto;
- rename com mesmo `ioId` -> fio preservado;
- remoção -> orphan explícito;
- recompilação inválida -> último artefato válido continua disponível, sem publicação parcial;
- duas instâncias do mesmo artifact -> memória independente;
- cold/warm reset e RETAIN;
- step/accelerated/headless -> mesma semântica temporal.

## Baselines

Todo baseline registra commit, toolchain, CPU, RAM, SO, perfil, comando, cenário e versão do formato. Para IEC registra também `compilerVersion`, `abiVersion`, hashes de libraries e backend de bytecode. Resultado sem ambiente definido é diagnóstico, não gate de capacidade.

## Aceitação

- CI separa testes herméticos de testes que exigem toolchain externo;
- suite PLC bytecode é hermética e não exige OpenPLC Runtime instalado;
- matriz IEC 5×5 é gate antes de `FEAT-007` tornar-se `active`;
- flaky test não é promovido a gate até ter causa e política;
- regressão de performance exige limiar estatístico, não uma única execução;
- cada feature normativa aponta para testes concretos antes de `status: active`.
