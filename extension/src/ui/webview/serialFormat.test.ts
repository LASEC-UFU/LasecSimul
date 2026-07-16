import { assert, createTestRunner } from "../../ipc/testSupport/MockCoreServer";
import { parseSerialInput, serialFormatBytes } from "./serialFormat";

const { test, finish } = createTestRunner("Serial Terminal — formatos do SimulIDE");
(async () => {
  await test("ASCII preserva UTF-8 no envio", () => assert(Buffer.from(parseSerialInput("ação\r\n", "ASCII")).toString("utf8") === "ação\r\n", "UTF-8 alterado"));
  await test("HEX aceita bytes binários completos", () => assert([...parseSerialInput("00 41 ff 0D 0a", "HEX")].join(",") === "0,65,255,13,10", "HEX incorreto"));
  await test("DEC/OCT/BIN seguem os mesmos modos do SimulIDE", () => {
    assert([...parseSerialInput("0 65 255", "DEC")].join(",") === "0,65,255", "DEC incorreto");
    assert([...parseSerialInput("000 101 377", "OCT")].join(",") === "0,65,255", "OCT incorreto");
    assert([...parseSerialInput("00000000 01000001 11111111", "BIN")].join(",") === "0,65,255", "BIN incorreto");
  });
  await test("rejeita token inválido e valor acima de 255", () => {
    let invalid = false, overflow = false;
    try { parseSerialInput("GG", "HEX"); } catch { invalid = true; }
    try { parseSerialInput("256", "DEC"); } catch { overflow = true; }
    assert(invalid && overflow, "entrada inválida foi aceita");
  });
  await test("formatação tem largura estável", () => {
    assert(serialFormatBytes([0, 65, 255], "HEX") === "00 41 FF ", "HEX formatado incorretamente");
    assert(serialFormatBytes([0, 65, 255], "BIN") === "00000000 01000001 11111111 ", "BIN formatado incorretamente");
  });
  const { failed } = finish(); process.exitCode = failed ? 1 : 0;
})();
