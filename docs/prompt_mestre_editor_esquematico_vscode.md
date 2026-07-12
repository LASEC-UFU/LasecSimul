# Prompt mestre — Editor de esquemáticos elétricos de alto desempenho no Visual Studio Code

> **Finalidade:** este arquivo deve ser entregue integralmente a um agente de IA com acesso ao repositório do projeto. O agente deverá pesquisar, decidir, implementar, testar, medir e documentar a arquitetura do editor de esquemáticos, sem se limitar a produzir um planejamento teórico.
>
> **Escopo:** editor visual de circuitos elétricos dentro do **Visual Studio Code**, com experiência de conexão semelhante ao SimulIDE, KiCad, Qucs-S e Simulink, mas com arquitetura própria, modular, testável e otimizada para atualização de tela.
>
> **Data-base da pesquisa:** 11 de julho de 2026.

---

## 1. Síntese da pesquisa e decisão recomendada

### 1.1 Decisão principal

Adote como arquitetura preferencial:

- **Eclipse GLSP** como plataforma de edição gráfica e protocolo cliente-servidor;
- **Sprotty** como base de renderização e interação no cliente gráfico;
- integração oficial por:
  - `@eclipse-glsp/vscode-integration`;
  - `@eclipse-glsp/vscode-integration-webview`;
- servidor de linguagem gráfica em **Node.js + TypeScript**, inicialmente integrado à extensão;
- núcleo de domínio independente de GLSP, VS Code, DOM, SVG e simulador;
- documento textual versionado em JSON;
- motor próprio de topologia elétrica;
- roteador ortogonal incremental;
- tarefas pesadas em Web Worker, `worker_threads` ou processo separado;
- simulação desacoplada da taxa de renderização.

Essa é a rota com melhor separação entre:

1. modelo de domínio;
2. operações e comandos;
3. transporte;
4. apresentação;
5. persistência;
6. validação;
7. simulação.

### 1.2 Rota alternativa para MVP

Faça obrigatoriamente um *spike* comparativo com **AntV X6**.

O X6 é uma alternativa muito forte quando o objetivo prioritário é obter rapidamente:

- portas;
- conexões;
- seleção;
- ferramentas de aresta;
- minimapa;
- alinhamento;
- eventos;
- customização SVG/HTML;
- uma experiência visual funcional com menos infraestrutura.

A escolha definitiva entre GLSP/Sprotty e X6 não deve ser baseada apenas em preferência. Deve resultar de um benchmark reproduzível dentro do Webview do VS Code.

### 1.3 Alternativas secundárias

| Tecnologia | Posição | Uso recomendado |
|---|---:|---|
| Eclipse GLSP + Sprotty | Principal | Produto de longo prazo, domínio complexo, validação, múltiplos clientes, operações e integração profunda com VS Code |
| AntV X6 | Finalista | MVP rápido, UX rica de diagramas, menor custo inicial |
| maxGraph | Alternativa | Bom conjunto maduro de edição, roteamento ortogonal, layout e undo/redo |
| JointJS Core | Avaliar | Bom motor SVG; verificar licença e dependência de recursos comerciais do JointJS+ |
| React Flow | Não usar como núcleo sem benchmark excepcional | Bom para interfaces baseadas em nós, mas não deve ditar a topologia elétrica |
| ELK/elkjs | Componente auxiliar | Auto-organização e layout em lote; não é motor de edição nem renderizador |
| libavoid | Experimento de roteamento | Roteamento ortogonal desviando de obstáculos; avaliar compilação para WebAssembly |
| jsPlumb Community Edition | Rejeitado | O repositório comunitário não recebe mais atualizações |

### 1.4 Princípio central

**Uma linha desenhada não é, por si só, uma conexão elétrica.**

O projeto deve manter separados:

- o grafo visual;
- a geometria dos fios;
- o grafo topológico;
- as redes elétricas derivadas;
- o netlist de simulação.

Não represente o circuito apenas como `nodes[]` e `edges[]` de uma biblioteca gráfica.

---

# 2. PROMPT PARA O AGENTE DE IA

## 2.1 Papel

Atue simultaneamente como:

- arquiteto de software sênior;
- engenheiro de ferramentas gráficas;
- especialista em TypeScript;
- desenvolvedor de extensões do Visual Studio Code;
- especialista em algoritmos geométricos;
- especialista em editores de esquemáticos;
- engenheiro de desempenho;
- responsável por testes, documentação e migração.

Você deve **executar** a solução no repositório atual. Não entregue somente sugestões genéricas.

---

## 2.2 Objetivo

Construir ou reestruturar o editor de esquemáticos para que ele permita:

- inserir dispositivos;
- expor e reconhecer pinos;
- iniciar fios a partir de pinos, junções ou segmentos;
- criar linhas ortogonais;
- adicionar, remover e mover quinas;
- criar derivações;
- distinguir cruzamento sem conexão de junção elétrica;
- conectar fios a dispositivos;
- conectar fio a fio;
- arrastar segmentos;
- mover dispositivos preservando conexões;
- dividir e unir segmentos automaticamente;
- trabalhar com barramentos;
- trabalhar com rótulos de rede;
- representar alimentação e terra;
- suportar subcircuitos hierárquicos;
- gerar um netlist canônico;
- validar o circuito;
- integrar futuramente ou imediatamente um simulador;
- manter boa fluidez em circuitos grandes;
- oferecer comportamento previsível de desfazer/refazer;
- salvar em formato textual versionável;
- funcionar como editor customizado no Visual Studio Code.

A experiência final deve ser competitiva com editores como SimulIDE, KiCad e Qucs-S, mantendo a facilidade visual de ferramentas como Simulink.

---

## 2.3 Regras de execução

1. Analise primeiro o repositório atual.
2. Não presuma que o projeto precisa ser reescrito.
3. Preserve as funcionalidades existentes.
4. Não recupere uma arquitetura antiga do Git sem demonstrar, por benchmark e análise, que ela é superior.
5. Prefira migração incremental, adaptadores e *feature flags*.
6. Não peça autorização a cada etapa.
7. Tome decisões técnicas justificadas em ADRs.
8. Compile e teste após cada mudança estrutural.
9. Não esconda pendências.
10. Não marque um item como concluído sem teste verificável.
11. Se o repositório atual já tiver modelo, comandos, solver ou formato de arquivo, faça inventário e mapa de impacto antes de alterar contratos.
12. Não acople o núcleo elétrico à biblioteca de diagrama escolhida.
13. Toda otimização deve ter medição antes e depois.
14. Todo comportamento visual importante deve possuir teste de interação.
15. Toda alteração de formato deve possuir migração e teste de compatibilidade.

---

# 3. Pesquisa obrigatória nos códigos existentes

Clone apenas para estudo, em diretório externo ou em `research/vendor-readonly`. Não copie trechos incompatíveis com a licença do projeto.

## 3.1 Eclipse GLSP e Sprotty

Estude:

- https://github.com/eclipse-glsp/glsp-vscode-integration
- https://github.com/eclipse-glsp/glsp-vscode-integration/tree/master/example/workflow
- https://github.com/eclipse-glsp/glsp-examples
- https://github.com/eclipse-glsp/glsp-client
- https://github.com/eclipse-sprotty/sprotty

Investigue especificamente:

- criação do servidor GLSP;
- integração da extensão com Webview;
- transporte de ações e operações;
- registro de tipos gráficos;
- modelo gráfico;
- *model factory*;
- comandos;
- edição de arestas;
- ferramentas;
- seleção;
- validação;
- *dirty state*;
- atualização incremental;
- reconexão;
- persistência;
- suporte a extensão web;
- como o exemplo `workflow` organiza pacotes.

## 3.2 AntV X6

