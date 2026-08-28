# I2C host scheduling/fidelity encerrada

O writer causal binário bounded eliminou o observer effect do recorder textual. A captura ETW
confirmou descheduling/off-CPU em 150/150 tails R3→D0 >=10 µs. A união de toda a região R3→D0
foi 6042 µs em 4.613 s (limite superior de 0,131% do wall time), sem justificativa para
otimização de prioridade/afinidade ou criação de workers.

O caminho guest-visible aguarda `i2cResponseSeq`; o tempo host gasto aguardando a resposta não é
convertido automaticamente em tempo virtual do guest. `periodNs` e `i2cStretchNs` permanecem os
valores modelados da transação. Assim, para o stall host analisado, o impacto de timing virtual
guest-visible é NONE.

`Scheduler::nowNs()` em T3/T4 é a fronteira virtual global comprometida, não uma duração local de
I2C. Outliers de snapshots (quatro casos >=100 µs, todos na thread de polling 22004) não são
evidência de atraso guest-visible.

Estado: causa local CONFIRMED_DESCHEDULING; impacto global NEGLIGIBLE neste workload; nenhuma
otimização de scheduling justificada. R3/D0/D1 foram removidos do hot path normal; o parser
continua compatível com traces históricos que ainda contenham os campos diagnósticos.

## Baseline pós-diagnóstico oficial

Artefatos de referência: `postdiag-core.trace`, `postdiag-qemu.trace` e `postdiag-run.log`.
Core `4D902FC1C84F7051213B40F1FAE021F1A9F680890C36D118E2DE90E6A73E8D68`; QEMU
`86AA98590AB3AE74561D459A3E8B8C6C26F427CB2C02600120F53D77D3F5FAE0`; firmware
`2328824B5016AA292E701A03F2477A14B632CCEE1C91B463517CB423434452A9`.

O trace tem 120 transações, zero incompletas, duplicatas, drops, malformados ou violações QPC,
com `causalValid=true`. ACK inválido e Guru Meditation são zero; display e UART/LasecPlot estão
funcionais, com correspondência exata e 1190 pixels acesos.

Esta baseline é a referência oficial. T3→T4/T0→T1 permanecem jitter host conhecido, sem nova
regressão. Não há discrepância hardware demonstrada: próximo candidato de fidelidade = `NO CHANGE`.
