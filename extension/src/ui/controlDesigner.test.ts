import { controlDesignSimulinkScript } from "./webview/controlDesigner/simulinkExport";
import { matlabWorkspaceArrayExportScript } from "./webview/controlDesigner/matlabWorkspaceExport";
import { exportDesignFileStem, projectForExportDesign } from "./webview/controlDesigner/exportDesign";
import { createTestRunner, assert as assertWithMessage } from "../ipc/testSupport/MockCoreServer";
import { certifyAnalyses, certifiedRealRootCount } from "./webview/controlDesigner/certification";
import { amigofPiParameters, chienHronesReswickParameters, zieglerNicholsFrequencyParameters, zieglerNicholsStepParameters, skogestadImcPiParameters, approximateTransportDelay, bode, closeLoop, closedLoopInitialStateResponse, closedLoopPeakGainDb, controllerForm, convertDomain, convertEuler, convertZoh, fromZInverse, frequencyResponse, isFeedbackLoopStable, interpretDiscretePole, isStable, classifyStability, margins, nyquistEncirclements, polynomialRoots, poles, reduceControllerOrder, rootFromFrequency, rootLocus, stateSpaceToTf, stepMetrics, synthesizeImcController, synthesizeLqg, synthesizeLoopShapeByBandwidth, timeResponse, timeResponseForInput, toZInverse, transferFromPolesZeros, twoDofPidChannels, tfAdd, tfMul, tfScale, tfToStateSpace, validateTf, type TransferFunction } from "./webview/controlDesigner/lti";
import { CONTROL_DESIGN_FREQUENCY_UNITS, validateControlDesignProject } from "./webview/controlDesigner/types";
import { frequencyFromDisplay, frequencyToDisplay, frdFrequencyToRadPerSecond } from "./webview/controlDesigner/frequencyUnits";
import { sampleStateSpaceCoefficients, sampleTransferFunctionCoefficients } from "./webview/controlDesigner/uncertainty";
import { fitFrdStablePoles, fitFrdStableRealPoles, frdMargins, interpolateFrdResponse, parseFrdMagnitudeProfile } from "./webview/controlDesigner/frdFit";
const assert = (ok: boolean, message = "falhou"): void => assertWithMessage(ok, message);
const near = (a: number, b: number, tol = 1e-5) => Math.abs(a - b) <= tol * Math.max(1, Math.abs(b));

