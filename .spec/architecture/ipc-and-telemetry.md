---
id: ARCH-005
kind: architecture
status: active
dependsOn: [ARCH-001, ARCH-004, ADR-0009]
supersedes: []
---

# IPC e telemetria

## Planos separados

O contrato lógico possui duas lanes, mesmo quando ambas usam o mesmo pipe/socket físico:

- `ReliableControl`: requests, responses, comandos e notificações essenciais;
- `LossyTelemetry`: snapshots visuais, séries e estados substituíveis.

Controle é FIFO, limitado e nunca sofre descarte silencioso. Telemetria é latest-wins por stream/chave e registra frames/bytes descartados.

## Evolução obrigatória

### T0 — filas limitadas

Classificar notificações, impor capacidade por bytes/itens, definir shutdown e expor métricas.

### T1 — frame batelado

Uma operação `getTelemetryFrame(subscription, sinceGeneration)` por tick agrega tensões, instrumentos, runtime visual e taxa. JSON permanece inicialmente.

### T2 — framing binário

Somente após benchmark, arrays numéricos migram para payload binário versionado. Metadados não são repetidos por frame.

### T3 — shared memory local

Somente Scope/stream local de alta taxa que continue limitado por IPC após T2. Controle permanece no pipe. Backend remoto usa streaming binário equivalente, não shared memory.

## Observabilidade causal não é telemetria

Raw causal trace de I2C/UART/Scheduler/solver não trafega em `ReliableControl`, `LossyTelemetry` ou Webview. Cada processo/source grava em buffer/arquivo local bounded quando `DETAILED` é explicitamente habilitado; merge e análise são offline.

Core e runtime externo não compartilham writer de trace, mutex de arquivo ou serviço global. Summary/agregação futura pode ser exposta à UI somente como produto derivado e benchmarkado.

Identidade cross-process é criada no lifecycle e passada no launch; IPC funcional não ganha campos apenas para tracing quando o protocolo existente já fornece uma sequência causal adequada.

## Snapshots

O coordenador publica snapshot imutável com `planGeneration`, `telemetryGeneration`, `timestampNs` e grupos solicitados. A Extension descarta geração obsoleta e decide FPS/renderização.

## Implementação inicial da F4

O Core implementa as lanes em `ipc/NotificationQueue.*` e o frame lógico em
`SimulationSession::getTelemetryFrameSnapshot`/`getTelemetryFrame`:

- `ReliableControl` mantém FIFO próprio, tem prioridade no consumidor e aplica backpressure entre
  mensagens confiáveis. Sob pressão, expulsa somente frames `LossyTelemetry`; controle maior que a
  capacidade é rejeitado explicitamente, nunca de forma silenciosa;
- `LossyTelemetry` usa uma chave estável por stream. Uma publicação nova substitui a anterior ainda
  pendente (`latest-wins`) e contabiliza frames/bytes coalescidos e descartados;
- a soma das lanes respeita `ResourceBudget::telemetryQueueBytes`, a worker continua preguiçosa e
  shutdown limpa as duas filas antes do `join`;
- `getTelemetryFrame(subscription, sinceGeneration)` agrega estados de componentes, tensões e
  relógios em um único JSON. O snapshot carrega `planGeneration`, `telemetryGeneration` monotônica
  e timestamp da mesma fronteira de stable step;
- blobs de componentes e o frame JSON final são limitados pelo orçamento de telemetria. Assinaturas
  novas substituem inscrições anteriores, evitando retenção cumulativa de streams obsoletos;
- a Extension mantém no máximo um frame em trânsito, envia a última geração observada e descarta
  respostas obsoletas. O tick periódico deixou de fazer cinco round-trips independentes;
- `getPerformanceMetrics` expõe profundidade por lane, máximos, coalescência, drops, bytes e rejeições
  de controle. O framing continua JSON; T2/T3 permanecem condicionados a benchmark.

## Aceitação

- controle responde sob saturação de telemetria;
- fila nunca cresce sem limite;
- um tick visual usa um request/frame lógico;
- drops e profundidade máxima são observáveis;
- stop/desconexão libera fila e memória compartilhada sem órfãos;
- raw causal trace nunca compete com lanes de controle/telemetria;
- nenhuma instrumentação adiciona polling periódico ou writer cross-process à IPC normal.
