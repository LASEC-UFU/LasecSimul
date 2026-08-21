import * as fs from "fs/promises";
import * as path from "path";
import * as vscode from "vscode";
import { parseIecProject } from "./iecProject";
import { starterIecProject } from "./plcProjectTemplate";

export async function newIecProjectCommand(): Promise<void> {
  const selected = await vscode.window.showSaveDialog({
    filters: { "Projeto IEC 61131-3": ["iec.json"] },
    saveLabel: "Criar projeto PLC",
    title: "Novo projeto IEC 61131-3",
  });
  if (!selected) return;
  const projectId = path.basename(selected.fsPath).replace(/\.iec\.json$/i, "") || "plc-project";
  const project = starterIecProject(projectId);
  parseIecProject(project);
  await fs.writeFile(selected.fsPath, `${JSON.stringify(project, null, 2)}\n`, "utf8");
  await vscode.commands.executeCommand("vscode.openWith", selected, "lasecsimul.iecProjectEditor");
}
