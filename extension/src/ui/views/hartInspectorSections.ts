/** Property Inspector Variables/Commands editors for HART devices
 * (`protocol.hart.serial`/`protocol.hart.udp`, `HartCommunicationComponent`).
 *
 * Pure, `vscode`-free (Node-testable, same convention as `batchProperties.ts`)
 * -- `PropertyInspectorViewProvider.ts` calls these to build the HTML it
 * hands to the webview and to interpret `data-hart-*` edit messages coming
 * back. The row shapes here are the JSON wire format for the Core
 * `hartVariablesJson`/`hartCommandsJson` properties (`HartCommunicationComponent
 * ::rebuildConfiguredPlan`/`HartCommandJson::parseCommandCollection`) --
 * keep both sides in sync by hand; there is no shared schema generator (FEAT-013
 * Property Inspector audit, "Anexo B" section 8: this is a small, closed,
 * architecture-level vocabulary, not something worth a generic Core
 * "describe my JSON collection" mechanism). */

/** Mirrors `lasecsimul::protocols::HartVariableRole` (HartEngine.hpp). */
export const HART_VARIABLE_ROLES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "PV", label: "Primary Variable (PV)" },
  { value: "SV", label: "Secondary Variable (SV)" },
  { value: "TV", label: "Tertiary Variable (TV)" },
  { value: "QV", label: "Quaternary Variable (QV)" },
  { value: "Internal", label: "Internal" },
  { value: "DeviceSpecific", label: "Device Specific" },
  { value: "VendorSpecific", label: "Vendor Specific" },
  { value: "Custom", label: "Custom" },
];

/** Mirrors `lasecsimul::protocols::HartVariableType` -- only types
 * `HartTypeCodec` actually implements (section 14: no UI type disconnected
 * from a real codec). */
export const HART_VARIABLE_TYPES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "Float32", label: "Float32" },
  { value: "UInt8", label: "UInt8" },
  { value: "UInt16", label: "UInt16" },
  { value: "Int16", label: "Int16" },
  { value: "PackedAscii", label: "Packed ASCII" },
  { value: "Bool", label: "Bool" },
];

/** Mirrors `lasecsimul::protocols::HartVariableDirection`; Input/Output are
 * materialized as generic Signal Graph endpoints by the Core component. */
export const HART_VARIABLE_DIRECTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "Internal", label: "Internal" },
  { value: "Input", label: "Input" },
  { value: "Output", label: "Output" },
];

/** Built-in protocol fields remain available to commands. User variables are
 * appended to this picker from the variable collection at render time. */
export const HART_BUILTIN_VARIABLES: ReadonlyArray<{ value: string; label: string }> = [
  { value: "ManufacturerId", label: "Manufacturer ID" },
  { value: "DeviceType", label: "Device Type" },
  { value: "DeviceId", label: "Device ID (3 bytes)" },
  { value: "NumRequestPreambles", label: "Num. Request Preambles" },
  { value: "UniversalCommandRevision", label: "Universal Command Revision" },
  { value: "TransmitterSpecificRevision", label: "Transmitter-Specific Revision" },
  { value: "SoftwareRevision", label: "Software Revision" },
  { value: "HardwareRevisionAndSignal", label: "Hardware Revision + Signal Code" },
  { value: "Flags", label: "Flags" },
  { value: "Tag", label: "Tag (6 bytes packed ASCII)" },
  { value: "PrimaryVariableUnit", label: "PV Unit" },
  { value: "PrimaryVariable", label: "PV (Float32)" },
];

export type HartCommandStepKind = "hex" | "variable" | "body" | "bodySlice";

export const HART_COMMAND_STEP_KINDS: ReadonlyArray<{ value: HartCommandStepKind; label: string }> = [
  { value: "hex", label: "Hex Constant" },
  { value: "variable", label: "Variable" },
  { value: "body", label: "Request Body" },
  { value: "bodySlice", label: "Body Slice" },
];

