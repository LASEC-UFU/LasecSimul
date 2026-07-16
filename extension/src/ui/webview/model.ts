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
  | { kind: "bitmaskHistory"; channels: number }
  | { kind: "vectorHistory"; channels: number };

/** Mesma convenção de `ReadoutFormatEntry`, pra como a UI trata clique/arrasto sem checar typeId. */
export type InteractionKindEntry = "momentary" | "toggle" | "none" | "joystick" | "encoder" | "touchpad";

export interface McuSerialPortEntry {
  label: string;
  usartIndex: 0 | 1 | 2;
}

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
  /** QUAL propriedade numérica é exibida no rótulo de valor, quando o typeId tem mais de uma
   * candidata -- achado de auditoria de UI 2026-07-09: SimulIDE deixa o usuário escolher por
   * componente (cada `NumVal` tem seu próprio checkbox "Show"); antes disso, LasecSimul só permitia
   * a ÚNICA propriedade marcada `showOnSymbol` no catálogo (fixo por typeId, nunca por instância).
   * Ausente == usa o default do catálogo (`findShowOnSymbolSchema`, `main.ts`). Precisa bater com o
   * `id` de algum item de `propertySchema` do typeId -- se não bater mais (typeId trocou de schema
   * entre versões), cai de volta pro default silenciosamente, nunca erro. */
  valueLabelPropertyKey?: string;
  /** Espelha o símbolo no eixo horizontal/vertical -- combinado com `rotation`: o flip é aplicado
   * primeiro no espaço local do símbolo, a rotação depois (mesma ordem no CSS `transform` de
   * `main.ts` e no cálculo de posição de pino, ver `flipPoint`/`rotatePoint`). Ausente == `false`. */
  flipH?: boolean;
  flipV?: boolean;
  /** Bloqueio de edição (bloco genérico de edição em lote, ver `batchProperties.ts`) -- distinto de
   * `hidden` (derivado do catálogo, nunca setável pelo usuário). Ausente == `false`. Enforcement
   * mínimo: bloqueia iniciar arrasto e apagar (`main.ts`); NÃO bloqueia edição de propriedades (o
   * próprio campo `locked` precisa continuar editável pra poder destravar). */
  locked?: boolean;
  /** Visibilidade escolhida pelo usuário (bloco genérico de edição em lote) -- distinto de `hidden`
   * (recalculado do catálogo a cada load, ver `projectToWebviewState`; sempre `false` pra tipos que
   * não são conectores). Ausente == `false`. Some do render/hit-test igual a `hidden`, mas persiste
   * por instância (`.lsproj`) em vez de ser re-derivado do typeId. */
  hiddenByUser?: boolean;
  pins: WebviewPinModel[];
  properties: Record<string, string | number | boolean>;
  /** Posição/orientação na PLACA (Board Mode) — independente de `x`/`y`/`rotation`/`flipH`/`flipV`
   * (posição no CIRCUITO), igual a `circPos`/`boardPos` do SimulIDE real. Persistido no
   * `.lssubcircuit` e usado pelo overlay de instâncias com `boardModeEnabled`; ausente significa que
   * o overlay escolhe uma posição inicial padrão. */
  boardX?: number;
  boardY?: number;
  boardRotation?: 0 | 90 | 180 | 270;
  boardFlipH?: boolean;
  boardFlipV?: boolean;
  /** Tamanho na PLACA (Board Mode) -- SEM equivalente no `x`/`y`/`rotation` do esquemático, que
   * nunca redimensiona um componente por instância (só `boardPackage.width`/`.height` natural, ver
   * `model.ts::WebviewComponentCatalogEntry.boardPackage`). Ausente == usa o tamanho natural do
   * `boardPackage` (ou de `package`, se não houver `boardPackage`) sem escala nenhuma. Puramente um
   * fator de escala aplicado sobre o corpo renderizado, nunca reinterpretado como grid/pinos --
   * evita ter que re-derivar geometria de pino pra um tamanho arbitrário. */
  boardWidth?: number;
  boardHeight?: number;
  /** "Selecione os Componentes expostos" -- só relevante para componentes internos persistidos no
   * `.lssubcircuit`. Ausente == `false`. */
  exposed?: boolean;
  /** Presença deste campo (independente do `typeId` atual) é o marcador de "isto é um bloco
   * genérico de subcircuito por caminho" -- mesmo shape de `ProjectSubcircuitRef`
   * (`ProjectTypes.ts`). Ausente == componente normal, resolvido só por `typeId`/catálogo. */
  subcircuitRef?: {
    path: string;
    lastKnownTypeId?: string;
    lastKnownPinIds?: string[];
  };
  /** Marca a ÚNICA instância de `graphics.image` (dentro de uma sessão "Abrir Subcircuito") que
   * representa a Figura/ícone do Package sendo editado -- campo SÓ DE SESSÃO, nunca serializado
   * direto no `.lssubcircuit` (a fonte de verdade persistida é `package.background`, ver
   * `PackageDescriptor`). Materializado por `seedPackageAuthoringComponents` a partir de
   * `package.background.kind === "image"`; lido de volta por `compilePackageAuthoringComponents` ao
   * salvar (`extension/src/catalog/subcircuitPackageAuthoring.ts`, `.spec/lasecsimul.spec`). Mesmo
   * estilo de campo "marcador de papel especial" que `subcircuitRef` já usa. */
  packageIconRole?: true;
  /** Marca uma instância de `graphics.line`/`graphics.image`/`graphics.text`/`graphics.rectangle`/
   * `graphics.ellipse` (dentro de uma sessão "Abrir Subcircuito") como um ELEMENTO DECORATIVO do
   * Package sendo editado -- compilado pra `package.shapes[]` ao salvar, em vez de ir pro circuito
   * interno real (`components[]`). Independente de `packageIconRole` (que é a ÚNICA Figura de fundo
   * travada no tamanho do Package; um elemento com `packageShapeRole` é um extra qualquer -- linha,
   * forma, texto livre, segunda imagem -- posicionado livremente sobre o Package). Campo SÓ DE
   * SESSÃO, nunca serializado direto (a fonte de verdade persistida é `package.shapes[]`). Ver
   * `subcircuitPackageAuthoring.ts`. */
  packageShapeRole?: true;
}

