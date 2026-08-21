---
id: BENCH-004
kind: benchmark
status: active
dependsOn: [BENCH-001, ARCH-004, ARCH-007, FEAT-007]
supersedes: []
---

# Capacidade SharedHost — 2026-08-20

## Ambiente e cenário

- Windows x64;
- 8 processadores lógicos declarados no perfil administrativo;
- 32 GiB de RAM declarados, 4 GiB reservados e 1 GiB por sessão;
- Core Release com `--resource-profile shared-host`;
- 20 processos Core simultâneos, cada um com named pipe exclusivo;
- 25 rodadas concorrentes de `step(1_000_000 ns)` por processo;
- handshake, leitura de tempo e métricas de budget via IPC v2;
- shutdown solicitado e exit code zero obrigatório para os 20 processos.

Comando: `npm run benchmark:shared-host`.

## Resultado observado

```json
{
  "scenario": "shared-host-empty-core-fair-share",
  "platform": "win32-x64",
  "sessions": 20,
  "roundsPerSession": 25,
  "deltaNsPerRound": 1000000,
  "expectedSimulationTimeNs": 25000000,
  "startupMs": 206,
  "concurrentWorkloadMs": 19,
  "shutdownMs": 8,
  "totalMs": 233,
  "uniquePipes": 20,
  "result": "pass"
}
```

Tempos são diagnóstico da máquina, não promessa universal. O gate é: 20/20 handshakes, tempo
virtual idêntico, budgets SharedHost (`maxParallelTasks <= 2`, `maxExternalProcesses <= 2`,
`maxBuildJobs <= 1`), 20 namespaces únicos e 20/20 encerramentos limpos.

O teste C++ `shared_host_capacity` cobre adicionalmente limite por memória, rejeição de duplicatas,
fila de builds, pesos iguais de fair-share e auditoria de falhas de cleanup. O teste
`plc_session_integration` executa o mesmo artefato PLC nos perfis Desktop e SharedHost e exige
resultado/tempo virtual equivalentes.
