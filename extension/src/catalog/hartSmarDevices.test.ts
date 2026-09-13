import * as path from "path";
import { assert, createTestRunner } from "../ipc/testSupport/MockCoreServer";
import { loadUnifiedCatalog } from "./UnifiedCatalog";
import { buildPaletteTree, PaletteTreeNode } from "../ui/webview/paletteTree";

const smarTypeIds = ["protocol.hart.device.smar_ld301", "protocol.hart.device.smar_tt301", "protocol.hart.device.smar_fy301"];

function findFolder(nodes: PaletteTreeNode[], label: string): Extract<PaletteTreeNode, { kind: "folder" }> | undefined {
  return nodes.find((node): node is Extract<PaletteTreeNode, { kind: "folder" }> => node.kind === "folder" && node.label === label);
}

(async () => {
  const { test, finish } = createTestRunner("HART SMAR devices in the real palette pipeline");
  const extensionRoot = path.resolve(__dirname, "../..");
  const { catalog } = loadUnifiedCatalog(extensionRoot, "pt-BR");

  await test("LD301, TT301 and FY301 are enabled entries in the shared HART folder", () => {
    for (const typeId of smarTypeIds) {
      const matches = catalog.filter((entry) => entry.typeId === typeId);
      assert(matches.length === 1, `esperava exatamente uma entrada para ${typeId}`);
      const entry = matches[0];
      if (!entry) throw new Error(`entrada ausente: ${typeId}`);
      assert(entry.workspaceSection === "process", `${typeId} deveria pertencer a Processo`);
      assert(JSON.stringify(entry.folderPath) === JSON.stringify(["Protocolos Industriais", "HART"]), `${typeId} deveria reutilizar a pasta HART`);
      assert(!entry.disabled, `${typeId} não deveria estar desabilitado`);
    }
  });

  await test("the Process palette has one HART folder containing all SMAR devices", () => {
    const industrial = findFolder(buildPaletteTree(catalog, "", "process"), "Protocolos Industriais");
    assert(Boolean(industrial), "pasta Protocolos Industriais ausente");
    if (!industrial) throw new Error("pasta Protocolos Industriais ausente");
    const hart = findFolder(industrial.children, "HART");
    assert(Boolean(hart), "pasta HART ausente");
    if (!hart) throw new Error("pasta HART ausente");
    const leafIds = hart.children.filter((node) => node.kind === "component").map((node) => node.typeId);
    for (const typeId of smarTypeIds) assert(leafIds.includes(typeId), `${typeId} ausente da paleta HART`);
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();
