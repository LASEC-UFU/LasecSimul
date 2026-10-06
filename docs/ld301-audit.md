# Auditoria do transmissor HART LD301 simulado

O LD301 é o subcircuito `subcircuits/hart_smar_ld301.lssubcircuit`, construído
sobre o **dispositivo HART padrão** em C++ (`protocol.hart.device.standard`). Ver §5.

Fonte de verdade local: `ld301/fig01.png`…`fig23.png` e
`ld301/saida do trm hart LD301.txt`. Esses originais não fazem parte do
repositório; as 23 capturas de protocolo necessárias aos testes estão versionadas
em `core/test/core/protocols/fixtures/ld301_*.txt`.
O log é a ponte `pactware_udp_bridge.py`: **SERIAL RX** = requisição do PACTware
(COM23 ↔ CNCB3, 1200 8O1); **UDP RX** = bytes do LD301 real vindos da ESP32
(modem HART), fragmentados em datagramas de 1–4 bytes. Cada resposta foi
remontada concatenando os datagramas até a requisição seguinte; nenhum
datagrama é tratado como quadro.

Artefatos reproduzíveis:

| Artefato | Conteúdo | Como gerar |
|---|---|---|
| [`ld301-session.csv`](ld301-session.csv) | 135 trocas: preâmbulos, delimitador, endereço, comando, byte count, dados, XOR, RC, status | `python scripts/ld301_decode.py` |
| [`ld301-replay.csv`](ld301-replay.csv) | resposta real × simulada, byte a byte, com classificação | `hart_ld301_test --report docs/ld301-replay.csv` |
| `hart_ld301_test` | 249 verificações + replay, LD301 lido do `.lssubcircuit` | `ctest -R hart_ld301` |

Legenda de evidência: **C** = capturado no log; **F** = lido na figura;
**D** = deduzido de C/F com cálculo verificado; **S** = especificação HART
(HCF_SPEC-99/127/151/183/307 do `HART.zip`); **M** = manual do LD301
(`ld301/ld301mp.pdf`, ver §5.5); **H** = hipótese (não verificável com o
material); **ND** = não determinado.

---

## 1. Referência encontrada — `LD301_REFERENCE_PROFILE`

Classe: **Id** identificação · **Lim** limite físico · **Cfg** configuração do
exemplar (não default de fábrica) · **Dyn** variável dinâmica · **Cal**
calibração · **Circ** valor circunstancial da captura.

### 1.1 Identificação e protocolo

| Campo | Valor | Classe | Origem | Cmd | Estado interno | Simulador |
|---|---|---|---|---|---|---|
| Fabricante | Smar `0x3E` | Id | C, F03 | 0 | `profile.manufacturerId` | igual |
| Device type | LD301 `0x01` | Id | C, F03 | 0 | `profile.deviceType` | igual |
| Device ID | 389197 = `05 F0 4D` | Id | C, F03 | 0 | `uniqueId` | igual |
| Long address | `3E 01 05 F0 4D` (`BE…` com bit de mestre primário) | Id | C, F03 | todos | resolução em `HartEngine::executeAddressed` | igual |
| Preâmbulos | 5 (req. e resp.) | Id | C | 0 | `responsePreambles` | igual |
| Universal rev. / device rev. | 5 / 5 | Id | C, F02 | 0 | `identity` | igual |
| Software rev. | `0x72` (DTM: “Firmware 7.02”) | Id | C, F03 | 0 | `identity.softwareRevision` | igual |
| Hardware/sinalização | `0x20` = hw rev 4, Bell 202 corrente | Id | C, F02 | 0 | `identity` | igual |
| Flags | `0x06` = EEPROM control + protocol bridge (Common Table 11) | Id | C, S | 0 | `identity.flags` | igual |
| Polling address | 0 (quadro curto `80`) | Cfg | C | 0/6 | `pollingAddress` | igual |
| Tag | `TAG` → **`LT100`** (Cmd 18) | Cfg | C, F02 | 13/18 | `tag` | igual |
| Descriptor | `16 CHARACTERES` → **`MEDIDOR DE NIVEL`** | Cfg | C, F02 | 13/18 | `descriptor` | igual |
| Data | bytes `82 08 20` (inválida, texto empacotado) → **08/03/1981** | Cfg | C, F02 | 13/18 | `date` | igual |
| Message (32 car.) | `32 CHARACTERES` → **`TRANSMISSOR DE NIVEL`** | Cfg | C, F02 | 12/17 | `message` | igual |
| Final assembly (“Main Board”) | 53478 = `00 D0 E6` | Id | C, F03 | 16 | `finalAssemblyNumber` | igual |
| Sensor serial | 653944 = `09 FA 78` | Id | C, F03/F04 | 14 | `PV.transducerSerialNumber` | igual |
| Ordering code | `LD301M21ITD10011-I6P0 ` (22 B ASCII) | Id | C, F02 | 173 | var. `orderingCode` (Ascii) | igual |
| Private label | `0x3E` | Id | C | 15 | fabricante | igual |
| Write protect | 0 = “Not Write Protected” | Cfg | C, F06 | 15 | `writeProtectCode` | igual |
| Status inicial | `0x64` → `0x44` | — | C | todos | ver §3/§11 | igual |

### 1.2 Medição, faixa e saída

| Campo | Valor | Classe | Origem | Cmd | Estado interno | Simulador |
|---|---|---|---|---|---|---|
| Unidade do PV | `0x04` mmH2O @68 °F (= 20 °C) | Cfg | C, F07 | 1/14/15 | `PV.deviceVariableUnit` | igual |
| USL / LSL | +5107.7451 / −5107.7451 (`459F9DF6`/`C59F9DF6`) | Lim | C, F07, F14 | 14 | `PV.upper/lowerTransducerLimit` | igual |
| Span mínimo | 25.538725 (`41CC4F4F`; tela 25,5387) | Lim | C, F07 | 14 | `PV.minimumSpan` | igual |
| URV / LRV | 1690 / 190 (span 1500) | Cfg | C, F01, F07 | 15/35 | `PV.upper/lowerRangeValue` | igual |
| Damping | 0,00 s; filtro digital de 1ª ordem, 0–128 s (M) | Cfg | C, F01/06/07, M | 15/34 | `PV.dampingValue` | igual; filtro aplicado ao PV |
| Função de transferência | Linear (0) | Cfg | C, F01/06 | 15 | `pvTransferFunctionCode` | igual |
| Fail safe (alarme) | Low (1) | Cfg | C, F06 | 15 | `alarmSelectionCode` | igual |
| PV | **0,0 mmH2O** | Dyn | C (Cmd 1), F15–17 | 1/3 | entrada `PV` | igual |
| % da faixa | −12,6667 % (`C14AAAAA`) | D | C (Cmd 140) | 2/140 | calculado | igual, bit a bit |
| Corrente | **3,80 mA** (saturação inferior) | D | C (Cmd 33 cód. 0), F14/20/22 | 2/3/33 | calculado | igual |
| Saturação | inferior −1,25 % = 3,8 mA (C, M); superior 103,125 % = 20,5 mA (M) | Lim | C/M | — | `profile.analogLower/UpperSaturationPercent` | igual |
| Corrente fixa (loop test) | 3,6 a 21 mA (M) | Lim | M | 40 | `analogFixedLow/HighMilliamps` | igual |
| Burnout (falha) | 3,6 mA (Low) / 21 mA (High) conforme Alarm Selection (M) | Lim | M | — | `analogAlarmLow/HighMilliamps` + `sensorFault` | igual |
| PV em unidade do usuário (cód. 4) | 172,4467 mm = 243 + 557 × (−12,667 %) | D | C, F14 | 33 | var. `pvUserUnit` derivada | igual, bit a bit |
| Unidade do usuário | On, 0 % = 243 mm, 100 % = 800 mm, família Length, “mm” (`0x31`) | Cfg | C, F08 | 176/178 | `pvUserUnit` range + `userUnit.label` | igual |
| Temperatura (cód. 5) | 28,078 °C (`41E09FBE`); 28,081 depois; 28,15 na F18 | Dyn/Circ | C, F14, F18 | 33 | entrada `temperature` | inicia em 28,078 |
| Variável 20 | −1582,9156, unidade 251 | Circ/ND | C | 33 | `deviceVariable20` | igual (significado ND) |

