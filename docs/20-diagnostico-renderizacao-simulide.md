<!-- Gerado a partir de render-diagnostic.html em 2026-07-04. -->

_LasecSimul · Análise técnica v2_

# Diagnóstico de Renderização e Interação

Plano fundido: diagnóstico do SimulIDE-dev + análise LasecSimul. Cobre todos os dispositivos. Decisões arquiteturais assumidas marcadas em ◆.

## Sumário executivo

O SimulIDE usa **paint() por componente em C++/Qt** — cada device tem sua própria classe, widgets nativos embutidos (`JoystickWidget`, `CustomDial`, `UpDoButton`, `CustomSlider`, `TouchPadWidget`) e eventos Qt locais (`mousePressEvent`/`mouseMoveEvent`/`mouseReleaseEvent`/`paintEvent`). O LasecSimul usa uma **pipeline declarativa genérica** (JSON shapes → SVG estático) sem modelo formal de partes interativas.

Havia um **bug zero** confirmado: o KY-040 não tinha nenhum elemento com `encoder-hit-zone`, então o handler da roda do mouse filtrava por essa classe e retornava sem fazer nada. A correção esperada é manter o knob/indicador do KY-040 declarados como `encoder-hit-zone`.

O caminho correto para os demais componentes é introduzir uma **camada `ComponentViewSpec`** por typeId — partes nomeadas, hitTest explícito, limites, stateProjection e tipos formais de interação — em vez de continuar extendendo o sistema de shapes genérico que não foi desenhado para isso.

**Versão mais forte adotada neste plano:** P0 corrige os bugs visíveis, P1 estabiliza o render, P2 cria `ComponentViewSpec`, e só depois os componentes são reescritos em massa com identidade SimulIDE real.

**Decisões assumidas pelo projeto:** usar `ViewSpec` completo; implementar o KY-040 com arraste angular fiel ao SimulIDE; reutilizar assets de imagem do SimulIDE, aceitando as implicações de licença GPL.

> **Pré-requisito inegociável:** a reconciliação incremental do render (`createComponentElement` / `updateComponentElement` + Map keyed por id) deve entrar _antes_ de qualquer interação nova. Hoje `render()` faz `app.innerHTML = ""` a cada telemetria (~300ms), destruindo qualquer elemento sendo arrastado. Toda interação futura sofre esse bug enquanto ele não for corrigido.

## P0 — Correções visíveis imediatas **[Implementado parcialmente]**

### P0.1 — KY-040: encoder-hit-zone ausente

O handler em `main.ts:3081` faz `event.target.closest(".encoder-hit-zone")`. O `ky040.json` deve manter a ellipse do knob (`rx=13`) e o ponto indicador com essa classe, para que clicar no knob ou no indicador inicie a interação.

```json
// ky040.json — linha 36 — ellipse do knob (rx=13)
// ANTES:
{ "kind": "ellipse", "cx": 20, "cy": 20, "rx": 13, "ry": 13,
  "stroke": "none", "fill": "url(#ky040-knob)", "strokeWidth": 0 }

// DEPOIS:
{ "kind": "ellipse", "cx": 20, "cy": 20, "rx": 13, "ry": 13,
  "stroke": "none", "fill": "url(#ky040-knob)", "strokeWidth": 0,
  "cssClass": "encoder-hit-zone" }
```

### P0.2 — Gradient IDs colidem em múltiplas instâncias

Dois KY-040 na mesma canvas geram dois `<defs id="ky040-knob">`. Mesma definição funciona, mas é frágil. Solução definitiva está na P2 (IDs escopados por componentId). Por ora, documentar como risco known.

### P0.3 — Validar path interactionKind manifest → webview

Não existe teste confirmando que `interaction: "encoder"` no JSON do manifesto chega como `catalogInteractionKind === "encoder"` na webview. Adicionar um teste antes de qualquer implementação nova de interação.

## Lacuna arquitetural

### SimulIDE (referência)

- **paint(QPainter)** por componente — imperativo, stateful

- Widgets Qt nativos: `JoystickWidget`, `CustomDial`, `CustomSlider`, `UpDoButton`, `TouchPadWidget`, `CustomButton`

