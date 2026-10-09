"""Generates subcircuits/process_pressurized_tank_dp.lssubcircuit.

Usage: python scripts/generate-pressurized-tank.py subcircuits/process_pressurized_tank_dp.lssubcircuit
See docs/tanque-pressurizado-ld301.md.

Closed (pressurized) tank whose level is measured by a differential pressure transmitter (LD301):
- HIGH side: lower tap at the minimum level, plus a capillary that goes Lcap below it down to the
  transmitter, filled with a fluid of relative density SGcap;
- LOW side: wet leg from the tank top down to the transmitter (H + Lcap), always full of a seal
  fluid of relative density SGseal;
- the gas pressure on the top acts on both legs (cancels in HIGH - LOW, drives the outflow).

HIGH = 1000*(SGp*h + SGcap*Lcap) + 101.972*Pgas   [mmH2O]
LOW  = 1000*SGseal*(H + Lcap)    + 101.972*Pgas   [mmH2O]
dh/dt = (Qin - Qout) / (pi*D^2/4), Qin = Qin_max*u_in/100 (stops when full),
Qout = Qout_max*u_out/100*sqrt((SGp*h + Pgas_m)/(SGp*H + Pgas_m)) (flow at full tank and full opening).
"""
import json
import sys

PERIOD = 10_000_000  # 10 ms, same as the TDPS process models

components = []
conductors = []


def comp(cid, type_id, props, x, y, label=None):
    entry = {"id": cid, "typeId": type_id, "properties": props, "visual": {"x": x, "y": y, "rotation": 0}}
    if label:
        entry["label"] = label
    components.append(entry)


def wire(src, dst, pin):
    conductors.append({"id": f"w-{len(conductors) + 1}", "from": {"kind": "port", "componentId": src, "pinId": "out" if src not in TUNNELS else "value"},
                       "to": {"kind": "port", "componentId": dst, "pinId": pin}, "points": []})


def calc(cid, inputs, expression, x, y, label):
    comp(cid, "control.calc_expression", {"expression": expression, "inputs": [name for name, _ in inputs],
                                          "upperLimit": 0, "lowerLimit": 0, "upperLimitEnabled": False, "lowerLimitEnabled": False,
                                          "samplePeriodNs": PERIOD}, x, y, label)
    for name, source in inputs:
        wire(source, cid, name)


# --- interface tunnels -------------------------------------------------------------------------
TUNNELS = {"t_valve_in", "t_valve_out"}
comp("t_valve_in", "connectors.signal_tunnel", {"name": "valve_in", "pinId": "valve_in", "direction": "Input", "valueType": "Real", "defaultValue": 0}, 40, 80)
comp("t_valve_out", "connectors.signal_tunnel", {"name": "valve_out", "pinId": "valve_out", "direction": "Input", "valueType": "Real", "defaultValue": 0}, 40, 160)

# --- parameters (exported) ---------------------------------------------------------------------
PARAMETERS = [
    ("c_height", "Altura do tanque (tomada de baixo até a de cima)", 3.0, "m"),
    ("c_diameter", "Diâmetro do tanque", 1.0, "m"),
    ("c_sg_process", "Densidade relativa do líquido de processo", 1.0, ""),
    ("c_sg_seal", "Densidade relativa do selo da perna molhada (LOW, topo)", 1.0, ""),
    ("c_sg_capillary", "Densidade relativa do fluido do capilar de alta (HIGH)", 1.0, ""),
    ("c_capillary", "Capilar de alta abaixo do nível mínimo (até o transmissor)", 0.2, "m"),
    ("c_gas", "Pressão do gás no topo (manométrica)", 50.0, "kPa"),
    ("c_qin_max", "Vazão máxima de entrada (válvula 100 %)", 36.0, "m³/h"),
    ("c_qout_max", "Vazão máxima de saída (válvula 100 %, tanque cheio)", 36.0, "m³/h"),
]
for index, (cid, label, value, unit) in enumerate(PARAMETERS):
    comp(cid, "control.constant", {"value": value, "unit": unit}, 200, 40 + index * 60, label)

# --- valve openings (observers feed the valve graphics) -----------------------------------------
comp("u_in", "control.observer", {"unit": "%", "observerOnly": True, "samplePeriodNs": PERIOD}, 200, 620, "Abertura da válvula de entrada")
wire("t_valve_in", "u_in", "in")
comp("u_out", "control.observer", {"unit": "%", "observerOnly": True, "samplePeriodNs": PERIOD}, 200, 680, "Abertura da válvula de saída")
wire("t_valve_out", "u_out", "in")

