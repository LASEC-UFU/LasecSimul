import * as vscode from "vscode";
import { IpcError } from "../ipc/protocol";
import { ComponentReadoutValue, InstrumentHistoryPayload, SimulationStatus } from "../ui/webview/messages";
import { CanonicalEndpoint, WebviewComponentCatalogEntry, WebviewComponentModel, WebviewWireModel, endpointId, endpointPinId } from "../ui/webview/model";
import { state, coreInstanceIdByComponentId, mcuTargetCoreIdByComponentId } from "../state";
import { pinsForTypeId } from "../extension";
import { electricalEdgesForProject, diffElectricalEdges } from "../ui/webview/wireTopology";

export { electricalEdgesForProject, diffElectricalEdges };

/** Camada de comunicação com o Core (push de mutações, polling de leitura, ciclo de vida da
 * simulação) -- extraída de `extension.ts` (EX-9, .spec/lasecsimul-native-devices.spec). Todo
 * campo mutável compartilhado (`state.coreClient`/`state.schematicState`/etc.) vem de `../state`;
 * `extension.ts` continua sendo quem REATRIBUI `state.coreClient`/`state.schematicPanel` (conectar/
 * desconectar Core, abrir/fechar painel), este módulo só LÊ esses campos (exceto
 * `state.simulationStatus`/`state.voltageReadoutTimer`, cujo ciclo de vida completo mora aqui). */

export function reportCoreWarning(action: string, err: unknown): void {
  const code = err instanceof IpcError && err.code ? ` [${err.code}]` : "";
  vscode.window.showWarningMessage(
    `LasecSimul Core: ${action} falhou${code}: ${err instanceof Error ? err.message : String(err)}`
  );
}

export function registerCoreIdsForComponent(componentId: string, typeId: string, response: { instanceId: string; primaryMcuInstanceId?: string }): void {
  coreInstanceIdByComponentId.set(componentId, response.instanceId);
  if (response.primaryMcuInstanceId) {
    // Subcircuito hospedando MCU interno -- o alvo é o FILHO (primaryMcuInstanceId), não a
    // instância do subcircuito em si.
    mcuTargetCoreIdByComponentId.set(componentId, response.primaryMcuInstanceId);
    return;
  }
  // Genérico via `mcuHost` (.spec/lasecsimul-native-devices.spec): qualquer typeId que SEJA um
  // mcu-adapter direto (ex: espressif.esp32) não tem `primaryMcuInstanceId` próprio -- o
  // componente É o MCU, sua própria instância é o alvo. Nenhum hardcode de typeId aqui.
  const catalogEntry = state.schematicState.catalog.find((entry) => entry.typeId === typeId);
  if (catalogEntry?.mcuHost === true) mcuTargetCoreIdByComponentId.set(componentId, response.instanceId);
}

/** Escolhe um pino real por rede e o associa a cada condutor geométrico dessa rede. Assim a
 * telemetria nunca tenta consultar um topologyNode no Core e continua usando os IDs visuais. */
export function voltageProbesForProject(
  project: Pick<typeof state.schematicState.topology, "conductors">
): Array<{ wireId: string; componentId: string; pinId: string }> {
  const key = (endpoint: CanonicalEndpoint): string => endpoint.kind === "node" ? `n:${endpoint.nodeId}` : `p:${JSON.stringify([endpoint.componentId, endpoint.pinId])}`;
  const refs = new Map<string, { componentId: string; pinId: string }>();
  const adjacency = new Map<string, Set<string>>();
  for (const wire of project.conductors) {
    const a = key(wire.from); const b = key(wire.to);
    if (wire.from.kind === "port") refs.set(a, wire.from);
    if (wire.to.kind === "port") refs.set(b, wire.to);
    (adjacency.get(a) ?? (adjacency.set(a, new Set()), adjacency.get(a)!)).add(b);
    (adjacency.get(b) ?? (adjacency.set(b, new Set()), adjacency.get(b)!)).add(a);
  }
  const probeByVertex = new Map<string, { componentId: string; pinId: string }>();
  const seen = new Set<string>();
  for (const start of adjacency.keys()) {
    if (seen.has(start)) continue;
    const queue = [start]; const network: string[] = []; let probe: { componentId: string; pinId: string } | undefined;
    seen.add(start);
    while (queue.length) {
      const current = queue.pop()!; network.push(current); probe ??= refs.get(current);
      for (const next of adjacency.get(current) ?? []) if (!seen.has(next)) { seen.add(next); queue.push(next); }
    }
    if (probe) for (const vertex of network) probeByVertex.set(vertex, probe);
  }
  return project.conductors.flatMap((wire) => {
    const probe = probeByVertex.get(key(wire.from)) ?? probeByVertex.get(key(wire.to));
    return probe ? [{ wireId: wire.id, ...probe }] : [];
  });
}

