---
id: FEAT-013
kind: feature
status: planned
dependsOn: [FEAT-001, ARCH-002, ARCH-004, ARCH-005, ARCH-006, FEAT-009]
supersedes: []
---

# Anexo F.14.10 — Common Practice Commands 80–90 (HCF_SPEC-151 Rev. 10.0)

- **80–83 — Device Variable Trim:** cada `VariableConfiguration` possui uma única capacidade/estado de trim: código de pontos suportados (0–3), unidade, limites/guidelines, diferencial mínimo, último ponto inferior/superior, ajuste atual e ajuste de fábrica. 80 retorna os últimos pontos; 81 retorna as guidelines; 82 valida código, unidade, limites e diferencial antes do commit atômico; 83 restaura o ajuste de fábrica. Isso é distinto de PV zero (43), Device Variable zero (52), Loop Current trim (45/46) e Analog Channel trim (67/68). O valor lido pelo Device Variable usa a mesma autoridade de ajuste, sem `trimmedValue` paralelo.
- **84 — Read Sub-Device Identity Summary:** resolve o `childDeviceId` no registro do próprio `HartEngine` e lê identidade do child; o parent armazena somente referência/topologia. A resposta é produzida a partir do plano/perfil do child, não de cópia de tag, manufacturer ou device ID.
- **85/86 — Statistics:** contadores são voláteis, bounded e incrementados pelo tráfego real de polling/forwarding. 85 lê contadores por card/channel; 86 lê contadores por sub-device, mantendo A/B independentes.
- **87/88 — I/O System Master Mode/Retry Count:** alteram as propriedades canônicas `ioMasterMode` e `ioRetryCount` (2–5); 88 é a mesma configuração consultada pelo polling/forwarding, sem `displayedRetryCount` separado.
- **89/90 — Real-Time Clock:** RTC é capability explícita. O valor é derivado de `rtcValueSeconds + (virtualTime - rtcSetVirtualSeconds)`, com uma única injeção de tempo virtual do `HartEngine`; não usa wall clock, thread ou timer. 90 retorna current time, last-set time e flags; clock não inicializado retorna midnight/1900 e flag correspondente. Clock não-volátil é uma propriedade de capability, não uma consequência de Command 42.

Os layouts foram conferidos nas seções 7.48–7.58 do HCF_SPEC-151 Rev. 10.0 e Common Tables 22, 38 e 42 do HCF_SPEC-183. Os goldens/cross-checks estão em `core/test/core/protocols/HartEngineTest.cpp`.

# Anexo F.14.9 — Common Practice Commands 71–78 (HCF_SPEC-151 Rev. 10.0)

Implementação verificada no Core:

- **71/76 — Lock Device / Read Lock Device State:** um único `HartDevicePlan::lockCode` canônico (0 unlocked, 1 temporary, 2 permanent, 3 lock all). O status de 76 é derivado da mesma autoridade; owner e gateway/primary bits não são cópias independentes. Lock temporário é limpo por Device Reset (42); lock permanente não é. Write Protect continua sendo um mecanismo separado. Writes de configuração/calibração são rejeitados para master não-owner, enquanto Command 38 permanece permitido conforme a norma.
- **72 — Squawk:** aceita Off, On, Squawk Once e a requisição vazia de compatibilidade. O efeito é estado/evento semântico no Core (`squawkControl`/`squawkEvent`), sem thread, timer de wall clock ou dependência da UI; reset limpa o estado transitório.
- **73 — Find Device:** exige `findDeviceArmed` e produz a mesma resposta de identidade de Command 0 usando o mesmo programa/autoridade de identidade.
- **74 — Read I/O System Capabilities:** só responde quando `ioSystem` é verdadeiro e serializa os limites/capacidades do plano; device comum não fabrica capability nem sub-device.
- **75/77 — Poll Sub-Device / Send Command to Sub-Device:** links estáveis guardam somente `childDeviceId` e coordenadas card/channel/polling. O estado HART do filho continua no próprio `HartDevicePlan`; polling e forwarding resolvem o filho no mesmo `HartEngine` e passam pelo mesmo caminho de comandos, sem executor, scheduler ou stack paralelo.
- **78 — Read Aggregated Commands:** envelope bounded (até 32 comandos, payload total HART bounded), rejeita Command 31/78 aninhado, executa cada item pelo dispatcher canônico e faz staging numa cópia antes do commit para impedir efeito parcial quando a resposta não couber.

Os layouts e códigos de controle foram conferidos contra as seções 7.39–7.46 do HCF_SPEC-151 Rev. 10.0 e Common Tables 18, 25 e 66 do HCF_SPEC-183. A cobertura byte-level e de cross-command está em `core/test/core/protocols/HartEngineTest.cpp`.


# HART Device Engine — motor modular de dispositivos HART

# Anexo F.14.11 - Common Practice Commands 91-99 (HCF_SPEC-151 Rev. 10.0)

- **91/92 - Trend Configuration:** cada trend usa `HartTrendConfiguration`; Command 92 valida controle, variavel e periodo (1 s-7200 s) antes do commit. Alterar qualquer parametro limpa o historico e reinicializa as 12 posicoes com `NaN`/status BAD-Fixed. O historico e bounded e somente runtime.
- **93 - Read Trend:** o payload retorna a configuracao efetiva e, no maximo, 12 pares valor/status, em ordem do mais recente para o mais antigo, com timestamp e intervalo. A amostragem ocorre somente ao avancar o tempo virtual, sem thread ou wall clock.
- **94/95 - Communication Statistics:** retornam snapshots dos contadores volateis de trafego IO/client-side e device-side; nao ha contador paralelo na extensao.
- **96/97 - Synchronous Action:** a acao e armazenada em `HartSynchronousActionConfiguration`, com os bits de comando, one-shot e enabled. O scheduler bounded usa exclusivamente tempo virtual; acoes one-shot removem o bit enabled, e acoes recorrentes avancam 24 h.
- **98/99 - Command Action:** request data e comando ficam na configuracao da mesma acao. Quando disparada, a acao chama o dispatcher canonico do `HartEngine`, sem executor ou caminho de execucao alternativo.

Os layouts foram conferidos nas secoes 7.59-7.67 do HCF_SPEC-151 Rev. 10.0 e Common Tables 37 e 41 do HCF_SPEC-183. A cobertura byte-level, o reset de historico, os snapshots e o disparo one-shot estao em `core/test/core/protocols/HartEngineTest.cpp`.

# Anexo F.14.12 - Common Practice Commands 100-110 (HCF_SPEC-151 Rev. 10.0)

- **100 - Write Primary Variable Alarm Code - DONE_SPEC_VERIFIED:** request/response de 1 byte; grava `HartDevicePlan::alarmSelectionCode`, já usado pelo leitor de informação da PV. É configuração de ação de alarme e não altera os bits de status/alarme ativo.
- **101/102 - Sub-device/Burst Message Map - DONE_SPEC_VERIFIED:** request 1 byte para leitura e 3 bytes para escrita; resposta é mensagem + índice uint16. A associação persistente usa `childDeviceId`, enquanto o índice é resolvido na leitura; o estado do child não é copiado para o parent. Aplicável a I/O System.
- **103/104/105 - Burst configuration - DONE_SPEC_VERIFIED:** períodos são armazenados em unidades HART de 1/32 ms; trigger guarda modo, classificação, unidade e nível; Command 105 serializa a mesma definição consumida pelo scheduler. Cada dispositivo possui três mensagens bounded, com configuração persistente e estado de agendamento volátil.
- **106 - Flush Delayed Responses - DONE_SPEC_VERIFIED:** request/response vazios; limpa a fila bounded real de eventos/respostas pendentes do runtime, sem apenas zerar um contador fictício.
- **107/108/109 - Burst variables/command/control - DONE_SPEC_VERIFIED:** 107 valida e comita os oito slots atomicamente; 108 usa identidade numérica de comando; 109 altera a mesma flag lida pelo scheduler. Burst usa o dispatcher canônico StandardCore/CompiledDsl.
- **110 - Read All Dynamic Variables - DONE_SPEC_VERIFIED:** request vazio; serializa até quatro pares unidade/float e interrompe no último assignment configurado, usando `dynamicVariableAssignments` e os mesmos valores canônicos de Commands 3/61. A norma marca o comando como não recomendado para novos designs.

O texto normativo foi conferido nas seções 7.68-7.78, páginas 122-138, do HCF_SPEC-151 Rev. 10.0. Os comandos de configuração persistem no plano/JSON do componente; `next-fire`, última amostra e fila de eventos são runtime volátil. Não há thread, timer ou wall clock: Burst é conduzido exclusivamente por `HartEngine::setVirtualTimeSeconds`, com fila e emissões bounded.

O histórico de Trend de 12 entradas continua documentado como `INTERNAL_RESOURCE_LIMIT` da implementação bounded para o payload de Command 93; não é apresentado como um limite geral normativo HART além do layout implementado.

### Anexo F.14.13 - Common Practice Commands 111-119 (HCF_SPEC-151 Rev. 10.0)

- **111/112 - Block Data Transfer - DONE_SPEC_VERIFIED:** implementados conforme ao HCF_SPEC-190: abertura/fechamento de porta, funcao de transferencia, contadores master/device e segmentos limitados pelo tamanho aceito. A sessao de transferencia e estado de runtime e e descartada no reset.
- **113 - Catch Device Variable - DONE_SPEC_VERIFIED:** grava a configuracao de captura futura (modo, endereco expandido, slot, shed time e comando de origem). A captura ocorre somente quando a resposta real do comando configurado chega ao dispatcher canonico; ela nao cria uma segunda variavel independente.
- **114 - Read Caught Device Variable - DONE_SPEC_VERIFIED:** le a configuracao de catch, incluindo a representacao IEEE-754 de `shedTime`; valores nao configurados retornam modo desabilitado e `NaN`.
- **115-119 - Event Notification - DONE_SPEC_VERIFIED:** implementados resumo, mascara de status/evento, temporizacao, controle e acknowledgment. A fila de transicoes e limitada a oito registros; configuracoes permanecem no plano, enquanto registros latched e timestamps sao limpos no reset. O relogio usa o tempo virtual do engine.
- **120/121 - NOT_APPLICABLE:** nao sao comandos Common Practice definidos no HCF_SPEC-151 Rev. 10.0 fornecido neste repositorio; nenhuma semantica foi inventada para eles. O proximo bloco padronizado localizado no catalogo e o de comandos 512+.

Os contratos de 111-119 e seus cenarios de transferencia, catch e eventos estao cobertos em `HartEngineTest.cpp`; a implementacao mantem um dispatcher canonico e nao usa fallback generico para simular respostas.

### Anexo F.14.14 - Additional Common Practice Commands 512-531

Matriz normativa preliminar, conferida diretamente em `HCF_SPEC-151 Rev. 10.0` (secoes 7.88-7.107) e `HCF_SPEC-183 Rev. 22.0` (Common Tables 54, 67-74). Os layouts completos, codigos de resposta e notas de aplicabilidade estao nos PDFs locais do `HART.zip`.

| ID | Official Name | Normative Specification / Rev. | Defined in local HART.zip? | Applicability | Existing canonical infrastructure | Implementation status |
|---:|---|---|---|---|---|---|
| 512 | Read Country Code | HCF_SPEC-151 Rev. 10.0, 7.88 | Sim | device metadata; paired with 513 | HartDevicePlan metadata | DONE_SPEC_VERIFIED |
| 513 | Write Country Code | HCF_SPEC-151 Rev. 10.0, 7.89 | Sim | device metadata; requires 512 | same country/SI property | DONE_SPEC_VERIFIED |
| 514 | Register Event Manager | HCF_SPEC-151 Rev. 10.0, 7.90; HCF_SPEC-183 Rev. 22.0, Table 67 | Sim | I/O System | Event Notification ownership | DONE_SPEC_VERIFIED |
| 515 | Read Event Manager Registration Status | HCF_SPEC-151 Rev. 10.0, 7.91; HCF_SPEC-183 Rev. 22.0, Table 68 | Sim | I/O System | same registration authority | DONE_SPEC_VERIFIED |
| 516 | Read Device Location | HCF_SPEC-151 Rev. 10.0, 7.92; HCF_SPEC-183 Rev. 22.0, Table 69 | Sim | device with WGS84 location capability | HartDeviceLocation | DONE_SPEC_VERIFIED |
| 517 | Write Device Location | HCF_SPEC-151 Rev. 10.0, 7.93 | Sim | same location capability | same location property | DONE_SPEC_VERIFIED |
| 518 | Read Location Description | HCF_SPEC-151 Rev. 10.0, 7.94 | Sim | device metadata | bounded Latin-1 metadata | DONE_SPEC_VERIFIED |
| 519 | Write Location Description | HCF_SPEC-151 Rev. 10.0, 7.95 | Sim | same metadata | same 32-byte property | DONE_SPEC_VERIFIED |
| 520 | Read Process Unit Tag | HCF_SPEC-151 Rev. 10.0, 7.96 | Sim | process-unit metadata | separate 32-byte property | DONE_SPEC_VERIFIED |
| 521 | Write Process Unit Tag | HCF_SPEC-151 Rev. 10.0, 7.97 | Sim | same metadata | same process-unit property | DONE_SPEC_VERIFIED |
| 522 | Write Volumetric Flow Classification | HCF_SPEC-151 Rev. 10.0, 7.98; HCF_SPEC-183 Rev. 22.0, Table 21 | Sim | only a volumetric-flow Device Variable | VariableConfiguration classification | DONE_SPEC_VERIFIED |
| 523 | Read Condensed Status Mapping Array | HCF_SPEC-151 Rev. 10.0, 7.99; HCF_SPEC-183 Rev. 22.0, Table 70 | Sim | device supporting Condensed Status | 208-entry canonical map | DONE_SPEC_VERIFIED |
| 524 | Write Condensed Status Mapping | HCF_SPEC-151 Rev. 10.0, 7.100 | Sim | configurable Condensed Status device | staged map, atomic commit | DONE_SPEC_VERIFIED |
| 525 | Reset Condensed Status Map | HCF_SPEC-151 Rev. 10.0, 7.101 | Sim | configurable Condensed Status device | normative/default map authority | DONE_SPEC_VERIFIED |
| 526 | Write Status Simulation Mode | HCF_SPEC-151 Rev. 10.0, 7.102; HCF_SPEC-183 Rev. 22.0, Table 71 | Sim | Condensed Status/Status Simulation device | status overlay over real status | DONE_SPEC_VERIFIED |
| 527 | Simulate Status Bit | HCF_SPEC-151 Rev. 10.0, 7.103; HCF_SPEC-183 Rev. 22.0, Table 72 | Sim | only while simulation enabled | same overlay, no physical-state mutation | DONE_SPEC_VERIFIED |
| 528 | Read Sub-Device Assignment List Information | HCF_SPEC-151 Rev. 10.0, 7.104; HCF_SPEC-183 Rev. 22.0, Table 73 | Sim | non-volatile I/O assignment capability | bounded assignment list | DONE_SPEC_VERIFIED |
| 529 | Read Sub-Device Assignment | HCF_SPEC-151 Rev. 10.0, 7.105 | Sim | same assignment capability | stable child identity records | DONE_SPEC_VERIFIED |
| 530 | Write Sub-Device Assignment | HCF_SPEC-151 Rev. 10.0, 7.106 | Sim | same assignment capability | staged bounded assignment list | DONE_SPEC_VERIFIED |
| 531 | Transfer Live Sub-Device List to Assignment List | HCF_SPEC-151 Rev. 10.0, 7.107; HCF_SPEC-183 Rev. 22.0, Table 74 | Sim | same assignment capability | live registry snapshot -> assignment | DONE_SPEC_VERIFIED |

Writes 513, 517, 519, 521, 522, 524-527 and 530-531 validate the complete request before commit. Event Manager uses the command caller's HART master identity (`masterRole` in the Core API), so only the registered owner may acknowledge Command 119; no display name or UI identity participates. Assignment entries are bounded, retain stable child references, survive plan save/reopen when serialized by the owning device, and are not aliases of the live `subDevices` list.

### Anexo F.14.15 - Post-531 standardized inventory and next semantic cluster

Inventory reconciled against the local `HART.zip` (Command Summary HCF_SPEC-099 Rev. 9.0 and the referenced local specifications). IDs are grouped only where the specification defines a contiguous command family; overlapping IDs (for example Temperature and Conductivity at 1024-1027) remain separate rows because applicability is specification/family-specific.

| ID(s) | Family / official source | Local specification | Applicability in this engine | Existing canonical model | Status / next action |
|---:|---|---|---|---|---|
| 512-531 | Additional Common Practice | HCF_SPEC-151 Rev. 10.0 | Standard field device; capability-gated per command | HartDevicePlan metadata, Event Manager, condensed status, assignments | DONE_SPEC_VERIFIED |
| 768-791, 793-823, 832-862, 960-979 | WirelessHART network, security, scheduling and topology | HCF_SPEC-155 Rev. 2.0 | NOT_APPLICABLE: no WirelessHART network/session/security model in the engine | None; no fake radio/network state | NOT_APPLICABLE |
| 1024-1027, 1152-1155, 1157, 1556 | Temperature Device Family | HCF_SPEC-160.04 Rev. 2.0 | NOT_APPLICABLE until a temperature-family capability and its typed configuration exist | Device Variable metadata alone is insufficient for these layouts | NOT_APPLICABLE |
| 1024-1027, 1152-1153 | Conductivity Device Family | HCF_SPEC-160.09 Rev. 1.1 | NOT_APPLICABLE: no conductivity sensor/configuration model | None | NOT_APPLICABLE |
| 1280-1285 | Pressure Device Family mandatory read cluster | HCF_SPEC-160.5, Draft, Rev. 1.0, pp. 22-29 | A real authored Device Variable with Pressure classification 65 | Per-Device-Variable PressureFamilyConfiguration | DONE_SPEC_VERIFIED |
| 1286-1290 | Pressure Device Family optional reads (mandatory when feature is supported) | HCF_SPEC-160.5, Draft, Rev. 1.0, pp. 30-33 | Explicit per-variable gasket/observation/remote-seal capability | Same PressureFamilyConfiguration; bounded fixed layouts | DONE_SPEC_VERIFIED |
| 1408-1410 | Pressure Device Family optional writes (mandatory when feature is supported) | HCF_SPEC-160.5, Draft, Rev. 1.0, pp. 34-38 | Explicit per-variable write capability plus write protection | Same metadata read by 1284/1286/1290; atomic commit | DONE_SPEC_VERIFIED |
| 1792-1805, 1920-1943 | PID Control Device Family | HCF_SPEC-160.07 Rev. 1.0 | NOT_APPLICABLE: no PID controller/tuning model | None | NOT_APPLICABLE |
| 2048-2051, 2176-2178 | pH Device Family | HCF_SPEC-160.08 Rev. 1.0 | NOT_APPLICABLE: no pH calibration/compensation model | None | NOT_APPLICABLE |
| 2560-2562, 2688-2693 | Totalizer Device Family | HCF_SPEC-160.10 Rev. 1.0 | NOT_APPLICABLE: no totalizer/relay model | None | NOT_APPLICABLE |
| 2816-2827, 2944-2953 | Level Device Family | HCF_SPEC-160.11 Rev. 1.0 | NOT_APPLICABLE: no level sensor/settings/calibration model | None | NOT_APPLICABLE |
| 64384-64397 | Discrete Applications | HCF_SPEC-285 Rev. 2.0 | NOT_APPLICABLE: no discrete variable/override/fault model | None | NOT_APPLICABLE |
| 64448-64459 | DLEU / Discrete Applications extension | HCF_SPEC-285 Rev. 2.0 | NOT_APPLICABLE: no DLEU capability or model | None | NOT_APPLICABLE |

The Pressure Family is now complete for every command actually defined by the local specification: 1280-1290 and 1408-1410. Requests select a real pressure-classified Device Variable (classification 65); each variable owns an independent `PressureFamilyConfiguration`, including process connection, gasket, observations, remote seal and stable associated-variable IDs. 1280-1285 and 1286-1290 are fixed-layout reads; 1408-1410 decode the complete request, enforce write protection and the corresponding semantic capability, then atomically update the same metadata consumed by the readers. No pressure state is global to the device and no unsupported optional feature is filled with a generic capability mask.

For the local PDF, classification 65 is the normative pressure Device Variable classification used by the family command request tables; it is sufficient to select the family variable, while optional commands additionally require the explicit feature capability in the canonical pressure metadata. The PDF is marked `DRAFT`, Document Number `HCF_SPEC-160.5`, Revision 1.0, release date 5 November 2002; this implementation does not mix bytes from another revision. Command 1291 is not defined by this specification and is intentionally absent from the catalog.

Pressure command-level contract (HCF_SPEC-160.5 Draft Rev. 1.0):

| ID / section / page | Official name | Request | Response | Response codes / applicability | Semantics, persistence and tests | Status |
|---:|---|---|---|---|---|---|
| 1280 / 5.2 / 22 | Read Pressure Status | 1 byte DV code | DV code + DV status + Pressure Status 0 (3 bytes) | 0 success; 2 invalid selection; 5 too few; 6 device error; 16 access restricted; classification 65 | Reads per-DV `status0`; persistent metadata; byte-exact golden | DONE_SPEC_VERIFIED |
| 1281 / 5.3 / 24 | Read Capabilities | 1 byte DV code | DV code + family definition revision + capability bytes 0/1 (4 bytes) | Same 0/2/5/6/16; classification 65 | Reads per-DV capability metadata; no generic mask | DONE_SPEC_VERIFIED |
| 1282 / 5.4 / 25 | Read Supported Status Mask | 1 byte DV code | DV code + supported family mask + Pressure Status 0 mask (3 bytes) | Same 0/2/5/6/16; classification 65 | Reads per-DV masks; persistent and independently tested | DONE_SPEC_VERIFIED |
| 1283 / 5.5 / 26 | Read Pressure Sensor Information | 1 byte DV code | DV code, 6 enums/bytes, minimum absolute pressure and maximum static pressure (15 bytes) | Same 0/2/5/6/16; classification 65 | Uses typed per-DV sensor metadata and IEEE-754 BE limits | DONE_SPEC_VERIFIED |
| 1284 / 5.6 / 27 | Read Process Connection | 1 byte DV code | DV code + 10 process-connection enum values (11 bytes) | Same 0/2/5/6/16; classification 65 | Reads the exact property written by 1408 | DONE_SPEC_VERIFIED |
| 1285 / 5.7 / 29 | Read Associated Device Variables | 1 byte DV code | DV code + associated cell-temperature code + associated static-pressure code (3 bytes) | Same 0/2/5/6/16; stable IDs resolve to codes; absent association is 250 | Stable `variableId` references, not display names/vector indexes | DONE_SPEC_VERIFIED |
| 1286 / 5.8 / 30 | Read Optional Gasket Material Data | 1 byte DV code | DV code + backup/adapter/neck material enums (4 bytes) | Same 0/2/5/6/16; only if per-DV gasket capability | Reads property written by 1409; capability-gated | DONE_SPEC_VERIFIED |
| 1287 / 5.9 / 30 | Read Min/Max Pressure Observation | 1 byte DV code | DV code + unit + minimum/maximum float (10 bytes) | Same 0/2/5/6/16; only if pressure-observation capability | Per-DV lifetime observation metadata; fixed-size golden | DONE_SPEC_VERIFIED |
| 1288 / 5.10 / 31 | Read Min/Max Temperature Observation | 1 byte DV code | DV code + unit + minimum/maximum float (10 bytes) | Same 0/2/5/6/16; only if temperature-observation capability | Per-DV metadata; no pressure/global fallback | DONE_SPEC_VERIFIED |
| 1289 / 5.11 / 32 | Read Min/Max Static Pressure Observation | 1 byte DV code | DV code + unit + minimum/maximum float (10 bytes) | Same 0/2/5/6/16; only if static-pressure-observation capability | Per-DV metadata; no hardcoded limits | DONE_SPEC_VERIFIED |
| 1290 / 5.12 / 33 | Read Remote Seal Information | 1 byte DV code | DV code + seven remote-seal enum values (8 bytes) | Same 0/2/5/6/16; only if remote-seal capability | Reads property written by 1410 | DONE_SPEC_VERIFIED |
| 1408 / 5.13 / 34-35 | Write Process Connection | DV code + 10 enum values (11 bytes) | DV code + same 10 values (11 bytes) | 0/2/5/6/8 warning/16/17+ illegal enum; write-protected or unsupported is rejected | Atomic update of per-DV connection; read-after-write 1284; configuration is persistent | DONE_SPEC_VERIFIED |
| 1409 / 5.14 / 36 | Write Optional Gasket Material | DV code + three material enums (4 bytes) | DV code + three values (4 bytes) | 0/2/5/6/8 warning/16/17+ illegal enum; capability and write protection required | Atomic update of per-DV gasket; read-after-write 1286; persistent | DONE_SPEC_VERIFIED |
| 1410 / 5.15 / 37-38 | Write Remote Seal Information | DV code + seven seal values (8 bytes) | DV code + seven values (8 bytes) | 0/2/5/6/8 warning/16/17+ illegal enum; capability and write protection required | Atomic update of per-DV remote seal; read-after-write 1290; persistent | DONE_SPEC_VERIFIED |

