---
id: SCHEMA-001
kind: schema
status: planned
dependsOn: [ARCH-001, ARCH-006]
supersedes: []
---

# Projeto vNext

## Decisão

JSON continua canônico. Um container `.lsproj` compactado só será avaliado quando assets embutidos justificarem a complexidade.

O vNext usa JSON Schema 2020-12 como fonte de verdade e gera tipos TypeScript. O Core recebe DTOs compilados por IPC e não abre diretamente o documento de projeto.

## Conteúdo persistido

- versão e metadados;
- componentes com IDs estáveis e propriedades de autoria;
- topologias separadas por domínio;
- visual/viewport;
- settings de simulação declarativos;
- referências portáteis a firmware, VHDL, scripts e subsistemas.

Não persistir `SimulationPlan`, índices runtime, soluções, filas ou estado transitório.

## Evolução beta

Mudança incompatível incrementa `schemaVersion`; loader rejeita versão errada antes de carga parcial. Conversor v2 → vNext é comando explícito e grava novo arquivo/backup. Compatibilidade indefinida não é requisito.

## Aceitação

- schema estrito para estruturas canônicas;
- tipos TS derivados não divergem do schema;
- IDs e endpoints são validados antes da compilação;
- round-trip preserva semântica;
- fixtures numéricas v2 convertidas mantêm resultado dentro da tolerância.
