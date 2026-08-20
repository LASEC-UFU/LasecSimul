---
id: ARCH-002
kind: architecture
status: active
dependsOn: [ARCH-001, ARCH-006]
supersedes: []
---

# Runtime e SimulationPlan

## Pipeline canônico

```text
AuthoringSnapshot -> Validator/Normalizer -> PlanCompiler
                  -> shared_ptr<const SimulationPlan>
                  -> RuntimeState por sessão
```

Para IEC 61131-3 existe um estágio de build anterior ao `PlanCompiler`:

```text
IecProjectAuthoring -> IecCompiler -> PlcCompiledArtifact
                                      |
AuthoringSnapshot --------------------+-> PlanCompiler -> PlcPlan
```

O `SimulationPlan` referencia somente artefatos compilados válidos; parser, AST e editor IEC não executam no hot path.

`SimulationPlan` agrega planos específicos por domínio. Não é um objeto universal que mistura estado elétrico, PLC, Python e UI.


Subsistemas/dispositivos compostos também passam por compilação antes do hot path:

```text
CompositeDefinition -> normalize/hash -> CompiledSubsystemTemplate
AuthoringSnapshot + instance overrides
                   -> PlanCompiler
                   -> índices/handles densos por domínio
```

A hierarquia permanece canônica na autoria, mas o `PlanCompiler` pode achatar instâncias para listas densas. A execução não percorre a árvore hierárquica nem resolve `componentId/propertyId` por string a cada passo. `interfaceBindings`, `parameterExports` e `telemetryExports` são resolvidos para handles no plano.

Modelos importados do TDPS entram nesse mesmo pipeline após conversão de autoria. Índices legados (`Indice lista ...`, `Mnn`) não existem no `SimulationPlan`.

## Conteúdo mínimo

- geração e hash da autoria normalizada;
- handles e índices densos de componentes;
- listas densas de componentes reativos, FPGA, MCU, PLC, observers e subscribers;
- `ElectricalPlan` baseado na `Netlist::Topology` existente;
- `SignalPlan`, `BridgePlan` e `ExternalBindingPlan` quando suas fases existirem;
- `PlcPlan` com instâncias, tasks, RateGroups, mappings de I/O e referências `shared_ptr<const PlcCompiledArtifact>`;
- slots tipados e mapeamentos port-to-slot;
- SCCs, ordem topológica e RateGroups;
- referências a `CompiledSubsystemTemplate` imutáveis.

`PlcPlan` nunca contém source text nem nós React/graphical editor. Interfaces de POUs e I/O já chegam resolvidas para handles/offsets da ABI.

O plano não contém processos, handles do SO, tensões, estado interno dos blocos, buffers de telemetria ou callbacks capturando objetos de autoria.

## RuntimeState

É criado para uma geração do plano e contém todo estado mutável: tempo, dirty sets, soluções MNA, slots de sinal, estados de bloco, processos externos e buffers limitados.

Para cada instância PLC contém, no mínimo:

- memória da VM;
- imagens de entrada e saída;
- estados de `FUNCTION_BLOCK` e SFC;
- timers/counters;
- estado de tasks;
- área `RETAIN` quando habilitada;
- force/watch/debug runtime.

Duas instâncias podem compartilhar o mesmo `PlcCompiledArtifact`, mas nunca a memória acima.

O coordenador é o único escritor do estado global. Workers recebem plano e snapshots somente leitura, escrevem em scratch disjunto e têm resultados commitados em ordem do plano.

## Compilação e publicação

1. Validar schema e referências.
2. Compilar autoria IEC alterada para `PlcCompiledArtifact` antes do plano.
3. Validar `formatVersion`, `abiVersion`, hashes, bytecode e interface exportada.
4. Normalizar IDs, propriedades, tipos e unidades.
5. Resolver strings para índices/handles.
6. Construir grafos por domínio.
7. Detectar SCCs e formar RateGroups.
8. Compilar planos de domínio, `PlcPlan` e bindings.
9. Publicar o plano somente se toda a compilação for bem-sucedida.

