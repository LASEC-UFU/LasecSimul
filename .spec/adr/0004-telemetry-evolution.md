---
id: ADR-0004
kind: adr
status: accepted
dependsOn: [ADR-0001]
supersedes: []
---

# Evolução incremental da telemetria

## Decisão

Telemetria evolui em quatro estágios: filas limitadas/classificadas, frame JSON batelado, framing binário e shared memory apenas para stream local comprovadamente limitado.

## Consequências

- controle confiável é separado de frames substituíveis;
- backend remoto preserva o contrato sem depender de shared memory;
- complexidade só entra após medição.
