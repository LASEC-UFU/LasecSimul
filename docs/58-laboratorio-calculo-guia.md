# Laboratório de Cálculo — guia de uso e distribuição

Para professores que montam aulas no LasecSimul e para quem mantém ou empacota a extensão. O desenho e as decisões estão em
[50–57](50-laboratorio-calculo-investigacao.md); o estado da implementação, em [54 §0](54-laboratorio-calculo-validacao-e-riscos.md).

## 1. Abrir

1. Abra um projeto `.lsproj` (ou nenhum, para as atividades analíticas).
2. Paleta de comandos (Ctrl+Shift+P) → **LasecSimul: Laboratório de Cálculo**.

Sem atividades gravadas no projeto, o painel mostra as **atividades-modelo**, uma por tipo, na ordem pedagógica:

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

## 3. Modo professor

O botão **Modo professor** no cabeçalho liga o modo de autoria:

- Cada atividade ganha **Gravar atividade no projeto**: o que está na tela (modelo, parâmetros, vista, pergunta) vira a definição.
- **Editor de atividades**: adicionar por tipo, reordenar, duplicar, remover; editar título, pergunta, expressões, faixas,
  parâmetros e etapas; escolher a instância do projeto que a atividade usa. Referências quebradas (componente renomeado ou removido)
  aparecem como aviso, com **religar** ou **desligar** — a atividade continua abrindo.
- **Desfazer/Refazer** (botões do editor ou Ctrl+Z / Ctrl+Y fora de campos de texto) valem para a definição do laboratório.
- Gravar no laboratório altera o projeto em memória; **salve o `.lsproj`** (Ctrl+S no esquemático ou *LasecSimul: Save Project*) para
  guardar no arquivo. Séries gravadas e estado da simulação nunca vão para o arquivo.

**Apresentação** (cabeçalho) amplia textos e números para projetar em sala; a escolha fica guardada no painel.

## 4. Exemplos prontos

Em `examples/calculo/`:

| Arquivo | Conteúdo |
|---|---|
| `laboratorio-calculo.lsproj` | as seis atividades e as três plantas (tanque, primeira ordem, sensor) |
| `tanque.lsproj`, `primeira-ordem.lsproj`, `sensor.lsproj` | uma planta e a atividade dela |
| `funcoes-e-limites.lsproj` | só as atividades analíticas (o esquemático fica só com a nota) |

Abrir o `.lsproj` mostra no esquemático as plantas e uma nota com o caminho do laboratório; as atividades aparecem no painel
(**LasecSimul: Laboratório de Cálculo**). As plantas são subsistemas internos do projeto (tabela `subsystems`): não dependem da paleta nem de arquivos externos.

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
| `npm run test:lab:e2e` | VS Code real: atividades analíticas, editor, apresentação, CSP |
| `npm run test:lab:tank:e2e` | VS Code + Core reais: tanque, primeira ordem, sensor, inspeção sem mensagens, gravar e reabrir |
| `npm run test:pid:e2e` | diálogo de sintonia PID com o miniplot e as séries do Core |
| `npm run test:telemetry:baseline` | bytes e duração de telemetria e da janela do Oscope ([54 §0.1](54-laboratorio-calculo-validacao-e-riscos.md)) |

Os testes de Core real e os e2e precisam do Core compilado (`npm run build:core -- --config Release` na raiz). Compile só os alvos
necessários e rode os executáveis de teste um de cada vez: o build completo com paralelismo irrestrito pode travar a máquina.

**Empacotamento.** O VSIX leva `out/`, `out-webview/` e `media/`. Por isso o CSS do laboratório fica em `media/lab/lab.css` (o commit
da tag v0.0.94 ainda o deixava fora; essa versão não chegou a ser publicada) e o gráfico do PID em `media/pid/miniplot.js`. O diálogo PID é um iframe `srcdoc`
que não consegue buscar recursos da Webview: o miniplot é injetado inline pelo `PidTuningPanel`. Subcircuitos novos entram em
`subcircuits/library.json`, exceto plantas: estas não são registradas globalmente, ficam em `subcircuits/plants.json` e entram
nos projetos incorporadas (ver `extension/src/project/plantTemplates.ts`). Ids de componentes internos não podem repetir ids de
pinos do símbolo (o validador recusa a biblioteca).
