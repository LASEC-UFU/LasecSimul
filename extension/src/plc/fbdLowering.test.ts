import { strict as assert } from "assert";
import { IecProjectStore, PouBody, PouDefinition } from "./iecProject";
import { lowerFbdBodyToSt, lowerFbdToSt, validateFbd } from "./fbdLowering";

function run(): void {
  const store = new IecProjectStore();
  const timer: PouDefinition = {
    pouId: "fb-motor", name: "FB_MOTOR", kind: "functionBlock",
    interface: { variables: [
      { ioId: "enable", name: "Enable", class: "input", type: "BOOL" },
      { ioId: "running", name: "Running", class: "output", type: "BOOL" },
    ] },
    implementation: { language: "st", text: "Running := Enable;" },
  };
  const scale: PouDefinition = {
    pouId: "fc-scale", name: "FC_SCALE", kind: "function",
    interface: { returnType: "REAL", variables: [{ ioId: "in", name: "Value", class: "input", type: "REAL" }] },
    implementation: { language: "st", text: "FC_SCALE := Value * 2.0;" },
  };
  const caller: PouDefinition = {
    pouId: "main", name: "MAIN", kind: "program",
    interface: { variables: [
      { ioId: "a", name: "A", class: "input", type: "BOOL" },
      { ioId: "b", name: "B", class: "input", type: "BOOL" },
      { ioId: "q", name: "Q", class: "output", type: "BOOL" },
      { name: "motor", class: "local", type: "FB_MOTOR" },
    ] },
    implementation: { language: "fbd", networks: [{ networkId: "logic", nodes: [
      { nodeId: "a", kind: "input", symbol: "A" }, { nodeId: "b", kind: "input", symbol: "B" },
      { nodeId: "and", kind: "operator", operator: "AND" }, { nodeId: "q", kind: "output", symbol: "Q" },
    ], edges: [
      { edgeId: "a-and", fromNodeId: "a", fromPort: "OUT", toNodeId: "and", toPort: "A" },
      { edgeId: "b-and", fromNodeId: "b", fromPort: "OUT", toNodeId: "and", toPort: "B" },
      { edgeId: "and-q", fromNodeId: "and", fromPort: "OUT", toNodeId: "q", toPort: "IN" },
    ] }] },
  };
  assert.deepEqual(store.savePou(timer), []);
  assert.deepEqual(store.savePou(scale), []);
  assert.deepEqual(store.savePou(caller), []);
  assert.deepEqual(store.addReference(caller.pouId, timer.pouId, "ref-motor", "motor"), []);
  assert.match(lowerFbdToSt(caller, store).join("\n"), /Q := \(A\) AND \(B\);/);

  const sum: PouDefinition = {
    pouId: "sum", name: "FC_SUM", kind: "function", interface: { returnType: "DINT", variables: [] },
    implementation: { language: "fbd", networks: [{ networkId: "sum", nodes: [
      { nodeId: "one", kind: "input", symbol: "1" }, { nodeId: "two", kind: "input", symbol: "2" },
      { nodeId: "three", kind: "input", symbol: "3" }, { nodeId: "add", kind: "operator", operator: "ADD" },
      { nodeId: "result", kind: "output", symbol: "FC_SUM" },
    ], edges: [
      { edgeId: "one", fromNodeId: "one", toNodeId: "add", toPort: "A" },
      { edgeId: "two", fromNodeId: "two", toNodeId: "add", toPort: "B" },
      { edgeId: "three", fromNodeId: "three", toNodeId: "add", toPort: "C" },
      { edgeId: "result", fromNodeId: "add", toNodeId: "result", toPort: "IN" },
    ] }] },
  };
  assert.match(lowerFbdToSt(sum, store).join("\n"), /FC_SUM := \(1\) \+ \(2\) \+ \(3\);/, "variadic ADD folds all named ports");

  store.saveLibraryPou({ namespace: "IEC", pouId: "iec-add", name: "ADD", kind: "function", system: true, enabled: true, extensible: true,
    interface: { returnType: "ANY_NUM", variables: [{ ioId: "iec-add-IN1", name: "IN1", class: "input", type: "ANY_NUM" }] } });
  const variadicFunction: PouDefinition = {
    pouId: "variadic-add", name: "VARIADIC_ADD", kind: "program", interface: { variables: [{ ioId: "OUT", name: "OUT", class: "output", type: "DINT" }] },
    implementation: { language: "fbd", networks: [{ networkId: "add", nodes: [
      { nodeId: "one", kind: "input", symbol: "1" }, { nodeId: "two", kind: "input", symbol: "2" }, { nodeId: "three", kind: "input", symbol: "3" },
      { nodeId: "add", kind: "block", referencedPouId: "iec-add" }, { nodeId: "out", kind: "output", symbol: "OUT" },
    ], edges: [
      { edgeId: "one", fromNodeId: "one", toNodeId: "add", toPort: "IN1" },
      { edgeId: "two", fromNodeId: "two", toNodeId: "add", toPort: "IN2" },
      { edgeId: "three", fromNodeId: "three", toNodeId: "add", toPort: "IN3" },
      { edgeId: "result", fromNodeId: "add", fromPort: "OUT", toNodeId: "out", toPort: "IN" },
    ] }] },
  };
  assert.match(lowerFbdToSt(variadicFunction, store).join("\n"), /OUT := ADD\(IN1 := 1, IN2 := 2, IN3 := 3\);/);
  assert.deepEqual(validateFbd(variadicFunction, store), [], "generic ANY_NUM ports accept resolved integer literals");

  const fbd = store.getPou(caller.pouId)!;
  fbd.implementation = { language: "fbd", networks: [{ networkId: "motor", nodes: [
    { nodeId: "input", kind: "input", symbol: "A" },
    { nodeId: "fb", kind: "block", referencedPouId: timer.pouId, instanceName: "motor" },
    { nodeId: "output", kind: "output", symbol: "Q" },
  ], edges: [
    { edgeId: "enable", fromNodeId: "input", fromPort: "OUT", toNodeId: "fb", toPort: "Enable" },
    { edgeId: "running", fromNodeId: "fb", fromPort: "Running", toNodeId: "output", toPort: "IN" },
  ] }] };
  assert.deepEqual(store.savePou(fbd), []);
  assert.deepEqual(lowerFbdToSt(fbd, store), ["motor.Enable := A;", "motor();", "Q := motor.Running;"]);
  assert.deepEqual(validateFbd(fbd, store), []);

  const feedback = structuredClone(fbd);
  feedback.implementation = { language: "fbd", networks: [{ networkId: "feedback", nodes: [
    { nodeId: "fb", kind: "block", referencedPouId: timer.pouId, instanceName: "motor" },
    { nodeId: "q", kind: "output", symbol: "Q" },
  ], edges: [
    { edgeId: "loop", fromNodeId: "fb", fromPort: "Running", toNodeId: "fb", toPort: "Enable", feedback: true, feedbackInitialValue: "FALSE" },
    { edgeId: "result", fromNodeId: "fb", fromPort: "Running", toNodeId: "q", toPort: "IN" },
  ] }] };
  const loweredFeedback = lowerFbdBodyToSt(feedback, store);
  assert.deepEqual(loweredFeedback.declarations, ["__FBD_DELAY_feedback_loop : BOOL := FALSE;"]);
  assert.deepEqual(loweredFeedback.lines, ["motor.Enable := __FBD_DELAY_feedback_loop;", "motor();", "Q := motor.Running;", "__FBD_DELAY_feedback_loop := motor.Running;"]);

  const fanout = structuredClone(fbd);
  fanout.implementation = { language: "fbd", networks: [{ networkId: "fanout", nodes: [
    { nodeId: "a", kind: "input", symbol: "A" }, { nodeId: "j", kind: "junction" },
    { nodeId: "q1", kind: "output", symbol: "Q" }, { nodeId: "q2", kind: "output", symbol: "Q2" },
  ], edges: [
    { edgeId: "a-j", fromNodeId: "a", toNodeId: "j", toPort: "IN" },
    { edgeId: "j-q1", fromNodeId: "j", fromPort: "OUT", toNodeId: "q1", toPort: "IN" },
    { edgeId: "j-q2", fromNodeId: "j", fromPort: "OUT", toNodeId: "q2", toPort: "IN" },
  ] }] };
  assert.deepEqual(lowerFbdToSt(fanout, store), ["Q := A;", "Q2 := A;"]);

  const bad = store.getPou(fbd.pouId)!;
  (bad.implementation as Extract<PouBody, { language: "fbd" }>).networks[0]!.edges[0]!.toPort = "missing";
  assert(validateFbd(bad, store).some(item => /input port missing/.test(item.message)));
  const badType = store.getPou(fbd.pouId)!;
  const badTypeNetwork = (badType.implementation as Extract<PouBody, { language: "fbd" }>).networks[0]!;
  badTypeNetwork.nodes[0]!.symbol = "1";
  assert(validateFbd(badType, store).some(item => /tipo incompatível/.test(item.message)), "DINT cannot connect to a BOOL formal");
  const cycle = store.getPou(caller.pouId)!;
  (cycle.implementation as Extract<PouBody, { language: "fbd" }>).networks[0]!.edges.push({ edgeId: "cycle", fromNodeId: "q", toNodeId: "and", toPort: "A" });
  assert.throws(() => lowerFbdToSt(cycle, store), /cycle/);
  console.log("FBD lowering, named ports, type diagnostics and cycle rejection: OK");
}

run();
