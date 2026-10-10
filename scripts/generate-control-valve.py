"""Generates subcircuits/process_control_valve.lssubcircuit: a globe control valve with a spring-diaphragm
actuator, to be driven by a positioner (FY301).

Usage: python scripts/generate-control-valve.py subcircuits/process_control_valve.lssubcircuit
See docs/fy301-posicionador.md.

- actuator pressure: dP/dt = (OUT1 - P) / tau (tubing and diaphragm volume);
- spring-diaphragm balance (bench set Plo..Phi): air to open (spring closes, fail closed) or air to
  close (spring opens, fail open);
- stem: dead band of the packing friction, then dx/dt = (x_eq - x) / 0.15 s;
- flow: Q = Kvs * f(l) * sqrt(dP / G), with the inherent characteristic f (linear, equal percentage
  R = 50, quick opening) and l = x / stroke.
Pins: OUT1 (in, bar, from the positioner), SUP (out, air supply, bar), POS (out, stem travel, mm, to
the positioner's magnet) and Vazão (out, m3/h).
"""
import json
import sys

PERIOD = 1_000_000  # 1 ms: the servo loop (positioner + actuator) needs a short step at the high gain of a positioner

components = []
conductors = []
SOURCES = {"t_out1": "value"}


def comp(cid, type_id, props, x, y, label=None):
    entry = {"id": cid, "typeId": type_id, "properties": props, "visual": {"x": x, "y": y, "rotation": 0}}
    if label:
        entry["label"] = label
    components.append(entry)


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
        link(source, SOURCES.get(source, "out"), cid, name)


def tank(cid, rate_in, rate_out, initial, label):
    comp(cid, "control.tank", {"area": 1, "initial": initial, "samplePeriodNs": PERIOD}, 40, 300 + 60 * len([c for c in components if c["typeId"] == "control.tank"]), label)
    link(rate_in, "out", cid, "in")
    link(rate_out, "out", cid, "outflow")


def clamp(expr, low, high):
    return f"({expr})+(({expr})<{low})*({low}-({expr}))+(({expr})>{high})*({high}-({expr}))"


# --- interface ---------------------------------------------------------------------------------
comp("t_out1", "connectors.signal_tunnel", {"name": "out1", "pinId": "out1", "direction": "Input", "valueType": "Real", "defaultValue": 0}, 40, 80)
for cid, name in (("t_supply", "supply"), ("t_position", "position"), ("t_flow", "flow")):
    comp(cid, "connectors.signal_tunnel", {"name": name, "pinId": name, "direction": "Output", "valueType": "Real"}, 1340, 80 + 60 * len(cid))

# --- parameters (exported) ---------------------------------------------------------------------
PARAMETERS = [  # id, label, default, unit, options
    ("c_supply", "Pressão de suprimento de ar (conjunto filtro-regulador)", 1.4, "bar", ""),
    ("c_action", "Ação do atuador", 0, "", "0=Ar para abrir (mola fecha: falha fechada);1=Ar para fechar (mola abre: falha aberta)"),
    ("c_plo", "Faixa da mola: início do movimento (bench set)", 0.2, "bar", ""),
    ("c_phi", "Faixa da mola: fim do curso (bench set)", 1.0, "bar", ""),
    ("c_stroke", "Curso da válvula", 20, "mm", ""),
    ("c_tau", "Constante de tempo pneumática do atuador", 0.5, "s", ""),
    ("c_friction", "Atrito da gaxeta (banda morta)", 0.5, "% do curso", ""),
    ("c_kvs", "Kvs (coeficiente de vazão a 100 %)", 10, "m³/h", ""),
    ("c_char", "Característica inerente da válvula", 0, "", "0=Linear;1=Igual porcentagem (R = 50);2=Abertura rápida"),
    ("c_dp", "Pressão diferencial na válvula", 1, "bar", ""),
]
for index, (cid, label, value, unit, options) in enumerate(PARAMETERS):
    props = {"value": value, "unit": unit}
    if options:
        props["options"] = options
    comp(cid, "control.constant", props, 200, 40 + index * 60, label)

