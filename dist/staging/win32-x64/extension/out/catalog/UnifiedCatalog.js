"use strict";
var __createBinding = (this && this.__createBinding) || (Object.create ? (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    var desc = Object.getOwnPropertyDescriptor(m, k);
    if (!desc || ("get" in desc ? !m.__esModule : desc.writable || desc.configurable)) {
      desc = { enumerable: true, get: function() { return m[k]; } };
    }
    Object.defineProperty(o, k2, desc);
}) : (function(o, m, k, k2) {
    if (k2 === undefined) k2 = k;
    o[k2] = m[k];
}));
var __setModuleDefault = (this && this.__setModuleDefault) || (Object.create ? (function(o, v) {
    Object.defineProperty(o, "default", { enumerable: true, value: v });
}) : function(o, v) {
    o["default"] = v;
});
var __importStar = (this && this.__importStar) || (function () {
    var ownKeys = function(o) {
        ownKeys = Object.getOwnPropertyNames || function (o) {
            var ar = [];
            for (var k in o) if (Object.prototype.hasOwnProperty.call(o, k)) ar[ar.length] = k;
            return ar;
        };
        return ownKeys(o);
    };
    return function (mod) {
        if (mod && mod.__esModule) return mod;
        var result = {};
        if (mod != null) for (var k = ownKeys(mod), i = 0; i < k.length; i++) if (k[i] !== "default") __createBinding(result, mod, k[i]);
        __setModuleDefault(result, mod);
        return result;
    };
})();
Object.defineProperty(exports, "__esModule", { value: true });
exports.resolveLocalizedItems = resolveLocalizedItems;
exports.loadUnifiedCatalog = loadUnifiedCatalog;
exports.saveRegisteredSources = saveRegisteredSources;
const fs = __importStar(require("fs"));
const path = __importStar(require("path"));
const catalog_1 = require("../ui/webview/catalog");
const DEFAULT_DEVICE_LIBRARIES = ["../devices/library.json"];
const DEFAULT_CATALOG_FILE = {
    schemaVersion: 1,
    deviceLibraries: [...DEFAULT_DEVICE_LIBRARIES],
    items: catalog_1.defaultComponentCatalog.map((entry) => ({
        typeId: entry.typeId,
        label: entry.label,
        pinCount: entry.pinCount,
        defaultProperties: entry.defaultProperties,
        icon: entry.icon,
        folderPath: entry.folderPath,
        category: entry.category,
        subcategory: entry.subcategory,
        disabled: entry.disabled,
        disabledReason: entry.disabledReason,
    })),
    registeredSources: [],
};
function sanitizeFolderPath(input) {
    if (!Array.isArray(input))
        return [];
    const out = [];
    for (const segment of input) {
        const normalized = String(segment).trim();
        if (normalized)
            out.push(normalized);
    }
    return out;
}
function entryToWebview(item) {
    const folderPath = sanitizeFolderPath(item.folderPath);
    const category = folderPath[0] ?? item.category ?? "Outros";
    const subcategory = folderPath.length > 1 ? folderPath[1] : item.subcategory;
    return {
        typeId: item.typeId,
        label: item.label,
        category,
        subcategory,
        folderPath,
        icon: item.icon,
        iconFilePath: item.iconFilePath,
        symbolSvg: item.symbolSvg,
        package: item.package,
        pinCount: item.pinCount,
        defaultProperties: item.defaultProperties ?? {},
        hidden: item.hidden,
        disabled: item.disabled,
        disabledReason: item.disabledReason,
    };
}
function normalizeUiLanguage(requestedLanguage) {
    if (!requestedLanguage)
        return undefined;
    const normalized = requestedLanguage.toLowerCase();
    if (normalized.startsWith("pt"))
        return "pt-BR";
    if (normalized.startsWith("en"))
        return "en";
    return undefined;
}
/** Resolução por fallback (`lasecsimul.spec` seção 6.3.3, ADR 0009) — mesmo algoritmo do Core
 * (`resolvePropertySchemaForLanguage` em `CoreApplication.cpp`), implementado aqui em TS porque
 * `component-catalog.json` é lido direto pela Extension, sem o Core no meio. Língua pedida → língua-
 * base do arquivo → item sem tradução pra essa língua cai pra língua-base, nunca string vazia. */
