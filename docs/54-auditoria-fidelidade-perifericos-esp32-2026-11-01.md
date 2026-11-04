# Auditoria de fidelidade dos periféricos do ESP32 (2026-11-01)

Objetivo: o ESP32 simulado deve se comportar como o chip em todos os aspectos que um aluno pode observar.
Esta auditoria levantou o que o QEMU + adaptador ainda não faziam como o chip; os itens estão em ordem de
gravidade e são resolvidos nessa ordem. O primeiro lote saiu no patch 0022 do QEMU
(`devices/qemu-esp32/patches/0022-esp32-peripheral-fidelity-spi-miso-adc-rmt-pcnt-mcpwm-twai.patch`,
executável `9D3DC29908...`).

## Situação por item

| # | Item | Situação |
|---|------|----------|
| 1 | SPI: o MISO nunca era lido | **Resolvido (0022)** |
| 2 | ADC: `analogRead()` dava 0 no VNEXT_B; sem atenuação nem largura | **Resolvido (0022)**; tempo de conversão e ruído não modelados |
| 3 | RMT (WS2812, IR): os itens não chegavam aos pinos | **TX resolvido (0022), RX resolvido (0027)** |
| 3b | RMT RX | **Resolvido (0027)**; demodulação de portadora e ping-pong não existem no ESP32 original; tick arredondado sem fase do contador |
| 4 | PCNT, MCPWM e TWAI não mapeados (Guru Meditation) | **Resolvido (0022)**; o chopper do MCPWM e o CLKOUT do TWAI não são modelados |
| 5 | SPI só em MODE0; sem DMA; sem a interrupção de fim de transação; fases de comando/endereço/dummy ignoradas | **Resolvido (0023)**; registradores de atraso do MISO/MOSI, dual/quad/3 fios, CS1/CS2 e o modo escravo não são modelados |
| 6 | Deep sleep | **Resolvido (0023)**, com o light sleep; sem RTC IO hold e pulls no sono, ULP, touch e UART como fonte de despertar; ver 6b |
| 6b | Light sleep: os periféricos que o Core modela (LEDC, UART, PCNT, MCPWM, RMT, TWAI) seguem com clock | **Implementado (0028)**: congela clocks APB/REF_TICK e preserva LEDC RTC8M se CK8M_FORCE_PU; teste não mede diretamente a saída RTC8M durante o sono |
| 7 | Touch: ~1500 fixo, sem ligação com o circuito | **Resolvido (0024)**: a contagem vem da capacitância que o circuito põe no pad; o `DCUR` e as cargas resistivas não são modelados |
| 8 | DAC (RTCIO é um stub) | **CW resolvido (0029)**: RTC8M, FSTEP, escala, offset, fase e inversão por canal; MUX/RTC GPIO (0024) e DMA do I2S (0025); limite de corrente DAC específico ainda sem especificação verificável |
| 9 | UART: sem paridade, quadro fixo de 10 bits, 1,5 stop bit vira 1 | **Resolvido (0024)**, com os bits de DL, a inversão da linha, os erros de recepção e o break do transmissor; o `TX_IDLE_NUM`, o loopback, o controle de fluxo e o modo RS485 não são modelados |
| 10 | Bluetooth | Pendente (escopo a decidir com o usuário) |
| 11 | I2S é um stub | **Resolvido (0025)**: DMA de TX e RX no tempo da taxa (PLL_F160M e APLL), as interrupções, o modo FIFO da CPU, o DAC e o ADC internos; os pinos BCK/WS/dados, PDM, LCD/câmera e A-law não são modelados |
| 12 | I2C em modo escravo | **Resolvido (0025)**: endereço de 7 bits, ACK, as FIFOs de RX e TX com os limiares, `TRANS_COMPLETE` no STOP; o endereço de 10 bits e a chamada geral não são modelados |
| 13 | Clock XTAL ignora o divisor do SYSCLK | **Resolvido (0026)**: o XTAL e o RC_FAST divididos por `PRE_DIV_CNT + 1` e o APLL como fonte da CPU; o APB de agora vai ao Core (LEDC, filtro do PCNT, captura do MCPWM, TWAI, UART e I2C); o REF_TICK fica em 1 MHz |
| 14 | Só o primeiro FRC timer recebia a frequência do APB | **Resolvido (0022)** |
| 15 | Período do SPI 0 até o firmware escrever SPI_CLOCK_REG | **Resolvido (0023)** |
| 16 | WDT dos TIMG escalado x100 em toda sessão | **Resolvido (0022)** |
| 17 | Dois MCUs na mesma sessão rodam a ~2% do tempo real | **Melhorado (Core, candidato 0029)**: lookahead de pares 10 µs; TWAI cai de 13 s para 5 s; I2C escravo continua 153 s. O lockstep multi-MCU ainda não é tempo real em todos os workloads |
| 18 | Um reset do guest não reiniciava os periféricos que o Core modela | **Resolvido (0023)** |
| 19 | UART: o guest via a TX ociosa com o Core ainda transmitindo; TX_DONE invertido | **Resolvido (0023)** |
| 20 | eFuse: cada leitura levava 100 ms (300 ms na ROM a cada boot) | **Resolvido (0023)** |
| 21 | Uma troca do APB recontava todo o tempo dos timers TIMG/FRC na frequência nova | **Resolvido (0023)** |
| 22 | A APP CPU não alcançava a RTC FAST (deep sleep a partir do core 1 dava Guru Meditation) | **Resolvido (0023)** |
| 23 | Sem imagem de eFuse o chip dizia revisão 0 (o `APB_CTRL_DATE` dizia ECO3); com `use_apll` o ESP-IDF esperava a calibração do APLL para sempre | **Resolvido (0025)** |
| 1b | SPI bit a bit contra um escravo do circuito a ~11% do tempo real | **Resolvido (Core/adapter/device, candidato 0029)**: troca MISO por byte para escravo compatível; pares incluem o nó MISO e saídas q instrumentadas mantêm fallback bit a bit |
| 3b | RMT RX | **Resolvido (0027)**; sem demodulação de portadora e ping-pong (não existem no ESP32 original); tick arredondado sem fase do contador |

