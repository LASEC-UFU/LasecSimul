# Inventário técnico do catálogo gráfico

Fonte: `project/schema/component-catalog.json` (entrada atual no workspace). Gerado por leitura do catálogo; não é juízo de conformidade. Propriedades abaixo são IDs de `propertySchema`, não valores default. Símbolos `graphics.pid.*` são desenhos estáticos, não modelos de equipamentos.

**Contagens:** 244 `graphics.*`; 239 com pacote declarativo; 5 primitivas especiais; 193 P&ID; 10 HMI; 30 com `bindSource`; 7 com `actionTarget`; 1 com pinos.

| ID | Categoria/pasta | Pinos | Pacote | Campos de binding/ação | Propriedades declaradas |
|---|---|---:|:---:|---|---|
| `graphics.alarm_indicator` | Grafico / Controles/Indicadores | 0 | sim | bindSource | bindChannel, bindDecimals, bindInvert, bindMax, bindMin, bindOffset, bindScale, bindSource, bindThreshold, bindUnit, fill, height, opacity, stroke, strokeWidth, text, value, width |
| `graphics.arrow` | Grafico / Conexoes | 0 | sim |  | height, opacity, stroke, strokeWidth, width |
| `graphics.check_valve` | Grafico / Valvulas | 0 | sim |  | fill, height, opacity, stroke, strokeWidth, tag, width |
| `graphics.controller_faceplate` | Grafico / Instrumentos | 0 | sim | bindSource | barColor, bindChannel, bindDecimals, bindMax, bindMin, bindOffset, bindScale, bindSource, bindUnit, fill, height, opacity, setpoint, showValue, stroke, strokeWidth, tag, value, width |
| `graphics.controller_station` | Grafico / SupervisÃ³rio Industrial | 0 | sim | bindSource | bindChannel, bindDecimals, bindMax, bindMin, bindOffset, bindScale, bindSource, bindUnit, fill, height, opacity, setpoint, showValue, stroke, strokeWidth, tag, value, width |
| `graphics.conveyor` | Grafico / Equipamento de Processo | 0 | sim | bindSource | bindChannel, bindDecimals, bindInvert, bindMax, bindMin, bindOffset, bindScale, bindSource, bindThreshold, bindUnit, fill, height, opacity, stroke, strokeWidth, value, width |
| `graphics.ellipse` | Grafico / Formas Basicas | 0 | primitiva |  |  |
| `graphics.equipment` | Grafico / Equipamento de Processo | 0 | sim |  | fill, height, label, labelSize, opacity, showBorder, stroke, strokeWidth, width |
| `graphics.flow_arrow` | Grafico / Elementos de Fluxo | 0 | sim |  | fill, height, opacity, stroke, strokeWidth, width |
| `graphics.flow_transmitter` | Grafico / SupervisÃ³rio Industrial | 0 | sim | bindSource | bindChannel, bindDecimals, bindMax, bindMin, bindOffset, bindScale, bindSource, bindUnit, fill, height, opacity, showValue, stroke, strokeWidth, tag, value, width |
| `graphics.gauge_bar` | Grafico / Controles/Indicadores | 0 | sim | bindSource | barColor, bindChannel, bindDecimals, bindMax, bindMin, bindOffset, bindScale, bindSource, bindUnit, fill, height, opacity, showValue, stroke, strokeWidth, value, width |
| `graphics.group_box` | Grafico / Controles/Indicadores | 0 | sim |  | fill, height, maskFill, opacity, stroke, strokeWidth, title, titleSize, titleWidth, width |
| `graphics.heat_exchanger` | Grafico / Tanques e Vasos | 0 | sim |  | fill, height, opacity, stroke, strokeWidth, width |
| `graphics.hmi.alarm_banner` | Grafico / Controles/Indicadores | 0 | sim | bindSource | bindChannel, bindDecimals, bindMax, bindMin, bindOffset, bindScale, bindSource, bindUnit, fill, height, limitH, limitHH, limitL, limitLL, message, opacity, stroke, tag, value, width |
| `graphics.hmi.bar` | Grafico / Controles/Indicadores | 0 | sim | bindSource | bindChannel, bindChannelB, bindDecimals, bindDecimalsB, bindMax, bindMaxB, bindMin, bindMinB, bindOffset, bindOffsetB, bindScale, bindScaleB, bindSource, bindSourceB, bindUnit, bindUnitB, fill, height, limitH, limitHH, limitL, limitLL, opacity, stroke, tag, value, valueB, width |
| `graphics.hmi.display` | Grafico / Controles/Indicadores | 0 | sim | bindSource | bindChannel, bindChannelB, bindDecimals, bindDecimalsB, bindMax, bindMaxB, bindMin, bindMinB, bindOffset, bindOffsetB, bindScale, bindScaleB, bindSource, bindSourceB, bindUnit, bindUnitB, fill, height, limitH, limitHH, limitL, limitLL, opacity, showSp, stroke, tag, value, valueB, width |
| `graphics.hmi.faceplate` | Grafico / Controle | 0 | sim | bindSource | bindChannel, bindChannelB, bindChannelC, bindDecimals, bindDecimalsB, bindDecimalsC, bindMax, bindMaxB, bindMaxC, bindMin, bindMinB, bindMinC, bindOffset, bindOffsetB, bindOffsetC, bindScale, bindScaleB, bindScaleC, bindSource, bindSourceB, bindSourceC, bindUnit, bindUnitB, bindUnitC, fill, height, limitH, limitHH, limitL, limitLL, mode, opacity, stroke, tag, value, valueB, valueC, width |
| `graphics.hmi.gauge` | Grafico / Controles/Indicadores | 0 | sim | bindSource | bindChannel, bindDecimals, bindMax, bindMin, bindOffset, bindScale, bindSource, bindUnit, fill, height, limitH, limitHH, limitL, limitLL, opacity, stroke, tag, value, width |
| `graphics.hmi.lamp` | Grafico / Controles/Indicadores | 0 | sim | bindSource | bindChannel, bindDecimals, bindInvert, bindMax, bindMin, bindOffset, bindScale, bindSource, bindThreshold, bindUnit, fill, height, label, opacity, stroke, value, width |
| `graphics.hmi.panel` | Grafico / Layout | 0 | sim |  | fill, height, opacity, stroke, title, width |
| `graphics.hmi.pump` | Grafico / Equipamentos | 0 | sim | bindSource | bindChannel, bindDecimals, bindInvert, bindMax, bindMin, bindOffset, bindScale, bindSource, bindThreshold, bindUnit, fill, height, opacity, outOfService, stroke, tag, tripped, value, width |
| `graphics.hmi.tank` | Grafico / Equipamentos | 0 | sim | bindSource | bindChannel, bindDecimals, bindMax, bindMin, bindOffset, bindScale, bindSource, bindUnit, fill, height, limitH, limitHH, limitL, limitLL, opacity, shape, stroke, tag, value, width |
| `graphics.hmi.valve` | Grafico / Equipamentos | 0 | sim | bindSource | bindChannel, bindDecimals, bindInvert, bindMax, bindMin, bindOffset, bindScale, bindSource, bindThreshold, bindUnit, fill, height, opacity, stroke, tag, throttle, value, width |
| `graphics.hmi_button` | Grafico / Controles/Indicadores | 0 | sim | actionTarget | actionMax, actionMin, actionMode, actionProperty, actionReleaseValue, actionStep, actionTarget, actionValue, fill, height, opacity, stroke, strokeWidth, text, width |
| `graphics.hmi_lamp_button` | Grafico / Controles/Indicadores | 0 | sim | bindSource, actionTarget | actionMax, actionMin, actionMode, actionProperty, actionReleaseValue, actionStep, actionTarget, actionValue, bindChannel, bindDecimals, bindInvert, bindMax, bindMin, bindOffset, bindScale, bindSource, bindThreshold, bindUnit, fill, height, offColor, onColor, opacity, stroke, strokeWidth, value, width |
| `graphics.hmi_switch` | Grafico / Controles/Indicadores | 0 | sim | bindSource, actionTarget | actionMax, actionMin, actionMode, actionProperty, actionReleaseValue, actionStep, actionTarget, actionValue, bindChannel, bindDecimals, bindInvert, bindMax, bindMin, bindOffset, bindScale, bindSource, bindThreshold, bindUnit, fill, height, opacity, stroke, strokeWidth, value, width |
| `graphics.hmi_toggle` | Grafico / Controles/Indicadores | 0 | sim | bindSource, actionTarget | actionMax, actionMin, actionMode, actionProperty, actionReleaseValue, actionStep, actionTarget, actionValue, bindChannel, bindDecimals, bindInvert, bindMax, bindMin, bindOffset, bindScale, bindSource, bindThreshold, bindUnit, fill, height, offText, onText, opacity, stroke, strokeWidth, value, width |
| `graphics.hopper` | Grafico / Tanques e Vasos | 0 | sim | bindSource | bindChannel, bindDecimals, bindMax, bindMin, bindOffset, bindScale, bindSource, bindUnit, fill, height, liquidColor, opacity, showValue, stroke, strokeWidth, value, width |
| `graphics.image` | Grafico / Formas Basicas | 0 | primitiva |  | height, path, width |
| `graphics.instrument` | Grafico / Instrumentos | 0 | sim | bindSource | bindChannel, bindDecimals, bindMax, bindMin, bindOffset, bindScale, bindSource, bindUnit, fill, height, housing, location, opacity, showValue, stroke, strokeWidth, tag, tagNumber, value, width |
| `graphics.label` | Grafico / Texto e Rotulos | 0 | sim | bindSource | align, bindChannel, bindDecimals, bindMax, bindMin, bindOffset, bindScale, bindSource, bindUnit, fill, fontSize, height, opacity, showBox, stroke, text, value, width |
| `graphics.level_bar` | Grafico / Controles/Indicadores | 0 | sim | bindSource | barColor, bindChannel, bindDecimals, bindMax, bindMin, bindOffset, bindScale, bindSource, bindUnit, fill, height, highLimit, lowLimit, opacity, showLimits, showValue, stroke, strokeWidth, value, width |
| `graphics.line` | Grafico / Formas Basicas | 0 | primitiva |  |  |
| `graphics.numeric_input` | Grafico / Controles/Indicadores | 0 | sim | bindSource, actionTarget | actionMax, actionMin, actionMode, actionProperty, actionReleaseValue, actionStep, actionTarget, actionValue, bindChannel, bindDecimals, bindMax, bindMin, bindOffset, bindScale, bindSource, bindUnit, fill, height, label, opacity, stroke, strokeWidth, value, width |
| `graphics.orifice_plate` | Grafico / Elementos de Fluxo | 0 | sim |  | fill, height, opacity, stroke, strokeWidth, width |
| `graphics.pid.acc_afr` | P&ID / AcessÃ³rios | 0 | sim |  | height, opacity, width |
| `graphics.pid.acc_bimetal` | P&ID / AcessÃ³rios | 0 | sim |  | height, opacity, width |
| `graphics.pid.acc_bulb` | P&ID / AcessÃ³rios | 0 | sim |  | height, opacity, width |
| `graphics.pid.acc_floatcage` | P&ID / AcessÃ³rios | 0 | sim |  | height, opacity, width |
| `graphics.pid.acc_lg` | P&ID / AcessÃ³rios | 0 | sim |  | height, opacity, width |
| `graphics.pid.acc_loadcell` | P&ID / AcessÃ³rios | 0 | sim |  | height, opacity, width |
| `graphics.pid.acc_pg` | P&ID / AcessÃ³rios | 0 | sim |  | height, opacity, width |
| `graphics.pid.acc_radar` | P&ID / AcessÃ³rios | 0 | sim |  | height, opacity, width |
| `graphics.pid.acc_seal` | P&ID / AcessÃ³rios | 0 | sim |  | height, opacity, width |
| `graphics.pid.acc_siphon` | P&ID / AcessÃ³rios | 0 | sim |  | height, opacity, width |
| `graphics.pid.acc_thermowell` | P&ID / AcessÃ³rios | 0 | sim |  | height, opacity, width |
| `graphics.pid.agitator` | P&ID / MÃ¡quinas | 0 | sim |  | height, opacity, width |
| `graphics.pid.air_dryer` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.ann_arrow` | P&ID / AnotaÃ§Ã£o | 0 | sim |  | height, opacity, width |
| `graphics.pid.ann_bl_flag` | P&ID / AnotaÃ§Ã£o | 0 | sim |  | height, opacity, width |
| `graphics.pid.ann_cloud` | P&ID / AnotaÃ§Ã£o | 0 | sim |  | height, opacity, width |
| `graphics.pid.ann_detail_flag` | P&ID / AnotaÃ§Ã£o | 0 | sim |  | height, opacity, width |
| `graphics.pid.ann_equipstrip` | P&ID / AnotaÃ§Ã£o | 0 | sim |  | height, opacity, width |
| `graphics.pid.ann_holds` | P&ID / AnotaÃ§Ã£o | 0 | sim |  | height, opacity, width |
| `graphics.pid.ann_insulation` | P&ID / AnotaÃ§Ã£o | 0 | sim |  | height, opacity, width |
| `graphics.pid.ann_matchline` | P&ID / AnotaÃ§Ã£o | 0 | sim |  | height, opacity, width |
| `graphics.pid.ann_noteflag` | P&ID / AnotaÃ§Ã£o | 0 | sim |  | height, opacity, width |
| `graphics.pid.ann_offpage` | P&ID / AnotaÃ§Ã£o | 0 | sim |  | height, opacity, width |
| `graphics.pid.ann_onpage` | P&ID / AnotaÃ§Ã£o | 0 | sim |  | height, opacity, width |
| `graphics.pid.ann_revtriangle` | P&ID / AnotaÃ§Ã£o | 0 | sim |  | height, opacity, width |
| `graphics.pid.ann_slope` | P&ID / AnotaÃ§Ã£o | 0 | sim |  | height, opacity, width |
| `graphics.pid.ann_text` | P&ID / AnotaÃ§Ã£o | 0 | sim |  | height, opacity, width |
| `graphics.pid.ann_tiein` | P&ID / AnotaÃ§Ã£o | 0 | sim |  | height, opacity, width |
| `graphics.pid.bagfilter` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.bl_terminal` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.blender_ribbon` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.blower` | P&ID / MÃ¡quinas | 0 | sim |  | height, opacity, width |
| `graphics.pid.boiler` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.bpcv` | P&ID / SeguranÃ§a | 0 | sim |  | height, opacity, width |
| `graphics.pid.breather` | P&ID / SeguranÃ§a | 0 | sim |  | height, opacity, width |
| `graphics.pid.bucket_elevator` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.centrifuge` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.chiller` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.clarifier` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.coalescer` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.comp_centrifugal` | P&ID / MÃ¡quinas | 0 | sim |  | height, opacity, width |
| `graphics.pid.comp_recip` | P&ID / MÃ¡quinas | 0 | sim |  | height, opacity, width |
| `graphics.pid.comp_screw` | P&ID / MÃ¡quinas | 0 | sim |  | height, opacity, width |
| `graphics.pid.conveyor_belt` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.conveyor_screw` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.cooling_tower` | P&ID / Troca TÃ©rmica | 0 | sim |  | height, opacity, width |
| `graphics.pid.crusher` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.crystallizer` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.ctl_dcs` | P&ID / Controle | 0 | sim |  | height, opacity, width |
| `graphics.pid.ctl_interlock` | P&ID / Controle | 0 | sim |  | height, opacity, width |
| `graphics.pid.ctl_jb` | P&ID / Controle | 0 | sim |  | height, opacity, width |
| `graphics.pid.ctl_panel` | P&ID / Controle | 0 | sim |  | height, opacity, width |
| `graphics.pid.ctl_plc` | P&ID / Controle | 0 | sim |  | height, opacity, width |
| `graphics.pid.ctl_sis` | P&ID / Controle | 0 | sim |  | height, opacity, width |
| `graphics.pid.cv_ball` | P&ID / VÃ¡lvulas de Controle | 0 | sim |  | actuator, fail, height, opacity, positioner, width |
| `graphics.pid.cv_butterfly` | P&ID / VÃ¡lvulas de Controle | 0 | sim |  | actuator, fail, height, opacity, positioner, width |
| `graphics.pid.cv_globe` | P&ID / VÃ¡lvulas de Controle | 0 | sim |  | actuator, fail, height, opacity, positioner, width |
| `graphics.pid.cyclone` | P&ID / Vasos | 0 | sim |  | height, opacity, width |
| `graphics.pid.deaerator` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.demister` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.dryer_rotary` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.dryer_spray` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.dryer_tray` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.ejector` | P&ID / MÃ¡quinas | 0 | sim |  | height, opacity, width |
| `graphics.pid.elec_barrier` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.elec_mcc` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.elec_transformer` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.elec_ups` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.evaporator` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.extruder` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.fan` | P&ID / MÃ¡quinas | 0 | sim |  | height, opacity, width |
| `graphics.pid.fe_avgpitot` | P&ID / Elementos de VazÃ£o | 0 | sim |  | height, opacity, width |
| `graphics.pid.fe_coriolis` | P&ID / Elementos de VazÃ£o | 0 | sim |  | height, opacity, width |
| `graphics.pid.fe_magmeter` | P&ID / Elementos de VazÃ£o | 0 | sim |  | height, opacity, width |
| `graphics.pid.fe_nozzle` | P&ID / Elementos de VazÃ£o | 0 | sim |  | height, opacity, width |
| `graphics.pid.fe_orifice` | P&ID / Elementos de VazÃ£o | 0 | sim |  | height, opacity, width |
| `graphics.pid.fe_pd` | P&ID / Elementos de VazÃ£o | 0 | sim |  | height, opacity, width |
| `graphics.pid.fe_pitot` | P&ID / Elementos de VazÃ£o | 0 | sim |  | height, opacity, width |
| `graphics.pid.fe_ro` | P&ID / Elementos de VazÃ£o | 0 | sim |  | height, opacity, width |
| `graphics.pid.fe_rotameter` | P&ID / Elementos de VazÃ£o | 0 | sim |  | height, opacity, width |
| `graphics.pid.fe_thermal` | P&ID / Elementos de VazÃ£o | 0 | sim |  | height, opacity, width |
| `graphics.pid.fe_turbine` | P&ID / Elementos de VazÃ£o | 0 | sim |  | height, opacity, width |
| `graphics.pid.fe_ultrasonic` | P&ID / Elementos de VazÃ£o | 0 | sim |  | height, opacity, width |
| `graphics.pid.fe_venturi` | P&ID / Elementos de VazÃ£o | 0 | sim |  | height, opacity, width |
| `graphics.pid.fe_vortex` | P&ID / Elementos de VazÃ£o | 0 | sim |  | height, opacity, width |
| `graphics.pid.feeder_rotary` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.filter_cartridge` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.filter_press` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.filter_rotary` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.filter_sep` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.fit_blind` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.fit_coupling` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.fit_drain` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.fit_exhaust_head` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.fit_expansion` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.fit_flanges` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.fit_funnel` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.fit_hose` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.fit_hose_station` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.fit_mixing_tee` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.fit_pulsation_dampener` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.fit_quill` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.fit_reducer` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.fit_reducer_ecc` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.fit_rupture_pin` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.fit_sample` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.fit_sightglass` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.fit_silencer` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.fit_spade` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.fit_specbreak` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.fit_spectacle` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.fit_steam_trap` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.fit_trap_bucket` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.fit_trap_float` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.fit_trap_thermo` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.fit_union` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.fit_vent` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.flame_arrestor` | P&ID / SeguranÃ§a | 0 | sim |  | height, opacity, width |
| `graphics.pid.flare` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.heater_electric` | P&ID / Troca TÃ©rmica | 0 | sim |  | height, opacity, width |
| `graphics.pid.heater_fired` | P&ID / Troca TÃ©rmica | 0 | sim |  | height, opacity, width |
| `graphics.pid.hx_air_cooler` | P&ID / Troca TÃ©rmica | 0 | sim |  | height, opacity, width |
| `graphics.pid.hx_coil` | P&ID / Troca TÃ©rmica | 0 | sim |  | height, opacity, width |
| `graphics.pid.hx_condenser` | P&ID / Troca TÃ©rmica | 0 | sim |  | height, opacity, width |
| `graphics.pid.hx_doublepipe` | P&ID / Troca TÃ©rmica | 0 | sim |  | height, opacity, width |
| `graphics.pid.hx_kettle` | P&ID / Troca TÃ©rmica | 0 | sim |  | height, opacity, width |
| `graphics.pid.hx_plate` | P&ID / Troca TÃ©rmica | 0 | sim |  | height, opacity, width |
| `graphics.pid.hx_shell_tube` | P&ID / Troca TÃ©rmica | 0 | sim |  | height, opacity, width |
| `graphics.pid.hydrocyclone` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.instr_converter` | P&ID / Instrumentos | 0 | sim |  | conv, height, opacity, width |
| `graphics.pid.logic_and` | P&ID / Controle | 0 | sim |  | height, opacity, width |
| `graphics.pid.logic_not` | P&ID / Controle | 0 | sim |  | height, opacity, width |
| `graphics.pid.logic_or` | P&ID / Controle | 0 | sim |  | height, opacity, width |
| `graphics.pid.mill_ball` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.mixer_static` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.motor` | P&ID / MÃ¡quinas | 0 | sim |  | height, opacity, width |
| `graphics.pid.package_unit` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.pcv_self` | P&ID / SeguranÃ§a | 0 | sim |  | height, opacity, width |
| `graphics.pid.pse` | P&ID / SeguranÃ§a | 0 | sim |  | height, opacity, width |
| `graphics.pid.psv` | P&ID / SeguranÃ§a | 0 | sim |  | height, opacity, width |
| `graphics.pid.psv_pilot` | P&ID / SeguranÃ§a | 0 | sim |  | height, opacity, width |
| `graphics.pid.pump_centrifugal` | P&ID / MÃ¡quinas | 0 | sim |  | height, opacity, width |
| `graphics.pid.pump_diaphragm` | P&ID / MÃ¡quinas | 0 | sim |  | height, opacity, width |
| `graphics.pid.pump_gear` | P&ID / MÃ¡quinas | 0 | sim |  | height, opacity, width |
| `graphics.pid.pump_peristaltic` | P&ID / MÃ¡quinas | 0 | sim |  | height, opacity, width |
| `graphics.pid.pump_plunger` | P&ID / MÃ¡quinas | 0 | sim |  | height, opacity, width |
| `graphics.pid.pump_submersible` | P&ID / MÃ¡quinas | 0 | sim |  | height, opacity, width |
| `graphics.pid.pump_vacuum` | P&ID / MÃ¡quinas | 0 | sim |  | height, opacity, width |
| `graphics.pid.pvsv` | P&ID / SeguranÃ§a | 0 | sim |  | height, opacity, width |
| `graphics.pid.sample_cooler` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.screen_vibrating` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.scrubber` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.stack` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.strainer_basket` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.strainer_cone` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.strainer_y` | P&ID / Em Linha | 0 | sim |  | height, opacity, width |
| `graphics.pid.tcv_self` | P&ID / SeguranÃ§a | 0 | sim |  | height, opacity, width |
| `graphics.pid.turbine_steam` | P&ID / MÃ¡quinas | 0 | sim |  | height, opacity, width |
| `graphics.pid.vacuum_breaker` | P&ID / SeguranÃ§a | 0 | sim |  | height, opacity, width |
| `graphics.pid.valve_angle` | P&ID / VÃ¡lvulas | 0 | sim |  | height, opacity, width |
| `graphics.pid.valve_ball` | P&ID / VÃ¡lvulas | 0 | sim |  | height, opacity, width |
| `graphics.pid.valve_ballcheck` | P&ID / VÃ¡lvulas | 0 | sim |  | height, opacity, width |
| `graphics.pid.valve_butterfly` | P&ID / VÃ¡lvulas | 0 | sim |  | height, opacity, width |
| `graphics.pid.valve_check` | P&ID / VÃ¡lvulas | 0 | sim |  | height, opacity, width |
| `graphics.pid.valve_diaphragm` | P&ID / VÃ¡lvulas | 0 | sim |  | height, opacity, width |
| `graphics.pid.valve_float` | P&ID / VÃ¡lvulas | 0 | sim |  | height, opacity, width |
| `graphics.pid.valve_foot` | P&ID / VÃ¡lvulas | 0 | sim |  | height, opacity, width |
| `graphics.pid.valve_fourway` | P&ID / VÃ¡lvulas | 0 | sim |  | height, opacity, width |
| `graphics.pid.valve_gate` | P&ID / VÃ¡lvulas | 0 | sim |  | height, opacity, width |
| `graphics.pid.valve_globe` | P&ID / VÃ¡lvulas | 0 | sim |  | height, opacity, width |
| `graphics.pid.valve_knife` | P&ID / VÃ¡lvulas | 0 | sim |  | height, opacity, width |
| `graphics.pid.valve_mov` | P&ID / VÃ¡lvulas | 0 | sim |  | height, opacity, width |
| `graphics.pid.valve_needle` | P&ID / VÃ¡lvulas | 0 | sim |  | height, opacity, width |
| `graphics.pid.valve_pinch` | P&ID / VÃ¡lvulas | 0 | sim |  | height, opacity, width |
| `graphics.pid.valve_plug` | P&ID / VÃ¡lvulas | 0 | sim |  | height, opacity, width |
| `graphics.pid.valve_solenoid` | P&ID / VÃ¡lvulas | 0 | sim |  | height, opacity, width |
| `graphics.pid.valve_stopcheck` | P&ID / VÃ¡lvulas | 0 | sim |  | height, opacity, width |
| `graphics.pid.valve_threeway` | P&ID / VÃ¡lvulas | 0 | sim |  | height, opacity, width |
| `graphics.pid.vessel_bullet` | P&ID / Vasos | 0 | sim |  | height, opacity, width |
| `graphics.pid.vessel_column_packed` | P&ID / Vasos | 0 | sim |  | height, opacity, width |
| `graphics.pid.vessel_column_tray` | P&ID / Vasos | 0 | sim |  | height, opacity, width |
| `graphics.pid.vessel_cstr` | P&ID / Vasos | 0 | sim |  | height, opacity, width |
| `graphics.pid.vessel_fixedbed` | P&ID / Vasos | 0 | sim |  | height, opacity, width |
| `graphics.pid.vessel_floating_roof` | P&ID / Vasos | 0 | sim |  | height, opacity, width |
| `graphics.pid.vessel_horizontal` | P&ID / Vasos | 0 | sim |  | height, opacity, width |
| `graphics.pid.vessel_ko_drum` | P&ID / Vasos | 0 | sim |  | height, opacity, width |
| `graphics.pid.vessel_open` | P&ID / Vasos | 0 | sim |  | height, opacity, width |
| `graphics.pid.vessel_sep3` | P&ID / Vasos | 0 | sim |  | height, opacity, width |
| `graphics.pid.vessel_silo` | P&ID / Vasos | 0 | sim |  | height, opacity, width |
| `graphics.pid.vessel_sphere` | P&ID / Vasos | 0 | sim |  | height, opacity, width |
| `graphics.pid.vessel_tank` | P&ID / Vasos | 0 | sim |  | height, opacity, width |
| `graphics.pid.vessel_vertical` | P&ID / Vasos | 0 | sim |  | height, opacity, width |
| `graphics.pid.vfd` | P&ID / MÃ¡quinas | 0 | sim |  | height, opacity, width |
| `graphics.pipe` | Grafico / Tubulacao | 0 | sim | bindSource | bindChannel, bindDecimals, bindInvert, bindMax, bindMin, bindOffset, bindScale, bindSource, bindThreshold, bindUnit, fill, flowDirection, height, opacity, showFlanges, showFlow, stroke, strokeWidth, value, width |
| `graphics.pipe_cross` | Grafico / Tubulacao | 0 | sim |  | fill, height, opacity, stroke, strokeWidth, width |
| `graphics.pipe_elbow` | Grafico / Tubulacao | 0 | sim |  | fill, height, opacity, stroke, strokeWidth, width |
| `graphics.pipe_flange` | Grafico / Tubulacao | 0 | sim |  | fill, height, opacity, stroke, strokeWidth, width |
| `graphics.pipe_tee` | Grafico / Tubulacao | 0 | sim |  | fill, height, opacity, stroke, strokeWidth, width |
| `graphics.rectangle` | Grafico / Formas Basicas | 0 | primitiva |  |  |
| `graphics.setpoint` | Grafico / Controles/Indicadores | 0 | sim | bindSource, actionTarget | actionMax, actionMin, actionMode, actionProperty, actionReleaseValue, actionStep, actionTarget, actionValue, bindChannel, bindDecimals, bindMax, bindMin, bindOffset, bindScale, bindSource, bindUnit, fill, height, label, opacity, stroke, strokeWidth, value, width |
| `graphics.signal_elbow` | Grafico / Conexoes | 0 | sim |  | corner, height, opacity, stroke, strokeWidth, width |
| `graphics.signal_line` | Grafico / Conexoes | 0 | sim |  | arrow, dash, height, opacity, stroke, strokeWidth, width |
| `graphics.slider` | Grafico / Controles/Indicadores | 1 | sim | bindSource, actionTarget | actionMax, actionMin, actionMode, actionProperty, actionReleaseValue, actionStep, actionTarget, actionValue, bindChannel, bindDecimals, bindMax, bindMin, bindOffset, bindScale, bindSource, bindUnit, fill, height, opacity, showTicks, stroke, strokeWidth, value, width |
| `graphics.status_lamp` | Grafico / Controles/Indicadores | 0 | sim | bindSource | bindChannel, bindDecimals, bindInvert, bindMax, bindMin, bindOffset, bindScale, bindSource, bindThreshold, bindUnit, fill, height, label, offColor, onColor, opacity, stroke, strokeWidth, value, width |
| `graphics.summing_junction` | Grafico / Instrumentos | 0 | sim |  | fill, height, opacity, stroke, strokeWidth, width |
| `graphics.tank_svg` | Grafico / Tanques e Vasos | 0 | sim | bindSource | bindChannel, bindDecimals, bindMax, bindMin, bindOffset, bindScale, bindSource, bindUnit, height, liquidColor, value, width |
| `graphics.text` | Grafico / Formas Basicas | 0 | primitiva |  |  |
| `graphics.value_display` | Grafico / Controles/Indicadores | 0 | sim | bindSource | bindChannel, bindDecimals, bindMax, bindMin, bindOffset, bindScale, bindSource, bindUnit, fill, height, label, opacity, stroke, strokeWidth, value, valueColor, width |
| `graphics.valve_globe_svg` | Grafico / Valvulas | 0 | sim | bindSource | bindChannel, bindDecimals, bindMax, bindMin, bindOffset, bindScale, bindSource, bindUnit, height, showValue, value, width |

