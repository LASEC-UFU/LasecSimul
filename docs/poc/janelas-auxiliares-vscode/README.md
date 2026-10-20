# PoC — janelas auxiliares do VS Code para a Tela HMI

Experimento descartável que sustenta as decisões de janela de
[`61-unificacao-visual-janelas-dock-tela-cheia.md`](../../61-unificacao-visual-janelas-dock-tela-cheia.md).
Não é código de produto: nada daqui é empacotado na extensão.

Executado em 2026-10-19 nesta máquina (Windows Server 2025, **dois monitores** a 96 DPI: `DISPLAY2` principal
1920×1080 em (0,0) e `DISPLAY1` 1366×768 em (−1366,0)) contra o VS Code **1.128.0** (build de teste em
`extension/.vscode-test`, a mesma usada pelos E2E) e o VS Code **1.141.0** instalado, sempre numa instância separada
com perfil temporário. As quatro primeiras rodadas ficaram no monitor principal; a rodada `SPIKE_SCENARIO=monitor`
leva a janela ao monitor secundário.

## O que roda

| Arquivo | Papel |
|---|---|
| `spike-ext/` | extensão mínima: cria um `WebviewPanel`, move-o para janela auxiliar, alterna tela cheia, modo compacto, devolve à janela principal e grava tudo em `log.jsonl` |
| `spike-driver.cjs` | sobe o VS Code com `--remote-debugging-port`, segue as fases do log, tira capturas e faz o clique confiável (CDP) no botão da Webview |
| `winctl.ps1` | maximiza/minimiza/restaura/move janelas pelo Win32 (`ShowWindow`, `SetWindowPos`), porque o Electron não implementa `Browser.getWindowForTarget` no CDP |
| `summarize.cjs` | resume uma execução |
| `evidencias/` | resumos das cinco execuções e quatro capturas |

```powershell
# a partir da raiz do repositório; o primeiro argumento é o Code.exe a testar
node docs/poc/janelas-auxiliares-vscode/spike-driver.cjs "extension/.vscode-test/vscode-win32-x64-archive-1.128.0/Code.exe" "$env:TEMP/spike-1128" "docs/poc/janelas-auxiliares-vscode/spike-ext" "extension/node_modules/@playwright/test"
# quinto argumento opcional: settings.json do perfil temporário, ex. '{"window.customTitleBarVisibility":"windowed"}'
# cenário de dois monitores (move a janela para x = -1266 pelo Win32): $env:SPIKE_SCENARIO = "monitor" antes de rodar
node docs/poc/janelas-auxiliares-vscode/summarize.cjs "$env:TEMP/spike-1128"
```

A execução abre uma janela do VS Code na sessão do usuário e coloca uma janela em tela cheia por
alguns segundos; avise quem estiver usando a máquina.

## Resultados (iguais em 1.128 e 1.141 salvo indicação)

| # | Pergunta | Resultado | Evidência |
|---|---|---|---|
| 1 | Os comandos `moveEditorToNewWindow`, `copyEditorToNewWindow`, `restoreEditorsToMainWindow`, `toggleFullScreen`, `enable/toggleCompactAuxiliaryWindow`, `newEmptyEditorWindow`, `toggleWindowAlwaysOnTop` existem para `executeCommand`? | sim, todos (`vscode.commands.getCommands(true)`) | `commands` |
| 2 | Um `WebviewPanel` pode ir para uma janela auxiliar por código? | sim: `panel.reveal()` + `workbench.action.moveEditorToNewWindow` | `undocked` |
| 3 | O contexto JS da Webview sobrevive à troca de janela? | **não**: a Webview é recriada (contador de boot 1→2 a cada troca), mesmo com `retainContextWhenHidden`; `vscode.getState()` é preservado | `webview:ready boots=N` |
| 4 | A janela auxiliar é uma página separada? | sim, `about:blank` aberta por `window.open` do renderer principal (mesmo Extension Host) | `pages:undocked` |
| 5 | `ViewColumn` / `tabGroups` enxergam a janela auxiliar? | sim: o grupo dela aparece como `viewColumn: 2`; `panel.viewColumn` passa a 2 | `undocked`, `tabGroupsChanged` |
| 6 | `workbench.action.toggleFullScreen` age na janela auxiliar? | sim, na janela **focada**: 1040×776 → 1920×1080 em (0,0); ao sair volta aos mesmos limites | `fullscreen-on/off` |
| 7 | Sobra moldura em tela cheia? | normal: 92 px (título + abas + status); compacta: **30 px** (faixa de título); compacta + `window.customTitleBarVisibility: "windowed"`: **0 px** (Webview 1920×1080) | `compact-fullscreen`, capturas |
| 8 | `element.requestFullscreen()` dentro da Webview? | **recusado**: `TypeError: Disallowed by permissions policy`; `document.fullscreenEnabled === false` | `requestFullscreenResult` |
| 9 | Maximizada → tela cheia → sair volta maximizada? | sim (`IsZoomed=True`, 1920×1032) | `auxStateAfterFullscreenOff` |
| 10 | Com a janela principal minimizada a Webview auxiliar continua viva? | sim: `visibilityState = visible`, 50/50 mensagens entregues | `webview:ticks` |
| 11 | Voltar à janela principal pela API pública? | sim: `panel.reveal(ViewColumn.One)`; a janela auxiliar fecha sozinha ao ficar vazia | `dockedByReveal`, `pages=1` |
| 12 | E por comando? | `workbench.action.restoreEditorsToMainWindow` também funciona (move **todos** os editores da janela focada) | `dockedByRestore` |
| 13 | Criar um painel direto na janela auxiliar? | sim: `ViewColumn.Active` com a janela auxiliar ativa abre o painel nela | `secondPanelActiveColumn` |
| 14 | A Webview sabe em qual janela está? | sim, indiretamente: `window.screenX/Y`, `outerWidth/Height` e `innerWidth/Height` dentro da Webview refletem a janela do SO que a hospeda | todas as medições |
| 15 | Tela cheia com a janela no monitor secundário (1366×768)? | Webview **1366×768 em (−1366,0)**, janela principal intacta (1.141) | `v1141-dois-monitores.log.txt`, captura |
| 16 | Sair da tela cheia no secundário | volta à posição anterior no secundário; maximizada → tela cheia → sair volta maximizada no secundário | idem |
| 17 | Janela entre os dois monitores (700 px / 300 px) → tela cheia | vai para o monitor com a maior parte da janela | idem |
| 18 | Dock e Undock de novo: onde nasce a janela? | na posição padrão do monitor **principal** (440,160): a posição no secundário se perde | idem |
| 19 | `screen.*` dentro da Webview | acompanha o monitor da janela (1920×1080 → 1366×768, `availLeft −1366`) | idem |

Observações:

- logo após a recriação, a primeira medição pode trazer `innerHeight = 0` (visto no 1.141); o layout
  deve esperar o primeiro `resize` com tamanho não nulo antes de "ajustar à janela";
- em tela cheia vinda do estado maximizado o Windows reporta `outer = 1904×1064` em (8,8), mas
  `inner` cobre a tela inteira: a detecção de estado deve usar `inner*` contra `screen.*`;
- mover a janela com `SetWindowPos` de outro processo deixou a altura em 65535 fora da tela cheia (artefato do
  experimento; as medições em tela cheia e maximizada são exatas; o arraste pelo usuário não passa por esse caminho);
- os dois monitores têm 96 DPI: o comportamento com DPI diferente entre monitores **não foi verificado**;
- uma versão anterior deste README dizia que havia um só monitor: a conclusão tinha sido tirada de `screen.*` medido com a
  janela no monitor principal, e estava errada.
