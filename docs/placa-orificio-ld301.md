# Placa de orifício com LD301 (vazão por pressão diferencial)

Subcircuito `subcircuits.process.orifice_flow_dp`
(`subcircuits/process_orifice_flow_dp.lssubcircuit`, gerado por
`scripts/generate-orifice-flow.py`). Fica na paleta em *Processo › Modelos*.
O projeto pronto é `trm/ld301/placa_orificio_ld301.lsproj`.

É um trecho de tubulação com uma placa de orifício concêntrica (ISO 5167-2)
e as tomadas de um transmissor de pressão diferencial (LD301):

- a vazão entra por cima e faz **uma curva de 90°** antes do trecho reto a
  montante;
- a **válvula de controle (FV)** fica no fim do trecho reto a jusante. A
  abertura dela (pino, 0–100 %, ligue um slider) impõe a vazão;
- a tomada de **alta** fica antes da placa e a de **baixa** depois. As duas
  descem até o nível do transmissor e saem pelos pinos HIGH e LOW.

## Instalação simulada

```
 entrada
   │
   └─(curva 90°)── trecho reto a montante (L montante·D) ──[FE]── trecho reto a jusante (L jusante·D) ──[FV]── saída
                                                          │  │
                                                       alta  baixa  → LD301 (HIGH, LOW)
```

## Equações

Todas as grandezas usam D e d **na temperatura de operação**:
`D_T = D·(1 + α_tubo·(T − 20))` e `d_T = d·(1 + α_placa·(T − 20))`.

| Grandeza | Equação |
|---|---|
| β | `d_T / D_T` |
| Vazão | `Q = Qmax · u/100`, com atraso de 1ª ordem (τ = 1 s) |
| Reynolds | `Re_D = 4·ρ·Q / (π·μ·D)` |
| C (ISO 5167-2, Reader-Harris/Gallagher) | `0,5961 + 0,0261β² − 0,216β⁸ + 0,000521(10⁶β/Re_D)^0,7 + (0,0188 + 0,0063A)·β^3,5·(10⁶/Re_D)^0,3 + (0,043 + 0,080e^(−10L1) − 0,123e^(−7L1))·(1 − 0,11A)·β⁴/(1 − β⁴) − 0,031(M'2 − 0,8M'2^1,1)·β^1,3`, mais `0,011(0,75 − β)(2,8 − D/25,4)` se D < 71,12 mm |
| A, M'2 | `A = (19000β/Re_D)^0,8`, `M'2 = 2L'2/(1 − β)` |
| ε (só gás) | `1 − (0,351 + 0,256β⁴ + 0,93β⁸)·[1 − (p2/p1)^(1/κ)]`; líquido: ε = 1 |
| ΔP | `8·ρ·(1 − β⁴)·Q² / (C²·ε²·π²·d⁴)` |
| Perda permanente | `(√(1 − β⁴(1 − C²)) − Cβ²) / (√(1 − β⁴(1 − C²)) + Cβ²) · ΔP` |
| HIGH | pressão a montante p1, em mmH2O (`101,97·p1[kPa]`) |
| LOW | `HIGH − ΔP` (mmH2O) |

