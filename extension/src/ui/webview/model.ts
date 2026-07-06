export interface WebviewPinModel {
  id: string;
  x: number;
  y: number;
}

/** ABI v2 (.spec/lasecsimul-native-devices.spec) -- como a UI decodifica `getComponentState()` de um
 * typeId sem checar typeId em código nenhum: declarado pelo device (built-in: método estático no
 * Core; plugin/DLL: chave `"readout"` em `.lsdevice`), vindo via `getPropertySchemas`. Ausente ==
 * device sem leitura estruturada (válido, não "ainda não migrado"). */
export type ReadoutFormatEntry =
  | { kind: "scalar"; unit: string }
  | { kind: "channelHistory"; channels: number }
  | { kind: "bitmaskHistory"; channels: number };

/** Mesma convenção de `ReadoutFormatEntry`, pra como a UI trata clique/arrasto sem checar typeId. */
export type InteractionKindEntry = "momentary" | "toggle" | "none" | "joystick" | "encoder" | "touchpad";

export interface WebviewComponentModel {
  id: string;
  typeId: string;
  x: number;
  y: number;
  rotation: 0 | 90 | 180 | 270;
  /** Nome com índice por tipo (ex: "Resistor-1", "Resistor-2") — atribuído na criação
   * (`nextIndexedLabel`), editável depois pelo campo "Titulo" do diálogo de propriedades. Igual ao
   * `Component::idLabel()` do SimulIDE, exceto o contador (por tipo aqui, global lá). */
  label: string;
  hidden?: boolean;
  /** Mostra `label` perto do símbolo no canvas. Ausente == `false` (oculto por padrão, igual ao
   * `Component::setShowId(false)` do SimulIDE — ver `componentSystemFlags` em `main.ts`). */
  showId?: boolean;
  /** Mostra o valor formatado da propriedade `showOnSymbol` do typeId (ex: "1 kΩ") perto do símbolo.
   * Ausente == default calculado em runtime (`true` se o typeId tiver uma propriedade
   * `showOnSymbol`, senão `false`) — nunca persistido só pra "ter um valor", ver `componentSystemFlags`. */
  showValue?: boolean;
  /** Espelha o símbolo no eixo horizontal/vertical -- combinado com `rotation`: o flip é aplicado
   * primeiro no espaço local do símbolo, a rotação depois (mesma ordem no CSS `transform` de
   * `main.ts` e no cálculo de posição de pino, ver `flipPoint`/`rotatePoint`). Ausente == `false`. */
  flipH?: boolean;
  flipV?: boolean;
  pins: WebviewPinModel[];
  properties: Record<string, string | number | boolean>;
  /** Posição/orientação na PLACA (Board Mode) — independente de `x`/`y`/`rotation`/`flipH`/`flipV`
   * (posição no CIRCUITO), igual a `circPos`/`boardPos` do SimulIDE real (`SubPackage::
   * setBoardMode()`, `simulide_2/src/components/other/subpackage.cpp`): cada componente tem 2
   * posições independentes, um toggle alterna qual está "ativa" -- mover num modo nunca afeta a
   * posição no outro. Só usado dentro de uma sessão de "Abrir Subcircuito" com Modo Placa
   * (`main.ts::toggleBoardMode`); ausente até o usuário entrar em Modo Placa a primeira vez.
   * Convenção: os campos `x`/`y`/`rotation`/`flipH`/`flipV` de sempre SEMPRE refletem a posição
   * "ativa" no momento (igual ao SimulIDE) -- entrar/sair de Modo Placa faz SWAP com estes campos,
   * nunca lê os dois ao mesmo tempo pra desenhar. */
  boardX?: number;
  boardY?: number;
  boardRotation?: 0 | 90 | 180 | 270;
  boardFlipH?: boolean;
  boardFlipV?: boolean;
  /** "Selecione os Componentes expostos" -- só relevante pra componentes do circuito INTERNO de um
   * subcircuito (`isSymbolAuthoringTypeId` é sempre `false`/irrelevante aqui). Sobrevive ao
   * round-trip de "Abrir Subcircuito" via `InternalComponentSeed.exposed` (ver
   * `symbolAuthoring.ts`). Ausente == `false`. */
  exposed?: boolean;
  /** Presença deste campo (independente do `typeId` atual) é o marcador de "isto é um bloco
   * genérico de subcircuito por caminho" -- mesmo shape de `ProjectSubcircuitRef`
   * (`ProjectTypes.ts`). Ausente == componente normal, resolvido só por `typeId`/catálogo. */
  subcircuitRef?: {
    path: string;
    lastKnownTypeId?: string;
    lastKnownPinIds?: string[];
  };
}

