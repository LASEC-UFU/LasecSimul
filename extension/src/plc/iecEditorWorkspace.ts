import { IEC_LANGUAGES, IecDataType, IecGlobalVariableList, IecLanguage, IecProjectAuthoring, IecVariable, LdRung, PouBody, PouDefinition, signatureOf } from "./iecProject";
import { resolvePlcEntryPoint } from "./plcBuild";

function clone(project: IecProjectAuthoring): IecProjectAuthoring {
  return structuredClone(project);
}

function nextId(prefix: string, used: Set<string>): string {
  let index = 1;
  while (used.has(`${prefix}-${index}`)) index += 1;
  return `${prefix}-${index}`;
}

export function addPouToProject(
  source: IecProjectAuthoring,
  name: string,
  kind: PouDefinition["kind"],
  language: IecLanguage,
): IecProjectAuthoring {
  const project = clone(source);
  const normalized = name.trim();
  if (kind !== "program" && kind !== "function" && kind !== "functionBlock") throw new Error("invalid IEC POU kind");
  if (!IEC_LANGUAGES.includes(language)) throw new Error("invalid IEC POU language");
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(normalized)) throw new Error("invalid IEC POU name");
  if (project.pous.some(pou => pou.name.toUpperCase() === normalized.toUpperCase())) throw new Error("duplicate IEC POU name");
  const pouId = nextId(`pou-${normalized.toLowerCase()}`, new Set(project.pous.map(pou => pou.pouId)));
  let implementation: PouBody;
  if (language === "st" || language === "il") implementation = { language, text: "" };
  else if (language === "sfc") {
    implementation = { language, steps: [{ stepId: "step-1", name: "Initial", initial: true, actions: [] }], transitions: [], actions: [] };
  } else if (language === "ld") {
    implementation = { language, networks: [], rungs: [emptyLdRung("rung-1")] };
  } else implementation = { language, networks: [{ networkId: "network-1", nodes: [], edges: [] }] };
  project.pous.push({
    pouId,
    name: normalized,
    kind,
    interface: { returnType: kind === "function" ? "BOOL" : undefined, variables: [] },
    implementation,
  });
  return project;
}

/** Inserts one reference through the canonical identity model, independent of caller language. */
export function insertPouReference(
  source: IecProjectAuthoring,
  callerPouId: string,
  targetPouId: string,
): IecProjectAuthoring {
  const project = clone(source);
  const caller = project.pous.find(pou => pou.pouId === callerPouId);
  const target = project.pous.find(pou => pou.pouId === targetPouId);
  if (!caller || !target) throw new Error("caller or target POU does not exist");
  if (target.kind === "program") throw new Error("PROGRAM cannot be inserted as a block");
  const usedReferences = new Set((caller.references ?? []).map(reference => reference.referenceId));
  const referenceId = nextId(`ref-${target.pouId}`, usedReferences);
  const instanceName = target.kind === "functionBlock" ? `${target.name}_1` : undefined;
  caller.references = [...(caller.references ?? []), {
    referenceId,
    targetPouId,
    instanceName,
    expectedSignature: signatureOf(target),
  }];

  const body = caller.implementation;
  if (body.language === "st") body.text = `${body.text.trimEnd()}\n${instanceName ?? target.name}();`.trimStart();
  else if (body.language === "il") body.text = `${body.text.trimEnd()}\nCAL ${instanceName ?? target.name}`.trimStart();
  else if (body.language === "sfc") {
    if (body.steps.length === 0) body.steps.push({ stepId: "step-1", name: "Initial", initial: true, actions: [] });
    const actions = body.steps[0]!.actions;
    actions.push({ actionId: nextId(`action-${target.pouId}`, new Set(actions.map(action => action.actionId))),
      referencedPouId: target.pouId, instanceName });
  } else if (body.language === "ld" && body.rungs) {
    const used = new Set(body.rungs.map(rung => rung.rungId));
    const rung = emptyLdRung(nextId("rung", used));
    rung.rows[0]![0] = { kind: "block", typeName: target.name, ...(instanceName ? { instanceName } : {}), powerInput: "EN", powerOutput: "ENO", inputs: {}, outputs: {} };
    body.rungs.push(rung);
  } else if ("networks" in body) {
    if (body.networks.length === 0) body.networks.push({ networkId: "network-1", nodes: [], edges: [] });
    const nodes = body.networks[0]!.nodes;
    nodes.push({ nodeId: nextId(`block-${target.pouId}`, new Set(nodes.map(node => node.nodeId))), kind: "block",
      referencedPouId: target.pouId, instanceName, x: 80 + nodes.length * 140, y: 80 });
  }
  return project;
}

