---
id: ADR-0001
kind: adr
status: accepted
dependsOn: []
supersedes: []
---

# Uma arquitetura de Core para todos os perfis

## Decisão

Desktop, SharedHost e backend remoto usam o mesmo Core, Scheduler, planos de domínio e solver. Cada sessão possui um processo Core. O remoto é extensão de transporte/provisionamento.

## Consequências

- isolamento natural de falha e recursos;
- sem Core multi-tenant com estado compartilhado;
- perfis alteram budgets, não semântica;
- capacidade é medida em processos/sessões reais.