### 1.3 Telas (fig01–fig23)

Campos editáveis = caixa branca/seletor; somente leitura = cinza.

| Fig | Tela | Campos e valores | Editável | Leitura | Escrita |
|---|---|---|---|---|---|
| 01 | Online Parameterize (resumo) | Display PV(%)/Temp./Installed; PV unit mmH2O@20°C; LRV 190; URV 1690; Function Linear; Controller Off; Totalization Off; Damping 0,00 | unidade, LRV/URV, função, modos, damping | 164, 15, 138, 185 | ND (não capturada) |
| 02 | Identification | Tag LT100; Descriptor; Message; Date 08/03/1981; Universal 5; Specific 5; Bell 202; Ordering code | tag/descr./msg./data | 13, 12, 0, 173 | **18, 17** (capturados) |
| 03 | Device | Smar; LD301; ID 389197; Long Address 3E 01 05 F0 4D; Firmware 7.02; Main board 53478; Sensor 653944 | não | 0, 16, 14 | — |
| 04 | Sensor | Gauge (M); Silicone; Range 2 (200 inH2O); 316 SS; 653944 | não | 128, 14 | — |
| 05 | Flange/Seal | Conventional (Biplanar); Hastelloy C; PTFE; Drain 316 SS; remote seal None ×4 | sim | 128 | ND |
| 06 | Configuration | Fail Safe Low; Linear; Controller Off; Totalization Off; Damping 0,00; Not Write Protected | sim (exceto WP) | 15, 138, 185 | ND |
| 07 | Measurement | URL/LRL/span mínimo; URV/LRV; damping; unidade; Lo-/Hi+ | faixa, damping, unidade | 14, 15 | 35/36/37/34/44 (padrão; não capturadas) |
| 08 | User Unit | On; 243/800 mm; Length; mm | sim | 176, 178 | ND |
| 09 | Display | PV(%); Temp.; Installed | sim | 164 | ND |
| 10 | Table | 6 pontos; (0,0) e (100,100)×5 | sim | 133 (8 páginas) | ND |
| 11 | PID Control | Reverse; SP tracking Off; Power-on Automatic; PID Automatic; Kp 1,00; Tr 0,01; Td 0,00 | sim | 136, 142 | ND |
| 12 | PID Loop | Automatic; Off; SP 50 %; PV −12,67 %; MV −1,25 %; Erro 0,000 % | SP, MV, modos | 140 | ND |
| 13 | Totalization | Off; total 0,00; Miscellaneous; max flow 100; fator 1,00; reset | sim | 185, 186, 189 | ND |
| 14 | Calibration overview | 172,4467 mm; mm; ±5107,7451; 25,5387; 28,08 °C; 3,80 mA; caracterização Off; últimos pontos 0 / 5088,8975 | não | 33{4,5,0}, 14, 160, 128, 176 | — |
| 15 | Zero Pressure | Pressão 0,00 mmH2O@20°C | ação | 1 | **43** (×5, com byte `00`) |
| 16 | Lower Pressure | Pressão 0,00; novo valor | novo valor | 1 | ND |
| 17 | Upper Pressure | Pressão 0,00; novo valor | novo valor | 1 | ND |
| 18 | Temperature trim | 28,15 °C; novo valor | novo valor | 33{5} | ND |
| 19 | Sensor Characterization | 5 pontos; Off; medidos = desejados 0 / 1276,9363 / 2553,8726 / 3830,8088 / 5107,7451 | modo/start | 160 (5 pontos) | ND |
| 20 | Output Current (trim) | 4/20 mA; digital 3,80 | seleção, valor | 33{0}, 204, 40 | 40 (4 mA e saída) |
| 21 | Operations counter | LRV/URV 61; Function 7; Trim_Lower/Zero 21 (19 no log); PID 8; Totalization 8; Auto clamping 1; demais 0 | não | 166 | — |
| 22, 23 | Loop Test | Digital current 3,800; 4/8/12/16/20/Other | seleção | 33{0} | **40** (4, 8, 12, 16, 20, 0) |

Multidrop/Polling Address e Factory (General, Work Limits, Polynomial, Device
Info, Auto Clamping, Emulator) aparecem só na árvore: **não há tela nem tráfego
capturado** para elas.

---

## 2. Comandos HART encontrados (30 distintos, 135 trocas)

Respostas sem preâmbulos; `RC ST` = código de resposta e status. Política =
classe HCF_SPEC-99 Tabela 9 aplicada pelo simulador.

