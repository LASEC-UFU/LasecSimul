import { stateSpaceToTf } from "./webview/controlDesigner/lti";

export interface RationalModel { num: number[]; den: number[]; domain?: "continuous" | "discrete"; sampleTime?: number; stateSpace?: { A: number[][]; B: number[]; C: number[]; D: number } }
export interface CircuitSignalBlock {
  id?: string;
  typeId: string;
  label: string;
  properties: Record<string, string | number | boolean | string[]>;
}
type CircuitEndpoint = { kind: "node"; nodeId: string } | { kind: "port"; componentId: string; pinId: string };
export interface SeriesCircuitInput {
  components: readonly (CircuitSignalBlock & { id: string })[];
  conductors: readonly { from: CircuitEndpoint; to: CircuitEndpoint }[];
  selectedComponentIds: readonly string[];
}
export interface AppliedController {
  properties: Record<string, string | number | boolean>;
  representation: string;
}

export function signalBlockSignature(block: CircuitSignalBlock): string {
  const sorted = Object.fromEntries(Object.entries(block.properties).sort(([a], [b]) => a.localeCompare(b)));
  return JSON.stringify([block.typeId, sorted]);
}

function coefficients(values: readonly number[]): number[] {
  if (!values.length || values.some((value) => !Number.isFinite(value))) throw new Error("Coeficientes precisam ser números reais finitos.");
  let index = 0;
  while (index < values.length - 1 && values[index] === 0) index++;
  return values.slice(index);
}

/** Converts only exact, delay-free LTI blocks; FOPDT is intentionally not approximated. */
export function signalBlockToTransfer(block: CircuitSignalBlock): RationalModel | undefined {
  const p = block.properties;
  const number = (key: string, fallback: number) => typeof p[key] === "number" ? p[key] as number : fallback;
  const finiteModel = (model: RationalModel): RationalModel | undefined =>
    [...model.num, ...model.den].every(Number.isFinite) ? model : undefined;
  if (block.typeId === "control.state_space") {
    try {
      const stateSpace = { A: JSON.parse(String(p.A)) as number[][], B: JSON.parse(String(p.B)) as number[], C: JSON.parse(String(p.C)) as number[], D: number("D", 0) };
      const domain = p.domain === "discrete" ? "discrete" : "continuous";
      const sampleTime = domain === "discrete" ? number("samplePeriodNs", 0) / 1e9 : undefined;
      const model = stateSpaceToTf({ ...stateSpace, domain, sampleTime });
      return finiteModel({ ...model, stateSpace });
    } catch { return undefined; }
  }
  if (block.typeId === "control.transfer_function" && p.model === "discrete_transfer_function") {
    if (typeof p.numeratorCoefficients !== "string" || typeof p.denominatorCoefficients !== "string" || typeof p.samplePeriodNs !== "number" || !(p.samplePeriodNs > 0)) return undefined;
    const num = p.numeratorCoefficients.split(",").map((value) => Number(value.trim()));
    const den = p.denominatorCoefficients.split(",").map((value) => Number(value.trim()));
    if (!num.length || den.length < 2 || num.length > den.length || den[0] === 0 || [...num, ...den].some((value) => !Number.isFinite(value))) return undefined;
    const leading = den[0]!;
    return finiteModel({ num: num.map((value) => value / leading), den: den.map((value) => value / leading), domain: "discrete", sampleTime: p.samplePeriodNs / 1e9 });
  }
  if (block.typeId === "control.gain") return finiteModel({ num: [number("gain", 1)], den: [1] });
  if (block.typeId === "control.probe") return { num: [1], den: [1] };
  if (block.typeId === "control.first_order" || (block.typeId === "control.transfer_function" && p.model === "first_order")) {
    const gain = number("gain", 1), tau = number("tau", 1);
    if (!(tau > 0) || !Number.isFinite(tau)) return undefined;
    return finiteModel({ num: [gain], den: [tau, 1] });
  }
  if (block.typeId === "control.second_order" || (block.typeId === "control.transfer_function" && p.model === "second_order")) {
    const gain = number("gain", 1), omega = number("omega", 1), zeta = number("zeta", 1);
    if (!(omega > 0) || zeta < 0) return undefined;
    return finiteModel({ num: [gain * omega * omega], den: [1, 2 * zeta * omega, omega * omega] });
  }
  if (block.typeId === "control.lead_lag" || (block.typeId === "control.transfer_function" && p.model === "lead_lag")) {
    const gain = number("gain", 1), lead = number("leadTau", 0), lag = number("lagTau", 1);
    if (lead < 0 || !(lag > 0)) return undefined;
    return finiteModel({ num: [gain * lead, gain], den: [lag, 1] });
  }
  return undefined;
}