The HART engine test covers the mandatory and optional fixed layouts, capability rejection, non-pressure rejection, write/read round trips, write protection path, two independent pressure Device Variables and stable association behavior. Component variable JSON serializes the same nested pressure metadata, so a fresh component reconstruction uses the persisted values rather than the original runtime object.

The remaining files in the ZIP describe protocol/application infrastructure, reserved ranges, device-specific extensions or draft device-family proposals. They are retained as source evidence but do not create field-device StandardCore handlers: `NOT_APPLICABLE` means the repository has no corresponding capability/model, while `NOT_DEFINED` means the local normative source was found but the current increment deliberately does not claim that semantic cluster.

## 1. Propósito

Esta especificação define a evolução da implementação HART existente no LasecSimul para um **HART Device Engine** modular, extensível e eficiente, capaz de representar múltiplos tipos e instâncias de dispositivos HART sem exigir alterações no dispatcher central, na UI ou no transporte a cada novo equipamento.

O motor deve permitir:

- adicionar novos perfis/tipos de dispositivo HART;
- remover perfis/tipos sem alterar o núcleo do protocolo;
- criar e remover instâncias de dispositivos a partir desses perfis;
- registrar e remover comandos HART independentemente;
- compartilhar funções de parsing/interpretação entre comandos;
- executar múltiplos dispositivos com baixo custo de CPU e memória;
- funcionar de forma determinística no transporte virtual;
- preservar isolamento por `SimulationSession`;
- operar adequadamente em Desktop, SharedHost e futuro backend remoto;
- suportar uma arquitetura thin client na qual a UI não executa a lógica HART;
- permitir transportes físicos/reais de maneira opcional, explícita e governada por orçamento de recursos.

Esta feature **não cria uma segunda implementação HART paralela**. Ela estende e generaliza `FEAT-009`, preservando os componentes HART já entregues como perfis/compatibilidade sobre o novo motor.

---

## 2. Contexto

O LasecSimul já estabelece:

- Core C++ como autoridade da simulação;
- Extension/cliente como camada de autoria, visualização e comando;
- `SimulationPlan` imutável compilado fora do hot path;
- `RuntimeState` mutável e isolado por sessão;
- registries e handles densos para evitar resolução de strings durante a execução;
- telemetria bounded e latest-wins quando apropriado;
- ResourceGovernor para limitar threads, processos, buffers, filas e transportes reais;
- protocolos industriais semanticamente separados de suas camadas físicas;
- HART virtual existente através de `protocol.hart.transmitter` e `protocol.hart.communicator`.

O projeto `process_simul` contém conceitos valiosos que devem ser reaproveitados arquiteturalmente, em especial:

- `EquipmentRepository`;
- definição/perfil de equipamentos;
- `HartCommandHandler`;
- `HartCommandContext`;
- `HartCommandRegistry`;
- `HartFunctionRegistry`;
- codec/parser compartilhado;
- framing HART;
- transportes TCP e serial;
- separação entre cadastro de equipamento e widgets.

Esses conceitos devem ser **adaptados para a arquitetura do LasecSimul**, e não copiados literalmente do Flutter/Dart.

---

## 3. Decisões arquiteturais obrigatórias

### 3.1. Um engine por sessão, não um runtime pesado por dispositivo

Cada `SimulationSession` deve possuir no máximo um `HartEngine` lógico.

O engine gerencia todos os barramentos, perfis e instâncias HART daquela sessão.

É proibido criar, por dispositivo virtual:

- `std::thread`;
- processo externo;
- socket;
- timer do sistema operacional;
- event loop independente;
- arquivo de log independente;
- fila sem limite;
- conexão de banco de dados.

Dispositivos virtuais inativos não devem gerar wakeups periódicos individuais.

### 3.2. Separação entre definição, instância compilada e estado

A arquitetura deve separar explicitamente:

```text
HartDeviceProfile
        ↓ compile
HartDevicePlan
        ↓ instantiate
HartDeviceRuntimeState
```

`HartDeviceProfile` pertence ao domínio de autoria/catálogo.

`HartDevicePlan` pertence ao `SimulationPlan` e contém somente dados normalizados e resolvidos.

`HartDeviceRuntimeState` pertence à sessão e contém somente estado mutável necessário durante a execução.

### 3.3. Sem resolução textual no hot path

Durante processamento normal de frames/comandos:

- não procurar dispositivo por nome;
- não procurar variável por string;
- não procurar comando por string;
- não fazer busca global no catálogo;
- não consultar arquivos;
- não consultar SQLite;
- não consultar a Extension.

Todos os vínculos devem estar resolvidos em compile-time para índices/handles.

### 3.4. Transporte semântico separado do transporte físico

O caminho primário deve ser:

```text
HartCommunicator
        ↓
HartVirtualBus
        ↓
HartEngine
        ↓
HartDeviceRuntime
```

Transportes reais devem ser adaptadores externos:

```text
TCP compatibility adapter ─┐
Serial adapter             ├─> HartTransportEndpoint -> HartEngine
Future physical FSK modem  ┘
```

Nenhum dispositivo virtual deve abrir uma porta real implicitamente.

### 3.5. Thin client

No perfil thin client:

```text
UI / VS Code / cliente
        ↓ ReliableControl
SharedHost / Core remoto
        ↓
SimulationSession
        ↓
HartEngine
```

Toda a lógica de protocolo, execução de comandos, estado de equipamentos, endereçamento, parsing e bindings deve permanecer no Core/SharedHost.

A UI recebe apenas:

- estado necessário à apresentação;
- alterações de configuração;
- resultados de operações;
- telemetria resumida;
- traces HART somente quando explicitamente habilitados.

---

## 4. Escopo funcional

### HART-FR-001 — Registry de perfis

Deve existir um `HartDeviceProfileRegistry`.

O registry deve permitir registrar e remover perfis fora do estado RUN.

Cada perfil deve possuir ao menos:

```text
profileId
profileVersion
displayName
manufacturerId
deviceType
capabilities
defaultParameters
variableDefinitions
commandSet
functionDependencies
```

`profileId + profileVersion` deve identificar de forma estável a definição usada por um projeto.

Registro duplicado deve falhar explicitamente.

### HART-FR-002 — Instâncias independentes do perfil

Um único perfil pode originar múltiplas instâncias.

Cada instância deve possuir no mínimo:

```text
deviceHandle
instanceId
profileHandle
busHandle
pollingAddress
uniqueId
tag
status
parameter/state slots
signal bindings
```

Dados comuns ao perfil não devem ser duplicados desnecessariamente em cada instância.

### HART-FR-003 — Adição de dispositivo

Adicionar uma nova instância HART deve exigir apenas uma operação de autoria/configuração.

Não deve exigir alteração de:

- dispatcher HART;
- widget específico;
- Core central;
- transporte;
- SQL;
- código de outro dispositivo.

Enquanto o suporte de hot-swap de `SimulationPlan` não existir, adição estrutural de dispositivo durante RUN deve:

1. ser rejeitada de maneira explícita; ou
2. ser enfileirada como alteração de autoria a aplicar após STOP.

Não implementar hot-swap ad hoc somente para HART.

### HART-FR-004 — Remoção de dispositivo

A remoção estrutural deve invalidar apenas os domínios de plano necessários.

Após recompilação, nenhum estado, binding, endpoint ou callback pertencente ao dispositivo removido pode permanecer alcançável pelo runtime.

### HART-FR-005 — Registry de comandos

Deve existir um `HartCommandRegistry` sem `switch` monolítico central.

Contrato conceitual:

```cpp
struct HartCommandContext;
struct HartResponseBuilder;

class IHartCommandHandler {
public:
    virtual HartCommandId command() const noexcept = 0;
    virtual HartCommandResult execute(
        const HartCommandContext& context,
        HartResponseBuilder& response) noexcept = 0;
};
```

A implementação concreta pode usar ABI C/function pointers quando necessário.

Adicionar ou remover um comando deve ser uma operação de registro, sem editar o dispatcher central.

### HART-FR-006 — Dispatch compilado

O `HartDevicePlan` deve conter tabela de dispatch já resolvida para o conjunto de comandos suportado pelo perfil.

O caminho normal deve ser O(1) sempre que tecnicamente razoável.

São aceitáveis:

- tabela densa para comandos universais/comuns;
- tabela compacta indexada;
- lookup binário em tabela ordenada para comandos estendidos/vendor-specific.

Não utilizar `unordered_map<string,...>` ou equivalentes no hot path.

### HART-FR-007 — Remoção explícita de comando

Quando houver compatibilidade com um conjunto legado/default, a remoção explícita de um comando deve impedir fallback acidental.

Pode ser utilizado conceito equivalente a tombstone durante a composição/compilação do perfil.

No plano final, o resultado deve ser uma tabela resolvida sem necessidade de interpretar tombstones a cada frame.

### HART-FR-008 — Contexto único de comando

Todos os handlers devem receber um contexto padronizado contendo, quando aplicável:

```text
session
deviceHandle
profileHandle
busHandle
virtualTime
request
runtime state access
parameter slots
signal handles
function registry
bounded response writer
diagnostic sink
```

Handlers não devem acessar diretamente:

- socket;
- serial;
- SQLite;
- Riverpod;
- WebView;
- VS Code;
- filesystem;
- singleton global de sessão.

### HART-FR-009 — Registry de funções reutilizáveis

Deve existir um `HartFunctionRegistry` para parsers e interpretações reutilizáveis.

Exemplos:

```text
float32_be
uint16_be
uint24_be
uint32_be
ascii_fixed
packed_status
engineering_unit
enum_value
bit_enum
device_variable
```

Funções devem:

- possuir identificador estável;
- validar bounds;
- produzir erro tipado;
- ser testáveis sem infraestrutura externa;
- não fazer I/O;
- não alocar memória dinamicamente no caminho comum quando evitável.

### HART-FR-010 — Codec HART compartilhado

Deve existir um único módulo de codec/framing utilizado por:

- barramento virtual;
- adaptadores TCP;
- adaptadores seriais;
- testes;
- ferramentas de diagnóstico.

O codec deve oferecer:

```text
HartFrameView
HartFrameDecoder
HartFrameEncoder
HartPayloadReader
HartPayloadWriter
HartChecksum
HartAddress
```

O decoder deve operar sobre buffers bounded e rejeitar frames inválidos sem crescimento ilimitado de memória.

### HART-FR-011 — Endereçamento

O engine deve suportar endereçamento HART curto e longo conforme o nível semântico implementado.

A resolução deve ser pré-compilada por barramento.

Para polling address curto, preferir estrutura direta de tamanho limitado.

Para long address/unique ID, utilizar estrutura compilada adequada, sem busca global textual.

Conflitos de endereço no mesmo barramento devem ser erro de validação antes de RUN.

### HART-FR-012 — Barramento virtual

Cada sessão pode conter zero ou mais `HartVirtualBus`.

Um barramento deve suportar múltiplos dispositivos e múltiplos comunicadores compatíveis com suas regras de endereçamento.

O barramento virtual:

- usa virtual time;
- não abre recursos do host;
- é determinístico;
- possui filas bounded;
- não depende da velocidade da UI;
- mantém isolamento entre sessões;
- permite fault injection controlada para testes.

### HART-FR-013 — Binding com Signal Engine

Variáveis HART que representam grandezas do processo devem poder ser vinculadas a slots do Signal Engine.

Exemplos:

```text
PV -> signalHandle
SV -> signalHandle
TV -> signalHandle
QV -> signalHandle
AO -> signalHandle
status/quality -> typed slot
```

Bindings devem ser resolvidos pelo `PlanCompiler`.

O runtime não pode resolver nomes de tags/variáveis a cada comando.

### HART-FR-014 — Escrita em parâmetros

Comandos de escrita devem atualizar uma única fonte autoritativa de estado.

Não manter cópias divergentes de um mesmo parâmetro em:

- protocolo;
- UI;
- componente de processo;
- PLC;
- persistence model.

Quando um valor estiver ligado ao Signal Engine, a regra de ownership deve ser explícita no plano.

### HART-FR-015 — Equipamentos declarativos

A forma preferencial de adicionar dispositivos deve ser declarativa.

Um novo equipamento padrão deve poder ser introduzido por:

```text
manifest/profile
+
command composition
+
bindings/defaults
+
fixtures/tests
```

sem criar uma nova DLL quando não houver comportamento nativo especial.

### HART-FR-016 — Extensão nativa opcional

Perfis que precisem de algoritmos proprietários, comandos vendor-specific complexos ou comportamento de dispositivo não expressável declarativamente podem utilizar plugin nativo.

O plugin deve integrar-se ao mecanismo de devices já existente no LasecSimul e respeitar ABI estável.

Handlers nativos devem ser resolvidos quando o plano/sessão é preparado.

Não carregar/descarregar DLL/SO por frame.

Não realizar unload de plugin enquanto alguma sessão utiliza handlers provenientes dele.

### HART-FR-017 — Compatibilidade com HART atual

Os componentes existentes:

```text
protocol.hart.transmitter
protocol.hart.communicator
```

devem continuar funcionando.

O transmitter atual deve evoluir para perfil default compatível sobre o engine.

O communicator deve utilizar o mesmo `HartVirtualBus`/contrato do engine.

Não manter uma implementação antiga paralela depois da migração.

### HART-FR-018 — Catálogo

Perfis HART disponíveis devem integrar o catálogo unificado.

A UI deve descobrir capacidades através de metadados e não por listas hard-coded de modelos.

O cliente deve conseguir apresentar:

```text
fabricante
modelo/perfil
versão
comandos suportados
variáveis
parâmetros editáveis
transportes compatíveis
```

sem conhecer a implementação interna do handler.

### HART-FR-019 — Persistência

O projeto deve persistir apenas informação de autoria necessária para reconstrução:

```text
profileId
profileVersion
instanceId
bus
address
identity overrides
parameter overrides
bindings
transport configuration
```

Estado derivado/compilado pertence ao `SimulationPlan`/`RuntimeState` e não deve ser tratado como autoria.

### HART-FR-020 — Versionamento de perfil

Se um projeto referencia uma versão de perfil que não está disponível, o carregamento deve:

- informar claramente o identificador ausente;
- não substituir silenciosamente por uma versão diferente;
- oferecer migração explícita quando suportada.

### HART-FR-021 — Hot parameter update

Parâmetros declarados runtime-mutable podem ser atualizados durante RUN por comando confiável, desde que:

- não alterem a topologia;
- não alterem tamanho/layout do plano;
- não exijam recompilação;
- sejam aplicados pelo single-writer da sessão ou mecanismo equivalente determinístico.

Mudanças estruturais continuam dependentes da política normal de invalidation/recompile.

### HART-FR-022 — Diagnóstico

O engine deve fornecer counters baratos:

```text
framesRx
framesTx
checksumErrors
decodeErrors
unknownAddress
unsupportedCommand
commandErrors
queueDrops
timeouts
externalTransportErrors
```

Tracing detalhado de frames deve permanecer OFF por padrão.

### HART-FR-023 — Transportes reais

Transportes reais são opcionais e explicitamente habilitados.

Devem obedecer ao `ResourceGovernor`.

Primeira implementação recomendada:

```text
HartTcpCompatibilityAdapter
```

como ponte de compatibilidade com o ecossistema `process_simul`, sem tratá-lo como camada física HART real.

Suporte serial deve ser etapa independente.

Interoperabilidade com modem FSK/PHY real requer especificação e validação próprias.

### HART-FR-024 — Multiplexação de transporte

Um adaptador TCP/serial deve poder atender múltiplos dispositivos/barramentos quando o protocolo/configuração permitir.

É proibida a arquitetura:

```text
1 dispositivo = 1 thread = 1 socket = 1 timer
```

como padrão.

### HART-FR-025 — Lifecycle

O lifecycle externo deve ser centralizado:

```text
configure
prepare
start
stop
dispose
```

Após `stop/dispose`:

- sockets devem estar fechados;
- handles seriais devem estar fechados;
- callbacks externos devem estar desregistrados;
- filas bounded devem ser drenadas/descartadas conforme política;
- nenhum worker dedicado a HART pode permanecer;
- nenhuma referência a `SimulationSession` destruída pode permanecer.

---

## 5. Modelo arquitetural proposto

```text
                           AUTHORING / COLD PATH

 Unified Catalog
      │
      ├── HartDeviceProfile A
      ├── HartDeviceProfile B
      └── HartDeviceProfile Vendor X
                     │
                     ▼
            HartProfileRegistry
                     │
                     ▼
            Validator / Normalizer
                     │
                     ▼
               PlanCompiler
                     │
         ┌───────────┴────────────┐
         ▼                        ▼
  HartProtocolPlan        Signal/Binding Plan
         │                        │
         └───────────┬────────────┘
                     ▼

                           RUNTIME / HOT PATH

              SimulationSession
                     │
                 HartEngine
                     │
       ┌─────────────┼──────────────┐
       ▼             ▼              ▼
  BusRuntime 0  BusRuntime 1 ... BusRuntime N
       │
       ├── DeviceRuntime[0]
       ├── DeviceRuntime[1]
       └── DeviceRuntime[n]
       │
       ▼
 Compiled Command Dispatch
       │
       ▼
 Shared Payload/Function Codec
```

No thin client:

```text
VS Code/Web Client
   │
   ├── projeto/configuração
   ├── comandos de controle
   └── telemetria bounded
   │
   ▼
Core/SharedHost
   │
   └── HartEngine + simulação
```

---

## 6. Estruturas conceituais

### 6.1. HartDeviceProfile

```cpp
struct HartDeviceProfile {
    ProfileId id;
    ProfileVersion version;
    ManufacturerId manufacturer;
    DeviceTypeId deviceType;

    span<const ParameterDefinition> parameters;
    span<const VariableDefinition> variables;
    span<const HartCommandDescriptor> commands;
    span<const HartFunctionId> requiredFunctions;

    HartCapabilities capabilities;
};
```

Objetos equivalentes podem variar na implementação, mas a separação conceitual é normativa.

### 6.2. HartDevicePlan

```cpp
struct HartDevicePlan {
    DeviceHandle device;
    ProfileHandle profile;
    HartBusHandle bus;

    PollingAddress pollingAddress;
    HartUniqueAddress uniqueAddress;

    span<const CommandDispatchEntry> dispatch;
    span<const ParameterSlotHandle> parameters;
    span<const SignalBindingHandle> bindings;

    RuntimeLayout runtimeLayout;
};
```

O plano deve conter handles e offsets já resolvidos.

### 6.3. HartProtocolPlan

```cpp
struct HartProtocolPlan {
    span<const HartBusPlan> buses;
    span<const HartDevicePlan> devices;
    span<const HartProfilePlan> profiles;
    span<const HartExternalEndpointPlan> externalEndpoints;
};
```

Metadados imutáveis comuns devem ser compartilhados entre instâncias.

### 6.4. HartRuntimeState

O estado mutável deve ser compactado em arrays/slots, evitando árvores de objetos com alocação por variável.

Exemplo conceitual:

```text
device status array
device flags array
parameter value arena
dynamic variable arena
diagnostic counters
bounded command queue
bounded transport RX/TX arenas
```

---

## 7. Dispatch de comandos

O fluxo deve ser:

```text
frame recebido
   ↓
decode + bounds + checksum
   ↓
resolve bus
   ↓
resolve short/long address
   ↓
deviceHandle
   ↓
command dispatch entry
   ↓
handler(context, boundedWriter)
   ↓
encode response
```

Não deve existir:

```text
frame
   ↓
buscar nome do equipamento
   ↓
consultar catálogo
   ↓
switch gigantesco por command
   ↓
consultar UI/banco
```

---

## 8. Perfil declarativo de equipamento

A especificação de schema correspondente deve ser criada antes da implementação definitiva.

Preferir integração com os manifests/catalog contracts existentes.

Modelo lógico esperado:

```yaml
kind: hart-device-profile
id: hart.vendor.model
version: 1

identity:
  manufacturerId: 0
  deviceType: 0

variables:
  - id: pv
    type: float32
    unitParameter: pvUnit
    runtimeMutable: true

parameters:
  - id: tag
    type: ascii
    maxLength: 8

commands:
  include:
    - hart.universal.0
    - hart.universal.1
    - hart.universal.3
  exclude: []
  custom: []

bindings:
  - variable: pv
    signalRole: processValue
```

O formato físico final pode ser JSON ou outro formato já aceito pelo catálogo.

Não introduzir um parser YAML adicional apenas para esta feature se o projeto não o utilizar.

---

## 9. Composição de comandos

Perfis devem compor conjuntos de comandos a partir de módulos reutilizáveis:

```text
HART Universal Commands
        +
Common Practice Commands
        +
Device Family Commands
        +
Vendor Commands
        -
Explicitly Removed Commands
```

A composição é resolvida no cold path.

O resultado publicado no `HartDevicePlan` é uma tabela final.

---

## 10. Integração com dispositivos nativos

A DLL/SO deve ser exceção, não requisito para cada modelo HART.

Usar plugin nativo quando existir:

- cálculo proprietário;
- comportamento dinâmico complexo;
- integração especial com modelo físico;
- comandos não representáveis por handlers reutilizáveis;
- necessidade comprovada de desempenho.

Um perfil simples com identidade, parâmetros, variáveis e comandos padrão não deve exigir binário próprio.

---

## 11. Thin client e SharedHost

### 11.1. Regras

No perfil SharedHost/thin client:

- HART virtual não cria threads extras por sessão se não houver trabalho suficiente;
- zero dispositivo HART significa custo de runtime praticamente zero;
- dispositivo ocioso não possui timer individual;
- traces detalhados permanecem desabilitados;
- frames de trace não trafegam continuamente para o cliente;
- telemetria de valores deve ser coalescida;
- atualizações de UI não participam do virtual time;
- transporte real fica desligado por padrão;
- número de endpoints reais é limitado pelo ResourceBudget;
- buffers são bounded;
- command queues são bounded.

### 11.2. Conteúdo enviado ao cliente

Enviar preferencialmente:

```text
deviceHandle
revision/state version
PV/SV/TV/QV solicitados
status
health/counters resumidos
command result quando requisitado
```

Não reenviar a definição completa do perfil a cada frame.

Metadados de perfil podem ser cacheados por:

```text
profileId
profileVersion
contentHash
```

### 11.3. Controle

Operações estruturais:

```text
add/remove device
change profile
change bus topology
change binding topology
```

devem usar ReliableControl e respeitar a política de recompilação do `SimulationPlan`.

Telemetria contínua deve seguir a política LossyTelemetry existente.

---

## 12. Orçamento de recursos

O engine deve integrar-se ao `ResourceGovernor`.

A implementação deve provar que não viola:

```text
maxWorkerThreads
maxParallelTasks
maxExternalProcesses
telemetryBytesPerSecond
telemetryQueueBytes
logBytes
commandQueueCapacity
```

Se necessário, introduzir budgets específicos apenas por ADR/schema apropriado, por exemplo:

```text
maxHartExternalEndpoints
maxHartFramesPerTick
maxHartTraceBytes
```

Não criar budgets novos dentro do código sem atualização da especificação canônica.

---

## 13. Metas de desempenho

As seguintes propriedades são requisitos:

1. nenhum `std::thread` por dispositivo;
2. nenhum socket por dispositivo virtual;
3. nenhum timer do SO por dispositivo virtual;
4. nenhuma resolução de string por frame no caminho steady-state;
5. nenhuma busca global de catálogo por frame;
6. buffers de frame bounded;
7. filas bounded;
8. alocações steady-state evitadas no processamento normal de comandos padrão;
9. metadados comuns compartilhados por perfil;
10. runtime state compacto por instância;
11. tracing detalhado sem footprint relevante quando OFF.

Metas de benchmark iniciais:

```text
Case A: 1 bus / 1 device
Case B: 1 bus / 64 devices
Case C: 16 buses / ~1,000 devices
Case D: múltiplas sessões SharedHost
Case E: stress de comandos + telemetry OFF
Case F: stress de comandos + telemetry bounded ON
```

Registrar ao menos:

```text
CPU time
wall time
allocations
peak RSS
bytes/device
threads
wakeups
queue depth
frames/s
p50 command latency
p95 command latency
p99 command latency
```

Meta orientadora para perfil padrão:

```text
<= 4 KiB de estado mutável incremental por instância
```

excluindo metadados compartilhados, buffers globais da sessão e modelos físicos externos.

Se a meta não for atingida, documentar a causa e o benchmark antes de aceitar regressão.

---

## 14. Segurança e robustez

Todo input proveniente de transportes externos é não confiável.

Obrigatório:

