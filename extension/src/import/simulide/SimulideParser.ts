import {
  SimulideAttributes,
  SimulideCircuitDocument,
  SimulideConnectorRecord,
  SimulideImportIssue,
} from "./SimulideTypes";

function decodeXmlEntities(value: string): string {
  return value
    // O TextComponent do SimulIDE usa referências numéricas, algumas historicamente sem ';'.
    .replace(/&#x([0-9a-fA-F]+);?/g, (_match, hex: string) => String.fromCodePoint(Number.parseInt(hex, 16)))
    .replace(/&#(\d+);?/g, (_match, decimal: string) => String.fromCodePoint(Number.parseInt(decimal, 10)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/**
 * O SimulIDE persiste cada <circuit> / <item> em uma única linha e sempre grava atributos
 * entre aspas. Não usamos DOM/XML externo para manter o importador sem dependências adicionais.
 */
export function parseSimulideAttributes(line: string): SimulideAttributes {
  const attributes: SimulideAttributes = {};
  const expression = /([A-Za-z_][A-Za-z0-9_]*)\s*=\s*"([^"]*)"/g;
  let match: RegExpExecArray | null;
  while ((match = expression.exec(line)) !== null) {
    const name = match[1];
    const value = match[2];
    if (name && value !== undefined) attributes[name] = decodeXmlEntities(value);
  }
  return attributes;
}

/** `undefined` para pointList ausente/inválido -- nunca lança. Quem chama decide o fallback
 * geométrico (ver `resolveEndpoint` em `SimulideToLasecConverter.ts`), e o warning correspondente
 * é responsabilidade de quem detecta a linha malformada (`parseSimulideCircuit`). */
export function parseSimulidePointList(raw: string | undefined): Array<{ x: number; y: number }> | undefined {
  if (!raw) return [];
  const parts = raw.split(",").map((part) => Number(part.trim()));
  if (parts.length < 4 || parts.length % 2 !== 0 || parts.some((value) => !Number.isFinite(value))) {
    return undefined;
  }
  const points: Array<{ x: number; y: number }> = [];
  for (let index = 0; index < parts.length; index += 2) {
    points.push({ x: parts[index]!, y: parts[index + 1]! });
  }
  return points;
}

function optionalNumber(value: string | undefined): number | undefined {
  if (value === undefined || value.trim() === "") return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

/**
 * Best-effort: uma linha individualmente malformada (CircId ausente/duplicado, item sem
 * itemtype, Connector sem pino, pointList inválida, <mainCompProps> órfã) NUNCA aborta o arquivo
 * inteiro -- vira um "parse-warning"/"duplicate-id" e o parser segue para a próxima linha. Só a
 * ausência da própria tag `<circuit>` (arquivo que não é um circuito SimulIDE) é tratada como
 * realmente ilegível e lança.
 */
export function parseSimulideCircuit(text: string): SimulideCircuitDocument {
  const document: SimulideCircuitDocument = {
    settings: { raw: {} },
    components: [],
    nodes: [],
    connectors: [],
    parseIssues: [],
  };

  const seenIds = new Set<string>();
  const lines = text.replace(/^﻿/, "").split(/\r?\n/);
  let foundCircuit = false;
  let openComponent: SimulideCircuitDocument["components"][number] | undefined;

  const warn = (message: string, lineNumber: number, code: SimulideImportIssue["code"] = "parse-warning"): void => {
    document.parseIssues.push({ severity: "warning", code, message, lineNumber });
  };

  // Connectors referenciam o CircId ORIGINAL (não renomeado) como prefixo do pinId -- por isso só
  // a PRIMEIRA ocorrência de um CircId duplicado consegue herdar os fios existentes no arquivo via
  // `splitSimulideEndpoint`. As ocorrências seguintes, renomeadas, ficam sem pinos conectados (não
  // há como saber, só pelo arquivo, qual conector pretendia apontar para qual cópia). Isso ainda é
  // estritamente melhor que abortar o arquivo inteiro: o componente duplicado sobrevive no
  // `.lsproj` para o usuário resolver manualmente, em vez de derrubar os outros N componentes bons.
  const uniqueCircId = (candidate: string, lineNumber: number): string => {
    if (!seenIds.has(candidate)) {
      seenIds.add(candidate);
      return candidate;
    }
    let index = 2;
    let renamed = `${candidate}.imported-${index}`;
    while (seenIds.has(renamed)) renamed = `${candidate}.imported-${++index}`;
    seenIds.add(renamed);
    warn(`CircId duplicado (${candidate}); renomeado para ${renamed}.`, lineNumber, "duplicate-id");
    return renamed;
  };

  for (let lineIndex = 0; lineIndex < lines.length; lineIndex += 1) {
    const rawLine = lines[lineIndex] ?? "";
    const line = rawLine.trim();
    if (!line) continue;
    const lineNumber = lineIndex + 1;

    if (line.startsWith("<circuit")) {
      const attributes = parseSimulideAttributes(line);
      document.settings = {
        version: attributes.version,
        revision: optionalNumber(attributes.rev),
        stepSize: optionalNumber(attributes.stepSize),
        stepsPerSecond: optionalNumber(attributes.stepsPS),
        maxNonLinearSteps: optionalNumber(attributes.NLsteps),
        raw: attributes,
      };
      foundCircuit = true;
      continue;
    }

    if (line.startsWith("</circuit")) break;

    // Subcircuitos são os únicos itens observados que abrem uma tag não auto-fechada e carregam
    // propriedades do componente principal numa linha filha. Preservamos esse bloco no IR para
    // converter, por exemplo, devkitC + Program para o subcircuito ESP32 + firmware do LasecSimul.
    if (line.startsWith("<mainCompProps")) {
      if (!openComponent) {
        warn(`<mainCompProps> fora de <item>; ignorada.`, lineNumber);
        continue;
      }
      openComponent.mainCompProps = { attributes: parseSimulideAttributes(line), lineNumber };
      continue;
    }
    if (line.startsWith("</item")) {
      openComponent = undefined;
      continue;
    }
    if (!line.startsWith("<item")) continue;

    const attributes = parseSimulideAttributes(line);
    const itemType = attributes.itemtype;
    if (!itemType) {
      warn(`<item> sem itemtype; linha ignorada.`, lineNumber);
      continue;
    }

    if (itemType === "Connector") {
      const startPinId = attributes.startpinid;
      const endPinId = attributes.endpinid;
      if (!startPinId || !endPinId) {
        warn(`Connector sem startpinid/endpinid; linha ignorada (fio não pôde ser preservado).`, lineNumber);
        continue;
      }
      const uid = attributes.uid || `connector-line-${lineNumber}`;
      const points = parseSimulidePointList(attributes.pointList);
      if (points === undefined) {
        warn(`pointList inválida no Connector ${uid}; vértices intermediários descartados, endpoints preservados.`, lineNumber);
      }
      const connector: SimulideConnectorRecord = {
        kind: "connector",
        itemType: "Connector",
        uid,
        startPinId,
        endPinId,
        points: points ?? [],
        attributes,
        lineNumber,
      };
      document.connectors.push(connector);
      continue;
    }

    const rawCircId = attributes.CircId;
    if (!rawCircId) {
      warn(`${itemType} sem CircId; linha ignorada (fios que apontavam para ele viram órfãos preservados).`, lineNumber);
      continue;
    }
    const circId = uniqueCircId(rawCircId, lineNumber);

    if (itemType === "Node") {
      document.nodes.push({ kind: "node", itemType: "Node", circId, attributes, lineNumber });
      openComponent = undefined;
    } else {
      const component = { kind: "component" as const, itemType, circId, attributes, lineNumber };
      document.components.push(component);
      openComponent = line.endsWith("/>") ? undefined : component;
    }
  }

  if (!foundCircuit) throw new Error("Arquivo não contém a tag <circuit> do SimulIDE");
  return document;
}
