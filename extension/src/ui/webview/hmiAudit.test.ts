import { assert, createTestRunner } from "../../ipc/testSupport/MockCoreServer";
import type { HmiApplication, HmiPage, WebviewComponentCatalogEntry, WebviewComponentModel } from "./model";
import { auditHmiApplication, createHmiAuditHtml, createHmiAuditReport, defaultHmiAuditRuleProfile, filterHmiAuditFindings, fingerprintHmiAuditInputs, HMI_AUDIT_RULE_IDS, hmiAuditFindingKey, resolveHmiAuditExceptions } from "./hmiAudit";

const component = (id: string, typeId: string, label = id, properties: Record<string, string | number | boolean> = {}): WebviewComponentModel => ({
  id, typeId, label, properties, pins: [], x: 0, y: 0, rotation: 0,
} as WebviewComponentModel);

const page = (id: string, elements: HmiPage["elements"] = [], navigation: HmiPage["navigation"] = []): HmiPage => ({
  id, name: id, width: 1920, height: 1080, elements, navigation,
});
const audit = (app: HmiApplication, components: readonly WebviewComponentModel[] = [], catalog: readonly WebviewComponentCatalogEntry[] = [], writable: Readonly<Record<string, readonly string[]>> = {}) =>
  auditHmiApplication(app, components, catalog, writable, "pt-BR", Date.parse("2026-10-10T12:00:00.000Z"));

