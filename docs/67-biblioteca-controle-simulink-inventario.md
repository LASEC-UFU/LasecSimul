# Inventário de migração da biblioteca de controle

Este inventário fecha a ligação entre os typeIds legados `control.*` e a biblioteca nova `sl.*` / `process.*`. O catálogo de blocos novos, seus parâmetros, portas e links para MATLAB Help vive em `project/schema/block-library/*.json`; este documento registra a cobertura de migração implementada em `extension/src/migration/controlLibrary/conversions.ts`.

## Cobertura por tipo legado

| Legado | Conversão | Tratamento |
|---|---|---|
| `control.gain` | `sl.gain` | Conversão 1:1; ganho e período preservados. |
| `control.bias` | `sl.bias` | Conversão 1:1; porta declarada preservada. |
| `control.sum`, `control.subtract` | `sl.sum` | Operadores e portas remapeados. |
| `control.product`, `control.divide` | `sl.product` | Operadores e portas remapeados. |
| `control.integrator` | `sl.discrete_time_integrator` | Forward Euler, ganho, estado inicial e período de ativação explícitos. |
| `control.filtered_derivative` | `sl.state_space` + `sl.unit_delay` | Filtro contínuo e estado inicial preservados; o atraso de saída reproduz a fase de publicação legada. |
| `control.unit_delay` | `sl.unit_delay` | Condição inicial e período preservados. |
| `control.dead_time` | `sl.transport_delay` | Atraso e saída inicial preservados. |
| `control.first_order` | `sl.discrete_transfer_fcn` | Discretização ZOH exata no período de ativação legado; estado inicial incluído. |
| `control.second_order` | `sl.state_space` + `sl.unit_delay` | Estados `y` e `y′` preservados; o atraso amostrado reproduz a fase de publicação legada. |
| `control.lead_lag` | `sl.discrete_state_space` | Transição ZOH exata no período legado, com estado e ganho preservados. |
| `control.fopdt` | composição inline `sl.transport_delay` + `sl.discrete_transfer_fcn` | Atraso fica como componente direto no diagrama, evitando perda de fase por override aninhado; ganho, constante de tempo, período e estado inicial da planta são preservados. |
| `control.transfer_function` | `sl.transfer_fcn`, `sl.discrete_transfer_fcn` ou composição equivalente | Os modelos históricos delegam à regra específica; coeficientes discretos são preservados. |
| `control.state_space` | `sl.state_space` ou `sl.discrete_state_space` | Matrizes, estado inicial, domínio e período preservados. |
| `control.accumulator` | `process.accumulator` | Renomeado; continua sendo bloco de processo do LasecSimul. |
| `control.valve_characteristic` | `sl.saturation` + `sl.fcn` | Entrada limitada a zero ou acima, seguida da lei potência da válvula. |
| `control.saturation`, `control.limiter` | `sl.saturation` | Limites e período preservados. |
| `control.deadband` | `sl.dead_zone` | Largura convertida para limites simétricos. |
| `control.hysteresis` | `sl.relay` ou subsistema com memória | Limiares e saídas preservados; estado inicial não padrão mantém memória explícita. |
| `control.stiction` | subsistema `sl.mux` + `sl.fcn` + `sl.unit_delay` | Limite de desprendimento, escorregamento e estado inicial preservados. |
| `control.rate_limiter` | subsistema `sl.unit_delay` → `sl.rate_limiter` | A entrada é amostrada no período legado; o rate limiter opera no modo discreto herdado e mantém o estado inicial. |
| `control.pid` | subsistema com `sl.discrete_pid_controller_2dof` | Forma paralela, discretização, saturação e estado inicial explícitos. |
| `control.pid_station` | subsistema com `sl.discrete_pid_controller_2dof`, `sl.switch`, `sl.zero_order_hold` e blocos auxiliares | Entradas SP/PV/AM/LR; seleção local/remota, manual/automática e transferência sem salto. |
| `control.calc_expression` | `sl.mux` + `sl.fcn` + `sl.saturation` opcional | Expressão traduzida e limites preservados. |
| `control.observer` | `sl.gain` unitário | Mantém o sinal observável como saída nomeada. Não ramifica a partir da porta de entrada do bloco, pois isso gera conexão inválida no Core. |
| `control.probe` | `sl.signal_conversion` | Ponto de sondagem preservado. |
| `control.constant` | mantido | É parâmetro de modelo específico do LasecSimul, não o bloco Constant do Simulink. |
| `control.process` | subsistema equivalente | Composição de processo expandida em blocos da biblioteca. |

## Compatibilidade e recusas

`PENDING_LEGACY_TYPES` está vazio. Entradas válidas de todos os typeIds listados têm regra de conversão. Dados inválidos recusados pelo próprio Core legado continuam marcados como `unsupported` com motivo no relatório; a migração não inventa comportamento para parâmetros inválidos. `control.constant` é mantido intencionalmente, e `control.accumulator` permanece em `process.*` por ser uma dinâmica conservativa própria do produto.

Os nomes de bloco e as URLs oficiais ficam nas declarações de biblioteca em `project/schema/block-library/*.json`. A matriz propriedade a propriedade e as premissas de equivalência estão em [68-biblioteca-controle-equivalencias.md](68-biblioteca-controle-equivalencias.md).
