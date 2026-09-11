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

Os kernels necessários também estão publicados como 24 subcircuitos reutilizáveis em
`subcircuits/control_*.lssubcircuit` (PID, ganho, soma, produto, integrador, derivada filtrada,
atraso unitário/tempo morto, primeira/segunda ordem, lead-lag, FOPDT, função de transferência,
tanque, característica de válvula, saturação/limitador, banda morta, histerese, stiction e
limitador de taxa). Todos são registrados em `subcircuits/library.json` e compilados pelo Core para
os `SignalBlockKind` correspondentes do mesmo `SignalEngine`.

### Referência visual das plantas

Os dez `.lssubcircuit` TDPS convertidos usam o `screen.bmp` completo do exemplo correspondente
como referência, convertido uma vez para PNG otimizado em `subcircuits/tdps-reference-images/` e
declarado como `symbol.background`. As imagens são embutidas pelo sanitizador como
`data:image/png;base64`, portanto continuam funcionando no
VSIX sem depender do caminho `C:\SourceCode\TDPSv771`. A imagem é somente visual: a funcionalidade
continua em `components[]`, `topology` e no SignalEngine. Componentes internos não-túnel são
referenciados por ID em `exposedComponents[]`, permitindo sua projeção/externação sem copiar estado
ou propriedades. `scripts/apply-tdps-reference-symbols.mjs` reaplica essa associação a cada geração.

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

## Evidência pré-existente reaproveitada

A especificação alinhada em `C:\SourceCode\lasecsimul-spec-tdps-repo-aligned\.spec`
já contém decisões e fixtures diretamente aplicáveis, que passam a ser fontes
canônicas desta auditoria:

- ADR-0008 define `.lssubcircuit` schema v3 como composição TDPS normal, usando
  `components`, `topology`, `interface`/tunnels, `symbol`, componentes expostos e
  propriedades exportadas; rejeita um `TDPSEngine` ou hierarquia paralela.
- FEAT-012 define o importador `.smp` como adapter de autoria, resolução de `Mnn`
  somente no cold path e conversão para `.lsproj`/`.lssubcircuit`.
- `.spec/fixtures/tdps-v771-coverage.json` já registra 24 modelos, 66 controles,
  139 processos, 172 blocos de cálculo, 57 registradores, 24 registradores XY e
  213 textos animados, com hashes dos arquivos de origem.
- `.spec/fixtures/f7-process-coverage.md` e `f7-process-goldens.md` já mapeiam
  Gain, Sum, CalcExpression, FirstOrder, DeadTime, LeadLag, Saturation,
  RateLimiter, Hysteresis, Stiction, PID e seis bridges para o Core, além dos
  cenários `process_fopdt`, `tdps_basic_flow_loop` e `tdps_smith_predictor`.
- O repositório já contém `scripts/generate-tdps-process-library.mjs` e os
  subcircuitos TDPS gerados. Esses artefatos devem ser auditados e validados
  contra as fontes, não recriados.

Essa evidência reduz o escopo real: a etapa seguinte é verificar gaps entre o
que a spec declara e o que realmente compila/executa no Core atual, começando
por parser/importador e pelos goldens existentes.

## Primeira extração mecanizada

O parser `scripts/audit-tdps-smp.mjs` processou todos os 30 arquivos `.smp/.txd`
e captura registros `=====<<<TIPO:ID>>>=====` e campos `{...} Nome:valor`.
As contagens estruturadas atuais são: `TEXTO ANIMADO` 213, `BLOCO CALC` 172,
`PROCESSO` 139, `CONTROLADOR` 66 e `REGISTRADOR` 57. Os marcadores de seção
(`Unidades Engenharia` e `Tracks`) aparecem em 24 modelos e não são blocos
matemáticos. O JSON preserva cada ID, campo, referência `Mnn`, tamanho e linhas.
As expressões `Funcao:` de `BLOCO CALC`, parâmetros de `PROCESSO` e estados
iniciais de `CONTROLADOR`/`REGISTRADOR` serão usados na decomposição do
`SignalEngine` e na matriz TDPS -> `.lssubcircuit` -> kernel.
