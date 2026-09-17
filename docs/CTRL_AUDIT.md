# Auditoria da biblioteca Ctrl

Este documento separa o que está realmente operacional do que apenas possui nome, classe ou
composição parcial. A classificação considera Core/SignalEngine, compilador, manifesto, catálogo,
propriedades, serialização e execução.

## Primitivos já operacionais

| Alvo | Implementação efetiva | Autoría | Estado |
|---|---|---|---|
| Gain | `SignalBlockKind::Gain` | `subcircuits/control_gain.lssubcircuit` | EXACT |
| Sum | `SignalBlockKind::Sum` com N entradas | `control_sum` | EXACT |
| Product | `SignalBlockKind::Product` com N entradas | `control_product` | EXACT |
| Integrator | `SignalBlockKind::Integrator` | `control_integrator` | EXACT |
| FilteredDerivative | `SignalBlockKind::FilteredDerivative` | `control_filtered_derivative` | EXACT |
| UnitDelay | `SignalBlockKind::UnitDelay` | `control_unit_delay` | EXACT |
| DeadTime/TransportDelay | `SignalBlockKind::DeadTime` | `control_dead_time` | EQUIVALENT |
| FirstOrder/PT1 | `SignalBlockKind::FirstOrder` | `control_first_order` | EQUIVALENT |
| SecondOrder | `SignalBlockKind::SecondOrder` | `control_second_order` | EXACT |
| LeadLag | `SignalBlockKind::LeadLag` | `control_lead_lag` | EXACT |
| FOPDT | `SignalBlockKind::Fopdt` | `control_fopdt` | EXACT |
| TransferFunction física | alias parametrizado para FirstOrder/SecondOrder/LeadLag/FOPDT | `control_transfer_function` | EQUIVALENT |
| Tank | `SignalBlockKind::Tank` | `control_tank` | EXACT |
| ValveCharacteristic | `SignalBlockKind::ValveCharacteristic` | `control_valve_characteristic` | EXACT |
| Saturation/Limiter | `SignalBlockKind::Saturation`/`Limiter` | `control_saturation`, `control_limiter` | EXACT |
| Deadband/DeadZone | `SignalBlockKind::Deadband` | `control_deadband` | EQUIVALENT |
| Hysteresis | `SignalBlockKind::Hysteresis` | `control_hysteresis` | EXACT |
| Stiction | `SignalBlockKind::Stiction` | `control_stiction` | EXACT |
| RateLimiter | `SignalBlockKind::RateLimiter` | `control_rate_limiter` | EXACT |
| PID | `SignalBlockKind::Pid` | `control_pid` e TDPS | EXACT |
| CalcExpression | parser cold-path com slots pré-resolvidos | `control.calc_expression` | EXACT |

Esses 24 blocos estão registrados em `subcircuits/library.json`, usam `.lssubcircuit` e são
compilados pelo mesmo `SignalEngine` do Core. Não são `.lsdevice`.

> Correção 2026-09-15: até esta data a tabela acima descrevia apenas o que
> `ProcessSubcircuitCompiler` sabia traduzir -- e ele nunca esteve no caminho de execução real (só é
> chamado pelos próprios testes). Na prática nenhum `control.*` tinha factory no
> `ComponentRegistry`, então instanciar qualquer manifesto Ctrl/TDPS falhava com "Unknown component
> typeId: control.*". A execução agora acontece por componente
> (`core/src/components/control/SignalMathBlock.hpp`, registrado em `registerBuiltinComponents`),
> pelo mesmo `expandSubcircuit` de qualquer outro subcircuito. O gate que vale para esta seção é
> `control_block_subcircuit_test`, que instancia os 49 manifestos publicados pela API real da
> sessão -- um teste do compilador isolado não prova nada sobre a biblioteca estar alcançável.

## Equivalentes existentes, mas ainda sem bloco público dedicado

`Bias`, `Subtract` e `Divide` já estão publicados como aliases compilados por `CalcExpression`; `MinMax`, comparadores,
funções matemáticas e trigonométricas não podem ser declarados honestamente como prontos porque a
DSL atual só possui constantes, entradas, soma, subtração, produto, divisão e negação. Não foram
criados aliases que prometam semântica inexistente.

## Ausentes do runtime atual

`Step`, `Ramp`, `SineWave`, `Pulse`, `Clock`, `RepeatingSequence`, `Random/WhiteNoise`, lookup 1D/2D,
state-space contínuo/discreto, zero-order-hold, sample-and-hold, discrete transfer function,
FIR/filter genérico, rate-transition, dynamic saturation/dead-zone/rate, relay/backlash/quantizer,
Mux/Demux/Selector vetorial, multiport switch, detecção de eventos e zero-crossing.

Esses itens exigem novos `SignalBlockKind`/estado/validação no Core ou uma extensão da infraestrutura
de tipos e scheduler; gerar somente JSON ou `.lssubcircuit` para eles criaria blocos catalogados que
falham no `ProcessSubcircuitCompiler`. Por isso permanecem explicitamente `MISSING`/`CORE_ONLY`, não
foram mascarados como implementados.