let coreMutationQueue: Promise<unknown> = Promise.resolve();

/** Serializador único para qualquer mutação do Core que leia/escreva `coreInstanceIdByComponentId`
 * ou altere o grafo elétrico. EX-E: rebuild completo, sync por snapshot e pushes incrementais agora
 * entram na mesma fila; nenhuma chamada incremental pode intercalar com `removeComponent`/`addComponent`
 * de um rebuild em andamento. */
export function enqueueCoreMutation<T>(operation: () => Promise<T> | T): Promise<T> {
  const queued = coreMutationQueue
    .catch(() => undefined)
    .then(operation);
  coreMutationQueue = queued.then(
    () => undefined,
    () => undefined
  );
  return queued;
}

/** Cria a instância no Core e só resolve depois que o id da instância foi registrado. Chamadores que
 * não dependem da ordem podem continuar usando `void pushComponentToCore(...)`; fluxos que inserem
 * fios na mesma transação devem aguardar isto antes de chamar `pushWireToCore`. */
async function pushComponentToCoreNow(
  componentId: string,
  typeId: string,
  properties: Record<string, unknown>,
  pins: Array<{ id: string; x: number; y: number }>
): Promise<boolean> {
  if (!state.coreClient || !shouldSyncComponentToCore(typeId)) return false;
  try {
    const response = await state.coreClient.addComponent(typeId, properties, pins);
    registerCoreIdsForComponent(componentId, typeId, response);
    return true;
  } catch (err) {
    reportCoreWarning(`criar "${typeId}"`, err);
    return false;
  }
}

export function pushComponentToCore(
  componentId: string,
  typeId: string,
  properties: Record<string, unknown>,
  pins: Array<{ id: string; x: number; y: number }>
): Promise<boolean> {
  return enqueueCoreMutation(() => pushComponentToCoreNow(componentId, typeId, properties, pins));
}

async function pushWireToCoreNow(wire: WebviewWireModel): Promise<boolean> {
  if (!state.coreClient) return false;
  const coreA = coreInstanceIdByComponentId.get(endpointId(wire.from));
  const coreB = coreInstanceIdByComponentId.get(endpointId(wire.to));
  if (!coreA || !coreB) return false; // um dos lados não existe no Core (typeId não suportado ou ainda não resolvido)
  try {
    await state.coreClient.connectWire(coreA, endpointPinId(wire.from), coreB, endpointPinId(wire.to));
    return true;
  } catch (err) {
    reportCoreWarning("conectar fio", err);
    return false;
  }
}

export function pushWireToCore(wire: WebviewWireModel): Promise<boolean> {
  return enqueueCoreMutation(() => pushWireToCoreNow(wire));
}

/** Nunca deixa uma falha (inclusive `topology_revision_conflict`, ver `CoreClient.wireTopologyRevision`)
 * escapar como exceção -- todo chamador (edição interativa, diff de snapshot, remoção com cascata)
 * trata `false` do mesmo jeito: cai pro `queueCoreRebuild()` de sempre, nunca deixa o Core divergir
 * silenciosamente do que a tela mostra. */
export function pushWireTopologyTransaction(operations: Array<{ kind: "connect" | "disconnect"; wire: WebviewWireModel }>): Promise<boolean> {
  return enqueueCoreMutation(async () => {
    if (!state.coreClient) return false;
    if (operations.length === 0) return true;
    const resolved = operations.map(({ kind, wire }) => {
      const componentA = coreInstanceIdByComponentId.get(endpointId(wire.from));
      const componentB = coreInstanceIdByComponentId.get(endpointId(wire.to));
      if (!componentA || !componentB) return undefined;
      return { kind, from: { componentId: componentA, pinId: endpointPinId(wire.from) }, to: { componentId: componentB, pinId: endpointPinId(wire.to) } };
    });
    if (resolved.some((operation) => operation === undefined)) return false;
    try {
      await state.coreClient.applyWireTopologyTransaction(resolved as Array<{
        kind: "connect" | "disconnect";
        from: { componentId: string; pinId: string };
        to: { componentId: string; pinId: string };
      }>);
      return true;
    } catch (err) {
      reportCoreWarning("aplicar transação de fio", err);
      return false;
    }
  });
}

