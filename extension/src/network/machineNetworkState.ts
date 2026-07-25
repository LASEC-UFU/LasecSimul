export interface MachineNetworkConfig {
  schemaVersion?: number;
  gatewayPort?: number;
  productVersion?: string;
}

/** A infraestrutura global só está atual quando schema, porta e versão do produto coincidem.
 *
 * Até a v0.0.13, network.json não registrava a versão. Depois de uma atualização pelo
 * Marketplace, a Extension confundia "há alguma infraestrutura" com "a infraestrutura desta
 * versão está instalada" e nunca buscava o setup.exe correspondente no GitHub Release. */
export function isMachineNetworkConfigCurrent(
  value: unknown,
  expectedGatewayPort: number,
  expectedProductVersion: string,
): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const config = value as MachineNetworkConfig;
  return config.schemaVersion === 2
    && config.gatewayPort === expectedGatewayPort
    && config.productVersion === expectedProductVersion;
}
