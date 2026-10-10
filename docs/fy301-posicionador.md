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

Cadeia de blocos (período de 1 ms, necessário para o laço servo de ganho alto):

```text
4-20 mA -> split range -> Auto/Man (SP%) -> CHAR -> limites -> TSO -> TIME (taxa) -> setpoint de posição
POS (mm) -> calibração do Auto Setup -> LOPOS/UPPOS -> ação direta/reversa (TYPE) -> posição %
erro (com AIR_T) -> PI (3 x KP, TR) -> sinal do piezo/carretel (% do suprimento) -> OUT1 = % x SUP
```

| Parâmetro (Propriedades exportadas) | Padrão | Manual |
|---|---|---|
| TYPE (0 Lind, 1 Linr, 2 Rotd, 3 Rotr) | 0 | seção 4 |
| AIR_T (0 AIR_OPEN, 1 AIR_CLOSED) | 0 | seção 4 |
| CHAR (0 Lin; 1-3 EP 1:25/1:33/1:50; 4-6 abertura rápida hiperbólica 1:25/1:33/1:50) | 0 | seção 3 |
| MODE (0 Auto, 1 Man) e SP% | Auto, 0 % | seção 4 |
| TIME (s, de 0 a 100 %) | 1 | seção 4 (1 a 60 s) |
| KP, TR (min/rep) | 40, 2 | seção 4 (KP 35-45 e TR ~2 em válvulas lineares) |
| LOPOS, UPPOS (%) | 0, 100 | seção 4 |
| TSO (%) | 0 (desligado) | seção 3 |
| Limites do setpoint, split range (mA) | 0-100 %, 4-20 mA | seção 3 |
| SETUP (0 Parado, 1 Executar) | 0 | seção 3 (Auto Setup) |

- **Curvas:** igual porcentagem `100·(R^(s/100) - 1)/(R - 1)`; abertura rápida hiperbólica
  `100·R·s/(1 + (R - 1)·s)` (s em 0-1). O manual nomeia as curvas mas não traz as fórmulas.
- **Auto Setup** (cerca de 50 s no simulador; cerca de 4 min no aparelho): 0-25 s sem ar, grava a posição
  de repouso; 25-50 s com ar total, grava a outra ponta; a integral é zerada. Antes do primeiro Auto Setup,
  a escala do sensor é a de fábrica (30 mm): num curso de 20 mm, 50 % no display são 75 % de abertura real.
- **Servo:** ganho interno 3 x KP (piezo + carretel). Com KP 40 a válvula assenta em cerca de 1 s e a integral
  remove os últimos décimos de %; KP perto de 0,5 é lento e deixa erro.
- **HART:** PV = setpoint (sinal de entrada, 0-100 % para 4-20 mA), SV = posição, TV = corrente de entrada,
  QV = OUT1 (bar), variável 4 = setpoint de posição. O Comando 2 informa a corrente lida; o Comando 33 lê a
  posição (variável 1). O Comando 3 embutido do dispositivo padrão devolve só a PV (a DSL não sobrescreve
  comandos Universais). Display: posição (variável 1) e setpoint de posição (variável 4), alternados.
- **Identidade (inferida):** Smar 3E, tipo 03 (sequência LD301 01, TT301 02), HART 5 (o manual cita
  endereços de multidrop 1 a 15), software 4 (manual da versão 4.XX), ID 0B 2A 61.

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
| `hart_wire_loop` I0-I8 | carga de 550 Ω (6,6 V a 12 mA), corrente medida, Cmd 0/13 byte a byte pelo modem em paralelo, 0,5 Vpp, filtro de entrada, desligado abaixo de 3,8 mA, display apagado, modem em série não ouve |
| `fy301ControlValve.realCore.test.ts` | escala de fábrica antes do Auto Setup; Auto Setup; Cmd 2 = 12,000 mA, Cmd 33; 4/20 mA; EP 1:50 → 12,4 %; manual; split range; AIR_T trocado; fonte de corrente com a ordem de pinos da paleta |
| `hartSmarDevices.test.ts`, `paletteTree.test.ts` | pinos e modo do FY301, imagem dentro das margens, preset antigo oculto |
| `control_block_subcircuit` (3) | a planta da válvula instancia e compila |

Com o posicionador, o atrito quase não muda o curso final: o servo aumenta a pressão até vencê-lo. A
mesma posição passa a exigir mais pressão (50 %: cerca de 0,60 bar com atrito de 0,5 % e 0,62 bar com 5 %).

Capturas que faltam do FY301 real: `trm/fy301/Falta_fazer.txt`.