/** Solves a selected linear signal network, including parallel branches and feedback. */
export function selectedSeriesNetworkToTransfer(input: SeriesCircuitInput): RationalModel | undefined {
  const ids = [...new Set(input.selectedComponentIds)];
  if (ids.length < 2) return undefined;
  const byId = new Map(input.components.map((component) => [component.id, component]));
  const blocks = ids.map((id) => byId.get(id));
  if (blocks.some((block) => !block)) throw new Error("Um ou mais componentes selecionados não existem mais no circuito.");
  const selected = blocks as Array<CircuitSignalBlock & { id: string }>;
  if (selected.length > 16) throw new Error("Selecione no máximo 16 blocos por importação de rede.");
  const parent = new Map<string, string>();
  const key = (endpoint: CircuitEndpoint) => endpoint.kind === "node" ? `node:${endpoint.nodeId}` : `port:${endpoint.componentId}:${endpoint.pinId}`;
  const find = (value: string): string => {
    const current = parent.get(value);
    if (!current) { parent.set(value, value); return value; }
    if (current === value) return value;
    const root = find(current); parent.set(value, root); return root;
  };
  const union = (left: string, right: string) => { const a = find(left), b = find(right); if (a !== b) parent.set(b, a); };
  for (const conductor of input.conductors) union(key(conductor.from), key(conductor.to));
  const net = (id: string, pinId: string) => find(`port:${id}:${pinId}`);
  type Rat = RationalModel;
  const trim = (p: number[]) => { while (p.length > 1 && Math.abs(p[0]!) < 1e-13) p.shift(); return p; };
  const mulP = (a: number[], b: number[]) => { const o = Array(a.length + b.length - 1).fill(0) as number[]; a.forEach((x,i)=>b.forEach((y,j)=>o[i+j]!+=x*y)); return trim(o); };
  const addP = (a: number[], b: number[]) => { const n=Math.max(a.length,b.length), o=Array(n).fill(0) as number[]; a.forEach((x,i)=>o[n-a.length+i]=o[n-a.length+i]!+x); b.forEach((x,i)=>o[n-b.length+i]=o[n-b.length+i]!+x); return trim(o); };
  const scaleP = (a:number[],s:number) => trim(a.map(x=>x*s));
  const norm = (r:Rat):Rat => { const n=trim([...r.num]),d=trim([...r.den]); if (!d.some(x=>Math.abs(x)>1e-13)) throw new Error("A rede contém uma malha algébrica singular."); const k=d[0]!; return {num:scaleP(n,1/k),den:scaleP(d,1/k)}; };
  const zero:Rat={num:[0],den:[1]}, one:Rat={num:[1],den:[1]};
  const add=(a:Rat,b:Rat)=>norm({num:addP(mulP(a.num,b.den),mulP(b.num,a.den)),den:mulP(a.den,b.den)});
  const neg=(a:Rat):Rat=>({num:scaleP(a.num,-1),den:a.den});
  const sub=(a:Rat,b:Rat)=>add(a,neg(b));
  const mul=(a:Rat,b:Rat)=>norm({num:mulP(a.num,b.num),den:mulP(a.den,b.den)});
  const div=(a:Rat,b:Rat)=>norm({num:mulP(a.num,b.den),den:mulP(a.den,b.num)});
  const isZero=(a:Rat)=>a.num.every(x=>Math.abs(x)<1e-11);
  type EquationBlock={block:typeof selected[number]; inputs:string[]; gains:Rat[]};
  const equations:EquationBlock[]=[];
  let dynamicDomain: "continuous" | "discrete" | undefined, dynamicSampleTime: number | undefined;
  for (const block of selected) {
    const p=block.properties;
    if (block.typeId === "control.sum" || block.typeId === "control.subtract") {
      let pins = Array.isArray(p.inputs) ? (p.inputs as unknown[]).filter((v):v is string=>typeof v==="string")
        : typeof p.inputs === "string" ? p.inputs.split(",").map(v=>v.trim()).filter(Boolean) : [];
      if (!pins.length) pins = ["in0","in1"];
      if (block.typeId === "control.subtract" && pins.length < 2) pins=["in0","in1"];
      equations.push({block,inputs:pins.map(pin=>net(block.id,pin)),gains:pins.map((_,i)=>({num:[block.typeId === "control.subtract" && i===1 ? -1:1],den:[1]}))});
    } else {
      const model=signalBlockToTransfer(block);
      if (!model) throw new Error(`“${block.label}” não é um bloco LTI, soma, subtração ou sonda compatível.`);
      if ([...model.num,...model.den].some(v=>!Number.isFinite(v))) throw new Error(`Os coeficientes de “${block.label}” excedem a faixa numérica suportada.`);
      if (model.den.length > 1) {
        const domain = model.domain ?? "continuous";
        if (dynamicDomain && dynamicDomain !== domain) throw new Error("A rede contém dinâmicas contínuas e discretas; converta os blocos explicitamente antes de importar.");
        if (domain === "discrete" && dynamicSampleTime !== undefined && Math.abs(dynamicSampleTime - model.sampleTime!) > 1e-12 * Math.max(1, dynamicSampleTime, model.sampleTime!))
          throw new Error("A rede contém blocos discretos com Ts diferentes; reamostre explicitamente antes de importar.");
        dynamicDomain = domain;
        if (domain === "discrete") dynamicSampleTime = model.sampleTime;
      }
      equations.push({block,inputs:[net(block.id,"in")],gains:[model]});
    }
  }
  const drivers=new Map<string,EquationBlock>();
  for (const equation of equations) { const root=net(equation.block.id,"out"); if (drivers.has(root)) throw new Error("Há mais de uma saída de bloco na mesma rede; a importação exige um único driver por nó."); drivers.set(root,equation); }
  const inputRoots=new Set(equations.flatMap(e=>e.inputs));
  const sources=[...new Set(equations.flatMap(e=>e.inputs.filter(root=>!drivers.has(root))))];
  if (sources.length!==1) throw new Error("A rede selecionada precisa ter exatamente uma entrada externa sem driver.");
  const sinks=[...drivers.keys()].filter(root=>!inputRoots.has(root));
  if (sinks.length!==1) throw new Error("A rede precisa ter uma única saída aberta; inclua uma sonda control.probe no nó de saída quando ele também alimenta a realimentação.");
  const roots=[...drivers.keys()], index=new Map(roots.map((root,i)=>[root,i]));
  const matrix=equations.map(()=>Array.from({length:roots.length+1},()=>zero));
  equations.forEach((equation,row)=>{
    const y=net(equation.block.id,"out"), yi=index.get(y)!;
    matrix[row]![yi]=one;
    equation.inputs.forEach((root,j)=>{
      const gain=equation.gains[j]!;
      if (drivers.has(root)) { const col=index.get(root)!; matrix[row]![col]=sub(matrix[row]![col]!,gain); }
      else matrix[row]![roots.length]=add(matrix[row]![roots.length]!,gain);
    });
  });
  for(let col=0;col<roots.length;col++){
    let pivot=col; while(pivot<roots.length&&isZero(matrix[pivot]![col]!)) pivot++;
    if(pivot===roots.length) throw new Error("A realimentação forma uma malha singular ou sem solução única.");
    [matrix[col],matrix[pivot]]=[matrix[pivot]!,matrix[col]!];
    const p=matrix[col]![col]!; for(let j=col;j<=roots.length;j++) matrix[col]![j]=div(matrix[col]![j]!,p);
    for(let row=0;row<roots.length;row++) if(row!==col){ const factor=matrix[row]![col]!; if(isZero(factor)) continue; for(let j=col;j<=roots.length;j++) matrix[row]![j]=sub(matrix[row]![j]!,mul(factor,matrix[col]![j]!)); }
  }
  const result=matrix[index.get(sinks[0]!)!]![roots.length]!;
  if ([...result.num,...result.den].some(v=>!Number.isFinite(v)) || Math.max(result.num.length,result.den.length)>24) throw new Error("A rede excede o limite numérico de ordem 24.");
  return { ...result, ...(dynamicDomain ? { domain: dynamicDomain } : {}), ...(dynamicSampleTime !== undefined ? { sampleTime: dynamicSampleTime } : {}) };
}