export interface WebviewPoint {
  x: number;
  y: number;
}

/** Endpoint tipado de um condutor -- `port` é um pino real de componente, `node` é um nó de
 * topologia (derivado de junção de grau N, nunca um componente do Core, ver `.spec` seção 24.1).
 * Fonte única de verdade tanto no documento persistido (`.lsproj`/`.lssubcircuit`, `topology.*`)
 * quanto no modelo vivo (`WebviewProjectState.topology`) -- ver `.spec` seção 25.6 (Fase C completa:
 * antes desta rodada existiam DUAS representações, uma viva com `componentId` plano assumindo que
 * nó e porta compartilhavam o mesmo espaço de string por convenção, e esta aqui só usada nas bordas
 * de save/load). */
export type CanonicalEndpoint =
  | { kind: "port"; componentId: string; pinId: string }
  | { kind: "node"; nodeId: string };

export interface TopologyNode {
  id: string;
  position: WebviewPoint;
}

/** Documento canônico de topologia -- substitui `wires[]`/`topologyNodes[]` separados como fonte
 * única de verdade, tanto persistida quanto viva. `revision` é o contador de CAS otimista entre
 * Webview/Host/Core (ver `requestConnectEndpoints`/`applyWireTopologyTransaction`). `conductors` usa
 * o MESMO `WebviewWireModel` (definido abaixo) que todo o resto do projeto já manipula -- não existe
 * um tipo `TopologyConductor` separado; seriam campo-por-campo idênticos (`id`/`from`/`to`/
 * geometria), então um tipo só. */
export interface CanonicalTopologyDocument {
  revision: number;
  nodes: TopologyNode[];
  conductors: WebviewWireModel[];
}