## O que mudou no lote 0022

- **SPI MISO (1).** O adaptador amostra o MISO em cada borda de captura e o Core leva o byte ao W0-W15 do
  QEMU pelo C2A, com meia e dupla via, `USR_MISO_HIGHPART`, `RD_BYTE_ORDER` e `RD_BIT_ORDER`. Uma leitura
  do W0-W15 espera os bytes que o fio já terminou: o anel C2A tem 64 entradas e uma transação de 48 bytes
  o enchia. O período do SCK é calculado em ps: a 80 MHz, 12,5 ns virava 12 ns, um clock 4% rápido.
- **ADC (2).** O Core publica a tensão dos 18 pads (0,1 mV) no snapshot. O SENS do QEMU guarda os
  registradores com os valores de reset e devolve o inverso da curva de line fitting do ESP-IDF (Vref
  1100 mV, tabela de 11 dB), na largura e na atenuação configuradas.
- **RMT TX (3).** Motor por canal no QEMU (wrap com TX_THR, TX_END, modo contínuo, portadora) e as formas de
  onda no adaptador, nos sinais 87-94 da matriz. O decodificador WS2812 do `simulide-complex` perdia o
  primeiro bit de cada quadro e foi corrigido junto.
- **PCNT (4).** Contador no adaptador (sinais 39-58 e 71-82, filtro em ciclos de APB, `STATUS` travado na
  última interrupção) e a interrupção no QEMU.
- **MCPWM (4).** Timers (subida, descida, sobe-desce, sync), atualizações por sombra, ações do gerador com
  prioridade, dead time S0-S8, falhas OST/CBC e captura a APB.
