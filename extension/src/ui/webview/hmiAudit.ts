import type { HmiApplication, HmiAuditExceptionEvent, HmiAuditRuleProfile, HmiPage, WebviewComponentCatalogEntry, WebviewComponentModel } from "./model.js";
import { hasVisualOnlyAlarmSemantics, isGraphicalTypeId, reviewGraphicalBindingConfiguration, reviewGraphicalBindingUnit } from "./graphicsBinding.js";
import { isGraphicalActionTypeId } from "./graphicsAction.js";

export interface HmiAuditFinding {
  ruleId: string;
  pageId: string;
  pageName: string;
  message: string;
  elementId?: string;
  componentId?: string;
  componentLabel?: string;
  rationale?: string;
  recommendation?: string;
  evidence?: Array<{ kind: "project-path"; path: string }>;
  normativeMapping?: null;
  autoFixAvailable?: false;
  status?: HmiAuditStatus;
  exception?: HmiAuditExceptionEvent;
}

export type HmiAuditStatus = "open" | "excepted" | "expired" | "revoked";
export function hmiAuditFindingKey(finding: Pick<HmiAuditFinding, "ruleId" | "pageId" | "elementId">): string {
  return JSON.stringify([finding.ruleId, finding.pageId, finding.elementId ?? ""]);
}

/** Resolve the latest append-only event per stable finding key once, then reuse it across the report. */
export function resolveHmiAuditExceptions(app: Pick<HmiApplication, "auditExceptions">, now: number): ReadonlyMap<string, { status: HmiAuditStatus; exception: HmiAuditExceptionEvent }> {
  const latest = new Map<string, HmiAuditExceptionEvent>();
  for (const event of app.auditExceptions ?? []) latest.set(event.findingKey, event);
  const resolved = new Map<string, { status: HmiAuditStatus; exception: HmiAuditExceptionEvent }>();
  for (const [key, exception] of latest) {
    const status: HmiAuditStatus = exception.action === "revoked"
      ? "revoked"
      : exception.expiresAt && Date.parse(exception.expiresAt) <= now ? "expired" : "excepted";
    resolved.set(key, { status, exception });
  }
  return resolved;
}

export type HmiAuditSeverity = "issue" | "warning";

/** Stable IDs shared by all projects; profiles configure rules by ID, never by device type. */
export const HMI_AUDIT_RULE_IDS = [
  "HMI.PAGE.START_MISSING", "HMI.PAGE.ID_DUPLICATE", "HMI.PAGE.DIMENSIONS_INVALID", "HMI.PAGE.UNREACHABLE",
  "HMI.ELEMENT.ID_DUPLICATE", "HMI.ELEMENT.DIMENSIONS_INVALID", "HMI.ELEMENT.OUT_OF_BOUNDS", "HMI.COMPONENT.REFERENCE_MISSING",
  "HMI.NAVIGATION.ID_DUPLICATE", "HMI.NAVIGATION.DIMENSIONS_INVALID", "HMI.NAVIGATION.OUT_OF_BOUNDS", "HMI.NAVIGATION.TARGET_MISSING",
  "HMI.BINDING.SOURCE_MISSING", "HMI.BINDING.READOUT_UNAVAILABLE", "HMI.BINDING.CHANNEL_INVALID",
  "HMI.BINDING.INVALID_NUMBER", "HMI.BINDING.INVALID_DECIMALS", "HMI.BINDING.DEGENERATE_RANGE", "HMI.BINDING.LIMIT_ORDER",
  "HMI.BINDING.UNIT_MISSING", "HMI.BINDING.UNIT_MISMATCH", "HMI.BINDING.UNIT_CONVERSION_UNVERIFIED",
  "HMI.ACTION.CONFIGURATION_MISSING", "HMI.ACTION.TARGET_MISSING", "HMI.ACTION.PROPERTY_UNAVAILABLE", "HMI.ALARM.VISUAL_ONLY",
] as const;

export function defaultHmiAuditRuleProfile(locale: "pt-BR" | "en" = "pt-BR"): HmiAuditRuleProfile {
  return { schemaVersion: 1, name: locale === "pt-BR" ? "Padrão" : "Default", version: 1, disabledRuleIds: [] };
}

