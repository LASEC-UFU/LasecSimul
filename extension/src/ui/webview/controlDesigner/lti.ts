/** Núcleo LTI SISO independente da interface. Coeficientes em potências decrescentes. */
export type Complex = { re: number; im: number };
/** Map a selected break frequency to a real pole or a damped conjugate pair. */
export function rootFromFrequency(omega:number,domain:"continuous"|"discrete",sampleTime?:number,damping=.7,complex=false):Complex {
  if(!(omega>0)||!Number.isFinite(omega))throw new Error("Frequency must be positive and finite.");
  if(!Number.isFinite(damping)||damping<0||damping>=1)throw new Error("Damping ratio must be in [0, 1).");
  if(domain==="continuous")return complex?{re:-damping*omega,im:omega*Math.sqrt(1-damping*damping)}:{re:-omega,im:0};
  if(!(sampleTime!>0)||!Number.isFinite(sampleTime))throw new Error("Discrete roots require a positive sample time.");
  if(complex&&omega>=Math.PI/sampleTime!)throw new Error("The selected frequency for a complex pair must be below Nyquist.");
  if(!complex)return {re:Math.exp(-omega*sampleTime!),im:0};
  const radius=Math.exp(-damping*omega*sampleTime!),angle=omega*Math.sqrt(1-damping*damping)*sampleTime!;
  return {re:radius*Math.cos(angle),im:radius*Math.sin(angle)};
}
export interface TransferFunction { num: number[]; den: number[]; domain: "continuous" | "discrete"; sampleTime?: number }
export interface ZInverseTransferFunction { num: number[]; den: number[]; sampleTime?: number }
/** Approximate a transport delay with Padé in continuous time or an exact z^-k delay in discrete time. */
export function approximateTransportDelay(delaySeconds:number,domain:TransferFunction["domain"],sampleTime?:number,padeOrder=4):TransferFunction {
  if(!Number.isFinite(delaySeconds)||delaySeconds<0)throw new Error("Transport delay must be finite and nonnegative.");
  if(!Number.isInteger(padeOrder)||padeOrder<1||padeOrder>8)throw new Error("Padé order must be an integer between 1 and 8.");
  if(domain==="discrete"){
    if(!(sampleTime!>0)||!Number.isFinite(sampleTime))throw new Error("A discrete transport delay needs a positive sample time.");
    const samples=delaySeconds/sampleTime!,rounded=Math.round(samples);
    if(Math.abs(samples-rounded)>1e-9*Math.max(1,Math.abs(samples)))throw new Error("A discrete transport delay must be an integer multiple of Ts.");
    return validateTf({num:[1],den:[1,...new Array(rounded).fill(0)],domain,sampleTime});
  }
  if(delaySeconds===0)return validateTf({num:[1],den:[1],domain});
  const factorial=(value:number)=>{let result=1;for(let factor=2;factor<=value;factor++)result*=factor;return result};
  const ascending=Array.from({length:padeOrder+1},(_,k)=>{const magnitude=factorial(2*padeOrder-k)*factorial(padeOrder)/(factorial(2*padeOrder)*factorial(k)*factorial(padeOrder-k))*delaySeconds**k;return k%2?-magnitude:magnitude});
  const numerator=[...ascending].reverse(),denominator=[...ascending].reverse().map(Math.abs);
  return validateTf({num:numerator,den:denominator,domain});
}
export type ControllerForm = "P" | "I" | "PI" | "PD" | "PID" | "lead" | "lag" | "leadlag" | "notch";
export interface ControllerParameters { kp: number; ki: number; kd: number; filterN: number; tau: number; alpha: number; lagTau?: number; lagAlpha?: number }
export interface LoopAnalysis {
  loop: TransferFunction; output: TransferFunction; control: TransferFunction;
  innerLoop?: TransferFunction; innerOutput?: TransferFunction; innerComplementary?: TransferFunction;
  sensitivity: TransferFunction; complementary: TransferFunction;
  /** Perturbação d somada à entrada da planta; ruído n somado à medição H y. */
  plantInputDisturbance: TransferFunction; measurementNoiseOutput: TransferFunction; measurementNoiseControl: TransferFunction;
}
const c = (re: number, im = 0): Complex => ({ re, im });
const add = (a: Complex, b: Complex): Complex => c(a.re + b.re, a.im + b.im);
const sub = (a: Complex, b: Complex): Complex => c(a.re - b.re, a.im - b.im);
const mul = (a: Complex, b: Complex): Complex => c(a.re * b.re - a.im * b.im, a.re * b.im + a.im * b.re);
const div = (a: Complex, b: Complex): Complex => { const d = b.re * b.re + b.im * b.im; return c((a.re * b.re + a.im * b.im) / d, (a.im * b.re - a.re * b.im) / d); };
const abs = (a: Complex): number => Math.hypot(a.re, a.im);
const trim = (p: number[]): number[] => { while (p.length > 1 && p[0] === 0) p.shift(); return p; };
export const validateTf = (tf: TransferFunction): TransferFunction => {
  if (!tf || !["continuous", "discrete"].includes(tf.domain)) throw new Error("Domínio inválido.");
  const num = trim([...tf.num]), den = trim([...tf.den]);
  if (!num.length || !den.length || [...num, ...den].some((v) => !Number.isFinite(v))) throw new Error("Informe coeficientes reais finitos.");
  if (den.every((v) => v === 0)) throw new Error("O denominador não pode ser zero.");
  if (num.length > den.length) throw new Error("Modelo impróprio: o grau do numerador excede o do denominador.");
  if (tf.domain === "discrete" && den.length > 1 && (!(tf.sampleTime! > 0) || !Number.isFinite(tf.sampleTime))) throw new Error("Modelo discreto dinâmico exige tempo de amostragem positivo.");
  return { ...tf, num, den };
};
/** z^-1 coefficients are ordered by ascending sample delay: b0 + b1 z^-1 + ... . */
export function toZInverse(tf: TransferFunction): ZInverseTransferFunction {
  const model = validateTf(tf);
  if (model.domain !== "discrete") throw new Error("z^-1 representation is only available for discrete models.");
  const relativeDegree = model.den.length - model.num.length;
  return { num: [...new Array(relativeDegree).fill(0), ...model.num], den: [...model.den], sampleTime: model.sampleTime };
}
export function fromZInverse(model: ZInverseTransferFunction): TransferFunction {
  if (!model.num.length || !model.den.length || model.den[0] === 0) throw new Error("Invalid z^-1 coefficients.");
  const order = Math.max(model.num.length, model.den.length) - 1;
  const num = [...model.num, ...new Array(order + 1 - model.num.length).fill(0)];
  const den = [...model.den, ...new Array(order + 1 - model.den.length).fill(0)];
  return validateTf({ num, den, domain: "discrete", sampleTime: model.sampleTime });
}
/** Formas contínuas com derivada filtrada. Avanço/atraso usam (τs+1)/(ατs+1). */
export function controllerForm(form: ControllerForm, p: ControllerParameters): TransferFunction {
  const { kp, ki, kd, filterN: n, tau, alpha } = p;
  if ([kp, ki, kd, n, tau, alpha, ...(p.lagTau === undefined ? [] : [p.lagTau]), ...(p.lagAlpha === undefined ? [] : [p.lagAlpha])].some(x => !Number.isFinite(x)) || n <= 0 || tau <= 0 || alpha <= 0)
    throw new Error("Parâmetros de controlador inválidos; N, τ e α precisam ser positivos.");
  let num: number[], den: number[];
  switch (form) {
    case "P": num = [kp]; den = [1]; break;
    case "I": num = [ki]; den = [1, 0]; break;
    case "PI": num = [kp, ki]; den = [1, 0]; break;
    case "PD": num = [kp + kd * n, kp * n]; den = [1, n]; break;
    case "PID": num = [kp + kd * n, kp * n + ki, ki * n]; den = [1, n, 0]; break;
    case "lead": case "lag": num = [kp * tau, kp]; den = [alpha * tau, 1]; break;
    case "leadlag": { const leadAlpha = alpha, lagTau = p.lagTau ?? tau, lagAlpha = p.lagAlpha ?? Math.max(1.001, 1 / alpha); if (!(leadAlpha > 0 && leadAlpha < 1 && lagTau > 0 && lagAlpha > 1)) throw new Error("Lead-lag exige αlead entre 0 e 1 e αlag maior que 1."); num = [kp * tau * lagTau, kp * (tau + lagTau), kp]; den = [leadAlpha * tau * lagAlpha * lagTau, leadAlpha * tau + lagAlpha * lagTau, 1]; break; }
    case "notch": if (!(kd > 0 && kd < 1 && alpha > 0 && alpha < 1)) throw new Error("Notch exige amortecimentos de zero e polo entre 0 e 1."); num = [kp * tau * tau, 2 * kp * kd * tau, kp]; den = [tau * tau, 2 * alpha * tau, 1]; break;
  }
  return validateTf({ num, den, domain: "continuous" });
}
/** Return the reference and measurement channels of a parallel 2-DOF PIDF. */
export function twoDofPidChannels(p: ControllerParameters, b: number, c: number): { reference: TransferFunction; feedback: TransferFunction } {
  if (![b, c].every(value => Number.isFinite(value) && value >= 0)) throw new Error("2-DOF PID setpoint weights b and c must be finite and nonnegative.");
  const feedback = controllerForm("PID", p);
  const reference = controllerForm("PID", { ...p, kp: p.kp * b, kd: p.kd * c });
  return { reference, feedback };
}
export function transferFromPolesZeros(zerosIn: readonly Complex[], polesIn: readonly Complex[], gain: number, domain: "continuous" | "discrete", sampleTime?: number): TransferFunction {
  if (!Number.isFinite(gain)) throw new Error("Informe um ganho finito.");
  if (zerosIn.length > polesIn.length) throw new Error("O modelo por polos e zeros seria impróprio.");
  const coefficients = (roots: readonly Complex[]): number[] => {
    let p = [c(1)];
    for (const root of roots) {
      if (![root.re, root.im].every(Number.isFinite)) throw new Error("Polo/zero não finito.");
      const next = new Array<Complex>(p.length + 1).fill(c(0));
      p.forEach((a, i) => { next[i] = add(next[i]!, a); next[i + 1] = sub(next[i + 1]!, mul(a, root)); });
      p = next;
    }
    if (p.some(x => Math.abs(x.im) > 1e-8 * Math.max(1, Math.abs(x.re)))) throw new Error("Polos e zeros complexos precisam formar pares conjugados.");
    return p.map(x => x.re);
  };
  return validateTf({ num: polyScale(coefficients(zerosIn), gain), den: coefficients(polesIn), domain, sampleTime });
}
export interface StateSpaceModel { A: number[][]; B: number[]; C: number[]; D: number; domain: "continuous" | "discrete"; sampleTime?: number }
/** Build a controllable companion realization from a proper SISO transfer function. */
export function tfToStateSpace(model: TransferFunction): StateSpaceModel {
  const tf=validateTf(model),n=tf.den.length-1,leading=tf.den[0]!;
  if(!Number.isFinite(leading)||leading===0)throw new Error("The transfer-function denominator must have a nonzero leading coefficient.");
  const den=tf.den.map(value=>value/leading),num=tf.num.map(value=>value/leading),padded=[...new Array(n+1-num.length).fill(0),...num],direct=padded[0]!;
  if(n===0)return {A:[],B:[],C:[],D:direct,domain:tf.domain,sampleTime:tf.sampleTime};
  const A=Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>i===0?-den[j+1]!:j===i-1?1:0));
  const B=[1,...new Array(n-1).fill(0)],C=Array.from({length:n},(_,i)=>padded[i+1]!-den[i+1]!*direct);
  return {A,B,C,D:direct,domain:tf.domain,sampleTime:tf.sampleTime};
}
/** Converte realização SISO para TF via Faddeev–LeVerrier e parâmetros de Markov. */
export function stateSpaceToTf(model: StateSpaceModel): TransferFunction {
  const { A, B, C, D, domain, sampleTime } = model, n = A.length;
  if (!n || B.length !== n || C.length !== n || A.some(row => row.length !== n) || ![D, ...A.flat(), ...B, ...C].every(Number.isFinite))
    throw new Error("Matrizes de estado inválidas ou dimensões incompatíveis.");
  if (n > 24) throw new Error("Modelos acima de 24 estados excedem o limite numérico atual.");
  if (!["continuous", "discrete"].includes(domain) || (domain === "discrete" && (!(sampleTime! > 0) || !Number.isFinite(sampleTime)))) throw new Error("Modelo discreto exige Ts positivo.");
  // Scale A before Faddeev-LeVerrier recurrence. This limits intermediate powers and
  // retains the full characteristic polynomial, including hidden realization modes.
  const norm = Math.max(1, ...A.map(row => row.reduce((sum, value) => sum + Math.abs(value), 0)));
  if (!Number.isFinite(norm)) throw new Error("Conversão de espaço de estados mal condicionada: norma de A excede a faixa numérica.");
  const scaledA = A.map(row => row.map(value => value / norm));
  const eye = (size: number) => Array.from({ length: size }, (_, i) => Array.from({ length: size }, (_, j) => i === j ? 1 : 0));
  const multiply = (left: number[][], right: number[][]) => left.map(row => right[0]!.map((_, j) => row.reduce((s, x, k) => s + x * right[k]![j]!, 0)));
  const matAddScale = (m: number[][], scale: number) => m.map((row, i) => row.map((x, j) => x + (i === j ? scale : 0)));
  let work: number[][] = eye(n); const scaledDen = [1];
  for (let k = 1; k <= n; k++) { const product = multiply(scaledA, work), coefficient = -product.reduce((s, row, i) => s + row[i]!, 0) / k; scaledDen.push(coefficient); work = matAddScale(product, coefficient); }
  let power: number[][] = eye(n); const moments: number[] = [];
  for (let k = 0; k < n; k++) { moments.push(C.reduce((s, x, i) => s + x * power[i]!.reduce((q, a, j) => q + a * B[j]! / norm, 0), 0)); power = multiply(power, scaledA); }
  const scaledNum = [D, ...Array.from({ length: n }, (_, k) => D * scaledDen[k + 1]! + moments.slice(0, k + 1).reduce((s, m, j) => s + scaledDen[k - j]! * m, 0))];
  const rescale = (coefficients: number[]) => coefficients.map((value, index) => {
    const result = value * norm ** index;
    if (!Number.isFinite(result)) throw new Error("Conversão de espaço de estados mal condicionada: coeficientes fora da faixa numérica representável.");
    if (value !== 0 && result === 0) throw new Error("Conversão de espaço de estados mal condicionada: coeficiente sofreu underflow numérico.");
    return result;
  });
  return validateTf({ num: rescale(scaledNum), den: rescale(scaledDen), domain, sampleTime });
}
/** Continuous-time full-order LQG tracker with an integral state. */
export function synthesizeLqg(plant: StateSpaceModel, stateWeight: number | number[][] = 1, processNoise: number | number[][] = 1, measurementNoise = 1, controlWeight = 1, stateControlCross: number[] = [], processMeasurementCross: number[] = [], trackingIntegralWeight?: number): TransferFunction {
  const n=plant.A.length;
  if(plant.domain!=="continuous"||!n||n>12||plant.B.length!==n||plant.C.length!==n||plant.A.some(row=>row.length!==n)||![plant.D,...plant.A.flat(),...plant.B,...plant.C,measurementNoise,controlWeight,...stateControlCross,...processMeasurementCross,...(trackingIntegralWeight===undefined?[]:[trackingIntegralWeight])].every(Number.isFinite))throw new Error("LQG requires a valid continuous-time SISO plant with up to 12 states.");
  const weightMatrix=(value:number|number[][],label:string,size=n)=>{const matrix=typeof value==="number"?Array.from({length:size},(_,i)=>Array.from({length:size},(_,j)=>i===j?value:0)):value;if(typeof value==="number"&&!(value>0))throw new Error(`${label} must be positive.`);if(!Array.isArray(matrix)||matrix.length!==size||matrix.some(row=>!Array.isArray(row)||row.length!==size||row.some(entry=>!Number.isFinite(entry))))throw new Error(`${label} must be a finite ${size} by ${size} matrix.`);const a=matrix.map(row=>[...row]),scale=Math.max(1,...a.flat().map(Math.abs));for(let i=0;i<size;i++)for(let j=i+1;j<size;j++)if(Math.abs(a[i]![j]!-a[j]![i]!)>1e-9*scale)throw new Error(`${label} must be symmetric.`);for(let iteration=0;iteration<Math.max(1,40*size*size);iteration++){let p=0,q=0,largest=0;for(let i=0;i<size;i++)for(let j=i+1;j<size;j++)if(Math.abs(a[i]![j]!)>largest){largest=Math.abs(a[i]![j]!);p=i;q=j}if(largest<=1e-12*scale)break;const app=a[p]![p]!,aqq=a[q]![q]!,apq=a[p]![q]!,angle=.5*Math.atan2(2*apq,aqq-app),c=Math.cos(angle),t=Math.sin(angle);for(let k=0;k<size;k++)if(k!==p&&k!==q){const akp=a[k]![p]!,akq=a[k]![q]!;a[k]![p]=a[p]![k]=c*akp-t*akq;a[k]![q]=a[q]![k]=t*akp+c*akq}a[p]![p]=c*c*app-2*t*c*apq+t*t*aqq;a[q]![q]=t*t*app+2*t*c*apq+c*c*aqq;a[p]![q]=a[q]![p]=0}if(a.some((row,i)=>row[i]! < -1e-9*scale))throw new Error(`${label} must be positive semidefinite.`);return matrix.map(row=>[...row])};
  const stateCost=weightMatrix(stateWeight,"State weighting Q"),noiseCostInput=weightMatrix(processNoise,"Process-noise covariance W");if(!(measurementNoise>0&&controlWeight>0))throw new Error("Control and measurement-noise weights must be positive.");if(stateControlCross.length!==0&&stateControlCross.length!==n)throw new Error(`State/control cross-weight must have ${n} entries.`);if(processMeasurementCross.length!==0&&processMeasurementCross.length!==n)throw new Error(`Process/measurement cross-covariance must have ${n} entries.`);const stateCross=stateControlCross.length?[...stateControlCross]:new Array(n).fill(0),noiseCross=processMeasurementCross.length?[...processMeasurementCross]:new Array(n).fill(0);if(trackingIntegralWeight!==undefined&&trackingIntegralWeight<=0)throw new Error("Integral tracking weight QI must be positive.");
  const solve=(matrix:number[][],rhs:number[])=>{const size=rhs.length,a=matrix.map((row,i)=>[...row,rhs[i]!]);for(let col=0;col<size;col++){let pivot=col;for(let row=col+1;row<size;row++)if(Math.abs(a[row]![col]!)>Math.abs(a[pivot]![col]!))pivot=row;if(Math.abs(a[pivot]![col]!)<1e-13)throw new Error("Singular Riccati equation; check stabilizability, detectability, and realization conditioning.");[a[col],a[pivot]]=[a[pivot]!,a[col]!];const divisor=a[col]![col]!;for(let j=col;j<=size;j++)a[col]![j]=a[col]![j]!/divisor;for(let row=0;row<size;row++)if(row!==col){const factor=a[row]![col]!;for(let j=col;j<=size;j++)a[row]![j]=a[row]![j]!-factor*a[col]![j]!}}return a.map(row=>row[size]!)};
  const transpose=(a:number[][])=>a[0]!.map((_,j)=>a.map(row=>row[j]!));
  const multiply=(left:number[][],right:number[][])=>left.map(row=>right[0]!.map((_,j)=>row.reduce((sum,value,k)=>sum+value*right[k]![j]!,0)));
  const stable=(a:number[][])=>{const size=a.length;return classifyStability(stateSpaceToTf({A:a,B:new Array(size).fill(0),C:new Array(size).fill(0),D:0,domain:"continuous"}))==="stable"};
  const stabilizingGain=(a:number[][],b:number[])=>{const size=a.length,norm=Math.max(1,...a.map(row=>row.reduce((sum,value)=>sum+Math.abs(value),0))),rate=2*norm+1,identity=Array.from({length:size},(_,i)=>Array.from({length:size},(_,j)=>i===j?1:0)),powers:number[][][]=[identity];for(let degree=1;degree<=size;degree++)powers.push(multiply(powers[degree-1]!,a));const choose=(top:number,bottom:number)=>{let value=1;for(let i=1;i<=bottom;i++)value=value*(top-i+1)/i;return value},phi=Array.from({length:size},()=>new Array(size).fill(0));for(let exponent=0;exponent<=size;exponent++){const coefficient=choose(size,exponent)*rate**(size-exponent);for(let i=0;i<size;i++)for(let j=0;j<size;j++)phi[i]![j]!+=coefficient*powers[exponent]![i]![j]!}const controllability=Array.from({length:size},()=>new Array(size).fill(0));let column=[...b];for(let degree=0;degree<size;degree++){for(let row=0;row<size;row++)controllability[row]![degree]=column[row]!;column=a.map(row=>row.reduce((sum,value,j)=>sum+value*column[j]!,0))}const terminal=new Array(size).fill(0);terminal[size-1]=1;const ackermann=solve(transpose(controllability),terminal),gain=phi[0]!.map((_,j)=>phi.reduce((sum,row,i)=>sum+ackermann[i]!*row[j]!,0)),closed=a.map((row,i)=>row.map((value,j)=>value-b[i]!*gain[j]!));if(!phi.flat().every(Number.isFinite)||!gain.every(Number.isFinite)||!stable(closed))throw new Error("Could not initialize a stabilizing Riccati iteration; check controllability and conditioning.");return gain};
  const lyapunov=(a:number[][],q:number[][])=>{const size=a.length,total=size*size,operator=Array.from({length:total},()=>new Array(total).fill(0)),rhs=new Array(total);for(let i=0;i<size;i++)for(let j=0;j<size;j++){const row=i*size+j;rhs[row]=-q[i]![j]!;for(let k=0;k<size;k++){operator[row]![k*size+j]+=a[k]![i]!;operator[row]![i*size+k]+=a[k]![j]!}}const flat=solve(operator,rhs);return Array.from({length:size},(_,i)=>Array.from({length:size},(_,j)=>flat[i*size+j]!))};
  const care=(a:number[][],b:number[],q:number[][],r:number)=>{const size=a.length;let k=stable(a)?new Array(size).fill(0):stabilizingGain(a,b);for(let iter=0;iter<150;iter++){const acl=a.map((row,i)=>row.map((value,j)=>value-b[i]!*k[j]!));if(!stable(acl))throw new Error("Riccati iteration lost numerical stability.");const cost=q.map((row,i)=>row.map((value,j)=>value+k[i]!*r*k[j]!)),p=lyapunov(acl,cost),next=b.map((_,i)=>b.reduce((sum,bj,j)=>sum+bj*p[j]![i]!,0)/r);if(!p.flat().every(Number.isFinite)||!next.every(Number.isFinite))throw new Error("Riccati iteration exceeded numeric range.");const error=Math.max(...next.map((value,i)=>Math.abs(value-k[i]!)));k=next;if(error<1e-9*Math.max(1,...k.map(Math.abs)))return k}throw new Error("Iterative LQG Riccati solution did not converge.")};
  const A=plant.A,B=plant.B,C=plant.C,plantTf=stateSpaceToTf({...plant,domain:"continuous"}),numeratorScale=Math.max(Number.MIN_VALUE,...plantTf.num.map(Math.abs));if(numeratorScale===Number.MIN_VALUE&&plantTf.num.every(value=>value===0))throw new Error("LQG cannot track a plant with no input-output path.");const freeDifferentiator=Math.abs(plantTf.num[plantTf.num.length-1]!)<=1e-10*numeratorScale,m=n+(freeDifferentiator?0:1),augmentedA=freeDifferentiator?A:Array.from({length:m},(_,i)=>i<n?[...A[i]!,0]:[...C.map(value=>-value),0]),augmentedB=freeDifferentiator?B:[...B,0],trackingCost=Array.from({length:m},(_,i)=>Array.from({length:m},(_,j)=>i<n&&j<n?stateCost[i]![j]!:i===n&&j===n?(trackingIntegralWeight??Math.max(1e-9,stateCost.reduce((sum,row,index)=>sum+row[index]!,0)/n)):0)),augmentedCross=[...stateCross,...(freeDifferentiator?[]:[0])],controlCost=weightMatrix(trackingCost.map((row,i)=>row.map((value,j)=>value-augmentedCross[i]!*augmentedCross[j]!/controlWeight)),"Transformed state/control cost",m),controlA=augmentedA.map((row,i)=>row.map((value,j)=>value-augmentedB[i]!*augmentedCross[j]!/controlWeight)),noiseCost=noiseCostInput.map((row,i)=>row.map((value,j)=>value-noiseCross[i]!*noiseCross[j]!/measurementNoise)),noiseA=A.map((row,i)=>row.map((value,j)=>value-noiseCross[i]!*C[j]!/measurementNoise)),K=care(controlA,augmentedB,controlCost,controlWeight).map((value,i)=>value+augmentedCross[i]!/controlWeight),L=care(transpose(noiseA),C,noiseCost,measurementNoise).map((value,i)=>value+noiseCross[i]!/measurementNoise),Kx=K.slice(0,n),Ki=freeDifferentiator?0:K[n]!;
  const controllerA=Array.from({length:m},(_,i)=>Array.from({length:m},(_,j)=>!freeDifferentiator&&i===n?0:!freeDifferentiator&&j===n?(-B[i]!+L[i]!*plant.D)*Ki:A[i]![j]!-B[i]!*Kx[j]!-L[i]!*C[j]!+L[i]!*plant.D*Kx[j]!)),controllerB=[...L.map(value=>-value),...(freeDifferentiator?[]:[1])],controllerC=[...Kx.map(value=>-value),...(freeDifferentiator?[]:[-Ki])];
  return stateSpaceToTf({A:controllerA,B:controllerB,C:controllerC,D:0,domain:"continuous"});
}
/** Reduce a stable controller to a requested order by retaining slow pole groups and fitting its numerator over frequency. */
export function reduceControllerOrder(controller: TransferFunction, desiredOrder: number): { controller: TransferFunction; achievedOrder: number } {
  const fullOrder=controller.den.length-1;
  if(!Number.isInteger(desiredOrder)||desiredOrder<1)throw new Error("Desired controller order must be a positive integer.");
  if(desiredOrder>=fullOrder)return {controller,achievedOrder:fullOrder};
  const discrete=controller.domain==="discrete",roots=poles(controller),isIntegrator=(root:Complex)=>discrete?Math.hypot(root.re-1,root.im)<1e-7:Math.hypot(root.re,root.im)<1e-7,hasIntegrator=roots.some(isIntegrator),dynamicRoots=roots.filter(root=>!isIntegrator(root));
  if(dynamicRoots.some(root=>discrete?Math.hypot(root.re,root.im)>=1-1e-8:root.re>=-1e-8))throw new Error(`Order reduction requires stable non-integrator controller poles in the ${discrete?"z":"s"} plane.`);
  const poleFrequency=(root:Complex)=>discrete?Math.min(Math.PI/controller.sampleTime!,Math.hypot(Math.log(Math.max(Number.MIN_VALUE,Math.hypot(root.re,root.im))),Math.atan2(root.im,root.re))/controller.sampleTime!):Math.hypot(root.re,root.im);
  const groups:{roots:Complex[];frequency:number}[]=[],used=new Set<number>();
  for(let i=0;i<dynamicRoots.length;i++){
    if(used.has(i))continue;const root=dynamicRoots[i]!;
    if(Math.abs(root.im)<1e-7){used.add(i);groups.push({roots:[{re:root.re,im:0}],frequency:poleFrequency(root)});continue}
    const mateIndex=dynamicRoots.findIndex((candidate,j)=>j!==i&&!used.has(j)&&Math.abs(candidate.re-root.re)<1e-5*Math.max(1,Math.abs(root.re))&&Math.abs(candidate.im+root.im)<1e-5*Math.max(1,Math.abs(root.im)));
    if(mateIndex<0)throw new Error("Could not preserve a complex pole pair during order reduction.");
    used.add(i);used.add(mateIndex);const positive=root.im>=0?root:dynamicRoots[mateIndex]!,negative=root.im<0?root:dynamicRoots[mateIndex]!;groups.push({roots:[positive,negative],frequency:poleFrequency(positive)});
  }
  groups.sort((a,b)=>a.frequency-b.frequency);
  const availableOrder=groups.reduce((sum,group)=>sum+group.roots.length,hasIntegrator?1:0),target=Math.min(desiredOrder,availableOrder),selected:Complex[]=[];let remaining=target-(hasIntegrator?1:0);
  for(const group of groups){if(group.roots.length<=remaining){selected.push(...group.roots);remaining-=group.roots.length}if(remaining===0)break}
  if(remaining!==0)throw new Error("Requested order cannot preserve conjugate pole pairs.");
  const achievedOrder=selected.length+(hasIntegrator?1:0);if(achievedOrder===fullOrder)return {controller,achievedOrder};
  const multiply=(left:number[],right:number[])=>{const out=new Array(left.length+right.length-1).fill(0);left.forEach((value,i)=>right.forEach((other,j)=>out[i+j]!+=value*other));return out};
  let denominator=hasIntegrator?(discrete?[1,-1]:[1,0]):[1];
  for(let i=0;i<selected.length;){const root=selected[i]!;if(Math.abs(root.im)<1e-7){denominator=multiply(denominator,[1,-root.re]);i++;continue}const pair=selected.slice(i,i+2);if(pair.length<2)throw new Error("Incomplete conjugate pole pair in reduced controller.");denominator=multiply(denominator,[1,-2*root.re,root.re*root.re+root.im*root.im]);i+=2}
  const nyquist=discrete?Math.PI/controller.sampleTime!:Infinity,scale=discrete?nyquist:Math.max(1e-6,...roots.map(root=>Math.hypot(root.re,root.im))),sampleCount=Math.max(120,achievedOrder*24),matrix:number[][]=[],targetValues:number[]=[];
  const evalRealPolynomial=(coefficients:number[],re:number,im:number)=>{let outRe=coefficients[0]!,outIm=0;for(const coefficient of coefficients.slice(1)){const nextRe=outRe*re-outIm*im+coefficient,nextIm=outRe*im+outIm*re;outRe=nextRe;outIm=nextIm}return {re:outRe,im:outIm}};
  for(let sample=0;sample<sampleCount;sample++){
    const fraction=sample/(sampleCount-1),omega=discrete?nyquist*(1e-4*(.98/1e-4)**fraction):scale*10**(-2+4*fraction),response=frequencyResponse(controller,omega),evaluationPoint=discrete?{re:Math.cos(omega*controller.sampleTime!),im:Math.sin(omega*controller.sampleTime!)}:{re:0,im:omega},denValue=evalRealPolynomial(denominator,evaluationPoint.re,evaluationPoint.im),goalRe=response.re*denValue.re-response.im*denValue.im,goalIm=response.re*denValue.im+response.im*denValue.re;
    let basisRe=1,basisIm=0;const rowRe:number[]=[],rowIm:number[]=[];
    for(let degree=0;degree<achievedOrder;degree++){rowRe.push(basisRe);rowIm.push(basisIm);const nextRe=discrete?basisRe*evaluationPoint.re-basisIm*evaluationPoint.im:(-basisIm*omega/scale),nextIm=discrete?basisRe*evaluationPoint.im+basisIm*evaluationPoint.re:basisRe*omega/scale;basisRe=nextRe;basisIm=nextIm}
    matrix.push(rowRe);targetValues.push(goalRe);matrix.push(rowIm);targetValues.push(goalIm);
  }
  const columns=Array.from({length:achievedOrder},(_,column)=>matrix.map(row=>row[column]!)),orthogonal:number[][]=[],triangular=Array.from({length:achievedOrder},()=>new Array(achievedOrder).fill(0));
  for(let column=0;column<achievedOrder;column++){
    let vector=[...columns[column]!];for(let previous=0;previous<column;previous++){const projection=orthogonal[previous]!.reduce((sum,value,row)=>sum+value*columns[column]![row]!,0);triangular[previous]![column]=projection;vector=vector.map((value,row)=>value-projection*orthogonal[previous]![row]!)}
    const norm=Math.hypot(...vector);if(!(norm>1e-10&&Number.isFinite(norm)))throw new Error("Numerical conditioning prevents the requested controller order reduction.");triangular[column]![column]=norm;orthogonal.push(vector.map(value=>value/norm));
  }
  const projected=orthogonal.map(column=>column.reduce((sum,value,row)=>sum+value*targetValues[row]!,0)),coefficients=new Array(achievedOrder).fill(0);
  for(let row=achievedOrder-1;row>=0;row--)coefficients[row]=(projected[row]!-triangular[row]!.slice(row+1).reduce((sum,value,index)=>sum+value*coefficients[row+1+index]!,0))/triangular[row]![row]!;
  const numerator=discrete?coefficients:[...coefficients].reverse().map((value,index)=>value/scale**(achievedOrder-1-index)),reduced=validateTf({num:numerator,den:denominator,domain:controller.domain,sampleTime:controller.sampleTime});
  if(!reduced.num.every(Number.isFinite)||!reduced.den.every(Number.isFinite))throw new Error("Reduced controller exceeded numeric range.");
  return {controller:reduced,achievedOrder};
}
/** Full-order IMC Q from a proper predictive model (MATLAB Control System Designer architecture 5). */
export function synthesizeImcController(model: TransferFunction, lambda: number, desiredOrder = Number.MAX_SAFE_INTEGER): { controller: TransferFunction; achievedOrder: number; fullOrder: number } {
  const predictive=validateTf(model);
  if(predictive.domain!=="continuous")throw new Error("IMC synthesis currently requires a continuous-time predictive model.");
  if(!(lambda>0&&Number.isFinite(lambda)))throw new Error("The dominant closed-loop time constant must be positive and finite.");
  if(predictive.num.length>predictive.den.length)throw new Error("The predictive model G2 must be proper for IMC inversion.");
  const modelZeros=zeros(predictive),boundary=modelZeros.filter(root=>Math.abs(root.re)<=1e-8*Math.max(1,Math.abs(root.im)));
  if(boundary.length)throw new Error("IMC synthesis cannot stably invert predictive-model zeros on the imaginary axis.");
  const nonminimum=modelZeros.filter(root=>root.re>0),minimum=modelZeros.filter(root=>root.re<0),minimumPolynomial=transferFromPolesZeros([],minimum,1,"continuous").den,nonminimumPolynomial=transferFromPolesZeros([],nonminimum,1,"continuous").den;
  // Factor G2=G+G-: invert only its minimum-phase factor G+, retain G-'s
  // nonminimum-phase zeros in the target response, and add enough filter poles
  // to keep Q proper. Normalize G- to unit DC gain as in standard IMC design.
  const nonminimumDc=nonminimumPolynomial[nonminimumPolynomial.length-1]!;
  if(Math.abs(nonminimumDc)<1e-12)throw new Error("IMC synthesis cannot normalize a predictive zero at the origin.");
  const relativeDegree=predictive.den.length-predictive.num.length,filterOrder=Math.max(1,relativeDegree+nonminimum.length);let filterDen=[1];
  for(let degree=0;degree<filterOrder;degree++)filterDen=polyMul(filterDen,[lambda,1]);
  const controllerDen=polyScale(polyMul(minimumPolynomial,filterDen),predictive.num[0]!*nonminimumDc),full=validateTf({num:[...predictive.den],den:controllerDen,domain:"continuous"}),fullOrder=full.den.length-1;
  const reduced=desiredOrder>=fullOrder?{controller:full,achievedOrder:fullOrder}:reduceControllerOrder(full,desiredOrder);
  return {...reduced,fullOrder};
}
export const reduceLqgOrder=reduceControllerOrder;
export const polyAdd = (a: readonly number[], b: readonly number[]): number[] => { const n = Math.max(a.length, b.length); return Array.from({ length: n }, (_, i) => (a[a.length - n + i] ?? 0) + (b[b.length - n + i] ?? 0)); };
export const polyScale = (a: readonly number[], k: number): number[] => a.map((x) => x * k);
export const polyMul = (a: readonly number[], b: readonly number[]): number[] => { const out = new Array(a.length + b.length - 1).fill(0); a.forEach((x, i) => b.forEach((y, j) => out[i + j] += x * y)); return trim(out); };
export const tfScale = (a: TransferFunction, k: number): TransferFunction => ({ ...a, num: polyScale(a.num, k) });
const staticGain = (tf: TransferFunction): boolean => trim([...tf.den]).length === 1;
function alignDomains(a: TransferFunction, b: TransferFunction): [TransferFunction, TransferFunction] {
  const dynamic = [a, b].filter((tf) => !staticGain(tf));
  if (!dynamic.length) return [a, b];
  const reference = dynamic[0]!;
  for (const tf of dynamic.slice(1)) if (tf.domain !== reference.domain || (reference.domain === "discrete" && tf.sampleTime !== reference.sampleTime)) throw new Error("Incompatible dynamic domains or sample times.");
  const adopt = (tf: TransferFunction): TransferFunction => staticGain(tf) ? { ...tf, domain: reference.domain, sampleTime: reference.sampleTime } : tf;
  return [adopt(a), adopt(b)];
}
export const tfMul = (a: TransferFunction, b: TransferFunction): TransferFunction => {
  [a, b] = alignDomains(validateTf(a), validateTf(b));
  if (a.domain !== b.domain || (a.domain === "discrete" && a.sampleTime !== b.sampleTime)) throw new Error("Não misture modelos contínuos e discretos nem tempos de amostragem distintos.");
  return validateTf({ num: polyMul(a.num, b.num), den: polyMul(a.den, b.den), domain: a.domain, sampleTime: a.sampleTime });
};
export type DirectAnalysisPoint = "prefilterOutput" | "error" | "control" | "plantOutput" | "sensorOutput";
export type DirectAnalysisSignal = "output" | "control" | "controllerOutput" | "error" | "sensorOutput" | "prefilterOutput" | "plantInput";
/** Transfer from an additive input marked at a wire in the standard forward controller diagram. */
export function directAnalysisPointTransfer(analysis: LoopAnalysis, C: TransferFunction, G: TransferFunction, H: TransferFunction, point: DirectAnalysisPoint, signal: DirectAnalysisSignal, openFeedback = false): TransferFunction {
  const unit: TransferFunction = { num: [1], den: [1], domain: analysis.output.domain, sampleTime: analysis.output.sampleTime };
  const zero: TransferFunction = { num: [0], den: [1], domain: analysis.output.domain, sampleTime: analysis.output.sampleTime };
  const cg = tfMul(C, G), S = analysis.sensitivity;
  let y: TransferFunction, u: TransferFunction, e: TransferFunction, sensor: TransferFunction, prefilter = zero, plantInput: TransferFunction;
  if (openFeedback) {
    switch (point) {
      case "prefilterOutput": case "error":
        y = cg; u = C; e = point === "prefilterOutput" ? unit : zero; sensor = tfMul(H, y); plantInput = u; break;
      case "control":
        y = G; u = zero; e = zero; sensor = tfMul(H, y); plantInput = zero; break;
      case "plantOutput":
        y = zero; u = zero; e = zero; sensor = H; plantInput = zero; break;
      case "sensorOutput":
        y = tfScale(cg, -1); u = tfScale(C, -1); e = tfScale(unit, -1); sensor = tfScale(tfMul(H, cg), -1); plantInput = tfScale(C, -1); break;
    }
  } else switch (point) {
    case "prefilterOutput": case "error":
      y = tfMul(cg, S); u = tfMul(C, S); e = point === "prefilterOutput" ? S : tfScale(tfMul(H, y), -1); sensor = tfMul(H, y); plantInput = u; break;
    case "control":
      y = tfMul(G, S); u = tfScale(tfMul(tfMul(C, H), y), -1); e = tfScale(tfMul(H, y), -1); sensor = tfMul(H, y); plantInput = u; break;
    case "plantOutput":
      u = tfScale(tfMul(tfMul(C, H), S), -1); y = tfMul(G, u); e = tfScale(tfMul(H, S), -1); sensor = tfMul(H, S); plantInput = u; break;
    case "sensorOutput":
      y = tfScale(tfMul(cg, S), -1); u = tfScale(tfMul(C, S), -1); e = tfScale(S, -1); sensor = tfMul(H, y); plantInput = u; break;
  }
  switch (signal) {
    case "output": return y;
    case "control": return u;
    case "controllerOutput": return u;
    case "error": return e;
    case "sensorOutput": return sensor;
    case "prefilterOutput": return prefilter;
    case "plantInput": return plantInput;
  }
}
/** Transfer from a marked additive input in the architecture with C in the feedback branch. */
export function feedbackAnalysisPointTransfer(analysis: LoopAnalysis, C: TransferFunction, G: TransferFunction, H: TransferFunction, point: DirectAnalysisPoint, signal: DirectAnalysisSignal, openFeedback = false): TransferFunction {
  const unit: TransferFunction = { num: [1], den: [1], domain: analysis.output.domain, sampleTime: analysis.output.sampleTime };
  const zero: TransferFunction = { num: [0], den: [1], domain: analysis.output.domain, sampleTime: analysis.output.sampleTime };
  const S = analysis.sensitivity, cg = tfMul(C, G), chg = tfMul(C, tfMul(H, G));
  let y: TransferFunction, plantInput: TransferFunction, e: TransferFunction, controllerOutput: TransferFunction, sensor: TransferFunction;
  if (openFeedback) switch (point) {
    case "prefilterOutput": case "error": y = G; plantInput = unit; e = point === "prefilterOutput" ? unit : zero; controllerOutput = zero; sensor = tfMul(H, G); break;
    case "control": y = tfScale(G, -1); plantInput = tfScale(unit, -1); e = tfScale(unit, -1); controllerOutput = zero; sensor = tfScale(tfMul(H, G), -1); break;
    case "plantOutput": y = zero; plantInput = zero; e = zero; controllerOutput = zero; sensor = H; break;
    case "sensorOutput": y = tfScale(cg, -1); plantInput = tfScale(C, -1); e = tfScale(C, -1); controllerOutput = C; sensor = tfScale(tfMul(H, cg), -1); break;
  } else switch (point) {
    case "prefilterOutput": y = tfMul(G, S); plantInput = S; e = S; controllerOutput = tfMul(chg, S); sensor = tfMul(tfMul(H, G), S); break;
    case "error": y = tfMul(G, S); plantInput = S; e = tfScale(tfMul(chg, S), -1); controllerOutput = tfMul(chg, S); sensor = tfMul(tfMul(H, G), S); break;
    case "control": y = tfScale(tfMul(G, S), -1); plantInput = tfScale(S, -1); e = tfScale(S, -1); controllerOutput = tfScale(tfMul(chg, S), -1); sensor = tfScale(tfMul(tfMul(H, G), S), -1); break;
    case "plantOutput": y = tfScale(tfMul(chg, S), -1); plantInput = tfScale(tfMul(chg, S), -1); e = plantInput; controllerOutput = tfMul(chg, S); sensor = tfMul(H, S); break;
    case "sensorOutput": y = tfScale(tfMul(cg, S), -1); plantInput = tfScale(tfMul(C, S), -1); e = plantInput; controllerOutput = tfMul(C, S); sensor = tfScale(tfMul(tfMul(H, cg), S), -1); break;
  }
  switch (signal) {
    case "output": return y;
    case "control": case "plantInput": return plantInput;
    case "controllerOutput": return controllerOutput;
    case "error": return e;
    case "sensorOutput": return sensor;
    case "prefilterOutput": return zero;
  }
}
/** Transfer from an additive input in the feedforward-disturbance architecture. */
export function feedforwardAnalysisPointTransfer(analysis: LoopAnalysis, C: TransferFunction, G: TransferFunction, H: TransferFunction, point: DirectAnalysisPoint, signal: DirectAnalysisSignal, openFeedback = false): TransferFunction {
  const unit: TransferFunction = { num: [1], den: [1], domain: analysis.output.domain, sampleTime: analysis.output.sampleTime };
  const zero: TransferFunction = { num: [0], den: [1], domain: analysis.output.domain, sampleTime: analysis.output.sampleTime };
  const cg = tfMul(C, G), chg = tfMul(C, tfMul(H, G)), S = analysis.sensitivity;
  let y: TransferFunction, controller: TransferFunction, error: TransferFunction, sensor: TransferFunction, prefilter = zero, plantInput: TransferFunction;
  if (openFeedback) switch (point) {
    case "prefilterOutput": y = G; controller = zero; error = zero; sensor = tfMul(H, G); plantInput = unit; break;
    case "error": y = cg; controller = C; error = zero; sensor = tfMul(H, cg); plantInput = C; break;
    case "control": y = G; controller = zero; error = zero; sensor = tfMul(H, G); plantInput = unit; break;
    case "plantOutput": y = zero; controller = zero; error = zero; sensor = H; plantInput = zero; break;
    case "sensorOutput": y = tfScale(cg, -1); controller = tfScale(C, -1); error = tfScale(unit, -1); sensor = tfScale(tfMul(H, cg), -1); plantInput = controller; break;
  } else switch (point) {
    case "prefilterOutput": y = tfMul(G, S); controller = tfScale(tfMul(chg, S), -1); error = tfScale(tfMul(H, y), -1); sensor = tfMul(H, y); plantInput = S; break;
    case "error": y = tfMul(cg, S); controller = tfMul(C, S); error = tfScale(tfMul(H, y), -1); sensor = tfMul(H, y); plantInput = controller; break;
    case "control": y = tfMul(G, S); controller = tfScale(tfMul(chg, S), -1); error = tfScale(tfMul(H, y), -1); sensor = tfMul(H, y); plantInput = S; break;
    case "plantOutput": y = tfScale(tfMul(chg, S), -1); controller = tfScale(tfMul(tfMul(C, H), S), -1); error = tfScale(tfMul(H, S), -1); sensor = tfMul(H, S); plantInput = controller; break;
    case "sensorOutput": y = tfScale(tfMul(cg, S), -1); controller = tfScale(tfMul(C, S), -1); error = tfScale(S, -1); sensor = tfScale(tfMul(H, cg), -1); plantInput = controller; break;
  }
  switch (signal) {
    case "output": return y;
    case "control": case "controllerOutput": return controller;
    case "error": return error;
    case "sensorOutput": return sensor;
    case "prefilterOutput": return prefilter;
    case "plantInput": return plantInput;
  }
}
export const tfAdd = (a: TransferFunction, b: TransferFunction): TransferFunction => { [a, b] = alignDomains(validateTf(a), validateTf(b)); return validateTf({ num: polyAdd(polyMul(a.num, b.den), polyMul(b.num, a.den)), den: polyMul(a.den, b.den), domain: a.domain, sampleTime: a.sampleTime }); };
function polynomialPower(base: number[], power: number): number[] { let out = [1]; for (let i=0;i<power;i++) out=polyMul(out,base); return out; }
/** Conversão explícita bilinear/Tustin entre s e z; Ts é obrigatório no destino discreto. */
export function convertDomain(tf: TransferFunction, target: "continuous"|"discrete", sampleTime: number): TransferFunction {
  validateTf(tf);
  if (tf.domain===target) {
    if (target === "continuous") return { ...tf, sampleTime: undefined };
    if (!staticGain(tf) && tf.sampleTime !== sampleTime) throw new Error("Changing Ts changes the dynamics; use an explicit domain conversion.");
    return { ...tf, sampleTime: staticGain(tf) ? undefined : sampleTime };
  }
  if (staticGain(tf)) return { ...tf, domain: target, sampleTime: undefined };
  if (!(sampleTime>0) || !Number.isFinite(sampleTime)) throw new Error("Conversão bilinear exige Ts positivo.");
  const degree=tf.den.length-1, factor=2/sampleTime, half=sampleTime/2;
  const substitute=(p: readonly number[]): number[] => {
    let out=new Array(degree+1).fill(0);
    p.forEach((coefficient,index)=>{
      const power=p.length-1-index;
      const numerator=polynomialPower(target==="discrete"?[factor,-factor]:[half,1],power);
      const denominator=polynomialPower(target==="discrete"?[1,1]:[-half,1],degree-power);
      const term=polyScale(polyMul(numerator,denominator),coefficient*(target==="discrete"?1:1));
      out=polyAdd(out,term);
    });
    return trim(out);
  };
  const num=substitute(tf.num),den=substitute(tf.den);
  const scale=den[0]!;
  return validateTf({num:num.map(x=>x/scale),den:den.map(x=>x/scale),domain:target,sampleTime:target==="discrete"?sampleTime:undefined});
}
/** Explicit Euler substitutions for a continuous proper SISO model. */
export function convertEuler(tf: TransferFunction, sampleTime: number, method: "forward" | "backward"): TransferFunction {
  const source = validateTf(tf);
  if (source.domain !== "continuous") throw new Error("Euler conversion requires a continuous model.");
  if (!(sampleTime > 0) || !Number.isFinite(sampleTime)) throw new Error("Euler conversion requires positive Ts.");
  const degree = source.den.length - 1;
  const power = (base: number[], exponent: number) => polynomialPower(base, exponent);
  const substitute = (coefficients: number[]) => {
    let result = new Array<number>(degree + 1).fill(0);
    coefficients.forEach((coefficient, index) => {
      const exponent = coefficients.length - 1 - index;
      const numerator = power([1 / sampleTime, -1 / sampleTime], exponent);
      const denominator = method === "backward" ? power([1, 0], degree - exponent) : [1];
      result = polyAdd(result, polyScale(polyMul(numerator, denominator), coefficient));
    });
    return result;
  };
  const num = substitute(source.num), den = substitute(source.den), leading = den[0]!;
  if (!Number.isFinite(leading) || leading === 0) throw new Error("Euler conversion produced a singular denominator.");
  return validateTf({ num: num.map(value => value / leading), den: den.map(value => value / leading), domain: "discrete", sampleTime });
}
/** Exact zero-order-hold conversion for continuous SISO transfer functions. */
export function convertZoh(tf: TransferFunction, sampleTime: number): TransferFunction {
  const source = validateTf(tf);
  if (source.domain !== "continuous") throw new Error("ZOH conversion requires a continuous model.");
  if (!(sampleTime > 0) || !Number.isFinite(sampleTime)) throw new Error("ZOH conversion requires positive Ts.");
  const n = source.den.length - 1;
  if (!n) return { ...source, domain: "discrete", sampleTime: undefined };
  const den = source.den.map((v) => v / source.den[0]!);
  const num = source.num.map((v) => v / source.den[0]!);
  const padded = [...new Array(n + 1 - num.length).fill(0), ...num], D = padded[0]!;
  const A = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => i < n - 1 ? (j === i + 1 ? 1 : 0) : -den[n - j]!));
  const B = Array.from({ length: n }, (_, i) => i === n - 1 ? 1 : 0);
  const C = Array.from({ length: n }, (_, i) => padded[n - i]! - den[n - i]! * D);
  const size = n + 1;
  const augmented = Array.from({ length: size }, (_, i) => Array.from({ length: size }, (_, j) => i < n ? (j < n ? A[i]![j]! * sampleTime : B[i]! * sampleTime) : 0));
  const multiply = (x: number[][], y: number[][]): number[][] => x.map((row) => y[0]!.map((_, j) => row.reduce((sum, v, k) => sum + v * y[k]![j]!, 0)));
  const norm = Math.max(...augmented.map((row) => row.reduce((sum, v) => sum + Math.abs(v), 0)));
  const squarings = Math.max(0, Math.ceil(Math.log2(Math.max(1, norm))));
  const scaled = augmented.map((row) => row.map((v) => v / 2 ** squarings));
  let exponential: number[][] = Array.from({ length: size }, (_, i) => Array.from({ length: size }, (_, j) => i === j ? 1 : 0));
  let term = exponential.map((row) => [...row]);
  for (let k = 1; k <= 80; k++) {
    term = multiply(term, scaled).map((row) => row.map((v) => v / k));
    exponential = exponential.map((row, i) => row.map((v, j) => v + term[i]![j]!));
    if (Math.max(...term.flat().map(Math.abs)) < 1e-16) break;
  }
  for (let i = 0; i < squarings; i++) exponential = multiply(exponential, exponential);
  const Ad = exponential.slice(0, n).map((row) => row.slice(0, n));
  const Bd = exponential.slice(0, n).map((row) => row[n]!);
  return stateSpaceToTf({ A: Ad, B: Bd, C, D, domain: "discrete", sampleTime });
}
export type ControlArchitecture = "forward-controller" | "feedback-controller" | "feedforward-disturbance" | "nested-inner-feedback" | "imc" | "nested-inner-forward";
export function closeLoop(F: TransferFunction, C: TransferFunction, G: TransferFunction, H: TransferFunction, derivativeOnMeasurement?: TransferFunction, architecture: ControlArchitecture = "forward-controller", innerController?: TransferFunction, innerSensor?: TransferFunction, openFeedbackSensor = false, openInnerFeedbackSensor = false, referenceController?: TransferFunction): LoopAnalysis {
  let models = [F, C, G, H, ...(derivativeOnMeasurement ? [derivativeOnMeasurement] : []), ...(referenceController ? [referenceController] : [])].map(validateTf);
  const dynamic = models.filter((tf) => !staticGain(tf));
  const reference = dynamic[0] ?? models[0]!;
  models = models.map((tf) => staticGain(tf) ? { ...tf, domain: reference.domain, sampleTime: reference.sampleTime } : tf);
  const [f, ctl, plant, sensor] = models as [TransferFunction, TransferFunction, TransferFunction, TransferFunction];
  const derivative = derivativeOnMeasurement ? models[4] : undefined;
  const referenceCtl = referenceController ? models[derivativeOnMeasurement ? 5 : 4] : undefined;
  if (referenceCtl && (architecture !== "forward-controller" || derivativeOnMeasurement || openInnerFeedbackSensor)) throw new Error("A 2-DOF reference channel requires the direct architecture and derivative on measurement disabled.");
  if (referenceCtl && (referenceCtl.den.length !== ctl.den.length || referenceCtl.den.some((value, index) => value !== ctl.den[index]))) throw new Error("The 2-DOF reference and feedback channels must use the same controller denominator.");
  for (const m of models) if (m.domain !== f.domain || (f.domain === "discrete" && m.sampleTime !== f.sampleTime)) throw new Error("Arquitetura com domínios ou tempos de amostragem incompatíveis.");
  const mult = (...p: number[][]): number[] => p.reduce((a, b) => polyMul(a, b), [1]);
  if (architecture === "nested-inner-feedback" || architecture === "nested-inner-forward") {
    const unit: TransferFunction = { num: [1], den: [1], domain: f.domain, sampleTime: f.sampleTime };
    const innerSensorModel=architecture==="nested-inner-feedback"?unit:innerSensor??unit;
    const inner = closeLoop(unit, innerController ?? unit, plant, innerSensorModel, undefined, architecture === "nested-inner-feedback" ? "feedback-controller" : "forward-controller", undefined, undefined, openInnerFeedbackSensor);
    const outer=closeLoop(architecture==="nested-inner-forward"?f:unit, ctl, inner.output, sensor, derivative, "forward-controller", undefined, undefined, openFeedbackSensor);
    const cascade=(a:TransferFunction,b:TransferFunction)=>validateTf({num:polyMul(a.num,b.num),den:polyMul(a.den,b.den),domain:f.domain,sampleTime:f.sampleTime});
    const sum=(a:TransferFunction,b:TransferFunction)=>validateTf({num:polyAdd(polyMul(a.num,b.den),polyMul(b.num,a.den)),den:polyMul(a.den,b.den),domain:f.domain,sampleTime:f.sampleTime});
    outer.innerLoop=inner.loop;outer.innerOutput=inner.output;outer.innerComplementary=inner.complementary;
    outer.plantInputDisturbance=cascade(outer.sensitivity,inner.plantInputDisturbance);
    outer.measurementNoiseOutput=sum(outer.measurementNoiseOutput,cascade(outer.sensitivity,inner.measurementNoiseOutput));
    return outer;
  }
  if (openInnerFeedbackSensor) throw new Error("A abertura interna requer uma arquitetura aninhada.");
  if (openFeedbackSensor) {
    if (architecture !== "forward-controller" && architecture !== "feedback-controller") throw new Error("A abertura em H·y está disponível nas arquiteturas diretas e com C na realimentação.");
    if (derivative) throw new Error("Desative a derivada sobre a medição antes de abrir o retorno H·y.");
    const tf = (num: number[], den: number[] = [1]): TransferFunction => validateTf({ num, den, domain: f.domain, sampleTime: f.sampleTime });
    const cascade = (...systems: TransferFunction[]) => tf(systems.reduce((numerator, system) => polyMul(numerator, system.num), [1]), systems.reduce((denominator, system) => polyMul(denominator, system.den), [1]));
    const unit = tf([1]), zero = tf([0]), negativeController = tf(polyScale(ctl.num, -1), ctl.den), loop = cascade(ctl, plant, sensor), controllerInForwardPath = architecture === "forward-controller", referenceToControl = controllerInForwardPath ? cascade(f, referenceCtl ?? ctl) : f, referenceToOutput = cascade(referenceToControl, plant), measurementNoiseOutput = controllerInForwardPath ? cascade(negativeController, plant) : zero, measurementNoiseControl = controllerInForwardPath ? negativeController : zero;
    return { loop, output: referenceToOutput, control: referenceToControl, sensitivity: unit, complementary: zero, plantInputDisturbance: plant, measurementNoiseOutput, measurementNoiseControl };
  }
  if (architecture === "imc") {
    if (derivative) throw new Error("A arquitetura IMC ainda não combina a derivada sobre a medição.");
    const unit: TransferFunction = { num: [1], den: [1], domain: f.domain, sampleTime: f.sampleTime }, disturbance = innerController ? validateTf(innerController) : unit;
    for (const m of [disturbance]) if (m.domain !== f.domain || (f.domain === "discrete" && m.sampleTime !== f.sampleTime)) throw new Error("O modelo de perturbação Gd precisa usar o mesmo domínio e Ts.");
    const baseDen = mult(ctl.den, plant.den, sensor.den), difference = polyAdd(mult(plant.num, sensor.den), polyScale(mult(sensor.num, plant.den), -1)), loopNum = polyMul(ctl.num, difference), characteristic = polyAdd(baseDen, loopNum), fullDen = mult(f.den, characteristic);
    const feedback = (num: number[], den = characteristic) => validateTf({ num, den, domain: f.domain, sampleTime: f.sampleTime });
    return {
      loop: validateTf({ num: loopNum, den: baseDen, domain: f.domain, sampleTime: f.sampleTime }),
      output: validateTf({ num: mult(f.num, ctl.num, plant.num, sensor.den), den: fullDen, domain: f.domain, sampleTime: f.sampleTime }),
      control: validateTf({ num: mult(f.num, ctl.num, plant.den, sensor.den), den: fullDen, domain: f.domain, sampleTime: f.sampleTime }),
      sensitivity: feedback(baseDen), complementary: feedback(loopNum),
      plantInputDisturbance: feedback(mult(disturbance.num, plant.den, polyAdd(mult(ctl.den, sensor.den), polyScale(mult(ctl.num, sensor.num), -1)))),
      measurementNoiseOutput: feedback(polyScale(mult(ctl.num, plant.num, sensor.den), -1)),
      measurementNoiseControl: feedback(polyScale(mult(ctl.num, plant.den, sensor.den), -1)),
    };
  }
  if (architecture === "feedforward-disturbance" && derivative) throw new Error("A arquitetura feedforward de perturbação ainda não combina a derivada sobre a medição.");
  if (derivative) {
    if (architecture === "feedback-controller") throw new Error("Derivada sobre a medição combinada com compensador no ramo de realimentação ainda não está disponível.");
    // u = C0(F r - H y) - Dm y; keep reference and measurement paths distinct.
    const characteristic = polyAdd(polyAdd(mult(ctl.den, derivative.den, plant.den, sensor.den), mult(ctl.num, derivative.den, plant.num, sensor.num)), mult(derivative.num, ctl.den, plant.num, sensor.den));
    const tf = (num: number[]) => validateTf({ num, den: characteristic, domain: f.domain, sampleTime: f.sampleTime });
    const loopDen = mult(ctl.den, derivative.den, plant.den, sensor.den);
    const loopNum = polyAdd(mult(ctl.num, derivative.den, plant.num, sensor.num), mult(derivative.num, ctl.den, plant.num, sensor.den));
    const feedback = (num: number[]) => validateTf({ num, den: characteristic, domain: f.domain, sampleTime: f.sampleTime });
    return {
      loop: validateTf({ num: loopNum, den: loopDen, domain: f.domain, sampleTime: f.sampleTime }),
      output: tf(mult(f.num, ctl.num, derivative.den, plant.num, sensor.den)),
      control: tf(mult(f.num, ctl.num, derivative.den, plant.den, sensor.den)),
      sensitivity: feedback(loopDen),
      complementary: feedback(loopNum),
      plantInputDisturbance: feedback(mult(plant.num, ctl.den, derivative.den, sensor.den)),
      measurementNoiseOutput: feedback(polyScale(loopNum, -1)),
      measurementNoiseControl: feedback(polyScale(mult(ctl.num, derivative.den, sensor.den, plant.den), -1)),
    };
  }
  if (architecture === "feedback-controller") {
    // Configuration 2: u = F r - C H y and y = G u.
    const loopDen = mult(ctl.den, plant.den, sensor.den), loopNum = mult(ctl.num, plant.num, sensor.num);
    const characteristic = polyAdd(loopDen, loopNum), fullDen = mult(f.den, characteristic);
    const feedback = (num: number[]) => validateTf({ num, den: characteristic, domain: f.domain, sampleTime: f.sampleTime });
    return {
      loop: validateTf({ num: loopNum, den: loopDen, domain: f.domain, sampleTime: f.sampleTime }),
      output: validateTf({ num: mult(f.num, ctl.den, plant.num, sensor.den), den: fullDen, domain: f.domain, sampleTime: f.sampleTime }),
      control: validateTf({ num: mult(f.num, ctl.den, plant.den, sensor.den), den: fullDen, domain: f.domain, sampleTime: f.sampleTime }),
      sensitivity: feedback(loopDen), complementary: feedback(loopNum),
      plantInputDisturbance: feedback(mult(ctl.den, plant.num, sensor.den)),
      measurementNoiseOutput: feedback(polyScale(mult(ctl.num, plant.num, sensor.den), -1)),
      measurementNoiseControl: feedback(polyScale(mult(ctl.num, plant.den, sensor.den), -1)),
    };
  }
  if (architecture === "feedforward-disturbance") {
    const baseDen = mult(ctl.den, plant.den, sensor.den), loopNum = mult(ctl.num, plant.num, sensor.num), characteristic = polyAdd(baseDen, loopNum), fullDen = mult(f.den, characteristic);
    const feedback = (num: number[], den = characteristic) => validateTf({ num, den, domain: f.domain, sampleTime: f.sampleTime });
    return {
      loop: validateTf({ num: loopNum, den: baseDen, domain: f.domain, sampleTime: f.sampleTime }),
      output: feedback(mult(ctl.num, plant.num, sensor.den)),
      control: feedback(mult(ctl.num, plant.den, sensor.den)),
      sensitivity: feedback(baseDen), complementary: feedback(loopNum),
      plantInputDisturbance: feedback(mult(plant.num, ctl.den, sensor.den, polyAdd(f.den, f.num)), fullDen),
      measurementNoiseOutput: feedback(polyScale(loopNum, -1)),
      measurementNoiseControl: feedback(polyScale(mult(ctl.num, plant.den, sensor.num), -1)),
    };
  }
  const loopDen = polyAdd(mult(ctl.den, plant.den, sensor.den), mult(ctl.num, plant.num, sensor.num));
  const fullDen = mult(f.den, loopDen);
  const tf = (num: number[]): TransferFunction => validateTf({ num, den: fullDen, domain: f.domain, sampleTime: f.sampleTime });
  const feedbackTf = (num: number[]): TransferFunction => validateTf({ num, den: loopDen, domain: f.domain, sampleTime: f.sampleTime });
  const referenceNumerator = referenceCtl?.num ?? ctl.num;
  return {
    loop: validateTf({ num: mult(ctl.num, plant.num, sensor.num), den: mult(ctl.den, plant.den, sensor.den), domain: f.domain, sampleTime: f.sampleTime }),
    output: tf(mult(f.num, referenceNumerator, plant.num, sensor.den)),
    control: tf(mult(f.num, referenceNumerator, plant.den, sensor.den)),
    sensitivity: validateTf({ num: mult(ctl.den, plant.den, sensor.den), den: loopDen, domain: f.domain, sampleTime: f.sampleTime }),
    complementary: validateTf({ num: mult(ctl.num, plant.num, sensor.num), den: loopDen, domain: f.domain, sampleTime: f.sampleTime }),
    plantInputDisturbance: feedbackTf(mult(plant.num, ctl.den, sensor.den)),
    measurementNoiseOutput: feedbackTf(polyScale(mult(ctl.num, plant.num, sensor.num), -1)),
    measurementNoiseControl: feedbackTf(polyScale(mult(ctl.num, sensor.num, plant.den), -1)),
  };
}
function polynomialAt(p: readonly number[], z: Complex): Complex { return p.reduce((v, k) => add(mul(v, z), c(k)), c(0)); }
/** Durand–Kerner com inicialização circular e refinamento. Raízes conjugadas aparecem preservadas. */
export function polynomialRoots(coefficients: readonly number[]): Complex[] {
  const p = trim([...coefficients]); if (p.length < 2) return [];
  const lead = p[0]!; for (let i = 0; i < p.length; i++) p[i] = p[i]! / lead;
  const n = p.length - 1; if (n > 24) throw new Error("Ordens acima de 24 não são suportadas pelo solucionador atual.");
  const radius = 1 + Math.max(...p.slice(1).map(Math.abs)); let roots = Array.from({ length: n }, (_, i) => c(radius * Math.cos(2 * Math.PI * (i + .25) / n), radius * Math.sin(2 * Math.PI * (i + .25) / n)));
  for (let k = 0; k < 1200; k++) { let err = 0; roots = roots.map((z, i) => { let den = c(1); roots.forEach((w, j) => { if (i !== j) den = mul(den, sub(z, w)); }); if (abs(den) < 1e-28) den = add(den, c(1e-20, 1e-20)); const d = div(polynomialAt(p, z), den); err = Math.max(err, abs(d)); return sub(z, d); }); if (err < 1e-11) break; }
  return roots;
}
export const poles = (tf: TransferFunction): Complex[] => polynomialRoots(tf.den);
/** Internal closed-loop stability depends on the feedback characteristic denominator, not F or a single output path. */
export type StabilityClass = "stable" | "unstable" | "marginal" | "near-boundary";
export function classifyStability(tf: TransferFunction): StabilityClass {
  const model = validateTf(tf), roots = poles(model);
  if (!roots.length) return "stable";
  let boundary = false, near = false;
  for (const pole of roots) {
    const metric = model.domain === "continuous" ? pole.re : abs(pole);
    const edge = model.domain === "continuous" ? 0 : 1;
    if (Math.abs(metric - edge) <= (model.domain === "continuous" ? 1e-9 : 1e-8)) boundary = true;
    else if (Math.abs(metric - edge) <= (model.domain === "continuous" ? 1e-5 : 1e-5)) near = true;
    else if (model.domain === "continuous" ? metric > edge : metric > edge) return "unstable";
  }
  return boundary ? "marginal" : near ? "near-boundary" : "stable";
}
export const isStable = (tf: TransferFunction): boolean => classifyStability(tf) === "stable";
/** Internal unity-feedback stability check without cancelling hidden plant/controller modes. */
export function isFeedbackLoopStable(process:TransferFunction,controller:TransferFunction):boolean {
  const loop=tfMul(validateTf(process),validateTf(controller));
  return classifyStability(validateTf({num:[1],den:polyAdd(loop.den,loop.num),domain:loop.domain,sampleTime:loop.sampleTime}))==="stable";
}
export const zeros = (tf: TransferFunction): Complex[] => polynomialRoots(tf.num);
/** Synthesize the proper controller whose effective open loop follows a bandwidth target over an integrator. */
export function synthesizeLoopShapeByBandwidth(process:TransferFunction,bandwidth:number):TransferFunction {
  const plant=validateTf(process);
  if(!(bandwidth>0&&Number.isFinite(bandwidth)))throw new Error("Informe uma largura de banda positiva.");
  if(classifyStability(plant)!=="stable")throw new Error("A planta efetiva da malha selecionada precisa ser estavel para evitar cancelamentos instaveis.");
  if(plant.domain==="continuous"?zeros(plant).some(root=>root.re>=-1e-9):zeros(plant).some(root=>abs(root)>=1-1e-9))throw new Error("A planta efetiva precisa ser de fase minima para evitar polos instaveis no controlador.");
  const relativeDegree=plant.den.length-plant.num.length;
  if(relativeDegree<0)throw new Error("A planta efetiva precisa ser propria.");
  if(plant.domain==="continuous"){
    const filterOrder=Math.max(0,relativeDegree-1),tau=1/bandwidth;let filter=[1];
    for(let i=0;i<filterOrder;i++)filter=polyMul(filter,[tau,1]);
    return validateTf({num:plant.den.map(value=>value*bandwidth),den:polyMul(polyMul(plant.num,[1,0]),filter),domain:"continuous"});
  }
  const ts=plant.sampleTime!;
  if(!(bandwidth*ts<Math.PI))throw new Error("A largura de banda deve ficar abaixo da frequencia de Nyquist (π/Ts).");
  const integratorGain=Math.tan(bandwidth*ts/2);
  if(!(integratorGain>0&&Number.isFinite(integratorGain)))throw new Error("A largura de banda nao pode ser representada com este tempo de amostragem.");
  const filterOrder=relativeDegree;let targetNum=[integratorGain,integratorGain],targetDen=[1,-1];
  for(let i=0;i<filterOrder;i++){
    const pole=Math.exp(-bandwidth*ts),dcGain=1-pole;
    if(!(pole<1&&pole>0&&dcGain>0))throw new Error("A largura de banda e pequena demais para ser representada com este tempo de amostragem.");
    targetNum=polyScale(targetNum,dcGain);targetDen=polyMul(targetDen,[1,-pole]);
  }
  return validateTf({num:polyMul(plant.den,targetNum),den:polyMul(plant.num,targetDen),domain:"discrete",sampleTime:ts});
}
export function interpretDiscretePole(pole: Complex, sampleTime: number): { principal?: Complex; naturalFrequency?: number; dampingRatio?: number; branchSpacing: number; note: string } {
  if (!(sampleTime > 0) || !Number.isFinite(sampleTime)) throw new Error("Ts must be positive to interpret a discrete pole.");
  const radius = abs(pole), branchSpacing = 2 * Math.PI / sampleTime;
  if (radius === 0) return { branchSpacing, note: "z=0 has no finite logarithmic equivalent; it represents a deadbeat mode." };
  const principal = c(Math.log(radius) / sampleTime, Math.atan2(pole.im, pole.re) / sampleTime);
  const naturalFrequency = abs(principal);
  return { principal, naturalFrequency, dampingRatio: naturalFrequency > 0 ? -principal.re / naturalFrequency : undefined, branchSpacing,
    note: `Principal logarithm; other branches shift imaginary frequency by multiples of ${branchSpacing} rad/s.` };
}
export function evalTf(tf: TransferFunction, s: Complex): Complex { return div(polynomialAt(tf.num, s), polynomialAt(tf.den, s)); }
export const frequencyResponse = (tf: TransferFunction, omega: number): Complex => staticGain(tf) ? evalTf(tf, c(0)) : evalTf(tf, tf.domain === "continuous" ? c(0, omega) : c(Math.cos(omega * tf.sampleTime!), Math.sin(omega * tf.sampleTime!)));
/** Peak closed-loop sensitivity to a reference for unity negative feedback, in dB. */
export function closedLoopPeakGainDb(loop:TransferFunction):number {
  validateTf(loop);
  const denominator=polyAdd(loop.den,loop.num),scale=Math.max(1,...loop.den.map(Math.abs),...loop.num.map(Math.abs));
  if(denominator.every(value=>Math.abs(value)<=Number.EPSILON*scale*16))return Infinity;
  const closed=validateTf({num:[...loop.num],den:denominator,domain:loop.domain,...(loop.domain==="discrete"?{sampleTime:loop.sampleTime}:{})});
  const peak=Math.max(...bode(closed).map(point=>point.magnitudeDb));
  return Number.isNaN(peak)?Infinity:peak;
}
export interface BodePoint { omega: number; magnitudeDb: number; phaseDeg: number }
export type ClassicalPidParameters = { kp: number; ti?: number; td?: number };
export type ClassicalPidKind = "P" | "PI" | "PID";
function validateClassicalPidParameters(parameters: ClassicalPidParameters): ClassicalPidParameters {
  if (!Number.isFinite(parameters.kp) || parameters.kp === 0 || (parameters.ti !== undefined && !(Number.isFinite(parameters.ti) && parameters.ti > 0)) || (parameters.td !== undefined && !(Number.isFinite(parameters.td) && parameters.td >= 0))) throw new Error("Classical PID tuning returned invalid parameters.");
  return parameters;
}
/** Ziegler-Nichols open-loop reaction-curve rules for a signed FOPDT process. */
export function zieglerNicholsStepParameters(gain: number, delay: number, timeConstant: number, kind: ClassicalPidKind): ClassicalPidParameters {
  if (![gain, delay, timeConstant].every(Number.isFinite) || gain === 0 || delay <= 0 || timeConstant <= 0) throw new Error("Ziegler-Nichols step tuning requires a nonzero gain and positive FOPDT delay/time constant.");
  const ratio = timeConstant / (gain * delay);
  if (kind === "P") return validateClassicalPidParameters({ kp: ratio });
  if (kind === "PI") return validateClassicalPidParameters({ kp: .9 * ratio, ti: 3.33 * delay });
  return validateClassicalPidParameters({ kp: 1.2 * ratio, ti: 2 * delay, td: .5 * delay });
}
/** Ziegler-Nichols ultimate-cycle rules; period is the period at the first -180 degree crossing. */
export function zieglerNicholsFrequencyParameters(ultimateGain: number, ultimatePeriod: number, kind: ClassicalPidKind): ClassicalPidParameters {
  if (![ultimateGain, ultimatePeriod].every(Number.isFinite) || ultimateGain <= 0 || ultimatePeriod <= 0) throw new Error("Ziegler-Nichols frequency tuning requires positive ultimate gain and period.");
  if (kind === "P") return validateClassicalPidParameters({ kp: .5 * ultimateGain });
  if (kind === "PI") return validateClassicalPidParameters({ kp: .45 * ultimateGain, ti: ultimatePeriod / 1.2 });
  return validateClassicalPidParameters({ kp: .6 * ultimateGain, ti: ultimatePeriod / 2, td: ultimatePeriod / 8 });
}
/** Chien-Hrones-Reswick 0% overshoot, disturbance-rejection reaction-curve rules. */
export function chienHronesReswickParameters(gain: number, delay: number, timeConstant: number, kind: ClassicalPidKind): ClassicalPidParameters {
  if (![gain, delay, timeConstant].every(Number.isFinite) || gain === 0 || delay <= 0 || timeConstant <= 0) throw new Error("CHR tuning requires a nonzero gain and positive FOPDT delay/time constant.");
  const ratio = timeConstant / (gain * delay);
  if (kind === "P") return validateClassicalPidParameters({ kp: .3 * ratio });
  if (kind === "PI") return validateClassicalPidParameters({ kp: .6 * ratio, ti: 4 * delay });
  return validateClassicalPidParameters({ kp: .95 * ratio, ti: 2.4 * delay, td: .42 * delay });
}