- **TWAI (4).** O controlador CAN inteiro no adaptador, bit a bit nos pinos (sinais 123/124 e 94), no
  modelo do SJA1000/OpenCores que as erratas do ESP-IDF descrevem:
  - stuffing e CRC-15, ACK, arbitragem;
  - quadros de erro e de sobrecarga;
  - regras do TEC/REC com as exceções 1 e 2;
  - bus off com TEC = 128 descontado a cada 11 recessivos;
  - ressincronização com SJW e filtro de aceitação.

  O QEMU guarda a FIFO de RX de 64 bytes com o overrun por mensagem, o IR e o rearme do ALC/ECC; o reset
  pelo `DPORT_PERIP_RST_EN` também zera o controlador. Para não sincronizar o guest a cada bit:
  - as bordas do próprio TX são eventos suaves;
  - um plano previsto marca os instantes que levantam interrupção;
  - esses instantes chegam num segundo despertar, rígido, por módulo (`McuComponent::scheduleModuleHardWakeup`).
- **Outros.**
  - Matriz de interrupção em OU.
  - WDT sem a escala x100.
  - O SoC começa no clock XTAL de reset.
  - Todo FRC timer recebe o APB (14).
  - Sem avisos de build do ESP32.

## O que mudou no lote 0023

- **SPI (5, 15).** HSPI/VSPI com as fases de comando, endereço, dummy e dados (meia e dupla via), tamanhos
  em bits, CPOL/CPHA nos quatro modos, a interrupção de fim de transação e o DMA com as cadeias `lldesc` de
  saída e entrada (irq 52-54). Os registradores começam nos valores de reset do chip (`SPI_CLOCK`
  0x80003043, `SPI_USER` 0x80000040) e o período vem do APB a cada transação.
- **Escritas que o guest vê na hora (lockstep).** Com uma interrupção do Core armada (PCNT, MCPWM, GPIO), as
  escritas "suaves" também seguram o guest: uma captura do MCPWM das bordas do próprio SPI chegava tarde.
- **Os resets e o seu alcance (18).** Como no chip:
  - o `esp_restart()` é um `SW_CPU_RESET` e só reinicia as CPUs: o LEDC segue gerando PWM e o PCNT segue
    contando;
  - um reset do digital (`RTC_CNTL_SW_SYS_RST`, watchdog, a volta do deep sleep) reinicia tudo, no Core
    também;
  - o `DPORT_PERIP_RST_EN` (`periph_module_reset()`) reinicia o periférico do bit nas duas bordas. No QEMU
    são as linhas `perip-rst`; no Core, um módulo novo do adaptador no endereço do registrador.
- **UART (19).** Cada byte, `CLKDIV` e `CONF0` chega ao Core pela própria escrita do guest, no instante dela.
  Antes passava por uma bottom half, mais tarde, e o guest via a UART ociosa com o Core ainda transmitindo:
  o `esp_restart()` e o deep sleep cortavam o fim do que o firmware tinha impresso. O QEMU anda os quadros
  como o Core (start, bits de dados e stop do `CONF0`), com `ST_UTX_OUT`, o `TXFIFO_CNT` sem o byte do
  shifter e o `TX_DONE` travado; ele estava invertido e o `uart_wait_tx_done()` voltava cedo. Os monitores
  e o tap do fio sobrevivem a um reset do periférico: guardam bytes que já passaram pelo pino.
- **eFuse (20).** Uma leitura levava 100 ms (um placeholder). São três a cada boot, então a ROM passava
  300 ms antes de imprimir. Depois de um reset do digital, ainda no PLL (APB 80 MHz), o watchdog de flash
  boot do TG0 (325 ms) estourava dentro do bootloader. Agora a leitura leva 10 us: pela tabela de leitura
  do controlador são poucos ciclos de APB por palavra.
- **Deep sleep (6).**
  - Acorda pelo timer de RTC, pelo ext0 e pelo ext1; cada despertar é um reset com `DEEPSLEEP_RESET` que
    mantém a memória e o tempo de RTC.
  - O motor de CRC da memória de RTC que a ROM usa (`RTC_CNTL` 0x100/0x104) agora existe; sem ele a ROM
    esperava o FINISH para sempre.
  - O domínio digital desliga: os watchdogs dos TIMG param (antes encerravam o sono num `TG1WDT_SYS_RESET`).
  - A APP CPU alcança a RTC FAST pelo barramento de dados (22). O ESP-IDF lê `s_adc_tsen_enabled`
    (`RTC_FAST_ATTR`) no `esp_sleep_start()`, no core de quem dorme, e o Arduino dorme do `setup()` no
    core 1.
