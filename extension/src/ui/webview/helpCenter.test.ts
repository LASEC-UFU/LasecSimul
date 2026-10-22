import assert from "assert";
import { helpCenterUrl } from "./helpCenter";

assert.strictEqual(helpCenterUrl(), "https://lasec-ufu.github.io/LasecSimul/");
assert.strictEqual(helpCenterUrl("sl.integrator"), "https://lasec-ufu.github.io/LasecSimul/components/sl-integrator.html");
assert.strictEqual(helpCenterUrl("protocol.hart_device"), "https://lasec-ufu.github.io/LasecSimul/components/protocol-hart-device.html");
console.log("Help Center URL tests passed");
