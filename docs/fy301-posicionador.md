# FY301: posicionador de válvula sobre o dispositivo HART padrão

Subcircuito `subcircuits/hart_smar_fy301.lssubcircuit` (gerado por `scripts/generate-fy301.py`), planta
`subcircuits/process_control_valve.lssubcircuit` (`scripts/generate-control-valve.py`), projeto
`trm/fy301/posicionador_fy301.lsproj` e roteiro de aula em
`C:\Prof_Josue\0II2\II2P10_FY301_Posicionador_Valvula`.

## O laço de 4-20 mA de um atuador

O LD301 e o TT301 **escrevem** o sinal: são transmissores, controlam a corrente do laço e respondem HART
variando essa corrente (±0,5 mA). O FY301 **lê** o sinal: quem escreve a corrente é a saída analógica do
controlador (ou um calibrador em modo fonte de mA), e o posicionador é uma carga alimentada pelo próprio
laço (manual: cerca de 550 Ω, mínimo de 3,8 mA, até 11 V a 20 mA). Como não pode mudar a corrente, ele
responde HART variando a **tensão** nos bornes. O sinal HART é o mesmo; o configurador, que mede tensão
entre as garras, ouve os dois.

### Dispositivo HART padrão: `analogLoopDirection`

| Propriedade | Padrão | Função |
|---|---|---|
| `analogLoopDirection` | `output` | `output`: transmissor (fonte de corrente). `input`: atuador alimentado pelo laço |
| `analogInputResistance` | 550 Ω | carga entre LOOP+ e LOOP- no modo entrada |
| `analogInputMinimumMilliamps` | 3,8 mA | abaixo disso o aparelho está desligado: sem HART, display apagado |
| `analogInputVariable` | `inputCurrent` | variável HART que recebe a corrente medida (mA), saída de sinal para os blocos do modelo |

No modo entrada a corrente medida passa por um filtro de primeira ordem de 20 ms, como o estágio de entrada
real: a portadora do configurador (±1 mA a 1200/2200 Hz) não mexe no setpoint. A resposta HART é uma
portadora de 0,5 Vpp em série com a carga (`hart_phy::kSlaveVoltageAmplitudeV`).

### Modem HART: `connection`

| Valor | Uso |
|---|---|
| `series` (padrão) | em série no laço, com o resistor interno de 250 Ω: ouve a variação de corrente de um transmissor (projetos LD301/TT301) |
| `parallel` | em paralelo na linha, como as garras do configurador: receptor de alta impedância (1 GΩ, sem carga DC) e portadora injetada sem caminho DC; ouve o posicionador e também um transmissor (ligado sobre o resistor de 250 Ω) |

Com uma fonte de corrente ideal e o modem em série, nada passa nos dois sentidos: a fonte fixa a corrente.
É o comportamento físico; por isso o projeto do FY301 liga o modem em paralelo.

### Pontes Sinal-MNA da paleta

A fábrica do Core pegava os terminais elétricos das pontes (sensores e fontes por sinal, resistor por
sinal) **por posição**. O catálogo lista a porta de sinal primeiro (`command`, `p`, `n`), então uma ponte
colocada direto da paleta tinha `p` = porta de sinal e `n` = `p`: a fonte de corrente injetava ao contrário.
Agora os terminais são escolhidos pelo nome (`makeNamedPins2`). Dentro dos subcircuitos já funcionava,
porque só os pinos ligados entram na lista.

## Subcircuito FY301

Pinos: `LOOP+`/`LOOP-` (elétricos), `SUP` (suprimento de ar, bar), `OUT1` (saída pneumática, bar) e `POS`
(curso da haste lido pelo ímã/sensor Hall, mm).

Cadeia de blocos (`sl.fcn`/`sl.unit_delay`, período de 1 ms, necessário para o laço servo de ganho alto):

```text
4-20 mA -> split range (Cmd 35, % da faixa) -> Local (SP% do Cmd 226) / Remoto -> curva (Cmd 47) -> limites -> TSO -> TIME -> setpoint
POS (mm) -> calibração do Auto Setup (Cmd 152) -> trims LOPOS/UPPOS (Cmd 168) -> ação direta/reversa (Cmd 157) -> PV = posição %
erro (com AIR_T, Cmd 129) -> PI (3 x KP, TR em min/rep; Cmd 218/219) -> piezo/carretel (% do suprimento) -> OUT1 = % x SUP
```

**Toda a configuração é feita por HART**, com os comandos do DD da Smar (revisão 2) e o DTM do FY301
(LasecFDT ou PACTware): o dispositivo é o único dono dos parâmetros, que o modelo lê pelos pinos de saída das
variáveis HART. O mapa completo de comandos e a forma como foi obtido estão em
[fy301-dtm-engenharia-reversa.md](fy301-dtm-engenharia-reversa.md). A configuração escrita pelo DTM é gravada no
`.lsproj` ao salvar, parar ou reconstruir (como no LD301).