- **Light sleep (6).**
  - Acorda pelo timer, pelo ext0 e pelo GPIO (`esp_sleep_enable_gpio_wakeup`, `WAKEUP_ENABLE` de
    `GPIO_PINn`).
  - Sem os clocks da CPU e do APB, o CCOUNT (com os CCOMPARE), os TIMG e os FRC não contam o sono; o
    `esp_timer` conta, pois o ESP-IDF o acerta pelo tempo de RTC.
  - A troca do APB (a CPU vai ao XTAL e volta) só muda o ritmo dali em diante (21). Antes recontava todo o
    tempo desde a base, e o timer de hardware andava para trás.
- **Outros.** A primeira escrita do QEMU no Core durante o `qemu_init()` (o reset de ligar) derrubava o
  transporte legado. O `vnext_b_attachment` passou a distinguir as escritas do próprio guest (que agora
  roda depois da leitura do eFuse) das escritas de auto-teste repetidas.

## O que mudou no lote 0024

- **Touch (7).** O SENS do QEMU faz a medição do chip: o sono (`SLEEP_CYCLES` no clock lento), o XPD e a
  janela (`MEAS_DELAY` a 8 MHz). A contagem é T · I · inclinação / (2 · (20 pF + C) · ΔV), com I = 1,72 µA
  por passo de inclinação e ΔV de `TOUCH_CFG` (DREFH, DREFL, atenuação). O C é a capacitância que o
  circuito põe no pad: o Core a mede na rede do pino com uma sonda de 1 MΩ por 1 µs e a devolve pelo
  snapshot antes de a janela fechar. Os canais 8 e 9 trocados como no chip, a interrupção do limiar e o
  despertar do deep sleep pelo toque.
- **RTC IO.** Um pad no domínio do RTC (`MUX_SEL`, o `rtc_gpio_init()` e o `touch_pad_io_init()`) perde a
  saída digital; o `RTC_GPIO_OUT`/`ENABLE` o dirige, com os pulls `RUE`/`RDE`. O GPIO15 (MTDO) é uma saída
  digital no reset e só sai dela pelo MUX.
- **DAC (8).** GPIO25/26 a 3,3 · D / 255 por 20 Ω (a resistência de saída medida no chip), uma fonte de
  Norton no pino (`mcu_abi` 3.5, `get_pin_analog`).
- **Reset do digital.** Roda no adaptador (módulo Soc em 0x3FF48FFC): reinicia o digital e mantém o domínio
  do RTC (RTC IO, touch) e as tensões dos pads. Antes o QEMU reenviava cada registrador do RTC IO no
  reset, 17 escritas numa só instrução do guest que o lockstep repetia sem fim (o deep sleep acabava num
  `TG0WDT`).
- **UART (9).**
  - O quadro inteiro do chip: paridade par e ímpar, 5 a 8 bits, 1, 1,5 e 2 stops e os bits de DL do
    `RS485_CONF`. O ESP-IDF faz os 2 stops com `STOP_BIT_NUM` 1 e `DL1_EN`, pela errata do chip. O QEMU
    anda o quadro com a conta inteira do Core, então o fim de cada byte bate no ns.
  - `TXD_INV`/`RXD_INV`. Inverter o RX é uma borda que o receptor vê, como no chip.
  - Os erros de recepção chegam ao firmware: paridade, quadro e break (`PARITY_ERR`, `FRM_ERR`,
    `BRK_DET` travados até o `INT_CLR`) e o `RXFIFO_OVF`. O byte vai para a FIFO assim mesmo: o ESP32 não
    tem o `ERR_WR_MASK` dos chips mais novos.
  - O break do transmissor (`TXD_BRK`, `TX_BRK_NUM`, `TX_BRK_DONE`). O `uart_write_bytes_with_break()`
    (LIN, DMX) esperava para sempre.

## O que mudou no lote 0025

