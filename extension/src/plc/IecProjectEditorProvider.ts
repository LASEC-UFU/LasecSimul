import * as vscode from "vscode";
import { IecProjectAuthoring, IecProjectStore, parseIecProject } from "./iecProject";
import { addPouToProject, insertPouReference, updatePouInterface, updatePouText } from "./iecEditorWorkspace";

function nonce(): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  return Array.from({ length: 32 }, () => alphabet[Math.floor(Math.random() * alphabet.length)]).join("");
}

function readProject(document: vscode.TextDocument): IecProjectAuthoring {
  return parseIecProject(JSON.parse(document.getText()));
}

export class IecProjectEditorProvider implements vscode.CustomTextEditorProvider {
  static readonly viewType = "lasecsimul.iecProjectEditor";

  static register(context: vscode.ExtensionContext): vscode.Disposable {
    return vscode.window.registerCustomEditorProvider(IecProjectEditorProvider.viewType, new IecProjectEditorProvider(), {
      webviewOptions: { retainContextWhenHidden: true },
      supportsMultipleEditorsPerDocument: false,
    });
  }

  async resolveCustomTextEditor(document: vscode.TextDocument, panel: vscode.WebviewPanel): Promise<void> {
    panel.webview.options = { enableScripts: true };
    panel.webview.html = this.html(panel.webview);
    const publish = (): void => {
      try {
        const project = readProject(document);
        const store = new IecProjectStore(project);
        void panel.webview.postMessage({ type: "project", project, symbols: store.symbols(), diagnostics: store.diagnostics() });
      } catch (error) {
        void panel.webview.postMessage({ type: "error", message: error instanceof Error ? error.message : String(error) });
      }
    };
    const change = vscode.workspace.onDidChangeTextDocument(event => {
      if (event.document.uri.toString() === document.uri.toString()) publish();
    });
    panel.onDidDispose(() => change.dispose());
    panel.webview.onDidReceiveMessage(async message => {
      try {
        if (message?.type === "ready") { publish(); return; }
        const project = readProject(document);
        let updated: IecProjectAuthoring;
        if (message?.type === "addPou") updated = addPouToProject(project, String(message.name ?? ""), message.kind, message.language);
        else if (message?.type === "insertReference") updated = insertPouReference(project, String(message.callerPouId), String(message.targetPouId));
        else if (message?.type === "updateText") updated = updatePouText(project, String(message.pouId), String(message.text ?? ""));
        else if (message?.type === "updateInterface") updated = updatePouInterface(project, String(message.pouId), message.value);
        else return;
        parseIecProject(updated);
        const edit = new vscode.WorkspaceEdit();
        edit.replace(document.uri, new vscode.Range(document.positionAt(0), document.positionAt(document.getText().length)),
          JSON.stringify(updated, null, 2) + "\n");
        if (!(await vscode.workspace.applyEdit(edit))) throw new Error("VS Code rejected the IEC document edit");
      } catch (error) {
        void vscode.window.showErrorMessage(`IEC editor: ${error instanceof Error ? error.message : String(error)}`);
      }
    });
  }

