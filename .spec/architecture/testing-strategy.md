---
id: ARCH-008
kind: architecture
status: active
dependsOn: [ARCH-001, BENCH-001, BENCH-005, ADR-0009]
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
- benchmarks não substituem assertions semânticas;
- hardware real/datasheet é oracle externo de fidelidade quando disponível;
- trace/diagnóstico não pode alterar comportamento qualitativo ou ser tratado como timing funcional.

## Fidelidade, IPC e observer effect

Para runtimes/periféricos onde tempo e protocolo são guest-visible, testes distinguem:

1. `fixed host wall-clock` para throughput;
2. `fixed guest workload` para overhead/observer effect;
3. comparação com hardware real/datasheet quando disponível.

Backends fast/reference são comparados por bytes, ACK/NACK, estado intermediário/final, FIFO/IRQ/timers, ordem e tempo virtual; concordância entre dois backends não supera evidência física.

Trace causal usado como prova exige zero drops, zero órfãos/duplicatas, identidade/dependências válidas e provenance compatível. `DETAILED` não é benchmark final quando seu observer effect for material.

Testes de lifecycle cobrem pause/resume, stop/start, relaunch com contador local reiniciado, múltiplos runtimes e múltiplas sessões sem colisão.

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


## Hierarquia e referência TDPS

Testes obrigatórios de `FEAT-004`/`FEAT-012`:

- composto versus expansão manual do mesmo grafo;
- duas instâncias com estado dinâmico independente;
- nested composite com hash transitivo e rejeição de ciclo;
- rename/movimento visual de porta preservando binding por `portId`;
- remoção de porta conectada produzindo orphan explícito;
- mudança interna com interface estável preservando fios externos;
- `parameterOverride` atingindo apenas o target/instância correto;
- parser dos 24 `.smp` de referência sem crash;
- importador resolvendo `Mnn`/índices globais para edges explícitos;
- golden de basic flow loop e Smith predictor;
- regressões de FirstOrder/FOPDT/DeadTime/Valve/Stiction/RateLimiter quando portados;
- observer/Scope/AnimatedValue não alterando resultado numérico.

Fixtures provenientes do TDPS devem registrar origem/versão e tolerância. Estado transitório salvo no `.smp` não se torna estado canônico de projeto; quando usado para reprodução, fica isolado na fixture de teste.

## Baselines

Todo baseline registra commit, toolchain, CPU, RAM, SO, perfil, comando, cenário e versão do formato. Para IEC registra também `compilerVersion`, `abiVersion`, hashes de libraries e backend de bytecode. Resultado sem ambiente definido é diagnóstico, não gate de capacidade.

## Aceitação

- CI separa testes herméticos de testes que exigem toolchain externo;
- suite PLC bytecode é hermética e não exige OpenPLC Runtime instalado;
- matriz IEC 5×5 é gate antes de `FEAT-007` tornar-se `active`;
- flaky test não é promovido a gate até ter causa e política;
- regressão de performance exige limiar estatístico, não uma única execução;
- cada feature normativa aponta para testes concretos antes de `status: active`;
- `FEAT-004` só vira `active` após equivalência de composite/expansão e isolamento de instâncias;
- `FEAT-012` só vira `active` após parser/importador e pelo menos dois cenários TDPS com golden documentado;
- fast path de runtime externo não vira default sem differential test e benchmark `BENCH-005`;
- mudança que aumenta recurso por sessão não vira default SharedHost sem densidade reproduzível.