/** Id do outro lado do endpoint -- pra um `port`, é o `componentId` real; pra um `node`, é o
 * `nodeId` do nó de topologia. Os dois espaços de id nunca colidem (ids gerados por `nextId(...)`
 * com prefixo diferente, `component-`/`junction-`) -- por isso é seguro usar isto como chave de
 * lookup uniforme em `components`/`topologyNodes` conforme o `kind`. */
export function endpointId(endpoint: CanonicalEndpoint): string {
  return endpoint.kind === "node" ? endpoint.nodeId : endpoint.componentId;
}

/** Pino do endpoint -- pra um `node`, é sempre `"pin-1"` (todo nó de topologia tem exatamente um
 * pino sintético compartilhado por N condutores, ver `.spec` seção 24.1); pra um `port`, é o pino
 * real declarado pelo componente. */
export function endpointPinId(endpoint: CanonicalEndpoint): string {
  return endpoint.kind === "node" ? "pin-1" : endpoint.pinId;
}

export function portEndpoint(componentId: string, pinId: string): CanonicalEndpoint {
  return { kind: "port", componentId, pinId };
}

export function nodeEndpoint(nodeId: string): CanonicalEndpoint {
  return { kind: "node", nodeId };
}

/** Reescreve o id de um endpoint conforme `idMap` (ex: duplicar/colar/importar um sub-grafo com ids
 * novos), preservando `kind` -- `undefined` quando o id referenciado não está no mapa (o chamador
 * decide o que fazer: tipicamente excluir o condutor, mesma regra de hoje pra endpoint fora da
 * seleção copiada). */
export function remapEndpoint(endpoint: CanonicalEndpoint, idMap: ReadonlyMap<string, string>): CanonicalEndpoint | undefined {
  if (endpoint.kind === "node") {
    const mapped = idMap.get(endpoint.nodeId);
    return mapped ? nodeEndpoint(mapped) : undefined;
  }
  const mapped = idMap.get(endpoint.componentId);
  return mapped ? portEndpoint(mapped, endpoint.pinId) : undefined;
}

export interface WebviewWireModel {
  id: string;
  from: CanonicalEndpoint;
  to: CanonicalEndpoint;
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
  /** Espelha `PropertySchemaAffectsPinCount` do Core (`CoreApplication.cpp::propertySchemaToJson`)
   * -- editar esta propriedade muda o NÚMERO de pinos do componente (ex: `rows`/`columns` de
   * `switches.keypad`), não só a fiação. `extension.ts` usa isto no handler
   * `"requestUpdateProperty"` pra recalcular `pinsForTypeId` e reconciliar `component.pins[]` +
   * remover fios que apontavam pra um pino que deixou de existir. Ausente == `false` (a maioria das
   * propriedades). */
  affectsPinCount?: boolean;
}

/** Pino declarado em `package.pins[]` (`.lsdevice`/`.lssubcircuit`, ver
 * `.spec/lasecsimul-native-devices.spec` seção 21.2). `x`/`y` é sempre o terminal elétrico; quando
 * `PackageDescriptor.coordinateSpace` é `simulide-local`, usa diretamente o espaço local do
 * `QGraphicsItem`/`m_area` original e é normalizado junto com o corpo pelo resolvedor comum. `id`
 * deve bater com o `pin.id` real devolvido pelo
 * Core — é por `id`, nunca por posição no array, que o renderizador casa pino declarado com pino
 * real (um `McuComponent`/subcircuito pode devolver pinos em ordem diferente da declarada). */
export interface PackageNumberExpression {
  prop?: string;
  index?: string;
  multiplier?: number;
  offset?: number;
  fallback?: number;
  min?: number;
  max?: number;
  round?: "trunc" | "round" | "floor" | "ceil";
  /** Aplicado ao valor bruto de `prop`/`index` ANTES de `multiplier`/`offset`/`round` -- só
   * `"log2Ceil"` existe hoje (`ceil(log2(valor))`, valor<=1 vira 0), espelha
   * `DynamicPinCountFn::Log2Ceil` do lado Core (`Types.hpp`). Ex: `active.analog_mux` -- posição Y
   * do pino `En` depende de `ceil(log2(channels))` linhas de endereço já desenhadas, não de
   * `channels` diretamente; sem isto não dá pra expressar essa posição só com multiplicador/offset
   * lineares. */
  transform?: "log2Ceil";
}

