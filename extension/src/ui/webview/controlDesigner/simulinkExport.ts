import type { ControlDesignProject, ControlArchitecture } from "./types.js";

type NodeKind="in"|"out"|"sum"|"tf"|"plant"|"delay";
type ModelBlock={name:string;kind:NodeKind;x:number;y:number;port?:number;signs?:string;model?:{num:string;den:string}};
type Edge=[from:string,to:string,input:number];
type Graph={blocks:ModelBlock[];edges:Edge[];plant?:string};
const unit={num:"1",den:"1"};
function parseCoefficients(value:string):number[]{const result=value.split(/[;,\s]+/).filter(Boolean).map(Number);if(!result.length||result.some(item=>!Number.isFinite(item)))throw new Error("Coeficientes invalidos para gerar o modelo Simulink.");return result}
function vector(values:number[]):string{return `[${values.map(value=>Number(value).toPrecision(15)).join(" ")}]`}
function column(values:number[]):string{return `[${values.map(value=>Number(value).toPrecision(15)).join("; ")}]`}
function matrix(values:number[][]):string{return `[${values.map(row=>row.map(value=>Number(value).toPrecision(15)).join(" ")).join("; ")}]`}
function model(value:{num:string;den:string}|undefined){const actual=value??unit;return {num:vector(parseCoefficients(actual.num)),den:vector(parseCoefficients(actual.den))}}
function graphFor(project:ControlDesignProject):Graph{
  const architecture:ControlArchitecture=project.architecture??"forward-controller",blocks:ModelBlock[]=[],edges:Edge[]=[],add=(name:string,kind:NodeKind,x:number,y:number,extra:Partial<ModelBlock>={})=>blocks.push({name,kind,x,y,...extra}),edge=(from:string,to:string,input=1)=>edges.push([from,to,input]),input=(name:string,port:number,y:number)=>add(name,"in",25,y,{port}),output=(name:string,y:number)=>add(name,"out",700,y),tf=(name:string,value:{num:string;den:string}|undefined,x:number,y:number)=>add(name,"tf",x,y,{model:model(value)}),plant=(name:string,x:number,y:number)=>{if(project.plantStateSpace)add(name,"plant",x,y);else tf(name,project.G,x,y)},sum=(name:string,x:number,y:number,signs:string)=>add(name,"sum",x,y,{signs});let plantNode="G";
  if(architecture==="forward-controller"){
    input("r",1,245);tf("F",project.F,105,230);sum("Sum_e",190,230,"+-");tf("C",project.C,280,230);plant("G",380,230);tf("H",project.H,490,400);output("y",245);plantNode="G";
    edge("r","F");edge("F","Sum_e",1);edge("H","Sum_e",2);edge("Sum_e","C");edge("C","G");edge("G","y");edge("G","H");
  }else if(architecture==="feedback-controller"){
    input("r",1,245);tf("F",project.F,105,230);sum("Sum_e",190,230,"+-");plant("G",300,230);tf("H",project.H,400,400);tf("C",project.C,510,400);output("y",245);plantNode="G";
    edge("r","F");edge("F","Sum_e",1);edge("C","Sum_e",2);edge("Sum_e","G");edge("G","y");edge("G","H");edge("H","C");
  }else if(architecture==="feedforward-disturbance"){
    input("r",1,200);input("d",2,500);sum("Sum_e",125,190,"+-");tf("H",project.H,100,410);tf("C",project.C,220,180);tf("F",project.F,220,470);sum("Sum_u",330,310,"++");plant("G",430,300);sum("Sum_y",540,300,"++");output("y",300);plantNode="G";
    edge("r","Sum_e",1);edge("H","Sum_e",2);edge("Sum_e","C");edge("C","Sum_u",1);edge("d","F");edge("F","Sum_u",2);edge("Sum_u","G");edge("G","Sum_y",1);edge("d","Sum_y",2);edge("Sum_y","y");edge("Sum_y","H");
  }else if(architecture==="nested-inner-feedback"){
    input("r",1,180);sum("Sum_outer",120,170,"+-");tf("C1",project.C,220,150);tf("H",project.H,400,430);tf("C2",project.C2,360,430);sum("Sum_u",470,275,"+-");plant("G",560,265);output("y",265);plantNode="G";
    edge("r","Sum_outer",1);edge("H","Sum_outer",2);edge("Sum_outer","C1");edge("C1","Sum_u",1);edge("G","y");edge("y","H");edge("G","C2");edge("C2","Sum_u",2);edge("Sum_u","G");
  }else if(architecture==="imc"){
    input("r",1,190);input("d",2,500);tf("F",project.F,95,170);sum("Sum_e",185,170,"+-+");tf("C",project.C,275,170);plant("G1",390,160);tf("G2",project.H,390,380);tf("Gd",project.C2,500,470);sum("Sum_y",540,240,"++");output("y",240);plantNode="G1";
    edge("r","F");edge("F","Sum_e",1);edge("Sum_y","Sum_e",2);edge("G2","Sum_e",3);edge("Sum_e","C");edge("C","G1");edge("C","G2");edge("G1","Sum_y",1);edge("d","Gd");edge("Gd","Sum_y",2);edge("Sum_y","y");
  }else{
    input("r",1,190);tf("F",project.F,65,170);sum("Sum_outer",135,170,"+-");tf("C1",project.C,230,150);sum("Sum_inner",340,170,"+-");tf("H1",project.H,410,430);tf("H2",project.H2,300,430);tf("C2",project.C2,430,150);plant("G",550,160);output("y",160);plantNode="G";
    edge("r","F");edge("F","Sum_outer",1);edge("H1","Sum_outer",2);edge("Sum_outer","C1");edge("C1","Sum_inner",1);edge("H2","Sum_inner",2);edge("Sum_inner","C2");edge("C2","G");edge("G","y");edge("G","H1");edge("G","H2");
  }
  if((project.plantDelaySeconds??0)>0){const x=(blocks.find(block=>block.name===plantNode)?.x??400)+75,y=blocks.find(block=>block.name===plantNode)?.y??230;add("G_delay","delay",x,y);for(const edgeRow of edges)if(edgeRow[0]===plantNode)edgeRow[0]="G_delay";edges.push([plantNode,"G_delay",1])}
  return {blocks,edges,plant:plantNode};
}
export function controlDesignSimulinkScript(project:ControlDesignProject):string{
  const architecture=project.architecture??"forward-controller",domain=project.domain,ts=Number(project.sampleTime),mdl="LasecSimulControl",graph=graphFor(project),lines=["% Gera uma arquitetura Simulink equivalente ao projeto SisoTools.",`% Arquitetura: ${architecture}; domínio: ${domain}.`,`mdl = '${mdl}';`,`if bdIsLoaded(mdl), close_system(mdl,0); end`,`new_system(mdl);`,`open_system(mdl);`];
  if(domain==="discrete")lines.push(`set_param(mdl,'Solver','FixedStepDiscrete','FixedStep','${ts.toPrecision(15)}');`);
  for(const block of graph.blocks){const dest=`[mdl '/${block.name}']`,position=`[${block.x} ${block.y} ${block.x+58} ${block.y+38}]`;
    if(block.kind==="in")lines.push(`add_block('simulink/Ports & Subsystems/In1',${dest},'Port','${block.port}','Position',${position});`);
    else if(block.kind==="out")lines.push(`add_block('simulink/Ports & Subsystems/Out1',${dest},'Position',${position});`);
    else if(block.kind==="sum")lines.push(`add_block('simulink/Math Operations/Sum',${dest},'Inputs','${block.signs}','Position',${position});`);
    else if(block.kind==="tf"){const value=block.model!;if(domain==="discrete")lines.push(`add_block('simulink/Discrete/Discrete Transfer Fcn',${dest},'Numerator','${value.num}','Denominator','${value.den}','SampleTime','${ts.toPrecision(15)}','Position',${position});`);else lines.push(`add_block('simulink/Continuous/Transfer Fcn',${dest},'Numerator','${value.num}','Denominator','${value.den}','Position',${position});`)}
    else if(block.kind==="plant"){const ss=project.plantStateSpace!;const library=domain==="discrete"?"simulink/Discrete/Discrete State-Space":"simulink/Continuous/State-Space",x0=project.plantInitialState??ss.A.map(()=>0),params=`'A','${matrix(ss.A)}','B','${column(ss.B)}','C','${vector(ss.C)}','D','${Number(ss.D).toPrecision(15)}','InitialCondition','${vector(x0)}'${domain==="discrete"?`,'SampleTime','${ts.toPrecision(15)}'`:""}`;lines.push(`add_block('${library}',${dest},${params},'Position',${position});`)}
    else {const delay=domain==="discrete"?Math.round((project.plantDelaySeconds??0)/ts):Number(project.plantDelaySeconds);if(domain==="discrete"&&Math.abs(delay-(project.plantDelaySeconds??0)/ts)>1e-8)throw new Error("O atraso da planta precisa ser múltiplo inteiro de Ts para gerar o modelo discreto.");if(domain==="discrete")lines.push(`add_block('simulink/Discrete/Delay',${dest},'DelayLength','${delay}','InitialCondition','0','SampleTime','${ts.toPrecision(15)}','Position',${position});`);else lines.push(`add_block('simulink/Continuous/Transport Delay',${dest},'DelayTime','${Number(project.plantDelaySeconds).toPrecision(15)}','InitialOutput','0','Position',${position});`)}
  }
  for(const [from,to,input] of graph.edges)lines.push(`add_line(mdl,'${from}/1','${to}/${input}','autorouting','on');`);
  lines.push("Simulink.BlockDiagram.arrangeSystem(mdl);","save_system(mdl,[mdl '.slx']);","open_system(mdl);","");return lines.join("\n");
}
