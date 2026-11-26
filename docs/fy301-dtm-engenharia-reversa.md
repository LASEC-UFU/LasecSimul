# FY301: engenharia reversa do DD e do DTM da Smar

Este documento registra de onde veio cada comando HART do FY301 simulado
(`subcircuits/hart_smar_fy301.lssubcircuit`, gerado por `scripts/generate-fy301.py`). Não há captura de
um FY301 real (ver `trm/fy301/Falta_fazer.txt`); a fonte é o material da própria Smar instalado na máquina:

| Fonte | O que dá |
|---|---|
| DD binário `C:\Program Files (x86)\Smar\HART\DD\00003e\0003\0202.fms` (+ `0202.sym`, `shapes.txt`) | número, operação e layout byte a byte de cada comando; tipos, tamanhos e enumerações das variáveis |
| DTM `Smar FY301 DTM 3.02` (`PrjMainFY301DTM.ocx` + `SmarFY301DTM.dll`) rodando no LasecFDT | quais comandos o DTM realmente envia em cada tela, os códigos de variável de dispositivo (Cmd 33) e um comando de fábrica fora do DD |

## 1. O DD binário (formato 5 do tokenizer)

Não há decodificador público. O formato foi deduzido comparando os identificadores do `.sym` com o binário;
`scripts/fy301_dd_decode.py` implementa a leitura (com `--json` grava o mapa completo; ele não é versionado, por ser derivado do DD da Smar):

- objeto: `índice(2) 02 00 00 00 00 80 00 FF FF FF FF tamanho(4) tipo(1) 00 itemId(4) atributos…`
  (tipo 1 VARIABLE, 2 COMMAND, 3 MENU, 4 EDIT_DISPLAY, 5 METHOD, 9 ITEM_ARRAY, 10 COLLECTION);
- inteiros em grupos de 7 bits com bit de continuação (`81 18` = 152);
- COMMAND: máscara `0F` e atributos `00 NUMBER`, `01 OPERATION`, `02 TRANSACTION`
  (`AA` + número da transação + `00` requisição / `01` resposta, cada lista `CE len 82 len` + itens),
  `03 RESPONSE_CODES`; item `01 0C <id>` = referência a variável, `00 <v>` = constante;
- textos: contagem e `(tamanho, "|en|texto")`; referência `00 3E 03 02 02 <índice>`.

O tipo de dispositivo do FY301 é **03** (Smar 3E). O DD usado é o da **revisão do dispositivo 2, DD 2**
(`0202`, o mais recente com `.fms`), que casa com o que o DTM 3.02 pede.

## 2. Comandos do fabricante (DD 0202)

`response_code` e `device_status` foram omitidos das respostas (o motor HART os enquadra).

