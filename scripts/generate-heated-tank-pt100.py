"""Generates subcircuits/process_heated_tank_pt100.lssubcircuit.

Usage: python scripts/generate-heated-tank-pt100.py subcircuits/process_heated_tank_pt100.lssubcircuit
See docs/tanque-aquecido-tt301.md.

Water tank with an electric heater (pin `heater`, 0-100 %) and a Pt100 in a thermowell, wired with a
4-wire cable to the terminals 1-4 of a temperature transmitter (TT301):
- energy balance: m c dT/dt = Pmax u/100 - UA (T - Tamb), boiling at 100 degC (heat above the losses
  is spent evaporating);
- thermowell lag: dTs/dt = (T - Ts) / tau;
- Pt100 IEC 60751 (Callendar-Van Dusen): R = R0 (1 + A t + B t^2 [+ C (t - 100) t^3 below 0 degC]),
  t = Ts + sensor deviation; a broken sensor is 1 Gohm;
- the element and the four cable leads are bridges.controlled_resistor, so the transmitter really
  measures them: 2 wires add both leads, 3 wires compensate, 4 wires ignore them.
"""
import json
import sys

PERIOD = 10_000_000  # 10 ms
A, B, C = 3.9083e-3, -5.775e-7, -4.183e-12

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
PARAMETERS = [  # id, label, default, unit, options
    ("c_volume", "Volume de água no tanque", 10, "L", ""),
    ("c_pmax", "Potência máxima do aquecedor (100 %)", 6, "kW", ""),
    ("c_ua", "Coeficiente de perdas para o ambiente UA", 80, "W/K", ""),
    ("c_tamb", "Temperatura ambiente", 25, "°C", ""),
    ("c_tau", "Constante de tempo do poço termométrico", 15, "s", ""),
    ("c_r0", "R0 do sensor (resistência a 0 °C)", 100, "Ω", ""),
    ("c_lead", "Resistência de cada fio do cabo do sensor", 0.5, "Ω", ""),
    ("c_dev", "Desvio do sensor (erro do Pt100)", 0, "°C", ""),
    ("c_broken", "Sensor rompido", 0, "", "0=Não;1=Sim (circuito aberto)"),
]
for index, (cid, label, value, unit, options) in enumerate(PARAMETERS):
    props = {"value": value, "unit": unit}
    if options:
        props["options"] = options
    comp(cid, "control.constant", props, 200, 40 + index * 60, label)
comp("c_level", "control.constant", {"value": 80, "unit": "%"}, 200, 640, "Nível de água (desenho)")

# --- thermal model -----------------------------------------------------------------------------------
comp("u", "control.observer", {"unit": "%", "observerOnly": True, "samplePeriodNs": PERIOD}, 40, 200, "Aquecimento")
wire("t_heater", "u", "in")
calc("q_heat", [("u", "u"), ("P", "c_pmax")], "1000*P*((u>0)*(u<100)*u+(u>99.9999)*100)/100", "Potência do aquecedor (W)")
calc("q_loss", [("T", "temp"), ("UA", "c_ua"), ("Ta", "c_tamb")], "UA*(T-Ta)", "Perdas para o ambiente (W)")
calc("mc", [("V", "c_volume")], "4186*V", "Capacidade térmica m·c (J/K)")
# At 100 degC the heat above the losses boils water: the temperature stops rising.
calc("heat_in", [("q", "q_heat"), ("l", "q_loss"), ("T", "temp"), ("mc", "mc")],
     "((T<100)*q+(T>99.9999)*((q<l)*q+(q>l-0.000001)*l))/mc", "Ganho de temperatura (K/s)")
calc("heat_out", [("l", "q_loss"), ("mc", "mc")], "l/mc", "Perda de temperatura (K/s)")
comp("temp", "control.tank", {"area": 1, "initial": 25, "samplePeriodNs": PERIOD}, 40, 320, "Temperatura da água (°C)")
wire("heat_in", "temp", "in")
wire("heat_out", "temp", "outflow")
calc("tau_th", [("mc", "mc"), ("UA", "c_ua")], "mc/UA/60", "Constante de tempo térmica (min)")