export interface HartVariableRow {
  id: string;
  name: string;
  role: string;
  type: string;
  direction: string;
  unit: string;
  value: number;
  /** Deprecated compatibility fields accepted by callers from the previous
   * Inspector contract; they are intentionally not rendered or persisted. */
  readable?: boolean;
  writable?: boolean;
  runtimeMutable?: boolean;
  deviceVariableCode?: number;
  deviceVariableUnit?: number;
  classification?: number;
  family?: number;
  transducerSerialNumber?: number;
  upperTransducerLimit?: number;
  lowerTransducerLimit?: number;
  minimumSpan?: number;
  dampingValue?: number;
  acquisitionPeriod?: number;
  deviceVariableProperties?: number;
  deviceVariableStatus?: number;
  allowedUnitCodes?: number[];
  rangeUnitCode?: number;
  lowerRangeValue?: number;
  upperRangeValue?: number;
  expression?: string;
}

export interface HartCommandStepRow {
  kind: HartCommandStepKind;
  bytes?: string; // hex, "kind":"hex"
  variable?: string; // "kind":"variable"
  offset?: number; // "kind":"bodySlice"
  length?: number; // "kind":"bodySlice"
}

export interface HartCommandRow {
  id: number;
  name: string;
  enabled: boolean;
  responseSteps: HartCommandStepRow[];
}

function asRecordArray(json: string): Array<Record<string, unknown>> {
  try {
    const parsed: unknown = JSON.parse(json || "[]");
    return Array.isArray(parsed) ? parsed.filter((x): x is Record<string, unknown> => Boolean(x) && typeof x === "object") : [];
  } catch {
    return [];
  }
}

export function parseVariableRows(json: string): HartVariableRow[] {
  return asRecordArray(json).map((item) => ({
    id: typeof item.id === "string" ? item.id : "",
    name: typeof item.name === "string" ? item.name : "",
    role: typeof item.role === "string" ? item.role : "Internal",
    type: typeof item.type === "string" ? item.type : "Float32",
    direction: typeof item.direction === "string" ? item.direction : "Internal",
    unit: typeof item.unit === "string" ? item.unit : "",
    value: typeof item.value === "number" ? item.value : 0,
    runtimeMutable: item.runtimeMutable === true,
    ...(typeof item.deviceVariableCode === "number" ? { deviceVariableCode: item.deviceVariableCode } : {}),
    ...(typeof item.deviceVariableUnit === "number" ? { deviceVariableUnit: item.deviceVariableUnit } : {}),
    ...(typeof item.classification === "number" ? { classification: item.classification } : {}),
    ...(typeof item.family === "number" ? { family: item.family } : {}),
    ...(typeof item.transducerSerialNumber === "number" ? { transducerSerialNumber: item.transducerSerialNumber } : {}),
    ...(typeof item.upperTransducerLimit === "number" ? { upperTransducerLimit: item.upperTransducerLimit } : {}),
    ...(typeof item.lowerTransducerLimit === "number" ? { lowerTransducerLimit: item.lowerTransducerLimit } : {}),
    ...(typeof item.minimumSpan === "number" ? { minimumSpan: item.minimumSpan } : {}),
    ...(typeof item.dampingValue === "number" ? { dampingValue: item.dampingValue } : {}),
    ...(typeof item.acquisitionPeriod === "number" ? { acquisitionPeriod: item.acquisitionPeriod } : {}),
    ...(typeof item.deviceVariableProperties === "number" ? { deviceVariableProperties: item.deviceVariableProperties } : {}),
    ...(typeof item.deviceVariableStatus === "number" ? { deviceVariableStatus: item.deviceVariableStatus } : {}),
    ...(Array.isArray(item.allowedUnitCodes) ? { allowedUnitCodes: item.allowedUnitCodes.filter((x): x is number => typeof x === "number") } : {}),
    ...(typeof item.rangeUnitCode === "number" ? { rangeUnitCode: item.rangeUnitCode } : {}),
    ...(typeof item.lowerRangeValue === "number" ? { lowerRangeValue: item.lowerRangeValue } : {}),
    ...(typeof item.upperRangeValue === "number" ? { upperRangeValue: item.upperRangeValue } : {}),
    ...(typeof item.expression === "string" && item.expression ? { expression: item.expression } : {}),
  }));
}