| Cmd | Nº | Request (dados) | Resposta (RC ST + dados, 1ª ocorrência) | Significado | Implementação | Replay |
|---|---:|---|---|---|---|---|
| 0 `00` | 7 | — | `00 64` FE 3E 01 05 05 05 72 20 06 05 F0 4D | Read Unique Identifier (curto e longo) | StandardCore (DSL built-in) | 7 exatos |
| 1 `01` | 5 | — | `00 44` 04 00000000 | Read PV: mmH2O, 0,0 | StandardCore | 5 exatos |
| 12 `0C` | 4 | — | `00 44` + 24 B empacotados | Read Message (32 car.) | StandardCore | 4 exatos |
| 13 `0D` | 5 | — | `00 44` tag(6) descr.(12) data(3) | Read Tag/Descriptor/Date | StandardCore | 5 exatos |
| 14 `0E` | 4 | — | `00 44` 09FA78 04 459F9DF6 C59F9DF6 41CC4F4F | Read PV Transducer Info | StandardCore (C++) | 4 exatos |
| 15 `0F` | 6 | — | `00 44` 01 00 04 44D34000 433E0000 00000000 00 3E | Read Device Info, layout HART 5 (17 B) | StandardCore (DSL) | 6 exatos |
| 16 `10` | 1 | — | `00 44` 00 D0 E6 | Read Final Assembly Number | StandardCore | exato |
| 17 `11` | 1 | 24 B “TRANSMISSOR DE NIVEL” | `00 44` eco | Write Message | StandardCore | exato |
| 18 `12` | 1 | “LT100”/“MEDIDOR DE NIVEL”/08-03-81 | `00 44` eco | Write Tag/Descriptor/Date | StandardCore | exato |
| 20 `14` | 4 | — | **`40 44`** (sem dados) | Read Long Tag → **RC 64 não implementado** (HART 5) | fora do `hartCommandSet` da instância → RC 64 genérico | 3 exatos + 1 (preâmbulos perdidos na captura) |
| 33 `21` | 23 | `04 05 00` / `05` / `00` / `14` | `00 44` 04 31 432C7259 · 05 20 41E09FBE · 00 27 40733333 | Read Device Variables: 4 = PV em mm, 5 = temperatura °C, 0 = corrente mA, 20 = ? | StandardCore + variáveis do perfil | 20 exatos + 3 semânticos |
| 40 `28` | 8 | 4,0 / 0,0 / 8 / 12 / 16 / 20 / 0 | `00 4C` eco (fixo) · `00 44` ao sair | Enter/Exit Fixed Current (Loop Test) | StandardCore | 7 exatos + 1 (captura truncada) |
| 43 `2B` | 5 | `00` (byte excedente) | `00 44` | Set PV Zero | StandardCore | 5 exatos |
| 128 `80` | 8 | — | `00 44` 0C 03 0A 01 02 FB×4 01 02 01 01 04 459F072E 00000000 FA 00 | Sensor/flange/selo + últimos pontos de calibração | DSL do subcircuito (`hartCommandsJson`) | 8 exatos |
| 133 `85` | 9 | índice 00…1C | `00 44` idx 06 + 4 floats | Tabela X1..X16,Y1..Y16 paginada | DSL do subcircuito | 9 exatos |
| 136 `88` | 1 | — | **`70 44`** 17 00 00 | Modo de operação PID (aviso 112) | DSL do subcircuito | exato |
| 138 `8A` | 5 | — | `00 44` FF | Controller mode Off | DSL do subcircuito | 5 exatos |
| 140 `8C` | 2 | — | **`70 44`** 39 PV% 39 SP 39 MV FF 00 39 Erro | Loop PID: PV −12,67 %, SP 50, MV −1,25, erro 0 | DSL do subcircuito (PV%/MV calculados) | 2 exatos |
| 142 `8E` | 1 | — | **`70 44`** Kp 1,0 Tr 0,01 Td 0 0 0,1 | Sintonia PID | DSL do subcircuito | exato |
| 156 `9C` | 1 | — | **`71 44`** 00 6,0 | bloco 156 (significado ND) | DSL do subcircuito | exato |
| 160 `A0` | 6 | índice 0…4 | `00 44` idx 0F 05 medido desejado | Ponto de caracterização | DSL do subcircuito | 6 exatos |
| 164 `A4` | 5 | — | `00 44` 03 05 02 02 | Display (1ª var., 2ª var., medidor, ?) | DSL do subcircuito | 5 exatos |
| 166 `A6` | 1 | — | `00 44` 3D 07 00 00 13 00 00 08 00 01 00 00 03 08 | Contadores de operação | DSL do subcircuito | exato |
| 173 `AD` | 4 | — | `00 44` “LD301M21ITD10011-I6P0 ” | Ordering code | DSL do subcircuito | 4 exatos |
| 176 `B0` | 1 | — | `00 44` 31 “mm” 00 00 00 | Unidade do usuário (código + texto) | DSL do subcircuito | exato |
| 178 `B2` | 1 | — | `00 44` 00 800,0 243,0 | Faixa da unidade do usuário | DSL do subcircuito | exato |
| 185 `B9` | 12 | — | **`76 44`** FF FB 0,0 | Totalização: modo Off, unidade, total | DSL do subcircuito | 12 exatos |
| 186 `BA` | 1 | — | **`76 44`** 100,0 1,0 | Vazão máxima, fator | DSL do subcircuito | exato |
| 189 `BD` | 2 | — | **`76 44`** FB 00 00000000 | Totalização (unidade/…) | DSL do subcircuito | 2 exatos |
| 204 `CC` | 1 | `01 10` | `00 44` 01 10 00 | função ND (eco + byte) | DSL do subcircuito | exato |

Capturas posteriores à sessão original acrescentaram as escritas proprietárias
**129** (flange/selo), **134** (ponto da tabela), **135** (quantidade de pontos),
**163** (modos On/Off da caracterização) e **165** (Display). Elas têm fixtures e testes próprios nos grupos X, Y e Z;
as contagens da tabela acima e o replay de 135 trocas continuam referentes à
sessão original.

RC `0x70/0x71/0x76` = 112/113/118, faixa “multi-definition warning” (HCF_SPEC-307
§6.50): os dados são devolvidos e o significado é do fabricante. No log são
constantes; o simulador os emite como constantes do comando (condição real ND).

Não houve comandos *Factory/Private* (122–126) no tráfego; todos os 17 comandos
proprietários são *Device-Specific* (128–253) → **ManufacturerDsl**: programas da DSL
HART gravados no `hartCommandsJson` da instância (outro dispositivo que receba o
comando 128 responde RC 64; teste E17).

### Floats observados (IEEE-754 big-endian, HART)

| Bytes | Valor | Uso |
|---|---|---|
| `40 80 00 00` / `41 00 00 00` / `41 40 00 00` / `41 80 00 00` / `41 A0 00 00` | 4 / 8 / 12 / 16 / 20 | Cmd 40 (loop test) → lidos de volta no Cmd 33 código 0 |
| `00 00 00 00` | 0 | Cmd 40: sai do modo de corrente fixa |
| `40 73 33 33` | 3,8 | corrente saturada |
| `C1 4A AA AA` | −12,666666 | % da faixa — só reproduzível com `(PV−LRV)/span` **e depois** ×100 em float32 (a ordem 100·(PV−LRV)/span dá `…AB`) |
| `BF A0 00 00` | −1,25 | MV = saída saturada em % (saturação feita no domínio de %) |
| `43 2C 72 59` | 172,44667 | PV em unidade do usuário |

---

## 3. Valores iniciais — referência × simulador

“Antes” = estado encontrado nesta auditoria (HEAD + tentativa anterior não commitada).
O log **não** mostra defaults de fábrica: os valores abaixo são do exemplar
configurado; onde o default de fábrica não pode ser inferido, consta ND.

| Variável | Antes (HEAD) | Referência | Default de fábrica | Simulador agora |
|---|---|---|---|---|
| PV | 0 kPa | 0,0 mmH2O | ND | 0,0 mmH2O |
| Unidade | kPa (12) | mmH2O@20°C (4) | ND | 4 |
| LRV / URV | 0 / 25 | 190 / 1690 | ND | 190 / 1690 |
| USL / LSL / span mín. | ausentes | ±5107,7451 / 25,5387 | limites do sensor (fixos) | iguais |
| Damping | 0 | 0 | ND | 0 |
| Corrente | 4 + 16·% sem saturação | 3,80 mA | — | 3,80 mA |
| % da faixa | `C14AAAAB` | `C14AAAAA` | — | `C14AAAAA` |
| SV (temperatura) | ausente | 28,078 °C | — | 28,078 °C (entrada) |
| TV / QV | — | não usados (Cmd 3 não capturado) | — | não modelados |
| Tag / descriptor / message / data | LD301 / vazio / vazio / 0 | LT100 / MEDIDOR DE NIVEL / TRANSMISSOR DE NIVEL / 08-03-1981 | ND | iguais |
| Device ID / ordering code | 029EB1 / ausente | 05F04D / LD301M21… | Id | iguais |
| Polling address / loop mode | 0 / habilitado | 0 | 0 | 0 / habilitado |
| Alarme / write protect | 251 / 251 | Low (1) / Não (0) | ND | 1 / 0 |
| Status | sem status | `0x64` 1ª resposta, depois `0x44` | — | idem (calculado) |
| Display | ausente | PV(%) / Temp. / Installed | ND | estado (Cmd 164) |
| PID | ausente | Off; SP 50; Kp 1; Tr 0,01; Td 0 | ND | estado (Cmds 136–142) |
| Totalização | ausente | Off; 0; 100; 1 | ND | estado (Cmds 185–189) |
| Tabela | ausente | 6 pontos | ND | estado (Cmd 133) |
| Caracterização | ausente | Off, 5 pontos; On/Off capturados | 163 para On/Off | estado (Cmd 160) |
| Últimos pontos de calibração | ausentes | 0 / 5088,8975 | Cal | estado (Cmd 128) |
| Loop test / trim de saída | off / 0 | off antes do teste | — | off; trims 0 |
| Contadores | ausentes | 61, 7, 0, 0, 19, … | — | estado (Cmd 166) |

---

## 4. Problemas encontrados

**Núcleo genérico (afetavam qualquer dispositivo HART):**

