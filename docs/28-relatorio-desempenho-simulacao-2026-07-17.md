# Relatório de desempenho da simulação — 2026-07-17

## Resultado

O travamento principal, a falha `3221225477`, o acoplamento entre telemetria e renderização e os
hot paths mais caros do scheduler/MNA/MCU foram corrigidos sem remover dispositivos ou recursos.
Todos os 45 testes do Core e toda a suíte TypeScript passaram em Release. O teste integrado também
iniciou e parou o QEMU real usando exatamente o `merged.bin` informado, inclusive com espaços e
caracteres UTF-8 no caminho.

A comparação executável com o SimulIDE não faz parte desta rodada por solicitação posterior do
usuário ("pode deixar que eu audito"). Consequentemente este documento não afirma, sem medição, que
o LasecSimul superou o SimulIDE. O runner agora permite repetir essa comparação sob as mesmas
condições.

## 1. Causas raiz

### Falha do Core `3221225477`

No Windows, `3221225477` é `0xC0000005`, violação de acesso. A conversão UTF-8/UTF-16 em
`QemuProcessManager::widen()` perguntava ao Windows o tamanho incluindo o NUL, alocava `size - 1`
caracteres e mandava `MultiByteToWideChar()` escrever `size`. Era uma escrita de um `wchar_t` após o
fim do buffer. O caminho do firmware informado, com espaços e caracteres não ASCII, exercitava esse
caminho ao montar a linha de comando do QEMU.

A conversão agora valida UTF-8, reserva o tamanho completo, verifica a segunda conversão e remove o
NUL somente depois da escrita. Há teste de regressão com argumentos UTF-8 e espaços e teste integrado
com o firmware real.

### Interface congelada e comando Parar congestionado

O problema era composto:

- o scheduler podia permanecer no ciclo de convergência segurando o ownership da simulação, sem
  observar o pedido de parada entre iterações;
- leituras de telemetria disputavam o mesmo lock e podiam esperar em vez de falhar rapidamente;
- o Extension Host iniciava novas rodadas de leitura mesmo com a anterior ainda em trânsito;
- estados de componentes, fios e tempo eram pedidos em operações sequenciais;
- cada atualização de leitura ou porta serial podia redesenhar o esquemático inteiro;
- instrumentos transferiam histórico completo no caminho visual comum;
- temporizadores de serial/LasecPlot continuavam acordando sem endpoint ativo;
- o MCU era consultado por polling e cada consulta podia sujar novamente o circuito, provocando
  restamp/fatoração MNA mesmo sem mudança elétrica.

O caminho de parada agora cancela primeiro a produção visual, incrementa uma geração que invalida
respostas atrasadas e envia o controle sem depender de a fila visual drenar. No Core, o pedido de
parada é observado dentro do settle loop. Telemetria usa `trySynchronized`: se o Core estiver
ocupado, o frame visual é coalescido, nunca bloqueia controle nem altera estado essencial.

### Velocidade indicada em aproximadamente 7%

Não existe um multiplicador constante de 7% nem erro de unidade na razão de tempo. No caso real
`blinkLed.lsproj`/`merged.bin`, havia duas causas mensuradas. Primeiro, a extensão procurava
`core/build/Debug/lasecsimul-core.exe` antes de `Release`; como as duas configurações existiam, ela
executava um Core Debug antigo e não o Release recém-corrigido. Segundo, o MCU era restampado por
cada wakeup/bit da UART, mesmo sem mudança elétrica. Em 5 s isso produziu 347.240 stamps e consumiu
3,520 s em dispositivos, contra somente 10,1 ms no solver MNA. Logo, o LED/resistor e o solver não
eram o gargalo deste circuito.

O resolver agora prefere Release/RelWithDebInfo e usa Debug somente como fallback, com regressão
automatizada. O scheduler assíncrono percorre o mesmo `runUntil` do modo determinístico. Para QEMU,
o Core agenda o timestamp virtual publicado, drena ações do mesmo instante e só pede nova solução
MNA quando a impressão digital das saídas elétricas muda.

## 2. Arquitetura de threads verificada

