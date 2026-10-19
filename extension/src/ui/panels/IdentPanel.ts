import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs/promises";
import { Worker } from "worker_threads";
import { emptyIdentProject, parseIdentTable, stateSpaceToTransfer, updateDiscreteStateInitial, updateOutputInitial, validateIdentProject, type IdentDataset, type IdentModel, type IdentProject } from "../../ident/identification";

export class IdentPanel {
  private static current: vscode.WebviewPanel | undefined;
  static post(message:unknown):void{void this.current?.webview.postMessage(message);}
  static show(context: vscode.ExtensionContext, initial?: IdentProject, onSave?: (project: IdentProject) => void, onInsert?: (component: {typeId:string;label:string;properties:Record<string,string|number|boolean>}) => void, signals:Array<{id:string;label:string}>=[], onAcquire?:(request:{inputId:string;outputId:string;startSeconds:number;durationSeconds:number;sampleTime:number})=>void, onCancelAcquire?:()=>void, onSendControl?:(model:{label:string;num:number[];den:number[];domain:"continuous"|"discrete";sampleTime:number;stateSpace?:{A:number[][];B:number[];C:number[];D:number;x0?:number[]}})=>void): void {
    if (this.current) { this.current.reveal(vscode.ViewColumn.Active); return; }
    const panel=vscode.window.createWebviewPanel("lasecsimul.ident","LasecSimul — Identificação de Sistemas",vscode.ViewColumn.Active,{enableScripts:true,retainContextWhenHidden:true,localResourceRoots:[vscode.Uri.joinPath(context.extensionUri,"out-webview")]});
    this.current=panel;panel.onDidDispose(()=>{onCancelAcquire?.();if(this.current===panel)this.current=undefined;});
    const script=panel.webview.asWebviewUri(vscode.Uri.joinPath(context.extensionUri,"out-webview","ident","main.js"));const nonce=String(Date.now());
    panel.webview.html=`<!doctype html><html lang="pt-BR"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}' ${panel.webview.cspSource}"><title>LasecSimul — Identificação de Sistemas</title><style>
      :root{color-scheme:light dark;font:13px var(--vscode-font-family)}body{margin:0;color:var(--vscode-foreground);background:var(--vscode-editor-background)}header{position:sticky;top:0;background:var(--vscode-sideBar-background);padding:12px 16px;border-bottom:1px solid var(--vscode-panel-border);z-index:2}h1{font-size:19px;margin:0 0 10px}.actions{display:flex;flex-wrap:wrap;gap:7px}button,select,input{font:inherit;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);padding:5px 8px;border-radius:3px}button{cursor:pointer}button:hover{background:var(--vscode-button-secondaryHoverBackground)}main{padding:14px;display:grid;grid-template-columns:minmax(240px,1fr) minmax(360px,2fr) minmax(240px,1fr);gap:12px}.card{border:1px solid var(--vscode-panel-border);padding:12px;border-radius:4px;min-height:220px}h2{font-size:15px;margin:0 0 10px}.row{display:flex;gap:7px;align-items:center;flex-wrap:wrap;margin:7px 0}.dataset,.model{padding:8px;margin:5px 0;border:1px solid var(--vscode-panel-border);cursor:pointer}.selected{border-color:var(--vscode-focusBorder)}#status{padding:8px;color:var(--vscode-descriptionForeground)}#plot{width:100%;height:280px;background:var(--vscode-editor-background)}pre{white-space:pre-wrap;overflow-wrap:anywhere;color:var(--vscode-descriptionForeground)}table{border-collapse:collapse}td,th{padding:4px 8px;border:1px solid var(--vscode-panel-border);text-align:right} @media(max-width:900px){main{grid-template-columns:1fr}}</style></head><body><div id="app"></div><script nonce="${nonce}" type="module" src="${script}"></script></body></html>`;
    let project=validateIdentProject(initial)??context.workspaceState.get<IdentProject>("identProject",emptyIdentProject());const undoStack:IdentProject[]=[],redoStack:IdentProject[]=[];
    let pendingImport: { text: string; options: Parameters<typeof parseIdentTable>[1] } | undefined;let pendingDerived:IdentDataset|undefined;
    panel.webview.onDidReceiveMessage(async(message:{type:string;payload?:unknown;options?:unknown;na?:number;nb?:number;nk?:number;nc?:number;nd?:number;nf?:number;family?:string;domain?:"discrete"|"continuous";datasetId?:string;model?:IdentModel;modelId?:string;x0?:number[];initialOutput?:number})=>{
      try{
        if(message.type==="ready"){await panel.webview.postMessage({type:"init",project,signals});return;}
        if(message.type==="newProject"){pushHistory();project=emptyIdentProject();save();return;}
        if(message.type==="undo"||message.type==="redo"){
          const from=message.type==="undo"?undoStack:redoStack,to=message.type==="undo"?redoStack:undoStack;if(!from.length)return;to.push(structuredClone(project));project=from.pop()!;save();return;
        }
        if(message.type==="openProject"){
          const selected=await vscode.window.showOpenDialog({canSelectMany:false,filters:{"Projeto Ident": ["ident.json","json"]}});if(!selected?.[0])return;const loaded=validateIdentProject(JSON.parse(await fs.readFile(selected[0].fsPath,"utf8")));if(!loaded)throw Error("Arquivo não contém um projeto Ident válido.");pushHistory();project=loaded;save();return;
        }
        if(message.type==="saveProjectAs"){
          const target=await vscode.window.showSaveDialog({filters:{"Projeto Ident":["ident.json"]},saveLabel:"Salvar projeto Ident"});if(!target)return;await fs.writeFile(target.fsPath,JSON.stringify(project,null,2),"utf8");await panel.webview.postMessage({type:"projectExported",path:target.fsPath});return;
        }
        if(message.type==="exportModel"){
          const model=message.model as IdentModel|undefined;if(!model||!project.models.some(item=>item.id===model.id))throw Error("Selecione um modelo pertencente a este projeto.");const target=await vscode.window.showSaveDialog({filters:{"Modelo Ident JSON":["json"]},saveLabel:"Exportar modelo"});if(!target)return;await fs.writeFile(target.fsPath,JSON.stringify(model,null,2),"utf8");return;
        }
        if(message.type==="acquire"&&message.options){const request=message.options as {inputId:string;outputId:string;startSeconds:number;durationSeconds:number;sampleTime:number};onAcquire?.(request);await panel.webview.postMessage({type:"acquisitionStarted"});return;}
        if(message.type==="cancelAcquisition"){onCancelAcquire?.();return;}
        if(message.type==="acquisitionDataset"&&message.payload&&typeof message.payload==="object"){
          const result=message.payload as {dataset?:IdentDataset;error?:string};if(result.dataset){pushHistory();project.datasets.push(result.dataset);project.estimationDatasetId=result.dataset.id;save();await panel.webview.postMessage({type:"imported",dataset:result.dataset,project,warning:result.error});}else await panel.webview.postMessage({type:"error",message:result.error??"Aquisição não concluída."});return;
        }
        if(message.type==="previewText"&&typeof message.payload==="string"){
          pendingImport={text:message.payload,options:(message.options??{}) as Parameters<typeof parseIdentTable>[1]};
          const parsed=parseIdentTable(pendingImport.text,pendingImport.options);
          await panel.webview.postMessage({type:"preview",columns:parsed.columns,preview:parsed.preview,warnings:parsed.warnings});return;
        }
        if(message.type==="importText"){
          if(!pendingImport)throw Error("Selecione um arquivo antes de confirmar a importação.");
          pendingImport.options=(message.options??{}) as Parameters<typeof parseIdentTable>[1];
          const parsed=parseIdentTable(pendingImport.text,pendingImport.options);
          pushHistory();project.datasets.push(parsed.dataset);project.estimationDatasetId=parsed.dataset.id;save();
          await panel.webview.postMessage({type:"imported",dataset:parsed.dataset,columns:parsed.columns,preview:parsed.preview,warnings:parsed.warnings,project});return;
        }
        if(message.type==="preprocess"&&message.datasetId){
          const source=project.datasets.find(d=>d.id===message.datasetId);if(!source)throw Error("Conjunto de dados não encontrado.");
          const options=message.options as {operation:string;start?:number;end?:number;sampleTime?:number;cutoffHz?:number;inputOffset?:number;outputOffset?:number};let indices=source.time.map((_,i)=>i);
          if(options.operation==="recorte")indices=indices.filter(i=>source.time[i]!>=options.start!&&source.time[i]!<=options.end!);
          if(indices.length<3)throw Error("A operação precisa manter pelo menos três amostras.");
          let time=indices.map(i=>source.time[i]!),input=indices.map(i=>source.input[i]!),output=indices.map(i=>source.output[i]!);let sampleTime=source.sampleTime,resampleAntiAlias=false;const mean=(values:number[])=>values.reduce((a,b)=>a+b,0)/values.length;
          if(options.operation==="remover média"){const u=mean(input),y=mean(output);input=input.map(v=>v-u);output=output.map(v=>v-y);}
          if(options.operation==="ajustar offsets"){if(!Number.isFinite(options.inputOffset)||!Number.isFinite(options.outputOffset))throw new Error("Informe offsets numéricos finitos para u e y.");input=input.map(v=>v-options.inputOffset!);output=output.map(v=>v-options.outputOffset!);}
          if(options.operation==="remover tendência"){
            const detrend=(values:number[])=>{const x=indices.map(i=>source.time[i]!);const xm=mean(x),ym=mean(values);const slope=x.reduce((s,v,j)=>s+(v-xm)*(values[j]!-ym),0)/x.reduce((s,v)=>s+(v-xm)**2,0);return values.map((v,j)=>v-ym-slope*(x[j]!-xm));};input=detrend(input);output=detrend(output);
          }
          if(options.operation==="reamostrar"){
            const dt=options.sampleTime;if(!(dt&&Number.isFinite(dt)&&dt>0))throw Error("Informe o novo período de amostragem positivo.");
            if(sampleTime&&dt>sampleTime*(1+1e-6)){const cutoff=.45*sampleTime/dt;if(!(cutoff>0&&cutoff<.5))throw Error("A reamostragem para Ts maior não admite um filtro antialias estável nesta escala.");if(input.length*63>5_000_000)throw Error("O filtro antialias excede o limite interativo de operações; recorte o experimento antes da reamostragem.");input=firLowPass(input,cutoff);output=firLowPass(output,cutoff);resampleAntiAlias=true;}
            const start=time[0]!,end=time.at(-1)!,count=Math.floor((end-start)/dt)+1;if(count<3||count>2_000_000)throw Error("A grade de reamostragem produziria uma quantidade de amostras inválida.");
            const interpolate=(values:number[])=>Array.from({length:count},(_,j)=>{const target=start+j*dt;let lo=0,hi=time.length-1;while(lo+1<hi){const mid=(lo+hi)>>1;if(time[mid]!<=target)lo=mid;else hi=mid;}if(target<=time[0]!)return values[0]!;if(target>=time.at(-1)!)return values.at(-1)!;const fraction=(target-time[lo]!)/(time[hi]!-time[lo]!);return values[lo]!+(values[hi]!-values[lo]!)*fraction;});
            input=interpolate(input);output=interpolate(output);time=Array.from({length:count},(_,j)=>start+j*dt);sampleTime=dt;
          }
          if(options.operation==="decimar"){
            if(!sampleTime)throw new Error("A decimação exige amostragem uniforme.");const requested=options.sampleTime;if(!(requested&&requested>sampleTime))throw new Error("Novo Ts da decimação deve ser maior que o Ts atual.");const factor=Math.round(requested/sampleTime);if(factor<2||Math.abs(factor*sampleTime-requested)>sampleTime*1e-4)throw new Error("O novo período deve ser múltiplo inteiro do período atual.");const taps=Math.min(1001,Math.max(31,12*factor+1));if(input.length*taps>5_000_000)throw new Error("A decimação FIR excede o limite interativo de operações; recorte o experimento ou escolha outro fator.");input=firDecimate(input,factor);output=firDecimate(output,factor);const oldTime=time;time=oldTime.filter((_,i)=>i%factor===0).slice(0,Math.min(input.length,output.length));input=input.slice(0,time.length);output=output.slice(0,time.length);sampleTime*=factor;
          }
          if(options.operation==="filtrar"){
            if(!sampleTime)throw new Error("A filtragem FIR exige amostragem uniforme.");const cutoff=options.cutoffHz;if(!(cutoff&&cutoff>0&&cutoff<.5/sampleTime))throw new Error("A frequência de corte deve ficar abaixo de Nyquist.");if(input.length*63>5_000_000)throw new Error("A filtragem FIR excede o limite interativo de operações; recorte o experimento antes de filtrar.");input=firLowPass(input,cutoff*sampleTime);output=firLowPass(output,cutoff*sampleTime);
          }
          const derived:IdentDataset={...source,id:`${source.id}-derived-${Date.now().toString(36)}`,name:`${source.name} — ${options.operation}`,source:"Derivado",time,input,output,sampleTime,history:[...source.history,{operation:options.operation,parameters:{...(options.start===undefined?{}:{start:options.start}),...(options.end===undefined?{}:{end:options.end}),...(options.sampleTime===undefined?{}:{sampleTime:options.sampleTime}),...(options.cutoffHz===undefined?{}:{cutoffHz:options.cutoffHz}),...(options.inputOffset===undefined?{}:{inputOffset:options.inputOffset}),...(options.outputOffset===undefined?{}:{outputOffset:options.outputOffset}),...(resampleAntiAlias?{filter:"FIR sinc Blackman antialias para reamostragem com Ts maior"}:options.operation==="decimar"?{filter:"FIR sinc Blackman antialias"}:options.operation==="filtrar"?{filter:"FIR sinc Blackman"}:{})}}]};
          pendingDerived=derived;await panel.webview.postMessage({type:"preprocessPreview",dataset:derived,sourceId:source.id});return;
        }
        if(message.type==="applyPreprocess"){
          if(!pendingDerived)throw Error("A prévia do pré-processamento expirou; gere-a novamente.");pushHistory();project.datasets.push(pendingDerived);project.estimationDatasetId=pendingDerived.id;pendingDerived=undefined;save();return;
        }
        if(message.type==="splitDataset"&&message.datasetId){
          const source=project.datasets.find(d=>d.id===message.datasetId);if(!source)throw Error("Conjunto de dados não encontrado.");const fraction=typeof message.options==="object"&&message.options?Number((message.options as {estimationFraction?:number}).estimationFraction):.7;const split=Math.floor(source.time.length*fraction);
          if(!(fraction>.1&&fraction<.9)||split<3||source.time.length-split<3)throw Error("A divisão temporal precisa deixar pelo menos três amostras em cada conjunto e uma proporção entre 10% e 90%.");
          const make=(start:number,end:number,name:string):IdentDataset=>({...source,id:`${source.id}-${name}-${Date.now().toString(36)}`,name:`${source.name} — ${name}`,source:"Derivado",time:source.time.slice(start,end),input:source.input.slice(start,end),output:source.output.slice(start,end),history:[...source.history,{operation:"divisão temporal",parameters:{startIndex:start,endIndex:end,estimationFraction:fraction}}]});
          const estimation=make(0,split,"estimação"),validation=make(split,source.time.length,"validação");pushHistory();project.datasets.push(estimation,validation);project.estimationDatasetId=estimation.id;project.validationDatasetId=validation.id;save();await panel.webview.postMessage({type:"init",project,signals});return;
        }
        if(message.type==="estimate"){
          const data=project.datasets.find(d=>d.id===(message.datasetId??project.estimationDatasetId));if(!data)throw Error("Importe e selecione dados de estimação.");
          const validation=project.datasets.find(d=>d.id===project.validationDatasetId);
          const model=await estimateInWorker(context,{data,validation,family:message.family??"ARX",domain:message.domain,na:message.na??2,nb:message.nb??2,nk:message.nk??1,nc:message.nc??1,nd:message.nd??1,nf:message.nf??1});
          pushHistory();project.models.push(model);save();await panel.webview.postMessage({type:"estimated",project,model});return;
        }
        if(message.type==="insertModel"&&message.model){
          const model=message.model;let typeId:string;let properties:Record<string,string|number|boolean>;const samplePeriodNs=Math.round(model.sampleTime*1e9);
          if(model.delay>0&&model.family!=="Processo 1ª ordem")throw Error("Este modelo possui atraso puro e o bloco compatível atual não o representa. Reduza ou componha o atraso explicitamente antes de inserir.");
          if(model.family==="Integrador"){
            typeId="control.integrator";properties={gain:model.parameters.gain!,initial:model.predicted[0]??0};
          }else if(model.stateSpace){
            if(!(samplePeriodNs>0)||!Number.isSafeInteger(samplePeriodNs)||Math.abs(samplePeriodNs/1e9-model.sampleTime)>1e-12)throw Error("Ts precisa ser representável em nanossegundos inteiros pelo bloco de estados discreto.");
            typeId="control.state_space";properties={A:JSON.stringify(model.stateSpace.A),B:JSON.stringify(model.stateSpace.B),C:JSON.stringify(model.stateSpace.C),D:model.stateSpace.D,x0:JSON.stringify(model.stateSpace.x0??Array(model.stateSpace.A.length).fill(0)),domain:model.domain,samplePeriodNs};
          }else if(model.family==="Processo 2ª ordem"){
            if(model.denominator.length!==3)throw Error("A realização contínua da planta de segunda ordem é inválida.");
            const [a0,a1,a2]=model.denominator,[gain]=model.numerator;
            if(!a0||a1===undefined||a2===undefined||gain===undefined)throw Error("Coeficientes de segunda ordem incompletos.");
            typeId="control.state_space";properties={A:JSON.stringify([[0,1],[-a2/a0,-a1/a0]]),B:JSON.stringify([0,1]),C:JSON.stringify([gain/a0,0]),D:0,domain:"continuous",samplePeriodNs};
          }else if(model.domain==="discrete"){
            if(!(samplePeriodNs>0)||!Number.isSafeInteger(samplePeriodNs)||Math.abs(samplePeriodNs/1e9-model.sampleTime)>1e-12)throw Error("Ts precisa ser representável em nanossegundos inteiros pelo bloco discreto.");
            const denominator=[...model.denominator];if(model.numerator.length>denominator.length)denominator.push(...Array(model.numerator.length-denominator.length).fill(0));
            typeId="control.transfer_function";properties={model:"discrete_transfer_function",numeratorCoefficients:model.numerator.join(","),denominatorCoefficients:denominator.join(","),samplePeriodNs};
          }else{
            typeId="control.fopdt";properties={gain:model.parameters.gain!,tau:model.parameters.timeConstant!,delay:model.parameters.delay!,initial:model.predicted[0]??0};
          }
          onInsert?.({typeId,label:`Ident ${model.name}`,properties});
          await panel.webview.postMessage({type:"inserted"});return;
        }
        if(message.type==="sendToControl"&&message.model){
          const model=message.model;if(model.delay>0)throw Error("O modelo contém atraso puro, que o Projeto de Controladores ainda não representa. O atraso não foi descartado.");
          const transfer=model.stateSpace?stateSpaceToTransfer(model.stateSpace):{numerator:model.numerator,denominator:model.denominator};
          if(!transfer.numerator.length||!transfer.denominator.length)throw Error("Não foi possível obter uma função de transferência SISO para este modelo.");
          onSendControl?.({label:model.name,num:transfer.numerator,den:transfer.denominator,domain:model.domain,sampleTime:model.sampleTime,...(model.stateSpace?{stateSpace:model.stateSpace}:{})});
          await panel.webview.postMessage({type:"sentToControl"});return;
        }
        if(message.type==="assignDataset"){if(message.datasetId&&!project.datasets.some(d=>d.id===message.datasetId))throw Error("Conjunto de dados não encontrado.");pushHistory();if(message.family==="validation"){if(message.datasetId)project.validationDatasetId=message.datasetId;else delete project.validationDatasetId;}else if(message.datasetId)project.estimationDatasetId=message.datasetId;save();await panel.webview.postMessage({type:"init",project,signals});return;}
        if(message.type==="setInitialOutput"&&message.modelId&&typeof message.initialOutput==="number"){const index=project.models.findIndex(m=>m.id===message.modelId);if(index<0)throw Error("Selected model was not found.");const model=project.models[index]!,data=project.datasets.find(d=>d.id===model.evaluationDatasetId);if(!data)throw Error("Model evaluation dataset was not found.");pushHistory();project.models[index]=updateOutputInitial(model,data,message.initialOutput);save();return;}
        if(message.type==="setInitialState"&&message.modelId&&message.x0){const index=project.models.findIndex(m=>m.id===message.modelId);if(index<0)throw Error("Modelo selecionado não encontrado.");const model=project.models[index]!,data=project.datasets.find(d=>d.id===model.evaluationDatasetId);if(!data)throw Error("Conjunto de avaliação do modelo não encontrado.");const updated=updateDiscreteStateInitial(model,data,message.x0);pushHistory();project.models[index]=updated;save();return;}
        if(message.type==="save") { save(); }
      }catch(error){await panel.webview.postMessage({type:"error",message:error instanceof Error?error.message:String(error)});}
    });
    function pushHistory(){undoStack.push(structuredClone(project));if(undoStack.length>50)undoStack.shift();redoStack.length=0;}
    function save(){onSave?.(project);void context.workspaceState.update("identProject",project);void panel.webview.postMessage({type:"init",project,signals});}
  }
}