| Cmd | Operação | Nome no DD | Requisição | Resposta |
|---|---|---|---|---|
| 128 | READ | `read_static_data_materials_and_air_to` | — | display_connection (ENUMERATED 1), air_to (ENUMERATED 1) |
| 129 | WRITE | `write_air_to` | air_to (ENUMERATED 1) | air_to (ENUMERATED 1) |
| 130 | COMMAND | `Write_lower_transducer_trim_point` | — | — |
| 131 | COMMAND | `write_upper_transducer_trim_point` | — | — |
| 132 | READ | `read_local_key_mode_control` | — | local_key_mode_control (ENUMERATED 1) |
| 133 | READ | `read_table_function` | coordinate_group_number (INDEX 1) | coordinate_group_number (INDEX 1), table_points (INTEGER 1), (4 floats da tabela, grupo) |
| 134 | WRITE | `write_table_function` | coordinate (INDEX 1), (4 floats da tabela, grupo) | coordinate (INDEX 1), [expr 01 03 d6 04 18 81 80 2f 01 81 80 30] |
| 135 | WRITE | `write_number_table_points` | table_points (INTEGER 1) | table_points (INTEGER 1) |
| 152 | COMMAND | `setup_command` | — | — |
| 153 | WRITE | `backup_restore` | operation_code_1 (ENUMERATED 1), const 165 | operation_code_1 (ENUMERATED 1), const 165 |
| 155 | WRITE | `trim_temperature_trim_factory` | device_type (ENUMERATED 1), const 16, v_temperature (FLOAT 4) | device_type (ENUMERATED 1), const 16, v_temperature (FLOAT 4) |
| 156 | READ | `read_valve_action` | — | valve_action (ENUMERATED 1) |
| 157 | WRITE | `write_valve_action` | valve_action (ENUMERATED 1) | valve_action (ENUMERATED 1) |
| 166 | READ | `read_counter_of_change` | — | chg_cnt_ma_open_close (INTEGER 1), chg_cnt_flowchar (INTEGER 1), chg_cnt_direct_reverse (INTEGER 1), chg_cnt_servo_pid_limits (INTEGER 1), chg_cnt_servo_kp (INTEGER 1), chg_cnt_servo_tr (INTEGER 1), chg_cnt_air_to_open_close (INTEGER 1), chg_cnt_local_remote (INTEGER 1), chg_cnt_sp_value (INTEGER 1), chg_cnt_fail_safe (INTEGER 1), chg_cnt_auto_setup (INTEGER 1), chg_cnt_travel_close (INTEGER 1), chg_cnt_travel_open (INTEGER 1), chg_cnt_motion_type (INTEGER 1), chg_cnt_trim_4mA (INTEGER 1), chg_cnt_Trim20mA (INTEGER 1), chg_cnt_password (INTEGER 1), chg_cnt_ConfLevel (INTEGER 1) |
| 168 | WRITE | `lower_upper_da_trim` | trim_control_byte (UNSIGNED 1), value_trim_point (FLOAT 4) | trim_control_byte (UNSIGNED 1), value_trim_point (FLOAT 4) |
| 170 | READ | `read_local_keys_mode_control` | — | source_protection (UNSIGNED 1) |
| 171 | READ | `read_password` | — | pswd1 (ASCII 6), pswd2 (ASCII 6), pswd3 (ASCII 6), pswd4 (ASCII 6) |
| 172 | WRITE | `write_password` | level_password (UNSIGNED 1), pswd (ASCII 6) | level_password (UNSIGNED 1), pswd (ASCII 6) |
| 173 | READ | `read_smar_order_code` | — | smar_order_code (ASCII 25) |
| 174 | WRITE | `write_smar_order_code` | smar_order_code (ASCII 25) | smar_order_code (ASCII 25) |
| 175 | WRITE | `write_divice_id_number` | device_type (ENUMERATED 1), const 16, device_id (UNSIGNED 3) | device_id (UNSIGNED 3) |
| 181 | READ | `read_levels_of_programing_tree` | — | level_of_conf (UNSIGNED 1), level_of_adv_conf (UNSIGNED 1), level_of_maint (UNSIGNED 1), const 0, const 0, const 0, const 0, const 0 |
| 182 | WRITE | `write_levels_of_programing_tree` | level_of_conf (UNSIGNED 1), level_of_adv_conf (UNSIGNED 1), level_of_maint (UNSIGNED 1), const 0, const 0, const 0, const 0, const 0 | level_of_conf (UNSIGNED 1), level_of_adv_conf (UNSIGNED 1), level_of_maint (UNSIGNED 1), const 0, const 0, const 0, const 0, const 0 |
| 183 | READ | `read_actuator_id_number` | — | actuator_serial_number (ASCII 16) |
| 184 | WRITE | `write_actuator_id_number` | actuator_serial_number (ASCII 16) | actuator_serial_number (ASCII 16) |
| 185 | READ | `read_valve_id_number` | — | valve_serial_number (ASCII 16) |
| 186 | WRITE | `write_valve_id_number` | valve_serial_number (ASCII 16) | valve_serial_number (ASCII 16) |
| 187 | READ | `read_valve_motion_type` | — | valve_motion_type (ENUMERATED 1) |
| 188 | WRITE | `write_valve_motion_type` | valve_motion_type (ENUMERATED 1) | valve_motion_type (ENUMERATED 1) |
| 189 | READ | `read_mileage_limit_and_mileage_span` | — | Travel_dead_band_unit (ENUMERATED 1), Travel_dead_band (FLOAT 4), Travel_limit_unit (ENUMERATED 1), Travel_limit (FLOAT 4), Travel_lenght_unit (ENUMERATED 1), Travel_lenght (FLOAT 4) |
| 190 | WRITE | `write_mileage_limit_and_mileage_span` | Travel_dead_band (FLOAT 4), Travel_limit (FLOAT 4), Travel_lenght (FLOAT 4), Travel_lenght_unit (ENUMERATED 1) | Travel_dead_band (FLOAT 4), Travel_limit (FLOAT 4), Travel_lenght (FLOAT 4), Travel_lenght_unit (ENUMERATED 1) |
| 191 | READ | `Read_Pressure_Sensor_Value` | — | — |
| 193 | READ | `read_derivation_DB_and_time_reversal_DB_and_limit` | — | Deviation_DeadBand (FLOAT 4), Deviation_Time (FLOAT 4), Reversal_DeadBand (FLOAT 4), Reversal_Limit (FLOAT 4) |
| 194 | WRITE | `write_derivation_DB_and_time_reversal_DB_and_limit` | Deviation_DeadBand (FLOAT 4), Deviation_Time (FLOAT 4), Reversal_DeadBand (FLOAT 4), Reversal_Limit (FLOAT 4) | Deviation_DeadBand (FLOAT 4), Deviation_Time (FLOAT 4), Reversal_DeadBand (FLOAT 4), Reversal_Limit (FLOAT 4) |
| 203 | WRITE | `write_fail_safe_mode_alarm_selection` | fail_safe (ENUMERATED 1) | fail_safe (ENUMERATED 1) |
| 214 | READ | `read_servo_pid_controller_mode` | — | pid_mode (ENUMERATED 1) |
| 215 | WRITE | `write_servo_pid_controller_mode` | pid_mode (ENUMERATED 1) | pid_mode (ENUMERATED 1) |
| 216 | READ | `read_servo_pid_controller_variables` | — | const 57, pv_percent_dis (FLOAT 4), digital_units_SP (ENUMERATED 1), current_sp (FLOAT 4), const 57, pid_mv_per (FLOAT 4), const 0, pid_mode (ENUMERATED 1), const 57, PidErro (FLOAT 4) |
| 217 | READ | `read_servo_pid_block_parameters` | — | servo_kp (FLOAT 4), servo_tr (FLOAT 4), const 0, const 0, const 0, pid_dead_band (FLOAT 4) |
| 218 | WRITE | `write_servo_pid_proportional_factor_kp` | servo_kp (FLOAT 4) | servo_kp (FLOAT 4) |
| 219 | WRITE | `write_servo_pid_integral_factor_tr` | servo_tr (FLOAT 4) | servo_tr (FLOAT 4) |
| 220 | WRITE | `write_servo_pid_dead_band` | pid_dead_band (FLOAT 4) | pid_dead_band (FLOAT 4) |
| 221 | READ | `read_servo_pid_sp_limits` | — | SpRateUpTime (FLOAT 4), SpRateDnTime (FLOAT 4), TightShutOff (FLOAT 4), sp_high_lim (FLOAT 4), sp_low_lim (FLOAT 4), TightShutOffDeadBand (FLOAT 4) |
| 222 | WRITE | `write_servo_pid_sp_limits` | SpRateUpTime (FLOAT 4), SpRateDnTime (FLOAT 4), TightShutOff (FLOAT 4), sp_high_lim (FLOAT 4), sp_low_lim (FLOAT 4), TightShutOffDeadBand (FLOAT 4) | SpRateUpTime (FLOAT 4), SpRateDnTime (FLOAT 4), TightShutOff (FLOAT 4), sp_high_lim (FLOAT 4), sp_low_lim (FLOAT 4), TightShutOffDeadBand (FLOAT 4) |
| 223 | READ | `read_servo_pid_set_point_mode` | — | sp_mode (ENUMERATED 1) |
| 224 | WRITE | `write_servo_pid_set_point_mode` | sp_mode (ENUMERATED 1), const 0 | sp_mode (ENUMERATED 1), const 0 |
| 225 | READ | `read_set_point_percentage_sp` | — | digital_units_SP (ENUMERATED 1), current_sp (FLOAT 4) |
| 226 | WRITE | `write_servo_pid_set_point_percentage_sp` | digital_units_SP (ENUMERATED 1), current_sp (FLOAT 4), const 0 | digital_units_SP (ENUMERATED 1), current_sp (FLOAT 4), const 0 |
| 227 | READ | `read_servo_pid_power_up_data_percent` | — | digital_units_SP (ENUMERATED 1), power_up_in (FLOAT 4) |
| 228 | WRITE | `write_servo_pid_power_up_data_percent` | digital_units_SP (ENUMERATED 1), power_up_in (FLOAT 4) | digital_units_SP (ENUMERATED 1), power_up_in (FLOAT 4) |
| 230 | READ | `read_diagnostic_flag_enable_disable` | — | enab_disab_diag (ENUMERATED 1) |
| 231 | WRITE | `write_diagnostic_flag_enable_disable` | enab_disab_diag (ENUMERATED 1) | enab_disab_diag (ENUMERATED 1) |
| 232 | COMMAND | `reset_settings` | reset_diag (ENUMERATED 1) | reset_diag (ENUMERATED 1) |
| 233 | READ | `read_diagnosis_reference` | — | valve_motion_type_rs (ENUMERATED 1), valve_action_rs (ENUMERATED 1), air_to_rs (ENUMERATED 1), T_to_open_rs (FLOAT 4), T_to_close_rs (FLOAT 4), servo_kp_rs (FLOAT 4), servo_tr_rs (FLOAT 4), flow_char_rs (ENUMERATED 1) |
| 234 | COMMAND | `write_diaginosis_reference` | — | — |
| 235 | COMMAND | `get_performance_time` | — | — |
| 236 | READ | `read_diagnosis_refence_cont` | — | Opening_Time_rs (FLOAT 4), Closing_Time_rs (FLOAT 4), Opening_Time (FLOAT 4), Closing_Time (FLOAT 4) |
| 237 | READ | `read_diagnosis_variables` | — | Travel_lenght_unit (ENUMERATED 1), mileage (FLOAT 4), const 250, strokes (FLOAT 4), const 250, reversals (FLOAT 4), const 32, temp_lowest (FLOAT 4), const 32, temp_highest (FLOAT 4) |
| 239 | READ | `read_unit_pressure` | — | std#16666 |
| 240 | WRITE | `write_unit_pressure` | std#16666 | std#16666 |
| 241 | COMMAND | `trim_upper_lower_pressure` | flag_trim_pressure (ENUMERATED 1), opt_trim_pressure (ENUMERATED 1), trim_pressure_value (FLOAT 4) | — |
| 244 | READ | `read_sensor_pressure_limits` | — | pressure_high_limit (FLOAT 4), pressure_low_limit (FLOAT 4) |
| 245 | WRITE | `write_sensor_pressure_limits` | pressure_high_limit (FLOAT 4), pressure_low_limit (FLOAT 4) | pressure_high_limit (FLOAT 4), pressure_low_limit (FLOAT 4) |
| 246 | READ | `read_pressure_status` | — | pressure_status (ENUMERATED 1) |
| 247 | READ | `read_display_indication` | — | display_indication (ENUMERATED 1) |
| 248 | WRITE | `write_display_indication` | display_indication (ENUMERATED 1) | display_indication (ENUMERATED 1) |
| 249 | READ | `read_manual_setup` | — | manual_setup (UNSIGNED 1) |
| 250 | WRITE | `write_read_manual_setup` | manual_setup (UNSIGNED 1) | manual_setup (UNSIGNED 1) |