| Thread/processo | Responsabilidade após a correção |
|---|---|
| Extension Host (Node/VS Code) | comandos, ciclo de vida, batching e backpressure; não executa solver |
| Webview | eventos DOM e renderização incremental dos elementos afetados |
| Core/IPC | recebe e despacha requisições; métricas opcionais de parse/handler/serialização |
| writer de notificações IPC | escoa notificações sem bloquear a simulação; fila é medida |
| worker do Scheduler | relógio virtual, eventos, dirty set, settle e passos transitórios |
| pool MNA persistente | resolve grupos elétricos independentes em paralelo |
| thread chamadora do MNA | participa do lote, evitando um núcleo extra ocioso/sobrescrito |
| leitor do processo QEMU | captura saída e ciclo de vida do processo emulado |
| processo QEMU por MCU | CPU e periféricos emulados; comunica por arena compartilhada |

Na máquina medida (`Ryzen 5 PRO 5650G`, 6 núcleos/12 threads), `solverThreads=12`. O pool cria
`hardware_concurrency - 1` workers e a thread chamadora participa. O número não é fixado no código.
O benchmark de oito ilhas de 256 incógnitas mediu `3,85x` de ganho (29,627 ms serial contra
7,701 ms no pool), demonstrando paralelismo efetivo. Cargas pequenas continuam seriais quando o
custo de sincronização seria maior; 32 grupos de 48 incógnitas mediram 1,02x.

## 3. Alterações arquiteturais e otimizações

### Scheduler e controle

- parada cooperativa é verificada dentro da convergência;
- pausa/parada não esperam uma leitura de telemetria congestionada;
- execução assíncrona avança circuitos sem eventos agendados;
- eventos de mesmo timestamp continuam ordenados pelo sequence number;
- parada/pausa também são observadas entre eventos do mesmo timestamp, impedindo starvation de
  controle por um produtor externo;
- `sleep_until` usa o início do ciclo e o passo alvo, sem delay corretivo arbitrário;
- reinícios reutilizam corretamente o ciclo de vida e limpam eventos pendentes.

### ESP32/QEMU — princípio verificado no SimulIDE

Foi inspecionado o fonte local `C:\SourceCode\simulide_2`. Em `QemuDevice::runEvent()`, o SimulIDE
aguarda o QEMU publicar `arena->simuTime`, processa todas as ações cujo timestamp é o tempo atual e
usa `Simulator::addEventAt(nextTime, this)` somente quando encontra uma ação futura. No lado QEMU,
`simuliface.c` publica o tempo vindo de `icount_get_ns()` e faz o handshake pela arena. A interface
é independente: timer de atualização de 50 ms e animação lógica em frequência visual própria.

O LasecSimul agora aplica esse princípio sem copiar código: origem de tempo por carga de firmware,
conversão ps→ns com arredondamento, agendamento exato, batching no mesmo timestamp e ownership do
handshake no worker do Scheduler. Wakeups internos dos módulos são executados no próprio evento e
só marcam o MCU dirty quando saída/habilitação de pino muda. O cache pino→módulo elimina a busca
linear repetida por todos os módulos nos 43 pinos do ESP32.

### Solver MNA

- resolução componente/grupo/pino é cacheada quando a topologia é reconstruída;
- o vetor de componentes estampados é reutilizado entre iterações;
- matrizes escaladas, RHS e solução usam buffers persistentes;
- a escala é aplicada diretamente, sem matrizes diagonais temporárias;
- foi removida a segunda fatoração cúbica `FullPivLU`; o `PartialPivLU` usado na solução também
  fornece a estimativa de condicionamento;
- o pool publica um lote com índice atômico, sem `std::function` e lock de fila por grupo;
- o limite artificial de 16 threads foi removido; a capacidade vem do hardware.

O resultado numérico denso/esparso continuou com diferença máxima observada de `2,84e-14`; pool e
serial produziram checksum idêntico.

### IPC, telemetria e Webview

- estados de vários componentes e tensões de fios são capturados em lote sob uma única tentativa de
  lock;
- escopo e analisador lógico expõem um snapshot visual compacto (valores atuais); a API de histórico
  completo continua disponível para a janela do instrumento;
- há no máximo um frame visual em trânsito e uma leitura de histórico por instrumento;
- leituras independentes são executadas em paralelo com `Promise.allSettled`;
- frequência visual é configuração declarativa (`lasecsimul.simulation.telemetryRateHz`) e não é a
  frequência interna do solver;