Estude:

- https://github.com/antvis/X6
- documentação oficial e exemplos de:
  - ports;
  - connecting;
  - routers;
  - connectors;
  - edge tools;
  - snapline;
  - selection;
  - minimap;
  - keyboard;
  - history;
  - scroller;
  - clipboard;
  - embedding.

Avalie se o X6 consegue ser usado somente como camada de apresentação, recebendo um *view model* do núcleo, sem se tornar o modelo canônico.

## 3.3 maxGraph

Estude:

- https://github.com/maxGraph/maxGraph

Avalie:

- roteadores `orthogonal`, `Manhattan` e `elbow`;
- histórico;
- eventos;
- edição de arestas;
- *stencils*;
- serialização;
- escalabilidade;
- modernização do legado mxGraph;
- facilidade de integração com um documento elétrico próprio.

## 3.4 SimulIDE

Estude como referência conceitual, principalmente:

- https://github.com/Arcachofo/SimulIDE-dev
- `src/components/connectors`
- `src/components/component.cpp`
- `src/components/linker.cpp`
- `src/components/node.cpp`

Mapeie:

- representação de pino;
- representação de nó;
- conectores;
- união de elementos;
- atualização visual;
- relação entre componente, conexão e simulação;
- interação do usuário ao desenhar fios.

**Atenção:** o SimulIDE utiliza AGPL. Não copie código para um projeto com licença incompatível. Reimplemente conceitos de forma independente quando necessário.

## 3.5 KiCad Eeschema

Estude:

- https://gitlab.com/kicad/code/kicad/-/tree/master/eeschema

Pesquise no código por:

- wire;
- junction;
- bus;
- connection;
- net;
- line;
- schematic;
- move;
- drag;
- break;
- trim;
- heal;
- connectivity.

Observe principalmente:

- diferença entre item visual e conectividade;
- atualização incremental;
- junções;
- labels;
- barramentos;
- hierarquia;
- ERC;
- ferramentas de fio;
- comportamento ao mover símbolos e segmentos.

## 3.6 Qucs-S

Estude:

- https://github.com/ra3xdh/qucs_s

Pesquise por:

- `Schematic`;
- `Wire`;
- `Node`;
- `MouseActions`;
- `installWire`;
- `wire stretching`;
- `createNetlist`;
- `labelled nets`;
- `dangling nets`.

Use como referência para:

- movimentação com esticamento;
- topologia;
- geração de netlist;
- separação entre geometria e simulação;
- prevenção de travamento da interface com grandes volumes de dados.

## 3.7 CircuitJS1

Estude:

- https://github.com/sharpie7/circuitjs1
- https://github.com/sharpie7/circuitjs1/tree/master/src/com/lushprojects/circuitjs1

Use como referência para:

- laço de simulação;
- desacoplamento entre cálculo e desenho;
- animação de corrente;
- atualização visual;
- estrutura de elementos.

Não use seu legado GWT/Java como modelo arquitetural principal para a nova implementação.

## 3.8 Roteamento e layout

Estude:

- https://github.com/kieler/elkjs
- https://www.adaptagrams.org/documentation/libavoid.html
- repositório do Adaptagrams/libavoid.

Regra:

- ELK deve ser usado para **layout em lote**, organização automática ou distribuição de blocos;
- ELK não deve ser chamado a cada movimento de ponteiro;
- libavoid deve ser avaliado em um *spike* isolado;
- se libavoid for usado no Webview, prefira WebAssembly e Worker;
- mantenha um roteador TypeScript simples como *fallback*.

---

# 4. Fase zero — auditoria do repositório atual

Antes de implementar, gere:

- `docs/auditoria/editor-esquematico-atual.md`;
- `docs/auditoria/mapa-de-dependencias.md`;
- `docs/auditoria/modelo-atual-vs-modelo-alvo.md`;
- `docs/auditoria/riscos-de-migracao.md`.

A auditoria deve responder:

1. Onde está o modelo canônico atual?
2. Componentes, fios, junções e topologia são objetos separados?
3. Há arrays paralelos?
4. Há “pontes temporárias” de conversão?
5. Quem é responsável por salvar?
6. Quem é responsável por desfazer/refazer?
7. Quem calcula conectividade?
8. Quem cria o netlist?
9. O Webview envia o documento inteiro ou patches?
10. O estado transitório de interação está misturado ao documento?
11. A simulação depende diretamente da geometria?
12. Existe roteamento?
13. Existe índice espacial?
14. Um `pointermove` altera estado global?
15. O circuito inteiro é recalculado ao alterar um fio?
16. O circuito inteiro é renderizado ao mover um dispositivo?
17. Como IDs são gerados?
18. O formato possui versão?
19. Existem migrações?
20. Existem testes de topologia?
21. Existem benchmarks?
22. Há vazamentos de listeners, timers, workers ou objetos do Webview?
23. Quais APIs públicas não podem ser quebradas?
24. Quais dispositivos serão afetados?
25. Quais funcionalidades atuais precisam de teste de caracterização antes da mudança?

Crie testes de caracterização para o comportamento atual antes de refatorar áreas críticas.

---

# 5. Fase zero B — comparação GLSP/Sprotty versus X6

Implemente dois protótipos descartáveis e equivalentes.

## 5.1 Cena mínima comum

Cada protótipo deve conter:

- 100 componentes;
- 1.000 componentes;
- 5.000 componentes;
- quatro pinos por componente;
- 1.000, 10.000 e 50.000 segmentos;
- zoom e pan;
- seleção;
- arraste de componente;
- criação de fio ortogonal;
- *snap* em pino;
- arraste de segmento;
- destaque de rede;
- atualização de um subconjunto de componentes;
- troca de tema;
- abertura dentro do VS Code.

## 5.2 Métricas obrigatórias

Meça:

- tamanho do bundle;
- tempo de ativação da extensão;
- tempo até a primeira pintura útil;
- tempo de carregamento do documento;
- FPS médio;
- p95 e p99 do tempo de quadro;
- latência ponteiro-pintura;
- tempo de atualização de 1, 10 e 100 elementos;
- consumo de memória;
- quantidade de nós DOM;
- volume de mensagens entre extensão e Webview;
- tempo de criação de fio;
- tempo de seleção;
- tempo de pan/zoom;
- facilidade de implementar ferramentas customizadas;
- facilidade de testar;
- clareza da separação entre domínio e renderização;
- custo estimado de manutenção.

## 5.3 Critérios de decisão

A escolha deve considerar, nesta ordem:

1. correção da topologia;
2. desacoplamento arquitetural;
3. previsibilidade de edição;
4. desempenho;
5. integração com VS Code;
6. testabilidade;
7. extensibilidade;
8. experiência do usuário;
9. licença;
10. tempo de implementação.

Produza:

- `docs/adr/ADR-001-engine-grafico.md`;
- `benchmarks/engine-spike/results.json`;
- `benchmarks/engine-spike/report.md`;
- gravações ou GIFs curtos dos testes;
- instrução reproduzível para executar o benchmark.

Se GLSP e X6 apresentarem desempenho equivalente, prefira GLSP pela arquitetura. Se o custo de GLSP for desproporcional e mensurado, use X6 como apresentação, mas mantenha o núcleo e o protocolo independentes.

---

# 6. Arquitetura-alvo

## 6.1 Visão em camadas

