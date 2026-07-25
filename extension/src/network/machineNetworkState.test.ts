import * as assert from "assert";
import { isMachineNetworkConfigCurrent } from "./machineNetworkState";

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
