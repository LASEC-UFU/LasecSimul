# Laboratório de Cálculo — experimentos de referência e vertical "Tanque — da vazão à integral"

**Proposta [P].** Corrige o modelo físico da versão anterior: estado em volume com acumulador conservativo **genérico**
([51 §4.3](51-laboratorio-calculo-arquitetura-e-dados.md)), cenários em que a vazão varia (com vazões constantes, secante = tangente
e qualquer soma de Riemann é exata — não há o que explorar), geometria compatível com a meta visual e taxas de amostragem
alinhadas ao período real dos blocos.

## 1. Experimentos de referência

Nenhum exige equações diferenciais ou controle como pré-requisito: o aluno manipula entradas e lê gráficos; o modelo é dado.

| | A. Sensor e calibração | B. Tanque | C. Movimento de eixo | D. Resposta de primeira ordem |
|---|---|---|---|---|
| Objetivo | função afim, ganho/offset, unidade, inversa, saturação | taxa × acúmulo, derivada, integral, condição inicial, TFC | posição, velocidade, aceleração, aproximação linear | exponencial, valor final, taxa, constante de tempo |
| Modelo | `I = 4 mA + 16 mA·(P−Pmin)/(Pmax−Pmin)`, saturação configurável (típico 3,8–20,5 mA); entrada de pressão por slider; opcional: transmissor `hart_smar_ld301` existente | §2 abaixo | trajetória polinomial S `x(t) = L(3τ²−2τ³)`, `τ = t/T`, `0 ≤ τ ≤ 1` (função do `calc-core`; animação simples) | bloco `control.first_order` com degrau de `control.constant`: `y = y∞ + (y0−y∞)e^{−t/τ}` |
| Entradas (unidade) | P (kPa), Pmin/Pmax (kPa) | q_in, q_out (L/s), k da válvula (L/(s·m)), A (m²) | L (mm), T (s) | degrau u, ganho K, τ (s), y0 |
| `live` / `stop-required` | P live; faixa stop | ver §2.3 | ambos (só Webview) | u live; K, τ stop (propriedades de bloco) |
| Representações | reta I(P), tabela P→I, ponto móvel, faixa de saturação, I(P) bruta tracejada fora da faixa | tanque, h(t), q(t) com Riemann, equações | eixo animado, x/v/a empilhados, tangente em x | y(t), tangente em t=0, linha 63,2 %, taxa dy/dt |
| Perguntas | qual P dá 12 mA? o que acontece acima de Pmax? qual a inversa? | §2.5 | quando v = 0? onde a é máxima? reta tangente aproxima x perto de t₀? | onde y alcança 63,2 % do salto? a tangente em 0 cruza y∞ em t = τ? |
| Aceite | Pmin→4,000 mA; Pmax→20,000; ponto médio→12,000; acima da faixa mostra "saturado" e valor bruto; unidades no eixo | §2.6 | v e a exatas (derivada simbólica de polinômio) batem a quociente central com h→0; x, v, a no mesmo cursor | `|y(τ) − y_analítico(τ)| ≤ 10⁻⁶·|K·u|` com período de 10 ms (RK4) [I]; mudança de u gera marcador e afeta só o futuro |
| Onde roda | Core (constante + `calc_expression` + `saturation`) | Core | Webview (`calc-core`), sem Core | Core |

O experimento C não usa o Core no MVP: o `ExpressionParser` do Core não tem `sin` [C], e uma trajetória prescrita não
precisa de solver. Ligar C a um servo simulado fica para depois.

## 2. Vertical "Tanque — da vazão à integral"

### 2.1 Modelo físico

- Estado **V** (canônico m³, exibido em L) em `control.accumulator` com `lower = 0`, `upper = Vmax = A·h_max`; `upper` é uma
  **porta de entrada** (não parâmetro compilado), para que A possa mudar durante a execução.
- Seção **A** (m²) constante entre mudanças; `h = V/A` (bloco `calc_expression` com A vindo de `control.constant`); fluido
  incompressível; sem evaporação nem vazamentos.
- Entrada: bomba com vazão demandada `q_in ≥ 0`.
- Saída, dois modos (troca = topologia, `stop-required`):
  1. **Bomba de saída:** `q_out` demandada (constante ou por patamares).
  2. **Válvula por gravidade (linearizada):** `q_out = k·h` — tanque autorregulado; com `q_in` constante,
     `V(t) = V* + (V0 − V*)·e^{−t/τ}`, `V* = A·q_in/k`, `τ = A/k`. Torricelli (`q_out = c·√h`) entra depois.