function firDecimate(values:number[],factor:number):number[]{return firLowPass(values,0.45/factor,Math.min(1001,Math.max(31,12*factor+1)));}
function firLowPass(values:number[],normalizedCutoff:number,tapCount=63):number[]{
  if(!(normalizedCutoff>0&&normalizedCutoff<.5))throw new Error("Corte FIR inválido.");
  let taps=Math.max(3,Math.min(1001,Math.floor(tapCount)));if(taps%2===0)taps++;
  const middle=(taps-1)/2,kernel=Array.from({length:taps},(_,i)=>{const n=i-middle;const sinc=n===0?2*normalizedCutoff:Math.sin(2*Math.PI*normalizedCutoff*n)/(Math.PI*n);const window=.42-.5*Math.cos(2*Math.PI*i/(taps-1))+.08*Math.cos(4*Math.PI*i/(taps-1));return sinc*window;});const sum=kernel.reduce((a,b)=>a+b,0);for(let i=0;i<kernel.length;i++)kernel[i]=kernel[i]!/sum;
  return values.map((_,index)=>kernel.reduce((acc,h,j)=>acc+h*values[Math.max(0,Math.min(values.length-1,index+j-middle))]!,0));
}

function estimateInWorker(context:vscode.ExtensionContext,request:{data:IdentDataset;validation?:IdentDataset;family:string;domain?:"discrete"|"continuous";na:number;nb:number;nk:number;nc:number;nd:number;nf:number}):Promise<IdentModel>{
  return Promise.resolve(vscode.window.withProgress({location:vscode.ProgressLocation.Notification,title:"Ident — estimando modelo",cancellable:true},(progress,token)=>new Promise<IdentModel>((resolve,reject)=>{
    const worker=new Worker(path.join(context.extensionPath,"out","ident","estimateWorker.js"));let settled=false;progress.report({message:"Montando preditores e ajustando parâmetros…"});
    const cleanup=()=>{subscription.dispose();void worker.terminate();};
    const fail=(error:Error)=>{if(settled)return;settled=true;cleanup();reject(error);};
    const subscription=token.onCancellationRequested(()=>fail(new Error("Estimação cancelada pelo usuário.")));
    worker.on("message",(response:{ok?:boolean;model?:IdentModel;error?:string;progress?:string;percent?:number})=>{if(response.progress){progress.report({message:response.progress,increment:response.percent===100?65:5});return;}if(settled)return;settled=true;cleanup();if(response.ok&&response.model)resolve(response.model);else reject(new Error(response.error??"Falha no worker de estimação."));});
    worker.once("error",error=>fail(error));
    worker.once("exit",code=>{if(!settled&&code!==0)fail(new Error(`Worker de estimação encerrou com código ${code}.`));});
    worker.postMessage(request);
  })));
}