/** Inverso de `pushWireToCore` (EX-6.1/EX-6.2) -- remove só ESTE fio via `disconnectWire` (IPC
 * incremental), nunca reconstrói o circuito inteiro. Sem isto, apagar N fios selecionados
 * (`deleteSelectedItems` com seleção múltipla manda um `requestRemoveWire` por fio) disparava N
 * `queueCoreRebuild()` sequenciais -- cada um recriando TODOS os componentes/fios do zero (ver
 * EX-6.3, que já coalesce chamadas concorrentes, mas não evita o trabalho de reconstruir tudo
 * quando SÓ um fio precisava sumir). Cai pro rebuild completo de sempre (fallback seguro, nunca
 * deixa o fio "preso" no Core) se algum dos dois lados ainda não tem instância resolvida (ex: bloco
 * de subcircuito não localizado) -- mesmo espírito do `if (!coreA || !coreB) return` acima. */
export function pushRemoveWireToCore(wire: WebviewWireModel | undefined): void {
  if (!wire) return;
  void enqueueCoreMutation(async () => {
    if (!state.coreClient) return;
    const coreA = coreInstanceIdByComponentId.get(endpointId(wire.from));
    const coreB = coreInstanceIdByComponentId.get(endpointId(wire.to));
    if (!coreA || !coreB) {
      await rebuildCoreFromSchematicStateNow();
      return;
    }
    try {
      await state.coreClient.disconnectWire(coreA, endpointPinId(wire.from), coreB, endpointPinId(wire.to));
    } catch (err) {
      reportCoreWarning("remover fio", err);
    }
  });
}

export function isUiOnlyRuntimeProperty(component: WebviewComponentModel | undefined, name: string): boolean {
  if (name.startsWith("__ui_")) return true;
  // "Modo Placa" da instância (overlay no circuito principal) -- sem PropertyDescriptor no Core,
  // só controla renderização/interação na Webview (ver `toggleInstanceBoardMode`).
  if (name === "boardModeEnabled") return true;
  if (!component || (name !== "firmwarePath" && name !== "qemuBinaryOverride")) return false;
  const catalogEntry = state.schematicState.catalog.find((entry) => entry.typeId === component.typeId);
  return catalogEntry?.mcuHost === true;
}

export function pushPropertyToCore(componentId: string, name: string, value: string | number | boolean): void {
  void enqueueCoreMutation(async () => {
    if (!state.coreClient) return;
    const component = state.schematicState.components.find((entry) => entry.id === componentId);
    if (isUiOnlyRuntimeProperty(component, name)) return;
    const coreId = coreInstanceIdByComponentId.get(componentId);
    if (!coreId) return;
    try {
      const { requiresRestart } = await state.coreClient.setProperty(coreId, name, value);
      if (requiresRestart) {
        vscode.window.showInformationMessage(
          `LasecSimul: a propriedade "${name}" só terá efeito completo depois que o componente for recriado.`
        );
      }
    } catch (err) {
      reportCoreWarning(`atualizar propriedade "${name}"`, err);
    }
  });
}

export function pushRemoveToCore(componentId: string): void {
  const coreId = coreInstanceIdByComponentId.get(componentId);
  if (!coreId) return;
  mcuTargetCoreIdByComponentId.delete(componentId);
  void enqueueCoreMutation(async () => {
    if (!state.coreClient) return;
    try {
      await state.coreClient.removeComponent(coreId);
    } catch (err) {
      reportCoreWarning("remover componente", err);
    }
  });
}

export function pushTunnelNameToCore(componentId: string, pinId: string, oldName: string, newName: string): void {
  void enqueueCoreMutation(async () => {
    if (!state.coreClient) return;
    const coreId = coreInstanceIdByComponentId.get(componentId);
    if (!coreId) return;
    try {
      await state.coreClient.setTunnelName(coreId, pinId, oldName, newName);
    } catch (err) {
      reportCoreWarning("renomear túnel", err);
    }
  });
}