- **I2S (11).** As duas I2S eram stubs: o `i2s_write()`/`i2s_read()` esperava para sempre pela DMA.
  - O modelo do chip: os registradores com os valores de reset do TRM; o clock `PLL_F160M / (N + b/a) / M`
    (e o APLL, abaixo), uma entrada da FIFO por quadro (por canal no modo 2; por ciclo de WS no modo LCD);
    o período é uma fração exata de ns, sem deriva.
  - TX: a DMA lê as cadeias `lldesc` para a FIFO de 64 entradas conforme abre espaço; `OUT_DONE` ao ler
    um descritor, `OUT_EOF` quando a última entrada sai (`OUT_EOF_MODE` 1) ou entra (0), `OUT_TOTAL_EOF` no
    fim da lista. RX: cada entrada vai ao buffer quando é recebida; `IN_DONE` e `IN_SUC_EOF` a cada
    `RXEOF_NUM` palavras, com o descritor devolvido. O modo FIFO da CPU (`DSCR_EN` 0) também.
  - Sem dispositivo I2S no circuito, o receptor lê o nível do pino de dados. Um escravo só anda com o
    clock da outra metade (`SIG_LOOPBACK`, o full-duplex do ESP-IDF).
  - O DAC interno (`I2S_MODE_DAC_BUILT_IN`): o byte alto de cada amostra, o canal direito no DAC1 (GPIO25)
    e o esquerdo no DAC2, cada uma no seu instante (a DMA lê à frente e o Core aplica na hora).
  - O ADC interno (`I2S_MODE_ADC_BUILT_IN`): o `APB_CTRL`, onde fica o controlador digital do SAR ADC, era
    um stub também. O Core amostra o pad da tabela de padrões em cada instante de amostra e o QEMU converte
    (a mesma função de transferência do `adc1_get_raw`), no formato do chip.
  - O APLL: o ESP-IDF o configura pelo I2C analógico (bloco 0x6D). O stub devolvia o comando e o
    `rtc_clk_apll_coeff_set()` esperava a calibração para sempre; agora os coeficientes dão a frequência.
- **eFuse (23).** Sem imagem, o chip dizia revisão 0 e o ESP-IDF rodava os contornos do rev 0 (o APLL sem
  a parte fracionária); agora tem os fusíveis de fábrica de um ESP32-D0WD-V3 (o ECO3 do `APB_CTRL_DATE`).
  Com isso entra o tratador do ECO3 para o watchdog de interrupção (primeiro estágio em 20 ms, as duas CPUs
  no tratador): o firmware do `cache_wait_e2e`, que prende a CPU1 de propósito por dezenas de ms, agora
  alimenta o TG1 enquanto a segura, como precisaria num chip ECO3.
- **I2C escravo (12).** O motor no Core vê SCL e SDA nos pads: START/STOP, o endereço, o ACK, os bytes
  recebidos e os da FIFO de TX nas descidas de SCL depois do `SDA_HOLD`; o ESP32 original não estica o
  clock. O QEMU guarda as FIFOs e as interrupções (`RXFIFO_FULL`, `TXFIFO_EMPTY`, `TRANS_COMPLETE`) e o
  `STATUS` (`SLAVE_RW`, `SCL_MAIN_STATE_LAST`) que o escravo do Arduino lê. O `I2C_CTR` sai do reset em
  0x3 (escravo), como no chip.

## O que mudou no lote 0026

- **Clock da CPU (13).** O `APB_CTRL_SYSCLK_CONF.PRE_DIV_CNT` divide o XTAL e o RC_FAST: o
  `setCpuFrequencyMhz(20)` e o `(10)` ficavam em 40 MHz. O APLL também serve de fonte da CPU
  (`CPUPERIOD_SEL` 0: APLL/4, 1: APLL/2, APB = CPU/2).
- **O APB no Core.** O adaptador contava tudo em 80 MHz de APB. Agora o QEMU informa o APB a cada troca e o
  LEDC (os timers no APB continuam a contagem no ritmo novo), o filtro do PCNT, a captura do MCPWM, o TQ do
  TWAI, o período do SCL do I2C e o bit das UARTs no APB (`TICK_REF_ALWAYS_ON`) seguem o de agora. A UART faz
  a mesma conta inteira dos dois lados com o divisor (`1e9 / ((APB << 4) / CLKDIV)`), então o fio continua
  exato. Como no chip, o Arduino 2.0 não reajusta a UART nem o LEDC numa troca: o sketch o faz.
