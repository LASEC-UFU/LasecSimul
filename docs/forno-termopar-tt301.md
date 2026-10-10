# Termopar: componente da paleta, entrada de termopar do TT301 e forno elétrico

Roteiro de aula em `C:\Prof_Josue\0II2\II2P09_TT301_Temperatura_Termopar`. Projetos:
`trm/tt301/forno_termopar_tt301.lsproj` (forno + TT301) e `trm/tt301/bancada_termopar_tt301.lsproj`
(termopar da paleta fazendo o papel do calibrador em modo TC).

## Funções de referência NIST ITS-90

`scripts/thermocouple_its90.py` guarda os coeficientes da NIST ITS-90 Thermocouple Database
(Monograph 175, https://its90.nist.gov/ThermoDownloads) dos tipos B, E, J, K, N, R, S e T: função de
referência `E(t)` (mV, junta de referência a 0 °C, com o termo exponencial do K) e inversa aproximada
`t(E)`. `python scripts/thermocouple_its90.py --check --tables <pasta com type_x.tab.txt>` compara com
as tabelas do NIST grau a grau: diferença máxima de 0,0005 mV (o arredondamento da tabela) e inversa
dentro de 0,05 °C. O mesmo módulo gera:

- as expressões de cálculo (forma de Horner, só `+ − * / ^ > <`) do TT301 e do forno;
- `devices/simulide-sensors/src/thermocouple_its90.h` (`--c-header`) para o componente da paleta.

A ordem dos tipos é a da lista do TT301 (byte 2 do Comando 131 com termopar): B = 0, E = 1, J = 2,
K = 3, N = 4, R = 5, S = 6, T = 7.

## Termopar da paleta (`sensors.thermocouple`)

Na pasta **Sensores**, ao lado do RTD (`devices/simulide-sensors/thermocouple.lsdevice`, mesmo
`device.dll`). Pinos `+` e `−`; dial na temperatura da junta de medição. Gera
`E(junta de medição) − E(junta de referência)` em série com a resistência dos fios (equivalente de
Norton). Propriedades: junta de medição, junta de referência (onde os fios do termopar encontram o
cobre: os bornes do instrumento), tipo, faixa do dial, resistência dos fios e rompido.

`emf_mv` é uma propriedade só de leitura e oculta (o painel não atualiza propriedades ao vivo); a
bancada mostra a FEM com um voltímetro.

## Entrada de termopar do TT301

Manual, Fig. 1.9: termopar **+ no borne 2, − no borne 3**, bornes 1, 3 e 4 ligados entre si. O estágio
de entrada do subcircuito (blocos genéricos, sem código de TT301 no Core) passou a ter um ramo de
termopar ao lado do de RTD:

| Bloco | Função |
|---|---|
| `rtd_exc_cmd` | desliga a excitação de 0,5 mA do RTD quando o sensor é termopar |
| `tc_det_value` + `tc_det` | 10 nA saindo pelo borne 2: termopar aberto lê ~1 V e vai a burnout; ligado, erro de 10 nA × resistência dos fios (< 0,01 °C) |
| `tc_mv` | `V(2) − V(3)` em mV |
| `tc_cj_<tipo>`, `tc_cj` | `E_tipo(temperatura da borneira)`, compensação da junta fria |
| `tc_e` | `mV + E(borneira)` com a junta fria habilitada |
| `tc_ec_<tipo>`, `tc_t_<tipo>`, `tc_t` | limita à faixa NIST do tipo e converte pela inversa |
| `tc_fault` | termopar aberto (mV > 150 ou < −50) ou tipo não simulado |
| `pv_select`, `fault_select` | PV e falha do RTD ou do termopar, conforme `sensor.type` |

Variáveis HART que passaram a ser sinais:

- `sensor.type`, `sensor.model` e `sensor.coldJunction` (saídas): o que o PACTware grava pelos
  Comandos 131 e 186 é o que o estágio usa.
- `terminalTemperature` (entrada, SV): vem da constante exportada **Temperatura da borneira**
  `c_tterm` (25 °C), que representa o sensor de junta fria do TT301.

Inferências (capturas pendentes em `trm/tt301/Falta_fazer.txt`):

- Só o tipo **J** foi capturado (`83 02`). Os outros termopares seguem a ordem da Tabela 4.7 (A4).
- Junta fria: `00` = habilitada (capturado). `FF` (valor com RTD) também conta como habilitada; qualquer
  outro código desabilita. O código de "Disabled" não foi capturado (A5).
- L/U DIN, W5Re/W26Re e L GOST (códigos 8 a 11) não são simulados: leem como falha do sensor.
- Com a junta fria do TT301 e a referência do termopar na mesma temperatura, a leitura é exata. Para
  simular um sensor de junta fria descalibrado, mude só a **Temperatura da borneira** do TT301.

## Forno elétrico com termopar (`subcircuits.process.electric_furnace_tc`)

Gerado por `scripts/generate-electric-furnace-tc.py`.

- Balanço de energia: `C·dT/dt = P_max·u/100 − UA·(T − T_amb)`.
- Tubo de proteção: `dT_s/dt = (T − T_s)/τ`.
- FEM nos bornes: `E(T_s + desvio) − E(T_referência)`. A referência fica nos bornes do transmissor
  (ambiente) com cabo de extensão; com cabo de cobre comum, fica no cabeçote.
- A FEM é uma `bridges.controlled_voltage_source` em série com os dois fios (`bridges.controlled_resistor`):
  polaridade invertida e termopar rompido são elétricos de verdade.

| Parâmetro | Padrão |
|---|---|
| Potência máxima | 3 kW |
| Capacidade térmica (forno + carga) | 1,5 kJ/K |
| UA | 2,5 W/K |
| Temperatura ambiente (onde fica o transmissor) | 25 °C |
| τ do termopar | 20 s |
| Tipo | 3 (K) |
| Resistência de cada fio | 2,5 Ω |
| Desvio do termopar | 0 °C |
| Cabo do cabeçote ao transmissor | 0 = extensão (1 = cobre) |
| Temperatura no cabeçote | 60 °C |
| Polaridade invertida | Não |
| Termopar rompido | Não |

Constante de tempo de 600 s (10 min) e regime `25 + 12·u` °C (625 °C a 50 %, 1225 °C a 100 %).

## Símbolo do TT301

O renderizador deixa livre a faixa de 8 px dos terminais nas bordas com pino. A imagem do TT301 ia
de x = 0 a 150 e perdia as duas tampas. Agora fica entre as margens: `x = 8`, largura 134.

## Testes

| Teste | O que prova |
|---|---|
| `thermocouple_its90.py --check` | funções e expressões iguais às tabelas NIST |
| `hart_tt301` S3/S4/S8 | PV e falha pelos seletores, borneira exportada, 7 portas de sinal |
| `control_block_subcircuit` (3) | o forno instancia e compila (53/53 manifestos) |
| `hartTt301Thermocouple.realCore.test.ts` | termopar da paleta: 19,644 mV a 500 °C; Cmd 131/186; junta fria a 40 °C; junta fria desligada (476,5 °C); rompido; tipo trocado |
| `electricFurnaceTt301.realCore.test.ts` | forno + TT301: repouso, 120 s a 100 % igual ao modelo, desvio, cabo de cobre (−35 °C), polaridade, rompido |
| `simulideGraphicalCatalog.test.ts` | o termopar tem ícone e dial como os outros sensores |
