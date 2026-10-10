# Auditoria do transmissor HART TT301 simulado

O TT301 é o subcircuito `subcircuits/hart_smar_tt301.lssubcircuit`, construído
sobre o **dispositivo HART padrão** em C++ (`protocol.hart.device.standard`),
exatamente como o LD301 (`docs/ld301-audit.md`). Nenhum código específico do
TT301 existe no Core: o modelo é feito só de dados (identidade, traços de
perfil, variáveis e comandos da DSL HART).

Fonte de verdade local: `trm/tt301/` (fora do repositório).

- `fig01.png`…`fig08.png`: telas do DTM no PACTware.
- `saida do trm hart TT301.txt`: captura com 104 trocas. A cópia versionada é
  `core/test/core/protocols/fixtures/tt301_capture.txt`.
- `tt301mp.pdf`: manual do TT301.
- `tt301.svg`: arte do símbolo, igual a `subcircuits/tt301.svg`.

O log tem o mesmo formato do LD301:

- **SERIAL RX**: pedido do PACTware.
- **UDP RX**: bytes do TT301 real, vindos do modem.

Legenda de evidência:

- **C**: capturado no log.
- **F**: lido na figura.
- **M**: manual `tt301mp.pdf`.
- **L**: igual ao LD301 (mesmo fabricante e mesmo layout).
- **I**: inferido, ainda sem captura (ver §7).

## 1. Identidade (HART 7)

| Campo | Valor | Evidência | Onde |
|---|---|---|---|
| Comando 0 | `FE 3E 02 05 07 08 60 10 00 01 0C 3A 05 09 00 28 00 00 3E 00 3E 01` | C | traços de perfil |
| Fabricante / tipo | Smar `0x3E` / TT301 `0x02` | C, F03 | `hartManufacturerId`, `hartDeviceType` |
| Revisões | universal 7, dispositivo 8, software `0x60` (DTM 6.00), hardware `0x10` (DTM 16) | C, F04 | `hartUniversalRevision`… |
| Device ID / endereço longo | 68666 = `01 0C 3A` / `BE 02 01 0C 3A` | C, F03 | `uniqueId` |
| Campos HART 7 do Comando 0 | 5 preâmbulos de resposta, 9 variáveis de dispositivo, contador de configuração `0x0028`, private label Smar `0x003E`, perfil 1 | C | `hartMaxDeviceVariables`, `hartConfigChangeCounter`, `hartPrivateLabel`, `hartDeviceProfile` |
| Tag / descritor / data | `TAG` / `16 CHARACTERS` / 15/04/2013 | C, F03 | `tag`, `descriptor`, `date*` |
| Mensagem | `32 CHARACTERS` | C, F03 | `message` |
| Main board serial (Cmd 16) | 0 | C, F04 | `finalAssemblyNumber` |
| Ordering code (Cmd 173) | 21 espaços (em branco no DTM) | C, F04 | variável `orderingCode` |
| Sensor (Cmd 14) | serial 0, °C, USL 850, LSL −200, span mínimo 10 (Pt100 IEC) | C, F08, M tab. 6.1 | PV |

O bit **Cold Start** continua ligado depois do Comando 0: o TT301 respondeu
`E1` ao Comando 0 e de novo `E1` ao Comando 13 seguinte (C). Traço
`hartColdStartKeptByCommand0`.

## 2. Comandos do fabricante

Todo comando do fabricante do TT301 leva no primeiro byte de dados `02` e a
resposta começa ecoando esse byte (C, 104 trocas). Sem ele, a resposta é RC 5.