# --- actuator pressure ----------------------------------------------------------------------------------
calc("out1_bar", [("o", "t_out1")], "o", "OUT1 recebida do posicionador (bar)")
calc("supply_bar", [("s", "c_supply")], "(s>0)*s", "Suprimento (bar)")
link("supply_bar", "out", "t_supply", "value")
calc("p_in", [("o", "t_out1"), ("p", "p_act"), ("tau", "c_tau")], "((o-p)>0)*(o-p)/((tau>0.01)*tau+(tau<0.0101)*0.01)", "Enchimento do atuador")
calc("p_out", [("o", "t_out1"), ("p", "p_act"), ("tau", "c_tau")], "((p-o)>0)*(p-o)/((tau>0.01)*tau+(tau<0.0101)*0.01)", "Exaustão do atuador")
tank("p_act", "p_in", "p_out", 0, "Pressão no atuador (bar)")

# --- spring-diaphragm and stem ------------------------------------------------------------------------------
# Not clamped: below the start of the spring range the preload keeps the plug on the seat, above the end the
# stem rests on the travel stop; the stem itself is limited to 0..stroke (seat and stop).
calc("x_eq", [("p", "p_act"), ("lo", "c_plo"), ("hi", "c_phi"), ("a", "c_action"), ("s", "c_stroke")],
     "s*((a<0.5)*((p-lo)/(((hi-lo)>0.01)*(hi-lo)+((hi-lo)<0.0101)*0.01))+(a>0.5)*(1-(p-lo)/(((hi-lo)>0.01)*(hi-lo)+((hi-lo)<0.0101)*0.01)))",
     "Equilíbrio mola x diafragma (mm de abertura; fora da faixa: sede ou batente)")
calc("gap", [("e", "x_eq"), ("x", "stem"), ("f", "c_friction"), ("s", "c_stroke")],
     "((e-x)>f*s/200)*((e-x)-f*s/200)+((e-x)<(0-f*s/200))*((e-x)+f*s/200)", "Força líquida além do atrito (mm)")
calc("stem_in", [("g", "gap"), ("x", "stem"), ("s", "c_stroke")], "(g>0)*g/0.15*(x<s)", "Haste: abrindo (até o batente)")
calc("stem_out", [("g", "gap")], "(g<0)*(0-g)/0.15", "Haste: fechando")
tank("stem", "stem_in", "stem_out", 0, "Abertura da haste (mm)")
link("stem", "out", "t_position", "value")
calc("opening", [("x", "stem"), ("s", "c_stroke")], "x/((s>0.1)*s+(s<0.1001)*0.1)*100", "Abertura (%)")

# --- flow ---------------------------------------------------------------------------------------------------
calc("flow_m3h", [("l", "opening"), ("c", "c_char"), ("k", "c_kvs"), ("dp", "c_dp")],
     "k*((c<0.5)*(l/100)+(c>0.5)*(c<1.5)*(50^(l/100)-1)/49+(c>1.5)*((l/100)>0)*(l/100)^0.5)*((dp>0)*dp)^0.5",
     "Vazão Q = Kvs·f(l)·√ΔP (m³/h)")
link("flow_m3h", "out", "t_flow", "value")

# --- symbol: graphics (exposed) ----------------------------------------------------------------------------
W, H = 760, 520
PIN_Y = {"supply": 200, "out1": 220, "position": 240}
y_flow_pin = 300
exposed = []


def graphic(cid, type_id, props, x, y, label=None):
    comp(cid, type_id, props, x, y, label)
    exposed.append({"componentId": cid, "x": x, "y": y, "rotation": 0, "flipH": False, "flipV": False, "scale": 1, "layer": len(exposed)})


