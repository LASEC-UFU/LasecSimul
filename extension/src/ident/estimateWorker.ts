import { parentPort } from "worker_threads";
import { estimateArx, estimateContinuousTransfer, estimateIntegrator, estimateFopdt, estimateSecondOrder, estimateHoKalman, estimatePolynomial, type IdentDataset } from "./identification";

parentPort?.on("message",(request:{data:IdentDataset;validation?:IdentDataset;family:string;domain?:"discrete"|"continuous";na:number;nb:number;nk:number;nc:number;nd:number;nf:number})=>{
  try{
    const startedAt=Date.now();
    parentPort?.postMessage({progress:"Validando dados e preparando estimação…",percent:5});
    const model=request.family==="integrator"?estimateIntegrator(request.data,request.validation):request.family==="continuous-tf"?estimateContinuousTransfer(request.data,request.na,request.nb,request.nk,request.validation):request.family==="state-space"?estimateHoKalman(request.data,request.na,request.validation,request.domain??"discrete"):request.family==="fopdt"?estimateFopdt(request.data,request.validation,request.nk):request.family==="second-order"?estimateSecondOrder(request.data,request.validation,request.nk)
      :request.family==="ARMAX"||request.family==="OE"||request.family==="Box-Jenkins"
        ?estimatePolynomial(request.data,request.family,{na:request.na,nb:request.nb,nk:request.nk,nc:request.nc,nd:request.nd,nf:request.nf},request.validation)
        :estimateArx(request.data,request.na,request.nb,request.nk,request.validation);
    const cost=model.residuals.reduce((sum,value)=>sum+value*value,0);model.diagnostics.push(`Amostras de estimação: ${request.data.input.length}; avaliação: ${model.residuals.length}; SSE da avaliação: ${cost.toPrecision(6)}; cálculo: ${Date.now()-startedAt} ms.`);
    model.diagnostics.push(`Referência inicial do experimento: u₀=${request.data.input[0]!.toPrecision(5)}, y₀=${request.data.output[0]!.toPrecision(5)}. Interprete o modelo em torno desta condição de operação; offsets absolutos são separados da dinâmica.`);
    if(apparentSaturation(request.data.input))model.diagnostics.push("Possível saturação aparente em u: muitos valores coincidem com o mínimo ou máximo observado; confirme nos dados do processo.");
    if(apparentSaturation(request.data.output))model.diagnostics.push("Possível saturação aparente em y: muitos valores coincidem com o mínimo ou máximo observado; confirme nos dados do processo.");
    parentPort?.postMessage({progress:"Validação e diagnósticos concluídos.",percent:100});parentPort?.postMessage({ok:true,model});
  }catch(error){parentPort?.postMessage({ok:false,error:error instanceof Error?error.message:String(error)});}
});
function apparentSaturation(values:number[]):boolean{if(values.length<20)return false;let min=Infinity,max=-Infinity;for(const value of values){min=Math.min(min,value);max=Math.max(max,value);}if(!(max>min))return false;const tolerance=(max-min)*1e-9;let atBoundary=0;for(const value of values)if(Math.abs(value-min)<=tolerance||Math.abs(value-max)<=tolerance)atBoundary++;return atBoundary>=Math.max(4,Math.ceil(values.length*.05));}
