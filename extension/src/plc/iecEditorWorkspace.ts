import { IEC_LANGUAGES, IecLanguage, IecProjectAuthoring, PouBody, PouDefinition, signatureOf } from "./iecProject";

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
    implementation = { language, steps: [{ stepId: "step-1", name: "Initial", initial: true, actions: [] }], transitions: [] };
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

export function updatePouInterface(source: IecProjectAuthoring, pouId: string, value: unknown): IecProjectAuthoring {
  const project = clone(source);
  const pou = project.pous.find(item => item.pouId === pouId);
  if (!pou || !value || typeof value !== "object" || !Array.isArray((value as { variables?: unknown }).variables)) {
    throw new Error("invalid POU interface");
  }
  pou.interface = structuredClone(value) as PouDefinition["interface"];
  return project;
}