Na primeira versão, um novo plano ou novo artefato PLC só é publicado com a simulação parada. Hot-swap durante `RUN` é adiado.

## Invalidação

- visual/viewport: nenhuma recompilação;
- parâmetro runtime-safe: atualização do estado;
- período/conexão de sinal: `SignalPlan` e RateGroups;
- fio/túnel elétrico: `ElectricalPlan` afetado;
- tipo/largura/unidade: domínio e bridges relacionados;
- conteúdo de subsistema: template e dependentes; mudança interna com interface idêntica preserva bindings externos, mas recompila o template;
- `interface`/`portId` de subsistema: recompila endpoints/bindings afetados e produz orphan explícito quando uma porta usada é removida;
- `parameterExport`: recompila metadata/bindings de parâmetro; override runtime-safe pode atualizar estado sem recompilar topologia;
- VHDL/toolchain: artefato GHDL;
- corpo IEC sem mudança de interface: recompila artefato + `PlcPlan`, preservando topologia externa quando `exportedIo` for idêntico;
- interface IEC/exported I/O: recompila artefato, `PlcPlan`, endpoints e bindings afetados;
- task/resource IEC: recompila artefato e schedule do `PlcPlan`.

Incrementalidade inicial é por domínio. Recompilação fina por POU/SCC só entra com benchmark, embora cache por hash de POU seja permitido se não mudar semântica.

## Implementação inicial da F3

O Core implementa este contrato em `simulation/SimulationPlan.*` e `simulation/RuntimeState.hpp`:

- `PlanCompiler` compila em staging e devolve `shared_ptr<const SimulationPlan>` somente depois de
  validar listas densas, capacidade e referências; uma exceção preserva o plano publicado;
- geração e hash da autoria normalizada são separados: a geração é monotônica por publicação e o
  hash deriva do estado canônico dos componentes, propriedades, listas e topologia, sem depender da
  sequência de edições;
- `ElectricalPlan` publica grupos e resoluções estruturais imutáveis; matrizes, fatorações, soluções,
  bordas e scratch permanecem exclusivamente no `RuntimeState` da sessão;
- `PlanInvalidation` separa `Electrical`, `Signal`, `External`, `Plc` e `ExecutionIndex`; domínios não
  invalidados preservam a identidade do subplano anterior;
- reativos, não lineares, FPGA, MCU e subscribers são listas densas mantidas no cold path. Callbacks
  de tempo, pacing MCU e settle não descobrem tipos percorrendo todos os componentes;
- subscriptions e condições de pausa compilam source/alias para índices de nós. O stable step apenas
  amostra esses handles, sem resolver strings ou procurar pinos globalmente;
- `Scheduler::start()` e execução síncrona publicam pendências antes de iniciar. Mutação estrutural
  durante `RUN` falha com erro explícito exigindo `stop`; parâmetro runtime-safe continua atualizando
  apenas estado e não troca a geração;
- `getPerformanceMetrics` expõe geração, hash, domínios pendentes e cardinalidades do plano.

`SignalPlan`, `PlcPlan` e bindings externos já possuem fronteiras imutáveis, mas seu conteúdo de
domínio cresce apenas nas fases correspondentes (F5, F8 e F9); F3 não antecipa seus runtimes.

## Aceitação

- nenhuma resolução de alias/string no hot path do Signal Engine ou PLC VM;
- nenhuma varredura global para localizar reativos, FPGA ou PLC a cada passo;
- falha de compilação IEC preserva plano/runtime anterior;
- duas instâncias do mesmo artefato possuem estado PLC isolado;
- duas instâncias do mesmo `CompiledSubsystemTemplate` compartilham apenas estrutura imutável e possuem todo estado dinâmico isolado;
- composto e expansão manual do mesmo grafo são numericamente equivalentes dentro da tolerância definida;
- troca de implementação de um POU entre linguagens, mantendo interface e comportamento, não altera bindings externos;
- execução idêntica com 1, 2 e N workers dentro das tolerâncias numéricas fixadas.
