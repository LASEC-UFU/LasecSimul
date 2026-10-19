export interface IdentDataset {
  id: string; name: string; source: string; time: number[]; input: number[]; output: number[];
  sampleTime?: number; inputUnit: string; outputUnit: string; inputName: string; outputName: string;
  history: Array<{ operation: string; parameters: Record<string, number | string> }>;
}
export interface IdentModel {
  id: string; name: string; family: "ARX" | "ARMAX" | "OE" | "Box-Jenkins" | "Processo 1ª ordem" | "Processo 2ª ordem" | "Integrador" | "Função de transferência" | "Espaço de estados (Ho-Kalman)"; domain: "discrete" | "continuous";
  sampleTime: number; initialOutput?:number; numerator: number[]; denominator: number[]; delay: number;
  parameters: Record<string, number>; fit: number; rmse: number; mae: number; aic: number; bic: number;
  residuals: number[]; predicted: number[]; method: string; diagnostics: string[];
  residualAutocorrelation: number[]; inputResidualCorrelation: number[];
  predictionKind: "one-step" | "simulation"; evaluationDatasetId: string;
  noiseNumerator?: number[]; noiseDenominator?: number[];
  stateSpace?: {A:number[][];B:number[];C:number[];D:number;x0?:number[]};
}
export interface IdentProject { version: 1; datasets: IdentDataset[]; models: IdentModel[]; estimationDatasetId?: string; validationDatasetId?: string; }