/** Maps rational controllers to the exact forms currently supported by circuit blocks. */
export function controllerToBlockProperties(model: RationalModel, destinationType: string): AppliedController {
  if (destinationType !== "control.transfer_function" && destinationType !== "control.gain") {
    throw new Error("O destino precisa ser control.transfer_function ou control.gain.");
  }
  const n = coefficients(model.num), d = coefficients(model.den);
  if (n.length > d.length || d.every((value) => value === 0)) throw new Error("Controlador impróprio ou denominador inválido.");
  const gain = n[0]! / d[0]!;
  if (d.length === 1 && n.length === 1) {
    if (destinationType !== "control.gain") throw new Error("Use um bloco control.gain para aplicar um controlador puramente estático.");
    return { representation: "ganho estático", properties: { gain } };
  }
  if (d.length === 2 && n.length === 1) {
    const tau = d[0]! / d[1]!;
    if (!(tau > 0)) throw new Error("A constante de tempo precisa ser positiva.");
    return { representation: "first_order", properties: { model: "first_order", gain: n[0]! / d[1]!, tau } };
  }
  if (d.length === 3 && n.length === 1) {
    const den = d.map((value) => value / d[0]!), omega = Math.sqrt(den[2]!);
    if (!(omega > 0)) throw new Error("O denominador não corresponde a uma segunda ordem representável.");
    const zeta = den[1]! / (2 * omega);
    if (zeta < 0) throw new Error("O bloco requer amortecimento não negativo.");
    return { representation: "second_order", properties: { model: "second_order", gain: n[0]! / d[2]!, omega, zeta } };
  }
  if (d.length === 2 && n.length === 2 && n[1] !== 0 && d[1] !== 0) {
    const leadTau = n[0]! / n[1]!, lagTau = d[0]! / d[1]!;
    if (leadTau < 0 || !(lagTau > 0)) throw new Error("Avanço-atraso requer constantes de tempo não negativas e atraso positivo.");
    return { representation: "lead_lag", properties: { model: "lead_lag", gain: n[1]! / d[1]!, leadTau, lagTau } };
  }
  throw new Error("O bloco representa apenas primeira/segunda ordem ou avanço-atraso de primeira ordem. A forma atual de C exigiria aproximação.");
}
