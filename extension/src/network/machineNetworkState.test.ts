import * as assert from "assert";
import { isMachineNetworkConfigCurrent, shouldOfferMachineNetworkSetup } from "./machineNetworkState";

assert.strictEqual(
  shouldOfferMachineNetworkSetup({
    platform: "win32",
    infrastructureCurrent: false,
    extensionVersion: "0.0.23",
  }),
  true,
  "instalação nova do Marketplace deve oferecer a infraestrutura com o modo padrão disabled",
);

assert.strictEqual(
  shouldOfferMachineNetworkSetup({
    platform: "win32",
    infrastructureCurrent: true,
    extensionVersion: "0.0.23",
  }),
  false,
  "infraestrutura atual não deve gerar uma oferta redundante",
);

assert.strictEqual(
  shouldOfferMachineNetworkSetup({
    platform: "win32",
    infrastructureCurrent: false,
    extensionVersion: "0.0.23",
    dismissedVersion: "0.0.23",
  }),
  false,
  "recusa explícita continua valendo para a versão atual",
);

assert.strictEqual(
  shouldOfferMachineNetworkSetup({
    platform: "win32",
    infrastructureCurrent: false,
    extensionVersion: "0.0.23",
    dismissedVersion: "0.0.22",
  }),
  true,
  "uma nova versão pode oferecer a infraestrutura novamente",
);

assert.strictEqual(
  shouldOfferMachineNetworkSetup({
    platform: "linux",
    infrastructureCurrent: false,
    extensionVersion: "0.0.23",
  }),
  false,
  "a infraestrutura TAP/bridge só deve ser oferecida no Windows",
);

assert.strictEqual(
  isMachineNetworkConfigCurrent(
    { schemaVersion: 2, gatewayPort: 9011, productVersion: "0.0.15" },
    9011,
    "0.0.15",
  ),
  true,
  "schema, porta e versão exatos devem dispensar novo download",
);

assert.strictEqual(
  isMachineNetworkConfigCurrent({ schemaVersion: 1, gatewayPort: 9011 }, 9011, "0.0.15"),
  false,
  "configuração legada da v0.0.13 sem versão precisa baixar o setup atual",
);

assert.strictEqual(
  isMachineNetworkConfigCurrent(
    { schemaVersion: 2, gatewayPort: 9011, productVersion: "0.0.13" },
    9011,
    "0.0.15",
  ),
  false,
  "infraestrutura de versão anterior precisa ser atualizada",
);

assert.strictEqual(
  isMachineNetworkConfigCurrent(
    { schemaVersion: 2, gatewayPort: 9012, productVersion: "0.0.15" },
    9011,
    "0.0.15",
  ),
  false,
  "porta divergente continua exigindo reparo",
);

assert.strictEqual(isMachineNetworkConfigCurrent(undefined, 9011, "0.0.15"), false);
assert.strictEqual(isMachineNetworkConfigCurrent("invalid", 9011, "0.0.15"), false);

console.log("machineNetworkState tests passed");