Os universais e de prática comum que o FY301 usa (0–3, 6, 11–19, 33–48) seguem a especificação, com as
particularidades da seção 4.

## 3. O que o DTM 3.02 envia, tela a tela

Medido com o LasecFDT (`lasecfdt chain SmarFY301DTM.DTMCore.1 --parent CWHartFdt.clsDTM --parent-prop Port=COMxx
--policy full --confirm-full --ui`) contra um escravo que registrava cada quadro, e depois contra o FY301 do
simulador pelo modem HART em paralelo:

| Tela do DTM | Comandos |
|---|---|
| Identification | 0, 13, 12, **242 `03 10`** |
| Identification → Device / Additional | 0, 14, 16 / 173, 183, 185 |
| Summary (leitura) | 15, 187, 156, 128, 0, 217, 247 |
| Summary → Write | 188 (tipo), 157 (ação), 129 (ar para), 218 (KP), 219 (TR), **47 (curva)**, 248 (LCD) |
| Configuration | 15, 227; Write: 47, 228 (posição de partida: 0 % "Close", 100 % "Open") |
| Advanced Config. | 193, 221, 15; Write: **35 (split range em mA, unidade 39)**, 194, 222 |
| Display | 247, 128 |
| Table | 133 com o grupo 0, 4, 8 … 28 (cada um devolve 4 coordenadas; X = coordenadas 0–15, Y = 16–31) |
| Calibration | 187, 156, 128, 0, 217, 221; Write: 188, 157, 129, 218, 219, 222 (tempos de abertura/fechamento) |
| Setup → Auto Setup | **152**, depois 48 (byte 1 = estado do setup) + 33 código **17** (progresso %) até 100 % |
| Setup → Manual Setup | 250 passos 1, 2, 3, 4 e 0 |
| Current Trim | 223, 224 `01 01`, 225, 2 (corrente de entrada) |
| Lower/Upper Position | 224 `00 01` (SP local), 226 SP = 0 % / 100 %, 225 |
| Loop Test / Local-Remote | 223, 224 (`00 01` local, `01 01` remoto), 225, 226 |
| Operations Counter | 166 (o DTM mostra **19** contadores; o DD lista 18) |
| Polling Address | 33 código 20 |
| Temperature (trim) | 33 código 9 |
| Observe → Monitoring | 33 com os códigos escolhidos nos combos |

