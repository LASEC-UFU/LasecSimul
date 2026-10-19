import { createTestRunner, assert as assertWithMessage } from "../ipc/testSupport/MockCoreServer";
import { certifyAnalyses, certifiedRealRootCount } from "./webview/controlDesigner/certification";
import { bode, closeLoop, closedLoopInitialStateResponse, controllerForm, convertDomain, convertEuler, convertZoh, fromZInverse, interpretDiscretePole, isStable, classifyStability, margins, nyquistEncirclements, polynomialRoots, poles, rootLocus, stateSpaceToTf, stepMetrics, timeResponse, timeResponseForInput, toZInverse, transferFromPolesZeros, validateTf, type TransferFunction } from "./webview/controlDesigner/lti";
const assert = (ok: boolean, message = "falhou"): void => assertWithMessage(ok, message);
const near = (a: number, b: number, tol = 1e-5) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

(async () => {
  const { test, finish } = createTestRunner("Projeto de Controladores â€” nÃºcleo LTI");
  await test("interconexÃ£o distinta de Y/R, U/R, S e T com F=H=1", () => {
    const tf = (num: number[], den: number[]): TransferFunction => ({ num, den, domain: "continuous" });
    const a = closeLoop(tf([1],[1]), tf([4],[1]), tf([1],[1,2,0]), tf([1],[1]));
    assert(JSON.stringify(a.output.num) === JSON.stringify([4]) && JSON.stringify(a.output.den) === JSON.stringify([1,2,4]), JSON.stringify(a));
    assert(JSON.stringify(a.sensitivity.num) === JSON.stringify([1,2,0]) && JSON.stringify(a.complementary.num) === JSON.stringify([4]), "S e T nÃ£o foram distinguidas");
    assert(JSON.stringify(a.control.num) === JSON.stringify([4,8,0]), "U/R incorreta");
  });
  await test("prÃ©-filtro, sensor nÃ£o unitÃ¡rio e perturbaÃ§Ãµes respeitam os pontos de injeÃ§Ã£o", () => {
    const tf = (num: number[], den: number[]): TransferFunction => ({ num, den, domain: "continuous" });
    const a = closeLoop(tf([2],[1]),tf([3],[1]),tf([1],[1,1]),tf([4],[1]));
    assert(JSON.stringify(a.output.num)==="[6]"&&JSON.stringify(a.output.den)==="[1,13]",JSON.stringify(a.output));
    assert(JSON.stringify(a.control.num)==="[6,6]"&&JSON.stringify(a.control.den)==="[1,13]","U/R com F nÃ£o unitÃ¡rio");
    assert(JSON.stringify(a.sensitivity.num)==="[1,1]"&&JSON.stringify(a.complementary.num)==="[12]","S/T nÃ£o unitÃ¡rios");
    assert(JSON.stringify(a.plantInputDisturbance.num)==="[1]"&&JSON.stringify(a.measurementNoiseOutput.num)==="[-12]","transferÃªncias de perturbaÃ§Ã£o");
    assert(JSON.stringify(a.measurementNoiseControl.num)==="[-12,-12]"&&JSON.stringify(a.measurementNoiseControl.den)==="[1,13]","ruÃ­do de mediÃ§Ã£o na saÃ­da de controle");
  });
  await test("estabilidade interna usa a equaÃ§Ã£o caracterÃ­stica mesmo com planta instÃ¡vel", () => {
    const tf=(num:number[],den:number[]):TransferFunction=>({num,den,domain:"continuous"});
    const plant=tf([1],[1,-1]),closed=closeLoop(tf([1],[1]),tf([2],[1]),plant,tf([1],[1]));
    assert(!isStable(plant),"planta instÃ¡vel nÃ£o foi reconhecida");
    assert(isStable(closed.sensitivity)&&isStable(closed.output),JSON.stringify({s:closed.sensitivity,output:closed.output}));
  });
  await test("raÃ­zes complexas do exemplo analÃ­tico K=4", () => {
    const roots = polynomialRoots([1,2,4]);
    assert(roots.length === 2 && roots.every(r => near(r.re,-1) && near(Math.abs(r.im),Math.sqrt(3))), JSON.stringify(roots));
  });
  await test("raiz repetida Ã© resolvida e Bode retorna margem no cruzamento de ganho", () => {
    const repeated=polynomialRoots([1,2,1]);
    assert(repeated.length===2&&repeated.every(r=>near(r.re,-1,.002)&&Math.abs(r.im)<.002),JSON.stringify(repeated));
    const loop={num:[4],den:[1,2,0],domain:"continuous" as const},b=bode(loop,1200),m=margins(loop,b);
    assert(m.gainCrossovers.length===1&&near(m.gainCrossovers[0]!,Math.sqrt(-2+Math.sqrt(20)),.01),JSON.stringify(m));
    assert(m.phaseMargins.length===1&&near(m.phaseMargins[0]!,51.8,.02),JSON.stringify(m));
  });
  await test("margens mÃºltiplas nÃ£o duplicam cruzamentos que caem exatamente em uma amostra", () => {
    const points=[0,-180,-360,-540,-720].map((phaseDeg,index)=>({omega:10**index,magnitudeDb:3,phaseDeg}));
    const result=margins({num:[Math.SQRT2],den:[1],domain:"continuous"},points);
    assert(result.phaseCrossovers.length===2&&result.gainMarginsDb.length===2,JSON.stringify(result));
    assert(near(result.phaseCrossovers[0]!,10)&&near(result.phaseCrossovers[1]!,1e3),JSON.stringify(result.phaseCrossovers));
    assert(result.gainMarginsDb.every((value)=>near(value,-20*Math.log10(Math.SQRT2))),JSON.stringify(result.gainMarginsDb));
  });
  await test("refina cruzamento de ganho e margem de fase a partir de uma grade de Bode esparsa", () => {
    const loop={num:[2],den:[1,1],domain:"continuous" as const};
    const result=margins(loop,bode(loop,2));
    assert(result.gainCrossovers.length===1&&near(result.gainCrossovers[0]!,Math.sqrt(3),1e-9),JSON.stringify(result));
    assert(result.phaseMargins.length===1&&near(result.phaseMargins[0]!,120,1e-9),JSON.stringify(result));
  });
  await test("controladores P, PI, PD filtrado e PID usam convenÃ§Ãµes declaradas", () => {
    const p={kp:2,ki:3,kd:4,filterN:5,tau:2,alpha:.5};
    assert(JSON.stringify(controllerForm("PI",p).num)==="[2,3]"&&JSON.stringify(controllerForm("PI",p).den)==="[1,0]","PI");
    assert(JSON.stringify(controllerForm("PD",p).num)==="[22,10]"&&JSON.stringify(controllerForm("PD",p).den)==="[1,5]","PD");
    assert(JSON.stringify(controllerForm("PID",p).num)==="[22,13,15]"&&JSON.stringify(controllerForm("PID",p).den)==="[1,5,0]","PID filtrado");
    assert(JSON.stringify(controllerForm("lead",p).num)==="[4,2]"&&JSON.stringify(controllerForm("lead",p).den)==="[1,1]","avanÃ§o");
    assert(JSON.stringify(controllerForm("lag",{...p,alpha:2}).den)==="[4,1]","atraso");
  });
  await test("entrada por polos e zeros preserva pares conjugados e ganho", () => {
    const tf=transferFromPolesZeros([{re:-2,im:0}],[{re:-1,im:1},{re:-1,im:-1}],3,"continuous");
    assert(JSON.stringify(tf.num)==="[3,6]"&&JSON.stringify(tf.den)==="[1,2,2]",JSON.stringify(tf));
    let bad=false;try{transferFromPolesZeros([], [{re:-1,im:1}],1,"continuous")}catch{bad=true}assert(bad,"par conjugado ausente aceito");
  });
  await test("realizaÃ§Ã£o de espaÃ§o de estados converge ao mesmo modelo transferÃ­vel", () => {
    const tf=stateSpaceToTf({A:[[-2]],B:[1],C:[1],D:0,domain:"continuous"});
    assert(JSON.stringify(tf.num)==="[1]"&&JSON.stringify(tf.den)==="[1,2]",JSON.stringify(tf));
    const second=stateSpaceToTf({A:[[0,1],[-4,-2]],B:[0,1],C:[4,0],D:0,domain:"continuous"});
    assert(JSON.stringify(second.num)==="[4]"&&JSON.stringify(second.den)==="[1,2,4]",JSON.stringify(second));
  });
  await test("lugar das raÃ­zes inclui os polos corretos no ganho quatro", () => {
    const series = rootLocus({num:[1],den:[1,2,0],domain:"continuous"},1,4,2);
    const roots = series.at(-1)!.roots;
    assert(roots.every(r => near(r.re,-1) && near(Math.abs(r.im),Math.sqrt(3))), JSON.stringify(series));
  });
  await test("preserves hidden unstable modes in the state-space analysis polynomial", () => {
    const model = stateSpaceToTf({ A: [[-1,0],[0,2]], B: [1,0], C: [1,0], D: 0, domain: "continuous" });
    assert(JSON.stringify(model.den) === "[1,-1,-2]", JSON.stringify(model));
    assert(poles(model).some(pole => pole.re > 1.99), "unobservable unstable state was dropped from the characteristic polynomial");
    const closed = closeLoop({ num:[1], den:[1], domain:"continuous" }, { num:[1], den:[1], domain:"continuous" }, model, { num:[1], den:[1], domain:"continuous" });
    assert(!isStable(closed.sensitivity), "internal stability ignored the hidden unstable mode");
  });
  await test("converts scaled continuous and sampled state-space plants without losing Ts", () => {
    const continuous = stateSpaceToTf({ A:[[1e6,0],[0,2e6]], B:[1,0], C:[1,0], D:0, domain:"continuous" });
    assert(near(continuous.den[1]!, -3e6, 1e-10) && near(continuous.den[2]!, 2e12, 1e-10), JSON.stringify(continuous));
    assert(near(continuous.num[0]!,1)&&near(continuous.num[1]!,-2e6,1e-10),JSON.stringify(continuous));
    const discrete = stateSpaceToTf({ A:[[.5,0],[0,1.2]], B:[1,0], C:[1,0], D:0, domain:"discrete", sampleTime:.2 });
    assert(discrete.domain === "discrete" && discrete.sampleTime === .2 && near(discrete.den[0]!,1) && near(discrete.den[1]!,-1.7) && near(discrete.den[2]!,.6), JSON.stringify(discrete));
    assert(poles(discrete).some(pole => Math.hypot(pole.re,pole.im) > 1.19), "discrete hidden unstable mode was dropped");
    let rejected = false;
    try { stateSpaceToTf({ A:[[1,2]], B:[1], C:[1], D:0, domain:"continuous" }); } catch { rejected = true; }
    assert(rejected, "rectangular A matrix was accepted");
    rejected = false;
    try { stateSpaceToTf({ A:[[1]], B:[1,2], C:[1], D:0, domain:"continuous" }); } catch { rejected = true; }
    assert(rejected, "dimensionally incompatible B vector was accepted");
    rejected = false;
    try { stateSpaceToTf({ A:[[1]], B:[1], C:[1], D:0, domain:"discrete", sampleTime:0 }); } catch { rejected = true; }
    assert(rejected, "discrete model without positive Ts was accepted");
  });
  await test("discrete root locus reaches the unit circle at the analytic gain boundary",()=>{
    const tf={num:[.1],den:[1,-.9],domain:"discrete" as const,sampleTime:.1};
    const locus=rootLocus(tf,.1,19,2),boundary=locus.at(-1)!.roots[0]!;
    assert(locus.length>2,"adaptive refinement did not add intermediate gain samples");
    assert(near(boundary.re,-1)&&Math.abs(boundary.im)<1e-8,JSON.stringify(locus));
    assert(classifyStability({num:[1],den:[1,1],domain:"discrete",sampleTime:.1})==="marginal","z=-1 must be marginal, not asymptotically stable");
    assert(classifyStability({num:[1],den:[1,-1.01],domain:"discrete",sampleTime:.1})==="unstable","pole outside the unit circle must be unstable");
  });
  await test("discrete pole interpretation reports principal branch and singular cases",()=>{
    const interpretation=interpretDiscretePole({re:-1,im:0},.1);
    assert(near(interpretation.principal!.im,Math.PI/.1)&&near(interpretation.branchSpacing,2*Math.PI/.1),JSON.stringify(interpretation));
    assert(interpretDiscretePole({re:0,im:0},.1).principal===undefined,"z=0 has no finite logarithm");
  });
  await test("resposta ao degrau e mÃ©tricas do exemplo tÃªm valor final unitÃ¡rio", () => {
    const response = timeResponse({num:[4],den:[1,2,4],domain:"continuous"},"step");
    const metrics = stepMetrics(response.samples);
    assert(response.stable && metrics.status === "settled" && near(metrics.finalValue!,1,.01), JSON.stringify(metrics));
    assert(near(metrics.overshootPercent!,16.3,.03), String(metrics.overshootPercent));
  });
  await test("discreto exige amostragem e a resposta usa recorrÃªncia", () => {
    let rejected=false; try { validateTf({num:[1],den:[1,-.5],domain:"discrete"}); } catch { rejected=true; }
    assert(rejected,"Ts ausente aceito");
    const r=timeResponse({num:[1],den:[1,-.5],domain:"discrete",sampleTime:.1},"step",5,50);
    assert(r.stable && near(r.samples.at(-1)!.value,2,1e-8),String(r.samples.at(-1)?.value));
    assert(r.directFeedthrough===0,"resposta discreta estritamente prÃ³pria tem D=0");
    const dBode=bode({num:[1],den:[1,-.5],domain:"discrete",sampleTime:.1},32);
    assert(near(dBode.at(-1)!.omega,Math.PI/.1,1e-8),"Bode discreto deve terminar em Nyquist");
    const direct=timeResponse({num:[2,1],den:[1,-.5],domain:"discrete",sampleTime:.1},"impulse",5,10);
    assert(direct.directFeedthrough===2&&near(direct.samples[0]!.value,2),"componente direta do impulso discreto");
  });
  await test("modelo discreto de oitava ordem estÃ¡vel mantÃ©m polos e resposta finitos", () => {
    const tf=transferFromPolesZeros([],Array.from({length:8},(_,index)=>({re:.1*(index+1),im:0})),.01,"discrete",.01);
    const roots=polynomialRoots(tf.den),response=timeResponse(tf,"step",.8,100);
    assert(roots.length===8&&Array.from({length:8},(_,index)=>.1*(index+1)).every(expected=>roots.some(root=>Math.abs(root.re-expected)<1e-5&&Math.abs(root.im)<1e-5)),JSON.stringify(roots));
    assert(isStable(tf)&&response.converged&&response.samples.every(sample=>Number.isFinite(sample.value)),"modelo discreto estÃ¡vel nÃ£o convergiu");
  });
  await test("solucionador preserva dez polos reais distintos", () => {
    const roots=Array.from({length:10},(_,i)=>({re:-(i+1),im:0}));
    const tf=transferFromPolesZeros([],roots,1,"continuous"),solved=poles(tf);
    assert(solved.length===10&&solved.every((root)=>Number.isFinite(root.re)&&Number.isFinite(root.im)),JSON.stringify(solved));
    for(const expected of roots)assert(solved.some((root)=>near(root.re,expected.re,1e-7)&&Math.abs(root.im)<1e-7),`polo ausente ${expected.re}: ${JSON.stringify(solved)}`);
  });
  await test("polos com escalas separadas por seis ordens continuam identificÃ¡veis", () => {
    const expected=[-1e-3,-1,-1e3],tf=transferFromPolesZeros([],expected.map((re)=>({re,im:0})),1,"continuous"),solved=poles(tf);
    for(const value of expected)assert(solved.some((root)=>near(root.re,value,1e-7)&&Math.abs(root.im)<1e-7),`polo ausente ${value}: ${JSON.stringify(solved)}`);
  });
  await test("conversÃ£o bilinear declara Ts e mapeia polo contÃ­nuo para o interior do cÃ­rculo", () => {
    const z=convertDomain({num:[1],den:[1,2],domain:"continuous"},"discrete",.1);
    assert(z.domain==="discrete"&&near(z.num[0]!,1/22)&&near(z.num[1]!,1/22)&&near(z.den[1]!,-18/22),JSON.stringify(z));
    const s=convertDomain(z,"continuous",.1);
    assert(s.domain==="continuous"&&near(s.den[1]!,2),JSON.stringify(s));
  });
  await test("contagem de encirclements de Nyquist fecha contorno estavel", () => {
    const stable = { num: [1], den: [1, 1], domain: "continuous" as const };
    assert(nyquistEncirclements(stable) === 0, String(nyquistEncirclements(stable)));
    const unstableOpenLoop={num:[2],den:[1,-1],domain:"continuous" as const};
    assert(nyquistEncirclements(unstableOpenLoop)===-1,"contagem algébrica deve detectar polo aberto instável e malha fechada estável");
    assert(nyquistEncirclements({num:[1],den:[1,0],domain:"continuous"})===undefined,"polo sobre o contorno deve tornar Nyquist indefinido");
    const discreteUnstable={num:[2],den:[1,-1.5],domain:"discrete" as const,sampleTime:.1};
    assert(nyquistEncirclements(discreteUnstable)===1,"contorno discreto anti-horário deve contar corretamente polo aberto fora do círculo unitário");
  });  await test("Bode refina bandas estreitas de polos ressonantes", () => {
    const curve = bode({ num: [1], den: [1, .002, 1], domain: "continuous" }, 30);
    assert(curve.length > 30 && Math.max(...curve.map(point => point.magnitudeDb)) > 48, `samples=${curve.length}, peak=${Math.max(...curve.map(point => point.magnitudeDb))}`);
    assert(curve.coverage==="algebraic-extrema"&&curve.magnitudeExtrema.some(omega=>near(omega,1,1e-5)),"extremo ressonante não foi encontrado pela equação estacionária");
    const digital=bode({num:[1],den:[1,-1.8,0.81],domain:"discrete",sampleTime:.1},40);
    assert(digital.coverage==="algebraic-extrema"&&digital.magnitudeExtrema.every(omega=>omega>0&&omega<=Math.PI/.1),"extremos discretos fora da banda de Nyquist");
  });  await test("Euler para frente e para tras discretizam modelo de primeira ordem", () => {
    const source = { num: [1], den: [1, 2], domain: "continuous" as const };
    const forward = convertEuler(source, .1, "forward"), backward = convertEuler(source, .1, "backward");
    assert(near(forward.num[0]!, .1) && near(forward.den[1]!, -.8) && forward.sampleTime === .1, JSON.stringify(forward));
    assert(near(backward.num[0]!, 1 / 12) && near(backward.den[0]!, 1) && near(backward.den[1]!, -10 / 12), JSON.stringify(backward));
  });  await test("incompatibilidade entre din?micas ? rejeitada, mas ganhos est?ticos s?o neutros", () => {
    let improper=false, mixed=false;
    try { validateTf({num:[1,1],den:[1],domain:"continuous"}); } catch { improper=true; }
    try { closeLoop({num:[1],den:[1,1],domain:"continuous"},{num:[1],den:[1],domain:"continuous"},{num:[1],den:[1,-.5],domain:"discrete",sampleTime:.1},{num:[1],den:[1],domain:"continuous"}); } catch { mixed=true; }
    assert(improper&&mixed,"mistura de din?micas incompat?veis foi aceita");
    const result=closeLoop({num:[1],den:[1],domain:"continuous"},{num:[2],den:[1],domain:"continuous"},{num:[1],den:[1,-.5],domain:"discrete",sampleTime:.1},{num:[1],den:[1],domain:"continuous"});
    assert(result.output.domain==="discrete"&&result.output.sampleTime===.1,"ganhos est?ticos n?o adotaram o dom?nio da din?mica");
  });
  await test("isolamento de Sturm e contagem de Nyquist certificados usam coeficientes racionais exatos", async () => {
    assert(certifiedRealRootCount([1, 1, -2], 0, 2) === 1, "Sturm deveria isolar uma raiz no intervalo (0,2)");
    const result = await certifyAnalyses({ num: [2], den: [1, -1], domain: "continuous" });
    const nyquist = result.find(item => item.analysis === "nyquist");
    assert(nyquist?.status === "certified" && nyquist.details?.encirclements === -1, JSON.stringify(nyquist));
    const discrete = await certifyAnalyses({ num: [2], den: [1, -1.5], domain: "discrete", sampleTime: .1 });
    const discreteNyquist = discrete.find(item => item.analysis === "nyquist");
    assert(discreteNyquist?.status === "certified" && discreteNyquist.details?.encirclements === 1, JSON.stringify(discreteNyquist));
    const discreteSecondOrder = await certifyAnalyses({ num: [2], den: [1, -2, .75], domain: "discrete", sampleTime: .1 });
    assert(discreteSecondOrder.find(item => item.analysis === "nyquist")?.status === "certified" && discreteSecondOrder.find(item => item.analysis === "nyquist")?.details?.encirclements === -1, JSON.stringify(discreteSecondOrder));
    const boundary = await certifyAnalyses({ num: [1], den: [1, 1], domain: "discrete", sampleTime: .1 });
    assert(boundary.find(item => item.analysis === "nyquist")?.status === "inconclusive", "polo discreto na fronteira deve impedir certificado");
    const bodeProof = await certifyAnalyses({ num: [1], den: [1, .002, 1], domain: "continuous" });
    const bode = bodeProof.find(item => item.analysis === "bode");
    assert(bode?.status === "certified" && bode.details?.stationaryPoints === 1, JSON.stringify(bode));
    const discreteBodeProof = await certifyAnalyses({ num: [1], den: [1, -.5], domain: "discrete", sampleTime: .1 });
    assert(discreteBodeProof.find(item => item.analysis === "bode")?.status === "certified", JSON.stringify(discreteBodeProof));
    const locusProof = await certifyAnalyses({ num: [1], den: [1, 1], domain: "continuous" });
    const locus = locusProof.find(item => item.analysis === "root-locus");
    assert(locus?.status === "certified" && locus.details?.branches === 1 && Number(locus.details.rootMin) < -1, JSON.stringify(locus));
    const secondOrderLocus = (await certifyAnalyses({ num: [1], den: [1, 3, 2], domain: "continuous" })).find(item => item.analysis === "root-locus");
    assert(secondOrderLocus?.status === "certified" && secondOrderLocus.details?.branches === 2, JSON.stringify(secondOrderLocus));
    const discreteLocus = (await certifyAnalyses({ num: [1], den: [1, -1.2, .32], domain: "discrete", sampleTime: .1 })).find(item => item.analysis === "root-locus");
    assert(discreteLocus?.status === "certified" && discreteLocus.details?.branches === 2, JSON.stringify(discreteLocus));
  });
  await test("z and z^-1 conversion preserves sample delay",()=>{
    const zModel={num:[.1],den:[1,-.9],domain:"discrete" as const,sampleTime:.1},inverse=toZInverse(zModel);
    assert(JSON.stringify(inverse.num)==="[0,0.1]"&&JSON.stringify(inverse.den)==="[1,-0.9]",JSON.stringify(inverse));
    const roundTrip=fromZInverse(inverse);
    assert(JSON.stringify(roundTrip.num)==="[0.1]"&&JSON.stringify(roundTrip.den)==="[1,-0.9]",JSON.stringify(roundTrip));
    const pureDelay=fromZInverse({num:[0,0,1],den:[1],sampleTime:.1});
    assert(JSON.stringify(pureDelay.num)==="[1]"&&JSON.stringify(pureDelay.den)==="[1,0,0]",JSON.stringify(pureDelay));
  });
  await test("atraso z^-2 desloca degrau e impulso por duas amostras sem alterar magnitude",()=>{
    const delay:TransferFunction={num:[1],den:[1,0,0],domain:"discrete",sampleTime:.1};
    const step=timeResponse(delay,"step",.5,5).samples.map(x=>x.value);
    const impulse=timeResponse(delay,"impulse",.5,5).samples.map(x=>x.value);
    const response=bode(delay,8);
    assert(JSON.stringify(step)==="[0,0,1,1,1]",JSON.stringify(step));
    assert(JSON.stringify(impulse)==="[0,0,1,0,0]",JSON.stringify(impulse));
    assert(response.every(x=>near(x.magnitudeDb,0,1e-8)),JSON.stringify(response));
  });
  await test("sequência de entrada arbitrária usa Ts e a equação discreta",()=>{
    const model:TransferFunction={num:[.1],den:[1,-.9],domain:"discrete",sampleTime:.1};
    const response=timeResponseForInput(model,[1,1,1,0]);
    assert(JSON.stringify(response.samples.map(x=>Number(x.value.toFixed(3))))==="[0,0.1,0.19,0.271]",JSON.stringify(response.samples));
    assert(near(response.samples[3]!.time,.3),"instantes não foram expressos em kTs");
  });
  await test("métricas calculadas identificam subida e pico nos instantes amostrados",()=>{
    const metrics=stepMetrics([{time:0,value:0},{time:.1,value:.2},{time:.2,value:1.2},{time:.3,value:.9}],1);
    assert(metrics.riseTime===.1&&metrics.peakTime===.2&&near(metrics.overshootPercent!,20),JSON.stringify(metrics));
  });
  await test("ZOH reproduz reten??o de ordem zero para planta de primeira ordem",()=>{
    const digital=convertZoh({num:[1],den:[1,1],domain:"continuous"},.1);
    assert(digital.domain==="discrete"&&digital.sampleTime===.1&&near(digital.num[0]!,1-Math.exp(-.1),1e-8)&&near(digital.den[1]!,-Math.exp(-.1),1e-8),JSON.stringify(digital));
    const response=timeResponse(digital,"step",.4,10);
    assert(response.samples[0]!.value===0&&near(response.samples[1]!.value,1-Math.exp(-.1),1e-8),JSON.stringify(response.samples.slice(0,2)));
  });
  await test("mudar Ts no mesmo dom?nio n?o reinterpreta o modelo",()=>{
    let rejected=false;try{convertDomain({num:[1],den:[1,-.5],domain:"discrete",sampleTime:.1},"discrete",.2)}catch{rejected=true}assert(rejected,"Ts diferente n?o exigiu convers?o expl?cita");
  });
  await test("ramos do lugar permanecem conjugados ao sair de polo repetido", () => {
    const series = rootLocus({num:[1],den:[1,2,0],domain:"continuous"},1e-3,1e3,121);
    const firstComplex = series.findIndex(row => row.roots.some(root => Math.abs(root.im) > 1e-4));
    assert(firstComplex > 0, "nÃ£o encontrou o encontro dos ramos");
    const branches = series.slice(firstComplex);
    assert(branches.every(row => near(row.roots[0]!.re,row.roots[1]!.re,.01) && near(row.roots[0]!.im,-row.roots[1]!.im,.01)), "raÃ­zes deixaram de ser conjugadas");
    const sign = Math.sign(branches[0]!.roots[0]!.im);
    assert(branches.slice(1).every(row => Math.sign(row.roots[0]!.im) === sign), "ramos trocaram de lado depois do encontro");
  });
  await test("resposta natural em malha fechada usa x0 da realizaÃ§Ã£o sem descartar estados", () => {
    const plant={A:[[0,1],[-2,-3]],B:[0,1],C:[1,0],D:0};
    const result=closedLoopInitialStateResponse(plant,[1,0],{num:[2],den:[1],domain:"continuous"},{num:[1],den:[1],domain:"continuous"},2,401);
    assert(result.samples[0]!.value===1,"saÃ­da inicial deve ser C*x0");
    assert(result.stable&&result.samples.every(sample=>Number.isFinite(sample.value)),"resposta finita e estÃ¡vel esperada");
    let rejected=false;try{closedLoopInitialStateResponse(plant,[1],{num:[2],den:[1],domain:"continuous"},{num:[1],den:[1],domain:"continuous"})}catch{rejected=true}
    assert(rejected,"vetor inicial com dimensÃ£o incorreta aceito");
  });
  await test("derivada sobre medição entra no ramo de realimentação sem alterar o caminho de referência", () => {
    const tf=(num:number[],den:number[]):TransferFunction=>({num,den,domain:"continuous"});
    const ordinary=closeLoop(tf([1],[1]),tf([2],[1]),tf([1],[1,1]),tf([1],[1]));
    const split=closeLoop(tf([1],[1]),tf([2],[1]),tf([1],[1,1]),tf([1],[1]),tf([3,0],[1,10]));
    assert(JSON.stringify(split.output.num)===JSON.stringify([2,20]),"caminho de referência não preservou C0 multiplicado pelo denominador do ramo derivativo");
    assert(JSON.stringify(split.output.den)!==JSON.stringify(ordinary.output.den),"derivada de medição não alterou característica fechada");
  });
  await finish();
})();