/** Lookup único de catálogo por typeId -- usado pelos 3 decodificadores genéricos abaixo (ABI v2,
 * .spec/lasecsimul-native-devices.spec) pra consultar `readoutFormat` sem repetir
 * `state.schematicState.catalog.find(...)` em cada um. */
export function findCatalogEntry(typeId: string): WebviewComponentCatalogEntry | undefined {
  return state.schematicState.catalog.find((entry) => entry.typeId === typeId);
}

/** Decodifica `getComponentState()` SEM checar typeId quando o catálogo já declara
 * `readoutFormat` (ABI v2) -- mesmo formato binário de sempre (scalar = 1 double; channelHistory =
 * N doubles + contagem + histórico; bitmaskHistory = bitmask + contagem + histórico), só que a
 * FORMA vem do Core, não de um `if (typeId)` aqui. Fallback pros typeIds que ainda não declararam
 * (catálogo não carregou do Core ainda) preserva o comportamento de sempre, nunca quebra. */
export function decodeComponentReadout(typeId: string, state: Buffer): ComponentReadoutValue | undefined {
  const readoutFormat = findCatalogEntry(typeId)?.readoutFormat;
  if (readoutFormat?.kind === "scalar") {
    return state.length >= 8 ? state.readDoubleLE(0) : undefined;
  }
  if (readoutFormat?.kind === "channelHistory") {
    if (state.length < readoutFormat.channels * 8) return undefined;
    return Array.from({ length: readoutFormat.channels }, (_, channel) => state.readDoubleLE(channel * 8));
  }
  if (readoutFormat?.kind === "bitmaskHistory") {
    return state.length >= 4 ? state.readUInt32LE(0) : undefined;
  }
  // Fallback legado -- typeId sem readoutFormat no catálogo ainda.
  if (
    typeId === "instruments.voltmeter" ||
    typeId === "meters.probe" ||
    typeId === "meters.ampmeter" ||
    typeId === "meters.freqmeter"
  ) {
    return state.length >= 8 ? state.readDoubleLE(0) : undefined;
  }
  if (typeId === "meters.oscope") {
    if (state.length < 32) return undefined;
    return [0, 1, 2, 3].map((channel) => state.readDoubleLE(channel * 8));
  }
  if (typeId === "meters.logic_analyzer") {
    return state.length >= 4 ? state.readUInt32LE(0) : undefined;
  }
  return undefined;
}

/** Decodifica o histórico REAL (tempo simulado, ver doc de `Oscope.hpp`/`LogicAnalyzer.hpp`) do
 * mesmo `getComponentState()` que `decodeComponentReadout` já usa pra última leitura -- formato:
 * channelHistory = [0..N*8) N doubles + [N*8..N*8+4) uint32 contagem + histórico CHANNEL-MAJOR,
 * cada amostra {uint64 timestampNs, double value}; bitmaskHistory = [0..4) uint32 + [4..8) uint32
 * contagem + histórico {uint64 timestampNs, uint32 bitmask}. `readoutFormat.channels` (ABI v2)
 * substitui o `4`/`8` hardcoded de antes -- espelha EXATAMENTE o `getState()` de cada classe, mudar
 * um lado sem o outro quebra silenciosamente (offsets batem por construção, não por validação em
 * runtime). Fallback legado preserva o comportamento de sempre pra typeId sem readoutFormat. */