- O I2C mandava o período ao Core depois de guardá-lo: uma escrita repetida pelo lockstep não o mandava de
  novo.

## O que mudou no lote 0029

- **DAC CW (8).** QEMU encaminha `SENS_SAR_DAC_CTRL1/2` ao adaptador antes de guardar os valores do guest, respeitando replay do VNEXT_B. O adaptador calcula o cosseno com RTC8M e `FSTEP`, seleção por canal, escala, offset DC, fase e os quatro modos de inversão de bits, e entrega a saída analógica aos DAC1/2. `mcu_dac_cw` configura ambos canais a 1 kHz com fase oposta e mede via ADC1; valida amplitude e correlação cruzada negativa. O limite de corrente específico do DAC continua sem modelo: o material consultado de ESP-IDF 4.4 e datasheet não especifica um clamp do DAC.
- **Item 17, Core.** A folga de pares do lockstep passa de 1 para 10 us. `mcu_twai_bus` cai de 13 para 5 s; `mcu_i2c_slave` segue em 152 s. 100 us e 1 ms falharam com erros de barramento e foram rejeitados.
- **SPI MISO, item 1b.** A ABI do device fornece troca MISO/MOSI por byte para `logic.shift_reg`; o par Core inclui clock, MOSI, MISO e os nós MISO. O adaptador só omite as bordas quando todos os pinos q0-q7 ficam sem instrumento ou outra carga observadora; caso contrário continua no modo elétrico bit a bit.

## Medido (0029)

- QEMU `8C8502DB`. Bateria externa final: 42/42 passaram, um por vez; scheduler 91 s, I2C escravo 152 s, SPI MISO 9 s. `mcu_dac_cw`, `mcu_dac`, `mcu_i2s_dac`, `mcu_spi_byte` e `mcu_spi_miso` passaram.
- SPI MISO: byte mode, 54.528 bytes certos e 2.859 ms simulados em 8.010 ms de parede; bit a bit forçado, 10.560 bytes certos e 571 ms simulados em 8.003 ms. Aproximadamente 5x mais taxa simulada.
- Checagem II1P06 com 8 sessões: A 0,999x-1,000x; B todas em 1,000x; C 0,973x-1,003x. Todas tiveram 22-23 linhas corretas de LCD/PCD.

## O que mudou no lote 0028

- **Light sleep (6b).** O QEMU publica o gate digital antes de parar os guests e restaura o clock do Core antes de soltá-los, com retry se a lane estiver cheia. O adaptador pausa os prazos dos periféricos no APB/REF_TICK (UART, I2C, SPI, PCNT, MCPWM, RMT e TWAI) e os timers LEDC correspondentes; no despertar desloca as épocas e prazos pelo tempo dormido. LEDC de baixa velocidade no RTC8M continua apenas quando `CK8M_FORCE_PU` indica que o IDF manteve esse clock ligado.
- `mcu_light_sleep_periph` configura LEDC no APB e no RTC8M, os liga a duas unidades PCNT e mede 50 ms de light sleep. Os contadores PCNT ficam estáveis dentro de duas bordas na janela do despertar. A continuação da saída RTC8M durante o sono não é observada diretamente por este teste.

## Medido (0028)

- QEMU `55D1F3461999`. Bateria externa: 41/41 passaram, um por vez; `mcu_scheduler_pacing_sync_real_qemu` levou 91 s e `mcu_i2c_slave` 152 s. `mcu_light_sleep` e `mcu_light_sleep_periph` passaram.
- Checagem II1P06 com 8 sessões: rodada A 8/8 em 1,000x; rodada B seis em 1,000x, uma em 0,995x e uma em 1,022x; rodada C 8/8 em 1,000x. Todas tiveram 22-23 linhas corretas de LCD/PCD.

## O que mudou no lote 0027

