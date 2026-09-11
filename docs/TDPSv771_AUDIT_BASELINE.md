# TDPSv771 — baseline da auditoria

Este documento registra a primeira coleta verificável da auditoria do diretório
`C:\SourceCode\TDPSv771`. Ele não declara a migração concluída: as equações,
estados e resultados de referência ainda precisam ser extraídos de cada modelo.

## Fontes encontradas

O pacote contém o executável `TDPS771.exe` e exemplos `.smp` (texto estruturado),
`.txd` (diagramas/dados de desempenho) e imagens de referência. Foram encontrados
25 arquivos `.smp`:

| Família | Arquivos |
|---|---|
| Vazão/processo | `basic flow loop.smp`, `course-fine flow loop.smp`, `header pressure with 3 consumers.smp`, `nonlinear flow processes.smp`, `4processes.smp` |
| Temperatura/energia | `furnace.smp` (2 diretórios), `furnace masterslave/furnace.smp`, `boiler.smp`, `Industrial Boiler.smp`, `heat exchanger.smp`, `coolingplant.smp`, `combustion.smp` (cl/dcl/ratio), `combustion2fuels.smp`, `ethaneplant.smp` |
| Nível/reator | `regulatory level.smp`, `surge tank.smp`, `reactor.smp` |
| Controle/identificação | `frequencyresponse.smp`, `smithpredictor.smp`, `splitrange.smp`, `linearized pH control` (`pHcontrol.smp` e `Linearized pH control.smp`) |
| Coleção | `4processes.smp` |

Os nomes são apenas classificação inicial; a decomposição final deve ser feita
por leitura dos registros e equações, não pelo nome do arquivo.

## Infraestrutura já existente no LasecSimul

- `SignalEngine` já fornece kernels e runtime para soma, produto, ganho,
  saturação, expressões, integradores, atrasos, primeira/segunda ordem,
  lead-lag, FOPDT, tanque, rate limiter, histerese, stiction e PID.
- `ProcessSubcircuitCompiler` já converte parte do schema de processo para o
  `SignalGraphDefinition` e o `SignalRuntime`.
- `.lsdevice` permanece o formato de dispositivo/primitivo existente. Quando o
  usuário combinar blocos primitivos em um bloco composto, o formato correto é
  `.lssubcircuit`; catálogo e Property Inspector devem suportar ambos sem criar
  uma arquitetura Ctrl/TDPS paralela.
- O motor de expressões agora é exposto pelo Core como `SignalExpression`, usado
  pelo HART e pelo `control.calc_expression`, mantendo uma única gramática.

## Regras de trabalho

1. Cada modelo será inventariado com entradas, saídas, parâmetros, estados,
   equações, inicialização, discretização e referência numérica.
2. Um kernel novo só será criado quando a matemática do TDPS exigir uma operação
   que não possa ser composta pelos kernels existentes ou quando a composição
   violar desempenho/estabilidade mensurável.
3. Blocos/dispositivos primitivos usam `.lsdevice`; composições hierárquicas usam
   `.lssubcircuit`; kernels permanecem internos ao Core.
   permanecem internos ao Core.
4. A hierarquia será resolvida no compile/PlanCompiler e achatada para o hot path;
   nenhuma busca por nome ou travessia de `.lsdevice`/`.lssubcircuit` ocorrerá por tick.
5. Nenhuma planta será declarada validada sem golden output e comparação numérica
   objetiva.

## Estado

`BASELINE_AUDITED_PARTIAL`: fontes localizadas e infraestrutura existente
identificada. A próxima coleta deve parsear os `.smp` e `.txd`, extrair as
operações efetivamente usadas e produzir a matriz TDPS → `.lssubcircuit` →
kernel, registrando `.lsdevice` quando o item for primitivo.