| Cmd | Significado | Resposta capturada (após o `02`) | Evidência |
|---|---|---|---|
| 130 / 131 | Ler / escrever sensor: tipo, sensor, conexão (+1 byte só de leitura) | RTD / Pt 100 IEC / 2 fios = `01 02 01 01`; TC / J NBS / 2 fios = `83 02 01` | C, F06a/b |
| 136 | Modo de operação do PID (aviso 112) | `FF FF FF` (PID desligado) | C, F07, L |
| 138 | Modo do controlador | `FF` | C, F07, L |
| 139 | Escrever código de modo do controlador | eco | L, I |
| 140 | PV %, SP, MV, modo, SP tracking, erro (aviso 112) | `39` PV% `39` SP 0 `39` MV `FF FF 39` erro 0 — mesmo layout do LD301 | C, F07, L |
| 142 | Sintonia Kp / Tr / Td (aviso 112) | Kp 1, Tr 0,01, Td 0 | L, I |
| 152 | Gerador de setpoint: tempo + estado | `00000000 FF FF` (Off) | C, F07 |
| 162 / 163 | Ler / escrever burnout | `01` = High | C, F05a |
| 164 / 165 | Ler / escrever LCD (1ª e 2ª variável) | `02 02` = Temp. PV / Temp. PV | C, F05a/b |
| 168 / 169 | Ler / escrever proteção de escrita (comunicação, ajuste local) | `FF FF`; depois de gravar `01 FF` | C, F05a |
| 173 | Ordering code | 21 espaços | C, F04 |
| 186 / 187 | Escrever / ler junta fria | `FF` com RTD; `00` = Enabled | C, F06b |
| 198 | Valor lido na tela Sensor | `00000000` | C |
| 223 | Coeficientes Callendar-Van Dusen | R0 100, A 3,9083e-3, B −5,775e-7, C −4,183e-12 (Pt100 IEC 751) | C, M (Callendar Van Dusen) |

### 2.1 Display (LCD) conferido com o manual

**Códigos dos Comandos 164/165.** O manual §3.9 ("LCD Indicator") dá a lista
completa, na ordem dos códigos. Os dois códigos capturados (`02` Temp. PV e
`03` Temp.) caem exatamente nessa ordem.

A Tabela 4.3 (menu local) usa outra ordem e não serve para o HART: nela o
código 2 seria MV% e o 3 seria ER%.

| Código | Mostra | Evidência |
|---|---|---|
| 0 | OUT (mA), corrente de saída | C, M |
| 1 | OUT (%), saída em % | M |
| 2 | PV, temperatura medida (DTM: Temp. PV) | C, M |
| 3 | TEMP, temperatura ambiente da borneira em °C (DTM: Temp.) | C, M (Tabela 3.3) |
| 4 | PV (%) | M |
| 5–8 | SP (%), SP, tempo do gerador de SP (min), erro (%) — só em modo PID | M |
| 9–12 | Kp, Tr (min), Td (s), MV (%) | M |
| 251 | None, só para a 2ª variável | L |

O código 6 (SP em unidade de engenharia) ainda não aparece no display
simulado: não existe uma variável com esse valor.

**O que o manual corrigiu no display simulado:**

| Manual | Antes (vidro do LD301) | Agora |
|---|---|---|
| Fig. 2.9: o vidro tem **ACK**, PID, F(t), F(x), MD, Fix, A/M, %, min, setas, SP, PV; **sem** √, 3 e 5 | √ 3 5, sem ACK | `displayGlass = 1`: ACK no lugar da raiz |
| Fig. 2.7: monitoração mostra **25.0 °C** (uma casa decimal) | 25.00 | `displayCodeMap` `2=pv/1,3=dv:1/1`: temperaturas com 1 casa; mA e % seguem com até 3 |
| §2.8 / Fig. 2.8: alarme interrompe a monitoração; **AL_0** = burnout, sem reconhecimento automático, com **ACK** aceso | "SFAIL" piscando com a unidade | sensor em falha → `AL_0` com ACK, campo numérico apagado |
| Nenhuma mensagem "SAT" no manual | "SAT" piscando na saturação | sem "SAT" no vidro do TT301 |
| Tabela 4.2: unidade "Ohm" | "OHM" | "Ohm" |
| Inicialização mostra o endereço (manual §3, Multidrop) | protocolo + endereço, modelo e versão | igual (já estava) |

Os alarmes 1 e 2 (AL_H / AL_L) existem no TT301, mas não foram simulados:
nenhum comando deles aparece na captura.

### 2.2 O que o manual não resolve

- **Bytes do sensor (Cmds 130/131).** As Tabelas 4.4–4.7 dão a ordem do menu
  local, que não bate com os bytes capturados:
  - Pt100 IEC é o 4º item da lista de RTD, mas vem `02` no byte 2;
  - J NBS é o 3º termopar e também vem `02`.

  A lista de conexões (2 fios, 3 fios, 4 fios, diferencial) é compatível com
  `01` = 2 fios, contando a partir de 1. Isso ainda é inferência.

### 2.3 Troca de sensor: limites e faixa automáticos

Ao trocar o sensor, o TT301 carrega sozinho os dados do sensor novo. Isso foi
confirmado pelo usuário e é coerente com a captura: voltando a RTD Pt100, a
faixa ficou −200…850 °C. Três coisas mudam:

- o limite superior e o inferior do sensor (Comando 14);
- o span mínimo (Comando 14);
- a faixa, com URV = limite superior e LRV = limite inferior (Comando 15).

No simulador, a escrita do Comando 131 faz isso pela DSL, com uma linha por
sensor. Os limites vêm da Tabela 6.1 do manual.

| Bytes 1–2 do Cmd 131 | Sensor | Faixa e limites (°C) | Span mínimo | Código |
|---|---|---|---|---|
| `01 02` | RTD Pt100 IEC | −200…850 | 10 | C |
| `83 00` | TC B NBS | 100…1800 | 50 | I |
| `83 01` | TC E NBS | −100…1000 | 20 | I |
| `83 02` | TC J NBS | −150…750 | 30 | C |
| `83 03` | TC K NBS | −200…1350 | 60 | I |
| `83 04` | TC N NBS | −100…1300 | 50 | I |
| `83 05` / `83 06` | TC R / S NBS | 0…1750 | 40 | I |
| `83 07` | TC T NBS | −200…400 | 15 | I |
| `83 08` / `83 09` | TC L / U DIN | −200…900 / −200…600 | 35 / 50 | I |
| `83 0A` | TC W5Re/W26Re | 0…2200 | 60 | I |
| `83 0B` | TC L GOST | −200…800 | 60 | I |

Os códigos dos termopares seguem a ordem da Tabela 4.7. Essa ordem põe o J no
índice 2, como capturado; os demais códigos são inferidos.

O estágio de entrada do subcircuito usa esses códigos (`sensor.type`, `sensor.model` e
`sensor.coldJunction` viraram sinais) para medir o termopar nos bornes 2 e 3 pela tabela NIST do tipo:
ver `docs/forno-termopar-tt301.md`.

Os outros RTDs, mV e Ohm ficam para captura. A ordem da Tabela 4.5 não bate
com o `02` do Pt100 IEC capturado. Um código desconhecido é gravado, mas não
muda a faixa nem os limites.

Depois da troca, a faixa passa a ser validada pelos limites novos. Exemplo:
com o termopar J, URV 800 é recusado com RC 11.

**Efeito na captura.** O trecho do PID (15:45) veio depois da troca para o
termopar J (15:43), quando a faixa já era −150…750. Mesmo assim o PV% foi
106,25 %, igual à saída de burnout (21 mA). Portanto, em burnout, o PV%
acompanha a saída. Traço `hartBurnoutPercentFollowsOutput`.

## 3. Comando 15, burnout e proteção de escrita

O Comando 15 do TT301 tem **17 bytes**, embora o aparelho seja HART 7: termina
no byte reservado `FA`, sem o byte de flags do canal analógico (C). Traço
`hartResponseDataLimits = "15=17"`.

| Byte | Captura | Significado |
|---|---|---|
| 0 | `01` | burnout (código Smar: 01 = High; na tabela HART 6, 1 seria Low) |
| 1 | `00` | função linear |
| 2 | `20` | °C |
| 3–10 | URV 800 / LRV 0, depois URV 850 / LRV −200 | faixa |
| 11–14 | 0 | damping |
| 15 | `FF`, depois `01` | código de proteção de escrita = byte 1 do Cmd 168 |
| 16 | `FA` | reservado |

O TT301 usa códigos próprios no Comando 15:

- **Burnout `01` = High.** O traço `hartAlarmHighCode = 1` leva a falha a
  21 mA; `hartAlarmLowCode = 0` leva a 3,6 mA (I).
- **Proteção `01` grava normalmente.** Depois de gravar `01`, o próprio log
  mostra os Comandos 165, 131 e 186 aceitos. O traço
  `hartWriteProtectActiveCode = 0` (I) define qual código bloqueia (RC 7).

### Burnout (captura com o sensor aberto)

A bancada estava sem sensor ligado. O TT301 respondeu assim (C, F07):

- Status `C1` = falha do dispositivo + configuração alterada + PV fora de
  limites, **sem** o bit Saturado.
- PV % = MV = 106,25 % = 21 mA.

No simulador, a propriedade **Simular falha do sensor** reproduz isso. O traço
`hartBurnoutStatus = 1` escolhe os bits de status durante o burnout.

## 4. Arquitetura