- Balanço realizado: `q = q_in,real − q_out,real − q_overflow`; `dV/dt = q`; `V(t) = V0 + ∫₀ᵗ q dτ`; `0 ≤ V ≤ Vmax`.
  Em `V = 0` com `q_out > q_in`: `q_out,real = q_in`, `q_unmet = q_out − q_in` (demanda não atendida, não é volume).
  Em `V = Vmax` com `q_in > q_out`: `q_overflow = q_in − q_out` sai pelo vertedouro (não há volume virtual).
- **Conservação × trajetória:** o balanço fecha por construção (acumulados exatos, §2.2). A trajetória do modo válvula tem
  erro de discretização O(Δt) porque a saída depende do estado lido no passo anterior (laço explícito no período do bloco);
  com período 10 ms e τ = 50 s o erro relativo esperado é ~Δt/(2τ) = 10⁻⁴ **[I, medir em M2]**. A UI distingue as duas coisas.

### 2.2 Algoritmo por passo (Core, entradas ZOH em `[t, t+Δt]`)

```text
net = q_in − q_out                       (q_in, q_out ≥ 0; negativos são rejeitados no Host e contados como diagnóstico no Core)
se net > 0 e upper finito:  tc = (upper − x)/net
    se tc < Δt: x' = upper; overflowVol = net·(Δt − tc); evento "boundary:upper" em t + max(tc, 0)
se net < 0:                 tc = (x − lower)/(−net)
    se tc < Δt: x' = lower; unmetVol = (−net)·(Δt − tc); evento "boundary:lower" em t + max(tc, 0)
senão: x' = x + net·Δt
cumIn += q_in·Δt;  cumOut += q_out·Δt − unmetVol;  cumOverflow += overflowVol;  cumUnmet += unmetVol
saídas instantâneas no fim do passo:
    em upper com net > 0: inActual = q_in, outActual = q_out, overflow = net
    em lower com net < 0: inActual = q_in, outActual = q_in, unmet = q_out − q_in
    caso contrário: inActual = q_in, outActual = q_out, overflow = unmet = 0
identidade: x' − x0 = cumIn − cumOut − cumOverflow   (exata a menos de arredondamento)
```

Casos de borda: já na fronteira (`tc ≤ 0`) todo o excesso do passo vai para `overflow`/`unmet`; `net = 0` não muda nada;
`upper ≤ lower` é erro; arredondamento que ultrapasse a fronteira entra em `overflow`/`unmet` (nunca some). `full == half` mantém o
erro estimado em 0, como hoje [C].

**Limite superior ao vivo** (implementado: a fronteira é uma entrada amostrada e o estado é projetado nela na própria ativação
do bloco; o derramamento vai para `cumSpill`, separado de `cumOverflow` — [54 §0](54-laboratorio-calculo-validacao-e-riscos.md)):

```text
upper ← nova entrada (A·h_max)
se x > upper:  derramamento = x − upper;  x = upper;  cumSpill += derramamento   (evento "spill" derivado do salto de cumSpill)
```

O derramamento é um **volume discreto** (impulso), não uma vazão: não aparece em `q`, aparece na identidade
`V(b) − V(a) = ∫ₐᵇ q dt − Σ derramamentos`. Implementação de referência e testes em
[`docs/poc/laboratorio-calculo-limites/accumulator.mjs`](poc/laboratorio-calculo-limites/accumulator.mjs) **[E]**, que serve de oráculo para os testes C++ de M4.

### 2.3 Parâmetros iniciais e políticas

| Parâmetro | Valor inicial | Faixa do aluno | Política |
|---|---|---|---|
| A | 0,1 m² (Ø ≈ 0,36 m) | 0,03–0,2 m², passo 0,005 | **live na primeira entrega** (decisão do usuário, 2026-10-16) — ver nota |
| h_max → Vmax | 1,0 m → 100 L | — | stop-required (professor) |
| V0 | 20 L (h0 = 0,2 m) | 0–100 L | stop-required |
| q_in | 1,0 L/s | 0–2 L/s, passo 0,05 | live |
| q_out (bomba) | 0,4 L/s | 0–2 L/s, passo 0,05 | live |
| k (válvula) | 2 L/(s·m) ⇒ h* = 0,5 m, τ = 50 s | 0,5–5 | live (é constante ligada a porta) |
| período dos blocos | 10 ms (`samplePeriodNs = 10 000 000` explícito) | — | autoria |
| ritmo | `realTimeRate = 1` (botões 2×/5× opcionais) | — | autoria |

