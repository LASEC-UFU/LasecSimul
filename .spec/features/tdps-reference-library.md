---
id: FEAT-012
kind: feature
status: planned
dependsOn: [FEAT-001, FEAT-002, FEAT-004, SCHEMA-002, ADR-0008]
supersedes: []
---

# Biblioteca de controle/processo inspirada no TDPS e importação `.smp`

## Objetivo

Usar o TDPS v7.71 como referência funcional/pedagógica para ampliar o LasecSimul **sem duplicar a arquitetura existente**. Processos reutilizáveis são `.lssubcircuit` schemaVersion 3 normais; exemplos completos podem ser `.lsproj`; o importador `.smp` é apenas um adapter de autoria.

## Evidência analisada

Nos 24 projetos `.smp` do pacote v7.71 foram observados:

- 66 `CONTROLADOR`;
- 139 `PROCESSO`;
- 172 `BLOCO CALC`;
- 57 `REGISTRADOR`;
- 24 `REGISTRADOR XY`;
- 213 `TEXTO ANIMADO`;
- coordenadas/layout por projeto;
- referências globais por `Indice lista ...` e expressões `Mnn`.

Esses índices pertencem exclusivamente ao modelo legado de entrada.

## Regra de reaproveitamento antes de criar código

Para cada entidade TDPS, seguir esta ordem:

1. procurar componente/builtin/plugin/subcircuito existente com semântica suficiente;
2. montar composição com componentes existentes;
3. criar `.lssubcircuit` reutilizável se a composição tiver identidade própria;
4. criar nova primitiva somente se houver lacuna matemática, reutilização clara ou necessidade de desempenho medida.

Nenhum tipo novo deve existir apenas porque há uma seção com nome correspondente no `.smp`.

## Mapeamento inicial

| TDPS | Destino preferido no LasecSimul |
|---|---|
| `CONTROLADOR` | componente PID já existente, se houver; caso contrário primitiva PID reutilizável; wrappers didáticos como subcircuito |
| `PROCESSO` | `.lssubcircuit` composto por primitivas existentes/novas mínimas |
| `BLOCO CALC` | reutilizar bloco matemático/expression existente; criar DSL segura só se faltar capacidade |
| `REGISTRADOR` | reutilizar oscope/probe/instrumento de telemetria existente antes de criar Recorder novo |
| `REGISTRADOR XY` | reutilizar infraestrutura de plot existente; criar XY apenas se inexistente |
| `TEXTO ANIMADO` | reutilizar readout/probe/exposed component/telemetria existente |
| `COORDENADAS` | converter somente para layout de autoria |
| `Indice lista ...`, `Mnn` | resolver para endpoints/componentes reais durante importação |

## Biblioteca de processo

### Inventário antes da implementação

A implementação deve primeiro registrar em uma matriz de cobertura quais elementos já existem no Core/catálogo e quais faltam. A spec não presume que `Gain`, `Scope`, `Probe`, `WaveGen`, `Saturation` etc. precisem ser recriados.

### Lacunas matemáticas candidatas

Somente após o inventário, podem ser consideradas primitivas coesas para:

- PID industrial, caso a implementação existente não cubra o comportamento necessário;
- dinâmica de primeira/segunda ordem e integrador de processo;
- dead time determinístico;
- lead/lag;
- não linearidade de válvula;
- hysteresis/deadband/stiction;
- rate limiter;
- dinâmica de atuador.

FOPDT deve preferir composição `Gain/FirstOrder + DeadTime`, não uma nova classe, salvo justificativa medida.

## Processo TDPS-like

É um subcircuito comum:

```text
symbol externo
u ───► [ PROCESSO ] ───► y

components/topology internos
u -> valve -> rate limiter -> actuator -> dynamics -> delay -> y
```

O documento usa os mesmos campos do editor atual:

- `components`;
- `topology`;
- `interface` por tunnels;
- `symbol`;
- opcionalmente `exposedComponents`;
- opcionalmente `exportedPropertyComponentIds`.

Não usar `CompositeDefinition`, `parameterExports`, `telemetryExports` ou schema TDPS próprio.

## Propriedades do processo

Parâmetros TDPS como `gain`, `tau1`, `tau2`, `deadTime`, `stiction`, `rateLimit`, `actuatorTau`, `lead`, `lag` devem mapear para propriedades normais dos componentes internos.