export function hmiAuditRecommendation(ruleId: string, locale: "pt-BR" | "en"): string {
  const pt = locale === "pt-BR";
  if (ruleId.startsWith("HMI.BINDING.UNIT_")) return pt
    ? "Confira as unidades de origem e exibição com a definição de engenharia; documente escala e offset quando houver conversão."
    : "Check source and display units against the engineering definition; document scale and offset when conversion is used.";
  if (ruleId.startsWith("HMI.BINDING.")) return pt
    ? "Revise a fonte, canal e parâmetros de faixa/formatação do binding usando o contrato de leitura do componente."
    : "Review the binding source, channel, and range/format settings against the component readout contract.";
  if (ruleId.startsWith("HMI.ACTION.")) return pt
    ? "Associe somente uma propriedade gravável existente e valide separadamente permissões, intertravamentos e feedback de execução."
    : "Bind only to an existing writable property, and separately validate authorization, interlocks, and execution feedback.";
  if (ruleId.startsWith("HMI.NAVIGATION.")) return pt
    ? "Ajuste o atalho e confirme que o destino existe e é alcançável sem mover os demais elementos da tela."
    : "Adjust the shortcut and confirm its destination exists and is reachable without moving other screen elements.";
  if (ruleId === "HMI.PAGE.UNREACHABLE") return pt
    ? "Adicione uma rota apropriada a partir da página inicial ou documente por que esta página é acessada por outro meio."
    : "Add an appropriate route from the start page or document why this page is accessed another way.";
  if (ruleId.startsWith("HMI.PAGE.")) return pt
    ? "Corrija a identidade, dimensões ou configuração da página, preservando as posições dos elementos existentes."
    : "Correct the page identity, dimensions, or configuration while preserving existing element positions.";
  if (ruleId === "HMI.ELEMENT.OUT_OF_BOUNDS") return pt
    ? "Revise a geometria local do elemento ou o viewport desta página; não reposicione o símbolo correspondente no esquemático."
    : "Review the element's local geometry or this page's viewport; do not move its schematic symbol.";
  if (ruleId === "HMI.ELEMENT.DIMENSIONS_INVALID") return pt
    ? "Defina coordenadas finitas e largura/altura positivas para este elemento HMI."
    : "Set finite coordinates and positive width/height for this HMI element.";
  if (ruleId === "HMI.ELEMENT.ID_DUPLICATE") return pt
    ? "Atribua IDs únicos aos elementos desta página para manter seleção, exceções e rastreabilidade sem ambiguidade."
    : "Assign unique IDs to elements on this page so selection, exceptions, and traceability remain unambiguous.";
  if (ruleId === "HMI.NAVIGATION.DIMENSIONS_INVALID") return pt
    ? "Defina coordenadas finitas e largura/altura positivas para este atalho."
    : "Set finite coordinates and positive width/height for this shortcut.";
  if (ruleId === "HMI.NAVIGATION.ID_DUPLICATE") return pt
    ? "Atribua IDs únicos aos atalhos desta página para manter a edição e a rastreabilidade sem ambiguidade."
    : "Assign unique IDs to shortcuts on this page so editing and traceability remain unambiguous.";
  if (ruleId === "HMI.COMPONENT.REFERENCE_MISSING") return pt
    ? "Religue a projeção a um componente existente ou mantenha-a como elemento gráfico independente, se essa for a intenção."
    : "Relink the projection to an existing component or keep it as an independent graphic if that is intended.";
  if (ruleId === "HMI.ALARM.VISUAL_ONLY") return pt
    ? "Trate este objeto como indicação visual; use um serviço de alarmes separado se a aplicação exigir gestão de alarmes."
    : "Treat this object as a visual indication; use a separate alarm service if the application requires alarm management.";
  return pt ? "Revise o achado com base na filosofia HMI e nos requisitos do projeto." : "Review this finding against the project HMI philosophy and requirements.";
}

export interface HmiAuditFilter {
  severity?: HmiAuditSeverity;
  pageId?: string;
  ruleId?: string;
  componentId?: string;
  status?: HmiAuditStatus;
}

export interface HmiAuditResult {
  issues: HmiAuditFinding[];
  warnings: HmiAuditFinding[];
  profile?: HmiAuditRuleProfile;
}