```text
┌──────────────────────────────────────────────────────────────┐
│ Visual Studio Code                                           │
│  comandos, arquivos, save, hot-exit, undo/redo, tema         │
└───────────────────────┬──────────────────────────────────────┘
                        │
┌───────────────────────▼──────────────────────────────────────┐
│ Adaptador VS Code / GLSP Integration                          │
│  sessões por URI, transporte, segurança, lifecycle            │
└───────────────────────┬──────────────────────────────────────┘
                        │ ações, operações e patches
┌───────────────────────▼──────────────────────────────────────┐
│ Application Layer                                             │
│  Command Bus, transações, histórico, validação, migrations     │
└───────────────┬──────────────────────────────┬────────────────┘
                │                              │
┌───────────────▼──────────────┐  ┌────────────▼───────────────┐
│ Domain Model                 │  │ Topology/Geometry          │
│ componentes, pinos, fios,    │  │ nets, junções, interseção, │
│ sheets, labels, barramentos  │  │ índice espacial, roteamento│
└───────────────┬──────────────┘  └────────────┬───────────────┘
                │                              │
┌───────────────▼──────────────────────────────▼───────────────┐
│ Ports                                                         │
│ persistência, biblioteca, simulador, importação, exportação    │
└───────────────┬──────────────────────────────┬────────────────┘
                │                              │
┌───────────────▼──────────────┐  ┌────────────▼───────────────┐
│ JSON / Workspace             │  │ Solver / Core / ABI        │
└──────────────────────────────┘  └────────────────────────────┘
```

## 6.2 Hexagonal e independente

O pacote de domínio não pode importar:

- `vscode`;
- GLSP;
- Sprotty;
- X6;
- React;
- DOM;
- SVG;
- Canvas;
- WebGL;
- Node `fs`;
- APIs do simulador.

O domínio deve funcionar em testes Node puros.

## 6.3 Estrutura recomendada do monorepo

Adapte os nomes ao repositório existente sem criar duplicação desnecessária.

```text
apps/
  vscode-extension/
  webview/
  benchmark-host/

packages/
  circuit-domain/
  circuit-commands/
  circuit-topology/
  circuit-geometry/
  circuit-router/
  circuit-protocol/
  circuit-validation/
  circuit-persistence/
  circuit-library/
  circuit-netlist/
  simulator-adapter/
  glsp-server/
  glsp-client/
  x6-spike/
  testing/
  performance/

docs/
  adr/
  architecture/
  audit/
  performance/
  migration/
  licensing/

examples/
  basic/
  hierarchy/
  buses/
  stress/
```

Use:

- TypeScript em modo `strict`;
- pnpm workspace;
- compilação incremental;
- lint;
- formatação;
- Vitest;
- Playwright;
- `fast-check` para testes baseados em propriedades;
- validação de schema com Zod, JSON Schema ou solução equivalente;
- dependências fixadas por lockfile.

---

# 7. Modelo canônico de documento

## 7.1 Regras

1. Use coordenadas inteiras no espaço lógico do esquema.
2. Nunca salve pixels de tela como coordenada canônica.
3. Use IDs estáveis.
4. O zoom não altera o documento.
5. Estado de hover, seleção temporária e prévia não pertence ao documento.
6. Redes elétricas são derivadas da topologia.
7. Cache derivado pode existir, mas deve ser invalidável e reconstruível.
8. O formato deve possuir `schemaVersion`.
9. Ordene arrays de maneira determinística ao salvar quando isso não alterar semântica.
10. O documento deve produzir diffs legíveis.
11. Definições de dispositivos devem ser separadas de instâncias.
12. Símbolo, modelo elétrico e package/footprint devem ser conceitos distintos.
13. Um subcircuito deve usar o mesmo modelo de folha de um circuito principal.

## 7.2 Tipos de referência

Implemente tipos equivalentes aos seguintes. Ajuste após a auditoria.

```ts
export type Id<T extends string> = string & { readonly __brand: T };

export type DocumentId = Id<'DocumentId'>;
export type SheetId = Id<'SheetId'>;
export type ComponentId = Id<'ComponentId'>;
export type DeviceDefinitionId = Id<'DeviceDefinitionId'>;
export type PinId = Id<'PinId'>;
export type JunctionId = Id<'JunctionId'>;
export type WirePathId = Id<'WirePathId'>;
export type LabelId = Id<'LabelId'>;
export type BusId = Id<'BusId'>;
export type NetId = Id<'NetId'>;

export interface GridPoint {
  readonly x: number;
  readonly y: number;
}

export type QuarterTurn = 0 | 1 | 2 | 3;

export interface Transform2D {
  readonly position: GridPoint;
  readonly rotation: QuarterTurn;
  readonly mirrorX: boolean;
  readonly mirrorY: boolean;
}
```

## 7.3 Documento e folhas

```ts
export interface CircuitDocument {
  readonly schemaVersion: number;
  readonly id: DocumentId;
  readonly metadata: DocumentMetadata;
  readonly libraries: LibraryReference[];
  readonly rootSheetId: SheetId;
  readonly sheets: Readonly<Record<SheetId, SchematicSheet>>;
  readonly settings: DocumentSettings;
}

export interface SchematicSheet {
  readonly id: SheetId;
  readonly name: string;
  readonly grid: GridSettings;
  readonly components: Readonly<Record<ComponentId, ComponentInstance>>;
  readonly junctions: Readonly<Record<JunctionId, Junction>>;
  readonly wirePaths: Readonly<Record<WirePathId, WirePath>>;
  readonly labels: Readonly<Record<LabelId, NetLabel>>;
  readonly buses: Readonly<Record<BusId, Bus>>;
  readonly graphics: readonly GraphicItem[];
}
```

## 7.4 Definição e instância de dispositivo

```ts
export interface DeviceDefinition {
  readonly id: DeviceDefinitionId;
  readonly version: string;
  readonly displayName: string;
  readonly symbol: SymbolDefinition;
  readonly pins: readonly PinDefinition[];
  readonly electricalModel?: ElectricalModelReference;
  readonly package?: PackageReference;
  readonly propertySchema: PropertySchema;
}

export interface PinDefinition {
  readonly id: PinId;
  readonly name: string;
  readonly number?: string;
  readonly localPosition: GridPoint;
  readonly orientation: QuarterTurn;
  readonly electricalType:
    | 'passive'
    | 'input'
    | 'output'
    | 'bidirectional'
    | 'powerInput'
    | 'powerOutput'
    | 'openCollector'
    | 'openEmitter'
    | 'triState'
    | 'notConnected';
  readonly required: boolean;
}

export interface ComponentInstance {
  readonly id: ComponentId;
  readonly definitionId: DeviceDefinitionId;
  readonly reference: string;
  readonly transform: Transform2D;
  readonly properties: Readonly<Record<string, unknown>>;
  readonly variant?: string;
  readonly unit?: string;
  readonly subcircuitSheetId?: SheetId;
}
```

## 7.5 Nós topológicos e caminhos de fio

Não armazene um fio complexo como uma única “edge” sem semântica. Modele caminhos entre âncoras topológicas.

```ts
export type ConnectionAnchor =
  | {
      readonly kind: 'pin';
      readonly componentId: ComponentId;
      readonly pinId: PinId;
    }
  | {
      readonly kind: 'junction';
      readonly junctionId: JunctionId;
    }
  | {
      readonly kind: 'dangling';
      readonly position: GridPoint;
    }
  | {
      readonly kind: 'hierarchicalPort';
      readonly componentId: ComponentId;
      readonly portId: string;
    }
  | {
      readonly kind: 'busEntry';
      readonly busId: BusId;
      readonly entryId: string;
    };

export interface Junction {
  readonly id: JunctionId;
  readonly position: GridPoint;
  readonly explicit: boolean;
}

export interface WirePath {
  readonly id: WirePathId;
  readonly source: ConnectionAnchor;
  readonly target: ConnectionAnchor;
  readonly vertices: readonly GridPoint[];
  readonly routing: {
    readonly mode: 'manual' | 'orthogonal' | 'automatic';
    readonly lockedVertexIndexes: readonly number[];
  };
  readonly style?: WireStyle;
}
```

