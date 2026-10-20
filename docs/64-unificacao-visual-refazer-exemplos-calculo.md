# Unificação visual — refazer as telas de `examples/calculo` na nova modalidade

**Classificação:** plano **[P]**, complemento de [62](62-unificacao-visual-arquitetura-e-documento.md) e
[63](63-unificacao-visual-plano-testes-riscos.md). Requisito do usuário (2026-10-19): *as telas hoje construídas em
`examples/calculo` precisam ser refeitas na nova modalidade*. **Refeitos em 2026-10-20** pelo gerador
`scripts/generate-calculus-lab-examples.cjs` (páginas-atividade, página de elementos e Faceplates das plantas); o que difere
do desenho página a página abaixo está no [doc 65](65-unificacao-visual-implementacao.md) §3.2.

## 1. Por que refazer, e não converter

Os exemplos de hoje não guardam telas: guardam **definições de atividade** (`calculusLab.activities[]`) cujo desenho está
no código das seis vistas (`TankView`, `LimitsView`…, doc 60 §4.2) **[C]**. Um conversor só conseguiria gerar
"uma página com a atividade X"; o pedido é que as telas existam como **documentos visuais editáveis** — o professor abre a
tela, entra em modo de edição e muda qualquer elemento, como numa HMI. Por isso os cinco projetos são **reconstruídos** a
partir dos modelos de página do produto (doc 62 §6.3), e as três plantas ganham Faceplates no motor novo.

Os exemplos novos substituem os atuais (política beta, ADR-0005 da `.spec`); os arquivos no formato antigo deixam de existir.

## 2. Inventário atual

Gerados por `scripts/generate-calculus-lab-examples.cjs` a partir de `lab.defaultActivities()` e de
`subcircuits/plants.json` **[C]**:

| Projeto | Esquemático | Plantas (subsistemas internos) | Atividades |
|---|---|---|---|
| `laboratorio-calculo.lsproj` | nota "Atividades: Ctrl+Shift+P → LasecSimul: Laboratório de Cálculo" + 3 plantas em coluna (x = 40) | `tanque-lab`, `primeira-ordem-lab`, `sensor-lab` | funções, sensor, limites, eixo, primeira ordem, tanque |
| `tanque.lsproj` | nota + `tanque-lab` | tanque | tanque |
| `primeira-ordem.lsproj` | nota + `primeira-ordem-lab` | primeira ordem | primeira ordem |
| `sensor.lsproj` | nota + `sensor-lab` | sensor | sensor |
| `funcoes-e-limites.lsproj` | 2 notas | — | funções, limites, eixo |

Plantas **[C]** (`subcircuits/process_*.lssubcircuit`, geradas por `scripts/generate-hydraulic-tank.py`,
`generate-first-order-lab.py`, `generate-sensor-4-20.py`):

| Planta | Componentes | Símbolo | Expostos (posição) | Interface | Propriedades exportadas |
|---|---|---|---|---|---|
| `hydraulic_tank` | 25 (constantes, `acc` acumulador, `h`, `q_out`, `vmax`, observadores, túneis, 7 gráficos) | 520×330, 6 formas | `g_tank` (150,50), `g_volume` (340,30), `g_level` (340,76), `g_qin` (340,122), `g_qout` (340,168), `g_overflow` (340,214), `g_area` (340,260) | `volume`, `level`, `level_pct`, `overflow` | `c_qin`, `c_qout`, `c_area`, `c_hmax`, `c_k`, `c_torr`, `c_outlet` |
| `first_order_lab` | 5 (`c_u`, `fo`, túnel, 2 displays) | 360×200, 4 formas | `g_u` (190,50), `g_y` (190,106) | `y` | `c_u`, `fo` |
| `sensor_4_20` | 9 (`c_p`, `c_pmin`, `c_pmax`, `i_raw`, `i_loop`, túneis, 2 displays) | 380×220, 5 formas | `g_p` (210,50), `g_i` (210,106) | `current`, `raw` | `c_p`, `c_pmin`, `c_pmax` |

## 3. Alvo por projeto

