# OpenPLC Editor dentro do LasecSimul

Arquivos que o LasecSimul acrescenta ao código oficial do OpenPLC Editor (tag e commit em
`scripts/openplc-workspace-pin.json`) para rodar o frontend dele numa aba do VS Code. O código do
OpenPLC não fica neste repositório: `scripts/build-openplc-workspace.js` clona a tag, copia esta
pasta `overlay/` para `src/lasecsimul/` e gera `extension/media/openplc-workspace/`.

| Arquivo | Papel |
| --- | --- |
| `overlay/webview/bridge.ts` | `window.bridge` do OpenPLC sobre `postMessage` da Webview |
| `overlay/webview/ports.ts` | Portas da plataforma: adaptadores do próprio OpenPLC + compilação, depurador, runtime e placa do LasecSimul |
| `overlay/webview/main.tsx`, `app-layout.tsx` | Entrada da Webview: WorkspaceScreen do OpenPLC sem a barra de título/tela inicial do Electron |
| `overlay/webview/workers.ts` | Workers (Monaco, LSP da STruC++) criados a partir do texto do script |
| `overlay/host/index.ts`, `electron-shim.ts` | Pacote do host: leitura/criação de projeto, LibraryManagerModule, importar/exportar pasta e transpilador do OpenPLC |
| `overlay/shared/transpile.ts` | Projeto OpenPLC -> ST e programa de entrada (pinos do bloco CLP) |
| `overlay/shared/sfc.ts` | Corpo dos POUs SFC (mesmos campos do modelo SFC do LasecSimul + posições), layout automático |
| `overlay/shared/function-temp-types.ts` | Tipo da saída de funções genéricas (ADD, MUL...) no LD/FBD, que o transpilador do OpenPLC deixa BOOL |
| `overlay/host/legacy.ts` | Projeto IEC antigo (`*.iec.json`) -> projeto OpenPLC; LD em grade montado com as funções do editor LD |
| `overlay/webview/sfc/` | Editor SFC (no lugar do stub do OpenPLC) e a barra de ferramentas SFC |
| `overlay/patch-loader.cjs` | Os ajustes no código do OpenPLC (capacidades, menu de POU, SFC, tipo de saída de função), aplicados no empacotamento |
| `overlay/webpack.*.cjs` | Configurações de empacotamento (Webview e host) |

Descrição completa, decisões e testes: `docs/49-editor-openplc.md`.
