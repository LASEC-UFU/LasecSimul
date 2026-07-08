import { InteractionKindDto, McuSerialPortDto, PropertySchemaDto, ReadoutFormatDto } from "../ipc/types";
import { PropertySchemaEntry, WebviewComponentCatalogEntry, WebviewComponentModel } from "../ui/webview/model";
import { sanitizeMcuSerialPortsByTypeId } from "./catalogMetadata";

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** Nome com índice por tipo (ex: "Resistor-1", "Resistor-2") — contador por `typeId`, nunca
 * persistido separado: sempre recalculado a partir de quem já existe (mesmo princípio do SimulIDE
 * real, `Circuit::m_seqNumber`, exceto que aqui é por tipo, não por sessão inteira — ver plano
 * aprovado/`.spec`). Duplicado em `ui/webview/main.ts::nextIndexedLabel` (mesmo algoritmo, dois
 * pontos de criação de componente — Extension quando a Webview pede via `requestAddComponent`,
 * Webview quando o host empurra um `requestAddComponent` vindo da paleta/TreeView). */
export function nextIndexedLabel(
  typeId: string,
  baseLabel: string,
  existingComponents: WebviewComponentModel[]
): string {
  const pattern = new RegExp(`^${escapeRegExp(baseLabel)}-(\\d+)$`);
  let maxIndex = 0;
  for (const component of existingComponents) {
    if (component.typeId !== typeId) continue;
    const match = pattern.exec(component.label);
    if (match) maxIndex = Math.max(maxIndex, Number(match[1]));
  }
  return `${baseLabel}-${maxIndex + 1}`;
}

/** `true` se o typeId tiver alguma propriedade marcada `showOnSymbol` no schema do Core — usado pra
 * decidir o default de `WebviewComponentModel.showValue` na criação (sem isso, todo componente
 * nasceria sem valor visível, mesmo os que têm um valor óbvio pra mostrar, ex: "1 kΩ"). */
export function hasShowOnSymbolProperty(descriptor: WebviewComponentCatalogEntry | undefined): boolean {
  return Boolean(descriptor?.propertySchema?.some((schema) => schema.showOnSymbol));
}

export function toWebviewPropertySchema(dto: PropertySchemaDto): PropertySchemaEntry {
  return {
    id: dto.id,
    label: dto.label,
    group: dto.group,
    unit: dto.unit,
    editor: dto.editor,
    default: typeof dto.default === "object" ? 0 : dto.default,
    min: dto.min,
    max: dto.max,
    step: dto.step,
    options: dto.options,
    hidden: dto.hidden,
    readOnly: dto.readOnly,
    showOnSymbol: dto.showOnSymbol,
    affectsPinCount: dto.affectsPinCount,
  };
}

/** Combina o catálogo unificado (sem schema rico) com o mapa typeId→schemas já resolvido pelo Core
 * (`getPropertySchemas`). Função pura — quem chama (`extension.ts::attachPropertySchemas`) cuida de
 * obter `schemasByTypeId` via IPC; aqui só o merge é testado, sem precisar de Core real.
 * `readoutFormatByTypeId`/`interactionKindByTypeId` (ABI v2, .spec/lasecsimul-native-devices.spec)
 * são opcionais -- ausentes (chamador antigo, resposta do Core sem os campos novos) preserva
 * exatamente o comportamento de antes desta rodada, sem quebrar nada.
 * `pinIdsByTypeId` só PREENCHE quando `entry.pinIds` ainda está ausente (built-in sem `package`,
 * ex: passive.resistor/other.ground/connectors.tunnel/sources.rail/sources.fixed_volt/
 * sources.battery, ver EX-4.2) -- nunca sobrescreve o `pinIds` que devices/mcu-adapter/subcircuit-
 * file já tinham derivado direto do próprio manifesto (mesma fonte, mas resolvida antes, sem
 * depender de round-trip com o Core). */
export function mergePropertySchemas(
  catalog: WebviewComponentCatalogEntry[],
  schemasByTypeId: Record<string, PropertySchemaDto[]>,
  readoutFormatByTypeId: Record<string, ReadoutFormatDto> = {},
  interactionKindByTypeId: Record<string, InteractionKindDto> = {},
  pinIdsByTypeId: Record<string, string[]> = {},
  serialPortsByTypeId: Record<string, McuSerialPortDto[]> = {}
): WebviewComponentCatalogEntry[] {
  const safeSerialPortsByTypeId = sanitizeMcuSerialPortsByTypeId(serialPortsByTypeId);
  return catalog.map((entry) => {
    const schemas = schemasByTypeId[entry.typeId];
    const readoutFormat = readoutFormatByTypeId[entry.typeId];
    const interactionKind = interactionKindByTypeId[entry.typeId];
    const pinIds = entry.pinIds === undefined ? pinIdsByTypeId[entry.typeId] : undefined;
    const serialPorts = safeSerialPortsByTypeId[entry.typeId];
    if ((!schemas || schemas.length === 0) && !readoutFormat && !interactionKind && !pinIds && !serialPorts) return entry;
    return {
      ...entry,
      ...(schemas && schemas.length > 0 ? { propertySchema: schemas.map(toWebviewPropertySchema) } : {}),
      ...(readoutFormat ? { readoutFormat } : {}),
      ...(interactionKind ? { interactionKind } : {}),
      ...(pinIds && pinIds.length > 0 ? { pinIds } : {}),
      ...(serialPorts && serialPorts.length > 0 ? { serialPorts } : {}),
    };
  });
}
