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

A revisao universal HART 7 (`07`) e igual no TT301 real e no perfil simulado. O bloco conhecido do Cmd 0 tambem coincide: revisao do dispositivo 8, software 6.00, hardware 16, ID `010C3A`, 5 preambles, 9 Device Variables. O contador inicial foi `0x0032`; apos a sessao PID, a leitura final retornou `0x0052`. Evidencia: `trm/tt301/live-read-COM17-resume-20261015.txt` e `trm/tt301/live-read-after-PID-restore-COM17-20261015.txt`. A revisao universal, dispositivo, software e hardware coincide com o perfil simulado. All five Core HART suites passed on 2026-10-15.

| Campo | Valor | Evidência | Onde |
|---|---|---|---|
| Comando 0 | `FE 3E 02 05 07 08 60 10 00 01 0C 3A 05 09 00 32 00 00 3E 00 3E 01` | C | traços de perfil |
| Fabricante / tipo | Smar `0x3E` / TT301 `0x02` | C, F03 | `hartManufacturerId`, `hartDeviceType` |
| Revisões | universal 7, dispositivo 8, software `0x60` (DTM 6.00), hardware `0x10` (DTM 16) | C, F04 | `hartUniversalRevision`… |
| Device ID / endereço longo | 68666 = `01 0C 3A` / `BE 02 01 0C 3A` | C, F03 | `uniqueId` |
| Campos HART 7 do Comando 0 | 5 preambulos de resposta, 9 variaveis de dispositivo, contador inicial `0x0032`; `0x0052` apos sessao PID e `0x0056` apos sondas de burnout/LCD e duas escritas idempotentes de Cmd 18; private label Smar `0x003E`, perfil 1 | C, leituras diretas 15/10/2026 | `hartMaxDeviceVariables`, `hartConfigChangeCounter`, `hartPrivateLabel`, `hartDeviceProfile` |
| Tag / descritor / data | `TAG` / `16 CHARACTERS` / 15/04/2013; Cmd 20 = `LONG TAG` | C, F03; leitura direta 15/10/2026 | `tag`, `descriptor`, `date*`, `longTag` |
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
| 136 | Modo de operação do PID (aviso 112) | `FF FF FF` no baseline Off; após a captura/restauração: `FF FF 01` (PID Off) | C, F07, leitura direta final |
| 137 | Escrita do modo PID | pedido observado `02 00 FF 01`; resposta ecoa os 4 bytes; bytes de modo secundários persistidos | C, relay PID |
| 138 | Modo do controlador | `FF` | C, F07, L |
| 139 | Escrever código de modo do controlador | `00` durante PID Manual; `FF` ao restaurar Off; resposta ecoa | C, relay PID |
| 140 | PV %, SP, MV, modo, SP tracking, erro (aviso 112) | baseline: erro 0; após Cmd 137 byte 3=`01`: erro `PV%−SP%`, também com controlador Off | C, PID ativo e leitura final |
| 141 | Escrita de modo/ação PID | pedido observado `02 FF 01`; resposta ecoa; `01` acompanha ação Direct; mapeamento de todos os códigos ainda aberto | C, relay PID |
| 142 | Sintonia Kp / Tr / Td (aviso 112) | Kp 1, Tr 10 min, Td 0; parâmetro 5 = 100 | leituras direta inicial e final 15/10/2026 |
| 152 | Gerador de setpoint: tempo + estado | `00000000 FF FF` (Off) | C, F07 |
| 162 / 163 | Ler / escrever burnout | `00` = Low; `01` = High. Cmd 15 byte 0 alternou `01`→`00`→`01` | leitura direta controlada em 15/10/2026, `trm/tt301/burnout-low-probe-COM17-20261015.txt` |
| 164 / 165 | Ler / escrever LCD (1a e 2a variavel) | `03 02` = Temp. / Temp. PV; `04 02` (PV% / Temp. PV) foi aplicado e restaurado | leitura/escrita direta controlada, `trm/tt301/lcd-pv-percent-probe-COM17-20261015.txt`; falta foto do visor |
| 168 / 169 | Ler / escrever protecao de escrita (comunicacao, ajuste local) | `00 FF` bloqueia escrita HART com RC 7; `01 FF` permite escrita | leitura/escrita direta controlada, `trm/tt301/write-protect-probe-COM17-20261015.txt`; `01/FF` restaurado |
| 173 | Ordering code | 21 espaços | C, F04 |
| 186 / 187 | Escrever / ler junta fria | leitura atual RTD = `00`; `00` = Enabled | leitura direta 15/10/2026; comportamento de 186 com RTD ainda por capturar |
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

