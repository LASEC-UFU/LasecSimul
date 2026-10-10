# Tanque aquecido com Pt100 e TT301 a 4 fios

Planta `subcircuits.process.heated_tank_pt100`
(`subcircuits/process_heated_tank_pt100.lssubcircuit`, gerada por
`scripts/generate-heated-tank-pt100.py`), projeto `trm/tt301/tanque_aquecido_tt301.lsproj`
e roteiro de aula em `C:\Prof_Josue\0II2\II2P08_TT301_Temperatura_PT100`.

## TT301 com os bornes do sensor (1 a 4)

O TT301 real não recebe "temperatura": ele mede a resistência do sensor ligado nos bornes 1 a 4. O
subcircuito `hart_smar_tt301.lssubcircuit` agora tem esses bornes no lugar do antigo pino de sinal
TEMP. O estágio de entrada é montado com blocos genéricos dentro do subcircuito, sem código de TT301
no Core:

| Bloco | Função |
|---|---|
| `bridges.controlled_current_source` + constante de 0,5 mA | excitação: sai pelo borne 1, volta pelo 4 |
| `bridges.voltage_sensor` 2–3 e 3–4 | medição de alta impedância (sem corrente nos bornes 2 e 3) |
| `rtd_r` | `R = (V23 − 3fios·V34)/I` |
| `rtd_t` | Pt100 IEC 60751 (Callendar–Van Dusen, ramo t ≥ 0) |
| `rtd_fault` | R fora de 18–400 Ω (sensor aberto ou em curto) → entrada `sensorFault` do dispositivo → burnout |
| resistores de 100 MΩ e 1 GΩ | mantêm os bornes definidos com o sensor aberto e dão referência ao circuito isolado do sensor |

Resultado, como no aparelho real:

- **4 fios**: a resistência dos cabos não entra;
- **2 fios** (pontes 1–2 e 3–4 nos bornes): os dois fios somam-se ao sensor (`+2R/0,385 °C`);
- **3 fios** (ponte 1–2) com a conexão "3 fios" configurada: a queda no fio de retorno é subtraída.

A ligação vem da variável `sensor.connection` do TT301, que passou a ser uma saída de sinal: o que o
PACTware grava é o que o estágio de entrada usa. **Só o código 1 (2 fios) foi capturado** no
aparelho; os demais (0 diferencial, 2 três fios, 3 quatro fios, 4–7 backup/média/máximo/mínimo)
seguem a ordem da lista do manual e precisam da captura A4 de `trm/tt301/Falta_fazer.txt`. Como as
fórmulas de 2 e de 4 fios são iguais (a diferença está nas pontes), só o código de 3 fios importa
para a medida.

O mesmo estágio mede termopar nos bornes 2 e 3 (ver `docs/forno-termopar-tt301.md`).

## Planta

- Balanço de energia: `m·c·dT/dt = P_max·u/100 − UA·(T − T_amb)`, fervura a 100 °C.
- Poço termométrico: `dT_s/dt = (T − T_s)/τ`.
- Pt100: `R = R0·(1 + A·t + B·t² [+ C·(t − 100)·t³ abaixo de 0 °C])`, `t = T_s + desvio`.
- O elemento e os quatro fios do cabo são `bridges.controlled_resistor`: resistências reais no MNA.

| Parâmetro | Padrão |
|---|---|
| Volume de água | 10 L |
| Potência máxima | 6 kW |
| UA | 80 W/K |
| Temperatura ambiente | 25 °C |
| τ do poço | 15 s |
| R0 | 100 Ω |
| Resistência de cada fio | 0,5 Ω |
| Desvio do sensor | 0 °C |
| Sensor rompido | Não |

Constante de tempo térmica 523 s (8,7 min); regime `T_amb + P/UA` (62,5 °C a 50 %).

## Mudanças no Core

- **`bridges.controlled_resistor`** (`SignalBridges.hpp`): resistência (Ω) vinda de uma porta de sinal,
  com valor inicial pela propriedade `resistance`. Catálogo: "Sinal2Resistência" em Conversores.
- **Entrada `sensorFault`** do dispositivo HART padrão: um modelo que declara essa variável de
  entrada leva o dispositivo ao burnout a partir de um bloco (soma-se à propriedade `sensorFault`).
- **Rate das pontes elétricas**: a porta de uma ponte (sensores e fontes/resistor por sinal) herda o
  período dos vizinhos no Signal Graph (bloco de controle, ou 1 ms para slider, constante e HART).
  Antes, toda ponte nascia com rate de 1 ns e, ligada a um bloco de 1 ms, prendia a simulação em
  1 milhão de passos por milissegundo.

## Testes

| Teste | O que prova |
|---|---|
| `electrical_signal_bridge_live` (5) | lei de Ohm pelo resistor por sinal; 20 ms em passos normais |
| `hart_tt301` S3/S8 | bornes 1–4 no subcircuito, PV e burnout pelo estágio de entrada |
| `control_block_subcircuit` (3) | a planta instancia e compila com os demais manifestos |
| `hartTt301Subcircuit.realCore.test.ts` | Pt100 a 4 fios = PV exato; 2 fios +5,3 °C com 1 Ω por fio; 3 fios compensado; burnout 21 mA |
| `heatedTankTt301.realCore.test.ts` | planta + TT301: 25 °C em repouso, aquecimento por 60 s igual ao modelo, desvio de +0,5 °C, sensor rompido |
