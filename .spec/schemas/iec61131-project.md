---
id: SCHEMA-003
kind: schema
status: planned
dependsOn: [SCHEMA-001, ARCH-002, ARCH-006, ADR-0007]
supersedes: []
---

# Projeto IEC 61131-3 e artefato PLC

## Objetivo

Definir autoria IEC independente de linguagem, referências persistentes do bloco PLC e o manifesto versionado do artefato compilado.

## `IecProjectAuthoring`

```text
IecProjectAuthoring
├── schemaVersion
├── projectId
├── dataTypes[]
├── globalVariableLists[]
├── pous[]
├── configurations[]
├── resources[]
├── tasks[]
├── programInstances[]
├── libraries[]
└── buildSettings
```

## POU

```text
PouDefinition
├── pouId              # UUID estável
├── name
├── kind               # program | function | functionBlock
├── interface
│   ├── returnType?    # apenas function
│   └── variables[]
│       ├── ioId       # UUID estável quando público
│       ├── name
│       ├── class      # input | output | inOut | local | temp | external
│       ├── type
│       ├── initialValue?
│       ├── retain?
│       └── attributes?
└── implementation
    ├── language       # ld | fbd | st | sfc | il
    └── body
```

`interface` não depende da linguagem. A resolução cross-language usa `pouId`, nome qualificado e assinatura tipada.

## Corpo por linguagem

- `st` e `il`: texto canônico UTF-8 mais metadados de posição;
- `ld`: rungs, nós, contatos, coils, blocks e edges com IDs estáveis;
- `fbd`: networks/nodes/ports/edges com IDs estáveis;
- `sfc`: steps, transitions, actions, qualifiers e edges com IDs estáveis.

A representação gráfica de autoria não é a IR de execução.

## Referência do componente PLC

Um componente PLC persistido no projeto usa:

```text
PlcComponentAuthoring
├── componentId
├── iecProjectRef?
├── entryConfiguration?
├── artifactRef?
├── expectedArtifactHash?
├── exportedIoBindingVersion?
└── properties
```

O componente pode existir sem `iecProjectRef` e sem `artifactRef`; nesse caso tem zero pinos.

`artifactRef` pode apontar para cache/build output local ou asset portátil. O artefato é derivado e substituível; a autoria IEC continua sendo a fonte de verdade quando disponível.

## Manifesto do artefato

Por [ADR-0007](../adr/0007-openplc-v4-incorporation-and-native-plc-pipeline.md), LD/FBD/SFC baixam para ST canônico antes da compilação; o backend é STruCpp (vendorizado) gerando C++17, compilado por um toolchain C++ real em um módulo nativo executado por um worker isolado do Core:

```text
PlcArtifactManifest
├── formatVersion
├── strucppVersion
├── cxxToolchainVersion
├── sourceHash
├── artifactHash
├── target: plc-native-cxx
├── entryConfiguration
├── symbols[]
├── pous[]
├── tasks[]
├── exportedIo[]
│   ├── ioId
│   ├── qualifiedName
│   ├── displayName
│   ├── direction
│   ├── iecType
│   ├── width
│   └── unit?
├── memoryLayout
├── retainLayout
├── generatedStSourceRef  # ST canônico gerado por lowering, para debug/auditoria
└── debugMapVersion
```

`artifactHash` cobre manifesto normalizado + binário/biblioteca nativa referenciada por `nativeBinaryRef`. `sourceHash` cobre a autoria normalizada e dependências de biblioteca. `target` distingue este manifesto de um eventual manifesto de bytecode legado (nenhum é planejado; o campo existe para rejeitar explicitamente um artefato do formato anterior ao ADR-0007).

## Evolução de I/O

Conexões persistem pelo `ioId`. Ordens de array, coordenadas de pino e nomes visuais não são identidade.

- rename com mesmo `ioId`: mantém binding;
- remoção: binding fica órfão com diagnóstico;
- mudança de tipo: exige revalidação;
- adição: novo pino aparece desconectado;
- recompilação idêntica: mesma interface e hash reprodutível dentro do mesmo toolchain/configuração.

## Bibliotecas e dependências

Bibliotecas IEC declaram versão e hash. POUs de biblioteca e do usuário participam do mesmo symbol table. Duas dependências não podem publicar o mesmo símbolo qualificado sem regra explícita de namespace.

## Aceitação

- schema representa LD, FBD, ST, SFC e IL sem campos exclusivos obrigatórios de outra linguagem;
- um POU muda de chamador ST para LD/FBD/SFC/IL sem alteração da sua interface persistida;
- round-trip preserva IDs de POU, nós gráficos e `ioId`;
- componente PLC sem artefato é válido e possui zero endpoints;
- manifesto rejeita `abiVersion` incompatível antes do `RUN`;
- projeto não persiste `RuntimeState`, filas, imagens de I/O ou memória transitória do PLC.