- Hit-test por shape() / boundingRect() — nativo, preciso

- Eventos Qt locais: `mousePressEvent`, `mouseMoveEvent`, `mouseReleaseEvent`, `paintEvent`, `eventFilter`

- Estado visual = estado elétrico (LED TX muda cor no mesmo paint())

- Imagens PNG/SVG via drawPixmap() do filesystem local

- Quadratura do encoder: timing entre bordas CLK/DT calculado na sim

### LasecSimul (atual)

- **packageShapeSvg()** genérico, declarativo, estático

- Sem partes nomeadas — só shapes anônimos + cssClass

- Hit-test: `element.closest(cssClass)` — depende de CSS, não de geometria

- Eventos: pointer handlers em main.ts, acoplados a typeId específicos

- Estado visual não é refletido — SVG é constante entre renders

- Sem imagens de fundo (CSP bloqueia URL externa)

- render() = innerHTML="" toda telemetria — mata drag em andamento

> **Por que a lacuna existe (e não é um erro de design):** SimulIDE é um processo único Qt — `paint()` do device e o canvas estão no mesmo processo/linguagem. LasecSimul separa Core (C++, DLL, IPC) de UI (webview, TypeScript). Um device não pode chamar `paint()` através de IPC — metadados declarativos são a única ponte. O que precisa mudar é a _expressividade_ do que é declarado: de "shapes genéricos" para "specs de componente com partes, limites e interações formais".

## Divergências por componente

- **[Crítico]** sem interação real
- **[Visual]** apenas visual errado
- **[OK]** adequado
- **[Testar]** implementado, não validado

| Componente                                    | SimulIDE (referência)                                                                                                                            | LasecSimul (atual)                                                                                                                          | Bug principal                                                         | Status           |
| --------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------- | ---------------- |
| KY-023                                        | JoystickWidget 50×50. Drag XY, clamp radial, returnToCenter. SW momentário. Hit-test: clique perto do atuador central (`joystickwidget.cpp:81`). | Bowl + thumbstick gradiente. joystick-hit-zone na ellipse rx=10. setPointerCapture + isDraggingComponent corrigidos.                        | P0.3: validar path interactionKind. Visualmente ok.                   | **[Testar]**     |
| KY-040                                        | CustomDial 36×36. Arraste angular horário/anti-horário. 20 notches, wrap, steps. SW momentário.                                                  | `viewSpec` com knob/indicador, `encoder-hit-zone` e `encoder-indicator`. Wheel existe; arraste angular foi assumido como UX final.           | Validar manualmente arraste angular, wheel e SW.                       | **[Testar]**     |
| TouchPad                                      | TouchPadWidget. Press/move/release → X/Y resistivos. Reset ao soltar. `touchpad.cpp:31`                                                          | Tipo touchpad existe em model.ts. Handler específico: não localizado.                                                                       | Handler de interação ausente.                                         | **[Crítico]**    |
| SR04                                          | sr04.svg background (168×72) + CustomSlider 0–400cm. `sr04.cpp:30`                                                                               | Shapes estáticos. Sem SVG de fundo. Sem slider.                                                                                             | Sem interaction kind "slider".                                        | **[Crítico]**    |
| DHT22                                         | dht22.svg background (36×46) + 4× UpDoButton (temp ▲▼, umidade ▲▼). `dht22.cpp:30`                                                               | Shapes estáticos. Sem SVG. Sem botões.                                                                                                      | Sem interaction kind "updown".                                        | **[Crítico]**    |
| DS18B20                                       | 2× UpDoButton (temp ▲▼). `ds18b20.cpp:33`                                                                                                        | Shapes estáticos. Sem botões.                                                                                                               | Sem interaction kind "updown".                                        | **[Crítico]**    |
| DS1621                                        | 2× UpDoButton (temp ▲▼). `ds1621.cpp:33`                                                                                                         | Shapes estáticos. Sem botões.                                                                                                               | Sem interaction kind "updown".                                        | **[Crítico]**    |
| SerialTerm                                    | LEDs TX/RX dinâmicos + CustomButton "Open/Close" 44×20. `serialterm.cpp:38`                                                                      | Shapes estáticos. Sem botão. LEDs não reagem.                                                                                               | Sem stateProjection. Sem botão "Open".                                | **[Visual]**     |
| SerialPort                                    | LEDs TX/RX: preto→vermelho→amarelo conforme estado. `serialport.cpp:36`                                                                          | 5 rects estáticos. LEDs não mudam.                                                                                                          | Sem stateProjection de fill.                                          | **[Visual]**     |
| SDCard                                        | QPainterPath chanfrado + LED verde (mounted). `sdcard.cpp:34`                                                                                    | polygon + texto. Sem indicador de estado.                                                                                                   | Sem path kind. Sem stateProjection.                                   | **[Visual]**     |
| ESP-01                                        | esp01.png background (PCB ESP8266). `esp01.cpp:32`                                                                                               | 1 rect. Sem imagem. Divergência visual/pinos em alguns descritores.                                                                         | Sem image kind. Verificar pinos.                                      | **[Visual]**     |
| DS1307                                        | dsxxx.png background PCB. `ds1307.cpp:24`                                                                                                        | SVG shapes PCB redesenhados manualmente.                                                                                                    | Adequado.                                                             | **[OK]**         |
| simulide-logic / simulide-complex (40+ tipos) | paint() por tipo, símbolos específicos.                                                                                                          | Muitos dependem de fallback genérico. Comparação pixel-a-pixel: não feita.                                                                  | Inventário necessário antes da reescrita em massa.                    | **[Inventário]** |