def binding(source, unit, decimals, lo=0, hi=100, threshold=50):
    return {"bindSource": source, "bindChannel": 0, "bindScale": 1, "bindOffset": 0, "bindMin": lo, "bindMax": hi,
            "bindUnit": unit, "bindDecimals": decimals, "bindThreshold": threshold, "bindInvert": False}


graphic("g_travel", "graphics.level_bar", {"width": 30, "height": 108, "stroke": "currentColor", "fill": "#ffffff", "strokeWidth": 1.5, "opacity": 1,
                                           "barColor": "#16a34a", "highLimit": 90, "lowLimit": 10, "showLimits": False, "showValue": True, "value": 0,
                                           **binding("opening", "%", 0, 0, 100)}, 262, 196)
graphic("g_gauge", "graphics.hmi.gauge", {"width": 120, "height": 136, "tag": "PI-101", "stroke": "#4a4a4a", "fill": "#c2c2c2", "opacity": 1,
                                          "value": 0, **binding("p_act", "bar", 2, 0, 2), "limitLL": "", "limitL": "", "limitH": "", "limitHH": ""},
        420, 40)
READOUTS = [
    ("g_out1", "OUT1 do posicionador", "out1_bar", "bar", 3),
    ("g_pact", "Pressão no atuador", "p_act", "bar", 3),
    ("g_x", "Curso (abertura da haste)", "stem", "mm", 2),
    ("g_open", "Abertura", "opening", "%", 1),
    ("g_flow", "Vazão", "flow_m3h", "m³/h", 2),
]
for index, (cid, label, source, unit, decimals) in enumerate(READOUTS):
    graphic(cid, "graphics.value_display", {"width": 160, "height": 44, "stroke": "currentColor", "fill": "#f8fafc", "strokeWidth": 1.5, "opacity": 1,
                                            "label": label, "valueColor": "#0f172a", "value": 0, **binding(source, unit, decimals, -1e12, 1e12)},
            420, 190 + index * 48)
