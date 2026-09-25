export type SupportedNetworkMode = "disabled" | "isolated" | "lab-router" | "lab-bridge";

export interface NetworkModeResolution {
  effectiveMode: SupportedNetworkMode;
  migratedLegacyIsolated: boolean;
}

/** Resolve o modo que deve ser enviado ao Core.
 *
 * Padrão transparente: quando nada é configurado, a ESP32 usa `isolated` (uplink
 * SLIRP transparente), então um firmware Arduino com `WiFi.begin()` conecta à
 * internet automaticamente, sem exigir TAP/administrador nem qualquer toggle.
 * `disabled` continua sendo a opção explícita de "sem rede"; `lab-router`/
 * `lab-bridge` permanecem para acesso à LAN real e descoberta mDNS a partir do
 * host (exigem provisionamento de TAP).
 */
export function resolveNetworkMode(configured: string | undefined): NetworkModeResolution {
  if (configured === "disabled" || configured === "isolated" ||
      configured === "lab-router" || configured === "lab-bridge") {
    return { effectiveMode: configured, migratedLegacyIsolated: false };
  }
  return { effectiveMode: "isolated", migratedLegacyIsolated: false };
}
