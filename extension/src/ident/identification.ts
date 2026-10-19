/** Núcleo SISO de identificação: importação explícita, ARX por QR e validação livre. */
import type { IdentDataset, IdentModel, IdentProject } from "../ui/webview/ident/types";
export type { IdentDataset, IdentModel, IdentProject } from "../ui/webview/ident/types";
export const emptyIdentProject = (): IdentProject => ({ version: 1, datasets: [], models: [] });
export function validateIdentProject(value: unknown): IdentProject | undefined {
  if(!value||typeof value!=="object"||Array.isArray(value))return undefined;
  const p=value as Record<string,unknown>;
  if(p.version!==1||!Array.isArray(p.datasets)||!Array.isArray(p.models)||p.datasets.length>100||p.models.length>100)return undefined;
  const numeric=(v:unknown):v is number[]=>Array.isArray(v)&&v.every(x=>typeof x==="number"&&Number.isFinite(x));
  const validStateSpace=(v:unknown):boolean=>{if(!v||typeof v!=="object")return false;const s=v as Record<string,unknown>,a=s.A;if(!Array.isArray(a)||a.length<1||a.length>8)return false;return a.every(row=>numeric(row)&&row.length===a.length)&&numeric(s.B)&&numeric(s.C)&&s.B.length===a.length&&s.C.length===a.length&&typeof s.D==="number"&&Number.isFinite(s.D)&&(s.x0===undefined||numeric(s.x0)&&s.x0.length===a.length);};
  const datasets:IdentDataset[]=[];let dataPoints=0;
  for(const raw of p.datasets){
    if(!raw||typeof raw!=="object")return undefined;const d=raw as Record<string,unknown>;
    if(![d.id,d.name,d.source,d.inputName,d.outputName,d.inputUnit,d.outputUnit].every(v=>typeof v==="string")||!numeric(d.time)||!numeric(d.input)||!numeric(d.output)||d.time.length<3||d.time.length>2_000_000||d.input.length!==d.time.length||d.output.length!==d.time.length)return undefined;
    if(d.sampleTime!==undefined&&!(typeof d.sampleTime==="number"&&Number.isFinite(d.sampleTime)&&d.sampleTime>0))return undefined;
    for(let i=1;i<d.time.length;i++)if(d.time[i]!<=d.time[i-1]!)return undefined;
    if(typeof d.sampleTime==="number"){for(let i=1;i<d.time.length;i++)if(Math.abs((d.time[i]!-d.time[i-1]!)-d.sampleTime)>Math.max(1e-10,Math.abs(d.sampleTime)*1e-4))return undefined;}
    if(!Array.isArray(d.history)||d.history.length>100)return undefined;
    dataPoints+=3*d.time.length;if(dataPoints>10_000_000)return undefined;datasets.push(d as unknown as IdentDataset);
  }
  const models:IdentModel[]=[];let modelPoints=0;
  for(const raw of p.models){
    if(!raw||typeof raw!=="object")return undefined;const m=raw as Record<string,unknown>;
    if(String(m.family)!=="Função de transferência"&&!["ARX","ARMAX","OE","Box-Jenkins","Processo 1ª ordem","Processo 2ª ordem","Integrador","Espaço de estados (Ho-Kalman)"].includes(String(m.family))||!( ["continuous","discrete"].includes(String(m.domain)))||![m.sampleTime,m.delay,m.fit,m.rmse,m.mae,m.aic,m.bic].every(v=>typeof v==="number"&&Number.isFinite(v))||!["one-step","simulation"].includes(String(m.predictionKind))||typeof m.evaluationDatasetId!=="string"||!numeric(m.numerator)||!numeric(m.denominator)||!numeric(m.residuals)||!numeric(m.predicted)||m.predicted.length>2_000_000||!numeric(m.residualAutocorrelation)||!numeric(m.inputResidualCorrelation)||typeof m.method!=="string"||!Array.isArray(m.diagnostics)||!m.diagnostics.every(v=>typeof v==="string")||(m.noiseNumerator!==undefined&&!numeric(m.noiseNumerator))||(m.noiseDenominator!==undefined&&!numeric(m.noiseDenominator))||(m.stateSpace!==undefined&&!validStateSpace(m.stateSpace)))return undefined;
    modelPoints+=2*m.predicted.length;if(modelPoints>10_000_000)return undefined;models.push(m as unknown as IdentModel);
  }
  const ids=new Set(datasets.map(d=>d.id)),modelIds=new Set(models.map(m=>m.id));if(ids.size!==datasets.length||modelIds.size!==models.length||models.some(m=>!ids.has(m.evaluationDatasetId)))return undefined;
  return{version:1,datasets,models,...(typeof p.estimationDatasetId==="string"&&ids.has(p.estimationDatasetId)?{estimationDatasetId:p.estimationDatasetId}:{}),...(typeof p.validationDatasetId==="string"&&ids.has(p.validationDatasetId)?{validationDatasetId:p.validationDatasetId}:{})};
}
export function parseIdentTable(text: string, options: { delimiter?: string; decimalComma?: boolean; hasHeader?: boolean; inputColumn?: number; outputColumn?: number; timeColumn?: number | null; sampleTime?: number; name?: string; inputUnit?: string; outputUnit?: string } = {}): { dataset: IdentDataset; columns: string[]; preview: string[][]; warnings: string[] } {
  if (text.length > 50_000_000) throw new Error("Arquivo excede o limite de importação de 50 MB.");
  if (text.trimStart().startsWith("{")) {
    let raw: Record<string, unknown>; try { raw=JSON.parse(text) as Record<string,unknown>; } catch { throw new Error("JSON inválido."); }
    const input=raw.input,output=raw.output,time=raw.time;
    if(!Array.isArray(input)||!Array.isArray(output)||input.length!==output.length||input.length<3||input.length>2_000_000||input.some(v=>typeof v!=="number"||!Number.isFinite(v))||output.some(v=>typeof v!=="number"||!Number.isFinite(v))) throw new Error("JSON deve conter arrays SISO `input` e `output` finitos e de mesmo tamanho (mínimo 3 amostras).");
    const sampleTime=typeof raw.sampleTime==="number"&&Number.isFinite(raw.sampleTime)&&raw.sampleTime>0?raw.sampleTime:options.sampleTime;
    if(time!==undefined&&(!Array.isArray(time)||time.length!==input.length||time.some(v=>typeof v!=="number"||!Number.isFinite(v))))throw new Error("O array JSON `time` deve ter uma amostra válida para cada valor de entrada/saída.");
    if(time===undefined&&!sampleTime)throw new Error("Informe `sampleTime` no JSON ou na importação.");
    const times=time as number[]|undefined;const t=times??input.map((_,i)=>i*sampleTime!);
    for(let i=1;i<t.length;i++)if(t[i]!<=t[i-1]!)throw new Error(`Tempo não crescente ou repetido no índice ${i}.`);
    const intervals=t.slice(1).map((v,i)=>v-t[i]!);const dt=median(intervals);const irregular=intervals.some(v=>Math.abs(v-dt)>Math.max(1e-10,Math.abs(dt)*1e-4));
    const data:IdentDataset={id:makeId(),name:typeof raw.name==="string"?raw.name:options.name??"Dados JSON",source:"JSON",time:t,input:input as number[],output:output as number[],...(!irregular?{sampleTime:times?dt:sampleTime}:{}),inputUnit:typeof raw.inputUnit==="string"?raw.inputUnit:options.inputUnit??"",outputUnit:typeof raw.outputUnit==="string"?raw.outputUnit:options.outputUnit??"",inputName:typeof raw.inputName==="string"?raw.inputName:"u",outputName:typeof raw.outputName==="string"?raw.outputName:"y",history:[]};
    return {dataset:data,columns:["time","input","output"],preview:t.slice(0,8).map((v,i)=>[String(v),String(input[i]),String(output[i])]),warnings:[...(irregular?["Amostragem irregular detectada; reamostragem explícita necessária para famílias uniformes."]:[]),...(raw.sampleTime===undefined&&times===undefined?["Período de amostragem foi informado na importação."]:[])]};
  }
  const lines = text.replace(/^\uFEFF/, "").split(/\r?\n/);
  while(lines.length&&lines[lines.length-1]!.trim()==="")lines.pop();
  const emptyLine=lines.findIndex(line=>line.trim()==="");if(emptyLine>=0)throw new Error(`Linha vazia no índice ${emptyLine+1}; nenhuma amostra foi removida.`);
  if (lines.length < 4) throw new Error("São necessárias pelo menos três amostras numéricas.");
  const delimiter = options.delimiter ?? (lines[0]!.includes("\t") ? "\t" : lines[0]!.includes(";") ? ";" : ",");
  const rows = lines.map(line => splitDelimitedLine(line,delimiter));
  const hasHeader = options.hasHeader ?? rows[0]!.some(cell => !Number.isFinite(parseIdentNumber(cell, options.decimalComma ?? delimiter === ";")));
  const columns = hasHeader ? rows.shift()! : rows[0]!.map((_, i) => `Coluna ${i + 1}`);
  if (rows.some(row => row.length !== columns.length)) throw new Error("Número de colunas inconsistente; nenhuma linha foi descartada.");
  const inferredTime=options.timeColumn===null?undefined:options.timeColumn??(/^(t|time|tempo)(\b|\s|\()/i.test(columns[0]??"")?0:undefined);
  const timeColumn=inferredTime;
  const inputColumn = options.inputColumn ?? (timeColumn===0?1:0);
  const outputColumn = options.outputColumn ?? (timeColumn===0?2:inputColumn===0?1:inputColumn+1);
  for (const index of [inputColumn, outputColumn, ...(timeColumn === undefined ? [] : [timeColumn])]) if (!Number.isInteger(index) || index < 0 || index >= columns.length) throw new Error("Seleção de coluna fora do intervalo.");
  if (inputColumn === outputColumn || inputColumn === timeColumn || outputColumn === timeColumn) throw new Error("Tempo, entrada e saída precisam usar colunas distintas.");
  const time: number[] = [], input: number[] = [], output: number[] = [];
  for (let rowIndex = 0; rowIndex < rows.length; rowIndex++) {
    const row = rows[rowIndex]!;
    const u = parseIdentNumber(row[inputColumn]!, options.decimalComma ?? delimiter === ";");
    const y = parseIdentNumber(row[outputColumn]!, options.decimalComma ?? delimiter === ";");
    const t = timeColumn === undefined ? rowIndex * (options.sampleTime ?? 1) : parseIdentNumber(row[timeColumn]!, options.decimalComma ?? delimiter === ";");
    if (![u, y, t].every(Number.isFinite)) throw new Error(`Amostra inválida na linha ${rowIndex + (hasHeader ? 2 : 1)}; corrija valores vazios ou não finitos. Nenhuma amostra foi removida.`);
    if (time.length && t <= time[time.length - 1]!) throw new Error(`Tempo não crescente ou repetido na linha ${rowIndex + (hasHeader ? 2 : 1)}.`);
    time.push(t); input.push(u); output.push(y);
  }
  if (time.length < 3) throw new Error("São necessárias pelo menos três amostras numéricas.");
  const intervals = time.slice(1).map((t, i) => t - time[i]!);
  const sampleTime = median(intervals);
  const irregular = intervals.some(dt => Math.abs(dt - sampleTime) > Math.max(1e-10, Math.abs(sampleTime) * 1e-4));
  return { dataset: { id: makeId(), name: options.name ?? "Dados importados", source: "Arquivo", time, input, output,
    ...(timeColumn === undefined ? { sampleTime: options.sampleTime ?? 1 } : irregular ? {} : { sampleTime }),
    inputUnit: options.inputUnit ?? "", outputUnit: options.outputUnit ?? "", inputName: columns[inputColumn]!, outputName: columns[outputColumn]!, history: [] },
    columns, preview: rows.slice(0, 8), warnings: [...(irregular ? ["Amostragem irregular detectada; famílias discretas uniformemente amostradas ficam bloqueadas até reamostragem explícita."] : []), ...(timeColumn === undefined ? ["Tempo criado com o período informado; verifique a unidade física."] : [])] };
}
function parseIdentNumber(raw: string, decimalComma: boolean): number { const normalized = decimalComma ? raw.replace(",", ".") : raw; return normalized.trim() === "" ? NaN : Number(normalized); }
function splitDelimitedLine(line:string,delimiter:string):string[]{const cells:string[]=[];let value="",quoted=false;for(let i=0;i<line.length;i++){const c=line[i]!;if(c==='"'){if(quoted&&line[i+1]==='"'){value+='"';i++;}else quoted=!quoted;}else if(c===delimiter&&!quoted){cells.push(value.trim());value="";}else value+=c;}if(quoted)throw new Error("Campo entre aspas não foi fechado; quebras de linha dentro de campos não são suportadas.");cells.push(value.trim());return cells;}
const median = (values: number[]) => { const sorted = [...values].sort((a,b)=>a-b); return sorted[Math.floor(sorted.length/2)]!; };
function requireCompatibleValidation(data:IdentDataset,validation?:IdentDataset):void{if(!validation)return;if(!validation.sampleTime)throw new Error("Dados de validação irregulares não podem ser usados silenciosamente; reamostre explicitamente.");if(Math.abs(validation.sampleTime-data.sampleTime!)>Math.max(1e-12,Math.abs(data.sampleTime!)*1e-9))throw new Error("Ts da validação difere do Ts de estimação; reamostre explicitamente para a mesma grade temporal.");}
const makeId = () => `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 9)}`;

/** Mínimos quadrados usando QR de Gram-Schmidt modificado com reortogonalização; evita X'X. */
export function estimateArx(data: IdentDataset, na = 2, nb = 2, nk = 1, validation?: IdentDataset): IdentModel {
  const n = data.input.length;
  if (!data.sampleTime || !Number.isFinite(data.sampleTime)) throw new Error("ARX requer amostragem uniforme; reamostre explicitamente os dados.");
  requireCompatibleValidation(data,validation);
  if (![na, nb, nk].every(Number.isInteger) || na < 1 || nb < 1 || nk < 0 || na > 20 || nb > 20 || nk > 200) throw new Error("Ordens ARX inválidas.");
  const start = Math.max(na, nk + nb - 1), rows: number[][] = [], rhs: number[] = [];
  for (let k = start; k < n; k++) {
    const row: number[] = [];
    for (let i = 1; i <= na; i++) row.push(-data.output[k-i]!);
    for (let j = 0; j < nb; j++) row.push(data.input[k-nk-j]!);
    rows.push(row); rhs.push(data.output[k]!);
  }
  const theta = solveQr(rows, rhs);
  const validationData = validation?.sampleTime ? validation : data;
  const predicted = simulateArx(theta.slice(0,na), theta.slice(na), nk, validationData.input, validationData.output);
  const offset = validationData === data ? start : 0;
  const residuals = validationData.output.slice(offset).map((y,i)=>y-predicted[offset+i]!);
  const metrics = modelMetrics(validationData.output.slice(offset), predicted.slice(offset), theta.length);
  const diagnostics: string[] = [];
  if (variance(data.input) < 1e-14) diagnostics.push("Entrada praticamente constante: excitação insuficiente para identificar a dinâmica.");
  if (variance(data.output) < 1e-14) diagnostics.push("Saída praticamente constante.");
  if (rows.length <= theta.length) diagnostics.push("Poucos graus de liberdade residuais.");
  if (validation && validation.id !== data.id) diagnostics.push("Métricas calculadas em experimento de validação independente.");
  else diagnostics.push("Sem dados independentes: ajuste em estimação não demonstra generalização.");
  return { id: makeId(), name: `ARX(${na},${nb},${nk})`, family: "ARX", domain: "discrete", sampleTime: data.sampleTime,
    numerator: [...Array(nk).fill(0) as number[], ...theta.slice(na)], denominator: [1, ...theta.slice(0,na)], delay: nk,
    parameters: { na, nb, nk, ...Object.fromEntries(theta.map((v,i)=>[`theta${i+1}`,v])) }, ...metrics, residuals, predicted,
    ...residualChecks(validationData.input.slice(offset),residuals),predictionKind:"one-step",evaluationDatasetId:validationData.id,
    method: "ARX por mínimos quadrados via QR reortogonalizado", diagnostics };
}
export type PolynomialFamily="ARMAX"|"OE"|"Box-Jenkins";
export function estimatePolynomial(data:IdentDataset,family:PolynomialFamily,orders:{na?:number;nb:number;nk:number;nc?:number;nd?:number;nf?:number},validation?:IdentDataset):IdentModel{
  if(!data.sampleTime)throw new Error(`${family} requer amostragem uniforme.`);
  requireCompatibleValidation(data,validation);
  const na=family==="OE"||family==="Box-Jenkins"?0:(orders.na??2),nb=orders.nb,nk=orders.nk,nc=family==="ARMAX"||family==="Box-Jenkins"?(orders.nc??1):0,nd=family==="Box-Jenkins"?(orders.nd??1):0,nf=family==="OE"||family==="Box-Jenkins"?(orders.nf??1):0;
  const dims={na,nb,nk,nc,nd,nf};if(Object.values(dims).some(v=>!Number.isInteger(v)||v<0)||nb<1||nb>10||na>10||nc>10||nd>10||nf>10||nk>100)throw new Error("Ordens inválidas (ordens até 10; nk até 100).");
  const start=Math.max(na,nk+nb-1);if(data.input.length-start<Math.max(na+nb+nc+nd+nf+2,10))throw new Error("Dados insuficientes para as ordens escolhidas.");
  const estimate=estimateArx(data,Math.max(1,na||nf||1),nb,nk);const theta:number[]=[];
  if(family==="ARMAX"){theta.push(...estimate.denominator.slice(1,na+1),...estimate.numerator.slice(nk,nk+nb),...Array(nc).fill(0));}
  else if(family==="OE"){theta.push(...estimate.numerator.slice(nk,nk+nb),...estimate.denominator.slice(1,nf+1));}
  else {theta.push(...estimate.numerator.slice(nk,nk+nb),...estimate.denominator.slice(1,nf+1),...Array(nc+nd).fill(0));}
  const objective=(params:number[],d:IdentDataset)=>polynomialPrediction(d,family,dims,params).residuals;
  let lambda=1e-2,converged=false,cost=Infinity,iterations=0;
  const sourceResidual=objective(theta,data);cost=dot(sourceResidual,sourceResidual);
  for(let iter=0;iter<35;iter++){
    iterations=iter+1;const jacobian=theta.map((value,j)=>{const step=1e-5*(Math.abs(value)+1);const plus=[...theta],minus=[...theta];plus[j]=value+step;minus[j]=value-step;const rp=objective(plus,data),rm=objective(minus,data);return rp.map((v,i)=>(v-rm[i]!)/(2*step));});
    const m=sourceResidual.length,p=theta.length,augmented=Array.from({length:m+p},(_,row)=>row<m?jacobian.map(col=>col[row]!):Array.from({length:p},(_,j)=>j===row-m?Math.sqrt(lambda):0));
    const rhs=[...sourceResidual.map(v=>-v),...Array(p).fill(0)];let step:number[];
    try{step=solveQr(augmented,rhs);}catch{lambda*=10;if(lambda>1e8)break;continue;}
    const candidate=theta.map((v,i)=>Math.max(-100,Math.min(100,v+step[i]!)));const nextResidual=objective(candidate,data),nextCost=dot(nextResidual,nextResidual);
    if(Number.isFinite(nextCost)&&nextCost<cost){const improvement=cost-nextCost;for(let i=0;i<theta.length;i++)theta[i]=candidate[i]!;sourceResidual.splice(0,sourceResidual.length,...nextResidual);cost=nextCost;lambda=Math.max(1e-9,lambda/3);if(improvement<=1e-9*Math.max(1,cost)||Math.sqrt(dot(step,step))<1e-7){converged=true;break;}}
    else {lambda*=10;if(lambda>1e8)break;}
  }
  const target=validation?.sampleTime?validation:data;const result=polynomialPrediction(target,family,dims,theta);const offset=family==="ARMAX"?Math.max(na,nk+nb-1):Math.max(nf,nk+nb-1);const actual=target.output.slice(offset),predicted=result.predicted.slice(offset),residuals=result.residuals.slice(offset);const metrics=modelMetrics(actual,predicted,theta.length);
  // The plant model is represented separately from the noise model. For ARMAX the dynamic denominator is A; OE/BJ use F.
  let numerator:number[],denominator:number[];
  if(family==="ARMAX"){const plant=polynomialPrediction(data,family,dims,theta).plant; numerator=[...Array(nk).fill(0),...plant.b];denominator=[1,...plant.a];}
  else {const plant=polynomialPrediction(data,family,dims,theta).plant;numerator=[...Array(nk).fill(0),...plant.b];denominator=[1,...plant.f];}
  const diagnostics=[...(converged?[`Convergência em ${iterations} iterações.`]:[`Otimização iterativa parou após ${iterations} iterações sem critério estrito de convergência.`]),"Coeficientes não foram restringidos à estabilidade; confira os polos antes de usar o modelo.",...(validation&&validation.id!==data.id?["Métricas em experimento de validação independente."]:["Sem validação independente; métricas de estimação não demonstram generalização."]),...(variance(data.input)<1e-14?["Entrada praticamente constante: parâmetros podem não ser identificáveis."]:[])];
  return{id:makeId(),name:`${family}(${na},${nb},${nk}${family==="Box-Jenkins"?`,${nf},${nc},${nd}`:family==="OE"?`,${nf}`:`,${nc}`})`,family,domain:"discrete",sampleTime:data.sampleTime,numerator,denominator,delay:nk,parameters:{...dims,iterations,cost},...metrics,residuals,predicted:result.predicted,...residualChecks(target.input.slice(offset),residuals),predictionKind:family==="ARMAX"?"one-step":"simulation",evaluationDatasetId:target.id,noiseNumerator:[1,...result.noise.c],noiseDenominator:[1,...result.noise.d],method:`Predição de erro com Gauss-Newton amortecido (${family}; dinâmica e ruído separados)`,diagnostics};
}
function polynomialPrediction(data:IdentDataset,family:PolynomialFamily,d:{na:number;nb:number;nk:number;nc:number;nd:number;nf:number},p:number[]):{predicted:number[];residuals:number[];plant:{a:number[];b:number[];f:number[]};noise:{c:number[];d:number[]}}{
  let k=0;const take=(n:number)=>p.slice(k,k+=n);const a=family==="ARMAX"?take(d.na):[];const b=take(d.nb);const f=family==="OE"||family==="Box-Jenkins"?take(d.nf):[];const c=family==="ARMAX"||family==="Box-Jenkins"?take(d.nc):[];const noiseD=family==="Box-Jenkins"?take(d.nd):[];
  const yhat=Array(data.input.length).fill(0) as number[],innovation=Array(data.input.length).fill(0) as number[],plantError=Array(data.input.length).fill(0) as number[];
  for(let t=0;t<yhat.length;t++){
    let free=0;for(let i=1;i<=f.length;i++)if(t-i>=0)free-=f[i-1]!*yhat[t-i]!;for(let j=0;j<b.length;j++)if(t-d.nk-j>=0)free+=b[j]!*data.input[t-d.nk-j]!;
    if(family==="ARMAX"){
      let one=free;for(let i=1;i<=a.length;i++)if(t-i>=0)one-=a[i-1]!*data.output[t-i]!;for(let i=1;i<=c.length;i++)if(t-i>=0)one+=c[i-1]!*innovation[t-i]!;
      innovation[t]=data.output[t]!-one;yhat[t]=one;
    }else if(family==="Box-Jenkins"){
      const z=data.output[t]!-free;let e=z;for(let i=1;i<=d.nd;i++)if(t-i>=0)e+=noiseD[i-1]!*plantError[t-i]!;for(let i=1;i<=d.nc;i++)if(t-i>=0)e-=c[i-1]!*innovation[t-i]!;plantError[t]=z;
      innovation[t]=e;yhat[t]=free;
    }else {yhat[t]=free;innovation[t]=data.output[t]!-free;}
    if(!Number.isFinite(yhat[t]!)||Math.abs(yhat[t]!)>1e100||!Number.isFinite(innovation[t]!))return{predicted:yhat.map(v=>Number.isFinite(v)?v:0),residuals:Array(yhat.length).fill(1e50),plant:{a,b,f},noise:{c,d:noiseD}};
  }
  return{predicted:yhat,residuals:innovation,plant:{a,b,f},noise:{c,d:noiseD}};
}
/** Estima Markov parameters por FIR-QR e realiza o sistema com Ho-Kalman (sem converter ARX). */
export function estimateHoKalman(data:IdentDataset,order=2,validation?:IdentDataset,targetDomain:"discrete"|"continuous"="discrete"):IdentModel{
  if(!data.sampleTime)throw new Error("Identificação em espaço de estados Ho-Kalman requer amostragem uniforme.");
  requireCompatibleValidation(data,validation);
  if(!Number.isInteger(order)||order<1||order>8)throw new Error("A ordem de estado deve estar entre 1 e 8.");
  const n=data.input.length,horizon=Math.min(32,Math.floor(n/4));if(n<40||horizon<2*order+3)throw new Error("Dados insuficientes para FIR e blocos de Hankel da ordem solicitada.");
  const start=horizon-1,regression:number[][]=[],rhs:number[]=[];
  for(let k=start;k<n;k++){const row:number[]=[];for(let j=0;j<horizon;j++)row.push(data.input[k-j]!);regression.push(row);rhs.push(data.output[k]!);}
  const markov=solveQr(regression,rhs),block=Math.min(12,Math.floor((horizon-1)/2));if(block<order)throw new Error("Blocos de Hankel pequenos demais para a ordem escolhida.");
  const h0=Array.from({length:block},(_,i)=>Array.from({length:block},(_,j)=>markov[i+j+1]!));
  const h1=Array.from({length:block},(_,i)=>Array.from({length:block},(_,j)=>markov[i+j+2]!));
  const svd=oneSidedJacobi(h0),threshold=Math.max(1e-10,svd.singular[0]!*1e-8);if(svd.singular[order-1]!<=threshold)throw new Error("Hankel não tem posto suficiente para a ordem escolhida; reduza a ordem ou melhore a excitação.");
  const A=Array.from({length:order},(_,i)=>Array.from({length:order},(_,j)=>{
    let value=0;for(let r=0;r<block;r++)for(let c=0;c<block;c++)value+=svd.left[r]![i]!*h1[r]![c]!*svd.right[c]![j]!;
    return value/Math.sqrt(svd.singular[i]!*svd.singular[j]!);
  }));
  const B=Array.from({length:order},(_,i)=>Math.sqrt(svd.singular[i]!)*svd.right[0]![i]!);
  const C=Array.from({length:order},(_,i)=>Math.sqrt(svd.singular[i]!)*svd.left[0]![i]!);const D=markov[0]!;
  const target=validation?.sampleTime?validation:data;const predicted=simulateStateSpace(A,B,C,D,target.input);const residuals=target.output.map((value,i)=>value-predicted[i]!);const metrics=modelMetrics(target.output,predicted,order*order+2*order+1);
  const stateSpace=targetDomain==="continuous"?discreteZohToContinuous({A,B,C,D},data.sampleTime):{A,B,C,D};
  return{id:makeId(),name:`Espaço de estados Ho-Kalman (${order} estados)`,family:"Espaço de estados (Ho-Kalman)",domain:targetDomain,sampleTime:data.sampleTime,numerator:[],denominator:[],delay:0,stateSpace,parameters:{order,firHorizon:horizon,blockRows:block,...Object.fromEntries(markov.map((v,i)=>[`h${i}`,v]))},...metrics,residuals,predicted,...residualChecks(target.input,residuals),predictionKind:"simulation",evaluationDatasetId:target.id,method:"FIR estimado por mínimos quadrados QR + realização balanceada Ho-Kalman dos parâmetros de Markov",diagnostics:["Identificação FIR seguida por realização Ho-Kalman; não é conversão de ARX nem N4SID.",...(targetDomain==="continuous"?["A/B convertidos da realização discreta sob hipótese de retenção ZOH e logaritmo matricial principal real."]:[]),"Inicialização de estado zero na simulação livre.","Estabilidade não imposta; analise os autovalores de A.",...(validation&&validation.id!==data.id?["Avaliado em experimento independente."]: ["Sem validação independente."]),...(variance(data.input)<1e-14?["Entrada praticamente constante: parâmetros não identificáveis."]:[])]};
}
function discreteZohToContinuous(model:{A:number[][];B:number[];C:number[];D:number},sampleTime:number):{A:number[][];B:number[];C:number[];D:number}{
  const logA=matrixLogReal(model.A),Ac=matrixScale(logA,1/sampleTime),difference=matrixAdd(model.A,matrixIdentity(model.A.length),-1),inverse=matrixInverse(difference),Bc=matrixVector(inverse,matrixVector(Ac,model.B));
  if([...Ac.flat(),...Bc].some(v=>!Number.isFinite(v)||Math.abs(v)>1e12))throw new Error("Conversão para espaço contínuo excede a faixa numérica; mantenha domínio discreto.");
  return{A:Ac,B:Bc,C:model.C,D:model.D};
}
function matrixIdentity(n:number):number[][]{return Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>i===j?1:0));}
function matrixAdd(a:number[][],b:number[][],scaleB=1):number[][]{return a.map((row,i)=>row.map((v,j)=>v+scaleB*b[i]![j]!));}
function matrixScale(a:number[][],scale:number):number[][]{return a.map(row=>row.map(v=>v*scale));}
function matrixMul(a:number[][],b:number[][]):number[][]{return a.map(row=>b[0]!.map((_,j)=>row.reduce((s,v,k)=>s+v*b[k]![j]!,0)));}
function matrixVector(a:number[][],v:number[]):number[]{return a.map(row=>row.reduce((s,x,i)=>s+x*v[i]!,0));}
function matrixInverse(a:number[][]):number[][]{const n=a.length,m=a.map((row,i)=>[...row,...matrixIdentity(n)[i]!]);for(let c=0;c<n;c++){let p=c;for(let r=c+1;r<n;r++)if(Math.abs(m[r]![c]!)>Math.abs(m[p]![c]!))p=r;if(Math.abs(m[p]![c]!)<1e-12)throw new Error("Conversão ZOH singular; não é possível identificar o domínio contínuo com esta realização.");[m[c],m[p]]=[m[p]!,m[c]!];const d=m[c]![c]!;m[c]=m[c]!.map(v=>v/d);for(let r=0;r<n;r++)if(r!==c){const f=m[r]![c]!;m[r]=m[r]!.map((v,j)=>v-f*m[c]![j]!);}}return m.map(row=>row.slice(n));}
function matrixNorm(a:number[][]):number{return Math.max(...a.map(row=>row.reduce((s,v)=>s+Math.abs(v),0)));}
function matrixSqrt(a:number[][]):number[][]{let y=a.map(row=>[...row]),z=matrixIdentity(a.length);for(let i=0;i<40;i++){const yn=matrixScale(matrixAdd(y,matrixInverse(z)),.5),zn=matrixScale(matrixAdd(z,matrixInverse(y)),.5);const error=matrixNorm(matrixAdd(matrixMul(yn,yn),a,-1));y=yn;z=zn;if(error<1e-11*Math.max(1,matrixNorm(a)))return y;}throw new Error("Logaritmo matricial principal não convergiu para uma realização real; use identificação discreta.");}
function matrixLogReal(a:number[][]):number[][]{let x=a.map(row=>[...row]),s=0;while(matrixNorm(matrixAdd(x,matrixIdentity(x.length),-1))>.45&&s<16){x=matrixSqrt(x);s++;}if(s===16)throw new Error("Logaritmo matricial fora da faixa numérica real; use identificação discreta.");const q=matrixMul(matrixAdd(x,matrixIdentity(x.length),-1),matrixInverse(matrixAdd(x,matrixIdentity(x.length))));let term=q,sum=q;for(let k=3;k<=61;k+=2){term=matrixMul(term,matrixMul(q,q));sum=matrixAdd(sum,matrixScale(term,1/k));}return matrixScale(sum,2**(s+1));}
function simulateStateSpace(A:number[][],B:number[],C:number[],D:number,input:number[],initialState?:number[]):number[]{const state=initialState?[...initialState]:Array(B.length).fill(0) as number[],output:number[]=[];for(const u of input){output.push(C.reduce((s,v,i)=>s+v*state[i]!,D*u));const next=A.map((row,i)=>row.reduce((s,v,j)=>s+v*state[j]!,B[i]!*u));for(let i=0;i<state.length;i++)state[i]=next[i]!;}return output;}
function oneSidedJacobi(matrix:number[][]):{left:number[][];right:number[][];singular:number[]}{
  const rows=matrix.length,cols=matrix[0]!.length,b=matrix.map(row=>[...row]);const v:number[][]=Array.from({length:cols},(_,i)=>Array.from({length:cols},(_,j)=>i===j?1:0));
  for(let sweep=0;sweep<60;sweep++){let changed=false;for(let p=0;p<cols;p++)for(let q=p+1;q<cols;q++){
    let alpha=0,beta=0,gamma=0;for(let r=0;r<rows;r++){alpha+=b[r]![p]!**2;beta+=b[r]![q]!**2;gamma+=b[r]![p]!*b[r]![q]!;}
    if(Math.abs(gamma)<=1e-12*Math.sqrt(alpha*beta))continue;changed=true;const zeta=(beta-alpha)/(2*gamma),t=(zeta===0?1:Math.sign(zeta))/(Math.abs(zeta)+Math.sqrt(1+zeta*zeta)),c=1/Math.sqrt(1+t*t),s=c*t;
    for(let r=0;r<rows;r++){const x=b[r]![p]!,y=b[r]![q]!;b[r]![p]=c*x-s*y;b[r]![q]=s*x+c*y;}
    for(let r=0;r<cols;r++){const x=v[r]![p]!,y=v[r]![q]!;v[r]![p]=c*x-s*y;v[r]![q]=s*x+c*y;}
  }if(!changed)break;}
  const singular=Array.from({length:cols},(_,j)=>Math.sqrt(b.reduce((sum,row)=>sum+row[j]!**2,0))),order=singular.map((value,index)=>({value,index})).sort((a,b)=>b.value-a.value),sorted=order.map(x=>x.index);
  const left=Array.from({length:rows},(_,r)=>Array.from({length:cols},(_,j)=>{const source=sorted[j]!;return singular[source]!>0?b[r]![source]!/singular[source]!:0;})),right=Array.from({length:cols},(_,r)=>Array.from({length:cols},(_,j)=>v[r]![sorted[j]!]!));
  return{left,right,singular:order.map(x=>x.value)};
}
/** FOPDT por busca de perfil: K é resolvido linearmente e tau/atraso são pesquisados. */
export function estimateFopdt(data: IdentDataset, validation?: IdentDataset, maxDelaySamples = 30): IdentModel {
  if (!data.sampleTime || data.input.length < 6) throw new Error("FOPDT requer ao menos seis amostras uniformes.");
  if(!Number.isInteger(maxDelaySamples)||maxDelaySamples<0||maxDelaySamples>2_000)throw new Error("Limite de atraso FOPDT deve ser um inteiro entre 0 e 2.000 amostras.");
  if(validation&&!validation.sampleTime)throw new Error("A validação FOPDT também precisa estar uniformemente amostrada; reamostre explicitamente.");
  if (data.input.length > 50_000) throw new Error("FOPDT limita a estimação a 50 mil amostras para manter a resposta interativa; faça decimação explícita e rastreada.");
  const dt=data.sampleTime, y=data.output, u=data.input, n=y.length, y0=y[0]!, u0=u[0]!;
  let best={cost:Infinity,k:0,tau:dt,delay:0,predicted:[] as number[]};
  const delayLimit=Math.min(maxDelaySamples,Math.floor(n/5));
  const maxExponent=Math.max(-1,Math.log10(Math.max(1,n/3)));
  for(let delay=0;delay<=delayLimit;delay++) for(let g=-2;g<=maxExponent;g+=1) for(let sub=0;sub<4;sub++){
    const tau=dt*10**(g+sub/8), alpha=Math.exp(-dt/tau), z=Array(n).fill(0) as number[];
    for(let i=1;i<n;i++) { const source=i-delay-1; z[i]=alpha*z[i-1]!+(1-alpha)*(source>=0?u[source]!-u0:0); }
    let num=0,den=0;for(let i=2;i<n;i++){num+=z[i]!*(y[i]!-y0);den+=z[i]!**2;}
    if(den<1e-20)continue;const k=num/den,predicted=z.map(v=>y0+k*v);
    const cost=y.slice(2).reduce((s,value,i)=>s+(value-predicted[i+2]!)**2,0);
    if(cost<best.cost)best={cost,k,tau,delay,predicted};
  }
  if(!Number.isFinite(best.cost))throw new Error("Não foi possível estimar FOPDT: entrada sem excitação suficiente.");
  const target=validation?.sampleTime?validation:data, delaySeconds=best.delay*dt, tau=best.tau, alpha=Math.exp(-target.sampleTime!/tau), prediction=Array(target.output.length).fill(target.output[0]!) as number[];
  const targetInput0=target.input[0]!;
  for(let i=1;i<prediction.length;i++){const past=i-best.delay-1;prediction[i]=alpha*prediction[i-1]!+(1-alpha)*(target.output[0]!+best.k*((past>=0?target.input[past]!:targetInput0)-targetInput0));}
  const offset=2, residuals=target.output.slice(offset).map((v,i)=>v-prediction[offset+i]!);
  return {id:makeId(),name:`FOPDT (L=${delaySeconds.toPrecision(3)} s)`,family:"Processo 1ª ordem",domain:"continuous",sampleTime:dt,numerator:[best.k],denominator:[tau,1],delay:delaySeconds,
    parameters:{gain:best.k,timeConstant:tau,delay:delaySeconds,delaySamples:best.delay},...modelMetrics(target.output.slice(offset),prediction.slice(offset),3),residuals,predicted:prediction,
    ...residualChecks(target.input.slice(offset),residuals),predictionKind:"simulation",evaluationDatasetId:target.id,method:"Busca de perfil em atraso discreto e constante de tempo logarítmica; ganho por mínimos quadrados",diagnostics:[...(variance(u)<1e-14?["Entrada praticamente constante: parâmetros não identificáveis."]:[]),...(validation&&validation.id!==data.id?["Métricas em dados independentes."]: ["Sem validação independente; métricas são de estimação."])]};
}
/** Segunda ordem subamortecida/superamortecida, atraso por perfil e ajuste de erro de simulação. */
export function estimateIntegrator(data:IdentDataset,validation?:IdentDataset):IdentModel{
  if(!data.sampleTime||data.input.length<6)throw new Error("A identificação integradora requer ao menos seis amostras uniformes.");if(validation&&!validation.sampleTime)throw new Error("A validação do integrador precisa estar uniformemente amostrada.");
  const integrate=(d:IdentDataset)=>{const integral=Array(d.input.length).fill(0) as number[];for(let k=1;k<integral.length;k++)integral[k]=integral[k-1]!+d.sampleTime!*(d.input[k-1]!-d.input[0]!);return integral;};
  const x=integrate(data),y0=data.output[0]!;let numerator=0,denominator=0;for(let i=0;i<x.length;i++){numerator+=x[i]!*(data.output[i]!-y0);denominator+=x[i]!**2;}if(denominator<1e-20)throw new Error("Entrada sem variação integrada suficiente para identificar o ganho integrador.");const gain=numerator/denominator;
  const target=validation??data,integral=integrate(target),predicted=integral.map(v=>target.output[0]!+gain*v),residuals=target.output.map((v,i)=>v-predicted[i]!),metrics=modelMetrics(target.output,predicted,1),stateSpace={A:[[0]],B:[1],C:[gain],D:0};
  return{id:makeId(),name:`Integrador K=${gain.toPrecision(4)}`,family:"Integrador",domain:"continuous",sampleTime:data.sampleTime,numerator:[gain],denominator:[1,0],delay:0,parameters:{gain,initialOutput:y0},...metrics,residuals,predicted,...residualChecks(target.input,residuals),stateSpace,predictionKind:"simulation",evaluationDatasetId:target.id,method:"Ganho integrador por mínimos quadrados sobre a integral retangular da entrada; condição inicial y(0) medida",diagnostics:[...(validation&&validation.id!==data.id?["Avaliado em experimento de validação independente."]: ["Sem validação independente."])]};
}
export function estimateSecondOrder(data:IdentDataset,validation?:IdentDataset,maxDelaySamples=20):IdentModel{
  if(!data.sampleTime||data.input.length<12)throw new Error("Processo de 2ª ordem requer ao menos 12 amostras uniformes.");
  if(!Number.isInteger(maxDelaySamples)||maxDelaySamples<0||maxDelaySamples>2_000)throw new Error("Limite de atraso de segunda ordem deve ser um inteiro entre 0 e 2.000 amostras.");
  if(validation&&!validation.sampleTime)throw new Error("A validação de segunda ordem também precisa estar uniformemente amostrada; reamostre explicitamente.");
  if(data.input.length>50_000)throw new Error("Processo de 2ª ordem limita a estimação a 50 mil amostras; faça decimação rastreada.");
  const dt=data.sampleTime,n=data.input.length,delayMax=Math.min(maxDelaySamples,Math.floor(n/6));let best:{cost:number;k:number;wn:number;zeta:number;delay:number;iterations:number;converged:boolean}|undefined;
  const u0=data.input[0]!,y0=data.output[0]!,umean=mean(data.input),ymean=mean(data.output),uvar=variance(data.input),cov=data.input.reduce((sum,u,i)=>sum+(u-umean)*(data.output[i]!-ymean),0)/n,k0=uvar>1e-14?cov/uvar:1;
  const simulate=(k:number,wn:number,zeta:number,delay:number,signal:IdentDataset)=>{
    const output=Array(signal.input.length).fill(signal.output[0]!) as number[],baseU=signal.input[0]!,x=[signal.output[0]!,0];const h=signal.sampleTime!;
    const acceleration=(position:number,velocity:number,u:number)=>-wn*wn*position-2*zeta*wn*velocity+k*wn*wn*(u-baseU);
    for(let i=0;i<output.length;i++){
      output[i]=x[0]!;const source=i-delay,held=source>=0?signal.input[source]!:baseU;
      const f1=x[1]!,g1=acceleration(x[0]!,x[1]!,held),f2=x[1]!+h*g1/2,g2=acceleration(x[0]!+h*f1/2,x[1]!+h*g1/2,held),f3=x[1]!+h*g2/2,g3=acceleration(x[0]!+h*f2/2,x[1]!+h*g2/2,held),f4=x[1]!+h*g3,g4=acceleration(x[0]!+h*f3,x[1]!+h*g3,held);
      x[0]=x[0]!+h*(f1+2*f2+2*f3+f4)/6;x[1]=x[1]!+h*(g1+2*g2+2*g3+g4)/6;
      if(!Number.isFinite(x[0]!)||Math.abs(x[0]!)>1e100)return output.map(()=>Number.MAX_VALUE/1e100);
    }return output;
  };
  for(let delay=0;delay<=delayMax;delay++){
    let theta=[Number.isFinite(k0)&&Math.abs(k0)>1e-5?Math.max(-1e5,Math.min(1e5,k0)):1,Math.log(Math.max(.001,Math.min(1e5,2/dt))),Math.log(.7)],lambda=1e-2,converged=false,iterations=0;
    const residual=(p:number[])=>{const output=simulate(p[0]!,Math.exp(p[1]!),Math.exp(p[2]!),delay,data);return data.output.map((y,i)=>y-output[i]!);};let r=residual(theta),cost=dot(r,r);
    for(let iter=0;iter<18;iter++){iterations=iter+1;const jac=theta.map((v,j)=>{const step=1e-4*(1+Math.abs(v)),plus=[...theta],minus=[...theta];plus[j]=v+step;minus[j]=v-step;const rp=residual(plus),rm=residual(minus);return rp.map((x,i)=>(x-rm[i]!)/(2*step));});const rows=r.length+theta.length,aug=Array.from({length:rows},(_,row)=>row<r.length?jac.map(col=>col[row]!):Array.from({length:theta.length},(_,j)=>row-r.length===j?Math.sqrt(lambda):0));let step:number[];try{step=solveQr(aug,[...r.map(v=>-v),0,0,0]);}catch{lambda*=10;continue;}
      const candidate=[Math.max(-1e5,Math.min(1e5,theta[0]!+step[0]!)),Math.max(Math.log(.001),Math.min(Math.log(1e5),theta[1]!+step[1]!)),Math.max(Math.log(.02),Math.min(Math.log(20),theta[2]!+step[2]!))],next=residual(candidate),nextCost=dot(next,next);
      if(Number.isFinite(nextCost)&&nextCost<cost){const improvement=cost-nextCost;theta=candidate;r=next;cost=nextCost;lambda=Math.max(1e-8,lambda/3);if(improvement<1e-8*Math.max(1,cost)||Math.sqrt(dot(step,step))<1e-6){converged=true;break;}}else{lambda*=10;if(lambda>1e8)break;}
    }
    if(Number.isFinite(cost)&&(!best||cost<best.cost))best={cost,k:theta[0]!,wn:Math.exp(theta[1]!),zeta:Math.exp(theta[2]!),delay,iterations,converged};
  }
  if(!best)throw new Error("A otimização do processo de 2ª ordem não encontrou uma solução finita.");
  const target=validation?.sampleTime?validation:data,delaySeconds=best.delay*dt,delayOnTarget=Math.round(delaySeconds/target.sampleTime!),predicted=simulate(best.k,best.wn,best.zeta,delayOnTarget,target),residuals=target.output.map((y,i)=>y-predicted[i]!),metrics=modelMetrics(target.output,predicted,4);
  return{id:makeId(),name:`Processo 2ª ordem (L=${delaySeconds.toPrecision(3)} s)`,family:"Processo 2ª ordem",domain:"continuous",sampleTime:dt,numerator:[best.k*best.wn*best.wn],denominator:[1,2*best.zeta*best.wn,best.wn*best.wn],delay:delaySeconds,parameters:{gain:best.k,naturalFrequency:best.wn,dampingRatio:best.zeta,delay:delaySeconds,iterations:best.iterations},...metrics,residuals,predicted,...residualChecks(target.input,residuals),predictionKind:"simulation",evaluationDatasetId:target.id,method:"Busca de perfil do atraso + erro de simulação com RK4 e Gauss-Newton amortecido",diagnostics:[...(best.converged?[`Convergência em ${best.iterations} iterações; restrições wn>0, zeta>0.`]:["A busca terminou sem critério estrito de convergência; confira os parâmetros e resíduos."]),"Condições iniciais: y(0) medido e derivada inicial zero.",...(validation&&validation.id!==data.id?["Avaliado em experimento de validação independente."]: ["Sem validação independente."])]};
}
/** SISO realization -> descending-power transfer coefficients, via Faddeev-LeVerrier. */
export function estimateContinuousTransfer(data:IdentDataset,poleCount:number,zeroCount:number,delaySamples=0,validation?:IdentDataset):IdentModel{
  if(!data.sampleTime||data.input.length<20)throw new Error("A função de transferência contínua requer ao menos 20 amostras uniformes.");
  if(data.input.length>20_000)throw new Error("A estimação contínua limita o cálculo não linear a 20 mil amostras; recorte ou decime os dados explicitamente.");
  if(!Number.isInteger(poleCount)||poleCount<1||poleCount>8||!Number.isInteger(zeroCount)||zeroCount<0||zeroCount>=poleCount||!Number.isInteger(delaySamples)||delaySamples<0||delaySamples>200)throw new Error("Use 1–8 polos, zeros entre 0 e np−1 e atraso em amostras entre 0 e 200.");
  if(validation&&!validation.sampleTime)throw new Error("A validação contínua também precisa de tempos uniformes; reamostre explicitamente.");
  const w=Math.max(.001,Math.min(1/data.sampleTime,10/(data.time.at(-1)!-data.time[0]!))),den0=Array(poleCount+1).fill(0) as number[];den0[0]=1;for(let p=0;p<poleCount;p++)for(let i=p+1;i>=1;i--)den0[i]=den0[i]!+w*den0[i-1]!;
  let zeroPoly=[1];for(let p=0;p<zeroCount;p++)zeroPoly=polyMulDescending(zeroPoly,[1,w]);
  const uMean=mean(data.input),yMean=mean(data.output),uVar=variance(data.input),staticGain=uVar>1e-14?data.input.reduce((sum,u,i)=>sum+(u-uMean)*(data.output[i]!-yMean),0)/(data.input.length*uVar):1;
  if(uVar<1e-14)throw new Error("Entrada praticamente constante: a função de transferência não é identificável.");
  const numerator0=zeroPoly.map(v=>v*staticGain*den0.at(-1)!/zeroPoly.at(-1)!);
  let theta=[...numerator0,...den0.slice(1)],lambda=1e-2,iterations=0,converged=false;
  const realize=(p:number[])=>transferToStateSpace(p.slice(0,zeroCount+1),[1,...p.slice(zeroCount+1)]);
  const simulate=(p:number[],d:IdentDataset,delay=delaySamples):number[]=>{const ss=realize(p),h=d.sampleTime!,x=Array(poleCount).fill(0) as number[],out:number[]=[];const derivative=(state:number[],u:number)=>ss.A.map((row,i)=>row.reduce((sum,v,j)=>sum+v*state[j]!,ss.B[i]!*u));
    for(let k=0;k<d.input.length;k++){out.push(d.output[0]!+ss.C.reduce((sum,v,i)=>sum+v*x[i]!,0));const source=k-delay,held=source>=0?d.input[source]!-d.input[0]!:0;
      const k1=derivative(x,held),x2=x.map((v,i)=>v+h*k1[i]!/2),k2=derivative(x2,held),x3=x.map((v,i)=>v+h*k2[i]!/2),k3=derivative(x3,held),x4=x.map((v,i)=>v+h*k3[i]!),k4=derivative(x4,held);
      for(let i=0;i<x.length;i++){x[i]=x[i]!+h*(k1[i]!+2*k2[i]!+2*k3[i]!+k4[i]!)/6;if(!Number.isFinite(x[i]!)||Math.abs(x[i]!)>1e12)return out.concat(Array(d.input.length-k-1).fill(1e100));}
    }return out;};
  const residual=(p:number[],d:IdentDataset)=>{const predicted=simulate(p,d);return d.output.map((y,i)=>y-predicted[i]!);};let r=residual(theta,data),cost=dot(r,r);
  for(let iter=0;iter<45;iter++){iterations=iter+1;const jac=theta.map((value,j)=>{const step=1e-5*(Math.abs(value)+1),plus=[...theta],minus=[...theta];plus[j]=value+step;minus[j]=value-step;const rp=residual(plus,data),rm=residual(minus,data);return rp.map((v,i)=>(v-rm[i]!)/(2*step));});const rows=r.length+theta.length,aug=Array.from({length:rows},(_,row)=>row<r.length?jac.map(col=>col[row]!):Array.from({length:theta.length},(_,j)=>row-r.length===j?Math.sqrt(lambda):0));let step:number[];try{step=solveQr(aug,[...r.map(v=>-v),...Array(theta.length).fill(0)]);}catch{lambda*=10;if(lambda>1e8)break;continue;}
    const candidate=theta.map((v,i)=>Math.max(-1e8,Math.min(1e8,v+step[i]!))),next=residual(candidate,data),nextCost=dot(next,next);if(Number.isFinite(nextCost)&&nextCost<cost){const improvement=cost-nextCost;theta=candidate;r=next;cost=nextCost;lambda=Math.max(1e-9,lambda/3);if(improvement<1e-9*Math.max(1,cost)||Math.sqrt(dot(step,step))<1e-7){converged=true;break;}}else{lambda*=10;if(lambda>1e8)break;}}
  if(!Number.isFinite(cost))throw new Error("O ajuste da função de transferência não encontrou parâmetros finitos; verifique excitação, ordem e escala dos sinais.");
  const target=validation??data,targetDelay=Math.round(delaySamples*data.sampleTime/target.sampleTime!),predicted=simulate(theta,target,targetDelay),residuals=target.output.map((y,i)=>y-predicted[i]!),num=theta.slice(0,zeroCount+1),den=[1,...theta.slice(zeroCount+1)],stateSpace=transferToStateSpace(num,den),metrics=modelMetrics(target.output,predicted,theta.length);
  return{id:makeId(),name:`G(s) ${poleCount} polos / ${zeroCount} zeros`,family:"Função de transferência",domain:"continuous",sampleTime:data.sampleTime,numerator:num,denominator:den,delay:delaySamples*data.sampleTime,parameters:{poleCount,zeroCount,delaySamples,iterations,estimationCost:cost},...metrics,residuals,predicted,...residualChecks(target.input,residuals),stateSpace,predictionKind:"simulation",evaluationDatasetId:target.id,method:"Ajuste não linear no tempo contínuo por Gauss-Newton amortecido e integração RK4",diagnostics:[...(converged?[`Convergência em ${iterations} iterações.`]:[`Otimização terminou após ${iterations} iterações sem critério estrito de convergência.`]),"Estabilidade não foi imposta; verifique os polos antes de usar o modelo.","Modelo próprio; zeros limitados a np−1.",...(validation&&validation.id!==data.id?["Avaliado em experimento de validação independente."]: ["Sem validação independente."])]};
}
function polyMulDescending(a:number[],b:number[]):number[]{const out=Array(a.length+b.length-1).fill(0) as number[];for(let i=0;i<a.length;i++)for(let j=0;j<b.length;j++)out[i+j]=out[i+j]!+a[i]!*b[j]!;return out;}
function transferToStateSpace(numerator:number[],denominator:number[]):{A:number[][];B:number[];C:number[];D:number}{const n=denominator.length-1;if(n<1||numerator.length>n)throw new Error("A realização exige uma função própria e denominador dinâmico.");const a=denominator[0]!;if(a===0||!Number.isFinite(a))throw new Error("Coeficiente principal do denominador inválido.");const den=denominator.map(v=>v/a),num=numerator.map(v=>v/a),padded=[...Array(n-num.length).fill(0) as number[],...num];const A=Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>i<n-1&&j===i+1?1:i===n-1?-den[n-j]!:0)),B=Array.from({length:n},(_,i)=>i===n-1?1:0),C=[...padded].reverse();return{A,B,C,D:0};}
export function stateSpaceToTransfer(s:{A:number[][];B:number[];C:number[];D:number}):{numerator:number[];denominator:number[]}{
  const n=s.A.length;if(n<1||n>8||s.B.length!==n||s.C.length!==n||s.A.some(row=>row.length!==n)||![...s.A.flat(),...s.B,...s.C,s.D].every(Number.isFinite))throw new Error("Realização SISO inválida ou fora do limite de conversão.");
  const identity=():number[][]=>Array.from({length:n},(_,i)=>Array.from({length:n},(_,j)=>i===j?1:0));
  const multiply=(a:number[][],b:number[][])=>a.map(row=>b[0]!.map((_,j)=>row.reduce((sum,v,k)=>sum+v*b[k]![j]!,0)));
  const trace=(a:number[][])=>a.reduce((sum,row,i)=>sum+row[i]!,0);
  const matVec=(a:number[][],v:number[])=>a.map(row=>row.reduce((sum,x,i)=>sum+x*v[i]!,0));
  const denominator=[1],adjugateTerms:number[][][]=[identity()];let previous=identity();
  for(let k=1;k<=n;k++){const product=multiply(s.A,previous),coefficient=-trace(product)/k;denominator.push(coefficient);previous=product.map((row,i)=>row.map((v,j)=>v+(i===j?coefficient:0)));if(k<n)adjugateTerms.push(previous);}
  const numerator=Array(n+1).fill(0) as number[];numerator[0]=s.D;for(let i=1;i<=n;i++){const term=matVec(adjugateTerms[i-1]!,s.B);numerator[i]=s.D*denominator[i]!+s.C.reduce((sum,c,j)=>sum+c*term[j]!,0);}
  if([...numerator,...denominator].some(v=>!Number.isFinite(v)))throw new Error("Conversão de espaço de estados para função de transferência produziu coeficientes não finitos.");
  return{numerator,denominator};
}
export function updateDiscreteStateInitial(model:IdentModel,data:IdentDataset,x0:number[]):IdentModel{
  if(!model.stateSpace||model.domain!=="discrete"||model.evaluationDatasetId!==data.id)throw new Error("Condições iniciais editáveis exigem o modelo discreto e seu conjunto de avaliação correspondente.");
  if(x0.length!==model.stateSpace.A.length||x0.some(v=>!Number.isFinite(v)))throw new Error("x₀ deve ter uma entrada finita por estado.");
  const ss={...model.stateSpace,x0:[...x0]},predicted=simulateStateSpace(ss.A,ss.B,ss.C,ss.D,data.input,ss.x0),residuals=data.output.map((v,i)=>v-predicted[i]!),metrics=modelMetrics(data.output,predicted,ss.A.length**2+2*ss.A.length+1);
  return{...model,stateSpace:ss,predicted,residuals,...metrics,...residualChecks(data.input,residuals),diagnostics:[...model.diagnostics.filter(d=>!d.startsWith("Condição inicial x₀ configurada:")),`Condição inicial x₀ configurada: [${x0.join(", ")}]. Ajuste recalculado no conjunto ${data.name}.`]};
}
export function updateOutputInitial(model:IdentModel,data:IdentDataset,initialOutput:number):IdentModel{
  if(model.evaluationDatasetId!==data.id)throw new Error("A condi??o inicial deve ser avaliada no conjunto associado ao modelo.");
  if(!Number.isFinite(initialOutput))throw new Error("Initial output must be finite.");
  const base=model.predicted[0]??0,offset=initialOutput-base,predicted=model.predicted.map(value=>value+offset),residuals=data.output.map((value,i)=>value-predicted[i]!),metrics=modelMetrics(data.output,predicted,Math.max(1,Object.keys(model.parameters).length));
  return{...model,initialOutput,predicted,residuals,...metrics,...residualChecks(data.input,residuals),diagnostics:[...model.diagnostics.filter(d=>!d.startsWith("Initial output edited:")),`Initial output edited: ${initialOutput}; prediction shifted by a constant; metrics recalculated on ${data.name}.`]};
}
function simulateArx(a: number[], b: number[], nk: number, u: number[], observed: number[]): number[] {
  const y = Array(u.length).fill(0) as number[];
  for (let k = 0; k < y.length; k++) {
    let v = 0;
    for (let i=1;i<=a.length;i++) if (k-i>=0) v -= a[i-1]!*y[k-i]!;
    for (let j=0;j<b.length;j++) if (k-nk-j>=0) v += b[j]!*u[k-nk-j]!;
    // One-step predictor uses measured past outputs; free-run response is offered separately in a later view.
    if (observed[k] !== undefined && k > 0) { v = 0; for(let i=1;i<=a.length;i++) if(k-i>=0) v-=a[i-1]!*observed[k-i]!; for(let j=0;j<b.length;j++) if(k-nk-j>=0)v+=b[j]!*u[k-nk-j]!; }
    y[k]=v;
  }
  return y;
}
function solveQr(matrix: number[][], rhs: number[]): number[] {
  const m=matrix.length, n=matrix[0]?.length ?? 0;
  if (m < n || !n) throw new Error("Dados insuficientes para a ordem escolhida.");
  const cols=Array.from({length:n},(_,j)=>matrix.map(row=>row[j]!)), q: number[][]=[], r=Array.from({length:n},()=>Array(n).fill(0) as number[]);
  let maxNorm=0,minNorm=Infinity;
  for(let j=0;j<n;j++){
    let v=[...cols[j]!];
    for(let pass=0;pass<2;pass++) for(let i=0;i<j;i++){const projection=dot(q[i]!,v);r[i]![j]!+=projection;v=v.map((x,k)=>x-projection*q[i]![k]!);}
    const norm=Math.sqrt(dot(v,v)); maxNorm=Math.max(maxNorm,norm); minNorm=Math.min(minNorm,norm);
    if(norm <= Math.max(1e-12,maxNorm*1e-10)) throw new Error("Matriz de regressão deficiente de posto; reduza a ordem ou melhore a excitação dos dados.");
    r[j]![j]=norm; q.push(v.map(x=>x/norm));
  }
  const qty=q.map(col=>dot(col,rhs)); const x=Array(n).fill(0) as number[];
  for(let i=n-1;i>=0;i--){let v=qty[i]!;for(let j=i+1;j<n;j++)v-=r[i]![j]!*x[j]!;x[i]=v/r[i]![i]!;}
  if(maxNorm/minNorm>1e10) throw new Error("Regressão mal condicionada (>1e10); revise escalas, ordem e excitação."); return x;
}
const dot=(a:number[],b:number[])=>a.reduce((s,x,i)=>s+x*b[i]!,0);
const mean=(x:number[])=>x.reduce((a,b)=>a+b,0)/x.length;
const variance=(x:number[])=>{const m=mean(x);return x.reduce((s,v)=>s+(v-m)**2,0)/x.length;};
function modelMetrics(actual:number[], predicted:number[], parameters:number) {
  const n=Math.min(actual.length,predicted.length); if(n<2)throw new Error("A validação precisa de ao menos duas amostras.");
  const errors=actual.slice(0,n).map((y,i)=>y-predicted[i]!); const sse=errors.reduce((s,e)=>s+e*e,0); const rmse=Math.sqrt(sse/n),mae=errors.reduce((s,e)=>s+Math.abs(e),0)/n;
  const mean=actual.slice(0,n).reduce((s,x)=>s+x,0)/n, denom=Math.sqrt(actual.slice(0,n).reduce((s,x)=>s+(x-mean)**2,0));
  return {rmse,mae,fit:denom===0?0:100*(1-Math.sqrt(sse)/denom),aic:n*Math.log(Math.max(sse/n,Number.MIN_VALUE))+2*parameters,bic:n*Math.log(Math.max(sse/n,Number.MIN_VALUE))+parameters*Math.log(n)};
}
function residualChecks(input:number[],residuals:number[]):Pick<IdentModel,"residualAutocorrelation"|"inputResidualCorrelation">{
  const n=Math.min(input.length,residuals.length),e=residuals.slice(0,n),u=input.slice(0,n),em=e.reduce((a,b)=>a+b,0)/Math.max(1,n),um=u.reduce((a,b)=>a+b,0)/Math.max(1,n),ev=e.reduce((s,v)=>s+(v-em)**2,0),uv=u.reduce((s,v)=>s+(v-um)**2,0);
  const maxLag=Math.min(20,Math.floor(n/4));const residualAutocorrelation=Array.from({length:maxLag+1},(_,lag)=>{let covariance=0;for(let i=lag;i<n;i++)covariance+=(e[i]!-em)*(e[i-lag]!-em);return ev>0?covariance/ev:0;});let cross=0;for(let i=0;i<n;i++)cross+=(u[i]!-um)*(e[i]!-em);const inputResidualCorrelation=Array.from({length:maxLag+1},(_,lag)=>{let c=0;for(let i=lag;i<n;i++)c+=(u[i]!-um)*(e[i-lag]!-em);return uv>0&&ev>0?c/Math.sqrt(uv*ev):0;});void cross;
  return{residualAutocorrelation,inputResidualCorrelation};
}
