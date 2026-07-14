export const PROTOCOL_VERSION = 2;

/** Envelope de requisição: Extension → Core (newline-delimited JSON). */
export interface RequestEnvelope {
  readonly id: string;
  readonly type: string;
  readonly payload: unknown;
  readonly protocolVersion: number;
}

/** Envelope de resposta: Core → Extension. */
export interface ResponseEnvelope {
  readonly id: string;
  readonly ok: boolean;
  readonly payload?: unknown;
  readonly error?: string;
}

/** Notificação assíncrona: Core → Extension (sem id, sem resposta esperada). */
export interface NotificationEnvelope {
  readonly type: string;
  readonly payload: unknown;
}

/** Erro de uma requisição IPC rejeitada pelo Core. `code` é o `errorCode` estável que alguns
 * handlers (ex: `setProperty`) embutem em `payload` quando `ok === false` — ver
 * `core/src/app/CoreApplication.cpp::parsePropertyError` ("unknown_property"|"read_only"|
 * "type_mismatch"|"out_of_range"|"invalid_option"). `code` fica `undefined` para handlers que ainda
 * só devolvem `error` (texto livre), o que mantém quem só lê `.message` funcionando sem mudança. */
export class IpcError extends Error {
  readonly code?: string;
  readonly details?: Record<string, unknown>;
  readonly column?: number;

  constructor(message: string, code?: string, details?: Record<string, unknown>) {
    super(message);
    this.name = "IpcError";
    this.code = code;
    this.details = details;
    this.column = typeof details?.column === "number" ? details.column : undefined;
  }
}

export function errorDetailsFromPayload(payload: unknown): Record<string, unknown> | undefined {
  return typeof payload === "object" && payload !== null ? payload as Record<string, unknown> : undefined;
}

export function errorCodeFromPayload(payload: unknown): string | undefined {
  if (typeof payload !== "object" || payload === null) return undefined;
  const errorCode = (payload as Record<string, unknown>).errorCode;
  return typeof errorCode === "string" ? errorCode : undefined;
}

export type ControlMessageType =
  | "hello"
  | "shutdown"
  | "loadProject"
  | "applyChange"
  | "start"
  | "pause"
  | "stop";

export interface HelloPayload {
  clientVersion: string;
}

export interface HelloResponsePayload {
  serverVersion: string;
  protocolVersion: number;
}