- **Burnout `01` = High e `00` = Low.** Os códigos foram confirmados por
  escrita/leitura controlada em Cmds 162/163; o byte 0 do Cmd 15 acompanhou a
  troca e voltou a `01` após restauração. A corrente física em Low ainda não
  foi medida. O simulador usa `hartAlarmHighCode = 1` para 21 mA e
  `hartAlarmLowCode = 0` para 3,6 mA (este valor segue sem medição física).
- **Proteção `01` permite e `00` bloqueia escrita HART.** Sob `00/FF`, uma
  tentativa de regravar sem mudanças o Cmd 18 foi rejeitada com RC 7. A
  proteção voltou a `01/FF`; Cmd 13 confirmou a identidade inalterada.
  Evidência: `trm/tt301/write-protect-probe-COM17-20261015.txt`.

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
                                                 + 39 variáveis, 21 comandos DSL (128-253)
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
(`docs/hart-fio-e-modem.md`). Faixa observada: -200..850 degC para 4-20 mA.
4–20 mA.

### 4.1 O que entrou no dispositivo padrão (genérico, vale para qualquer modelo)

Todos os traços abaixo têm padrão igual ao comportamento anterior. Por isso o
LD301: `hart_ld301` passou com 255 verificações e replay 130 exatos / 5 semânticos / 0 divergentes.

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
| `hart_tt301` (`core/test/core/protocols/HartTt301Test.cpp`) | **134 checks passed (2026-10-15).** See list below. |
| `hartTt301Subcircuit.realCore.test.ts` | Nucleo real: identidade HART 7, Command 15 e Commands 130/223, LCD, sensor Pt100 2/3/4 fios e corrente de loop usando a faixa observada -200..850 degC. |
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
| 1 | Configuration › Burnout = **Low** e aplicar | código `00` e byte 0 do Cmd 15 confirmados por leitura/escrita direta; corrente física Low ainda sem medição |
| 2 | Configuration › W.Protect = **read only**, aplicar e tentar gravar outra coisa | `00/FF` confirmado; Cmd 18 bloqueado com RC 7. Validar a operação na tela DTM |
| 3 | LCD › First Variable = **PV(%)** | confirmação do código `04` (o manual já dá a ordem; ver §2.1) |
| 4 | Sensor › cada tipo/sensor/conexão (3 fios, 4 fios, diferencial; outro RTD; K; mV; Ohm) | PACTware online confirmou a configuração atual RTD / Pt 100 IEC / Two wires e as categorias RTD, TC, Ohm, mV e Special. Permanecem pendentes as demais associações código/modelo e a resposta de cada ligação (captura 15/10/2026, §8.3). |
| 5 | PID › ligar o PID, mudar Kp/Tr/Td, Auto/Manual, SP | Cmds 137/139/141 modelados com os frames capturados; completar Kp/Tr/Td, Auto, ação inversa e gerador de SP |
| 6 | Calibration › LO-/HI+ (com referência) e a tela Methods (fig09 não veio) | comandos de calibração e de trim |
| 7 | HART 7 Device Variables / Dynamic Variables | Cmd 9/33 seletores 0-8 e aliases F4-F9 têm regressão offline; mapeamentos distintos por comando reproduzem os dados capturados. Cmd 50 atribuições 2,3,1,2; canais 5-8 foram comparados com PID On/Off. |
| 8 | Maintenance › Operations Counter | comando e layout dos contadores de operação |
| 9 | Gravar o mesmo valor duas vezes e ler o Comando 0 | se o contador de configuração conta escritas repetidas |

## 8. Captura ao vivo via PACTware e relay (15/10/2026)