### 3.1 Esquemático

- A nota de instrução é substituída por um **botão Tela HMI** (`tools.hmi_screen`, Controle → Ferramentas, doc 62 §5)
  intitulado **"Laboratório de Cálculo"**, na posição da nota (x = 40, y = 20).
- As plantas continuam subsistemas internos, na mesma coluna; passam a ser desenhadas pela página `symbol` do Faceplate novo (§5).
- `funcoes-e-limites.lsproj` fica só com o botão (não há planta).

### 3.2 Telas

| Projeto | Tela | Páginas (= abas no contexto Laboratório, mesma ordem de hoje) |
|---|---|---|
| `laboratorio-calculo` | "Laboratório de Cálculo" | Funções · Sensor 4–20 mA · Limites · Eixo · Primeira ordem · Tanque |
| `tanque` | idem | Tanque |
| `primeira-ordem` | idem | Primeira ordem |
| `sensor` | idem | Sensor 4–20 mA |
| `funcoes-e-limites` | idem | Funções · Limites · Eixo |

Configuração comum das telas: `presentation.fullscreenContext = "lab"`, tema `lab` nas páginas, páginas em **grade**
(`layout.kind = "grid"`, seções empilhadas como as do `lab.css`), `designWidth×designHeight` = 1920×1080.

## 4. Página a página

Notação: seções na ordem vertical; colunas copiadas de `media/lab/lab.css`; `tone` = fundo da área. Todos os textos (perguntas,
etapas, dicas, rótulos) são os atuais (`lab/activity.ts`). Elementos `graphics.math.*` conforme doc 62 §6.1.

### 4.1 Funções — explorador

| Seção | Colunas | Áreas |
|---|---|---|
| `cabecalho` | `1fr` | `pergunta` / `etapas` |
| `principal` (`fn-grid`, colapsa < 900 px) | `minmax(280px,1fr) minmax(360px,1.8fr) minmax(260px,1fr)` | `entradas grafico analise` |
| `teclado` | `1fr` | `teclado` |

| Área | Elemento | Configuração |
|---|---|---|
| pergunta | `question` | "Como os parâmetros a, b e c mudam o gráfico de f(x) = a·x² + b·x + c?" |
| etapas | `steps` | 4 etapas (prever, explorar ×2, formalizar) |
| entradas | `expression_input` ×2 | `f = a x^2 + b x + c`, `g = x + 1` |
| entradas | `parameter` ×3 (locais) | a ∈ [−3, 3] passo 0,1 = 1; b ∈ [−5, 5] = 0; c ∈ [−5, 5] = −2 |
| entradas | `view_toggles` → gráfico | f′ (desl.), F = ∫f (desl.), assíntotas, raízes, tabela (lig.) |
| grafico | `function_plot` | x ∈ [−5, 5], y ∈ [−6, 10]; camadas f, g, f′, F a partir de 0, assíntotas, raízes, interseções, ponto arrastável em f |
| analise | `analysis` + `table` | raízes, interseções, f′, F com selo exato/numérico; tabela passo 1 |
| teclado | `keyboard` | abas 123 · f(x) · Cálculo, alvo = campo de expressão com foco |

### 4.2 Limites — velocidade de subida aos 4 s

| Seção | Colunas | Áreas |
|---|---|---|
| `cabecalho` | `1fr` | `pergunta` / `etapas` |
| `principal` (`lim-grid`) | `minmax(170px,0.6fr) minmax(340px,2fr) minmax(260px,1fr)` | `processo grafico taxa` |
| `calculo` (`calc`) | `minmax(320px,1.4fr) minmax(320px,1fr)` | `calculadora teclado` |
| `rodape` (`lim-footer`) | `1fr` | `equacao` |
| `epsilon` (`calc eps`) | `minmax(320px,1.4fr) minmax(320px,1fr)` | `eps_grafico eps_controle` |