Interprete `vertices` como quinas internas. Os pontos inicial e final são resolvidos pelas âncoras.

## 7.6 Redes derivadas

```ts
export interface DerivedNet {
  readonly id: NetId;
  readonly anchors: readonly ConnectionAnchor[];
  readonly wirePathIds: readonly WirePathId[];
  readonly labelNames: readonly string[];
  readonly hierarchicalName: string;
  readonly electricalSummary: ElectricalNetSummary;
  readonly revision: number;
}
```

Regras:

- `DerivedNet` não é a fonte primária da geometria;
- deve ser reconstruível;
- pode ser cacheado;
- IDs podem ser mantidos estáveis quando a conectividade não muda;
- labels iguais podem unir redes conforme a regra de escopo;
- terra e alimentação devem ser tratados por semântica, não apenas por aparência;
- um barramento não deve ser automaticamente tratado como uma única rede elétrica.

---

# 8. Motor de topologia

## 8.1 Responsabilidades

O motor deve:

- resolver posição global de pinos;
- encontrar âncoras próximas;
- detectar segmentos;
- detectar interseções;
- criar junções;
- dividir caminhos;
- unir caminhos colineares;
- remover segmentos de comprimento zero;
- remover quinas colineares redundantes;
- descobrir componentes conexas;
- manter redes derivadas;
- invalidar apenas regiões afetadas;
- emitir um delta topológico;
- gerar netlist;
- fornecer dados para ERC.

## 8.2 Estruturas de dados

Use uma combinação de:

- mapa por ID;
- índice espacial para componentes e pinos;
- índice espacial para segmentos;
- índice especializado para segmentos ortogonais;
- conjuntos de adjacência;
- Union-Find/Disjoint Set para adições;
- reconstrução localizada por BFS/DFS para remoções e divisões;
- `dirty sets`;
- cache de posição global de pinos por revisão do componente.

Para fios ortogonais, considere índices por linha e coluna:

```text
horizontalByY: Map<y, IntervalIndex<x1, x2, segmentId>>
verticalByX:   Map<x, IntervalIndex<y1, y2, segmentId>>
```

Isso facilita:

- achar cruzamentos;
- achar segmentos sob o cursor;
- detectar sobreposição colinear;
- recortar regiões afetadas;
- evitar varrer todos os fios.

## 8.3 Atualização incremental

Em uma operação local:

1. determine o retângulo afetado;
2. remova do índice somente os itens antigos afetados;
3. aplique a mutação;
4. normalize a geometria local;
5. reinsira itens alterados;
6. determine as redes candidatas a invalidação;
7. reconstrua somente as componentes conexas afetadas;
8. gere `TopologyDelta`;
9. notifique validação, renderização e simulador;
10. não reconstrua o documento inteiro.

Exemplo de delta:

```ts
export interface TopologyDelta {
  readonly addedNets: readonly NetId[];
  readonly removedNets: readonly NetId[];
  readonly changedNets: readonly NetId[];
  readonly changedComponents: readonly ComponentId[];
  readonly changedWirePaths: readonly WirePathId[];
  readonly affectedBounds: Rect;
  readonly topologyRevision: number;
}
```

## 8.4 Invariantes

Garanta por teste:

- não existe segmento de comprimento zero;
- não existem vértices colineares redundantes;
- toda junção referenciada existe;
- toda âncora de pino referencia componente e pino válidos;
- um ponto de cruzamento sem junção não conecta redes;
- um T intencional cria junção;
- caminhos colineares equivalentes podem ser normalizados sem alterar conectividade;
- desfazer restaura documento e topologia;
- refazer reproduz o mesmo hash canônico;
- salvar e abrir preserva semântica;
- mover componente não perde conexão lógica;
- apagar uma derivação não separa redes indevidamente;
- apagar a ponte correta separa a rede em duas;
- labels seguem as regras de escopo;
- barramentos preservam largura e mapeamento.

---

# 9. Semântica visual dos fios

## 9.1 Cruzamento

Implemente quatro situações distintas:

1. linhas se cruzam sem conexão;
2. uma extremidade encosta em um segmento e cria T;
3. junção explícita une três ou mais ramos;
4. “salto” ou ponte visual opcional para cruzamento sem conexão.

Não crie conexão elétrica por mera sobreposição de pixels.

## 9.2 Junção

A junção deve:

- ser pequena;
- manter tamanho legível;
- não virar uma bola exagerada ao selecionar;
- respeitar zoom sem dominar o desenho;
- usar estilo de tema;
- aparecer somente quando semanticamente necessário;
- ter alvo de clique maior e invisível que sua marca visual.

## 9.3 Caminho ortogonal

Comportamentos:

- clique em pino inicia fio;
- movimento exibe prévia;
- clique adiciona quina;
- duplo clique ou clique em destino finaliza;
- `Enter` finaliza quando válido;
- `Esc` cancela transação;
- `Backspace` remove a última quina da prévia;
- `Tab` alterna orientação inicial horizontal/vertical;
- `Shift` pode bloquear eixo;
- clicar em segmento válido cria derivação;
- clicar no vazio pode criar ponta pendente somente se permitido;
- destino incompatível deve ser indicado antes do clique;
- reconectar uma extremidade não deve recriar o fio inteiro.

## 9.4 Arraste

Implemente:

- arraste de vértice;
- arraste de segmento horizontal;
- arraste de segmento vertical;
- esticamento local ao mover componente;
- preservação de quinas bloqueadas;
- roteamento parcial do primeiro e último trecho;
- opção “mover” versus “arrastar mantendo conexão”;
- cancelamento atômico.

---

# 10. Máquina de estados da interação

Não espalhe condicionais de ponteiro por componentes React ou views isoladas. Crie uma máquina de estados explícita.

Estados mínimos:

```ts
type InteractionState =
  | { kind: 'idle' }
  | { kind: 'hoveringPin'; candidate: PinAnchor }
  | { kind: 'wireArmed'; source: ConnectionAnchor }
  | { kind: 'drawingWire'; draft: WireDraft }
  | { kind: 'draggingVertex'; wireId: WirePathId; vertexIndex: number }
  | { kind: 'draggingSegment'; wireId: WirePathId; segmentIndex: number }
  | { kind: 'reconnectingEndpoint'; wireId: WirePathId; end: 'source' | 'target' }
  | { kind: 'movingSelection'; transactionId: string }
  | { kind: 'boxSelecting'; origin: GridPoint }
  | { kind: 'panning'; originClient: ClientPoint }
  | { kind: 'editingLabel'; labelId: LabelId };
```

Separe:

- estado persistente;
- estado transitório;
- estado de ferramenta;
- estado de câmera;
- estado de seleção.

A prévia de arraste não deve criar uma entrada de histórico por `pointermove`. Grave um único comando no `pointerup`.

---

# 11. Command Bus, transações e histórico

## 11.1 Todo comando deve ser reversível

Exemplos:

- `AddComponent`;
- `MoveComponents`;
- `RotateComponents`;
- `AddWirePath`;
- `SplitWirePath`;
- `ConnectToSegment`;
- `MoveWireVertex`;
- `MoveWireSegment`;
- `ReconnectWireEndpoint`;
- `DeleteSelection`;
- `AddJunction`;
- `RemoveJunction`;
- `SetComponentProperty`;
- `SetNetLabel`;
- `CreateBus`;
- `AddBusEntry`;
- `MigrateDocument`.

## 11.2 Envelope

```ts
export interface CommandEnvelope<TPayload = unknown> {
  readonly commandId: string;
  readonly transactionId: string;
  readonly documentUri: string;
  readonly baseRevision: number;
  readonly type: string;
  readonly payload: TPayload;
  readonly timestamp: number;
  readonly origin: 'webview' | 'extension' | 'migration' | 'importer';
}
```

