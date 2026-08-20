---
id: FEAT-001
kind: feature
status: active
dependsOn: [ARCH-002, ARCH-003, ARCH-006, SCHEMA-001]
supersedes: []
---

# Signal Engine

## Escopo MVP

- tipos `Real`, `Bool`, `Int64` e vetores limitados;
- unidade como metadado compilável, com conversões lineares explícitas;
- slots densos separados por tipo;
- blocos Source, Gain, Sum, Product, Limiter, Selector, Probe e infraestrutura de `CalcExpression` segura;
- ordem topológica para grafo acíclico;
- SCCs para realimentação e diagnóstico de loop algébrico;
- RateGroups e microsteps conforme `ARCH-003`;
- zero resolução de strings no hot path.

## Semântica

Um bloco lê snapshot de entradas do microstep e escreve em saída própria. Commit ocorre em ordem do plano. Blocos combinacionais não usam wall clock. Blocos periódicos são ativados por RateGroup.

Qualidade/timestamp podem ser reservados no layout, mas propagação completa de quality fica fora do MVP. `double` não deve contaminar a representação dos outros tipos.



## Composição e hierarquia

O Signal Engine não distingue no hot path um bloco colocado diretamente de um bloco que veio de um `CompositeDevice`. `FEAT-004` resolve shells, interface bindings e grafos filhos antes da execução.

Slots internos de uma instância composta são privados por instância. Portas exportadas são aliases compilados/handles para slots de fronteira, não uma tabela global de nomes. Isso permite reproduzir modelos no estilo TDPS sem adotar `M1..Mn` como arquitetura.

`CalcExpression` aceita apenas uma DSL determinística e validada, com entradas explicitamente ligadas; acesso a variáveis globais, `eval` e resolução dinâmica de `Mnn` durante `RUN` são proibidos.

## Alocação

Compilação pode alocar. Execução steady-state reutiliza arrays, dirty bitsets, filas e scratch. Nenhum `unordered_map`, nome de porta ou `std::function` por bloco no passo normal.

## Implementação inicial da F5

O Core implementa o programa imutável em `simulation/SignalEngine.*`, publicado dentro do
`SignalPlan` e vinculado a um `SignalRuntime` por sessão:

- `Real`, `Bool` e `Int64` possuem pools densos independentes; vetores usam faixas contíguas com
  largura validada e limitada no cold path;
- bindings resolvem IDs/portas uma vez. Tipos e larguras precisam coincidir, e unidades conhecidas
  são transformadas em coeficientes lineares somente quando a conversão foi declarada explicitamente;
- Source, Gain, Sum, Product, Limiter, Selector, Probe e `CalcExpression` são compilados para opcodes,
  slots e bytecode sem nomes no passo normal. A DSL de expressão permite apenas constantes, entradas
  ligadas, parênteses e operadores aritméticos determinísticos;
- Tarjan identifica SCCs. Loops sem política falham na compilação; `FixedPoint` usa snapshots
  síncronos, tolerância e número máximo de iterações, com contador de não convergência;
- a condensação de SCCs gera níveis de microstep determinísticos. Cada nível lê um snapshot e faz
  commit em ordem de plano; grupos são ordenados por `(periodNs, offsetNs, phase)` e recuperam todos
  os deadlines virtuais até o timestamp fornecido pelo Scheduler;
- `bind()` pré-aloca valores, snapshots, candidatos, stack de expressão e deadlines. `executeUntil()`
  reutiliza esses buffers e não contém resolução de strings, mapas ou funções alocáveis;
- `SimulationSession::setSignalGraph` valida transacionalmente no estado parado. A publicação falha
  sem trocar o authoring/plano anterior, e cada stable step avança o runtime até o tempo virtual;
- `signal_engine_benchmark` cobre 100, 10 mil e 100 mil blocos e integra o baseline reproduzível.

A origem hierárquica do grafo é deliberadamente apagada nessa representação compilada. O lowering de
`CompositeDevice` e sua equivalência com expansão manual pertencem ao gate F7 (`FEAT-004`); o runtime
F5 já recebe ambos como o mesmo conjunto de blocos, bindings e slots.

## Aceitação

- conexão incompatível falha na compilação;
- conversão de unidade conhecida é pré-compilada;
- grafo acíclico executa uma vez por ativação;
- SCC sem política de solução produz diagnóstico;
- mesmos valores e ordem com 1/2/N workers;
- benchmark cobre 100, 10k e 100k blocos simples;
- grafo de um composto produz os mesmos slots/valores observáveis que sua expansão manual;
- `CalcExpression` inválida ou com binding ausente falha na compilação, não durante avaliação.