export interface WebviewPoint {
  x: number;
  y: number;
}

export interface WebviewWireModel {
  id: string;
  from: { componentId: string; pinId: string };
  to: { componentId: string; pinId: string };
  points?: WebviewPoint[];
}

export interface PropertySchemaOptionEntry {
  value: string;
  label: string;
}

/** Cópia webview-safe de `PropertySchemaDto` (`extension/src/ipc/types.ts`) — a Webview compila
 * separado via `tsconfig.webview.json` (ambiente de browser, sem tipos Node), por isso não importa
 * direto de `ipc/types.ts`; o host (`extension.ts`) converte um pro outro ao montar o catálogo. */
export interface PropertySchemaEntry {
  id: string;
  label: string;
  group: string;
  unit: string;
  editor: string;
  default: string | number | boolean;
  min?: number;
  max?: number;
  step?: number;
  options?: PropertySchemaOptionEntry[];
  hidden?: boolean;
  readOnly?: boolean;
  showOnSymbol?: boolean;
}

/** Pino declarado em `package.pins[]` (`.lsdevice`/`.lssubcircuit`, ver
 * `.spec/lasecsimul-native-devices.spec` seção 21.2) — `x`/`y` é o ponto onde o "lead" toca o corpo
 * do símbolo (não a ponta do fio); a ponta real (onde o fio conecta) fica em
 * `x + cos(angle)*length, y + sin(angle)*length`. `id` deve bater com o `pin.id` real devolvido pelo
 * Core — é por `id`, nunca por posição no array, que o renderizador casa pino declarado com pino
 * real (um `McuComponent`/subcircuito pode devolver pinos em ordem diferente da declarada). */
export interface PackagePin {
  id: string;
  aliases?: string[];
  stateVisible?: SimulidePaintStateVisible;
  kind?: string;
  x: number;
  y: number;
  angle: number;
  length: number;
  leadOrigin?: "body" | "terminal";
  leadEndTrim?: number;
  leadColor?: string;
  label?: string;
  labelColor?: string;
  labelFontSize?: number;
  labelSpace?: number;
  labelStateVisible?: SimulidePaintStateVisible;
  labelTextAnchor?: "start" | "middle" | "end";
  labelDominantBaseline?: "auto" | "middle" | "central" | "hanging" | "text-before-edge" | "text-after-edge";
  /** Posição do RÓTULO, independente da posição do pino -- igual ao SimulIDE real (texto de pino,
   * texto do CI etc são objetos arrastáveis à parte, nunca presos a um deslocamento fixo do pino).
   * Em coordenadas ORIGINAIS do package (mesmo espaço de `x`/`y`, antes do deslocamento de
   * `resolvePackageLayout`). Ausente == posição padrão calculada (ponta do lead + 9 unidades na
   * direção do `angle`, com rótulo girado -90° se o lead for vertical) -- mesmo comportamento de
   * sempre, nunca quebra um `package` escrito antes deste campo existir. Editado arrastando um
   * `graphics.text` vinculado na sessão de autoria (`other.package_pin`/`symbolAuthoring.ts`), nunca
   * uma alça nova. */
  labelX?: number;
  labelY?: number;
}

/** Uma forma declarativa de `package.shapes[]` — mesmo vocabulário de
 * `components/graphical/{rectangle,ellipse,line,textcomponent}` do SimulIDE, só que como dado
 * (`.spec/lasecsimul-native-devices.spec` seção 21.2), nunca um componente à parte. */