# --- flows [m3/h] --------------------------------------------------------------------------------
calc("q_in", [("u", "u_in"), ("h", "tank"), ("H", "c_height"), ("Qmax", "c_qin_max")],
     "Qmax*((u>0)*u)/100*(h<H)", 420, 80, "Vazão de entrada (m³/h)")
# Gas + liquid head drive the outflow; below 2 cm the flow fades to zero so an empty tank settles
# smoothly instead of chattering around h = 0.
calc("q_out", [("u", "u_out"), ("h", "tank"), ("H", "c_height"), ("SG", "c_sg_process"), ("Pg", "c_gas"), ("Qmax", "c_qout_max")],
     "Qmax*((u>0)*u)/100*((h>0.02)+(h<0.02)*h/0.02)*((((SG*h+0.101972*Pg)>0)*(SG*h+0.101972*Pg))/(SG*H+0.101972*Pg))^0.5",
     420, 160, "Vazão de saída (m³/h)")

# --- level: dh/dt = (Qin - Qout)/A, A = pi*D^2/4 (control.tank with area 1 integrates m/s) -------
calc("dh_in", [("q", "q_in"), ("D", "c_diameter")], "q/3600/(0.785398163*D^2)", 620, 80, "Entrada (m/s)")
calc("dh_out", [("q", "q_out"), ("D", "c_diameter")], "q/3600/(0.785398163*D^2)", 620, 160, "Saída (m/s)")
comp("tank", "control.tank", {"area": 1, "initial": 1.5, "samplePeriodNs": PERIOD}, 820, 120, "Nível (m)")
wire("dh_in", "tank", "in")
wire("dh_out", "tank", "outflow")

calc("level_percent", [("h", "tank"), ("H", "c_height")], "100*h/H", 1020, 80, "Nível (%)")

# --- transmitter legs [mmH2O] ---------------------------------------------------------------------
calc("p_high", [("h", "tank"), ("SG", "c_sg_process"), ("SGc", "c_sg_capillary"), ("Lc", "c_capillary"), ("Pg", "c_gas")],
     "1000*(SG*h+SGc*Lc)+101.972*Pg", 1020, 200, "Pressão na tomada de alta (mmH2O)")
calc("p_low", [("H", "c_height"), ("SGs", "c_sg_seal"), ("Lc", "c_capillary"), ("Pg", "c_gas")],
     "1000*SGs*(H+Lc)+101.972*Pg", 1020, 280, "Pressão na tomada de baixa (mmH2O)")
calc("dp", [("a", "p_high"), ("b", "p_low")], "a-b", 1220, 240, "ΔP alta − baixa (mmH2O)")

OUTPUTS = [("high", "p_high", "HIGH (mmH2O)"), ("low", "p_low", "LOW (mmH2O)"), ("level", "tank", "Nível (m)"), ("level_pct", "level_percent", "Nível (%)")]
for index, (name, source, _label) in enumerate(OUTPUTS):
    tunnel = f"t_{name}"
    comp(tunnel, "connectors.signal_tunnel", {"name": name, "pinId": name, "direction": "Output", "valueType": "Real"}, 1420, 80 + index * 80)
    conductors.append({"id": f"w-{len(conductors) + 1}", "from": {"kind": "port", "componentId": source, "pinId": "out"},
                       "to": {"kind": "port", "componentId": tunnel, "pinId": "value"}, "points": []})

# --- symbol: graphics (exposed) ------------------------------------------------------------------
W, H = 780, 600
TANK = {"x": 200, "y": 90, "w": 160, "h": 240}
k = TANK["w"] / 1024
tank_right = TANK["x"] + 744 * k          # outer wall
tank_cx = TANK["x"] + 512 * k
tank_top = TANK["y"] + 52 * k
tank_bottom = TANK["y"] + 1445 * k
tap_top = TANK["y"] + 118 * k            # 100 % (upper tap)
tap_bottom = TANK["y"] + 1350 * k        # 0 % (lower tap, minimum level)
VALVE = 90
valve_axis = 0.805 * VALVE
y_in = 84
y_out = 362
VALVE_X = 150
sig_in = 40     # valve_in pin: signal to the inlet actuator
sig_out = 318   # valve_out pin: signal to the outlet actuator
y_high = 520
y_low = 550