/** Skogestad SIMC PI rule for a signed first-order-plus-dead-time model. */
export function skogestadImcPiParameters(gain: number, delay: number, timeConstant: number, closedLoopTime: number): ClassicalPidParameters {
  if (![gain, delay, timeConstant, closedLoopTime].every(Number.isFinite) || gain === 0 || delay <= 0 || timeConstant <= 0 || closedLoopTime <= 0) throw new Error("Skogestad IMC PI tuning requires nonzero process gain and positive model/tuning time constants.");
  const sum = closedLoopTime + delay;
  return validateClassicalPidParameters({ kp: timeConstant / (gain * sum), ti: Math.min(timeConstant, 4 * sum) });
}
/** AMIGOf PI rule for Ms=1.4; omegaPhi is expressed in rad/s. */
export function amigofPiParameters(Kphi: number, omegaPhi: number, kappa: number, gainSign: number): { kp: number; ti: number } {
  if (![Kphi, omegaPhi, kappa, gainSign].every(Number.isFinite) || Kphi <= 0 || omegaPhi <= 0 || kappa < 0 || gainSign === 0)
    throw new Error("Invalid AMIGOf frequency parameters.");
  const phi = 135 * Math.PI / 180;
  const a = 2.5 - .92 * phi, b = 10.75 - 4.01 * phi;
  const c = -3.05 + 1.72 * phi, d = -6.10 + 3.44 * phi;
  const denominator = Kphi * (1 + b * kappa);
  const result = { kp: Math.sign(gainSign) * a / denominator, ti: (c + d * kappa) / omegaPhi };
  if (!(denominator > 0) || !Number.isFinite(result.kp) || result.kp === 0 || !(result.ti > 0) || !Number.isFinite(result.ti))
    throw new Error("AMIGOf returned parameters outside the valid range.");
  return result;
}
type BodeSeries = BodePoint[] & { magnitudeExtrema: number[]; coverage: "algebraic-extrema" | "adaptive-only" };
function ascendingTrim(p: number[]): number[] { while (p.length > 1 && p.at(-1) === 0) p.pop(); return p; }
function ascendingAdd(a: readonly number[], b: readonly number[]): number[] { const n = Math.max(a.length,b.length); return ascendingTrim(Array.from({length:n},(_,i)=>(a[i]??0)+(b[i]??0))); }
function ascendingMul(a: readonly number[], b: readonly number[]): number[] { const out=new Array(a.length+b.length-1).fill(0);a.forEach((x,i)=>b.forEach((y,j)=>out[i+j]+=x*y));return ascendingTrim(out); }
function ascendingDerivative(a: readonly number[]): number[] { return a.length<=1?[0]:ascendingTrim(a.slice(1).map((value,index)=>value*(index+1))); }
function ascendingToDescending(a: readonly number[]): number[] { return trim([...a].reverse()); }
function magnitudePolynomialContinuous(coefficients: readonly number[]): number[] {
  let real=[0], imag=[0];
  coefficients.forEach((value,index)=>{const power=coefficients.length-1-index,slot=Math.floor(power/2),target=power%2?imag:real;while(target.length<=slot)target.push(0);target[slot]=value*(Math.floor(power/2)%2?-1:1)});
  return ascendingAdd(ascendingMul(real,real),[0,...ascendingMul(imag,imag)]);
}
function magnitudePolynomialDiscrete(coefficients: readonly number[]): number[] {
  const ascending=[...coefficients].reverse(), degree=ascending.length-1, diagonals=new Array(degree+1).fill(0);
  for(let lag=0;lag<=degree;lag++)for(let index=0;index+lag<=degree;index++)diagonals[lag]+=ascending[index]!*ascending[index+lag]!;
  const chebyshev:[[number[]],[number[]]]|any=[[1],[0,1]];
  for(let n=2;n<=degree;n++)chebyshev[n]=ascendingAdd([0,...chebyshev[n-1]].map((x:number)=>2*x),chebyshev[n-2].map((x:number)=>-x));
  let result=[diagonals[0]!];
  for(let lag=1;lag<=degree;lag++)result=ascendingAdd(result,chebyshev[lag].map((x:number)=>2*diagonals[lag]!*x));
  return result;
}
function algebraicMagnitudeExtrema(tf: TransferFunction): number[] {
  const magnitude=tf.domain==="continuous"?magnitudePolynomialContinuous:magnitudePolynomialDiscrete;
  const numerator=magnitude(tf.num),denominator=magnitude(tf.den);
  const derivative=ascendingAdd(ascendingMul(ascendingDerivative(numerator),denominator),ascendingMul(numerator,ascendingDerivative(denominator)).map(x=>-x));
  const roots=polynomialRoots(ascendingToDescending(derivative));
  return roots.filter(root=>Math.abs(root.im)<1e-7).map(root=>tf.domain==="continuous"?Math.sqrt(root.re):Math.acos(Math.max(-1,Math.min(1,root.re)))/tf.sampleTime!).filter(value=>value>0&&Number.isFinite(value));
}
export function bode(tf: TransferFunction, count = 240, customFrequencyGrid?: readonly number[]): BodeSeries {
  if (tf.domain === "discrete" && !Number.isFinite(tf.sampleTime)) throw new Error("A discrete Bode plot needs a known Ts to define the Nyquist frequency.");
  if (customFrequencyGrid && (customFrequencyGrid.length < 2 || customFrequencyGrid.length > 5000 || customFrequencyGrid.some((value, index) => !(value > 0 && Number.isFinite(value)) || index > 0 && value <= customFrequencyGrid[index - 1]!))) throw new Error("A custom Bode frequency grid needs 2 to 5000 positive, strictly increasing finite values.");
  const ps = [...poles(tf), ...zeros(tf)].map(abs).filter((x) => x > 1e-8 && Number.isFinite(x));
  const nyquist = tf.domain === "discrete" ? Math.PI / tf.sampleTime! : undefined;
  if (customFrequencyGrid && nyquist !== undefined && customFrequencyGrid.at(-1)! > nyquist * (1 + 1e-10)) throw new Error(`The custom frequency grid cannot exceed Nyquist (${nyquist.toPrecision(5)} rad/s).`);
  const extrema = algebraicMagnitudeExtrema(tf);
  const high = nyquist ?? Math.max(Math.min(1e5, Math.max(10, (ps.length ? Math.max(...ps) : 1) * 100)), ...extrema);
  // z-plane pole radii are not break frequencies. Sample the physical band up to Nyquist.
  const low = nyquist ? Math.max(1e-8, high / 1e4) : Math.min(Math.max(1e-12, (ps.length ? Math.min(...ps) : 1) / 100), high / 10, ...extrema.map(value=>value/1.05));
  const frequencies = new Set(customFrequencyGrid ?? Array.from({ length: count }, (_, i) => low * (high / low) ** (i / (count - 1))));
  if (!customFrequencyGrid) for(const omega of extrema) if(omega<=high) frequencies.add(omega);
  // Add local samples around every finite pole/zero bandwidth so a high-Q resonance does not
  // disappear between adjacent points of the general logarithmic grid.
  for (const root of customFrequencyGrid ? [] : [...poles(tf), ...zeros(tf)]) {
    const radius = abs(root);
    const center = tf.domain === "continuous" ? Math.abs(root.im) : Math.abs(Math.atan2(root.im, root.re) / tf.sampleTime!);
    const bandwidth = tf.domain === "continuous" ? Math.abs(root.re) : radius > 0 ? Math.abs(Math.log(radius) / tf.sampleTime!) : high;
    if (!(center > 0) || center < low || center > high || !Number.isFinite(bandwidth)) continue;
    const span = Math.max(bandwidth, center * 1e-9);
    for (let i = 0; i <= 120; i++) {
      const omega = center + (i / 120 * 12 - 6) * span;
      if (omega >= low && omega <= high) frequencies.add(omega);
    }
  }
  const result = [...frequencies].sort((a, b) => a - b).map(w => { const z = frequencyResponse(tf, w), phase = Math.atan2(z.im, z.re) * 180 / Math.PI; return { omega: w, magnitudeDb: 20 * Math.log10(Math.max(abs(z), 1e-150)), phaseDeg: phase }; });
  for (let i = 1; i < result.length; i++) {
    const previous = result[i - 1]!.phaseDeg;
    let phase = result[i]!.phaseDeg;
    while (phase - previous > 180) phase -= 360;
    while (phase - previous < -180) phase += 360;
    result[i]!.phaseDeg = phase;
  }
  return Object.assign(result,{magnitudeExtrema:extrema,coverage:"algebraic-extrema" as const}) as BodeSeries;
}
/** Approximate winding of L(jw)+1 over the conjugate Nyquist contour. Returns undefined when a sampled singularity lies on the contour. */
/** Algebraic Nyquist winding from the argument principle; no contour mesh is used. */
export function nyquistEncirclements(tf: TransferFunction): number | undefined {
  const model=validateTf(tf), characteristic=polyAdd(model.den,model.num), openRoots=polynomialRoots(model.den),closedRoots=polynomialRoots(characteristic);
  const unstableCount=(polynomial:readonly number[],roots:Complex[]):number|undefined=>{
    const degree=polynomial.length-1,scale=Math.max(1,...polynomial.map(Math.abs));
    if(roots.some(root=>abs(polynomialAt(polynomial,root))/(scale*Math.max(1,1+abs(root))**degree)>1e-7))return undefined;
    let count=0;
    for(const root of roots){const metric=model.domain==="continuous"?root.re:abs(root),distance=model.domain==="continuous"?Math.abs(metric):Math.abs(metric-1);if(distance<1e-7)return undefined;if(model.domain==="continuous"?metric>0:metric>1)count++;}
    return count;
  };
  const open=unstableCount(model.den,openRoots),closed=unstableCount(characteristic,closedRoots);
  if(open===undefined||closed===undefined)return undefined;
  // The continuous RHP contour uses the opposite orientation from the
  // discrete unit-circle contour (z=e^(jωTs), traversed counter-clockwise).
  return model.domain === "continuous" ? closed-open : open-closed;
}export interface RootLocusPoint { gain: number; roots: Complex[] }
/** Global minimum-distance assignment avoids greedy branch swaps near repeated/crossing roots. */
function associateRootBranches(previous: readonly Complex[], candidates: readonly Complex[]): Complex[] {
  const n = previous.length, u = new Array(n + 1).fill(0), v = new Array(n + 1).fill(0);
  const p = new Array(n + 1).fill(0), way = new Array(n + 1).fill(0);
  for (let i = 1; i <= n; i++) {
    p[0] = i;
    let j0 = 0;
    const minv = new Array(n + 1).fill(Infinity), used = new Array(n + 1).fill(false);
    do {
      used[j0] = true;
      const i0 = p[j0]!;
      let delta = Infinity, j1 = 0;
      for (let j = 1; j <= n; j++) if (!used[j]) {
        const a = previous[i0 - 1]!, b = candidates[j - 1]!;
        const cur = Math.hypot(a.re - b.re, a.im - b.im) - u[i0]! - v[j]!;
        if (cur < minv[j]!) { minv[j] = cur; way[j] = j0; }
        if (minv[j]! < delta) { delta = minv[j]!; j1 = j; }
      }
      for (let j = 0; j <= n; j++) {
        if (used[j]) { u[p[j]!] += delta; v[j] -= delta; }
        else minv[j] -= delta;
      }
      j0 = j1;
    } while (p[j0] !== 0);
    do { const j1 = way[j0]!; p[j0] = p[j1]; j0 = j1; } while (j0 !== 0);
  }
  const ordered = new Array<Complex>(n);
  for (let j = 1; j <= n; j++) ordered[p[j]! - 1] = candidates[j - 1]!;
  return ordered;
}
/** Varre ganhos logarítmicos em k·C₀(s)G(s)H(s); sem cancelamentos automáticos. */
export type RootLocusSeries = RootLocusPoint[] & { converged: boolean; maxRelativeResidual: number };
export function rootLocus(openLoop: TransferFunction, minGain = 1e-3, maxGain = 1e3, samples = 90): RootLocusSeries {
  if (!(minGain > 0) || !(maxGain > minGain) || samples < 2) throw new Error("Root-locus gain interval and sample count are invalid.");
  let maxRelativeResidual=0,unresolved=false;
  const solve = (gain: number, previous?: Complex[]): RootLocusPoint => {
    const characteristic=polyAdd(openLoop.den,polyScale(openLoop.num,gain));let roots=polynomialRoots(characteristic);
    const scale=Math.max(1,...characteristic.map(Math.abs));for(const root of roots)maxRelativeResidual=Math.max(maxRelativeResidual,abs(polynomialAt(characteristic,root))/(scale*Math.max(1,1+abs(root))**(characteristic.length-1)));
    if (previous && roots.length === previous.length) roots = associateRootBranches(previous, roots);
    return { gain, roots };
  };
  const initial: RootLocusPoint[] = [];
  for (let i = 0; i < samples; i++) initial.push(solve(minGain * (maxGain / minGain) ** (i / (samples - 1)), initial[initial.length - 1]?.roots));
  const result: RootLocusPoint[] = [initial[0]!], maxPoints = Math.max(samples, 8192);
  const refine = (left: RootLocusPoint, right: RootLocusPoint, depth: number): void => {
    if(left.roots.length!==right.roots.length){unresolved=true;result.push(right);return;}
    const gain = Math.sqrt(left.gain * right.gain), middle = solve(gain, left.roots);
    const scale = Math.max(1, ...left.roots.map((p) => Math.hypot(p.re, p.im)), ...right.roots.map((p) => Math.hypot(p.re, p.im)));
    let curvature = 0, travel = 0;
    for (let i = 0; i < middle.roots.length; i++) {
      const a = left.roots[i]!, b = right.roots[i]!, m = middle.roots[i]!;
      curvature = Math.max(curvature, Math.hypot(m.re - (a.re + b.re) / 2, m.im - (a.im + b.im) / 2) / scale);
      travel = Math.max(travel, Math.hypot(b.re - a.re, b.im - a.im) / scale);
    }
    if(curvature>.003||travel>.08){if(depth>=14||result.length>=maxPoints-1){unresolved=true;result.push(right);return;}refine(left,middle,depth+1);refine(middle,right,depth+1);}
    else result.push(right);
  };
  for (let i = 1; i < initial.length; i++) refine(result[result.length - 1]!, initial[i]!, 0);
  return Object.assign(result,{converged:!unresolved&&maxRelativeResidual<1e-7,maxRelativeResidual}) as RootLocusSeries;
}
export interface TimeSample { time: number; value: number }
export interface TimeResponse { samples: TimeSample[]; stable: boolean; directFeedthrough: number; converged: boolean }
/** Simulates a sampled input with zero initial state using a discrete difference equation or a continuous-time state-space realization. */
export function timeResponseForInput(tf: TransferFunction, input: readonly number[], sampleTimes?: readonly number[]): TimeResponse {
  const model = validateTf(tf);
  if (!input.length || input.some((value) => !Number.isFinite(value))) throw new Error("Provide a non-empty finite sample sequence.");
  if(sampleTimes&& (sampleTimes.length!==input.length||sampleTimes.length<2||sampleTimes.some((time,index)=>!Number.isFinite(time)||time<0||index>0&&time<=sampleTimes[index-1]!)))throw new Error("Input sample times must match the input length and increase strictly.");
  if(model.den.length<model.num.length)throw new Error("Arbitrary-input simulation requires a proper transfer function.");
  if(model.domain==="continuous"){
    const times=sampleTimes??input.map((_,index)=>index*.01),n=model.den.length-1,den=model.den.map(value=>value/model.den[0]!),num=[...new Array(n+1-model.num.length).fill(0),...model.num].map(value=>value/model.den[0]!),direct=num[0]??0;
    if(n===0)return{samples:input.map((value,index)=>({time:times[index]!,value:direct*value})),stable:true,directFeedthrough:direct,converged:true};
    const c=Array.from({length:n},(_,index)=>num[index+1]!-den[index+1]!*direct),x=new Array(n).fill(0),samples:TimeSample[]=[],fastestPole=Math.max(1,...poles(model).map(root=>Math.hypot(root.re,root.im))),maximumStep=.1/fastestPole;
    const derivative=(state:number[],u:number)=>state.map((_,index)=>index<n-1?state[index+1]!: -den.slice(1).reduce((sum,value,j)=>sum+value*state[j]!,0)+u);
    const add=(state:number[],delta:number[],scale:number)=>state.map((value,index)=>value+delta[index]!*scale);
    for(let k=0;k<input.length;k++){
      const y=direct*input[k]!+c.reduce((sum,value,index)=>sum+value*x[index]!,0);samples.push({time:times[k]!,value:y});if(k===input.length-1)break;
      const interval=times[k+1]!-times[k]!,u0=input[k]!,u1=input[k+1]!,steps=Math.max(1,Math.ceil(interval/maximumStep)),dt=interval/steps;
      for(let step=0;step<steps;step++){const f0=step/steps,fm=(step+.5)/steps,f1=(step+1)/steps,ua=u0+(u1-u0)*f0,um=u0+(u1-u0)*fm,ub=u0+(u1-u0)*f1,a=derivative(x,ua),b=derivative(add(x,a,dt/2),um),d=derivative(add(x,b,dt/2),um),e=derivative(add(x,d,dt),ub);for(let index=0;index<n;index++)x[index]=x[index]!+dt*(a[index]!+2*b[index]!+2*d[index]!+e[index]!)/6}
    }
    const stable=classifyStability(model)==="stable";return{samples,stable,directFeedthrough:direct,converged:stable&&samples.every(sample=>Number.isFinite(sample.value))};
  }
  const dt = model.sampleTime!;if(sampleTimes&&sampleTimes.some((time,index)=>Math.abs(time-index*dt)>1e-8*Math.max(1,time)))throw new Error("Discrete input samples must be spaced by exactly one sample time.");const den = model.den.map((value) => value / model.den[0]!), num = model.num.map((value) => value / model.den[0]!);
  const b = [...new Array(den.length - num.length).fill(0), ...num], outputs: number[] = [], samples: TimeSample[] = [];
  for (let k = 0; k < input.length; k++) {
    let y = 0;
    for (let j = 0; j < b.length; j++) if (k - j >= 0) y += b[j]! * input[k - j]!;
    for (let j = 1; j < den.length; j++) if (k - j >= 0) y -= den[j]! * outputs[k - j]!;
    outputs.push(y); samples.push({ time: k * dt, value: y });
  }
  return { samples, stable: classifyStability(model) === "stable", directFeedthrough: b[0] ?? 0,
    converged: classifyStability(model) === "stable" && samples.every((sample) => Number.isFinite(sample.value)) };
}