O PACTware já ocupava a COM17, então não era possível abrir a porta em paralelo.
Foi feita uma cópia do projeto para `trm/projeto_pactware_tt301-COM26.PW5` e
configurado um par virtual com0com COM26↔COM27. O PACTware abriu a cópia em
COM26; um relay Python transparente encaminhou COM27↔COM17, registrando os dois
sentidos. O projeto original `projeto_pactware_tt301.PW5` não foi alterado.

Evidências locais (não versionadas):

- `trm/tt301/pactware-COM26-relay-20261015.txt`: captura bruta, 30.829 bytes.
- `trm/tt301/pactware-COM26-relay-20261015-decoded.csv`: 36 requisições com
  respostas remontadas de 472 fragmentos recebidos.
- `trm/tt301/pactware-COM26-upload-done-20261015.jpg`: tela do PACTware após
  a leitura. O menu do TT301 mostrou conexão ativa e a ação “Load from device”
  encerrou sem erro visível.

A captura contém os comandos 0, 12, 13, 15, 130, 162, 164 e 187. As respostas
com checksum XOR válido incluem identificação atual com contador de configuração
`0x0032`, sensor RTD Pt100 IEC a 2 fios (`Cmd 130`: `02 01 02 01 01`), burnout
High (`Cmd 162`: `02 01`), LCD (`Cmd 164`: `02 03 02`) e junta fria desabilitada
(`Cmd 187`: `02 00`). O Cmd 15 confirmou bytes de faixa/status retornados nesta
sessão; veja o CSV para o frame bruto. A leitura de upload repetiu alguns
comandos e contém 13 requisições Cmd 15, além de reenvios de outros comandos.

### 8.1 Leitura direta complementar (somente consulta)

A leitura direta inicial em COM17 confirmou faixa `-200..850 degC`, Long Tag `LONG TAG`, PID desligado, Kp=1, Tr=10 min, Td=0, LCD `03/02`, protecao `01/FF`, junta fria `00` e contador `0x0032`. Depois, com PACTware pelo relay COM26-COM27, o PID foi ativado em Manual/Direct e SP ajustado a 30%; a saida permaneceu em 26,53%. A tela Write restaurou o controlador para Off e SP para 0%. Leitura direta final (`live-read-after-PID-restore-COM17-20261015.txt`) confirmou Cmd 138=`FF`, SP=0%, PID desligado, sintonia Kp=1/Tr=10/Td=0, sensor e faixa preservados. O contador passou a `0x0052` pelas escritas de configuracao; esse contador nao foi restaurado.

A consulta correta do Comando 9 com seletores `03 01 02 00` respondeu RC 0 e devolveu quatro registros, na ordem solicitada: codigo 3 = temperatura da borneira (classe `40`, unidade `20`, amostra `41 D7 A5 40`, status `C0`); codigo 1 = PV percentual (classe `00`, unidade `39`, amostra `41 D4 46 BB`, status `C0`); codigo 2 = PV em degC (classe `40`, unidade `20`, amostra `42 9D 39 AC`, status `C0`); codigo 0 = corrente de saida (classe `54`, unidade `27`, amostra `41 03 ED AC`, status `C0`). O Comando 9 tambem retornou timestamp de quatro bytes. O Comando 50 confirmou atribuicoes dinamicas `[02,03,01,02]` (PV/SV/TV/QV); o Comando 33 retornou os pares unidade/valor correspondentes. Consultas validas de um byte no Comando 54 para codigos 0, 1, 2, 3 e 246 responderam RC `0x40` (Command Not Implemented); respostas arquivadas em `trm/tt301/live-detail-COM17-20261015.txt`.

O subcircuito declara as nove variaveis de dispositivo (codigos 0-8), as atribuicoes dinamicas, faixa, Long Tag e configuracoes observadas. Cmds 9/33 confirmaram codigos 5-8 como SP percentual, SP em engenharia, tempo do gerador e erro. SP de engenharia segue `LRV + SP% * span`, inclusive com PID Off; erro segue `PV% - SP%`, inclusive com o controlador Off. Com SP=30%, a leitura real retornou SP=30%, SP=115 degC, tempo=0 e erro=-3.466%; com PID Off e SP=0%, retornou SP=0%, SP=-200 degC e erro=26.54%. O simulador agora calcula SP em engenharia e erro pela faixa PV e setpoint. O nucleo HART permite configurar e persistir as quatro atribuicoes do Cmd 50 (`hartDynamicVariableAssignments`). PV e temperatura da borneira continuam entradas dinamicas, nao constantes.