export interface PackageShape {
  kind: "rect" | "text" | "line" | "ellipse" | "polygon" | "path" | "image" | "svg";
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  x1?: number;
  y1?: number;
  x2?: number;
  y2?: number;
  cx?: number;
  cy?: number;
  rx?: number;
  ry?: number;
  points?: Array<{ x: number; y: number }>;
  d?: string;
  href?: string;
  preserveAspectRatio?: string;
  value?: string;
  fontSize?: number;
  textAnchor?: "start" | "middle" | "end";
  color?: string;
  stroke?: string;
  fill?: string;
  strokeWidth?: number;
  strokeLinecap?: "butt" | "round" | "square";
  strokeLinejoin?: "arcs" | "bevel" | "miter" | "miter-clip" | "round";
  strokeDasharray?: string;
  fillRule?: "nonzero" | "evenodd";
  opacity?: number;
  transform?: string;
  fontFamily?: string;
  fontWeight?: string | number;
  dominantBaseline?: "auto" | "middle" | "central" | "hanging" | "text-before-edge" | "text-after-edge";
  /** CSS class(es) added to the SVG element — used for interactive hit zones (e.g. "joystick-hit-zone"). */
  cssClass?: string;
  /** Nome do "part" deste elemento no ViewSpec — conecta ao `stateProjection[partId]` da spec.
   * Quando presente, o renderizador aplica o transform inicial derivado das propriedades do componente
   * (ex: position do encoder → rotate; x_pos/y_pos do joystick → translate). */
  partId?: string;
}

export interface PackageBackground {
  kind: "color" | "svg" | "image" | "none";
  value?: string;
  data?: string;
  asset?: string;
  mime?: string;
}

