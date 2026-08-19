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
- referências portáteis a firmware, VHDL, scripts, subsistemas/dispositivos compostos e projetos IEC 61131-3;
- instâncias compostas com referência de definição/hash, `parameterOverrides` por ID estável e bindings externos por `portId`;
- componentes PLC podem referenciar um projeto IEC, uma configuração de entrada e/ou um `PlcCompiledArtifact` por asset/hash;
- identidade estável de endpoints PLC (`ioId`) para preservar bindings entre recompilações.

A estrutura detalhada de POUs, cinco linguagens e manifesto PLC pertence a [SCHEMA-003](iec61131-project.md).

Não persistir `SimulationPlan`, índices runtime, soluções, filas, imagens de I/O, memória da PLC VM, estados internos de composites ou tabela global legada `Mnn`. Artefato PLC pode ser armazenado como asset de build reproduzível, mas nunca é a fonte de verdade quando a autoria IEC está presente.

## Evolução beta

Mudança incompatível incrementa `schemaVersion`; loader rejeita versão errada antes de carga parcial. Conversor v2 → vNext é comando explícito e grava novo arquivo/backup. Compatibilidade indefinida não é requisito.

## Aceitação

- schema estrito para estruturas canônicas;
- tipos TS derivados não divergem do schema;
- IDs e endpoints são validados antes da compilação;
- bloco PLC sem projeto/artefato é persistível com zero endpoints;
- `ioId` permite preservar bindings em rename de I/O;
- round-trip preserva semântica;
- instância composta preserva `portId`/`parameterId` e não duplica o grafo interno;
- fixtures numéricas v2 convertidas mantêm resultado dentro da tolerância.
