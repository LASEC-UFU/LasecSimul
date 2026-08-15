---
id: ARCH-005
kind: architecture
status: active
dependsOn: [ARCH-001, ARCH-004]
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

## Snapshots

O coordenador publica snapshot imutável com `planGeneration`, `telemetryGeneration`, `timestampNs` e grupos solicitados. A Extension descarta geração obsoleta e decide FPS/renderização.

## Aceitação

- controle responde sob saturação de telemetria;
- fila nunca cresce sem limite;
- um tick visual usa um request/frame lógico;
- drops e profundidade máxima são observáveis;
- stop/desconexão libera fila e memória compartilhada sem órfãos.