/** Defense-in-depth for the variable `id` field's "stable identity, not
 * editable after creation" contract (the rendered `<input readonly>` is the
 * primary defense, same convention as the DSL-draft-open guard in
 * `PropertyInspectorViewProvider.onDidReceiveMessage` -- a message that
 * slips through a stale/bypassed webview must still never reach the
 * Authoring Model). `id` is the Signal Graph identity for Input/Output
 * variables (`HartCommunicationComponent::signalBlockId` = `hart.<index>.
 * <id>`); silently accepting a changed id for an existing row would orphan
 * any wire bound to the old block id with no warning. Rows are matched by
 * array position, the same indexing the client script itself uses to build
 * the payload -- a row that already existed at position i keeps its old id
 * regardless of what the incoming payload says; a genuinely new row (no
 * previous row at that position) keeps whatever id it arrived with. */
export function preserveExistingVariableIds(previousJson: string, nextJson: string): string {
  const previous = asRecordArray(previousJson);
  const next = asRecordArray(nextJson);
  const corrected = next.map((row, i) => {
    const previousId = previous[i]?.id;
    return typeof previousId === "string" && previousId ? { ...row, id: previousId } : row;
  });
  return JSON.stringify(corrected);
}

export function serializeVariableRows(rows: HartVariableRow[]): string {
  return JSON.stringify(rows.map((row) => ({
    id: row.id, name: row.name, role: row.role, type: row.type, direction: row.direction,
    unit: row.unit, ...(row.direction === "Internal" ? { value: row.value } : {}),
    ...(row.runtimeMutable ? { runtimeMutable: true } : {}),
    ...Object.fromEntries(([
      "deviceVariableCode", "deviceVariableUnit", "classification", "family", "transducerSerialNumber",
      "upperTransducerLimit", "lowerTransducerLimit", "minimumSpan", "dampingValue", "acquisitionPeriod",
      "deviceVariableProperties", "deviceVariableStatus", "allowedUnitCodes",
      "rangeUnitCode", "lowerRangeValue", "upperRangeValue",
    ] as const).filter((key) => row[key] !== undefined).map((key) => [key, row[key]])),
    ...(row.expression ? { expression: row.expression } : {}),
  })));
}

export function parseCommandRows(json: string): HartCommandRow[] {
  return asRecordArray(json).map((item) => ({
    id: typeof item.id === "number" ? item.id : 0,
    name: typeof item.name === "string" ? item.name : "",
    enabled: item.enabled !== false,
    responseSteps: Array.isArray(item.responseSteps)
      ? (item.responseSteps as unknown[])
          .filter((s): s is Record<string, unknown> => Boolean(s) && typeof s === "object")
          .map((s) => ({
            kind: (["hex", "variable", "body", "bodySlice"].includes(String(s.kind)) ? s.kind : "hex") as HartCommandStepKind,
            ...(typeof s.bytes === "string" ? { bytes: s.bytes } : {}),
            ...(typeof s.variable === "string" ? { variable: s.variable } : {}),
            ...(typeof s.offset === "number" ? { offset: s.offset } : {}),
            ...(typeof s.length === "number" ? { length: s.length } : {}),
          }))
      : [],
  }));
}

export function serializeCommandRows(rows: HartCommandRow[]): string {
  return JSON.stringify(rows.map((row) => ({
    id: row.id, name: row.name, enabled: row.enabled,
    responseSteps: row.responseSteps.map((step) => {
      if (step.kind === "hex") return { kind: "hex", bytes: step.bytes ?? "" };
      if (step.kind === "variable") return { kind: "variable", variable: step.variable ?? "ManufacturerId" };
      if (step.kind === "bodySlice") return { kind: "bodySlice", offset: step.offset ?? 0, length: step.length ?? 1 };
      return { kind: "body" };
    }),
  })));
}

function escapeAttr(value: string): string {
  return value.replaceAll("&", "&amp;").replaceAll("\"", "&quot;").replaceAll("<", "&lt;");
}

function selectHtml(dataAttrs: string, options: ReadonlyArray<{ value: string; label: string }>, current: string, disabled: boolean): string {
  const opts = options.map((o) => `<option value="${escapeAttr(o.value)}"${o.value === current ? " selected" : ""}>${escapeAttr(o.label)}</option>`).join("");
  return `<select ${dataAttrs}${disabled ? " disabled" : ""}>${opts}</select>`;
}

