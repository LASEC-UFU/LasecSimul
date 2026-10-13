import { IecLanguage, IecProjectAuthoring } from "./iecProject";

/** Projeto novo: PROGRAM MAIN com DI0 -> DO0, na linguagem escolhida. */
export function starterIecProject(projectId: string, language: IecLanguage = "st"): IecProjectAuthoring {
  return {
    schemaVersion: 1,
    projectId,
    dataTypes: [],
    globalVariableLists: [],
    configurations: [{ name: "CONFIGURATION_1", resource: "RESOURCE_1" }],
    resources: [{ name: "RESOURCE_1", task: "MAIN_TASK" }],
    tasks: [{ name: "MAIN_TASK", intervalMs: 10, priority: 1 }],
    programInstances: [{ name: "MAIN_INSTANCE", pouId: "pou-main", task: "MAIN_TASK" }],
    pous: [{
      pouId: "pou-main",
      name: "MAIN",
      kind: "program",
      interface: { variables: [
        { ioId: "DI0", name: "DI0", class: "input", type: "BOOL" },
        { ioId: "DO0", name: "DO0", class: "output", type: "BOOL" },
      ] },
      implementation: language === "il"
        ? { language: "il", text: "LD DI0\nST DO0" }
        : language === "ld"
          ? { language: "ld", networks: [], rungs: [{ rungId: "rung-1", rows: [[null, null, null, null, null, null]], verticals: [] }] }
          : language === "fbd"
            ? { language: "fbd", networks: [{ networkId: "network-1", nodes: [], edges: [] }] }
            : language === "sfc"
              ? { language: "sfc", steps: [{ stepId: "step-1", name: "Initial", initial: true, actions: [] }], transitions: [], actions: [] }
              : { language: "st", text: "DO0 := DI0;" },
    }],
    libraries: [],
    buildSettings: { entryConfiguration: "CONFIGURATION_1" },
  };
}