PARAM_READOUTS = [
    ("g_p_sup", "Suprimento", "c_supply", "bar", 2),
    ("g_p_act", "Ação (0 AA, 1 AF)", "c_action", "", 0),
    ("g_p_lo", "Mola: início", "c_plo", "bar", 2),
    ("g_p_hi", "Mola: fim", "c_phi", "bar", 2),
    ("g_p_stroke", "Curso", "c_stroke", "mm", 1),
    ("g_p_fric", "Atrito", "c_friction", "%", 2),
    ("g_p_kvs", "Kvs", "c_kvs", "m³/h", 1),
    ("g_p_char", "Curva (0 L, 1 EP, 2 AR)", "c_char", "", 0),
]
for index, (cid, label, source, unit, decimals) in enumerate(PARAM_READOUTS):
    graphic(cid, "graphics.value_display", {"width": 150, "height": 44, "stroke": "#64748b", "fill": "#fefce8", "strokeWidth": 1.2, "opacity": 1,
                                            "label": label, "valueColor": "#713f12", "value": 0, **binding(source, unit, decimals, -1e12, 1e12)},
            40 + (index % 4) * 160, 430 + (index // 4) * 46)

# --- symbol: static drawing -----------------------------------------------------------------------------------
INK = "#0f172a"
STEEL = "#64748b"
BODY = "#94a3b8"
AIR = "#2563eb"
cx = 210
shapes = [
    {"kind": "text", "x": 40, "y": 22, "value": "Válvula de controle globo com atuador pneumático de diafragma e mola", "fontSize": 13,
     "textAnchor": "start", "color": INK},
    # pipe with flanges and flow arrow
    {"kind": "rect", "x": 40, "y": 362, "w": 340, "h": 36, "fill": "#cbd5e1", "stroke": STEEL, "strokeWidth": 1.5},
    {"kind": "rect", "x": 120, "y": 352, "w": 10, "h": 56, "fill": BODY, "stroke": STEEL, "strokeWidth": 1.2},
    {"kind": "rect", "x": 290, "y": 352, "w": 10, "h": 56, "fill": BODY, "stroke": STEEL, "strokeWidth": 1.2},
    {"kind": "path", "d": "M50 412 H110 M100 406 L110 412 L100 418", "stroke": INK, "strokeWidth": 1.5, "fill": "none"},
    {"kind": "text", "x": 50, "y": 428, "value": "vazão", "fontSize": 9, "textAnchor": "start", "color": INK},
    # globe body, bonnet, yoke
    {"kind": "ellipse", "cx": cx, "cy": 380, "rx": 70, "ry": 42, "fill": BODY, "stroke": INK, "strokeWidth": 1.8},
    {"kind": "rect", "x": cx - 22, "y": 312, "w": 44, "h": 30, "fill": BODY, "stroke": INK, "strokeWidth": 1.5},
    {"kind": "path", "d": f"M{cx - 34} 312 V214 M{cx + 34} 312 V214", "stroke": STEEL, "strokeWidth": 4, "fill": "none"},
    {"kind": "line", "x1": cx, "y1": 206, "x2": cx, "y2": 370, "stroke": INK, "strokeWidth": 3},
    {"kind": "rect", "x": cx - 14, "y": 366, "w": 28, "h": 12, "fill": "#475569", "stroke": INK, "strokeWidth": 1},
    {"kind": "text", "x": cx + 74, "y": 392, "value": "obturador e sede", "fontSize": 8, "textAnchor": "start", "color": INK},
    # spring-diaphragm actuator
    {"kind": "path", "d": f"M{cx - 95} 150 Q{cx} 70 {cx + 95} 150 Z", "fill": "#e2e8f0", "stroke": INK, "strokeWidth": 1.8},
    {"kind": "path", "d": f"M{cx - 95} 150 Q{cx} 230 {cx + 95} 150 Z", "fill": "#e2e8f0", "stroke": INK, "strokeWidth": 1.8},
    {"kind": "line", "x1": cx - 95, "y1": 150, "x2": cx + 95, "y2": 150, "stroke": "#1d4ed8", "strokeWidth": 2.5},
    {"kind": "path", "d": f"M{cx - 14} 158 L{cx + 14} 166 L{cx - 14} 174 L{cx + 14} 182 L{cx - 14} 190 L{cx + 14} 198",
     "stroke": "#b45309", "strokeWidth": 2, "fill": "none"},
    {"kind": "text", "x": cx - 100, "y": 110, "value": "atuador (diafragma + mola)", "fontSize": 9, "textAnchor": "end", "color": INK},
    {"kind": "text", "x": 262, "y": 190, "value": "indicador de curso", "fontSize": 8, "textAnchor": "start", "color": INK},
]
# air tubing: supply from the filter-regulator to SUP, OUT1 from the positioner to the actuator chamber,
# position: the magnet on the stem, read by the positioner's Hall sensor.
shapes += [
    {"kind": "rect", "x": 600, "y": 120, "w": 70, "h": 44, "fill": "#eff6ff", "stroke": AIR, "strokeWidth": 1.5},
    {"kind": "text", "x": 635, "y": 138, "value": "filtro-", "fontSize": 9, "textAnchor": "middle", "color": AIR},
    {"kind": "text", "x": 635, "y": 152, "value": "regulador", "fontSize": 9, "textAnchor": "middle", "color": AIR},
    {"kind": "path", "d": f"M635 164 V{PIN_Y['supply']} H{W}", "stroke": AIR, "strokeWidth": 2.5, "fill": "none"},
    {"kind": "path", "d": f"M{W} {PIN_Y['out1']} H590 V96 H{cx} V110", "stroke": AIR, "strokeWidth": 2.5, "fill": "none"},
    {"kind": "text", "x": 600, "y": 92, "value": "OUT1 → câmara do atuador", "fontSize": 9, "textAnchor": "start", "color": AIR},
    {"kind": "rect", "x": cx + 2, "y": 250, "w": 14, "h": 10, "fill": "#dc2626", "stroke": INK, "strokeWidth": 1},
    {"kind": "path", "d": f"M{cx + 16} 255 H340 V{PIN_Y['position']} H{W}", "stroke": "#dc2626", "strokeWidth": 1.5,
     "strokeDasharray": "5 4", "fill": "none"},
    {"kind": "text", "x": 344, "y": 252, "value": "ímã → sensor Hall", "fontSize": 9, "textAnchor": "start", "color": "#dc2626"},
    {"kind": "path", "d": f"M380 380 H{W - 60} V{y_flow_pin} H{W}", "stroke": "#0f766e", "strokeWidth": 1.2, "strokeDasharray": "6 4", "fill": "none"},
    {"kind": "text", "x": 40, "y": 424 + 6, "value": "", "fontSize": 9, "textAnchor": "start", "color": INK},
]
pins = [
    {"id": "supply", "kind": "ANALOG_OUT", "x": W, "y": PIN_Y["supply"], "angle": 0, "length": 8, "label": "SUP"},
    {"id": "out1", "kind": "ANALOG_IN", "x": W, "y": PIN_Y["out1"], "angle": 0, "length": 8, "label": "OUT1"},
    {"id": "position", "kind": "ANALOG_OUT", "x": W, "y": PIN_Y["position"], "angle": 0, "length": 8, "label": "POS"},
    {"id": "flow", "kind": "ANALOG_OUT", "x": W, "y": y_flow_pin, "angle": 0, "length": 8, "label": "Vazão (m³/h)"},
]
interface = [
    {"pinId": "supply", "label": "Suprimento de ar (bar)", "internalTunnel": "supply", "domain": "signal", "direction": "out", "valueType": "Real", "width": 1},
    {"pinId": "out1", "label": "Pressão do posicionador OUT1 (bar)", "internalTunnel": "out1", "domain": "signal", "direction": "in", "valueType": "Real", "width": 1},
    {"pinId": "position", "label": "Posição da haste (mm)", "internalTunnel": "position", "domain": "signal", "direction": "out", "valueType": "Real", "width": 1},
    {"pinId": "flow", "label": "Vazão (m³/h)", "internalTunnel": "flow", "domain": "signal", "direction": "out", "valueType": "Real", "width": 1},
]
document = {
    "schemaVersion": 3,
    "typeId": "subcircuits.process.control_valve",
    "name": "Válvula de controle com atuador pneumático",
    "language": "pt-BR",
    "folderPath": ["Modelos"],
    "workspaceSection": "process",
    "help": {"description": (
        "Válvula globo com atuador pneumático de diafragma e mola, para ser comandada por um posicionador (FY301). OUT1 é a "
        "pressão que o posicionador manda à câmara do atuador; SUP é o suprimento de ar do filtro-regulador; POS é o curso da "
        "haste (mm de abertura) que o ímã leva ao sensor Hall do posicionador. Modelo: atraso pneumático, equilíbrio mola x "
        "diafragma pela faixa da mola (bench set), ar para abrir ou para fechar, banda morta do atrito da gaxeta e vazão "
        "Q = Kvs·f(l)·√ΔP com a característica inerente linear, igual porcentagem (R = 50) ou abertura rápida. Os parâmetros "
        "ficam em Propriedades Exportadas.")},
    "components": components,
    "topology": {"revision": 0, "nodes": [], "conductors": conductors},
    "interface": interface,
    "symbolMode": "custom",
    "symbol": {"width": W, "height": H, "border": True, "shapes": [s for s in shapes if s.get("value", "x") != ""], "pins": pins},
    "exposedComponents": exposed,
    "exportedPropertyComponentIds": [cid for cid, *_ in PARAMETERS],
}
with open(sys.argv[1], "w", encoding="utf-8", newline="\n") as handle:
    json.dump(document, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
print(f"{len(components)} components, {len(conductors)} wires, {len(exposed)} exposed")