## 11.3 Resultado

```ts
export interface CommandResult {
  readonly commandId: string;
  readonly accepted: boolean;
  readonly documentRevision: number;
  readonly patch?: CircuitPatch;
  readonly inversePatch?: CircuitPatch;
  readonly topologyDelta?: TopologyDelta;
  readonly diagnostics?: readonly Diagnostic[];
  readonly rejection?: {
    readonly code: string;
    readonly message: string;
    readonly details?: unknown;
  };
}
```

## 11.4 Regras

- um gesto corresponde a uma transação;
- comandos compostos são atômicos;
- undo/redo usa patches inversos ou comandos inversos testados;
- não envie o documento completo a cada gesto;
- valide `baseRevision`;
- trate mensagens duplicadas com `commandId`;
- mantenha sequência monotônica por documento;
- permita reabrir Webview e reconstruir a view a partir do modelo;
- não use `retainContextWhenHidden` como substituto de estado correto;
- use estado do Webview apenas para câmera, seleção e preferências transitórias recuperáveis.

---

# 12. Integração com Visual Studio Code

## 12.1 Documento textual

Prefira um arquivo textual como:

```text
*.eschem.json
```

ou mantenha o formato atual se já estiver consolidado e puder ser migrado.

Vantagens esperadas:

- diff no Git;
- recuperação;
- inspeção;
- migração;
- testes;
- compatibilidade com `CustomTextEditorProvider`;
- save, hot-exit e integração com o modelo de documento do VS Code.

Na rota GLSP, siga a integração oficial e conecte o *source model* textual ao servidor. Na rota X6, implemente um `CustomTextEditorProvider`.

## 12.2 Sessão por URI

Crie:

```ts
interface DocumentSession {
  readonly uri: string;
  readonly documentId: DocumentId;
  readonly modelRevision: number;
  readonly topologyRevision: number;
  readonly clients: ReadonlySet<ClientId>;
  readonly commandHistory: CommandHistory;
  readonly diagnostics: DiagnosticStore;
  readonly lifecycle: 'loading' | 'ready' | 'saving' | 'disposed';
}
```

Deve existir um modelo de documento por recurso, com múltiplas views possíveis.

## 12.3 Mensageria

Use mensagens pequenas, versionadas e discriminadas:

```ts
type HostToWebviewMessage =
  | { protocol: 1; type: 'initialize'; snapshot: ViewSnapshot }
  | { protocol: 1; type: 'applyPatch'; patch: ViewPatch }
  | { protocol: 1; type: 'commandResult'; result: CommandResult }
  | { protocol: 1; type: 'diagnostics'; items: Diagnostic[] }
  | { protocol: 1; type: 'themeChanged'; theme: ThemeTokens }
  | { protocol: 1; type: 'simulationFrame'; frame: SimulationFrame };

type WebviewToHostMessage =
  | { protocol: 1; type: 'ready'; clientCapabilities: ClientCapabilities }
  | { protocol: 1; type: 'executeCommand'; command: CommandEnvelope }
  | { protocol: 1; type: 'requestSnapshot'; knownRevision: number }
  | { protocol: 1; type: 'selectionChanged'; selection: SelectionState }
  | { protocol: 1; type: 'telemetry'; sample: LocalPerformanceSample };
```

## 12.4 Segurança

- Content Security Policy estrita;
- nonce para scripts;
- `localResourceRoots` mínimo;
- valide toda mensagem;
- não confie em dados do Webview;
- não exponha `acquireVsCodeApi()` globalmente;
- não use `eval`;
- sanitize SVG importado;
- bloqueie URL externa não autorizada;
- valide caminhos de arquivos;
- respeite Workspace Trust;
- encerre workers, listeners e timers em `dispose`.

---

# 13. Renderização de alto desempenho

## 13.1 Regra de ouro

Não faça o framework de UI renderizar novamente o diagrama inteiro em cada movimento.

Se React estiver presente:

- use React somente na casca da interface, painéis e propriedades;
- não mantenha todo o grafo como estado controlado atualizado a cada `pointermove`;
- memorize componentes;
- evite seletores que dependam de arrays completos;
- mantenha a interação crítica em controladores do motor gráfico;
- aplique o commit ao final do gesto.

## 13.2 Pipeline de quadro

```ts
class FrameScheduler {
  private pending = false;
  private dirty = DirtyFlags.none();

  invalidate(flags: DirtyFlags): void {
    this.dirty = this.dirty.merge(flags);
    if (this.pending) return;

    this.pending = true;
    requestAnimationFrame(() => {
      this.pending = false;
      const dirty = this.dirty;
      this.dirty = DirtyFlags.none();
      this.render(dirty);
    });
  }

  private render(dirty: DirtyFlags): void {
    // Atualizar somente câmera, overlay e elementos alterados.
  }
}
```

Use `PointerEvent.getCoalescedEvents()` quando disponível e benéfico, sem criar um commit para cada evento.

## 13.3 Camadas

Estruture visualmente:

1. fundo e grade;
2. fios;
3. símbolos;
4. labels;
5. seleção;
6. handles;
7. prévia de ferramenta;
8. diagnósticos;
9. animação de simulação.

A camada de interação deve ficar acima da camada estática.

## 13.4 SVG, Canvas e WebGL

Comece com a estratégia nativa do motor vencedor.

Para SVG:

- um `path` por caminho, não um elemento por trecho, quando possível;
- `vector-effect="non-scaling-stroke"` quando adequado;
- alvo invisível de hit-test com traço mais largo;
- remova elementos fora do viewport;
- agrupe transformações;
- evite filtros e sombras pesadas;
- não use HTML para cada pino;
- atualize atributos diretamente via mecanismo do motor;
- simplifique vértices colineares.

Somente migre fios estáticos para Canvas/WebGL se o benchmark demonstrar necessidade.

Uma arquitetura híbrida aceitável:

- Canvas/WebGL: grade, milhares de fios não selecionados, animações;
- SVG: componentes interativos, fio selecionado, handles e labels;
- overlay DOM: menus e editores de texto.

Não implemente o híbrido sem medir o custo de:

- sincronização de câmera;
- hit-test;
- acessibilidade;
- seleção;
- exportação;
- complexidade de manutenção.

## 13.5 Culling e nível de detalhe

Implemente:

- viewport culling;
- margem de pré-carregamento;
- índice espacial de itens visuais;
- ocultação de textos pequenos em zoom muito distante;
- redução de handles;
- simplificação de detalhes de símbolos;
- limite de animações;
- desativação de brilho e sombra em cenas grandes.

## 13.6 Estabilidade visual

- mantenha espessura coerente;
- evite tremulação de pixel;
- alinhe coordenadas de traço quando necessário;
- considere `devicePixelRatio`;
- preserve posição lógica durante zoom;
- não arredonde repetidamente coordenadas transformadas;
- transforme ponteiro de client space para world space uma única vez;
- aplique *snap* no espaço lógico.

---

# 14. Roteador ortogonal incremental

## 14.1 Modos

Implemente três modos:

1. **manual:** usuário controla quinas;
2. **ortogonal assistido:** motor cria uma ou duas quinas previsíveis;
3. **automático:** motor evita obstáculos.

O modo manual e o assistido são prioritários. O automático não deve atrasar a entrega das funções essenciais.

## 14.2 Custos do roteamento automático

Use uma função de custo equivalente a:

```text
custo =
  comprimento
  + pesoCurva × quantidadeDeCurvas
  + pesoCruzamento × cruzamentos
  + pesoObstáculo × colisões
  + pesoProximidade × proximidadeDeSímbolos
  + pesoMudança × diferençaDoCaminhoAnterior
```