**Semântica de A ao vivo (validada na PoC [E]):** mudar A é "trocar o tanque instantaneamente" — um experimento mental, não um
processo físico contínuo. Regras:

1. O comando entra pela fila de comandos; `appliedAtNs` vira evento `parameter` na série e o modelo amostrado (10 ms) passa a
   usar o valor na ativação seguinte (≤ 10 ms depois) — medido no Core real.
2. **V é preservado** (conservação); **h = V/A salta** no mesmo instante. O gravador registra **duas linhas com o mesmo t**
   (antes/depois); gráficos quebram o traçado ali e nenhuma interpolação, secante ou tangente atravessa o instante.
3. `Vmax = A·h_max` é recalculado; se `V > Vmax`, o excesso sai como **derramamento discreto** (evento `spill` com volume), contabilizado
   em `cumOverflow` — o balanço continua fechando (resíduo medido 8,8e-15 m³ [E]).
4. `dV/dt` não muda com A; `dh/dt = q/A` muda — é exatamente a pergunta didática ("mesma vazão, outra velocidade de subida").
5. A tangente a h no instante da mudança não existe; derivadas laterais são mostradas.

Exemplo verificado [E]: com bomba 1/0,4 L/s, em t = 50 s (V = 50 L) A passa de 0,1 para 0,04 m² com h_max = 1 m: Vmax = 40 L,
derramam 10 L, h vai de 0,5 m para 1,0 m e o tanque passa a transbordar 0,6 L/s. De 0,1 para 0,2 m²: V fica 50 L e h cai para 0,25 m.

Geometria anterior (A = 0,02 m², h_max = 5 m) descrevia um tubo de 16 cm × 5 m, incompatível com a meta visual; foi trocada.

### 2.4 Aquisição e representações

- Inscrição única no `SignalRecorder`: V, h, A, q_in, q_out demandada, inActual, outActual, overflow, unmet, `q` e os acumulados;
  uma linha por ativação de 10 ms (100 Hz), linha extra no mesmo t em descontinuidades, e eventos exatos. 30 min ⇒ 180 000 linhas ×
  (1 tempo + 13 colunas) × 8 B ≈ **20 MB** no Host [I]. Retenção configurável.
- **Definição da vazão gravada:** a linha i guarda a vazão líquida **média realizada** no passo `(tᵢ₋₁, tᵢ]` (`ΔV/Δt`, sem os
  derramamentos discretos). Com isso, `∫ q dt` sobre a série é **igual** a ΔV (verificado com erro 1e-15 [E]) e a soma de Riemann
  converge para ΔV. Consequência medida: ponto médio e trapézio param num piso de ≈ 7·10⁻⁵·ΔV com passo de 10 ms, que só desaparece
  quando cada retângulo coincide com um passo — efeito da amostragem, a ser explicado ao aluno, não erro do método.
- Processo: tanque com nível `h/h_max`, setas com vazões **realizadas** (e demanda quando diferente), vertedouro animado quando
  `overflow > 0`, indicador "saída sem água" quando `unmet > 0`.
- Gráfico 1: `h(t)` (ou `V(t)`, escolha do professor). Gráfico 2: `q(t)` com retângulos de Riemann e área acumulada.
  Cursor compartilhado; pontos A/B independentes do cursor; Riemann entre A e B.
- Equações com valores no cursor e natureza: `q = q_in,real − q_out,real − q_overflow`, `dV/dt = q`, `V(t) = V0 + ∫ q`,
  `h = V/A`, `dh/dt = q/A` (só fora das fronteiras).

### 2.5 Sequência do estudante

1. **Prever (bomba de saída):** "Com 1 L/s entrando e 0,4 L/s saindo, quanto o volume aumenta em 10 s?"
2. **Executar e medir:** A/B em t = 0 s e t = 10 s ⇒ ΔV = 6 L, secante = 0,6 L/s = q. Observação guiada: com q constante,
   toda secante tem a mesma inclinação e qualquer Riemann é exato — por quê?
3. **Mudar q_in durante a execução:** V ganha um "bico" no marcador; q salta. A tangente no bico não existe (derivadas laterais
   diferentes); Riemann com partição que não cai no salto erra.