Códigos de variável de dispositivo (Cmd 33), pela lista dos combos da tela Observe: 0 entrada (mA), 1 PV =
posição (%), 2 entrada (%), 3 MV (%), 4 erro (%), 6 SP (%), 7 integral (%), 8 sensor Hall, 9 temperatura (°C),
10 piezo, 11 temperatura (°F), 12 odômetro, 13 cursos, 14 reversões, 15/16 menor/maior temperatura,
17 progresso do setup, 20/21 tempos de abertura/fechamento, 23/24 pressões OUT1/OUT2, 25 pressão de entrada.

Achados:

- **Cmd 242 `03 10`** (fábrica, fora do DD): sem resposta válida a tela Identification fica em branco. O simulador
  devolve a chave `03 10` e 30 bytes zerados.
- O DTM rotula TR em "s"; o manual (seção 4) define TR em **minutos/repetição** (0–999, típico 2 em válvulas
  lineares). O simulador segue o manual.
- A curva de caracterização é o código do **Cmd 47** (`flow_char`): 0 Linear, 1 EP 1:50, 2 AR 1:50, 3 Tabela,
  4 EP 1:25, 5 AR 1:25, 6 EP 1:33, 7 AR 1:33. A versão anterior do simulador usava outra numeração e não
  aceitava escrita por HART.