| Área | Elemento | Configuração |
|---|---|---|
| processo (`dark`) | `process_tank` | fonte = expressão `h(t)` (reconstrução, selo "modelo"), rótulo h(4) = 8 cm |
| processo | `expression_input` | modelo `h(t) = 0.5t^2` (editável em operação, como hoje) |
| grafico | `function_plot` | t ∈ [0, 6]; P = (a, h(a)), Q restrito à curva por Δt, secante, tangente exata, guias Δt/Δh; barra: zoom, restaurar vista, lado |
| grafico | `parameter` Δt | log, inicial 0,5; botão "Δt = 0" |
| taxa | `table` bilateral | linhas fixas 1 · 0,1 · 0,01 + linha atual, dígitos pela política de [52 §4.2](52-laboratorio-calculo-produto-e-matematica.md) |
| taxa | `analysis` | limite exato 4 cm/s; aviso "Em Δt = 0 o quociente é indefinido" |
| calculadora | `calculator` | exemplos atuais; funções do documento |
| teclado | `keyboard` | — |
| equacao | `equation` | `[h(4+Δt) − h(4)]/Δt = 4 + 0,5Δt (Δt ≠ 0)` |
| eps_grafico | `function_plot` | quociente × Δ, faixas L ± ε e ± δ |
| eps_controle | `parameter` ε + `analysis` | ε log, inicial 0,5; δ encontrado; contraexemplo |

Expressões: `h(t) = 0.5t^2`, `q(Δ) = (h(a+Δ) − h(a))/Δ`. Parâmetros locais: a = 4, Δt, lado (`choices`), ε.

### 4.3 Eixo — posição, velocidade e aceleração

| Seção | Colunas | Áreas |
|---|---|---|
| `cabecalho` | `1fr` | `pergunta` / `etapas` |
| `principal` (`tank-layout`) | `minmax(300px,0.9fr) minmax(360px,1.6fr)` | `eixo graficos` |
| `inferior` (`tank-bottom`) | `1.5fr 1fr 1fr` | `equacoes resultado notas` |

| Área | Elemento | Configuração |
|---|---|---|
| eixo (`dark`) | `process_axis` | carro sobre o trilho na posição x(t₀) |
| eixo | `parameter` ×3 | L = 200, T = 4 s, t₀ = 1 s |
| graficos | `function_plot` ×3 empilhados | x(t) com tangente em t₀ (ponto arrastável), v(t) = x′(t), a(t) = v′(t) |
| equacoes | `equation` | x(t) = L(3τ² − 2τ³), τ = t/T; v e a exatas |
| resultado | `analysis` | v e a em t₀ com selo exato |
| notas | texto | notas atuais |

### 4.4 Primeira ordem — exponencial

| Seção | Colunas | Áreas |
|---|---|---|
| `cabecalho` | `1fr` | `pergunta` / `planta` / `etapas` |
| `principal` (`tank-layout`) | `minmax(300px,0.9fr) minmax(360px,1.6fr)` | `processo resposta` |
| `inferior` (`tank-bottom`) | `1.5fr 1fr 1fr` | `equacoes resultado notas` |

| Área | Elemento | Configuração |
|---|---|---|
| planta | `plant_status` | instância `primeira-ordem-lab` (ligada / ausente / religar) |
| processo (`dark`) | `faceplate` | instância `primeira-ordem-lab`, página `painel` (diagrama u → K/(τs+1) → y com valores vivos, §5.2) |
| processo | `parameter` ×4 (do modelo) | u ∈ [−10, 10] `live` = 1 (`c_u.value`); K ∈ [0,1; 10] `stop-required` = 2 (`fo.gain`); τ ∈ [0,5; 60] s `stop-required` = 5 (`fo.tau`); y₀ `stop-required` = 0 (`fo.initial`) |
| processo | `run_controls` | Executar · Pausar · Reiniciar (reaplica os valores iniciais da página) |
| resposta | `series_chart` | y(t) gravado, valor final K·u, linha de 63,2 %, tangente em t₀, cursor |
| equacoes | `equation` | τy′ + y = K·u; y(t) = y₀ + (K·u − y₀)(1 − e^(−t/τ)) |
| resultado | `analysis` | instante de 63,2 % (dos dados × exato) |