| Parâmetro | Comando | Padrão de fábrica | Manual |
|---|---|---|---|
| Tipo (Linear/Rotary) | 187/188 | Linear | seção 4 (TYPE) |
| Ação (Direct/Reverse) | 156/157 | Direct | seção 4 (TYPE Lind/Linr) |
| Ar para (Open/Close) = AIR_T | 128/129 | Open | seção 4 |
| Curva: 0 Linear, 1 EP 1:50, 2 AR 1:50, 3 Tabela, 4 EP 1:25, 5 AR 1:25, 6 EP 1:33, 7 AR 1:33 | 47 (lida no 15) | Linear | seção 3 |
| Tabela de 16 pontos (X entrada %, Y posição %) | 133/134/135 | 2 pontos 0-100 | seção 3 |
| KP, TR (min/rep), banda morta | 217-220 | 40, 2, 0 | seção 4 |
| TIME abertura/fechamento (s), TSO e banda do TSO (%), limites do SP (%) | 221/222 | 0 (sem limite), 0, 0-100 | seções 3 e 4 |
| Split range (mA) | 35 (lido no 15) | 4-20 mA | seção 3 |
| SP Local/Remoto e SP% local | 223-226 | Remoto | seção 4 (MODE/SP%) |
| Auto Setup / Setup manual | 152 / 250 | — | seção 3 |
| Trims de posição inferior/superior (%) | 168 | 0 / 100 | seção 4 (LOPOS/UPPOS) |
| LCD (PV% ou SP%) | 247/248 | PV% | seção 3 |

Nas Propriedades exportadas ficam só os dados físicos: a escala de fábrica do sensor de posição (30 mm) e a
temperatura ambiente.

- **Curvas:** igual porcentagem `100·(R^(s/100) - 1)/(R - 1)`; abertura rápida hiperbólica
  `100·R·s/(1 + (R - 1)·s)` (s em 0-1). O manual nomeia as curvas mas não traz as fórmulas.
- **Auto Setup** (cerca de 50 s no simulador; cerca de 4 min no aparelho): 0-25 s sem ar, grava a posição
  de repouso; 25-50 s com ar total, grava a outra ponta; a integral é zerada. Progresso no Cmd 33 código 17 e
  estado no Cmd 48 byte 1 (15 = em andamento). Antes do primeiro Auto Setup a escala do sensor é a de fábrica
  (30 mm): num curso de 20 mm, 50 % no display são 75 % de abertura real.
- **Ação × AIR_T:** com ação reversa num atuador ar-para-abrir o AIR_T tem de ser *Close* (manual, seção 4);
  a combinação errada dá realimentação positiva e a válvula vai a um extremo.
- **Servo:** ganho interno 3 x KP (piezo + carretel). Com KP 40 a válvula assenta em cerca de 1 s e a integral
  remove os últimos décimos de %; KP perto de 0,5 é lento e deixa erro.
- **HART:** PV = posição (%, código 1); faixa (Cmd 15/35) = split range em mA; Cmd 2/3 = corrente medida e %
  do split range; Cmd 33 com os códigos do DTM (0 entrada mA, 2 entrada %, 1 posição, 6 SP, 17 progresso do
  setup …). Display: PV% ou SP% conforme o Cmd 248.
- **Identidade:** Smar 3E, tipo 03, HART 5, revisão do dispositivo 2 (a do DD `0202`), firmware 2.04, ID 0B 2A 61.

O preset antigo `protocol.hart.device.smar_fy301` continua registrado (projetos antigos abrem), oculto da
paleta como os do LD301 e do TT301.

## Planta: válvula de controle

- pressão no atuador `dP/dt = (OUT1 - P)/τ`;
- equilíbrio mola x diafragma pela faixa da mola (bench set, padrão 0,2-1,0 bar), ar para abrir (falha
  fechada) ou ar para fechar (falha aberta); fora da faixa a pré-carga assenta o obturador na sede ou a haste
  encosta no batente (a haste fica entre 0 e o curso);
- banda morta do atrito da gaxeta (% do curso) e `dx/dt = (x_eq - x)/0,15 s`;
- vazão `Q = Kvs·f(l)·√ΔP` com característica inerente linear, igual porcentagem (R = 50) ou abertura rápida.

## Testes

| Teste | O que prova |
|---|---|
| `hart_wire_loop` I0-I8 | carga de 550 Ω (6,6 V a 12 mA), corrente medida, Cmd 0/13 byte a byte pelo modem em paralelo, 0,5 Vpp, a portadora HART não mexe na corrente medida (retida durante a portadora), desligado abaixo de 3,8 mA, display apagado, modem em série não ouve |
| `fy301ControlValve.realCore.test.ts` | toda a configuração por HART, com os bytes do DTM: escala de fábrica antes do Auto Setup; Auto Setup (Cmd 152, Cmd 48, Cmd 33 código 17); Cmd 2/15/33; 4/20 mA; Cmd 47 EP 1:50 → 12,4 % e código inválido recusado; SP local (224/226); split range pelo Cmd 35; TIME e TSO (222); tabela (133-135); ação reversa + AIR_T; AIR_T trocado; contadores (166); Cmd 242; sem sinal |
| `hartSmarDevices.test.ts`, `paletteTree.test.ts` | pinos e modo do FY301, imagem dentro das margens, preset antigo oculto |
| `control_block_subcircuit` (3) | a planta da válvula instancia e compila |

Com o posicionador, o atrito quase não muda o curso final: o servo aumenta a pressão até vencê-lo. A
mesma posição passa a exigir mais pressão (50 %: cerca de 0,60 bar com atrito de 0,5 % e 0,62 bar com 5 %).

Capturas que faltam do FY301 real: `trm/fy301/Falta_fazer.txt`.