exposed = []


def graphic(cid, type_id, props, x, y, label=None):
    comp(cid, type_id, props, x, y, label)
    exposed.append({"componentId": cid, "x": x, "y": y, "rotation": 0, "flipH": False, "flipV": False, "scale": 1, "layer": len(exposed)})


def binding(source, unit, decimals, lo=0, hi=100):
    return {"bindSource": source, "bindChannel": 0, "bindScale": 1, "bindOffset": 0, "bindMin": lo, "bindMax": hi, "bindUnit": unit, "bindDecimals": decimals}


graphic("g_tank", "graphics.tank_svg", {"width": TANK["w"], "height": TANK["h"], "value": 0, "liquidColor": "#1e88e5", **binding("level_percent", "%", 1)}, TANK["x"], TANK["y"])
graphic("g_valve_in", "graphics.valve_globe_svg", {"width": VALVE, "height": VALVE, "value": 0, "showValue": True, **binding("u_in", "%", 0)}, VALVE_X, y_in - valve_axis)
graphic("g_valve_out", "graphics.valve_globe_svg", {"width": VALVE, "height": VALVE, "value": 0, "showValue": True, **binding("u_out", "%", 0)}, VALVE_X, y_out - valve_axis)

READOUTS = [
    ("g_level", "Nível", "tank", "m", 3),
    ("g_level_pct", "Nível", "level_percent", "%", 1),
    ("g_dp", "ΔP (alta − baixa)", "dp", "mmH2O", 0),
    ("g_qin", "Vazão de entrada", "q_in", "m³/h", 2),
    ("g_qout", "Vazão de saída", "q_out", "m³/h", 2),
    ("g_phigh", "Tomada de alta", "p_high", "mmH2O", 0),
    ("g_plow", "Tomada de baixa", "p_low", "mmH2O", 0),
]
for index, (cid, label, source, unit, decimals) in enumerate(READOUTS):
    graphic(cid, "graphics.value_display", {"width": 172, "height": 44, "stroke": "currentColor", "fill": "#f8fafc", "strokeWidth": 1.5, "opacity": 1,
                                            "label": label, "valueColor": "#0f172a", "value": 0, **binding(source, unit, decimals, -1e9, 1e9)},
            432, 46 + index * 50)
PARAM_READOUTS = [
    ("g_par_height", "H tanque", "c_height", "m", 2),
    ("g_par_sgp", "SG processo", "c_sg_process", "", 3),
    ("g_par_sgs", "SG selo (LOW)", "c_sg_seal", "", 3),
    ("g_par_sgc", "SG capilar (HIGH)", "c_sg_capillary", "", 3),
    ("g_par_cap", "Capilar", "c_capillary", "m", 2),
    ("g_par_gas", "Gás no topo", "c_gas", "kPa", 1),
]
for index, (cid, label, source, unit, decimals) in enumerate(PARAM_READOUTS):
    graphic(cid, "graphics.value_display", {"width": 150, "height": 44, "stroke": "#64748b", "fill": "#fefce8", "strokeWidth": 1.2, "opacity": 1,
                                            "label": label, "valueColor": "#713f12", "value": 0, **binding(source, unit, decimals, -1e9, 1e9)},
            618, 46 + index * 50)

