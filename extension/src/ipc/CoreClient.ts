import * as net from "net";
import * as os from "os";
import * as path from "path";
import { StringDecoder } from "string_decoder";
import {
  PROTOCOL_VERSION,
  RequestEnvelope,
  ResponseEnvelope,
  NotificationEnvelope,
  HelloResponsePayload,
  IpcError,
  errorCodeFromPayload,
  errorDetailsFromPayload,
} from "./protocol";
import { InteractionKindDto, McuSerialPortDto, PropertySchemaDto, ReadoutFormatDto, TelemetrySample } from "./types";

function toPipePath(name: string): string {
  return process.platform === "win32"
    ? `\\\\.\\pipe\\${name}`
    : path.join(os.tmpdir(), `${name}.sock`);
}

type NotificationHandler = (n: NotificationEnvelope) => void;

export interface RegisteredSubcircuitInfo {
  status: "registered" | "reloaded";
  replaced: boolean;
  typeId: string;
  name?: string;
  path?: string;
  interface?: Array<{ pinId: string; label?: string; internalTunnel: string }>;
  pinIds?: string[];
  pinCount?: number;
  package?: unknown;
  logicSymbolPackage?: unknown;
  defaultProperties?: Record<string, unknown>;
  propertySchema?: unknown[];
  translations?: Record<string, unknown>;
  language?: string | null;
  folderPath?: string[] | string | null;
  icon?: string | null;
  iconPath?: string | null;
}

