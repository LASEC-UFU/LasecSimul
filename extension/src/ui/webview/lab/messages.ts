/** Protocolo entre o Extension Host e a Webview do Laboratório de Cálculo (versão 1). */
import type { CalculusLab, LabActivity } from "./activity";

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

/** Ligação de uma atividade de processo com a instância do subcircuito no projeto. */
export type LabPlantStatus =
  | { state: "missing" }
  | { state: "bound"; componentId: string; label: string }
  | { state: "error"; message: string };

/** Componente do projeto que pode servir de planta (editor e auditoria). */
export interface LabProjectComponent { id: string; typeId: string; label: string }

/** Achado da auditoria de referências (padrão `hmiAudit`): nunca falha silenciosa. */
export interface LabAuditFinding {
  activityId: string;
  severity: "error" | "warning";
  code: "missing-plant" | "ambiguous-plant" | "no-plant";
  message: string;
  /** Componentes do tipo certo para religar. */
  candidates: LabProjectComponent[];
}

export type HostToLabMessage =
  | { version: 1; type: "labInit"; locale: string; lab: CalculusLab; mode: LabMode; activeId: string; projectName?: string; saved: boolean }
  | { version: 1; type: "labSaved"; activityId: string }
  | { version: 1; type: "labPlant"; activityId: string; status: LabPlantStatus }
  | { version: 1; type: "labRunState"; status: LabRunStatus }
  | { version: 1; type: "labSeries"; activityId: string; delta: LabSeriesDelta }
  /** Valor aceito pelo Core; `appliedAtNs` ausente quando a simulação está parada (vale no próximo início). */
  | { version: 1; type: "labParameter"; activityId: string; id: string; value: number; appliedAtNs?: number }
  | { version: 1; type: "labParameterRejected"; activityId: string; id: string; value: number; reason: string }
  | { version: 1; type: "labProject"; components: LabProjectComponent[]; findings: LabAuditFinding[] }
  | { version: 1; type: "labHistory"; canUndo: boolean; canRedo: boolean };

export type LabToHostMessage =
  | { version: 1; type: "labReady" }
  /** Professor grava uma atividade no projeto (marca o `.lsproj` como alterado). */
  | { version: 1; type: "labSaveActivity"; activity: LabActivity }
  /** Editor de atividades: grava o laboratório inteiro (lista, ordem, remoções). */
  | { version: 1; type: "labSaveLab"; lab: CalculusLab }
  | { version: 1; type: "labUndo" }
  | { version: 1; type: "labRedo" }
  | { version: 1; type: "labSetMode"; mode: LabMode }
  /** A Webview passou a mostrar esta atividade (o Host liga/desliga o experimento). */
  | { version: 1; type: "labActivate"; activity: LabActivity }
  | { version: 1; type: "labRun" }
  | { version: 1; type: "labPause" }
  /** Para, reconstrói e reaplica os parâmetros autorados (nova geração na próxima execução). */
  | { version: 1; type: "labRestart"; parameters: Record<string, number> }
  | { version: 1; type: "labSetParameter"; id: string; value: number }
  /** Insere uma instância do processo da atividade no projeto (paleta) e liga a atividade a ela. */
  | { version: 1; type: "labInsertPlant" };
