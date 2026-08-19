---
id: ARCH-004
kind: architecture
status: active
dependsOn: [ARCH-001, ARCH-002, BENCH-001]
supersedes: []
---

# Recursos e concorrência

## ResourceGovernor

Cada sessão recebe uma política imutável por rodada:

```cpp
ResourceBudget {
  maxWorkerThreads,
  maxParallelTasks,
  maxExternalProcesses,
  maxBuildJobs,
  plcVmMemoryBytes,
  telemetryBytesPerSecond,
  telemetryQueueBytes,
  scopeHistoryBytes,
  logBytes,
  cacheBytes,
  commandQueueCapacity
}
```

`maxWorkerThreads` conta somente threads adicionais; a coordenadora pode participar do trabalho e
está incluída em `maxParallelTasks`. Limites de telemetria, histórico, logs e cache são expressos em
bytes; a fila de comandos usa quantidade de comandos porque closures não possuem tamanho portável.

O Governor concede orçamento; pools, telemetria, PLC VM e caches continuam donos de seus recursos. Apenas esta camada consulta capacidade de CPU ou política administrativa.

## Workers

- pool criado preguiçosamente quando `grant > 1` e o custo estimado supera o threshold;
- a thread coordenadora também pode executar uma tarefa;
- workers ficam estacionados quando ociosos;
- orçamento muda somente parado ou em barreira segura;
- tarefas leem plano/snapshot e escrevem em scratch disjunto;
- commit e reduções globais ocorrem em ordem determinística.

Paralelizar inicialmente apenas ilhas MNA e lotes/SCCs independentes. PLC tasks de uma mesma instância executam segundo a ordem IEC compilada; não paralelizar chamadas internas de POU sem prova específica.

Compilação IEC é build job limitado, separado do pool de simulação. Cacheia `PlcCompiledArtifact` por hash e publica somente artefato completo/imútavel.

## Perfis

- `Desktop`: orçamento moderado, ainda limitado e lazy;
- `SharedHost`: coordenador + 0–1 worker inicialmente, telemetria conservadora e build queue limitada;
- `Custom`: limites administrativos explícitos;
- `Automatic`: escolhe perfil, nunca concede toda a máquina a cada sessão.

Afinidade, CPU sets e HostSupervisor não são defaults. Um HostSupervisor só entra se benchmark multi-sessão demonstrar que processos independentes e políticas do SO são insuficientes.

## Filas

Toda fila declara produtor, consumidor, capacidade, unidade do limite, overflow, ordem e shutdown. Comandos não podem ser descartados silenciosamente; telemetria intermediária pode ser coalescida. Build IEC não cria fila ilimitada de recompilações: alterações rápidas coalescem por geração de autoria.

## Aceitação

- sessão vazia cria zero worker extra;
- thread count respeita orçamento em todas as sessões;
- build IEC respeita `maxBuildJobs` e não bloqueia indefinidamente o coordenador de simulação;
- memória total das PLC VMs respeita orçamento por sessão;
- memória de filas/logs/Scope é limitada;
- resultados são equivalentes com 1, 2 e N workers;
- benchmark decide thresholds e defaults.