export interface HartSectionOptions {
  /** Simulation is running/paused (not "stopped") -- structural edits (add,
   * remove, id, direction, type) are disabled; runtime-mutable value fields
   * stay editable (HART-FR-021, section 20/21). */
  structuralEditsLocked: boolean;
}

export function renderVariablesSection(rows: HartVariableRow[], options: HartSectionOptions): string {
  const rowHtml = rows.map((row, i) => {
    const d = (field: string) => `data-hv-index="${i}" data-hv-field="${field}"`;
    const structuralDisabled = options.structuralEditsLocked;
    const valueDisabled = options.structuralEditsLocked && !row.runtimeMutable;
    return `<div class="hv-row">
      <div class="hv-line">
        <input ${d("id")} value="${escapeAttr(row.id)}" placeholder="variableId (stable)" readonly title="Stable identity -- referenced by commands, Signal Graph wires (hart.&lt;index&gt;.&lt;id&gt; block id) and bindings; never editable after creation, not just while RUN is active. Remove and re-add the variable to change it (this intentionally breaks any wire on the old id instead of silently orphaning it).">
        <input ${d("name")} value="${escapeAttr(row.name)}" placeholder="Display name">
        <button data-hv-remove="${i}" ${structuralDisabled ? "disabled" : ""} title="Remove variable">&minus;</button>
      </div>
      <div class="hv-line">
        ${selectHtml(`data-hv-index="${i}" data-hv-field="role"`, HART_VARIABLE_ROLES, row.role, structuralDisabled)}
        ${selectHtml(`data-hv-index="${i}" data-hv-field="type"`, HART_VARIABLE_TYPES, row.type, structuralDisabled)}
        ${selectHtml(`data-hv-index="${i}" data-hv-field="direction"`, HART_VARIABLE_DIRECTIONS, row.direction, structuralDisabled)}
        <input ${d("unit")} value="${escapeAttr(row.unit)}" placeholder="unit">
      </div>
      ${row.direction === "Internal" ? `<div class="hv-line"><label><input type="number" ${d("value")} value="${row.value}" ${valueDisabled ? "disabled" : ""}> Value</label></div>` : ""}
      ${row.direction === "Input" ? `<div class="hv-note">Input: value owned by the Signal Graph wire.</div><input type="checkbox" data-hv-field="writable" disabled hidden>` : ""}
      ${row.direction === "Output" ? `<div class="hv-note">Output: value published to the Signal Graph.</div>` : ""}
    </div>`;
  }).join("");
  return `<section><h3>Variables</h3>${rowHtml || `<div class="empty">None configured.</div>`}
    <button data-hv-add="1" ${options.structuralEditsLocked ? "disabled" : ""}>+ Add Variable</button></section>`;
}

