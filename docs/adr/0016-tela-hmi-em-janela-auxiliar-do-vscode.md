# ADR 0016 - Tela HMI acoplável em janela auxiliar do VS Code, com tela cheia real

## Objetivo

Escolher como uma Tela HMI (e as demais superfícies visuais do LasecSimul) sai da área de editores do VS Code para uma
janela própria, movível entre monitores, maximizável e em tela cheia verdadeira, e volta, sem duplicar documento nem simulação.

## Status

Aceita e implementada (2026-10-20): `extension/src/visual/visualPanels.ts` e `extension/src/ui/panels/VisualPanel.ts`;
relatório e medições em [docs/65](../65-unificacao-visual-implementacao.md). Proposta em 2026-10-19; análise em [`docs/61`](../61-unificacao-visual-janelas-dock-tela-cheia.md); evidência em
[`docs/poc/janelas-auxiliares-vscode/`](../poc/janelas-auxiliares-vscode/README.md).

## Contexto

- A API pública não abre editores em nova janela nem lê/escreve limites de janela; `WindowState` só tem `focused`/`active`.
- O VS Code tem janelas auxiliares de editor ("janelas flutuantes") que compartilham o Extension Host da janela principal. Os
  comandos `workbench.action.moveEditorToNewWindow`, `toggleFullScreen`, `enableCompactAuxiliaryWindow` e
  `restoreEditorsToMainWindow` existem e funcionam com `WebviewPanel` no 1.128 e no 1.141 (verificado por execução).
- `element.requestFullscreen()` dentro de Webview é recusado pela política de permissões do *iframe* (verificado).
- Com dois monitores (principal 1920×1080 e secundário 1366×768), a tela cheia ocorre no monitor que contém a janela
  (ou a maior parte dela), e ao sair a janela volta à posição/maximização anterior no mesmo monitor (verificado). Uma
  janela auxiliar nova sempre nasce no monitor principal, mesmo depois de Dock + Undock (verificado).
- A troca de janela recria a Webview (contexto JS novo; `vscode.getState()` preservado).
- A *Agents Window* é uma janela de workbench de nível superior, com Extension Host próprio: hospedar a HMI ali criaria
  uma segunda instância da extensão e do Core.

## Decisão

- A Tela HMI é um `WebviewPanel` (`lasecsimul.visual`). **Undock** = `panel.reveal` + `moveEditorToNewWindow` + modo
  compacto. **Dock** = `panel.reveal(coluna)` (API pública). O gesto manual de destacar a aba é tratado igual.
- **Tela cheia** = `toggleFullScreen` com a janela da tela focada; vista acoplada faz Undock antes e Dock ao sair.
  Sem moldura nenhuma mediante consentimento para `window.customTitleBarVisibility: "windowed"`.
- Estado de janela é **detectado** pela geometria reportada pela Webview (`inner*` × `screen.*`), não comandado.
- Edição funciona na janela flutuante: paleta roteada pelo Host à vista ativa em edição e gaveta de paleta local.
- Recursos dependentes de comandos do workbench são habilitados por *feature detection*; sem eles, a tela continua
  acoplada e a ação some do menu.
- `registerWebviewPanelSerializer` + `onWebviewPanel:lasecsimul.visual` para voltar após recarregar o VS Code.

## Consequências

- Nenhuma dependência nova, nenhuma porta de rede, funciona em desenvolvimento remoto.
- Dependência de IDs de comandos do workbench (não contratuais): coberta por E2E em duas versões.
- Toda vista visual precisa ser reconstruível (estado no Host — ADR 0018).
- Sem API para escolher o monitor: cada janela auxiliar nova nasce no monitor principal; o VS Code só lembra a posição
  das janelas auxiliares restauradas com a área de trabalho. Por isso a edição na janela flutuante é o fluxo preferido
  (evita ciclos Dock/Undock que trazem a tela de volta ao monitor principal).
- Escolha programática de monitor (quiosque) fica para uma alternativa futura com navegador e servidor local.