# --- symbol: static drawing (pipes, capillaries, seal pots, labels) ------------------------------
PIPE = "#64748b"
LIQUID = "#1e88e5"
SEAL = "#eab308"
CAPILLARY = "#f97316"
shapes = [
    {"kind": "text", "x": 250, "y": 22, "value": "Tanque pressurizado — nível por pressão diferencial", "fontSize": 13, "textAnchor": "start", "color": "#0f172a"},
    # valve opening signals (instrument lines) from the pins to the actuators
    {"kind": "line", "x1": 112, "y1": sig_in, "x2": VALVE_X + 26, "y2": sig_in, "stroke": "#0f172a", "strokeWidth": 1.2, "strokeDasharray": "6 4"},
    {"kind": "line", "x1": 112, "y1": sig_out, "x2": VALVE_X + 26, "y2": sig_out, "stroke": "#0f172a", "strokeWidth": 1.2, "strokeDasharray": "6 4"},
    # inlet: pin -> valve -> tank top
    {"kind": "line", "x1": 8, "y1": y_in, "x2": tank_cx, "y2": y_in, "stroke": PIPE, "strokeWidth": 6},
    {"kind": "line", "x1": tank_cx, "y1": y_in, "x2": tank_cx, "y2": tank_top + 4, "stroke": PIPE, "strokeWidth": 6},
    {"kind": "text", "x": 30, "y": y_in - 8, "value": "entrada", "fontSize": 10, "textAnchor": "start", "color": "#334155"},
    # outlet: tank bottom -> valve -> pin side
    {"kind": "line", "x1": tank_cx, "y1": tank_bottom - 4, "x2": tank_cx, "y2": y_out, "stroke": PIPE, "strokeWidth": 6},
    {"kind": "line", "x1": 8, "y1": y_out, "x2": tank_cx, "y2": y_out, "stroke": PIPE, "strokeWidth": 6},
    {"kind": "text", "x": 30, "y": y_out + 18, "value": "saída", "fontSize": 10, "textAnchor": "start", "color": "#334155"},
    # gas cushion label
    {"kind": "text", "x": tank_cx, "y": tank_top - 6, "value": "gás pressurizado", "fontSize": 9, "textAnchor": "middle", "color": "#475569"},
    # LOW: upper tap -> seal pot -> wet leg down to the transmitter level
    {"kind": "line", "x1": tank_right, "y1": tap_top, "x2": 328, "y2": tap_top, "stroke": SEAL, "strokeWidth": 4},
    {"kind": "rect", "x": 328, "y": tap_top - 10, "w": 16, "h": 20, "fill": SEAL, "stroke": "#713f12", "strokeWidth": 1.2},
    {"kind": "line", "x1": 344, "y1": tap_top, "x2": 412, "y2": tap_top, "stroke": SEAL, "strokeWidth": 4},
    {"kind": "line", "x1": 412, "y1": tap_top, "x2": 412, "y2": y_low, "stroke": SEAL, "strokeWidth": 4},
    {"kind": "line", "x1": 412, "y1": y_low, "x2": W, "y2": y_low, "stroke": SEAL, "strokeWidth": 4},
    {"kind": "text", "x": 418, "y": tap_top + 30, "value": "selo (LOW)", "fontSize": 9, "textAnchor": "start", "color": "#713f12"},
    # HIGH: lower tap (minimum level) -> seal pot -> capillary down to the transmitter level
    {"kind": "line", "x1": tank_right, "y1": tap_bottom, "x2": 328, "y2": tap_bottom, "stroke": CAPILLARY, "strokeWidth": 4},
    {"kind": "rect", "x": 328, "y": tap_bottom - 10, "w": 16, "h": 20, "fill": CAPILLARY, "stroke": "#7c2d12", "strokeWidth": 1.2},
    {"kind": "line", "x1": 344, "y1": tap_bottom, "x2": 388, "y2": tap_bottom, "stroke": CAPILLARY, "strokeWidth": 4},
    {"kind": "line", "x1": 388, "y1": tap_bottom, "x2": 388, "y2": y_high, "stroke": CAPILLARY, "strokeWidth": 4},
    {"kind": "line", "x1": 388, "y1": y_high, "x2": W, "y2": y_high, "stroke": CAPILLARY, "strokeWidth": 4},
    {"kind": "text", "x": 300, "y": tap_bottom + 40, "value": "capilar (HIGH)", "fontSize": 9, "textAnchor": "start", "color": "#7c2d12"},
    # dimensions: H between taps, Lcap from the lower tap to the transmitter
    {"kind": "line", "x1": 186, "y1": tap_top, "x2": 186, "y2": tap_bottom, "stroke": "#0f172a", "strokeWidth": 1},
    {"kind": "line", "x1": 180, "y1": tap_top, "x2": 192, "y2": tap_top, "stroke": "#0f172a", "strokeWidth": 1},
    {"kind": "line", "x1": 180, "y1": tap_bottom, "x2": 192, "y2": tap_bottom, "stroke": "#0f172a", "strokeWidth": 1},
    {"kind": "text", "x": 178, "y": (tap_top + tap_bottom) / 2, "value": "H", "fontSize": 13, "textAnchor": "end", "color": "#0f172a"},
    {"kind": "line", "x1": 270, "y1": tap_bottom, "x2": 270, "y2": y_high, "stroke": "#0f172a", "strokeWidth": 1, "strokeDasharray": "4 3"},
    {"kind": "text", "x": 264, "y": (tap_bottom + y_high) / 2 + 30, "value": "Lcap", "fontSize": 12, "textAnchor": "end", "color": "#0f172a"},
    {"kind": "line", "x1": 180, "y1": y_high, "x2": 384, "y2": y_high, "stroke": "#0f172a", "strokeWidth": 1, "strokeDasharray": "4 3"},
    {"kind": "text", "x": 180, "y": y_high + 16, "value": "nível do transmissor (ligue HIGH/LOW no LD301)", "fontSize": 9, "textAnchor": "start", "color": "#0f172a"},
    {"kind": "text", "x": 618, "y": 36, "value": "Parâmetros (Propriedades exportadas)", "fontSize": 9, "textAnchor": "start", "color": "#713f12"},
]