Sinais: `y = ["primeira-ordem-lab","fo"]:out` (`linear`), `u = ["primeira-ordem-lab","c_u"]:out` (`zoh`), série a 10 ms.

### 4.5 Sensor 4–20 mA — função afim

Mesmas seções da §4.4 (`processo` = "Transmissor", `resposta` = "Corrente × pressão").

| Área | Elemento | Configuração |
|---|---|---|
| processo | `faceplate` | instância `sensor-lab`, página `painel` (P e I grandes, indicação de saturação) |
| processo | `parameter` ×3 | P ∈ [0, 300] kPa `live` = 100 (`c_p`); Pmin ∈ [0, 150] `stop-required` = 0; Pmax ∈ [20, 300] `stop-required` = 200 |
| processo | `run_controls` | — |
| resposta | `function_plot` | reta I(P) com saturação 3,8–20,5 mA + ponto medido (sinais p, i) |
| resposta | `table` | P → I |
| equacoes | `equation` | I = 4 + 16·(P − Pmin)/(Pmax − Pmin); inversa P(I) |

Sinais: `p` (`c_p:out`), `iRaw` (`i_raw:out`), `i` (`i_loop:out`), todos `zoh`, 10 ms. Restrição do documento:
`pmax > pmin` ("Pmax precisa ser maior que Pmin", regra hoje em `checkPlantParameter`).

### 4.6 Tanque — da vazão à integral

| Seção | Colunas | Áreas |
|---|---|---|
| `cabecalho` | `1fr` | `pergunta` / `planta` / `etapas` |
| `principal` (`tank-layout`) | `minmax(300px,0.9fr) minmax(360px,1.6fr)` | `processo graficos` |
| `inferior` (`tank-bottom`) | `1.5fr 1fr 1fr` | `equacoes riemann eventos` |

| Área | Elemento | Configuração |
|---|---|---|
| processo (`dark`) | `faceplate` | instância `tanque-lab`, página `painel` (tanque com nível, largura ∝ A, setas de vazão realizada, vertedouro) |
| processo | `parameter` (do modelo) | saída `choices` bomba/válvula/Torricelli `stop-required` = bomba; qIn `live` = 1 L/s; qOut `live` = 0,4 (`visibleWhen: outlet == 0`); k `live` = 2 (`outlet == 1`); c `live` = 1,4 (`outlet == 2`); A `live` = 0,1 m²; h máx. `stop-required` = 1 m; V₀ `stop-required` = 20 L (`acc.initial`) |
| processo | `run_controls` | — |
| graficos | `series_chart` 1 | seletor h(t) · V(t) · V₀ + ∫q (TFC); cursor; a/b |
| graficos | `series_chart` 2 | vazão líquida q com Riemann: método (esquerda/direita/ponto médio/trapézio), n ∈ [1, 200], a = 5, b = 25, n = 10, esquerda |
| equacoes | `equation` | q = q_in,real − q_out,real − q_overflow; dV/dt = q; V(t) |
| riemann | `analysis` | soma, ∫ exata sobre a série, ΔV, derramamentos |
| eventos | `events` | parâmetro aplicado, contato com fronteira, derramamento, início |

Sinais (15, todos de `TANK_PLANT` em `lab/plants.ts`): `V = acc:out`, `h = h:out`, `A = c_area:out`, `qOutDemand = q_out:out`,
`inActual`, `outActual`, `overflow`, `unmet`, `cumIn`, `cumOut`, `cumOverflow`, `cumUnmet`, `cumSpill`,
`upperContact = acc:upperContactTime`, `lowerContact = acc:lowerContactTime`, caminho `["tanque-lab", …]`, 10 ms.
Sinal derivado do documento: `q = Δ(cumIn − cumOut − cumOverflow)/Δt` (hoje calculado por `SeriesBuffer`), mantendo a
identidade ∫q = ΔV + derramamentos.

## 5. Faceplates das plantas

As três plantas são refeitas na fonte (`scripts/generate-*.py` → `subcircuits/process_*.lssubcircuit` v4) e os exemplos as
incorporam como hoje.

