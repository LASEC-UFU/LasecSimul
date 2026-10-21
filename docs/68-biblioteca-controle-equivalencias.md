# Matriz de equivalência da migração de controle

Este documento registra as transformações de `extension/src/migration/controlLibrary/conversions.ts`. As regras são determinísticas e baseadas no comportamento implementado pelo Core legado (`SignalMathBlock`/`SignalEngine`); a validação executável compara séries temporais do Core congelado em `ab4c1efb7` com a biblioteca nova.

## Forma da conversão

- **1:1:** mantém o ID externo do componente e converte propriedades e nomes de portas. Fios e pinos de subcircuitos continuam ligados ao mesmo componente.
- **Inline:** insere blocos auxiliares no mesmo diagrama (por exemplo, `Mux → Fcn → Saturation`) e reescreve os condutores que entravam no bloco.
- **Subsistema:** mantém ID, posição, rótulo, interface e referências externas; cria definição interna compartilhável e parâmetros por instância `@bloco.Parâmetro`.
- **Renomeação:** usada para `process.accumulator`, que permanece uma dinâmica específica de processo.
- **Mantido:** `control.constant` é um parâmetro de modelo do LasecSimul, não um bloco de sinal equivalente ao Constant do Simulink.

## Regras dinâmicas relevantes

### PID

`control.pid` é convertido em `sl.discrete_pid_controller_2dof`, forma paralela, com Backward Euler no integrador e no filtro, período de amostragem explícito, saturação e clamping anti-windup. O ganho proporcional é `action·kc`; integral é `action·kc/ti` para `ti > 0`; derivativo é `kc·td` quando a derivada atua na PV e `action·kc·td` quando atua no erro. O parâmetro `c` seleciona essa convenção. Bias mais integral inicial alimenta `I0`; `D0` inicializa o filtro para manter a saída legada. A equivalência do PID básico é coberta por `legacyPidMapping` em `core/test/core/library/PidBlocksTest.cpp`.

### Estação PID

`control.pid_station` preserva as entradas SP, PV, AM e LR. AM e LR passam por `sl.zero_order_hold` no período do controlador. LR seleciona setpoint local (`localSetpoint`) ou remoto (SP); erro é referência menos PV. AM seleciona saída automática ou saída manual limitada à faixa configurada. Na transição manual/automático, o reset externo do controlador impede salto de saída; a condição inicial acompanha o valor manual menos a parcela proporcional, ou bias mais integral inicial em automático. Esta composição foi comparada ao bloco legado em `legacyPidStationMapping`.

### Dinâmica e inicialização

- Primeira ordem `K/(τs+1)` é discretizada por ZOH exato no `samplePeriodNs` legado para preservar as ativações que o bloco antigo efetivamente expõe; a forma é `b=[K(1−e^(−Ts/τ))]`, `a=[1,−e^(−Ts/τ)]`. O estado inicial é passado a `InitialStates`.
- Integrador usa `sl.discrete_time_integrator` com Forward Euler, ganho, estado inicial e `samplePeriodNs` explícitos, representando a acumulação ZOH por ativação.
- Segunda ordem mantém `x=[y, y']` em State-Space contínuo e segue por `Unit Delay` amostrado no período legado para preservar a fase de publicação observada no Core antigo.
- Limitador de taxa amostra a entrada com `Unit Delay` (`InitialCondition=initial`, `SampleTime=Ts`) e alimenta `Rate Limiter` no modo discreto herdado. Os dois estados iniciais são `initial`; não há atraso extra na saída, preservando a fase confirmada na comparação de 0,4 s.
- Derivada filtrada usa State-Space contínuo (`A=−1/τ`, `B=1/τ`, `C=−K/τ`, `D=K/τ`) seguido por `Unit Delay` amostrado no período legado. O atraso reproduz a fase de publicação do sinal e o filtro contínuo preserva a trajetória entre amostras.
- Lead-lag usa State-Space discreto ZOH exato: `A=e^(−Ts/lag)`, `B=1−A`, `C=K(1−lead/lag)`, `D=K·lead/lag`.
- Lead-lag preserva `K(lead·s+1)/(lag·s+1)` e usa State-Space quando necessário para manter o estado.
- FOPDT mantém `Transport Delay` explícito no diagrama principal (não aninhado como override) e conecta a planta de primeira ordem discretizada por ZOH no período legado. O atraso deve reproduzir a amostra histórica por inteiro antes de entrar na planta.
- Funções de transferência discretas e espaço de estados discreto preservam período e coeficientes/matrizes.
- Composições algébricas internas usam `SampleTime=-1` para herdar o domínio/ritmo do sinal; blocos legados amostrados recebem seu período histórico explicitamente.
- Característica de válvula usa um único `sl.fcn` no período legado: `C*((u+abs(u))/2)^n`, que é igual a `C*max(0,u)^n` e evita um estágio intermediário de saturação.

### Expressões, portas e referências

As entradas do Sum/Product preservam ordem, operador e IDs legados. `control.calc_expression` traduz a gramática histórica para `sl.fcn`, cria Mux para entradas nomeadas e aplica Saturation quando os limites legados estavam ativos. A migração preserva IDs de componentes e referências por ID, reescreve endpoints de fios, portas exportadas e overrides `@filho.propriedade`, inclusive quando a definição antiga vem do snapshot da biblioteca.

## Condições reportadas

Parâmetros que o Core legado recusava (por exemplo, coeficientes discretos inválidos, `ti`/`td` negativos, filtro derivativo inválido, limites invertidos ou ação zero no PID) não recebem uma dinâmica inventada. O componente permanece inalterado e o relatório registra `unsupported` e a razão. `control.constant` é a única regra `keep` intencional.

Cada migração é idempotente: um documento sem tipos legados conversíveis não sofre nova alteração. A conversão pura e o inventário completo do repositório são exercitados por `extension/src/migration/controlLibrary/migration.test.ts`.