Nova leitura de Cmd 33 em 15/10/2026: seletores `00-07` retornaram quatro registros (codigos 0-3); seletor `08` retornou o codigo 8; seletores `F4-F9` retornaram quatro registros repetidos do codigo 0/corrente. Leitura individual confirmou cada alias. O executor agora remapeia 244-249 para 0 somente em Cmd 33 quando o equipamento e SMAR TT301; Cmd 9 preserva os aliases individuais.

Regressao adicionada: o teste Core percorre Cmd 9 e Cmd 33 com seletores individuais `00-08` e `F4-F9`, conferindo quantidade, codigo, status e unidade dos registros. Esse teste encontrou que cinco aliases do Cmd 9 ainda nao resolviam para a variavel real; o executor agora mapeia F4=PV%, F5=corrente, F6=PV, F7=temperatura da borneira, F8=PV% e F9=PV, limitado ao perfil SMAR TT301. Cmd 33 continua reproduzindo a resposta observada de corrente para cada alias. `hart_tt301` passou com 134 verificacoes; o replay da captura segue 103/104 exatos e 1 diferenca explicada pelo contador.

Nova regressao offline cobre os 12 perfis de termopar da Tabela 6.1 (B, E, J, K, N, R, S, T, L, U, W5Re/W26Re e L GOST), validando Cmd 131, Cmd 130, limites dos Cmds 14/15 e span minimo. Isso verifica os defaults do simulador sem alegar validacao de sensores fisicos. `hart_tt301` passou com 134 verificacoes.

Tambem foram adicionados testes de armazenamento/readback para os oito codigos de conexao do Cmd 131 (diferencial, dois, tres e quatro fios, backup, media, maximo e minimo). Isso confirma somente o estado HART configurado no simulador; ligacao eletrica e comportamento com sensores reais continuam pendentes. `hart_tt301` passou com 134 verificacoes.

### 8.2 PID ativo, retorno ao estado Off e revisão HART

O mesmo projeto PACTware pelo relay permitiu observar PID On, ação Direct,
tracking Off, modo Manual e SP=30%. O MV/saída permaneceu em 26,53% (≈8,24 mA).
As gravações foram feitas pelo DTM e estão registradas em
`trm/tt301/pactware-PID-COM26-COM27-COM17-20261015.txt`. Cmds 9 e 33
concordaram nos canais 5–8: SP=30%, SP de engenharia=115 °C, tempo=0 min e
erro≈−3,466% (PV%−SP%). O cálculo de SP é `LRV + SP% × (URV−LRV)`.

Em seguida, o DTM gravou controlador Off e SP=0%; a leitura direta final
`trm/tt301/live-read-after-PID-restore-COM17-20261015.txt` confirmou Cmd
138=`FF`, Cmd 136 com bytes `FF FF 01` e Cmd 140 com SP=0%, modo/tracking
`FF FF`. Com PID Off, Cmds 9/33 retornaram SP de engenharia=−200 °C (LRV) e
erro≈26,54% (PV%−0%). Esse comportamento ocorreu após Cmd 137 deixar o terceiro
byte de modo em `01`; no baseline inicial `FF FF FF`, o erro lido era zero.
Isso corrigiu a hipótese anterior de que SP de
engenharia seria zero quando o PID estivesse desligado; o cálculo no Core e
no LCD foi ajustado para usar a faixa em todos os modos. O canal de erro
também agora deriva PV%−SP% quando esse byte está `01`, e fica zero no
baseline `FF`. Cmd 140 usa o mesmo valor de DV 8, em vez de erro estático.

O comando 0 final continua anunciando revisão universal HART 7, revisão do
dispositivo 8, software `0x60` e hardware `0x10`, iguais ao simulador. As
gravações elevaram o contador de configuração de `0x0032` para `0x0052`; ele
não foi resetado. A leitura confirmou novamente faixa Pt100 −200…850 °C,
sensor RTD Pt100 IEC/2 fios, burnout High, LCD `03/02`, proteção `01/FF`,
junta fria `00`, Kp=1, Tr=10 min, Td=0 e gerador de SP Off. PACTware não foi
usado depois da leitura direta e o relay COM27↔COM17 foi parado.