export function updatePouText(source: IecProjectAuthoring, pouId: string, text: string): IecProjectAuthoring {
  const project = clone(source);
  const pou = project.pous.find(item => item.pouId === pouId);
  if (!pou || (pou.implementation.language !== "st" && pou.implementation.language !== "il")) {
    throw new Error("text update requires an ST or IL POU");
  }
  pou.implementation.text = text;
  return project;
}

const VARIABLE_CLASSES: IecVariable["class"][] = ["input", "output", "inOut", "local", "temp", "external"];

/**
 * Tabela de variáveis do editor. Entradas e saídas precisam de `ioId` estável (é o id do pino no
 * esquemático): ganham o próprio nome quando passam a ser públicas e o mantêm se forem renomeadas,
 * para os fios continuarem ligados.
 */
export function updatePouVariables(source: IecProjectAuthoring, pouId: string, value: unknown): IecProjectAuthoring {
  const project = clone(source);
  const pou = project.pous.find(item => item.pouId === pouId);
  if (!pou || !Array.isArray(value)) throw new Error("invalid POU variables");
  const usedIoIds = new Set<string>();
  const variables: IecVariable[] = value.map((raw, index) => {
    const entry = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
    const name = String(entry.name ?? "").trim();
    const variableClass = VARIABLE_CLASSES.includes(entry.class as IecVariable["class"]) ? entry.class as IecVariable["class"] : "local";
    const type = String(entry.type ?? "").trim().toUpperCase() || "BOOL";
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name)) throw new Error(`nome de variável inválido na linha ${index + 1}: "${name}"`);
    const variable: IecVariable = { name, class: variableClass, type };
    if (entry.retain === true) variable.retain = true;
    const initialValue = String(entry.initialValue ?? "").trim();
    if (initialValue) variable.initialValue = initialValue;
    if (variableClass === "input" || variableClass === "output" || variableClass === "inOut") {
      let ioId = String(entry.ioId ?? "").trim() || name;
      if (usedIoIds.has(ioId)) ioId = name;
      let suffix = 2;
      while (usedIoIds.has(ioId)) ioId = `${name}_${suffix++}`;
      usedIoIds.add(ioId);
      variable.ioId = ioId;
    }
    return variable;
  });
  pou.interface = { ...pou.interface, variables };
  return project;
}

interface TaskSettings { name: string; intervalMs: number; priority: number; eventVariable?: string }
interface ProgramInstanceSettings { name: string; pouId: string }

/**
 * Edição rápida da TASK/instância de entrada. As listas completas para múltiplos resources, tasks
 * e instâncias são editadas por `updateProjectRuntimeConfiguration`.
 */