- atualizações de valor, fio e estado serial alteram somente o SVG/componente afetado;
- frames visuais obsoletos são descartáveis; estado da simulação, UART e comandos não são;
- timers de Serial Terminal, Serial Port e LasecPlot só existem enquanto há consumidor ativo;
- métricas IPC medem bytes, requisições/notificações, parse, handler, serialização e profundidade
  atual/máxima da fila.

### MCU/QEMU

- correção do overflow UTF-16 que derrubava o Core;
- callbacks usam estado compartilhado com `weak_ptr`, evitando acesso ao componente destruído;
- leitura de estado público é protegida;
- detecção de mudança elétrica usa fingerprint FNV sem alocar dois vetores por poll;
- no máximo um poll futuro fica agendado, inclusive após vários stop/reload;
- GPIO sem alteração não força solução analógica;
- UART continua em lotes e todos os caminhos ABI/QEMU existentes foram preservados.

## 4. Instrumentação de baixo custo

A configuração `lasecsimul.simulation.performanceProfiling` é `false` por padrão. Quando ligada, os
comandos IPC `resetPerformanceMetrics` e `getPerformanceMetrics` retornam:

- tempo simulado, passos, eventos e iterações de settle;
- stamps, chamadas/tempo do solver e tempo dos dispositivos;
- rebuilds/tempo de topologia e passos transitórios aceitos/rejeitados;
- eventos pendentes e threads do solver;
- requisições/notificações IPC, bytes, parse, handler, serialização e fila de notificações.

Cronometragem detalhada só ocorre quando o profiling está ativo. O script
`scripts/benchmark-simulation.ps1` complementa com CPU do processo, CPU acumulada por thread, pico de
memória e pico de threads.

## 5. Evidências e comparação antes/depois

Medição Release em 2026-07-17, Windows, Ryzen 5 PRO 5650G (6C/12T), 7,4 GiB visíveis. Cada cenário
simulou 10 ms; `units` é a escala do fixture sintético.

| Cenário | Escala | Inicialização | Tempo real | Velocidade | Eventos | Stamps | Solver | Dispositivos |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
| vazio | 0 | 0,348 ms | 0,011 ms | 877,19x | 0 | 0 | 0 ms | 0 ms |
| passivo | 1 | 0,355 ms | 0,063 ms | 159,24x | 0 | 5 | 0,021 ms | 0,004 ms |
| RC analógico | 1 | 0,288 ms | 0,368 ms | 27,20x | 0 | 751 | 0,205 ms | 0,094 ms |
| digital | 1 | 0,308 ms | 0,162 ms | 61,88x | 200 | 603 | 0,025 ms | 0,059 ms |
| instrumentos | 1 | 0,253 ms | 0,713 ms | 14,03x | 200 | 804 | 0,026 ms | 0,142 ms |
| passivo | 100 | 1,046 ms | 1,047 ms | 9,55x | 0 | 500 | 0,173 ms | 0,291 ms |
| RC analógico | 100 | 1,240 ms | 35,129 ms | 0,285x | 0 | 75.100 | 21,724 ms | 11,229 ms |
| digital | 100 | 0,974 ms | 9,467 ms | 1,056x | 20.000 | 60.300 | 0,975 ms | 5,135 ms |

O fixture de instrumentos é mantido em uma unidade porque mede o custo de um instrumento com fluxo
realista, e não cem telas abertas. Em uma execução externa de 100 ms/escala 100, o runner mediu pico
de 5,48 MiB, 15 threads e fila digital estável em 100 eventos (um próximo evento por clock), sem
crescimento por passo.

No hot path de refatoração:

| Medida | Antes | Depois | Mudança |
|---|---:|---:|---:|
| 8 grupos 256, serial | 40,264 ms | 29,627 ms | -26,4% nesta execução |
| 8 grupos 256, pool | 16,413 ms | 7,701 ms | -53,1% |
| ganho do pool | 2,45x | 3,85x | paralelismo maior |
| fatoração 256 densa/esparsa | 7,60x | 12,48x | menor custo esparso |

As execuções não são uma comparação estatística multi-máquina, mas usam o mesmo binário Release,
fixture e host. O smoke test exige objetivamente velocidade >= 1x para todos os cenários simples.

### Montagem real ESP32 do laboratório

Fixture exato:

