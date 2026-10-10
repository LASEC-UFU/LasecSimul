"""Generates subcircuits/process_electric_furnace_tc.lssubcircuit.

Usage: python scripts/generate-electric-furnace-tc.py subcircuits/process_electric_furnace_tc.lssubcircuit
See docs/forno-termopar-tt301.md.

Electric muffle furnace (pin `heater`, 0-100 %) with a thermocouple in a ceramic protection tube, wired
to the terminals 2 (+) and 3 (-) of a temperature transmitter (TT301):
- energy balance: C dT/dt = Pmax u/100 - UA (T - Tamb);
- protection tube lag: dTs/dt = (T - Ts) / tau;
- Seebeck EMF at the transmitter terminals: E(Ts + deviation) - E(T_reference), NIST ITS-90 reference
  functions of the chosen type (scripts/thermocouple_its90.py). The reference junction is where the
  thermocouple alloys meet copper: the transmitter terminals (ambient) with extension/compensating
  cable, or the connection head when the cable from the head is plain copper (the classic error);
- the EMF is a bridges.controlled_voltage_source in series with the two leads (bridges.controlled_resistor):
  the transmitter really measures a voltage, reversed polarity and an open thermocouple included.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import thermocouple_its90 as its90  # noqa: E402

PERIOD = 10_000_000  # 10 ms

components = []
conductors = []
TUNNELS = {"t_heater"}


def comp(cid, type_id, props, x, y, label=None):
    entry = {"id": cid, "typeId": type_id, "properties": props, "visual": {"x": x, "y": y, "rotation": 0}}
    if label:
        entry["label"] = label
    components.append(entry)


def wire(src, dst, pin, src_pin=None):
    conductors.append({"id": f"w-{len(conductors) + 1}",
                       "from": {"kind": "port", "componentId": src, "pinId": src_pin or ("value" if src in TUNNELS else "out")},
                       "to": {"kind": "port", "componentId": dst, "pinId": pin}, "points": []})


def link(a, a_pin, b, b_pin):
    conductors.append({"id": f"w-{len(conductors) + 1}", "from": {"kind": "port", "componentId": a, "pinId": a_pin},
                       "to": {"kind": "port", "componentId": b, "pinId": b_pin}, "points": []})


_slot = [0]


def calc(cid, inputs, expression, label):
    slot = _slot[0]
    _slot[0] += 1
    comp(cid, "control.calc_expression", {"expression": expression, "inputs": [name for name, _ in inputs],
                                          "upperLimit": 0, "lowerLimit": 0, "upperLimitEnabled": False, "lowerLimitEnabled": False,
                                          "samplePeriodNs": PERIOD}, 620 + 220 * (slot // 12), 40 + 60 * (slot % 12), label)
    for name, source in inputs:
        wire(source, cid, name)


# --- interface ---------------------------------------------------------------------------------
comp("t_heater", "connectors.signal_tunnel", {"name": "heater", "pinId": "heater", "direction": "Input", "valueType": "Real", "defaultValue": 0}, 40, 80)

# --- parameters (exported) ---------------------------------------------------------------------
TYPE_OPTIONS = ";".join(f"{index}={tc}" for index, tc in enumerate(its90.TYPES))
PARAMETERS = [  # id, label, default, unit, options
    ("c_pmax", "Potência máxima das resistências (100 %)", 3, "kW", ""),
    ("c_cap", "Capacidade térmica do forno com a carga", 1.5, "kJ/K", ""),
    ("c_ua", "Coeficiente de perdas para o ambiente UA", 2.5, "W/K", ""),
    ("c_tamb", "Temperatura ambiente (onde fica o transmissor)", 25, "°C", ""),
    ("c_tau", "Constante de tempo do termopar (tubo de proteção)", 20, "s", ""),
    ("c_type", "Tipo do termopar", 3, "", TYPE_OPTIONS),
    ("c_lead", "Resistência de cada fio (termopar + cabo)", 2.5, "Ω", ""),
    ("c_dev", "Desvio do termopar (erro do sensor)", 0, "°C", ""),
    ("c_cable", "Cabo do cabeçote ao transmissor", 0, "", "0=Extensão/compensação (correto);1=Cobre comum (erro)"),
    ("c_thead", "Temperatura no cabeçote do termopar", 60, "°C", ""),
    ("c_reverse", "Polaridade invertida nos bornes", 0, "", "0=Não;1=Sim (+ e − trocados)"),
    ("c_broken", "Termopar rompido", 0, "", "0=Não;1=Sim (circuito aberto)"),
]
for index, (cid, label, value, unit, options) in enumerate(PARAMETERS):
    props = {"value": value, "unit": unit}
    if options:
        props["options"] = options
    comp(cid, "control.constant", props, 200, 40 + index * 60, label)

# --- thermal model -----------------------------------------------------------------------------------
comp("u", "control.observer", {"unit": "%", "observerOnly": True, "samplePeriodNs": PERIOD}, 40, 200, "Aquecimento")
wire("t_heater", "u", "in")
calc("q_heat", [("u", "u"), ("P", "c_pmax")], "1000*P*((u>0)*(u<100)*u+(u>99.9999)*100)/100", "Potência das resistências (W)")
calc("q_loss", [("T", "temp"), ("UA", "c_ua"), ("Ta", "c_tamb")], "UA*(T-Ta)", "Perdas para o ambiente (W)")
calc("heat_in", [("q", "q_heat"), ("C", "c_cap")], "q/(1000*C)", "Ganho de temperatura (K/s)")
calc("heat_out", [("l", "q_loss"), ("C", "c_cap")], "l/(1000*C)", "Perda de temperatura (K/s)")
comp("temp", "control.tank", {"area": 1, "initial": 25, "samplePeriodNs": PERIOD}, 40, 320, "Temperatura do forno (°C)")
wire("heat_in", "temp", "in")
wire("heat_out", "temp", "outflow")
calc("tau_th", [("C", "c_cap"), ("UA", "c_ua")], "1000*C/UA/60", "Constante de tempo térmica (min)")
calc("t_steady", [("P", "c_pmax"), ("UA", "c_ua"), ("Ta", "c_tamb")], "Ta+1000*P/UA", "Temperatura de regime a 100 % (°C)")

# --- protection tube + thermocouple ---------------------------------------------------------------------
calc("well_in", [("T", "temp"), ("tau", "c_tau")], "T/((tau>0.1)*tau+(tau<0.1)*0.1)", "Tubo: entrada")
calc("well_out", [("Ts", "sensor_temp"), ("tau", "c_tau")], "Ts/((tau>0.1)*tau+(tau<0.1)*0.1)", "Tubo: saída")
comp("sensor_temp", "control.tank", {"area": 1, "initial": 25, "samplePeriodNs": PERIOD}, 40, 440, "Temperatura da junta de medição (°C)")
wire("well_in", "sensor_temp", "in")
wire("well_out", "sensor_temp", "outflow")

lows = [its90.t_range(tc)[0] for tc in its90.TYPES]
highs = [its90.t_range(tc)[1] for tc in its90.TYPES]
calc("t_lo", [("m", "c_type")], its90.select_expression("m", [its90.number(v) for v in lows]), "Limite inferior do tipo (°C)")
calc("t_hi", [("m", "c_type")], its90.select_expression("m", [its90.number(v) for v in highs]), "Limite superior do tipo (°C)")
calc("t_hot", [("Ts", "sensor_temp"), ("d", "c_dev"), ("lo", "t_lo"), ("hi", "t_hi")],
     "(Ts+d)+((Ts+d)<lo)*(lo-(Ts+d))+((Ts+d)>hi)*(hi-(Ts+d))", "Junta de medição limitada à faixa do tipo (°C)")
calc("t_ref", [("cable", "c_cable"), ("Ta", "c_tamb"), ("Th", "c_thead"), ("lo", "t_lo"), ("hi", "t_hi")],
     "((cable<0.5)*Ta+(cable>0.5)*Th)+(((cable<0.5)*Ta+(cable>0.5)*Th)<lo)*(lo-((cable<0.5)*Ta+(cable>0.5)*Th))"
     "+(((cable<0.5)*Ta+(cable>0.5)*Th)>hi)*(hi-((cable<0.5)*Ta+(cable>0.5)*Th))",
     "Junta de referência: bornes do transmissor (extensão) ou cabeçote (cobre) (°C)")
for tc in its90.TYPES:
    calc(f"e_hot_{tc.lower()}", [("t", "t_hot")], its90.emf_expression(tc, "t"), f"Tipo {tc}: E(junta de medição) (mV)")
    calc(f"e_ref_{tc.lower()}", [("t", "t_ref")], its90.emf_expression(tc, "t"), f"Tipo {tc}: E(junta de referência) (mV)")
names = [tc.lower() for tc in its90.TYPES]
calc("e_hot", [("m", "c_type")] + [(n, f"e_hot_{n}") for n in names], its90.select_expression("m", names), "E(junta de medição) do tipo (mV)")
calc("e_ref", [("m", "c_type")] + [(n, f"e_ref_{n}") for n in names], its90.select_expression("m", names), "E(junta de referência) do tipo (mV)")
calc("e_tc", [("h", "e_hot"), ("r", "e_ref"), ("rev", "c_reverse")], "(1-2*(rev>0.5))*(h-r)", "FEM nos bornes do transmissor (mV)")
calc("emf_v", [("e", "e_tc")], "e/1000", "FEM (V)")
calc("r_plus", [("r", "c_lead"), ("b", "c_broken")], "(b<0.5)*r+(b>0.5)*1000000000", "Fio + (rompido = 1 GΩ)")

comp("emf", "bridges.controlled_voltage_source", {}, 420, 700, "FEM do termopar (Seebeck)")
wire("emf_v", "emf", "command")
comp("lead_p", "bridges.controlled_resistor", {"resistance": 2.5}, 600, 690, "Fio + (termopar + cabo)")
comp("lead_n", "bridges.controlled_resistor", {"resistance": 2.5}, 600, 740, "Fio − (termopar + cabo)")
wire("r_plus", "lead_p", "command")
wire("c_lead", "lead_n", "command")
comp("t_tc_p", "connectors.tunnel", {"name": "tc_p", "pinId": "tc_p"}, 780, 690)
comp("t_tc_n", "connectors.tunnel", {"name": "tc_n", "pinId": "tc_n"}, 780, 740)
link("emf", "p", "lead_p", "p")
link("lead_p", "n", "t_tc_p", "pin")
link("emf", "n", "lead_n", "p")
link("lead_n", "n", "t_tc_n", "pin")

comp("t_temperature", "connectors.signal_tunnel", {"name": "temperature", "pinId": "temperature", "direction": "Output", "valueType": "Real"}, 1340, 80)
conductors.append({"id": f"w-{len(conductors) + 1}", "from": {"kind": "port", "componentId": "temp", "pinId": "out"},
                   "to": {"kind": "port", "componentId": "t_temperature", "pinId": "value"}, "points": []})

# --- symbol: graphics (exposed) ----------------------------------------------------------------------------
W, H = 920, 640
BODY = {"x": 150, "y": 110, "w": 230, "h": 300}
CH = {"x": BODY["x"] + 40, "y": BODY["y"] + 46, "w": BODY["w"] - 80, "h": BODY["h"] - 86}
sig_y = 40
# Same 16 px pitch as the TT301 terminals: + goes straight to terminal 2, - to terminal 3.
PIN_Y = {"tc_p": 576, "tc_n": 592}
y_temp_pin = 120
exposed = []


def graphic(cid, type_id, props, x, y, label=None):
    comp(cid, type_id, props, x, y, label)
    exposed.append({"componentId": cid, "x": x, "y": y, "rotation": 0, "flipH": False, "flipV": False, "scale": 1, "layer": len(exposed)})


def binding(source, unit, decimals, lo=0, hi=100, threshold=50):
    return {"bindSource": source, "bindChannel": 0, "bindScale": 1, "bindOffset": 0, "bindMin": lo, "bindMax": hi,
            "bindUnit": unit, "bindDecimals": decimals, "bindThreshold": threshold, "bindInvert": False}


graphic("g_heating", "graphics.status_lamp", {"width": 34, "height": 42, "stroke": "currentColor", "fill": "#94a3b8", "strokeWidth": 1.5, "opacity": 1,
                                              "onColor": "#f97316", "offColor": "#cbd5e1", "label": "Aquecendo", "value": 0, **binding("u", "", 0, 0, 100, 0.5)},
        40, 210)
graphic("g_gauge", "graphics.hmi.gauge", {"width": 120, "height": 136, "tag": "TI-201", "stroke": "#4a4a4a", "fill": "#c2c2c2", "opacity": 1,
                                          "value": 0, **binding("temp", "°C", 0, 0, 1200), "limitLL": "", "limitL": "", "limitH": "1000", "limitHH": "1150"},
        410, 48)
graphic("g_bar", "graphics.level_bar", {"width": 36, "height": 130, "stroke": "currentColor", "fill": "#ffffff", "strokeWidth": 1.5, "opacity": 1,
                                        "barColor": "#ef4444", "highLimit": 90, "lowLimit": 10, "showLimits": False, "showValue": True, "value": 0,
                                        **binding("sensor_temp", "°C", 0, 0, 1200)},
        548, 52)

READOUTS = [
    ("g_t", "Temperatura do forno", "temp", "°C", 1),
    ("g_ts", "Temperatura no termopar", "sensor_temp", "°C", 1),
    ("g_e", "FEM nos bornes", "e_tc", "mV", 3),
    ("g_tref", "Junta de referência", "t_ref", "°C", 1),
    ("g_q", "Potência das resistências", "q_heat", "W", 0),
    ("g_loss", "Perdas para o ambiente", "q_loss", "W", 0),
    ("g_tau", "Constante de tempo térmica", "tau_th", "min", 1),
]
for index, (cid, label, source, unit, decimals) in enumerate(READOUTS):
    graphic(cid, "graphics.value_display", {"width": 168, "height": 44, "stroke": "currentColor", "fill": "#f8fafc", "strokeWidth": 1.5, "opacity": 1,
                                            "label": label, "valueColor": "#0f172a", "value": 0, **binding(source, unit, decimals, -1e12, 1e12)},
            410, 200 + index * 48)
PARAM_READOUTS = [
    ("g_p_p", "Potência máxima", "c_pmax", "kW", 2),
    ("g_p_c", "Capacidade térmica", "c_cap", "kJ/K", 2),
    ("g_p_ua", "Perdas UA", "c_ua", "W/K", 2),
    ("g_p_ta", "Temperatura ambiente", "c_tamb", "°C", 1),
    ("g_p_tau", "τ do termopar", "c_tau", "s", 1),
    ("g_p_type", "Tipo (3 = K)", "c_type", "", 0),
    ("g_p_lead", "R de cada fio", "c_lead", "Ω", 2),
    ("g_p_dev", "Desvio do termopar", "c_dev", "°C", 2),
    ("g_p_cable", "Cabo (0 ext., 1 cobre)", "c_cable", "", 0),
    ("g_p_head", "T no cabeçote", "c_thead", "°C", 1),
]
for index, (cid, label, source, unit, decimals) in enumerate(PARAM_READOUTS):
    graphic(cid, "graphics.value_display", {"width": 150, "height": 44, "stroke": "#64748b", "fill": "#fefce8", "strokeWidth": 1.2, "opacity": 1,
                                            "label": label, "valueColor": "#713f12", "value": 0, **binding(source, unit, decimals, -1e12, 1e12)},
            600 + (index % 2) * 160, 200 + (index // 2) * 48)

# --- symbol: static drawing -------------------------------------------------------------------------------
INK = "#0f172a"
NOTE = "#334155"
GREEN = "#16a34a"
WHITE = "#ffffff"
ELEMENT = "#dc2626"
TC_X = CH["x"] + CH["w"] - 34
head_y = BODY["y"] - 40
tip_y = CH["y"] + 92
bx, by, bw, bh = BODY["x"], BODY["y"], BODY["w"], BODY["h"]
shapes = [
    {"kind": "text", "x": 150, "y": 22, "value": "Forno elétrico (mufla) — temperatura por termopar tipo K (IEC 60584 / NIST ITS-90)", "fontSize": 13,
     "textAnchor": "start", "color": INK},
    # power controller and the supply to the heating elements
    {"kind": "line", "x1": 112, "y1": sig_y, "x2": 120, "y2": sig_y, "stroke": INK, "strokeWidth": 1.2, "strokeDasharray": "6 4"},
    {"kind": "rect", "x": 40, "y": 120, "w": 76, "h": 44, "fill": "#fff7ed", "stroke": "#c2410c", "strokeWidth": 1.5},
    {"kind": "text", "x": 78, "y": 138, "value": "Controle de", "fontSize": 9, "textAnchor": "middle", "color": "#7c2d12"},
    {"kind": "text", "x": 78, "y": 152, "value": "potência", "fontSize": 9, "textAnchor": "middle", "color": "#7c2d12"},
    {"kind": "path", "d": f"M120 {sig_y} V120", "stroke": INK, "strokeWidth": 1.2, "strokeDasharray": "6 4", "fill": "none"},
    {"kind": "path", "d": f"M78 164 V{by + bh + 22} H{bx + 26} V{by + bh - 30}", "stroke": "#c2410c", "strokeWidth": 3, "fill": "none"},
    {"kind": "path", "d": f"M96 164 V{by + bh + 14} H{bx + bw - 26} V{by + bh - 30}", "stroke": "#c2410c", "strokeWidth": 3, "fill": "none"},
    # steel casing, refractory lining and the chamber outline
    {"kind": "rect", "x": bx, "y": by, "w": bw, "h": bh, "fill": "#475569", "stroke": "#1e293b", "strokeWidth": 2},
    {"kind": "rect", "x": bx + 14, "y": by + 14, "w": bw - 28, "h": bh - 28, "fill": "#e7d3b1", "stroke": "#a8875a", "strokeWidth": 1.5},
    {"kind": "rect", "x": CH["x"], "y": CH["y"], "w": CH["w"], "h": CH["h"], "fill": "#1f2937", "stroke": "#111827", "strokeWidth": 1.5},
    {"kind": "rect", "x": CH["x"] + 6, "y": CH["y"] + CH["h"] - 60, "w": CH["w"] - 12, "h": 54, "fill": "#7c2d12", "stroke": "none", "opacity": 0.55},
    {"kind": "text", "x": CH["x"] + CH["w"] / 2, "y": CH["y"] + 20, "value": "câmara", "fontSize": 9, "textAnchor": "middle", "color": "#e2e8f0"},
    {"kind": "text", "x": bx + bw / 2, "y": by + 32, "value": "refratário", "fontSize": 9, "textAnchor": "middle", "color": "#7c5a2b"},
    {"kind": "text", "x": bx + bw / 2, "y": by + bh - 18, "value": "porta", "fontSize": 9, "textAnchor": "middle", "color": "#7c5a2b"},
    {"kind": "rect", "x": bx + bw / 2 - 30, "y": by + bh - 12, "w": 60, "h": 6, "fill": "#94a3b8", "stroke": "#1e293b", "strokeWidth": 1},
]
# heating elements on the side walls (zig-zag)
for side_x in (CH["x"] - 14, CH["x"] + CH["w"] + 4):
    points = " ".join(f"L{side_x + (10 if k % 2 else 0)} {CH['y'] + 12 + k * 16}" for k in range(1, 13))
    shapes.append({"kind": "path", "d": f"M{side_x} {CH['y'] + 12} {points}", "stroke": ELEMENT, "strokeWidth": 2, "fill": "none"})
shapes += [
    {"kind": "text", "x": bx + bw + 4, "y": by + bh + 40, "value": "resistências de aquecimento", "fontSize": 9, "textAnchor": "end", "color": "#7c2d12"},
    # load on the hearth
    {"kind": "rect", "x": CH["x"] + 22, "y": CH["y"] + CH["h"] - 34, "w": 56, "h": 30, "fill": "#64748b", "stroke": "#0f172a", "strokeWidth": 1.2},
    {"kind": "text", "x": CH["x"] + 50, "y": CH["y"] + CH["h"] - 15, "value": "carga", "fontSize": 9, "textAnchor": "middle", "color": WHITE},
    # thermocouple: connection head on the roof, ceramic protection tube, measuring junction at the tip
    {"kind": "rect", "x": TC_X - 5, "y": head_y + 22, "w": 10, "h": tip_y - head_y - 22, "fill": "#f8fafc", "stroke": "#475569", "strokeWidth": 1.2},
    {"kind": "ellipse", "cx": TC_X, "cy": tip_y - 4, "rx": 4, "ry": 4, "fill": "#facc15", "stroke": "#92400e", "strokeWidth": 1},
    {"kind": "rect", "x": TC_X - 14, "y": head_y, "w": 28, "h": 22, "fill": "#e2e8f0", "stroke": "#334155", "strokeWidth": 1.5},
    {"kind": "text", "x": TC_X, "y": head_y + 15, "value": "TE", "fontSize": 9, "textAnchor": "middle", "color": INK},
    {"kind": "text", "x": TC_X + 18, "y": head_y - 4, "value": "TE-201 (cabeçote)", "fontSize": 9, "textAnchor": "start", "color": NOTE},
    {"kind": "text", "x": TC_X - 8, "y": tip_y + 12, "value": "junta de medição", "fontSize": 8, "textAnchor": "end", "color": "#fde68a"},
]
# Extension cable KX (IEC 60584-3): + green, - white, green sheath.
for key, color, offset in (("tc_p", GREEN, -3), ("tc_n", WHITE, 3)):
    route = f"M{TC_X + 14} {head_y + 11 + offset} H{392 + (4 if key == 'tc_p' else 8)} V{PIN_Y[key]} H{W}"
    shapes.append({"kind": "path", "d": route, "stroke": "#14532d", "strokeWidth": 5, "fill": "none"})
    shapes.append({"kind": "path", "d": route, "stroke": color, "strokeWidth": 3, "fill": "none"})
shapes += [
    {"kind": "text", "x": 600, "y": 190, "value": "Parâmetros (Propriedades exportadas)", "fontSize": 9, "textAnchor": "start", "color": "#713f12"},
    {"kind": "text", "x": 410, "y": 562, "value": "cabo de extensão tipo K (+ verde, − branco) até os bornes 2 e 3 do TT301",
     "fontSize": 9, "textAnchor": "start", "color": INK},
]
pins = [
    {"id": "heater", "kind": "ANALOG_IN", "x": 0, "y": sig_y, "angle": 180, "length": 8, "label": "Aquecimento (%)"},
    {"id": "tc_p", "kind": "ANALOG_OUT", "x": W, "y": PIN_Y["tc_p"], "angle": 0, "length": 8, "label": "+"},
    {"id": "tc_n", "kind": "ANALOG_OUT", "x": W, "y": PIN_Y["tc_n"], "angle": 0, "length": 8, "label": "−"},
    {"id": "temperature", "kind": "ANALOG_OUT", "x": W, "y": y_temp_pin, "angle": 0, "length": 8, "label": "Temperatura (°C)"},
]
interface = [
    {"pinId": "heater", "label": "Aquecimento (%)", "internalTunnel": "heater", "domain": "signal", "direction": "in", "valueType": "Real", "width": 1},
    {"pinId": "tc_p", "label": "Termopar + (verde)", "internalTunnel": "tc_p", "domain": "electrical"},
    {"pinId": "tc_n", "label": "Termopar − (branco)", "internalTunnel": "tc_n", "domain": "electrical"},
    {"pinId": "temperature", "label": "Temperatura do forno (°C)", "internalTunnel": "temperature", "domain": "signal", "direction": "out", "valueType": "Real", "width": 1},
]
document = {
    "schemaVersion": 3,
    "typeId": "subcircuits.process.electric_furnace_tc",
    "name": "Forno elétrico com termopar",
    "language": "pt-BR",
    "folderPath": ["Modelos"],
    "workspaceSection": "process",
    "help": {"description": (
        "Forno elétrico tipo mufla com resistências de aquecimento (pino Aquecimento, 0–100 %) e um termopar em tubo de "
        "proteção cerâmico, ligado por cabo de extensão aos bornes 2 (+) e 3 (−) de um transmissor de temperatura (TT301). "
        "Balanço de energia C·dT/dt = P − UA·(T − Tamb), atraso do tubo e FEM de Seebeck E(T) − E(T_referência) pelas "
        "funções de referência NIST ITS-90 do tipo escolhido (B, E, J, K, N, R, S, T). A junta de referência fica nos bornes "
        "do transmissor (ambiente) com cabo de extensão, ou no cabeçote quando o cabo é de cobre comum. A FEM e os fios são "
        "elementos do circuito: o transmissor mede tensão de verdade, inclusive com polaridade invertida ou termopar rompido. "
        "Potência, capacidade térmica, perdas, ambiente, tubo, tipo, fios, desvio, cabo, temperatura do cabeçote, polaridade "
        "e ruptura ficam em Propriedades Exportadas.")},
    "components": components,
    "topology": {"revision": 0, "nodes": [], "conductors": conductors},
    "interface": interface,
    "symbolMode": "custom",
    "symbol": {"width": W, "height": H, "border": True, "shapes": shapes, "pins": pins},
    "exposedComponents": exposed,
    "exportedPropertyComponentIds": [cid for cid, *_ in PARAMETERS],
}
with open(sys.argv[1], "w", encoding="utf-8", newline="\n") as handle:
    json.dump(document, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
print(f"{len(components)} components, {len(conductors)} wires, {len(exposed)} exposed")
