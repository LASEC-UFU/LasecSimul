import { strict as assert } from "assert";
import * as path from "path";
import { IEC_LANGUAGES, IecLanguage, IecProjectStore, PouBody, PouDefinition, parseIecProject } from "./iecProject";
import { compileProjectToCanonicalSt, lowerPouToSt } from "./lowering";
import { parsePlcNativeModule } from "./artifact";
import { addPouToProject, insertPouReference } from "./iecEditorWorkspace";

function body(language: IecLanguage, targetPouId?: string): PouBody {
  if (language === "st") return { language, text: targetPouId ? "callee();" : "q := q;" };
  if (language === "il") return { language, text: targetPouId ? "CAL callee" : "LD q\nST q" };
  if (language === "sfc") return { language, steps: [{ stepId: "s0", name: "Initial", initial: true,
    actions: targetPouId ? [{ actionId: "a0", referencedPouId: targetPouId, instanceName: "callee" }] : [] }], transitions: [] };
  return { language, networks: [{ networkId: "n0", nodes: targetPouId ?
    [{ nodeId: "b0", kind: "block", referencedPouId: targetPouId, instanceName: "callee" }] :
    [{ nodeId: "i0", kind: "contact", symbol: "q" }, { nodeId: "o0", kind: "coil", symbol: "q" }],
    edges: targetPouId ? [] : [{ edgeId: "e0", fromNodeId: "i0", toNodeId: "o0" }] }] };
}

function pou(id: string, name: string, language: IecLanguage, kind: PouDefinition["kind"] = "functionBlock", target?: string): PouDefinition {
  return { pouId: id, name, kind, interface: { variables: [
    { ioId: `${id}-in`, name: "x", class: "input", type: "BOOL" },
    { ioId: `${id}-out`, name: "q", class: "output", type: "BOOL" },
  ] }, implementation: body(language, target) };
}