export function updateTaskConfiguration(
  source: IecProjectAuthoring,
  task: TaskSettings,
  instance: ProgramInstanceSettings,
): IecProjectAuthoring {
  const project = clone(source);
  const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
  if (!identifier.test(task.name)) throw new Error(`nome de tarefa inválido: ${task.name}`);
  if (!identifier.test(instance.name)) throw new Error(`nome de instância inválido: ${instance.name}`);
  const program = project.pous.find(pou => pou.pouId === instance.pouId && pou.kind === "program");
  if (!program) throw new Error("a instância precisa apontar para um POU PROGRAM");
  if (task.eventVariable) {
    if (!identifier.test(task.eventVariable.trim())) throw new Error("nome da variável de evento inválido");
    task.eventVariable = task.eventVariable.trim();
    const eventInput = program.interface.variables.find(variable => variable.name.toUpperCase() === task.eventVariable!.toUpperCase());
    if (!eventInput || eventInput.class !== "input" || eventInput.type.toUpperCase() !== "BOOL") throw new Error("a variável de evento precisa ser uma entrada BOOL do PROGRAM");
  } else if (!(Number.isFinite(task.intervalMs) && task.intervalMs > 0)) throw new Error("o intervalo da tarefa deve ser maior que zero");

  const entry = resolvePlcEntryPoint(project);
  const records = (values: unknown[]) => values as Array<Record<string, unknown>>;
  const tasks = records(project.tasks);
  const resources = records(project.resources);
  const configurations = records(project.configurations);
  const instances = records(project.programInstances);
  const oldTaskName = entry.taskName;

  let taskRecord = tasks.find(item => item.name === oldTaskName);
  if (!taskRecord) { taskRecord = {}; tasks.push(taskRecord); }
  Object.assign(taskRecord, { name: task.name, intervalMs: task.intervalMs, priority: Math.max(0, Math.round(task.priority)) });
  if (task.eventVariable) taskRecord.eventVariable = task.eventVariable;
  else delete taskRecord.eventVariable;

  let resource = resources.find(item => item.name === entry.resourceName);
  if (!resource) { resource = { name: "RESOURCE_1" }; resources.push(resource); }
  const assignedTasks = Array.isArray(resource.tasks) ? resource.tasks.filter((value): value is string => typeof value === "string")
    : typeof resource.task === "string" ? [resource.task] : [];
  const nextAssignedTasks = assignedTasks.map(name => name === oldTaskName ? task.name : name);
  if (!nextAssignedTasks.includes(task.name)) nextAssignedTasks.push(task.name);
  resource.tasks = [...new Set(nextAssignedTasks)];
  delete resource.task;
  let configuration = configurations.find(item => item.name === entry.configurationName);
  if (!configuration) { configuration = { name: "CONFIGURATION_1" }; configurations.push(configuration); }
  configuration.resource = resource.name;
  project.buildSettings = { ...project.buildSettings, entryConfiguration: configuration.name };

  let instanceRecord = instances.find(item => item.name === entry.programInstanceName);
  if (!instanceRecord) { instanceRecord = {}; instances.push(instanceRecord); }
  Object.assign(instanceRecord, { name: instance.name, pouId: instance.pouId, task: task.name });
  for (const other of instances) if (other !== instanceRecord && other.task === oldTaskName) other.task = task.name;
  return project;
}