export function decodeInstrumentHistory(typeId: string, state: Buffer): InstrumentHistoryPayload["oscope"] | InstrumentHistoryPayload["logic"] | undefined {
  const readoutFormat = findCatalogEntry(typeId)?.readoutFormat;
  if (readoutFormat?.kind === "channelHistory") {
    const headerBytes = readoutFormat.channels * 8;
    if (state.length < headerBytes + 4) return undefined;
    const sampleCount = state.readUInt32LE(headerBytes);
    const channels: Array<{ timestampsNs: number[]; values: number[] }> = [];
    let offset = headerBytes + 4;
    for (let channel = 0; channel < readoutFormat.channels; channel++) {
      const timestampsNs: number[] = [];
      const values: number[] = [];
      for (let i = 0; i < sampleCount; i++) {
        timestampsNs.push(Number(state.readBigUInt64LE(offset)));
        values.push(state.readDoubleLE(offset + 8));
        offset += 16;
      }
      channels.push({ timestampsNs, values });
    }
    return { channels };
  }
  if (readoutFormat?.kind === "bitmaskHistory") {
    if (state.length < 8) return undefined;
    const sampleCount = state.readUInt32LE(4);
    const timestampsNs: number[] = [];
    const masks: number[] = [];
    let offset = 8;
    for (let i = 0; i < sampleCount; i++) {
      timestampsNs.push(Number(state.readBigUInt64LE(offset)));
      masks.push(state.readUInt32LE(offset + 8));
      offset += 12;
    }
    return { timestampsNs, masks };
  }
  // Fallback legado -- typeId sem readoutFormat no catálogo ainda.
  if (typeId === "meters.oscope") {
    if (state.length < 36) return undefined;
    const sampleCount = state.readUInt32LE(32);
    const channels: Array<{ timestampsNs: number[]; values: number[] }> = [];
    let offset = 36;
    for (let channel = 0; channel < 4; channel++) {
      const timestampsNs: number[] = [];
      const values: number[] = [];
      for (let i = 0; i < sampleCount; i++) {
        timestampsNs.push(Number(state.readBigUInt64LE(offset)));
        values.push(state.readDoubleLE(offset + 8));
        offset += 16;
      }
      channels.push({ timestampsNs, values });
    }
    return { channels };
  }
  if (typeId === "meters.logic_analyzer") {
    if (state.length < 8) return undefined;
    const sampleCount = state.readUInt32LE(4);
    const timestampsNs: number[] = [];
    const masks: number[] = [];
    let offset = 8;
    for (let i = 0; i < sampleCount; i++) {
      timestampsNs.push(Number(state.readBigUInt64LE(offset)));
      masks.push(state.readUInt32LE(offset + 8));
      offset += 12;
    }
    return { timestampsNs, masks };
  }
  return undefined;
}

export async function sendInstrumentHistory(componentId: string): Promise<void> {
  if (!state.coreClient || !state.schematicPanel) return;
  const component = state.schematicState.components.find((entry) => entry.id === componentId);
  if (!component) return;
  const coreId = coreInstanceIdByComponentId.get(componentId);
  if (!coreId) return;
  try {
    const coreState = await state.coreClient.getComponentState(coreId);
    const decoded = decodeInstrumentHistory(component.typeId, coreState);
    if (!decoded) return;
    const readoutFormat = findCatalogEntry(component.typeId)?.readoutFormat;
    // `readoutFormat.kind` (ABI v2) diz qual dos 2 formatos `decoded` tem -- `channelHistory` é
    // sempre o payload "oscope" (N canais analógicos), `bitmaskHistory` sempre "logic" (1 palavra
    // digital). Fallback legado (mesmos 2 typeIds do fallback de `decodeInstrumentHistory` acima)
    // cobre o catálogo ainda não ter chegado do Core.
    const isChannelHistory = readoutFormat ? readoutFormat.kind === "channelHistory" : component.typeId === "meters.oscope";
    const payload: InstrumentHistoryPayload = isChannelHistory
      ? { componentId, oscope: decoded as InstrumentHistoryPayload["oscope"] }
      : { componentId, logic: decoded as InstrumentHistoryPayload["logic"] };
    state.schematicPanel.postMessage({ version: 1, type: "instrumentHistory", ...payload });
  } catch {
    // instância ainda não assentou ou foi removida -- ignora, a próxima tentativa (popup ainda aberto) cobre
  }
}

export function isReadableInstrument(typeId: string): boolean {
  if (findCatalogEntry(typeId)?.readoutFormat) return true;
  // Fallback legado -- typeId sem readoutFormat no catálogo ainda.
  return (
    typeId === "instruments.voltmeter" ||
    typeId === "meters.probe" ||
    typeId === "meters.ampmeter" ||
    typeId === "meters.freqmeter" ||
    typeId === "meters.oscope" ||
    typeId === "meters.logic_analyzer"
  );
}

/** Lê o estado de cada "instruments.voltmeter" no projeto e manda pra Webview — único instrumento
 * com leitura via Webview hoje (ver .spec/lasecsimul.spec sobre instrumentos como plugin ABI).
 * Generaliza naturalmente pra outros: basta interpretar getComponentState() conforme o typeId. */
