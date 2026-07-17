import * as vscode from "vscode";
import * as path from "path";
import { IpcError } from "../ipc/protocol";
import { ComponentReadoutValue, InstrumentHistoryPayload, SimulationStatus } from "../ui/webview/messages";
import { CanonicalEndpoint, TopologyNode, TUNNEL_TYPE_ID, WebviewComponentCatalogEntry, WebviewComponentModel, WebviewWireModel, endpointId, endpointPinId } from "../ui/webview/model";
import { state, coreInstanceIdByComponentId, mcuTargetCoreIdByComponentId, subcircuitBoundaryPinsByComponentId } from "../state";
import { pinsForTypeId } from "../extension";
import { lasecPlotManager } from "../lasecplot/manager";
import { serialTerminalManager } from "../serialterm/manager";
import { serialPortManager } from "../serialport/manager";
import { electricalEdgesForProject, diffElectricalEdges } from "../ui/webview/wireTopology";
import { logSimulation, noteSimulationStatusChange } from "../diagnostics/simulationLog";
import { canonicalPackagePinId } from "../ui/webview/componentSymbols";

export { electricalEdgesForProject, diffElectricalEdges };

/** Fonte única de verdade pra "o que mudou eletricamente entre duas topologias" -- achata
 * antes/depois em arestas de pino real (`electricalEdgesForProject`) e devolve a diferença já no
 * formato que `pushWireTopologyTransaction` espera. Este cálculo (achatar + diferenciar + montar a
 * lista de operações connect/disconnect) era repetido, byte a byte, em 4 lugares de `extension.ts`
 * (sync genérico de `projectChanged`, `requestRemoveComponent`, `requestRemoveWire`,
 * `requestConnectEndpoints`) -- cada um decidindo de um jeito DIFERENTE o que fazer com o resultado
 * (aguardar ou disparar sem esperar, fallback quando não há diferença nenhuma, granularidade de
 * polling), por isso só a PARTE mecânica (idêntica nos 4) foi extraída pra cá; a orquestração de
 * cada verbo continua no call site, que já tinha motivo pra divergir. */
export function electricalOperationsDiff(
  beforeWires: WebviewWireModel[],
  beforeNodes: TopologyNode[],
  afterWires: WebviewWireModel[],
  afterNodes: TopologyNode[]
): Array<{ kind: "connect" | "disconnect"; wire: WebviewWireModel }> {
  const edgeDiff = diffElectricalEdges(
    electricalEdgesForProject({ wires: beforeWires, topologyNodes: beforeNodes }),
    electricalEdgesForProject({ wires: afterWires, topologyNodes: afterNodes })
  );
  return [
    ...edgeDiff.disconnect.map((wire) => ({ kind: "disconnect" as const, wire })),
    ...edgeDiff.connect.map((wire) => ({ kind: "connect" as const, wire })),
  ];
}

/** Camada de comunicação com o Core (push de mutações, polling de leitura, ciclo de vida da
 * simulação) -- extraída de `extension.ts` (EX-9, .spec/lasecsimul-native-devices.spec). Todo
 * campo mutável compartilhado (`state.coreClient`/`state.schematicState`/etc.) vem de `../state`;
 * `extension.ts` continua sendo quem REATRIBUI `state.coreClient`/`state.schematicPanel` (conectar/
 * desconectar Core, abrir/fechar painel), este módulo só LÊ esses campos (exceto
 * `state.simulationStatus`/`state.voltageReadoutTimer`, cujo ciclo de vida completo mora aqui). */

export function reportCoreWarning(action: string, err: unknown): void {
  const code = err instanceof IpcError && err.code ? ` [${err.code}]` : "";
  const message = `${action} falhou${code}: ${err instanceof Error ? err.message : String(err)}`;
  logSimulation("warning", message, { stage: "core" });
}