/** Atualiza a configuração IEC inteira para autoria de múltiplos resources, tasks e instâncias. */
export function updateProjectRuntimeConfiguration(source: IecProjectAuthoring, value: unknown): IecProjectAuthoring {
  let parsed: unknown;
  try { parsed = typeof value === "string" ? JSON.parse(value) : value; }
  catch { throw new Error("Configuração de runtime deve ser um JSON válido."); }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) throw new Error("Configuração de runtime deve ser um objeto JSON.");
  const encoded = parsed as Record<string, unknown>;
  const readRecords = (key: string): Array<Record<string, unknown>> => {
    const rows = encoded[key];
    if (!Array.isArray(rows) || rows.some(row => !row || typeof row !== "object" || Array.isArray(row))) {
      throw new Error(`${key} deve ser uma lista de objetos.`);
    }
    return rows as Array<Record<string, unknown>>;
  };
  const configurations = readRecords("configurations");
  const resources = readRecords("resources");
  const tasks = readRecords("tasks");
  const instances = readRecords("programInstances");
  const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const uniqueNames = (rows: Array<Record<string, unknown>>, label: string): Set<string> => {
    const names = new Set<string>();
    for (const row of rows) {
      if (typeof row.name !== "string" || !identifier.test(row.name) || names.has(row.name.toUpperCase())) {
        throw new Error(`${label}: nome invÃ¡lido ou duplicado (${String(row.name ?? "")}).`);
      }
      names.add(row.name.toUpperCase());
    }
    return names;
  };
  const configurationNames = uniqueNames(configurations, "Configurations");
  const resourceNames = uniqueNames(resources, "Resources");
  const taskNames = uniqueNames(tasks, "Tasks");
  uniqueNames(instances, "Program instances");
  for (const task of tasks) {
    const interval = Number(task.intervalMs);
    const priority = Number(task.priority ?? 0);
    const eventVariable = task.eventVariable;
    if (typeof eventVariable === "string" && eventVariable.trim()) {
      if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(eventVariable.trim())) throw new Error(`Task ${String(task.name)} tem uma variável de evento inválida.`);
      const assignedPrograms = instances.filter(instance => !instance.task || (typeof instance.task === "string" && instance.task.toUpperCase() === String(task.name).toUpperCase()))
        .map(instance => source.pous.find(pou => pou.kind === "program" && pou.pouId === instance.pouId)).filter((pou): pou is PouDefinition => !!pou);
      if (assignedPrograms.length === 0 || assignedPrograms.some(pou => !pou.interface.variables.some(variable => variable.name.toUpperCase() === eventVariable.toUpperCase() && variable.class === "input" && variable.type.toUpperCase() === "BOOL"))) {
        throw new Error(`Task ${String(task.name)} precisa referenciar uma entrada BOOL de cada PROGRAM associado.`);
      }
    } else if (!Number.isFinite(interval) || interval <= 0) throw new Error(`Task ${String(task.name)} precisa de intervalo cÃ­clico maior que zero.`);
    if (!Number.isInteger(priority)) throw new Error(`Prioridade da task ${String(task.name)} deve ser inteira.`);
  }
  for (const resource of resources) {
    const assigned = Array.isArray(resource.tasks) ? resource.tasks : resource.task ? [resource.task] : [];
    if (assigned.some(name => typeof name !== "string" || !taskNames.has(name.toUpperCase()))) {
      throw new Error(`Resource ${String(resource.name)} referencia task inexistente.`);
    }
  }
  for (const configuration of configurations) {
    if (configuration.resource !== undefined && (typeof configuration.resource !== "string" || !resourceNames.has(configuration.resource.toUpperCase()))) {
      throw new Error(`Configuration ${String(configuration.name)} referencia resource inexistente.`);
    }
  }
  for (const instance of instances) {
    const pou = source.pous.find(candidate => candidate.kind === "program" && candidate.pouId === instance.pouId);
    if (!pou) throw new Error(`InstÃ¢ncia ${String(instance.name)} precisa apontar para um POU PROGRAM existente.`);
    if (instance.task !== undefined && (typeof instance.task !== "string" || !taskNames.has(instance.task.toUpperCase()))) {
      throw new Error(`InstÃ¢ncia ${String(instance.name)} referencia task inexistente.`);
    }
  }
  const project = clone(source);
  project.configurations = structuredClone(configurations);
  project.resources = structuredClone(resources);
  project.tasks = structuredClone(tasks);
  project.programInstances = structuredClone(instances);
  if (typeof encoded.entryConfiguration === "string") {
    if (!configurationNames.has(encoded.entryConfiguration.toUpperCase())) throw new Error("entryConfiguration nÃ£o existe.");
    project.buildSettings = { ...project.buildSettings, entryConfiguration: encoded.entryConfiguration };
  }
  return project;
}

/** Authoring editor for project TYPE declarations and GVLs. The serialized model stays typed and
 * round-trips through build snapshots rather than being hidden in POU text. */
export function updateProjectData(source: IecProjectAuthoring, dataTypesValue: unknown, globalListsValue: unknown): IecProjectAuthoring {
  const project = clone(source);
  let dataTypes: unknown, globalLists: unknown;
  try { dataTypes = JSON.parse(String(dataTypesValue)); } catch { throw new Error("Tipos IEC devem ser um JSON válido."); }
  try { globalLists = JSON.parse(String(globalListsValue)); } catch { throw new Error("GVLs devem ser um JSON válido."); }
  if (!Array.isArray(dataTypes) || !Array.isArray(globalLists)) throw new Error("Tipos IEC e GVLs devem ser listas JSON.");
  const identifier = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const types = dataTypes as IecDataType[];
  const typeNames = new Set<string>();
  for (const type of types) {
    if (!type || typeof type.name !== "string" || !identifier.test(type.name) || typeNames.has(type.name.toUpperCase())) throw new Error("Nome de tipo IEC inválido ou duplicado.");
    typeNames.add(type.name.toUpperCase());
    if (type.kind === "alias" && typeof type.baseType !== "string") throw new Error(`Tipo base ausente em ${type.name}.`);
    if (type.kind === "enum" && (!Array.isArray(type.values) || type.values.length === 0 || type.values.some(value => typeof value !== "string" || !identifier.test(value)))) throw new Error(`Enumeração inválida em ${type.name}.`);
    if (type.kind === "struct" && (!Array.isArray(type.fields) || type.fields.some(field => !field || !identifier.test(field.name) || typeof field.type !== "string"))) throw new Error(`Estrutura inválida em ${type.name}.`);
    if (type.kind === "array" && (!Array.isArray(type.dimensions) || type.dimensions.length === 0 || typeof type.elementType !== "string")) throw new Error(`Array inválido em ${type.name}.`);
    if (!["alias", "enum", "struct", "array"].includes(type.kind)) throw new Error(`Categoria de tipo IEC inválida em ${type.name}.`);
  }
  const lists = globalLists as IecGlobalVariableList[];
  const listNames = new Set<string>(), globalNames = new Set<string>();
  for (const list of lists) {
    if (!list || typeof list.name !== "string" || !identifier.test(list.name) || listNames.has(list.name.toUpperCase()) || !Array.isArray(list.variables)) throw new Error("GVL inválida ou duplicada.");
    listNames.add(list.name.toUpperCase());
    for (const variable of list.variables) {
      if (!variable || typeof variable.name !== "string" || !identifier.test(variable.name) || globalNames.has(variable.name.toUpperCase()) || typeof variable.type !== "string") throw new Error(`Variável global inválida ou duplicada: ${variable?.name ?? ""}.`);
      globalNames.add(variable.name.toUpperCase());
      variable.class = "local";
    }
  }
  project.dataTypes = structuredClone(types);
  project.globalVariableLists = structuredClone(lists);
  return project;
}