interface PendingRequest {
  resolve: (payload: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

/**
 * Único ponto da Extension que sabe que existe um processo LasecSimul Core nativo.
 * Toda a UI fala com CoreClient; nenhum outro módulo abre socket/pipe diretamente.
 */
export class CoreClient {
  private wireTopologyRevision = 0;
  private socket: net.Socket | undefined;
  private readonly pending = new Map<string, PendingRequest>();
  private readonly notificationHandlers: NotificationHandler[] = [];
  private requestCounter = 0;
  private lineBuffer = "";
  /** PC-4 (.spec/lasecsimul-native-devices.spec): decodifica UTF-8 de forma INCREMENTAL entre
   * chamadas de `_onData` -- um `Buffer.toString("utf8")` ingênuo por chunk (como era antes) corrompe
   * qualquer caractere multi-byte (praticamente todo texto acentuado -- "ç"/"ã"/"õ", comum em
   * label/erro/tradução deste app, majoritariamente em pt-BR) que caia bem na fronteira entre dois
   * chunks de socket/pipe: os bytes incompletos do lado de cá viram U+FFFD (replacement character)
   * na hora, sem chance de completar com os bytes que só chegam no PRÓXIMO `data`. `StringDecoder`
   * resolve isso -- guarda bytes finais incompletos internamente e só devolve caracteres já
   * completos, prefixando o resto automaticamente na próxima chamada de `.write()`. */
  private readonly utf8Decoder = new StringDecoder("utf8");
  private readonly requestTimeoutMs: number;

  constructor(private readonly pipeName: string, opts: { requestTimeoutMs?: number } = {}) {
    this.requestTimeoutMs = opts.requestTimeoutMs ?? 5_000;
  }

  /** Estabelece conexão com o Core e realiza o handshake de protocolo. */
  async start(): Promise<void> {
    await this._connect();
    await this._handshake();
  }

  /** Envia shutdown ao Core e encerra o socket. Rejeita todas as requisições pendentes. */
  async stop(): Promise<void> {
    try {
      await this.request("shutdown", {});
    } catch {
      // best-effort: Core pode já ter encerrado
    }
    this._destroy(new Error("CoreClient encerrado"));
  }

  /** Envia uma requisição ao Core e aguarda a resposta. */
  async request(type: string, payload: unknown, timeoutMs?: number): Promise<unknown> {
    if (!this.socket) {
      throw new Error("CoreClient não está conectado");
    }
    const effectiveTimeout = timeoutMs ?? this.requestTimeoutMs;
    const id = String(++this.requestCounter);
    const envelope: RequestEnvelope = { id, type, payload, protocolVersion: PROTOCOL_VERSION };
    return new Promise<unknown>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Requisição "${type}" (id=${id}) expirou após ${effectiveTimeout}ms`));
      }, effectiveTimeout);
      this.pending.set(id, { resolve, reject, timer });
      this.socket!.write(JSON.stringify(envelope) + "\n");
    });
  }

  /** Registra um handler para notificações assíncronas enviadas pelo Core. */
  onNotification(handler: NotificationHandler): void {
    this.notificationHandlers.push(handler);
  }

  // ── controle de simulação ──────────────────────────────────────────────────

  async run(): Promise<void> { await this.request("start", {}); }
  async pause(): Promise<void> { await this.request("pause", {}); }
  async setPauseCondition(ownerId: string, expression: string): Promise<void> { await this.request("setPauseCondition", { ownerId, expression }); }
  async resume(): Promise<void> { await this.request("resume", {}); }
  async settleMcuDebug(instanceId: string): Promise<void> { await this.request("settleMcuDebug", { instanceId }); }
  async stopMcuFirmware(instanceId: string): Promise<void> { await this.request("stopMcuFirmware", { instanceId }); }
  /** Avança a simulação por `deltaNs` (default 1000ns) e assenta uma única vez -- `Scheduler::step`
   * real do Core (achado de auditoria 2026-07-08: o verbo IPC dizia "não implementado" mas o
   * mecanismo já existia, só não estava ligado). Sem chamador na UI ainda -- um botão "Step" fica
   * pra um trabalho de UI separado, fora de escopo aqui; o método deixa de ser código morto agora
   * que a resposta do Core é real. */
  async step(deltaNs?: number): Promise<void> { await this.request("step", deltaNs !== undefined ? { deltaNs } : {}); }
  /** Para a simulação sem encerrar a conexão IPC. */
  async stopSimulation(): Promise<void> { await this.request("stop", {}); }

  // ── controle do esquemático ────────────────────────────────────────────────

  /** `pins`: built-ins ignoram o id (cada factory já tem o seu hardcoded, ex: "p1"/"p2") e só leem
   * x/y; plugins (NativeDeviceProxy) usam estes ids DIRETAMENTE como os pinos da instância — sem
   * isso, connectWire nunca acertaria o pino certo de um componente vindo de um plugin (ver
   * .spec/lasecsimul.spec sobre instrumentos como plugin ABI). */
  async addComponent(
    typeId: string,
    properties: Record<string, unknown>,
    pins: Array<{ id: string; x: number; y: number }> = [],
    instanceName = "",
    signalAliases: string[] = []
  ): Promise<{ instanceId: string; primaryMcuInstanceId?: string }> {
    const resp = await this.request("addComponent", { typeId, properties, pins, instanceName, signalAliases });
    return resp as { instanceId: string; primaryMcuInstanceId?: string };
  }

  /** `requiresRestart: true` quando a propriedade alterada tem essa flag no schema (`Core` já
   * aplicou a mudança normalmente; reinício automático não é feito aqui — ver Épico A do roadmap de
   * pendências, decisão A3). Quem chama decide como avisar o usuário. */
  async setProperty(instanceId: string, name: string, value: unknown): Promise<{ requiresRestart: boolean }> {
    const resp = (await this.request("setProperty", { instanceId, name, value })) as
      | { requiresRestart?: boolean }
      | undefined;
    return { requiresRestart: Boolean(resp?.requiresRestart) };
  }

  /** Edita uma propriedade de um componente DENTRO de um subcircuito, endereçando por id local
   * (ex: "button_en") em vez do índice Core -- usado pelo overlay de Modo Placa no circuito
   * principal, ver `core/src/app/CoreApplication.cpp::"setSubcircuitChildProperty"`. */
  async setSubcircuitChildProperty(instanceId: string, localId: string, name: string, value: unknown): Promise<void> {
    await this.request("setSubcircuitChildProperty", { instanceId, localId, name, value });
  }

  /** Resolve o `componentIndex` real no Core de um filho interno de subcircuito identificado pelo
   * id local salvo no `.lssubcircuit` (ex: "mcu1"). Usado por ações do submenu externo de
   * componentes expostos que precisam de um alvo direto de MCU (firmware/serial). */
  async getSubcircuitChildInstanceId(instanceId: string, localId: string): Promise<string> {
    const resp = await this.request("getSubcircuitChildInstanceId", { instanceId, localId });
    return (resp as { instanceId: string }).instanceId;
  }

  /** Renomeia um túnel no Netlist. Deve ser chamado em vez de `setProperty` quando a propriedade
   * "name" de um `connectors.tunnel` muda — `setProperty` só re-stampa, não rebuilda topologia.
   * Ver `SimulationSession::setTunnelName` e `.spec/lasecsimul.spec` seção 6.1. */
  async setTunnelName(instanceId: string, pinId: string, oldName: string, newName: string): Promise<void> {
    await this.request("setTunnelName", { instanceId, pinId, oldName, newName });
  }

  /** Configura parâmetros operacionais do Scheduler em runtime.
   * `targetStepUs`: duração mínima (µs) de cada cycle de liquidação; 0 = ilimitado (default).
   * `maxNonLinearIterations`: limite de iterações de settle por passo; 0 = ilimitado (default). */
  async setSimulationConfig(config: {
    targetStepUs?: number;
    maxNonLinearIterations?: number;
    integrationMethod?: "automatic" | "backwardEuler" | "trapezoidal" | "gear2";
    initialStepNs?: number;
    minimumStepNs?: number;
    maximumStepNs?: number;
    relativeTolerance?: number;
    absoluteTolerance?: number;
    maximumNewtonIterations?: number;
    adaptiveTimeStep?: boolean;
  }): Promise<void> {
    await this.request("setSimulationConfig", config);
  }

  /** Forma JSON de "fio" na IPC: `{from:{componentId,pinId}, to:{componentId,pinId}}` -- mesma
   * forma aninhada do arquivo `.lssubcircuit` e do modelo interno `WebviewWireModel.from`/`.to`
   * (ver `coreLifecycle.ts`). Antes esta chamada montava uma forma achatada própria
   * (`componentA`/`pinIdA`/`componentB`/`pinIdB`) -- duas formas de JSON pra mesma entidade lógica
   * coexistindo no Core (achado de auditoria arquitetural 2026-07-09, D14). Assinatura do método
   * continua com 4 parâmetros posicionais (sem mudança nos call sites de `coreLifecycle.ts`); só a
   * forma enviada pela IPC mudou. */
  async connectWire(componentA: string, pinIdA: string, componentB: string, pinIdB: string): Promise<void> {
    const response = await this.request("connectWire", {
      from: { componentId: componentA, pinId: pinIdA },
      to: { componentId: componentB, pinId: pinIdB },
    });
    this.wireTopologyRevision = (response as { topologyRevision?: number }).topologyRevision ?? this.wireTopologyRevision + 1;
  }

  /** Inverso de `connectWire` (EX-6.1/EX-6.2) -- remove só ESTE fio no Core, sem precisar
   * reconstruir o circuito inteiro (`removeComponent`+`addComponent`+`connectWire` de todos os
   * componentes, ver `extension.ts::rebuildCoreFromSchematicState`). Devolve `false` (sem lançar)
   * se o par de pinos já não estava conectado -- idempotente, igual a `removeComponent`. */
  async disconnectWire(componentA: string, pinIdA: string, componentB: string, pinIdB: string): Promise<boolean> {
    const resp = await this.request("disconnectWire", {
      from: { componentId: componentA, pinId: pinIdA },
      to: { componentId: componentB, pinId: pinIdB },
    });
    const payload = resp as { removed?: boolean; topologyRevision?: number };
    this.wireTopologyRevision = payload.topologyRevision ?? this.wireTopologyRevision;
    return payload.removed === true;
  }

  async applyWireTopologyTransaction(operations: Array<{
    kind: "connect" | "disconnect";
    from: { componentId: string; pinId: string };
    to: { componentId: string; pinId: string };
  }>): Promise<void> {
    const response = await this.request("applyWireTopologyTransaction", { baseRevision: this.wireTopologyRevision, operations });
    this.wireTopologyRevision = (response as { topologyRevision: number }).topologyRevision;
  }

  async removeComponent(instanceId: string): Promise<void> {
    await this.request("removeComponent", { instanceId });
  }

  async loadDeviceLibrary(libraryJsonPath: string): Promise<void> {
    // só deve ser chamado depois do fluxo de confiança/consentimento
    // 30 s: carregamento de DLL nova pode ser varrido pelo Defender antes de executar
    await this.request("loadDeviceLibrary", { path: libraryJsonPath }, 30_000);
  }

  /** Registra UM `.lssubcircuit` avulso direto no `SubcircuitRegistry` do Core, sem exigir um
   * `library.json` -- usado pelo bloco genérico de subcircuito por caminho (propriedade
   * `subcircuitPath` do componente). Sem risco de plugin nativo (dado JSON puro, nunca DLL/SO),
   * então não passa pelo fluxo de confiança/consentimento que `loadDeviceLibrary` exige. Devolve o
   * `typeId` efetivamente registrado (lido do próprio manifesto). */
  async registerAdhocSubcircuit(manifestPath: string, options: { replace?: boolean } = {}): Promise<RegisteredSubcircuitInfo> {
    const resp = await this.request("registerAdhocSubcircuit", { path: manifestPath, replace: Boolean(options.replace) });
    return resp as RegisteredSubcircuitInfo;
  }

  /** Mesmo registro avulso, mas sem pedir ao Core o manifesto serializado de volta. Use quando o
   * chamador jÃ¡ vai ler o `.lssubcircuit` localmente ou sÃ³ precisa garantir que o typeId estÃ¡ no
   * registry antes de `addComponent`/rebuild. */
  async registerAdhocSubcircuitDefinition(manifestPath: string, options: { replace?: boolean } = {}): Promise<void> {
    await this.request("registerAdhocSubcircuit", {
      path: manifestPath,
      replace: Boolean(options.replace),
      returnPayload: false,
    });
  }

  /** Bytes opacos de `IComponentModel::getState()` de uma instância (built-in ou plugin),
   * devolvidos como hex — quem chama decide o que os bytes significam (ex: "instruments.voltmeter"
   * é sempre 1 double little-endian = a última tensão medida). */
  async getComponentState(instanceId: string): Promise<Buffer> {
    const resp = await this.request("getComponentState", { instanceId });
    const stateHex = (resp as { stateHex: string }).stateHex;
    return Buffer.from(stateHex, "hex");
  }

  async getComponentStates(items: Array<{ key: string; instanceId: string }>): Promise<Record<string, Buffer>> {
    const resp = await this.request("getComponentStates", { items });
    const encoded = (resp as { states: Record<string, string> }).states;
    return Object.fromEntries(Object.entries(encoded).map(([key, hex]) => [key, Buffer.from(hex, "hex")]));
  }

  /** Saúde operacional da instância (`"ok" | "lagging" | "faulted"`) -- watchdog/CrashGuard do
   * lado do plugin nativo, ver `.spec/lasecsimul-native-devices.spec` seção 13. Built-ins sempre
   * respondem `"ok"`. */
  async getComponentHealth(instanceId: string): Promise<"ok" | "lagging" | "faulted"> {
    const resp = await this.request("getComponentHealth", { instanceId });
    return (resp as { status: "ok" | "lagging" | "faulted" }).status;
  }

  /** Corrente elétrica no "ramo principal" da instância na última solve() -- convenção PASSIVA
   * (positiva entrando no primeiro pino/saindo no segundo; fonte fornecendo energia aparece
   * negativa). `undefined` quando o componente não implementa isso (Ground, Tunnel, etc.) --
   * nunca lança por esse motivo. Opção de baixo custo do plano de leitura de corrente: sem
   * incógnita nova no Core, lida sob demanda do estado já cacheado. */
  async getComponentCurrent(instanceId: string): Promise<number | undefined> {
    const resp = await this.request("getComponentCurrent", { instanceId });
    const payload = resp as { hasCurrent: boolean; current?: number };
    return payload.hasCurrent ? payload.current : undefined;
  }

  /** Tensão atual do nó ao qual `pinId` da instância `instanceId` está resolvido -- usado pra
   * colorir/animar fios na Webview (vermelho/azul conforme tensão, ver ConnectorLine do SimulIDE),
   * sem precisar de um instrumento. Lê o mesmo valor que `IComponentModel`/instrumentos já leem
   * internamente via `getNodeVoltage()` do solver. */
  async getNodeVoltage(instanceId: string, pinId: string): Promise<number> {
    const resp = await this.request("getNodeVoltage", { instanceId, pinId });
    return (resp as { voltage: number }).voltage;
  }

  async getNodeVoltages(probes: Array<{ key: string; instanceId: string; pinId: string }>): Promise<Record<string, number>> {
    const resp = await this.request("getNodeVoltages", { probes });
    return (resp as { values: Record<string, number> }).values;
  }

  /** Nanossegundos de tempo SIMULADO decorrido (`Scheduler::nowNs()`) -- base pra calcular a taxa
   * real de simulação (`Δsimulado/Δparede` entre duas amostras), achado de auditoria de UI
   * 2026-07-09. Verbo somente-leitura. */
  async getSimulationTime(): Promise<number> {
    const resp = await this.request("getSimulationTime", {});
    return (resp as { simulatedNs: number }).simulatedNs;
  }

  async loadMcuFirmware(instanceId: string, firmwarePath: string, qemuBinaryOverride?: string,
    debug?: { gdbPort: number; startPaused?: boolean }): Promise<{ gdbPort: number; debug: boolean }> {
    return await this.request("loadMcuFirmware", {
      instanceId, firmwarePath, qemuBinaryOverride,
      gdbPort: debug?.gdbPort,
      startPaused: debug?.startPaused ?? false,
    }) as { gdbPort: number; debug: boolean };
  }

  async getMcuLogs(instanceId: string): Promise<string> {
    const resp = await this.request("getMcuLogs", { instanceId });
    return (resp as { logs: string }).logs;
  }

  /** Schema rico de propriedades (grupo/editor/min/max/opções/flags) de TODO typeId já registrado
   * no Core neste momento — built-in (sempre presente) e plugin (só depois de `loadDeviceLibrary`
   * bem-sucedido). Por `typeId`, nunca por instância — chamar de novo depois de carregar uma
   * library nova pega os typeIds que acabaram de ficar disponíveis. `language` (BCP-47, opcional):
   * pede `label`/`group`/opções traduzidos quando o `.lsdevice`/built-in tiver essa tradução
   * declarada (`translations`); sem isso (ou sem tradução pra essa língua), devolve na língua-base
   * do componente -- nunca falha, ver `lasecsimul.spec` seção 6.3.3. */
  async getPropertySchemas(language?: string): Promise<{
    schemasByTypeId: Record<string, PropertySchemaDto[]>;
    /** ABI v2 (.spec/lasecsimul-native-devices.spec) -- mapas irmãos aditivos, só presentes pro
     * typeId que o device declarou; ausência é "sem leitura estruturada"/"sem interação especial". */
    readoutFormatByTypeId: Record<string, ReadoutFormatDto>;
    interactionKindByTypeId: Record<string, InteractionKindDto>;
    /** Id ELÉTRICO real de cada pino, na ordem canônica que o Core usa (ver
     * `CoreApplication.cpp::registerBuiltinMetadata`) -- só presente pro typeId que declarou
     * `pins` (built-in com id fixo, OU device/subcircuit-file cujo manifesto já populou via
     * `interface[]`). Substitui a Extension manter uma tabela hardcoded 2ª cópia do mesmo dado. */
    pinIdsByTypeId: Record<string, string[]>;
    serialPortsByTypeId: Record<string, McuSerialPortDto[]>;
  }> {
    const resp = await this.request("getPropertySchemas", { language });
    const payload = resp as {
      schemasByTypeId: Record<string, PropertySchemaDto[]>;
      readoutFormatByTypeId?: Record<string, ReadoutFormatDto>;
      interactionKindByTypeId?: Record<string, InteractionKindDto>;
      pinIdsByTypeId?: Record<string, string[]>;
      serialPortsByTypeId?: Record<string, McuSerialPortDto[]>;
    };
    return {
      schemasByTypeId: payload.schemasByTypeId,
      readoutFormatByTypeId: payload.readoutFormatByTypeId ?? {},
      interactionKindByTypeId: payload.interactionKindByTypeId ?? {},
      pinIdsByTypeId: payload.pinIdsByTypeId ?? {},
      serialPortsByTypeId: payload.serialPortsByTypeId ?? {},
    };
  }

  onTelemetry(callback: (sample: TelemetrySample) => void): void {
    // assina notificações de telemetria pelo canal de controle (alta frequência usa shm)
    this.onNotification((n) => {
      if (n.type === "telemetry") callback(n.payload as TelemetrySample);
    });
  }

  // ── privado ────────────────────────────────────────────────────────────────

  private _connect(): Promise<void> {
    const maxAttempts = 20;
    const retryDelayMs = 150;
    let attempt = 0;
    const tryOnce = (): Promise<void> =>
      new Promise((resolve, reject) => {
        const socket = net.createConnection(toPipePath(this.pipeName));
        socket.once("connect", () => {
          this.socket = socket;
          socket.on("data", (d: Buffer) => this._onData(d));
          socket.once("close", () =>
            this._destroy(new Error("Conexão com Core encerrada inesperadamente"))
          );
          resolve();
        });
        socket.once("error", reject);
      });

    const retry = (): Promise<void> =>
      tryOnce().catch((err) => {
        attempt++;
        if (attempt >= maxAttempts) {
          throw new Error(`Não foi possível conectar ao Core após ${maxAttempts} tentativas: ${err}`);
        }
        return new Promise((r) => setTimeout(r, retryDelayMs)).then(retry);
      });

    return retry();
  }

  private async _handshake(): Promise<void> {
    const resp = (await this.request("hello", { clientVersion: "0.1.0" })) as HelloResponsePayload;
    if (resp.protocolVersion !== PROTOCOL_VERSION) {
      throw new Error(
        `Versão de protocolo incompatível: cliente=${PROTOCOL_VERSION}, servidor=${resp.protocolVersion}`
      );
    }
  }

  private _onData(data: Buffer): void {
    this.lineBuffer += this.utf8Decoder.write(data);
    const lines = this.lineBuffer.split("\n");
    this.lineBuffer = lines.pop() ?? "";
    for (const line of lines) {
      const t = line.trim();
      if (t) this._dispatch(t);
    }
  }

  private _dispatch(raw: string): void {
    let msg: unknown;
    try { msg = JSON.parse(raw); } catch { return; }
    if (typeof msg !== "object" || msg === null) return;
    if ("id" in msg) {
      const r = msg as ResponseEnvelope;
      const p = this.pending.get(r.id);
      if (!p) return;
      clearTimeout(p.timer);
      this.pending.delete(r.id);
      r.ok ? p.resolve(r.payload) : p.reject(new IpcError(r.error ?? "Erro no Core", errorCodeFromPayload(r.payload), errorDetailsFromPayload(r.payload)));
    } else {
      const n = msg as NotificationEnvelope;
      this.notificationHandlers.forEach((h) => h(n));
    }
  }

  private _destroy(err: Error): void {
    this.socket?.destroy();
    this.socket = undefined;
    for (const [, p] of this.pending) {
      clearTimeout(p.timer);
      p.reject(err);
    }
    this.pending.clear();
  }
}