(async () => {
  const { test, finish } = createTestRunner("hmiAudit");

  await test("auditoria pura aceita projeto estatico simples sem mutar a entrada", () => {
    const app: HmiApplication = { startPageId: "home", pages: [page("home")] };
    const before = JSON.stringify(app);
    const result = audit(app);
    assert(result.issues.length === 0 && result.warnings.length === 0, "composicao estatica valida nao deve exigir bindings");
    assert(JSON.stringify(app) === before, "auditoria nao deve alterar o documento recebido");
  });

  await test("relata referencias quebradas, canal invalido, unidade divergente e alcance de pagina", () => {
    const app: HmiApplication = {
      startPageId: "home",
      pages: [
        page("home", [
          { id: "gauge-1", typeId: "graphics.hmi.gauge", properties: { bindSource: "probe", bindChannel: 3, bindUnit: "bar" }, visual: { x: 20, y: 20, width: 100, height: 80 } },
          { id: "broken", componentId: "removed", visual: { x: 0, y: 0, width: 20, height: 20 } },
        ]),
        page("lost"),
      ],
    };
    const components = [component("probe", "instrument.pressure", "PT-1")];
    const catalog = [
      { typeId: "graphics.hmi.gauge", label: "Gauge", category: "Grafico", pinCount: 0, defaultProperties: {}, propertySchema: [] },
      { typeId: "instrument.pressure", label: "Pressure", category: "Instrumento", pinCount: 0, defaultProperties: {}, readoutFormat: { kind: "scalar", unit: "kPa" } },
    ] as WebviewComponentCatalogEntry[];
    const result = audit(app, components, catalog);
    assert(result.issues.some((finding) => finding.ruleId === "HMI.BINDING.CHANNEL_INVALID" && finding.elementId === "gauge-1"), "canal nao permitido deve ser problema navegavel");
    const channelFinding = result.issues.find((finding) => finding.ruleId === "HMI.BINDING.CHANNEL_INVALID");
    assert(Boolean(channelFinding?.rationale && channelFinding.recommendation && channelFinding.evidence?.[0]?.path.includes('elements[id="gauge-1"]')), "achado deve conter justificativa, próximo passo e caminho de evidencia");
    assert(channelFinding?.autoFixAvailable === false && channelFinding?.normativeMapping === null, "não sugerir auto-fix nem mapeamento normativo não revisado");
    assert(result.issues.find((finding) => finding.elementId === "gauge-1")?.componentId === "gauge-1", "achado deve identificar o componente/elemento HMI independente");
    assert(result.issues.some((finding) => finding.ruleId === "HMI.COMPONENT.REFERENCE_MISSING" && finding.elementId === "broken"), "referencia removida deve ser problema navegavel");
    assert(result.issues.find((finding) => finding.elementId === "broken")?.componentId === "removed", "referencia quebrada ainda deve poder ser filtrada pelo ID original");
    assert(result.warnings.some((finding) => finding.ruleId === "HMI.BINDING.UNIT_MISMATCH"), "unidade divergente deve continuar sendo aviso");
    assert(result.warnings.some((finding) => finding.ruleId === "HMI.PAGE.UNREACHABLE" && finding.pageId === "lost"), "pagina fora da navegacao deve ser reportada");
  });

  await test("bindings HMI do Python respeitam o numero dinamico de saidas", () => {
    const app: HmiApplication = {
      startPageId: "home",
      pages: [page("home", [{ id: "gauge-python", typeId: "graphics.hmi.gauge", properties: { bindSource: "python-1", bindChannel: 1 }, visual: { x: 20, y: 20, width: 100, height: 80 } }])],
    };
    const components = [component("python-1", "python.programmable", "Controller", { ports: JSON.stringify({ inputs: [], outputs: [{ name: "level", type: "real" }] }) })];
    const catalog = [
      { typeId: "graphics.hmi.gauge", label: "Gauge", category: "Grafico", pinCount: 0, defaultProperties: {} },
      { typeId: "python.programmable", label: "Python", category: "Controle", pinCount: 0, defaultProperties: {}, readoutFormat: { kind: "channelHistory", channels: 64 } },
    ] as WebviewComponentCatalogEntry[];
    const result = audit(app, components, catalog);
    assert(result.issues.some((finding) => finding.ruleId === "HMI.BINDING.CHANNEL_INVALID" && finding.elementId === "gauge-python"),
      "canal além das saídas Python configuradas deve ser inválido, mesmo que o formato aceite até 64 canais");
  });

  await test("binding HMI aceita a saida Python nomeada dentro da faixa configurada", () => {
    const app: HmiApplication = {
      startPageId: "home",
      pages: [page("home", [{ id: "gauge-python", typeId: "graphics.hmi.gauge", properties: { bindSource: "python-1", bindChannel: 0 }, visual: { x: 20, y: 20, width: 100, height: 80 } }])],
    };
    const components = [component("python-1", "python.programmable", "Controller", { ports: JSON.stringify({ inputs: [], outputs: [{ name: "level", type: "real", unit: "%" }] }) })];
    const catalog = [
      { typeId: "graphics.hmi.gauge", label: "Gauge", category: "Grafico", pinCount: 0, defaultProperties: {} },
      { typeId: "python.programmable", label: "Python", category: "Controle", pinCount: 0, defaultProperties: {}, readoutFormat: { kind: "channelHistory", channels: 64 } },
    ] as WebviewComponentCatalogEntry[];
    const result = audit(app, components, catalog);
    assert(!result.issues.some((finding) => finding.elementId === "gauge-python"),
      "a primeira saida Python configurada deve poder alimentar um widget HMI");
  });

  await test("classifica tarja de limites visuais e deixa widget sem binding como composicao valida", () => {
    const app: HmiApplication = {
      startPageId: "home",
      pages: [page("home", [{ id: "banner", typeId: "graphics.hmi.alarm_banner", visual: { x: 0, y: 0, width: 400, height: 50 } }])],
    };
    const catalog = [{ typeId: "graphics.hmi.alarm_banner", label: "Alarm Banner", category: "Grafico", pinCount: 0, defaultProperties: {} }] as WebviewComponentCatalogEntry[];
    const result = audit(app, [], catalog);
    assert(result.issues.length === 0, "widget visual sem binding continua valido");
    assert(result.warnings.some((finding) => finding.ruleId === "HMI.ALARM.VISUAL_ONLY" && finding.elementId === "banner"), "uso da tarja precisa deixar claro que nao existe servico de alarmes");
  });

  await test("resultados e IDs de regra sao deterministas", () => {
    const app: HmiApplication = { startPageId: "missing", pages: [page("home")] };
    const first = audit(app);
    const second = audit(app);
    assert(JSON.stringify(first) === JSON.stringify(second), "mesma entrada deve produzir os mesmos achados e ordenacao");
    assert(first.issues[0]?.ruleId === "HMI.PAGE.START_MISSING", "cada achado deve expor um identificador de regra estavel");
  });

  await test("relatorio JSON versionado contem achados, nao o projeto nem valores de componentes", () => {
    const findings = audit({ startPageId: "bad", pages: [page("home")] });
    const report = createHmiAuditReport(findings, "en", "2026-10-10T12:00:00.000Z");
    const json = JSON.stringify(report);
    assert(report.format === "lasecsimul-hmi-audit" && report.schemaVersion === 2 && report.rulesetVersion === 1, "formato e versoes devem identificar o contrato do relatorio com status, perfil e evidencia");
    assert(report.counts.issues === 1 && report.findings[0]?.severity === "issue", "contagem e severidade devem corresponder aos achados");
    assert(report.findings[0]?.engineeringSeverity === "error" && report.findings[0]?.ruleVersion === 1 && report.findings[0]?.confidence === "high" && report.findings[0]?.evidence.length === 1, "relatório deve formalizar severidade, versão, confiança e evidência");
    assert(!json.includes("components") && !json.includes("properties") && !json.includes("secret"), "exportacao deve conter apenas metadados e achados, nunca o estado do projeto");
    assert(report.privacyMode === "redacted" && report.findings[0]?.pageName === "home" && report.findings[0]?.message === "HMI.PAGE.START_MISSING", "exportacao padrao deve redigir nomes e mensagem dinamica, preservando ID e regra");
    const fullReport = createHmiAuditReport({ issues: [{ ruleId: "R.PRIVATE", pageId: "p-secret", pageName: "Area confidencial", message: "tag=pressao.privada", exception: { id: "e-secret", findingKey: "k", ruleId: "R.PRIVATE", pageId: "p-secret", action: "accepted", reviewer: "Operador", reason: "motivo confidencial", recordedAt: "2026-10-10T12:00:00.000Z" } }], warnings: [] }, "pt-BR", "2026-10-10T12:00:00.000Z", undefined, undefined, "full");
    assert(JSON.stringify(fullReport).includes("motivo confidencial") && JSON.stringify(fullReport).includes("pressao.privada"), "texto do projeto so aparece na modalidade explicitamente solicitada");
    const empty = createHmiAuditReport({ issues: [], warnings: [] }, "pt-BR", "2026-10-10T12:00:00.000Z");
    assert(empty.findings.length === 0 && empty.counts.issues === 0 && empty.counts.warnings === 0, "relatorio limpo tambem deve ser exportavel");
  });

  await test("relatorio HTML e acessivel, autocontido e escapa texto fornecido pelo projeto", () => {
    const report = createHmiAuditReport({
      issues: [{ ruleId: "HMI.TEST", pageId: "p1", pageName: "<img src=x onerror=alert(1)>", componentLabel: "<svg onload=alert(2)>", componentId: "c&1", elementId: "e&1", message: "A < B & C" }],
      warnings: [],
    }, "pt-BR", "2026-10-10T12:00:00.000Z", undefined, undefined, "full");
    const html = createHmiAuditHtml(report);
    assert(html.includes('<html lang="pt-BR">') && html.includes("<main>") && html.includes("<table>"), "relatorio usa idioma e elementos semanticos");
    assert(html.includes("&lt;img src=x onerror=alert(1)&gt;") && html.includes("e&amp;1") && html.includes("A &lt; B &amp; C"), "texto dinamico deve ser escapado no HTML");
    assert(html.includes("&lt;svg onload=alert(2)&gt;") && html.includes("c&amp;1"), "nome e ID do componente tambem devem ser escapados");
    assert(!html.includes("<img src=x") && !html.includes("<svg onload=") && !html.includes("onerror=alert(1)>"), "conteudo de projeto nunca vira markup executavel");
    const empty = createHmiAuditHtml(createHmiAuditReport({ issues: [], warnings: [] }, "en", "2026-10-10T12:00:00.000Z"));
    assert(empty.includes("No findings for the enabled rules."), "export limpo deve explicar que nao houve achados");
  });

  await test("filtros por severidade, pagina, componente, regra e status preservam a ordem", () => {
    const findings = [
      { ruleId: "R1", pageId: "p1", pageName: "Page 1", componentId: "c1", message: "a", severity: "issue" as const },
      { ruleId: "R2", pageId: "p1", pageName: "Page 1", componentId: "c2", message: "b", severity: "warning" as const },
      { ruleId: "R1", pageId: "p2", pageName: "Page 2", componentId: "c1", message: "c", severity: "warning" as const, status: "excepted" as const },
    ];
    const before = JSON.stringify(findings);
    const result = filterHmiAuditFindings(findings, { severity: "warning", pageId: "p1", ruleId: "R2", componentId: "c2" });
    assert(result.length === 1 && result[0]?.message === "b", "criterios combinados devem aplicar AND");
    assert(JSON.stringify(findings) === before, "filtrar nao deve mutar nem reordenar o relatorio original");
    assert(filterHmiAuditFindings(findings, {}).length === findings.length, "filtros vazios mostram todos os achados");
    assert(filterHmiAuditFindings(findings, { status: "excepted" }).length === 1, "status deve ser filtrável independentemente dos outros critérios");
  });

  await test("excecao vinculada ao achado expoe decisao e vencimento no status", () => {
    const app: HmiApplication = { startPageId: "home", pages: [page("home", [{ id: "outside", typeId: "graphics.hmi.gauge", visual: { x: -1, y: 0, width: 20, height: 20 } }])], auditExceptions: [
      { id: "e1", findingKey: JSON.stringify(["HMI.ELEMENT.OUT_OF_BOUNDS", "home", "outside"]), ruleId: "HMI.ELEMENT.OUT_OF_BOUNDS", pageId: "home", elementId: "outside", action: "accepted", reviewer: "Ana", reason: "tela legada aprovada", recordedAt: "2026-01-01T00:00:00.000Z", expiresAt: "2099-01-01T00:00:00.000Z" },
    ] };
    const result = audit(app);
    const finding = result.warnings.find((entry) => entry.elementId === "outside");
    assert(finding?.status === "excepted" && finding.exception?.reviewer === "Ana", "decisao deve ser ligada ao achado e visivel no resultado");
    const afterExpiry = auditHmiApplication({ ...app, auditExceptions: app.auditExceptions?.map((event) => ({ ...event, expiresAt: "2026-03-01T00:00:00.000Z" })) }, [], [], {}, "pt-BR", Date.parse("2026-03-02T00:00:00.000Z"));
    assert(afterExpiry.warnings[0]?.status === "expired", "instante de avaliacao explicito controla expiracao sem consultar o relogio global");
    const report = createHmiAuditReport(result, "pt-BR", "2026-10-10T12:00:00.000Z", undefined, undefined, "full");
    const html = createHmiAuditHtml(report);
    assert(html.includes("Ana: tela legada aprovada") && html.includes("2099-01-01"), "relatorio HTML deve preservar a trilha e a validade");
  });

  await test("resolucao generica escolhe o ultimo evento e calcula vencimento com relogio informado", () => {
    const key = hmiAuditFindingKey({ ruleId: "R1", pageId: "P1", elementId: "E1" });
    const exceptionBase = { findingKey: key, ruleId: "R1", pageId: "P1", reviewer: "Eng", reason: "revisao", recordedAt: "2026-01-01T00:00:00.000Z" };
    const resolved = resolveHmiAuditExceptions({ auditExceptions: [
      { ...exceptionBase, id: "old", action: "accepted", expiresAt: "2027-01-01T00:00:00.000Z" },
      { ...exceptionBase, id: "new", reason: "segunda revisao", action: "accepted", expiresAt: "2026-02-01T00:00:00.000Z" },
    ] }, Date.parse("2026-03-01T00:00:00.000Z"));
    assert(resolved.get(key)?.status === "expired" && resolved.get(key)?.exception.id === "new" && resolved.get(key)?.exception.reason === "segunda revisao", "ultima decisao vencida deve substituir a anterior sem depender do relogio global");
  });

  await test("perfil versionado desativa por ID generico e aparece no relatorio mesmo sem achados", () => {
    const profile = { ...defaultHmiAuditRuleProfile("en"), name: "Line 1", version: 4, disabledRuleIds: ["HMI.PAGE.START_MISSING", "plugin.custom.rule"] };
    const app: HmiApplication = { startPageId: "missing", pages: [page("home")], auditRuleProfile: profile };
    const result = audit(app);
    assert(result.issues.length === 0, "regra desativada deve ser excluida do resultado aplicado");
    assert(result.profile?.version === 4 && result.profile.disabledRuleIds.includes("plugin.custom.rule"), "perfil/versionamento e IDs extensíveis devem ser preservados");
    const report = createHmiAuditReport(result, "en", "2026-10-10T12:00:00.000Z");
    assert(report.profile.name === "Line 1" && report.profile.version === 4 && report.profile.disabledRuleIds.length === 2, "relatorio precisa identificar o perfil e todas as regras desativadas");
    assert(createHmiAuditHtml(report).includes("plugin.custom.rule"), "HTML deve explicitar IDs de regras excluídas");
    assert(new Set(HMI_AUDIT_RULE_IDS).size === HMI_AUDIT_RULE_IDS.length, "registry genérico de regras não deve conter IDs duplicados");
  });

  await test("fingerprints SHA-256 sao canonicos, mudam com entradas e nao exportam dados brutos", async () => {
    const app: HmiApplication = { startPageId: "home", pages: [page("home")] };
    const catalog = [{ typeId: "graphics.hmi.gauge", label: "Gauge", category: "Graphic", pinCount: 0, defaultProperties: {} }] as WebviewComponentCatalogEntry[];
    const first = await fingerprintHmiAuditInputs(app, [component("c1", "instrument.pressure", "PT-1", { range: 100 })], catalog);
    const reordered = await fingerprintHmiAuditInputs({ pages: app.pages, startPageId: "home" }, [component("c1", "instrument.pressure", "PT-1", { range: 100 })], catalog);
    const changed = await fingerprintHmiAuditInputs(app, [component("c1", "instrument.pressure", "PT-1", { range: 101 })], catalog);
    assert(first.hmiInputsSha256.length === 64 && first.catalogSha256.length === 64, "fingerprints devem ser SHA-256 hexadecimais");
    assert(first.hmiInputsSha256 === reordered.hmiInputsSha256, "ordem de propriedades nao deve alterar o fingerprint canonico");
    assert(first.hmiInputsSha256 !== changed.hmiInputsSha256, "alterar uma entrada auditada deve alterar seu fingerprint");
    const report = createHmiAuditReport({ issues: [], warnings: [] }, "en", "2026-10-10T12:00:00.000Z", defaultHmiAuditRuleProfile("en"), first);
    const json = JSON.stringify(report);
    assert(json.includes(first.hmiInputsSha256) && !json.includes("instrument.pressure") && !json.includes("PT-1"), "relatorio inclui so hash, nunca valores brutos de projeto");
    assert(createHmiAuditHtml(report).includes(first.catalogSha256), "HTML deve incluir os fingerprints da execucao");
  });

  await test("cada regra registrada tem fixture que a aciona", () => {
    const gauge = (properties: Record<string, string | number | boolean> = {}) => ({ id: "gauge", typeId: "graphics.hmi.gauge", properties, visual: { x: 20, y: 20, width: 100, height: 80 } });
    const scalarSource = component("source", "instrument.pressure", "PT-1");
    const scalarCatalog = [{ typeId: "instrument.pressure", label: "Pressure", category: "Instrument", pinCount: 0, defaultProperties: {}, readoutFormat: { kind: "scalar" as const, unit: "kPa" } }] as WebviewComponentCatalogEntry[];
    const cases: Record<string, () => HmiApplication> = {
      "HMI.PAGE.START_MISSING": () => ({ startPageId: "absent", pages: [page("home")] }),
      "HMI.PAGE.ID_DUPLICATE": () => ({ startPageId: "home", pages: [page("home"), page("home")] }),
      "HMI.PAGE.DIMENSIONS_INVALID": () => ({ startPageId: "home", pages: [{ ...page("home"), width: 0 }] }),
      "HMI.PAGE.UNREACHABLE": () => ({ startPageId: "home", pages: [page("home"), page("away")] }),
      "HMI.ELEMENT.ID_DUPLICATE": () => ({ startPageId: "home", pages: [page("home", [gauge(), { ...gauge(), typeId: "graphics.hmi.trend" }])] }),
      "HMI.ELEMENT.DIMENSIONS_INVALID": () => ({ startPageId: "home", pages: [page("home", [{ ...gauge(), visual: { x: 0, y: 0, width: 0, height: Number.NaN } }])] }),
      "HMI.ELEMENT.OUT_OF_BOUNDS": () => ({ startPageId: "home", pages: [page("home", [{ ...gauge(), visual: { x: -1, y: 0, width: 100, height: 80 } }])] }),
      "HMI.COMPONENT.REFERENCE_MISSING": () => ({ startPageId: "home", pages: [page("home", [{ id: "orphan", componentId: "missing", visual: { x: 0, y: 0, width: 10, height: 10 } }])] }),
      "HMI.NAVIGATION.ID_DUPLICATE": () => ({ startPageId: "home", pages: [{ ...page("home"), navigation: [{ id: "nav", label: "One", targetPageId: "home", visual: { x: 0, y: 0, width: 10, height: 10 } }, { id: "nav", label: "Two", targetPageId: "home", visual: { x: 10, y: 0, width: 10, height: 10 } }] }] }),
      "HMI.NAVIGATION.DIMENSIONS_INVALID": () => ({ startPageId: "home", pages: [{ ...page("home"), navigation: [{ id: "nav", label: "Invalid", targetPageId: "home", visual: { x: 0, y: 0, width: -1, height: 10 } }] }] }),
      "HMI.NAVIGATION.OUT_OF_BOUNDS": () => ({ startPageId: "home", pages: [{ ...page("home"), navigation: [{ id: "nav", label: "Out", targetPageId: "home", visual: { x: -1, y: 0, width: 10, height: 10 } }] }] }),
      "HMI.NAVIGATION.TARGET_MISSING": () => ({ startPageId: "home", pages: [{ ...page("home"), navigation: [{ id: "nav", label: "Missing", targetPageId: "absent", visual: { x: 0, y: 0, width: 10, height: 10 } }] }] }),
      "HMI.BINDING.SOURCE_MISSING": () => ({ startPageId: "home", pages: [page("home", [gauge({ bindSource: "absent" })])] }),
      "HMI.BINDING.READOUT_UNAVAILABLE": () => ({ startPageId: "home", pages: [page("home", [gauge({ bindSource: "source" })])] }),
      "HMI.BINDING.CHANNEL_INVALID": () => ({ startPageId: "home", pages: [page("home", [gauge({ bindSource: "source", bindChannel: 1 })])] }),
      "HMI.BINDING.INVALID_NUMBER": () => ({ startPageId: "home", pages: [page("home", [gauge({ bindScale: "invalid" })])] }),
      "HMI.BINDING.INVALID_DECIMALS": () => ({ startPageId: "home", pages: [page("home", [gauge({ bindDecimals: 8 })])] }),
      "HMI.BINDING.DEGENERATE_RANGE": () => ({ startPageId: "home", pages: [page("home", [gauge({ bindMin: 5, bindMax: 5 })])] }),
      "HMI.BINDING.LIMIT_ORDER": () => ({ startPageId: "home", pages: [page("home", [gauge({ limitLL: 10, limitL: 0 })])] }),
      "HMI.BINDING.UNIT_MISSING": () => ({ startPageId: "home", pages: [page("home", [gauge({ bindSource: "source" })])] }),
      "HMI.BINDING.UNIT_MISMATCH": () => ({ startPageId: "home", pages: [page("home", [gauge({ bindSource: "source", bindUnit: "bar" })])] }),
      "HMI.BINDING.UNIT_CONVERSION_UNVERIFIED": () => ({ startPageId: "home", pages: [page("home", [gauge({ bindSource: "source", bindUnit: "bar", bindScale: 2 })])] }),
      "HMI.ACTION.CONFIGURATION_MISSING": () => ({ startPageId: "home", pages: [page("home", [{ id: "button", typeId: "graphics.hmi_button", properties: {}, visual: { x: 0, y: 0, width: 20, height: 20 } }])] }),
      "HMI.ACTION.TARGET_MISSING": () => ({ startPageId: "home", pages: [page("home", [{ id: "button", typeId: "graphics.hmi_button", properties: { actionTarget: "absent", actionProperty: "setpoint" }, visual: { x: 0, y: 0, width: 20, height: 20 } }])] }),
      "HMI.ACTION.PROPERTY_UNAVAILABLE": () => ({ startPageId: "home", pages: [page("home", [{ id: "button", typeId: "graphics.hmi_button", properties: { actionTarget: "source", actionProperty: "readOnly" }, visual: { x: 0, y: 0, width: 20, height: 20 } }])] }),
      "HMI.ALARM.VISUAL_ONLY": () => ({ startPageId: "home", pages: [page("home", [{ id: "alarm", typeId: "graphics.hmi.alarm_banner", visual: { x: 0, y: 0, width: 100, height: 20 } }])] }),
    };
    assert(HMI_AUDIT_RULE_IDS.every((ruleId) => cases[ruleId]), "cada regra deve ter um fixture positivo correspondente");
    assert(Object.keys(cases).length === HMI_AUDIT_RULE_IDS.length, "fixtures nao devem incluir regras sem registro");
    for (const ruleId of HMI_AUDIT_RULE_IDS) {
      const app = cases[ruleId]!();
      const components = [scalarSource];
      const catalog = ruleId === "HMI.BINDING.READOUT_UNAVAILABLE" ? [] : scalarCatalog;
      const writable = ruleId === "HMI.ACTION.PROPERTY_UNAVAILABLE" ? { source: [] } : { source: ["setpoint"] };
      const result = audit(app, components, catalog, writable);
      assert([...result.issues, ...result.warnings].some((finding) => finding.ruleId === ruleId), `fixture deveria acionar ${ruleId}`);
    }
  });

  const { failed } = finish();
  process.exitCode = failed > 0 ? 1 : 0;
})();
