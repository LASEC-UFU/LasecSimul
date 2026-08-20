---
id: FEAT-004
kind: feature
status: active
dependsOn: [ARCH-002, ARCH-006, SCHEMA-002, ADR-0008, FEAT-001]
supersedes: []
---

# Evolução do subcircuito para modelos de processo e controle

## Objetivo

Usar **o subcircuito que já existe no LasecSimul** como mecanismo único para componentes hierárquicos de processo/controle: por fora um símbolo; por dentro componentes reais interligados.

```text
visão externa                      edição interna do mesmo .lssubcircuit

u ───► [ PROCESSO ] ───► y         u -> Valve -> Dynamics -> DeadTime -> y
```

Não criar `CompositeDevice`, `CompositeDefinition`, `SubsystemDefinition` ou outro formato concorrente.

## Contrato existente que deve ser preservado

O schemaVersion 3 atual é a base:

- `components: ProjectComponent[]`;
- `topology: ProjectTopology`;
- `interface[]`;
- `symbol?: PackageDescriptor`;
- `exposedComponents[]`;
- `exportedPropertyComponentIds[]`;
- `icon`, `folderPath`, `defaultProperties`, `propertySchema`, `help` quando aplicáveis.

No Core, continuar usando `SubcircuitRegistry`/`SubcircuitDefinition` e `SimulationSession::addSubcircuitInstance()`.

## Interface externa

A interface pública continua sendo criada por `connectors.tunnel`:

```text
symbol.pinId="PV"
        |
interface[].pinId="PV"
        |
internalTunnel="PV"
        |
connectors.tunnel interno
```

O mecanismo de nomes isolados por instância (`<subcircuitInstanceId>::<internalTunnel>`) permanece a fronteira elétrica/sinal existente. Nenhum proxy adicional deve ser criado.

## Símbolo externo e implementação interna

`symbol` é a apresentação externa. `components` + `topology` são a implementação.

O usuário pode abrir o subcircuito com o fluxo já existente de edição; processo não ganha editor hierárquico separado. Qualquer melhoria de breadcrumb, navegação ou autorias deve ser feita no editor de subcircuito genérico e beneficiar todos os subcircuitos.

## Propriedades externas

Reutilizar primeiro `exportedPropertyComponentIds[]`.

Exemplo: um subcircuito PROCESSO contém `gain-1`, `delay-1` e `actuator-1`. Se o usuário marcar `gain-1` e `delay-1` como exportados, as propriedades desses componentes aparecem na instância externa usando o mecanismo já existente.

Não criar `parameterExports[]` nesta fase.

Se a biblioteca de processo comprovar a necessidade de:

- exportar apenas uma propriedade de um componente;
- renomear a propriedade externamente;
- agregar uma propriedade pública a múltiplos targets;

então a solução deve ser uma **extensão genérica do mecanismo de exported properties do subcircuito**, compatível com schema v3 e aplicável a qualquer subcircuito, não um campo exclusivo de TDPS/processo.

## Componentes expostos

`exposedComponents[]` permanece exclusivamente visual. Um componente pode:

- aparecer no símbolo/placa sem exportar propriedades;
- exportar propriedades sem aparecer;
- fazer ambos;
- fazer nenhum.

Não acoplar esses conceitos.

## Processo como composição

Preferência normativa:

```text
u
|
+-> ValveCharacteristic
    -> Hysteresis/Stiction
    -> RateLimiter
    -> Actuator
    -> Gain/TransferFunction/Integrator
    -> DeadTime
    -> Saturation
    -> y
```

Cada estágio deve reutilizar componente já existente quando houver equivalência matemática suficiente.

Uma nova primitiva só deve ser adicionada após inventário do catálogo/Core demonstrar lacuna real. A implementação deve favorecer blocos pequenos, coesos e reutilizáveis (SRP/OCP), evitando uma classe monolítica de processo.

## Estratégias compostas

Modelos como Smith Predictor, split-range, cascade, razão, forno, caldeira e trocador de calor devem ser entregues preferencialmente como:

- exemplos `.lsproj`, quando servem apenas como cenário didático completo;
- `.lssubcircuit`, quando fazem sentido como unidade reutilizável no catálogo.

Nesting usa o suporte recursivo já existente do subcircuito.

## Runtime

Não introduzir compilador/flattening novo como pré-requisito da feature.

O comportamento continua:

1. registrar definição no `SubcircuitRegistry`;
2. `addSubcircuitInstance()` expande recursivamente;
3. cada componente interno é criado via `addComponent` normal;
4. fios internos usam `connectWire` normal;
5. tunnels de interface são renomeados por escopo da instância;
6. remoção usa cascata já existente.

Otimizações futuras devem ser guiadas por profiling e aplicadas à infraestrutura geral, não só a processos.

## Estado

Estado dinâmico pertence às instâncias internas normais. Duas instâncias do mesmo processo nunca compartilham:

- integradores;
- memória PID;
- buffers de dead time;
- stiction/hysteresis;
- estados contínuos/discretos;
- estados de instrumentos.

Isso decorre naturalmente da expansão atual por instância e deve ser preservado.

## Diagnósticos

Reutilizar validação existente do documento e acrescentar apenas checks genéricos necessários, por exemplo:

- tunnel/pino sem correspondência;
- referência exportada órfã;
- componente exposto órfão;
- nesting cíclico;
- propriedade incompatível com schema do componente interno;
- tipo de componente interno ausente no catálogo.

Diagnósticos específicos do importador TDPS ficam em `FEAT-012`, não no contrato geral do subcircuito.

## Aceitação

- um processo pode ser salvo como `.lssubcircuit` schemaVersion 3 sem novo formato;
- aparece no catálogo e é inserido como qualquer subcircuito existente;
- símbolo externo usa `symbol` existente;
- abrir para edição mostra `components`/`topology` reais;
- interface usa tunnels existentes;
- propriedades externas reutilizam o mecanismo atual;
- nesting e remoção recursiva continuam funcionando;
- duas instâncias têm estado independente;
- resultado do processo composto é equivalente à expansão manual dos mesmos blocos;
- nenhuma API TDPS-específica é necessária para inserir, conectar, remover, salvar ou executar o processo.
