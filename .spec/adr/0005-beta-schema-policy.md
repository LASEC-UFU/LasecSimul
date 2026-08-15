---
id: ADR-0005
kind: adr
status: accepted
dependsOn: []
supersedes: []
---

# Política de schemas durante beta

## Decisão

Schemas experimentais podem sofrer ruptura deliberada. Toda ruptura incrementa versão, rejeita carga parcial e fornece diagnóstico/conversão explícita quando economicamente razoável.

## Consequências

- não existe compatibilidade preventiva indefinida;
- golden semântico/numérico permanece obrigatório;
- conversores não são caminhos silenciosos de execução.