## Plano de cobertura, reuso e preservação de layout

Este catálogo é a base visual a aproveitar. Para cada símbolo, procurar primeiro um modelo equivalente já existente no Core e associar o desenho às instâncias, tags e estados correspondentes. Depois, associar widgets HMI já disponíveis. Só criar modelo de dispositivo, estados de runtime ou widget novo se o mapeamento mostrar uma lacuna real.

A complementação deve manter a posição e a composição atual dos projetos: preservar IDs, X/Y, largura/altura, rotação, escala, camadas, grupos, viewport e coordenadas de conexões. Novos bindings e estados visuais devem ser anexados ao componente existente sem movê-lo. Migrações precisam passar por comparação antes/depois e round-trip; não reorganizar automaticamente o sinótico.

Tabela de planejamento: `símbolo → modelo Core → estados/tags → binding → widget → comando → gaps → verificação → posição preservada`. O primeiro cruzamento por famílias está em `06-lista-ativos-svg.md`: atualmente só `outputs.dc_motor` corresponde diretamente a uma das famílias mecânicas revisadas, e representa o motor elétrico. Os demais `graphics.pid.*` continuam sendo desenhos; para bombeamento, válvulas, vasos, ventilação, agitação, filtragem e troca térmica, é preciso complementar fontes de dados/modelos antes de declarar dinâmica HMI. Não solicitar arte nova com base apenas na ausência desses modelos.

## Interpretação do contrato

- Os 193 itens `graphics.pid.*` são biblioteca de representação; não têm campo `bindSource` declarado e não devem ser apresentados como objetos dinâmicos de processo.
- Os widgets `graphics.hmi.*` são distribuídos em pastas funcionais. Há dez entradas HMI, mas nem todas atuam como widget de comando.
- Sete itens expõem `actionTarget`; ações disponíveis e restrições são tratadas em `graphicsAction.ts`. A presença do campo não implementa autorização ou intertravamento.
- A única entrada gráfica com pino é `graphics.slider`; o conjunto é principalmente camada visual, com essa exceção de integração ao grafo.
- Cinco primitivas sem pacote vetorial são tratadas por renderizadores próprios: confirmar no código antes de alterar o contrato.
- Símbolos ISA-5.1 e cobertura mecânica ficam fora de uma conclusão normativa; validar semântica por revisão de domínio.