export interface HmiAuditReport {
  format: "lasecsimul-hmi-audit";
  schemaVersion: 2;
  rulesetVersion: 1;
  generatedAt: string;
  locale: "pt-BR" | "en";
  privacyMode: "redacted" | "full";
  counts: { issues: number; warnings: number };
  profile: HmiAuditRuleProfile;
  evidence?: { hmiInputsSha256: string; catalogSha256: string };
  findings: Array<HmiAuditFinding & {
    severity: HmiAuditSeverity;
    engineeringSeverity: "error" | "warning";
    ruleVersion: 1;
    confidence: "high";
    rationale: string;
    recommendation: string;
    evidence: Array<{ kind: "project-path"; path: string }>;
    normativeMapping: null;
    autoFixAvailable: false;
  }>;
}

/** Apply report-view filters without changing the source result or its stable ordering. */
export function filterHmiAuditFindings<T extends HmiAuditFinding & { severity: HmiAuditSeverity }>(
  findings: readonly T[],
  filter: HmiAuditFilter,
): T[] {
  return findings.filter((finding) =>
    (!filter.severity || finding.severity === filter.severity)
    && (!filter.pageId || finding.pageId === filter.pageId)
    && (!filter.ruleId || finding.ruleId === filter.ruleId)
    && (!filter.componentId || finding.componentId === filter.componentId)
    && (!filter.status || finding.status === filter.status));
}

/** Build an exportable report from findings only; never serialize the project or its properties. */
export function createHmiAuditReport(
  result: HmiAuditResult,
  locale: "pt-BR" | "en",
  generatedAt: string,
  profile: HmiAuditRuleProfile = result.profile ?? defaultHmiAuditRuleProfile(locale),
  evidence?: HmiAuditReport["evidence"],
  privacyMode: HmiAuditReport["privacyMode"] = "redacted",
): HmiAuditReport {
  const projectText = (finding: HmiAuditFinding) => privacyMode === "full" ? {
    pageName: finding.pageName,
    ...(finding.componentLabel ? { componentLabel: finding.componentLabel } : {}),
    message: finding.message,
    rationale: finding.rationale ?? finding.message,
    ...(finding.exception ? { exception: finding.exception } : {}),
  } : {
    pageName: finding.pageId,
    componentLabel: undefined,
    message: finding.ruleId,
    rationale: finding.ruleId,
  };
  const findings = [
    ...result.issues.map((finding) => ({ ...finding, ...projectText(finding), recommendation: finding.recommendation ?? hmiAuditRecommendation(finding.ruleId, locale), evidence: finding.evidence ?? [], normativeMapping: null, autoFixAvailable: false as const, ...(privacyMode === "redacted" ? { exception: undefined } : {}), severity: "issue" as const, engineeringSeverity: "error" as const, ruleVersion: 1 as const, confidence: "high" as const })),
    ...result.warnings.map((finding) => ({ ...finding, ...projectText(finding), recommendation: finding.recommendation ?? hmiAuditRecommendation(finding.ruleId, locale), evidence: finding.evidence ?? [], normativeMapping: null, autoFixAvailable: false as const, ...(privacyMode === "redacted" ? { exception: undefined } : {}), severity: "warning" as const, engineeringSeverity: "warning" as const, ruleVersion: 1 as const, confidence: "high" as const })),
  ];
  return {
    format: "lasecsimul-hmi-audit",
    schemaVersion: 2,
    rulesetVersion: 1,
    generatedAt,
    locale,
    privacyMode,
    counts: { issues: result.issues.length, warnings: result.warnings.length },
    profile: { ...profile, disabledRuleIds: [...profile.disabledRuleIds] },
    ...(evidence ? { evidence } : {}),
    findings,
  };
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, entry]) => entry !== undefined)
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0);
  return `{${entries.map(([key, entry]) => `${JSON.stringify(key)}:${canonicalJson(entry)}`).join(",")}}`;
}

async function sha256(value: unknown): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson(value)));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