1. O transporte só entendia o quadro virtual `02 …`: sem preâmbulos, endereço longo, **response code** ou **device status**; um PACTware real não era atendido.
2. `HartEngine::execute` devolvia apenas `bool`: nenhum response code; comandos não suportados eram silêncio em vez de **RC 64**.
3. Cmd 12/17 com 18 bytes (24 car.); HCF_SPEC-127 §6.12 define **24 bytes (32 car.)** em todas as revisões.
4. Cmd 15 sempre no layout HART 7 (18 B); HART 5 termina no *private label distributor* (17 B).
5. Cmd 15 e Cmd 34 liam/escreviam o damping na variável de código 0 (alias de PV); no LD301 o código 0 é a corrente.
6. Cmd 14 sempre “não aplicável”, mesmo com transdutor configurado.
7. Write protect: qualquer código ≠ 251 era tratado como protegido; o código 0 (“Não”) bloqueava escritas. Escritas DSL (17/18/19/34/6) ignoravam a proteção.
8. Sem saturação da saída analógica; ordem de cálculo do % divergia bit a bit do instrumento.
9. Escritas DSL não marcavam *configuration changed*; não havia bits por mestre (exigidos pelo HCF_SPEC-99) nem *cold start*.
10. Cmd 43 rejeitava o byte excedente que o LD301 real aceita.
11. Programas de fabricante eram globais por número de comando (o 128 de um fabricante responderia por outro).
12. A ponte COM da extensão só recortava quadros `02 …`: quadros reais do PACTware eram descartados.
13. Propriedades `sensorLowVolts/HighVolts` estavam no schema sem getter/setter (sem efeito, não salvas).

**Perfil LD301:**

14. Identidade, unidade, faixa, limites, mensagem, tag etc. não correspondiam ao exemplar (ver §3).
15. Os 17 comandos proprietários não existiam (responderiam RC 64 e o DTM não preencheria as telas).
16. Comandos HART 6/7 (20, 21, 22, 9, …) eram aceitos; o LD301 (HART 5) responde RC 64.
17. Na paleta, `pinCount: 0`: o LD301 inserido no esquemático **não tinha terminais** (os 4 pinos do Core ficavam inacessíveis); o sinal dos terminais era limitado a LRV..URV e reescalonado ao mudar a faixa via HART; a corrente de loop ignorava loop test/saturação.

**Tentativa anterior (não commitada) encontrada nesta auditoria:** resolvia parte de 1–3/14 com `if (profile.id == "lasecsimul.hart.smar-ld301")` espalhados no hook genérico, no transporte e no componente; status fixo `0x44` (comentado erroneamente como “more status”, é *config changed* + *saturated*); tratava 172,4467 como PV (é o PV em **mm de unidade do usuário**; o PV é 0 mmH2O) e a fig23 como “vazia” (é o Loop Test). Tudo isso foi substituído.

---

## 5. Arquitetura e correções feitas

### 5.1 Arquitetura final

```
C++ (Core)                                   Dados (editáveis)
──────────────────────────────────────────   ─────────────────────────────────────────────
protocol.hart.device.standard  ◄──────────── subcircuits/hart_smar_ld301.lssubcircuit
  Dispositivo HART padrão: motor HART,          1 instância do dispositivo padrão ("ld301")
  quadros físicos, RC, status, saída            + propriedades do exemplar LD301:
  analógica, terminais S+/S-/LOOP+/LOOP-,         identidade, revisão, conjunto de comandos,
  DSL HART, traços de perfil por instância        saturação, variáveis (116), 33 comandos DSL
                                                 + entradas HIGH/LOW por sinal, subtração e dois túneis
                                                   elétricos → LOOP+ LOOP-
                                                 + propriedades exportadas para a instância
```

Não existe código específico do LD301 no Core. O antigo tipo built‑in
`protocol.hart.device.smar_ld301` continua registrado (genérico, como no HEAD)
apenas para abrir projetos antigos; na paleta ele está oculto. O TT301 e o
FY301 ficam como estavam, para serem refeitos sobre o dispositivo padrão.

No símbolo atual do LD301, `HIGH` e `LOW` recebem valores independentes em
`mmH2O@20C` pelo grafo de sinais. A pressão aplicada ao dispositivo é HIGH
menos LOW; dois sliders de `Gráfico → Controles/Indicadores` podem dirigir as
entradas pelos terminais `OUT`. Os bornes `LOOP+` e `LOOP-` continuam no
circuito elétrico. A faixa inicial capturada é 190–1690 mmH2O para 4–20 mA.
Ao abrir um projeto antigo, a ligação do terminal `pressure` é migrada para
`HIGH`; `LOW` permanece em zero até receber outra fonte de sinal.

### 5.2 Funcionalidades — onde cada uma vive agora

Tudo o que foi desenvolvido durante a auditoria do LD301 e é comportamento
HART genérico está no **dispositivo padrão / núcleo** (vale para qualquer
transmissor construído sobre ele); só os **dados** do exemplar estão no subcircuito.

| Funcionalidade (antes ausente ou errada) | Onde está | Teste |
|---|---|---|
| Quadro físico HART (preâmbulos, endereço curto/longo, byte count, XOR, ACK) | `HartTransport` + `HartEngine::executeAddressed` | A1–A3, M4–M6, O |
| Response codes (64 não implementado, 2, 3, 4, 5, 7, 11, 16; avisos 112–127 com dados; silêncio) | `HartResponseBuilder`, engine, hook, DSL | J4–J6, M1–M3, N1–N9, T4, T8 |
| Device status calculado: config. changed e cold start **por mestre**, loop fixo, saturado, PV/não‑PV fora de limite | `HartEngine::fieldDeviceStatus` | B1–B3, D3–D5, I4–I7, J1/J3/J7, L1–L2, T1, T5 |
| Saída analógica única (%, mA, saturação no domínio de %, trims, multidrop) com a mesma ordem de cálculo do instrumento | `hartEvaluateAnalogOutput` | B9, F1–F7, I1–I5, E5 |
| Loop test (Cmd 40) com limites e status | hook (Cmd 40) | J1–J7, T5 |
| Cmd 12/17 com 24 bytes (32 car.) | DSL built‑in | A5, C3, T3 |
| Cmd 15 com layout pela revisão implementada (HART 5: 17 B; HART 7: 18 B) e damping do PV | DSL built‑in + traço `hartImplementedRevision` | B5, T2 |
| Cmd 14 com o transdutor real | hook | A8, B6 |
| Cmd 34 e Cmd 15 no PV (código 246), não na variável 0 | DSL built‑in | D1, L4 |
| Cmd 38 por mestre | hook | D3–D4 |
| Cmd 43 aceita bytes excedentes; zero é mudança de configuração | hook | K1–K5 |
| Write protect: código 1 protege; RC 7 também para escritas DSL | hook/engine | N7–N9, T8 |
| Escritas DSL marcam configuração alterada | hook | D5 |
| Variáveis derivadas (corrente de loop; % reescalonado, ex. unidade do usuário) | `VariableConfiguration::derivedSource` | B7, F3 |
| Variáveis texto (`Ascii`) e escrita de variáveis pela DSL; RC 2 por índice; RC 5 por dados curtos | DSL (`HartCommandProgram`, `HartCommandJson`) | E1–E16, N1–N4 |
| Traços de perfil por instância: fabricante, tipo, revisões, flags, preâmbulos, revisão implementada, conjunto de comandos, saturação | `HartCommunicationComponent` (propriedades “HART Perfil”) | A2, A9, S7, M1 |
| Terminais: sinal S+/S‑ (escala física fixa, sem limitação, só quando ligados) e laço LOOP+/LOOP‑ (fonte a 2 fios dirigida pela saída HART) | `HartCommunicationComponent::stamp` | Q1–Q11, T6–T7 |
| Persistência de write protect, config. changed (não volátil), escala do sinal | componente | L1–L6 |
| Ponte COM da extensão aceita quadros físicos | `extension/src/hart/hartFraming.ts` | testes TS (5) |
| Portas HART (serial/terminal/UDP) alcançam o dispositivo **dentro** de um subcircuito HART | `extension/src/hart/hartTarget.ts` | teste TS |
| Editor de comandos/variáveis do Property Inspector sem perda de dados (passos avançados, write/after, metadados) | `hartInspectorSections.ts`, `PropertyInspectorViewProvider.ts` | testes TS (2) |

