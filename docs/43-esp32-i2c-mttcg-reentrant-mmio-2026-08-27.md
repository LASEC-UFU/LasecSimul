# Reentrada MMIO no I2C ESP32 sob MTTCG — 2026-08-27

## Estado do achado

**Causa funcional comprovada; correção em validação.**

Este documento registra o achado da investigação da atualização incorreta do SSD1306. Ele não
reabre a análise já encerrada de jitter host em T3→T4: o defeito descrito aqui é guest-visible e
possui evidência direta de perda/duplicação de dados no controlador virtual.

## Sintoma observado

O firmware real atualiza um framebuffer SSD1306 de 1024 bytes e desloca as linhas longas em um
pixel por quadro. Na simulação, a maioria dos quadros apresenta exatamente esse deslocamento, mas
alguns quadros ficam fragmentados ou combinam regiões de instantes diferentes antes de se
recuperarem.

O oracle de framebuffer encontrou janelas com contagens incompatíveis com uma atualização física
completa:

- quadro esperado: `1024` bytes;
- quadro com uma fatia repetida: `1056` bytes (`1024 + 32`);
- quadro truncado observado: `897` bytes;
- todos os bytes anômalos acima vieram do fast path (`electrical=0`).

Portanto, a corrupção não nasce no renderer do display nem na rasterização do texto. O modelo
SSD1306 está recebendo uma sequência incorreta do controlador I2C virtual.

## Evidência decisiva

Na mesma carga, o QEMU registrou:

```text
qemu-system-xtensa: warning: Blocked re-entrant IO on MemoryRegion: esp32.i2c at addr: 0x38
```

O endereço `0x38` pertence à região MMIO do periférico `esp32.i2c`. A proteção de reentrada do
QEMU detectou uma segunda entrada no mesmo dispositivo enquanto a primeira callback MMIO ainda
estava ativa e rejeitou o acesso. Rejeitar uma escrita real do guest no FIFO/registrador explica
diretamente uma fatia ausente; a alteração concorrente do estado da command-list/FIFO ao redor de
um burst explica também repetição ou consumo da fatia errada.

Artefatos diagnósticos principais:

- `.codex-validation/oled-byte-origin.log`;
- `.codex-validation/oled-duplicate-state-long.log`;
- `.codex-validation/oled-duplicate-qemu-long.log`;
- `.codex-validation/fidelity-frames.log`;
- `.codex-validation/display-frame-analysis.json`.

## Mecanismo causal

O caminho é:

```text
vCPU executa escrita MMIO em esp32.i2c
  → callback monta o burst
  → i2cBurstTransfer() inicia round-trip síncrono com o Core
  → arenaTransactionBegin() solta o BQL durante toda a espera
  → outro vCPU MTTCG entra novamente em esp32.i2c
  → a proteção de MemoryRegion bloqueia o acesso reentrante
  → uma escrita do guest não chega ao FIFO/command-list
  → frame SSD1306 fica truncado, deslocado ou híbrido
```

O mutex da arena serializa o mailbox compartilhado, mas não serializa a `MemoryRegion` I2C depois
que o BQL é solto. Logo, integridade da arena e integridade do dispositivo são problemas distintos.

## Critério físico

### EXPECTED PHYSICAL BEHAVIOR

Uma escrita válida do ESP32 no FIFO/command-list não desaparece porque o outro núcleo executou
enquanto o controlador aguardava a conclusão da transferência. O periférico mantém estado
coerente e apresenta interrupções/FIFO conforme a transação programada.

### SIMULATOR BEHAVIOR

O round-trip host-side soltava a exclusão do dispositivo dentro da própria callback MMIO. Sob
MTTCG, uma segunda entrada era possível e o QEMU precisava rejeitá-la.

### MEASURED/DERIVED DELTA

- acesso MMIO rejeitado: observado diretamente pelo guard do QEMU;
- frame esperado de 1024 bytes: observado;
- frames de 1056 e 897 bytes: observados;
- corrupção visual correspondente: observada nos dumps BMP;
- origem fast path: 100% dos bytes das janelas anômalas medidas.

### EVIDENCE

O aviso de reentrada e as contagens de bytes pertencem ao mesmo workload real. Isso estabelece uma
cadeia causal concreta e substitui hipóteses anteriores de renderer, firmware ou jitter de
scheduling.

### ACTION

Preservar a serialização da `MemoryRegion` durante o round-trip I2C síncrono, sem inverter a ordem
de locks. A implementação candidata faz:

```text
soltar BQL
  → adquirir arenaOrderLock
  → readquirir BQL
  → publicar/aguardar a resposta I2C
  → liberar arenaOrderLock
```

A ordem continua `arena → BQL`, evitando o deadlock que ocorreria ao esperar a arena mantendo o
BQL. A mudança não adiciona thread, worker, polling, handle, processo, buffer permanente ou lock
novo; reutiliza o mutex da arena e o BQL existentes.

## O que não deve ser feito

- não permitir reentrada insegura com `disable_reentrancy_guard`;
- não ignorar o aviso do QEMU;
- não truncar artificialmente o SSD1306 em 1024 bytes para esconder dados extras;
- não publicar apenas quadros “bonitos” no renderer;
- não alterar prioridade, afinidade, pacing, BQL global ou firmware para mascarar o defeito;
- não atribuir este problema à UART sem uma cadeia causal própria.

Essas alternativas esconderiam uma divergência real do controlador virtual e reduziriam a
fidelidade.

## Validação obrigatória antes de encerrar

A correção somente pode ser considerada fechada após execução real prolongada demonstrar:

- avisos `Blocked re-entrant IO on MemoryRegion: esp32.i2c` = `0`;
- frames completos com bytes diferentes de `1024` = `0`;
- fatias FIFO repetidas ou perdidas = `0`;
- corrupção visual = `0`;
- ACK inválido e Guru Meditation = `0`;
- comportamento de marquee: deslocamento esperado e recuperação artificial = `0`;
- UART byte a byte permanece exata;
- taxa de simulação e custo por sessão não apresentam regressão material;
- threads/processos/handles/periodic wakes adicionais = `0`.

Até esses critérios passarem, o estado permanece **correção candidata em validação**, e não
“problema resolvido”.

## Relação com o problema serial

O benchmark direto já mostrou igualdade byte a byte entre a UART drenada pelo Core e o endpoint
consumido pelo LasecPlot. A captura visual também mostrou `Not connected` e o log do broker mostrou
`clientes=0`; portanto, o defeito serial visível possui atualmente uma fronteira de conexão/cliente
distinta. A correção I2C deste documento não deve ser apresentada como correção da UART.