4. **Reiniciar com válvula:** q decai, h tende a 0,5 m. Secante ≠ tangente; Riemann à esquerda superestima, à direita
   subestima; o erro cai ~1/n; trapézio converge mais rápido.
5. **TFC:** comparar a inclinação de V(t) (secante com A/B próximos) com q(t) no mesmo instante; comparar `∫ₐᵇ q` com `V(b) − V(a)`.
6. **Fronteiras:** aumentar q_out até esvaziar ou q_in até transbordar; ver vazão realizada × demanda e o balanço com
   `cumOverflow`/`cumUnmet`.
6a. **Mudar A durante a execução:** prever o que acontece com h e com a inclinação de h; observar o salto, a nova inclinação q/A,
   o eventual derramamento e que `V(b) − V(a) = ∫q − derramamentos` quando o intervalo atravessa a mudança.
7. **Formalizar:** escrever o balanço e as hipóteses; distinguir "erro do método numérico" de "simplificação do modelo".
8. **Reiniciar:** parâmetros iniciais, V0, nova geração, cursor em t = 0.

### 2.6 Aceite da vertical (mensurável)

| # | Critério | Tolerância |
|---|---|---|
| 1 | Bomba, q_in = 1, q_out = 0,4 L/s, 10,000 s: ΔV = 6 L, Δh = 0,06 m | `|ΔV − 6 L| ≤ 10⁻⁹ L` (Euler exato para ZOH) |
| 2 | V0 = 20 L, vazões zero: V constante; integral acumulada não substitui V0 | exato |
| 3 | Transbordo: de 20 L com q = 0,6 L/s, evento `boundary:upper` em 133,333… s | `≤ 1 ns` do analítico |
| 4 | Esvaziamento: q_in = 0, q_out = 2 L/s de 20 L: evento em 10 s; depois `outActual = 0`, `unmet = 2 L/s` | `≤ 1 ns`; exato |
| 5 | Identidade de balanço em toda linha gravada | `≤ 10⁻¹²·max(1, Vmax)` |
| 6 | Válvula: V(t) contra a exponencial analítica em [0, 200 s] | erro relativo `≤ 5·10⁻⁴` com período 10 ms |
| 7 | Riemann esquerda/direita/ponto médio/trapézio sobre q(t) gravado em [0, 50 s]: erro vs `V(50) − V(0)` decresce com n | esq./dir. ~1/n; médio/trapézio ≥ 50× melhores com n = 50 até o piso de amostragem ≈ 7·10⁻⁵·ΔV; zero quando retângulo = passo [E] |
| 8 | Mudar q_in em run: marcador em `appliedAtNs`; amostras anteriores inalteradas | exato |
| 9 | Inspeção (cursor, A/B, n, método, zoom): 0 mensagens ao Host | contador |
| 10 | Salvar/reabrir: definição e referências preservadas; nenhum dado de série ou estado transitório gravado | diff do `.lsproj` |
| 11 | Os 5 subcircuitos migrados de `control.tank` reproduzem os testes atuais enquanto não tocam a fronteira | testes de sessão |
| 12 | A ao vivo: evento `parameter` em `appliedAtNs`; V contínuo; h com duas linhas no mesmo t; traçado de h quebrado | exato [E na PoC] |
| 13 | A ao vivo com `V > A·h_max`: evento `spill` com o volume; identidade `ΔV = ∫q − Σ derramamentos` em qualquer intervalo | `≤ 10⁻¹²·max(1, Vmax)` [E na PoC] |
| 14 | Mover cursor, a/b, n ou método não envia nada ao Core e não redesenha a camada da série | contadores [E na PoC] |

### 2.7 Simplificações admitidas e proibidas

Admitidas: animação vetorial simples; só bomba e válvula linear; h_max e V0 só em Configuração; sem exportação de respostas;
sem undo dos gestos do aluno; sem retomar depois de fechar o painel.

Proibidas: recorte visual no lugar de balanço; integrar na taxa de tela; carimbo de tempo por chegada; perder evento de
fronteira; iniciar só com V0 = 0; interpolar através de marcador de parâmetro ou fronteira.

### 2.8 Pré-requisitos

M1 (gravador + `appliedAtNs` + unidades), M2 (acumulador e migração), M3 (fundação da Webview) e M4 (painel, sessão e
persistência) de [54](54-laboratorio-calculo-validacao-e-riscos.md).