- **RMT RX (3b).** O QEMU recebe a configuração de cada canal e encaminha os itens da RAM RX ao Core. O adaptador filtra em ciclos APB, aplica `IDLE_THRES` e entrega eventos no instante previsto; o Core desperta pelo vencimento rígido do RMT. No `CONF1`, `RX_EN` é o bit 1 e `MEM_WR_RST` o bit 2, como no TRM.
- O ESP32 original não tem demodulação de portadora no RX nem ping-pong (recursos que só existem do S2 em diante). O tick de RX é arredondado ao mais próximo; a fase do contador não é modelada.

## Medido (0027)

- QEMU `F59B3C15`. Bateria externa: 40 de 40 testes passaram, um por vez; `mcu_rmt_rx` levou 2 s e `mcu_i2c_slave` 153 s.
  - `mcu_rmt_rx`: `RMTRX n=12`, dez pulsos `1:100/0:200`, o pulso de 1 us removido pelo filtro de 100 ciclos, `1:101/0:100` e o fim `1:300/0:0`.
- Projeto II1P06, 8 sessões simultâneas por rodada, três rodadas: todas as 24 sessões ficaram entre 1,000x e 1,005x; todas tiveram 22 ou 23 linhas LCD/PCD corretas.

## Medido (0026)

- QEMU `62193BC1`. Bateria do QEMU externo, um teste por vez: 37 de 39 na rodada; o `esp32_adapter`
  (hermético, sem QEMU) passou a informar o APB de 80 MHz antes das contas do LEDC e passou; o
  `mcu_scheduler_pacing_sync_real_qemu` teve um intervalo de 12,5 s do Scheduler uma vez e passou nas duas
  rodadas seguintes neste binário e numa no `5B26C905`.
  - `mcu_cpu_freq`: 240/160/80 MHz no PLL e 40/20/10 MHz no XTAL dividido; `getCpuFrequencyMhz` e
    `getApbFrequency` certos; o CCOUNT a 240/160/80/40/19/10 por us; o LEDC de 1 kHz configurado de novo
    entre 996 e 1002 us.
- Projeto da aula II1P06 com 8 sessões: na terceira rodada 7 a 1,000x e uma a 1,025x (recuperando); as duas
  primeiras, logo depois dos testes, 0,967x a 1,006x e 0,977x a 1,030x.

## Medido (0025)

- QEMU `5B26C905`. Bateria do QEMU externo, um teste por vez: 38 de 38. Os novos testes:
  - `mcu_i2s`: o `I2S_EVENT_TX_DONE` de 441 quadros a cada 10000 us a 44,1 kHz, 55125 us a 8 kHz e
    10000 us com `use_apll`; um segundo de `i2s_write` em 1,000004 s; 1600 amostras de RX em 100000 us,
    todas iguais ao nível do DIN em alto e em baixo.
  - `mcu_i2s_dac`: o par estéreo em 828/2485 mV e trocado; uma quadrada 0/255 a cada 19999 us (20000); o
    `dacWrite` depois do `i2s_driver_uninstall`, 1294 mV.
  - `mcu_i2s_adc`: o código do I2S, 1879, igual ao do `adc1_get_raw`, com o canal certo nas 1000 amostras;
    uma quadrada de 1 kHz a 20 kHz: 200 subidas a 20,00 amostras uma da outra, 2000 de 4000 em alto, 4000
    amostras em 200000 us.
  - `mcu_i2c_slave` (dois ESP32): as três escritas com ACK, o escravo recebe hi0..hi2, as leituras trazem
    ABCD, EFGH e IJKL.
  - `cache_wait_e2e_real_qemu` passa com o firmware alimentando o TG1 (ver 23).
- Projeto da aula II1P06 com 8 sessões ao mesmo tempo: na terceira rodada 8 de 8 a 1,000x com as 23 linhas
  do LCD; na segunda 7 a 1,000x e uma a 0,981x; a primeira, logo depois da bateria, 0,951x a 0,992x.

## Medido (0024)