- projeto `blinkLed.lsproj`, firmware `merged.bin` (4 MiB), ESP32 DevKitC V4;
- LED + 1 kΩ no GPIO34 e LasecPlot na UART;
- paths fornecidos pelo usuário, incluindo espaços; QEMU `-icount shift=4,align=off,sleep=off`;
- polling UART do LasecPlot a cada 10 ms para incluir o consumidor real.

| Medida | Antes | Depois |
|---|---:|---:|
| janela com profiling | 5 s | 10 s |
| razão média, incluindo boot | 0,657x | 1,089x |
| razão após boot | irregular e abaixo da meta | 1,66x–2,22x no trecho estável |
| tempo simulado | 2,863 s | 11,096 s |
| stamps de componentes | 347.240 | 72 |
| tempo em dispositivos | 3.519,8 ms | 0,103 ms |
| chamadas do solver | 347.172 | 4 |
| tempo do solver | 10,07 ms | 0,083 ms |
| eventos processados | 375.803 | 223.717 |
| fila pendente ao final | 1 | 1 |
| latência de parada | 15,0 ms | 0,43 ms |

Uma segunda execução de 20 s com profiling desligado simulou 31,831 s, média integral de 1,588x,
trecho estável aproximadamente 1,44x–2,46x e parada em 0,286 ms. O início ainda contém o boot real
do ESP32/QEMU: durante cerca do primeiro segundo real não há avanço publicado e, nos segundos
seguintes, ROM/flash inicializam abaixo de 1x. Isso não é limitação permanente; depois do boot o
circuito acompanha e supera o tempo real.

Após o diagnóstico de uso interativo, a Extension passou a configurar `realTimeRate=1` por padrão.
Na mesma montagem, a taxa após o boot ficou entre 0,968x e 1,030x (amostras de 250 ms), sem a fase
de recuperação a 200%; parada em 0,301 ms. `realTimeRate=0` preserva o modo ilimitado usado pelos
benchmarks acima, e valores como 0,5/2 permitem câmera lenta/aceleração explícita. O pacing acumula
tempo virtual conforme a granularidade medida do scheduler do SO; não altera passo, precisão ou
eventos QEMU.

O firmware fornecido declara `LED_PIN = 34`. No ESP32, GPIO34–39 são somente entrada; o próprio
adaptador (`Esp32Adapter.cpp`) ignora habilitação de saída nesses bits. Portanto esse firmware não
pisca o LED no simulador nem em hardware real. Para observar o Blink, circuito e firmware precisam
usar juntos um GPIO com capacidade de saída, por exemplo um dos GPIO32/33/25/26/27 disponíveis na
placa, e o binário deve ser recompilado.

## 6. Testes de regressão e resultados

- 45/45 testes CTest passaram, incluindo CoreBootstrap, solver, transientes, dispositivos, plugins,
  ESP32, arena QEMU, QEMU real, watchdog e benchmark smoke;
- suíte completa `npm test` passou, incluindo compilação do Extension Host e Webview;
- 100 ciclos de start/stop verificam avanço e fila vazia após cada parada;
- settle deliberadamente não convergente verifica telemetria não bloqueante em menos de 50 ms e
  parada em menos de 1 s;
- 25 ciclos de stop/reload sintético de MCU verificam que a fila não cresce além de um poll;
- teste UTF-8/espaços cobre a violação de acesso;
- teste QEMU real com `LASECSIMUL_TEST_FIRMWARE` iniciou, permaneceu vivo e encerrou usando o
  `merged.bin` informado;
- testes de checksum, RC/RLC, LU e medidores confirmam preservação numérica/funcional.

## 7. Compatibilidade e subsistemas impactados

- dispositivos built-in: contrato preservado;
- ABI nativa: `getTelemetryState` possui implementação padrão que delega ao estado antigo;
- osciloscópio/analisador: snapshot visual compacto, histórico completo preservado;
- Arduino/AVR: contratos MCU e UART preservados; não havia firmware AVR equivalente fornecido para
  um ensaio integrado nesta rodada;
- ESP32/QEMU: caminho real validado com firmware do usuário;
- Serial Terminal, Serial Port e LasecPlot: mesmos dados e comandos, timers apenas sob demanda;
- determinismo: desempate de eventos e resultados serial/pool preservados.

Nenhuma funcionalidade foi removida e não foi introduzido delay para esconder carga.

## 8. Arquivos principais modificados