export async function pollInstrumentReadouts(): Promise<void> {
  if (!state.coreClient || !state.schematicPanel) return;
  const instruments = state.schematicState.components.filter((component) => isReadableInstrument(component.typeId));
  if (instruments.length === 0) return;

  const readoutsByComponentId: Record<string, ComponentReadoutValue> = {};
  for (const component of instruments) {
    const coreId = coreInstanceIdByComponentId.get(component.id);
    if (!coreId) continue;
    try {
      const coreState = await state.coreClient.getComponentState(coreId);
      const readout = decodeComponentReadout(component.typeId, coreState);
      if (readout !== undefined) readoutsByComponentId[component.id] = readout;
    } catch {
      // instância ainda não assentou ou foi removida nesse meio tempo -- ignora neste tick, tenta de novo no próximo
    }
  }
  state.schematicPanel.postMessage({ version: 1, type: "componentReadout", readoutsByComponentId });
}

/** Tensão de cada fio (lida em uma das duas pontas — são o mesmo nó elétrico por definição) pra
 * colorir/animar na Webview igual ao SimulIDE (`ConnectorLine::paint`: vermelho se >2.5V, azul
 * senão, só enquanto a simulação está "animada"/rodando). */
export async function pollWireVoltages(): Promise<void> {
  if (!state.coreClient || !state.schematicPanel) return;
  if (state.schematicState.topology.conductors.length === 0) return;

  const voltagesByWireId: Record<string, number> = {};
  for (const probe of voltageProbesForProject(state.schematicState.topology)) {
    const coreId = coreInstanceIdByComponentId.get(probe.componentId);
    try {
      if (coreId) voltagesByWireId[probe.wireId] = await state.coreClient.getNodeVoltage(coreId, probe.pinId);
    } catch {
      // nó ainda não resolvido (settle loop não rodou pra esse trecho ainda) -- ignora neste tick
    }
  }
  state.schematicPanel.postMessage({ version: 1, type: "wireVoltages", voltagesByWireId });
}

/** Amostra anterior de `(tempo de parede, tempo simulado)` -- base pra calcular a taxa real
 * alcançada (`Δsimulado/Δparede`) a cada tick do polling já existente, achado de auditoria de UI
 * 2026-07-09 (paridade com `InfoWidget::setRate()` real do SimulIDE -- taxa ACHADA, não a
 * configuração estática de `lasecsimul.simulation.targetStepUs`). `undefined` == ainda sem amostra
 * anterior nesta corrida (primeiro tick depois de `run()`/retomada). */
let lastRateSample: { wallMs: number; simNs: number } | undefined;

async function pollSimulationRate(): Promise<void> {
  if (!state.coreClient) return;
  try {
    const simNs = await state.coreClient.getSimulationTime();
    const wallMs = Date.now();
    if (lastRateSample) {
      const deltaWallMs = wallMs - lastRateSample.wallMs;
      const deltaSimNs = simNs - lastRateSample.simNs;
      // Só reporta com uma janela de tempo de parede não-trivial -- uma amostra de 1-2ms de
      // diferença entre polls (jitter do `setInterval`) daria uma taxa ruidosa/enganosa.
      if (deltaWallMs > 50) {
        const rate = (deltaSimNs / 1e6) / deltaWallMs; // (ms simulados)/(ms de parede) = fator "Nx"
        state.schematicPanel?.postMessage({ version: 1, type: "simulationRate", rate });
      }
    }
    lastRateSample = { wallMs, simNs };
  } catch {
    // Core pode ter parado/desconectado entre o tick e a resposta -- sem taxa neste ciclo, não é erro.
  }
}

export function startVoltageReadoutPolling(): void {
  if (state.voltageReadoutTimer) return;
  lastRateSample = undefined;
  state.voltageReadoutTimer = setInterval(() => {
    void pollInstrumentReadouts();
    void pollWireVoltages();
    void pollSimulationRate();
  }, 300);
}

export function stopVoltageReadoutPolling(): void {
  if (!state.voltageReadoutTimer) return;
  clearInterval(state.voltageReadoutTimer);
  state.voltageReadoutTimer = undefined;
  lastRateSample = undefined;
  // Sem simulação rodando não há tensão "atual" pra mostrar -- volta os fios pra cor neutra em vez
  // de deixar a última cor (vermelho/azul) congelada, o que pareceria que ainda está simulando.
  state.schematicPanel?.postMessage({ version: 1, type: "wireVoltages", voltagesByWireId: {} });
  state.schematicPanel?.postMessage({ version: 1, type: "componentReadout", readoutsByComponentId: {} });
  state.schematicPanel?.postMessage({ version: 1, type: "simulationRate", rate: undefined });
}

