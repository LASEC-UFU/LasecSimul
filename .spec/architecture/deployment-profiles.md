---
id: ARCH-007
kind: architecture
status: active
dependsOn: [ARCH-001, ARCH-004, ARCH-005, ADR-0009]
supersedes: []
---

# Perfis de implantação

## Local Desktop

Extension, IEC Compiler e Core estão na mesma máquina; named pipe/Unix socket é o transporte. Cache e runtimes externos são provisionados localmente. O PLC bytecode é executado no Core, não em runtime PLC separado.

## SharedHost

Cada usuário mantém processo Core e diretórios/arenas próprios. Política administrativa fornece `SharedHost` budgets. Builds IEC usam fila limitada/cache imutável e não criam um compilador residente por bloco. O scheduler do SO distribui processos; afinidade não é aplicada por padrão.

`resources::SharedHostCapacity` aplica a admissão antes de iniciar cada Core, deriva namespaces
independentes para pipe, arena, porta virtual e workdir, limita a fila de builds e registra falhas
de encerramento de processos filhos. O `ResourceBudget` entregue em cada lease é imutável durante a
sessão. O gerenciador não hospeda estado de simulação e não remove workdirs por conta própria.

### Identidade e diagnóstico no SharedHost

Cada execução possui identidade independente mesmo quando projeto, firmware e binários são idênticos. Runtimes externos recebem IDs densos no launch e seus traces usam namespaces/workdirs próprios. Relaunch altera `launch_generation`; pause/resume não cria nova execução.

Trace `OFF` é o default de produção/capacidade e não aloca buffer/arquivo/thread. `DETAILED` é diagnóstico explícito, lazy e bounded; não se assume 1.000.000 de records por processo como default. Otimizações que alterem recursos por sessão devem passar pela matriz de densidade de `BENCH-005` antes de promoção.

### Cenário de capacidade F10

- host: Windows x64, 8 processadores lógicos, 32 GiB, 4 GiB reservados;
- perfil: até 20 sessões administrativas, 1 GiB residente por sessão, 2 processos externos por
  sessão, 2 builds IEC concorrentes no host;
- carga automatizada: 20 processos Core, 25 passos concorrentes de 1 ms virtual por sessão;
- comando reproduzível: `npm run benchmark:shared-host`;
- evidência versionada: `BENCH-004`.

## Backend remoto futuro

A Extension usa o mesmo backend contract através de transporte autenticado. O servidor provisiona exatamente o mesmo Core por sessão e a mesma versão de ABI PLC. Autenticação, quotas e descoberta são responsabilidades de deployment, não do solver ou da semântica IEC.

## HostSupervisor

É opcional e adiado. Pode ser introduzido apenas se F10 provar necessidade de coordenação dinâmica de cache, quotas ou processos. Não pode hospedar estado mutável de múltiplas sessões no mesmo Core.

## Aceitação

- mesmo projeto produz resultado equivalente nos perfis;
- `PlcCompiledArtifact` compatível produz a mesma semântica em todos os perfis;
- nomes de pipe, arena, porta virtual e workdir não colidem;
- encerramento do Core mata filhos ou registra falha de cleanup;
- nenhuma promessa de capacidade sem host/cenário/versão definidos;
- duas sessões com mesmos artefatos não colidem em execution identity, trace path ou correlação;
- sessão SharedHost com trace OFF não paga buffer/thread/wake diagnóstico.
