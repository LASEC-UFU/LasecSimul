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

`SimulationPlan` agrega planos específicos por domínio. Não é um objeto universal que mistura estado elétrico, PLC, Python e UI.

## Conteúdo mínimo

- geração e hash da autoria normalizada;
- handles e índices densos de componentes;
- listas densas de componentes reativos, FPGA, MCU, observers e subscribers;
- `ElectricalPlan` baseado na `Netlist::Topology` existente;
- `SignalPlan`, `BridgePlan` e `ExternalBindingPlan` quando suas fases existirem;
- slots tipados e mapeamentos port-to-slot;
- SCCs, ordem topológica e RateGroups;
- referências a `CompiledSubsystemTemplate` imutáveis.

O plano não contém processos, handles do SO, tensões, estado interno dos blocos, buffers de telemetria ou callbacks capturando objetos de autoria.

## RuntimeState

É criado para uma geração do plano e contém todo estado mutável: tempo, dirty sets, soluções MNA, slots de sinal, estados de bloco, processos externos e buffers limitados.

O coordenador é o único escritor do estado global. Workers recebem plano e snapshots somente leitura, escrevem em scratch disjunto e têm resultados commitados em ordem do plano.

## Compilação e publicação

1. Validar schema e referências.
2. Normalizar IDs, propriedades, tipos e unidades.
3. Resolver strings para índices/handles.
4. Construir grafos por domínio.
5. Detectar SCCs e formar RateGroups.
6. Compilar planos de domínio e bindings.
7. Publicar o plano somente se toda a compilação for bem-sucedida.

Na primeira versão, um novo plano só é publicado com a simulação parada. Hot-swap durante `RUN` é adiado.

## Invalidação

- visual/viewport: nenhuma recompilação;
- parâmetro runtime-safe: atualização do estado;
- período/conexão de sinal: `SignalPlan` e RateGroups;
- fio/túnel elétrico: `ElectricalPlan` afetado;
- tipo/largura/unidade: domínio e bridges relacionados;
- conteúdo de subsistema: template e dependentes;
- VHDL/toolchain: artefato GHDL.

Incrementalidade inicial é por domínio. Recompilação fina por nó/SCC só entra com benchmark.

## Aceitação

- nenhuma resolução de alias/string no hot path do Signal Engine;
- nenhuma varredura global para localizar reativos ou FPGA a cada passo;
- falha de compilação preserva plano/runtime anterior;
- execução idêntica com 1, 2 e N workers dentro das tolerâncias numéricas fixadas.