# --- thermowell + Pt100 --------------------------------------------------------------------------------
calc("well_in", [("T", "temp"), ("tau", "c_tau")], "T/((tau>0.1)*tau+(tau<0.1)*0.1)", "Poço: entrada")
calc("well_out", [("Ts", "sensor_temp"), ("tau", "c_tau")], "Ts/((tau>0.1)*tau+(tau<0.1)*0.1)", "Poço: saída")
comp("sensor_temp", "control.tank", {"area": 1, "initial": 25, "samplePeriodNs": PERIOD}, 40, 440, "Temperatura no sensor (°C)")
wire("well_in", "sensor_temp", "in")
wire("well_out", "sensor_temp", "outflow")
calc("r_pt100", [("Ts", "sensor_temp"), ("d", "c_dev"), ("R0", "c_r0")],
     f"R0*(1+{A}*(Ts+d)+({B})*(Ts+d)^2+((Ts+d)<0)*({C})*((Ts+d)-100)*(Ts+d)^3)", "Resistência do Pt100 (Ω)")
calc("r_element", [("r", "r_pt100"), ("b", "c_broken")], "(b<0.5)*r+(b>0.5)*1000000000", "Elemento (rompido = 1 GΩ)")

comp("element", "bridges.controlled_resistor", {"resistance": 109.73}, 420, 700, "Elemento Pt100")
wire("r_element", "element", "command")
for n, end in ((1, "p"), (2, "p"), (3, "n"), (4, "n")):
    comp(f"lead{n}", "bridges.controlled_resistor", {"resistance": 0.5}, 600, 640 + 50 * n, f"Fio {n} do cabo")
    wire("c_lead", f"lead{n}", "command")
    link("element", end, f"lead{n}", "p")
    comp(f"t_rtd{n}", "connectors.tunnel", {"name": f"rtd{n}", "pinId": f"rtd{n}"}, 780, 640 + 50 * n)
    link(f"lead{n}", "n", f"t_rtd{n}", "pin")

comp("t_temperature", "connectors.signal_tunnel", {"name": "temperature", "pinId": "temperature", "direction": "Output", "valueType": "Real"}, 1340, 80)
conductors.append({"id": f"w-{len(conductors) + 1}", "from": {"kind": "port", "componentId": "temp", "pinId": "out"},
                   "to": {"kind": "port", "componentId": "t_temperature", "pinId": "value"}, "points": []})

# --- symbol: graphics (exposed) ----------------------------------------------------------------------------
W, H = 920, 640
TANK = {"x": 150, "y": 96, "w": 200, "h": 300}
k = TANK["w"] / 1024
tank_cx = TANK["x"] + 512 * k
tank_top = TANK["y"] + 52 * k
tank_bottom = TANK["y"] + 1445 * k
sig_y = 40
# Same 16 px pitch as the TT301 terminals 1-4: the four leads run straight to the transmitter.
PIN_Y = {1: 560, 2: 576, 3: 592, 4: 608}
y_temp_pin = 120
exposed = []


def graphic(cid, type_id, props, x, y, label=None):
    comp(cid, type_id, props, x, y, label)
    exposed.append({"componentId": cid, "x": x, "y": y, "rotation": 0, "flipH": False, "flipV": False, "scale": 1, "layer": len(exposed)})


def binding(source, unit, decimals, lo=0, hi=100, threshold=50):
    return {"bindSource": source, "bindChannel": 0, "bindScale": 1, "bindOffset": 0, "bindMin": lo, "bindMax": hi,
            "bindUnit": unit, "bindDecimals": decimals, "bindThreshold": threshold, "bindInvert": False}


graphic("g_tank", "graphics.tank_svg", {"width": TANK["w"], "height": TANK["h"], "value": 0, "liquidColor": "#1e88e5", **binding("c_level", "%", 0)},
        TANK["x"], TANK["y"])
graphic("g_coil", "graphics.pid.hx_coil", {"width": 66, "height": 22, "opacity": 1}, tank_cx - 52, tank_bottom - 42)
graphic("g_heating", "graphics.status_lamp", {"width": 34, "height": 42, "stroke": "currentColor", "fill": "#94a3b8", "strokeWidth": 1.5, "opacity": 1,
                                              "onColor": "#f97316", "offColor": "#cbd5e1", "label": "Aquecendo", "value": 0, **binding("u", "", 0, 0, 100, 0.5)},
        40, 210)
graphic("g_gauge", "graphics.hmi.gauge", {"width": 120, "height": 136, "tag": "TI-101", "stroke": "#4a4a4a", "fill": "#c2c2c2", "opacity": 1,
                                          "value": 0, **binding("temp", "°C", 1, 0, 120), "limitLL": "", "limitL": "", "limitH": "90", "limitHH": "100"},
        410, 48)
graphic("g_bar", "graphics.level_bar", {"width": 36, "height": 130, "stroke": "currentColor", "fill": "#ffffff", "strokeWidth": 1.5, "opacity": 1,
                                        "barColor": "#ef4444", "highLimit": 90, "lowLimit": 10, "showLimits": False, "showValue": True, "value": 0,
                                        **binding("temp", "°C", 0, 0, 120)},
        548, 52)