function resolveLocalizedItems(items, requestedLanguage, baseLanguage, translations) {
    const normalizedRequested = normalizeUiLanguage(requestedLanguage);
    const normalizedBase = normalizeUiLanguage(baseLanguage) ?? "pt-BR";
    if (!normalizedRequested || normalizedRequested === normalizedBase || !translations)
        return items;
    const translation = translations[normalizedRequested];
    if (!translation?.items)
        return items;
    return items.map((item) => {
        const itemTranslation = translation.items?.[item.typeId];
        if (!itemTranslation)
            return item;
        return {
            ...item,
            label: itemTranslation.label ?? item.label,
            folderPath: itemTranslation.folderPath ?? item.folderPath,
        };
    });
}
function catalogPathCandidates(extensionPath) {
    return [
        path.join(extensionPath, "..", "project", "schema", "component-catalog.json"),
        path.join(extensionPath, "bundled", "project", "schema", "component-catalog.json"),
    ];
}
function catalogPath(extensionPath) {
    const candidates = catalogPathCandidates(extensionPath);
    return candidates.find((candidate) => fs.existsSync(candidate)) ?? path.join(extensionPath, "..", "project", "schema", "component-catalog.json");
}
function sanitizeRegisteredSources(input) {
    if (!Array.isArray(input))
        return [];
    const out = [];
    for (const value of input) {
        if (typeof value !== "object" || value === null)
            continue;
        const source = value;
        if (typeof source.id !== "string" || !source.id.trim())
            continue;
        if (source.kind !== "abi-device" && source.kind !== "mcu-adapter" && source.kind !== "subcircuit-file")
            continue;
        if (typeof source.filePath !== "string" || !source.filePath.trim())
            continue;
        out.push({
            id: source.id,
            kind: source.kind,
            filePath: source.filePath,
            libraryPath: typeof source.libraryPath === "string" && source.libraryPath.trim() ? source.libraryPath : undefined,
            lsconfigPath: typeof source.lsconfigPath === "string" && source.lsconfigPath.trim() ? source.lsconfigPath : undefined,
            folderPath: sanitizeFolderPath(source.folderPath),
            removable: source.removable !== false,
        });
    }
    return out;
}
function readUnifiedCatalogFile(extensionPath) {
    const sourcePath = catalogPath(extensionPath);
    try {
        const raw = fs.readFileSync(sourcePath, "utf8");
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed.items))
            throw new Error("items precisa ser um array");
        return { sourcePath, file: parsed };
    }
    catch {
        return { sourcePath, file: DEFAULT_CATALOG_FILE };
    }
}
function loadUnifiedCatalog(extensionPath, requestedLanguage) {
    const { sourcePath, file } = readUnifiedCatalogFile(extensionPath);
    const baseLanguage = typeof file.language === "string" && file.language.trim() ? file.language : "pt-BR";
    const resolvedItems = resolveLocalizedItems(file.items, requestedLanguage, baseLanguage, file.translations);
    const catalog = resolvedItems.map(entryToWebview);
    const deviceLibraries = Array.isArray(file.deviceLibraries)
        ? file.deviceLibraries.filter((p) => typeof p === "string" && p.trim().length > 0)
        : DEFAULT_DEVICE_LIBRARIES;
    const registeredSources = sanitizeRegisteredSources(file.registeredSources);
    return { catalog, deviceLibraries, registeredSources, sourcePath };
}
function saveRegisteredSources(extensionPath, registeredSources) {
    const { sourcePath, file } = readUnifiedCatalogFile(extensionPath);
    const output = {
        ...file,
        schemaVersion: typeof file.schemaVersion === "number" ? file.schemaVersion : 1,
        deviceLibraries: Array.isArray(file.deviceLibraries) ? file.deviceLibraries : [...DEFAULT_DEVICE_LIBRARIES],
        items: Array.isArray(file.items) ? file.items : DEFAULT_CATALOG_FILE.items,
        registeredSources,
    };
    fs.writeFileSync(sourcePath, `${JSON.stringify(output, null, 2)}\n`, "utf8");
    return sourcePath;
}
//# sourceMappingURL=UnifiedCatalog.js.map