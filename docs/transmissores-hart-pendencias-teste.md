# LD301 e TT301: testes pendentes para conclusão

Atualizado em 15/10/2026. Este documento consolida as pendências registradas nas auditorias individuais. Ele é um roteiro de fechamento: itens marcados como pendentes precisam de captura/medição no equipamento real, implementação se houver divergência, e regressão no simulador.

## Situação da documentação

Já existem auditorias detalhadas: [LD301](ld301-audit.md), [TT301](tt301-audit.md), [HART e modem no fio](hart-fio-e-modem.md) e cenários de processo [LD301](placa-orificio-ld301.md) / [TT301](tanque-aquecido-tt301.md). Portanto, não faltava documentação; faltava um checklist único de conclusão. As auditorias informam suites automatizadas verdes, mas isso não equivale à validação completa contra o aparelho real.

## LD301

### Capturas e comportamento ainda não fechados

- [ ] Capturar escrita dos pontos da caracterização do sensor (Cmd 163 e leituras relacionadas), variando um ponto por vez; conferir limites, persistência após salvar/reabrir e resposta a índice/truncamento inválido.
- [ ] Exercitar no DTM as escritas de PID: Kp, Tr, Td, Auto/Manual e setpoint; identificar comandos, bytes, códigos de resposta e efeito sobre PV/MV/saída. Resolver os significados pendentes de `pid.operatingMode*` e `pid.modeCode`.
- [ ] Capturar trims Lower, Upper e Temperature com referência rastreável; verificar leitura de volta, limites, proteção de escrita e persistência.
- [ ] Testar Totalization em funcionamento: zerar/resetar, acumulação ao longo do tempo, fator, vazão máxima, unidade, overflow/limites e persistência. Hoje o total simulado é estático; validar a dinâmica real antes de modelá-la.
- [ ] Capturar Factory/reset e documentar exatamente quais parâmetros são restaurados, o que permanece, códigos de resposta e contador de configuração.
- [ ] Completar Cmd 166: medir incremento após escritas de função, totalização, caracterização, trims, TRM/PID, Auto Clamp, proteção e senha/nível.
- [ ] Fechar códigos e efeitos ainda inferidos no Display (Cmd 164/165), em especial SP(%), SP e Error(%), bytes 2/3 e renderização de SP/ER/TOT no LCD; validar também seleção de primeira/segunda variável no DTM.
- [ ] Determinar significado de campos proprietários ainda desconhecidos (`cmd128.byte3/11/12/22/23`, `display.byte3`, `cmd189.*`, Cmd 204 e variável 20) e a origem dos avisos 112/118, usando captura controlada ou documentação do fabricante.
- [x] Cmd 11 LD301: regressão offline valida Tag coincidente (`00` + bloco de identidade) e divergente (`01` + mesmo bloco). Endereçamento broadcast continua sem captura/validação.

### Validação ponta a ponta ainda pendente

- [ ] Abrir PACTware 5.0/DTM pela COM conectada ao modem em série no laço e validar as telas 01–23: abertura, leitura de todos os campos e escrita com confirmação visual. A auditoria registra todas como não verificadas na interface.
- [ ] Comparar no equipamento real corrente do laço e LCD para Linear/Square Root, cutoff Hard/Bumpless, User Unit e saturação; os testes atuais reproduzem protocolo e curva, mas ainda faltam essas medições físicas.
- [ ] Medir burnout em aparelho real (corrente e status) e comparar com injeção simulada; o teste atual é por falha injetada.
- [ ] Verificar faixa elétrica real do laço: tensão mínima/lift-off, alimentação, carga mínima/máxima, polaridade e resposta de corrente. O modelo atual usa fonte ideal de corrente.
- [ ] Repetir replay serial pelo modem HART e classificar as 4 diferenças conhecidas dentre 135 (itens da captura 97, 112, 117 e 134); confirmar que continuam explicáveis por variação de PV/ruído/truncamento do log e não por regressão.

## TT301

### Capturas HART pendentes