export function renderCommandsSection(rows: HartCommandRow[], compilerStatus: string, options: HartSectionOptions,
                                      variables: HartVariableRow[] = []): string {
  const structuralDisabled = options.structuralEditsLocked;
  const rowHtml = rows.map((row, i) => {
    const stepsHtml = row.responseSteps.map((step, si) => {
      const kindSelect = selectHtml(`data-hc-index="${i}" data-hc-step="${si}" data-hc-field="kind"`, HART_COMMAND_STEP_KINDS, step.kind, structuralDisabled);
      let paramHtml = "";
      if (step.kind === "hex") {
        paramHtml = `<input data-hc-index="${i}" data-hc-step="${si}" data-hc-field="bytes" value="${escapeAttr(step.bytes ?? "")}" placeholder="hex bytes, e.g. CAFE" ${structuralDisabled ? "disabled" : ""}>`;
      } else if (step.kind === "variable") {
        const variableOptions = HART_BUILTIN_VARIABLES.concat(variables.map((variable) => ({ value: variable.id, label: variable.name || variable.id })));
        paramHtml = selectHtml(`data-hc-index="${i}" data-hc-step="${si}" data-hc-field="variable"`, variableOptions, step.variable ?? "ManufacturerId", structuralDisabled);
      } else if (step.kind === "bodySlice") {
        paramHtml = `<input type="number" data-hc-index="${i}" data-hc-step="${si}" data-hc-field="offset" value="${step.offset ?? 0}" placeholder="offset" ${structuralDisabled ? "disabled" : ""}>
          <input type="number" data-hc-index="${i}" data-hc-step="${si}" data-hc-field="length" value="${step.length ?? 1}" placeholder="length" ${structuralDisabled ? "disabled" : ""}>`;
      }
      return `<div class="hc-step">${kindSelect}${paramHtml}
        <button data-hc-step-up="${i}:${si}" ${structuralDisabled || si === 0 ? "disabled" : ""} title="Move up">&uarr;</button>
        <button data-hc-step-down="${i}:${si}" ${structuralDisabled || si === row.responseSteps.length - 1 ? "disabled" : ""} title="Move down">&darr;</button>
        <button data-hc-step-remove="${i}:${si}" ${structuralDisabled ? "disabled" : ""} title="Remove step">&minus;</button>
      </div>`;
    }).join("");
    return `<div class="hc-row">
      <div class="hc-line">
        <input data-hc-index="${i}" data-hc-field="id" type="number" value="${row.id}" placeholder="command id" ${structuralDisabled ? "readonly" : ""} title="Manufacturer commands must use the Device-Specific range (128-253). HART-standardized command numbers (Universal, Common Practice, Additional Common Practice, WirelessHART, Device Family) cannot be redefined here.">
        <input data-hc-index="${i}" data-hc-field="name" value="${escapeAttr(row.name)}" placeholder="name">
        <label><input type="checkbox" data-hc-index="${i}" data-hc-field="enabled" ${row.enabled ? "checked" : ""} ${structuralDisabled ? "disabled" : ""}> Enabled</label>
        <button data-hc-remove="${i}" ${structuralDisabled ? "disabled" : ""} title="Remove command">&minus;</button>
      </div>
      <div class="hc-stage-label">Response</div>
      ${stepsHtml || `<div class="empty">No steps.</div>`}
      <button data-hc-step-add="${i}" ${structuralDisabled ? "disabled" : ""}>+ Add Step</button>
    </div>`;
  }).join("");
  const statusOk = compilerStatus.trim().toUpperCase() === "OK";
  return `<section><h3>Commands</h3>
    <div class="hc-status ${statusOk ? "ok" : "err"}">Compiler: ${statusOk ? "&#10003; Valid" : `&#10007; ${escapeAttr(compilerStatus)}`}</div>
    ${rowHtml || `<div class="empty">None configured.</div>`}
    <button data-hc-add="1" ${structuralDisabled ? "disabled" : ""}>+ Add Command</button></section>`;
}

/** Client-side glue: reconstructs `HartVariableRow[]`/`HartCommandRow[]` from
 * the CURRENT DOM (source of truth lives server-side in the Authoring Model;
 * this webview never keeps a second copy across messages, only transiently
 * while building one commit -- section 44), applies the one thing that just
 * changed, and posts the full collection back as a single `setProperty`. The
 * host round-trips the edit through the normal `requestUpdateProperty`
 * pipeline and re-renders this view with the result (same mechanism as every
 * other property, so undo/redo and persistence are already correct -- see
 * `PropertyInspectorViewProvider.ts`'s class doc comment). */
export function hartInspectorClientScript(): string {
  return `
(function() {
  function readVariableRows() {
    var rows = [];
    document.querySelectorAll('[data-hv-index]').forEach(function(el) {
      var i = Number(el.dataset.hvIndex), field = el.dataset.hvField;
      if (field === undefined) return;
      rows[i] = rows[i] || {};
      rows[i][field] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
    });
    return rows.filter(Boolean);
  }
  function commitVariables(rows) {
    api.postMessage({ type: 'setProperty', name: 'hartVariablesJson', value: JSON.stringify(rows) });
  }
  function readCommandRows() {
    var rows = [];
    document.querySelectorAll('[data-hc-index]:not([data-hc-step])').forEach(function(el) {
      var i = Number(el.dataset.hcIndex), field = el.dataset.hcField;
      rows[i] = rows[i] || { responseSteps: [] };
      rows[i][field] = el.type === 'checkbox' ? el.checked : el.type === 'number' ? Number(el.value) : el.value;
    });
    document.querySelectorAll('[data-hc-step]').forEach(function(el) {
      var i = Number(el.dataset.hcIndex), s = Number(el.dataset.hcStep), field = el.dataset.hcField;
      rows[i] = rows[i] || { responseSteps: [] };
      rows[i].responseSteps[s] = rows[i].responseSteps[s] || {};
      rows[i].responseSteps[s][field] = el.type === 'number' ? Number(el.value) : el.value;
    });
    return rows.filter(Boolean).map(function(r) { r.responseSteps = r.responseSteps.filter(Boolean); return r; });
  }
  function commitCommands(rows) {
    api.postMessage({ type: 'setProperty', name: 'hartCommandsJson', value: JSON.stringify(rows) });
  }

  document.querySelectorAll('[data-hv-index]').forEach(function(el) {
    el.addEventListener('change', function() { commitVariables(readVariableRows()); });
  });
  var hvAdd = document.querySelector('[data-hv-add]');
  if (hvAdd) hvAdd.addEventListener('click', function() {
    var rows = readVariableRows();
    rows.push({ id: 'var' + rows.length, name: 'New Variable', role: 'Internal', type: 'Float32', direction: 'Internal',
                unit: '', value: 0 });
    commitVariables(rows);
  });
  document.querySelectorAll('[data-hv-remove]').forEach(function(el) {
    el.addEventListener('click', function() {
      var rows = readVariableRows();
      rows.splice(Number(el.dataset.hvRemove), 1);
      commitVariables(rows);
    });
  });

  document.querySelectorAll('[data-hc-index]').forEach(function(el) {
    el.addEventListener('change', function() { commitCommands(readCommandRows()); });
  });
  var hcAdd = document.querySelector('[data-hc-add]');
  if (hcAdd) hcAdd.addEventListener('click', function() {
    var rows = readCommandRows();
    var usedIds = rows.map(function(r) { return r.id; });
    // Device-Specific (HCF_SPEC-99 Table 9, 128-253) is the primary
    // manufacturer range -- never suggest an id outside it here (254+ is
    // Reserved). Core's classifier is the real gate either way (see
    // HartCommandJson::parseCommandDefinition); this just keeps the default
    // suggestion from ever landing on a Reserved id.
    var nextId = 128;
    while (nextId <= 253 && usedIds.indexOf(nextId) !== -1) nextId++;
    if (nextId > 253) { commitCommands(rows); return; } // Device-Specific range exhausted; nothing to add
    rows.push({ id: nextId, name: 'New Command', enabled: true, responseSteps: [] });
    commitCommands(rows);
  });
  document.querySelectorAll('[data-hc-remove]').forEach(function(el) {
    el.addEventListener('click', function() {
      var rows = readCommandRows();
      rows.splice(Number(el.dataset.hcRemove), 1);
      commitCommands(rows);
    });
  });
  document.querySelectorAll('[data-hc-step-add]').forEach(function(el) {
    el.addEventListener('click', function() {
      var rows = readCommandRows();
      rows[Number(el.dataset.hcStepAdd)].responseSteps.push({ kind: 'hex', bytes: '00' });
      commitCommands(rows);
    });
  });
  document.querySelectorAll('[data-hc-step-remove]').forEach(function(el) {
    el.addEventListener('click', function() {
      var parts = el.dataset.hcStepRemove.split(':').map(Number);
      var rows = readCommandRows();
      rows[parts[0]].responseSteps.splice(parts[1], 1);
      commitCommands(rows);
    });
  });
  document.querySelectorAll('[data-hc-step-up]').forEach(function(el) {
    el.addEventListener('click', function() {
      var parts = el.dataset.hcStepUp.split(':').map(Number);
      var rows = readCommandRows(), steps = rows[parts[0]].responseSteps;
      if (parts[1] > 0) { var t = steps[parts[1] - 1]; steps[parts[1] - 1] = steps[parts[1]]; steps[parts[1]] = t; }
      commitCommands(rows);
    });
  });
  document.querySelectorAll('[data-hc-step-down]').forEach(function(el) {
    el.addEventListener('click', function() {
      var parts = el.dataset.hcStepDown.split(':').map(Number);
      var rows = readCommandRows(), steps = rows[parts[0]].responseSteps;
      if (parts[1] < steps.length - 1) { var t = steps[parts[1] + 1]; steps[parts[1] + 1] = steps[parts[1]]; steps[parts[1]] = t; }
      commitCommands(rows);
    });
  });
})();`;
}