READOUTS = [
    ("g_t", "Temperatura da água", "temp", "°C", 2),
    ("g_ts", "Temperatura no sensor", "sensor_temp", "°C", 2),
    ("g_r", "Resistência do Pt100", "r_pt100", "Ω", 3),
    ("g_q", "Potência do aquecedor", "q_heat", "W", 0),
    ("g_loss", "Perdas para o ambiente", "q_loss", "W", 0),
    ("g_tau", "Constante de tempo térmica", "tau_th", "min", 1),
]
for index, (cid, label, source, unit, decimals) in enumerate(READOUTS):
    graphic(cid, "graphics.value_display", {"width": 168, "height": 44, "stroke": "currentColor", "fill": "#f8fafc", "strokeWidth": 1.5, "opacity": 1,
                                            "label": label, "valueColor": "#0f172a", "value": 0, **binding(source, unit, decimals, -1e12, 1e12)},
            410, 210 + index * 50)
PARAM_READOUTS = [
    ("g_p_v", "Volume de água", "c_volume", "L", 1),
    ("g_p_p", "Potência máxima", "c_pmax", "kW", 2),
    ("g_p_ua", "Perdas UA", "c_ua", "W/K", 1),
    ("g_p_ta", "Temperatura ambiente", "c_tamb", "°C", 1),
    ("g_p_tau", "τ do poço", "c_tau", "s", 1),
    ("g_p_r0", "R0 do sensor", "c_r0", "Ω", 1),
    ("g_p_lead", "R de cada fio", "c_lead", "Ω", 2),
    ("g_p_dev", "Desvio do sensor", "c_dev", "°C", 2),
]
for index, (cid, label, source, unit, decimals) in enumerate(PARAM_READOUTS):
    graphic(cid, "graphics.value_display", {"width": 150, "height": 44, "stroke": "#64748b", "fill": "#fefce8", "strokeWidth": 1.2, "opacity": 1,
                                            "label": label, "valueColor": "#713f12", "value": 0, **binding(source, unit, decimals, -1e12, 1e12)},
            600 + (index % 2) * 160, 210 + (index // 2) * 50)

# --- symbol: static drawing -------------------------------------------------------------------------------
INK = "#0f172a"
NOTE = "#334155"
RED = "#dc2626"
WHITE = "#ffffff"
WELL_X = tank_cx + 30
head_y = tank_top - 34
cable_y = head_y + 12
shapes = [
    {"kind": "text", "x": 150, "y": 22, "value": "Tanque aquecido — temperatura por Pt100 a 4 fios (IEC 60751)", "fontSize": 13, "textAnchor": "start", "color": INK},
    # heater: signal to a power controller, power to the coil
    {"kind": "line", "x1": 112, "y1": sig_y, "x2": 120, "y2": sig_y, "stroke": INK, "strokeWidth": 1.2, "strokeDasharray": "6 4"},
    {"kind": "rect", "x": 40, "y": 120, "w": 76, "h": 44, "fill": "#fff7ed", "stroke": "#c2410c", "strokeWidth": 1.5},
    {"kind": "text", "x": 78, "y": 138, "value": "Controle de", "fontSize": 9, "textAnchor": "middle", "color": "#7c2d12"},
    {"kind": "text", "x": 78, "y": 152, "value": "potência", "fontSize": 9, "textAnchor": "middle", "color": "#7c2d12"},
    {"kind": "path", "d": f"M120 {sig_y} V120", "stroke": INK, "strokeWidth": 1.2, "strokeDasharray": "6 4", "fill": "none"},
    {"kind": "path", "d": f"M78 164 V{tank_bottom + 20} H{tank_cx - 30} V{tank_bottom - 26}", "stroke": "#c2410c", "strokeWidth": 3, "fill": "none"},
    {"kind": "path", "d": f"M96 164 V{tank_bottom + 12} H{tank_cx - 22} V{tank_bottom - 26}", "stroke": "#c2410c", "strokeWidth": 3, "fill": "none"},
    {"kind": "text", "x": tank_cx - 20, "y": tank_bottom + 36, "value": "resistência de aquecimento", "fontSize": 9, "textAnchor": "start", "color": "#7c2d12"},
    # thermowell with the Pt100 at the tip, connection head on top
    {"kind": "rect", "x": WELL_X - 5, "y": head_y + 20, "w": 10, "h": tank_bottom - 70 - head_y - 20, "fill": "#cbd5e1", "stroke": "#475569", "strokeWidth": 1.2},
    {"kind": "rect", "x": WELL_X - 4, "y": tank_bottom - 82, "w": 8, "h": 14, "fill": "#f59e0b", "stroke": "#92400e", "strokeWidth": 1},
    {"kind": "rect", "x": WELL_X - 14, "y": head_y, "w": 28, "h": 22, "fill": "#e2e8f0", "stroke": "#334155", "strokeWidth": 1.5},
    {"kind": "text", "x": WELL_X, "y": head_y + 15, "value": "TE", "fontSize": 9, "textAnchor": "middle", "color": INK},
    {"kind": "text", "x": WELL_X + 12, "y": tank_bottom - 72, "value": "Pt100", "fontSize": 9, "textAnchor": "start", "color": "#92400e"},
    {"kind": "text", "x": WELL_X + 18, "y": head_y - 4, "value": "TE-101 (poço termométrico)", "fontSize": 9, "textAnchor": "start", "color": NOTE},
]
# 4-wire cable: one end of the element red/red, the other white/white (IEC 60751), to the pins 1-4.
for n, color in ((1, RED), (2, RED), (3, WHITE), (4, WHITE)):
    offset = (n - 2.5) * 5
    route = f"M{WELL_X + 14} {cable_y + offset} H{388 + n * 4} V{PIN_Y[n]} H{W}"
    shapes.append({"kind": "path", "d": route, "stroke": "#475569", "strokeWidth": 5, "fill": "none"})
    shapes.append({"kind": "path", "d": route, "stroke": color, "strokeWidth": 3, "fill": "none"})
shapes += [
    {"kind": "text", "x": 600, "y": 200, "value": "Parâmetros (Propriedades exportadas)", "fontSize": 9, "textAnchor": "start", "color": "#713f12"},
    {"kind": "text", "x": 410, "y": 548, "value": "cabo de 4 fios até os bornes 1 a 4 do TT301 (vermelho, vermelho, branco, branco)",
     "fontSize": 9, "textAnchor": "start", "color": INK},
]
pins = [
    {"id": "heater", "kind": "ANALOG_IN", "x": 0, "y": sig_y, "angle": 180, "length": 8, "label": "Aquecimento (%)"},
    {"id": "rtd1", "kind": "ANALOG_OUT", "x": W, "y": PIN_Y[1], "angle": 0, "length": 8, "label": "1"},
    {"id": "rtd2", "kind": "ANALOG_OUT", "x": W, "y": PIN_Y[2], "angle": 0, "length": 8, "label": "2"},
    {"id": "rtd3", "kind": "ANALOG_OUT", "x": W, "y": PIN_Y[3], "angle": 0, "length": 8, "label": "3"},
    {"id": "rtd4", "kind": "ANALOG_OUT", "x": W, "y": PIN_Y[4], "angle": 0, "length": 8, "label": "4"},
    {"id": "temperature", "kind": "ANALOG_OUT", "x": W, "y": y_temp_pin, "angle": 0, "length": 8, "label": "Temperatura (°C)"},
]
interface = [
    {"pinId": "heater", "label": "Aquecimento (%)", "internalTunnel": "heater", "domain": "signal", "direction": "in", "valueType": "Real", "width": 1},
    *[{"pinId": f"rtd{n}", "label": f"Fio {n} do Pt100", "internalTunnel": f"rtd{n}", "domain": "electrical"} for n in range(1, 5)],
    {"pinId": "temperature", "label": "Temperatura da água (°C)", "internalTunnel": "temperature", "domain": "signal", "direction": "out", "valueType": "Real", "width": 1},
]
document = {
    "schemaVersion": 3,
    "typeId": "subcircuits.process.heated_tank_pt100",
    "name": "Tanque aquecido com Pt100",
    "language": "pt-BR",
    "folderPath": ["Modelos"],
    "workspaceSection": "process",
    "help": {"description": (
        "Tanque de água com resistência de aquecimento (pino Aquecimento, 0–100 %) e um Pt100 em poço termométrico, "
        "ligado por cabo de 4 fios aos bornes 1 a 4 de um transmissor de temperatura (TT301). Balanço de energia "
        "m·c·dT/dt = P − UA·(T − Tamb), fervura a 100 °C, atraso do poço e curva IEC 60751 (Callendar-Van Dusen). "
        "O elemento e os fios do cabo são resistências de verdade no circuito: a 2 fios o transmissor soma os dois fios, "
        "a 3 fios compensa e a 4 fios ignora. Volume, potência, perdas, poço, R0, resistência dos fios, desvio do sensor "
        "e sensor rompido ficam em Propriedades Exportadas.")},
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