/** Closed-loop zero-input response for a nonzero initial plant state with static C and H.
 * The original A/B/C/D realization is used directly, preserving hidden internal modes. */
export function closedLoopInitialStateResponse(plant: { A: number[][]; B: number[]; C: number[]; D: number; domain?: "continuous" | "discrete" }, initial: readonly number[], controller: TransferFunction, sensor: TransferFunction, duration?: number, count = 500, controllerInitial: readonly number[] = [], sensorInitial: readonly number[] = []): TimeResponse {
  const ctl = validateTf(controller), h = validateTf(sensor), c = tfToStateSpace(ctl), hs = tfToStateSpace(h), n = plant.A.length, nc = c.A.length, nh = hs.A.length;
  if (!n || plant.A.some(row => row.length !== n) || plant.B.length !== n || plant.C.length !== n || initial.length !== n || initial.some(v => !Number.isFinite(v))) throw new Error("O vetor x₀ deve ter exatamente uma entrada finita por estado da planta.");
  const controllerX0 = controllerInitial.length === 0 ? new Array(nc).fill(0) : [...controllerInitial], sensorX0 = sensorInitial.length === 0 ? new Array(nh).fill(0) : [...sensorInitial];
  if (controllerX0.length !== nc || controllerX0.some(v => !Number.isFinite(v))) throw new Error(`O estado inicial de C deve conter ${nc} valores finitos.`);
  if (sensorX0.length !== nh || sensorX0.some(v => !Number.isFinite(v))) throw new Error(`O estado inicial de H deve conter ${nh} valores finitos.`);
  if (ctl.domain !== h.domain || ctl.domain === "discrete" && ctl.sampleTime !== h.sampleTime) throw new Error("C e H precisam compartilhar domínio e Ts para resposta por condição inicial.");
  const dimension = n + nc + nh, algebraicDenominator = 1 + hs.D * plant.D * c.D;
  if (Math.abs(algebraicDenominator) < 1e-12) throw new Error("A interconexão algébrica de malha fechada é singular (1 + D_H·D_G·D_C = 0).");
  const derivative = (state: number[]) => {
    const xg = state.slice(0, n), xc = state.slice(n, n + nc), xh = state.slice(n + nc);
    const yc = c.C.reduce((sum, value, i) => sum + value * (xc[i] ?? 0), 0), yh = hs.C.reduce((sum, value, i) => sum + value * (xh[i] ?? 0), 0), yg = plant.C.reduce((sum, value, i) => sum + value * xg[i]!, 0);
    const error = -(yh + hs.D * (yg + plant.D * yc)) / algebraicDenominator, control = yc + c.D * error, output = yg + plant.D * control;
    const xgd = plant.A.map((row, i) => row.reduce((sum, value, j) => sum + value * xg[j]!, 0) + plant.B[i]! * control);
    const xcd = c.A.map((row, i) => row.reduce((sum, value, j) => sum + value * xc[j]!, 0) + c.B[i]! * error);
    const xhd = hs.A.map((row, i) => row.reduce((sum, value, j) => sum + value * (xh[j] ?? 0), 0) + hs.B[i]! * output);
    return { dx: [...xgd, ...xcd, ...xhd], output };
  };
  let x = [...initial, ...controllerX0, ...sensorX0];
  const plantDomain = plant.domain ?? ctl.domain;
  if (plantDomain === "continuous" && ctl.domain === "discrete") {
    const dt = ctl.sampleTime!, steps = Math.min(count, Math.max(1, Math.ceil((duration ?? dt * 200) / dt) + 1)), plantState = [...initial], controllerState = [...controllerX0], sensorState = [...sensorX0], samples: TimeSample[] = [];
    const sample = () => {
      const y0 = plant.C.reduce((sum, value, i) => sum + value * plantState[i]!, 0), yc = c.C.reduce((sum, value, i) => sum + value * (controllerState[i] ?? 0), 0), yh = hs.C.reduce((sum, value, i) => sum + value * (sensorState[i] ?? 0), 0);
      const error = -(yh + hs.D * (y0 + plant.D * yc)) / algebraicDenominator, control = yc + c.D * error, output = y0 + plant.D * control;
      return { error, control, output };
    };
    const stablePlant = convertZoh(stateSpaceToTf({ ...plant, domain: "continuous" }), dt), stableLoop = closeLoop({ num: [1], den: [1], domain: "discrete", sampleTime: dt }, ctl, stablePlant, h);
    const stable = classifyStability(stableLoop.output) === "stable";
    const derivative = (state: number[], control: number[]) => plant.A.map((row, i) => row.reduce((sum, value, j) => sum + value * state[j]!, 0) + plant.B[i]! * control[0]!);
    const advancePlant = (control: number) => {
      const held = [control], add = (state: number[], delta: number[], scale: number) => state.map((value, i) => value + delta[i]! * scale), a = derivative(plantState, held), b = derivative(add(plantState, a, dt / 2), held), c1 = derivative(add(plantState, b, dt / 2), held), d = derivative(add(plantState, c1, dt), held);
      for (let i = 0; i < n; i++) plantState[i] = plantState[i]! + dt * (a[i]! + 2 * b[i]! + 2 * c1[i]! + d[i]!) / 6;
    };
    for (let step = 0; step < steps; step++) {
      const current = sample(); samples.push({ time: step * dt, value: current.output });
      if (step === steps - 1) break;
      const nextController = c.A.map((row, i) => row.reduce((sum, value, j) => sum + value * controllerState[j]!, 0) + c.B[i]! * current.error), nextSensor = hs.A.map((row, i) => row.reduce((sum, value, j) => sum + value * sensorState[j]!, 0) + hs.B[i]! * current.output);
      advancePlant(current.control); for (let i = 0; i < nc; i++) controllerState[i] = nextController[i]!; for (let i = 0; i < nh; i++) sensorState[i] = nextSensor[i]!;
    }
    return { samples, stable, directFeedthrough: 0, converged: samples.every(item => Number.isFinite(item.value)) };
  }
  const matrix = Array.from({ length: dimension }, (_, row) => Array.from({ length: dimension }, (_, column) => { const basis = new Array(dimension).fill(0); basis[column] = 1; return derivative(basis).dx[row]!; }));
  const outputC = Array.from({ length: dimension }, (_, column) => { const basis = new Array(dimension).fill(0); basis[column] = 1; return derivative(basis).output; });
  const stabilityModel = stateSpaceToTf({ A: matrix, B: new Array(dimension).fill(0).map((_, i) => i === 0 ? 1 : 0), C: outputC, D: 0, domain: ctl.domain, sampleTime: ctl.sampleTime });
  const stable = classifyStability(stabilityModel) === "stable";
  const plantModel = stateSpaceToTf({ ...plant, domain: "continuous" });
  const horizon = duration ?? (ctl.domain === "discrete" ? (ctl.sampleTime ?? .1) * 200 : Math.min(100, Math.max(5, ...poles(plantModel).map(p => 8 / Math.max(.04, Math.abs(p.re))))));
  const samples: TimeSample[] = [];
  if (ctl.domain === "discrete") {
    const dt = ctl.sampleTime!; const steps = Math.min(count, Math.max(1, Math.ceil(horizon / dt)));
    for (let step = 0; step < steps; step++) { samples.push({ time: step * dt, value: derivative(x).output }); x = derivative(x).dx; }
  } else {
    const dt = horizon / Math.max(1, count - 1), addScaled = (state: number[], delta: number[], scale: number) => state.map((value, i) => value + delta[i]! * scale);
    for (let step = 0; step < count; step++) { samples.push({ time: step * dt, value: derivative(x).output }); if (step === count - 1) break; const a = derivative(x).dx, b = derivative(addScaled(x, a, dt / 2)).dx, c1 = derivative(addScaled(x, b, dt / 2)).dx, d = derivative(addScaled(x, c1, dt)).dx; x = x.map((value, i) => value + dt * (a[i]! + 2 * b[i]! + 2 * c1[i]! + d[i]!) / 6); }
  }
  return { samples, stable, directFeedthrough: 0, converged: samples.every(sample => Number.isFinite(sample.value)) };
}
/** RK4 em forma companheira. Época de impulso no termo direto é indicada separadamente como delta. */
export function timeResponse(tf: TransferFunction, kind: "step" | "ramp" | "impulse" = "step", duration?: number, count = 500, sampleTimes?: readonly number[]): TimeResponse {
  validateTf(tf);
  if(sampleTimes&&(!Array.isArray(sampleTimes)||sampleTimes.length<1||sampleTimes.length>2000||sampleTimes.some((time,index)=>!Number.isFinite(time)||time<0||index>0&&time<=sampleTimes[index-1]!)))throw new Error("Custom response times must contain 2 to 2000 finite, nonnegative, strictly increasing values.");
  if (tf.domain === "discrete" && !Number.isFinite(tf.sampleTime)) throw new Error("A discrete time response needs a known Ts.");
  const pp = poles(tf), stable = classifyStability(tf) === "stable";
  const horizon = duration ?? (tf.domain === "discrete" ? tf.sampleTime! * 200 : Math.min(100, Math.max(5, ...pp.map((p) => 8 / Math.max(.04, Math.abs(p.re))))));
  if (tf.domain === "discrete") {
    const dt = tf.sampleTime!, customIndices=sampleTimes?.map(time=>time/dt), n = sampleTimes ? Math.max(...customIndices!.map(index=>{if(Math.abs(index-Math.round(index))>1e-8)throw new Error("Discrete response times must be integer multiples of Ts.");return Math.round(index)}))+1 : Math.min(count, Math.ceil(horizon / dt)), den = tf.den.map((x) => x / tf.den[0]!), num = tf.num.map((x) => x / tf.den[0]!);
    const ys: number[] = [], samples: TimeSample[] = [], requested=new Map(sampleTimes?.map(time=>[Math.round(time/dt),time])??[]), b = [...new Array(den.length - num.length).fill(0), ...num];
    for (let k = 0; k < n; k++) {
      let y = 0; for (let j = 0; j < b.length; j++) { const ix = k - j; if (ix >= 0) y += b[j]! * (kind === "impulse" ? (ix === 0 ? 1 : 0) : kind === "step" ? 1 : ix * dt); }
      for (let j = 1; j < den.length; j++) { const ix = k - j; if (ix >= 0) y -= den[j]! * ys[ix]!; }
      ys.push(y); if(!sampleTimes||requested.has(k))samples.push({ time: requested.get(k)??k*dt, value: Number.isFinite(y) ? y : NaN });
    }
    return { samples, stable, directFeedthrough: b[0] ?? 0, converged: stable && samples.every((s) => Number.isFinite(s.value)) };
  }
  const den = tf.den.map((x) => x / tf.den[0]!), n = den.length - 1, num0 = new Array(n + 1 - tf.num.length).fill(0), num = [...num0, ...tf.num.map((x) => x / tf.den[0]!)];
  const D = num[0] ?? 0, C = Array.from({ length: n }, (_, j) => (num[n - j] ?? 0) - den[n - j]! * D);
  const dt = horizon / Math.max(1, count - 1), x = new Array(n).fill(0), samples: TimeSample[] = [];
  // Keep RK4 inside its stability region even when the response window is set by
  // a slow pole while another pole is much faster. Preserve the requested output grid.
  const fastestPole = Math.max(0, ...pp.map((pole) => Math.hypot(pole.re, pole.im)));
  const substeps = Math.max(1, Math.min(1000, Math.ceil(dt * fastestPole / 2)));
  if (kind === "impulse" && n > 0) x[n - 1] = 1;
  const deriv = (state: number[], time: number): number[] => {
    const out = new Array(n).fill(0); for (let i = 0; i < n - 1; i++) out[i] = state[i + 1]!;
    let value = kind === "impulse" ? 0 : kind === "step" ? 1 : time;
    // Input derivative terms for relative degree zero are represented by direct feedthrough.
    if (kind === "impulse") value = 0;
    out[n - 1] = value - den.slice(1).reduce((sum, a, i) => sum + a * state[n - 1 - i]!, 0);
    return out;
  };
  const output = (state: number[], time: number) => C.reduce((sum, a, i) => sum + a * state[i]!, D * (kind === "step" ? 1 : kind === "ramp" ? time : 0));
  if(sampleTimes){const samples:TimeSample[]=[];let current=0;for(const time of sampleTimes){const interval=time-current;if(interval>0){const maxStep=dt/substeps,steps=Math.max(1,Math.min(100000,Math.ceil(interval/maxStep))),stepDt=interval/steps,addScaled=(a:number[],b:number[],f:number)=>a.map((v,i)=>v+b[i]!*f);for(let step=0;step<steps;step++){const at=current+step*stepDt,k1=deriv(x,at),k2=deriv(addScaled(x,k1,stepDt/2),at+stepDt/2),k3=deriv(addScaled(x,k2,stepDt/2),at+stepDt/2),k4=deriv(addScaled(x,k3,stepDt),at+stepDt);for(let i=0;i<n;i++)x[i]+=stepDt/6*(k1[i]!+2*k2[i]!+2*k3[i]!+k4[i]!)}current=time}samples.push({time,value:output(x,time)})}return{samples,stable,directFeedthrough:D,converged:stable&&samples.every(sample=>Number.isFinite(sample.value))}}
  for (let k = 0; k < count; k++) {
    const t = k * dt; samples.push({ time: t, value: output(x, t) });
    if (k === count - 1) break;
    const stepDt = dt / substeps, addScaled = (a: number[], b: number[], f: number) => a.map((v, i) => v + b[i]! * f);
    for (let substep = 0; substep < substeps; substep++) {
      const time = t + substep * stepDt, k1 = deriv(x, time), k2 = deriv(addScaled(x, k1, stepDt / 2), time + stepDt / 2), k3 = deriv(addScaled(x, k2, stepDt / 2), time + stepDt / 2), k4 = deriv(addScaled(x, k3, stepDt), time + stepDt);
      for (let i = 0; i < n; i++) x[i] += stepDt / 6 * (k1[i]! + 2 * k2[i]! + 2 * k3[i]! + k4[i]!);
    }
  }
  return { samples, stable, directFeedthrough: D, converged: stable && samples.every((s) => Number.isFinite(s.value)) };
}
export interface MarginResult { gainCrossovers: number[]; phaseCrossovers: number[]; phaseMargins: number[]; gainMarginsDb: number[] }
export function margins(tf: TransferFunction, points: BodePoint[] = bode(tf, 1200)): MarginResult {
  const gainCrossovers: number[] = [], phaseCrossovers: number[] = [], phaseMargins: number[] = [], gainMarginsDb: number[] = [];
  const crossing = (a: number, b: number, target = 0): number | undefined => {
    const left = a - target, right = b - target;
    // Own a sample exactly on a crossing by the segment ending there. This prevents
    // a crossover at a sampled point from being counted again by the next segment.
    if (left === 0 || (left < 0 && right < 0) || (left > 0 && right > 0) || left === right) return undefined;
    return Math.max(0, Math.min(1, -left / (right - left)));
  };
  const refine = (a: BodePoint, b: BodePoint, target: number, fraction: number,
                  valueAt: (omega: number, expected: number) => number): { omega: number; value: number } => {
    if (fraction === 1) return { omega: b.omega, value: target };
    let lo = Math.log(a.omega), hi = Math.log(b.omega);
    let flo = a.magnitudeDb, fhi = b.magnitudeDb;
    // Phase crossings use the unwrapped phase as the scalar function instead of dB.
    if (valueAt === phaseAt) { flo = a.phaseDeg; fhi = b.phaseDeg; }
    const interpolate = (x: number) => a.magnitudeDb + x * (b.magnitudeDb - a.magnitudeDb);
    let initial = lo + fraction * (hi - lo);
    if (lo >= hi || flo === fhi || (flo - target) * (fhi - target) > 0) {
      const omega = Math.exp(initial);
      return { omega, value: valueAt(omega, valueAt === phaseAt ? a.phaseDeg + fraction * (b.phaseDeg - a.phaseDeg) : interpolate(fraction)) };
    }
    for (let iteration = 0; iteration < 48; iteration++) {
      const mid = (lo + hi) / 2, omega = Math.exp(mid);
      const expected = valueAt === phaseAt ? a.phaseDeg + (mid - Math.log(a.omega)) / (Math.log(b.omega) - Math.log(a.omega)) * (b.phaseDeg - a.phaseDeg) : 0;
      const value = valueAt(omega, expected);
      if ((flo - target) * (value - target) <= 0) { hi = mid; fhi = value; }
      else { lo = mid; flo = value; }
    }
    initial = (lo + hi) / 2;
    const omega = Math.exp(initial);
    const expected = valueAt === phaseAt ? a.phaseDeg + (initial - Math.log(a.omega)) / (Math.log(b.omega) - Math.log(a.omega)) * (b.phaseDeg - a.phaseDeg) : 0;
    return { omega, value: valueAt(omega, expected) };
  };
  const magnitudeAt = (omega: number) => 20 * Math.log10(Math.max(abs(frequencyResponse(tf, omega)), 1e-150));
  const phaseAt = (omega: number, expected: number) => {
    const response = frequencyResponse(tf, omega);
    const wrapped = Math.atan2(response.im, response.re) * 180 / Math.PI;
    return wrapped + 360 * Math.round((expected - wrapped) / 360);
  };
  for (let i = 1; i < points.length; i++) {
    const a = points[i - 1]!, b = points[i]!;
    const gainFraction = crossing(a.magnitudeDb, b.magnitudeDb);
    if (gainFraction !== undefined) {
      const root = refine(a, b, 0, gainFraction, (omega) => magnitudeAt(omega));
      const expectedPhase = a.phaseDeg + gainFraction * (b.phaseDeg - a.phaseDeg);
      gainCrossovers.push(root.omega);
      phaseMargins.push(180 + phaseAt(root.omega, expectedPhase));
    }
    const phaseLow = Math.min(a.phaseDeg, b.phaseDeg), phaseHigh = Math.max(a.phaseDeg, b.phaseDeg);
    // Targets are odd multiples of 180°: ..., -540°, -180°, 180°, ...
    // Anchor the sequence at the first target at or above the segment minimum.
    const firstTarget = Math.ceil((phaseLow - 180) / 360) * 360 + 180;
    for (let target = firstTarget; target <= phaseHigh; target += 360) {
      if (target < phaseLow) continue;
      const phaseFraction = crossing(a.phaseDeg, b.phaseDeg, target);
      if (phaseFraction === undefined) continue;
      const root = refine(a, b, target, phaseFraction, phaseAt);
      phaseCrossovers.push(root.omega);
      gainMarginsDb.push(-magnitudeAt(root.omega));
    }
  }
  return { gainCrossovers, phaseCrossovers, phaseMargins, gainMarginsDb };
}
export function stepMetrics(samples: readonly TimeSample[], expectedFinal?: number, options: { settlingPercent?: number; riseStartPercent?: number; riseEndPercent?: number } = {}): { finalValue?: number; overshootPercent?: number; undershootPercent?: number; settlingTime?: number; riseTime?: number; peakTime?: number; status: "settled" | "not-settled" | "undefined" } {
  if (samples.length < 2 || samples.some((s) => !Number.isFinite(s.value))) return { status: "undefined" };
  const initialValue=samples[0]!.value,finalValue = Number.isFinite(expectedFinal) ? expectedFinal! : samples[samples.length - 1]!.value,change=finalValue-initialValue,direction=change<0?-1:1,amplitude=Math.abs(change);
  const peakIndex = samples.reduce((best, sample, index) => (sample.value-initialValue)*direction > (samples[best]!.value-initialValue)*direction ? index : best, 0);
  const peak = samples[peakIndex]!.value, band = Math.max(amplitude * (options.settlingPercent ?? 2) / 100, 1e-9);
  let lastOutside = -1; samples.forEach((s, i) => { if (Math.abs(s.value - finalValue) > band) lastOutside = i; });
  const settled = lastOutside < samples.length - 1;
  const crossing = (fraction: number) => {
    const target=initialValue+change*fraction,index = samples.findIndex((sample) => (sample.value-target)*direction >= 0);
    return index >= 0 ? samples[index]!.time : undefined;
  };
  const t10 = crossing((options.riseStartPercent ?? 10) / 100), t90 = crossing((options.riseEndPercent ?? 90) / 100);
  const undershootPercent=amplitude>1e-12?Math.max(0,...samples.map(sample=>-direction*(sample.value-initialValue)))/amplitude*100:undefined;
  return { finalValue, overshootPercent: amplitude > 1e-12 ? Math.max(0, direction*(peak-finalValue)) / amplitude * 100 : undefined, undershootPercent,
    settlingTime: settled ? samples[Math.max(0, lastOutside + 1)]!.time : undefined, riseTime: t10 !== undefined && t90 !== undefined ? t90 - t10 : undefined,
    peakTime: samples[peakIndex]!.time, status: settled ? "settled" : "not-settled" };
}