## Arquitetura proposta

- .lsdevice:
**viewSpec**
— partes + limites

→

- componentSymbols.ts:
**ViewSpecRenderer**
— SVG por parte

→

- main.ts:
**InteractionEngine**
— hitTest formal

→

- Core IPC:
**property update**
— + visual sync

Em vez de continuar extendendo `shapes[]` genérico com mais kinds e cssClasses, introduzir um campo opcional `"viewSpec"` por manifesto de device. Quando presente, o renderer usa a spec ao invés dos shapes genéricos. Componentes sem viewSpec continuam usando o sistema atual — compatibilidade total, migração incremental.

### 3.1 — ComponentViewSpec

Schema formal por typeId, derivado do modelo paint()+widget do SimulIDE:

- **paint**:
Comandos vetoriais: retângulos, elipses, paths, textos, imagens (data URI). Equivalente a QPainter — sem gradiente raw SVG, gradientes são declarados aqui com tipo (radial/linear), pontos e stops.

- **parts**:
Peças nomeadas com geometria própria: `thumbstick`, `dial`, `button`, `sliderThumb`, `touchSurface`. Cada parte tem shape, posição inicial e cssClass automático (não manual).

- **hitTest**:
Regiões locais explícitas por parte — não depende de `.closest()` em CSS. Tipos: `circle(cx, cy, r)`, `rect(x, y, w, h)`, `angular(cx, cy)`. O engine testa coordenada local antes de despachar.

- **interaction**:
Tipo formal por parte: `dragVector` (XY livre), `angularDrag` (encoder), `linearDrag` (slider), `momentaryButton`, `toggleButton`, `touchSurface` (XY normalizado).

- **limits**:
Clamp radial (joystick), min/max linear (slider), steps/wrap (encoder), snap-to-notch, returnToCenter ao soltar. Declarado por parte — o engine aplica sem código específico de device.

- **stateProjection**:
Mapeia propriedades elétricas → transformações visuais: `position → rotate(dial)`, `x_pos/y_pos → translate(thumbstick)`, `tx_active → fill(ledTx)`. Atualizado em todo render sem reconstruir o DOM.

### Exemplo: KY-023 em ComponentViewSpec