Substituído (não perdido): os programas de fabricante “escopados por perfil”
em C++ deram lugar aos programas DSL **por instância** (`hartCommandsJson`),
que já isolam um dispositivo do outro (teste E17).

### 5.3 Arquivo por arquivo

| Arquivo | Mudança |
|---|---|
| `core/src/protocols/HartEngine.hpp/.cpp` | RC no `HartResponseBuilder`; `executeAddressed`; `fieldDeviceStatus`; `hartEvaluateAnalogOutput`; bits por mestre; `registerOrReplace`; campos de perfil (saturação %, revisão implementada); `derivedSource`, `textValue`, tipo `Ascii`. |
| `HartCommandProgram.hpp/.cpp` | Message 24 B; `SET` em variável; `ResponseCode`; `OutputPercent`; campos de faixa; `UserVariableTable`; RC 2/5 automáticos; uso da função analógica única. |
| `HartCommandJson.cpp` | Vocabulário JSON para tudo acima (é o formato dos comandos do LD301 no subcircuito). |
| `HartReferenceCatalog.cpp/.hpp` | Correções de Cmd 14/15/34/38/40/43, write protect com RC 7, variáveis derivadas, perfil `lasecsimul.hart.standard-field-device`; nenhum código do LD301. |
| `HartTransport.cpp/.hpp` | Codec físico genérico. |
| `HartCommunicationComponent.cpp/.hpp` | Preset do dispositivo padrão; traços de perfil por instância; defaults de preset como dados; terminais; persistência; leitores de variáveis novas. |
| `core/src/app/CoreApplication.cpp` | Registra `protocol.hart.device.standard`. |
| `subcircuits/hart_smar_ld301.lssubcircuit` (**novo**), `subcircuits/library.json` | O LD301. |
| `project/schema/component-catalog.json`, `extension/src/ui/webview/catalog.ts` | Entrada do dispositivo padrão (4 terminais); LD301 built‑in oculto. |
| `extension/src/hart/*` (**novos**), `serialport/manager.ts`, `hart/udpManager.ts`, `uart/CoreUartTransport.ts`, `ui/webview/main.ts`, `catalog/registeredSources.ts`, `model.ts`, `extension.ts`, `projectCommands.ts`, `UnifiedCatalog.ts` | Quadros físicos na COM; alvo HART dentro de subcircuito; `hidden` no catálogo de fallback. |
| `ui/views/hartInspectorSections.ts`, `PropertyInspectorViewProvider.ts` | Editor sem perda de dados. |
| `core/CMakeLists.txt`, `core/test/core/protocols/HartLd301Test.cpp` (**novo**), fixture do log, `core/tools/hart_ld301_serial_bridge.cpp` (**novo**) | Testes e ponte serial. |
| `scripts/ld301_decode.py`, `test_ld301_decode.py`, `ld301_serial_check.py` | Decodificação do log; verificação pela porta serial. |
| `core/test/core/protocols/HartEngineTest.cpp`, testes TS de paleta | Expectativas corrigidas onde estavam erradas pela especificação (Message 24 B) ou pela nova paleta. |

## 5.4 Indicador local (LCD) — manual do LD301, seção 2

Antes desta etapa o dispositivo HART **não tinha display**. Agora o dispositivo
HART padrão tem o indicador do manual (Fig. 2.4), e o LD301 o mostra no símbolo
do subcircuito (componente interno exposto).

| Requisito do manual | Implementação | Teste |
|---|---|---|
| Campo numérico de 4 ½ dígitos (sinal, meio dígito "1", 4 dígitos de 7 segmentos, pontos decimais) | `HartLcd::hartLcdFormatNumber`: maior nº de decimais com contagem ≤ 19999; acima disso, traços | V1–V5 |
| Campo alfanumérico de 5 caracteres (14 segmentos) — ex. `mmH2O` (Fig. 2.5) | `hartLcdUnitLabel` (Common Table 2); `segmentLcd.ts` | V6, TS |
| Campo de informações: PID, Fix, F(t), F(x), MD, √ (x, x³, x⁵), A/M, %, min, °, ⇕, SP, PV | 16 anunciadores (`HartLcdAnnunciator`), mesmas posições da Fig. 2.4 | V7, V10, V12, V15–V16, TS |
| Uma ou duas variáveis; com duas, alterna a cada 3 s | `displayVariable1/2`; no LD301 vêm do próprio estado do Cmd 164 (3 = PV(%), 5 = Temp.) | V10, V12, V13 |
| Ao ligar: protocolo e endereço / "LD301" e versão | 3 s: `5 00` + `LD301`, depois `V7.02` (software 0x72) | V8, V9, real Core |
| Saída saturada (3,8/20,5 mA): `SAT` / unidade | alternância a cada 1,5 s | V11, V14 |
| Falha (`FAIL`) | bit Device Malfunction | — |
| Indicador não instalado | `displayInstalled` | V17 |

Telemetria do dispositivo: `f64` corrente de laço (mA — também a leitura
numérica do componente) + marcador `LCD1` + quadro de 24 bytes (`HartLcd.hpp`).

Com o manual (§5.5) os códigos do Cmd 164 ficaram 0 OUT, 1 MV%, 2 PRES,
3 PV%, 4 PV (unidade do usuário), 5 TEMP, e a falha de sensor mostra `SFAIL`.

**Não determinado / não modelado:** códigos 6–9 (SP%, SP, ER%, TOT) e "None",
por não haver controlador PID nem totalizador ativos no simulador;
totalização (F(t) e divisão do total entre os campos), PID (PID, A/M, SP),
ajuste local (⇕) e `CHAR`; o texto exato da página de PV(%) e as abreviações
de unidade além de `mmH2O` não aparecem no material.

---

## 5.5 O que o manual do LD301 (`ld301mp.pdf`) resolveu

O manual de instruções (seções 2, 3, 5 e características técnicas) foi lido
inteiro em texto. Ele **não** traz o layout dos comandos HART proprietários
(isso fica num documento de comandos da Smar que não está no material), mas
resolveu as pendências abaixo. Tudo o que é genérico foi feito no
**dispositivo HART padrão** (traços por instância); o LD301 só recebeu dados.

