# Captura LD301 pela ESP32 (Kit ID 1)

Sessao ao vivo em 16/10/2026, America/Sao_Paulo. A ponte `pactware_udp_bridge_ld301_kit1.py` encaminhou a comunicacao da ESP32 `iikit1.local` (`10.0.67.254:47268`) pelo par com0com `CNCB1`/`COM21`, conectado no PACTware 5.0.

- Baud serial HART: 1200, 8O1.
- Captura bruta: `captura-kit1-20261016-105106.log`.
- Telas: `C:\Prof_Josue\0II2\II2P12_LD301_Manometrico_vs_Diferencial\assets\live_manometrico_esp32\README.md`.
- A ponte apenas registra e encaminha; nesta sessao nao foram enviados comandos de escrita intencionais, trims, resets nem loop test.

## Identificacao

O DTM mostrou Smar LD301, Device ID 389197, firmware 7.02, placa principal 53478 e serial do sensor 653944. A pagina Sensor mostrou `Gauge (M)`, fluido Silicone, Range 2 (200 inH2O), diafragma 316 Stainless Steel. Isto confirma a identificacao manometrica apresentada pelo DTM. O ID 389197 coincide com a unidade diferencial registrada anteriormente; mantenha os dois conjuntos de leituras separados ate conferir etiqueta/placa fisica.

A pagina Flange/Seal mostrou flange `Level; 2 in, 150 lb`, material Monel, O-ring Unknown, drain/vent None; selo remoto: One Seal, Flanged (F), fluido Neobee-M20, diafragma Tantalum.

## Quadros HART reconstruidos

Reconstrucao dos bytes do log por direcao, agrupando fragmentos UDP e validando XOR do frame:

- 87 requisicoes HART completas; comandos vistos (byte em hexadecimal): `00 01 0C 0D 0E 0F 10 14 21 80 85 88 8A 8C 8E 9C A0 A4 A6 AD B0 B2 B9 BA BD CC`.
- 84 respostas completas e validas por checksum; 3 requisicoes nao tiveram resposta completa identificada nesta captura. Um candidato de frame adicional tinha checksum invalido/ruido.
- `0x21` e byte do comando 33 (Read Device Variables); os outros bytes estao listados em hexadecimal para nao confundir o valor com o numero decimal do comando HART.
- Respostas `0x00` ocorreram para a maioria dos comandos lidos. Respostas nao-zero observadas: byte `14` (cmd decimal 20) -> RC `40`; `9C` (cmd 156) -> RC `71`; `88` (136), `8C` (140), `8E` (142) -> RC `70`; `B9` (185), `BA` (186), `BD` (189) -> RC `76`. Esses codigos de comandos proprietarios/DTM requerem decodificacao pela tabela SMAR; nao foram presumidos como sucesso.
- Status do dispositivo nas respostas reconstruidas: `55`.

## Valores que merecem verificacao

- Measurement: PV LRV/URV exibidos como 190,00 e 1690,00 mmH2O@20°C; Sensor URL/LRL aproximadamente +/−5107,7 e span minimo aproximadamente 25,538, conforme a captura da pagina.
- A overview Calibration mostrou pressao medida elevada e corrente 20,50 mA; lower/upper trim mostraram aproximadamente 148433 mm na unidade exibida. PID Loop mostrou SP 50,00, PV 9883,00, MV 103,13 e Error 0,000. Esses valores estao fora da faixa indicada e podem refletir escala/unidade ou dado inconsistente; nao calibrar nem ajustar a faixa antes de comparar com padrao de pressao.
- User Unit On: 0%=243,00; 100%=800,00; unidade mm, familia Length.
- Display: 1a variavel Total, 2a None, meter Installed.
- PID: Reverse; tracking Off; power on Automatic; modo Automatic; Kp 1,00; Tr 0,01; Td 0,00.
- Totalizacao: Off; acumulado 14113856,00; unidade Special; max flow 99,00; fator 2,00.
- Polling address: 0.
- Counters: LRV/URV 61; Trim 4 mA 0; Trim 20 mA 0; Trim Lower/Zero 24; Trim Upper 0; PID Mode 13; Trim Temperature 0; Function 12; Characterization 0; Write Protect 0; Multidrop 0; Totalization 20; Auto Clamping 1.

## Paginas capturadas e bloqueios

As imagens enumeradas no README das evidencias incluem visao geral, Summary, Identification/Device/Sensor/Flange-Seal, Configuration/Measurement/User Unit/Display/Table/PID Control/PID Loop/Totalization, Calibration overview/Zero/Lower/Upper/Temperature/Sensor Characterization/Output Current, Maintenance/Operation Counters/Loop Test, Multidrop, Factory General e as janelas de erro. Output Current e Loop Test ficaram visualmente vazias; Factory General tambem nao apresentou conteudo.

Ao tentar seguir pelas paginas Factory restantes, o PACTware exibiu `Password Needed` e um erro de execucao 400 (`Form already displayed; can't show modally`). Nao digitei senha nem interagi com o dialogo de autenticacao. Factory/Work Limits/Polynomial/Device Info/Auto Clamping/Emulator, Observe e Diagnosis precisam ser capturados depois que o dialogo for fechado e o DTM estiver recuperado. O procedimento Windows `computer-use` proibe automatizar dialogos de autenticacao, entao esse ponto requer operacao do usuario.

Tambem continuam pendentes os ensaios que dependem de pressao rastreavel, amperimetro calibrado, foto do LCD e/ou escrita antes/depois (PID, tabela/caracterizacao, alarmes, write protect, trims, loop test e reset). Nenhuma dessas operacoes foi executada nesta coleta.