O termo de estabilidade é importante para evitar que fios “pulem” entre rotas semelhantes ao mover um componente.

## 14.3 Preservação da intenção do usuário

- não altere vértices bloqueados;
- preserve segmentos manuais;
- reroteie somente o trecho afetado;
- ao mover um componente, ajuste primeiro o “stub” próximo ao pino;
- só recalcule todo o caminho em caso de conflito;
- permita converter rota automática em manual;
- permita travar rota.

## 14.4 Worker

Envie ao Worker apenas:

- obstáculos relevantes;
- endpoints;
- vértices bloqueados;
- retângulo de busca;
- pesos;
- revisão.

Cancele respostas antigas por revisão. Não aplique rota calculada para um estado obsoleto.

## 14.5 ELK

Use ELK para:

- auto-organizar folhas;
- layout hierárquico;
- distribuir blocos;
- organizar diagramas gerados.

Execute em Web Worker.

Não use ELK:

- no `pointermove`;
- para substituir ferramenta manual de fios;
- como fonte canônica de coordenadas sem confirmação do usuário.

## 14.6 libavoid

Faça um protótipo:

- C++ para WebAssembly;
- interface em Worker;
- roteamento ortogonal;
- obstáculos incrementais;
- conectores atualizados;
- teste com 100, 1.000 e 10.000 conectores.

Compare com roteador TypeScript.

Só adote se:

- a licença for compatível;
- o bundle for aceitável;
- a latência for melhor;
- a manutenção não ficar excessiva;
- houver fallback.

---

# 15. Biblioteca de componentes

## 15.1 Separação obrigatória

```text
DeviceDefinition
 ├─ SymbolDefinition
 ├─ PinDefinition[]
 ├─ PropertySchema
 ├─ ElectricalModelReference
 └─ PackageReference opcional

ComponentInstance
 ├─ definitionId
 ├─ transform
 ├─ reference
 ├─ property values
 └─ variant
```

A instância não deve duplicar todo o símbolo.

## 15.2 Pinos

Cada pino deve possuir:

- ID estável na definição;
- nome;
- número;
- posição local;
- orientação;
- tipo elétrico;
- visibilidade;
- regra de conexão;
- metadados para simulação;
- tooltip;
- alvo magnético.

## 15.3 Importadores

Se o projeto usa `.lsdevice`, crie um adaptador:

```text
.lsdevice → DeviceDefinition normalizada
```

Não faça o núcleo depender do parser `.lsdevice`.

Valide:

- duplicidade de pinos;
- pino sem posição;
- orientação inválida;
- referência de modelo inexistente;
- package incompatível;
- símbolo malformado.

---

# 16. Subcircuitos e hierarquia

Modele subcircuito como uma folha reutilizável.

Recursos:

- instância de subcircuito;
- portas hierárquicas;
- túneis;
- mapeamento de pinos;
- edição usando o mesmo editor;
- símbolo externo derivado ou associado;
- package/ícone separado;
- navegação entrar/sair;
- breadcrumb;
- validação de porta;
- netlist com caminho hierárquico;
- detecção de recursão;
- cache por definição/revisão.

Não crie um segundo motor de edição exclusivo para subcircuitos.

---

# 17. Validação elétrica e diagnósticos

Implemente ERC incremental.

Diagnósticos iniciais:

- pino obrigatório desconectado;
- ponta de fio pendente;
- rede sem referência;
- dois `powerOutput` conflitantes;
- múltiplas saídas digitais incompatíveis;
- pino `notConnected` conectado;
- label duplicado com conflito;
- referência de componente duplicada;
- barramento com largura incompatível;
- entrada de barramento inválida;
- subcircuito com porta ausente;
- propriedade obrigatória ausente;
- modelo de simulação ausente;
- loop hierárquico;
- fio de comprimento zero;
- junção órfã;
- segmento sobreposto inconsistente.

Cada diagnóstico deve possuir:

- código estável;
- severidade;
- mensagem;
- elemento;
- posição;
- revisão;
- *quick fix* quando possível.

Integre com:

- Problems do VS Code;
- destaque no esquema;
- painel de validação;
- navegação por diagnóstico.

---

# 18. Netlist e simulação

## 18.1 Limite arquitetural

O simulador não deve receber objetos gráficos.

Fluxo:

```text
CircuitDocument
  → DerivedTopology
  → CanonicalNetlist
  → SimulatorAdapter
  → Simulator
```

## 18.2 Netlist canônico

```ts
export interface CanonicalNetlist {
  readonly revision: number;
  readonly components: readonly NetlistComponent[];
  readonly nets: readonly NetlistNet[];
  readonly hierarchy: readonly HierarchicalInstance[];
  readonly probes: readonly ProbeDefinition[];
}
```

## 18.3 Atualização incremental

Forneça ao simulador:

- snapshot inicial;
- delta de parâmetros;
- delta de topologia;
- start;
- pause;
- stop;
- reset;
- step;
- alteração de firmware;
- alteração de modelo.

Se o simulador atual não suportar delta, mantenha o adaptador capaz de gerar snapshot completo sem contaminar o domínio.

## 18.4 Taxas independentes

Separe:

- taxa do solver;
- taxa de coleta;
- taxa de envio;
- taxa de renderização.

Exemplo:

- solver: conforme necessidade;
- agregação: janela ou amostragem;
- transporte: até 30–60 Hz;
- renderização: `requestAnimationFrame`.

Não envie uma mensagem por passo do solver.

Use:

- *throttling*;
- amostragem;
- buffers;
- `TypedArray`;
- transferência de buffers quando necessário;
- cancelamento por revisão.

---

# 19. Experiência do usuário

Implemente progressivamente:

## 19.1 Essenciais

- pan por botão do meio ou espaço;
- zoom centrado no ponteiro;
- seleção simples;
- multisseleção;
- seleção por área;
- copiar/colar;
- duplicar;
- apagar;
- desfazer/refazer;
- rotacionar;
- espelhar;
- alinhar;
- distribuir;
- *snap* na grade;
- *snap* magnético em pinos;
- paleta;
- busca de componente;
- painel de propriedades;
- atalhos;
- menu de contexto;
- salvar/cancelar em modos de edição;
- feedback de operação inválida.

## 19.2 Fios

- realce do pino candidato;
- realce de rede;
- prévia ortogonal;
- escolha de orientação;
- arraste de segmento;
- reconexão;
- criação de T;
- remoção de junção;
- labels;
- nome de rede;
- barramentos;
- jump-over opcional;
- detecção de ponta pendente.

## 19.3 Qualidade visual

- tema claro e escuro;
- tokens de cor do VS Code;
- sem bolas grandes em encontros;
- alvos de interação invisíveis;
- tooltip com nome e descrição;
- cursor correto por ferramenta;
- transições discretas;
- não depender apenas de cor;
- modo de alto contraste;
- respeito a `prefers-reduced-motion`.

## 19.4 Acessibilidade

- navegação por teclado;
- foco visível;
- descrição de componente;
- comando “ir para próximo pino”;
- comando “iniciar conexão”;
- anúncio de erros;
- atalhos configuráveis;
- painel textual alternativo da seleção;
- compatibilidade razoável com leitores de tela nos painéis.

---

# 20. Persistência, schema e migração

## 20.1 Exemplo de cabeçalho

```json
{
  "schemaVersion": 3,
  "generator": {
    "name": "nome-da-extensao",
    "version": "0.1.0"
  },
  "documentId": "..."
}
```

## 20.2 Regras

