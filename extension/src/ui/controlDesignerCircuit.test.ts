import { createTestRunner, assert as assertWithMessage } from "../ipc/testSupport/MockCoreServer";
import { controllerToBlockProperties, selectedSeriesNetworkToTransfer, signalBlockToTransfer, type SeriesCircuitInput } from "./controlDesignerCircuit";
const assert = (condition: boolean, message = "falhou"): void => assertWithMessage(condition, message);
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

(async () => {
  const { test, finish } = createTestRunner("Projeto de Controladores — integração com blocos");
  await test("importa exatamente ganho, primeira ordem, segunda ordem e avanço-atraso", () => {
    const gain = signalBlockToTransfer({ typeId: "control.gain", label: "K", properties: { gain: 4 } });
    const first = signalBlockToTransfer({ typeId: "control.first_order", label: "P1", properties: { gain: 2, tau: 3 } });
    const second = signalBlockToTransfer({ typeId: "control.second_order", label: "P2", properties: { gain: 2, omega: 3, zeta: .5 } });
    const leadLag = signalBlockToTransfer({ typeId: "control.lead_lag", label: "LL", properties: { gain: 2, leadTau: .2, lagTau: 1 } });
    assert(JSON.stringify(gain) === JSON.stringify({ num: [4], den: [1] }));
    assert(JSON.stringify(first) === JSON.stringify({ num: [2], den: [3, 1] }));
    assert(JSON.stringify(second) === JSON.stringify({ num: [18], den: [1, 3, 9] }));
    assert(JSON.stringify(leadLag) === JSON.stringify({ num: [.4, 2], den: [1, 1] }));
  });
  await test("não aproxima FOPDT nem blocos não lineares silenciosamente", () => {
    assert(signalBlockToTransfer({ typeId: "control.fopdt", label: "FOPDT", properties: { gain: 1, tau: 2, delay: .5 } }) === undefined);
    assert(signalBlockToTransfer({ typeId: "control.saturation", label: "limite", properties: {} }) === undefined);
  });
  await test("imports continuous and discrete SISO state-space blocks without losing the realization", () => {
    const continuous = signalBlockToTransfer({ typeId: "control.state_space", label: "SS", properties: { A: "[[-1]]", B: "[1]", C: "[1]", D: 0, domain: "continuous" } });
    const discrete = signalBlockToTransfer({ typeId: "control.state_space", label: "SSz", properties: { A: "[[0.5]]", B: "[1]", C: "[1]", D: 0, domain: "discrete", samplePeriodNs: 100000000 } });
    assert(continuous?.num[0] === 1 && continuous.den[0] === 1 && continuous.den[1] === 1 && continuous.stateSpace?.A[0]?.[0] === -1, JSON.stringify(continuous));
    assert(discrete?.domain === "discrete" && discrete.sampleTime === .1 && discrete.stateSpace?.A[0]?.[0] === .5, JSON.stringify(discrete));
  });  await test("aplica ganho estático somente em control.gain", () => {
    const result = controllerToBlockProperties({ num: [6], den: [3] }, "control.gain");
    assert(result.representation === "ganho estático" && result.properties.gain === 2);
    let rejected = false;
    try { controllerToBlockProperties({ num: [6], den: [3] }, "control.transfer_function"); } catch { rejected = true; }
    assert(rejected, "ganho estático aplicado em componente dinâmico sem equivalência exata");
  });
  await test("imports a discrete controller with Ts and normalized coefficients", () => {
    const model = signalBlockToTransfer({ typeId: "control.transfer_function", label: "Cz", properties: { model: "discrete_transfer_function", numeratorCoefficients: "0.2", denominatorCoefficients: "2,-1.8", samplePeriodNs: 100000000 } });
    assert(model?.domain === "discrete" && near(model.sampleTime!, .1) && near(model.num[0]!, .1) && near(model.den[1]!, -.9), JSON.stringify(model));
  });
  await test("round-trip de primeira ordem corrige normalização de coeficientes", () => {
    const result = controllerToBlockProperties({ num: [2], den: [2, 4] }, "control.transfer_function");
    assert(result.representation === "first_order" && near(Number(result.properties.gain), .5) && near(Number(result.properties.tau), .5), JSON.stringify(result));
    const model = signalBlockToTransfer({ typeId: "control.transfer_function", label: "C", properties: result.properties });
    assert(model !== undefined && near(model.num[0]! / model.den[1]!, .5) && near(model.den[0]! / model.den[1]!, .5), JSON.stringify(model));
  });
  await test("conversões de segunda ordem e avanço-atraso preservam os polinômios", () => {
    const second = controllerToBlockProperties({ num: [18], den: [2, 4, 18] }, "control.transfer_function");
    assert(second.representation === "second_order" && near(Number(second.properties.gain), 1) && near(Number(second.properties.omega), 3) && near(Number(second.properties.zeta), 1 / 3), JSON.stringify(second));
    const ll = controllerToBlockProperties({ num: [6, 3], den: [2, 4] }, "control.transfer_function");
    assert(ll.representation === "lead_lag" && near(Number(ll.properties.gain), .75) && near(Number(ll.properties.leadTau), 2) && near(Number(ll.properties.lagTau), .5), JSON.stringify(ll));
  });
  await test("rejeita controlador impróprio, não finito e dinâmicas não representáveis", () => {
    for (const model of [{ num: [1, 2], den: [1] }, { num: [1], den: [0, 0] }, { num: [NaN], den: [1] }]) {
      let rejected = false;
      try { controllerToBlockProperties(model, "control.transfer_function"); } catch { rejected = true; }
      assert(rejected, JSON.stringify(model));
    }
    let unstableRejected = false;
    try { controllerToBlockProperties({ num: [1], den: [1, -2] }, "control.transfer_function"); } catch { unstableRejected = true; }
    assert(unstableRejected);
  });
  await test("importa derivaÃ§Ãµes paralelas convergindo em um somador", () => {
    const p=(componentId:string,pinId:string)=>({kind:"port" as const,componentId,pinId});
    const node=(nodeId:string)=>({kind:"node" as const,nodeId});
    const network:SeriesCircuitInput={selectedComponentIds:["a","b","sum"],components:[
      {id:"a",typeId:"control.gain",label:"A",properties:{gain:2}},{id:"b",typeId:"control.gain",label:"B",properties:{gain:3}},
      {id:"sum",typeId:"control.sum",label:"Soma",properties:{inputs:["in0","in1"]}},
    ],conductors:[{from:p("a","in"),to:node("src")},{from:p("b","in"),to:node("src")},{from:p("a","out"),to:p("sum","in0")},{from:p("b","out"),to:p("sum","in1")}]};
    const result=selectedSeriesNetworkToTransfer(network);
    assert(result!==undefined&&near(result.num[0]!/result.den[0]!,5),JSON.stringify(result));
  });
  await test("resolve realimentaÃ§Ã£o negativa fechada com sonda na saÃ­da", () => {
    const p=(componentId:string,pinId:string)=>({kind:"port" as const,componentId,pinId});
    const network:SeriesCircuitInput={selectedComponentIds:["sum","forward","feedback","probe"],components:[
      {id:"sum",typeId:"control.sum",label:"Somador",properties:{inputs:["in0","in1"]}},
      {id:"forward",typeId:"control.gain",label:"C.G",properties:{gain:2}},{id:"feedback",typeId:"control.gain",label:"H",properties:{gain:-3}},
      {id:"probe",typeId:"control.probe",label:"SaÃ­da",properties:{}},
    ],conductors:[{from:p("sum","out"),to:p("forward","in")},{from:p("forward","out"),to:p("probe","in")},{from:p("forward","out"),to:p("feedback","in")},{from:p("feedback","out"),to:p("sum","in1")}]};
    const result=selectedSeriesNetworkToTransfer(network);
    assert(result!==undefined&&near(result.num[0]!/result.den[0]!,2/7),JSON.stringify(result));
  });
  await test("importa redes discretas mantendo Ts e recusa misturas de períodos",()=>{
    const p=(componentId:string,pinId:string)=>({kind:"port" as const,componentId,pinId});
    const base:SeriesCircuitInput={selectedComponentIds:["d1","d2"],components:[
      {id:"d1",typeId:"control.transfer_function",label:"D1",properties:{model:"discrete_transfer_function",numeratorCoefficients:"0.1",denominatorCoefficients:"1,-0.9",samplePeriodNs:100000000}},
      {id:"d2",typeId:"control.transfer_function",label:"D2",properties:{model:"discrete_transfer_function",numeratorCoefficients:"1",denominatorCoefficients:"1,-0.5",samplePeriodNs:100000000}},
    ],conductors:[{from:{kind:"node",nodeId:"src"},to:p("d1","in")},{from:p("d1","out"),to:p("d2","in")}]};
    const imported=selectedSeriesNetworkToTransfer(base);
    assert(imported?.domain==="discrete"&&imported.sampleTime===.1,JSON.stringify(imported));
    const incompatible={...base,components:base.components.map((block,index)=>index===1?{...block,properties:{...block.properties,samplePeriodNs:200000000}}:block)};
    let rejected=false;try{selectedSeriesNetworkToTransfer(incompatible)}catch{rejected=true}
    assert(rejected,"rede com Ts incompatíveis foi importada");
  });
  finish();
})();
