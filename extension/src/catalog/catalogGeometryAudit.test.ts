import * as fs from "fs";
import * as path from "path";
import { assert, createTestRunner } from "../ipc/testSupport/MockCoreServer";
import { sanitizePackage } from "./packageSanitizers";
import { componentBox, pinLocalPosition, registerPackage } from "../ui/webview/componentSymbols";
import { transformLocalPoint } from "../ui/webview/componentGeometry";

function files(root: string): string[] {
  if (!fs.existsSync(root)) return [];
  return fs.readdirSync(root, { withFileTypes: true }).flatMap((entry) => {
    const absolute = path.join(root, entry.name);
    return entry.isDirectory() ? files(absolute) : [absolute];
  });
}

(async () => {
  const { test, finish } = createTestRunner("catálogo completo - geometria canônica dos terminais");
  const roots = ["devices", "mcu-adapters", "subcircuits"].map((name) => path.resolve(process.cwd(), "..", name));
  const manifests = roots.flatMap(files).filter((file) => /\.(lsdevice|lssubcircuit)$/i.test(file));

  await test("varre todos os manifestos, sem ajuste por dispositivo", () => {
    assert(manifests.length >= 70, `varredura encontrou apenas ${manifests.length} manifestos`);
    let auditedPins = 0;
    for (const file of manifests) {
      const json = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      for (const packageKey of ["package", "logicSymbolPackage"] as const) {
        const descriptor = sanitizePackage(json[packageKey], path.dirname(file));
        if (!descriptor) continue;
        const typeId = `audit:${file}:${packageKey}`;
        registerPackage(typeId, descriptor);
        const properties = Object.fromEntries(
          (Array.isArray(json.properties) ? json.properties : []).flatMap((value) => {
            const item = typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
            return item && typeof item.id === "string" && ["string", "number", "boolean"].includes(typeof item.default)
              ? [[item.id, item.default]] : [];
          }),
        ) as Record<string, string | number | boolean>;
        const box = componentBox(typeId, properties);
        assert(Number.isFinite(box.width) && box.width > 0 && Number.isFinite(box.height) && box.height > 0,
          `${file}:${packageKey}: caixa inválida`);
        descriptor.pins.forEach((pin, index) => {
          const local = pinLocalPosition(pin.id, index, descriptor.pins.length, typeId, properties);
          assert(Number.isFinite(local.x) && Number.isFinite(local.y), `${file}:${packageKey}:${pin.id}: terminal não finito`);
          assert(local.x >= -0.01 && local.y >= -0.01 && local.x <= box.width + 0.01 && local.y <= box.height + 0.01,
            `${file}:${packageKey}:${pin.id}: terminal fora do layout resolvido`);
          for (const rotation of [0, 90, 180, 270] as const) {
            for (const flipH of [false, true]) for (const flipV of [false, true]) {
              const transformed = transformLocalPoint(local, { size: box, rotation, flipH, flipV });
              assert(Number.isFinite(transformed.x) && Number.isFinite(transformed.y), `${file}:${packageKey}:${pin.id}: rotação/espelho inválidos`);
            }
          }
          auditedPins++;
        });
      }
    }
    assert(auditedPins > 400, `apenas ${auditedPins} terminais foram auditados`);
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})().catch((error) => { console.error(error); process.exitCode = 1; });