- Core: `Scheduler.*`, `ThreadPool.hpp`, `CircuitGroup.hpp`, `Netlist.hpp`, `SimulationSession.*`,
  `IpcServer.*`, `CoreApplication.cpp` e `IComponentModel.hpp`;
- MCU/QEMU: `McuComponent.*`, `QemuProcessManager.cpp`, `QemuModuleProxy.hpp`;
- instrumentos: `Oscope.hpp`, `LogicAnalyzer.hpp`;
- extensão/Webview: `coreLifecycle.ts`, `coreExecutable.ts`, `CoreClient.ts`, `main.ts`, managers de
  serial/LasecPlot e `package.json`;
- benchmark: `simulation_performance_benchmark.cpp`, `benchmark-simulation.ps1`,
  `benchmark-real-esp32.mjs`, `CMakeLists.txt`;
- regressões: `SchedulerTest.cpp`, `McuComponentTest.cpp`, `QemuProcessManagerTest.cpp`,
  `McuControllerRealQemuTest.cpp`, testes MNA/medidores relacionados.

## 9. Pendências técnicas reais

1. A estratégia de sincronização do fonte local do SimulIDE foi auditada e aplicada como princípio,
   mas a comparação direta dos dois executáveis continua reservada ao auditor conforme orientação
   do usuário. Portanto, não se afirma superioridade global sem essa medição pareada.
2. O fixture RC com 100 unidades e passo/precisão atuais mediu 0,285x em 10 ms. Não afeta a aceitação
   de circuitos simples, mas mostra que o próximo ganho relevante está em reduzir stamps de elementos
   analógicos invariantes e explorar fatoração simbólica/numeric dirty tracking mais granular.
3. Falta um teste E2E automatizado que meça frames/reflows dentro do VS Code real; os testes atuais
   comprovam backpressure e atualização incremental no código, não o compositor do Electron.
4. Arduino Uno e um circuito único misto Core+QEMU+UART+instrumento requerem fixtures/firmwares de
   referência controlados. Os subsistemas foram testados separadamente, sem fabricar dados ausentes.
5. Teste de longa duração deve rodar fora do CTest rápido, usando o runner e o projeto real do
   laboratório, para registrar estabilidade térmica e de memória por horas.

## 10. Reprodução

```powershell
cd C:\SourceCode\LasecSimul\core
cmake -S . -B build -DCMAKE_BUILD_TYPE=Release
cmake --build build --config Release -j 4
ctest --test-dir build -C Release --output-on-failure -j 4

cd C:\SourceCode\LasecSimul\extension
npm test

cd C:\SourceCode\LasecSimul
.\core\build\Release\simulation_performance_benchmark.exe --scale 1 --sim-ns 10000000 --profile --require-realtime
.\core\build\Release\simulation_performance_benchmark.exe --scale 100 --sim-ns 10000000 --profile
.\core\build\Release\solver_benchmark.exe
.\scripts\benchmark-simulation.ps1 -Scale 100 -SimulatedNanoseconds 1000000000
```

Teste do firmware real:

```powershell
$env:LASECSIMUL_TEST_FIRMWARE = 'G:\Meu Drive\Josue\02 AulasUFU\01 Aulas_ININD1\Pratica\EININDI01_GitHub_VSCode_PIO\lasecSimul\merged.bin'
ctest --test-dir C:\SourceCode\LasecSimul\core\build -C Release -R mcu_controller_real_qemu --output-on-failure
Remove-Item Env:LASECSIMUL_TEST_FIRMWARE

node C:\SourceCode\LasecSimul\scripts\benchmark-real-esp32.mjs `
  'G:\Meu Drive\Josue\02 AulasUFU\01 Aulas_ININD1\Pratica\EININDI01_GitHub_VSCode_PIO\lasecSimul\blinkLed.lsproj' `
  'G:\Meu Drive\Josue\02 AulasUFU\01 Aulas_ININD1\Pratica\EININDI01_GitHub_VSCode_PIO\lasecSimul\merged.bin' `
  20000 `
  'C:\SourceCode\LasecSimul\core\build\Release\lasecsimul-core.exe' `
  false
```

Para comparar com o SimulIDE, use o mesmo circuito, firmware, passo/precisão e duração, inicie os dois
em processos separados e registre os mesmos campos do runner. A pasta informada para o executável é
`C:\SourceCode\SimulIDE_2-R260501_Win64`.
