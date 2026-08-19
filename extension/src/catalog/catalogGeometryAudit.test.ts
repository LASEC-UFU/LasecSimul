import * as fs from "fs";
import * as path from "path";
import { assert, createTestRunner } from "../ipc/testSupport/MockCoreServer";
import { sanitizePackage } from "./packageSanitizers";
import {
  componentBox, packageSymbolSvg, pinLocalPosition, pinTerminalMargins, registerPackage, resolvedPackageFor,
} from "../ui/webview/componentSymbols";
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

  // Invariante da REGRA CENTRAL DE GEOMETRIA (`pinTerminalMargins`, componentSymbols.ts): todo
  // manifesto real do repositório, sem exceção nem ajuste por `typeId`, que tenha um pino nascendo
  // na borda da caixa (`local.x`/`local.y` em 0 ou no limite do box resolvido) precisa ter o
  // `<clipPath>` genérico presente no SVG renderizado -- é isso que garante que NENHUM `.lsdevice`
  // consiga reintroduzir o bug (fio grosso pintado por cima do corpo sólido) silenciosamente, seja
  // ele um device já existente ou um novo ainda por vir. Não confia em cor/contraste (achado real:
  // `ds1307` tinha o mesmo bug que `serialport`, só invisível por acidente de cor) -- só geometria.
  await test("regra central: todo pino na borda da caixa tem a margem do terminal protegida por clip-path (qualquer .lsdevice, sem exceção por typeId)", () => {
    let edgePinsChecked = 0;
    for (const file of manifests) {
      const json = JSON.parse(fs.readFileSync(file, "utf8")) as Record<string, unknown>;
      for (const packageKey of ["package", "logicSymbolPackage"] as const) {
        const descriptor = sanitizePackage(json[packageKey], path.dirname(file));
        if (!descriptor) continue;
        const typeId = `clip-audit:${file}:${packageKey}`;
        registerPackage(typeId, descriptor);
        const properties = Object.fromEntries(
          (Array.isArray(json.properties) ? json.properties : []).flatMap((value) => {
            const item = typeof value === "object" && value !== null ? value as Record<string, unknown> : undefined;
            return item && typeof item.id === "string" && ["string", "number", "boolean"].includes(typeof item.default)
              ? [[item.id, item.default]] : [];
          }),
        ) as Record<string, string | number | boolean>;
        const box = componentBox(typeId, properties);
        const hasEdgePin = descriptor.pins.some((pin, index) => {
          if (typeof pin.length === "number" && pin.length <= 0) return false;
          const local = pinLocalPosition(pin.id, index, descriptor.pins.length, typeId, properties);
          return local.x <= 0.5 || local.x >= box.width - 0.5 || local.y <= 0.5 || local.y >= box.height - 0.5;
        });
        if (!hasEdgePin) continue;
        edgePinsChecked++;
        const svg = packageSymbolSvg(typeId, properties, `clip-audit-${edgePinsChecked}`) ?? "";
        assert(typeof svg === "string", `${file}:${packageKey}: renderer não devolveu SVG pra um package com pino na borda`);

        // Checagem algébrica de verdade: recalcula a margem de FORA (mesma função `pinTerminalMargins`
        // que `packageBodySvg` usa por dentro, via `resolvedPackageFor` -- não uma cópia da lógica) e
        // compara com o retângulo de clip efetivamente renderizado no SVG. O clip só é OMITIDO quando
        // a margem calculada é zero nos 4 lados (ex: convenção hd44780, pino ancorado no CORPO em vez
        // da CAIXA -- ver testes conceituais em componentSymbols.test.ts); nesse caso o teste exige que
        // NENHUM clip apareça, em vez de aceitar qualquer coisa. Isso fecha o buraco: um `.lsdevice`
        // novo com pino na borda só passa se o clip existir E bater com a margem correta -- por
        // geometria, nunca por `typeId`.
        const resolved = resolvedPackageFor(typeId, properties);
        assert(Boolean(resolved), `${file}:${packageKey}: resolvedPackageFor não achou o package recém-registrado`);
        const expected = pinTerminalMargins(resolved!.pins, resolved!.source.width, resolved!.source.height);
        const hasExpectedClip = expected.left > 0 || expected.right > 0 || expected.top > 0 || expected.bottom > 0;
        const clipMatch = /<clipPath id="[^"]*-terminal-clip"><rect x="([\d.]+)" y="([\d.]+)" width="([\d.]+)" height="([\d.]+)"\/><\/clipPath>/.exec(svg);

        if (!hasExpectedClip) {
          assert(!clipMatch, `${file}:${packageKey}: margem calculada é zero nos 4 lados mas o SVG tem um clip-path terminal mesmo assim`);
        } else {
          assert(Boolean(clipMatch), `${file}:${packageKey}: margem calculada (${JSON.stringify(expected)}) exige clip-path terminal, mas o SVG não tem nenhum`);
          const [, x, y, w, h] = clipMatch!;
          const expX = expected.left, expY = expected.top;
          const expW = Math.max(0, resolved!.source.width - expected.left - expected.right);
          const expH = Math.max(0, resolved!.source.height - expected.top - expected.bottom);
          const close = (a: number, b: number) => Math.abs(a - b) < 0.02;
          assert(close(Number(x), expX) && close(Number(y), expY) && close(Number(w), expW) && close(Number(h), expH),
            `${file}:${packageKey}: clip-path renderizado (x=${x},y=${y},w=${w},h=${h}) não bate com a margem recalculada (x=${expX},y=${expY},w=${expW},h=${expH})`);
        }
      }
    }
    assert(edgePinsChecked > 30, `varredura deveria achar dezenas de packages com pino na borda da caixa; achou ${edgePinsChecked}`);
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})().catch((error) => { console.error(error); process.exitCode = 1; });