- QEMU `8864A0CA`. Bateria do QEMU externo, um teste por vez: 34 de 34. Os novos testes:
  - `mcu_touch`: pad solto 70, com 100 pF 11, com 470 pF 2 (a medição do Arduino), o dobro da medição
    dá o dobro, a interrupção e o despertar do deep sleep pelo T3 (causa 5).
  - `mcu_dac`: códigos 64/128/192 no DAC1 dão 828/1656/2485 mV no ADC; o DAC2 em 200 com 1 kΩ ao GND,
    2537 mV; o GPIO de RTC dirige o pad no lugar da saída digital.
  - `mcu_uart_format` (UART2 -> UART1, driver do ESP-IDF): 32 bytes em cada formato, todos certos, no tempo
    do quadro mais ~13 µs da chamada (8N1 2790 µs, 8E1 3069, 7O1 2789, 8N2 3069, 8N1.5 2930, 6E2 2789,
    5N1 1955); 8E1 lido em 8O1 dá 4 erros de paridade em 4 bytes; um 0x01 a 57600 lido a 115200 chega
    0x06 com erro de quadro; um 0x00, break; o break de 100 bits volta em 969 µs (110 bits são 955).
- Projeto da aula II1P06 com 8 sessões ao mesmo tempo: 8 de 8 entre 1,000x e 1,002x do tempo real, com as
  23 linhas do LCD certas.

## Medido (0023)

- QEMU `512C581F`. Bateria do QEMU externo, um teste por vez: 31 de 31. Os novos testes:
  - `mcu_spi_modes`: os quatro modos, 9 bits, fases do IDF, a interrupção e 5000 bytes por DMA.
  - `mcu_soc_reset`, em três boots:
    - o reset de CPU mantém o PCNT (19 -> 106) e o PWM;
    - o `periph_module_reset()` zera o PCNT e para o LEDC;
    - o reset de sistema reinicia os dois.
  - `mcu_deep_sleep`: timer (361 ms de RTC com o boot), ext0 e ext1 (status no GPIO33).
  - `mcu_light_sleep`: o `esp_timer` mede 199 ms num sono de 200 ms; o CCOUNT e o TIMG contam só o
    tempo acordado em volta (menos de 1,2 ms).
- `mcu_twai_bus` em 13 s; levava ~150 s, a maior parte esperando o eFuse.
- Projeto da aula II1P06 com 8 sessões ao mesmo tempo: 8 de 8 entre 0,993x e 1,014x do tempo real, com
  todas as amostras do LCD certas.

## Medido (0022)

- Bateria do QEMU externo, um teste por vez: 28 de 28. Os novos testes:
  - `mcu_spi_miso`: 17 184 bytes.
  - `mcu_adc`: 80 leituras e 20 `analogReadMilliVolts`.
  - `mcu_rmt`: WS2812 e IR.
  - `mcu_pcnt`.
  - `mcu_mcpwm`: PWM complementar com 2 us de dead time, medido exato pela captura.
  - `mcu_twai`: cinco quadros decodificados do fio pela captura do MCPWM, com CRC, stuffing e cada borda
    na grade de 8 us. Sem ACK, o TEC para em 128.
  - `mcu_twai_bus`: dois ESP32 com ACK, respostas e arbitragem. 0x050 ganha de 0x060, o perdedor recebe o
    vencedor e transmite depois, com 0 erros de barramento.
- Projeto da aula II1P06 com 8 sessões ao mesmo tempo: 8 de 8 entre 1,000x e 1,019x do tempo real, com
  as 23 linhas do display em cada uma.

## Achado novo: dois MCUs na mesma sessão (17)

Com dois ESP32 no mesmo circuito, cada guest só podia passar 1 us (`kLockstepPeerLookaheadNs`) da posição
provada do outro. O candidato Core 0029 elevou a folga para 10 us: `mcu_twai_bus` passou de 13 s para
5 s de parede; `mcu_i2c_slave` permaneceu em 152 s. Tentativas a 100 us passaram uma vez e falharam na
repetição do TWAI (REC=44, `bus_errors=1`); a 1 ms falhou (REC=53, `bus_errors=1`), então foram
rejeitadas. A bateria do candidato 10 us passou 42/42 e a checagem da turma manteve 22-23 linhas corretas;
a melhoria é parcial e workloads multi-MCU ainda podem ficar abaixo do tempo real.
