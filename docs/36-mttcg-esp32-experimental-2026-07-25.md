# MTTCG experimental para ESP32 — implementação e baseline

Data: 2026-07-25.

## Resultado

O modo padrão continua determinístico:

```text
-accel tcg,thread=single
-icount shift=4,align=off,sleep=off
```

O modo experimental é habilitado antes de iniciar a simulação:

```text
LASECSIMUL_ESP32_EXECUTION_MODE=mttcg
```

Ele lança:

```text
-accel tcg,thread=multi
```

sem `-icount`. O QEMU confirmou em teste real:

```text
Qemu: execution mode: mttcg-realtime (vcpus=2, tcg_threads=2)
```

Para voltar imediatamente ao comportamento anterior, remova
`LASECSIMUL_ESP32_EXECUTION_MODE` e execute Stop → Run. Valores desconhecidos também falham de forma
segura para o modo determinístico.

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

O modo permanece experimental e opt-in até ser medido com o firmware de referência real e passar
uma janela longa de Stop → Run, GPIO, UART, I2C/SPI e interrupções sob carga dual-core.