- [x] PACTware online confirmou em Configuration › Sensor o estado real **RTD / Pt 100 IEC / Two wires**. A leitura direta posterior do Cmd 130 retornou `02 01 02 01 01`; a lista de tipos do DTM apresenta RTD, TC, Ohm, mV e Special. Evidências: `trm/tt301/pactware-online-sensor-COM26-COM27-COM17-20261015.txt` e `trm/tt301/pactware-online-sensor-readback-COM17-20261015.txt`. A captura não contém comandos de escrita.
- [x] Código Burnout Low `00` confirmado por escrita e leitura direta em Cmds 163/162; byte 0 do Cmd 15 alternou `01`→`00`→`01`. Captura `trm/tt301/burnout-low-probe-COM17-20261015.txt`. Falta medir a corrente física em Low e fazer a sequência pelo DTM.
- [x] Proteção de comunicação `00/FF` testada: Cmd 168 confirmou a seleção e uma regravação idêntica de Cmd 18 recebeu RC 7. Proteção foi restaurada a `01/FF` e Cmd 13 permaneceu idêntico. Captura `trm/tt301/write-protect-probe-COM17-20261015.txt`. Falta validar o fluxo pela tela DTM.
- [x] Cmd 165 gravou PV(%)=`04`; Cmd 164 leu `02 04 02`, depois restaurado para `02 03 02`. Captura `trm/tt301/lcd-pv-percent-probe-COM17-20261015.txt`. Falta foto do LCD e validação visual pelo DTM.
- [x] Cmd 131 tested on the device: Pt100 -> TC J -> TC K -> Pt100. J loads defaults; J-to-K preserves calibration; return to Pt100 restores initial settings. Evidence: `trm/tt301/sensor-roundtrip-COM17-COM130-20261015.txt`.
- [x] Offline regression covers all 12 thermocouple ranges and minimum spans in TT301 manual Table 6.1. This closes simulator profile coverage; physical accuracy for the other thermocouples remains unverified.
- [x] Offline regression stores/reads back all eight Cmd 131 connection codes (differential, 2/3/4-wire, backup, average, maximum, minimum). This validates HART configuration only, not the physical wiring behavior.
- [ ] Test remaining RTD models and 3/4-wire wiring on a matching physical sensor. A connection-only 3-wire write on the two-wire specimen left Cmd 130 at two-wire and was restored; it does not validate three-wire operation.
- [ ] Completar PID no TT301: Cmds 137/139/141 foram adicionados usando os frames capturados; Cmds 136/138/140/142/152 foram lidos nos estados PID ativo e Off. SP=30% foi aplicado em Manual/Direct e restaurado a 0%. Faltam variar Kp/Tr/Td, testar Auto e ação inversa, ligar o gerador de SP e medir o efeito dinâmico sobre MV/corrente.
- [ ] Capturar calibração LO-/HI+ com referência e a tela Methods; identificar comandos e comportamento de trim.
- [x] Device Variables HART 7: Cmd 9 selectors 0-8 and F4-F9 and Cmd 33 selectors 0-8 and F4-F9 are covered by Core regressions. Cmd 50 assignments 2,3,1,2 and Cmd 54 RC 64 are also checked. PID On/Off captures remain the reference for values 5-8.
- [x] Cmd 9 aliases F4-F9 now resolve to the individual TT301 variables captured on COM17; Cmd 33 retains the observed TT301 quirk that aliases 244-249 all return the current tuple. The mapping is isolated to SMAR TT301 and covered by selector regressions.
- [ ] Capturar Maintenance / Operations Counter para identificar comando, layout e regras de incremento.
- [x] Cmd 18 regravou duas vezes o payload inalterado de Tag/descritor/data. O Cmd 13 ficou idêntico; o contador do Cmd 0 incrementou `0x0054→0x0055→0x0056`, uma unidade por escrita idempotente. Captura `trm/tt301/idempotent-identity-probe-COM17-20261015.txt`.
- [ ] Ampliar a captura de sensores e estados para cobrir burnout High/Low, sensor rompido/curto, troca de sensor e retorno ao estado normal; confrontar alarmes/status e corrente.

### Validação física e interface pendentes

The items above are software-closed only where explicitly marked `[x]`. No physical wiring change was made. Remaining unclosed work requires physical sensor configurations/instruments, the LCD or DTM UI, or undocumented vendor frames; do not infer those behaviors from the simulator alone.

- [ ] Completar verificacao PACTware/DTM: relay confirmou upload e uma rodada controlada de PID; leituras diretas confirmaram Commands 1-3, 9, 14-16, 20, 33, 48, 50 e 130-223. Faltam conferir as demais telas, escrita de protecao e calibracao, e replay byte a byte contra o simulador.
- [ ] Comparar PV, LCD, corrente do laço e estados de alarme para pontos representativos de cada sensor, incluindo extremos de faixa e burnout.
- [ ] Medir montagem elétrica real: alimentação, bornes 1–4, resistências de linha para 2/3/4 fios, polaridade, ligação do modem e carga do laço. O teste de Core cobre Pt100 2/3/4 fios, mas não substitui medições no aparelho.
- [ ] Validar mudança de variável/unidade e apresentação do LCD em operação contínua, incluindo alternância de páginas se habilitada.

## Critério de conclusão comum

Para cada item acima, arquivar captura bruta com data, equipamento/firmware, configuração inicial e instrumento de medição; descrever sequência reproduzível no DTM; comparar resposta real e simulada byte a byte (explicando qualquer diferença); acrescentar regressão automatizada para o comportamento confirmado; e atualizar a auditoria individual com resultado, evidência e pendência residual. Marcar concluído somente quando evidência real e teste de regressão estiverem ligados ao item.

## Evidência adicionada em 15/10/2026