- schema versionado;
- parser tolerante somente onde for seguro;
- validação antes de carregar;
- mensagens de erro com localização;
- migrações puras e determinísticas;
- backup antes de migração destrutiva;
- teste de versões antigas;
- serialização canônica;
- números finitos;
- nenhum `undefined`;
- nenhum estado transitório;
- IDs referenciados validados.

## 20.3 Migrações

```ts
interface DocumentMigration {
  readonly from: number;
  readonly to: number;
  migrate(input: unknown): unknown;
}
```

Teste:

- V1 → V2;
- V2 → V3;
- V1 → V3;
- arquivo inválido;
- campos desconhecidos;
- IDs duplicados;
- round-trip.

---

# 21. Desempenho e orçamento

Use uma máquina de referência documentada e CI dedicada quando possível.

## 21.1 Metas iniciais

Cena típica:

- 1.000 componentes;
- 10.000 segmentos;
- 4.000 pinos visíveis.

Metas:

- pan/zoom p95 abaixo de 16,7 ms por quadro;
- nenhum congelamento maior que 100 ms em edição local;
- latência ponteiro-pintura p95 abaixo de 32 ms;
- commit de gesto local p95 abaixo de 50 ms;
- recálculo topológico local típico abaixo de 10 ms;
- primeira pintura útil abaixo de 1 s em máquina de referência;
- abertura completa da cena típica abaixo de 2 s;
- salvar sem bloquear a UI por mais de 100 ms;
- nenhuma reconstrução total em alteração local comum;
- nenhuma serialização completa por `pointermove`;
- nenhum envio contínuo do documento completo ao Webview.

Cena extrema:

- 5.000 componentes;
- 50.000 segmentos.

Meta:

- navegação utilizável;
- degradação controlada;
- LOD ativo;
- operações locais abaixo de 100 ms;
- sem crash;
- sem crescimento de memória após abrir/fechar repetidamente.

## 21.2 Instrumentação

Adicione:

- `performance.mark`;
- `performance.measure`;
- contador de quadros;
- histograma de frame time;
- Long Tasks;
- contagem de objetos visuais;
- contagem de mensagens;
- bytes por mensagem;
- tempo de topologia;
- tempo de roteamento;
- tempo de serialização;
- tempo de validação;
- heap antes/depois;
- número de redes invalidadas;
- número de elementos rerenderizados.

Crie um painel de desempenho ativado apenas em desenvolvimento.

## 21.3 Regressão

O CI deve falhar quando ultrapassar limiares definidos, com tolerância para variação de ambiente.

Mantenha:

- baseline versionada;
- relatório por commit;
- comparação percentual;
- cena determinística;
- seed fixa.

---

# 22. Testes

## 22.1 Unitários

- transformação de pino;
- rotação;
- espelhamento;
- snap;
- interseção;
- sobreposição;
- normalização;
- split;
- merge;
- junção;
- labels;
- barramentos;
- Union-Find;
- reconstrução localizada;
- netlist;
- migrações;
- comandos;
- patches;
- serialização.

## 22.2 Baseados em propriedades

Use `fast-check` ou equivalente.

Propriedades:

- `undo(execute(doc, cmd)) = doc`;
- salvar/abrir preserva hash semântico;
- ordem de inserção não muda conectividade;
- normalização é idempotente;
- mover e mover de volta preserva topologia;
- split + merge preserva rede;
- apagar ponte separa exatamente as componentes esperadas;
- cruzamento sem junção nunca une nets;
- T explícito sempre une;
- nenhuma sequência válida produz referência órfã.

## 22.3 Integração

- extensão abre arquivo;
- Webview inicializa;
- comando altera modelo;
- patch retorna;
- save grava;
- undo restaura;
- reabrir mantém estado;
- múltiplas views sincronizam;
- diagnóstico aparece;
- tema muda;
- worker é finalizado.

## 22.4 End-to-end com Playwright

Gestos:

- inserir componente;
- criar fio;
- criar quina;
- conectar em pino;
- derivar de segmento;
- cruzar sem conectar;
- criar junção;
- mover componente;
- arrastar segmento;
- reconectar;
- apagar;
- undo;
- redo;
- salvar;
- reabrir;
- zoom;
- pan;
- seleção múltipla;
- edição de propriedade.

## 22.5 Visual

- screenshots douradas;
- tema claro;
- tema escuro;
- alto contraste;
- zooms distintos;
- junções;
- crossing;
- seleção;
- erros;
- labels;
- barramentos;
- subcircuito.

## 22.6 Fuzz

Gere sequências aleatórias de comandos válidos e inválidos:

- adição;
- movimento;
- split;
- merge;
- exclusão;
- undo/redo;
- save/load.

Valide invariantes após cada passo.

---

# 23. Planejamento de implementação

## Etapa 1 — caracterização

Entregas:

- auditoria;
- testes do estado atual;
- cenas de referência;
- medições iniciais;
- mapa de contratos.

## Etapa 2 — spike dos motores

Entregas:

- GLSP funcional no VS Code;
- X6 funcional no VS Code;
- benchmark;
- ADR de decisão.

## Etapa 3 — núcleo de domínio

Entregas:

- tipos;
- schema;
- IDs;
- biblioteca;
- documento;
- migrações;
- comandos;
- testes.

Não conecte ainda ao simulador real.

## Etapa 4 — topologia

Entregas:

- índices;
- anchors;
- WirePath;
- Junction;
- DerivedNet;
- operações de split/merge;
- delta incremental;
- netlist;
- testes por propriedade.

## Etapa 5 — editor básico

Entregas:

- componente;
- pinos;
- fios;
- zoom;
- pan;
- seleção;
- propriedades;
- save;
- undo/redo.

## Etapa 6 — edição avançada de fio

Entregas:

- arraste de quina;
- arraste de segmento;
- reconexão;
- derivação;
- cruzamento;
- jump-over;
- labels;
- barramento;
- esticamento ao mover.

## Etapa 7 — desempenho

Entregas:

- culling;
- dirty rendering;
- worker;
- protocolo por patch;
- benchmark;
- correção de regressões;
- decisão SVG versus híbrido.

## Etapa 8 — validação e UX

Entregas:

- ERC;
- Problems;
- quick fixes;
- atalhos;
- tooltips;
- tema;
- acessibilidade;
- polimento visual.

## Etapa 9 — subcircuitos

Entregas:

- folhas;
- portas;
- túneis;
- instâncias;
- navegação;
- netlist hierárquico;
- validação.

## Etapa 10 — simulação

Entregas:

- adaptador;
- snapshot;
- deltas;
- lifecycle;
- valores;
- animação;
- throttling;
- testes de carga.

## Etapa 11 — empacotamento

Entregas:

- `.vsix`;
- documentação;
- exemplos;
- migração;
- changelog;
- inventário de licenças;
- benchmark final.

---

# 24. Critérios de aceite

A entrega não está pronta enquanto todos os itens abaixo não forem demonstrados.

## 24.1 Arquitetura

- núcleo não depende do renderer;
- renderer não é fonte canônica;
- topologia não depende do DOM;
- simulador não depende da geometria;
- operações são versionadas;
- arquivo possui schema;
- migrações testadas;
- sessões por URI;
- undo/redo atômico.

## 24.2 Conexões

- pino a pino;
- pino a segmento;
- segmento a segmento;
- T;
- cruzamento sem conexão;
- junção explícita;
- ponta pendente;
- reconexão;
- arraste de segmento;
- movimento preservando conexão;
- labels;
- barramentos;
- hierarquia.

## 24.3 Desempenho

- benchmark reproduzível;
- métricas antes/depois;
- metas da cena típica atendidas ou justificadas;
- sem atualização global por movimento local;
- sem solver na thread de UI;
- sem layout completo em `pointermove`;
- sem vazamento ao fechar Webview.

## 24.4 Qualidade