```json
"viewSpec": {
  "paint": [
    { "kind": "rect", "x": 0, "y": 0, "w": 40, "h": 56, "fill": "#3A3C34" },
    { "kind": "radialGradient", "id": "bowl",
      "cx": 17, "cy": 17, "r": 22, "fx": -2, "fy": -2,
      "stops": [{"at": 0, "color": "#646464"}, {"at": 1, "color": "#000"}] },
    { "kind": "ellipse", "cx": 20, "cy": 20, "rx": 17, "fill": "gradient:bowl" }
  ],
  "parts": {
    "thumbstick": {
      "shape": { "kind": "ellipse", "rx": 10 },
      "origin": { "cx": 20, "cy": 20 },
      "paint": { "kind": "radialGradient", "id": "stick", ... }
    },
    "sw": { "shape": { "kind": "rect", "x": 26, "y": 41, "w": 10, "h": 6 } }
  },
  "hitTest": {
    "thumbstick": { "kind": "circle", "cx": 20, "cy": 20, "r": 10 },
    "sw":         { "kind": "rect",   "x": 26, "y": 41, "w": 10, "h": 6 }
  },
  "interaction": {
    "thumbstick": { "kind": "dragVector", "property": ["x_pos", "y_pos"],
                    "range": [0, 1023], "center": 512 },
    "sw":         { "kind": "momentaryButton", "property": "sw_pressed" }
  },
  "limits": {
    "thumbstick": { "clampRadial": 7, "returnToCenter": true }
  },
  "stateProjection": {
    "thumbstick": "translate(x_pos→-7..7, y_pos→-7..7)"
  }
}
```

> **Encoder — nota sobre timing quadratura:** `customdial.cpp` gira visualmente e gera CLK/DT em quadratura com delay entre bordas calculado pela simulação. No LasecSimul, o Core já cuida disso ao receber `position +=1` via IPC — o engine de interação envia apenas o delta, não gera a quadratura. A spec só precisa declarar `"kind": "angularDrag"` + `"steps"` + `"wrap": true`.

### 3.2 — Render incremental (pré-requisito)

Antes de qualquer ViewSpec, o render deve ser incremental. A separação:

- **`createComponentElement(component)`** — cria wrapper + registra listeners. Roda 1× por componente. Listeners capturam referência viva ao objeto `component`.

- **`updateComponentElement(el, component)`** — aplica `stateProjection`, reposiciona, atualiza SVG interno. Roda a cada telemetria. Nunca toca listeners.

- **`Map`** keyed por componentId — cria se novo, atualiza se existe, remove se sumiu de `state.components`. Nunca mais `app.innerHTML = ""`.

## Plano de execução

### P0

**Correções visíveis imediatas**

Corrigir os bugs que impedem validação visual e interativa agora: manter `"cssClass":"encoder-hit-zone"` no KY-040, testar KY-023 manualmente (drag, spring-back, SW), validar que `interaction:"encoder"` chega como `catalogInteractionKind` na webview, e documentar o risco de IDs de gradiente duplicados até o P2 resolver por componentId.

### P1

**Estabilizar o render**

Separar `createComponentElement` / `updateComponentElement`. `Map<string, HTMLElement>` keyed por componentId. Nunca mais `innerHTML=""` na camada de componentes. Testar manualmente TODAS as interações existentes: arrastar, popup instrumento, overlay Modo Placa, menus, seleção múltipla, copiar/colar.

### ◆ D1

**Decisão assumida: escopo arquitetural**

Usar `ComponentViewSpec` completo, não apenas extensão incremental de `shapes[]`. Ver seção "Decisões assumidas".

### P2

**Criar `ComponentViewSpec` + renderer experimental (feature flag)**

Definir o schema `ComponentViewSpec` em `model.ts`. Implementar `ViewSpecRenderer` em `componentSymbols.ts` — ativado apenas quando `viewSpec` está presente no manifesto. Portar KY-023 como primeiro caso de uso. Gradientes declarados na spec (não SVG raw). IDs de gradiente escopados por componentId automaticamente. Nenhum device existente quebra — fallback para shapes[] quando viewSpec ausente.

### P3

**Reescrita em massa, etapa 1: inventário e interativos críticos**

Criar a tabela completa `typeId → classe SimulIDE → paint → widgets → assets → pins`. Em seguida migrar os interativos que provam a arquitetura: KY-023, KY-040 com `angularDrag`, TouchPad, SR04 com `linearDrag`, DHT22, DS18B20 e DS1621 com botões `momentaryButton`/up-down.

