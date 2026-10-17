# Meta visual — Laboratório de Cálculo (tanque)

**Origem:** imagem conceitual fornecida pelo usuário em 16/10/2026. Meta de composição e hierarquia, não arte final nem
retrato do software atual. Análise revisada em 2026-10-16 com medição por pixels (script `pngjs`, aproximada).

![Referência conceitual: tanque, gráficos sincronizados, controles e equações](<../trm/LasecSimul_ tanque.png>)

## 1. Composição a perseguir

```text
┌ LasecSimul | Laboratório de Cálculo ─ Processo | Gráficos | Cálculo | Explorar | Configurações ┐
├─────────────────────────────┬──────────────────────────────────────────────────────────────────┤
│ Processo em tempo real      │ Nível × tempo  (cursor t, pontos a/b, secante, tangente)          │
│ tanque, entrada, saída,     ├──────────────────────────────────────────────────────────────────┤
│ régua de nível com unidade  │ Vazão líquida × tempo + retângulos de Riemann + área acumulada    │
│ q_in  q_out/k  A (ao vivo)  │                                                                  │
│ ▶  ❚❚  ⟲   estado textual   │                                                                  │
├─────────────────────────────┴─────────────────────────────┬────────────────────────────────────┤
│ q = q_in,real − q_out,real − q_overflow · dV/dt · V(t)    │ Pergunta / etapa                    │
└───────────────────────────────────────────────────────────┴────────────────────────────────────┘
```

Cinco representações simultâneas: processo animado, dois gráficos, equações com valores, objetos de cálculo e etapa.
A navegação superior organiza ferramentas sem esconder as representações centrais.

## 2. O que a imagem acerta

- Hierarquia: processo ≈ metade da largura; dois gráficos de tamanho comparável; faixa inferior com equações e pergunta.
- Legendas textuais nos gráficos, controles com rótulo, estado da simulação em texto.
- Riemann sob a curva de vazão, com legenda distinta da curva e da área.
- Formas coerentes com um **tanque autorregulado**: medindo a imagem, a razão entre a inclinação de h(t) e o valor de q(t)
  fica aproximadamente constante (≈ 0,41–0,56 em unidades de pixel) do início até ~80 % da largura, como exige `dh/dt = q/A`.

## 3. O que precisa ser corrigido na implementação

| # | Na imagem | Correção |
|---|---|---|
| 1 | Na cauda, q se estabiliza num valor positivo (~7 % do inicial) enquanto h achata (a razão inclinação/q cai à metade) | Com q > 0, h continua subindo com inclinação q/A; patamar de h exige q → 0. O modo válvula ([53 §2.1](53-laboratorio-calculo-experimentos-e-tanque.md)) gera q → 0 e h → h*; a figura tem de vir dos dados gravados, nunca desenhada à mão |
| 2 | Com o modelo de vazões constantes, estas formas são impossíveis (h seria reta e q constante) | O primeiro cenário do aluno é linear de propósito; as curvas da figura correspondem ao cenário com válvula |
| 3 | Dois marcadores verticais rotulados "t" | Cursor de inspeção `t` e extremos do intervalo `a`, `b` com rótulos e estilos distintos |
| 4 | Régua do tanque com todos os rótulos "0" | Escala real com unidade (m ou cm) ligada a `h_max` |
| 5 | Eixo de vazão em m³/s; plano exibe L/s | Exibir L/s e m/cm de forma consistente; conversão só pelo registro de unidades ([51 §4.9](51-laboratorio-calculo-arquitetura-e-dados.md)) |
| 6 | `q = q_entrada − q_saída` | `q = q_in,real − q_out,real − q_overflow`, com as demandas mostradas quando diferirem das realizadas |
| 7 | Slider "Área do tanque" ativo durante a simulação | **Mantido** (decisão do usuário): V preservado, h salta com traçado quebrado e marcador, derramamento discreto se `V > A·h_max`; largura do tanque desenhada proporcional a A ([53 §2.3](53-laboratorio-calculo-experimentos-e-tanque.md), PoC [E]) |
| 8 | "Inclinação = dh/dt = q/A" desenhada como tangente no cursor | Vale fora das fronteiras e em pontos sem mudança de parâmetro; em bicos/fronteiras mostrar derivadas laterais |
| 9 | Fotografia realista do equipamento | Desenho vetorial ligado ao estado (nível, setas de vazão realizada, vertedouro); realismo fotográfico não é meta |

## 4. Sincronização observável

Um instante de inspeção `t` alinha, pela regra de interpolação declarada da série (linear para V/h, degrau para vazões
demandadas): nível reconstruído no tanque (selo "reconstrução"), marcador em h(t), marcador em q(t), valores nas equações
e linha da tabela. Sem amostra: lacuna visível. `a` e `b` são independentes do cursor. Em execução, a cena segue o último
dado; ao inspecionar o passado, a UI muda para "Inspeção" e só volta a "Ao vivo" por ação explícita.

## 5. Aceite da meta visual

1. Em 1920×1080 e 1366×768 (modo apresentação), processo, dois gráficos, equações, controles e pergunta aparecem juntos, sem
   sobreposição nem texto truncado.
2. Mudar q_in/q_out em execução gera marcador no instante aplicado; h/V, q, setas e equações seguem coerentes; o passado não muda.
2a. Mudar A em execução: V contínuo, h descontínuo com traçado quebrado e marcador; se houver derramamento, ele aparece como evento com
   volume e entra na identidade `ΔV = ∫q − derramamentos`; o desenho do tanque muda de largura.
3. As curvas exibidas vêm de séries gravadas pelo Core; no cenário válvula, a razão inclinação(h)/q fica constante (= 1/A) dentro
   da tolerância do método, verificada por teste automático sobre os dados.
4. Cursor, a/b, n e método não alteram o simulador (0 mensagens ao Host).
5. Secante, tangente e Riemann mostram método, intervalo e unidade; traçados não cruzam lacunas, fronteiras nem marcadores.
6. Teclado alcança todos os controles; estados não dependem só de cor; foco visível em projeção.