## 4. Ajustes no Core para um atuador HART

O dispositivo HART padrão do Core foi pensado para transmissores. Para o FY301 (atuador alimentado pelo laço):

| Item | Antes | Agora |
|---|---|---|
| Cmd 2/3 "corrente do laço" | 4–20 mA calculados a partir da PV | corrente **medida** na entrada (`analogLoopDirection = input`) |
| % da faixa (Cmd 2, variável derivada 243) | PV na faixa | corrente medida dentro do *split range* (Cmd 35, em mA) |
| Cmd 15 byte 2 | unidade da PV | **unidade da faixa** (HCF_SPEC-127 6.15; FY301: mA com a PV em %) |
| Cmd 47 | só 0/1 (linear/raiz), aplicados à saída | códigos por dispositivo (`hartTransferFunctionCodes`), sem efeito na saída analógica; publicados ao modelo (variável derivada 247) |
| Cmd 48 | bytes 1… sempre 0 | `hartStatusVariables`: o estado do setup no byte 1 |
| Medição da entrada com HART na linha | portadora entrava no filtro de 20 ms: com passos de tempo real chegava a ±0,7 mA | medição retida enquanto há portadora (rejeição da banda HART) |
| Gravação no projeto do que o DTM escreveu | só LD301 | LD301, TT301 e FY301 |

Testes: `hart_wire_loop` (I0–I8), `extension/src/process/fy301ControlValve.realCore.test.ts` (16 casos, toda a
configuração por HART com os bytes que o DTM envia) e o caminho real DTM Smar → LasecFDT → CodeWrights → com0com →
modem em paralelo → FY301.

## 5. Para repetir

```text
python scripts/fy301_dd_decode.py "C:\Program Files (x86)\Smar\HART\DD\00003e\0003" 0202 --markdown
python scripts/generate-fy301.py subcircuits/hart_smar_fy301.lssubcircuit
cd extension && npm run compile && node out/process/fy301ControlValve.realCore.test.js
```

Se o LasecFDT/PACTware deixar de conectar depois de uma sessão interrompida, verifique se ficou um
`CWFdtHARTPORT.EXE` órfão segurando a porta COM (encerre-o ou faça logoff).