### 5.1 Página `symbol` (o que aparece no esquemático)

Mesmo tamanho, mesmas formas (agora `item`) e os expostos de hoje como `ref` **nas mesmas posições** (tabela da §2), mais
os pinos da interface. Diferença visível: tudo fica vivo na instância, inclusive o que antes era desenho estático.

### 5.2 Páginas `painel` (usadas pelas telas do Laboratório)

| Planta | Conteúdo do painel |
|---|---|
| tanque | `process_tank` ligado às exposições V, h, A, inActual, outActual, overflow; displays de volume, nível, vazões e área |
| primeira ordem | diagrama de blocos u → K/(τs+1) → y com valores vivos (composto de `graphics.*` existentes: retângulos, setas, rótulos ligados, `equation`) |
| sensor | transmissor (símbolo de instrumento existente), P e I em `value_display` grandes, lâmpada de saturação (I ≤ 3,8 ou ≥ 20,5 mA) |

### 5.3 Exposições

| Planta | `signal` | `parameter` |
|---|---|---|
| tanque | V, h, A, nível %, inActual, outActual, overflow, unmet, cumIn, cumOut, cumOverflow, cumUnmet, cumSpill, contatos | qIn, qOut, A, h máx., k, c, saída, V₀ |
| primeira ordem | y, u | u, K, τ, y₀ |
| sensor | P, I, I sem saturação | P, Pmin, Pmax |

## 6. Como os exemplos são produzidos

- `scripts/generate-calculus-lab-examples.cjs` é reescrito para montar os projetos com os **mesmos modelos de página** que
  o produto oferece ("Inserir página do Laboratório › …"): exemplo e produto não divergem.
- Os geradores Python das plantas emitem o manifesto v4 com Faceplate e exposições.
- Nenhum JSON de exemplo é editado à mão.

## 7. Aceitação

| # | Critério | Teste |
|---|---|---|
| 1 | Abrir cada projeto mostra o botão "Laboratório de Cálculo" e as plantas com Faceplate vivo | E2E |
| 2 | Clique/duplo clique no botão abre a tela; Undock; edição na janela flutuante | E2E |
| 3 | Tela cheia no **monitor principal (1920×1080)** e no **secundário (1366×768)** desta máquina mostra o contexto Laboratório; capturas dentro da tolerância contra as vistas atuais nas mesmas resoluções (as metas visuais de [55 §5](55-meta-visual-laboratorio-calculo.md) já usam 1920×1080 e 1366×768) | E2E + regressão visual |
| 4 | Os 63 *checks* de `test:lab:e2e` (30) e `test:lab:tank:e2e` (33) passam nas páginas novas | E2E |
| 5 | Inspeção (cursor, Δt, n, a/b, ε) envia 0 mensagens ao Host | E2E (contador existente) |
| 6 | Parâmetros `stop-required` recusados com simulação rodando ou pausada; `pmax > pmin` recusado | unidade + E2E |
| 7 | Tanque, gráfico h(t) e display de nível usam o mesmo sinal: 1 leitura por tique | Core real (cenário D) |
| 8 | Projetos reabrem sem diferença; nenhum campo `calculusLab`/`hmiApplication` | ida e volta |
| 9 | O professor muda um elemento (ex.: cor de uma curva, posição de um painel) em edição e o aluno vê a mudança em operação | E2E |

## 8. Onde entra no plano

| Fase ([63](63-unificacao-visual-plano-testes-riscos.md)) | Entrega deste documento |
|---|---|
| F7 | páginas das seis atividades com os elementos matemáticos; `funcoes-e-limites` completo; critérios 4–6 |
| F8 | tema e casca `lab`, tela cheia nos dois monitores; critério 3 |
| F9 | Faceplates das três plantas (§5); critérios 1, 7 |
| F11 | gerador reescrito, arquivos antigos removidos; critérios 2, 8, 9 |

Os exemplos não podem ser refeitos antes da F7: o formato novo e os elementos matemáticos ainda não existem, e um arquivo
no formato novo não abriria no produto atual.
