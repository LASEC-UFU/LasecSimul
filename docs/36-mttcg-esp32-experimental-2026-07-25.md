# MTTCG padrão para ESP32 — implementação, validação e rollback

Data: 2026-07-25.

## Resultado

Após a validação com o firmware real, o modo padrão passou a ser:

```text
-accel tcg,thread=multi
```

sem `-icount`. Isso cria uma thread TCG por vCPU ESP32. O QEMU confirmou em teste real:

```text
Qemu: execution mode: mttcg-realtime (vcpus=2, tcg_threads=2)
```

Para voltar imediatamente ao modo anterior, defina antes de executar Stop → Run:

```text
LASECSIMUL_ESP32_EXECUTION_MODE=deterministic
```

O rollback lança:

```text
-accel tcg,thread=single
-icount shift=4,align=off,sleep=off
```

Remover a variável seleciona novamente o MTTCG padrão. Valores não vazios desconhecidos falham de
forma segura para o modo determinístico.

## Correções necessárias no QEMU

- Todos os timestamps da ponte passaram a usar `QEMU_CLOCK_VIRTUAL`. Essa fonte seleciona
  `icount_get_ns()` no modo determinístico e o relógio monotônico normal da VM no MTTCG.
- Publicação na fila e o slot síncrono de leitura foram serializados por uma trava interna. O BQL é
  liberado antes de adquirir essa trava e só é recuperado depois de liberá-la, evitando inversão de
  locks entre as duas vCPUs.
- O timestamp é capturado dentro da seção serializada, impedindo que duas vCPUs publiquem eventos
  fora de ordem.
- `SIM_READ` usa release/acquire nos dois processos; o Core limpa `simuTime` antes de liberar
  `qemuAction`, impedindo que um ACK atrasado apague a leitura seguinte.
- O caminho específico `main_loop_timeout()` deixou de chamar o warp de icount quando icount está
  desligado. Antes disso, o primeiro loop MTTCG abortava no assert de `icount_start_warp_timer()`.

Não houve alteração no layout binário da arena v3.

## GPIO13 congelado apesar de a simulação indicar 100%

A repetição de Stop → Run com o firmware real expôs uma segunda falha, intermitente e específica do
tempo multicore: em aproximadamente 30–50% de algumas baterias, a interface continuava indicando
100%, mas o GPIO13 permanecia em LOW.

O diagnóstico com GDB e telemetria temporária mostrou a APP CPU chegando a `panic_handler` por
interrupção de watchdog. A causa raiz não era o GPIO nem o solver:

1. o firmware troca o clock Xtensa durante o boot, chegando a 240 MHz;
2. o QEMU alterava diretamente a frequência do `Clock`, sem fechar o intervalo acumulado pelo
   `CCOUNT` na frequência anterior;
3. sob MTTCG, a troca também podia ocorrer logo depois do vencimento de `CCOMPARE0`, mas antes de o
   callback do timer ser executado;
4. o compare, agora no passado, era reinterpretado pela aritmética modular como estando quase uma
   volta completa de 32 bits no futuro — cerca de 19 s a 240 MHz;
5. a APP CPU perdia o tick do FreeRTOS, o watchdog de interrupção do TG1 expirava e o firmware
   entrava em pânico, enquanto a ponte Core–QEMU e o relógio virtual continuavam vivos. Isso explica
   exatamente a indicação de 100% com o LED parado.

O commit QEMU `f3e3cebbc119b792dca69860d5b0f02a268ac0b7` corrige o problema em três camadas:

- antes de mudar a frequência, materializa o `CCOUNT` usando o clock antigo e redefine
  `ccount_base/time_base`, preservando continuidade;
- preserva um `CCOMPARE` já vencido e reagenda os demais compares com a nova frequência, sem
  transformá-los acidentalmente em uma volta de 32 bits;
- executa o reset individual da APP CPU no contexto da própria vCPU e a mantém em stall até a
  conclusão do reset, eliminando a corrida com o antigo reset global atrasado.

Também foi eliminada a subtração sem sinal do watchdog quando a contagem já ultrapassou o timeout e
foi adicionada validação para não indexar uma configuração inválida de frequência.

## Telemetria

`LASECSIMUL_QEMU_PROFILE=1` produz aproximadamente uma linha por segundo:

```text
[LasecSimul][PROFILE] mode=... wall_ns=... virtual_ns=...
realtime_percent=... events=... reads=... queue_waits=...
read_waits=... max_queue=...
```

Baseline de 10 segundos com flash apagada, rede desabilitada e dois processos medidos em paralelo:

| Modo | Tempo de parede observado | Tempo virtual | Ritmo virtual | Eventos publicados | Esperas por fila |
|---|---:|---:|---:|---:|---:|
| determinístico/icount | 9,38 s | 0,303 s | 3,23% | 3.980 | 117 |
| MTTCG/realtime | 6,81 s | 6,814 s | 100,00% | 233 | 1 |

Essa medição prova a troca de modelo de tempo e a capacidade de acompanhar tempo real no cenário de
boot/idle; não prova ganho de throughput de firmware. Flash apagada não mantém as duas CPUs ocupadas,
portanto números de 1,3x–2x não podem ser inferidos dela. O benchmark decisivo continua sendo o
firmware real do usuário, especialmente separando cargas CPU-bound de cargas dominadas por MMIO.

## Validação automatizada

- `esp32_adapter`: valida o contrato dos argumentos nos dois modos.
- `qemu_mttcg_smoke`: executa o QEMU real por 10 s, exige duas threads TCG, timestamps não nulos,
  fluxo sustentado da fila e telemetria.
- `mcu_scheduler_pacing_sync_real_qemu_mttcg`: executa QEMU, `McuComponent`, `Scheduler` e pacing
  reais por 15 s. O processo permaneceu vivo; o MCU e o Scheduler continuaram avançando.
- O mesmo stress de fila também foi executado no modo determinístico para proteger o rollback.

## Validação com o firmware de referência

O firmware real `merged.bin` de 4 MiB (SHA-256
`44925BFFF6A6E26149DF6F8DEF96A865D2E8DEBF2C2159E39CF7FA4BEDE1AA14`) foi validado com GPIO13
ligado por 1 kΩ ao GND:

- execução contínua de 15 s: 21 transições, níveis HIGH e LOW observados, Pause/Continue e Stop
  aprovados, sem reset inesperado;
- bateria intermediária de 40 ciclos Stop → Run, seis segundos por ciclo: 0 falhas de boot, 0
  travamentos e 0 falhas do GPIO13;
- bateria final com o binário de produção: 25 ciclos Stop → Run, oito segundos por ciclo, 10–11
  bordas do GPIO13 em todos os ciclos; 0/25 falhas de boot, 0/25 travamentos, 0/25 falhas do GPIO13
  e 0/25 resíduos de processo, Scheduler, pausa, relógio ou eventos após Stop;
- smoke de fila de 10 s: MTTCG manteve 100% de ritmo virtual e o modo determinístico também
  permaneceu estável, protegendo o rollback;
- medição do usuário no projeto real: avanço de aproximadamente 23% para 98%.

Com essas evidências, MTTCG deixou de ser opt-in e passou a ser o modo padrão. O modo
`deterministic` permanece disponível como rollback e regressão automatizada. UART, I2C/SPI e
interrupções continuam cobertos pelas suítes específicas existentes e devem permanecer no conjunto
de regressão a cada alteração futura do protocolo Core–QEMU.