- unitários;
- propriedade;
- integração;
- E2E;
- visual;
- fuzz;
- CI;
- documentação;
- ADRs;
- licença.

---

# 25. Entregáveis obrigatórios

Crie ou atualize:

```text
docs/
  audit/
    editor-esquematico-atual.md
    mapa-de-dependencias.md
    modelo-atual-vs-modelo-alvo.md
    riscos-de-migracao.md
  adr/
    ADR-001-engine-grafico.md
    ADR-002-modelo-canonico.md
    ADR-003-topologia-e-nets.md
    ADR-004-command-bus-e-historico.md
    ADR-005-renderizacao.md
    ADR-006-roteamento.md
    ADR-007-integracao-vscode.md
    ADR-008-simulacao.md
    ADR-009-licenciamento.md
  architecture/
    overview.md
    domain-model.md
    topology.md
    interaction-state-machine.md
    protocol.md
    rendering.md
    performance.md
    persistence.md
    simulation.md
  migration/
    migration-plan.md
    compatibility-matrix.md
  licensing/
    third-party-review.md

benchmarks/
  engine-spike/
  typical-scene/
  extreme-scene/
  results.json
  report.md

examples/
  basic.eschem.json
  junctions.eschem.json
  buses.eschem.json
  hierarchy.eschem.json
  stress-1000.eschem.json
  stress-5000.eschem.json
```

Além disso:

- código implementado;
- testes;
- scripts de benchmark;
- gravação de demonstração;
- `.vsix`;
- changelog;
- instruções de desenvolvimento;
- instruções para depuração do Webview;
- matriz de funcionalidades;
- lista transparente de pendências.

---

# 26. Formato de trabalho e relatórios

Ao concluir cada etapa, informe:

1. o que foi encontrado;
2. a decisão tomada;
3. arquivos alterados;
4. testes executados;
5. métricas;
6. riscos;
7. compatibilidade;
8. pendências;
9. próxima etapa.

Não use frases vagas como “otimizado” ou “melhorado” sem números.

Exemplo:

```text
Antes:
- pointer-to-paint p95: 74 ms
- nós DOM: 43.120
- atualização local: 1.000 caminhos recriados

Depois:
- pointer-to-paint p95: 18 ms
- nós DOM: 9.480
- atualização local: 6 caminhos alterados
```

---

# 27. Proibições arquiteturais

Não faça:

- um array paralelo de topologia sem dono claro;
- uma “ponte temporária” que se torne permanente sem ADR;
- o renderer ser o banco de dados;
- guardar objeto X6/GLSP/Sprotty no documento;
- usar coordenada de tela como modelo;
- recalcular todas as redes por toda alteração;
- rerotear todos os fios em todo frame;
- rodar simulação na thread da interface;
- enviar o documento completo em todo gesto;
- salvar hover e seleção transitória no arquivo;
- usar React global state em todo `pointermove`;
- depender de `retainContextWhenHidden` para não perder dados;
- criar conexão por cruzamento acidental;
- usar uma bola visual grande como único indicador de conexão;
- misturar símbolo e package;
- duplicar definição do dispositivo em cada instância;
- copiar código GPL/AGPL sem decisão de licença;
- adotar jsPlumb Community Edition;
- escolher motor sem benchmark no VS Code;
- fazer reescrita total sem testes de caracterização;
- declarar concluído com testes ignorados.

---

# 28. Licenciamento

Antes de copiar ou derivar código:

1. identifique a licença;
2. registre no ADR;
3. analise compatibilidade com a licença do projeto;
4. prefira estudar comportamento e reimplementar;
5. mantenha atribuições;
6. gere inventário de dependências;
7. não misture código AGPL/GPL com base incompatível.

Pontos de atenção:

- SimulIDE: AGPL;
- CircuitJS1: GPL;
- JointJS Core: MPL;
- X6: MIT;
- maxGraph: Apache-2.0;
- GLSP/Sprotty/ELK: verificar a licença de cada módulo e versão utilizada;
- libavoid: verificar licença e obrigações da versão adotada.

---

# 29. Decisão prática esperada

A menos que o benchmark prove o contrário, a implementação final deve usar:

```text
Visual Studio Code
  + GLSP VS Code Integration
  + GLSP Server em TypeScript
  + Sprotty no Webview
  + circuito-domain independente
  + circuito-topology incremental
  + roteamento ortogonal próprio
  + ELK Worker para auto-layout
  + libavoid/WASM apenas se vencer benchmark
  + JSON textual versionado
  + Command Bus transacional
  + netlist canônico
  + simulador em processo/worker separado
```

A alternativa de contingência:

```text
Visual Studio Code CustomTextEditorProvider
  + AntV X6 como renderer/controller visual
  + os mesmos packages de domínio, comandos, topologia, protocolo e persistência
```

Mesmo na contingência, X6 não pode ser o modelo elétrico canônico.

---

# 30. Primeira sequência concreta de execução

Execute agora, nesta ordem:

1. detectar a raiz do repositório;
2. ler README, package manifests, specs, docs e testes;
3. localizar componentes, wires, topology, save/load, undo/redo e simulator;
4. gerar mapa de dependências;
5. adicionar testes de caracterização;
6. criar cenas de benchmark;
7. medir o editor atual;
8. criar branch de trabalho;
9. implementar spike GLSP;
10. implementar spike X6;
11. executar benchmark;
12. escrever ADR-001;
13. implementar o núcleo de domínio sem quebrar a UI atual;
14. criar adaptador do modelo atual;
15. implementar motor de topologia;
16. migrar uma ferramenta de fio;
17. validar compatibilidade;
18. migrar progressivamente as demais operações;
19. integrar persistência;
20. integrar simulação;
21. produzir `.vsix`;
22. apresentar resultado final com métricas.

Não pare após o planejamento. Prossiga até uma implementação funcional dentro das limitações reais do repositório.

---

# 31. Referências oficiais e códigos para estudo

## Visual Studio Code

- Webview API: https://code.visualstudio.com/api/extension-guides/webview
- Custom Editor API: https://code.visualstudio.com/api/extension-guides/custom-editors
- Custom Editor sample: https://github.com/microsoft/vscode-extension-samples/tree/main/custom-editor-sample

## GLSP e Sprotty

- https://eclipse.dev/glsp/
- https://github.com/eclipse-glsp/glsp-vscode-integration
- https://github.com/eclipse-glsp/glsp-examples
- https://github.com/eclipse-glsp/glsp-client
- https://github.com/eclipse-sprotty/sprotty

## Motores gráficos

- https://github.com/antvis/X6
- https://github.com/maxGraph/maxGraph
- https://github.com/clientIO/joint
- https://github.com/xyflow/xyflow

## Layout e roteamento

- https://github.com/kieler/elkjs
- https://www.adaptagrams.org/documentation/libavoid.html

## Editores e simuladores

- https://github.com/Arcachofo/SimulIDE-dev
- https://gitlab.com/kicad/code/kicad/-/tree/master/eeschema
- https://github.com/ra3xdh/qucs_s
- https://github.com/sharpie7/circuitjs1

---

# 32. Resultado final esperado do agente

Ao terminar, apresente:

- arquitetura escolhida;
- justificativa;
- diagrama;
- implementação funcional;
- demonstração das conexões;
- testes;
- benchmark;
- comparação antes/depois;
- lista de funcionalidades;
- compatibilidade;
- riscos;
- pendências reais;
- instruções para continuar;
- link ou caminho do `.vsix`;
- arquivos de exemplo.

A avaliação será feita principalmente por:

- correção;
- fluidez;
- previsibilidade da edição;
- clareza arquitetural;
- facilidade de evolução;
- qualidade de teste;
- capacidade de lidar com esquemas grandes.

