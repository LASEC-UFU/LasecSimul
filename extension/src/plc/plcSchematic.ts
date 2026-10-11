/*
 * Blocos "PLC IEC 61131-3" do esquemático ligados a um projeto IEC (*.iec.json): pinos vindos da
 * interface do programa e compilação antes de Rodar, como o FPGA faz com o VHDL.
 */

import * as fs from "fs";
import * as vscode from "vscode";
import { logSimulation } from "../diagnostics/simulationLog";
import { rebuildCoreFromSchematicState } from "../core/coreLifecycle";
import { state } from "../state";
import { WebviewComponentModel, endpointId, endpointPinId } from "../ui/webview/model";
import { parseIecProject } from "./iecProject";
import { PlcBuildDiagnostic, PlcExportedIoEntry, plcExportedIoFromProject } from "./plcBuild";
import { buildIecProjectForSimulator, loadedPlcArtifactHashByComponentId } from "./plcRuntimeBridge";

export interface PlcSchematicOptions {
  syncSchematicPanel: () => void;
}

export function plcPinsFromExportedIo(exportedIo: PlcExportedIoEntry[]): WebviewComponentModel["pins"] {
  return exportedIo.map((io, index) => ({ id: io.ioId, x: 0, y: index * 12 }));
}

/** `plc` e pinos de um bloco que passa a usar o projeto IEC `projectPath` (sem compilar). */
export function plcConfigurationForIecProject(
  current: WebviewComponentModel["plc"],
  projectPath: string,
): { plc: NonNullable<WebviewComponentModel["plc"]>; pins: WebviewComponentModel["pins"]; entryConfiguration?: string } {
  const project = parseIecProject(JSON.parse(fs.readFileSync(projectPath, "utf8")));
  const entryConfiguration = typeof project.buildSettings.entryConfiguration === "string"
    ? project.buildSettings.entryConfiguration : current?.entryConfiguration;
  const exportedIo = plcExportedIoFromProject(project);
  // Projeto IEC e artefato avulso são modos exclusivos: o artefato antigo não deve voltar a ser
  // carregado no lugar do programa compilado do projeto.
  const { artifactRef: _artifactRef, expectedArtifactHash: _expectedHash, ...rest } = current ?? {};
  return {
    plc: {
      ...rest,
      iecProjectRef: projectPath,
      ...(entryConfiguration ? { entryConfiguration } : {}),
      exportedIoBindingVersion: 1,
      exportedIo,
    },
    pins: plcPinsFromExportedIo(exportedIo),
    ...(entryConfiguration ? { entryConfiguration } : {}),
  };
}

function sameIo(a: PlcExportedIoEntry[] | undefined, b: PlcExportedIoEntry[]): boolean {
  const key = (io: { ioId: string; name: string; direction: string; iecType: string }) =>
    `${io.ioId}|${io.name}|${io.direction}|${io.iecType.toUpperCase()}`;
  return JSON.stringify((a ?? []).map(key)) === JSON.stringify(b.map(key));
}

/** Troca pinos/exportedIo de um bloco e remove fios de pinos que deixaram de existir. */
function applyPlcInterface(componentId: string, exportedIo: PlcExportedIoEntry[]): void {
  const pins = plcPinsFromExportedIo(exportedIo);
  const valid = new Set(pins.map(pin => pin.id));
  state.schematicState = {
    ...state.schematicState,
    components: state.schematicState.components.map(component => component.id === componentId
      ? { ...component, pins, plc: { ...component.plc, exportedIoBindingVersion: 1, exportedIo } }
      : component),
    topology: {
      ...state.schematicState.topology,
      conductors: state.schematicState.topology.conductors.filter(wire =>
        !((endpointId(wire.from) === componentId && !valid.has(endpointPinId(wire.from))) ||
          (endpointId(wire.to) === componentId && !valid.has(endpointPinId(wire.to))))),
    },
  };
}

function describe(diagnostic: PlcBuildDiagnostic): string {
  const where = diagnostic.pouName
    ? `${diagnostic.pouName}${diagnostic.line ? `, linha ${diagnostic.line}` : diagnostic.variableName ? `, variável ${diagnostic.variableName}` : ""}: `
    : "";
  return `${where}${diagnostic.message}`;
}

/**
 * Antes de Rodar: compila (ou acha no cache) o programa de cada bloco PLC ligado a um projeto IEC,
 * atualiza os pinos se a interface mudou e refaz o Core quando algum bloco não está com o programa
 * atual. Falha de compilação cancela a execução e aponta o POU e a linha.
 */
export async function ensureAllPlcsBuilt(options: PlcSchematicOptions): Promise<boolean> {
  const blocks = state.schematicState.components.filter(component =>
    component.typeId === "plc.instance" && component.plc?.iecProjectRef);
  if (blocks.length === 0) return true;

  let needsCoreRebuild = false;
  let interfaceChanged = false;
  const ok = await vscode.window.withProgress({
    location: vscode.ProgressLocation.Notification,
    title: "LasecSimul: compilando o programa do CLP",
  }, async (progress) => {
    for (const block of blocks) {
      const projectPath = block.plc!.iecProjectRef!;
      progress.report({ message: block.label || projectPath });
      const result = await buildIecProjectForSimulator(projectPath);
      if (!result.ok) {
        const errors = result.diagnostics.filter(item => item.severity === "error");
        logSimulation("error", `O programa do CLP não compilou (${errors.length} erro(s)).`, {
          device: block.label || block.id,
          stage: "clp",
          detail: [...result.diagnostics.map(describe), "", result.log].join("\n").trim(),
        });
        void vscode.window.showErrorMessage(
          `CLP "${block.label || block.id}": ${errors[0] ? describe(errors[0]) : "falha na compilação"}`,
          "Abrir projeto IEC",
        ).then(choice => {
          if (choice) void vscode.commands.executeCommand("vscode.openWith", vscode.Uri.file(projectPath), "lasecsimul.iecProjectEditor");
        });
        return false;
      }
      for (const warning of result.warnings) {
        logSimulation("warning", describe(warning), { device: block.label || block.id, stage: "clp", notify: false });
      }
      const exportedIo = result.module.exportedIo.map(io => ({ ...io, iecType: io.iecType.toUpperCase() }));
      if (!sameIo(block.plc?.exportedIo as PlcExportedIoEntry[] | undefined, exportedIo)) {
        applyPlcInterface(block.id, exportedIo);
        interfaceChanged = true;
        needsCoreRebuild = true;
      }
      if (loadedPlcArtifactHashByComponentId.get(block.id) !== result.module.artifactHash) needsCoreRebuild = true;
    }
    return true;
  });
  if (!ok) return false;
  if (interfaceChanged) options.syncSchematicPanel();
  if (needsCoreRebuild) await rebuildCoreFromSchematicState();
  return true;
}