```
C++ (Core)                                   Dados (editáveis)
──────────────────────────────────────────   ─────────────────────────────────────────────
protocol.hart.device.standard  ◄──────────── subcircuits/hart_smar_tt301.lssubcircuit
  Dispositivo HART padrão (o mesmo do LD301)    1 instância do dispositivo padrão ("tt301")
                                                 + identidade HART 7 e traços de perfil
                                                 + 33 variáveis, 19 comandos DSL (128-253)
                                                 + entrada TEMP por sinal → PV (°C)
                                                 + túneis elétricos → LOOP+ LOOP-
                                                 + LCD exposto acima da arte tt301.svg
```

- O antigo tipo built-in `protocol.hart.device.smar_tt301` continua registrado
  para abrir projetos antigos, mas fica oculto na paleta (`SMAR TT301 (legado)`).
- O TT301 novo aparece em *Protocolos Industriais › HART*, publicado em
  `subcircuits/library.json`.

**Montagem**: ligue um slider ou a saída de uma planta à entrada **TEMP** (°C).
Ligue **LOOP+/LOOP-** no laço 4–20 mA, em série com a fonte e o Modem HART
(`docs/hart-fio-e-modem.md`). A faixa inicial é a capturada: 0–800 °C para
4–20 mA.

### 4.1 O que entrou no dispositivo padrão (genérico, vale para qualquer modelo)

Todos os traços abaixo têm padrão igual ao comportamento anterior. Por isso o
LD301 não muda: `hart_ld301` continua com 249 verificações e replay 130/5/0.

