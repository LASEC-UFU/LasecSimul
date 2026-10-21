/**
 * Parser XML mínimo para as partes do `.slx` (blockdiagram.xml, systems/*.xml, bddefaults.xml,
 * configSet0.xml): elementos, atributos, texto, entidades e CDATA. Ignora declaração, comentários e
 * instruções de processamento. Não valida DTD (os arquivos do Simulink não usam).
 */

export interface XmlElement {
  name: string;
  attributes: Record<string, string>;
  children: XmlElement[];
  /** Texto direto do elemento (concatenado, sem o dos filhos). */
  text: string;
}

const ENTITIES: Record<string, string> = { lt: "<", gt: ">", amp: "&", quot: "\"", apos: "'" };

export function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|[a-zA-Z]+);/g, (whole, entity: string) => {
    if (entity.startsWith("#x")) return String.fromCodePoint(parseInt(entity.slice(2), 16));
    if (entity.startsWith("#")) return String.fromCodePoint(parseInt(entity.slice(1), 10));
    return ENTITIES[entity] ?? whole;
  });
}

export function parseXml(source: string): XmlElement {
  let position = 0;
  const text = source.replace(/^﻿/, "");
  const fail = (reason: string): never => { throw new Error(`XML invalido (posicao ${position}): ${reason}`); };
  const root: XmlElement = { name: "#document", attributes: {}, children: [], text: "" };
  const stack: XmlElement[] = [root];
  while (position < text.length) {
    const lt = text.indexOf("<", position);
    const top = stack[stack.length - 1]!;
    if (lt < 0) { top.text += decodeEntities(text.slice(position)); break; }
    if (lt > position) top.text += decodeEntities(text.slice(position, lt));
    position = lt;
    if (text.startsWith("<!--", position)) {
      const end = text.indexOf("-->", position + 4);
      if (end < 0) fail("comentario sem fim");
      position = end + 3;
    } else if (text.startsWith("<![CDATA[", position)) {
      const end = text.indexOf("]]>", position + 9);
      if (end < 0) fail("CDATA sem fim");
      top.text += text.slice(position + 9, end);
      position = end + 3;
    } else if (text.startsWith("<?", position)) {
      const end = text.indexOf("?>", position + 2);
      if (end < 0) fail("instrucao sem fim");
      position = end + 2;
    } else if (text.startsWith("<!", position)) {
      const end = text.indexOf(">", position + 2);
      if (end < 0) fail("declaracao sem fim");
      position = end + 1;
    } else if (text.startsWith("</", position)) {
      const end = text.indexOf(">", position + 2);
      if (end < 0) fail("tag de fechamento sem fim");
      const name = text.slice(position + 2, end).trim();
      const element = stack.pop();
      if (!element || element.name !== name) fail(`fechamento </${name}> nao corresponde a <${element?.name}>`);
      position = end + 1;
    } else {
      // Tag de abertura: nome, atributos (com aspas simples ou duplas), possivelmente auto-fechada.
      let cursor = position + 1;
      const nameMatch = /^[^\s/>]+/.exec(text.slice(cursor, cursor + 256));
      if (!nameMatch) fail("nome de elemento ausente");
      const element: XmlElement = { name: nameMatch![0], attributes: {}, children: [], text: "" };
      cursor += nameMatch![0].length;
      for (;;) {
        while (cursor < text.length && /\s/.test(text[cursor]!)) cursor++;
        if (text.startsWith("/>", cursor)) { cursor += 2; top.children.push(element); break; }
        if (text[cursor] === ">") { cursor++; top.children.push(element); stack.push(element); break; }
        const attribute = /^([^\s=/>]+)\s*=\s*("([^"]*)"|'([^']*)')/.exec(text.slice(cursor, cursor + 65536));
        if (!attribute) fail(`atributo invalido em <${element.name}>`);
        element.attributes[attribute![1]!] = decodeEntities(attribute![3] ?? attribute![4] ?? "");
        cursor += attribute![0].length;
      }
      position = cursor;
    }
  }
  if (stack.length !== 1) fail(`elemento <${stack[stack.length - 1]!.name}> sem fechamento`);
  const element = root.children[0];
  if (!element) fail("documento vazio");
  return element!;
}

export function childrenNamed(element: XmlElement, name: string): XmlElement[] {
  return element.children.filter((child) => child.name === name);
}

export function firstChild(element: XmlElement, name: string): XmlElement | undefined {
  return element.children.find((child) => child.name === name);
}

/** Parâmetros `<P Name="X">valor</P>` diretos do elemento. */
export function parameters(element: XmlElement): Record<string, string> {
  const result: Record<string, string> = {};
  for (const child of element.children) if (child.name === "P" && child.attributes.Name !== undefined) result[child.attributes.Name] = child.text;
  return result;
}