### P4

**Reescrita em massa, etapa 2: assets, imagens e estado visual**

Migrar componentes com imagem/pixmap e estado visual: ESP-01, DS1307, SR04, DHT22, SerialPort, SerialTerm e SDCard. Usar `image`, `path`, gradientes declarados e `stateProjection` para LEDs, botão Open/Close, mounted/ejected e leituras visuais.

### P5

**Reescrita em massa, etapa 3: lógicos, complexos, displays, ativos e passivos**

Portar os componentes que hoje dependem de fallback genérico ou desenho aproximado, priorizando leituras visuais e displays: voltímetro, amperímetro, osciloscópio/logic analyzer quando aplicável, displays gráficos, displays de 7 segmentos, portas lógicas, ativos e passivos divergentes.

### P6

**Regressão visual automatizada + remoção do renderer antigo**

Screenshots de referência para todos os componentes portados. Playwright para interações. Remover código morto do renderer de shapes[] para typeIds que já têm viewSpec. Não remover o sistema de shapes[] em si — devices sem viewSpec continuam funcionando.

## Riscos

### render() destrói elemento mid-drag (P1 não implementado) **[Alto]**

Enquanto P1 não entrar, toda interação nova sofre o mesmo bug 2 que afetou KY-023. O guard `isDraggingComponent` mitiga mas não elimina — qualquer código que chame `render()` diretamente pode quebrar o drag. **Bloqueador para P2+.**

### Gradient IDs colidem com múltiplas instâncias **[Alto]**

Dois KY-040 geram dois `<defs id="ky040-knob">`. Corrigido em P2 com IDs escopados por componentId gerado no renderer. Até lá, second instance usa o gradiente da primeira — funciona por acidente enquanto as defs são idênticas.

### Licença e atribuição de assets SimulIDE **[Alto]**

Decisão assumida: reutilizar assets de imagem do SimulIDE. Isso implica tratar o projeto/distribuição como compatível com GPL e manter atribuição/licença de forma explícita. Antes de distribuir builds, documentar origem dos assets (`esp01.png`, `dsxxx.png`, `sr04.svg`, `dht22.svg` etc.) e garantir conformidade GPL.

### Coordenadas Qt → SVG/browser **[Médio]**

Qt usa centro do componente como origem e transformações afins diferentes do SVG. KY-023 e KY-040 usam `setAngle(90)` — são desenhados em portrait no código mas rotacionados no canvas. Todo cálculo de posição precisa converter: Qt centro → body-local top-left = Qt + (width/2, height/2).

### ViewSpec é superfície de regressão maior que shapes[] **[Médio]**

Introduzir um sistema paralelo de renderização toca o código mais exercitado da Webview. Mitigação: feature flag — só ativa quando `viewSpec` presente no manifesto. Devices sem viewSpec não são afetados. Testar cada device portado antes do próximo.

### Paridade visual limitada (gradientes, antialiasing) **[Médio]**

QRadialGradient com focal point Qt e SVG radialGradient com fx/fy não são matematicamente idênticos. Antialiasing Qt renderiza diferente de browser. Tolerância visual precisa ser definida — "fiel à intenção" vs. "pixel-perfect".

### Pinos visuais vs. elétricos divergentes (ESP-01) **[Baixo]**

Alguns descritores têm mais pinos elétricos que visuais ou posições divergentes. Verificar durante P3 (inventário da reescrita em massa) e corrigir junto da migração visual do componente.

## Testes necessários

### Unitários (antes de qualquer PR de P2+)

- **ViewSpec schema validation** — schema inválido não quebra o renderer, cai no fallback de shapes[]

- **hitTest geométrico** — coordenada dentro/fora de circle/rect/angular retorna parte correta

- **limits engine** — clampRadial retorna vetor dentro do raio; linearDrag respeita min/max; wrap funciona em encoder

- **stateProjection** — propriedade elétrica → transform/fill é calculada corretamente

- **Gradient ID scoping** — dois KY-040 geram IDs únicos e não colidem

