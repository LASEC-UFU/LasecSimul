import { createHash } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const expected = new Map([
  ["licenses/ipd-studio/LICENSE", "52734fd58b75df40e0c258246196b12ffab4183d116999faf7c79fa88a93ed42"],
  ["licenses/ipd-studio/NOTICE", "cc33895b1076f25d5d2ef905daf57c27253b45ed254639381a118eded7bb338b"],
  ["licenses/ipd-studio/THIRD-PARTY-LICENSES.md", "e380d732bc7c98cc32e371071ceb7dd44473511a58861d3dd2aa09eb64c137cc"],
  ["licenses/ipd-studio/COMMERCIAL-LICENSE.md", "da8c70044999b27b54e77f014cfd3a0ad935f60fa1999a5766b254a0d043a50e"],
  ["licenses/ipd-studio/TRADEMARKS.md", "fa8bbde9b5539ddf70224d19fcffef80d61364c241d4bbbce665786c5ac0e56c"],
  ["licenses/lasecsimul/GPL-3.0-or-later.txt", "230184f60bae2feaf244f10a8bac053c8ff33a183bcc365b4d8b876d2b7f4809"],
]);

let failed = false;
for (const [relative, expectedHash] of expected) {
  const file = path.join(root, relative);
  const actual = fs.existsSync(file)
    ? createHash("sha256").update(fs.readFileSync(file)).digest("hex")
    : "missing";
  if (actual !== expectedHash) {
    failed = true;
    console.error(`[license-snapshot] ${relative}: expected ${expectedHash}, got ${actual}`);
  }
}
if (failed) process.exitCode = 1;
else console.log(`[license-snapshot] ${expected.size} arquivos conferidos byte a byte`);
