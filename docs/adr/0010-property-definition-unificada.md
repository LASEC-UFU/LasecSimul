# ADR 0010 - `PropertyDefinition`: schema + get/set declarados uma vez, não em dois métodos

## Objetivo

Registrar a introdução de `lasecsimul::PropertyDefinition` (`core/include/lasecsimul/PropertyDefinition.hpp`)
e explicar por que ela substitui, para novos componentes e para os já migrados, o par
`static propertySchema()` + `propertyDescriptors()` de instância que todo built-in repetia.

## Status

Aceita e implementada por completo — todos os built-ins do Core migrados (não só `Probe`/`Resistor`
da demonstração inicial), a pedido explícito do usuário ("migre os outros ~20 built-ins com o padrão
novo e acabe com o padrão antigo"). Ver `docs/25-auditoria-arquitetural-core-2026-07-09.md` §17.1
pra lista completa e detalhes da segunda rodada.

## Contexto

A auditoria arquitetural de 2026-07-09 (`docs/25-auditoria-arquitetural-core-2026-07-09.md`, achados
D1-D4) encontrou um padrão repetido em praticamente todo built-in (`Resistor`, `OpAmp`, `Rail`,
`Probe`, `AnalogMux`, `ResistorArray`, `DiodeLegArray`, as classes-molde de `SimulideBuiltins.hpp`):

1. Um método `static std::vector<PropertySchema> propertySchema()` (metadado puro).
2. Um método `propertyDescriptors()` de instância (get/set fechando sobre `this`) que **chama o
   primeiro só pra reanexar o schema ao descriptor**, redigitando o `id` de cada propriedade uma
   segunda vez.

Isso já causou um bug real e concreto em `Probe.hpp`: `propertyDescriptors()` pegava
`schemas[0]`/`schemas[1]`/`schemas[2]` do vetor de `propertySchema()` **por índice numérico** —
reordenar `propertySchema()` teria quebrado o descriptor errado em silêncio, sem nenhum aviso do
compilador.

Separadamente, `ComponentParams::property(name, default)` (usado por toda fábrica em
`CoreApplication.cpp` na hora de criar um componente a partir de um `.lsproj`) nunca validava nada
contra o schema — caía no `default` do CHAMADOR (não do schema) em qualquer mismatch de tipo ou
valor fora de faixa, **em silêncio total**. Isso já causou dois bugs reais confirmados em produção
antes desta ADR: `SimulidePassiveState` e `Probe` (`pauseOnChange`/`showVolt` perdidos ao reabrir um
projeto salvo, porque a fábrica esquecia de ler o campo).

## Decisão

Um novo header, `core/include/lasecsimul/PropertyDefinition.hpp`, declara:

- `PropertyDefinition{schema, get, set}` — uma propriedade, um lugar só.
- `toPropertyDescriptors(vector<PropertyDefinition>)` — projeção mecânica pro
  `vector<PropertyDescriptor>` que `IComponentModel::propertyDescriptors()` precisa devolver; nunca
  reescrita por classe.
- `validatePropertyValue(schema, value)` — a MESMA regra que `SimulationSession::setProperty` já
  aplicava (readOnly/tipo/min/max/opções), agora extraída e reutilizável.
- `propertyOrDefault(properties, schema)` — lê `ComponentParams::properties` validando contra o
  schema; cai no default do schema (com log em stderr) se o valor salvo for inválido, em vez de
  aceitar em silêncio. Fecha D4 diretamente no ponto de uso de cada fábrica migrada.
- `schemaById(schemas, id)` — busca por nome, nunca por posição; é o que elimina o acoplamento
  posicional que já quebrou `Probe` uma vez.

Uma classe migrada declara `properties()` (não-estático, uma vez, schema+get+set juntos, casados
por id via `schemaById`) e `propertyDescriptors()` vira uma única linha:
`return toPropertyDescriptors(properties());`. `propertySchema()` estático continua existindo (é
usado por `registerBuiltinMetadata` antes de qualquer instância existir), mas agora é a ÚNICA fonte
— `properties()` busca nele por id em vez de duplicar os literais.

## Alternativas consideradas

- **Migrar todos os built-ins de uma vez, na mesma rodada da infraestrutura**: descartada
  inicialmente por escopo/risco (~20 classes de uma vez, sem checkpoint intermediário) — feito
  numa rodada seguinte, arquivo por arquivo, com build+suite completa (Debug+Release) verificada ao
  final (ver `docs/25-auditoria-arquitetural-core-2026-07-09.md` §17.1). Migrar incremental, não em
  paralelo descontrolado, foi a mitigação de risco real, não "não migrar".
- **Reescrever `SimulationSession::setProperty` pra chamar `validatePropertyValue` em vez de suas
  checagens inline**: descartada por ora — esse caminho já é testado e tem contrato de erro
  (`errorCode` como `"type_mismatch"`/`"out_of_range"`/etc, verificado por
  `CoreBootstrapTest.cpp`) que `validatePropertyValue` (só mensagem, sem código) não replica
  ainda. Preservar o caminho testado; `validatePropertyValue` por ora serve só o lado novo
  (`PropertyDefinition`/`propertyOrDefault`), não substitui o antigo.
- **Detectar "propriedade decorativa" automaticamente**: fora de escopo desta ADR — não tem relação
  com o problema resolvido aqui (ver ADR 0011 pra discussão correlata sobre `kLeakageConductance`,
  que agora é aplicado pelo framework via `leakagePinIndices()` opt-in, não detecção automática).

## Consequências

- Novo componente built-in: `properties()` (padrão novo) é a ÚNICA forma esperada agora — não sobra
  nenhum built-in usando o par schema/descriptor antigo em `core/src/components/`.
- Fábricas em `CoreApplication.cpp` que já constroem um componente migrado (`Probe`, `Resistor`)
  agora usam `propertyOrDefault` em vez de `p.property(name, default)` — comportamento observável
  muda SÓ nesse ponto: um valor salvo inválido agora loga em stderr em vez de ser silenciosamente
  substituído sem rastro.

## Impacto no projeto

- `.spec/lasecsimul.spec` seção 6 (Interfaces principais) precisa de uma nota sobre
  `PropertyDefinition` como forma recomendada de declarar propriedade (ver atualização
  correspondente nesta mesma rodada).
- Próximo desenvolvedor migrando um built-in existente: seguir `Probe.hpp`/`Resistor.hpp` como
  referência de padrão, não reinventar a forma de declarar `properties()`.