- validar tamanho antes de ler;
- validar checksum;
- limitar frame;
- limitar clientes/endpoints;
- limitar filas;
- limitar diagnostics/traces;
- rejeitar command/address inválidos;
- evitar integer overflow;
- evitar leitura fora do payload;
- evitar crescimento de buffer controlado pelo peer;
- garantir shutdown idempotente;
- não bindar interface pública por default;
- não abrir serial/socket sem configuração explícita.

Para TCP de compatibilidade, loopback deve ser o default quando tecnicamente aplicável.

Exposição de rede deve exigir configuração explícita.

---

## 15. Migração do `process_simul`

### 15.1. Reaproveitar como conceito e fixtures

`lib/domain/hart/hart_command_registry.dart`

Ação:

```text
ADAPTAR
```

Reaproveitar:

- `HartCommandHandler`;
- `HartCommandContext`;
- registry sem switch central;
- registro/remoção independente;
- ideia de tombstone para impedir fallback acidental.

Destino:

```text
Core C++ / HartEngine
```

Não portar dependências Flutter.

### 15.2. Reaproveitar parser/codec

`lib/domain/hart/hart_payload_parser.dart`

Ação:

```text
ADAPTAR + PORTAR TESTES/GOLDENS
```

Reaproveitar:

- parsing tipado;
- validação de bounds;
- interpretações reutilizáveis;
- erros explícitos.

Implementar em C++ com readers/views bounded.

### 15.3. Reaproveitar framing

`lib/infrastructure/hart/hart_frame.dart`

Ação:

```text
ADAPTAR + USAR COMO ORÁCULO DE COMPATIBILIDADE
```

Reaproveitar:

- framing;
- checksum;
- short/long address;
- fixtures existentes;
- casos inválidos.

Não copiar alocações/estruturas Dart diretamente.

O limite atual utilizado pelo projeto de origem deve ser validado contra os requisitos do LasecSimul antes de virar constante canônica.

### 15.4. Reaproveitar comportamento do transmitter

`lib/infrastructure/hart/hart_transmitter.dart`

Ação:

```text
EXTRAIR SEMÂNTICA + TESTES
```

Mapear comportamento existente para:

```text
default HartDeviceProfile
+
standard command handlers
+
runtime state
```

Não manter `HartTransmitter` como subsistema paralelo depois da migração.

### 15.5. TCP server

`lib/infrastructure/hart/hart_comm.dart`

Ação:

```text
NÃO PORTAR COMO ARQUITETURA CENTRAL
```

O servidor atual é útil como:

- referência de compatibilidade;
- protocolo de integração;
- fixture para testes;
- origem para um futuro `HartTcpCompatibilityAdapter`.

No LasecSimul:

- não criar servidor por dispositivo;
- não permitir I/O real implícito;
- multiplexar endpoints;
- usar lifecycle central;
- usar ResourceGovernor.

### 15.6. Serial

`lib/infrastructure/hart/hart_serial_channel.dart`

`lib/infrastructure/hart/hart_serial_comm.dart`

Ação:

```text
POSTERGAR / ADAPTAR COMO EXTERNAL TRANSPORT
```

Não fazer do serial uma dependência do engine semântico.

### 15.7. Type conversion

`lib/infrastructure/hart/hart_type_converter.dart`

Ação:

```text
AUDITAR + INCORPORAR AO CODEC/FUNCTION REGISTRY
```

Remover duplicação entre conversão, parser e handlers.

### 15.8. Equipment repository

Conceito de `EquipmentRepository` e perfis de equipamentos.

Ação:

```text
ADAPTAR
```

No LasecSimul a fonte de autoria deve integrar:

```text
unified catalog
project schema
SimulationPlan
```

Não introduzir SQLite apenas para reproduzir o repositório do Flutter.

### 15.9. Riverpod/UI/SQLite/WebView

Ação:

```text
NÃO PORTAR
```

Essas camadas pertencem à arquitetura do aplicativo de origem.

Somente regras de domínio comprovadamente necessárias devem migrar.

---

## 16. Estratégia de compatibilidade

Antes de substituir a implementação atual, criar uma suíte de caracterização contra o `process_simul`.

Golden vectors devem incluir:

```text
valid short-address request
valid long-address request
checksum valid/invalid
unknown device
unsupported command
explicitly removed command
payload too short
payload too large
read PV
read identity
write supported parameter
write invalid parameter
multiple devices
same address on different buses
address collision on same bus
stop/restart
```

Quando o comportamento de `process_simul` conflitar com a arquitetura/especificação HART do LasecSimul, registrar a diferença.

Compatibilidade não autoriza transportar bug conhecido.

---

## 17. Fases de implementação

### Fase 0 — Baseline e caracterização

Antes de alterar comportamento:

- identificar o código HART atual do LasecSimul;
- documentar fluxos existentes transmitter/communicator;
- executar testes atuais;
- importar/criar golden vectors a partir de `process_simul`;
- registrar baseline de CPU/memória/threads;
- confirmar que FEAT-009 continua passando.

Saída:

```text
baseline documentado + testes de caracterização
```

### Fase 1 — Contratos do domínio

Implementar:

```text
HartDeviceProfile
HartProfileRegistry
HartCommandDescriptor
HartCommandRegistry
HartFunctionRegistry
HartPayloadReader/Writer
HartFrame codec
```

Ainda sem transportes reais.

### Fase 2 — PlanCompiler

Adicionar compilação para:

```text
HartProtocolPlan
HartBusPlan
HartDevicePlan
command dispatch tables
address resolution
signal bindings
runtime layout
```

Falhar a compilação em:

- perfil ausente;
- função ausente;
- handler duplicado;
- address collision;
- binding inválido;
- versão incompatível.

### Fase 3 — HartEngine virtual

Implementar:

```text
HartEngine
HartVirtualBus
device runtime arrays
dispatch
virtual-time timeout
bounded queues
diagnostic counters
```

Migrar o HART existente para o engine.

### Fase 4 — Perfis default

Converter o transmitter existente em perfil default.

Adicionar ao menos um segundo perfil/fixture significativamente diferente para provar extensibilidade.

O segundo perfil deve ser adicionável sem edição no dispatcher central.

### Fase 5 — Catálogo/UI/projeto

Integrar:

- discovery no catálogo;
- criação/remoção de instância;
- propriedades do perfil;
- bus/address;
- bindings;
- persistence;
- erros de perfil/versionamento.

A UI não deve conhecer handlers concretos.

### Fase 6 — TCP compatibility adapter

Somente após o engine virtual estar estabilizado.

Requisitos:

- opt-in;
- bounded;
- shutdown limpo;
- múltiplos dispositivos;
- sem thread por device;
- sem socket implícito;
- ResourceGovernor;
- testes de loopback e malformed input.

### Fase 7 — Thin client / SharedHost hardening

Executar benchmarks multi-sessão.

Verificar:

- thread count;
- RSS;
- wakeups;
- telemetry;
- backpressure;
- session isolation;
- client disconnect/reconnect;
- engine funcionando sem UI conectada.

### Fase 8 — Serial/PHY

Somente com requisito real confirmado.

Separar:

```text
semantic HART
serial byte transport
physical FSK/modem
```

Não declarar conformidade/interoperabilidade física sem testes contra hardware apropriado.

---

## 18. Testes obrigatórios

### Unitários

- registry de perfil;
- registry de comando;
- registry de função;
- composição include/exclude;
- duplicate registration;
- explicit removal;
- payload reader;
- payload writer;
- checksum;
- frame decoder;
- short address;
- long address;
- response bounds;
- invalid payload.

### Plan compiler

- multiple profiles;
- multiple instances same profile;
- conflict same bus/address;
- same address different bus;
- missing profile;
- incompatible version;
- missing function;
- invalid binding;
- duplicate identity;
- runtime layout stable.

### Runtime

- deterministic response;
- pause/resume;
- accelerated virtual time;
- stop/restart;
- multiple devices;
- multiple buses;
- multiple sessions;
- isolation;
- device with no traffic causes no periodic wakeup;
- unsupported command;
- command mutation through single-writer.

### Transport

- virtual mode opens zero host ports;
- TCP opt-in only;
- bounded clients;
- bounded RX;
- malformed frame;
- disconnect during frame;
- reconnect;
- shutdown while clients connected.

### Thin client

- UI disconnect does not stop engine unless requested;
- reconnect restores snapshot without replaying unbounded history;
- telemetry backpressure does not block simulation;
- detailed trace OFF has negligible footprint;
- structural edit follows plan invalidation rules.

### Fuzz/property

Aplicar fuzzing ao decoder/frame parser.

Invariantes mínimos:

```text
never OOB
never unbounded allocation
never infinite loop
never response larger than configured bound
invalid input cannot crash SimulationSession
```

---

## 19. Critérios de aceitação

A feature somente pode ser considerada concluída quando:

1. `protocol.hart.transmitter` e `protocol.hart.communicator` existentes funcionarem sobre o novo engine;
2. um segundo tipo de dispositivo HART for adicionado sem editar dispatcher central;
3. esse segundo tipo puder ser removido sem deixar código especial no dispatcher;
4. um comando custom puder ser registrado por módulo/profile sem editar `HartEngine`;
5. um comando puder ser explicitamente removido sem fallback silencioso;
6. funções de parsing reutilizáveis forem compartilhadas entre comandos;
7. múltiplas instâncias do mesmo perfil compartilharem metadados imutáveis;
8. bindings forem resolvidos para handles antes de RUN;
9. não existir busca por string no hot path HART;
10. virtual HART abrir zero sockets/serial/processos;
11. não existir thread/timer por dispositivo;
12. queues e buffers forem bounded;
13. duas `SimulationSession` com o mesmo polling address não interferirem;
14. endereço duplicado dentro do mesmo barramento for rejeitado;
15. teardown não deixar socket/thread/callback ativo;
16. testes de caracterização do comportamento migrado passarem;
17. fuzz tests do decoder não encontrarem crash/OOB;
18. benchmark SharedHost provar orçamento compatível com thin client;
19. traces HART OFF não criarem fila/buffer/thread dedicada;
20. documentação canônica e schemas correspondentes estiverem atualizados;
21. `node .spec/governance/check-specs.mjs` passar.

---

## 20. Critérios específicos de thin client

Para ser aprovado como adequado ao objetivo thin client:

- a Extension não pode conter o runtime HART;
- o Core deve continuar simulando com cliente desconectado;
- metadata de perfil deve ser cacheável;
- o cliente não deve receber todo frame HART por default;
- mudança visual não pode afetar virtual time;
- o número de dispositivos não pode determinar diretamente o número de threads;
- o número de dispositivos virtuais não pode determinar diretamente o número de sockets;
- memória por instância deve ser mensurada;
- idle cost deve ser mensurado;
- múltiplas sessões devem respeitar o mesmo ResourceGovernor;
- real I/O deve ser explicitamente habilitado e limitado.

---

## 21. Invalidation e autoria

A introdução desta feature deve reutilizar o mecanismo de invalidation existente.

Se os domínios atuais não forem suficientes, adicionar um domínio protocol/HART por alteração canônica correspondente.

Mudanças que exigem recompilação:

```text
add/remove device
change profile/version
change bus
change polling/unique address
change command composition
change structural parameter
change signal binding
enable/disable external endpoint estrutural
```

Mudanças potencialmente runtime-mutable:

```text
PV source value
tag quando explicitamente permitido
selected units
damping/configuração não estrutural
device status
command-writable parameter
```

Cada parâmetro deve declarar sua classe de mutabilidade.

---

## 22. Observabilidade

Counters baratos permanecem sempre disponíveis.

Trace detalhado deve ser opt-in por:

```text
session
bus
device
command
```

Quando ativo:

- usar buffer bounded;
- contar drops;
- nunca bloquear o simulation thread por consumidor lento;
- aplicar rate limit;
- não preservar histórico ilimitado.

---

## 23. Compatibilidade de projeto

Projetos existentes que usam os componentes HART atuais devem continuar carregando.

A migração pode mapear implicitamente:

```text
legacy protocol.hart.transmitter
        ↓
built-in profile: lasecsimul.hart.generic-transmitter@1
```

Esse mapeamento deve ser versionado e testado.

Salvar novamente o projeto não deve destruir propriedades legadas sem migração explícita.

---

## 24. Decisões que exigem validação durante implementação

Os itens abaixo não bloqueiam a criação do engine, mas não devem ser resolvidos por suposição:

### 24.1. Polling address zero

O comportamento esperado do ecossistema PACTware/endereço zero deve ser reproduzido e caracterizado.

Há histórico de comportamento ambíguo no projeto de origem.

Criar fixture antes de consolidar a regra.

### 24.2. Device identity

Confirmar a composição canônica de:

```text
manufacturerId
deviceType
deviceId
expanded device type
revision fields
```

e como será representada no profile schema.

### 24.3. Commands estendidos

Definir se command id interno será sempre 16-bit ou se haverá representação estruturada para comandos expandidos.

Não espalhar encoding especial pelos handlers.

### 24.4. FSK/modem físico

Não faz parte da primeira entrega.

Se necessário futuramente, criar feature/ADR específica.

### 24.5. Native plugin API

Antes de expor API pública adicional aos plugins, verificar se a ABI atual de devices comporta o registro requerido.

Se for necessária extensão ABI, criar ADR e manter versionamento/compatibilidade.

---

## 25. Arquivos/componentes esperados

A nomenclatura final deve respeitar a árvore real do Core, mas a separação recomendada é:

```text
core/
  hart/
    HartEngine.*
    HartProtocolPlan.*
    HartProfileRegistry.*
    HartCommandRegistry.*
    HartFunctionRegistry.*
    HartFrameCodec.*
    HartPayloadCodec.*
    HartVirtualBus.*
    HartDiagnostics.*

  transport/
    HartTransportEndpoint.*
    HartTcpCompatibilityAdapter.*
    HartSerialAdapter.*             # etapa futura

  plan/
    ... integração do HartProtocolPlan ...

devices/
  ... apenas plugins nativos HART que realmente necessitem DLL/SO ...

.spec/
  features/
    hart-device-engine.md
  schemas/
    ... profile/project additions ...
  benchmarks/
    ... SharedHost/HART benchmark contract ...
```

Não criar árvores paralelas se estruturas equivalentes já existirem.

---

## 26. Anti-patterns proibidos

Não aceitar implementação que contenha:

```text
switch gigante de command id no engine central
widget decidindo regra de protocolo
1 thread por HART device
1 timer por HART device
1 socket por device virtual
SQLite no hot path
filesystem no hot path
lookup de tag/string por frame
global singleton compartilhando device state entre sessões
unbounded queue
unbounded frame buffer
trace sempre ligado
porta TCP aberta automaticamente
serial aberto automaticamente
duplicação do HART antigo + HART engine novo em produção
plugin DLL obrigatório para todo perfil simples
hot reload estrutural improvisado durante RUN
```

---

## Aceitação

Os critérios normativos completos desta feature estão definidos nas seções
19, 20 e 27: compatibilidade com FEAT-009, extensibilidade sem editar o
dispatcher, isolamento, handles compilados, transportes virtuais sem recursos
do host, limites de filas/buffers, fuzz sem falhas e o gate de 64 instâncias em
SharedHost.

## 27. Regra de conclusão

A implementação deve demonstrar que a arquitetura funciona com a seguinte operação sem alterações no núcleo:

```text
1. registrar Profile A
2. registrar Profile B
3. criar 32 instâncias de A
4. criar 32 instâncias de B
5. executar comunicação virtual
6. remover B do projeto
7. recompilar
8. executar somente A
9. adicionar Profile C com comando vendor-specific
10. executar C sem editar o dispatcher central
```

Em SharedHost, a execução acima não pode criar threads ou sockets proporcionalmente às 64 instâncias virtuais.

Esse cenário é o gate arquitetural principal desta feature.

---

## Anexo A — Auditoria de primitivas e DSL semântica de comandos (FASE 8-19)

### A.1 Escopo e método

Verificado diretamente contra a fonte pública (não assumido da paráfrase de uma
tarefa anterior):

- `ININDII-UFU/EININDII07_PACTware_ProcessSimul`: `hrt/hrt_transmitter_v6.py`,
  `hrt/hrt_transmitter_v1.py`, `hrt/hrt_type.py`.
- `josuemoraisgh/process_simul`: `lib/domain/hart/hart_command_registry.dart`.

**Não auditado nesta sessão** (limite de orçamento, não esquecimento):
`hrt_transmitter_v2..v5.py`, `hrt_frame.py`, `hrt_enum.py`, `hrt_bitenum.py`,
`hart_payload_parser.dart`, `hart_transmitter.dart`, `hart_comm.dart`,
`hart_type_converter.dart`. A confirmação de que `v6` já é totalmente
declarativo (`COMMANDS` com `req/write/resp/after`) é direta; a alegação de que
`v1` **já** possuía o mesmo formato declarativo veio de um resumo automatizado
da ferramenta de fetch e não foi confirmada por diff byte-a-byte contra `v6` —
tratar a tabela de evolução abaixo como direcional até uma reauditoria com
leitura completa de `v2..v5`.

### A.2 Primitivas confirmadas em `hrt_transmitter_v6.py`

`COMMANDS` é o único ponto de configuração; cada comando é um dict opcional com
estágios `req`/`write`/`resp`/`after`. Tokens confirmados: `"$BODY"`, `"$SEL2"`,
`"$BODY[a:b]"` (slice compilado, offset inclusivo/fim exclusivo), `"$code"`
(dentro de `FOR_CODES`), literais HEX (`"FE"`, `"7FC00000"`), e chaves de
linha/variável (`"manufacturer_id"`, `"PROCESS_VARIABLE"`, ...). Estruturas
dict: `SET{row,value}`, `IF{EQ:[A,B],THEN,ELSE}`, `MAP{KEY,TABLE,DEFAULT}`,
`FOR_CODES{SRC,PREFIX,DO}`. Macros confirmadas: `IDENTITY_BLOCK` (10 campos),
`PV_UNIT_AND_VALUE`. `compile_commands()` pré-compila slices e valida hex antes
da execução; o motor de avaliação (`_eval_token()`) é genérico, sem
if/elif por comando.

### A.3 `hrt_type.py` — inventário de codecs confirmado

| Tipo | Função | Largura | Endian | Observação |
|---|---|---|---|---|
| UNSIGNED | `_hrt_type_hex2_uint`/`_uint2_hex` | 1-4 bytes | BE | zero-pad à esquerda |
| INTEGER | `_hrt_type_hex2_int`/`_int2_hex` | 2 bytes | BE | complemento de dois |
| SREAL/FLOAT | `_hrt_type_hex2_sreal`/`_sreal2_hex` | 4 bytes | BE | IEEE-754, `struct`-packed |
| PACKED ASCII | `_hrt_type_hex2_pascii`/`_pascii2_hex` | variável (6 bits/char) | BE bit-packed | maiúsculas, ASCII 0x20-0x5F, trunca/pad |
| DATE | `_hrt_type_hex2_date`/`_date2_hex` | 3 bytes | BE | DD/MM/YYYY, ano offset +1900 |
| TIME | `_hrt_type_hex2_time`/`_time2_hex` | 4 bytes | BE | precisão de milissegundo |
| ENUM/BIT_ENUM/BOOL | roteados por `hrt_type_hex_to`/`hrt_type_hex_from` | — | — | tabelas em `hrt_enum.py`/`hrt_bitenum.py`, **não auditadas nesta sessão** |

O algoritmo de packed-ASCII confirmado (máscara de 6 bits sobre o intervalo
0x20-0x5F, com dobra do bit 6) é o algoritmo padrão HART documentado, não uma
particularidade do PACTware — `HartTypeCodec` (ver A.5) o implementa de forma
independente e caracterizada por round-trip, não copiado às cegas (regra da
seção 17).

### A.4 `process_simul` `HartCommandRegistry` — mapeamento confirmado

| `process_simul` (Dart) | LasecSimul (C++) | Estado |
|---|---|---|
| `HartCommandHandler` | `IHartCommandHandler` | já existia, preservado |
| `HartCommandContext` | `HartCommandContext` + `HartExecutionVariables` (novo) | preservado + estendido |
| registro sem switch central | `HartCommandRegistry`/`setCommandProgramHook` | preservado + estendido |
| tombstone (`_removedCommands`) impedindo fallback para `_onUnknown` | **ainda não implementado** para o caminho DSL | gap identificado, não fechado nesta sessão (FASE 21/71) |
| `HartFunctionRegistry` (parsers nomeados reutilizáveis) | **ainda não construído como registry separado**; `HartVarId` cobre a mesma necessidade sem lookup por string | decisão consciente: o gate "zero string no hot path" já está satisfeito sem essa camada extra; construir o registry nomeado fica para quando um comando real precisar de função authoring-time por nome (FASE 78) |
| `HartPayloadCodec`/reader bounded | `HartPayloadReader`/`HartResponseBuilder` (`HartEngine.hpp`, já existiam) | reutilizados, nenhum codec duplicado |

### A.5 DSL semântica canônica — implementada

`core/src/protocols/HartCommandProgram.hpp/.cpp` (authoring IR + compilador +
executor) e `core/src/protocols/HartTypeCodec.hpp/.cpp` (codecs tipados
reutilizáveis: `Float32BE`, `UnsignedBE`, `PackedAscii`). Nós de authoring:
`HartExpr` (`RequestBody`, `BodySlice`, `HexConstant`, `Variable`, `LocalCode`)
e `HartStatement` (`Append`, `Set`, `If`/`EQ`, `Map`, `ForCodes`). `req` foi
deliberadamente **omitido** do executor: o `HartEngine` do LasecSimul é sempre
o dispositivo (responder), nunca o mestre, então não há requisição de saída a
compor; o campo é reservado no comentário do cabeçalho para um eventual papel
de mestre, mas nenhum código o percorre hoje.

Variáveis usam `HartVarId` (enum estável), resolvido para acesso direto a
campo — nenhuma string é comparada por frame. `HartCommandCompiler::compile()`
valida: alcance de `BodySlice` contra um limite declarado de requisição,
chaves duplicadas em `MAP`, bound de iteração de `FOR_CODES` (1-64), destino de
`SET` gravável (`Tag`, `PrimaryVariableUnit`, `PrimaryVariable` apenas) e
estimativa estática de pior caso de resposta. `HartCommandExecutor::execute()`
roda `write -> resp -> after` nessa ordem sobre uma cópia de trabalho de
`HartExecutionVariables`, rejeita qualquer slice fora dos limites do
`request` real (não apenas do bound estático) e nunca escreve bytes parciais
em caso de falha.

`IHartCommandHandler`/`HartCommandRegistry` nativos continuam disponíveis como
último recurso (`HART-FR-016`); a integração usa um hook opcional
(`HartEngine::setCommandProgramHook`) para que `HartEngine.hpp` não precise
depender do módulo DSL — adicionar/remover um comando compilado não exige
editar `HartEngine`.

### A.6 Matriz comando × primitiva (escopo desta sessão)

| Comando | Estágios usados | Primitivas | Handler nativo antes | Handler nativo depois |
|---|---|---|---|---|
| 0x00 Read Unique Identifier | resp | `IDENTITY_BLOCK` macro (Append×10) | switch central (bugado: retornava ASCII de `uniqueId`) | **nenhum** — DSL |
| 0x01 Read Primary Variable | resp | Append(Variable) ×2 | switch central (bug: faltava byte de unidade, resposta de 4 bytes) | **nenhum** — DSL, 5 bytes, corrigido |
| 0x03 Read Dynamic Variables And Loop Current | resp | Append ×9 (constantes + variáveis) | switch central (placeholder incorreto de 4 bytes fixos) | **nenhum** — DSL, 24 bytes, SV/TV/QV/loop = "not used"/NaN documentado |
| 0x0B Read Unique ID Associated With Tag | resp | `If`/`EQ` + `IDENTITY_BLOCK` macro ×2 | **nunca existiu** | **nenhum** — primeira implementação, via DSL |
| 0x21 Read Device Variables | resp | `ForCodes` + `If`/`EQ` | **nunca existiu** | **nenhum** — primeira implementação, via DSL |
| demais 55 comandos do catálogo de 60 IDs | — | — | não implementados (apenas descritor id+nome) | não implementados — inalterado, não superestimar |

0x0B e 0x21 não são "migrações de handler especial" no sentido literal — nunca
houve handler nativo para eles em LasecSimul; são a primeira implementação, e
comprovam que a DSL cobre exatamente os dois casos que a tarefa aponta como
prova arquitetural obrigatória (FASE 19/72/73), sem exigir opcode ad-hoc.

### A.7 Gaps conhecidos, não resolvidos nesta sessão

- `HartFunctionRegistry` nomeado, tombstones no caminho DSL, codecs
  `ENUM`/`BIT_ENUM`, `MAP` como estrutura compacta além de varredura linear
  (aceitável para tabelas pequenas atuais, não validado em escala).
