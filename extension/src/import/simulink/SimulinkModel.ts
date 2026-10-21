/**
 * Modelo intermediário de um diagrama do Simulink, comum aos formatos `.slx` (pacote OPC com XML) e
 * `.mdl` (texto). Guarda só o que a conversão para `.lsproj` usa: blocos (tipo, parâmetros como
 * texto, posição, orientação, conteúdo de subsistema, máscara), linhas (origem e destinos já com as
 * ramificações achatadas), padrões por tipo de bloco e a configuração do solver.
 */

export interface SlPortRef {
  /** SID do bloco (formato novo) ou nome do bloco no sistema (formato `.mdl` antigo). */
  block: string;
  byName?: boolean;
  /** `in`, `out` ou porta especial (`enable`, `trigger`, `state`, `ifaction`, `reset`...). */
  kind: string;
  /** 1-based; 0 nas portas especiais sem índice. */
  index: number;
}

export interface SlLine {
  src?: SlPortRef;
  dsts: SlPortRef[];
  name?: string;
}

export interface SlMaskParameter {
  name: string;
  value: string;
  prompt?: string;
}

export interface SlBlock {
  sid: string;
  blockType: string;
  name: string;
  /** Parâmetros do bloco (inclusive `InstanceData` de blocos de biblioteca), como texto. */
  params: Record<string, string>;
  /** [esquerda, topo, direita, base] em pixels do Simulink. */
  position?: [number, number, number, number];
  rotation: 0 | 90 | 180 | 270;
  mirror: boolean;
  /** Conteúdo de SubSystem. */
  system?: SlSystem;
  /** Caminho do bloco de biblioteca (`BlockType="Reference"`). */
  sourceBlock?: string;
  mask?: SlMaskParameter[];
  /** Scope/Display "viewer" (sem portas): sinais observados, `nomeDoBloco:o<porta>`. */
  viewerSignals?: Array<{ blockName: string; port: number }>;
}

export interface SlSystem {
  blocks: SlBlock[];
  lines: SlLine[];
}

export interface SlModel {
  name: string;
  format: "slx" | "mdl";
  root: SlSystem;
  /** Padrões por BlockType (`BlockParameterDefaults`), como texto. */
  defaults: Record<string, Record<string, string>>;
  /** Configuração (StartTime, StopTime, Solver, FixedStep, MaxStep, RelTol, AbsTol...). */
  config: Record<string, string>;
}

/** `[l, t, r, b]` -> números; `undefined` se inválido. */
export function parsePosition(text: string | undefined): [number, number, number, number] | undefined {
  if (!text) return undefined;
  const values = text.replace(/[[\]]/g, "").split(/[\s,;]+/).filter(Boolean).map(Number);
  return values.length === 4 && values.every(Number.isFinite) ? [values[0]!, values[1]!, values[2]!, values[3]!] : undefined;
}

/** Orientação: `BlockRotation` (horária) + `BlockMirror`, ou a forma antiga `Orientation`. */
export function parseOrientation(params: Record<string, string>): { rotation: 0 | 90 | 180 | 270; mirror: boolean } {
  let rotation = Number(params.BlockRotation ?? 0);
  let mirror = (params.BlockMirror ?? "off") === "on";
  if (params.BlockRotation === undefined && params.Orientation) {
    switch (params.Orientation) {
      case "left": rotation = 0; mirror = true; break;
      case "down": rotation = 90; break;
      case "up": rotation = 270; mirror = true; break;
      default: rotation = 0;
    }
  }
  const normalized = ((Math.round(rotation / 90) * 90) % 360 + 360) % 360;
  return { rotation: normalized as 0 | 90 | 180 | 270, mirror };
}

/** `SID#out:1`, `SID#in:2`, `SID#enable` (formato novo). */
export function parsePortRef(text: string | undefined): SlPortRef | undefined {
  if (!text) return undefined;
  const match = /^\s*([^#]+)#([A-Za-z]+)(?::(\d+))?\s*$/.exec(text);
  if (!match) return undefined;
  return { block: match[1]!.trim(), kind: match[2]!, index: match[3] ? Number(match[3]) : 0 };
}

/** `Integrator:o1` (sinal observado por um viewer). */
export function parseViewerSignal(text: string): { blockName: string; port: number } | undefined {
  const match = /^(.*):o(\d+)$/.exec(text.trim());
  return match ? { blockName: match[1]!, port: Number(match[2]) } : undefined;
}

/** Lista `IOSignalStrings` de um viewer: `setNSigs` concatena os sinais e `setNParseKeys` dá o
 * comprimento (em caracteres) de cada um, ex. `8,26` + `Fi(s):o1P.I ISA com anti-windup:o1`. */
export function parseViewerSignalList(params: Record<string, string>): Array<{ blockName: string; port: number }> {
  const result: Array<{ blockName: string; port: number }> = [];
  for (const [key, text] of Object.entries(params)) {
    const set = /^set(\d+)Sigs$/.exec(key);
    if (!set) continue;
    const lengths = (params[`set${set[1]}ParseKeys`] ?? "").split(",").map((item) => Number(item.trim())).filter((n) => Number.isInteger(n) && n > 0);
    const chars = [...text];
    const pieces: string[] = [];
    if (lengths.length > 0 && lengths.reduce((a, b) => a + b, 0) === chars.length) {
      let offset = 0;
      for (const length of lengths) { pieces.push(chars.slice(offset, offset + length).join("")); offset += length; }
    } else {
      pieces.push(text);
    }
    for (const piece of pieces) {
      const signal = parseViewerSignal(piece);
      if (signal) result.push(signal);
    }
  }
  return result;
}
