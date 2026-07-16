export type SerialFormat = "ASCII" | "HEX" | "DEC" | "OCT" | "BIN";

export function serialFormatBytes(bytes: readonly number[], format: SerialFormat): string {
  if (format === "ASCII") return bytes.map((value) => String.fromCharCode(value)).join("");
  const base = format === "HEX" ? 16 : format === "DEC" ? 10 : format === "OCT" ? 8 : 2;
  const width = format === "HEX" ? 2 : format === "BIN" ? 8 : 3;
  return bytes.map((value) => value.toString(base).toUpperCase().padStart(width, "0")).join(" ") + (bytes.length ? " " : "");
}

export function parseSerialInput(text: string, format: SerialFormat): Uint8Array {
  if (format === "ASCII") return new TextEncoder().encode(text);
  const base = format === "HEX" ? 16 : format === "DEC" ? 10 : format === "OCT" ? 8 : 2;
  const pattern = format === "HEX" ? /^[0-9a-fA-F]+$/ : format === "DEC" ? /^[0-9]+$/ : format === "OCT" ? /^[0-7]+$/ : /^[01]+$/;
  return Uint8Array.from(text.trim().split(/\s+/).filter(Boolean).map((token) => {
    if (!pattern.test(token)) throw new Error(`Valor ${format} inválido: ${token}`);
    const value = parseInt(token, base);
    if (!Number.isInteger(value) || value < 0 || value > 255) throw new Error(`Byte fora do intervalo 0..255: ${token}`);
    return value;
  }));
}