## Conversores MNA<->Signal (`bridges.*`)

Os 6 componentes de fronteira elétrica/sinal (`bridges.voltage_sensor`, `current_sensor`,
`digital_input`, `controlled_voltage_source`, `controlled_current_source`, `digital_output`) já
existiam completos no `SignalBridges.hpp` -- matemática elétrica correta, disciplina causal
cross-domain já implementada no settle loop (`applySignalActuatorsUnlocked`/
`publishElectricalSensorsToSignalUnlocked`) -- mas, até 2026-09-15, só alcançáveis pela autoria
`setElectricalSignalBridges`/`setSignalGraph`, nunca chamada pela Extension, e ausentes do catálogo
visual. Mesmo padrão do bug do TDPS: existiam só pros próprios testes (`SignalBridgeTest.cpp`).

Agora também expõem `signalPorts()` (porta "value" pros 3 sensores, porta "command" pros 3
atuadores) e entram no MESMO caminho genérico de fio (`connectWireUnlocked`) usado por
`Tunnel`/`SignalMathBlock`/HART -- sem API de binding separada. Dois hooks novos no settle loop
(`publishElectricalBridgeSensorsToSignalUnlocked`/`sampleElectricalBridgeActuatorsFromSignalUnlocked`)
só agem em componentes efetivamente ligados por fio comum (`hasGenericSignalWireUnlocked`), pra
nunca conflitar com a autoria antiga em quem ainda a usa. Cada um tem `package` próprio (3 pinos
visíveis: 2 elétricos "P"/"N" de um lado, 1 de sinal "IN"/"OUT" do outro lado em laranja, pra
distinguir visualmente qual é qual) e nome no formato `Origem2Destino` (`Tensão2Sinal`,
`Corrente2Sinal`, `Digital2Sinal`, `Sinal2Tensão`, `Sinal2Corrente`, `Sinal2Digital`). Visíveis na
paleta em "Conversores", dentro de Miscelâneos (workspace "misc", mesma seção do túnel dual-domínio).

Mesma pasta ganhou `logic.adc`/`logic.dac` ("A/D"/"D/A", `components/logic/AdcDac.hpp`) -- 100%
elétricos, SEM `signalPorts()`: 1 pino analógico de terminal único ("in"/"out", referenciado ao
terra global da MNA, nunca um par diferencial) + barramento LITERAL de 8 pinos digitais
independentes ("d0".."d7", d0 = LSB, cada um 0V/5V de verdade via Norton equivalente) -- réplica do
encapsulamento e fiação do ADC/DAC real do SimulIDE, pedido explícito do usuário depois de uma
primeira versão (revertida) que carregava o valor quantizado numa única porta de Signal Graph.
`vref` (tensão de referência) é a única propriedade editável; resolução fixa em 8 bits, mesmo
layout de pinos do dispositivo original. Typeids preservados de `SimulideComponentMapper.ts`
(mapeava `adc`/`dac` de `.sim1` pra cá antes de existir fábrica nenhuma -- import agora funciona de
verdade). Ficam na pasta "Conversores" por pedido explícito do usuário, mesmo não compartilhando o
fio genérico de Signal Graph dos outros 6 (que continuam usando `signalPorts()`/
`connectWireUnlocked`). No caminho de construir a primeira versão (a que foi revertida), achado e
corrigido um bug real em `setPropertyUnlocked`, que permanece válido pros 6 bridges/`control.*`:
editar uma propriedade `AffectsTopology` de QUALQUER componente com `signalPorts()` DEPOIS que o
Signal Plan já tinha compilado uma vez nunca invalidava o domínio Signal, só o Elétrico -- o valor
editado nunca chegava a valer (plano velho continuava rodando). Gates:
`electrical_signal_bridge_live_test` (6 malhas reais elétrico+sinal+elétrico dos bridges) e
`adc_dac_bus_test` (codificação/decodificação byte-a-byte do barramento digital do ADC/DAC,
saturação nos dois extremos, `vref` reescalando).

## Composites

Os composites TDPS existentes (`process_fopdt`, `tdps_*`) e os wrappers de estágio acima usam a
topologia canônica v3, `interface`, `exposedComponents` e `exportedPropertyComponentIds`. Ainda não
há implementações completas e validadas de PID 2DOF/anti-windup/tracking, Cascade, Feedforward,
Ratio, Override, Smith Predictor genérico, ValveActuator e TwoTank genéricos fora dos cenários TDPS.

## Gates executados

- `npm --prefix extension test`: PASS.
- `lasecsimul-core` Release: PASS após adicionar os aliases do compilador.
- Validação JSON dos 21 manifests e registro no catálogo: PASS.
- `control_block_subcircuit_test` (2026-09-15): 49/49 manifestos Ctrl/TDPS instanciam por
  `addSubcircuitInstance` e compilam o Signal Plan, incluindo malha fechada real.

O projeto não declara a seção Ctrl completa enquanto os itens `MISSING` acima não tiverem kernel,
semântica, inspector, save/reload, testes matemáticos e benchmark correspondentes.