- `installCommandPrograms()` hoje repete `encodePackedAscii`/parse de hex de
  `uniqueId` a cada `execute()` (alocação pequena e limitada, não ilimitada,
  mas não é o "zero alocação" ideal do hot path) — otimização pendente: mover
  o snapshot de `HartExecutionVariables` para `RuntimeDevice`, calculado uma
  vez em `loadPlan()`, com apenas PV/unit atualizados por chamada.
  Ver [[project_hart_device_engine_v2]].
- Restam 55 dos 60 comandos catalogados sem corpo implementado, benchmarks em
  escala, fuzzing do compilador/executor, e remoção de legado — FASE 20-30
  permanecem abertas. `HartCommunicationComponent` foi migrado para o hook
  nesta sessão (ver Anexo B); Property Inspector semântico também — Anexo B.

---

## Anexo B — Property Inspector do HART: auditoria e implementação (2026-09-11)

### B.1 Reconciliação do estado herdado

`PropertyInspectorViewProvider.ts` (commit `c8593239`) já usava a infraestrutura
oficial do VS Code (`vscode.WebviewViewProvider` + `registerWebviewViewProvider`
com `"type": "webview"` em `package.json`, seção `views`) e já reencaminhava
mutações pelo caminho normal `requestUpdateProperty` (undo/redo/persistência
compartilhados, não duplicados) — isso foi preservado integralmente.

O que a auditoria encontrou **não** implementado, apesar de o arquivo existir:

- `renderHartCollections` tratava `hartVariablesJson`/`hartCommandsJson` como
  duas tabelas de linhas soltas (`id`/`name`/`unit`/`source`), sem `role`,
  `type`, `direction`, `readable`/`runtimeMutable` — e usava um campo
  `source`/`function` livre equivalente ao antigo modo `Expression` que a
  arquitetura já havia retirado (seção 48).
- **`hartCommandsJson` nunca era lido pelo Core.** `HartCommunicationComponent
  ::setPropertyValue` só armazenava a string; não existia parser, não existia
  compilação, não existia instalação no `HartEngine`. Um comando "criado" pelo
  Inspector não tinha nenhum efeito no dispositivo rodando — a seção Commands
  inteira era inerte.
- `HartReferenceCatalog::installCommandPrograms()` (os 5 comandos DSL da
  sessão anterior) nunca era chamado por `HartCommunicationComponent` — mesmo
  os comandos 0x00/0x01/0x03/0x0B/0x21 não estavam acessíveis pelo componente
  usado de verdade pelo `protocol.hart.serial`/`protocol.hart.udp`.
- **Bug de persistência real, anterior a esta sessão**: o construtor de
  `HartCommunicationComponent` nunca lia `hartVariablesJson`/`hartCommandsJson`
  de `ComponentParams` — um projeto salvo com variáveis/comandos configurados
  voltava para `"[]"` a cada reabertura (violava a seção 38/Gate 12).
- **Bug real, também anterior**: `device.tag` nunca era preenchido a partir de
  `m_tag` (nem no construtor, nem em `rebuildConfiguredPlan`) — o comando
  0x0B sempre comparava contra `plan.id`, nunca contra a Tag configurada pelo
  usuário.
- Painel sem agrupamento de seções (tudo em uma única lista sob "Properties",
  apesar de `PropertySchema.group` já existir e não ser usado), sem suporte a
  `editor:"select"`/`"display"` (só text/number/checkbox), sem diagnóstico do
  compilador visível, sem guarda estrutural durante RUN.

### B.2 O que foi implementado nesta sessão

**Core** (`core/src/protocols/`):

- `HartEngine.hpp`: `HartVariableRole`, `HartVariableType`, `HartVariableDirection`
  e os campos correspondentes em `HartDevicePlan::VariableConfiguration`
  (`role`, `type`, `direction`, `readable`, `runtimeMutable`), aditivos
  (posição final da struct, nenhum call site existente quebrado).
- `HartCommandJson.hpp/.cpp` (novo): ponte JSON <-> DSL semântica para o
  subconjunto plano de authoring (`Hex Constant`/`Variable`/`Request Body`/
  `Body Slice` como passos de `resp`), com rejeição explícita de: JSON
  malformado, variável desconhecida, hex inválido, id de comando duplicado, e
  id de comando reservado (0x00/0x01/0x03/0x0B/0x21 — nunca pode ser
  sombreado por um comando custom).
- `HartReferenceCatalog::installCommandPrograms(engine, additional)` (nova
  sobrecarga): compila os 5 comandos built-in + os comandos custom
  fornecidos num único hook combinado; se QUALQUER comando custom falhar ao
  compilar, a instalação cai para **somente os built-ins** (nunca deixa um
  edit quebrado derrubar 0x00/0x01/0x03/0x0B/0x21) e devolve a mensagem de
  erro exata.
- `HartCommunicationComponent`: agora lê `hartVariablesJson`/`hartCommandsJson`
  do `ComponentParams` no construtor (corrige o bug de persistência),
  preenche `device.tag` (corrige o bug da Tag), parseia/valida/compila os
  comandos custom via `HartCommandJson`+`HartCommandCompiler`, expõe duas
  propriedades read-only novas (`hartVariablesStatus`, `hartCommandsStatus`)
  com a mensagem de erro exata do compilador, e rejeita write-ownership
  (`direction=Input && writable` é rejeitado com diagnóstico, nunca
  silenciosamente aceito com o campo zerado).
- `HartPlanCompiler::compile()`/`HartEngine::execute()`: um id de comando
  custom agora pode ser declarado por dispositivo (`commandConfigurations`)
  sem precisar estar no `HartDeviceProfile` compartilhado — a validação
  original ("override não declarado pelo perfil") permanece para
  disable/static-response de comandos que o perfil *conhece*; só a
  declaração aditiva pura (enabled, sem override) de um id novo passou a ser
  aceita. Sem essa mudança, nenhum comando autorado pela UI conseguia
  despachar (ver B.4).
- `HartCommunicationComponent::propertySchema()`: os 4 campos JSON/status
  passaram a ter `PropertySchemaHidden` — não aparecem mais na property sheet
  genérica do canvas (que os mostraria como texto JSON cru, um segundo editor
  competindo com o painel estruturado), mas continuam totalmente
  legíveis/graváveis via IPC e via o próprio Inspector.

**Extension** (`extension/src/ui/`):

- `batchProperties.ts`: `propertyFieldKindFromEditor` movido de `main.ts`
  (só existia lá) para cá — agora é a MESMA função usada pela property sheet
  do canvas e pelo painel lateral (seção 46: um único dispatch de
  `editor` -> widget, não dois mantidos à mão separadamente). `main.ts`
  passou a importar em vez de duplicar.
- `hartInspectorSections.ts` (novo, sem dependência de `vscode`, testável em
  Node): modelo de linhas (`HartVariableRow`, `HartCommandRow`,
  `HartCommandStepRow`), parse/serialize simétricos ao JSON que o Core
  espera, e os renderers HTML dos editores de Variables/Commands — incluindo
  o script client-side (reconstrói as linhas a partir do DOM atual a cada
  commit, sem manter uma segunda cópia autoritativa).
- `PropertyInspectorViewProvider.ts`: reescrito para agrupar campos por
  `schema.group` (título por seção, em vez de lista única), suportar
  `editor:"select"` (dropdown com `schema.options`) e `"display"`
  (read-only), esconder os 4 campos HART "crus" do fluxo genérico, e montar
  as seções Variables/Commands/Diagnostics via `hartInspectorSections.ts`.
  Ganhou `setSimulationStatus()`, chamado por `coreLifecycle.ts::setSimulationStatus`
  (mesmo padrão de `lasecPlotManager`/`serialTerminalManager`) — controles
  estruturais (Add/Remove, `id`, `direction`, `type`) desabilitam durante
  RUN/PAUSE; campos com `runtimeMutable=true` continuam editáveis.

### B.3 Editor de Variables — modelo real exposto

`id` (variableId estável, somente-leitura após criado) · `name`
(displayName) · `role` (select: PV/SV/TV/QV/Internal/DeviceSpecific/
VendorSpecific/Custom) · `type` (select: Float32/UInt8/UInt16/Int16/
PackedAscii/Bool — só os tipos que `HartTypeCodec` de fato implementa) ·
`direction` (select: Internal/Input/Output) · `unit` · `value` · `readable`/
`writable`/`runtimeMutable` (checkboxes). `writable` desabilita
automaticamente quando `direction=Input`, com explicação inline. Um
`expression` legado (authoring computado via SignalExpression, pré-existente)
sobrevive ao round-trip sem ganhar um campo dedicado no editor novo — não é
mais um "modo de origem" de primeira classe, mas dado existente nunca é
descartado silenciosamente.

**Gap real, documentado, não fechado**: `direction=Input`/`Output` é
armazenado e validado (write-ownership), mas **não materializa uma porta no
Signal Graph** — isso exigiria estender o mecanismo `ComponentPinSpec`/
`DynamicPinGroupSpec` (`lasecsimul/Types.hpp`) para portas dirigidas por uma
coleção JSON (hoje ele só deriva contagem de pinos de UMA propriedade
numérica), preservação de fios ao trocar direction, e mudanças no
`PlanCompiler`. Isso é um recurso estrutural grande e separado — o Gate 3 do
contrato original (mudar direction e ver a porta aparecer/fio conectável)
**não está pronto**; a validação write-ownership (Gate 9) está.

### B.4 Editor de Commands — modelo real exposto

Cada comando: `id` (reservado 0x00/0x01/0x03/0x0B/0x21, somente-leitura após
criado) · `name` · `enabled` · lista ordenável de passos de `Response`:
`Hex Constant` (bytes), `Variable` (select sobre o conjunto fixo de
`HartVarId`), `Request Body`, `Body Slice` (offset/length) — reordenar via
&uarr;/&darr;, adicionar/remover por passo. Um indicador "Compiler: ✓ Valid /
✗ &lt;mensagem exata&gt;" fica sempre visível, alimentado por
`hartCommandsStatus` (Core).

**Gap real, documentado, não fechado**: `write`/`after` e os primitivos de
controle de fluxo (`If`/`Map`/`ForCodes`) não têm editor na UI ainda — só
`resp` com os 4 passos planos acima. Isso cobre o padrão real da maioria dos
comandos "leitura simples" (inclusive prova os Gates 6/7/8/10 abaixo), mas
não FOR_CODES/IF/MAP pela UI. Referenciar uma variável HART *customizada*
(criada pelo usuário) de dentro de um comando também não é suportado ainda —
só o conjunto fixo de `HartVarId` (PV via a convenção pré-existente
`id="PV"`/`"primary"` continua funcionando, ver B.5 Gate 2). Ambos exigiriam
estender `HartCommandJson` com os nós adicionais e, para variáveis
customizadas, um novo `HartExpr::Kind::UserVariable` resolvido por handle no
executor — desenho já esboçado, não implementado (ver [[project_hart_device_engine_v2]]).

### B.5 Gates — resultado real (não assumido)

Gates comprovados por teste automatizado (Core `hart_engine_test` +
Extension `hartInspectorSections.test.ts`, ambos verdes, e compilação limpa
de host+webview):

- **Gate 2 (criar variável, ler via comando)**: uma variável `id="PV"` com
  `value`/`expression` chega ao comando 0x01 padrão exatamente como salva —
  caracterizado ponta a ponta em `HartEngineTest.cpp` (constrói
  `HartCommunicationComponent` com `hartVariablesJson` real, executa 0x01,
  confere o float exato).
- **Gate 6/7 (criar comando novo via primitivas semânticas, sem editar
  `HartEngine`/dispatcher)**: comando custom com passos `Variable`+`Hex`+
  `BodySlice` compila e despacha ponta a ponta sem tocar `HartEngine.cpp`
  nem `PropertyInspectorViewProvider.ts` para esse comando específico —
  caracterizado em `HartEngineTest.cpp` ("custom command 128... executes end
  to end through the JSON bridge") e replicável pela UI (mesmo parser/
  compilador).
- **Gate 8 (diagnóstico do compilador)**: um `BodySlice` além do limite
  reporta erro (`installCommandPrograms` retorna `.error` não vazio) e os
  built-ins continuam respondendo — caracterizado em
  `HartEngineTest.cpp` ("a broken custom command reports a diagnostic" /
  "built-ins survive a broken custom command install").
- **Gate 12 (save/reopen)**: uma SEGUNDA instância de `HartCommunicationComponent`
  construída com os MESMOS `ComponentParams` (simulando reabrir o projeto)
  produz a mesma resposta 0x01 — prova direta do bug de persistência
  corrigido.
- **Gate 9 parcial (write-ownership)**: validado para os alvos `SET`
  atualmente graváveis (`Tag`/`PrimaryVariableUnit`/`PrimaryVariable` no
  `HartCommandCompiler`, e `direction=Input && writable` rejeitado em
  `HartCommunicationComponent::rebuildConfiguredPlan`); não validado ainda
  para `SET` de uma variável customizada, porque isso não existe na DSL
  ainda (ver B.4).

Gates **não executados** (exigem VS Code Extension Development Host
interativo, que este agente não tem como abrir/clicar) — sem evidência,
portanto não reivindicados como prontos:

- Gate 1 (inspecionar visualmente as 6 seções no canvas real).
- Gate 3 (porta Input/Output aparecendo/conectável no canvas) — também
  bloqueado pela lacuna estrutural da B.3.
- Gate 5 (mensagem de rejeição estrutural durante RUN visível na tela real —
  a lógica de desabilitar os controles está implementada e testada
  isoladamente, mas o clique real não foi reproduzido).
- Gate 11 (Undo/Redo manual) — a mutação usa o MESMO pipeline
  `requestUpdateProperty` de qualquer outra propriedade (então undo/redo
  deveria "vir de graça"), mas isso não foi confirmado clicando.
- Gate 13 (encapsulamento `.lssubcircuit`) — não auditado nesta sessão.
- Gate 14 (temas/resize) — CSS usa variáveis de tema do VS Code
  (`--vscode-*`) e `flex-wrap`/`overflow-wrap` para não quebrar em painel
  estreito, mas não foi visualmente confirmado.

### B.6 Checklist do contrato original (seção 90) — estado real

Feito e comprovado: painel persistente via infraestrutura oficial · sem modal
HART canônico competindo · fluxo de seleção canônico (`setSelection`
alimentado por `state.schematicState`, não DOM scraping) · seções agrupadas ·
`variableId` estável (não-editável após criado) · Internal/Input/Output
armazenado e validado · edição estrutural bloqueada durante RUN · campos
`runtimeMutable` seguem a regra do Core · comandos editáveis
semanticamente (subconjunto plano) · `Body`/`BodySlice`/`Variable`/`Hex`
representados · diagnóstico do compilador exposto · nenhum bytecode exposto
· commit-on-change (não por tecla) · sem polling do projeto inteiro ·
Inspector nunca é fonte de verdade · testes Core e Extension passam.

Parcial ou pendente: `req`/`write`/`after` e `If`/`Map`/`ForCodes` sem editor
· referência a variável customizada dentro de comando · porta Signal Graph
para Input/Output · encapsulamento `.lssubcircuit` não auditado · Undo/Redo,
temas, resize e os demais gates que exigem Extension Development Host
interativo não confirmados manualmente · consolidação do editor canônico é
parcial (dispatch de `kind` unificado; os dois renderers HTML continuam
fisicamente separados, um DOM client-side e um HTML string server-side —
unificação completa exigiria mover a sidebar para o mesmo modelo de
webview+DOM do canvas, fora do escopo desta sessão).

### B.7 Próxima ação

Continuar as fases HART pendentes (FASE 20-30): migrar mais comandos do
catálogo de 60 usando `HartReferenceCatalog::commandProgramDefinitions()`
como molde; depois, se ainda relevante, fechar os gaps do Inspector acima
(`UserVariable`, `If`/`Map`/`ForCodes` na UI, porta Signal Graph) antes de
tentar os gates que exigem Extension Development Host interativo. Não
declarar o HART Device Engine concluído enquanto os 55 comandos restantes,
benchmarks, fuzzing e remoção de legado continuarem pendentes.
### Correção arquitetural v2 — ownership de valor e portas de sinal

O modelo público de `HartVariable` possui somente identidade (`variableId`,
`name`), metadata (`role`, `type`, `unit`) e ownership do valor:
`Internal | Input | Output`. `Internal` persiste `value`; `Input` recebe o
valor do Signal Graph; `Output` publica o valor no Signal Graph. Expressões,
funções de transferência, Modbus e controladores são blocos externos ligados
por fios, nunca modos da variável HART.

`Input` e `Output` materializam `SignalPortDescriptor` genérico, com id estável
derivado de `variableId`; `Internal` não materializa porta. Os campos legados
`readable`, `writable`, `runtimeMutable` e `required` não fazem parte da UX
normal nem da representação canônica. O parser aceita dados antigos apenas
para migração; acesso e requisitos devem vir do profile/schema e das
semânticas dos comandos.

Comandos podem referenciar variáveis de usuário pelo mesmo `variableId` salvo
no Inspector. O nome exibido é apenas um rótulo de seleção e renomeá-lo não
altera bindings.

Esta seção supersede as descrições históricas B.3/B.5/B.6 que classificavam as
portas de sinal e referências de usuário como gaps: o plano efetivo agora
materializa e executa essas portas no Core.

Na compilação do plano, cada porta HART é materializada no Signal Graph com o
id `hart.<componentIndex>.<variableId>`. Portas `Input` são blocos `Probe` e
portas `Output` são blocos `ExternalInput`; o índice de componente é apenas o
namespace da instância e o identificador da variável permanece estável mesmo
quando o nome exibido muda.

---

## Anexo C — Auditoria completa e bidirecional do Property Inspector (2026-09-11, sessão 3)

### C.1 Reconciliação

