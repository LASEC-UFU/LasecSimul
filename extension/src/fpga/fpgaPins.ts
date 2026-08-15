/** Deriva os pinos elétricos (um por bit) de uma lista de portas VHDL descobertas -- mesma
 * convenção EXATA de `FpgaPortMapper::mapPorts` (Core, `core/src/fpga/FpgaPortMapper.cpp`):
 * `"nome"` pra `width===1`; `"nome(N)"` pra `width>1`, onde N é o índice VHDL REAL do bit (não a
 * posição sequencial no array) -- pra uma porta `downto` de largura W, bitIndex 0 (primeiro
 * elemento) é o bit W-1 (MSB), decrescendo até bitIndex W-1 = bit 0 (LSB); pra uma porta `to`,
 * bitIndex 0 = bit 0, crescendo até bitIndex W-1 = bit W-1. As duas pontas (Core via
 * `addComponent`'s `fpga.ports`, Extension via este arquivo) precisam derivar o MESMO pinId a
 * partir do MESMO `PortSpec` -- uma divergência aqui faria `connectWire` nunca achar o pino certo. */

export interface FpgaPortSpec {
  name: string;
  direction: "in" | "out";
  width: number;
  downto: boolean;
}

export function fpgaPinIdsForPort(port: FpgaPortSpec): string[] {
  const width = Math.max(1, port.width);
  if (width === 1) return [port.name];
  const ids: string[] = [];
  for (let bitIndex = 0; bitIndex < width; bitIndex++) {
    const vhdlIndex = port.downto ? width - 1 - bitIndex : bitIndex;
    ids.push(`${port.name}(${vhdlIndex})`);
  }
  return ids;
}

/** `x`/`y` aqui são só posição-de-índice (mesma convenção de `pinsForTypeId`'s fallback dinâmico em
 * `extension.ts` -- posicionamento visual real vem de `componentSymbols.ts::pinLocalPosition`,
 * puramente função de `pinCount`/índice, não destes valores). */
export function buildFpgaPins(ports: readonly FpgaPortSpec[]): Array<{ id: string; x: number; y: number }> {
  const ids = ports.flatMap((port) => fpgaPinIdsForPort(port));
  return ids.map((id, index) => ({ id, x: 0, y: index * 12 }));
}