| Funcionalidade | Propriedade (HART Perfil) | Teste |
|---|---|---|
| Comando 0 HART 6/7 completo (bytes 12–21) quando a revisão universal ≥ 6 | `hartMaxDeviceVariables`, `hartPrivateLabel`, `hartDeviceProfile`, `hartConfigChangeCounter` (persistido) | A2, X7, L2 |
| Limite de bytes de resposta por comando | `hartResponseDataLimits` (ex.: `15=17`) | B4, O |
| Códigos de alarme que escolhem a corrente de burnout | `hartAlarmHighCode` (padrão 0), `hartAlarmLowCode` (padrão 1) | R1, R2 |
| Código de proteção de escrita que bloqueia escritas | `hartWriteProtectActiveCode` (padrão 1; 256 = nenhum) | X5, P1, P2 |
| Bits de status durante o burnout | `hartBurnoutStatus` (padrão 4 = Saturado) | R1 |
| Cold Start mantido após o Comando 0 | `hartColdStartKeptByCommand0` (padrão não) | O (#1) |
| Em burnout, PV% = saída % | `hartBurnoutPercentFollowsOutput` (padrão não) | R1, O (PID) |
| DSL: `setDeviceVariable` grava `upperLimit`, `lowerLimit`, `minimumSpan` (limites do transdutor, persistidos) | — | Z1–Z6 |
| DSL: `WriteProtectCode` como variável de sistema (ler/`set`) | — | E5, X4 |

#### Porta de sinal do PV sem unidade (dados do TT301)

A variável PV do TT301 tem a unidade de sinal vazia: a porta TEMP é
adimensional, como a do LD301 (`mmH2O@20C` também vira adimensional). O motivo:
a unidade HART muda em tempo de execução (Comando 44: °C → °F), e um slider sem
unidade precisa ser aceito. A unidade HART continua sendo °C (código 32).

Com a unidade `C`, a porta seria `degC`. Ligar um slider sem unidade nela
derruba o Core: a exceção "unidades de sinal incompatíveis" do motor de sinais
não é tratada. É uma falha geral do Core, fora do TT301, e continua aberta.

## 5. Testes

| Teste | O que prova |
|---|---|
| `hart_tt301` (`core/test/core/protocols/HartTt301Test.cpp`) | **78 verificações.** Ver lista abaixo. |
| `hartTt301Subcircuit.realCore.test.ts` | Núcleo real com 4 testes: identidade HART 7, Comando 15 e Comandos 130/223 byte a byte, LCD `TT301` e `7 00`, slider em TEMP → PV e 4–20 mA ao vivo (400 °C = 12 mA; 200 °C = 8 mA). |
| `hartSmarDevices.test.ts`, `paletteTree.test.ts` | TT301 publicado como subcircuito (TEMP por sinal, laço elétrico, pasta HART, SVG, LCD centralizado acima da arte). Built-in legado oculto. |

O que o `hart_tt301` cobre:

- **S**: subcircuito com dispositivo padrão.
- **A**: identidade.
- **B**: estado inicial.
- **E**: comandos do fabricante.
- **X**: escritas capturadas.
- **F**: faixa e saída.
- **R**: burnout.
- **P**: proteção.
- **Q**: laço.
- **V**: LCD.
- **L**: salvar e reabrir.
- **Z**: troca de sensor (limites e faixa).
- **O**: replay da captura.

### Replay da captura

104 trocas, **103 idênticas byte a byte** e 1 explicada:

- **Estado da bancada.** O replay parte de *falha do sensor* com 850 °C.
- **Mudança não capturada.** Entre 15:43:33 e 15:47:54 o sensor voltou a RTD
  Pt100 sem escrita no log (fig08). Só essa escrita do Comando 131 é
  reproduzida, pelo **mestre secundário**, que não altera os bits do primário.
  A faixa −200…850 °C vista depois sai da própria troca de sensor (§2.3).
- **Troca #101 (Comando 0).** Só o contador de configuração difere: real
  `0x32`, simulado `0x34`. O log não mostra todas as escritas desse intervalo.

## 6. Arquivos

| Arquivo | Mudança |
|---|---|
| `subcircuits/hart_smar_tt301.lssubcircuit` (**novo**) | O TT301. |
| `subcircuits/library.json` | Publica o TT301. |
| `core/src/protocols/HartEngine.hpp/.cpp` | Campos de perfil/plano: códigos de alarme, código de proteção ativo, status de burnout, Comando 0 HART 6/7, limites de resposta, Cold Start após Cmd 0. |
| `core/src/protocols/HartReferenceCatalog.cpp` | Comando 0 HART 6/7, limite de bytes de resposta, `writeProtected()`. |
| `core/src/protocols/HartCommandJson.cpp` | `WriteProtectCode` na DSL. |
| `core/src/protocols/HartCommunicationComponent.hpp/.cpp` | Propriedades dos traços novos; contador de configuração persistido; `displayGlass`; casas decimais por código (`/n`). |
| `core/src/protocols/HartLcd.hpp/.cpp` | Vidro do TT301 (ACK, alarme `AL_0`), limite de casas decimais por página, "Ohm". |
| `extension/src/ui/webview/segmentLcd.ts` (+ teste) | Desenha o vidro do TT301 (byte de vidro no payload). |
| `core/CMakeLists.txt`, `HartTt301Test.cpp` (**novo**), `fixtures/tt301_capture.txt` (**novo**) | Teste `hart_tt301`. |
| `project/schema/component-catalog.json`, `extension/src/ui/webview/catalog.ts` | TT301 built-in oculto (legado). |
| `extension/src/hart/hartTt301Subcircuit.realCore.test.ts` (**novo**), `catalog/hartSmarDevices.test.ts`, `ui/webview/paletteTree.test.ts` | Testes. |

## 7. Pendências: capturas que fecham as inferências (uma mudança por captura)

| # | No DTM do TT301 | Fecha |
|---|---|---|
| 1 | Configuration › Burnout = **Low** e aplicar | código Low (hoje inferido `00`) — Cmds 163/162/15 |
| 2 | Configuration › W.Protect = **read only**, aplicar e tentar gravar outra coisa | código que bloqueia (hoje inferido `00`) e o RC devolvido |
| 3 | LCD › First Variable = **PV(%)** | confirmação do código `04` (o manual já dá a ordem; ver §2.1) |
| 4 | Sensor › cada tipo/sensor/conexão (3 fios, 4 fios, diferencial; outro RTD; K; mV; Ohm) | bytes do Cmd 131 de cada sensor (hoje só Pt100 IEC e J capturados; demais termopares inferidos, §2.3) |
| 5 | PID › ligar o PID, mudar Kp/Tr/Td, Auto/Manual, SP | Cmds 137/139/141/142 (hoje 139/142 vêm do LD301) |
| 6 | Calibration › LO-/HI+ (com referência) e a tela Methods (fig09 não veio) | comandos de calibração e de trim |
| 7 | HART 7 › Device Variables / Dynamic Variables | códigos das 9 variáveis de dispositivo (hoje PV = 246 e borneira = 1) |
| 8 | Maintenance › Operations Counter | comando e layout dos contadores de operação |
| 9 | Gravar o mesmo valor duas vezes e ler o Comando 0 | se o contador de configuração conta escritas repetidas |