export function setSimulationStatus(status: SimulationStatus): void {
  state.simulationStatus = status;
  state.schematicPanel?.postMessage({ version: 1, type: "simulationStatus", status });
}

/** Mesma geração de ids de pino que `projectToWebviewState`/a Webview usam ("pin-1".."pin-N", a
 * partir do pinCount do catálogo) — `ProjectComponent` (formato `.lsproj`) não guarda pinos, só
 * posição (`ProjectComponent.visual`); os IDs em si são sempre recalculados do catálogo, nunca
 * persistidos, então é isto que tem que mandar pro Core ao reabrir um projeto. */
export function runSimulation(): void {
  if (!state.coreClient) return;
  state.coreClient
    .run()
    .then(() => {
      startVoltageReadoutPolling();
      setSimulationStatus("running");
      void pollInstrumentReadouts();
      void pollWireVoltages();
    })
    .catch((err) => reportCoreWarning("iniciar simulação", err));
}

export function pauseSimulation(): void {
  if (!state.coreClient) return;
  state.coreClient
    .pause()
    .then(() => {
      stopVoltageReadoutPolling();
      setSimulationStatus("paused");
    })
    .catch((err) => reportCoreWarning("pausar simulação", err));
}

export function stopSimulation(): void {
  if (!state.coreClient) {
    stopVoltageReadoutPolling();
    setSimulationStatus("stopped");
    return;
  }
  state.coreClient
    .stopSimulation()
    .catch((err) => reportCoreWarning("parar simulação", err))
    .finally(() => {
      stopVoltageReadoutPolling();
      setSimulationStatus("stopped");
    });
}

export function shouldSyncComponentToCore(typeId: string): boolean {
  const descriptor = state.schematicState.catalog.find((item) => item.typeId === typeId);
  return (descriptor?.pinCount ?? 2) > 0;
}

/** `true` quando um bloco genérico de subcircuito por caminho ainda não foi resolvido nesta sessão
 * (arquivo ausente, ou projeto recém-aberto antes de `resolveProjectSubcircuitReferences` rodar) --
 * usado pra NUNCA tentar `addComponent` no Core enquanto não resolvido (typeId não existe em nenhum
 * `SubcircuitRegistry`, a tentativa só geraria um toast de erro à toa a cada rebuild). */
export function isUnresolvedSubcircuitRef(component: { typeId: string; subcircuitRef?: unknown }): boolean {
  if (!component.subcircuitRef) return false;
  return !state.schematicState.catalog.some((item) => item.typeId === component.typeId);
}

/** Fila de execução serializada pra `rebuildCoreFromSchematicState` — sem isso, remover vários fios
 * em sequência rápida (ex: `deleteSelectedItems` da Webview, seleção múltipla) dispara várias
 * reconstruções CONCORRENTES, todas lendo/escrevendo `coreInstanceIdByComponentId` ao mesmo tempo:
 * uma reconstrução recria instâncias enquanto outra ainda usa os ids antigos pra `connectWire`,
 * gerando "recriar fio ... falhou: conexão" (sintoma observado, ver docs/mvp-limitacoes.md). Cada
 * chamada nova só começa depois que a anterior (sucesso ou erro) terminou. */
let rebuildQueue: Promise<void> = Promise.resolve();
/** `true` enquanto uma reconstrução já está agendada mas ainda NÃO começou a rodar -- chamadas
 * adicionais nessa janela (EX-6.3) reaproveitam a MESMA promise em vez de empilhar outra
 * reconstrução completa redundante: `rebuildCoreFromSchematicState` sempre lê `state.schematicState` ao
 * vivo quando roda, então uma reconstrução ainda-não-iniciada já cobre qualquer mudança feita
 * enquanto ela espera na fila (ex: `deleteSelectedItems` com seleção múltipla manda um
 * `requestRemoveWire` POR fio -- sem coalescer, N fios selecionados disparavam N reconstruções
 * completas sequenciais, cada uma recriando TODOS os componentes/fios do zero). Volta a `false`
 * assim que a reconstrução agendada COMEÇA a rodar -- uma chamada que chegue durante a execução
 * (não mais só esperando na fila) agenda uma reconstrução SEGUINTE nova, pra nunca perder mudança
 * feita depois que a atual já começou. */
let rebuildScheduled = false;