**Limitação da captura:** o relay encaminha e registra em chunks de até 20 ms.
O modem dividiu as respostas em muitos fragmentos e algumas requisições foram
repetidas pelo PACTware; há bytes `FF` excedentes no início/fim de algumas
respostas remontadas, que são preâmbulos ociosos, mantendo-se o XOR do frame
HART válido. Portanto a captura confirma os bytes dos comandos e respostas
listados, mas os intervalos não representam a temporização direta do modem.
Houve escritas controladas de PID, com retorno operacional ao estado Off e
SP=0% confirmado por leitura direta. As gravações elevaram o contador de
configuração; os outros parâmetros conferidos permaneceram nos valores
anteriores. Permanecem as pendências indicadas na seção 7.

### Verificações físicas adicionais em 15/10/2026

- `trm/tt301/burnout-low-probe-COM17-20261015.txt`: Cmd 163 selecionou Low (`02 00`), Cmd 162 leu `02 00` e Cmd 15 byte 0 passou de `01` para `00`; a restauração High (`01`) foi confirmada nos dois comandos. A corrente física em Low não foi medida.
- `trm/tt301/lcd-pv-percent-probe-COM17-20261015.txt`: Cmd 165 selecionou First Variable PV% (`02 04 02`), Cmd 164 leu `02 04 02`, e a restauração `02 03 02` foi confirmada. Falta registrar foto do visor e validação visual no DTM.
- `trm/tt301/idempotent-identity-probe-COM17-20261015.txt`: o payload de 21 bytes lido no Cmd 13 foi reenviado, sem alteração, duas vezes no Cmd 18. O readback permaneceu idêntico e o contador Cmd 0 avançou uma unidade por gravação: `0x0054` → `0x0055` → `0x0056`.
- `trm/tt301/write-protect-probe-COM17-20261015.txt`: Cmd 169 gravou `00/FF`; Cmd 168 confirmou; Cmd 18 foi recusado com RC 7; Cmd 169 restaurou `01/FF`; Cmd 13 permaneceu byte-idêntico.
- A captura read-only `trm/tt301/live-read-continue-COM17-20261015.txt` confirmou a configuração inicial destas sondas: PID Off, SP 0%, burnout High, LCD `03/02`, proteção `01/FF`, Pt100 IEC de 2 fios e faixa −200…850 °C. O contador era `0x0052` antes das sondas e está em `0x0056` após elas.

### 8.3 Página Sensor online no PACTware (15/10/2026)

O projeto de trabalho COM26 foi conectado ao modem COM17 pelo relay COM27. Em
**Online Parameterize › Blocks › Configuration › Sensor**, o DTM leu e exibiu
**Sensor Type = RTD**, **Sensor = Pt 100 IEC** e **Connection = Two wires**.
O menu de Sensor Type ofereceu **RTD, TC, Ohm, mV e Special**. A consulta
HART final pela COM17 confirmou o Cmd 130 como `02 01 02 01 01` (seletor TT301,
RTD, modelo 02, conexão 01, byte somente leitura 01), portanto a leitura
PACTware corresponde ao estado físico.

Capturas: `trm/tt301/pactware-online-sensor-COM26-COM27-COM17-20261015.txt`
(tráfego bruto do relay) e
`trm/tt301/pactware-online-sensor-readback-COM17-20261015.txt` (leitura direta
somente consulta). Na sessão PACTware, os comandos observados foram leituras
Cmd 0, 12, 13, 15, 130, 162, 164, 168, 187, 198 e 223; não houve Cmd 131 nem
outro comando de escrita. A navegação do menu de tipo não foi gravada no
transmissor. A leitura final também manteve PID Off (`Cmd 138 = FF`), burnout
High (`Cmd 162 = 02 01`), LCD `02 03 02`, proteção `01 FF` e sensor Pt100 IEC
de 2 fios.

