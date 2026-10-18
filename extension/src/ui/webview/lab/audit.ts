import { isProcessActivity, type CalculusLab } from "./activity.js";
import type { LabAuditFinding, LabProjectComponent } from "./messages.js";
import { PLANTS } from "./plants.js";

/**
 * Auditoria de referências do laboratório (M6; mesmo papel do `hmiAudit`): componentes do projeto que
 * servem de planta e achados das atividades de processo -- referência para componente removido,
 * ambiguidade entre várias instâncias, planta ausente. Função pura (Host e testes).
 */
/** Componentes do projeto que servem de planta e achados de referência das atividades de processo. */
export function labProjectInfo(lab: CalculusLab, projectComponents: ReadonlyArray<{ id: string; typeId: string; label?: string }>): { components: LabProjectComponent[]; findings: LabAuditFinding[] } {
  const plantTypes = new Set(Object.values(PLANTS).map((plant) => plant.typeId));
  const components = projectComponents
    .filter((component) => plantTypes.has(component.typeId))
    .map((component) => ({ id: component.id, typeId: component.typeId, label: component.label ?? component.id }));
  const findings: LabAuditFinding[] = [];
  for (const activity of lab.activities) {
    if (!isProcessActivity(activity)) continue;
    const plant = PLANTS[activity.kind];
    const candidates = components.filter((component) => component.typeId === plant.typeId);
    if (activity.plantComponentId) {
      if (!candidates.some((component) => component.id === activity.plantComponentId)) {
        findings.push({ activityId: activity.id, severity: "error", code: "missing-plant", candidates,
          message: `"${activity.title}" aponta para "${activity.plantComponentId}", que não existe mais no projeto: religue a outra instância de ${plant.name} ou remova a referência.` });
      }
    } else if (candidates.length === 0) {
      findings.push({ activityId: activity.id, severity: "warning", code: "no-plant", candidates,
        message: `"${activity.title}" precisa de ${plant.name} no projeto (o laboratório pode inseri-lo).` });
    } else if (candidates.length > 1) {
      findings.push({ activityId: activity.id, severity: "warning", code: "ambiguous-plant", candidates,
        message: `"${activity.title}" não escolheu entre ${candidates.length} instâncias de ${plant.name}; usa "${candidates[0]!.label}". Escolha uma no editor.` });
    }
  }
  return { components, findings };
}
