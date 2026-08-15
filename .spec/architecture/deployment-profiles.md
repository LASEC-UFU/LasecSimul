---
id: ARCH-007
kind: architecture
status: planned
dependsOn: [ARCH-001, ARCH-004, ARCH-005]
supersedes: []
---

# Perfis de implantação

## Local Desktop

Extension e Core estão na mesma máquina; named pipe/Unix socket é o transporte. Cache e runtimes externos são provisionados localmente.

## SharedHost

Cada usuário mantém processo Core e diretórios/arenas próprios. Política administrativa fornece `SharedHost` budgets. O scheduler do SO distribui processos; afinidade não é aplicada por padrão.

## Backend remoto futuro

A Extension usa o mesmo backend contract através de transporte autenticado. O servidor provisiona exatamente o mesmo Core por sessão. Autenticação, quotas e descoberta são responsabilidades de deployment, não do solver.

## HostSupervisor

É opcional e adiado. Pode ser introduzido apenas se F10 provar necessidade de coordenação dinâmica de cache, quotas ou processos. Não pode hospedar estado mutável de múltiplas sessões no mesmo Core.

## Aceitação

- mesmo projeto produz resultado equivalente nos perfis;
- nomes de pipe, arena, porta virtual e workdir não colidem;
- encerramento do Core mata filhos ou registra falha de cleanup;
- nenhuma promessa de capacidade sem host/cenário/versão definidos.
