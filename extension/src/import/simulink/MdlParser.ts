/**
 * `.mdl` (formato texto do Simulink). Duas variantes:
 *  - clássica: seções `Model { ... System { Block { ... } Line { ... } } }`, chaves `Nome valor`
 *    (texto entre aspas com continuação em linhas seguintes, vetores `[...]`, palavras soltas); linhas
 *    por NOME (`SrcBlock`/`SrcPort`/`DstBlock`/`DstPort`) ou pelo formato novo `Src "SID#out:1"`;
 *  - pacote OPC em texto (`__MWOPC_PACKAGE_BEGIN__`): as partes XML são lidas como no `.slx`.
 */
import { parsePackage, PartReader } from "./SlxParser";
import { parseOrientation, parsePortRef, parsePosition, parseViewerSignalList, SlBlock, SlLine, SlMaskParameter, SlModel, SlPortRef, SlSystem } from "./SimulinkModel";

export interface MdlSection {
  name: string;
  entries: Array<[string, string]>;
  sections: MdlSection[];
}

const value = (section: MdlSection, key: string): string | undefined => section.entries.find(([name]) => name === key)?.[1];
const sectionsNamed = (section: MdlSection, name: string) => section.sections.filter((child) => child.name === name);

/** Conteúdo de uma string MDL entre aspas (com os escapes do Simulink). */
function unquote(text: string): string {
  return text.replace(/\\(["\\nrt])/g, (_, c: string) => (c === "n" ? "\n" : c === "r" ? "\r" : c === "t" ? "\t" : c));
}

export function parseMdlSections(source: string): MdlSection {
  const root: MdlSection = { name: "#root", entries: [], sections: [] };
  const stack: MdlSection[] = [root];
  const lines = source.replace(/^\uFEFF/, "").split(/\r?\n/);
  let lastEntry: [string, string] | undefined;
  let pendingArray: { entry: [string, string]; depth: number } | undefined;
  for (const raw of lines) {
    const line = raw.trim();
    if (pendingArray) {
      pendingArray.entry[1] += ` ${line}`;
      pendingArray.depth += (line.match(/\[/g) ?? []).length - (line.match(/\]/g) ?? []).length;
      if (pendingArray.depth <= 0) pendingArray = undefined;
      continue;
    }
    if (line.length === 0 || line.startsWith("#")) continue;
    const top = stack[stack.length - 1]!;
    if (line === "}") {
      if (stack.length > 1) stack.pop();
      lastEntry = undefined;
      continue;
    }
    // Continuação de texto: linha que é só uma string entre aspas.
    if (line.startsWith("\"") && lastEntry && /^"(?:[^"\\]|\\.)*"$/.test(line)) {
      lastEntry[1] += unquote(line.slice(1, -1));
      continue;
    }
    const open = /^([^\s{]+)\s*\{$/.exec(line);
    if (open) {
      const section: MdlSection = { name: open[1]!, entries: [], sections: [] };
      top.sections.push(section);
      stack.push(section);
      lastEntry = undefined;
      continue;
    }
    const keyValue = /^(\S+)\s+([\s\S]*)$/.exec(line);
    if (!keyValue) continue;
    const key = keyValue[1]!;
    let text = keyValue[2]!.trim();
    let entry: [string, string];
    if (/^"(?:[^"\\]|\\.)*"$/.test(text)) {
      entry = [key, unquote(text.slice(1, -1))];
    } else {
      entry = [key, text];
      const depth = (text.match(/\[/g) ?? []).length - (text.match(/\]/g) ?? []).length;
      if (text.startsWith("[") && depth > 0) pendingArray = { entry, depth };
    }
    top.entries.push(entry);
    lastEntry = entry;
    text = "";
  }
  return root;
}

/** Partes de um `.mdl` empacotado (OPC em texto): `__MWOPC_PART_BEGIN__ /caminho`. */
function opcParts(source: string): Map<string, string> | undefined {
  if (!source.includes("__MWOPC_PACKAGE_BEGIN__")) return undefined;
  const parts = new Map<string, string>();
  const pattern = /__MWOPC_PART_BEGIN__\s+(\S+)[^\n]*\n([\s\S]*?)(?=__MWOPC_PART_BEGIN__|__MWOPC_PACKAGE_END__|$)/g;
  for (const match of source.matchAll(pattern)) parts.set(match[1]!.replace(/^\//, ""), match[2]!);
  return parts;
}

export function parseMdl(source: string, modelName: string): SlModel {
  const parts = opcParts(source);
  if (parts && parts.has("simulink/blockdiagram.xml")) {
    const reader: PartReader = { names: () => [...parts.keys()], has: (name) => parts.has(name), readText: (name) => parts.get(name) ?? "" };
    return parsePackage(reader, modelName, "mdl");
  }
  const root = parseMdlSections(source);
  const model = sectionsNamed(root, "Model")[0] ?? sectionsNamed(root, "Library")[0];
  if (!model) throw new Error("arquivo .mdl sem secao Model");
  const system = sectionsNamed(model, "System")[0];
  if (!system) throw new Error("modelo .mdl sem System raiz");
  const defaults: Record<string, Record<string, string>> = {};
  for (const section of sectionsNamed(model, "BlockParameterDefaults")) {
    for (const block of sectionsNamed(section, "Block")) {
      const type = value(block, "BlockType");
      if (type) defaults[type] = { ...(defaults[type] ?? {}), ...Object.fromEntries(block.entries) };
    }
  }
  const config: Record<string, string> = {};
  const collect = (section: MdlSection) => {
    for (const [key, entry] of section.entries) if (config[key] === undefined) config[key] = entry;
    section.sections.forEach(collect);
  };
  // Solver: chaves no próprio Model (formato antigo) ou num `Simulink.ConfigSet` (Array/Object).
  collect(model);
  return { name: value(model, "Name") ?? modelName, format: "mdl", root: mdlSystem(system), defaults, config };
}

function mdlSystem(section: MdlSection): SlSystem {
  const blocks = sectionsNamed(section, "Block").map(mdlBlock);
  const lines = sectionsNamed(section, "Line").map(mdlLine);
  return { blocks, lines };
}

function mdlBlock(section: MdlSection): SlBlock {
  const params = Object.fromEntries(section.entries);
  for (const instance of sectionsNamed(section, "InstanceData")) Object.assign(params, Object.fromEntries(instance.entries));
  const { rotation, mirror } = parseOrientation(params);
  const block: SlBlock = {
    sid: params.SID ?? "",
    blockType: params.BlockType ?? "",
    name: params.Name ?? "",
    params,
    position: parsePosition(params.Position),
    rotation,
    mirror,
  };
  if (params.SourceBlock) block.sourceBlock = params.SourceBlock;
  const system = sectionsNamed(section, "System")[0];
  if (system) block.system = mdlSystem(system);
  block.mask = mdlMask(section, params);
  if (block.mask.length === 0) delete block.mask;
  for (const list of sectionsNamed(section, "List")) {
    if (value(list, "ListType") !== "IOSignalStrings") continue;
    const signals = parseViewerSignalList(Object.fromEntries(list.entries));
    if (signals.length > 0) block.viewerSignals = signals;
  }
  return block;
}

/** Máscara: forma antiga (`MaskVariables "K=@1;Ti=@2;"` + `MaskValueString "2|10"`) ou objetos
 * `Simulink.MaskParameter` (forma nova). */
function mdlMask(section: MdlSection, params: Record<string, string>): SlMaskParameter[] {
  const result: SlMaskParameter[] = [];
  if (params.MaskVariables) {
    const names = params.MaskVariables.split(";").map((item) => item.split("=")[0]!.trim()).filter(Boolean);
    const values = (params.MaskValueString ?? "").split("|");
    names.forEach((name, index) => result.push({ name, value: values[index] ?? "" }));
    return result;
  }
  const visit = (node: MdlSection) => {
    if (node.name === "Object" && value(node, "$ClassName") === "Simulink.MaskParameter") {
      const name = value(node, "Name");
      if (name) result.push({ name, value: value(node, "Value") ?? "", prompt: value(node, "Prompt") });
    }
    node.sections.forEach(visit);
  };
  section.sections.filter((child) => child.name === "Object" || child.name === "Array").forEach(visit);
  return result;
}

function mdlPort(blockKey: string | undefined, portKey: string | undefined, kind: "in" | "out"): SlPortRef | undefined {
  if (!blockKey) return undefined;
  const port = portKey ?? "1";
  const index = Number(port);
  return Number.isFinite(index) ? { block: blockKey, byName: true, kind, index } : { block: blockKey, byName: true, kind: port, index: 0 };
}

function mdlLine(section: MdlSection): SlLine {
  const src = parsePortRef(value(section, "Src")) ?? mdlPort(value(section, "SrcBlock"), value(section, "SrcPort"), "out");
  const line: SlLine = { src, dsts: [] };
  const name = value(section, "Name");
  if (name) line.name = name;
  const collect = (node: MdlSection) => {
    const dst = parsePortRef(value(node, "Dst")) ?? mdlPort(value(node, "DstBlock"), value(node, "DstPort"), "in");
    if (dst) line.dsts.push(dst);
    sectionsNamed(node, "Branch").forEach(collect);
  };
  collect(section);
  return line;
}