  private html(webview: vscode.Webview): string {
    const token = nonce();
    return `<!doctype html><html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource} 'nonce-${token}'; script-src 'nonce-${token}';">
<style nonce="${token}">
body{margin:0;color:var(--vscode-foreground);background:var(--vscode-editor-background);font:13px var(--vscode-font-family)}
#layout{display:grid;grid-template-columns:230px minmax(420px,1fr) 260px;height:100vh}.pane{border-right:1px solid var(--vscode-panel-border);overflow:auto;padding:10px}.pane:last-child{border:0}
h2{font-size:12px;text-transform:uppercase;color:var(--vscode-descriptionForeground)}button,.item{display:block;width:100%;text-align:left;padding:6px;margin:2px 0;border:0;color:inherit;background:transparent}.item:hover,button:hover{background:var(--vscode-list-hoverBackground)}
.active{background:var(--vscode-list-activeSelectionBackground)!important;color:var(--vscode-list-activeSelectionForeground)}#tabs{display:flex;gap:4px;border-bottom:1px solid var(--vscode-panel-border);padding-bottom:8px}#tabs button{width:auto}.editor{padding:12px}.network{min-height:240px;border:1px dashed var(--vscode-panel-border);display:flex;gap:24px;align-items:flex-start;padding:20px}.node,.step{border:1px solid var(--vscode-focusBorder);padding:10px;background:var(--vscode-editorWidget-background)}textarea{box-sizing:border-box;width:100%;min-height:260px;color:var(--vscode-input-foreground);background:var(--vscode-input-background);border:1px solid var(--vscode-input-border);font-family:var(--vscode-editor-font-family)}#interface{min-height:120px}.badge{font-size:10px;opacity:.7;margin-left:6px}.error{color:var(--vscode-errorForeground);white-space:pre-wrap}
</style></head><body><div id="layout"><aside class="pane"><h2>IEC Explorer</h2><div id="explorer"></div></aside><main class="pane"><div id="tabs"></div><div id="editor" class="editor"></div></main><aside class="pane"><h2>Block browser</h2><input id="search" placeholder="Search POUs"/><div id="browser"></div></aside></div>
<script nonce="${token}">
const vscode=acquireVsCodeApi();let payload;let activeId=vscode.getState()?.activeId;
const el=id=>document.getElementById(id);const escape=s=>String(s??'').replace(/[&<>\"]/g,c=>({'&':'&amp;','<':'&lt;','>':'&gt;','\"':'&quot;'}[c]));
function select(id){activeId=id;vscode.setState({activeId});render()}
function add(lang){const name=prompt('POU name');if(!name)return;const kind=prompt('Kind: program, function or functionBlock','functionBlock');if(!kind)return;vscode.postMessage({type:'addPou',name,kind,language:lang})}
function insert(id){if(activeId)vscode.postMessage({type:'insertReference',callerPouId:activeId,targetPouId:id})}
function render(){if(!payload)return;const p=payload.project;if(!p.pous.some(x=>x.pouId===activeId))activeId=p.pous[0]?.pouId;const active=p.pous.find(x=>x.pouId===activeId);
 const groups=[['Functions','function'],['Function Blocks','functionBlock'],['Programs','program']];el('explorer').innerHTML=groups.map(([label,kind])=>'<h2>'+label+'</h2>'+p.pous.filter(x=>x.kind===kind).map(x=>'<button class="'+(x.pouId===activeId?'active':'')+'" data-select="'+escape(x.pouId)+'">'+escape(x.name)+' <span class="badge">'+x.implementation.language.toUpperCase()+'</span></button>').join('')).join('');
 el('explorer').querySelectorAll('[data-select]').forEach(x=>x.onclick=()=>select(x.dataset.select));
 el('tabs').innerHTML=['ld','fbd','st','sfc','il'].map(lang=>'<button class="'+(active?.implementation.language===lang?'active':'')+'" data-add="'+lang+'">'+lang.toUpperCase()+' ＋</button>').join('');el('tabs').querySelectorAll('[data-add]').forEach(x=>x.onclick=()=>add(x.dataset.add));
 const query=el('search').value.toLowerCase();el('browser').innerHTML=payload.symbols.filter(x=>x.kind!=='program'&&x.qualifiedName.toLowerCase().includes(query)).map(x=>'<button draggable="true" data-insert="'+escape(x.pouId)+'">'+escape(x.qualifiedName)+' <span class="badge">'+escape(x.kind)+(x.extensible?' · variadic':'')+'</span></button>').join('');el('browser').querySelectorAll('[data-insert]').forEach(x=>{x.onclick=()=>insert(x.dataset.insert);x.ondragstart=e=>e.dataTransfer.setData('text/pou-id',x.dataset.insert)});
 const out=el('editor');if(!active){out.innerHTML='<p>Create a POU from one of the language tabs.</p>';return}const b=active.implementation;let body='';if(b.language==='st'||b.language==='il')body='<textarea id="code">'+escape(b.text)+'</textarea>';else if(b.language==='sfc')body='<div class="network">'+b.steps.map(s=>'<div class="step"><b>'+escape(s.name)+'</b>'+s.actions.map(a=>'<div>→ '+escape(a.instanceName||a.text||a.referencedPouId)+'</div>').join('')+'</div>').join('')+'</div>';else body=b.networks.map(n=>'<div class="network">'+n.nodes.map(x=>'<div class="node"><b>'+escape(x.kind)+'</b><div>'+escape(x.symbol||x.instanceName||x.referencedPouId||x.nodeId)+'</div></div>').join('')+'</div>').join('');
 out.innerHTML='<h1>'+escape(active.name)+' <span class="badge">'+b.language.toUpperCase()+'</span></h1>'+body+'<h2>Interface</h2><textarea id="interface">'+escape(JSON.stringify(active.interface,null,2))+'</textarea>';
 out.ondragover=e=>e.preventDefault();out.ondrop=e=>{e.preventDefault();insert(e.dataTransfer.getData('text/pou-id'))};const code=el('code');if(code)code.onchange=()=>vscode.postMessage({type:'updateText',pouId:active.pouId,text:code.value});el('interface').onchange=()=>{try{vscode.postMessage({type:'updateInterface',pouId:active.pouId,value:JSON.parse(el('interface').value)})}catch(e){alert(e.message)}};
}
el('search').oninput=render;window.addEventListener('message',event=>{if(event.data.type==='project'){payload=event.data;render()}else if(event.data.type==='error')el('editor').innerHTML='<div class="error">'+escape(event.data.message)+'</div>'});vscode.postMessage({type:'ready'});
</script></body></html>`;
  }
}
