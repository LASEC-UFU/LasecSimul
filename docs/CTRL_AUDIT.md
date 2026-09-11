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

## Composites

Os composites TDPS existentes (`process_fopdt`, `tdps_*`) e os wrappers de estágio acima usam a
topologia canônica v3, `interface`, `exposedComponents` e `exportedPropertyComponentIds`. Ainda não
há implementações completas e validadas de PID 2DOF/anti-windup/tracking, Cascade, Feedforward,
Ratio, Override, Smith Predictor genérico, ValveActuator e TwoTank genéricos fora dos cenários TDPS.

## Gates executados

- `npm --prefix extension test`: PASS.
- `lasecsimul-core` Release: PASS após adicionar os aliases do compilador.
- Validação JSON dos 21 manifests e registro no catálogo: PASS.

O projeto não declara a seção Ctrl completa enquanto os itens `MISSING` acima não tiverem kernel,
semântica, inspector, save/reload, testes matemáticos e benchmark correspondentes.