| Pendência | Evidência no manual | Implementação | Teste |
|---|---|---|---|
| Saturação superior 20,5 mA não observada | "3,8 mA quando ocorrer saturação baixa; 20,5 mA quando ocorrer saturação alta" (Fonte de Alimentação; Tabela 5.1) | já era −1,25 / 103,125 %; agora **confirmado** | I, J |
| Faixa do loop test | "corrente fixa ... de 3,6 a 21 mA"; Loop Test "entre 3,6 e 21 mA" | traços `analogFixedLowMilliamps`/`HighMilliamps` (Cmd 40); LD301 = 3,6 / 21 | W16, W17, J4, J5 |
| Corrente de alarme (fail‑safe) | "indicação de falha em 3,6 mA quando configurado para falha baixa; 21 mA ... alta" (Alarm Selection) | traços `analogAlarmLow/HighMilliamps` + propriedade **`sensorFault`** ("Simular falha do sensor"): Device Malfunction (0x80), saída em burnout conforme Alarm Selection (0 High, 1 Low), saturada; loop test e multidrop têm precedência | W18, W20–W22 |
| Display em falha de sensor | Tabela 2.1: "SFAIL / Unidade" | LCD alterna unidade e `SFAIL` | W19 |
| Damping sem filtro | "filtro digital de primeira ordem ... de zero a 128 segundos" | filtro de 1ª ordem no PV do dispositivo padrão (`postStep`), constante = damping do PV (Cmd 34); damping 0 = sem atraso (o replay não muda) | W23–W25 |
| Contadores de operação não incrementam | "toda vez que ocorrer uma alteração ... incrementa o respectivo contador ... cíclico, de 0 a 255" + lista na ordem dos 14 bytes do Cmd 166 | traço `hartOperationCounters` (`comando=variável`); só incrementa quando o comando muda a configuração. LD301: 35/36/37 → LRV/URV, 43 → Trim Zero, 45 → Trim 4 mA, 46 → Trim 20 mA, 6 → Multidrop | W1–W5 |
| Nomes dos bytes 6, 8, 10, 11, 12 do Cmd 166 | ordem da lista do manual (bate com todos os valores ≠ 0 da fig21: PID 8, Auto Clamp 1, Totalização 8) | renomeados: 6 Trim Temperatura, 8 Caracterização, 10 Proteção de escrita, 11 Multidrop, **12 Senha/Nível (= 3)** | E10 |
| Valor inicial do contador Trim Zero | o log tem **5 × Cmd 43** antes da leitura do Cmd 166 (= 19) | estado inicial do subcircuito = 14 (19 − 5); o replay chega a 19 pelo incremento — confirma o mecanismo | E10, O |
| Códigos de variável do display (Cmd 164) | Tabela 3.5 / lista: OUT, MV(%), PRES, PV(%), PV, TEMP, SP(%), SP, ER(%), TOT, None; escritas reais em 2026-10-05: 1ª variável PV% (3) → OUT (mA) (0) → OUT (%) (1) → Pressure (2) → PV (4) → Total (9), com 2ª variável None (251) | `displayCodeMap` = `0=current,1=output,2=pv,3=percent,4=dv:4,5=dv:5`. PRES/Pressure = PV HART em mmH2O; PV = unidade do usuário. Códigos 0–5, 9 e 251 medidos; 6–8 seguem como **inferência** da sequência do manual/DTM. None só existe na 2ª lista. Com None, Cmd 164 devolve `09 FB 00 00`, embora o DTM ainda mostre “Installed”: o byte 2 não é simplesmente presença do medidor | W26, V, X5, X8–X11 |
| Cmd 156 (byte + float 6,0) | raiz quadrada: "valor default de corte é de 6%", modos Suave/Abrupto | `sqrtCutoff.point` (6 %) e `sqrtCutoff.mode`: Hard `00`, Bumpless `FF`, medidos nas escritas Cmd 191 | E7, AA10–AA11 |
| Limites de faixa (Cmds 35–37) | "valores que excedam até 25% destes limites são aceitos"; "valores até 0,90 do span mínimo são aceitos"; Tabela 5.1 (Valor inferior/superior muito alto/baixo, span muito baixo, pressão aplicada muito alta/baixa); no ajuste de zero "o URV será limitado ao valor URL" | traços `rangeLimitTolerancePercent` (LD301 25) e `minimumSpanAcceptPercent` (LD301 90) + códigos da HCF_SPEC-151 7.3–7.5: 9/10/11/12/13, 14 (aviso de span pequeno; URV empurrado no Cmd 37), 18 (unidade), 29 (span inválido) | F8, F9, W6–W15 |

Correções genéricas encontradas no caminho (dispositivo padrão):

- **Configuration Changed** não era sinalizado pelos Cmds 35/36/37, 44, 45,
  46 e 47 (só o 43 fazia): agora toda escrita desses comandos acende o bit
  por mestre e incrementa o contador de configuração (HCF_SPEC-99).
- **Cmd 6 de mestre HART 5** (1 byte) respondia RC 5. HCF_SPEC-127 §6.7.1:
  aceitar 1 byte, corrente do laço habilitada no endereço 0 e desabilitada
  nos demais. Um dispositivo que implementa a revisão 5 (o LD301) responde só
  o byte de endereço — layout do HART 5, não verificado em captura (o log não
  tem Cmd 6).

Evidências do manual que **não** viraram código: span mínimo da faixa D2 na
tabela de códigos de pedido (0,42 kPa) difere do valor do aparelho capturado
(25,5387 mmH2O = 0,25 kPa) — vale o capturado; burst mode, bloqueio de
equipamento e remapeamento de SV/TV/QV são do firmware HART 7 (o exemplar é
HART 5); reset/acúmulo do totalizador, PID, ajuste local e os pontos da
caracterização continuam sem comandos de escrita ou dinâmica confirmados.

---

## 6. Testes adicionados

`hart_ld301_test` — **238 verificações**, todas por quadros físicos, com o
LD301 instanciado **a partir do arquivo `.lssubcircuit`**:

| Grupo | Finalidade |
|---|---|
| S Subcircuito | é `subcircuits.hart.smar_ld301`; contém um `protocol.hart.device.standard`; 4 pinos elétricos ligados por túneis aos terminais; propriedades exportadas; 33 comandos DSL 128–253; editar a instância muda o transmissor |
| T Dispositivo padrão sozinho | identidade genérica, Cmd 15 HART 7, Cmd 12 24 B, RC 64 para comando de fabricante não autorado, loop test, terminais (2,5 V → 12 mA), RC 7 em escrita DSL protegida |
| A–O, Q | como na seção 1–4: identificação, estado inicial, universais, common practice, comandos LD301, faixa, unidades, floats, corrente, loop test, calibração, persistência, comandos e parâmetros inválidos, replay do log, terminais |
| X, Y, Z, AA Escritas reais | flange, Display, tabela, caracterização, Function, User Unit e Totalization, com replay de quadros físicos e persistência |
| V Display | LCD do manual, seção 2 |
| W Manual | regras do `ld301mp.pdf` (§5.5): contadores, limites de faixa e códigos 9–29, loop test 3,6–21 mA, burnout, SFAIL, damping, códigos do display, Cmd 6 HART 5 |

Extensão (`npm test`): `hart/hartFraming.test.ts` (5), novos casos em
`hartInspectorSections.test.ts` (2) e `hartSmarDevices.test.ts` (2), paleta
atualizada. Python: `scripts/test_ld301_decode.py` (4).

---

## 7. Replay do log

**Replay result: 135 commands tested · 130 exact matches · 5 semantically equivalent · 0 mismatches**
(LD301 = subcircuito sobre o dispositivo padrão).

| # | Cmd | Classe | Motivo |
|---|---|---|---|
| 41 | 20 | semântico | a captura perdeu 3 preâmbulos; quadro idêntico (`86 … 14 02 40 44 93`) |
| 97 | 33{5} | semântico | temperatura viva: 28,0814 × 28,078 simulado; código, unidade, RC e status iguais |
| 112 | 33{0} | semântico | ruído de linha: endereço `BC` × `BE` (1 bit), XOR inválido na captura; demais bytes e o checksum idênticos |
| 117 | 33{0} | semântico | idem, durante o loop test |
| 134 | 40 | semântico | log terminou no meio da resposta (`FD` no preâmbulo); os 14 bytes capturados coincidem |