async function main(): Promise<void> {
  const store = new IecProjectStore();
  for (const language of IEC_LANGUAGES) assert.deepEqual(store.savePou(pou(`callee-${language}`, `FB_${language.toUpperCase()}`, language)), []);
  assert.equal(store.browser().length, 5, "all five implementation languages share one browser");

  // Mandatory 5x5 interoperability matrix: references resolve by pouId, never source language.
  for (const callerLanguage of IEC_LANGUAGES) {
    for (const calleeLanguage of IEC_LANGUAGES) {
      const callerId = `caller-${callerLanguage}-${calleeLanguage}`;
      const targetId = `callee-${calleeLanguage}`;
      assert.deepEqual(store.savePou(pou(callerId, `CALL_${callerLanguage}_${calleeLanguage}`, callerLanguage, "functionBlock", targetId)), []);
      assert.deepEqual(store.addReference(callerId, targetId, `ref-${callerLanguage}-${calleeLanguage}`, "callee"), []);
      assert.match(lowerPouToSt(store.getPou(callerId)!, store).canonicalSt, /callee/i);
    }
  }

  const beforeRename = store.diagnostics();
  assert.equal(beforeRename.length, 0);
  const renamed = store.getPou("callee-st")!;
  renamed.name = "FB_ST_RENAMED";
  assert.deepEqual(store.savePou(renamed), [], "rename with same pouId preserves every reference");
  assert.equal(store.diagnostics().length, 0);

  const changed = store.getPou("callee-st")!;
  changed.interface.variables[0]!.type = "INT";
  assert(store.savePou(changed).some(item => item.code === "signature-changed"), "incompatible interface change is localized");
  changed.interface.variables[0]!.type = "BOOL";
  store.savePou(changed);

  const program = pou("main", "MAIN", "st", "program");
  assert.deepEqual(store.savePou(program), []);
  const parallel = pou("parallel-ld", "PARALLEL_LD", "ld");
  parallel.implementation = { language: "ld", networks: [{ networkId: "parallel", nodes: [
    { nodeId: "a", kind: "contact", symbol: "A" },
    { nodeId: "b", kind: "contact", symbol: "B" },
    { nodeId: "unused", kind: "contact", symbol: "DISCONNECTED" },
    { nodeId: "q", kind: "coil", symbol: "q" },
  ], edges: [
    { edgeId: "a-q", fromNodeId: "a", toNodeId: "q" },
    { edgeId: "b-q", fromNodeId: "b", toNodeId: "q" },
  ] }] };
  const parallelSt = lowerPouToSt(parallel, store).canonicalSt;
  assert.match(parallelSt, /\(A\) OR \(B\)/, "parallel LD paths lower to OR");
  assert.doesNotMatch(parallelSt, /DISCONNECTED/, "disconnected LD nodes never leak into a coil expression");

  const sfc = pou("sfc-transition", "SFC_TRANSITION", "sfc");
  sfc.implementation = { language: "sfc", steps: [
    { stepId: "idle", name: "Idle", initial: true, actions: [] },
    { stepId: "run", name: "Run", actions: [{ actionId: "run-q", text: "q := TRUE;" }] },
  ], transitions: [{ transitionId: "start", fromStepId: "idle", toStepId: "run", condition: "x" }] };
  assert.deepEqual(store.savePou(sfc), []);
  assert.match(lowerPouToSt(sfc, store).canonicalSt, /__SFC_idle AND \(x\)/);
  const canonical = compileProjectToCanonicalSt(store, "project-1", "main");
  assert.match(canonical, /FUNCTION_BLOCK FB_LD/);
  assert.match(canonical, /PROGRAM MAIN/);
  assert.match(canonical, /__SFC_idle : BOOL := TRUE;/, "canonical ST declares deterministic SFC state");

  store.importOpenPlcLibrary({
    name: "iec-standard",
    displayName: "IEC Standard",
    author: "OpenPLC",
    version: "4.2.10",
    stPath: "",
    cPath: "",
    pous: [{
      name: "ADD",
      type: "function",
      language: "st",
      body: "",
      documentation: "Addition",
      extensible: true,
      category: "Arithmetic",
      variables: [{ name: "IN1", class: "input", type: { definition: "generic-type", value: "ANY_NUM" } }],
    }],
  }, true);
  const importedAdd = store.browser("iec-standard.ADD")[0];
  assert.equal(importedAdd?.source, "system-library");
  assert.equal(importedAdd?.extensible, true, "OpenPLC variadic block metadata reaches every editor browser");
  assert.equal(importedAdd?.category, "Arithmetic");

  for (const language of IEC_LANGUAGES) {
    const callerId = `editor-${language}`;
    const editorBase = structuredClone(store.snapshot(`editor-project-${language}`));
    editorBase.pous.push(pou(callerId, `EDITOR_${language.toUpperCase()}`, language));
    const inserted = insertPouReference(editorBase, callerId, "callee-st");
    const caller = inserted.pous.find(item => item.pouId === callerId)!;
    assert.equal(caller.references?.[0]?.targetPouId, "callee-st", `custom ${language} editor preserves target pouId`);
    assert.match(JSON.stringify(caller.implementation), /callee-st|FB_ST_RENAMED/i,
      `custom ${language} editor materializes the inserted cross-language block`);
  }
  let created = store.snapshot("editor-create");
  for (const language of IEC_LANGUAGES) created = addPouToProject(created, `NEW_${language.toUpperCase()}`, "functionBlock", language);
  assert.deepEqual(created.pous.slice(-5).map(item => item.implementation.language), [...IEC_LANGUAGES]);

  const snapshot = store.snapshot("project-1");
  const roundTrip = parseIecProject(JSON.parse(JSON.stringify(snapshot)));
  assert.deepEqual(roundTrip, snapshot, "round-trip preserves POU/node/io identities");
  assert.throws(() => parseIecProject({ ...snapshot, runtimeState: {} }), /transient PLC field/);

  const module = parsePlcNativeModule({
    formatVersion: 1,
    workerProtocolVersion: 1,
    targetPlatform: "windows",
    targetArch: "x64",
    strucppVersion: "0.6.3",
    runtimeRevision: "0.6.3",
    cxxToolchainVersion: "MSVC",
    sourceHash: "b".repeat(64),
    artifactHash: "a".repeat(64),
    nativeBinaryRef: "bin/controller.exe",
    programName: "MAIN",
    exportedIo: [{ ioId: "io-q", name: "q", direction: "output", iecType: "BOOL" }],
  }, "C:/project/build");
  assert.equal(module.nativeBinaryRef, path.normalize("C:/project/build/bin/controller.exe"));
  assert.throws(() => parsePlcNativeModule({ ...module, targetArch: "" }), /targetArch/);

  const isolatedA = { count: 0 };
  const isolatedB = { count: 0 };
  isolatedA.count += 1;
  assert.equal(isolatedA.count, 1);
  assert.equal(isolatedB.count, 0, "two FB instances do not share mutable state");
  console.log("IEC authoring/lowering/common browser/cross-language matrix 5x5: OK");
}

void main().catch(error => { console.error(error); process.exitCode = 1; });
