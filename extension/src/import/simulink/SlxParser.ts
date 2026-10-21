/**
 * `.slx` (pacote OPC): `simulink/blockdiagram.xml` com os sistemas embutidos ou referenciados
 * (`<System Ref="system_N"/>` -> `simulink/systems/system_N.xml`), `simulink/bddefaults.xml`
 * (padrões por tipo de bloco, omitidos do diagrama) e `simulink/configSet0.xml` (solver).
 */
import { ZipArchive } from "./zip";
import { childrenNamed, firstChild, parameters, parseXml, XmlElement } from "./xml";
import { parseOrientation, parsePortRef, parsePosition, parseViewerSignalList, SlBlock, SlLine, SlMaskParameter, SlModel, SlSystem } from "./SimulinkModel";

/** Acesso às partes do pacote (ZIP do `.slx` ou partes de texto de um `.mdl` OPC). */
export interface PartReader {
  names(): string[];
  has(name: string): boolean;
  readText(name: string): string;
}

export function parseSlx(data: Buffer, modelName: string): SlModel {
  return parsePackage(new ZipArchive(data), modelName, "slx");
}

export function parsePackage(zip: PartReader, modelName: string, format: "slx" | "mdl"): SlModel {
  if (!zip.has("simulink/blockdiagram.xml")) throw new Error("pacote .slx sem simulink/blockdiagram.xml");
  const diagram = parseXml(zip.readText("simulink/blockdiagram.xml"));
  const model = firstChild(diagram, "Model") ?? firstChild(diagram, "Library");
  if (!model) throw new Error("blockdiagram.xml sem <Model>");
  const resolveSystem = (element: XmlElement): XmlElement => {
    const ref = element.attributes.Ref;
    if (!ref) return element;
    const part = `simulink/systems/${ref}.xml`;
    if (!zip.has(part)) throw new Error(`sistema referenciado ausente: ${part}`);
    return parseXml(zip.readText(part));
  };
  const rootElement = firstChild(model, "System");
  if (!rootElement) throw new Error("modelo sem <System> raiz");
  const root = parseSystemElement(resolveSystem(rootElement), resolveSystem);
  const defaults = zip.has("simulink/bddefaults.xml") ? parseDefaults(parseXml(zip.readText("simulink/bddefaults.xml"))) : {};
  // Padrões também podem vir embutidos no blockdiagram.xml (versões antigas do formato).
  const inline = firstChild(model, "BlockParameterDefaults");
  if (inline) Object.assign(defaults, parseDefaults({ name: "x", attributes: {}, children: [inline], text: "" }));
  const config: Record<string, string> = {};
  for (const name of zip.names().filter((entry) => /^simulink\/configSet\d*\.xml$/.test(entry)).sort()) {
    collectParameters(parseXml(zip.readText(name)), config);
    break;
  }
  return { name: parameters(model).Name ?? modelName, format, root, defaults, config };
}

/** Padrões `<BlockParameterDefaults><Block BlockType="X"><P .../></Block>`. */
export function parseDefaults(document: XmlElement): Record<string, Record<string, string>> {
  const result: Record<string, Record<string, string>> = {};
  const visit = (element: XmlElement) => {
    if (element.name === "BlockParameterDefaults") {
      for (const block of childrenNamed(element, "Block")) {
        const type = block.attributes.BlockType;
        if (type) result[type] = { ...(result[type] ?? {}), ...parameters(block) };
      }
      return;
    }
    element.children.forEach(visit);
  };
  visit(document);
  return result;
}

function collectParameters(element: XmlElement, into: Record<string, string>): void {
  if (element.name === "P" && element.attributes.Name && into[element.attributes.Name] === undefined) into[element.attributes.Name] = element.text;
  element.children.forEach((child) => collectParameters(child, into));
}

export function parseSystemElement(element: XmlElement, resolve: (element: XmlElement) => XmlElement): SlSystem {
  const blocks = childrenNamed(element, "Block").map((block) => parseBlockElement(block, resolve));
  const lines: SlLine[] = childrenNamed(element, "Line").map(parseLineElement);
  return { blocks, lines };
}

function parseBlockElement(element: XmlElement, resolve: (element: XmlElement) => XmlElement): SlBlock {
  const params = parameters(element);
  const instance = firstChild(element, "InstanceData");
  if (instance) Object.assign(params, parameters(instance));
  const { rotation, mirror } = parseOrientation(params);
  const block: SlBlock = {
    sid: element.attributes.SID ?? params.SID ?? "",
    blockType: element.attributes.BlockType ?? params.BlockType ?? "",
    name: element.attributes.Name ?? params.Name ?? "",
    params,
    position: parsePosition(params.Position),
    rotation,
    mirror,
  };
  if (params.SourceBlock) block.sourceBlock = params.SourceBlock;
  const system = firstChild(element, "System");
  if (system) block.system = parseSystemElement(resolve(system), resolve);
  const mask = firstChild(element, "Mask");
  if (mask) {
    block.mask = childrenNamed(mask, "MaskParameter").map((parameter): SlMaskParameter => ({
      name: parameter.attributes.Name ?? "",
      value: firstChild(parameter, "Value")?.text ?? parameters(parameter).Value ?? "",
      prompt: firstChild(parameter, "Prompt")?.text,
    })).filter((parameter) => parameter.name.length > 0);
  }
  for (const list of childrenNamed(element, "List")) {
    if (list.attributes.ListType !== "IOSignalStrings") continue;
    const signals = parseViewerSignalList(parameters(list));
    if (signals.length > 0) block.viewerSignals = signals;
  }
  return block;
}

function parseLineElement(element: XmlElement): SlLine {
  const params = parameters(element);
  const line: SlLine = { src: parsePortRef(params.Src), dsts: [] };
  if (params.Name) line.name = params.Name;
  const collect = (node: XmlElement) => {
    const dst = parsePortRef(parameters(node).Dst);
    if (dst) line.dsts.push(dst);
    childrenNamed(node, "Branch").forEach(collect);
  };
  collect(element);
  return line;
}