/** Fingerprint only the inputs provided to the auditor; raw project/catalog data never enters the report. */
export async function fingerprintHmiAuditInputs(
  app: HmiApplication,
  components: readonly WebviewComponentModel[],
  catalog: readonly WebviewComponentCatalogEntry[],
): Promise<NonNullable<HmiAuditReport["evidence"]>> {
  const [hmiInputsSha256, catalogSha256] = await Promise.all([
    sha256({ app, components }),
    sha256(catalog),
  ]);
  return { hmiInputsSha256, catalogSha256 };
}

/** Accessible, dependency-free HTML presentation. Dynamic project text is always escaped. */
export function createHmiAuditHtml(report: HmiAuditReport): string {
  const escape = (value: string): string => value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#39;");
  const pt = report.locale === "pt-BR";
  const title = pt ? "Relatório de verificação HMI" : "HMI verification report";
  const issueLabel = pt ? "Problema" : "Issue";
  const warningLabel = pt ? "Aviso" : "Warning";
  const rows = report.findings.map((finding) => `<tr><td>${finding.severity === "issue" ? issueLabel : warningLabel}</td><td>${escape(finding.status ?? "open")}</td><td>${escape(finding.ruleId)}</td><td>${escape(finding.pageName)} (${escape(finding.pageId)})</td><td>${escape(finding.componentLabel ?? finding.componentId ?? "")}${finding.componentLabel && finding.componentId ? ` (${escape(finding.componentId)})` : ""}</td><td>${escape(finding.elementId ?? "")}</td><td>${escape(finding.message)}</td><td>${escape(finding.rationale ?? finding.message)}</td><td>${escape(finding.recommendation ?? "")}</td><td>${(finding.evidence ?? []).map((item) => escape(item.path)).join("<br>")}</td><td>${escape(finding.exception ? `${finding.exception.id} · ${finding.exception.action} · ${finding.exception.reviewer}: ${finding.exception.reason} (${finding.exception.recordedAt}${finding.exception.expiresAt ? `; expires ${finding.exception.expiresAt}` : ""})` : "")}</td></tr>`).join("\n");
  const emptyRow = pt ? "<tr><td colspan=\"11\">Nenhum achado nas regras habilitadas.</td></tr>" : "<tr><td colspan=\"11\">No findings for the enabled rules.</td></tr>";
  const disclaimer = pt
    ? "Este relatório apresenta somente o resultado das regras habilitadas. Não constitui declaração de conformidade normativa."
    : "This report presents findings from enabled rules only. It does not declare normative compliance.";
  return `<!doctype html>
<html lang="${pt ? "pt-BR" : "en"}">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${title}</title>
<style>body{font:16px/1.5 system-ui,sans-serif;max-width:1200px;margin:2rem auto;padding:0 1rem;color:#17202a}h1{font-size:1.7rem}table{border-collapse:collapse;width:100%;margin:1rem 0}caption{text-align:left;font-weight:600;margin-bottom:.5rem}th,td{border:1px solid #667085;padding:.55rem;text-align:left;vertical-align:top}th{background:#eef2f6}tr:nth-child(even){background:#f8fafc}.issue{color:#9b1c1c}.warning{color:#7c4a03}.meta{display:flex;gap:1.5rem;flex-wrap:wrap}code{overflow-wrap:anywhere}.disclaimer{border-left:4px solid #64748b;padding:.5rem .75rem;background:#f1f5f9}</style>
</head>
<body>
<main>
<h1>${title}</h1>
<dl class="meta"><div><dt>${pt ? "Gerado em" : "Generated"}</dt><dd><time datetime="${escape(report.generatedAt)}">${escape(report.generatedAt)}</time></dd></div><div><dt>${pt ? "Problemas" : "Issues"}</dt><dd>${report.counts.issues}</dd></div><div><dt>${pt ? "Avisos" : "Warnings"}</dt><dd>${report.counts.warnings}</dd></div><div><dt>${pt ? "Versão do formato" : "Format version"}</dt><dd>${report.schemaVersion}</dd></div><div><dt>${pt ? "Versão das regras" : "Ruleset version"}</dt><dd>${report.rulesetVersion}</dd></div></dl>
<p>${pt ? "Perfil" : "Profile"}: ${escape(report.profile.name)} v${report.profile.version}. ${pt ? "Regras desativadas" : "Disabled rules"}: ${report.profile.disabledRuleIds.length ? report.profile.disabledRuleIds.map(escape).join(", ") : (pt ? "nenhuma" : "none")}.</p>
<p>${pt ? "Privacidade da exportação" : "Export privacy"}: ${report.privacyMode === "full" ? (pt ? "nomes e textos do projeto incluídos por opt-in" : "project names and text included by opt-in") : (pt ? "textos do projeto redigidos" : "project text redacted")}.</p>
${report.evidence ? `<p>${pt ? "SHA-256 das entradas HMI/componentes" : "HMI/component inputs SHA-256"}: <code>${escape(report.evidence.hmiInputsSha256)}</code><br>${pt ? "SHA-256 do catálogo" : "Catalog SHA-256"}: <code>${escape(report.evidence.catalogSha256)}</code></p>` : ""}
<p class="disclaimer">${disclaimer}</p>
<table><caption>${pt ? "Achados da verificação" : "Verification findings"}</caption><thead><tr><th scope="col">${pt ? "Tipo" : "Type"}</th><th scope="col">${pt ? "Status" : "Status"}</th><th scope="col">Rule ID</th><th scope="col">${pt ? "Página" : "Page"}</th><th scope="col">${pt ? "Componente" : "Component"}</th><th scope="col">${pt ? "Elemento HMI" : "HMI element"}</th><th scope="col">${pt ? "Descrição" : "Description"}</th><th scope="col">${pt ? "Justificativa técnica" : "Rationale"}</th><th scope="col">${pt ? "Próximo passo sugerido" : "Recommendation"}</th><th scope="col">${pt ? "Evidência no projeto" : "Project evidence"}</th><th scope="col">${pt ? "Decisão de revisão" : "Review decision"}</th></tr></thead><tbody>${rows || emptyRow}</tbody></table>
</main>
</body>
</html>`;
}