O DTM confirmou o nome do estado atual e as categorias principais, mas não
forneceu nesta sessão evidência para associar todos os códigos de modelo do
Cmd 131 a nomes nem para validar faixas e comportamento em mV/Ohm/Special. As
varreduras HART anteriores só comprovam quais códigos são aceitos e os limites
carregados; as correspondências ainda devem ser lidas no DTM/modelo e testadas
com uma entrada elétrica adequada antes de alterar a simulação.



### 8.4 Software corrections and regression (2026-10-15)

The `hart_tt301` suite was rebuilt and passed with **134 checks**. All five Core HART tests passed: `hart_engine`, `hart_ld301`, `hart_tt301`, `hart_physical_layer`, and `hart_wire_loop`. The TT301 capture replay produced **103/104 byte-identical replies**, one explained difference in the Command 0 configuration counter, and no unexplained mismatches.

Corrections include DSL support for `append`, PV/range units from the configured PV variable, semantic HART alias 246 resolving to the configured PV device-variable code, and category-change-only sensor range loading. Tests now match the observed LCD cycle (`Temp.` then `Temp. PV`) and the write-protect code `01`.

### 8.5 Final direct read on COM17 (2026-10-15)

A read-only capture confirmed Cmd 130 `02 01 02 01 01` (RTD / Pt 100 IEC / two wires), Cmd 138 PID Off (`02 FF`), Cmd 162 Burnout High (`02 01`), Cmd 164 LCD `02 03 02`, and Cmd 168 protection `02 01 FF`. Cmd 1 read PV 78.6146 C; Cmd 2 read 8.24556 mA / 26.5347% at that instant. Cmd 142 read Kp=1, Tr=10, Td=0; Cmd 152 read SP=0 and generator Off. Capture: `trm/tt301/live-read-final-COM17-20261015.txt`.

### 8.6 Reversible physical Cmd 131 probe (2026-10-15)

COM17 tested Pt100 IEC / two wires -> TC J NBS -> TC K NBS -> Pt100. Cmd 131 returned RC 0 for each transition. RTD -> J loaded range and limits -150..750 C with 30 C minimum span. J -> K updated the Cmd 130 sensor code but preserved the existing J range and calibration limits. K -> RTD restored the Pt100 range -200..850 C, original limits, and 10 C span. PID Off, Burnout High, and protection `01/FF` were read before the writes. Frames and final readback: `trm/tt301/sensor-roundtrip-COM17-COM130-20261015.txt`; the final read-only state after all probes is `trm/tt301/live-read-post-connection-probe-COM17-20261015.txt`. An additional connection-only write requesting three-wire on the specimen still wired as two-wire returned an ACK but Cmd 130 continued to report two-wire; it was restored. Eight sensor writes advanced the monotonic HART counter from `0x87` to `0x8F`, and that additional probe advanced it to `0x91`. Functional settings are restored; the counter is monotonic and is not decremented.


## Leitura online via PACTware e COM0COM ? 15/10/2026 (COM26)

O projeto de trabalho `trm/projeto_pactware_tt301-COM26.PW5` conectou o PACTware ? porta virtual COM26. O COM0COM Pair 6 estava ativo (COM26 ON ? COM27) e o relay transparente encaminhou COM27 ao modem f?sico COM17. Evid?ncia serial bruta: `trm/tt301/live-COM26-COM27-COM17-20261015.txt`; frames HART remontados e com checksum v?lido: `trm/tt301/live-COM26-COM27-COM17-20261015-decoded.csv`.

Na tela **Observe / Monitoring**, o DTM exibiu Out(mA)=8,25 mA, Out(%)=26,53%, PV(%)=26,53% e Temp.=27,41 ?C. O status de PACTware mostrava `Connected`. A tela **Calibration / Methods** lista Current, Zero, Gain, Factory e Terminal Sensor; nenhum desses comandos foi acionado. Em **General**, foi poss?vel ver a subse??o Multidrop.

A captura cont?m 119 frames v?lidos de solicita??o e 117 frames v?lidos de resposta (checksum XOR correto), com comandos 0, 12, 13, 15, 16, 33, 130, 136, 138, 140, 142, 148, 150, 152, 162, 164, 173, 187, 198 e 223. O DTM permaneceu indicando `Reading Xmtr Data...` durante a inspe??o; a captura da tela falhou ao atualizar, ent?o esta coleta confirma os par?metros online vis?veis, mas n?o fecha a inspe??o das p?ginas Observe, Diagnosis, Multidrop e demais telas. O relay foi encerrado ap?s a coleta.


