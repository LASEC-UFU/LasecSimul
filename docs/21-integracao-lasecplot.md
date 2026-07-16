# Integração LasecPlot

O LasecSimul exporta pela função `activate()` uma API opcional, versionada (`apiVersion === 1`), para transportar bytes da UART simulada diretamente entre Extension Hosts. Não são usadas portas COM virtuais, arquivos, UDP ou TCP.

## Dispositivo

O tipo `peripherals.lasecplot` possui exclusivamente `tx` (`DIGITAL_OUT`) e `rx` (`DIGITAL_IN`), nas mesmas posições e orientações do Serial Terminal. Não há GND, VCC, 3V3 ou 5V. O firmware conecta TX do MCU a RX do LasecPlot; no modo bidirecional, conecta também TX do LasecPlot a RX do MCU.

O nome do bloco no schematic é também o `Nome da fonte`. Os dois campos são sincronizados: renomear o bloco para `Temperatura do Motor` anuncia `LasecSimul — Temperatura do Motor`. Instâncias novas recebem nomes indexados distintos, e cada uma mantém seu próprio ID interno, stream, sequência e conjunto de clientes.

Baud rate, bits de dados e stop bits participam da decodificação elétrica real. Paridade não é exibida porque ainda não existe no decoder compartilhado. O estado aberto, clientes, buffers e erros são transitórios e não são persistidos no `.lsproj`.

O Core acumula até 4 KiB e a Extension drena lotes a cada 10 ms somente quando há endpoint publicado e consumidor conectado. Os lotes são opacos: linhas fragmentadas, várias linhas e dados binários não são interpretados ou remontados.

## API pública

Os tipos canônicos estão em `extension/src/lasecplot/api.ts`. O consumidor deve localizar o ID oficial `josuemoraisgh.lasecsimul` e validar `apiVersion` antes de usar a API:

```ts
import * as vscode from "vscode";
import type {
  LasecPlotConnection,
  LasecSimulInteropApi,
} from "../lasecsimul/src/lasecplot/api"; // publique uma cópia do contrato em pacote compartilhado

export async function connectToLasecSimul(): Promise<LasecPlotConnection | undefined> {
  const extension = vscode.extensions.getExtension<LasecSimulInteropApi>(
    "josuemoraisgh.lasecsimul",
  );
  if (!extension) return undefined; // LasecSimul é uma fonte opcional

  const api = extension.isActive ? extension.exports : await extension.activate();
  if (api.apiVersion !== 1) throw new Error(`API LasecSimul incompatível: ${api.apiVersion}`);

  api.onDidChangeLasecPlotEndpoints(async () => {
    const current = await api.listLasecPlotEndpoints();
    console.log("Fontes LasecSimul:", current.map((item) => item.displayName));
  });

  const endpoint = (await api.listLasecPlotEndpoints())[0];
  if (!endpoint) return undefined;

  const connection = await api.openLasecPlotEndpoint(endpoint.id, {
    writable: endpoint.writable,
  });
  connection.onData((bytes) => existingIncrementalParser.push(bytes));
  connection.onPacket((packet) => {
    // packet.sequence e packet.simulationTimeNs são opcionais para o pipeline visual.
    console.debug(packet.sequence, packet.simulationTimeNs);
  });
  connection.onDidClose(({ reason }) => console.log("Fonte fechada:", reason));

  if (connection.writable) await connection.write(new TextEncoder().encode("status\r\n"));
  // await connection.close(); // ou connection.dispose()
  return connection;
}
```

`openLasecPlotEndpoint()` permite vários leitores. Uma conexão só recebe escrita quando solicita `{ writable: true }`; apenas um escritor é reservado por endpoint. Escrita em fonte somente leitura e um segundo escritor são rejeitados com mensagens explícitas.

## Identidade e ciclo de vida

O formato é:

```
lasecsimul://workspace/{workspaceHash}/simulation/{sessionId}/lasecplot/{componentId}
```

O hash inclui usuário e workspace, e o session ID inclui o processo e entropia aleatória. Alterar `Nome da fonte` não altera o endpoint durante a simulação. Nomes iguais são desambiguados no `displayName` com o component ID.

Ao pausar, a conexão permanece aberta e nenhum lote novo é produzido. Ao fechar o dispositivo, parar a simulação, remover o componente, encerrar o Core ou desativar a extensão, as conexões recebem `onDidClose` com o motivo correspondente.

## IPC interno

O transporte Core ↔ Extension reutiliza `setProperty` e o novo verbo `getProperty`:

- `getProperty(instanceId, "interop_rx_hex")`: drena até 4096 bytes MCU → cliente;
- `setProperty(instanceId, "interop_tx_hex", hex)`: enfileira até 4096 bytes cliente → MCU;
- `getSimulationTime`: associa `simulationTimeNs` ao lote.

A sequência é mantida pelo broker por endpoint e reinicia quando o dispositivo é aberto. O encoding hexadecimal existe apenas na fronteira JSON do IPC; a API entre extensões entrega `Uint8Array`.