/** Rede LD vazia: uma linha de seis posições entre as barras de alimentação. */
export function emptyLdRung(rungId: string): LdRung {
  return { rungId, rows: [[null, null, null, null, null, null]], verticals: [] };
}

/** Editor gráfico do LD: substitui as redes. */
export function updateLdRungs(source: IecProjectAuthoring, pouId: string, value: unknown): IecProjectAuthoring {
  const project = clone(source);
  const pou = project.pous.find(item => item.pouId === pouId);
  if (!pou || pou.implementation.language !== "ld") throw new Error("o POU não é LD");
  if (!Array.isArray(value) || value.some(rung => !rung || typeof rung.rungId !== "string" || !Array.isArray(rung.rows) || !Array.isArray(rung.verticals))) {
    throw new Error("redes LD inválidas");
  }
  pou.implementation = { language: "ld", networks: pou.implementation.networks, rungs: structuredClone(value) as LdRung[] };
  return project;
}

/** Editor FBD: valida e substitui as redes preservando a identidade estável de cada nó e fio. */
export function updateFbdNetworks(source: IecProjectAuthoring, pouId: string, value: unknown): IecProjectAuthoring {
  const project = clone(source);
  const pou = project.pous.find(item => item.pouId === pouId);
  if (!pou || pou.implementation.language !== "fbd") throw new Error("o POU não é FBD");
  if (!Array.isArray(value) || value.some(network => !network || typeof network.networkId !== "string" ||
    !Array.isArray(network.nodes) || !Array.isArray(network.edges))) throw new Error("redes FBD inválidas");
  pou.implementation = { language: "fbd", networks: structuredClone(value) as Extract<PouBody, { language: "fbd" }>["networks"] };
  return project;
}

/** Editor gráfico do SFC: substitui o corpo inteiro (passos, transições, ações). */
export function updateSfcBody(source: IecProjectAuthoring, pouId: string, value: unknown): IecProjectAuthoring {
  const project = clone(source);
  const pou = project.pous.find(item => item.pouId === pouId);
  if (!pou || pou.implementation.language !== "sfc") throw new Error("o POU não é SFC");
  const body = value as Partial<Extract<PouBody, { language: "sfc" }>> | undefined;
  if (!body || !Array.isArray(body.steps) || !Array.isArray(body.transitions) || (body.actions !== undefined && !Array.isArray(body.actions))) {
    throw new Error("corpo SFC inválido");
  }
  pou.implementation = {
    language: "sfc",
    steps: structuredClone(body.steps),
    transitions: structuredClone(body.transitions),
    actions: structuredClone(body.actions ?? []),
  };
  return project;
}

export function updatePouInterface(source: IecProjectAuthoring, pouId: string, value: unknown): IecProjectAuthoring {
  const project = clone(source);
  const pou = project.pous.find(item => item.pouId === pouId);
  if (!pou || !value || typeof value !== "object" || !Array.isArray((value as { variables?: unknown }).variables)) {
    throw new Error("invalid POU interface");
  }
  pou.interface = structuredClone(value) as PouDefinition["interface"];
  return project;
}