export type PackageNumberValue = number | PackageNumberExpression;

export interface PackageDynamicPinGroup {
  countProp: string;
  /** Como `countProp` vira a CONTAGEM de pinos deste grupo -- ausente/`"value"` é leitura direta
   * (default de sempre); `"log2Ceil"` é `ceil(log2(valor))`, espelha `DynamicPinCountFn::Log2Ceil`
   * do Core (`active.analog_mux`: grupo de endereço tem `ceil(log2(channels))` pinos, não
   * `channels` pinos). */
  countFn?: "value" | "log2Ceil";
  indexName?: string;
  idPrefix?: string;
  idStart?: PackageNumberValue;
  x: PackageNumberValue;
  y: PackageNumberValue;
  angle?: PackageNumberValue;
  length?: PackageNumberValue;
  leadEndTrim?: PackageNumberValue;
  leadColor?: string;
  label?: string;
}

export interface PackageDynamicLayout {
  width?: PackageNumberValue;
  height?: PackageNumberValue;
  schematicWidth?: PackageNumberValue;
  schematicHeight?: PackageNumberValue;
  simulideBounds?: Partial<Record<"x" | "y" | "w" | "h", PackageNumberValue>>;
  replacePins?: boolean;
  pinGroups?: PackageDynamicPinGroup[];
}

