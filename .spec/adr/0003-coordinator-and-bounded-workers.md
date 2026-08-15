---
id: ADR-0003
kind: adr
status: accepted
dependsOn: [ADR-0001, ADR-0002]
supersedes: []
---

# Coordenador único e workers limitados

## Decisão

Uma thread Scheduler/coordenadora é dona da ordem e do estado global. Paralelismo ocorre apenas em tarefas independentes através de pool preguiçoso limitado pelo `ResourceGovernor`.

## Consequências

- não há thread por bloco/dispositivo/protocolo;
- workers produzem scratch e o coordenador commita em ordem fixa;
- mudança de orçamento ocorre em barreira segura;
- `hardware_concurrency()` só é consultado pela camada de recursos.
