import { IecProjectAuthoring } from "./iecProject";

export function starterIecProject(projectId: string): IecProjectAuthoring {
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
      implementation: { language: "st", text: "DO0 := DI0;" },
    }],
    libraries: [],
    buildSettings: { entryConfiguration: "CONFIGURATION_1" },
  };
}