- Projeto PACTware de trabalho foi clonado para `trm/projeto_pactware_tt301-COM26.PW5`; o original COM17 preservado. Par com0com COM26↔COM27 encaminhou dados até o modem físico COM17 enquanto o PACTware usava COM26. Captura direta inicial somente de consultas: `trm/tt301/live-read-COM17-resume-20261015.txt`; depois foram feitas escritas controladas de PID e uma leitura direta final, documentadas abaixo. Captura detalhada: `trm/tt301/live-detail-COM17-20261015.txt`.
- Capturas: `trm/tt301/pactware-COM26-relay-20261015.txt` (bytes brutos), `trm/tt301/pactware-COM26-relay-20261015-decoded.csv` (36 requisições/remontagens) e `trm/tt301/pactware-COM26-upload-done-20261015.jpg` (tela PACTware).
- Houve upload sem escritas inicialmente. Depois foram gravados PID On, SP=30%, e restaurados controlador Off e SP=0%. A leitura final confirmou sensor Pt100 IEC/2 fios, faixa -200..850 degC, burnout High, LCD `03/02`, proteção `01/FF`, junta fria `00`, Kp=1, Tr=10 min e Td=0. O contador de configuração mudou de `0x0032` para `0x0052` pelas gravações. O relay fragmenta bytes em 20 ms; consulte a seção 8 da auditoria antes de usar tempos ou comparar frames.
- Varredura somente de leitura inicial em `trm/tt301/live-device-variable-scan-COM17-20261015.txt`: Cmd 9 aceitou seletores `00-07`, `08` e `F4-F9`, todos com RC 0. Códigos 0-3 coincidem com corrente, PV percentual, PV e temperatura da borneira. O código 4 repetiu PV percentual. Códigos 5-8 foram depois comparados nos estados PID ativo e Off; evidências e valores estão na auditoria TT301. Aliases F4-F9 retornaram PV percentual, corrente, PV, temperatura da borneira, PV percentual e PV, respectivamente.
- Consulta somente de leitura ao Cmd 33, arquivada em `trm/tt301/live-command33-variable-scan-COM17-20261015.txt`: `00-07` devolveu quatro registros, codigos 0-3, ignorando os seletores adicionais; `08` devolveu um registro; `F4-F9` devolveu quatro registros repetidos do codigo 0/corrente. Esta resposta de aliases diverge da resposta de Cmd 9 e foi modelada com remapeamento especifico no Cmd 33 do TT301. Leitura individual em `trm/tt301/live-command33-selector-detail-COM17-20261015.txt` confirmou cada codigo F4-F9 como codigo de resposta 0/unidade 27 (hex)/corrente. O Cmd 9 continua resolvendo esses aliases de forma distinta.
- Cmd 54 respondeu RC 64 para seletores 0-3 e 246; o perfil TT301 deixou de anunciar esse comando. A coleta dos seletores esta concluida; ainda falta comparar os payloads simulados para 4-8, observar esses canais em outros estados e automatizar a comparacao real/simulado.
- A captura PID ativa está em `trm/tt301/pactware-PID-COM26-COM27-COM17-20261015.txt`; a restauração está em `trm/tt301/pactware-PID-restore-COM26-COM27-COM17-20261015.txt`. A leitura final pela COM17 está em `trm/tt301/live-read-after-PID-restore-COM17-20261015.txt`: Cmd 138=`FF`, SP=0%, PID Off, faixa e sensor preservados. O contador Cmd 0 avançou para `0x0052` e não foi resetado. O relay foi parado após a leitura final; o projeto original permanece preservado.

## Baseline automatizado já registrado

- LD301: `hart_ld301` 255 verificações; replay serial 131/135 exatos (4 diferenças classificadas); replay Core 130 exatos, 5 semânticos; `hart_wire_loop` também passou.
- TT301: `hart_tt301` 134 checks passed on 2026-10-15; replay 103/104 exact with one explained counter difference.
- Esses resultados são o baseline documentado nas auditorias, não foram reexecutados ao criar este checklist.


### TT301 software and bench status (2026-10-15)

- [x] Release build and five Core HART suites passed: `hart_engine`, `hart_ld301`, `hart_tt301`, `hart_physical_layer`, `hart_wire_loop`.

- [x] `hart_tt301`: 134 checks; 104 replay exchanges, 103 exact, one explained counter difference, no unexplained mismatches.

- [x] Read-only COM17 capture after the sensor probes confirms Pt100, PID Off, SP=0, Burnout High, LCD `03/02`, protection `01/FF`; counter is `0x91`: `trm/tt301/live-read-post-connection-probe-COM17-20261015.txt`.

- [x] Physical Cmd 131 roundtrip verified RTD-to-J, J-to-K calibration retention, and return to Pt100; see audit section 8.6.

- [x] A new read-only COM17 capture confirms that the instrument remains in the restored baseline: Pt100 2-wire, PID Off, SP 0, Burnout High, LCD `03/02`, write protection `01/FF`, and configuration counter `0x91`. Capture: `trm/tt301/live-read-current-20261015.txt`.

- [x] Offline sensor-profile regression now covers all 12 manual-listed thermocouples and all eight connection codes; the TT301 suite has 134 checks.

- [ ] Remaining instrument/DTM work: LO-/HI+ trim with a reference, measured burnout current, loop electrical limits, Methods page, additional sensor types, and remaining DTM pages.