export interface PackagePin {
  id: string;
  aliases?: string[];
  stateVisible?: SimulidePaintStateVisible;
  kind?: string;
  /** Ponto elétrico real em coordenadas locais. É também o início visual do lead e o ponto usado
   * pelo wire; o contato com o corpo é derivado exclusivamente de `angle` + `length`. */
  x: PackageNumberValue;
  y: PackageNumberValue;
  angle: PackageNumberValue;
  length: PackageNumberValue;
  leadEndTrim?: PackageNumberValue;
  leadColor?: string;
  label?: string;
  labelColor?: string;
  labelFontSize?: PackageNumberValue;
  labelSpace?: PackageNumberValue;
  labelStateVisible?: SimulidePaintStateVisible;
  labelTextAnchor?: "start" | "middle" | "end";
  labelDominantBaseline?: "auto" | "middle" | "central" | "hanging" | "text-before-edge" | "text-after-edge";
  /** Posição do RÓTULO, independente da posição do pino -- igual ao SimulIDE real (texto de pino,
   * texto do CI etc são objetos arrastáveis à parte, nunca presos a um deslocamento fixo do pino).
   * Em coordenadas ORIGINAIS do package (mesmo espaço de `x`/`y`, antes do deslocamento de
   * `resolvePackageLayout`). Ausente == posição padrão calculada (ponta do lead + 9 unidades na
   * direção do `angle`, com rótulo girado -90° se o lead for vertical) -- mesmo comportamento de
   * sempre, nunca quebra um `package` escrito antes deste campo existir. */
  labelX?: PackageNumberValue;
  labelY?: PackageNumberValue;
  /** Rotação (graus, CSS) do texto do rótulo -- só tem efeito junto de `labelX`/`labelY` (posição
   * customizada); o cálculo automático (sem `labelX`/`labelY`) já deriva sua própria rotação do
   * `angle` do pino, ver `packagePinLeadSvg`. */
  labelRotation?: PackageNumberValue;
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
  /** Troca declarativa do `d` de um path por propriedade da instância. Útil para símbolos cuja
   * geometria muda por uma propriedade discreta, sem criar helper TS por `typeId` (ex: gates com
   * 2..8 entradas). */
  statePath?: { prop: string; map: Record<string, string>; fallback?: string };
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
  | ({ kind: "line"; x1: PackageNumberValue; y1: PackageNumberValue; x2: PackageNumberValue; y2: PackageNumberValue; stateFill?: SimulidePaintStateFill; stateVisible?: SimulidePaintStateVisible } & SimulidePaintStyle)
  | ({ kind: "rect"; x: PackageNumberValue; y: PackageNumberValue; w: PackageNumberValue; h: PackageNumberValue; rx?: PackageNumberValue; ry?: PackageNumberValue; stateFill?: SimulidePaintStateFill; stateVisible?: SimulidePaintStateVisible } & SimulidePaintStyle)
  | ({ kind: "roundedRect"; x: PackageNumberValue; y: PackageNumberValue; w: PackageNumberValue; h: PackageNumberValue; rx: PackageNumberValue; ry: PackageNumberValue; stateFill?: SimulidePaintStateFill; stateVisible?: SimulidePaintStateVisible } & SimulidePaintStyle)
  | ({ kind: "ellipse"; cx: PackageNumberValue; cy: PackageNumberValue; rx: PackageNumberValue; ry: PackageNumberValue; stateFill?: SimulidePaintStateFill; stateVisible?: SimulidePaintStateVisible } & SimulidePaintStyle)
  | ({ kind: "arc"; x: PackageNumberValue; y: PackageNumberValue; w: PackageNumberValue; h: PackageNumberValue; startDeg: PackageNumberValue; spanDeg: PackageNumberValue; stateFill?: SimulidePaintStateFill; stateVisible?: SimulidePaintStateVisible } & SimulidePaintStyle)
  | ({ kind: "path"; d: string; stateFill?: SimulidePaintStateFill; stateVisible?: SimulidePaintStateVisible } & SimulidePaintStyle)
  | ({ kind: "polygon"; points: Array<{ x: number; y: number }>; stateFill?: SimulidePaintStateFill; stateVisible?: SimulidePaintStateVisible } & SimulidePaintStyle)
  | ({ kind: "polyline"; points: Array<{ x: number; y: number }>; stateFill?: SimulidePaintStateFill; stateVisible?: SimulidePaintStateVisible } & SimulidePaintStyle)
  | ({ kind: "text"; x: PackageNumberValue; y: PackageNumberValue; value: string; fontSize?: PackageNumberValue; textAnchor?: PackageShape["textAnchor"]; dominantBaseline?: PackageShape["dominantBaseline"]; fontFamily?: string; fontWeight?: string | number; stateFill?: SimulidePaintStateFill; stateVisible?: SimulidePaintStateVisible; stateText?: SimulidePaintStateText } & SimulidePaintStyle)
  | ({ kind: "image"; x: PackageNumberValue; y: PackageNumberValue; w: PackageNumberValue; h: PackageNumberValue; href: string; preserveAspectRatio?: string; stateFill?: SimulidePaintStateFill; stateVisible?: SimulidePaintStateVisible; stateHref?: SimulidePaintStateHref } & SimulidePaintStyle)
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

/** typeId de `connectors.tunnel` -- ponto único (TR-7, .spec/lasecsimul-native-devices.spec), usado
 * nos vários lugares (main.ts/componentSymbols.ts/extension.ts) que tratam este
 * conector como exceção (rótulo derivado ao vivo do nome do net, geometria variável, id embutido no
 * próprio SVG) -- cada exceção continua com sua própria lógica/justificativa local (não são cópias
 * do mesmo comportamento, ver histórico de cada call site), só a STRING do typeId é compartilhada
 * aqui em vez de repetida como literal em cada arquivo. */
export const TUNNEL_TYPE_ID = "connectors.tunnel";

/** typeId dedicado de "um pino sendo autorado no Modo Símbolo" (refatoração Subcircuito/Símbolo/
 * Ícone) -- componente de cena NORMAL (mesmo drag/rotate/copy/undo de qualquer outro), sem
 * singleton/marker-flag (substitui `other.package_pin`, removido junto do resto de
 * `subcircuitPackageAuthoring.ts`). Compartilhado entre `main.ts` (Webview, renderização/geometria/
 * interação) e `catalog/subcircuitSymbolScene.ts` (host, materialize/compile pro `PackageDescriptor`)
 * -- mesmo precedente de `TUNNEL_TYPE_ID` acima, já que `main.ts` nunca pode importar de `catalog/`
 * (fora do `rootDir` de `tsconfig.webview.json`). */
export const SYMBOL_PIN_TYPE_ID = "symbol.pin";

/** typeIds elegíveis pra marcar como elemento decorativo do Package durante "Abrir Subcircuito"
 * (`WebviewComponentModel.packageShapeRole: true`) -- cada um já é um componente NORMAL, visível na
 * paleta geral (`graphics.*`, categoria "Graphical"), com contraparte direta em `PackageShape.kind`.
 * `polygon`/`path`/`svg` (formatos de arquivo sem typeId de cena equivalente) ficam de fora -- sem
 * precedente de autoria, fora de escopo. Compartilhado entre `subcircuitPackageAuthoring.ts` (host)
 * e `main.ts` (Webview) -- mesmo motivo de `TUNNEL_TYPE_ID` acima, `model.ts` não tem dependência de
 * Node. */
export const PACKAGE_SHAPE_TYPE_IDS = ["graphics.line", "graphics.image", "graphics.text", "graphics.rectangle", "graphics.ellipse"] as const;
export type PackageShapeTypeId = (typeof PACKAGE_SHAPE_TYPE_IDS)[number];

/** Propriedade numérica interna (mesmo estilo `__ui_packageUnit`/`__simulideTunnelRotated` já usado
 * nesta base) que guarda a ordem de pintura entre os elementos marcados com `packageShapeRole` --
 * `PackageShape` não tem `id`/`zIndex` (ver mais abaixo), então a ordem do array `package.shapes[]`
 * É o único sinal de z-order; a posição do componente em `state.components` sozinha não é confiável
 * (fica intercalada com componentes do circuito interno). Mutada só pelos comandos "Trazer pra
 * frente"/"Enviar pra trás" (`main.ts`), lida por `compilePackageAuthoringComponents`
 * (`subcircuitPackageAuthoring.ts`). */
export const PACKAGE_SHAPE_ORDER_PROPERTY_KEY = "__packageShapeOrder";

/** typeId de `connectors.junction` -- mesmo princípio de `TUNNEL_TYPE_ID`, ponto elétrico sem
 * símbolo/rótulo visível (sempre `hidden: true`), tratado como exceção nos mesmos arquivos. */
export const JUNCTION_TYPE_ID = "connectors.junction";

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
  /** `propRangeMinProp`/`propRangeMaxProp` (achado 2026-07-10, mesmo motivo de `ViewSpecLimit.
   * minProp/maxProp`): quando presentes, sobrescrevem `propRange[0]`/`propRange[1]` com o valor AO
   * VIVO dessas propriedades -- pra desenhar o nub na posição certa (ex: fontes controladas com
   * `minValue`/`maxValue` editáveis) já no primeiro render, não só durante um arrasto ativo. */
  | { kind: "rotate"; prop: string; stepsPerRev: number; stepsPerRevProp?: string; cx: number; cy: number; propRange?: [number, number]; propRangeMinProp?: string; propRangeMaxProp?: string; angleRange?: [number, number] }
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
 * angular de um knob, faixa em pixels de um slider, min/max/step de propriedade. `minProp`/`maxProp`
 * (achado 2026-07-10 -- fontes de tensão/corrente controladas): quando presentes, o min/max real é
 * lido AO VIVO das `properties` da instância (mesmo nome de propriedade, ex: `minValue`/`maxValue`
 * de `sources.voltage_source`/`current_source`) em vez do `min`/`max` fixo daqui -- necessário pra
 * dispositivos cujo range é editável pelo usuário (diferente de `passive.variable_resistor`/etc,
 * cujo 0-10000 nunca muda). `min`/`max` continuam servindo de FALLBACK se a propriedade não existir
 * ainda na instância. Mesmo padrão já usado por `ViewSpecInteraction.dragAngular.stepsPerRevProp`. */
export interface ViewSpecLimit {
  min?: number;
  max?: number;
  minProp?: string;
  maxProp?: string;
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
  /** Quando true, `paint[]` e hit-test do ViewSpec sao renderizados por cima de `simulidePaint`/
   * `qtWidget`. Isso permite widgets/dials declarativos sem duplicar o corpo traduzido do C++. */
  overlayPaint?: boolean;
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
  /** `simulide-local`: pinos, labels e `simulidePaint.primitives` compartilham as coordenadas locais
   * reais do QGraphicsItem. `simulidePaint.bounds` (`m_area`) é a única origem usada para converter
   * todos eles para a caixa de exibição. Ausente preserva packages autorados em 0..width/height. */
  coordinateSpace?: "simulide-local";
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
  dynamicLayout?: PackageDynamicLayout;
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
  /** Aparência ESPECÍFICA do Modo Placa -- SEM equivalente no SimulIDE real (lá, `m_graphical`
   * escolhe só POSIÇÃO/visibilidade, nunca uma forma de desenho diferente; pesquisado a fundo em
   * `subpackage.cpp`/`component.cpp`, ver `.spec` seção 26.1/27). Recurso PRÓPRIO do LasecSimul,
   * pedido explicitamente pelo usuário depois dessa auditoria: um componente `graphical` pode
   * declarar uma segunda `PackageDescriptor` (mesmo formato de `package`, incluindo `simulidePaint`/
   * estado via `stateFill`/`stateVisible`) usada SÓ quando renderizado em contexto de Modo Placa
   * (dentro da edição do subcircuito com Modo Placa ligado, OU no overlay da instância no circuito
   * principal) -- nunca no esquemático normal, que continua usando `package`/`logicSymbolPackage`
   * de sempre. Ausente == Modo Placa reusa o mesmo `package` do esquemático (comportamento anterior,
   * preservado). Mesma instância/estado/pinos elétricos o tempo todo -- isto troca só QUAL
   * `PackageDescriptor` é usado pra desenhar, nunca cria um componente/cópia paralela. */
  boardPackage?: PackageDescriptor;
  /** Igual ao `m_graphical` do SimulIDE real (setado por classe em `component.cpp`) -- typeIds "de
   * interação do usuário" (LED, motor, display, switch, ...) que podem aparecer no overlay de Modo
   * Placa de uma instância de subcircuito. Ausente == `false`. */
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
  /** Tipo da fonte registrada que originou esta entrada -- usado pela Webview para ajustar menus e
   * ações específicas de subcircuito/MCU/QEMU. */
  registeredSourceKind?: "abi-device" | "mcu-adapter" | "subcircuit-file";
  /** `true` quando esta entrada representa um MCU direto (`mcu-adapter`) OU um subcircuito que
   * hospeda um MCU interno (ex: DevKit/WROOM com ESP32 QEMU dentro). */
  mcuHost?: boolean;
  /** Portas seriais expostas pelo MCU/subcircuito. Ausente significa que a UI nao oferece monitor serial. */
  serialPorts?: McuSerialPortEntry[];
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
  /** Fonte única de verdade de conectividade+geometria de fio -- substitui os antigos `wires[]`/
   * `topologyNodes[]`/`topologyRevision` separados (Fase C completa, `.spec` seção 25.6).
   * `topology.revision` é o contador de CAS otimista entre Webview/Host/Core; `topology.nodes` são
   * nós de topologia (nunca componentes); `topology.conductors` é a lista de fios -- mesmo objeto
   * que era `wires` antes, só que agora vive dentro de `topology` e usa `CanonicalEndpoint` tipado
   * em vez de `{componentId,pinId}` plano assumindo por convenção que nó e porta compartilham o
   * mesmo espaço de string. */
  topology: CanonicalTopologyDocument;
  locale?: "pt-BR" | "en";
  catalog: WebviewComponentCatalogEntry[];
  components: WebviewComponentModel[];
  /** `x`/`y` = pan, `zoom` = escala — aplicado via CSS transform no wrapper `.canvas-content`
   * (`main.ts`), com `eventToCanvasPoint` invertendo a transformação pra todo cálculo de coordenada
   * tela→canvas continuar correto em qualquer zoom (ver `.spec/lasecsimul.spec` seção 13.4). */
  viewport: { x: number; y: number; zoom: number };
  /** Seleção múltipla (marquee/Shift+click) — array vazio == nada selecionado, nunca `undefined`
   * (mais simples de testar que opcional). Substituiu `selectedComponentId?: string` singular. */
  selectedComponentIds: string[];
  selectedWireIds: string[];
  /** Origem transitória da ferramenta de fios. Uma origem sobre segmento permanece apenas como
   * draft: o fio alvo não é dividido até o usuário confirmar o destino. `kind` é opcional no caso
   * pin para manter estados de Webview já armazenados compatíveis. */
  pendingConnection?:
    | { kind?: "pin"; componentId: string; pinId: string }
    | { kind: "wire"; wireId: string; point: WebviewPoint };
  /** Presente enquanto `components`/`wires` representam o circuito INTERNO de um `.lssubcircuit`
   * aberto via "Abrir Subcircuito" (menu de contexto de uma instância `subcircuit-file`), não o
   * circuito principal do usuário -- ver `extension.ts::openSubcircuitForEditingCommand`. A Webview
   * usa isto pra mostrar a faixa "Editando subcircuito" com o botão "Voltar ao Circuito Principal" e
   * desabilitar Abrir/Salvar/Importar Projeto (formatos incompatíveis: `.lsproj` vs `.lssubcircuit`)
   * enquanto durar a sessão. */
  subcircuitEditingContext?: { sourceId: string; typeId: string; name: string };
  /** Cena do Modo Símbolo (refatoração Subcircuito/Símbolo/Ícone) -- elementos gráficos + pinos
   * externos autorados via WYSIWYG, MESMO vocabulário de componente (`WebviewComponentModel`) que
   * `components[]`, só que NUNCA misturado a ele (substitui o antigo `other.package`/
   * `other.package_pin` como objetos ocultos dentro de `components`). Só populado enquanto
   * `subcircuitEditingContext` está presente; vazio == símbolo ainda sem elementos autorados. */
  symbolElements: WebviewComponentModel[];
  /** Cena do Modo Ícone -- mesmo papel de `symbolElements`, pro ícone do catálogo. Nunca tem pinos
   * (`TUNNEL_TYPE_ID`/pino externo não fazem sentido num ícone, só elementos gráficos). */
  iconElements: WebviewComponentModel[];
  /** Tamanho/borda/fundo do CANVAS do Símbolo/Ícone -- propriedade do DOCUMENTO
   * (`SubcircuitDocument.symbol/icon.width/height/border/background`, `catalog/subcircuitDocument.ts`,
   * host), nunca um componente de cena (não há mais nenhum objeto "corpo do Package" pra duplicar/
   * apagar por engano -- eliminação estrutural da classe de bug "2 Package na cena"). Ausente ==
   * ainda sem Símbolo/Ícone autorado (mesmo padrão de `symbolElements`/`iconElements` vazios). */
  symbolCanvas?: { width: number; height: number; border?: boolean; background?: PackageBackground };
  iconCanvas?: { width: number; height: number; border?: boolean; background?: PackageBackground };
  /** Projeções de componentes internos expostos no Símbolo (absorve "Modo Placa") -- espelha
   * `catalog/subcircuitDocument.ts::ExposedComponentEntry` (mesmo shape, duplicado aqui só porque
   * `model.ts` nunca pode importar de `catalog/`, que transitivamente depende de `fs`/Node via
   * `packageSanitizers.ts`). `componentId` referencia `components[].id` por identificador
   * PERSISTENTE, nunca por índice -- nunca uma cópia do componente interno, só apresentação. */
  exposedComponents: Array<{
    componentId: string;
    x: number;
    y: number;
    rotation: 0 | 90 | 180 | 270;
    flipH: boolean;
    flipV: boolean;
    scale: number;
    layer: number;
  }>;
}