(async () => {
  const { test, finish } = createTestRunner("Projeto de Controladores â€” nÃºcleo LTI");
  await test("exports current and stored controller designs as detached project snapshots", () => {
    const source={version:1,domain:"continuous",sampleTime:.1,F:{num:"1",den:"1"},C:{num:"2",den:"1"},G:{num:"1",den:"1, 1"},H:{num:"1",den:"1"},C2:{num:"3",den:"1"},H2:{num:"1",den:"1"},response:"output",requirements:[],alternatives:[{name:"Lead-á",color:"#fff",controller:{num:"8",den:"1"},prefilter:{num:"4",den:"1"},innerController:{num:"6",den:"1"},measurementDerivativeModel:{num:"5",den:"1"}}],activeAlternative:"Lead-á"} as unknown as import("./webview/controlDesigner/types").ControlDesignProject;
    const current=projectForExportDesign(source),stored=projectForExportDesign(source,"Lead-á");
    assert(current!==source&&current.C!==source.C&&current.C.num==="2","current export must be detached and retain the active model");
    assert(stored.C.num==="8"&&stored.F.num==="4"&&stored.C2?.num==="6"&&stored.measurementDerivativeModel?.num==="5","stored export must replace all saved controller blocks");
    assert(source.C.num==="2"&&source.F.num==="1","export snapshot must not mutate the editor project");
    assert(exportDesignFileStem()===""&&exportDesignFileStem("Lead-á") === "Lead-a","export filenames should preserve current naming and normalize accents");
    let rejected=false;try{projectForExportDesign(source,"missing")}catch{rejected=true}assert(rejected,"removed designs must not silently export the current model");
  });
  await test("MATLAB Workspace array helper exports tf/zpk/ss/frd model arrays", () => {
    const script=matlabWorkspaceArrayExportScript();
    for(const fragment of ["exportSisoToolsWorkspaceModels(G, H, fileName, sampleCount, seed)","isa(sys, 'zpk')","isa(sys, 'frd')","models = value(:).'","tfdata(tf(sys), 'v')","ssdata(sys)","chgFreqUnit(sys, 'rad/s')","entry.plantFrd = frdData","exist('fitfrd', 'file') == 2","entry.sensor = struct('num', sensorNum, 'den', sensorDen)","entry.sensorFrd = sensorFrd","G e H devem usar o mesmo dominio.","G e H devem usar o mesmo sample time.","gUncertain = isa(G, 'uss') || isa(G, 'ufrd')","hUncertain = isa(H, 'uss') || isa(H, 'ufrd')","Amostre G e H juntos","usample(G, sampleCount)","previousRng = rng; rngCleanup = onCleanup(@() rng(previousRng))","rng(seed, 'twister')","coeficientes complexos","payload = struct('models', {models})","jsonencode(payload)","UTF-8"])
      assert(script.includes(fragment),`Workspace export helper omitted ${fragment}`);
    assert(script.includes("numel(sensors) ~= 1 && numel(sensors) ~= numel(plants)"),"helper must validate scalar expansion or matching sensor arrays");
    assert(script.includes("ganho-estatico-no-primeiro-ponto"),"FRD export must identify its fallback time-domain approximation when fitfrd is unavailable");
  });
  await test("IMC full-order reproduces the official MATLAB reactor example", () => {
    const s=8.2677,g=validateTf({num:[13.3259,3.2239],den:[s*s,2*s,1],domain:"continuous"}),result=synthesizeImcController(g,2,2),controller=result.controller,controllerPoles=poles(controller).map(root=>root.re).sort((a,b)=>a-b),controllerZeros=polynomialRoots(controller.num).map(root=>root.re).sort((a,b)=>a-b),gain=controller.num[0]!/controller.den[0]!;
    assert(result.fullOrder===2&&result.achievedOrder===2,"IMC full-order should retain the plant order");
    assert(near(gain,2.5647,2e-4),`MATLAB example gain mismatch: ${gain}`);
    assert(controllerPoles.length===2&&near(controllerPoles[0]!,-.5,3e-3)&&near(controllerPoles[1]!,-.2419,3e-3),`MATLAB example poles mismatch: ${controllerPoles}`);
    assert(controllerZeros.length===2&&near(controllerZeros[0]!,-.121,3e-3)&&near(controllerZeros[1]!,-.121,3e-3),`MATLAB example zeros mismatch: ${controllerZeros}`);
    const unstablePredictive=synthesizeImcController(validateTf({num:[1,1],den:[1,-2],domain:"continuous"}),1,1);assert(classifyStability(unstablePredictive.controller)==="stable","unstable predictive pole should not prevent a stable IMC compensator");
    const nonminimumModel=validateTf({num:[1,-1],den:[1,2],domain:"continuous"}),nonminimum=synthesizeImcController(nonminimumModel,1,2),nominalResponse=tfMul(nonminimumModel,nonminimum.controller);
    assert(classifyStability(nonminimum.controller)==="stable"&&nonminimum.fullOrder===1,"nonminimum-phase IMC should retain a stable, proper full-order Q");
    const targetZeros=polynomialRoots(nominalResponse.num);
    assert(classifyStability(nominalResponse)==="stable"&&near(nominalResponse.num.at(-1)!/nominalResponse.den.at(-1)!,1)&&targetZeros.some(root=>near(root.re,1)&&Math.abs(root.im)<1e-6),"nonminimum-phase zero should remain in the stable target response with unit DC gain");
    const complexModel=validateTf({num:[1,-2,2],den:[1,3,2],domain:"continuous"}),complexNonminimum=synthesizeImcController(complexModel,.5,2),complexTarget=tfMul(complexModel,complexNonminimum.controller),complexTargetZeros=polynomialRoots(complexTarget.num);assert(classifyStability(complexNonminimum.controller)==="stable"&&classifyStability(complexTarget)==="stable"&&complexNonminimum.fullOrder===2&&complexTargetZeros.some(root=>near(root.re,1)&&near(Math.abs(root.im),1)),"conjugate right-half-plane zero pair should be retained without unstable controller poles");
  });  await test("FRD continuous and discrete samples fit stable rational plants", () => {
    const frequencies=Array.from({length:48},(_,i)=>.02*10**(i*3/47)),continuous=validateTf({num:[3],den:[1,2],domain:"continuous"}),continuousResponse=frequencies.map(omega=>frequencyResponse(continuous,omega)),continuousFit=fitFrdStableRealPoles({frequency:frequencies,response:continuousResponse,domain:"continuous",order:1});
    assert(continuousFit.relativeRmsError<2e-5&&near(continuousFit.model.den[1]!,2,1e-4),`continuous FRD fit error ${continuousFit.relativeRmsError}; model ${JSON.stringify(continuousFit.model)}`);
    const ts=.1,discrete=validateTf({num:[.2],den:[1,-.8],domain:"discrete",sampleTime:ts}),discreteOmega=Array.from({length:48},(_,i)=>.02+(Math.PI/ts-.04)*i/47),discreteResponse=discreteOmega.map(omega=>frequencyResponse(discrete,omega)),discreteFit=fitFrdStableRealPoles({frequency:discreteOmega,response:discreteResponse,domain:"discrete",sampleTime:ts,order:1});
    assert(discreteFit.relativeRmsError<5e-5&&Math.abs(discreteFit.model.den[1]!+0.8)<1e-4,`discrete FRD fit error ${discreteFit.relativeRmsError}; model ${JSON.stringify(discreteFit.model)}`);
  });
  await test("FRD rational fit captures stable complex resonances in continuous and discrete models", () => {
    const continuousOmega=Array.from({length:80},(_,i)=>.04*10**(i*2.8/79)),continuous=validateTf({num:[1],den:[1,.4,4],domain:"continuous"}),continuousData=continuousOmega.map(omega=>frequencyResponse(continuous,omega)),complexFit=fitFrdStablePoles({frequency:continuousOmega,response:continuousData,domain:"continuous",order:2}),realFit=fitFrdStableRealPoles({frequency:continuousOmega,response:continuousData,domain:"continuous",order:2});
    assert(complexFit.relativeRmsError<1e-3&&complexFit.relativeRmsError<realFit.relativeRmsError*.1&&isStable(complexFit.model)&&poles(complexFit.model).some(root=>Math.abs(root.im)>.1),"continuous resonance fit failed: "+complexFit.relativeRmsError+" vs real-only "+realFit.relativeRmsError+"; model "+JSON.stringify(complexFit.model));
    const ts=.1,discreteOmega=Array.from({length:80},(_,i)=>.05+(Math.PI/ts-.1)*i/79),discrete=validateTf({num:[1],den:[1,-1.6,.81],domain:"discrete",sampleTime:ts}),discreteData=discreteOmega.map(omega=>frequencyResponse(discrete,omega)),discreteFit=fitFrdStablePoles({frequency:discreteOmega,response:discreteData,domain:"discrete",sampleTime:ts,order:2});
    assert(discreteFit.relativeRmsError<2e-3&&isStable(discreteFit.model)&&poles(discreteFit.model).some(root=>Math.abs(root.im)>.05),"discrete resonance fit failed: "+discreteFit.relativeRmsError+"; model "+JSON.stringify(discreteFit.model));
  });
  await test("FRD fit validates sample count, frequency order, and Nyquist", () => {
    const base={frequency:[1,2,3,4],response:Array.from({length:4},()=>({re:1,im:0})),domain:"discrete" as const,sampleTime:.1,order:1};let rejected=0;
    for(const input of [{...base,frequency:[1,2,2,4]},{...base,frequency:[1,2,3,40]}])try{fitFrdStableRealPoles(input)}catch{rejected++}
    assert(rejected===2,"invalid FRD grids were accepted");
  });
  await test("FRD interpolation is linear in frequency and complex response without extrapolation", () => {
    const midpoint=interpolateFrdResponse([1,3],[{re:1,im:-2},{re:5,im:2}],2);
    assert(midpoint.re===3&&midpoint.im===0,"FRD interpolation did not match the documented linear complex interpolation");
    let rejected=false;try{interpolateFrdResponse([1,3],[{re:1,im:0},{re:2,im:0}],3.01)}catch{rejected=true}
    assert(rejected,"FRD interpolation extrapolated beyond its measured range");
  });
  await test("FRD loop-shape magnitude profiles validate their grid and convert dB to linear gain", () => {
    const profile=parseFrdMagnitudeProfile("0.1, 20\n1, 0\n10, -20");
    assert(profile.frequencyRadPerSecond.join(",")==="0.1,1,10","FRD target frequencies were not preserved");
    assert(near(profile.response[0]!.re,10)&&near(profile.response[1]!.re,1)&&near(profile.response[2]!.re,.1),"FRD magnitude values were not converted from dB");
    for(const invalid of ["1, 0","1, 0\n1, -3","0, 2\n1, 0","1, NaN\n2, 0"])try{parseFrdMagnitudeProfile(invalid);throw new Error(`accepted invalid FRD target ${invalid}`)}catch(error){if(error instanceof Error&&error.message.startsWith("accepted invalid"))throw error}
  });
  await test("FRD stability margins use measured complex samples", () => {
    const model=validateTf({num:[1],den:[1,1,0],domain:"continuous"}),frequency=Array.from({length:1001},(_,i)=>.01+i*.01),response=frequency.map(omega=>frequencyResponse(model,omega)),result=frdMargins(frequency,response);
    assert(result.gainCrossovers.length===1&&near(result.gainCrossovers[0]!,Math.sqrt((Math.sqrt(5)-1)/2),.002),`FRD gain crossover is wrong: ${JSON.stringify(result.gainCrossovers)}`);
    assert(result.phaseMargins.length===1&&near(result.phaseMargins[0]!,51.84,.003),`FRD phase margin is wrong: ${JSON.stringify(result.phaseMargins)}`);
    const finiteGainMarginModel=validateTf({num:[1],den:[.1,1.1,1,0],domain:"continuous"}),finiteResponse=frequency.map(omega=>frequencyResponse(finiteGainMarginModel,omega)),finite=frdMargins(frequency,finiteResponse);
    assert(finite.phaseCrossovers.length===1&&near(finite.phaseCrossovers[0]!,Math.sqrt(10),.002),`FRD phase crossover is wrong: ${JSON.stringify(finite.phaseCrossovers)}`);
    assert(finite.gainMarginsDb.length===1&&near(finite.gainMarginsDb[0]!,20*Math.log10(Math.sqrt(10)*Math.sqrt(11)*Math.sqrt(1.1)),.003),`FRD gain margin is wrong: ${JSON.stringify(finite.gainMarginsDb)}`);
  });
  await test("project persistence retains hybrid plant domain and dynamic initial states", () => {
    const base={domain:"discrete",plantDomain:"continuous",sampleTime:.1,F:{num:"1",den:"1"},C:{num:"1",den:"1, 1"},G:{num:"1",den:"1, 1"},H:{num:"1",den:"1, 1"},response:"output",requirements:[],alternatives:[],activeAlternative:"",controllerInitialState:[2],sensorInitialState:[3]};
    const saved=validateControlDesignProject(base);
    assert(saved?.plantDomain==="continuous"&&saved.controllerInitialState?.[0]===2&&saved.sensorInitialState?.[0]===3,"hybrid domain or state initial conditions were not persisted");
  });  await test("project persistence keeps raw FRD measurements with strict frequency validation", () => {
    const base={domain:"continuous",sampleTime:.1,F:{num:"1",den:"1"},C:{num:"2",den:"1"},G:{num:"1",den:"1, 2"},H:{num:"1",den:"1"},response:"output",requirements:[],alternatives:[],activeAlternative:""},plantFrd={frequencyRadPerSecond:[.1,1,10,100],response:[{re:1,im:0},{re:.8,im:-.2},{re:.1,im:-.3},{re:.001,im:-.01}],sourceUnit:"Hz"},saved=validateControlDesignProject({...base,plantFrd});
    assert(saved?.plantFrd?.response.length===4&&saved.plantFrd.sourceUnit==="Hz","raw FRD samples were not persisted");
    assert(!validateControlDesignProject({...base,plantFrd:{...plantFrd,frequencyRadPerSecond:[.1,1,1,100]}}),"non-increasing persisted FRD grid was accepted");
  });
  await test("multimodel variants preserve measured FRD sensors and validate their frequency grid", () => {
    const base={domain:"continuous",sampleTime:.1,F:{num:"1",den:"1"},C:{num:"2",den:"1"},G:{num:"1",den:"1, 2"},H:{num:"1",den:"1"},response:"output",requirements:[],alternatives:[],activeAlternative:""},sensorFrd={frequencyRadPerSecond:[.1,1,10,100],response:[{re:1,im:0},{re:.8,im:-.2},{re:.1,im:-.3},{re:.001,im:-.01}],sourceUnit:"Hz"},saved=validateControlDesignProject({...base,plantVariants:[{name:"sensor FRD",color:"#89d185",plant:{num:"1",den:"1, 2"},sensor:{num:"1",den:"1"},sensorFrd}]});
    assert(saved?.plantVariants?.[0]?.sensorFrd?.response.length===4&&saved.plantVariants[0].sensorFrd.sourceUnit==="Hz","measured sensor response was not retained");
    assert(validateControlDesignProject({...base,plantVariants:[{name:"bad sensor FRD",color:"#89d185",plant:{num:"1",den:"1, 2"},sensorFrd:{...sensorFrd,frequencyRadPerSecond:[.1,1,1,100]}}]})?.plantVariants?.length===0,"non-increasing sensor FRD grid was retained");
  });
  await test("frequency-editor complex roots map damping and Nyquist correctly", () => {
    const continuous=rootFromFrequency(10,"continuous",undefined,.7,true);
    assert(near(continuous.re,-7)&&near(continuous.im,Math.sqrt(51)),"continuous complex root mapping is wrong");
    const discrete=rootFromFrequency(10,"discrete",.01,.7,true);
    assert(Math.hypot(discrete.re,discrete.im)<1&&discrete.im>0,"discrete complex root is not inside the unit circle");
    const real=rootFromFrequency(10,"discrete",.01,.7,false);
    assert(near(real.re,Math.exp(-.1))&&real.im===0,"real break-frequency mapping changed");
    let nyquistRejected=false;try{rootFromFrequency(Math.PI/.01,"discrete",.01,.7,true)}catch{nyquistRejected=true}
    assert(nyquistRejected,"complex root at Nyquist was accepted");
  });
  await test("closed-loop peak gain requirement measures L/(1+L), not the open-loop gain", () => {
    const loop={num:[1],den:[1],domain:"continuous" as const};
    assert(near(closedLoopPeakGainDb(loop),20*Math.log10(.5),1e-8),String(closedLoopPeakGainDb(loop)));
    assert(closedLoopPeakGainDb({num:[-1],den:[1],domain:"continuous"})===Infinity,"a singular unity-feedback denominator must report an unbounded peak");
  });
  await test("LQG accepts matrix state and process-noise weights and validates covariance structure", () => {
    const plant={A:[[-1,1],[0,-2]],B:[0,1],C:[1,0],D:0,domain:"continuous" as const};
    const scalar=synthesizeLqg(plant,1,1,1),diagonal=synthesizeLqg(plant,[[1,0],[0,1]],[[1,0],[0,1]],1),weighted=synthesizeLqg(plant,[[10,0],[0,1]],[[1,0],[0,.1]],1),crossed=synthesizeLqg(plant,1,1,1,2,[0,.1],[.02,.03]),integralWeighted=synthesizeLqg(plant,1,1,1,1,[],[],3);
    const feedthroughPlant={...plant,D:.25},feedthroughController=synthesizeLqg(feedthroughPlant,1,1,1);
    assert(JSON.stringify(scalar.num)!==JSON.stringify(feedthroughController.num)||JSON.stringify(scalar.den)!==JSON.stringify(feedthroughController.den),"known plant feedthrough did not enter the observer/controller dynamics");
    assert(isFeedbackLoopStable(stateSpaceToTf(feedthroughPlant),feedthroughController),"LQG controller with known plant feedthrough did not stabilize the feedback loop");
    assert(JSON.stringify(scalar.num)===JSON.stringify(diagonal.num)&&JSON.stringify(scalar.den)===JSON.stringify(diagonal.den),"identity matrices did not preserve scalar-weight behavior");
    assert(JSON.stringify(diagonal.num)!==JSON.stringify(weighted.num)||JSON.stringify(diagonal.den)!==JSON.stringify(weighted.den),"anisotropic covariance did not affect the controller");
    assert(JSON.stringify(scalar.num)!==JSON.stringify(crossed.num)||JSON.stringify(scalar.den)!==JSON.stringify(crossed.den),"R and cross-covariance weights did not affect the controller");
    assert(JSON.stringify(scalar.num)!==JSON.stringify(integralWeighted.num)||JSON.stringify(scalar.den)!==JSON.stringify(integralWeighted.den),"independent QI did not affect the tracker");
    let nonsymmetric=false,indefinite=false,wrongSize=false,badCross=false,badQi=false;try{synthesizeLqg(plant,[[1,1],[0,1]],1,1)}catch{nonsymmetric=true}try{synthesizeLqg(plant,[[1,2],[2,1]],1,1)}catch{indefinite=true}try{synthesizeLqg(plant,[[1]],1,1)}catch{wrongSize=true}try{synthesizeLqg(plant,1,1,1,1,[3,0])}catch{badCross=true}try{synthesizeLqg(plant,1,1,1,1,[],[],0)}catch{badQi=true}
    assert(nonsymmetric&&indefinite&&wrongSize&&badCross&&badQi,"invalid weight matrix, cross-term, or QI was accepted");
  });
  await test("discrete bandwidth loop shaping prewarps the integrator and stays causal", () => {
    const ts=.1,bandwidth=2,staticPlant={num:[1],den:[1],domain:"discrete" as const,sampleTime:ts},controller=synthesizeLoopShapeByBandwidth(staticPlant,bandwidth),response=frequencyResponse(controller,bandwidth),expected=Math.tan(bandwidth*ts/2);
    assert(controller.domain==="discrete"&&controller.sampleTime===ts,"synthesis changed the sample time");
    assert(JSON.stringify(controller.den)==="[1,-1]","discrete integrator denominator is incorrect");
    assert(controller.num.length<=controller.den.length&&near(controller.num[0]!,expected,1e-10)&&near(controller.num[1]!,expected,1e-10),"prewarped wb/s numerator is incorrect");
    assert(near(Math.hypot(response.re,response.im),1,1e-9),"loop-shape magnitude is not unity at the requested bandwidth");
    const strictlyProper=synthesizeLoopShapeByBandwidth({num:[1],den:[1,-.5],domain:"discrete",sampleTime:ts},bandwidth);
    assert(strictlyProper.num.length===strictlyProper.den.length&&strictlyProper.den.every(Number.isFinite),"relative-degree filter did not keep the controller causal");
    let nyquistRejected=false,nonMinimumRejected=false;
    try{synthesizeLoopShapeByBandwidth(staticPlant,Math.PI/ts)}catch{nyquistRejected=true}
    try{synthesizeLoopShapeByBandwidth({num:[1,-1.1],den:[1,.5],domain:"discrete",sampleTime:ts},bandwidth)}catch{nonMinimumRejected=true}
    assert(nyquistRejected,"target at Nyquist was accepted");assert(nonMinimumRejected,"nonminimum-phase discrete plant was accepted");
  });
  await test("redução de ordem discreta mantém polos estáveis no plano z", () => {
    const ts=.05,full={num:[.2,-.1,.03,.01],den:[1,-1.9,1.17,-.189],domain:"discrete" as const,sampleTime:ts},reduced=reduceControllerOrder(full,2);
    assert(reduced.achievedOrder===2&&reduced.controller.domain==="discrete"&&reduced.controller.sampleTime===ts,"ordem ou Ts não foram preservados");
    assert(classifyStability(reduced.controller)==="stable","a redução criou polo fora do círculo unitário");
    assert(reduced.controller.num.length<=reduced.controller.den.length&&reduced.controller.den.length===3&&[...reduced.controller.num,...reduced.controller.den].every(Number.isFinite),"polinômios reduzidos são inválidos ou impróprios");
    for(const omega of [.1,1,8,20]){const response=frequencyResponse(reduced.controller,omega);assert(Number.isFinite(response.re)&&Number.isFinite(response.im),`resposta não finita em ${omega} rad/s`)}
    let unstableRejected=false;try{reduceControllerOrder({num:[1,0],den:[1,-1.9,.88],domain:"discrete",sampleTime:ts},1)}catch{unstableRejected=true}assert(unstableRejected,"polo discreto instável foi aceito na redução");
  });
  await test("persistencia conserva a injecao no residuo IMC", () => {
    const saved = validateControlDesignProject({ domain:"continuous", sampleTime:0.1, architecture:"imc", F:{num:"1",den:"1"}, C:{num:"1",den:"1"}, G:{num:"1",den:"1"}, H:{num:"1",den:"1"}, response:"output", requirements:[], alternatives:[], activeAlternative:"", analysisPlots:[{id:"imc-residual",name:"Residuo IMC",path:"output",type:"step",inputSignal:"point:imcResidual",outputSignal:"output"}] });
    assert(saved?.analysisPlots?.[0]?.inputSignal === "point:imcResidual", "validacao descartou o ponto residual do plot salvo");
  });
  await test("persistencia conserva as matrizes de ponderacao LQG", () => {
    const base={domain:"continuous",sampleTime:.1,F:{num:"1",den:"1"},C:{num:"1",den:"1"},G:{num:"1",den:"1"},H:{num:"1",den:"1"},response:"output",requirements:[],alternatives:[],activeAlternative:""},weights={state:[[2,.5],[.5,1]],processNoise:[[1,0],[0,.25]],control:2,integral:3,stateControlCross:[.1,.2],processMeasurementCross:[.03,.04]},saved=validateControlDesignProject({...base,lqgWeights:weights});
    assert(JSON.stringify(saved?.lqgWeights)===JSON.stringify(weights),"LQG weighting matrices did not persist");
  });
  await test("persistencia conserva a restricao de estabilidade multimodelo do otimizador", () => {
    const base={domain:"continuous",sampleTime:.1,F:{num:"1",den:"1"},C:{num:"1",den:"1"},G:{num:"1",den:"1"},H:{num:"1",den:"1"},response:"output",requirements:[],alternatives:[],activeAlternative:""};
    assert(validateControlDesignProject({...base,optimizerRequireStableVariants:true})?.optimizerRequireStableVariants===true,"a preferencia de estabilidade em todas as variantes nao persistiu");
  });
  await test("grade de frequencia Bode personalizada e respeitada", () => {
    const model={num:[1],den:[1,1],domain:"continuous" as const},custom=bode(model,240,[.1,1,17]);
    assert(JSON.stringify(custom.map(point=>point.omega))==="[0.1,1,17]","Bode alterou a grade expl?cita do usu?rio");
    let unsorted=false,aboveNyquist=false;try{bode(model,240,[1,.5])}catch{unsorted=true}try{bode({num:[1],den:[1,-.5],domain:"discrete",sampleTime:.1},240,[1,40])}catch{aboveNyquist=true}
    assert(unsorted&&aboveNyquist,"grade inv?lida ou acima de Nyquist foi aceita");
  });
  await test("amostragem de coeficientes e reproduzivel e respeita limites relativos", () => {
    const nominal={num:[2,1],den:[1,3,2],domain:"continuous" as const},options={count:12,tolerancePercent:10,seed:42},a=sampleTransferFunctionCoefficients(nominal,options),b=sampleTransferFunctionCoefficients(nominal,options);
    assert(JSON.stringify(a)===JSON.stringify(b),"a mesma semente produziu arrays diferentes");
    assert(a.length===12&&a.every(model=>model.den[0]===1&&model.num.every((value,index)=>Math.abs(value/nominal.num[index]!-1)<=.1+1e-12)&&model.den.slice(1).every((value,index)=>Math.abs(value/nominal.den[index+1]!-1)<=.1+1e-12)),"uma amostra saiu da tolerancia ou alterou o coeficiente lider do denominador");
    let invalid=false;try{sampleTransferFunctionCoefficients(nominal,{count:101,tolerancePercent:10,seed:42})}catch{invalid=true}assert(invalid,"mais de 100 amostras foram aceitas");
  });
  await test("coeficientes no mesmo grupo compartilham uma unica variacao aleatoria", () => {
    const nominal={num:[2,4],den:[1,3,6],domain:"continuous" as const},samples=sampleTransferFunctionCoefficients(nominal,{count:20,tolerancePercent:15,seed:9,sharedParameterGroups:{"num[0]":"wn","den[1]":"wn","den[2]":"wn"}});
    assert(samples.every(sample=>near(sample.num[0]!/2,sample.den[1]!/3)&&near(sample.num[0]!/2,sample.den[2]!/6)),"os membros do grupo nao compartilharam o mesmo fator");
    let invalid=false;try{sampleTransferFunctionCoefficients(nominal,{count:2,tolerancePercent:10,seed:1,sharedParameterGroups:{"num[7]":"x"}})}catch{invalid=true}assert(invalid,"caminho de coeficiente inexistente foi aceito");
  });
  await test("parametros incertos usam faixas reais compartilhadas e potencias por coeficiente", () => {
    const samples=sampleTransferFunctionCoefficients({num:[1],den:[1,12,100],domain:"continuous"},{count:30,tolerancePercent:0,seed:27,parameterUncertainty:{parameters:{wn:{nominal:10,range:[7,13]},zeta:{nominal:.6,range:[.5,.8]}},coefficients:{"den[1]":[{parameter:"zeta",power:1},{parameter:"wn",power:1}],"den[2]":[{parameter:"wn",power:2}]}}});
    for(const sample of samples){const wn=10*Math.sqrt(sample.den[2]!/100),zeta=sample.den[1]!/(2*wn);assert(wn>=7&&wn<=13&&zeta>=.5&&zeta<=.8&&near(sample.den[2]!,wn*wn),"a amostra nao respeitou os limites e a dependencia analitica zeta*wn, wn^2")}
  });
  await test("expressoes matematicas seguras definem coeficientes TF a partir de parametros compartilhados", () => {
    const model={num:[1],den:[1,12,100],domain:"continuous" as const},options={count:30,tolerancePercent:0,seed:281,parameterUncertainty:{parameters:{wn:{nominal:10,range:[7,13] as [number,number]},zeta:{nominal:.6,range:[.5,.8] as [number,number]},gain:{nominal:1,range:[.5,1.5] as [number,number]}},expressions:{"den[1]":"2*zeta*wn","den[2]":"wn^2","num[0]":"max(0.5, exp(log(gain)))"}}},samples=sampleTransferFunctionCoefficients(model,options),again=sampleTransferFunctionCoefficients(model,options);
    assert(JSON.stringify(samples)===JSON.stringify(again),"amostragem por expressoes nao e reproduzivel");
    assert(samples.every(sample=>{const wn=Math.sqrt(sample.den[2]!),zeta=sample.den[1]!/(2*wn);return wn>=7&&wn<=13&&zeta>=.5&&zeta<=.8&&sample.num[0]!>=.5&&sample.num[0]!<=1.5}),"as expressoes nao mantiveram os parametros compartilhados nas faixas declaradas");
    const structuralZero=sampleTransferFunctionCoefficients({num:[1],den:[1,2,0],domain:"continuous"},{count:24,tolerancePercent:0,seed:3,parameterUncertainty:{parameters:{offset:{nominal:1,range:[.8,1.2]}},expressions:{"den[2]":"offset-1"}}});
    assert(structuralZero.some(sample=>sample.den[2]!==0),"expressao nao habilitou um coeficiente nominalmente zero");
    const stateSamples=sampleStateSpaceCoefficients({A:[[-10,0],[0,-20]],B:[1,0],C:[1,0],D:0,domain:"continuous"},{count:20,tolerancePercent:0,seed:17,parameterUncertainty:{parameters:{p:{nominal:10,range:[8,12]}},expressions:{"A[0][0]":"-p","A[1][1]":"-2*p"}}});
    assert(stateSamples.every(sample=>sample.A[0]![0]!>=-12&&sample.A[0]![0]!<=-8&&near(sample.A[1]![1]!,2*sample.A[0]![0]!)),"expressoes gerais nao foram aplicadas de forma consistente em A/B/C/D");
    let unsafeRejected=false;try{sampleTransferFunctionCoefficients(model,{...options,parameterUncertainty:{...options.parameterUncertainty,expressions:{"den[1]":"globalThis.process.exit()"}}})}catch{unsafeRejected=true}assert(unsafeRejected,"expressao executavel foi aceita");
    let nominalMismatchRejected=false;try{sampleTransferFunctionCoefficients(model,{...options,parameterUncertainty:{...options.parameterUncertainty,expressions:{"den[1]":"zeta*wn"}}})}catch{nominalMismatchRejected=true}assert(nominalMismatchRejected,"expressao que nao reproduz o coeficiente nominal foi aceita");
  });
  await test("expressao parametrica e validada e persistida sem executar codigo", () => {
    const base={domain:"continuous",sampleTime:.1,F:{num:"1",den:"1"},C:{num:"1",den:"1"},G:{num:"1",den:"1, 2, 0"},H:{num:"1",den:"1"},response:"output",requirements:[],alternatives:[],activeAlternative:""},settings={sampleCount:12,plantTolerancePercent:0,sensorTolerancePercent:0,seed:42,parameterUncertainty:{parameters:{wn:{nominal:1,range:[.8,1.2] as [number,number]}},expressions:{"den[1]":"1+wn"}}},saved=validateControlDesignProject({...base,uncertaintySampling:settings});
    assert(JSON.stringify(saved?.uncertaintySampling)===JSON.stringify(settings),"expressao parametrica valida nao foi preservada");
    const invalid=validateControlDesignProject({...base,uncertaintySampling:{...settings,parameterUncertainty:{...settings.parameterUncertainty,expressions:{"den[1]":"window.alert(1)"}}}});
    assert(!invalid?.uncertaintySampling?.parameterUncertainty,"expressao com chamada JavaScript arbitraria foi preservada");
  });
  await test("dependencias afins variam coeficiente nominal zero e mantem o nominal na faixa central", () => {
    const options={count:24,tolerancePercent:0,seed:731,parameterUncertainty:{parameters:{damping:{nominal:0,range:[-.4,.4] as [number,number]}},affineCoefficients:{"den[1]":[{parameter:"damping",scale:1}]}}},model={num:[1],den:[1,0,25],domain:"continuous" as const},samples=sampleTransferFunctionCoefficients(model,options),again=sampleTransferFunctionCoefficients(model,options);
    assert(JSON.stringify(samples)===JSON.stringify(again),"amostragem afim nao e reprodutivel");
    assert(samples.every(sample=>sample.den[0]===1&&sample.den[2]===25&&Math.abs(sample.den[1]!)<=.4)&&samples.some(sample=>sample.den[1]!==0),"coeficiente nominal zero nao foi amostrado dentro da faixa afim");
    const nominal=sampleTransferFunctionCoefficients(model,{...options,count:1,parameterUncertainty:{parameters:{damping:{nominal:0,range:[0,0]}},affineCoefficients:{"den[1]":[{parameter:"damping",scale:1}]}}})[0]!;
    assert(nominal.den[1]===0,"dependencia afim nao preservou o modelo nominal");
  });
  await test("um parametro incerto compartilhado correlaciona ocorrencias em A/B/C/D", () => {
    const samples=sampleStateSpaceCoefficients({A:[[-10,0],[0,-20]],B:[1,0],C:[1,0],D:0,domain:"continuous"},{count:24,tolerancePercent:0,seed:19,parameterUncertainty:{parameters:{p:{nominal:10,range:[8,12]}},coefficients:{"A[0][0]":[{parameter:"p",power:1}],"A[1][1]":[{parameter:"p",power:1}],"B[0]":[{parameter:"p",power:1}]}}});
    assert(samples.every(sample=>{const p=-sample.A[0]![0]!;return p>=8&&p<=12&&near(sample.A[1]![1]!, -2*p)&&near(sample.B[0]!,p/10)}),"A/B nao compartilharam o mesmo parametro nominal e faixa");
  });
  await test("dependencia afim habilita acoplamento incerto em entrada A/B/C/D nominalmente estrutural", () => {
    const model={A:[[-1,0],[0,-2]],B:[1,0],C:[0,1],D:0,domain:"continuous" as const},samples=sampleStateSpaceCoefficients(model,{count:20,tolerancePercent:0,seed:17,parameterUncertainty:{parameters:{coupling:{nominal:.5,range:[.2,.8]}},affineCoefficients:{"A[1][0]":[{parameter:"coupling",scale:1}]}}});
    assert(samples.every(sample=>Math.abs(sample.A[1]![0]!)<=.3&&sample.A[0]![1]===0)&&new Set(samples.map(sample=>sample.A[1]![0])).size>1,"entrada afim nao variou apenas o acoplamento configurado");
  });
  await test("preferencias de amostragem de incerteza persistem no projeto", () => {
    const base={domain:"continuous",sampleTime:.1,F:{num:"1",den:"1"},C:{num:"1",den:"1"},G:{num:"1",den:"1"},H:{num:"1",den:"1"},response:"output",requirements:[],alternatives:[],activeAlternative:""},settings={sampleCount:12,plantTolerancePercent:10,sensorTolerancePercent:5,seed:42,parameterUncertainty:{parameters:{wn:{nominal:10,range:[7,13] as [number,number]},k:{nominal:0,range:[-1,1] as [number,number]}},coefficients:{"den[1]":[{parameter:"wn",power:1}]},affineCoefficients:{"A[0][1]":[{parameter:"k",scale:1}]}}},saved=validateControlDesignProject({...base,uncertaintySampling:settings});
    assert(JSON.stringify(saved?.uncertaintySampling)===JSON.stringify(settings),"preferencias ou semente da amostragem nao foram preservadas");
    const affineOnly={sampleCount:2,plantTolerancePercent:0,sensorTolerancePercent:0,seed:2,parameterUncertainty:{parameters:{k:{nominal:0,range:[-1,1] as [number,number]}},affineCoefficients:{"A[0][1]":[{parameter:"k",scale:1}]}}},affineSaved=validateControlDesignProject({...base,uncertaintySampling:affineOnly});
    assert(JSON.stringify(affineSaved?.uncertaintySampling)===JSON.stringify(affineOnly),"configuracao somente afim nao persistiu");
    const conflict=validateControlDesignProject({...base,uncertaintySampling:{...affineOnly,parameterUncertainty:{...affineOnly.parameterUncertainty,coefficients:{"A[0][1]":[{parameter:"k",power:1}]}}}});
    assert(!conflict?.uncertaintySampling?.parameterUncertainty,"configuracao que aplica dois modelos ao mesmo coeficiente foi parcialmente aceita");
  });
  await test("amostragem de estado perturba A/B/C/D sem mudar dimensoes ou zeros estruturais", () => {
    const nominal={A:[[-1,0],[0,-2]],B:[1,0],C:[1,0],D:0,domain:"continuous" as const},options={count:8,tolerancePercent:10,seed:7},samples=sampleStateSpaceCoefficients(nominal,options),again=sampleStateSpaceCoefficients(nominal,options);
    assert(JSON.stringify(samples)===JSON.stringify(again)&&samples.length===8,"amostragem A/B/C/D nao e reproduzivel");
    assert(samples.every(sample=>sample.A.length===2&&sample.A.every(row=>row.length===2)&&sample.B.length===2&&sample.C.length===2&&sample.A[0]![1]===0&&sample.A[1]![0]===0&&sample.D===0&&Math.abs(sample.A[0]![0]!/-1-1)<=.1+1e-12&&Math.abs(sample.A[1]![1]!/-2-1)<=.1+1e-12),"amostra A/B/C/D alterou dimensoes, zero estrutural ou saiu da tolerancia");
  });
  await test("formulas classicas Ziegler-Nichols e CHR aplicam parametros de referencia", () => {
    const znStep=zieglerNicholsStepParameters(2,1,4,"PID"),chr=chienHronesReswickParameters(2,1,4,"PID"),znFrequency=zieglerNicholsFrequencyParameters(3,2*Math.PI,"PI"),skogestad=skogestadImcPiParameters(2,1,4,2);
    assert(near(znStep.kp,2.4)&&near(znStep.ti!,2)&&near(znStep.td!,.5),"ZN step PID parameters differ from the published reaction-curve rules");
    assert(near(chr.kp,1.9)&&near(chr.ti!,2.4)&&near(chr.td!,.42),"CHR 0% disturbance PID parameters differ from its lookup table");
    assert(near(znFrequency.kp,1.35)&&near(znFrequency.ti!,2*Math.PI/1.2),"ZN ultimate-cycle PI parameters differ from the standard rule");
    assert(near(skogestad.kp,4/6)&&near(skogestad.ti!,4),"Skogestad IMC PI parameters differ from the FOPDT rule");
    let invalid=false;try{zieglerNicholsStepParameters(1,0,2,"PI")}catch{invalid=true}assert(invalid,"classical tuning accepted a zero delay");
  });
  await test("AMIGOf usa rad/s e o limite kappa zero para integrador", () => {
    const phi=135*Math.PI/180,kphi=1/(2*Math.sqrt(8)),integrating=amigofPiParameters(kphi,2,0,1);
    assert(near(integrating.kp,(2.5-.92*phi)/kphi)&&near(integrating.ti,(-3.05+1.72*phi)/2),JSON.stringify(integrating));
    const stable=amigofPiParameters(2,4,.25,-1),expectedKp=-(2.5-.92*phi)/(2*(1+(10.75-4.01*phi)*.25)),expectedTi=(-3.05+1.72*phi+(-6.10+3.44*phi)*.25)/4;
    assert(near(stable.kp,expectedKp)&&near(stable.ti,expectedTi),JSON.stringify(stable));
    let invalid=false;try{amigofPiParameters(1,0,0,1)}catch{invalid=true}assert(invalid,"AMIGOf aceitou frequencia nula");
  });
  await test("atraso de transporte usa aproximacao Pade e atraso z^-k exato", () => {
    const first=approximateTransportDelay(2,"continuous",.1,1),second=approximateTransportDelay(1,"continuous",.1,2),discrete=approximateTransportDelay(.2,"discrete",.1,4);
    assert(JSON.stringify(first.num)==="[-1,1]"&&JSON.stringify(first.den)==="[1,1]",JSON.stringify(first));
    assert(JSON.stringify(second.num)==="[0.08333333333333333,-0.5,1]"&&JSON.stringify(second.den)==="[0.08333333333333333,0.5,1]",JSON.stringify(second));
    assert(JSON.stringify(discrete.num)==="[1]"&&JSON.stringify(discrete.den)==="[1,0,0]",JSON.stringify(discrete));
    let fractional=false,invalidOrder=false;try{approximateTransportDelay(.25,"discrete",.1)}catch{fractional=true}try{approximateTransportDelay(1,"continuous",undefined,9)}catch{invalidOrder=true}
    assert(fractional&&invalidOrder,"aceitou atraso z fracionario em Ts ou ordem Pade fora do limite");
  });
  await test("atraso Pade afeta efetivamente fase e resposta em malha fechada", () => {
    const plant:TransferFunction={num:[1],den:[1,1],domain:"continuous"},delayed=tfMul(plant,approximateTransportDelay(1,"continuous",.1,1)),unit:TransferFunction={num:[1],den:[1],domain:"continuous"},before=frequencyResponse(plant,1),after=frequencyResponse(delayed,1),phase=(value:{re:number;im:number})=>Math.atan2(value.im,value.re)*180/Math.PI,closed=closeLoop(unit,unit,delayed,unit),undelayed=closeLoop(unit,unit,plant,unit);
    assert(near(phase(after)-phase(before),-2*Math.atan(.5)*180/Math.PI)&&JSON.stringify(closed.output.den)!==JSON.stringify(undelayed.output.den),"Padé nao alterou a fase e a resposta fechada");
  });
  await test("sintonia de malha admite planta instavel somente com realimentacao internamente estavel", () => {
    const plant:TransferFunction={num:[1],den:[1,-1],domain:"continuous"},stableController:TransferFunction={num:[2],den:[1],domain:"continuous"},weakController:TransferFunction={num:[.5],den:[1],domain:"continuous"},cancelPole:TransferFunction={num:[1,-1],den:[1,1],domain:"continuous"};
    assert(isFeedbackLoopStable(plant,stableController),"rejeitou controlador que estabiliza polo da planta");
    assert(!isFeedbackLoopStable(plant,weakController),"aceitou malha fechada instavel");
    assert(!isFeedbackLoopStable(plant,cancelPole),"cancelamento de polo instavel foi tratado como estabilidade interna");
  });
  await test("realizacao em espaco de estados preserva planta com atraso ao aplicar G", () => {
    const delayed=tfMul({num:[2],den:[1,3],domain:"continuous"},approximateTransportDelay(.4,"continuous",.1,2)),realized=stateSpaceToTf(tfToStateSpace(delayed));
    for(const omega of [.1,1,10]){const a=frequencyResponse(delayed,omega),b=frequencyResponse(realized,omega);assert(near(a.re,b.re,1e-7)&&near(a.im,b.im,1e-7),JSON.stringify({omega,a,b}))}
    const discrete=approximateTransportDelay(.2,"discrete",.1),discreteRealized=stateSpaceToTf(tfToStateSpace(discrete));
    for(const omega of [1,10,20]){const a=frequencyResponse(discrete,omega),b=frequencyResponse(discreteRealized,omega);assert(near(a.re,b.re,1e-7)&&near(a.im,b.im,1e-7),JSON.stringify({omega,a,b}))}
  });
  await test("preferencia de polos e zeros da planta/sensor e persistida por projeto", () => {
    const base={domain:"continuous",sampleTime:.1,F:{num:"1",den:"1"},C:{num:"1",den:"1"},G:{num:"1",den:"1, 1"},H:{num:"1",den:"1"},response:"output",requirements:[],alternatives:[],activeAlternative:""};
    const hidden=validateControlDesignProject({...base,showPlantSensorPolesZeros:false}),legacy=validateControlDesignProject(base);
    assert(hidden?.showPlantSensorPolesZeros===false&&legacy?.showPlantSensorPolesZeros===undefined,"preferencia explicita nao foi preservada ou o projeto legado ganhou um campo redundante");
  });
  await test("atraso e ordem Pade persistem e validam sample time e estado inicial", () => {
    const base={domain:"continuous",sampleTime:.1,F:{num:"1",den:"1"},C:{num:"1",den:"1"},G:{num:"1",den:"1, 1"},H:{num:"1",den:"1"},response:"output",requirements:[],alternatives:[],activeAlternative:""};
    const continuous=validateControlDesignProject({...base,plantDelaySeconds:1.25,padeOrder:4}),discrete=validateControlDesignProject({...base,domain:"discrete",plantDelaySeconds:.3,padeOrder:4}),fractional=validateControlDesignProject({...base,domain:"discrete",plantDelaySeconds:.25,padeOrder:4});
    const withInitialState=validateControlDesignProject({...base,plantDelaySeconds:.2,plantStateSpace:{A:[[-1]],B:[1],C:[1],D:0},plantInitialState:[1]});
    assert(continuous?.plantDelaySeconds===1.25&&continuous.padeOrder===4&&discrete?.plantDelaySeconds===.3&&!fractional&&!withInitialState,"atraso invalido ou estado inicial nao suportado nao foi validado");
  });
  await test("grade de frequencia Bode e preservada no projeto", () => {
    const base={domain:"continuous",sampleTime:.1,F:{num:"1",den:"1"},C:{num:"1",den:"1"},G:{num:"1",den:"1"},H:{num:"1",den:"1"},response:"output",requirements:[],alternatives:[],activeAlternative:""};
    const saved=validateControlDesignProject({...base,frequencyGrid:[.1,1,10]}),invalid=validateControlDesignProject({...base,frequencyGrid:[1,.1]});
    assert(JSON.stringify(saved?.frequencyGrid)==="[0.1,1,10]"&&invalid?.frequencyGrid===undefined,"grade personalizada nao foi validada/preservada corretamente");
  });
  await test("PID de dois graus de liberdade separa referencia e medicao", () => {
    const p={kp:1,ki:2,kd:3,filterN:10,tau:1,alpha:1},channels=twoDofPidChannels(p,.5,0);
    assert(JSON.stringify(channels.feedback.num)==="[31,12,20]"&&JSON.stringify(channels.feedback.den)==="[1,10,0]", "canal de feedback PIDF incorreto");
    assert(JSON.stringify(channels.reference.num)==="[0.5,7,20]"&&JSON.stringify(channels.reference.den)==="[1,10,0]", "canal de referencia 2DOF incorreto");
    const pi=twoDofPidChannels({...p,kd:0},0,0);
    assert(JSON.stringify(pi.reference.num)==="[2,20]"&&JSON.stringify(pi.feedback.num)==="[1,12,20]", "pesos b=c=0 devem manter a acao integral na referencia e no erro");
  });
  await test("multimodelo persiste estado inicial de cada realiza??o", () => {
    const saved=validateControlDesignProject({domain:"continuous",sampleTime:0.1,F:{num:"1",den:"1"},C:{num:"1",den:"1"},G:{num:"1",den:"1"},H:{num:"1",den:"1"},response:"output",requirements:[],alternatives:[],activeAlternative:"",plantVariants:[{name:"variante SS",color:"#89d185",plant:{num:"1",den:"1, 1"},stateSpace:{A:[[-1]],B:[1],C:[1],D:0},initialState:[2],sensor:{num:"1",den:"1"}}]});
    assert(saved?.plantVariants?.[0]?.initialState?.[0]===2,"validador descartou x0 da variante SS");
    const invalid=validateControlDesignProject({domain:"continuous",sampleTime:0.1,F:{num:"1",den:"1"},C:{num:"1",den:"1"},G:{num:"1",den:"1"},H:{num:"1",den:"1"},response:"output",requirements:[],alternatives:[],activeAlternative:"",plantVariants:[{name:"SS inv?lida",color:"#89d185",plant:{num:"1",den:"1"},stateSpace:{A:[[-1]],B:[1],C:[1],D:0},initialState:[1,2]}]});
    assert(invalid?.plantVariants?.length===0,"validador aceitou x0 com dimens?o diferente do n?mero de estados");
  });
  await test("persistencia conserva pesos e pre-filtro base do PID 2DOF", () => {
    const saved = validateControlDesignProject({ domain:"continuous", sampleTime:0.1, architecture:"forward-controller", F:{num:"2",den:"1, 1"}, C:{num:"31, 12, 20",den:"1, 10, 0"}, G:{num:"1",den:"1, 1"}, H:{num:"1",den:"1"}, response:"output", requirements:[], alternatives:[], activeAlternative:"", pidTwoDof:{enabled:true,b:0.5,c:0,basePrefilter:{num:"2",den:"1, 1"}},pidTuningParameters:{kp:1,ki:2,kd:3,filterN:10} });
    assert(saved?.pidTwoDof?.enabled === true && saved.pidTwoDof.b===0.5 && saved.pidTwoDof.basePrefilter?.den==="1, 1", "validacao descartou a configuracao persistente do PID 2DOF");
  });
  await test("Simulink export preserves the six SISO control architectures", () => {
    const base={domain:"continuous",sampleTime:.1,F:{num:"2",den:"1, 1"},C:{num:"3",den:"1"},G:{num:"4",den:"1, 2"},H:{num:"5",den:"1"},H2:{num:"6",den:"1"},C2:{num:"7",den:"1"},response:"output",requirements:[],alternatives:[],activeAlternative:""} as any;
    const direct=controlDesignSimulinkScript(base);
    assert(direct.includes("'Inputs','+-'")&&direct.includes("'F/1','Sum_e/1'")&&direct.includes("'H/1','Sum_e/2'")&&direct.includes("'Sum_e/1','C/1'")&&direct.includes("'C/1','G/1'")&&direct.includes("save_system(mdl,[mdl '.slx'])"),"the default Simulink diagram does not match F -> sum -> C -> G with negative H feedback");
    for(const architecture of ["feedback-controller","feedforward-disturbance","nested-inner-feedback","imc","nested-inner-forward"]){const script=controlDesignSimulinkScript({...base,architecture});assert(script.includes(`% Arquitetura: ${architecture}`)&&script.includes("add_line(mdl,")&&script.includes("Simulink.BlockDiagram.arrangeSystem"),`model generation omitted ${architecture}`)}
    const discrete=controlDesignSimulinkScript({...base,domain:"discrete",architecture:"forward-controller",plantDelaySeconds:.2,plantStateSpace:{A:[[-1]],B:[1],C:[1],D:0},plantInitialState:[.25]});
    assert(discrete.includes("Discrete State-Space")&&discrete.includes("'InitialCondition','[0.250000000000000]'" )&&discrete.includes("'DelayLength','2'")&&discrete.includes("FixedStepDiscrete"),"discrete state-space plant, x0, or sample delay was omitted");
    const multistate=controlDesignSimulinkScript({...base,plantStateSpace:{A:[[0,1],[-2,-3]],B:[0,1],C:[1,0],D:0}});
    assert(multistate.includes("'B','[0.00000000000000; 1.00000000000000]'"),"state-space B must be emitted as an n-by-1 column vector");
    const cascade=controlDesignSimulinkScript({...base,architecture:"nested-inner-forward"});
    assert(cascade.includes("'r/1','F/1'")&&cascade.includes("'F/1','Sum_outer/1'"),"configuration 6 must route the reference through prefilter F before the outer summing junction");
    const nested=controlDesignSimulinkScript({...base,architecture:"nested-inner-feedback"});
    assert(!nested.includes("H2")&&nested.includes("'G/1','C2/1'"),"configuration 4 must close C2 directly around G and omit unsupported H2 dynamics");
    for(const architecture of ["forward-controller","feedback-controller","feedforward-disturbance","nested-inner-feedback","imc","nested-inner-forward"]){
      const script=controlDesignSimulinkScript({...base,architecture,plantDelaySeconds:.2});
      const declared=new Set([...script.matchAll(/add_block\([^\n]*\[mdl '\/([^']+)'\]/g)].map(match=>match[1]!));
      const sums=new Map([...script.matchAll(/add_block\('simulink\/Math Operations\/Sum',[^\n]*\[mdl '\/([^']+)'\],[^\n]*'Inputs','([+-]+)'/g)].map(match=>[match[1]!,match[2]!] as const));
      const used=new Map<string,number[]>();
      for(const match of script.matchAll(/add_line\(mdl,'([^/]+)\/1','([^/]+)\/(\d+)'/g)){
        const from=match[1]!,to=match[2]!,portText=match[3]!;
        const port=Number(portText);
        assert(declared.has(from)&&declared.has(to),`${architecture}: wire references missing block ${from} -> ${to}`);
        if(sums.has(to)){assert(port>=1&&port<=sums.get(to)!.length,`${architecture}: invalid input port ${to}/${port}`);used.set(to,[...(used.get(to)??[]),port])}
      }
      for(const [name,signs] of sums){const ports=(used.get(name)??[]).sort((a,b)=>a-b);assert(ports.join(",")==Array.from({length:signs.length},(_,i)=>i+1).join(","),`${architecture}: sum ${name} has missing or duplicate input ports: ${ports}`)}
    }
  });
  await test("analysis response plots preserve StepPlot input settings", () => {
    const plot={id:"biased-response",name:"Biased response",path:"output",type:"step",inputAmplitude:2,responseBias:1,responseDelay:.2,responseTimeVector:[0,.05,.2,1],responseRiseStartPercent:20,responseRiseEndPercent:80,responseSettlingPercent:5};
    const saved=validateControlDesignProject({domain:"continuous",sampleTime:.1,F:{num:"1",den:"1"},C:{num:"1",den:"1"},G:{num:"1",den:"1, 1"},H:{num:"1",den:"1"},response:"output",requirements:[],alternatives:[],activeAlternative:"",analysisPlots:[plot]});
    assert(saved?.analysisPlots?.[0]?.responseBias===1&&saved.analysisPlots[0].inputAmplitude===2,"StepPlot input bias was not persisted");
    assert(saved?.analysisPlots?.[0]?.responseTimeVector?.join(",")==="0,0.05,0.2,1"&&saved.analysisPlots[0].responseDelay===.2,"StepPlot time settings were not persisted");
    const simultaneous=validateControlDesignProject({domain:"continuous",sampleTime:.1,F:{num:"1",den:"1"},C:{num:"1",den:"1"},G:{num:"1",den:"1, 1"},H:{num:"1",den:"1"},response:"output",requirements:[],alternatives:[],activeAlternative:"",analysisPlots:[{id:"weighted-sources",name:"Fontes ponderadas",path:"output",type:"step",series:[{inputSignal:"reference",inputSignals:["reference","measurementNoise"],inputAmplitudes:[2,-.5],outputSignal:"output"}]}],analysisResponses:[{id:"weighted-response",name:"Fontes ponderadas",path:"output",series:[{inputSignal:"reference",inputSignals:["reference","measurementNoise"],inputAmplitudes:[2,-.5],outputSignal:"output"}]}]});
    assert(simultaneous?.analysisPlots?.[0]?.series?.[0]?.inputAmplitudes?.join(",")==="2,-0.5","independent input amplitudes were not persisted on analysis plots");
    assert(simultaneous?.analysisResponses?.[0]?.series?.[0]?.inputAmplitudes?.join(",")==="2,-0.5","independent input amplitudes were not persisted on saved responses");
    const arbitrary=validateControlDesignProject({domain:"continuous",sampleTime:.1,F:{num:"1",den:"1"},C:{num:"1",den:"1"},G:{num:"1",den:"1, 1"},H:{num:"1",den:"1"},response:"output",requirements:[],alternatives:[],activeAlternative:"",analysisPlots:[{id:"arbitrary-input",name:"Entrada arbitraria",path:"output",type:"lsim",responseTimeVector:[0,.1,.2],responseInputValues:[0,1,0]}]});
    assert(arbitrary?.analysisPlots?.[0]?.type==="lsim"&&arbitrary.analysisPlots[0].responseInputValues?.join(",")==="0,1,0","arbitrary input response was not persisted");
    const rejectedMismatch=validateControlDesignProject({domain:"continuous",sampleTime:.1,F:{num:"1",den:"1"},C:{num:"1",den:"1"},G:{num:"1",den:"1, 1"},H:{num:"1",den:"1"},response:"output",requirements:[],alternatives:[],activeAlternative:"",analysisPlots:[{id:"bad-lsim",name:"Entrada invalida",path:"output",type:"lsim",responseTimeVector:[0,.1,.2],responseInputValues:[1,0]}]});
    assert(!rejectedMismatch?.analysisPlots?.length,"mismatched time/input vectors were accepted");
    const withInitial=validateControlDesignProject({domain:"continuous",sampleTime:.1,F:{num:"1",den:"1"},C:{num:"1",den:"1"},G:{num:"1",den:"1, 1"},H:{num:"1",den:"1"},plantStateSpace:{A:[[-1]],B:[1],C:[1],D:0},response:"output",requirements:[],alternatives:[],activeAlternative:"",analysisPlots:[{id:"initial-state",name:"Resposta inicial",path:"output",type:"step",initialState:[2]}]});
    assert(withInitial?.analysisPlots?.[0]?.initialState?.[0]===2,"StepPlot InitialCondition was not persisted");
  });
  await test("persistencia conserva plots de valor singular", () => {
    const saved = validateControlDesignProject({ domain:"continuous", sampleTime:0.1, architecture:"forward-controller", F:{num:"1",den:"1"}, C:{num:"1",den:"1"}, G:{num:"1",den:"1, 1"}, H:{num:"1",den:"1"}, response:"output", requirements:[], alternatives:[], activeAlternative:"", analysisPlots:[{id:"sigma-response",name:"Valor singular",path:"output",type:"sigma",frequencyScale:"log",frequencyUnit:"Hz"}] });
    assert(saved?.analysisPlots?.[0]?.type === "sigma" && saved.analysisPlots[0].frequencyUnit === "Hz", "validador descartou o plot singular ou suas configuracoes");
  });
  await test("frequency-plot preferences persist without changing legacy projects", () => {
    const base={domain:"continuous",sampleTime:.1,F:{num:"1",den:"1"},C:{num:"1",den:"1"},G:{num:"1",den:"1, 1"},H:{num:"1",den:"1"},response:"output",requirements:[],alternatives:[],activeAlternative:""};
    const legacy=validateControlDesignProject(base),configured=validateControlDesignProject({...base,phaseUnit:"rad",phaseWrapAt:0,minimumMagnitudeDb:-65,showPlotGrid:false,timeUnit:"milliseconds",plotFontSize:14,plotFontBold:true,plotFontItalic:true,plotAxesColor:"#09FF09"}),invalid=validateControlDesignProject({...base,phaseWrapAt:Infinity,minimumMagnitudeDb:1001,showPlotGrid:"false",timeUnit:"fortnights",plotFontSize:100,plotAxesColor:"green"});
    assert(legacy!==undefined&&!Object.prototype.hasOwnProperty.call(legacy,"phaseUnit")&&!Object.prototype.hasOwnProperty.call(legacy,"phaseWrapAt")&&!Object.prototype.hasOwnProperty.call(legacy,"minimumMagnitudeDb")&&!Object.prototype.hasOwnProperty.call(legacy,"showPlotGrid")&&!Object.prototype.hasOwnProperty.call(legacy,"timeUnit")&&!Object.prototype.hasOwnProperty.call(legacy,"plotFontSize"),"legacy project normalization changed preference fields");
    assert(configured?.phaseUnit==="rad"&&configured.phaseWrapAt===0&&configured.minimumMagnitudeDb===-65&&configured.showPlotGrid===false&&configured.timeUnit==="milliseconds"&&configured.plotFontSize===14&&configured.plotFontBold===true&&configured.plotFontItalic===true&&configured.plotAxesColor==="#09ff09","plot style/unit preferences did not persist");
    assert(invalid?.phaseWrapAt===undefined&&invalid?.minimumMagnitudeDb===undefined&&invalid?.showPlotGrid===undefined&&invalid?.timeUnit===undefined&&invalid?.plotFontSize===undefined&&invalid?.plotAxesColor===undefined,"out-of-range plot preference was accepted");
  });
  await test("MATLAB frequency units round-trip for plot axes and FRD imports", () => {
    const omega=3.7,ts=.025,timeUnit="milliseconds" as const;
    for(const unit of CONTROL_DESIGN_FREQUENCY_UNITS){
      const displayed=frequencyToDisplay(omega,unit,ts,timeUnit),restored=frequencyFromDisplay(displayed,unit,ts,timeUnit);
      assert(Number.isFinite(displayed)&&near(restored,omega,1e-12),`frequency unit ${unit} did not round-trip: ${displayed} -> ${restored}`);
    }
    assert(near(frequencyToDisplay(omega,"auto",ts,timeUnit),omega*.001,1e-12),"auto should display radians per selected time unit");
    assert(near(frequencyToDisplay(omega,"cycles/hour",ts,timeUnit),omega*3600/(2*Math.PI),1e-12),"cycles/hour scale is incorrect");
    assert(near(frequencyToDisplay(omega,"Hz",ts,timeUnit),omega/(2*Math.PI),1e-12),"Hz scale is incorrect");
    assert(near(frdFrequencyToRadPerSecond(2,"cycles/hour",ts,timeUnit),4*Math.PI/3600,1e-12),"FRD cycles/hour import did not normalize to rad/s");
    const project=validateControlDesignProject({domain:"continuous",sampleTime:ts,F:{num:"1",den:"1"},C:{num:"1",den:"1"},G:{num:"1",den:"1, 1"},H:{num:"1",den:"1"},response:"output",requirements:[],alternatives:[],activeAlternative:"",frequencyUnit:"cycles/hour",analysisPlots:[{id:"custom-frequency",name:"Frequency axis",path:"output",type:"bode",frequencyUnit:"rad/millisecond"}]});
    assert(project?.frequencyUnit==="cycles/hour"&&project.analysisPlots?.[0]?.frequencyUnit==="rad/millisecond","expanded frequency units did not persist");
  });
  await test("abertura de malha no ponto grafico persiste apenas para fio e arquitetura compativeis", () => {
    const base={domain:"continuous",sampleTime:.1,architecture:"forward-controller",F:{num:"1",den:"1"},C:{num:"2",den:"1"},G:{num:"1",den:"1, 1"},H:{num:"1",den:"1"},response:"output",requirements:[],alternatives:[],activeAlternative:""};
    const plot={id:"selected-wire-loop",name:"Loop no fio u",path:"loop",type:"bode",inputSignal:"point:control",outputSignal:"output",loopOpening:"analysisPoint",series:[{inputSignal:"point:control",outputSignal:"output",loopOpening:"analysisPoint"}]};
    const nestedPlot={...plot,inputSignal:"point:innerControl",series:[{inputSignal:"point:innerControl",outputSignal:"output",loopOpening:"analysisPoint"}]},imcPlot={...plot,inputSignal:"point:imcResidual",series:[{inputSignal:"point:imcResidual",outputSignal:"output",loopOpening:"analysisPoint"}]},unsupportedPlot={...plot,inputSignal:"point:imcResidual",series:[{inputSignal:"point:imcResidual",outputSignal:"output",loopOpening:"analysisPoint"}]};
    const accepted=validateControlDesignProject({...base,analysisPlots:[plot]}),nested=validateControlDesignProject({...base,architecture:"nested-inner-forward",analysisPlots:[nestedPlot]}),imc=validateControlDesignProject({...base,architecture:"imc",analysisPlots:[imcPlot]}),rejected=validateControlDesignProject({...base,architecture:"feedback-controller",analysisPlots:[unsupportedPlot]});
    assert(accepted?.analysisPlots?.[0]?.loopOpening==="analysisPoint"&&accepted.analysisPlots[0].path==="loop","abertura no ponto selecionado nao persistiu");
    assert(nested?.analysisPlots?.[0]?.loopOpening==="analysisPoint"&&imc?.analysisPlots?.[0]?.loopOpening==="analysisPoint","abertura interna ou residual nao persistiu na arquitetura correspondente");
    assert(!rejected?.analysisPlots?.length,"abertura de ponto foi aceita fora da arquitetura ou fio marcado");
  });
  await test("pontos de analise nomeados persistem com posicao, arquitetura, sinal e finalidades", () => {
    const base={domain:"continuous",sampleTime:.1,architecture:"forward-controller",F:{num:"1",den:"1"},C:{num:"1",den:"1"},G:{num:"1",den:"1, 1"},H:{num:"1",den:"1"},response:"output",requirements:[],alternatives:[],activeAlternative:""};
    const point={id:"tap_u",name:"Tap u",architecture:"forward-controller",source:"point:control",x:176.5,y:62,purposes:{input:true,output:true,loopOpening:true}};
    const saved=validateControlDesignProject({...base,analysisPoints:[point]});
    assert(saved?.analysisPoints?.length===1&&saved.analysisPoints[0]?.id===point.id&&saved.analysisPoints[0]?.x===176.5&&saved.analysisPoints[0]?.purposes.loopOpening,"analysis point identity or wire location did not persist");
    const unsupported=validateControlDesignProject({...base,analysisPoints:[{...point,source:"reference"}]});
    assert(!unsupported?.analysisPoints?.length,"an analysis point without a wire source was accepted");
  });
  await test("persistencia aceita medida de residuo como saida de analise IMC", () => {
    const saved=validateControlDesignProject({domain:"continuous",sampleTime:.1,architecture:"imc",F:{num:"1",den:"1"},C:{num:"1",den:"1"},G:{num:"1",den:"1, 1"},H:{num:"1",den:"1, 1"},C2:{num:"1",den:"1"},response:"output",requirements:[],alternatives:[],activeAlternative:"",analysisPlots:[{id:"imc-residual",name:"Residuo IMC",path:"imcResidual",type:"step",inputSignal:"point:imcResidual",outputSignal:"imcResidual"}]});
    assert(saved?.analysisPlots?.[0]?.outputSignal==="imcResidual","validador descartou o residuo IMC como sinal de saida");
  });
  await test("persistencia conserva abertura de malha em respostas padrao L e S", () => {
    const saved = validateControlDesignProject({ domain:"continuous", sampleTime:0.1, architecture:"nested-inner-feedback", F:{num:"1",den:"1"}, C:{num:"1",den:"1"}, G:{num:"1",den:"1"}, H:{num:"1",den:"1"}, C2:{num:"1",den:"1"}, H2:{num:"1",den:"1"}, response:"output", requirements:[], alternatives:[], activeAlternative:"", analysisPlots:[{id:"outer-loop",name:"Malha externa",path:"loop",type:"bode",loopOpening:"innerFeedbackSensor"}], analysisResponses:[{id:"outer-loop-response",name:"Malha externa",path:"loop",loopOpening:"innerFeedbackSensor"}] });
    assert(saved?.analysisPlots?.[0]?.loopOpening === "innerFeedbackSensor", "validador descartou a abertura adicional do plot L");
    assert(saved?.analysisResponses?.[0]?.loopOpening === "innerFeedbackSensor", "validador descartou a abertura adicional da resposta salva");
  });
  await test("amplitudes independentes de fontes simultaneas obedecem superposicao", () => {
    const unit=validateTf({num:[1],den:[1],domain:"continuous"}),plant=validateTf({num:[1],den:[1,1],domain:"continuous"}),analysis=closeLoop(unit,unit,plant,unit),weighted=tfAdd(tfScale(analysis.output,2),tfScale(analysis.measurementNoiseOutput,-.5)),expected=validateTf({num:[2.5],den:[1,2],domain:"continuous"}),actualSamples=timeResponse(weighted,"step",2,101).samples,expectedSamples=timeResponse(expected,"step",2,101).samples;
    assert(actualSamples.every((sample,index)=>near(sample.value,expectedSamples[index]!.value,1e-7)),"weighted sources do not match the linear superposition reference");
  });
  await test("interconexÃ£o distinta de Y/R, U/R, S e T com F=H=1", () => {
    const tf = (num: number[], den: number[]): TransferFunction => ({ num, den, domain: "continuous" });
    const a = closeLoop(tf([1],[1]), tf([4],[1]), tf([1],[1,2,0]), tf([1],[1]));
    assert(JSON.stringify(a.output.num) === JSON.stringify([4]) && JSON.stringify(a.output.den) === JSON.stringify([1,2,4]), JSON.stringify(a));
    assert(JSON.stringify(a.sensitivity.num) === JSON.stringify([1,2,0]) && JSON.stringify(a.complementary.num) === JSON.stringify([4]), "S e T nÃ£o foram distinguidas");
    assert(JSON.stringify(a.control.num) === JSON.stringify([4,8,0]), "U/R incorreta");
  });
  await test("abertura de realimentacao em H*y remove o fechamento", () => {
    const tf = (num: number[], den: number[]): TransferFunction => ({ num, den, domain: "continuous" });
    const a = closeLoop(tf([2],[1]),tf([3],[1]),tf([1],[1,1]),tf([4],[1]),undefined,"forward-controller",undefined,undefined,true);
    assert(JSON.stringify(a.output.num)==="[6]"&&JSON.stringify(a.output.den)==="[1,1]","abertura nao removeu o retorno no caminho de referencia");
    assert(JSON.stringify(a.control.num)==="[6]"&&JSON.stringify(a.control.den)==="[1]","transferencia r para u com malha aberta incorreta");
    assert(JSON.stringify(a.plantInputDisturbance.num)==="[1]"&&JSON.stringify(a.plantInputDisturbance.den)==="[1,1]","perturbacao da planta deveria atravessar somente G");
    assert(JSON.stringify(a.measurementNoiseOutput.num)==="[-3]"&&JSON.stringify(a.measurementNoiseOutput.den)==="[1,1]"&&JSON.stringify(a.measurementNoiseControl.num)==="[-3]","ruido aditivo no somador incorreto com H*y aberto");
    const feedback = closeLoop(tf([2],[1]),tf([3],[1]),tf([1],[1,1]),tf([4],[1]),undefined,"feedback-controller",undefined,undefined,true);
    assert(JSON.stringify(feedback.output.num)==="[2]"&&JSON.stringify(feedback.output.den)==="[1,1]"&&JSON.stringify(feedback.control.num)==="[2]","abertura antes de C na realimentacao incorreta");
    assert(JSON.stringify(feedback.measurementNoiseOutput.num)==="[0]","o ruido depois do corte nao pode fechar a malha");
  });
  await test("aberturas externa, interna e simultanea em malha aninhada", () => {
    const tf=(num:number[],den:number[]):TransferFunction=>({num,den,domain:"continuous"}),u=tf([1],[1]),g=tf([1],[1,1]);
    const outer=closeLoop(u,u,g,u,undefined,"nested-inner-feedback",u,u,true,false);
    const inner=closeLoop(u,u,g,u,undefined,"nested-inner-feedback",u,u,false,true);
    const both=closeLoop(u,u,g,u,undefined,"nested-inner-feedback",u,u,true,true);
    const ignoredPrefilter=closeLoop(tf([2],[1]),u,g,u,undefined,"nested-inner-feedback",u,u),cascadePrefilter=closeLoop(tf([2],[1]),u,g,u,undefined,"nested-inner-forward",u,u),ignoredInnerSensor=closeLoop(u,u,g,u,undefined,"nested-inner-feedback",u,tf([2],[1])),activeInnerSensor=closeLoop(u,u,g,u,undefined,"nested-inner-forward",u,tf([2],[1]));
    assert(JSON.stringify(outer.output.num)==="[1]"&&JSON.stringify(outer.output.den)==="[1,2]","malha externa aberta deve preservar malha interna fechada");
    assert(JSON.stringify(inner.output.num)==="[1]"&&JSON.stringify(inner.output.den)==="[1,2]","malha interna aberta deve manter retorno externo");
    assert(JSON.stringify(both.output.num)==="[1]"&&JSON.stringify(both.output.den)==="[1,1]","abrir ambas deve expor planta sem realimentacao");
    assert(JSON.stringify(ignoredPrefilter.output.num)==="[1]"&&JSON.stringify(ignoredPrefilter.output.den)==="[1,3]","configuration 4 must not apply prefilter F");
    assert(JSON.stringify(cascadePrefilter.output.num)==="[2]"&&JSON.stringify(cascadePrefilter.output.den)==="[1,3]","configuration 6 must apply prefilter F before the outer loop");
    assert(JSON.stringify(ignoredInnerSensor.output.num)==="[1]"&&JSON.stringify(ignoredInnerSensor.output.den)==="[1,3]","configuration 4 must use unity inner feedback and the single documented H sensor");
    assert(JSON.stringify(activeInnerSensor.output.num)==="[1]"&&JSON.stringify(activeInnerSensor.output.den)==="[1,4]","configuration 6 must retain the inner sensor H1/H2 dynamics");
  });  await test("prÃ©-filtro, sensor nÃ£o unitÃ¡rio e perturbaÃ§Ãµes respeitam os pontos de injeÃ§Ã£o", () => {
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
    const staticGain=transferFromPolesZeros([],[],3,"continuous");
    assert(JSON.stringify(staticGain.num)==="[3]"&&JSON.stringify(staticGain.den)==="[1]",JSON.stringify(staticGain));
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
  await test("RK4 preserva resposta com polos lentos e rÃ¡pidos na mesma janela", () => {
    const tf=transferFromPolesZeros([], [{re:-.027,im:1.002},{re:-.027,im:-1.002},{re:-2.24,im:0},{re:-39.7,im:0}], 1, "continuous");
    const response=timeResponse(tf,"step",100,800);
    assert(response.converged&&response.samples.length===800&&response.samples.every(sample=>Number.isFinite(sample.value)),"integraÃ§Ã£o instÃ¡vel em escalas de tempo mistas");
  });
  await test("time response honors a nonuniform requested time vector", () => {
    const times=[0,.05,.2,.75,2],response=timeResponse({num:[1],den:[1,1],domain:"continuous"},"step",2,200,times);
    assert(response.samples.map(sample=>sample.time).every((time,index)=>time===times[index]),JSON.stringify(response.samples));
    assert(response.samples.every((sample,index)=>Math.abs(sample.value-(1-Math.exp(-times[index]!)))<1e-5),JSON.stringify(response.samples));
    let rejected=false;try{timeResponse({num:[1],den:[1,-.5],domain:"discrete",sampleTime:.1},"step",.5,10,[0,.15,.5])}catch{rejected=true}
    assert(rejected,"discrete sample times not aligned to Ts must be rejected");
    const discrete=timeResponse({num:[1],den:[1,-.5],domain:"discrete",sampleTime:.1},"step",.5,10,[0,.2,.5]);
    assert(discrete.samples.length===3&&near(discrete.samples[1]!.value,1.5)&&near(discrete.samples[2]!.value,1.9375),JSON.stringify(discrete.samples));
  });
  await test("percentuais de subida e acomoda??o s?o configur?veis", () => {
    const samples=[{time:0,value:0},{time:1,value:.2},{time:2,value:.8},{time:3,value:1.02},{time:4,value:1}];
    const metrics=stepMetrics(samples,1,{riseStartPercent:20,riseEndPercent:80,settlingPercent:5});
    assert(metrics.riseTime===1&&metrics.settlingTime===3,JSON.stringify(metrics));
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
  await test("entrada arbitraria integra planta continua e preserva vetor de tempo",()=>{
    const model:TransferFunction={num:[1],den:[1,1],domain:"continuous"},times=Array.from({length:11},(_,i)=>i*.1),response=timeResponseForInput(model,Array(11).fill(1),times);
    assert(response.samples.every((sample,index)=>near(sample.time,times[index]!,1e-12)),"instantes de amostragem nao foram preservados");
    assert(near(response.samples.at(-1)!.value,1-Math.exp(-1),2e-6),JSON.stringify(response.samples.at(-1)));
    const sparse=timeResponseForInput(model,[1,1],[0,1]);assert(near(sparse.samples.at(-1)!.value,1-Math.exp(-1),2e-6),"integracao nao refinou intervalo de entrada esparso");
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
  await test("resposta natural aceita estados iniciais dinamicos em C e H", () => {
    const plant={A:[[-1]],B:[1],C:[1],D:0};
    const result=closedLoopInitialStateResponse(plant,[1],{num:[1],den:[1,1],domain:"continuous"},{num:[1],den:[1,1],domain:"continuous"},.1,11,[2],[3]);
    assert(result.samples[0]!.value===1,"saida inicial deve vir do estado da planta");
    assert(result.samples[1]!.value>1,"estado inicial dinamico de C deve influenciar a resposta");
    let rejected=false;try{closedLoopInitialStateResponse(plant,[1],{num:[1],den:[1,1],domain:"continuous"},{num:[1],den:[1],domain:"continuous"},.1,11,[1],[2])}catch{rejected=true}
    assert(rejected,"dimensao incorreta do estado inicial do sensor aceita");
  });  await test("resposta natural integra planta continua entre amostras de controlador discreto", () => {
    const plant={A:[[-1]],B:[1],C:[1],D:0,domain:"continuous" as const};
    const result=closedLoopInitialStateResponse(plant,[1],{num:[.5],den:[1],domain:"discrete",sampleTime:.1},{num:[1],den:[1],domain:"discrete",sampleTime:.1},.2,3);
    assert(result.samples.length===3,"resposta hibrida deve amostrar nos multiplos de Ts");
    assert(near(result.samples[1]!.value,1.5*Math.exp(-.1)-.5,2e-7),"planta continua deve evoluir sob controle ZOH no intervalo de amostragem");
    assert(result.stable&&result.converged,"resposta hibrida estavel deve convergir");
  });  await test("derivada sobre medição entra no ramo de realimentação sem alterar o caminho de referência", () => {
    const tf=(num:number[],den:number[]):TransferFunction=>({num,den,domain:"continuous"});
    const ordinaryTwoDof=closeLoop(tf([1],[1]),tf([2],[1]),tf([1],[1,1]),tf([1],[1]));
    const splitTwoDof=closeLoop(tf([1],[1]),tf([2],[1]),tf([1],[1,1]),tf([1],[1]),undefined,"forward-controller",undefined,undefined,false,false,tf([1],[1]));
    assert(JSON.stringify(ordinaryTwoDof.output.num)!==JSON.stringify(splitTwoDof.output.num),"2-DOF reference channel did not change tracking response");
    assert(JSON.stringify(ordinaryTwoDof.output.den)===JSON.stringify(splitTwoDof.output.den),"2-DOF reference channel introduced artificial closed-loop poles");
  const ordinary=closeLoop(tf([1],[1]),tf([2],[1]),tf([1],[1,1]),tf([1],[1]));
    const split=closeLoop(tf([1],[1]),tf([2],[1]),tf([1],[1,1]),tf([1],[1]),tf([3,0],[1,10]));
    assert(JSON.stringify(split.output.num)===JSON.stringify([2,20]),"caminho de referência não preservou C0 multiplicado pelo denominador do ramo derivativo");
    assert(JSON.stringify(split.output.den)!==JSON.stringify(ordinary.output.den),"derivada de medição não alterou característica fechada");
  });
  await finish();
})();
