# 08 - UI Webview

> Nota 2026-07-07: este documento descreve o planejamento inicial do MVP. A UI atual reverteu pontos
> importantes daqui: a paleta é uma Webview própria, não um `TreeView` nativo, e propriedades são
> editadas por diálogo/modal no fluxo atual. Para o estado normativo, ver `.spec/lasecsimul.spec`
> seção 13.

## Objetivo

Definir o editor visual inicial do esquemático.

## Escopo

UI do MVP na Webview — **só o canvas central e o painel de propriedades**. Sem solver, sem QEMU e sem acesso
direto ao Core. Organização geral de painéis segue o SimulIDE-dev real, exceto qualquer área de
digitar/compilar firmware — essa não existe no LasecSimul (compilação é sempre externa, ver
`docs/11-qemu-esp32.md`). Mapeamento completo de painel-a-painel em `lasecsimul.spec`, seção 13.

**Paleta de componentes não é desta Webview.** É um `TreeView` nativo do VSCode (agente 02,
`docs/04-divisao-por-agentes.md`) — reaproveita busca/filtro/ícone nativos em vez de reimplementar dentro da
Webview. Navegador de arquivo e editor/compilador de código também não existem aqui nem em lugar nenhum —
redundante com o Explorer e o próprio editor do VSCode.

## Funcionalidades MVP

- Canvas de esquemático.
- Inserção de componente (vindo da paleta `TreeView`, fora desta Webview).
- Movimentação por drag.
- Criação de fios entre pinos.
- Remoção de componentes e fios.
- Painel de propriedades — **persistente, nunca modal** (SimulIDE usa diálogo modal aqui; decisão deliberada
  de não copiar, ver seção 13 do `.spec`), alimentado por `propertyDescriptors()` de cada componente (seção
  6.1 do `.spec`).
- Serialização do estado visual.
- Mensagens com Extension Host via `postMessage`.

## Modelo de dados visual

Cada item visual deve ter:

- `id` estável;
- `typeId`;
- posição;
- rotação, quando aplicável;
- propriedades editáveis;
- pinos com ids compatíveis com o contrato elétrico;
- fios por pares de endpoints.

## Comunicação

Webview fala apenas com Extension Host. A Extension decide quando converter mudanças em mensagens para `CoreClient`.

## Regras

- O canvas não deve depender de Core rodando para renderizar.
- A UI pode validar schema superficial, mas a validação elétrica fica no Core.
- Não duplicar lógica de netlist na Webview.
- O pacote visual de plugins vem do manifesto, mas o Core só enxerga o contrato elétrico.