export interface SimulidePaintBounds {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface SimulidePaintSource {
  file?: string;
  className?: string;
  method?: string;
  notes?: string;
}

export interface SimulidePaintStyle {
  stroke?: string;
  fill?: string;
  fillGradient?: SimulidePaintGradient;
  strokeWidth?: number;
  strokeLinecap?: PackageShape["strokeLinecap"];
  strokeLinejoin?: PackageShape["strokeLinejoin"];
  strokeDasharray?: string;
  fillRule?: PackageShape["fillRule"];
  opacity?: number;
  /** Passa direto pro `PackageShape.cssClass` -- usado por built-ins interativos (ex:
   * `sources.fixed_volt`/`clock`/`wave_gen`) pra marcar a primitiva como parte do
   * `.toggle-hit-zone` clicável, já que o motor SimulidePaint não tem outro jeito de expressar
   * "isso responde a clique" além de uma classe CSS reconhecida pelo `main.ts`. */
  cssClass?: string;
}

export interface SimulidePaintStateFill {
  prop: string;
  map?: Record<string, string>;
  numeric?: Array<{ op: ">" | ">=" | "<" | "<=" | "==" | "!="; value?: number; valueProp?: string; color: string }>;
  fallback?: string;
}

export interface SimulidePaintStateVisible {
  when: Record<string, string[]>;
}

export interface SimulidePaintStateHref {
  prop: string;
  map: Record<string, string>;
}

export type SimulidePaintStateText =
  | { kind: "meterDisplay"; unit: string }
  | { kind: "frequencyDisplay" }
  | { kind: "readout"; unit?: string; decimals?: number }
  | {
      kind: "propertyChar";
      prop: string;
      rowIndex?: string;
      columnIndex?: string;
      columnsProp?: string;
      fallback?: string;
    }
  /** Ecoa uma propriedade string/bool/number QUALQUER da instância direto como texto -- ex: `key` de
   * `switches.push`/`switches.switch` (rótulo do `CustomButton`, `SwitchBase::setKey`). Sem isto,
   * cada device com um texto arbitrário precisaria de um `stateText.kind` novo só pra ele. */
  | { kind: "property"; prop: string };

export type SimulidePaintGradient =
  | {
      kind: "linear";
      x1: number;
      y1: number;
      x2: number;
      y2: number;
      stops: Array<{ offset: number | string; color: string }>;
    }
  | {
      kind: "radial";
      cx: number;
      cy: number;
      r: number;
      fx?: number;
      fy?: number;
      stops: Array<{ offset: number | string; color: string }>;
    };

export type SimulidePaintPrimitive =
  | ({ kind: "line"; x1: number; y1: number; x2: number; y2: number; stateFill?: SimulidePaintStateFill; stateVisible?: SimulidePaintStateVisible } & SimulidePaintStyle)
  | ({ kind: "rect"; x: number; y: number; w: number; h: number; rx?: number; ry?: number; stateFill?: SimulidePaintStateFill; stateVisible?: SimulidePaintStateVisible } & SimulidePaintStyle)
  | ({ kind: "roundedRect"; x: number; y: number; w: number; h: number; rx: number; ry: number; stateFill?: SimulidePaintStateFill; stateVisible?: SimulidePaintStateVisible } & SimulidePaintStyle)
  | ({ kind: "ellipse"; cx: number; cy: number; rx: number; ry: number; stateFill?: SimulidePaintStateFill; stateVisible?: SimulidePaintStateVisible } & SimulidePaintStyle)
  | ({ kind: "arc"; x: number; y: number; w: number; h: number; startDeg: number; spanDeg: number; stateFill?: SimulidePaintStateFill; stateVisible?: SimulidePaintStateVisible } & SimulidePaintStyle)
  | ({ kind: "path"; d: string; stateFill?: SimulidePaintStateFill; stateVisible?: SimulidePaintStateVisible } & SimulidePaintStyle)
  | ({ kind: "polygon"; points: Array<{ x: number; y: number }>; stateFill?: SimulidePaintStateFill; stateVisible?: SimulidePaintStateVisible } & SimulidePaintStyle)
  | ({ kind: "polyline"; points: Array<{ x: number; y: number }>; stateFill?: SimulidePaintStateFill; stateVisible?: SimulidePaintStateVisible } & SimulidePaintStyle)
  | ({ kind: "text"; x: number; y: number; value: string; fontSize?: number; textAnchor?: PackageShape["textAnchor"]; dominantBaseline?: PackageShape["dominantBaseline"]; fontFamily?: string; fontWeight?: string | number; stateFill?: SimulidePaintStateFill; stateVisible?: SimulidePaintStateVisible; stateText?: SimulidePaintStateText } & SimulidePaintStyle)
  | ({ kind: "image"; x: number; y: number; w: number; h: number; href: string; preserveAspectRatio?: string; stateFill?: SimulidePaintStateFill; stateVisible?: SimulidePaintStateVisible; stateHref?: SimulidePaintStateHref } & SimulidePaintStyle)
  /** Duplica `primitives[]` `count` vezes, deslocando `stepX`/`stepY` (coordenadas ORIGINAIS, mesma
   * unidade de `bounds`) por repetição -- traduz diretamente os laços `for` que o SimulIDE real usa
   * pra desenhar N sub-widgets iguais (ex: `SwitchDip::createSwitches` cria 1 QPushButton 6x6 por
   * posição; `KeyPad`/`Socket`/`Header`/LED bar têm o mesmo padrão). Sem isto, cada device com N
   * subelementos repetidos exigia listar N cópias quase idênticas na mão em
   * `component-catalog.json` -- fonte comum de erro de copy-paste (offset errado numa cópia) e
   * exatamente o tipo de "remendo por dispositivo" que este IR existe pra evitar. Os `primitives[]`
   * internos continuam podendo usar `stateFill`/`stateVisible` normalmente (lidos das MESMAS
   * `properties` da instância -- o Core de hoje não tem estado por posição pra maioria destes
   * devices, ver `switches.switch_dip`; quando tiver, um `stateFill.numeric` com `valueProp`
   * calculado por índice resolve sem mudar este contrato). */
  | {
      kind: "repeat";
      count?: number;
      countProp?: string;
      indexName?: string;
      stepX?: number;
      stepY?: number;
      primitives: SimulidePaintPrimitive[];
      stateVisible?: SimulidePaintStateVisible;
    };

/** Declarative IR for SimulIDE C++ paint() output. Coordinates stay in the original QPainter item
 * space; `bounds` maps that local space into the positive SVG viewBox used by LasecSimul. */
export interface SimulidePaintSpec {
  version: 1;
  source?: SimulidePaintSource;
  bounds: SimulidePaintBounds;
  defaultStroke?: string;
  defaultFill?: string;
  defaultStrokeWidth?: number;
  primitives: SimulidePaintPrimitive[];
}

export interface SimulideQtWidgetSpec {
  kind: "plotBase";
  variant: "oscope" | "logicAnalyzer";
  channels: number;
  tracks?: number;
  source?: SimulidePaintSource;
}

/** SimulIDE stores Package.Width/Height in schematic grid cells; each cell is 8 scene units. */
export const SIMULIDE_PACKAGE_GRID_UNIT = 8;

// ── ViewSpec (P2) ────────────────────────────────────────────────────────────────────────────────
// Sistema declarativo de renderização e interação para devices com SVG complexo (gradientes,
// stateProjection, etc.). Ativa-se quando `package.viewSpec` está presente; fallback para
// `package.shapes[]` quando ausente — nenhum device existente quebra.

/** Gradiente SVG declarado no ViewSpec. IDs são auto-escopados por instância (`name-componentId`)
 * pelo ViewSpecRenderer para evitar colisão entre múltiplas instâncias do mesmo typeId. */
export type ViewSpecGradient =
  | {
      kind: "radial";
      cx: number; cy: number; r: number;
      fx?: number; fy?: number;
      gradientUnits?: "userSpaceOnUse" | "objectBoundingBox";
      stops: Array<{ offset: string; color: string }>;
    }
  | {
      kind: "linear";
      x1: number; y1: number; x2: number; y2: number;
      gradientUnits?: "userSpaceOnUse" | "objectBoundingBox";
      stops: Array<{ offset: string; color: string }>;
    };

/** Mapeamento linear de um eixo de uma propriedade do componente para pixels SVG.
 * `dx = pixelRange[0] + (prop - propRange[0]) / (propRange[1] - propRange[0]) * (pixelRange[1] - pixelRange[0])` */
export interface ViewSpecAxisMapping {
  prop: string;
  propRange: [number, number];
  pixelRange: [number, number];
}

/** Como o valor de uma propriedade do componente se projeta em transform/fill/visibility de um
 * element visual identificado por `partId` em `paint[]`. */
export type ViewSpecProjection =
  | { kind: "translate"; x?: ViewSpecAxisMapping; y?: ViewSpecAxisMapping }
  | { kind: "rotate"; prop: string; stepsPerRev: number; stepsPerRevProp?: string; cx: number; cy: number }
  | { kind: "fill"; prop: string; map: Record<string, string> }
  | { kind: "visible"; prop: string; invert?: boolean };

/** Região declarativa de hit-test em coordenadas nativas do package/ViewSpec. Ela separa desenho de
 * interação: um knob pode ser composto de várias formas visuais, mas ter uma única área clicável. */
export type ViewSpecHitTest =
  | { kind: "rect"; x: number; y: number; w: number; h: number; cursor?: string }
  | { kind: "circle"; cx: number; cy: number; r: number; cursor?: string }
  | { kind: "ellipse"; cx: number; cy: number; rx: number; ry: number; cursor?: string }
  | { kind: "polygon"; points: Array<{ x: number; y: number }>; cursor?: string }
  | { kind: "path"; d: string; cursor?: string };

/** Limite físico/numérico reutilizável por interações. Exemplos: raio máximo do joystick, intervalo
 * angular de um knob, faixa em pixels de um slider, min/max/step de propriedade. */
export interface ViewSpecLimit {
  min?: number;
  max?: number;
  step?: number;
  center?: number;
  radius?: number;
  minAngleDeg?: number;
  maxAngleDeg?: number;
  clamp?: boolean;
}

/** Parte semântica do componente. `paint[]` continua sendo a fonte visual principal, mas `parts`
 * permite nomear regiões móveis/acionáveis e conectar hit-test + interação + origem de rotação. */
export interface ViewSpecPart {
  role?: string;
  paint?: PackageShape[];
  hitTest?: string | ViewSpecHitTest;
  interaction?: string;
  origin?: { x: number; y: number };
  movable?: boolean;
  cursor?: string;
}

/** Interação declarativa por parte/região. O webview atual ainda implementa handlers específicos
 * para joystick/encoder/touchpad; este contrato é o alvo comum para migrar todos os dispositivos
 * sem hardcode por typeId. */
export type ViewSpecInteraction =
  | {
      kind: "dragVector";
      partId?: string;
      hitTest?: string;
      x?: ViewSpecAxisMapping;
      y?: ViewSpecAxisMapping;
      springBack?: boolean;
      pressedProp?: string;
      limits?: string;
    }
  | {
      kind: "dragAngular";
      partId?: string;
      hitTest?: string;
      prop: string;
      cx: number;
      cy: number;
      stepsPerRev?: number;
      stepsPerRevProp?: string;
      continuous?: boolean;
      limits?: string;
    }
  | {
      kind: "touchPoint";
      partId?: string;
      hitTest?: string;
      x: ViewSpecAxisMapping;
      y: ViewSpecAxisMapping;
      pressedProp?: string;
      limits?: string;
    }
  | {
      kind: "press";
      partId?: string;
      hitTest?: string;
      prop: string;
      pressedValue?: boolean | number | string;
      releasedValue?: boolean | number | string;
    }
  | {
      kind: "toggle";
      partId?: string;
      hitTest?: string;
      prop: string;
      values?: [boolean | number | string, boolean | number | string];
    }
  | {
      kind: "slider";
      partId?: string;
      hitTest?: string;
      axis: "x" | "y";
      prop: string;
      propRange: [number, number];
      pixelRange: [number, number];
      limits?: string;
    };

/** Especificação declarativa de renderização para um device. Alternativa a `shapes[]` com suporte
 * a gradientes escopados por instância e projeção de estado (posição/rotação baseada em propriedades).
 * Campos `fill: "gradient:name"` nos `paint` items referenciam `gradients[name]` com ID auto-escopado. */
export interface ComponentViewSpec {
  gradients?: Record<string, ViewSpecGradient>;
  /** Partes semânticas nomeadas; base para reescrita em massa dos módulos com interações móveis. */
  parts?: Record<string, ViewSpecPart>;
  /** Regiões de hit-test reutilizáveis por `parts` e `interaction`. */
  hitTest?: Record<string, ViewSpecHitTest>;
  /** Interações declarativas por id lógico (ex: "knob", "stick", "button"). */
  interaction?: Record<string, ViewSpecInteraction>;
  /** Limites físicos reutilizáveis por interações/projeções. */
  limits?: Record<string, ViewSpecLimit>;
  /** Formas visuais — mesma sintaxe de `PackageShape`, mas `fill: "gradient:name"` resolve para
   * o gradiente escopado, e `partId` conecta ao `stateProjection`. */
  paint: PackageShape[];
  /** Projeções de estado por `partId` — aplicadas ao `transform`/`fill`/`visibility` dos elementos
   * com esse `partId` no `paint[]`, em ordem. */
  stateProjection?: Record<string, ViewSpecProjection[]>;
}

// ────────────────────────────────────────────────────────────────────────────────────────────────

/** Símbolo visual declarativo de um `typeId` — mesmo bloco `package` de `.lsdevice`/`.lssubcircuit`
 * (`.spec/lasecsimul-native-devices.spec` seção 21, `.spec/lasecsimul-subcircuits.spec` seção 3).
 * Quando presente, o renderizador da Webview desenha o corpo e posiciona cada pino na coordenada
 * REAL declarada — nunca o algoritmo genérico esquerda/direita usado para built-ins sem `package`
 * (ver `componentSymbols.ts`, Épico G do roadmap de pendências). */
export interface PackageDescriptor {
  width: number;
  height: number;
  /** Tamanho EXTERNO no esquemático, independente da malha interna usada por `pins[]`/`shapes[]`.
   * Porta o comportamento do SimulIDE para placas/imagens reais: o package tem um espaço nativo
   * (ex: pixels da foto/placa, usado por `boardPos` e pinos), mas a instância no esquemático ocupa
   * um retângulo lógico menor (`Package.Width/Height` lá, em células de grade). Ausente ==
   * comportamento legado: usa `width`/`height` como tamanho visual também. */
  schematicWidth?: number;
  schematicHeight?: number;
  initialTransform?: { rotateDeg?: number; cx?: number; cy?: number };
  border?: boolean;
  background?: PackageBackground;
  /** Estilo visual dos pinos do package. `packagePin` replica `PackagePin::paint()` do SimulIDE:
   * depois do lead normal (`Pin::paint()`), desenha uma pequena cruz cinza no ponto onde o pino toca
   * o corpo do encapsulamento/subcircuito. */
  pinMarker?: "packagePin";
  shapes?: PackageShape[];
  /** SimulIDE-compatible paint IR. When present it is rendered before legacy `viewSpec`/`shapes[]`
   * so migrated symbols can be audited against the original C++ paint() source. */
  simulidePaint?: SimulidePaintSpec;
  qtWidget?: SimulideQtWidgetSpec;
  /** ViewSpec declarativo (P2) — quando presente, tem prioridade sobre `shapes[]`. Suporta
   * gradientes escopados por instância e stateProjection. */
  viewSpec?: ComponentViewSpec;
  valueLabel?: { x: number; y: number; rotation?: 0 | 90 | 180 | 270 | -90 };
  pins: PackagePin[];
  /** Cor dos rótulos de pinos — padrão `currentColor` (herda do canvas). Usar `"#FAFAC8"` pra
   * placas com fundo escuro (mesma cor `QColor(250,250,200)` dos rótulos de `PackagePin` do
   * SimulIDE real). */
  pinLabelColor?: string;
}

export interface WebviewComponentCatalogEntry {
  typeId: string;
  label: string;
  /** Categoria de topo, usando o nome EXATO da taxonomia do SimulIDE (ex: "Medidores", "Fontes",
   * "Interruptores", "Passivos") — ver docs/15-taxonomia-paleta.md. Nunca inventar uma categoria
   * nova se o SimulIDE já tem uma equivalente. */
  category: string;
  /** Subcategoria dentro de `category`, também com o nome exato do SimulIDE (ex: "Resistores",
   * "Reativo" dentro de "Passivos") — opcional: categorias sem subdivisão no SimulIDE (ex:
   * "Fontes", "Conectores") não usam este campo. */
  subcategory?: string;
  /** Caminho hierárquico completo da paleta (pastas/subpastas). Ex:
   * ["Passivos", "Resistores", "Precisao"]. Quando ausente, a árvore usa
   * `category`/`subcategory` para manter compatibilidade com catálogos legados. */
  folderPath?: string[];
  /** Caminho relativo a `extension/media/components/{light,dark}/<icon>` (sem extensão/tema) —
   * ex: "resistor" resolve para "media/components/light/resistor.svg" ou ".../dark/resistor.svg"
   * conforme o tema ativo do VSCode. */
  icon?: string;
  iconFilePath?: string;
  /** SVG inline da miniatura da paleta — alternativa a `icon`/`iconFilePath` para dispositivos
   * cujo manifesto embute o ícone diretamente (campo `icon` do `.lsdevice`/`.lssubcircuit` quando
   * o valor começa com `<svg`). Prevalece sobre `icon`/`iconFilePath` quando presente.
   * Renderizado como data URI (`data:image/svg+xml,...`) — funciona sem arquivo externo. */
  iconSvgInline?: string;
  symbolSvg?: string;
  /** Símbolo declarativo real (`.lsdevice`/`.lssubcircuit` `package`) — quando presente, tem
   * prioridade sobre `symbolSvg`/algoritmo genérico (ver `componentSymbols.ts`). */
  package?: PackageDescriptor;
  /** Aparência ALTERNATIVA opcional ("Chip or Logic Symbol", igual ao SimulIDE real —
   * `SubPackage::Logic_Symbol`, booleano simples, não uma lista de N variantes). Quando presente,
   * a instância ganha a propriedade `logicSymbol` (boolean) que escolhe entre este e `package` —
   * mesmos pinos elétricos nos dois (não validado à força, só aviso, ver `saveSymbolCommand`). */
  logicSymbolPackage?: PackageDescriptor;
  /** Igual ao `m_graphical` do SimulIDE real (setado por classe em `component.cpp`) -- typeIds "de
   * interação do usuário" (LED, motor, display, switch, ...) que continuam visíveis em Modo Placa
   * dentro de uma sessão de "Abrir Subcircuito"; o resto (resistor, MCU, fonte fixa, lógica pura)
   * fica oculto nesse modo, ver `main.ts::toggleBoardMode`. Ausente == `false`. */
  graphical?: boolean;
  pinCount: number;
  /** Ids elétricos REAIS na ordem que o Core espera (`abi-device`: `.lsdevice` `pins[].id`;
   * `mcu-adapter`: chaves de `.lsdevice` `pinMap`, mesma ordem/contagem que `get_pin_map()` do plugin
   * devolve em runtime — ordem importa, ver `NativeMcuAdapterProxy`/`McuComponent::McuComponent`,
   * que casam `requestedPins[i]` posicionalmente com `pinMap()[i]`; `subcircuit-file`:
   * `interface[].pinId`). Ausente == comportamento legado (`pin-1`, `pin-2`, ... genérico) — só
   * builtins sem schema próprio caem nisso hoje. Quando presente, `pinCount` é sempre
   * `pinIds.length` (nunca o tamanho de `package.pins[]`, que conta TAMBÉM pinos puramente visuais/
   * decorativos sem contrapartida elétrica — ver `componentSymbols.ts`/Épico G). */
  pinIds?: string[];
  defaultProperties: Record<string, string | number | boolean>;
  /** Schema rico de propriedades deste typeId (grupo/editor/min/max/opções/flags), vindo do Core via
   * `getPropertySchemas` — ausente/vazio só pra typeId que o Core ainda não conhece (ex: registrado
   * porém desabilitado); o diálogo de propriedades cai pra inferência nesse caso. */
  propertySchema?: PropertySchemaEntry[];
  hidden?: boolean;
  /** Quando true, o item aparece na paleta mas não pode ser inserido no circuito. */
  disabled?: boolean;
  /** Motivo da indisponibilidade, mostrado no tooltip do item desabilitado. */
  disabledReason?: string;
  /** Identifica entrada adicionada pelo usuário via registro de arquivo. */
  isRegistered?: boolean;
  /** ID estável da fonte registrada (usado para remoção por menu de contexto). */
  registeredSourceId?: string;
  /** False quando o item é integrado ao catálogo base e não pode ser removido pela UI. */
  registeredSourceRemovable?: boolean;
  /** Tipo da fonte registrada que originou esta entrada -- usado pela Webview para ajustar menu
   * de contexto ("Abrir Subcircuito" vs "Editar Símbolo") e ações específicas de MCU/QEMU. */
  registeredSourceKind?: "abi-device" | "mcu-adapter" | "subcircuit-file";
  /** `true` quando esta entrada representa um MCU direto (`mcu-adapter`) OU um subcircuito que
   * hospeda um MCU interno (ex: DevKit/WROOM com ESP32 QEMU dentro). */
  mcuHost?: boolean;
  /** ABI v2 -- ver `ReadoutFormatEntry`. Vem de `getPropertySchemas` (`attachPropertySchemas` em
   * extension.ts), mesmo merge de `propertySchema`. */
  readoutFormat?: ReadoutFormatEntry;
  /** ABI v2 -- ver `InteractionKindEntry`. */
  interactionKind?: InteractionKindEntry;
  /** Informação de ajuda do componente — `description` é um resumo curto (1-2 linhas) mostrado no
   * tooltip do diálogo de propriedades; `url` é link externo opcional para documentação completa;
   * `file` é caminho relativo ao manifesto para um arquivo .md de ajuda local.
   * Ausente: botão "Ajuda" no diálogo de propriedades permanece desabilitado. */
  help?: { description?: string; url?: string; file?: string };
}

export interface WebviewProjectState {
  locale?: "pt-BR" | "en";
  catalog: WebviewComponentCatalogEntry[];
  components: WebviewComponentModel[];
  wires: WebviewWireModel[];
  /** `x`/`y` = pan, `zoom` = escala — aplicado via CSS transform no wrapper `.canvas-content`
   * (`main.ts`), com `eventToCanvasPoint` invertendo a transformação pra todo cálculo de coordenada
   * tela→canvas continuar correto em qualquer zoom (ver `.spec/lasecsimul.spec` seção 13.4). */
  viewport: { x: number; y: number; zoom: number };
  /** Seleção múltipla (marquee/Shift+click) — array vazio == nada selecionado, nunca `undefined`
   * (mais simples de testar que opcional). Substituiu `selectedComponentId?: string` singular. */
  selectedComponentIds: string[];
  selectedWireIds: string[];
  pendingConnection?: { componentId: string; pinId: string };
}
