export type SupportedNetworkMode = "disabled" | "lab-router" | "lab-bridge";

export interface NetworkModeResolution {
  effectiveMode: SupportedNetworkMode;
  migratedLegacyIsolated: boolean;
}

/** Resolve o modo que deve ser enviado ao Core.
 *
 * `isolated` permanece aceito apenas como compatibilidade de leitura para projetos
 * antigos. A configuração efetiva passa a ser `lab-router`, permitindo que a camada
 * de ativação persista a migração uma única vez.
 */
export function resolveNetworkMode(configured: string | undefined): NetworkModeResolution {
  if (configured === "isolated") {
    return { effectiveMode: "lab-router", migratedLegacyIsolated: true };
  }
  if (configured === "lab-router" || configured === "lab-bridge") {
    return { effectiveMode: configured, migratedLegacyIsolated: false };
  }
  return { effectiveMode: "disabled", migratedLegacyIsolated: false };
}
