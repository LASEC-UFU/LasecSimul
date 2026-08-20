---
id: SCHEMA-002
kind: schema
status: active
dependsOn: [SCHEMA-001, ARCH-006, ADR-0008]
supersedes: []
---

# Subcircuito hierarquico nativo — schemaVersion 3

## Objetivo

O `.lssubcircuit` schemaVersion 3 existente e o unico contrato hierarquico data-driven. Processo,
controle, MCU integrado e subcircuito eletrico usam o mesmo documento; nao existem
`SubsystemDefinition`, `CompositeDefinition` ou um schema TDPS paralelo.

## Estrutura canonica

```json
{
  "schemaVersion": 3,
  "typeId": "subcircuits.process.fopdt",
  "name": "Processo FOPDT",
  "components": [],
  "topology": { "revision": 0, "nodes": [], "conductors": [] },
  "interface": [],
  "symbolMode": "generic",
  "symbol": {},
  "exposedComponents": [],
  "exportedPropertyComponentIds": []
}
```

Campos de catalogo ja suportados (`language`, `translations`, `folderPath`, `workspaceSection`,
`icon`, `defaultProperties`, `propertySchema`, `help`) permanecem opcionais.

## `components[]` e `topology`

`components[]` contem componentes normais do catalogo com `id`, `typeId`, `properties` e dados
visuais. `topology.nodes[]` e `topology.conductors[]` usam os mesmos endpoints estaveis do projeto:

- `{ "kind": "port", "componentId": "...", "pinId": "..." }`;
- `{ "kind": "node", "nodeId": "..." }`.

Geometria de condutor e persistida como `points` no arquivo e projetada como `vertices` no modelo
TypeScript vivo. Coordenadas nunca definem conectividade.

## `interface[]`

Cada porta externa referencia um `connectors.tunnel` interno pelo nome canonico:

```json
{
  "pinId": "pv",
  "label": "PV",
  "internalTunnel": "pv",
  "domain": "signal",
  "direction": "in",
  "valueType": "Real",
  "width": 1,
  "unit": "%"
}
```

`pinId` e a identidade estavel externa. `symbol.pins[].id` deve apontar para esse mesmo ID.
`domain`, `direction`, `valueType`, `width` e `unit` sao opcionais para compatibilidade com os
subcircuitos eletricos v3 anteriores; ausentes significam `electrical/inout/Real/1/""`.

Regras:

- interface de sinal exige `direction` igual a `in` ou `out`;
- `width` fica entre 1 e 64;
- todo `internalTunnel` deve existir;
- mover/redesenhar o pino nao altera `pinId` nem binding;
- fan-in nunca implica soma automatica.

## `symbol`, exposicao e propriedades

`symbol` e somente a apresentacao externa. Alteracoes visuais nao mudam topologia nem hash
semantico. `exposedComponents[]` referencia componentes internos por ID e e exclusivamente visual.
`exportedPropertyComponentIds[]` reutiliza a exposicao de propriedades existente e permanece
independente de `exposedComponents[]`.

Nao existem `interfaceBindings[]`, `parameterExports[]` ou `telemetryExports[]` paralelos nesta
versao. Tunnels, componentes exportados e Probe/telemetria existentes cumprem esses papeis. Uma
evolucao futura exige caso real, compatibilidade v3 e beneficio para qualquer subcircuito.

## Nesting, cache e runtime

Um item de `components[]` pode referenciar outro `typeId` de subcircuito. A expansao e recursiva,
transacional e rejeita ciclos. Instancias aninhadas conectam-se pelo `pinId` externo, nao por indice
ou coordenada.

O hash semantico normaliza componentes, propriedades, condutores, interface tipada e dependencias
transitivas. Nome, source path, `symbol`, `icon` e demais apresentacoes nao participam. O cache e
invalidado quando a definicao e substituida.

Blocos de Signal Engine contidos no mesmo contrato sao compilados no cold path para
`SignalGraphDefinition`; o resultado executa no `SignalRuntime`/`SimulationPlan` normal, sem solver,
sessao ou estado TDPS filho.

## Importacao TDPS

O importador e um adapter de autoria. Ele resolve `Indice lista ...` e `Mnn` para componentes,
entradas nomeadas e edges antes de gravar o schema v3. O `.smp` original e preservado e um relatorio
sidecar registra campos sem semantica confirmada. Nenhuma referencia global TDPS participa do
runtime canonico.

## Aceitação

- IDs duplicados, endpoints orfaos e interfaces invalidas sao rejeitados antes do save;
- symbol pin, interface e tunnel sao validados em conjunto;
- nesting, remocao recursiva e rollback de expansao possuem regressao;
- hash e estavel, transitivo, cacheado e independente de visual;
- duas instancias possuem estado e overrides independentes;
- composicao e expansao manual produzem o mesmo resultado;
- fixtures TDPS convertidas nao contem `Mnn` operacional.
