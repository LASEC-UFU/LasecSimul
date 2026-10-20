# Laboratório de Cálculo — guia de uso e distribuição

Para professores que montam aulas no LasecSimul e para quem mantém ou empacota a extensão. O desenho e as decisões estão em
[50–57](50-laboratorio-calculo-investigacao.md); desde 2026-10-20 o Laboratório é uma **Tela HMI** do projeto
([doc 65](65-unificacao-visual-implementacao.md)): as atividades são páginas da tela e cada atividade é um elemento.

## 1. Abrir

- No esquemático, duplo clique no botão **Laboratório de Cálculo** (Tela HMI; com a simulação rodando, um clique), ou
- paleta de comandos (Ctrl+Shift+P) → **LasecSimul: Laboratório de Cálculo** (sem uma tela do Laboratório no projeto, ela é
  criada com as atividades-modelo e o botão aparece no esquemático, em Controle › Ferramentas).

A tela abre no **contexto Laboratório**: o cabeçalho do Laboratório com as páginas como abas, já em operação (modo aluno).
Como qualquer Tela HMI, ela pode ficar acoplada ao VS Code, numa janela flutuante (outro monitor) ou em **tela cheia** (botão
no canto superior direito; Esc ou F11 saem). As atividades-modelo, na ordem pedagógica:

| Aba | O que o aluno faz | Precisa do simulador? |
|---|---|---|
| Funções — explorador | edita f e g, move parâmetros a, b, c; vê raízes, interseções, assíntotas, f′ e F = ∫f; arrasta o ponto sobre f (ou usa as setas) | não |
| Sensor 4–20 mA | função afim P → I; acha 12 mA, escreve a inversa, passa de Pmax e vê a saturação (3,8–20,5 mA) | sim: `subcircuits.process.sensor_4_20` |
| Limites | quociente incremental com tabela bilateral, limite exato ou evidência numérica, Δt = 0 indefinido, modo ε–δ com contraexemplo | não |
| Eixo | trajetória S x(t) = L(3τ² − 2τ³): v e a exatas, tangente em t₀ arrastável | não |
| Primeira ordem | degrau em τ·y′ + y = K·u; instante de 63,2 % e tangente em t₀; mudar u durante a execução | sim: `subcircuits.process.first_order_lab` |
| Tanque | da vazão à integral: V(t), h(t), q(t), Riemann (esquerda, direita, ponto médio, trapézio) sobre a série gravada, A ao vivo com derramamento, saída por bomba, válvula (q = k·h) ou orifício de Torricelli (q = c·√h) | sim: `subcircuits.process.hydraulic_tank` |

Cada atividade traz **etapas** (prever → explorar → formalizar → aplicar) com dicas; o aluno avança no próprio ritmo.

## 2. Atividades com o simulador

As abas de processo ligam-se à instância da planta correspondente no projeto (subsistema interno ou sistema externo). Se não houver nenhuma, o painel oferece
**Inserir no projeto**. Com o processo ligado:

- **Executar / Pausar / Reiniciar** controlam a simulação. Reiniciar volta aos parâmetros da atividade e começa uma série nova.
- Parâmetros marcados como *ao vivo* (vazões, área A, u, P) mudam durante a execução; os de configuração (V₀, h máx., K, τ,
  faixa do sensor, tipo de saída) só com a simulação parada — o painel explica quando recusa.
- Os gráficos mostram o que o Core gravou, com o instante exato de cada amostra e de cada mudança de parâmetro. Cursor, marcadores
  a/b, n e método de Riemann são **inspeção**: não mexem no simulador e funcionam com a simulação pausada.

## 3. Modo professor = edição da tela

**Editar** (cabeçalho) põe a tela em edição; as atividades passam ao modo professor.

- **Duplo clique numa atividade** edita "por dentro": **Gravar atividade** guarda o que está na tela (modelo, parâmetros, vista,
  pergunta) no elemento da atividade. Clicar fora da atividade volta à edição da página.
- **+ Página do Laboratório…** (barra de edição) insere uma página com uma atividade-modelo; páginas se renomeiam, reordenam e
  excluem como em qualquer Tela HMI. No Inspector da atividade: **Atividade** (troca pelo modelo de outro tipo), **Ocupar a página**
  e **Planta** (o id da instância do projeto que o experimento usa; vazio = a única do tipo).
- Na mesma página cabem outros elementos: indicadores e controles da HMI e os **elementos matemáticos** (Miscelâneos › Grafico ›
  Matemática): gráfico de função, parâmetro, equação, tabela de valores e tendência. Os parâmetros (`a`, `b`…) valem para as
  expressões dos outros elementos da página.
- **Desfazer/Refazer** (Ctrl+Z / Ctrl+Y) valem para a tela inteira, também numa janela flutuante.
- Editar altera o projeto em memória; **salve o `.lsproj`** (botão Salvar da tela, Ctrl+S no esquemático ou *LasecSimul: Save
  Project*). Séries gravadas e estado da simulação nunca vão para o arquivo.