pins = [
    {"id": "valve_in", "kind": "ANALOG_IN", "x": 0, "y": sig_in, "angle": 180, "length": 8, "label": "Válv. entrada (%)"},
    {"id": "valve_out", "kind": "ANALOG_IN", "x": 0, "y": sig_out, "angle": 180, "length": 8, "label": "Válv. saída (%)"},
    {"id": "level", "kind": "ANALOG_OUT", "x": W, "y": 420, "angle": 0, "length": 8, "label": "Nível (m)"},
    {"id": "level_pct", "kind": "ANALOG_OUT", "x": W, "y": 450, "angle": 0, "length": 8, "label": "Nível (%)"},
    {"id": "high", "kind": "ANALOG_OUT", "x": W, "y": y_high, "angle": 0, "length": 8, "label": "HIGH"},
    {"id": "low", "kind": "ANALOG_OUT", "x": W, "y": y_low, "angle": 0, "length": 8, "label": "LOW"},
]

interface = [
    {"pinId": "valve_in", "label": "Válvula de entrada (%)", "internalTunnel": "valve_in", "domain": "signal", "direction": "in", "valueType": "Real", "width": 1},
    {"pinId": "valve_out", "label": "Válvula de saída (%)", "internalTunnel": "valve_out", "domain": "signal", "direction": "in", "valueType": "Real", "width": 1},
    {"pinId": "level", "label": "Nível (m)", "internalTunnel": "level", "domain": "signal", "direction": "out", "valueType": "Real", "width": 1},
    {"pinId": "level_pct", "label": "Nível (%)", "internalTunnel": "level_pct", "domain": "signal", "direction": "out", "valueType": "Real", "width": 1},
    {"pinId": "high", "label": "HIGH (mmH2O)", "internalTunnel": "high", "domain": "signal", "direction": "out", "valueType": "Real", "width": 1},
    {"pinId": "low", "label": "LOW (mmH2O)", "internalTunnel": "low", "domain": "signal", "direction": "out", "valueType": "Real", "width": 1},
]

document = {
    "schemaVersion": 3,
    "typeId": "subcircuits.process.pressurized_tank_dp",
    "name": "Tanque pressurizado (nível por ΔP)",
    "language": "pt-BR",
    "folderPath": ["Modelos"],
    "workspaceSection": "process",
    "help": {"description": (
        "Tanque fechado e pressurizado com válvula de entrada e de saída (abertura 0–100 % pelos pinos) e as duas tomadas "
        "de um transmissor de pressão diferencial (LD301) abaixo do tanque. HIGH: tomada no nível mínimo + capilar de "
        "comprimento Lcap até o transmissor; LOW: perna molhada do topo até o transmissor (H + Lcap), sempre cheia de selo. "
        "Saídas em mmH2O: HIGH = 1000·(SGp·h + SGcap·Lcap) + 101,97·Pgás; LOW = 1000·SGselo·(H + Lcap) + 101,97·Pgás. "
        "Com os padrões (H 3 m, SG 1, Lcap 0,2 m) o ΔP vai de −3000 (vazio) a 0 mmH2O (cheio): ajuste LRV/URV do LD301 a essa faixa. "
        "Altura, diâmetro, densidades, capilar, pressão do gás e vazões máximas ficam em Propriedades Exportadas e mudam "
        "com a simulação rodando.")},
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