- **interactionKind path** — manifesto com `"interaction":"encoder"` chega como `catalogInteractionKind="encoder"` na webview

### Playwright (E2E)

- **KY-023 drag** — clicar centro, arrastar X/Y, thumbstick permanece dentro do bowl, spring-back ao soltar, x_pos/y_pos voltam a 512

- **KY-023 rápido** — arrastar para fora do elemento sem perder tracking (setPointerCapture)

- **KY-023 mid-telemetry** — drag em andamento + telemetria → thumbstick não pula (reconciliação incremental)

- **KY-040 angular drag** — arrastar horário → position incrementa; anti-horário → decrementa; indicator rotaciona

- **KY-040 scroll** — roda do mouse sobre encoder-hit-zone dispara

- **KY-040 SW button** — clique no rect SW → sw_pressed alterna

- **Múltiplas instâncias** — dois KY-040: cada um rotaciona independentemente

- **SR04 slider** — arrastar → distância 0–400cm em tempo real

- **DHT22 ▲▼** — click ▲ temperatura → temp sobe; click ▲ umidade → umidade sobe

- **TouchPad** — press/drag → x/y enviados ao Core; release → reset

- **SerialPort LED** — transmissão ativa → LED TX muda de preto para amarelo

### Regressão (após P1 — reconciliação)

- Arrastar resistor/capacitor — movimento suave sem jank

- Push button hold sem virar toggle

- Popup osciloscópio abrindo e arrastável

- Overlay Modo Placa arrastável

- Menu de contexto + submenu

- Seleção múltipla (shift+click)

- Copiar/colar componente com posição correta

## Decisões assumidas

Estas decisões já foram escolhidas e devem orientar a implementação.

### Decisão 1 — P2

**Escopo arquitetural: ViewSpec completo**

Escolha assumida: implementar `ComponentViewSpec` completo, com partes nomeadas, hitTest formal, limites físicos, stateProjection e engine de interação. A extensão incremental de `shapes[]` não será a arquitetura principal.

Implementação: introduzir `ComponentViewSpec` como sistema paralelo atrás de feature flag. Migrar devices um a um. `shapes[]` permanece para componentes não migrados.

### Decisão 2 — KY-040 / P3

**Encoder UX: arraste angular fiel ao SimulIDE**

Escolha assumida: o KY-040 deve usar arraste angular ao redor do centro do knob, como o `CustomDial` do SimulIDE. Arrastar horário incrementa, anti-horário decrementa. A roda do mouse pode ser mantida apenas como atalho secundário.

Implementação: calcular o ângulo do cursor em relação ao centro do knob a cada `pointermove`. Delta angular vira delta de `position`; o Core continua responsável pela sequência quadratura.

### Decisão 3 — P4

**Assets de imagem: reusar do SimulIDE, aceitando GPL**

Escolha assumida: reutilizar assets de imagem do SimulIDE para preservar fidelidade visual, aceitando a implicação GPL.

Implementação: importar/empacotar assets como `esp01.png`, `dsxxx.png`, `sr04.svg`, `dht22.svg` e equivalentes, mantendo atribuição, origem, licença e compatibilidade de distribuição.

### Decisão 4 — inventário da reescrita em massa

**Inventário completo em paralelo ou antes da estabilização/render spec?**

O inventário de todos os 40+ typeIds é obrigatório antes da reescrita em massa, mas não precisa bloquear P0, P1 nem P2. Ele pode rodar em paralelo enquanto o render é estabilizado e o `ComponentViewSpec` nasce.

- **A — Inventário em paralelo com P1/P2 [Recomendado]**

O inventário acontece como tarefa de pesquisa/documentação enquanto P1 estabiliza o render e P2 cria o `ComponentViewSpec`. Quando P3 começar, a matriz `typeId → paint → widgets → assets → pins` já deve estar pronta para guiar a reescrita em massa.

- **B — Inventário completo antes de P1/P2**

Garante que nenhuma surpresa aparece antes da implementação, mas atrasa o pré-requisito técnico mais importante: estabilizar o render. Só faz sentido se a equipe quiser congelar qualquer mudança estrutural até terminar a pesquisa completa.