Esta sessão começou com trabalho concorrente NÃO commitado em progresso:
suporte multi-perfil HART (`HartReferenceCatalog::registerProfiles`/
`makeProfile`, `profileId` por instância), portas Signal Graph reais para
Input/Output (`HartCommunicationComponent::signalPorts()`,
`SignalPortDescriptor`, `HartEngine::setVariableInput`/`variableValue`,
mudanças em `core/include/lasecsimul/IComponentModel.hpp`/`Signal.hpp` e
`core/src/session/SimulationSession.*`), remoção de `readable`/`writable`/
`expression` do modelo canônico de variável, `HartExpr::Kind::UserVariable`
(comandos referenciando variáveis criadas pelo usuário), e um novo módulo
`extension/src/dsl/` (DSL textual de circuito inteiro, comando "Aplicar DSL
ao Esquemático"). Nada disso foi revertido; nenhum arquivo fora do escopo
HART/Property-Inspector foi tocado (TDPS/Ctrl continuam intocados, conforme
`extension/src/catalog/packageSanitizers.ts` permanece modificado e não
staged por este agente).

### C.2 Bugs reais encontrados e corrigidos (não apenas "compila")

1. **Colisão silenciosa entre comando custom e fallback auto-gerado.**
   `commandProgramDefinitions()` passou a gerar um programa "echo body" para
   todo id catalogado sem handler dedicado (55 dos 60). `installCommandPrograms
   (engine, additional)` copiava os built-ins e usava
   `std::unordered_map::emplace` para inserir os comandos custom —
   `emplace` nunca sobrescreve uma chave existente. Resultado: um comando
   custom autorado para qualquer um desses 55 ids compilava com sucesso
   (`installed.success == true`, nenhum erro reportado) e NUNCA era
   despachado — o fallback "echo body" continuava respondendo, silenciosamente.
   Encontrado porque o teste original desta feature usava id 128 (== 0x80,
   "Vendor Read Configuration") como "id custom arbitrário" sem perceber a
   colisão. Corrigido: `(*combined)[id] = std::move(compiled.program)`
   (sobrescreve). Regressão coberta em `HartEngineTest.cpp` com comentário
   explícito apontando a causa raiz, para que uma futura reintrodução de
   `emplace` falhe o teste, não apenas "funcione por acaso".
2. **`HartCommandJson::toJson` descartava silenciosamente um passo
   `UserVariable`.** O `switch` sobre `HartExpr::Kind` não tinha `case
   UserVariable` (adicionado depois do `switch` original); o efeito era
   remover esse passo da serialização sem marcar `"unsupported": true` —
   exatamente a classe "parece ok, perde dado" que esta auditoria existe pra
   achar. Corrigido; teste de round-trip adicionado.
3. **`dslDocument` (módulo `extension/src/dsl/dslCommands.ts`) nunca era
   limpo.** `isDslDocumentOpen()` ficava `true` para sempre depois do
   primeiro uso de "Editar circuito em DSL", mesmo após aplicar ou fechar a
   aba — afetando `commitOpenDslIfPresent()` (gate de Save/Run) para sempre
   depois disso, e tornando inutilizável qualquer sinal "draft está aberto"
   que uma UI (como o Property Inspector) precisasse consultar. Corrigido com
   um listener em `vscode.workspace.onDidCloseTextDocument`.

Nenhum destes 3 bugs foi introduzido por esta sessão — os dois primeiros são
efeito colateral de trabalho concorrente ainda sem testes de regressão
próprios; o terceiro é um bug de nascença do módulo DSL novo. Todos foram
corrigidos, não apenas relatados, conforme a instrução de autonomia da tarefa.

### C.3 Conflito DSL vs. Property Inspector (seções 108-110 do enunciado)

Investigado end-to-end lendo `dslCommands.ts`/`DslReconciler.ts`: o DSL
textual é "propose-and-apply" — abrir o editor (`openDslCommand`) cria um
`vscode.TextDocument` independente com um snapshot serializado; nada em
`state.schematicState` muda até `commitDslCommand` (que substitui o
Authoring Model inteiro a partir do texto). Achado real: como o Property
Inspector edita `state.schematicState` diretamente e imediatamente
(pipeline `requestUpdateProperty` normal), uma edição feita no Inspector
**enquanto** um draft DSL não aplicado está aberto seria silenciosamente
sobrescrita na próxima vez que esse draft for aplicado (o draft não sabe que
o Inspector mudou algo nesse meio-tempo). Isso corresponde exatamente ao
cenário do enunciado (seção 109).

Resolvido seguindo a preferência arquitetural explícita do enunciado ("DSL
draft = editing authority"): `PropertyInspectorViewProvider.setDslDraftOpen()`
(novo), acionado via `onDslDraftOpenChanged` (novo, em `dslCommands.ts`) nos
dois pontos em que o estado do draft muda (abrir/fechar). Enquanto um draft
está aberto, o painel inteiro renderiza somente leitura com um banner
explicando por quê, e o handler de mensagens do lado do host rejeita
qualquer `setProperty` que ainda chegue (defesa em profundidade contra uma
Webview que não tenha re-renderizado a tempo). Não foi implementado um
mecanismo formal de "mutation → DSL patch" (a alternativa que o enunciado
também permite) — read-only é suficiente e mais simples, e é a opção que o
próprio enunciado chama de preferência original.

Limitação conhecida, documentada: o banner cobre "draft aberto" (uma aba com
`languageId === "lasecsimul-dsl"` existe), não "draft sujo desde o último
apply" — depois de aplicar, o painel continua bloqueado até a aba ser
fechada, mesmo que o texto agora reflita exatamente o Authoring Model atual.
Mais conservador que o estritamente necessário, mas seguro (nunca permite a
divergência silenciosa que a seção 109 descreve) e simples de raciocinar.

### C.4 Arquitetura confirmada por leitura direta de código (não suposição)

- **Fonte canônica de propriedades**: `PropertySchema` (Core,
  `lasecsimul/Types.hpp`) → `PropertySchemaEntry` (Extension,
  `ui/webview/model.ts`) é a ÚNICA fonte usada tanto pela property sheet do
  canvas (`main.ts::renderPropertyField`/`resolvePropertyFields`) quanto pelo
  painel lateral (`PropertyInspectorViewProvider::renderField`). Confirmado:
  nenhum dos dois mantém uma segunda lista de campos por `typeId` — ambos
  iteram `descriptor.propertySchema` genericamente.
- **Dispatch de `kind`**: unificado nesta linha de trabalho
  (`propertyFieldKindFromEditor` movido de `main.ts` pra
  `batchProperties.ts`, importado por ambos). Os DOIS renderers continuam
  fisicamente separados (um manipula DOM client-side, o outro gera uma
  string HTML server-side) — unificar isso de verdade exigiria portar a
  sidebar pro mesmo modelo de webview+script do canvas, o que é uma
  refatoração maior, fora do escopo seguro desta sessão (ver C.6).
- **Seleção canônica**: `state.selectedComponentIds`/`state.schematicState`
  é a única fonte; `propertyInspectorView.setSelection()` é alimentado pelos
  mesmos pontos que já existiam (`requestUpdateProperty` handler,
  `selectComponent` handler) — sem DOM scraping, sem polling.
- **Mutação canônica**: TODA edição de propriedade (canvas ou sidebar) passa
  por `requestUpdateProperty` → `pushPropertyToCore` → undo/redo/persistência
  compartilhados. O painel lateral nunca tem um caminho de mutação próprio.
- **Zero switch por `typeId`** no renderer genérico — a única ramificação por
  tipo é `isHart` para as duas coleções semânticas (Variables/Commands), que
  o próprio enunciado (seção 135) aceita como exceção legítima ("specialized
  editor... for genuinely complex semantic collections").
- Isto confirma estruturalmente a propriedade da seção 134 ("adicionar um
  componente novo com PropertyDescriptors padrão não deveria exigir nova tela
  no Inspector") para QUALQUER `typeId` cujo schema seja padrão — Ctrl,
  elétrico, PLC/Modbus, `.lsdevice` incluídos — sem precisar re-verificar tipo
  por tipo manualmente, porque a prova é estrutural (ausência de
  `if (typeId === ...)`), não uma amostragem.

### C.5 Testes adicionados (reais, executados, verdes)

Core (`hart_engine_test`, MSVC Release — `HART engine contracts: PASS`):
correção de `registerProfiles` vs. `registerGenericProfile` no teste de
referência; bytes golden de identidade atualizados para os valores reais do
perfil atual; regressão explícita para o bug de colisão de comando (C.2.1);
round-trip de `toJson` para `UserVariable` (C.2.2); gate de cobertura de
editor kind rodando sobre `HartCommunicationComponent::propertySchema()`
para os modos Serial e UDP (seção 117/120/134, ver C.5 nota de escopo).

Extension (`npm test`, host+webview TypeScript limpos, **449 verificações,
0 falhas** em toda a suíte existente — nenhuma regressão introduzida):
`hartInspectorSections.test.ts` (11 casos, já existentes, revalidados contra
o modelo Core atualizado) + novo teste de cobertura em `UnifiedCatalog.test.ts`
que itera o catálogo REAL carregado por `loadUnifiedCatalog` (sem Core) e
falha se qualquer `propertySchema` estático usar um `editor` que
`propertyFieldKindFromEditor` não reconheceria.

**Nota de escopo honesta sobre os gates de cobertura**: o catálogo estático
(`loadUnifiedCatalog`, sem processo Core) só carrega `propertySchema` pra 6
das 68 entradas atuais (manifests de device/subcircuito autorados
estaticamente) — os demais tipos (elétrico, HART, PLC/Modbus) declaram seu
schema em C++ e só chegam ao catálogo em runtime via
`attachPropertySchemas()`, que faz IPC contra um Core vivo. Não existe nesta
sessão um harness de teste que suba o Core e faça esse round-trip em Node,
então a cobertura automática de editor-kind para esses tipos fica limitada a:
(a) o gate C-side já citado, específico de `HartCommunicationComponent`; (b)
a prova estrutural de C.4 (nenhum dispatch por `typeId`, então o MESMO
`renderField` genérico atende qualquer schema, HART ou não). Construir um
harness de integração Core-IPC-em-Node é um esforço genuinamente separado e
maior (levantar processo, handshake, ciclo de vida) — não implementado aqui;
registrado como próxima ação concreta, não como "future work" vago.

### C.6 Matriz final (contrato original, seção 143)

| Area                    | PASS | PARTIAL | BROKEN | MISSING | BLOCKED_EXTERNAL |
|-------------------------|-----:|--------:|-------:|--------:|------------------:|
| Generic properties      | ✓ (arquitetura, testes automatizados) | seleção/undo/tema não confirmados clicando | — | — | Gates 1/5/11/14 (GUI) |
| Ctrl                    | — | — | — | não auditado propriedade-a-propriedade nesta sessão | requer varredura manual ou harness Core-IPC |
| HART device (General/Identity/Addressing) | ✓ | — | — | — | — |
| HART variables          | ✓ (id estável, role/type/direction, ownership, UserVariable em comandos) | portas materializam mas não confirmadas clicando no canvas | — | — | Gate 3 visual |
| HART commands           | ✓ (resp plano: Hex/Variable/Body/BodySlice, diagnóstico, override corrigido) | `write`/`after`/If/Map/ForCodes sem editor | — | não expostos na UI | — |
| .lssubcircuit            | — | encapsulamento (props expostas vs. internals) não auditado nesta sessão | — | — | — |
| Electrical               | — | — | — | não auditado propriedade-a-propriedade | requer varredura manual ou harness Core-IPC |
| PLC/Modbus               | — | — | — | não auditado propriedade-a-propriedade | requer varredura manual ou harness Core-IPC |
| Plugins (.lsdevice)      | — | genérico por arquitetura (C.4), não testado com um plugin real | — | — | — |
| Line/Tunnel              | — | — | — | não auditado nesta sessão | — |
| Save/reopen              | ✓ (HART: teste real reconstruindo o componente com os mesmos ComponentParams) | outros tipos não teste-reabertos nesta sessão | — | — | — |
| RUN policy               | ✓ (HART: guard genérico incluindo agora o draft DSL) | guard genérico fora do HART (propriedades `affectsPinCount`/estruturais de outros tipos) não auditado/testado | — | — | — |
| Undo/Redo                | ✓ (arquitetural: mesmo pipeline de qualquer propriedade) | não confirmado clicando | — | — | Gate 11 |
| DSL integration          | ✓ (conflito identificado e corrigido: read-only durante draft, bug de lifecycle corrigido) | — | — | — | — |

### C.7 Por que os itens não-PASS não foram fechados

- **Ctrl/Electrical/PLC-Modbus/Line-Tunnel, auditoria propriedade-a-propriedade**:
  exigiria ou (a) leitura manual de cada `propertySchema()` em C++ nesses
  domínios comparada campo a campo com o que a UI genérica realmente
  renderiza (dezenas de tipos, centenas de campos — múltiplas sessões de
  trabalho reais, não uma tarefa de minutos), ou (b) um harness de teste que
  suba o Core e faça `attachPropertySchemas()` de verdade em Node. Nenhum dos
  dois foi construído aqui. A prova estrutural de C.4 dá confiança de que a
  ARQUITETURA está correta (mesmo dispatch genérico pra todos), mas não
  substitui verificar que cada campo específico tem o `editor`/`options`
  certos. Próxima ação concreta: escolher entre (a) uma varredura manual
  dirigida por catálogo (visitar cada `*Component.cpp` e listar
  `propertySchema()`) ou (b) construir o harness Core-IPC-em-Node -- (b) é
  mais caro de construir mas paga dividendos permanentes (o mesmo gate de
  cobertura de C.5 passaria a cobrir 68/68 entradas, não 6/68 + o caso HART
  isolado).
- **`.lssubcircuit` encapsulamento, Line/Tunnel**: não teve nenhuma
  investigação começada nesta sessão (tempo). Próxima ação: repetir o
  método de C.4 (ler o código de seleção/renderização pra esses tipos
  específicos) antes de assumir que funcionam.
- **Gates 1/3/5/11/14 (visual/clique real)**: `BLOCKED_EXTERNAL` genuíno —
  este agente não tem VS Code Extension Development Host interativo
  disponível. Toda a lógica que esses gates exercitariam foi testada
  isoladamente (ver C.5) e por leitura de código, nunca reivindicada como
  clicada de verdade.

### C.8 Arquivos tocados nesta sessão (além dos já listados no Anexo B)

Modificados: `core/src/protocols/HartCommandJson.cpp`,
`core/src/protocols/HartReferenceCatalog.cpp`,
`core/test/core/protocols/HartEngineTest.cpp`,
`extension/src/catalog/UnifiedCatalog.test.ts`, `extension/src/extension.ts`,
`extension/src/ui/views/PropertyInspectorViewProvider.ts`,
`extension/src/dsl/dslCommands.ts` (arquivo novo de outro agente, ainda não
commitado; só o bug de lifecycle de C.2.3 foi corrigido, resto preservado
intacto), `.spec/features/hart-device-engine.md` (este Anexo). Nenhum
arquivo de TDPS/Ctrl/QEMU foi tocado ou commitado por este agente.

---

## Anexo D — Lasec DSL para HART Commands, correções reais, e estado master (2026-09-11, sessão 4)

Esta sessão recebeu uma tarefa de escopo deliberadamente enorme: concluir de
ponta a ponta a Lasec DSL unificada (circuitos + comandos HART), Visual⇄DSL,
Property Inspector completo em todos os domínios (Ctrl/elétrico/PLC-Modbus/
plugins/Line-Tunnel), Command Graph visual, migração de todos os ~60
comandos HART, remoção de legado, fuzzing e benchmarks. Isso não é uma tarefa
de uma sessão -- é um roadmap de produto de múltiplas semanas. Em vez de
fingir completude ou recusar o trabalho, esta sessão fez progresso real,
testado e verificado no que julgou ser a fatia de maior alavancagem --
**HART Command DSL/Graph/Compiler**, explicitamente marcada como "área
central" pela própria tarefa -- e reporta honestamente o restante como
`IN_PROGRESS`, nunca como `DONE` sem evidência.

### D.1 O que foi genuinamente concluído e comprovado nesta sessão

1. **`HartCommandJson` (Core) ganhou o vocabulário completo.** Antes: só
   `hex`/`variable`/`body`/`bodySlice` em `responseSteps` plano. Agora:
   `writeSteps`/`responseSteps`/`afterSteps`, com `set`/`if`/`map`/`forCodes`
   recursivos, parseados e serializados (`toJson()`) simetricamente. Testado:
   parse → compile → execute → `toJson()` → re-parse → re-compile → MESMO
   byte de saída (`HartEngineTest.cpp`, bloco "Full statement vocabulary
   through JSON").
2. **Existe agora um parser real da Lasec DSL para corpos de comando HART**
   (`extension/src/dsl/HartCommandDsl.ts`), reaproveitando o `lex()`
   exportado de `DslParser.ts` -- mesma camada léxica do DSL de circuito, não
   uma segunda linguagem inventada do zero (princípio "ONE LASEC DSL"
   respeitado no nível que importa: o léxico; a gramática acima dele é
   deliberadamente separada porque um corpo de comando HART é um pipeline de
   transformação de bytes limitado, não topologia de circuito). Suporta:
   cadeias (`A -> B -> out`), inferência leitura/escrita pela direção da seta
   (`Variable -> ... -> out` = leitura; `in[...] -> ... -> Variable` =
   escrita), slices (`in[a:b]`/`in[a]`), literais hex (`hex("...")`),
   `if <expr> == <expr> { ... } else { ... }`, expansão fria do macro
   `IdentityBlock` (10 campos, idêntico ao `hartIdentityBlockMacro()` em
   C++), e fallback para variável de usuário por nome quando o identificador
   não é um `HartVarId` conhecido -- mesma regra do lado JSON/C++.
   10 testes unitários reais (`HartCommandDsl.test.ts`), incluindo rejeição
   atômica de DSL inválida (chave faltando, seta pendente, identificador
   solto sem seta, slice invertido -- nenhum produz um corpo parcial).
3. **Prova cross-language de que 0x0B é DSL-representável, byte a byte.** A
   fonte DSL equivalente a 0x0B foi parseada no lado TypeScript (produzindo
   um JSON específico, testado), esse MESMO JSON foi fixado como literal em
   `HartEngineTest.cpp` e compilado/executado no lado C++, produzindo os
   bytes IDÊNTICOS ao AST manual de 0x0B já existente (match de tag e
   mismatch de tag, ambos). Isto é o "FASE 72 gate" (seção 72 do enunciado)
   fechado para este comando -- a primeira vez que um comando migra pela DSL
   de verdade, não por C++ manual reclassificado como "migrado".
4. **Dois bugs reais adicionais encontrados e corrigidos**, ambos com
   regressão testada:
   - `HartExpr::Kind::UserVariable` sempre codificava como Float32BE (4
     bytes) independente do `HartVariableType` declarado da variável --
     UInt8/UInt16/Int16/Bool produziam bytes errados no fio. Corrigido para
     despachar por tipo real (`HartCommandProgram.cpp::evalExpr`);
     `PackedAscii` fica explicitamente rejeitado (erro, não silenciosamente
     errado) até o modelo ganhar um slot de valor textual -- gap real,
     documentado, não escondido.
   - Um id de comando custom colidindo com qualquer um dos 55 ids
     padrão/vendor sem handler dedicado derrubava `HartPlanCompiler::compile()`
     inteiro ("duplicate HART command override"), silenciosamente
     desabilitando TODOS os comandos daquele dispositivo -- não só o
     colidente. Corrigido em `HartCommunicationComponent::rebuildConfiguredPlan()`
     (a entrada pré-scan não duplica mais um id já declarado). Regressão:
     comando custom 152 (== 0x98 "Vendor Keepalive") agora sobrescreve
     corretamente o fallback e mantém 0x01/0x0B/etc. funcionando.
   - Uma fragilidade real de teste (UB por aritmética de iterador não
     protegida após um `check()` que não aborta) foi encontrada e corrigida
     durante a investigação do bug acima -- documentada para não reaparecer.

### D.2 O que continua exatamente como a auditoria independente encontrou

- Os outros 54 comandos catalogados (fora 0x00/0x01/0x03/0x0B/0x21) continuam
  como fallback "eco corpo" auto-gerado -- nenhum ganhou corpo semântico
  nesta sessão. 0x00/0x01/0x03/0x21 continuam como AST manual em C++
  (funcionam, têm golden, mas não passaram pelo parser DSL ainda -- só 0x0B
  tem a prova cross-language completa até agora).
- `HartSemanticEndpoint`/o switch `command==0/1/3` em `IndustrialProtocols.cpp`
  continuam publicados por `protocol.hart.transmitter`/`protocol.hart.communicator`
  (confirmado ainda registrados em `CoreApplication.cpp`). Não removidos:
  são tipos de componente colocáveis pelo usuário em projetos EXISTENTES:
  remover sem uma história de migração fria quebraria esses projetos ao
  reabrir -- um bloqueio real de compatibilidade, não preguiça. Próxima ação
  concreta: escrever a migração fria (`protocol.hart.transmitter` salvo →
  reconhecido como perfil equivalente em `HartCommunicationComponent` ao
  abrir) antes de cogitar remoção.
- Não existe editor visual de Command Graph (nós/canvas) -- só o parser de
  texto. A Property Inspector Commands editor (`hartInspectorSections.ts`)
  continua editando os passos via os controles estruturados já existentes
  (select/input por step), não via um campo de texto DSL livre -- integrar o
  parser da DSL como uma superfície de autoria alternativa no Inspector é o
  próximo passo óbvio, não feito nesta sessão.
- `IHartCommandHandler` (o mecanismo de "NativeHandler") continua disponível
  na API do `HartEngine`, mas **zero** handlers de produção o registram --
  confirmado por busca (`grep registerCommandHandler` fora de testes), não
  assumido.
- Nenhuma auditoria propriedade-a-propriedade de Ctrl/elétrico/PLC-Modbus/
  plugins/Line-Tunnel foi feita nesta sessão (mesma lacuna já documentada no
  Anexo C, section C.7 -- não reaberta aqui por falta de tempo, não por
  decisão de escopo).
- Nenhuma validação de GUI/Extension Development Host foi feita (sem GUI
  disponível a este agente).
- Fuzzing e benchmarks representativos não foram executados nesta sessão.

### D.3 Status master

Usando exclusivamente `DONE` / `IN_PROGRESS` / `BLOCKED_EXTERNAL` (nunca
`PARTIAL` no fechamento, por instrução explícita da tarefa -- um item aqui
`IN_PROGRESS` teria sido `PARTIAL` numa taxonomia mais granular; a diferença
é que "in progress" não significa "abandonado", significa "próxima ação
concreta existe e está listada"):

| Area | Status | Evidência / próxima ação |
|---|---|---|
| Lasec DSL core (circuitos) | DONE (herdado, revalidado) | `DslParser.ts`/`DslReconciler.ts`/`DslSerializer.ts`, testes existentes passam |
| Lasec HART Command DSL | IN_PROGRESS | parser real + 10 testes + prova cross-language para 0x0B; gramática cobre chains/slices/hex/if, não cobre `map`/`forCodes` em texto ainda (só via JSON) |
| Visual→DSL / DSL→Visual (circuitos) | DONE (herdado) | `dslCommands.ts` (corrigido lifecycle), `DslReconciler.ts` |
| Visual⇄DSL (comandos HART) | IN_PROGRESS | parser existe, não integrado a um editor visual nem a um campo de texto no Inspector ainda |
| Direct Line / Tunnel (circuitos) | DONE (herdado) | `@Name` = tunnel, `A -> B` = line, distintos no parser/reconciler |
| Route/layout preservation | IN_PROGRESS | mecanismo existe (`DslReconciler.ts` preserva `points`/posições quando endpoints não mudam); não re-testado nesta sessão |
| Property Inspector genérico | DONE (sessão anterior, revalidado) | agrupamento por seção, select/readonly, sem stale selection, testado |
| Property Inspector HART (variáveis/comandos) | IN_PROGRESS | modelo funciona ponta a ponta (id estável, direction, UserVariable, override de fallback); DSL de comando ainda não é uma superfície do Inspector |
| Property Inspector Ctrl/Electrical/PLC-Modbus/plugins/Line-Tunnel | IN_PROGRESS | arquitetura genérica comprovada estruturalmente (Anexo C.4); varredura propriedade-a-propriedade real não feita |
| HART variables (Internal/Input/Output) | DONE (sessão anterior) | `signalPorts()`, `setVariableInput`/`variableValue`, testado |
| HART Command Graph (compilado/bounded IR) | DONE (infra) / IN_PROGRESS (cobertura) | `HartCommandCompiler`/`HartCommandExecutor` bounded e testados; só 5/60 comandos usam o pipeline com corpo real |
| Ctrl primitive reuse em HART commands | IN_PROGRESS | a DSL de comando usa a MESMA sintaxe de cadeia/slice do DSL de circuito (léxico compartilhado); não há ainda reuso de blocos Ctrl CONCRETOS (Gain/Select/etc.) dentro de um corpo de comando -- IF/EQ nativo do comando cobre os casos atuais, RelationalOperator/Select genéricos do Ctrl não foram conectados |
| HartCommandCompiler | DONE | bounded, testado, usado por todo comando (built-in, custom, agora DSL-provado para 0x0B) |
| Custom commands (override de fallback) | DONE | bug real corrigido + testado (D.1.4) |
| Standard commands (0x00/0x01/0x03/0x0B/0x21) | IN_PROGRESS | funcionam e têm golden; só 0x0B tem prova de vir da DSL de verdade até agora |
| Remaining 55 commands | IN_PROGRESS | fallback eco; nenhum migrado nesta sessão |
| Legacy switch/endpoint removal | IN_PROGRESS | não removido -- bloqueio real de compatibilidade com projetos existentes (D.2), precisa de migração fria primeiro |
| Save/reopen (HART) | DONE | testado ponta a ponta com `HartCommunicationComponent` real |
| Undo/redo | DONE (herdado, arquitetural) | mesmo pipeline `requestUpdateProperty` de qualquer propriedade |
| RUN policy | DONE (HART) / IN_PROGRESS (genérico fora de HART) | guard HART cobre estrutural + DSL draft; guard genérico para outras propriedades estruturais não auditado |
| Fuzz | IN_PROGRESS | não executado nesta sessão |
| Benchmarks | IN_PROGRESS | não executados nesta sessão |
| Specs | DONE (esta atualização) | Anexo D + atualização do audit independente |
| Extension Development Host | BLOCKED_EXTERNAL | sem GUI disponível a este agente |

### D.4 Testes desta sessão

Core (`hart_engine_test`, MSVC Release): **PASS**, incluindo os 2 bugs novos
corrigidos + regressão, vocabulário completo de JSON, e a prova
cross-language do 0x0B via DSL. Extension (`npm test`): **459/459**, sem
regressão em nenhum teste pré-existente (era 449 antes desta sessão; os 10
novos são `HartCommandDsl.test.ts`). `git diff --check`: limpo (só avisos de
LF/CRLF). `node .spec/governance/check-specs.mjs`: mesmos 2 erros
pré-existentes, não relacionados (referências `.piohome`).

### D.5 Por que esta sessão não tentou mais

Dado o volume genuíno do pedido (DSL unificada completa, Command Graph
visual, migração de 60 comandos, auditoria de 6+ domínios do Property
Inspector, remoção de legado, fuzzing, benchmarks), continuar por mais
tempo nesta MESMA sessão arriscava exatamente o padrão que as sessões
anteriores já provaram ser perigoso: mudanças rápidas e não verificadas
"parecem" avançar mas escondem bugs reais (como os 2 encontrados aqui, que
só apareceram testando de verdade, não por inspeção de código). A escolha
foi entre (a) reivindicar mais itens como `DONE` sem o mesmo rigor de teste
usado para os itens acima, ou (b) parar num ponto onde tudo que está
marcado `DONE` tem evidência real e tudo que não está é `IN_PROGRESS` com
uma próxima ação concreta escrita. Esta sessão escolheu (b).

## Anexo E -- Classificador normativo HCF_SPEC-99 e remoção do fake fallback (2026-09-11, sessão 5)

Esta sessão implementou a "arquitetura definitiva" pedida em torno de UM
princípio central que faltava de forma explícita e testada até aqui:
**quem define a semântica de um command number é determinado pela faixa
numérica (HCF_SPEC-99 §7.1, Table 9), nunca por convenção de nome de
vendor nem por "o que o Core já implementa hoje"**.

### E.1 O que foi construído (real, testado, buildado)

1. **`core/src/protocols/HartCommandClassification.{hpp,cpp}`** (novo par de
   arquivos) -- a ÚNICA autoridade para:
   - `HartCommandClass classifyHartCommandNumber(uint32_t)`: partição exata
     de HCF_SPEC-99 Table 9 (0-30 Universal, 31 ExpansionFlag, 32-121 exceto
     38/48 CommonPractice, 38/48 Universal, 122-126 NonPublic, 127 Reserved,
     128-253 DeviceSpecific, 254-511 Reserved, 512-767
     AdditionalCommonPractice, 768-1023 WirelessHart, 1024-33791
     DeviceFamily, 33792-64511 Reserved, 64512-64765
     WirelessDeviceSpecific, 64766-64767 Reserved, 64768-65021
     AdditionalDeviceSpecific, 65022-65535 Reserved).
   - `HartCommandImplementationPolicy implementationPolicyFor(HartCommandClass)`:
     deriva StandardCore / ManufacturerDsl / FactoryPrivateDsl /
     ProtocolInfrastructure / Forbidden a partir da classe -- nunca atribuída
     independentemente.
   - `isDeviceSpecificRangeOver90PercentConsumed(count)`: regra dos >90% da
     faixa 128-253 (126 ids) para liberar Additional Device-Specific,
     derivada do tamanho real da faixa (`kDeviceSpecificRangeSize = 126`),
     não um magic number hardcoded.
   - `isManufacturerAuthorable(id, isWirelessHartCapable, consumedCount)`:
     predicado único usado tanto pelos testes quanto pelo gate de autoria em
     `HartCommandJson`.
2. **`HartCommandJson::parseCommandDefinition`/`parseCommandCollection`
   reescritos para usar o classificador**, substituindo o antigo
   `isReservedStandardCommandId` (que só bloqueava 5 ids hardcoded:
   0x00/0x01/0x03/0x0B/0x21). Agora QUALQUER id HART-standardized
   (Universal, Common Practice, Additional Common Practice, WirelessHART,
   Device Family), Reserved, ExpansionFlag ou Non-Public é rejeitado com
   diagnóstico específico por classe; `parseCommandCollection` calcula
   `consumedDeviceSpecificCount` a partir da PRÓPRIA coleção antes de validar
   cada entrada, então a regra dos 90% é avaliada com o total real do
   dispositivo, não um contexto vazio.
3. **Removido o "echo fallback" de `HartReferenceCatalog::commandProgramDefinitions()`**
   -- este era o anti-padrão central que a diretiva desta sessão pediu para
   eliminar: para os 55 ids catalogados (todos os 60 ids de
   `commandDescriptors()` exceto os 5 com corpo real) o Core instalava
   automaticamente um programa que ecoava o corpo da requisição, fazendo um
   host HART que sondasse, por exemplo, o Command 128 (Device-Specific)
   receber uma resposta plausível em vez do "command not implemented"
   correto. Removido sem substituto: um id sem corpo real agora
   simplesmente não tem entrada no hook, e `HartEngine::execute()` já
   retorna `false` nesse caso (nenhuma resposta é enviada -- ver D.2 abaixo
   sobre o limite conhecido de não haver um byte de status RC=64 genérico no
   frame codec).
4. **29 dos 60 ids catalogados são, pela classificação normativa,
   Device-Specific (128-253)** -- esses ids agora ficam genuinamente livres
   para autoria de manufacturer DSL real (o mecanismo de override já
   existente continua funcionando, só que agora não está "vencendo" um
   fallback fake, é a ÚNICA implementação).
5. **Testes novos em `hart_engine_test`** (todos passando): os 33 boundary
   cases da seção 115 do pedido, a tabela completa de classificação
   esperada (seção 116), a tabela completa de policy esperada (seção 117),
   o teste de threshold 113 vs 114 (seção 122), o "manufacturer override
   test" (DSL Command 11/33/38/127/122/31 rejeitados, DSL Command 128
   aceito -- seção 118), e um teste de aplicabilidade Common Practice
   ponta-a-ponta (device que não declara Command 0x21 recebe "not
   implemented", sem nenhum toggle -- seção 119).
6. **Property Inspector**: o helper client-side "+ Add Command" agora
   restringe a sugestão de novo id à faixa 128-253 (antes usava uma lista
   fixa de 5 ids reservados e, sem limite superior, podia sugerir um id
   Reserved como 254 depois que 128-253 enchesse). Tooltip do campo id
   atualizado para explicar a faixa Device-Specific em vez de citar só os 5
   comandos antigos. Teste correspondente reescrito para validar o novo
   comportamento (o teste antigo procurava o literal `"[0, 1, 3, 11, 33]"`,
   que não existe mais no script).

Build: `hart_engine_test` (MSVC Debug) compila limpo e **PASS** (todos os
testes, incluindo os novos). Extension: `npm run compile` limpo, `npm test`
**459/459** (mesma contagem de antes -- 2 testes reescritos, não
adicionados, então o total não muda).

### E.2 Tabela de exemplo (seção 139/140 do pedido)

| ID | Nome (catálogo) | Classe normativa | Quem define semântica? | Core implementa? | Policy | Produção |
|---|---|---|---|---|---|---|
| 0 | Read Unique Identifier | Universal | HART | sim (corpo real) | StandardCore | StandardCore C++ |
| 11 (0x0B) | Read Unique Identifier Associated With Tag | Universal | HART | sim (corpo real) | StandardCore | StandardCore C++ (+ prova de paridade DSL, não produção) |
| 33 (0x21) | Read Device Variables | CommonPractice | HART | sim (corpo real) | StandardCore | StandardCore C++ |
| 2 (0x02) | Read Loop Current And Percent Of Range | Universal | HART | não | StandardCore | Not Implemented (honesto, sem fallback) |
| 152 (0x98) | Vendor Keepalive (nome do catálogo) | DeviceSpecific | Manufacturer | não por padrão | ManufacturerDsl | Not Implemented até autoria real; testado com corpo customizado autorado (D.1.4/E.1.5) |
| 128 (0x80) | Vendor Read Configuration (nome do catálogo) | DeviceSpecific | Manufacturer | não por padrão | ManufacturerDsl | idem |
| 127 | -- | Reserved | ninguém | -- | Forbidden | rejeitado na autoria |
| 64512 | -- | WirelessDeviceSpecific | Manufacturer (contexto wireless) | -- | ManufacturerDsl | rejeitado (build sem modelo de capability WirelessHART) |

### E.3 Contagens finais (seção 141)

```text
Universal Core commands (corpo real)                   = 4   (0x00, 0x01, 0x03, 0x0B)
Universal catalogado mas sem corpo real (not-impl)      = 17  (0x02,0x04-0x0A,0x0C-0x13,0x15)
Common Practice Core commands (corpo real)              = 1   (0x21 / 33)
Additional Common Practice Core commands               = 0   (nenhum id do catálogo cai nesta faixa)
WirelessHART Core commands                             = 0   (nenhum id do catálogo cai nesta faixa)
Device Family Core commands                            = 0   (nenhum id do catálogo cai nesta faixa)
Manufacturer Device-Specific ids catalogados (128-253)  = 29  (todos sem corpo por padrão, autoráveis)
Wireless Manufacturer DSL commands                      = 0   (sem contexto WirelessHART neste build)
Additional Manufacturer DSL commands                    = 0   (nenhum device chega perto de 90% de 128-253)
Factory Private commands                                = 0   (122-126 rejeitados; sem modo de fábrica)
Reserved definitions                                    = 0   (classificador rejeita toda autoria; nenhuma definição existe)
manufacturer-specific C++ runtime handlers remaining     = 0
standard commands incorrectly using production DSL       = 0  (os 5 corpos reais são definidos em C++, nunca por texto DSL do usuário)
generic Common Practice enable/disable toggles added     = 0  (verificado por leitura de hartInspectorSections.ts: único checkbox "Enabled" existente é por-comando-customizado, não um toggle genérico de Common Practice)
```

### E.4 O que esta sessão NÃO fez (honesto, não "PARTIAL")

- **Byte de status RC=64 genérico no frame**: `HartTransportEndpoint::transact`
  hoje simplesmente não envia resposta quando `HartEngine::execute` retorna
  `false` (nenhum frame de volta), em vez de compor um frame com
  Response-Code=64 ("command not implemented") no cabeçalho de status. Isso
  é uma lacuna real de fidelidade ao protocolo -- mas o codec de frame atual
  não modela os 2 bytes de status de forma genérica (cada corpo de comando
  escreve seu próprio primeiro byte de status quando precisa, ex.: 0x0B). Dar
  a UM frame codec compartilhado a responsabilidade do RC exigiria tocar
  TODOS os corpos de comando existentes (golden bytes mudariam) -- não
  tentado nesta sessão por ser uma mudança de alto risco fora do escopo
  imediato do classificador. Next action: modelar `HartResponseBuilder` com
  um método `writeStatus(HartResponseCode)` e migrar os 5 corpos reais para
  usá-lo antes de fazer `execute()` retornar um RC real em vez de `false`.
- **WirelessHART device-capability model**: não existe neste build (nenhum
  profile/plan tem um campo "isWirelessHartCapable"). A faixa Wireless
  Device-Specific (64512-64765) é sempre rejeitada na autoria como
  consequência honesta disso, não como uma feature implementada e depois
  desativada.
- **Migração dos 55 ids não-modelados para corpos reais de Common
  Practice/Universal** (ex.: dar a 0x02, 0x05, 0x54 etc. implementações
  C++ de verdade): continuam "not implemented" corretamente, mas isso é
  "correto e honesto", não "completo" -- só 4 ids Universal + 1 Common
  Practice têm corpo real hoje.
- **Command Graph visual editor, Map/ForCodes na sintaxe textual da DSL,
  Ctrl primitive reuse concreto dentro de um corpo de comando, auditoria
  propriedade-a-propriedade de Ctrl/electrical/PLC-Modbus/plugins/Line-Tunnel,
  fuzzing, benchmarks, remoção do endpoint legado
  `protocol.hart.transmitter`/`protocol.hart.communicator`**: nenhum destes
  avançou nesta sessão (mesmo estado do Anexo D.3), permanecem
  `IN_PROGRESS`.

### E.5 Correção de texto normativo (seção 133/134/135 do pedido)

Nenhum documento `.spec` encontrado nesta sessão afirmava literalmente "all
HART commands must use DSL" (revisado por busca textual); o texto mais
próximo de causar essa confusão era a doc comment de `HartCommandJson.hpp`
("compiler target the Lasec HART Command DSL parser lowers to"), que já
deixa claro que é um alvo de compilação para autoria manufacturer, não uma
afirmação sobre TODOS os comandos. Para eliminar qualquer ambiguidade
futura, o texto normativo abaixo fica registrado como a definição final:

> HART-defined commands use canonical Core implementations. Common Practice
> command semantics are standardized by HART, while their applicability is
> derived from the capabilities/declared commands of the individual field
> device -- never a generic per-command profile toggle. Device-Specific
> commands (128-253) are manufacturer-defined and are authored using Lasec
> DSL. Manufacturer-specific behavior must not reuse Universal, Common
> Practice, Additional Common Practice, WirelessHART or Device Family
> command numbers for different semantics -- `HartCommandClassification.hpp`
> is the single normative authority enforcing this at authoring time.
> Device-Specific = Manufacturer Defined; Device Family = HART-defined. The
> two must never be confused.

## Anexo F -- StandardCore expansion attempt, real external blocker found (2026-09-11, sessão 6)

Esta sessão recebeu um pedido para implementar TODOS os HART Commands
"HART-standardized" (Universal, Common Practice, WirelessHART, Device
Family, Discrete Applications -- centenas de IDs) em C++ canônico,
citando um ZIP anexo de PDFs (`spec099r9.0.pdf`, `spec127r7.1.pdf`, etc.)
e exigindo que, quando o ZIP estivesse desatualizado, a revisão vigente
fosse obtida do FieldComm Group online.

### F.1 Achado crítico, verificado, não hipotético

**O ZIP referenciado não existe neste ambiente.** Busca exaustiva no
repositório (`find ... -iname "*.pdf"`), no diretório do usuário e em todo
o restante da máquina não encontrou nenhum dos arquivos citados
(`spec099r9.0.pdf`, `spec127r7.1.pdf`, `spec151r10.0.pdf`, etc.) -- apenas
um PDF de referência de uma sessão anterior (`Comandos_Hart.pdf`, cópia do
repositório PACTware já usado como fonte deste projeto desde a sessão 1).

**O FieldComm Group online reader é access-controlled.** Testado
diretamente nesta sessão: `WebFetch` em
`https://library.fieldcommgroup.org/20127/TS20127/` retornou **HTTP 403
Forbidden**. Uma busca web confirma que as especificações completas
(TS20099/TS20127/TS20151/etc.) são "controlled technical documents that
require membership or purchase" -- não há acesso público ao texto integral
de nenhuma das ~15 especificações citadas na tarefa.

Isso significa que, para a esmagadora maioria dos ~250+ commands pedidos
(Common Practice 33-554, WirelessHART completo, Device Family completo,
Discrete completo), **não existe fonte normativa acessível a este agente**
para extrair request/response byte layout com confiança. Implementar esses
bytes sem essa fonte seria exatamente o que a própria tarefa proíbe
explicitamente na seção 3: "não deduza... pelo nome... é melhor deixar
explicitamente `SPEC_CURRENT_SOURCE_REQUIRED` do que implementar bytes
inventados."

### F.2 O que foi genuinely implementado nesta sessão apesar do bloqueio

Um subconjunto pequeno mas real dos Universal Commands tem layout de bytes
estável há décadas (inalterado desde HART 5) e é corroborado
independentemente pela referência PACTware `hrt_transmitter_v6.py` já
usada como fonte legítima deste projeto (não um PDF oficial, mas uma
implementação de referência real, auditável, já adotada desde a sessão 1).
Implementados e testados:

- **Command 12 (0x0C) Read Message** / **Command 17 (0x11) Write Message**
  -- 24 caracteres packed-ASCII (18 bytes).
- **Command 13 (0x0D) Read Tag/Descriptor/Date** / **Command 18 (0x12)
  Write Tag/Descriptor/Date** -- tag(6) + descriptor(12) + date(3) = 21
  bytes, layout confirmado byte-a-byte contra `hrt_transmitter_v6.py`'s
  `tag=$BODY[0:12], descriptor=$BODY[12:36], date=$BODY[36:42]` (offsets
  em hex chars, /2 = bytes).
- **Command 16 (0x10) Read Final Assembly Number** / **Command 19 (0x13)
  Write Final Assembly Number** -- 3 bytes big-endian.

Todos os seis são Universal (0-30) pela classificação normativa já
existente (`HartCommandClassification.hpp`), portanto `StandardCore` por
construção -- e já protegidos automaticamente contra redefinição por
manufacturer DSL (o classificador da sessão anterior cobre isso sem
nenhuma mudança adicional).

### F.3 Achado arquitetural real e corrigido: writes nunca persistiam

Durante a implementação, foi descoberto que **nenhum HART write command já
produzido por este projeto jamais persistia seu efeito**: `HartCommandExecutor::execute`
recebia `HartExecutionVariables` POR VALOR (uma cópia de trabalho
descartada ao retornar), e `HartEngine::CommandProgramHook` recebia
`const HartDevicePlan&` -- não havia NENHUM caminho para uma mutação `SET`
sobreviver além da própria chamada. Isso nunca tinha sido pego porque
nenhum dos 5 comandos de produção anteriores (0x00/0x01/0x03/0x0B/0x21)
usa `SET`; o `.write` stage nunca era exercitado em produção, só no teste
isolado de primitivas.

Corrigido nesta sessão (não era opcional -- Commands 17/18/19 exigem que
seus writes façam algo real):

1. `HartCommandExecutor::execute` agora recebe `HartExecutionVariables&`
   (referência, não cópia) -- mutações ficam visíveis ao chamador.
2. `HartEngine::CommandProgramHook` agora recebe `HartDevicePlan&` (não
   `const&`) -- o hook pode persistir.
3. `HartEngine::execute()` copia o `effectivePlan` mutado de volta para o
   device real (`selected->plan = std::move(effectivePlan)`) SOMENTE
   quando o hook retorna `true` -- uma escrita rejeitada (ex.: body
   truncado) nunca deixa mutação parcial (seção 50 "atomic writes",
   testado explicitamente: comando 18 com 1 byte a menos é rejeitado E o
   tag/descriptor/date permanecem exatamente como antes).
4. `HartReferenceCatalog::makeHook` só copia um campo de volta ao plan se
   ele REALMENTE mudou (comparação byte-a-byte antes/depois) -- sem essa
   guarda, QUALQUER comando (inclusive uma leitura como 0x01) re-
   canonicalizaria silenciosamente o tag (maiúsculas + padding de espaço)
   a cada dispatch, um efeito colateral espúrio que um teste de regressão
   dedicado agora impede.

Esta é, honestamente, a correção mais importante desta sessão -- maior que
os 6 commands em si: sem ela, QUALQUER write command futuro (6, 22, 34-37,
44, etc., quando/se as fontes normativas ficarem disponíveis) teria o
mesmo bug silencioso de "parece funcionar, não muda nada".

### F.4 Bug de teste real encontrado e corrigido de brinde

O helper `transactCommand` em `HartEngineTest.cpp` (usado desde a sessão
anterior) tinha um buffer de resposta fixo de 16 bytes -- suficiente para
os payloads de 1-2 bytes que testava até agora, mas silenciosamente
insuficiente para o payload de 18 bytes do Command 12. `component.transact`
retorna `false` em overflow (correto), então o teste simplesmente reportava
"resposta vazia" em vez de um erro óbvio -- corrigido para 48 bytes com
comentário explicando por quê.

### F.5 Testes desta sessão

Golden read/write para os 3 pares (12/17, 13/18, 16/19); persistência
comprovada via HartEngine puro E via `HartCommunicationComponent` real
(prova de produção, não só de engine isolado); consistência cruzada (um
write de tag via 18 é observado por um match de tag via 0x0B, e o tag
antigo passa a dar mismatch); atomicidade (write truncado não muda nada);
regressão anti-recanonicalização (uma leitura não relacionada não
perturba tag/descriptor/date). `hart_engine_test`: **PASS**. `npm test`
(extensão, não tocada nesta sessão): **459/459**, sem regressão.

### F.6 Limitação honesta: sem persistência entre save/reopen

`message`/`descriptor`/`date`/`finalAssemblyNumber` vivem em
`HartDevicePlan`, reconstruído do zero por `HartCommunicationComponent::
rebuildConfiguredPlan()` a cada edição de propriedade -- e NENHUMA
propriedade persistida foi adicionada para esses 4 campos nesta sessão
(seria escopo adicional real: schema, Property Inspector, serialização).
Isso significa: um write via Command 17/18/19 sobrevive durante a sessão
de simulação (testado, funciona), mas é perdido se o projeto for salvo e
reaberto. `tag` já tinha esse mesmo problema antes desta sessão (não é uma
regressão introduzida agora) -- este é um limite pré-existente que apenas
ficou mais visível ao ganhar 3 vizinhos novos.

### F.7 Matriz final (parcial -- apenas o que mudou nesta sessão)

| ID | Nome | Classe | Quem define semântica? | Core implementa? | Fonte | Status |
|---|---|---|---|---|---|---|
| 12 (0x0C) | Read Message | Universal | HART | sim | PACTware ref. (corroborado) | PASS_OLDER_COMPATIBLE_SPEC |
| 17 (0x11) | Write Message | Universal | HART | sim | idem | PASS_OLDER_COMPATIBLE_SPEC |
| 13 (0x0D) | Read Tag, Descriptor, Date | Universal | HART | sim | idem | PASS_OLDER_COMPATIBLE_SPEC |
| 18 (0x12) | Write Tag, Descriptor, Date | Universal | HART | sim | idem | PASS_OLDER_COMPATIBLE_SPEC |
| 16 (0x10) | Read Final Assembly Number | Universal | HART | sim | idem | PASS_OLDER_COMPATIBLE_SPEC |
| 19 (0x13) | Write Final Assembly Number | Universal | HART | sim | idem | PASS_OLDER_COMPATIBLE_SPEC |
| 2, 4, 5, 8, 9, 10, 14, 15, 20, 22, 38, 48 | (Universal restante) | Universal | HART | não | -- | NEEDS_CURRENT_SPEC_UPDATE / SPEC_CURRENT_SOURCE_REQUIRED |
| 33-121 (exceto 38/48) | Common Practice | CommonPractice | HART | não | -- | SPEC_CURRENT_SOURCE_REQUIRED (HTTP 403 confirmado) |
| 512-767 | Additional Common Practice | AdditionalCommonPractice | HART | não | -- | SPEC_CURRENT_SOURCE_REQUIRED |
| 768-1023 | WirelessHART | WirelessHart | HART | não | -- | SPEC_CURRENT_SOURCE_REQUIRED |
| 1024-33791 | Device Family | DeviceFamily | HART | não | -- | SPEC_CURRENT_SOURCE_REQUIRED |
| 64384-64459 | Discrete Applications | DeviceFamily-like (per §32 do pedido) | HART | não | -- | SPEC_CURRENT_SOURCE_REQUIRED |

### F.8 Contagens finais (seção 63 do pedido)

```text
Universal standardized commands discovered   = ~23 (0-22, 38, 48; exata
                                                depende da revisão --
                                                bloqueado por F.1)
Universal implemented (corpo real)           = 10 (0,1,3,11,12,13,16,17,18,19)
Universal remaining                          = ~13

Common Practice standardized commands discovered = SPEC_CURRENT_SOURCE_REQUIRED
Common Practice implemented                      = 1 (33, da sessão anterior)
Common Practice remaining                        = SPEC_CURRENT_SOURCE_REQUIRED

Wireless standardized commands discovered    = SPEC_CURRENT_SOURCE_REQUIRED
Wireless implemented                         = 0
Wireless remaining                           = SPEC_CURRENT_SOURCE_REQUIRED

Device Family standardized commands discovered = SPEC_CURRENT_SOURCE_REQUIRED
Device Family implemented                      = 0
Device Family remaining                        = SPEC_CURRENT_SOURCE_REQUIRED

Discrete standardized commands discovered    = SPEC_CURRENT_SOURCE_REQUIRED
Discrete implemented                         = 0
Discrete remaining                           = SPEC_CURRENT_SOURCE_REQUIRED

Commands awaiting current authoritative specification = a MAIORIA da tarefa
                                                          pedida (ver F.1)

Manufacturer DSL commands accidentally found in C++ = 0 (classificador
                                                        da sessão anterior
                                                        já impede isso)
```

### F.9 Próxima ação exata, não genérica

1. **Bloqueio externo real, não contornável por este agente**: acesso de
   membro à FieldComm Group (`library.fieldcommgroup.org`) ou aquisição
   dos PDFs `TS20099`/`TS20127`/`TS20151`/`TS20155`/`TS20160.x`/`TS20285`/
   `TS20307` na revisão vigente. Sem isso, a seção 56 do pedido ("segunda
   busca usando fontes oficiais atuais") não pode ser respondida com
   autoridade normativa -- só com o mesmo tipo de inferência que a própria
   tarefa proíbe.
2. Se o usuário puder fornecer os PDFs (upload direto, não um link
   FieldComm), este agente pode processá-los diretamente e retomar a
   implementação command-by-command exatamente como pedido.
3. Alternativa parcial sem os PDFs: continuar usando a MESMA técnica desta
   sessão (corroboração cruzada contra `hrt_transmitter_v1-v6.py` e outras
   implementações de referência real, não-oficiais mas auditáveis) para o
   punhado de commands restantes cujo layout é conhecido-estável há
   décadas (ex.: Command 20/22 Long Tag, Command 6/7 Polling
   Address/Loop Configuration -- este último adiado nesta sessão
   especificamente pela complexidade de re-endereçamento ao vivo, não por
   falta de fonte).
4. Adicionar propriedades persistidas para `message`/`descriptor`/`date`/
   `finalAssemblyNumber` no Property Inspector (fecha o gap F.6).

## F.10 -- Bloqueio externo resolvido: ZIP oficial localizado, extraído, inventariado (sessão 7)

O `HART.zip` foi colocado na raiz do repositório (`C:\SourceCode\LasecSimul\HART.zip`,
19.1 MB, 34 entradas incluindo a pasta). Extraído para uma pasta de
trabalho fora do repositório (`%LOCALAPPDATA%\Temp\lasecsimul-hart-specs-20260911\HART\`,
com `pdftotext -layout` gerando um `.txt` companheiro de cada PDF para
buscas rápidas) -- o ZIP original permanece intocado na raiz, e foi
adicionado ao `.gitignore` (`/HART.zip`) porque é material com copyright
da HART Communication Foundation, nunca deveria entrar no histórico git.

### F.10.1 Inventário completo (seção 7 do pedido)

| Arquivo | HCF Number | Título | Revisão | Data |
|---|---|---|---|---|
| spec013r7.4.pdf | HCF_SPEC-13 | HART Communication Protocol Specification | 7.4 | 2012-06-29 |
| spec054r8.1.pdf | HCF_SPEC-054 | FSK Physical Layer Specification | 8.1 | 1999-08-24 |
| spec060r1.0.pdf | HCF_SPEC-60 | C8PSK Physical Layer Specification | 1.0 | 2001-04-18 |
| spec065r1.0.pdf | HCF_SPEC-065 | 2.4GHz DSSS O-QPSK Physical Layer Specification | 1.0 | 2007-09-01 |
| spec075r1.1.pdf | HCF_SPEC-075 | TDMA Data Link Layer Specification | 1.1 | 2008-05-17 |
| spec081r9.0.pdf | HCF_SPEC-081 | Token-Passing Data Link Layer Specification | 9.0 | 2012-05-12 |
| spec085r2.0.pdf | HCF_SPEC-085 | Network Management Specification | 2.0 | 2012-06-18 |
| **spec099r9.0.pdf** | **HCF_SPEC-99** | **Command Summary Specification** | **9.0** | 2007-07-23 |
| **spec127r7.1.pdf** | **HCF_SPEC-127** | **Universal Command Specification** | **7.1** | 2008-05-10 |
| **spec151r10.0.pdf** | **HCF_SPEC-151** | **Common Practice Command Specification** | **10.0** | 2012-06-22 |
| **spec155r2.0.pdf** | **HCF_SPEC-155** | **Wireless Command Specification** | **2.0** | 2012-06-12 |
| spec160r1.1.pdf | HCF_SPEC-160 | Device Families Command Specification | 1.1 | 2011-05-12 |
| spec160.4r2.0.pdf | HCF_SPEC-160.4 | Temperature Device Family Specification | 2.0 | 2011-05-12 |
| spec160.05.pdf | HCF_SPEC-160.5 | Pressure Device Family Specification | 1.0 | **DRAFT L**, 2002-11-05 |
| spec160.06.pdf | HCF_SPEC-160.6 | Valve Positioner Device Family Specification | 1.0 | **DRAFT C**, 2001-12-27 |
| spec160.7r1.0.pdf | HCF_SPEC-160.7 | PID Control Device Family Specification | 1.0 | 2001-04-18 |
| spec160.08.pdf | HCF_SPEC-160.8 | pH Device Family Specification | 1.0 | **PRELIMINARY**, 2001-10-31 |
| spec160.09.pdf | HCF_SPEC-160.9 | Conductivity Device Family Specification | 1.0 | **PRELIMINARY**, 2001-10-31 |
| spec160.10.pdf | HCF_SPEC-160.10 | Totalizer Device Family Specification | 1.0 | **PRELIMINARY**, 2002-11-05 |
| spec160.11r1.0.pdf | HCF_SPEC-160.11 | Level Device Family Specification | 1.0 | 2011-05-12 |
| spec160_cor_draft.pdf | HCF_SPEC-160.xx | Coriolis Flow Device Family Specification | 0.0 | **DRAFT**, 2003-12-01 |
| spec160_magnetic_draft.pdf | HCF_SPEC-160.xx | Magnetic Inductive Flow Device Family Specification | 0.0 | **DRAFT**, 2003-07-01 |
| spec160_vortex_draft.pdf | HCF_SPEC-160.xx | Vortex Flow Device Family Specification | 0.0 | **DRAFT**, 2004-06-09 |
| spec183r22.0.pdf | HCF_SPEC-183 | Common Tables Specification | 22.0 | 2012-06-15 |
| **spec285r2.0.pdf** | **HCF_SPEC-285** | **Discrete Applications Specification** | **2.0** | 2012-06-11 |
| spec290r1.1.pdf | HCF_SPEC-290 | WirelessHART Device Specification | 1.1 | 2008-05-22 |
| spec307r6.0.pdf | HCF_SPEC-307 | Command Response Code Specification | 6.0 | 2007-09-05 |
| lit18r11.0.pdf | HCF_LIT-18 | Field Device Specification Guide | 11.0 | 2001-04-18 |
| test1r3.0.pdf | HCF_TEST-001 | Slave Token-Passing Data Link Layer Test Specification | 3.0 | 2009-02-25 |
| test2r2.2.pdf | HCF_TEST-2 | FSK Physical Layer Test Specification | 2.2 | 2001-06-28 |
| test3r4.0.pdf | HCF_TEST-003 | Slave Universal Command Test Specification | 4.0 | 2009-03-11 |
| test4r4.0.pdf | HCF_TEST-004 | Slave Common Practice Command Test Specification | 4.0 | 2009-03-12 |

Bold = the documents actually used this session. `Revision vs. current known
revision` (seção 8 do pedido): the task's own text cited current revisions
(Rev 11.1 for Command Summary, Rev 7.2 for Universal, Rev 14.0 for Common
Practice, Rev 7.0 for Response Codes) that are NEWER than what this ZIP
contains (9.0, 7.1, 10.0, 6.0 respectively) -- this ZIP is a real, usable,
but NOT current-latest source. Per section 9 of the task ("se somente a
revisão posterior está bloqueada, mas a revisão local permite implementar
corretamente... implemente a revisão suportada + marque o delta"), this
session implemented against the LOCAL (older-but-real) revisions and
records that delta here rather than blocking on it: nothing in this
session's Universal work (Commands 0-22, 38, 48) is known to have changed
between Rev 7.1 and the cited current Rev 7.2 -- FieldComm's own revision
history convention is additive (new commands, clarifications), and the
task's own text did not claim any BYTE-LAYOUT change to an EXISTING
command, only new content. This has NOT been independently verified
against Rev 7.2's actual text (inaccessible, see F.1) and is flagged as
`REVISION_DELTA_UNVERIFIED`, not silently assumed safe.

### F.10.2 Regra de ouro confirmada: NÃO promover DRAFT/PRELIMINARY

Pressure (160.5), Valve Positioner (160.6), pH (160.8), Conductivity
(160.9), and Totalizer (160.10) are explicitly marked DRAFT or PRELIMINARY
in the ZIP itself -- the ZIP did NOT deliver the "FINAL" versions the task
speculated might exist (section 27-30 of the task asked to check for a
Pressure/Totalizer FINAL; none is in this archive). Per section 28/57 of
the task ("Se ainda houver apenas Draft: não promova silenciosamente...
pode manter DRAFT_REFERENCE_ONLY"), these remain `DRAFT_REFERENCE_ONLY` /
`PRELIMINARY_REFERENCE_ONLY` -- not implemented as StandardCore this
session, and not to be implemented from a Draft/Preliminary source without
the user's explicit sign-off, since HCF explicitly reserves the right to
change Draft/Preliminary content before finalizing it. Coriolis/Magnetic/
Vortex Flow (the three `_draft` files, Revision 0.0) are even earlier-stage
drafts -- same rule.

Modulating Final Control (TS20160-15, referenced in the task's section 30)
is **NOT in this ZIP at all**. Marked `SPEC_CURRENT_SOURCE_REQUIRED` still.

## F.11 -- Universal Command Completion Gate (seção 14 do pedido) -- FECHADO (sessão 8)

Todos os itens `BLOCKED_INTERNAL`/`NEEDS_*` da sessão anterior (2, 9, 14,
15, 21) foram implementados nesta sessão. Command 3's status é
reconciliado (era um PASS parcial por causa do Loop Current em NaN; agora
é um PASS completo). Apenas o Command 10 (genuinely Reserved, ausente da
própria TOC do HCF_SPEC-127) permanece sem implementação -- corretamente.

| ID | Nome | Spec | Implementado? | Golden? | Status |
|---|---|---|---|---|---|
| 0 | Read Unique Identifier | HCF_SPEC-127 6.1 | Sim | Sim | PASS_OLDER_COMPATIBLE_SPEC |
| 1 | Read Primary Variable | HCF_SPEC-127 6.2 | Sim | Sim | PASS_OLDER_COMPATIBLE_SPEC |
| 2 | Read Loop Current And Percent Of Range | HCF_SPEC-127 6.3 | **Sim (sessão 8)** | Sim (PV=0 e PV=50) | PASS_OLDER_COMPATIBLE_SPEC |
| 3 | Read Dynamic Variables And Loop Current | HCF_SPEC-127 6.4 | Sim (Loop Current real desde a sessão 8) | Sim | PASS_OLDER_COMPATIBLE_SPEC (reconciliado: era parcial, agora completo) |
| 4 | Reserved | HCF_SPEC-127 6.5 | N/A | -- | NOT_APPLICABLE |
| 5 | Reserved | HCF_SPEC-127 6.6 | N/A | -- | NOT_APPLICABLE |
| 6 | Write Polling Address | HCF_SPEC-127 6.7 | Sim | Sim | PASS_OLDER_COMPATIBLE_SPEC |
| 7 | Read Loop Configuration | HCF_SPEC-127 6.8 | Sim | Sim | PASS_OLDER_COMPATIBLE_SPEC |
| 8 | Read Dynamic Variable Classifications | HCF_SPEC-127 6.9 | Sim | Sim | PASS_OLDER_COMPATIBLE_SPEC |
| 9 | Read Device Variables with Status | HCF_SPEC-127 6.10 | **Sim (sessão 8)**, via FOR_CODES existente | Sim (2 slots, timestamp) | PASS_OLDER_COMPATIBLE_SPEC |
| 10 | (não existe) | HCF_SPEC-127 (ausente) | N/A (Reserved) | -- | NOT_APPLICABLE |
| 11 (0x0B) | Read Unique Identifier Associated With Tag | HCF_SPEC-127 6.11 | Sim | Sim | PASS_OLDER_COMPATIBLE_SPEC |
| 12 | Read Message | HCF_SPEC-127 6.12 | Sim | Sim | PASS_OLDER_COMPATIBLE_SPEC |
| 13 | Read Tag, Descriptor, Date | HCF_SPEC-127 6.13 | Sim | Sim | PASS_OLDER_COMPATIBLE_SPEC |
| 14 | Read Primary Variable Transducer Information | HCF_SPEC-127 6.14 | **Sim (sessão 8)**, resposta "not applicable" do próprio spec | Sim | PASS_OLDER_COMPATIBLE_SPEC |
| 15 | Read Device Information | HCF_SPEC-127 6.15 | **Sim (sessão 8)** | Sim | PASS_OLDER_COMPATIBLE_SPEC |
| 16 | Read Final Assembly Number | HCF_SPEC-127 6.16 | Sim | Sim | PASS_OLDER_COMPATIBLE_SPEC |
| 17 | Write Message | HCF_SPEC-127 6.17 | Sim | Sim | PASS_OLDER_COMPATIBLE_SPEC |
| 18 | Write Tag, Descriptor, Date | HCF_SPEC-127 6.18 | Sim | Sim | PASS_OLDER_COMPATIBLE_SPEC |
| 19 | Write Final Assembly Number | HCF_SPEC-127 6.19 | Sim | Sim | PASS_OLDER_COMPATIBLE_SPEC |
| 20 | Read Long Tag | HCF_SPEC-127 6.20 | Sim | Sim | PASS_OLDER_COMPATIBLE_SPEC |
| 21 | Read Unique Identifier Associated With Long Tag | HCF_SPEC-127 6.21 | **Sim (sessão 8)** -- ambiguidade do catálogo 0x15 resolvida (ver F.11.1) | Sim (match + silêncio no mismatch) | PASS_OLDER_COMPATIBLE_SPEC |
| 22 | Write Long Tag | HCF_SPEC-127 6.22 | Sim | Sim | PASS_OLDER_COMPATIBLE_SPEC |
| 38 | Reset Configuration Changed Flag | HCF_SPEC-127 6.23 | Sim (echo; bit de status não modelado -- ver F.11.2) | Sim | PASS_OLDER_COMPATIBLE_SPEC (parcial, documentado) |
| 48 | Read Additional Device Status | HCF_SPEC-127 6.24 | Sim (mínimo mandatório: 9 bytes all-clear) | Sim | PASS_OLDER_COMPATIBLE_SPEC (mínimo, documentado) |

### F.11.1 -- Command 21 / catálogo 0x15: resolvido

`HartReferenceCatalog::commandDescriptors()` catalogava `0x15` (21
decimal) como `"Write Output Information"`. Resolvido nesta sessão por
dedução arquitetural, não por adivinhação: 21 está na faixa Universal, e
semântica Universal não pode legitimamente ser redefinida por um
fabricante (o mesmo princípio que `HartCommandClassification.hpp` já
aplica em toda parte). Logo o rótulo antigo só pode ter sido um erro de
importação -- corrigido para o nome real, e o Command 21 implementado sob
esse id.

### F.11.2 -- Limitação documentada: Command 38 não modela o bit de status (HISTÓRICO -- superado, ver F.15.2)

**Nota de reconciliação (sessão 9):** esta lacuna foi fechada por trabalho
concorrente desde que este parágrafo foi escrito. `command == 0x26` hoje
zera de fato o bit 0x40 de `plan.diagnosticStatus` quando o contador recebido
confere com `plan.configurationChangedCounter`, e Command 48 expõe esse mesmo
byte. Ver F.15.2 para o defeito real encontrado e corrigido nesta sessão (a
forma legada de 0 bytes era rejeitada em vez de resetar incondicionalmente) e
F.15.3 para a confirmação de que este contador é a autoridade canônica única.
Parágrafo original mantido abaixo apenas como registro histórico, não como
estado atual:

Continua real: Command 38 ecoa corretamente o Configuration Change
Counter, mas não zera nenhum bit porque este projeto não modela um Device
Status Byte genérico ainda (mesma lacuna do Anexo E.4 sobre RC=64).

## F.12 -- Contagens finais (Universal fechado)

```text
Universal standardized commands discovered  = 23 (0-22, 38, 48; IDs 4/5/10 são Reserved dentro desse total)
Universal implemented                       = 22 (todos exceto 10)
Universal NOT_APPLICABLE (Reserved, correto)= 3  (4, 5, 10)
Universal remaining                         = 0
Universal blocked internally                = 0
Universal blocked by spec access            = 0

fake fallback handlers                      = 0
standard commands still using fake bodies   = 0
manufacturer commands accidentally in C++   = 0
generic Common Practice enable/disable toggles = 0
```

`HartExpr::Kind::LoopCurrentMilliamps`/`PercentOfRange` (novo, sessão 8) é
a única primitiva aritmética da DSL -- um nó dedicado para a ÚNICA fórmula
que qualquer HART command neste projeto precisa (mapeamento linear
4-20mA), não uma linguagem de expressões genérica.

## F.14 -- Common Practice (HCF_SPEC-151 Rev 10.0, `spec151r10.0.pdf`)

### F.14.1 -- Cluster Device Variables: Commands 33/34/53/54/79 -- IMPLEMENTADO

O cluster foi implementado como StandardCore, usando `spec151r10.0.pdf`, sem
toggle de perfil e sem fallback de eco. A aplicabilidade Ã© derivada da tabela
numÃ©rica de Device Variables do plano; a DSL de fabricante nÃ£o define estes
comandos.

| Comando | SemÃ¢ntica implementada | Golden/regressÃ£o |
|---|---|---|
| 33 | lÃª atÃ© quatro slots `code + units + float32` | slot PV de 6 bytes e valor canÃ´nico |
| 34 | grava/lÃª damping da PV como float32 | read-after-write |
| 53 | grava unidades da Device Variable | altera o mesmo registro usado por 33/54/79 |
| 54 | informa code, serial, units, limites, damping, span, classificaÃ§Ã£o, famÃ­lia, aquisiÃ§Ã£o e propriedades | registro de 34 bytes |
| 79 | grava Device Variable com modo, unidades e status | mismatch de unidades rejeitado atomicamente |

Os metadados numÃ©ricos sÃ£o preservados no `hartVariablesJson` durante
save/reopen; o campo textual `unit` continua sendo apenas apresentaÃ§Ã£o. A
validaÃ§Ã£o C++ de sintaxe passou e a suÃ­te completa TypeScript passou. O build
executÃ¡vel C++ nÃ£o foi relinkado neste ambiente porque o checkout nÃ£o possui
`ctest`/MSVC (`dotnet msbuild` tambÃ©m nÃ£o encontra `Microsoft.Cpp.Default.props`);
isso Ã© limitaÃ§Ã£o de toolchain, nÃ£o erro de compilaÃ§Ã£o detectado no cÃ³digo.

### F.14.2 -- Auditoria de estado canÃ´nico StandardCore

Auditoria concluÃ­da nos comandos StandardCore existentes. Literais restantes
de resposta foram classificados como constantes normativas HART ou como
fallback explicitamente exigido quando o modelo declara que a capacidade nÃ£o
existe (por exemplo, status adicional all-clear, Reserved=250 e campos
Not-Used). Valores de PV, unidade, valor, limites, damping, serial,
classificaÃ§Ã£o, famÃ­lia, status e propriedades passam pelo registro
`HartDevicePlan::VariableConfiguration`/`HartExecutionVariables::DeviceVariable`.

| Propriedade | Armazenamento canÃ´nico | Identidade | InicializaÃ§Ã£o/escrita | Leitura |
|---|---|---|---|---|
| Device Variable value | `VariableConfiguration::value` + cache runtime | `variableId`/code | authoring, Signal Graph e Command 79 quando writable | 9, 33, 54, 79 |
| Device Variable units | `deviceVariableUnit` | code/variableId | authoring/profile e Command 53 | 9, 33, 54, 79 |
| Device Variable damping | `dampingValue` | code/variableId | authoring e Command 34 | 15, 34, 54 |
| limites/serial/classificaÃ§Ã£o/famÃ­lia/status/propriedades | campos da mesma `VariableConfiguration` | code/variableId | authoring/default normativo | 9, 33, 54, 79 |

Resultado do gate: `HARDCODED DEVICE DATA IN STANDARDCORE = 0` para dados
variÃ¡veis do dispositivo; `DUPLICATE CANONICAL HART DEVICE STATE = 0` para o
cluster. Constantes de protocolo (IDs, larguras, cÃ³digos Common Table,
Reserved/Not-Used e fallbacks de capacidade nÃ£o modelada) permanecem no DSL
compilado como `NORMATIVE_PROTOCOL_CONSTANT`.

Trabalho em andamento nesta sessão -- ver commits e histórico de teste
para o estado mais atual; esta seção é atualizada por cluster, não por
comando individual, para não duplicar o que os commits já registram em
detalhe.

### F.14.0 -- Infraestrutura necessária antes do cluster Device Variables

Common Practice references "Device Variable Code" (Common Table 34) e
reutiliza a mesma noção de PV/SV/TV/QV já usada pelos Universal Commands
9/21. Nenhuma infraestrutura nova de classificação foi necessária para o
primeiro cluster -- reutiliza `HartVarId::PrimaryVariable`/
`PrimaryVariableUnit` e o padrão FOR_CODES já estabelecido.
# Auditoria final independente -- Common Practice HART

| Propriedade | Fonte canônica | Leitores | Escritores | Persistida? | Duplicata/fixo de dispositivo | Status |
|---|---|---|---|---|---|---|
| identidade e Universal identity fields | `HartDevicePlan` | Commands 0/11/12/13/16/17/18/19/20/21/22 | authoring e writes Universal | sim | execution variables são snapshot | OK |
| polling address e loop current mode | `HartDevicePlan` | Commands 6/7 e transporte | authoring e 6/7 | sim | membro do componente é ponte | OK |
| Device Variable id/code/role/direction | `VariableConfiguration` | 9/21/33/54/79 e Signal Graph | Inspector/DSL autorizado | sim | id é authoring; code é fio HART | OK |
| value/unit/damping/limits/serial/classification/family/status/properties | `VariableConfiguration` | 9/15/33/34/53/54/79 | authoring, Signal Graph e writes validados | sim | nenhum dado de dispositivo hardcoded | OK |
| disponibilidade e programa de comando | perfil + configurações + DSL compilada | dispatcher | perfil/DSL | sim | fallback exclusivamente normativo | OK |
| ownership do Signal Graph | `VariableConfiguration::direction` | materialização do grafo | authoring | sim | Input não é gravável pelo Command 79 | OK |

Resultado do gate: `HARDCODED DEVICE DATA IN STANDARDCORE = 0` e
`DUPLICATE CANONICAL HART DEVICE STATE = 0`. Literais restantes são apenas
constantes normativas de protocolo e fallbacks de capacidade não modelada.
MSVC relinkou o código C++, o CTest direcionado `hart_engine` passou e a suíte
TypeScript passou. O próximo cluster Common Practice do Anexo F é **35/36/37
(range values)**; ele precisa de URV/LRV/range-units persistidos por dispositivo
antes de receber writes, pois os valores no perfil são defaults.
# F.14.4 -- Common Practice Range Values 35/36/37 -- IMPLEMENTADO

Implementação verificada contra HCF_SPEC-151 Rev 10.0, seção 7.3--7.5:
Command 35 recebe/responde `unit + URV + LRV` em 9 bytes; Commands 36/37 não
possuem payload de resposta; Command 37 preserva o span ao deslocar a URV.
`rangeUnitCode`, `lowerRangeValue` e `upperRangeValue` vivem na mesma
`VariableConfiguration` da PV. O range é independente da unidade PV, conforme
a especificação. Os writes validam payload, finitude, unidade, limites, span e
write-protect antes de um único ponto de commit.

Goldens e regressões cobrem 35/36/37, leitura cruzada pelo Universal 15,
truncamento atômico, write protection, damping independente e persistência do
plano. Não existe estado `command35*`, `command36*` ou `command37*`.
# F.14.5 -- Common Practice Command 44 -- IMPLEMENTADO

HCF_SPEC-151 Rev 10.0, seção 7.12: Command 44 recebe e responde um único
PV Units Code. A unidade canônica da PV (`deviceVariableUnit`) e a unidade de
apresentação do range (`rangeUnitCode`) são atualizadas juntas; LRV/URV e seus
valores numéricos não são convertidos automaticamente, pois a especificação
define seleção de unidade, não uma regra universal de conversão. O command
respeita write protection, unidades permitidas e payload exato, sem estado
`command44Unit`.
# F.14.6 -- Common Practice 39--47 e Loop Current -- IMPLEMENTADO

HCF_SPEC-151 Rev. 10.0 foi aplicado aos comandos 39--47. O modelo de Loop
Current agora é único no `HartDevicePlan`: modo fixed, alvo de corrente, zero
trim, gain trim e estado derivado são compartilhados pelos Universal 2/3 e
Common Practice 40/45/46. Command 40 altera somente o modo/valor operacional;
Command 42 limpa esse estado volátil. Commands 45/46 alteram calibração, e
Commands 43/47 alteram respectivamente o offset de zero e a configuração de
transfer function da PV.

Command 39 valida e ecoa o código EEPROM normativo, sem inventar um buffer de
EEPROM físico; o projeto continua sendo a autoridade de persistência. Command
41 é determinístico e não cria threads ou sleeps; Command 42 não reinicia o
processo, a extensão ou a sessão. Todos os writes validam o payload antes do
commit e usam o mesmo write-protect canônico.
# F.14.7 -- Common Practice Commands 49--59 -- IMPLEMENTADO

O plano agora mantém uma única autoridade para assignments PV/SV/TV/QV,
metadata de transducer por Device Variable, damping, zero offset, metadata de
Unit (Tag/Descriptor/Date) e preâmbulos de resposta. Commands 50/51 fazem
leitura/escrita atômica dos quatro códigos; Commands 49/56 e 55 compartilham
respectivamente serial e damping com Command 54; 52 compartilha zero metadata
com o ajuste de PV; 57/58 reutilizam o estado de unidade já usado pelos
Universals; 59 atualiza o mesmo valor reportado por Command 0.

Os payloads foram implementados conforme HCF_SPEC-151 Rev. 10.0, com validação
antes do commit, proteção de escrita e respostas de echo. Não foram criados
campos `command50*`, `command55*`, `command56*` ou `command59*`.
# F.14.8 -- Common Practice Commands 60--70 -- IMPLEMENTADO

### F.14.9 -- Temperature Device Family 1024--1027, 1152--1155, 1556 e 1157 -- IMPLEMENTADO

Inventário fechado contra `HCF_SPEC-160.4 Revision 2.0`, release de 12 May 2011.
Esta é a revisão normativa local utilizada, sem mistura com a especificação
antiga 1.0. A aplicabilidade base é `Device Variable Classification = 64`,
com capabilities explícitas no registro canônico para termopar, RTD calibrado,
Temperature Standard, conexão de sonda e compensação de junta fria.

| Comando | Payload normativo | Estado canônico/aplicabilidade |
|---|---|---|
| 1024 Read Temperature Status | code + status + status0 (3 bytes) | `temperature.familyStatus`/`familyStatus0`; DV Temperature |
| 1025 Read Temperature Configuration | code + probe type + wires + standard + connection (5 bytes) | metadata da mesma DV |
| 1026 Read Thermocouple Configuration | code + connection + CJC + unit + float32 (8 bytes) | `supportsThermocouple` |
| 1027 Read Callendar–Van Dusen Coefficients | code + quatro float32 (17 bytes) | `supportsCalibratedRtd` |
| 1152 Write Temperature Probe Type | code + probe type + wires (3 bytes) | commit atômico de probe/wires |
| 1153 Write Temperature Standard | code + standard (2 bytes) | `supportsWriteTemperatureStandard` |
| 1154 Write Temperature Probe Connection | code + connection (2 bytes) | `supportsWriteProbeConnection` |
| 1155 Select Cold Junction Compensation Type | code + CJC type (2 bytes) | `supportsWriteColdJunction` |
| 1556 Write Manual Cold Junction Temperature | code + unit + float32 (6 bytes) | mesma capability; float finito |
| 1157 Write Temperature Callendar–Van Dusen Coefficients | code + quatro float32 (17 bytes) | `supportsCalibratedRtd`; R0 positivo |

Todos os writes validam DV, tamanho, enumeração, capability, write-protect e
lock antes do commit. O estado é persistido por DV em `hartVariablesJson` e
reaberto no mesmo registro; cada commit válido incrementa uma vez o contador
canônico de Configuration Changed. Não existe estado `command1024*` separado.

## F.15 -- WirelessHART (HCF_SPEC-155 Rev 2.0)

O inventário normativo foi reconstruído diretamente da seção 7 de
`spec155r2.0`: o range Wireless definido é 768--823, 832--862, 960--979,
além de 64,512. Nesta etapa foi fechado o cluster de provisionamento e
parâmetros básicos com capability explícita `wireless.capable`; dispositivos
sem essa capability rejeitam o comando e não recebem estado Wireless
sintético.

| IDs | Nomes oficiais | Request/response | Estado canônico | Status |
|---|---|---|---|---|
| 768 | Write Join Key | 16 / 16 bytes | `wireless.joinKey` | DONE_SPEC_VERIFIED |
| 769 | Read Join Status | vazio / 14 bytes | status de join bounded | DONE_SPEC_VERIFIED |
| 770 | Request Active Advertising | uint32 / uint32+uint32+u8 | advertising state | DONE_SPEC_VERIFIED |
| 771--772 | Force/Read Join Mode Configuration | 5/6 e vazio; 5/6 | join mode, shed time, retries | DONE_SPEC_VERIFIED |
| 773--774 | Write/Read Network ID | u16 / 4 bytes | current/pending Network ID | DONE_SPEC_VERIFIED |
| 775--776 | Write/Read Network Tag | 32 / 32 bytes Latin-1 | bounded network tag | DONE_SPEC_VERIFIED |
| 797--798 | Write/Read Radio Transmit Power | u8 signed / u8 signed | radio power | DONE_SPEC_VERIFIED |
| 804--805 | Read/Write CCA Mode | vazio/u8; u8/u8 | CCA mode | DONE_SPEC_VERIFIED |
| 808--809 | Read/Write Packet TTL | vazio/u8; u8/u8 | TTL com mínimo normativo 8 | DONE_SPEC_VERIFIED |
| 810--813 | Join/Receive Priority | vazio/u8 e u8/u8 | bounded priorities | DONE_SPEC_VERIFIED |
| 821--822 | Write/Read Network Access Mode | u8/u8 e vazio/u8 | access mode | DONE_SPEC_VERIFIED |
| 860--861 | Read/Write Join Key Mode | vazio/u8 e u8/u8 | join-key mode | DONE_SPEC_VERIFIED |

Writes Wireless acima usam a mesma autoridade de Configuration Changed,
write-protect e estado persistente `hartAdditionalJson`; chaves são mantidas
somente no modelo canônico e não são logadas. Os demais comandos Wireless
serão classificados no mesmo inventário por sua tabela/estrutura normativa,
sem fallback de sucesso nem eco genérico.

O Analog Channel 0 foi consolidado como a saída Primary/Loop Current
obrigatória da especificação; não existe uma segunda autoridade para o mesmo
valor físico. Commands 60/61/62 leem level/percent/dynamic variables, Command
63 lê a configuração, 64/65 escrevem damping/range, 66 controla fixed mode,
67/68 compartilham os trims de Loop Current, 69 grava transfer function e 70
lê endpoints.

O modelo atual declara explicitamente apenas o canal 0; channels adicionais não
são inventados pelo handler. Cada write valida canal, payload, unidade, finitude
e proteção antes do commit. Os testes cobrem 60↔Universal 2, 61↔assignments,
64↔63, 65↔70, 66↔60, 67/68 e 69↔63.

## Anexo F (continuação) -- Auditoria independente, sessão 9: Temperature Device Family, Command 38, reconciliação `standardCoreNoProgram`

Esta seção documenta explicitamente o que foi **independentemente
re-verificado por esta auditoria** nesta sessão, distinto do que já constava
como "IMPLEMENTADO" por trabalho concorrente (F.14.9 acima). Metodologia: bytes
esperados derivados do texto da especificação ANTES de olhar o código, depois
comparados a código e a teste -- nunca aceito por nome de campo ou por teste
verde isoladamente (ver Anexo F.4/F.3 sobre o precedente do Command 54).

### F.15.1 -- Temperature Device Family (1024-1027, 1152-1157, 1556): DONE_SPEC_VERIFIED, zero defeitos

Derivado byte a byte de `spec160.4r2.0.txt` (HCF_SPEC-160.4 Revision 2.0,
Release 12 May 2011), seção 5.1-5.10, independentemente da tabela já publicada
em F.14.9:

- 1024: request 1 byte (DVC); response 3 bytes (DVC, Temperature Family DV
  Status, Temperature Family Status 0) -- código confere byte a byte.
- 1025: response 5 bytes (DVC, Probe Type, Number Of Wires, Temperature
  Standard, Probe Connection) -- código confere.
- 1026: response 8 bytes (DVC, Probe Connection, CJC Type, Units, float32 CJC
  Temperature) -- código confere; gate `supportsThermocouple` correto.
- 1027: response 17 bytes (DVC + CVD A/B/C/R0, float32 cada) -- código
  confere; gate `supportsCalibratedRtd` correto.
- 1152: request/response 3 bytes (DVC, Probe Type, Number Of Wires) -- confere.
- 1153/1154/1155: request/response 2 bytes (DVC + enum) -- confere para os
  três.
- 1556 "Write Manual Cold Junction Temperature": a especificação real usa o
  número **1556**, não 1156 -- confirmado no próprio texto da TOC (`spec160.4`
  §5.9, numeração não sequencial dentro da faixa 1152-1157 é do próprio HCF,
  não um typo). O código já usava `command == 1556` corretamente; suspeita
  inicial desta auditoria de que fosse um erro de digitação foi descartada
  após ler o texto normativo. Request/response 6 bytes (DVC, Unit, float32) --
  confere.
- 1157: request/response 17 bytes (DVC + CVD A/B/C/R0) -- confere; validação
  extra `r0 > 0` é apenas defensiva (resistência física não pode ser <= 0),
  não contradiz a especificação.
- Classificação 64 = Temperature confirmada em `spec183r22.0.txt` Tabela 21
  (Device Variable Classification Codes; 65 = Pressure, 66 = Volumetric Flow,
  já confirmados em sessão anterior) -- o filtro
  `variable.classification == 64` usado no dispatch é o valor correto, não um
  marcador arbitrário de teste.
- Convenção de sentinelas de enum (`value <= 249 || value == 251`) é
  consistente com o padrão já auditado em Pressure 1408-1410
  (`validPressureEnum`): 250 = "Not Used" (não é uma seleção de escrita válida),
  251 = "None" (seleção legítima). Nenhuma duplicação de autoridade encontrada
  neste cluster.

**Conclusão: zero defeitos no cluster Temperature. Status confirmado
`DONE_SPEC_VERIFIED` por esta auditoria (F.14.9 relatava "implementado";
agora está também independentemente verificado byte a byte).**

### F.15.2 -- Defeito real encontrado e corrigido: Command 38 rejeitava a forma legada (0 bytes)

Derivado de `spec127r7.1.txt` §6.23.1 ("Backward Compatibility
Requirements"): um Master HART Revision 6 ou anterior envia Command 38 **sem
nenhum byte de dados** (o campo Configuration Change Counter só existe a
partir da Revision 7), e o dispositivo é obrigado a resetar o bit
incondicionalmente mesmo assim -- não pode recusar a requisição só porque o
tamanho não é 2.

Código encontrado (antes da correção, `HartReferenceCatalog.cpp`, dispatch de
`command == 0x26`): `if (request.size() != 2) return false;` -- isto rejeita
exatamente a forma legada que a especificação exige aceitar. Nenhum teste
existente cobria o caso de 0 bytes (os dois testes existentes, na sessão
anterior e nesta, só exercitam a forma de 2 bytes).

Corrigido: um ramo explícito para `request.empty()` que reseta o bit
incondicionalmente e retorna uma resposta de 0 bytes (o formato legado nunca
carregou este campo). Regression test adicionado logo após o teste existente
de Command 38 em `HartEngineTest.cpp`, cobrindo exatamente esta lacuna.
Build + `hart_engine_test.exe` confirmados verdes após a correção.

Correção também no próprio Anexo F.11.2 (abaixo, tratado como reconciliação de
documentação, não um segundo achado): aquela nota dizia "não zera nenhum bit
porque este projeto não modela um Device Status Byte genérico ainda" -- isso
está desatualizado. O trabalho concorrente já wireou `command == 0x26` para
zerar o bit 0x40 de `plan.diagnosticStatus` comparando contra
`plan.configurationChangedCounter`, e Command 48 já expõe esse mesmo byte.
F.11.2 deve ser lida como histórica (verdadeira quando escrita), não como
estado atual.

### F.15.3 -- `configurationChangedCounter`: confirmado autoridade única

Reavaliado explicitamente: `HartDevicePlan::configurationChangedCounter`
(campo vivo do dispositivo, incrementado por Command 38 relacionado e por
todos os writes de Common Practice/Pressure/Temperature que mutam configuração
persistida) e `HartEventNotificationRecord::configurationChangedCounter` (um
campo *dentro de um registro de notificação*, isto é, uma cópia congelada do
valor no momento em que aquele evento específico foi emitido) são
semanticamente distintos por desenho -- um Event Notification Record existe
precisamente para capturar um snapshot do estado no momento do evento. Não é
uma recorrência do padrão de duplicação de autoridade do Command 54; é o
padrão correto "valor vivo" vs. "snapshot histórico imutável".

### F.15.4 -- `standardCoreNoProgram`: reconciliado, tratado como documentação auxiliar, não prioridade

Conforme instruído: este booleano é apenas um atalho de despacho ("hÃ¡ um
bloco `if` nativo abaixo para este id, não precisa do early-return"); a
autoridade real sobre "implementado ou não" já é o próprio `if` nativo mais o
guard final `it == programs->end()`. Uma tentativa anterior nesta sessão de
"corrigir" as faixas de exclusão (`inMissingCommonPracticeGap` etc.) foi
baseada em um grep estático que ficou obsoleto por edições concorrentes
simultâneas (Command 110 e Pressure 1285 já haviam sido implementados por
outro agente antes da minha leitura). Reconciliado: o arquivo atual já
reflete `inMissingPressureGap = false` e removeu 110 da lista, e a suíte de
testes completa passa (`HART engine contracts: PASS`) com o estado atual.
Não há inconsistência documental restante que justifique prioridade adicional
aqui -- registrado apenas para fechamento, retornando à auditoria principal
como instruído.

### F.15.5 -- Matriz incremental desta sessão

| Área/Comando | Spec | Verificado independentemente? | Defeito encontrado? | Corrigido? | Teste de regressão? | Status |
|---|---|---|---|---|---|---|
| Temperature 1024-1027 | HCF_SPEC-160.4 §5.1-5.4 | Sim | Não | N/A | Já existiam (concorrente) | DONE_SPEC_VERIFIED |
| Temperature 1152-1155,1556,1157 | HCF_SPEC-160.4 §5.5-5.10 | Sim | Não | N/A | Já existiam (concorrente) | DONE_SPEC_VERIFIED |
| Universal 38 (0x26), forma 2 bytes | HCF_SPEC-127 §6.23 | Sim | Não | N/A | Já existia | DONE_SPEC_VERIFIED |
| Universal 38 (0x26), forma legada 0 bytes | HCF_SPEC-127 §6.23.1 | Sim | **Sim** -- rejeitava em vez de resetar incondicionalmente | Sim | Adicionado nesta sessão | DONE_SPEC_VERIFIED |
| `configurationChangedCounter` (autoridade) | N/A (arquitetural) | Sim | Não (falso positivo descartado) | N/A | N/A | Verificado |
| `standardCoreNoProgram` (auto-documentação) | N/A (interno) | Sim | Inconsistência documental apenas, sem impacto em runtime | Já reconciliado concorrentemente | N/A | Fechado, não prioritário |
| Command 49 (0x31) | HCF_SPEC-151 §7.17 | Sim | Não | N/A | Já existia | DONE_SPEC_VERIFIED |
| Command 50 (0x32) | HCF_SPEC-151 §7.18 | Sim | Não | N/A | Já existia | DONE_SPEC_VERIFIED |
| Command 51 (0x33), forma completa (4 bytes) | HCF_SPEC-151 §7.19 | Sim | Não | N/A | Já existia | DONE_SPEC_VERIFIED |
| Command 51 (0x33), forma truncada (1-3 bytes) | HCF_SPEC-151 §7.19.1 | Sim | **Sim** -- rejeitava em vez de aceitar e preservar os slots não especificados | Sim | Adicionado nesta sessão | DONE_SPEC_VERIFIED |
| Command 52 (0x34) | HCF_SPEC-151 §7.20 | Sim | Não | N/A | N/A (cobertura indireta) | DONE_SPEC_VERIFIED |
| Command 57/58 (0x39/0x3A) | HCF_SPEC-151 §7.25-7.26 | Sim | Não | N/A | N/A (cobertura indireta) | DONE_SPEC_VERIFIED |
| Command 59 (0x3B) | HCF_SPEC-151 §7.27 | Sim | Não | N/A | N/A (cobertura indireta) | DONE_SPEC_VERIFIED |

### F.15.6 -- Nota de processo: colisão de edição concorrente real, ao vivo, no mesmo bloco (Command 51)

Durante a correção do Command 51 (0x33), esta auditoria encontrou e corrigiu
a ausência do ramo de compatibilidade retroativa (7.19.1). Entre uma
compilação e a seguinte, outro agente editou exatamente o mesmo bloco de
código (mesmo `if (command == 0x33)`) e, ao fazer isso, removeu sem intenção
aparente a validação "códigos 244-249 são seleção inválida" que já existia
antes desta sessão. `git diff` confirmou que a remoção não fazia parte desta
auditoria. Como a validação removida é normativa (7.19, não apenas uma
preferência de estilo), foi restaurada explicitamente, preservando todo o
resto do trabalho concorrente (inclusive um cluster WirelessHART 768-776
inteiramente novo que apareceu no mesmo arquivo durante essa janela). Suite
completa confirmada verde (`HART engine contracts: PASS`) após a
reconciliação. Isto é o padrão de reconciliação já estabelecido no Anexo F
(seção 6 do pedido do usuário) aplicado a uma colisão real, não hipotética.

### F.15.7 -- Defeito real, silencioso, classe Command-54: Universal 48 (0x30) tinha DUAS implementações divergentes

Ao caçar sistematicamente o padrão "duas representações do mesmo campo
semântico" (item 5 do pedido do usuário) nos comandos com cláusula
"Backward Compatibility Requirements" (alto valor: já produziu os defeitos
de Command 38 e 51 nesta sessão), Universal Command 48 (Read Additional
Device Status, HCF_SPEC-127 §6.24) revelou o MESMO padrão do bug histórico
do Command 54, e não apenas uma lacuna de compatibilidade:

- `HartEngine::execute()` tinha um handler nativo para `command == 0x30`
  **mas só quando `request.empty()`** -- construía os 9 bytes reais a partir
  de `plan.diagnosticStatus` e da simulação de status.
- `HartReferenceCatalog::commandPrograms()` registrava um SEGUNDO programa
  DSL para o mesmo id 0x30, cujo `resp` era um literal de 9 bytes zero,
  incondicional -- nunca lia `plan.diagnosticStatus`.
- Como o handler nativo só intercepta requests vazios, qualquer request NÃO
  vazio (ou seja, a forma HART7 normal, com os bytes de comparação que a
  §6.24 descreve, não apenas a forma legada) caía no `m_programHook` e
  recebia o stub DSL -- sempre "tudo limpo", mesmo com uma condição de
  diagnóstico real ativa. Um host fazendo polling corretamente (enviando os
  bytes de comparação) NUNCA veria o status real; só um caller usando a
  forma legada de 0 bytes via o motor de testes via essa via.
- Todos os testes existentes (`HartEngineTest.cpp`, 3 ocorrências) só
  chamavam Command 48 com `{}` (vazio) -- exatamente o único caminho que
  usava o handler correto -- mascarando o defeito exatamente como o teste
  do Command 54 mascarava seu próprio bug antes desta auditoria.

Corrigido: o handler nativo em `HartEngine.cpp` deixou de exigir
`request.empty()` (a especificação exige a mesma resposta
"irrespective of the contents of the Request Data Bytes"); o stub DSL
duplicado foi removido inteiramente de `HartReferenceCatalog.cpp`, deixando
exatamente uma autoridade. Regression test adicionado: seta
`diagnosticStatus = 0x80` via `setDiagnosticStatus`, chama Command 48 com um
request de 9 bytes não vazio, confirma que o byte 0 da resposta é `0x80` (não
zero) -- este teste teria falhado antes da correção. Build + suite completa
confirmados verdes.

Não modelado (gap disclosed, distinto do bug acima): o reset condicional do
bit "More Status Available" por Master quando os bytes de comparação
conferem exatamente (§6.24/6.24.1) -- este projeto não tem um bit de status
por-Master ainda. Isso é uma lacuna de modelagem já conhecida (mesma classe
do gap documentado do Command 6), não um bug silencioso.

| Área/Comando | Spec | Verificado independentemente? | Defeito encontrado? | Corrigido? | Teste de regressão? | Status |
|---|---|---|---|---|---|---|
| Universal 48 (0x30), request vazio | HCF_SPEC-127 §6.24.1 | Sim | Não | N/A | Já existia | DONE_SPEC_VERIFIED |
| Universal 48 (0x30), request não vazio | HCF_SPEC-127 §6.24 | Sim | **Sim** -- stub DSL duplicado sempre retornava zero, ignorando o status real | Sim | Adicionado nesta sessão | DONE_SPEC_VERIFIED (conteúdo da resposta); reset do bit More-Status-Available por Master permanece NOT_IMPLEMENTED (disclosed) |
| Universal 6 (0x06), forma completa (2 bytes) | HCF_SPEC-127 §6.7 | Sim | Não | N/A | Já existia | DONE_SPEC_VERIFIED |
| Universal 6 (0x06), forma legada (1 byte) | HCF_SPEC-127 §6.7.1 | Sim | Gap já divulgado no próprio código-fonte (comentário explícito), não um bug silencioso | Não corrigido nesta sessão (risco/benefício: é uma mutação de re-endereçamento ao vivo, já sinalizada como delicada pelo próprio comentário) | N/A | PARTIAL (disclosed) |
| Command 72 (0x48) Squawk, forma legada (0 bytes) | HCF_SPEC-151 §7.40.1 | Sim | Não -- já implementado corretamente (`control = request.empty() ? 2 : request[0]`, 2 = Squawk Once confirmado em Common Table 66) | N/A | N/A (cobertura indireta) | DONE_SPEC_VERIFIED |
| Command 71 (0x47) Lock Device | HCF_SPEC-151 §7.39 | Sim | Não | N/A | N/A (cobertura indireta) | DONE_SPEC_VERIFIED |
| Command 73 (0x49) Find Device | HCF_SPEC-151 §7.41 | Sim | Não | N/A | N/A (cobertura indireta) | DONE_SPEC_VERIFIED |
| Command 74 (0x4A) Read I/O System Capabilities | HCF_SPEC-151 §7.42 | Sim | Não | N/A | N/A (cobertura indireta) | DONE_SPEC_VERIFIED |

### F.15.8 -- Cluster Burst/Catch (105/107/109/113): mais três defeitos reais, incluindo um segundo bug classe Command-54

Continuando a busca sistemática nas seções "Backward Compatibility
Requirements" (alto valor: 3 de 3 achados reais até aqui vieram delas nesta
sessão), o cluster Burst Mode e Catch Device Variable revelou mais defeitos
reais:

**Command 105 (0x69) Read Burst Mode Configuration -- 7.73.1.** A forma
legada (0 bytes, já aceita corretamente) sempre escrevia o byte 1 da resposta
como o literal `31`, mas a especificação exige que, especificamente para essa
forma legada, o byte 1 seja o LSByte do número de comando de burst em vez de
31. Corrigido; regression test adicionado usando o comando 1 (já configurado
via Command 108) para confirmar `byte[1] == 1`, não 31.

**Command 107 (0x6B) Write Burst Device Variables -- 7.75.1.** A forma
truncada (1-4 bytes) era rejeitada inteiramente (`request.size() != 9 ->
false`) em vez de aceita com os slots não especificados preenchidos com 250
"Not Used" e Burst Message assumido 0, exatamente a mesma classe de bug já
corrigida no Command 51/38. Corrigido; regression test adicionado confirmando
que uma escrita de 1 byte retorna os 9 bytes completos não truncados.

**Command 109 (0x6D) Burst Mode Control -- 7.77, ordem de bytes trocada.**
Achado por extração de texto sem `-layout` (a tabela `-layout` rendeu
ambígua): a forma moderna (2 bytes) é `{Burst Mode Control Code, Burst
Message}`, controle PRIMEIRO. O código lia `index = request[0]` e `control =
request[1]` -- ordem invertida. O teste existente usava `{0, 1}` esperando
"liga a mensagem 0", o que só "funcionava" porque o bug e o dado do teste
concordavam por acidente -- mesmo padrão do Command 54 (bug no código e no
teste, mascarando um ao outro). Corrigido para `control = request[0]`,
`index = request[1]`; teste ajustado para `{1, 0}` (semântica correta) e uma
segunda leitura via Command 105 confirma `byte[0] == 1` (controle realmente
ligado), fechando o ciclo.

**Command 113 (0x71/0x72) Catch Device Variable -- 7.81, MESMO padrão do
Command 54 (dois campos de byte trocados + leitura decalada em uma posição).**
O mais sério dos quatro achados deste cluster. Layout real (confirmado por
extração sem `-layout`): `{Destino DV(1), Modo de Captura(1), Endereço
Escravo Fonte(5), marcador 31/0x1F(1), Número do Slot Fonte(1), Shed Time
float(4), Número do Comando Fonte 16-bit(2)} = 15 bytes`. O código trocava os
papéis dos bytes 7 e 8 (lia `sourceSlot` do byte 7 -- que deveria ser o
marcador/comando -- e nunca usava o byte 8 real) e, como consequência,
decodificava o float de Shed Time a partir dos bytes 8-11 em vez de 9-12 --
um deslocamento de um byte que corrompe silenciosamente o valor. O teste
existente usava Shed Time = 0.0 (todos os bytes zero), o único valor capaz de
disfarçar completamente esse deslocamento, e não verificava nenhum byte
individual da resposta -- apenas o tamanho. Corrigido: `sourceSlot` agora lê
do byte 8, Shed Time do span correto (9-12), e a resposta escreve o marcador
`31` (ou, numa resposta à própria escrita legada de 7.81.1, o LSByte do
comando) no byte 7 e o slot no byte 8. Implementada também a forma legada
(13 bytes, sem os bytes 13-14, comando de 1 byte no próprio byte 7) exigida
por 7.81.1, incluindo a regra "o número do comando deve retornar tanto no
byte 7 quanto nos bytes 13-14" para essa forma. Testes reforçados com valores
não degenerados (Shed Time = 2.5, não 0.0) e verificação byte a byte real,
mais um teste dedicado à forma legada de 13 bytes -- nenhum dos dois existia
antes desta sessão nesta profundidade.

| Área/Comando | Spec | Verificado independentemente? | Defeito encontrado? | Corrigido? | Teste de regressão? | Status |
|---|---|---|---|---|---|---|
| Command 105 (0x69), forma moderna | HCF_SPEC-151 §7.73 | Sim | Não | N/A | Já existia | DONE_SPEC_VERIFIED |
| Command 105 (0x69), forma legada (0 bytes) | HCF_SPEC-151 §7.73.1 | Sim | **Sim** -- byte 1 sempre 31, nunca o LSByte do comando | Sim | Adicionado nesta sessão | DONE_SPEC_VERIFIED |
| Command 106 (0x6A) Flush Delayed Responses | HCF_SPEC-151 §7.74 | Sim | Não | N/A | Já existia | DONE_SPEC_VERIFIED |
| Command 107 (0x6B), forma moderna (9 bytes) | HCF_SPEC-151 §7.75 | Sim | Não | N/A | Já existia | DONE_SPEC_VERIFIED |
| Command 107 (0x6B), forma legada (1-4 bytes) | HCF_SPEC-151 §7.75.1 | Sim | **Sim** -- rejeitada inteiramente | Sim | Adicionado nesta sessão | DONE_SPEC_VERIFIED |
| Command 108 (0x6C) Write Burst Mode Command Number | HCF_SPEC-151 §7.76/7.76.1 | Sim | Não (já corretamente implementado, ambas as formas) | N/A | Já existia | DONE_SPEC_VERIFIED |
| Command 109 (0x6D), forma moderna (2 bytes) | HCF_SPEC-151 §7.77 | Sim | **Sim** -- ordem control/index invertida | Sim | Corrigido + adicionado nesta sessão | DONE_SPEC_VERIFIED |
| Command 109 (0x6D), forma legada (1 byte) | HCF_SPEC-151 §7.77.1 | Sim | Não | N/A | Já existia | DONE_SPEC_VERIFIED |
| Command 113/114 (0x71/0x72), forma moderna (15 bytes) | HCF_SPEC-151 §7.81 | Sim | **Sim** -- bytes 7/8 trocados + Shed Time decalado (padrão Command 54) | Sim | Reforçado nesta sessão | DONE_SPEC_VERIFIED |
| Command 113 (0x71), forma legada (13 bytes) | HCF_SPEC-151 §7.81.1 | Sim | **Sim** -- não implementada (rejeitada) | Sim | Adicionado nesta sessão | DONE_SPEC_VERIFIED |
| Command 77 (0x4D) Send Command to Sub-Device | HCF_SPEC-151 §7.45 | Sim (revisado estruturalmente; convenção de comando estendido 2-byte não modelada, consistente com o resto do projeto) | Não | N/A | N/A (cobertura indireta) | DONE_SPEC_VERIFIED |

### F.15.9 -- Command 81 (0x51): terceiro bug classe Command-54 -- byte de eco ausente

`spec151r10.0` §7.49, confirmado por extração sem `-layout`: a resposta do
Command 81 (Read Device Variable Trim Guidelines) começa ecoando o Device
Variable Code solicitado no byte 0, exatamente como Command 80 (mesmo
cluster, já correto) e como todo o resto deste cluster de comandos. O código
pulava direto para `trimPointsSupported` como primeiro byte escrito,
produzindo uma resposta de 22 bytes em vez de 23, com todos os campos
subsequentes deslocados um byte para trás em relação à especificação. O teste
existente afirmava `size() == 22` -- o mesmo padrão exato do bug do
Command 54 (código errado, teste combinando com o erro, suite verde).
Corrigido: byte 0 agora ecoa `request[0]`; teste corrigido para `size() == 23`
com verificação explícita do byte de eco.

| Área/Comando | Spec | Verificado independentemente? | Defeito encontrado? | Corrigido? | Teste de regressão? | Status |
|---|---|---|---|---|---|---|
| Command 80 (0x50) Read Device Variable Trim Points | HCF_SPEC-151 §7.48 | Sim | Não | N/A | Já existia | DONE_SPEC_VERIFIED |
| Command 81 (0x51) Read Device Variable Trim Guidelines | HCF_SPEC-151 §7.49 | Sim | **Sim** -- byte de eco (DVC) ausente na resposta, resposta 1 byte curta | Sim | Corrigido nesta sessão | DONE_SPEC_VERIFIED |
| Command 82 (0x52) Write Device Variable Trim Point | HCF_SPEC-151 §7.50 | Sim | Não | N/A | Já existia | DONE_SPEC_VERIFIED |
| Command 83 (0x53) Reset Device Variable Trim | HCF_SPEC-151 §7.51 | Sim | Não | N/A | Já existia | DONE_SPEC_VERIFIED |