Distância das tomadas (L1 = alta, L'2 = baixa, em múltiplos de D):

| Tomada | L1 | L'2 |
|---|---|---|
| Flange (25,4 mm de cada face) | 25,4/D | 25,4/D |
| D e D/2 (radius taps) | 1 | 0,47 |
| Canto (corner taps) | 0 | 0 |

ε depende de ΔP e ΔP depende de ε. O modelo faz duas passadas (a segunda muda
ε menos de 10⁻⁴).

**Resultado com os padrões** (água a 20 °C, D 52,5 mm, d 31,5 mm, β 0,6,
tomadas de flange):

| Válvula | Q | Re_D | C | ΔP | Perda permanente |
|---|---|---|---|---|---|
| 100 % | 15 m³/h | 100 668 | 0,61242 | 3376,3 mmH2O (33,11 kPa) | 20,73 kPa |
| 50 % | 7,5 m³/h | 50 334 | 0,61534 | 836,1 mmH2O | 5,12 kPa |

C sobe um pouco com Re menor. Por isso 50 % da vazão dá 24,8 % do ΔP, e não
25 % exatos.

## LD301: faixa e raiz quadrada

O LD301 do projeto já vem com a faixa da placa padrão (exportada na
instância): **LRV 0, URV 3376,3 mmH2O**. A função de transferência começa
**linear**. Assim o aluno vê a corrente proporcional ao ΔP (50 % de válvula →
7,96 mA).

O tag da instância é **FT100**. Mudou diâmetro, orifício ou fluido? Refaça o
URV com o ΔP na vazão máxima, mostrado no display "ΔP na placa" ou calculado
com `placa_orificio_calculo.py --valvula 100`.

## LD301 em vazão pelo PACTware (display e 4–20 mA)

No LD301, **LRV/URV são sempre de pressão** (a faixa de ΔP), nunca de vazão.
A vazão aparece em dois passos:

1. a **função raiz quadrada** transforma o % de ΔP em % de vazão. Isso vale
   para a saída de 4–20 mA e para a PV;
2. a **Unidade do Usuário** dá nome e escala a esse %: 0 % = 0 e 100 % =
   vazão máxima, em m³/h. O display mostra essa PV (manual LD301, seção 3:
   *Função de Transferência*, *User Unit* e *LCD Indicator*).

Passos no DTM do LD301 (PACTware online). Entre colchetes, o comando HART
que o DTM envia, igual às capturas do aparelho real:

| # | Tela do DTM | Ajuste (planta padrão) | Comando |
|---|---|---|---|
| 1 | Calibration | Unidade mmH2O; Lower 0; Upper 3376,3 | 35 |
| 2 | Configuration › Function | Sqrt (raiz quadrada) | 47 |
| 3 | Configuration › Function | Corte 6 %; modo Hard (abrupto) ou Bumpless (suave) | 157, 191 |
| 4 | User Unit | On; unidade m3/h; 0 % = 0; 100 % = 15 | 180, 177, 179 |
| 5 | Display (LCD Indicator) | 1ª variável PV; 2ª OUT (mA), PV% ou None | 165 |

Conferência com a válvula (corte de 6 %, modo Hard):

| Válvula | Vazão real | ΔP (% da faixa) | Corrente | LCD |
|---|---|---|---|---|
| 100 % | 15,00 m³/h | 3376 mmH2O (100 %) | 20,00 mA | 15,00 m3/h |
| 75 % | 11,25 m³/h | 1892 mmH2O (56,1 %) | 15,98 mA | 11,23 m3/h |
| 50 % | 7,50 m³/h | 836 mmH2O (24,8 %) | 11,96 mA | 7,464 m3/h |
| 30 % | 4,50 m³/h | 298 mmH2O (8,8 %) | 8,75 mA | 4,457 m3/h |
| 20 % | 3,00 m³/h | 131 mmH2O (3,9 %) | 4,00 mA | 0,000 m3/h |

- **Diferença entre vazão real e indicada:** o transmissor supõe C
  constante, mas na planta o C muda com o Reynolds. Por isso 7,50 m³/h reais
  aparecem como 7,46 (−0,5 %). A função "Raiz & Tabela" do LD301 corrige
  isso (manual, seção 3).
- **Corte de 6 % do ΔP:** equivale a 15·√0,06 = 3,67 m³/h. Abaixo disso:
  - em **Hard**, a indicação vai a zero;
  - em **Bumpless**, a saída fica linear com o ΔP (20 % de válvula → 6,54 mA).

No simulador, o rótulo do LCD para m³/h é "m3/h". O texto exato do aparelho
real ainda não foi fotografado (`trm/ld301/falta_fazer.txt`, item C1).

## Instalação e conformidade com a norma

As lâmpadas verdes/vermelhas mostram se a instalação segue a ISO 5167-2.

**Trechos retos (Tabela 3, uma curva de 90° a montante).** Valores em D
usados pelo modelo:

| β | Montante sem incerteza adicional (A) | Montante mínimo, +0,5 % (B) | Jusante |
|---|---|---|---|
| ≤ 0,20 | 6 | 3 | 4 |
| 0,40 | 16 | 3 | 6 |
| 0,50 | 22 | 9 | 6 |
| 0,60 | 42 | 13 | 7 |
| 0,67 | 44 | 20 | 7 |
| 0,75 | 44 | 20 | 8 |

Para β intermediário vale a linha do β maior seguinte. **Confira esses
valores com a edição da norma usada na disciplina.**

**Rugosidade (Tabela 1).** O limite de `10⁴·Ra/D` é aproximado por
`4 + 21·e^(−19,1(β − 0,3))` para β > 0,3, e 25 para β ≤ 0,3. A aproximação
erra cerca de 10 % perto de β 0,35 e 0,5.

**Faixa de validade.** A lâmpada "Faixa ISO" acende quando:

- d ≥ 12,5 mm, 50 ≤ D ≤ 1000 mm e 0,1 ≤ β ≤ 0,75;
- Re_D ≥ 5000. Com tomadas de flange, também Re_D ≥ 170β²D;
- com tomadas de canto ou D e D/2, Re_D ≥ 16000β² se β > 0,56;
- no gás, p2/p1 ≥ 0,75.

**Desvio didático.** É opcional e ligado por padrão. A norma não diz quanto
o C muda fora dela. Para a turma ver o efeito, o modelo soma um desvio ao C
(o "C real"):

- **trecho a montante:**
  - 0 no comprimento A;
  - sobe linearmente até +0,5 % no comprimento B;
  - abaixo de B, chega a +2 % sem nenhum trecho reto;
- **trecho a jusante:** 0 no exigido, +0,25 % na metade, até +0,5 %;
- **rugosidade:** `0,5·(r/limite − 1)` %, até 2 %.

Desligue em "Desvio didático de instalação e rugosidade" para ver só a norma.

## Parâmetros

São blocos **Constante** (`control.constant`) exportados. Aparecem no painel
**Propriedades** da instância, em "Propriedades exportadas", e **mudam com a
simulação rodando**. Os de escolha (tomada, materiais, fluido, desvio)
aparecem como **caixa de seleção** (propriedade `options` do bloco Constante).

| Parâmetro | Padrão |
|---|---|
| Diâmetro interno da tubulação D (a 20 °C) | 52,5 mm (2" sch 40) |
| Diâmetro do orifício d (a 20 °C) | 31,5 mm |
| Tipo de tomada de pressão | Flange |
| Trecho reto a montante (da curva até a placa) | 44 D |
| Trecho reto a jusante (da placa até a válvula) | 8 D |
| Material da tubulação | Aço carbono |
| Material da placa de orifício | Aço inox AISI 316 |
| Temperatura de operação | 20 °C |
| Fluido | Líquido |
| Massa específica do fluido na operação (a montante) | 998,2 kg/m³ |
| Viscosidade dinâmica | 1,002 cP |
| Expoente isentrópico κ (gás) | 1,4 |
| Pressão a montante (manométrica) | 200 kPa |
| Vazão máxima (válvula 100 %) | 15 m³/h |
| Desvio didático de instalação e rugosidade | Aplicar |

Materiais (dilatação α em 10⁻⁶/K e rugosidade Ra em mm):

| Material | α | Ra |
|---|---|---|
| Aço carbono | 11,2 | 0,015 |
| Aço inox AISI 316 | 16,0 | 0,005 |
| Ferro fundido | 10,4 | 0,08 |
| Aço galvanizado | 11,2 | 0,05 |
| Cobre | 16,8 | 0,0005 |
| PVC | 54 | 0,0005 |

ρ e μ são os valores do fluido **na operação**; a temperatura só dilata D e
d. No gás, informe ρ a montante (p1, T). Ar a ~3 bar abs: 3,57 kg/m³,
0,0181 cP.

**Saídas:** Vazão (m³/h), ΔP (mmH2O), HIGH e LOW (mmH2O).

## Cálculo pelo aluno (`trm/ld301/placa_orificio_calculo.py`)

Script em Python puro (só a biblioteca padrão) com as mesmas equações e os
mesmos ajustes da planta. O aluno copia para `CONFIGURACAO` os valores de
"Propriedades exportadas" e informa o que mediu:

```
python placa_orificio_calculo.py --dp 836.1                ΔP no LD301/PACTware (mmH2O)
python placa_orificio_calculo.py --corrente 11.96 --raiz   corrente do laço com raiz quadrada
python placa_orificio_calculo.py --valvula 50              abertura -> vazão -> ΔP
python placa_orificio_calculo.py                           pergunta o que foi medido
```

- **A partir do ΔP:** resolve a vazão por iteração, porque C depende de Re,
  que depende de Q, e mostra cada passo.
- **A partir da corrente:** converte para ΔP com LRV/URV e a função linear ou
  raiz.
- **Relatório:** traz os mesmos valores dos displays da planta (geometria na
  temperatura, trechos exigidos, desvio, conformidade, C, ε, ΔP, perda) para
  o aluno comparar.
- **Ajustes pela linha de comando:** também podem ser passados assim, por
  exemplo `--tomada 2 --L_montante 10 --T 80`.
- **Autoteste:** `--autoteste` confere o script com os mesmos valores da
  `fluids` usados nos testes do simulador.

## Diferença para os scripts da prática II2P05

Os scripts `compute_corrections.py` multiplicam um C fixo (0,61) por fatores:
K_tap, K_inst, K_material e K_orifice. Este modelo troca esses fatores pelo
que a norma calcula:

- **tipo de tomada:** entra pelo L1/L'2 da equação de Reader-Harris/Gallagher;
- **número de Reynolds:** muda o C;
- **material:** entra pela dilatação de D e d e pela rugosidade (com o
  limite da norma);
- **trechos retos:** comparados com a Tabela 3 e não com 10D/5D fixos.

O tipo de orifício fica fora: a ISO 5167-2 trata só da placa concêntrica de
canto vivo.

## Testes

| Teste | O que prova |
|---|---|
| `control_block_subcircuit` (7) | C, ΔP, HIGH/LOW e perda permanente iguais aos da biblioteca `fluids` (flange, D e D/2, canto, gás com ε, 50 %); desvio do montante curto; constantes ao vivo sem recompilar; `setSubcircuitChildProperty` por id local |
| `extension/src/process/orificePlate.realCore.test.ts` | Core real com LD301: PV = ΔP, faixa pelo Comando 35, raiz quadrada pelo Comando 47 (20 mA a 15 m³/h, 11,96 mA a 7,5), User Unit em m³/h pela sequência do PACTware (indica 7,46 a 7,5 reais e 15 a 100 %), tomada e trecho ao vivo, dilatação a 80 °C |
| `subcircuitLibraryLoad.test.ts` | o manifesto carrega e valida, sem id interno repetindo um pino |
| `hart_ld301` W28–W32 | sequência do DTM (35, 47, 191, 157, 180, 177, 179, 165): User Unit em m³/h aceita, DV 4 = vazão, 12 mA a 25 % de ΔP, LCD "7.500 m3/h" com o ícone PV, User Unit Off volta a % |

Os valores esperados vêm da biblioteca aberta `fluids` (Caleb Bell), que
implementa a ISO 5167-2. As expressões do manifesto foram comparadas com ela
em 450 combinações de tomada, D, β e Re: a diferença máxima foi 1,1·10⁻¹⁶.

## Limitações

- As tomadas aparecem desenhadas nos flanges para qualquer tipo; o tipo
  escolhido acende a lâmpada correspondente.
- A válvula impõe a vazão. A perda de carga da placa não reduz a vazão.