Pela porta serial real (com0com, 1200 8O1, `hart_ld301_serial_bridge CNCB2` +
`ld301_serial_check.py COM22`): **131 quadros idênticos à captura**; os 4
diferentes são os itens 97/112/117/134 acima. Desde 2026-10-03 a ponte não fala
mais direto com o LD301: o PC está na COM de um **Modem HART em série no laço**
e cada pedido/resposta atravessa o fio como FSK (ver
[hart-fio-e-modem.md](hart-fio-e-modem.md)) -- resultado idêntico, 131/135.

---

## 8. Compatibilidade PACTware

PACTware 5.0 e o DTM do LD301 estão instalados e há pares com0com
(COM20–23 ↔ CNCB0–3). A sessão disponível é a **sessão RDP ativa do usuário**:
automatizar o PACTware tomaria mouse/teclado da área de trabalho em uso, então
**nenhuma tela foi aberta**. O tráfego que cada tela gerou no ensaio é
respondido corretamente (§7), inclusive pela porta serial do Windows.

Para validar visualmente: `core/build/Release/hart_ld301_serial_bridge.exe CNCB3`
e o PACTware em COM23 (mesmo arranjo do ensaio). No LasecSimul: fonte de 24 V,
subcircuito SMAR LD301 e **Modem HART em série no laço** com a *Porta serial do
PC* = CNCB3 (botão Abrir no modem).

| Fig | Tela | Abre? | Campos carregados? | Leitura correta? | Escrita correta? |
|---|---|---|---|---|---|
| 01–23 | todas | NV | NV | NV (tráfego capturado: sim) | NV |

NV = não verificado na interface do simulador. Capturas de escrita do aparelho
real já identificaram Flange, Display, Tabela, os modos On/Off da Caracterização,
Function Sqrt, User Unit Off e configurações de Totalization. PID,
trims Lower/Upper/Temperature, pontos da Caracterização, reset/acúmulo do total
e Factory ainda têm comportamento de escrita/dinâmica desconhecido.

---

## 9. Testes gerais

| Suíte | Resultado |
|---|---|
| Core `ctest` (Debug, `-j 4`, `ucrt64/bin` no PATH) | **110 testes: 105 passaram, 5 pulados (os mesmos do baseline), 0 falhas**; execução concluída em 2026-10-05 13:55 |
| `hart_ld301` | 249/249 verificações (inclui novas capturas X, Y, Z e AA); replay original 130 exatos / 5 semânticos / 0 divergentes |
| `hart_wire_loop` (Release) | 26/26; inclui Cmd 47 pelo modem HART e mudança de 8 para 12 mA medida no resistor de 250 Ω |
| `hart_engine` (suíte HART existente) | PASS |
| Extensão `npm test` | 689 casos, 0 falhas (inclui `segmentLcd.test.ts`) |
| Real Core (`out/hart/hartLd301Subcircuit.realCore.test.js`) | 4/4 — subcircuito carregado pelo Core real; respostas byte a byte; LCD na telemetria |
| Serial real (com0com 1200 8O1) | 131/135 quadros idênticos; 4 = defeitos da captura |
| Python `test_ld301_decode.py` | 4/4 |

Observação: numa primeira execução com `-j 6` e sem `ucrt64/bin` no PATH, 14 testes
QEMU/PLC falharam (`0xC0000139`, compilador externo); com o PATH correto e
execução serial todos passam — são do ambiente, não regressões.

---

## 10. Pendências reais