**Apresentação** (cabeçalho, em operação) amplia textos e números de todas as atividades para projetar em sala.

## 4. Exemplos prontos

Em `examples/calculo/`:

| Arquivo | Conteúdo |
|---|---|
| `laboratorio-calculo.lsproj` | as seis atividades, a página "Funções — elementos da tela" e as três plantas (tanque, primeira ordem, sensor) |
| `tanque.lsproj`, `primeira-ordem.lsproj`, `sensor.lsproj` | uma planta e a atividade dela |
| `funcoes-e-limites.lsproj` | as atividades analíticas e a página de elementos (o esquemático fica só com o botão) |

Abrir o `.lsproj` mostra no esquemático o botão **Laboratório de Cálculo** e as plantas. As plantas são subsistemas internos do
projeto (tabela `subsystems`): não dependem da paleta nem de arquivos externos. Cada planta tem um **Faceplate** (painel de
operação): menu da instância › **Abrir Faceplate da instância** mostra volume/nível/vazões (tanque), u/y (primeira ordem) ou
P/I (sensor) com sliders e uma tendência, valendo só para aquela instância.

Projetos antigos (com `calculusLab`) abrem normalmente: as atividades viram a tela do Laboratório com o botão, e a próxima
gravação já sai no formato novo.

São gerados por `scripts/generate-calculus-lab-examples.cjs` (depois de `npm run compile` em `extension/`); as plantas-modelo (`.lssubcircuit`), por
`scripts/generate-hydraulic-tank.py`, `generate-first-order-lab.py` e `generate-sensor-4-20.py` (o caminho de saída é o argumento).

## 5. Teclado matemático e expressões

- Abas **123**, **f(x)** e **Cálculo** (∫ definida, d/dx, lim, lim⁺/lim⁻, Σ, Π, ∞, por partes, < ≤ > ≥). Em Funções, a opção
  F = ∫ f desenha a acumulada a partir do limite inferior definido na atividade.
- Digitação direta: `x^2`, `sqrt(x)`, `sin(x)`, `se(x < 1, x^2, 2x - 1)` para funções por partes.
- Tab avança entre os campos de um modelo (limites de integração, índice de somatório).
- Resultados dizem como foram obtidos: **exato** (regra simbólica) ou **evidência numérica** (amostragem, bisseção, Simpson);
  o laboratório não declara convergência que não verificou.

## 6. Para quem mantém

| Comando (em `extension/`) | Verifica |
|---|---|
| `npm test` | unidades, incluindo `calc`, `analysis`, `EditorModel`, `LabGraph`, `units`, `SeriesBuffer`, `SeriesStore`, `audit` e `noEval` (o laboratório roda sob CSP sem `unsafe-eval`) |
| `npm run test:lab:core` | Core real: gravador de séries, tanque (aceites de [53 §2.6](53-laboratorio-calculo-experimentos-e-tanque.md)), primeira ordem e sensor, Oscope por deltas |
| `npm run test:lab:e2e` | VS Code real: a tela do Laboratório, atividades analíticas, professor por dentro, páginas-modelo, apresentação, CSP |
| `npm run test:lab:tank:e2e` | VS Code + Core reais, aberto pelo botão do exemplo: tanque, primeira ordem, sensor, inspeção sem mensagens, gravar e reabrir |
| `npm run test:visual:math:e2e` | elementos matemáticos e tela cheia do Laboratório nos dois monitores |
| `npm run test:pid:e2e` | diálogo de sintonia PID com o miniplot e as séries do Core |
| `npm run test:telemetry:baseline` | bytes e duração de telemetria e da janela do Oscope ([54 §0.1](54-laboratorio-calculo-validacao-e-riscos.md)) |

Os testes de Core real e os e2e precisam do Core compilado (`npm run build:core -- --config Release` na raiz). Compile só os alvos
necessários e rode os executáveis de teste um de cada vez: o build completo com paralelismo irrestrito pode travar a máquina.

**Empacotamento.** O VSIX leva `out/`, `out-webview/` e `media/`. A atividade embutida usa `out-webview/lab-embed/lab.js` (um
arquivo AMD, `tsconfig.lab-embed.json`, gerado por `npm run compile`) inline num `<iframe>`, pelo mesmo motivo do miniplot abaixo. Por isso o CSS do laboratório fica em `media/lab/lab.css` (o commit
da tag v0.0.94 ainda o deixava fora; essa versão não chegou a ser publicada) e o gráfico do PID em `media/pid/miniplot.js`. O diálogo PID é um iframe `srcdoc`
que não consegue buscar recursos da Webview: o miniplot é injetado inline pelo `PidTuningPanel`. Subcircuitos novos entram em
`subcircuits/library.json`, exceto plantas: estas não são registradas globalmente, ficam em `subcircuits/plants.json` e entram
nos projetos incorporadas (ver `extension/src/project/plantTemplates.ts`). Ids de componentes internos não podem repetir ids de
pinos do símbolo (o validador recusa a biblioteca).
