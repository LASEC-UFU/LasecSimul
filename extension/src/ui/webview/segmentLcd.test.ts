import { assert, createTestRunner } from "../../ipc/testSupport/MockCoreServer";
import { decodeSegmentLcd, fourteenSegments, segmentLcdSvg, SegmentLcdAnnunciator, sevenSegments } from "./segmentLcd";

/** Payload as the Core writes it (HartLcd.cpp::hartLcdSerialize). */
function payload(numeric: string, decimalPoints: number, alpha: string, annunciators: number, enabled = true): Uint8Array {
  const bytes = new Uint8Array(12 + 24);
  const view = new DataView(bytes.buffer);
  view.setUint32(12, enabled ? 1 : 0, true);
  for (let i = 0; i < 6; i += 1) bytes[16 + i] = numeric.charCodeAt(i);
  bytes[22] = decimalPoints;
  for (let i = 0; i < 5; i += 1) bytes[24 + i] = alpha.charCodeAt(i);
  view.setUint32(32, annunciators, true);
  return bytes;
}

function count(markup: string, pattern: RegExp): number {
  return (markup.match(pattern) ?? []).length;
}

(async () => {
  const { test, finish } = createTestRunner("segment-lcd (indicador do transmissor HART)");

  await test("decodifica o quadro do Core: 4 1/2 dígitos, pontos, 5 alfanuméricos, anunciadores", () => {
    const frame = decodeSegmentLcd(payload("-12667", 1 << 2, "  SAT", SegmentLcdAnnunciator.processVariable | SegmentLcdAnnunciator.percent), 12);
    assert(frame?.enabled === true && frame.numeric === "-12667" && frame.decimalPoints === 4 && frame.alpha === "  SAT", "campos");
    assert((frame!.annunciators & SegmentLcdAnnunciator.percent) !== 0, "anunciador %");
  });

  await test("o vidro tem 1 meio dígito + 4 dígitos de 7 segmentos e 5 caracteres de 14 segmentos", () => {
    const svg = segmentLcdSvg(decodeSegmentLcd(payload("  2500", 1 << 3, "mmH2O", SegmentLcdAnnunciator.processVariable), 12), 0, 0, 100, 70);
    // 2 (meio dígito) + 4*7 + 5*14 segmentos desenhados (acesos ou apagados).
    assert(count(svg, /data-lcd-segment=/g) === 2 + 4 * 7 + 5 * 14, `segmentos: ${count(svg, /data-lcd-segment=/g)}`);
    assert(count(svg, /data-lcd-point=/g) === 4, "4 pontos decimais (após o meio dígito e os 3 primeiros dígitos)");
    assert(/data-lcd-point="3"[^>]*data-lit="1"/.test(svg), "ponto de 25.00 aceso após o 2º dígito");
    assert(/data-lcd-annunciator="PV" data-lit|data-lit="1" data-lcd-annunciator="PV"/.test(svg), "anunciador PV aceso");
    assert(!/data-lit="1" data-lcd-annunciator="Fix"/.test(svg), "Fix apagado");
  });

  await test("glifos: 7 segmentos para dígitos e 14 segmentos para mmH2O/SAT/LD301", () => {
    assert(sevenSegments("2") === "abged" && sevenSegments("-") === "g", "7 segmentos");
    for (const char of "mmH2OSATLD301V7.02") {
      if (char === ".") continue;
      assert(fourteenSegments(char).length > 0, `14 segmentos para '${char}'`);
    }
  });

  await test("indicador não instalado ou desligado: vidro apagado", () => {
    assert(segmentLcdSvg(decodeSegmentLcd(payload("  2500", 0, "mmH2O", 0, false), 12), 0, 0, 100, 70) === "", "sem desenho");
    assert(decodeSegmentLcd(new Uint8Array(10), 12) === undefined, "payload curto é ignorado");
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();
