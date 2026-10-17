# Meta visual — atividade de Limites

**Origem:** segunda imagem conceitual fornecida pelo usuário em 16/10/2026, para a área **Limites**. Meta de experiência,
não captura de software. Revisão de 2026-10-16: valores conferidos por execução na PoC
([`docs/poc/laboratorio-calculo-limites/`](poc/laboratorio-calculo-limites/README.md)) e retas da imagem medidas por pixels.

![Referência conceitual: tanque, aproximação bilateral, tabela e velocidade média](<../trm/LasecSimul_ limite.png>)

## 1. O que a imagem propõe

Navegação Funções/Limites/Derivadas/Integrais; pergunta "Qual é a velocidade de subida da água aos 4 segundos?"; tanque com
`h(4) = 8 cm` e modelo `h(t) = 0,5t²` (t em s, h em cm); gráfico com P = (4, 8), Q = (4 + Δt, h(4 + Δt)), Δt, Δh e secante;
tabela de quocientes pela direita e pela esquerda; slider de Δt; valor-tendência "4 cm/s"; aviso "Em Δt = 0 o quociente é
indefinido"; rodapé com o quociente simplificado e a pergunta "O que muda ao aproximar pelo outro lado?".

## 2. Matemática — conferida

Com Δt assinado (Δt > 0 direita, Δt < 0 esquerda), uma única fórmula cobre os dois lados:

```text
h(4) = 8 cm
[h(4+Δt) − h(4)]/Δt = [0,5(16 + 8Δt + Δt²) − 8]/Δt = 4 + 0,5Δt   (Δt ≠ 0)
lim Δt→0⁺ = lim Δt→0⁻ = 4 cm/s  ⇒  os limites LATERAIS coincidem, logo o limite bilateral existe e vale 4 cm/s
Q para Δt = 0,5: (4,5; 10,125) e quociente 4,25 cm/s
```

| Δt (s) | Direita (cm/s) | Esquerda (cm/s) |
|---:|---:|---:|
| 1 | 4,5 | 3,5 |
| 0,1 | 4,05 | 3,95 |
| 0,01 | 4,005 | 3,995 |

Tabela, `h(4)`, Q e a forma `4 + 0,5Δt` conferidos por execução **[E]** (`verify.mjs`, `e2e.mjs`). Em float64 os quocientes
saem como `4,050000000000008` etc.; a exibição segue a política de [52 §4.2](52-laboratorio-calculo-produto-e-matematica.md).
Como h é convexa, a direita fica acima e a esquerda abaixo do limite. Em Δt = 0 o quociente não existe (0/0); o limite é um
objeto diferente do valor do quociente.

## 3. Defeitos da imagem a não reproduzir

| # | Na imagem | Medição / correção |
|---|---|---|
| 1 | Reta laranja tracejada apresentada como secante | inclinação medida ≈ 2,2–2,8 e passa longe de Q (h ≈ 8,9–11,0 em t = 4,5); a secante PQ tem inclinação 4,25 |
| 2 | Reta ciano (tangente/limite) | inclinação ≈ 1,5–2,0 e passa **abaixo** de P (h ≈ 5,4–6,3 em t = 4); a tangente em P tem inclinação 4 e passa por (4, 8) |
| 3 | Slider "Diminuir Δt" perto do início do curso (0,001…1) com Q desenhado em Δt = 0,5 | slider, Q, tabela e equação vêm do mesmo nó Δt (na PoC, um único nó do grafo [E]) |
| 4 | Só pontos de aproximação pela direita | seletor de lado explícito; Q azul/laranja com rótulo "direita/esquerda", não só cor |
| 5 | Rótulos de P e Q se sobrepõem quando Δt é pequeno (observado também na PoC) | posicionamento de rótulos com prevenção de colisão |

Medições aproximadas (máscaras de cor e regressão linear sobre pixels); o erro é muito menor que a diferença para os valores corretos.

## 4. Comportamento interativo requerido

1. Fonte do modelo: por padrão a **função analítica** `h(t) = 0,5t²` (resultado `exact`). Vincular ao tanque significa
   `q(t) = A · (1 cm/s²) · t` (vazão em rampa) — o tanque animado é **reconstruído pela mesma função**, não por um segundo modelo.
2. Q é restrito à curva **por parâmetro** (t do ponteiro, y = h(t), domínio [0, 6]); não usar ponto euclidiano mais próximo
   (no GeoGebra, (4,5; 0) foi projetado em (1,76; 1,55) [E]).
3. Δt por arraste, slider logarítmico, entrada numérica e teclado (setas, Shift+setas = passo fino); botão "Δt = 0" mostra
   "indefinido" sem esconder o limite [E].
4. Abaixo da resolução de ponto flutuante: "abaixo da precisão numérica"; perto de 10⁻⁸: aviso de cancelamento [E].
5. **Modo "dados do tanque"** (opcional, após M5): com amostras do Core a 10 ms, Δt menor que 0,01 s não tem dado; a linha da
   tabela mostra "sem dados nessa resolução" em vez de interpolar. Isso vira uma pergunta didática sobre o limite da medição.
6. Mover Q, mudar Δt ou o lado não toca o Core nem o relógio (0 mensagens) [E].
7. Pergunta final compara os lados e distingue quociente, limite e valor observado; uma etapa com salto (`If`) mostra limites
   laterais diferentes e a ausência do bilateral.

## 5. Requisitos visuais

Pergunta no topo; tanque à esquerda; gráfico ao centro; tabela e valor-limite à direita; quociente e pergunta no rodapé
(composição da imagem mantida). P e Q com coordenadas e unidades; guias Δt e Δh; secante e tangente com legendas e estilos
distintos e indicação "exata" quando a tangente vem do caminho polinomial. Equações em MathML [E]. Tabela com dígitos
suficientes para mostrar a aproximação.

## 6. Aceite da atividade

| Critério | Evidência atual |
|---|---|
| `h(4) = 8 cm`; tabela e quocientes calculados (não digitados) conferem com §2 | PoC [E] |
| Quociente simplificado `4 + 0,5Δt (Δt ≠ 0)` e limite exato 4 cm/s rotulados como exatos | PoC [E] |
| Direita acima e esquerda abaixo de 4 para todo Δt > 0 (função convexa) | teste a escrever em M1 |
| Δt = 0: quociente "indefinido"; limite continua visível como objeto separado | PoC [E] |
| Função com salto: laterais diferentes e "limite bilateral não existe" | teste a escrever em M1 |
| Arrastar Q não recalcula curva nem tabela fixa; 1 redesenho por quadro; foco preservado | PoC [E] |
| Mover Q/Δt/lado: 0 mensagens ao Host e ao Core | PoC [E] (Core simulado) |
| Teclado, contraste, leitor de tela (pontos como `role="slider"` com `aria-valuetext`) | PoC parcial [E]; auditoria em M2 |
| CSP sem `eval`/inline/CDN e sem rede | PoC [E] |

Entrega: M2 de [54](54-laboratorio-calculo-validacao-e-riscos.md) — antes do tanque, porque não depende de mudança no Core.