/** Deterministic, read-only HMI design review. It has no DOM, Core, network, or project mutation. */
export function auditHmiApplication(
  app: HmiApplication,
  components: readonly WebviewComponentModel[],
  catalog: readonly WebviewComponentCatalogEntry[],
  writablePropertiesByComponentId: Readonly<Record<string, readonly string[]>>,
  locale: "pt-BR" | "en",
  now: number,
): HmiAuditResult {
  const issues: HmiAuditFinding[] = [];
  const warnings: HmiAuditFinding[] = [];
  const catalogByTypeId = new Map(catalog.map((entry) => [entry.typeId, entry]));
  const componentsById = new Map(components.map((component) => [component.id, component]));
  const add = (target: HmiAuditFinding[], ruleId: string, page: HmiPage, message: string, elementId?: string, evidencePath?: string): void => {
    const hmiElement = elementId ? page.elements.find((element) => element.id === elementId) : undefined;
    const componentId = hmiElement?.componentId ?? hmiElement?.id;
    const component = hmiElement?.componentId ? componentsById.get(hmiElement.componentId) : undefined;
    const componentLabel = component?.label ?? hmiElement?.label ?? hmiElement?.typeId;
    target.push({
      ruleId,
      pageId: page.id,
      pageName: page.name,
      message,
      ...(elementId ? { elementId } : {}),
      ...(componentId ? { componentId } : {}),
      ...(componentLabel ? { componentLabel } : {}),
      rationale: message,
      recommendation: hmiAuditRecommendation(ruleId, locale),
      evidence: [{
        kind: "project-path",
        path: evidencePath ?? `hmiApplication.pages[id=${JSON.stringify(page.id)}]${elementId ? `.elements[id=${JSON.stringify(elementId)}]` : ""}`,
      }],
      normativeMapping: null,
      autoFixAvailable: false,
    });
  };
  const pageIds = new Set(app.pages.map((page) => page.id));
  const pageById = new Map<string, HmiPage>();
  for (const page of app.pages) if (!pageById.has(page.id)) pageById.set(page.id, page);
  const firstPage = app.pages[0];
  if (!pageIds.has(app.startPageId) && firstPage) {
    add(issues, "HMI.PAGE.START_MISSING", firstPage, `página inicial inexistente (${app.startPageId})`);
  }
  const pageIdCounts = new Map<string, number>();
  for (const page of app.pages) {
    pageIdCounts.set(page.id, (pageIdCounts.get(page.id) ?? 0) + 1);
  }
  for (const [pageId, count] of pageIdCounts) {
    if (count < 2) continue;
    if (firstPage) add(issues, "HMI.PAGE.ID_DUPLICATE", firstPage, `ID de página duplicado (${pageId})`);
  }

  const reachablePageIds = new Set<string>(pageIds.has(app.startPageId) ? [app.startPageId] : []);
  const pendingPageIds = [...reachablePageIds];
  while (pendingPageIds.length > 0) {
    const page = pageById.get(pendingPageIds.pop() ?? "");
    for (const navigation of page?.navigation ?? []) {
      if (pageIds.has(navigation.targetPageId) && !reachablePageIds.has(navigation.targetPageId)) {
        reachablePageIds.add(navigation.targetPageId);
        pendingPageIds.push(navigation.targetPageId);
      }
    }
  }

  for (const page of app.pages) {
    if (!Number.isFinite(page.width) || page.width <= 0 || !Number.isFinite(page.height) || page.height <= 0) {
      add(issues, "HMI.PAGE.DIMENSIONS_INVALID", page, "dimensões da página inválidas; largura e altura devem ser positivas");
    }
    const elementIdCounts = new Map<string, number>();
    for (const element of page.elements) elementIdCounts.set(element.id, (elementIdCounts.get(element.id) ?? 0) + 1);
    for (const [elementId, count] of elementIdCounts) {
      if (count > 1) add(issues, "HMI.ELEMENT.ID_DUPLICATE", page, `ID de elemento HMI duplicado (${elementId})`);
    }
    for (const element of page.elements) {
      const elementLabel = element.label ?? element.typeId ?? element.id;
      const validGeometry = Number.isFinite(element.visual.x) && Number.isFinite(element.visual.y)
        && Number.isFinite(element.visual.width) && Number.isFinite(element.visual.height)
        && element.visual.width > 0 && element.visual.height > 0;
      if (!validGeometry) {
        add(issues, "HMI.ELEMENT.DIMENSIONS_INVALID", page, `${elementLabel}: geometria HMI invalida; posicao e dimensoes devem ser finitas e tamanho positivo`, element.id);
      } else if (element.visual.x < 0 || element.visual.y < 0
          || element.visual.x + element.visual.width > page.width
          || element.visual.y + element.visual.height > page.height) {
        add(warnings, "HMI.ELEMENT.OUT_OF_BOUNDS", page, `${elementLabel}: elemento ultrapassa os limites da página`, element.id);
      }
      const sourceComponent = element.componentId ? componentsById.get(element.componentId) : undefined;
      if (element.componentId && !sourceComponent) {
        add(issues, "HMI.COMPONENT.REFERENCE_MISSING", page, `${elementLabel}: referência de componente inexistente (${element.componentId})`, element.id);
      }
      const typeId = sourceComponent?.typeId ?? element.typeId;
      if (!typeId || !isGraphicalTypeId(typeId)) continue;
      const catalogEntry = catalogByTypeId.get(typeId);
      const properties = { ...(sourceComponent?.properties ?? catalogEntry?.defaultProperties ?? {}), ...(element.properties ?? {}) };
      const label = element.label ?? sourceComponent?.label ?? catalogEntry?.label ?? typeId;

      for (const suffix of ["", "B", "C"]) {
        const bindSource = properties[`bindSource${suffix}`];
        if (typeof bindSource !== "string" || bindSource.trim() === "") continue;
        const boundComponent = componentsById.get(bindSource);
        if (!boundComponent) {
          add(issues, "HMI.BINDING.SOURCE_MISSING", page, `${label} / bindSource${suffix}: fonte inexistente (${bindSource})`, element.id);
          continue;
        }
        const readoutFormat = catalogByTypeId.get(boundComponent.typeId)?.readoutFormat;
        if (!readoutFormat) {
          add(issues, "HMI.BINDING.READOUT_UNAVAILABLE", page, `${label} / bindSource${suffix}: ${boundComponent.label} existe, mas não publica leitura compatível`, element.id);
          continue;
        }
        const channel = Number(properties[`bindChannel${suffix}`] ?? 0);
        const channelCount = readoutFormat.kind === "scalar" ? 1 : readoutFormat.channels;
        if (!Number.isInteger(channel) || channel < 0 || channel >= channelCount) {
          add(issues, "HMI.BINDING.CHANNEL_INVALID", page, `${label} / bindChannel${suffix}: canal ${String(properties[`bindChannel${suffix}`] ?? 0)} inválido para ${boundComponent.label} (${readoutFormat.kind}, ${channelCount} canal(is))`, element.id);
        }
      }

      for (const suffix of ["", "B", "C"]) {
        for (const configIssue of reviewGraphicalBindingConfiguration(properties, suffix)) {
          const message = configIssue.kind === "invalid-number"
            ? locale === "pt-BR" ? `${label} / ${configIssue.property}: o valor nao e numerico finito` : `${label} / ${configIssue.property}: value is not a finite number`
            : configIssue.kind === "invalid-decimals"
              ? locale === "pt-BR" ? `${label} / ${configIssue.property}: use um inteiro entre 0 e 6` : `${label} / ${configIssue.property}: use an integer from 0 to 6`
              : configIssue.kind === "degenerate-range"
                ? locale === "pt-BR" ? `${label}: bindMin${suffix} e bindMax${suffix} sao iguais; o grafico fica sem faixa` : `${label}: bindMin${suffix} and bindMax${suffix} are equal; the graphic has no range`
                : locale === "pt-BR" ? `${label} / ${configIssue.property}: os limites LL, L, H e HH devem estar em ordem crescente` : `${label} / ${configIssue.property}: LL, L, H, and HH limits must be ordered low to high`;
          add(warnings, `HMI.BINDING.${configIssue.kind.toUpperCase().replaceAll("-", "_")}`, page, message, element.id);
        }
        const sourceId = properties[`bindSource${suffix}`];
        const source = typeof sourceId === "string" ? componentsById.get(sourceId) : undefined;
        const readoutFormat = source ? catalogByTypeId.get(source.typeId)?.readoutFormat : undefined;
        if (readoutFormat?.kind !== "scalar") continue;
        const unitReview = reviewGraphicalBindingUnit(properties, readoutFormat.unit, suffix);
        if (!unitReview || unitReview === "compatible") continue;
        const displayUnit = String(properties[`bindUnit${suffix}`] ?? "").trim();
        const scale = String(properties[`bindScale${suffix}`] ?? 1);
        const offset = String(properties[`bindOffset${suffix}`] ?? 0);
        const ruleId = unitReview === "missing-display-unit" ? "HMI.BINDING.UNIT_MISSING"
          : unitReview === "unit-mismatch" ? "HMI.BINDING.UNIT_MISMATCH" : "HMI.BINDING.UNIT_CONVERSION_UNVERIFIED";
        const message = unitReview === "missing-display-unit"
          ? locale === "pt-BR" ? `${label} / bindUnit${suffix}: ${source!.label} informa ${readoutFormat.unit}, mas a unidade de exibição está vazia` : `${label} / bindUnit${suffix}: ${source!.label} reports ${readoutFormat.unit}, but the display unit is empty`
          : unitReview === "unit-mismatch"
            ? locale === "pt-BR" ? `${label} / bindUnit${suffix}: ${displayUnit} diverge da unidade da fonte ${readoutFormat.unit} sem escala/offset de conversão` : `${label} / bindUnit${suffix}: ${displayUnit} differs from source unit ${readoutFormat.unit} without a scale/offset conversion`
            : locale === "pt-BR" ? `${label} / bindUnit${suffix}: ${readoutFormat.unit} → ${displayUnit || "(vazia)"} usa escala ${scale} e offset ${offset}; confirme a conversão de engenharia` : `${label} / bindUnit${suffix}: ${readoutFormat.unit} → ${displayUnit || "(empty)"} uses scale ${scale} and offset ${offset}; review the engineering conversion`;
        add(warnings, ruleId, page, message, element.id);
      }

      if (isGraphicalActionTypeId(typeId)) {
        const actionTargetId = typeof properties.actionTarget === "string" ? properties.actionTarget.trim() : "";
        const actionProperty = typeof properties.actionProperty === "string" ? properties.actionProperty.trim() : "";
        if (!actionTargetId || !actionProperty) {
          add(warnings, "HMI.ACTION.CONFIGURATION_MISSING", page, `${label}: controle sem alvo/propriedade de ação configurados`, element.id);
        } else {
          const actionTarget = componentsById.get(actionTargetId);
          if (!actionTarget) {
            add(issues, "HMI.ACTION.TARGET_MISSING", page, `${label}: alvo de ação inexistente (${actionTargetId})`, element.id);
          } else if (!(writablePropertiesByComponentId[actionTargetId] ?? []).includes(actionProperty)) {
            add(issues, "HMI.ACTION.PROPERTY_UNAVAILABLE", page, `${label}: propriedade de ação indisponível em ${actionTarget.label} (${actionProperty})`, element.id);
          }
        }
      }
      if (hasVisualOnlyAlarmSemantics(typeId)) {
        add(warnings, "HMI.ALARM.VISUAL_ONLY", page, locale === "pt-BR"
          ? `${label}: a tarja sinaliza limites visuais; não declara prioridade, reconhecimento, histórico nem serviço de alarmes`
          : `${label}: this banner indicates visual limits; it does not declare priority, acknowledgment, history, or an alarm service`, element.id);
      }
    }
    const navigationIdCounts = new Map<string, number>();
    for (const navigation of page.navigation ?? []) navigationIdCounts.set(navigation.id, (navigationIdCounts.get(navigation.id) ?? 0) + 1);
    for (const [navigationId, count] of navigationIdCounts) {
      if (count > 1) add(issues, "HMI.NAVIGATION.ID_DUPLICATE", page, `ID de atalho de navegação duplicado (${navigationId})`);
    }
    for (const navigation of page.navigation ?? []) {
      const validGeometry = Number.isFinite(navigation.visual.x) && Number.isFinite(navigation.visual.y)
        && Number.isFinite(navigation.visual.width) && Number.isFinite(navigation.visual.height)
        && navigation.visual.width > 0 && navigation.visual.height > 0;
      if (!validGeometry) {
        add(issues, "HMI.NAVIGATION.DIMENSIONS_INVALID", page, `${navigation.label}: geometria de atalho invalida; posicao e dimensoes devem ser finitas e tamanho positivo`, undefined, `hmiApplication.pages[id=${JSON.stringify(page.id)}].navigation[id=${JSON.stringify(navigation.id)}]`);
      } else if (navigation.visual.x < 0 || navigation.visual.y < 0
          || navigation.visual.x + navigation.visual.width > page.width
          || navigation.visual.y + navigation.visual.height > page.height) {
        add(warnings, "HMI.NAVIGATION.OUT_OF_BOUNDS", page, `${navigation.label}: atalho ultrapassa os limites da página`, undefined, `hmiApplication.pages[id=${JSON.stringify(page.id)}].navigation[id=${JSON.stringify(navigation.id)}]`);
      }
      if (!pageIds.has(navigation.targetPageId)) {
        add(issues, "HMI.NAVIGATION.TARGET_MISSING", page, `${navigation.label}: destino de navegação inexistente (${navigation.targetPageId})`, undefined, `hmiApplication.pages[id=${JSON.stringify(page.id)}].navigation[id=${JSON.stringify(navigation.id)}].targetPageId`);
      }
    }
    if (pageIds.has(app.startPageId) && !reachablePageIds.has(page.id)) {
      add(warnings, "HMI.PAGE.UNREACHABLE", page, "página sem caminho de navegação desde a página inicial");
    }
  }
  const exceptionStatusByKey = resolveHmiAuditExceptions(app, now);
  const profile = app.auditRuleProfile ?? defaultHmiAuditRuleProfile(locale);
  const disabledRuleIds = new Set(profile.disabledRuleIds);
  const statusFindings = (findings: HmiAuditFinding[]): HmiAuditFinding[] => findings.map((finding) => {
    const resolution = exceptionStatusByKey.get(hmiAuditFindingKey(finding));
    return resolution ? { ...finding, ...resolution } : { ...finding, status: "open" };
  });
  return {
    issues: statusFindings(issues.filter((finding) => !disabledRuleIds.has(finding.ruleId))),
    warnings: statusFindings(warnings.filter((finding) => !disabledRuleIds.has(finding.ruleId))),
    profile: { ...profile, disabledRuleIds: [...profile.disabledRuleIds] },
  };
}
