function normalizeSearchText(value) {
    return value
        .normalize("NFD")
        .replace(/\p{Diacritic}/gu, "")
        .toLowerCase()
        .trim();
}
export function resolvePaletteFolderPath(entry) {
    const normalized = Array.isArray(entry.folderPath)
        ? entry.folderPath.map((segment) => segment.trim()).filter((segment) => segment.length > 0)
        : [];
    if (normalized.length > 0)
        return normalized;
    return [entry.category, ...(entry.subcategory ? [entry.subcategory] : [])].filter((segment) => segment.length > 0);
}
function entryMatchesQuery(entry, query) {
    if (!query)
        return true;
    const haystack = normalizeSearchText([
        entry.label,
        entry.typeId,
        entry.category,
        entry.subcategory,
        ...resolvePaletteFolderPath(entry),
    ]
        .filter(Boolean)
        .join(" "));
    return query
        .split(/\s+/)
        .filter((token) => token.length > 0)
        .every((token) => haystack.includes(token));
}
function createFolderNode(pathSegments) {
    return {
        kind: "folder",
        key: `folder:${pathSegments.join("/")}`,
        label: pathSegments[pathSegments.length - 1] ?? "",
        pathSegments,
        children: [],
        folderIndex: new Map(),
    };
}
function stripMutableNodes(nodes) {
    return nodes.map((node) => {
        if (node.kind === "component")
            return node;
        return {
            kind: "folder",
            key: node.key,
            label: node.label,
            pathSegments: node.pathSegments,
            children: stripMutableNodes(node.children),
        };
    });
}
export function buildPaletteTree(entries, rawQuery) {
    const roots = [];
    const rootFolders = new Map();
    const query = normalizeSearchText(rawQuery);
    for (const entry of entries) {
        if (entry.hidden || !entryMatchesQuery(entry, query))
            continue;
        const pathSegments = resolvePaletteFolderPath(entry);
        let targetChildren = roots;
        let targetFolderIndex = rootFolders;
        const currentPath = [];
        for (const segment of pathSegments) {
            currentPath.push(segment);
            let folderNode = targetFolderIndex.get(segment);
            if (!folderNode) {
                folderNode = createFolderNode([...currentPath]);
                targetFolderIndex.set(segment, folderNode);
                targetChildren.push(folderNode);
            }
            targetChildren = folderNode.children;
            targetFolderIndex = folderNode.folderIndex;
        }
        targetChildren.push({
            kind: "component",
            key: `component:${entry.typeId}`,
            typeId: entry.typeId,
            label: entry.label,
            category: entry.category,
            subcategory: entry.subcategory,
            pinCount: entry.pinCount,
            disabled: Boolean(entry.disabled),
            disabledReason: entry.disabledReason,
            pathSegments,
            iconLightUri: entry.iconLightUri,
            iconDarkUri: entry.iconDarkUri,
            isRegistered: Boolean(entry.isRegistered),
            registeredSourceId: entry.registeredSourceId,
            registeredSourceRemovable: entry.registeredSourceRemovable !== false,
        });
    }
    return stripMutableNodes(roots);
}
//# sourceMappingURL=paletteTree.js.map