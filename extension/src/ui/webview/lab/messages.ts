/** Protocolo entre o Extension Host e a Webview do Laboratório de Cálculo (versão 1). */
import type { CalculusLab, LabActivity } from "./activity";
import type { TankParameterId } from "./tankModel";

export const LAB_MESSAGE_VERSION = 1 as const;

export type LabMode = "student" | "teacher";
export type LabRunStatus = "stopped" | "running" | "paused";

/** Evento de série vindo do Core (ADR 0012); `tS` em segundos simulados. */
export interface LabSeriesEvent { tS: number; kind: "start" | "parameter"; name?: string; value?: number; instanceId?: string }

/** Linhas novas de uma assinatura (append-only); `reset` = descartar o que havia (geração nova). */
export interface LabSeriesDelta {
  reset: boolean;
  generation: number;
  columns: string[];
  t: number[];
  values: number[][];
  events: LabSeriesEvent[];
  lost: number;
}

/** Ligação da atividade do tanque com a instância do processo no projeto. */
export type LabPlantStatus =
  | { state: "missing" }
  | { state: "bound"; componentId: string; label: string }
  | { state: "error"; message: string };

export type HostToLabMessage =
  | { version: 1; type: "labInit"; locale: string; lab: CalculusLab; mode: LabMode; activeId: string; projectName?: string }
  | { version: 1; type: "labSaved"; activityId: string }
  | { version: 1; type: "labPlant"; activityId: string; status: LabPlantStatus }
  | { version: 1; type: "labRunState"; status: LabRunStatus }
  | { version: 1; type: "labSeries"; activityId: string; delta: LabSeriesDelta }
  /** Valor aceito pelo Core; `appliedAtNs` ausente quando a simulação está parada (vale no próximo início). */
  | { version: 1; type: "labParameter"; activityId: string; id: TankParameterId; value: number; appliedAtNs?: number }
  | { version: 1; type: "labParameterRejected"; activityId: string; id: TankParameterId; value: number; reason: string };

export type LabToHostMessage =
  | { version: 1; type: "labReady" }
  /** Professor grava a definição da atividade no projeto (marca o `.lsproj` como alterado). */
  | { version: 1; type: "labSaveActivity"; activity: LabActivity }
  | { version: 1; type: "labSetMode"; mode: LabMode }
  /** A Webview passou a mostrar esta atividade (o Host liga/desliga o experimento). */
  | { version: 1; type: "labActivate"; activity: LabActivity }
  | { version: 1; type: "labRun" }
  | { version: 1; type: "labPause" }
  /** Para, reconstrói e reaplica os parâmetros autorados (nova geração na próxima execução). */
  | { version: 1; type: "labRestart"; parameters: Record<TankParameterId, number> }
  | { version: 1; type: "labSetParameter"; id: TankParameterId; value: number }
  /** Insere uma instância do processo no projeto (paleta) e liga a atividade a ela. */
  | { version: 1; type: "labInsertPlant" };
