import * as path from "path";
import type { SimulideImportReport } from "./SimulideTypes";

export function formatSimulideImportReport(report: SimulideImportReport): string {
  const errors = report.issues.filter((issue) => issue.severity === "error");
  const warnings = report.issues.filter((issue) => issue.severity === "warning");
  const lines = [
    "Conversão SimulIDE → LasecSimul (best-effort)",
    report.sourcePath ? `Origem: ${report.sourcePath}` : undefined,
    `Componentes encontrados: ${report.componentCount}`,
    `Emitidos no .lsproj: ${report.convertedComponentCount}/${report.componentCount}`,
    `Convertidos integralmente: ${report.fullyConvertedComponentCount}`,
    `Convertidos parcialmente: ${report.partiallyConvertedComponentCount}`,
    `Placeholders sem equivalente: ${report.placeholderComponentCount}`,
    `Nós originais: ${report.nodeCount}`,
    `Condutores preservados: ${report.convertedConnectorCount}/${report.connectorCount}`,
    `Endpoints órfãos preservados: ${report.orphanEndpointCount}`,
    `Erros fatais: ${errors.length}`,
    `Avisos/pendências: ${warnings.length}`,
  ].filter((line): line is string => Boolean(line));

  if (report.issues.length > 0) {
    lines.push("", "Detalhes:");
    for (const issue of report.issues) {
      const where = [issue.sourceId, issue.sourceType, issue.property, issue.lineNumber ? `linha ${issue.lineNumber}` : undefined]
        .filter(Boolean)
        .join(" / ");
      lines.push(`- [${issue.severity.toUpperCase()}] ${issue.message}${where ? ` (${where})` : ""}`);
    }
  }
  return lines.join("\n");
}

export function shortSimulideImportSummary(report: SimulideImportReport): string {
  const errors = report.issues.filter((issue) => issue.severity === "error").length;
  const warnings = report.issues.filter((issue) => issue.severity === "warning").length;
  const name = report.sourcePath ? path.basename(report.sourcePath) : "circuito SimulIDE";
  return `${name}: ${report.convertedComponentCount}/${report.componentCount} componente(s) preservado(s), ` +
    `${report.convertedConnectorCount}/${report.connectorCount} condutor(es), ` +
    `${report.placeholderComponentCount} placeholder(s), ${errors} erro(s) fatal(is), ${warnings} aviso(s)`;
}