export function queueCoreRebuild(): Promise<void> {
  if (rebuildScheduled) return rebuildQueue;
  rebuildScheduled = true;
  rebuildQueue = enqueueCoreMutation(async () => {
      rebuildScheduled = false;
      await rebuildCoreFromSchematicStateNow();
    })
    .catch(() => {
      rebuildScheduled = false;
    });
  return rebuildQueue;
}

export function rebuildCoreFromSchematicState(): Promise<void> {
  return queueCoreRebuild();
}

async function rebuildCoreFromSchematicStateNow(): Promise<void> {
  if (!state.coreClient) return;

  const runningBeforeRebuild = state.simulationStatus === "running";
  if (runningBeforeRebuild) {
    try {
      await state.coreClient.stopSimulation();
    } catch (err) {
      reportCoreWarning("parar simulação antes de reconstruir o circuito", err);
    }
    stopVoltageReadoutPolling();
    setSimulationStatus("stopped");
  }

  const existingInstanceIds = [...coreInstanceIdByComponentId.values()];
  for (const instanceId of existingInstanceIds) {
    try {
      await state.coreClient.removeComponent(instanceId);
    } catch {
      // Se a instância já sumiu do outro lado, seguimos e reconstruímos o snapshot atual.
    }
  }
  coreInstanceIdByComponentId.clear();
  mcuTargetCoreIdByComponentId.clear();

  for (const component of state.schematicState.components) {
    if (isUnresolvedSubcircuitRef(component) || !shouldSyncComponentToCore(component.typeId)) continue;
    try {
      const response = await state.coreClient.addComponent(
        component.typeId,
        component.properties,
        pinsForProjectComponent(component)
      );
      registerCoreIdsForComponent(component.id, component.typeId, response);
    } catch (err) {
      reportCoreWarning(`recriar "${component.typeId}" (${component.id})`, err);
    }
  }

  for (const wire of electricalEdgesForProject({ wires: state.schematicState.topology.conductors, topologyNodes: state.schematicState.topology.nodes })) {
    const coreA = coreInstanceIdByComponentId.get(endpointId(wire.from));
    const coreB = coreInstanceIdByComponentId.get(endpointId(wire.to));
    if (!coreA || !coreB) continue;
    try {
      await state.coreClient.connectWire(coreA, endpointPinId(wire.from), coreB, endpointPinId(wire.to));
    } catch (err) {
      reportCoreWarning(`recriar fio "${wire.id}"`, err);
    }
  }

  if (runningBeforeRebuild) {
    try {
      await state.coreClient.run();
      startVoltageReadoutPolling();
      setSimulationStatus("running");
      void pollInstrumentReadouts();
      void pollWireVoltages();
    } catch (err) {
      reportCoreWarning("reiniciar simulação após reconstruir o circuito", err);
    }
  }
}

/** Mesma derivação de `pinsForTypeId`, com fallback extra pro snapshot `subcircuitRef.
 * lastKnownPinIds` quando o typeId de um bloco genérico de subcircuito ainda não está resolvido no
 * catálogo desta sessão (arquivo referenciado por caminho ainda não localizado/registrado) -- sem
 * isto, reabrir um projeto com o arquivo ausente sintetizaria pinos genéricos (`pin-1`/`pin-2`) e os
 * fios salvos ficariam órfãos, perdendo a identidade elétrica que tinham antes de fechar o projeto.
 * Aceita tanto `ProjectComponent` (`.lsproj`) quanto `WebviewComponentModel` (já em memória) --
 * as duas têm `typeId`/`subcircuitRef?` no mesmo shape, e ambas precisam do mesmo fallback ao
 * reconstruir pinos pro Core (`rebuildCoreFromSchematicState` reconstrói do zero a cada rebuild). */
export function pinsForProjectComponent(component: { typeId: string; subcircuitRef?: { lastKnownPinIds?: string[] }; properties?: Record<string, unknown> }): Array<{ id: string; x: number; y: number }> {
  const descriptor = state.schematicState.catalog.find((item) => item.typeId === component.typeId);
  const lastKnownPinIds = component.subcircuitRef?.lastKnownPinIds;
  if (!descriptor && lastKnownPinIds && lastKnownPinIds.length > 0) {
    return lastKnownPinIds.map((id, index) => ({ id, x: 0, y: index * 12 }));
  }
  return pinsForTypeId(component.typeId, component.properties);
}