A exposição externa deve reutilizar o mecanismo atual de propriedades exportadas. Se ficar comprovado que a granularidade por-componente é insuficiente para uma UX limpa, abrir uma evolução genérica do subcircuito, com backward compatibility e testes, em vez de adicionar uma exceção exclusiva desta feature.

## Controlador

Parâmetros encontrados no TDPS incluem:

- `Kc`, `Ti`, `Td`;
- bias;
- filtro derivativo;
- limites de saída;
- ação direta/reversa;
- derivada em PV ou erro;
- estrutura ISA;
- SP remoto;
- feedforward;
- manual/auto e tracking quando presentes.

Campos de memória como `Iant`, `Erroant`, `PVant` são estado runtime/fixture, não propriedades persistidas por padrão.

## Importador `.smp`

O importador vive fora do hot path do Core:

```text
.smp latin-1
 -> parser legado
 -> modelo intermediário TDPS
 -> resolução Mnn/índices
 -> ProjectComponent + ProjectTopology
 -> .lsproj e/ou .lssubcircuit schemaVersion 3
 -> validação/catálogo/runtime normais
```

### Regras

- preservar o `.smp` original;
- conversão escreve novos artefatos LasecSimul;
- não executar expressão legado com `eval`/host scripting;
- não manter `Mnn` operacional após conversão;
- nunca inventar conexão quando uma referência não puder ser resolvida;
- mapear layout separadamente da topologia;
- emitir relatório de campos/tipos desconhecidos;
- importer não é necessário para executar artefato já convertido.

## Expressões de `BLOCO CALC`

Antes de criar `CalcExpression`, verificar se o LasecSimul já possui bloco matemático/expressão suficiente.

Se for necessária uma DSL nova, ela deve ser um componente reutilizável e seguro, com parser próprio e permit-list de operadores/funções. JavaScript `eval`, execução arbitrária e acesso ao host são proibidos.

As referências `M21 + M97*M81` devem ser reescritas para entradas nomeadas conectadas pelo `ProjectTopology`, nunca avaliadas consultando tabela global por string no runtime.

## Cenários de referência

Prioridade inicial:

1. basic flow loop;
2. Smith predictor;
3. split-range;
4. regulatory/surge level;
5. heat exchanger;
6. furnace/combustion;
7. boiler;
8. reactor;
9. casos não lineares/pH quando a matemática estiver comprovada.

Entregar como projeto didático ou subcircuito conforme reusabilidade; não transformar todo cenário em novo tipo de componente.

## Compatibilidade matemática

Compatibilidade significa reproduzir o comportamento observável dentro de tolerância documentada, não replicar a implementação Delphi.

Para cada bloco/modelo implementado:

- documentar equação/discretização;
- unidades e limites;
- golden de resposta;
- tolerância numérica;
- fonte da referência;
- divergências conhecidas.

Semântica não confirmada deve permanecer `unsupported/unknown`; não inferir significado silenciosamente.

## SOLID aplicado

- SRP: parser legado, mapeador, componentes matemáticos e subcircuitos têm responsabilidades separadas;
- OCP: novos processos são adicionados principalmente como dados/subcircuitos;
- LSP: processos convertidos obedecem ao mesmo contrato de qualquer subcircuito;
- ISP: nenhum método TDPS é adicionado a interfaces gerais sem uso fora do importador;
- DIP: importer produz contratos canônicos do projeto e não injeta dependência TDPS no runtime.

## Aceitação

- parser percorre os 24 `.smp` sem crash e produz relatório de cobertura;
- todo elemento suportado é mapeado primeiro para recurso existente quando possível;
- conversão produz `.lsproj`/`.lssubcircuit` schemaVersion 3 válidos;
- nenhum `Mnn` permanece como mecanismo runtime;
- pelo menos um `PROCESSO` é um subcircuito normal e editável no editor existente;
- basic flow loop e Smith predictor funcionam usando runtime/subcircuito normais;
- duas instâncias de processo têm estado independente;
- nenhum novo mecanismo de hierarquia, solver ou catálogo é criado para TDPS;
- cada nova primitiva adicionada possui justificativa de lacuna/reuso e teste isolado.