Ap?s a primeira coleta, o relay foi retomado brevemente para preservar a conex?o do DTM. Nessa janela, o PACTware repetiu apenas consultas Cmd 33 (67 pedidos; 65 respostas v?lidas) enquanto a tela continuava em `Reading Xmtr Data...`; o log `trm/tt301/live-COM26-COM27-COM17-resume-20261015.txt` foi encerrado para evitar uma captura repetitiva sem avan?o de tela.


## Reabertura limpa do PACTware e coleta online completa (15/10/2026)

PACTware foi reaberto do zero e carregou explicitamente `trm/projeto_pactware_tt301-COM26.PW5`. O COM0COM Pair 6 COM26?COM27 estava ON; o relay `python scripts/hart_serial_relay_capture.py COM27 COM17 ...` encaminhou as consultas do PACTware ao modem na COM17. Ap?s confirmar a abertura da conex?o HART e TT301, o DTM exibiu `Connected`. O indicador inferior `Reading Xmtr Data...` permaneceu vis?vel durante consultas, mas as p?ginas e campos terminaram de carregar; a leitura foi aguardada e os valores foram verificados.

**Identifica??o online:** Manufacturer SMAR, Device Type TT301, Device ID 68666, Serial # 68666, Software Revision 6.00, Hardware Revision 16, Main Board Serial # 0; Ordering Code em branco. Tag `TAG`, Descriptor `16 CHARACTERS`, Message `32 CHARACTERS`.

**Configura??o e opera??o observadas:** Sensor Type RTD, Sensor Pt 100 IEC, Connection Two wires. PID Off, Action Direct, SP Track em branco, Mode Manual; SP 0,00%, PV 26,53%, MV 26,53%, Error 0,00%, SP Time 0,00 min, SP Generator Off, SP Generator Mode Off. Na p?gina Limit/Tuning: SP Power On Manual, KP 1,00, TR 10,00 min/rev, TD 0,00, Safety Val 50,00%, Rate/Chng 0,00%/s, Low Limit 0,00%, High Limit 100,00%.

**Observe / Monitoring:** Out(mA) 8,25 mA; Out(%) 26,53%; PV(%) 26,53%; Temp. 27,42 (o DTM apresentou a unidade `INT`). Na aba Monit Calibration: Measured Temperature 78,61 degC; Calibration Unit degC; Sensor Lower Range Limit ?200,00; Sensor Upper Range Limit 850,00; Minimum Span 10,00; Environment Temperature 27,42; Measured Current 8,25 mA; Source of Sensor Trim Factory.

**Geral, diagn?stico e calibra??o:** Multidrop Polling Address 0. No diagn?stico, `Configured Changed` apareceu em vermelho (Alarm); Power Up, Device MalFunction, Analog Output Saturated, PV Out of Limits, Temperature Out of Limits e Output Current Fixed ficaram em azul (Normal). A p?gina Calibration / Methods lista Current, Zero, Gain, Factory e Terminal Sensor. Nenhuma escrita, trim ou reset foi acionado nesta sess?o.

O Cmd 0 respondeu RC `00`, status `40` e dados universais confirmando HART universal 7, device revision 8, software `0x60` (6.00), hardware `0x10` (16), ID `01 0C 3A`, 5 preambles, 9 device variables e contador `0x0091`. A captura integral arquivada ? `trm/tt301/pactware-reload-COM26-COM27-COM17-20261015.txt`; a remontagem por dire??o, com valida??o XOR dos frames, est? em `trm/tt301/pactware-reload-COM26-COM27-COM17-20261015-decoded.csv` (snapshot de 22:01:12 local: 209 solicita??es e 206 respostas v?lidas). O relay continua ativo e gravando em `trm/tt301/live-COM26-COM27-COM17-retry2-20261015.txt` para manter a sess?o COM26 conectada; as consultas repetidas de Cmd 33 s?o o polling do DTM.
