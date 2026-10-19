import * as vscode from "vscode";
import { addSeriesDrain, enqueueCoreMutation, onCoreRebuilt, onSimulationStatusChange } from "../core/coreLifecycle";
import { coreInstanceIdByComponentId, state } from "../state";
import { SeriesStore } from "../lab/SeriesStore";
import type { IdentDataset } from "./identification";

/** Grava dois sinais do Core em tempo simulado; qualquer perda/reinício invalida o experimento. */
export class IdentAcquisition {
  private store: SeriesStore | undefined;
  private removeDrain: (()=>void)|undefined;
  private removeRebuild: (()=>void)|undefined;
  private removeStatus: (()=>void)|undefined;
  private finished=false;
  private readonly times:number[]=[];private readonly input:number[]=[];private readonly output:number[]=[];
  private inputComponentId="";private outputComponentId="";
  constructor(private readonly inputLabel:string,private readonly outputLabel:string,private readonly startSeconds:number,private readonly durationSeconds:number,private sampleTime:number,private readonly deliver:(dataset:IdentDataset|undefined,error?:string)=>void){}
  async start(inputComponentId:string,outputComponentId:string):Promise<void>{
    if(!state.coreClient)throw new Error("O Core não está conectado.");
    this.inputComponentId=inputComponentId;this.outputComponentId=outputComponentId;
    const uInstance=coreInstanceIdByComponentId.get(inputComponentId),yInstance=coreInstanceIdByComponentId.get(outputComponentId);
    if(!uInstance||!yInstance)throw new Error("Um dos sinais selecionados não está ativo no Core; execute a simulação e tente novamente.");
    const periodNs=Math.round(this.sampleTime*1e9);if(!Number.isSafeInteger(periodNs)||periodNs<=0)throw new Error("Período precisa ser representável em nanossegundos inteiros.");
    this.sampleTime=periodNs/1e9;
    await enqueueCoreMutation(async()=>{
      const subscriptionId=await state.coreClient!.subscribeSeries([{instanceId:uInstance,port:"out"},{instanceId:yInstance,port:"out"}],{periodNs});
      this.store=new SeriesStore(subscriptionId,["u","y"],2_000_000);
      this.removeDrain=addSeriesDrain({subscriptionId,request:()=>this.store!.request(),deliver:(chunk)=>{
        const delta=this.store?.ingest(chunk);if(!delta)return;
        if(delta.lost>0){void this.finish(undefined,`Aquisição cancelada: o Core informou ${delta.lost} amostras perdidas.`);return;}
        if(delta.reset&&this.times.length>0){void this.finish(undefined,"Aquisição cancelada: a simulação foi reiniciada durante a captura.");return;}
        for(let i=0;i<delta.t.length;i++){const t=delta.t[i]!;if(t+1e-12<this.startSeconds)continue;if(t>this.startSeconds+this.durationSeconds+1e-12){void this.finishFromCollected();return;}const u=delta.columns[0]?.[i],y=delta.columns[1]?.[i];if(!Number.isFinite(u)||!Number.isFinite(y)){void this.finish(undefined,"Aquisição cancelada: leitura ausente ou não finita.");return;}this.times.push(t);this.input.push(u!);this.output.push(y!);}
      }});
      this.removeRebuild=onCoreRebuilt(()=>{void this.finish(undefined,"Aquisição cancelada: o circuito foi reconstruído durante a captura.");});
      this.removeStatus=onSimulationStatusChange((status)=>{if(status==="stopped")void this.finishFromCollected("simulação parou antes do fim da janela configurada");});
    });
  }
  cancel():void{void this.finish(undefined,"Aquisição cancelada pelo usuário.");}
  noteParameterChange(componentId:string):void{if(componentId===this.inputComponentId||componentId===this.outputComponentId)void this.finishFromCollected("parâmetro do circuito alterado durante a aquisição");}
  private async finishFromCollected(partial?:string):Promise<void>{
    if(this.times.length<3){await this.finish(undefined,"A janela terminou com menos de três amostras; confira o início, duração e período.");return;}
    const differences=this.times.slice(1).map((t,i)=>t-this.times[i]!);const irregular=differences.some(dt=>Math.abs(dt-this.sampleTime)>Math.max(1e-9,this.sampleTime*1e-3));
    const dataset:IdentDataset={id:`acq-${Date.now().toString(36)}`,name:`Aquisição ${this.inputLabel} → ${this.outputLabel}`,source:"Simulação LasecSimul",time:[...this.times],input:[...this.input],output:[...this.output],...(irregular?{}:{sampleTime:this.sampleTime}),inputUnit:"",outputUnit:"",inputName:this.inputLabel,outputName:this.outputLabel,history:partial?[{operation:"Aquisição encerrada antes do fim",parameters:{reason:partial}}]:[]};
    await this.finish(dataset,[partial,irregular?"Amostragem irregular detectada durante captura; modelos discretos uniformes exigem reamostragem explícita.":undefined].filter(Boolean).join("; ")||undefined);
  }
  private async finish(dataset:IdentDataset|undefined,error?:string):Promise<void>{if(this.finished)return;this.finished=true;this.removeDrain?.();this.removeDrain=undefined;this.removeRebuild?.();this.removeRebuild=undefined;this.removeStatus?.();this.removeStatus=undefined;const store=this.store;this.store=undefined;if(store&&state.coreClient)await state.coreClient.unsubscribeSeries(store.subscriptionId).catch(()=>false);this.deliver(dataset,error);}
}
