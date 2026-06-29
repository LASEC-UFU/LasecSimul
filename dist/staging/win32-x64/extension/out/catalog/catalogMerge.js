"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.nextIndexedLabel = nextIndexedLabel;
exports.hasShowOnSymbolProperty = hasShowOnSymbolProperty;
exports.toWebviewPropertySchema = toWebviewPropertySchema;
exports.mergePropertySchemas = mergePropertySchemas;
function escapeRegExp(value) {
    return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
/** Nome com índice por tipo (ex: "Resistor-1", "Resistor-2") — contador por `typeId`, nunca
 * persistido separado: sempre recalculado a partir de quem já existe (mesmo princípio do SimulIDE
 * real, `Circuit::m_seqNumber`, exceto que aqui é por tipo, não por sessão inteira — ver plano
 * aprovado/`.spec`). Duplicado em `ui/webview/main.ts::nextIndexedLabel` (mesmo algoritmo, dois
 * pontos de criação de componente — Extension quando a Webview pede via `requestAddComponent`,
 * Webview quando o host empurra um `requestAddComponent` vindo da paleta/TreeView). */
function nextIndexedLabel(typeId, baseLabel, existingComponents) {
    const pattern = new RegExp(`^${escapeRegExp(baseLabel)}-(\\d+)$`);
    let maxIndex = 0;
    for (const component of existingComponents) {
        if (component.typeId !== typeId)
            continue;
        const match = pattern.exec(component.label);
        if (match)
            maxIndex = Math.max(maxIndex, Number(match[1]));
    }
    return `${baseLabel}-${maxIndex + 1}`;
}
/** `true` se o typeId tiver alguma propriedade marcada `showOnSymbol` no schema do Core — usado pra
 * decidir o default de `WebviewComponentModel.showValue` na criação (sem isso, todo componente
 * nasceria sem valor visível, mesmo os que têm um valor óbvio pra mostrar, ex: "1 kΩ"). */
function hasShowOnSymbolProperty(descriptor) {
    return Boolean(descriptor?.propertySchema?.some((schema) => schema.showOnSymbol));
}
function toWebviewPropertySchema(dto) {
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
    };
}
/** Combina o catálogo unificado (sem schema rico) com o mapa typeId→schemas já resolvido pelo Core
 * (`getPropertySchemas`). Função pura — quem chama (`extension.ts::attachPropertySchemas`) cuida de
 * obter `schemasByTypeId` via IPC; aqui só o merge é testado, sem precisar de Core real. */
function mergePropertySchemas(catalog, schemasByTypeId) {
    return catalog.map((entry) => {
        const schemas = schemasByTypeId[entry.typeId];
        if (!schemas || schemas.length === 0)
            return entry;
        return { ...entry, propertySchema: schemas.map(toWebviewPropertySchema) };
    });
}
//# sourceMappingURL=catalogMerge.js.map