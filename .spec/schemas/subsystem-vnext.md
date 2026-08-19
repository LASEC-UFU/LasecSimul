---
id: SCHEMA-002
kind: schema
status: planned
dependsOn: [SCHEMA-001, ARCH-006, ADR-0008]
supersedes: []
---

# Subsistema / dispositivo composto vNext

## Objetivo

Unificar subcircuito, subsystem, smart device e modelo composto de processo em um único contrato hierárquico. O formato descreve simultaneamente o **shell externo** e o **implementation graph**; runtime pode achatar a hierarquia, mas autoria nunca perde essa relação.

## Estrutura conceitual

```json
{
  "schemaVersion": 1,
  "typeId": "process.smith-predictor",
  "metadata": {},
  "interface": [],
  "package": {},
  "logicSymbolPackage": {},
  "components": [],
  "topologies": {},
  "interfaceBindings": [],
  "parameterExports": [],
  "telemetryExports": [],
  "exposedComponents": [],
  "dependencies": [],
  "provenance": {}
}
```

Os nomes acima são normativos como seções conceituais; o JSON Schema executável deve fixar seus detalhes antes de `SCHEMA-002` tornar-se `active`.

## `interface[]`

Cada item possui `portId` estável e metadados tipados:

```json
{
  "portId": "pv",
  "domain": "signal",
  "direction": "in",
  "valueType": "Real",
  "unit": "%",
  "label": "PV"
}
```

Regras:

- `portId` é identidade; label e posição são apresentação;
- pinos visuais em `package` referenciam `portId`;
- interface não duplica conectividade interna;
- domínio/tipo/largura/unidade obedecem `ARCH-006`.

## `package` e apresentação externa

Contém geometria declarativa do símbolo: bounds, shapes/assets, labels e posições dos pinos. Pode existir `logicSymbolPackage` alternativo.

Mudanças somente visuais não alteram `interface`, hashes semânticos de simulação nem topologia externa. Assets participam do hash visual quando necessário para cache de UI, não do resultado numérico.

## `components[]` e `topologies`

São a implementação real do composto. Componentes internos usam os mesmos schemas/tipos disponíveis num projeto normal. Topologias continuam separadas por domínio (`electrical`, `signal`, PLC/protocol bindings etc.).

Não existe formato especial de “bloco TDPS interno”; os modelos TDPS-like usam primitivas normais do LasecSimul.

## `interfaceBindings[]`

Mapeiam `portId` externo para endpoint interno estável:

```json
{
  "portId": "out",
  "target": {
    "componentId": "delay-1",
    "portId": "out"
  }
}
```

O loader valida existência, domínio, direção, tipo, largura e unidade. Binding visual por coordenada ou índice de array é proibido.

## `parameterExports[]`

Descrevem propriedades públicas editáveis da instância:

```json
{
  "parameterId": "deadTime",
  "label": "Tempo morto",
  "valueType": "Real",
  "unit": "s",
  "default": 12.0,
  "targets": [
    { "componentId": "delay-1", "propertyId": "delay" }
  ]
}
```

`parameterId` é estável. Targets são resolvidos na compilação. Transformações, se suportadas, devem pertencer a uma DSL declarativa/validável; JavaScript arbitrário no documento é proibido.

## `telemetryExports[]`

Exportam sinais/estados internos por ID estável para Scope, inspector, animação e bindings permitidos. Não tornam todo o grafo introspectável automaticamente.

## `exposedComponents[]`

Referenciam componentes internos cuja representação visual pode ser projetada no shell (display, LED, indicador, animação). A referência visual compartilha o mesmo estado/runtime do componente interno; não é uma cópia.

## `dependencies[]`

Cada dependência de outro composto carrega identidade e hash/versão quando aplicável. O hash normalizado inclui dependências transitivas sem incluir estado runtime.

Ciclos de definição são erro de compilação.

## Instância no projeto

Uma instância de composto em `SCHEMA-001` referencia a definição e pode conter:

- `instanceId`;
- `typeId`/asset reference/hash esperado;
- `parameterOverrides` por `parameterId`;
- visual/transform do shell;
- bindings externos normais por `portId`.

Ela **não** persiste cópia do grafo interno, índices runtime, buffers, estados de PID/solver ou tabela `Mxx`.

## Provenance e TDPS

`provenance` é opcional e não-semântico. Um importador de TDPS pode registrar:

```json
{
  "source": "tdps-smp",
  "sourceVersion": "7.71",
  "sourceFile": "smith predictor.smp",
  "legacyIds": {
    "component": "PROCESSO:21",
    "signalIndex": 43
  }
}
```

Referências TDPS como `Indice lista PV` e `M43` devem estar resolvidas para `componentId`/`portId`/edges antes de gravar o documento canônico. `legacyIds` nunca participa da execução.

## Ruptura e migração

Versões beta anteriores podem ser rejeitadas. Conversão deve ser explícita e validar:

- IDs e endpoints;
- tunnels/interfaces;
- package/pins;
- exports;
- assets e dependências;
- referências de instâncias existentes.

Evolução de `.lssubcircuit` deve preferir conversão para este modelo em vez de manter dois schemas hierárquicos paralelos.

## Aceitação

- schema detecta IDs duplicados, endpoints órfãos e interface inválida;
- todo `package.pin` aponta para `interface.portId` existente;
- todo `interfaceBinding`, export e exposed component aponta para target válido;
- dependência cíclica é rejeitada pelo compilador;
- conteúdo normalizado produz hash semântico estável;
- mudança puramente visual não altera hash semântico de simulação;
- duas instâncias possuem overrides e estado independentes;
- round-trip preserva hierarquia e IDs estáveis;
- fixture TDPS convertida não contém referência operacional `Mnn`/índice global legado.
