---
id: ADR-0002
kind: adr
status: accepted
dependsOn: [ADR-0001]
supersedes: []
---

# Separar autoria, plano compilado e estado runtime

## Decisão

O modelo persistido é normalizado/validado e compilado em `SimulationPlan` quase imutável. Todo estado mutável pertence a `RuntimeState` por sessão/instância.

## Consequências

- strings e referências saem do hot path;
- planos podem ser compartilhados somente quando imutáveis;
- falha de compilação não corrompe runtime anterior;
- projeto não persiste caches ou estado transitório.