export function registerCoreIdsForComponent(
  componentId: string,
  typeId: string,
  response: { instanceId: string; primaryMcuInstanceId?: string; exposedPins?: Record<string, { instanceId: string; pinId: string }> }
): void {
  coreInstanceIdByComponentId.set(componentId, response.instanceId);
  if (response.exposedPins && Object.keys(response.exposedPins).length > 0) {
    subcircuitBoundaryPinsByComponentId.set(componentId, response.exposedPins);
  } else {
    subcircuitBoundaryPinsByComponentId.delete(componentId);
  }
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

/** Resolve um endpoint de fio (`componentId`+`pinId` do modelo da Webview) pro par {instanceId,pinId}
 * REAL que o Core entende. Pra maioria dos componentes isso é só `coreInstanceIdByComponentId.get
 * (componentId)` + o mesmo `pinId` -- mas quando `componentId` é um BLOCO de subcircuito e `pinId` é
 * um dos seus pinos de FRONTEIRA (ex: fio ligado direto no "GPIO2" do ESP32 DevKitC colocado no
 * esquemático principal, não um componente interno exposto via Modo Placa), o id "container" do
 * bloco NUNCA é um índice de componente válido do Netlist (`kSubcircuitInstanceFlag`, ver
 * `SimulationSession.cpp`) -- usá-lo direto em `connectWire` derrubava o Core com "invalid
 * vector<bool> subscript" (bug real 2026-07-17, reproduzido ao reconectar fios de um ESP32 DevKitC
 * após um rebuild completo). `subcircuitBoundaryPinsByComponentId` (preenchido em
 * `registerCoreIdsForComponent` a partir de `exposedPins`, que o Core já calculava e devolvia mas a
 * Extension nunca lia) dá o {instanceId,pinId} real do túnel interno que representa esse pino. */
function resolveWireEndpoint(componentId: string, pinId: string): { instanceId: string; pinId: string } | undefined {
  const component = state.schematicState.components.find((item) => item.id === componentId);
  const resolvedPinId = component
    ? canonicalPackagePinId(component.typeId, pinId, component.properties)
    : pinId;
  const boundaryPins = subcircuitBoundaryPinsByComponentId.get(componentId);
  const boundary = boundaryPins?.[pinId] ?? boundaryPins?.[resolvedPinId];
  if (boundary) return boundary;
  const instanceId = coreInstanceIdByComponentId.get(componentId);
  return instanceId ? { instanceId, pinId: resolvedPinId } : undefined;
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
    const model = state.schematicState.components.find((component) => component.id === componentId);
    const response = await state.coreClient.addComponent(typeId, properties, pins, componentId, model?.label ? [model.label] : []);
    registerCoreIdsForComponent(componentId, typeId, response);
    if (typeId === TUNNEL_TYPE_ID) {
      const name = String(properties.name ?? "");
      if (name) await state.coreClient.setTunnelName(response.instanceId, pins[0]?.id ?? "pin", "", name);
    }
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
  const a = resolveWireEndpoint(endpointId(wire.from), endpointPinId(wire.from));
  const b = resolveWireEndpoint(endpointId(wire.to), endpointPinId(wire.to));
  if (!a || !b) return false; // um dos lados não existe no Core (typeId não suportado ou ainda não resolvido)
  try {
    await state.coreClient.connectWire(a.instanceId, a.pinId, b.instanceId, b.pinId);
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
      const a = resolveWireEndpoint(endpointId(wire.from), endpointPinId(wire.from));
      const b = resolveWireEndpoint(endpointId(wire.to), endpointPinId(wire.to));
      if (!a || !b) return undefined;
      return { kind, from: { componentId: a.instanceId, pinId: a.pinId }, to: { componentId: b.instanceId, pinId: b.pinId } };
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
    const a = resolveWireEndpoint(endpointId(wire.from), endpointPinId(wire.from));
    const b = resolveWireEndpoint(endpointId(wire.to), endpointPinId(wire.to));
    if (!a || !b) {
      await rebuildCoreFromSchematicStateNow();
      return;
    }
    try {
      await state.coreClient.disconnectWire(a.instanceId, a.pinId, b.instanceId, b.pinId);
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
  if (readoutFormat?.kind === "vectorHistory") {
    // O prefixo de compatibilidade é deliberado: mantém o símbolo compacto e projetos/clients V1
    // operacionais enquanto o popup consome o payload vetorial completo abaixo.
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
    return legacyMasksToVectorHistory(timestampsNs, masks, readoutFormat.channels);
  }
  if (readoutFormat?.kind === "vectorHistory") {
    // LA V2: latest legacy mask, magic/version/count, descritores variáveis e amostras uint64.
    // Todos os acessos são precedidos por bounds checks: estado vindo de plugin/Core incompatível
    // falha fechado em vez de deslocar offsets e fabricar canais.
    const magic = 0x3256414c;
    if (state.length < 12 || state.readUInt32LE(4) !== magic || state.readUInt16LE(8) !== 2) return undefined;
    const channelCount = state.readUInt16LE(10);
    if (channelCount > 32) return undefined;
    let offset = 12;
    const channels: NonNullable<InstrumentHistoryPayload["logic"]>["channels"] = [];
    const readU16 = (): number | undefined => {
      if (offset + 2 > state.length) return undefined;
      const value = state.readUInt16LE(offset); offset += 2; return value;
    };
    for (let channel = 0; channel < channelCount; channel++) {
      const idLength = readU16();
      const labelLength = readU16();
      const sourceLength = readU16();
      const width = readU16();
      const msb = readU16();
      const lsb = readU16();
      if ([idLength, labelLength, sourceLength, width, msb, lsb].some((v) => v === undefined) || offset + 2 > state.length) return undefined;
      const kindByte = state.readUInt8(offset); offset += 2; // kind + reserved
      const textBytes = idLength! + labelLength! + sourceLength!;
      if (offset + textBytes > state.length || width! < 1 || width! > 64) return undefined;
      const channelId = state.toString("utf8", offset, offset + idLength!); offset += idLength!;
      const label = state.toString("utf8", offset, offset + labelLength!); offset += labelLength!;
      const source = state.toString("utf8", offset, offset + sourceLength!); offset += sourceLength!;
      channels.push({
        channelId, label, source, width: width!, msb: msb!, lsb: lsb!,
        kind: kindByte === 0 ? "analog" : kindByte === 1 ? "digital" : "unsigned",
      });
    }
    if (offset + 4 > state.length) return undefined;
    const sampleCount = state.readUInt32LE(offset); offset += 4;
    const packedWidths = channels.map((channel) => Math.max(1, Math.ceil(channel.width / 8)));
    const bytesPerSample = 8 + packedWidths.reduce((sum, width) => sum + width, 0);
    if (sampleCount > 1_000_000 || offset + sampleCount * bytesPerSample > state.length) return undefined;
    const timestampsNs: number[] = [];
    const values: string[][] = [];
    for (let sample = 0; sample < sampleCount; sample++) {
      timestampsNs.push(Number(state.readBigUInt64LE(offset))); offset += 8;
      const row: string[] = [];
      for (let channel = 0; channel < channelCount; channel++) {
        let value = 0n;
        for (let byte = 0; byte < packedWidths[channel]!; byte++) value |= BigInt(state.readUInt8(offset++)) << BigInt(byte * 8);
        row.push(value.toString(10));
      }
      values.push(row);
    }
    return { formatVersion: 2, channels, timestampsNs, values };
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
    return legacyMasksToVectorHistory(timestampsNs, masks, 8);
  }
  return undefined;
}

export function legacyMasksToVectorHistory(timestampsNs: number[], masks: number[], width = 8): NonNullable<InstrumentHistoryPayload["logic"]> {
  const safeWidth = Math.max(1, Math.min(32, Math.trunc(width)));
  return {
    formatVersion: 2,
    channels: Array.from({ length: safeWidth }, (_, index) => ({
      channelId: `D${index}`,
      label: `D${index}`,
      source: `@self.${index + 1}`,
      kind: "digital" as const,
      width: 1,
      msb: 0,
      lsb: 0,
    })),
    timestampsNs: [...timestampsNs],
    values: masks.map((mask) => Array.from({ length: safeWidth }, (_, bit) => String((mask >>> bit) & 1))),
  };
}

const instrumentHistoryRequestsInFlight = new Set<string>();

export async function sendInstrumentHistory(componentId: string): Promise<void> {
  if (!state.coreClient || !state.schematicPanel) return;
  // A Webview pede histórico a cada frame enquanto o popup está aberto. Se o snapshot anterior
  // ainda está atravessando Core -> Extension -> Webview, o próximo pedido seria redundante e
  // faria a fila crescer sem limite sob carga.
  if (instrumentHistoryRequestsInFlight.has(componentId)) return;
  const component = state.schematicState.components.find((entry) => entry.id === componentId);
  if (!component) return;
  const coreId = coreInstanceIdByComponentId.get(componentId);
  if (!coreId) return;
  instrumentHistoryRequestsInFlight.add(componentId);
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
  } finally {
    instrumentHistoryRequestsInFlight.delete(componentId);
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
export async function pollInstrumentReadouts(expectedGeneration?: number): Promise<void> {
  if (!state.coreClient || !state.schematicPanel) return;
  const instruments = state.schematicState.components.filter((component) => isReadableInstrument(component.typeId));
  if (instruments.length === 0) return;

  const readoutsByComponentId: Record<string, ComponentReadoutValue> = {};
  const stateItems = instruments.flatMap((component) => {
    const instanceId = coreInstanceIdByComponentId.get(component.id);
    return instanceId ? [{ key: component.id, instanceId }] : [];
  });
  let batchedStates: Record<string, Buffer>;
  try {
    batchedStates = await state.coreClient.getComponentStates(stateItems);
  } catch {
    return;
  }
  for (const component of instruments) {
    const coreState = batchedStates[component.id];
    if (!coreState) continue;
    try {
      const readout = decodeComponentReadout(component.typeId, coreState);
      if (readout !== undefined) readoutsByComponentId[component.id] = readout;
    } catch {
      // instância ainda não assentou ou foi removida nesse meio tempo -- ignora neste tick, tenta de novo no próximo
    }
  }
  if (expectedGeneration !== undefined && expectedGeneration !== telemetryGeneration) return;
  state.schematicPanel.postMessage({ version: 1, type: "componentReadout", readoutsByComponentId });
}

/** Tensão de cada fio (lida em uma das duas pontas — são o mesmo nó elétrico por definição) pra
 * colorir/animar na Webview igual ao SimulIDE (`ConnectorLine::paint`: vermelho se >2.5V, azul
 * senão, só enquanto a simulação está "animada"/rodando). */
export async function pollWireVoltages(expectedGeneration?: number): Promise<void> {
  if (!state.coreClient || !state.schematicPanel) return;
  if (state.schematicState.topology.conductors.length === 0) return;

  const voltagesByWireId: Record<string, number> = {};
  const batch: Array<{ key: string; instanceId: string; pinId: string }> = [];
  for (const probe of voltageProbesForProject(state.schematicState.topology)) {
    const endpoint = resolveWireEndpoint(probe.componentId, probe.pinId);
    if (endpoint) batch.push({ key: probe.wireId, instanceId: endpoint.instanceId, pinId: endpoint.pinId });
  }
  try {
    Object.assign(voltagesByWireId, await state.coreClient.getNodeVoltages(batch));
  } catch {
      // nó ainda não resolvido (settle loop não rodou pra esse trecho ainda) -- ignora neste tick
  }
  if (expectedGeneration !== undefined && expectedGeneration !== telemetryGeneration) return;
  state.schematicPanel.postMessage({ version: 1, type: "wireVoltages", voltagesByWireId });
}

/** Amostra anterior de `(tempo de parede, tempo simulado)` -- base pra calcular a taxa real
 * alcançada (`Δsimulado/Δparede`) a cada tick do polling já existente, achado de auditoria de UI
 * 2026-07-09 (paridade com `InfoWidget::setRate()` real do SimulIDE -- taxa ACHADA, não a
 * configuração estática de `lasecsimul.simulation.targetStepUs`). `undefined` == ainda sem amostra
 * anterior nesta corrida (primeiro tick depois de `run()`/retomada). */
let lastRateSample: { wallMs: number; simNs: number } | undefined;
let telemetryGeneration = 0;
let telemetryPollInFlight = false;

async function pollSimulationRate(expectedGeneration?: number): Promise<void> {
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
        if (expectedGeneration === undefined || expectedGeneration === telemetryGeneration) {
          state.schematicPanel?.postMessage({ version: 1, type: "simulationRate", rate });
        }
      }
    }
    lastRateSample = { wallMs, simNs };
  } catch {
    // Core pode ter parado/desconectado entre o tick e a resposta -- sem taxa neste ciclo, não é erro.
  }
}

export function startVoltageReadoutPolling(): void {
  if (state.voltageReadoutTimer) return;
  const generation = ++telemetryGeneration;
  lastRateSample = undefined;
  const telemetryRateHz = vscode.workspace
    .getConfiguration("lasecsimul.simulation")
    .get<number>("telemetryRateHz");
  if (telemetryRateHz === undefined || !Number.isFinite(telemetryRateHz) || telemetryRateHz <= 0) {
    throw new Error("lasecsimul.simulation.telemetryRateHz deve ser uma frequência positiva");
  }
  state.voltageReadoutTimer = setInterval(() => {
    // Backpressure: um único frame visual em trânsito. Frames obsoletos podem ser coalescidos;
    // comandos de controle e estado essencial nunca entram numa fila crescente atrás deles.
    if (telemetryPollInFlight) return;
    telemetryPollInFlight = true;
    void Promise.allSettled([
      pollInstrumentReadouts(generation),
      pollWireVoltages(generation),
      pollSimulationRate(generation),
    ]).finally(() => { telemetryPollInFlight = false; });
  }, Math.round(1000 / telemetryRateHz));
}

export function stopVoltageReadoutPolling(): void {
  ++telemetryGeneration;
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

/** NÃO limpa a status bar de erro/aviso sozinha -- ver `noteSimulationStatusChange`, chamada só nos 3
 * pontos de AÇÃO deliberada do usuário (`runSimulation`/`pauseSimulation`/`stopSimulation`) abaixo.
 * Sem essa separação, um Core que morre (`extension.ts::coreProc.onExit`, que loga o erro E chama
 * `setSimulationStatus("stopped")` em seguida) apagaria o próprio indicador vermelho que acabou de
 * acender -- o usuário nunca veria o aviso na status bar, só um flash. */
export function setSimulationStatus(status: SimulationStatus): void {
  state.simulationStatus = status;
  lasecPlotManager?.updateSimulationState();
  serialTerminalManager?.updateSimulationState();
  serialPortManager?.updateSimulationState();
  state.schematicPanel?.postMessage({ version: 1, type: "simulationStatus", status });
}

/** Mesma geração de ids de pino que `projectToWebviewState`/a Webview usam ("pin-1".."pin-N", a
 * partir do pinCount do catálogo) — `ProjectComponent` (formato `.lsproj`) não guarda pinos, só
 * posição (`ProjectComponent.visual`); os IDs em si são sempre recalculados do catálogo, nunca
 * persistidos, então é isto que tem que mandar pro Core ao reabrir um projeto. */
export function runSimulation(): void {
  if (!state.coreClient) return;
  // Publish "running" before the request. A condition can fire in the Core's
  // first converged step, before the start response returns; in that race the
  // asynchronous "paused" notification must be the last state, never be
  // overwritten by the start promise continuation.
  startVoltageReadoutPolling();
  setSimulationStatus("running");
  // Tentativa deliberada do usuário -- limpa qualquer erro/aviso de uma corrida anterior ANTES de
  // saber se esta vai dar certo; se falhar, `reportCoreWarning` abaixo acende um novo.
  noteSimulationStatusChange("running");
  state.coreClient
    .run()
    .then(() => {
      void pollInstrumentReadouts();
      void pollWireVoltages();
    })
    .catch((err) => {
      stopVoltageReadoutPolling();
      setSimulationStatus("stopped");
      reportCoreWarning("iniciar simulação", err);
    });
}

export function pauseSimulation(): void {
  if (!state.coreClient) return;
  state.coreClient
    .pause()
    .then(() => {
      stopVoltageReadoutPolling();
      setSimulationStatus("paused");
      noteSimulationStatusChange("paused");
    })
    .catch((err) => reportCoreWarning("pausar simulação", err));
}

export function stopSimulation(): void {
  // Corta a produção de telemetria no instante do clique, antes de escrever o comando no pipe.
  // Assim nenhum frame visual novo pode ser enfileirado enquanto a worker está encerrando.
  stopVoltageReadoutPolling();
  if (!state.coreClient) {
    setSimulationStatus("stopped");
    noteSimulationStatusChange("stopped");
    return;
  }
  state.coreClient
    .stopSimulation()
    .catch((err) => reportCoreWarning("parar simulação", err))
    .finally(() => {
      setSimulationStatus("stopped");
      noteSimulationStatusChange("stopped");
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
export function isUnresolvedSubcircuitRef(component: { typeId: string; subcircuitRef?: unknown; deviceRef?: { path: string } }): boolean {
  if (component.subcircuitRef && !state.schematicState.catalog.some((item) => item.typeId === component.typeId)) return true;
  if (!component.deviceRef) return false;
  const absoluteRef = path.isAbsolute(component.deviceRef.path)
    ? path.normalize(component.deviceRef.path)
    : path.resolve(state.currentProjectFilePath ? path.dirname(state.currentProjectFilePath) : process.cwd(), component.deviceRef.path);
  return !state.schematicState.catalog.some((item) =>
    item.typeId === component.typeId && item.externalReferencePath && path.normalize(item.externalReferencePath) === absoluteRef);
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

  const simulation = vscode.workspace.getConfiguration("lasecsimul.simulation");
  await state.coreClient.setSimulationConfig({
    targetStepUs: simulation.get("targetStepUs", 0),
    maxNonLinearIterations: simulation.get("maxNonLinearIterations", 0),
    performanceProfiling: simulation.get("performanceProfiling", false),
    integrationMethod: simulation.get("integrationMethod", "automatic"),
    adaptiveTimeStep: simulation.get("adaptiveTimeStep", true),
    initialStepNs: simulation.get("initialStepNs", 100),
    minimumStepNs: simulation.get("minimumStepNs", 1),
    maximumStepNs: simulation.get("maximumStepNs", 100_000),
    relativeTolerance: simulation.get("relativeTolerance", 1e-4),
    absoluteTolerance: simulation.get("absoluteTolerance", 1e-9),
  });

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
  subcircuitBoundaryPinsByComponentId.clear();

  for (const component of state.schematicState.components) {
    if (isUnresolvedSubcircuitRef(component) || !shouldSyncComponentToCore(component.typeId)) continue;
    try {
      const response = await state.coreClient.addComponent(
        component.typeId,
        component.properties,
        pinsForProjectComponent(component),
        component.id,
        component.label ? [component.label] : []
      );
      registerCoreIdsForComponent(component.id, component.typeId, response);
      if (component.typeId === TUNNEL_TYPE_ID) {
        const name = String(component.properties.name ?? "");
        if (name) await state.coreClient.setTunnelName(response.instanceId, component.pins[0]?.id ?? "pin", "", name);
      }
    } catch (err) {
      reportCoreWarning(`recriar "${component.typeId}" (${component.id})`, err);
    }
  }

  for (const wire of electricalEdgesForProject({ wires: state.schematicState.topology.conductors, topologyNodes: state.schematicState.topology.nodes })) {
    const a = resolveWireEndpoint(endpointId(wire.from), endpointPinId(wire.from));
    const b = resolveWireEndpoint(endpointId(wire.to), endpointPinId(wire.to));
    if (!a || !b) continue;
    try {
      await state.coreClient.connectWire(a.instanceId, a.pinId, b.instanceId, b.pinId);
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
export function pinsForProjectComponent(component: { typeId: string; subcircuitRef?: { lastKnownPinIds?: string[] }; deviceRef?: { lastKnownPinIds?: string[] }; properties?: Record<string, unknown> }): Array<{ id: string; x: number; y: number }> {
  const descriptor = state.schematicState.catalog.find((item) => item.typeId === component.typeId);
  const lastKnownPinIds = component.subcircuitRef?.lastKnownPinIds ?? component.deviceRef?.lastKnownPinIds;
  if (!descriptor && lastKnownPinIds && lastKnownPinIds.length > 0) {
    return lastKnownPinIds.map((id, index) => ({ id, x: 0, y: index * 12 }));
  }
  return pinsForTypeId(component.typeId, component.properties);
}
