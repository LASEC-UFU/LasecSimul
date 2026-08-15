---
id: SCHEMA-002
kind: schema
status: planned
dependsOn: [SCHEMA-001, ARCH-006]
supersedes: []
---

# Subsistema vNext

O formato unifica subcircuito e futuro subsystem sem exigir que todos os domínios sejam elétricos.

## Seções

- `schemaVersion`, `typeId` e metadata;
- componentes/instâncias locais;
- topologias por domínio;
- interface tipada e direcionada;
- parâmetros exportados;
- símbolo/ícone/board package de autoria;
- componentes expostos;
- dependências com hash/versão quando aplicável.

Pinos visuais referenciam IDs da interface; não duplicam semântica elétrica. Hierarquia é canônica no arquivo e pode ser achatada apenas no plano runtime.

## Ruptura

Versões beta anteriores podem ser rejeitadas. Conversão deve ser explícita e validar referências, tunnels/interfaces e assets antes de gravar.

## Aceitação

- schema detecta IDs duplicados, endpoints órfãos e interface inválida;
- dependência cíclica é rejeitada pelo compilador;
- conteúdo normalizado produz hash estável;
- duas instâncias possuem estado independente.
