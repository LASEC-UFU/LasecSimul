---
id: ARCH-007
kind: architecture
status: planned
dependsOn: [ARCH-001, ARCH-004, ARCH-005]
supersedes: []
---

# Perfis de implantação

## Local Desktop

Extension, IEC Compiler e Core estão na mesma máquina; named pipe/Unix socket é o transporte. Cache e runtimes externos são provisionados localmente. O PLC bytecode é executado no Core, não em runtime PLC separado.

## SharedHost

Cada usuário mantém processo Core e diretórios/arenas próprios. Política administrativa fornece `SharedHost` budgets. Builds IEC usam fila limitada/cache imutável e não criam um compilador residente por bloco. O scheduler do SO distribui processos; afinidade não é aplicada por padrão.

## Backend remoto futuro

A Extension usa o mesmo backend contract através de transporte autenticado. O servidor provisiona exatamente o mesmo Core por sessão e a mesma versão de ABI PLC. Autenticação, quotas e descoberta são responsabilidades de deployment, não do solver ou da semântica IEC.

## HostSupervisor

É opcional e adiado. Pode ser introduzido apenas se F10 provar necessidade de coordenação dinâmica de cache, quotas ou processos. Não pode hospedar estado mutável de múltiplas sessões no mesmo Core.

## Aceitação

- mesmo projeto produz resultado equivalente nos perfis;
- `PlcCompiledArtifact` compatível produz a mesma semântica em todos os perfis;
- nomes de pipe, arena, porta virtual e workdir não colidem;
- encerramento do Core mata filhos ou registra falha de cleanup;
- nenhuma promessa de capacidade sem host/cenário/versão definidos.