1. Escritas proprietárias capturadas em 2026-10-05:
   - **Display, Cmd 165**: as fixtures `ld301_cmd165_display_first.txt`, `_output_percent.txt`, `_pressure.txt`, `_pv.txt` e `_none.txt` reproduzem as mudanças da tela. A nova captura escreve `09 FB` (1ª variável Total, 2ª None) duas vezes; o Cmd 164 devolve `09 FB 00 00`, embora o DTM ainda mostre “Meter indication: Installed”. Portanto, os bytes 2/3 não representam simplesmente a presença física do indicador; os IDs das variáveis foram preservados. Códigos 0–5, 9 e 251 medidos; 6 SP(%), 7 SP, 8 Error(%) permanecem inferidos da sequência da Tabela 3.5 do manual e das opções do DTM. None (251) aparece apenas na 2ª lista. Testes X5–X11 reproduzem os quadros byte a byte. O significado completo dos bytes 2/3 e a renderização local de SP/ER/TOT seguem sem validação.
   - **Tabela, Cmds 135/134**: `ld301_table_y2.txt` contém 52 trocas. O DTM escreve `06` no Cmd 135 (quantidade de pontos) e usa o Cmd 134 para escrever os 32 valores da tabela em sequência, com índice 0–31 e float de 4 bytes. Y2 é o índice `0x11`: `42 C8 00 00` (100,00) → `42 C6 00 00` (99,00). Cmd 133 lê de volta 99,00. No teste Y1–Y4, 51 quadros são exatos; um quadro de leitura do Cmd 133 tem endereço `BC` no lugar de `BE` e XOR inválido na captura, seguido de repetição exata. Escrita, rejeição de índice inválido/truncamento e persistência passaram. A captura `ld301_table_points5.txt` contém outras 42 trocas: Cmd 135 escreve `05`, o DTM reenvia os 32 pontos pelo Cmd 134 (inclusive X6/Y6 zerados), e nove leituras do Cmd 133 confirmam a quantidade 5 com Y2 ainda em 99,00. No teste Y5–Y7, os 42 quadros são exatos e o estado persiste após salvar/reabrir.
   - **Sensor Characterization, Cmd 163**: `ld301_characterization_on.txt` reúne 8 trocas da seleção Off → On. A escrita `A3 02 00 55` recebe eco `00 55`; cinco leituras do Cmd 160 mostram o byte de modo `00` em vez do `0F` observado antes (5 pontos e pares medido/desejado inalterados). O Cmd 1 da mesma sessão lê 148023,625 mmH₂O, acima do limite do sensor. Todos os oito quadros têm status `55`; o bit `0x10` (*More Status Available*) não teve sua causa estabelecida e **não** foi atribuído ao modo On. O teste Z1 compara os oito quadros após retirar somente esse bit de estado e ajustar o XOR; modela separadamente a PV fora dos limites (`0x01`). `ld301_characterization_off.txt` registra a volta On → Off: escrita `A3 02 0F 00`, resposta com eco `0F 00` e status `75` (inclui *Cold Start*). Z2–Z6 verificam os dois modos, entradas inválidas e persistência. A edição dos pontos ainda precisa de captura.
   - **Function Sqrt e Cutoff Mode/Value**: `ld301_function_sqrt_write.txt` contém nove trocas completas. Ao escrever a tela Configuration, o DTM envia Cmd 34 (damping 0), Cmd 203 (`01`, código de alarme), Cmd 47 (`01`, Sqrt), Cmd 139 (`01`), Cmd 183 (`00`), Cmd 191 (`00`) e Cmd 157 (float 6,0, ponto de corte), depois lê Cmd 15 e 138. O perfil habilita o Cmd 47 padrão; os comandos proprietários ficam no DSL. `ld301_function_sqrt_readback.txt` foi capturado **antes** da escrita e mostra Cmd 15 em Linear (`00`) e Cmd 156 Hard (`00`), 6,0, com aviso RC 113. Na captura posterior `ld301_sqrt_bumpless_write.txt`, Cmd 191 escreve `01` e Cmd 156 passa a `FF` (Bumpless), mantendo 6,0 e respondendo RC 0. O lote seguinte escreve Cmd 157 float 5,0 (`40 A0 00 00`) e Cmd 156 lê `FF`, 5,0. Ao voltar a Function Linear, Cmd 47 escreve `00`; Cmds 191, 157 e 156 ecoam os dados com aviso RC 113. Os testes AA1–AA2 e AA10–AA13 cobrem essas transições e persistência. O significado do byte do Cmd 139 permanece desconhecido.
   - **Efeito da raiz na saída**: o manual `ld301/ld301mp.pdf`, página PDF 35 (página impressa 3.7), define saída `10√X` com `X` em % da pressão; abaixo do corte `C`, o modo suave usa ganho `10/√C` e o abrupto zera a saída. O perfil marca as variáveis de corte como parâmetros genéricos da função de transferência; `Hard=00` usa o corte abrupto e `Bumpless=FF` o suave. Cmd 2, corrente do laço, telemetria e LCD usam a mesma curva; Cmd 1 preserva a pressão medida. AA18–AA19 verificam 25 % de pressão → 50 % de saída/12 mA, ambos os modos a 1 % e a indicação no LCD. Essa curva segue o manual; ainda faltam medições físicas da corrente e do LCD no aparelho para validar a equivalência dinâmica.
   - **Display Total**: o código 9 do Cmd 164 resolve a variável `totalization.total` no LCD pelo mapa de códigos da instância. W27 verifica que a página mostra um valor configurado em vez de traços. O total continua estático até ser medida e implementada a acumulação.
   - **User Unit Off/On**: `ld301_user_unit_off.txt` contém 20 trocas. Cmd 180 escreve `01` e ecoa; Cmd 177 envia 13 bytes começando por `31 6D 6D` e responde RC `0x75` com os seis primeiros; Cmd 179 escreve os floats 800 e 243, também com RC `0x75`. Cmd 178 passa de `00` para `FF` (Off). O Cmd 33 código 4 informa unidade `39` (%) após Off, enquanto Cmd 176 ainda informa a unidade configurada `31` (mm). Uma resposta de Cmd 179 tem XOR inválido e repetição correta; uma resposta de Cmd 33 está truncada. A nova captura `ld301_user_unit_on.txt` tem 12 trocas: Cmd 180 escreve `00`, Cmds 177/179 recebem RC 0, Cmd 178 lê `00` e Cmd 33 código 4 volta à unidade `31` (mm). AA3–AA4 e AA14–AA15 verificam os dois modos e a unidade ativa, preservando a seleção de engenharia.
   - **Totalization**: `ld301_totalization_maxflow99.txt`, `ld301_totalization_factor2.txt` e `ld301_totalization_mode_on.txt` mostram o DTM reescrevendo a tela inteira: Cmd 190 envia unidade `FD` (Special), Cmd 187 muda vazão máxima para 99 (`42 C6 00 00`), Cmd 188 muda fator para 2 (`40 00 00 00`) e Cmd 183 escreve `01` para Off ou `00` para On. Cmds 185/186/189 respondem com aviso RC 118 enquanto Off e RC 0 após On. A nova captura `ld301_totalization_mode_off.txt` tem 14 trocas: enquanto On, Cmds 187/188 respondem RC 70 sem eco, e Cmd 183 escreve `01` para desligar; as leituras voltam a RC 118, mantendo 99 e 2. AA5–AA9 e AA16–AA17 verificam as configurações e os quadros estáveis; duas respostas da primeira captura estão ausentes ou truncadas. Após On, o total real cresce entre leituras; o simulador conserva o valor configurado, pois a dinâmica de acumulação ainda não foi medida o suficiente para ser modelada. O bit de estado `0x10` permanece normalizado no replay, sem atribuição à Totalization.
   - **Flange/Remote Seal, Cmd 129**: `ld301_cmd129_flange.txt` escreve os 11 primeiros bytes do bloco do Cmd 128 (tipo, material e O-ring do flange, byte 3, dreno/vent, quantidade/tipo/fluido/diafragma do selo remoto, fluido e diafragma do sensor) e responde o eco; reproduzido byte a byte (X1), RC 5 com menos de 11 bytes, RC 7 com proteção de escrita, persistente. Códigos (variáveis com tabela `codes`, mostradas por nome no inspetor):
     - **Material, O-ring, dreno/vent do flange**: HCF_SPEC-183 Tabela 4 (*Material Codes*). Confirmada por 3 Hastelloy C, 4 Monel, 10 PTFE, 2 SS316, 251 None, 252 Unknown, capturados.
     - **Tipo de flange**: ordem da tabela de strings do DTM (`PrjMainLD301DTM.ocx`), ancorada em 12 = Conventional (Biplanar) e 22 = Level; 2 in, 150 lb, capturados. Os 9 itens entre os dois fecham exatamente a sequência 13–21.
     - **Selo remoto, bytes 5–8**: 4 capturas (`ld301_cmd129_flange.txt`, `_diaphragm.txt`, `_fillfluid.txt`, `_seal.txt`), cada uma mudando um só campo.
       - **byte 5 = tipo**: 4 Pancake e 5 Flanged medidos; a lista do DTM a partir de 2 dá 2 Chemical Tee, 3 Flanged Extended, 6 Threaded, 7 Sanitary, 8 Sanitary Tank Spud, 9 Union Connection.
       - **byte 6 = fluido de enchimento**: 2 Silicone Oil, 5 Glycerin/H2O e 7 Neobee-M20 medidos; o restante segue a ordem do DTM (3 Syltherm 800, 4 Inert, 6 Prop Gly/H2O, 8 Fluorolube).
       - **byte 7 = diafragma**: Tabela 4 (3 Hastelloy C, 5 Tantalum medidos).
       - **byte 8 = quantidade**: 1 One Seal e 2 Two Seals, medidos.
     - Bloco do Cmd 128/129, bytes 0–10: tipo de flange, material, O-ring, byte 3 (ND, sempre 01), dreno/vent, tipo do selo, fluido do selo, diafragma do selo, quantidade de selos, fluido do sensor, diafragma do sensor.
     - As enumerações da HCF_SPEC-160.5 (família pressão) **não** são as usadas pelo LD301 (HART 5). O estado existe e é editável na instância (variáveis), e é lido pelos comandos capturados.
   - **Ainda pendentes**: escritas de PID, trims Lower/Upper/Temperature, pontos da Characterization, reset e dinâmica de acumulação da Totalization e Factory. A `HART.zip` contém especificações gerais; HCF_SPEC-183 Tabela 34 define códigos de variáveis dos comandos padrão (243–250), não a seleção do Display proprietário. HCF_SPEC-127 remete comandos específicos ao documento do fabricante, ausente no ZIP.
2. Significado de `cmd128.byte3/11/12/22/23`, `display.byte3`, `pid.operatingMode*`, `pid.modeCode`, `cmd189.*`, Cmd 204, variável 20 e da condição dos avisos 112/118 (o manual não traz o layout dos comandos proprietários). Os logs de 2026-10-05 às 13:03–13:18 confirmaram Hard/Bumpless no Cmd 156, corte 6→5, User Unit On, Totalization Off e Function Linear. Para Square Root, RC 113 acompanha Function Linear e RC 0 acompanha Sqrt nas sessões medidas.
3. ~~Saturação 20,5 mA e corrente de alarme~~ — resolvido pelo manual (§5.5); burnout testado por injeção de falha, não observado em aparelho real.
4. ~~Damping~~ — resolvido (§5.5). **Contadores Cmd 166**: somente os ligados aos comandos padrão estão implementados; falta medir o incremento após uma escrita de Função, Totalização ou Caracterização e depois implementar os demais (Trim Superior/Temperatura, TRM/PID, Auto Clamp, Proteção de escrita e Senha/Nível).
5. Cmd 11 genérico (byte de status antes da identidade; não silencia com tag divergente) e endereço de broadcast — fora do log.
6. Validação visual no PACTware/DTM (§8).
7. Laço elétrico: fonte de corrente ideal (sem tensão mínima/lift‑off).
8. TT301 e FY301 ainda são presets built‑in antigos (a refazer como subcircuitos do dispositivo padrão).
