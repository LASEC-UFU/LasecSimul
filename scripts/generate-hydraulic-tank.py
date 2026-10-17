"""Generates subcircuits/process_hydraulic_tank.lssubcircuit.

Usage: python scripts/generate-hydraulic-tank.py subcircuits/process_hydraulic_tank.lssubcircuit
See docs/53-laboratorio-calculo-experimentos-e-tanque.md §2.

Open tank of constant cross-section A (the "Tanque — da vazão à integral" vertical of the
Calculus Lab), built on control.accumulator (ADR 0013):
- state V [L] with floor 0 and top Vmax = 1000·A·hmax as a sampled INPUT (A can change while
  running: V is preserved, h = V/(1000·A) jumps, the excess above Vmax spills at once into cumSpill);
- inlet pump q_in [L/s]; outlet either a pump q_out [L/s] (valve = 0) or a linear gravity valve
  q_out = k·h [L/s] (valve = 1);
- every block runs at 10 ms; parameters are control.constant (live) and the initial volume is the
  accumulator's `initial` (stop-required).
"""
import json
import sys

PERIOD = 10_000_000  # 10 ms

components = []
conductors = []
TUNNELS = set()


def comp(cid, type_id, props, x, y, label=None):
    entry = {"id": cid, "typeId": type_id, "properties": props, "visual": {"x": x, "y": y, "rotation": 0}}
    if label:
        entry["label"] = label
    components.append(entry)


def wire(src, dst, pin, src_pin="out"):
    conductors.append({"id": f"w-{len(conductors) + 1}",
                       "from": {"kind": "port", "componentId": src, "pinId": "value" if src in TUNNELS else src_pin},
                       "to": {"kind": "port", "componentId": dst, "pinId": "value" if dst in TUNNELS else pin}, "points": []})


def calc(cid, inputs, expression, x, y, label):
    comp(cid, "control.calc_expression", {"expression": expression, "inputs": [name for name, _ in inputs],
                                          "upperLimit": 0, "lowerLimit": 0, "upperLimitEnabled": False, "lowerLimitEnabled": False,
                                          "samplePeriodNs": PERIOD}, x, y, label)
    for name, source in inputs:
        wire(source, cid, name)


# --- parameters (exported; constants change with the simulation running) ------------------------
PARAMETERS = [
    ("c_qin", "Vazão da bomba de entrada", 1.0, "L/s"),
    ("c_qout", "Vazão da bomba de saída", 0.4, "L/s"),
    ("c_area", "Área da seção do tanque (A)", 0.1, "m²"),
    ("c_hmax", "Altura da borda (h máx.)", 1.0, "m"),
    ("c_k", "Coeficiente da válvula de saída (q = k·h)", 2.0, "L/(s·m)"),
    ("c_valve", "Saída por válvula (1) ou por bomba (0)", 0.0, ""),
]
for index, (cid, label, value, unit) in enumerate(PARAMETERS):
    comp(cid, "control.constant", {"value": value, "unit": unit}, 40, 40 + index * 60, label)

# --- model --------------------------------------------------------------------------------------
calc("vmax", [("a", "c_area"), ("hm", "c_hmax")], "a*hm*1000", 240, 120, "Volume máximo (L)")
calc("q_out", [("qo", "c_qout"), ("m", "c_valve"), ("k", "c_k"), ("h", "h")], "(1-m)*qo+m*k*h", 240, 240, "Saída demandada (L/s)")
comp("acc", "control.accumulator", {"initial": 20, "lowerLimitEnabled": True, "lowerLimit": 0, "upperLimitEnabled": False,
                                    "upperLimit": 100, "lowerInput": False, "upperInput": True, "samplePeriodNs": PERIOD},
     460, 160, "Volume (L)")
wire("c_qin", "acc", "in")
wire("q_out", "acc", "outflow")
wire("vmax", "acc", "upper")
calc("h", [("v", "acc"), ("a", "c_area")], "v/(a*1000)", 680, 120, "Nível h (m)")
calc("level_percent", [("h", "h"), ("hm", "c_hmax")], "100*h/hm", 680, 220, "Nível (%)")
comp("obs_overflow", "control.observer", {"unit": "L/s", "observerOnly": True, "samplePeriodNs": PERIOD}, 680, 320, "Transbordo (L/s)")
wire("acc", "obs_overflow", "in", "overflow")
comp("obs_unmet", "control.observer", {"unit": "L/s", "observerOnly": True, "samplePeriodNs": PERIOD}, 680, 380, "Saída sem água (L/s)")
wire("acc", "obs_unmet", "in", "unmet")

OUTPUTS = [("volume", "acc", "out", "Volume (L)"), ("level", "h", "out", "Nível (m)"),
           ("level_pct", "level_percent", "out", "Nível (%)"), ("overflow", "acc", "overflow", "Transbordo (L/s)")]
for index, (name, source, port, _label) in enumerate(OUTPUTS):
    tunnel = f"t_{name}"
    comp(tunnel, "connectors.signal_tunnel", {"name": name, "pinId": name, "direction": "Output", "valueType": "Real"}, 900, 80 + index * 80)
    TUNNELS.add(tunnel)
    wire(source, tunnel, "value", port)

# --- symbol -------------------------------------------------------------------------------------
W, H = 520, 330
TANK = {"x": 150, "y": 50, "w": 150, "h": 230}
exposed = []


def graphic(cid, type_id, props, x, y, label=None):
    comp(cid, type_id, props, x, y, label)
    exposed.append({"componentId": cid, "x": x, "y": y, "rotation": 0, "flipH": False, "flipV": False, "scale": 1, "layer": len(exposed)})


def binding(source, unit, decimals, lo=0, hi=100):
    return {"bindSource": source, "bindChannel": 0, "bindScale": 1, "bindOffset": 0, "bindMin": lo, "bindMax": hi, "bindUnit": unit, "bindDecimals": decimals}


graphic("g_tank", "graphics.tank_svg", {"width": TANK["w"], "height": TANK["h"], "value": 0, "liquidColor": "#1e88e5", **binding("level_percent", "%", 1)}, TANK["x"], TANK["y"])
READOUTS = [
    ("g_volume", "Volume", "acc", "L", 2),
    ("g_level", "Nível h", "h", "m", 3),
    ("g_qin", "Entrada", "c_qin", "L/s", 2),
    ("g_qout", "Saída demandada", "q_out", "L/s", 2),
    ("g_overflow", "Transbordo", "obs_overflow", "L/s", 2),
    ("g_area", "Área A", "c_area", "m²", 3),
]
for index, (cid, label, source, unit, decimals) in enumerate(READOUTS):
    graphic(cid, "graphics.value_display", {"width": 150, "height": 40, "stroke": "currentColor", "fill": "#f8fafc", "strokeWidth": 1.5, "opacity": 1,
                                            "label": label, "valueColor": "#0f172a", "value": 0, **binding(source, unit, decimals, -1e9, 1e9)},
            340, 30 + index * 46)

PIPE = "#64748b"
shapes = [
    {"kind": "text", "x": 12, "y": 22, "value": "Tanque — da vazão à integral", "fontSize": 13, "textAnchor": "start", "color": "#0f172a"},
    {"kind": "line", "x1": 12, "y1": 70, "x2": TANK["x"] + 40, "y2": 70, "stroke": PIPE, "strokeWidth": 6},
    {"kind": "text", "x": 12, "y": 62, "value": "bomba de entrada", "fontSize": 10, "textAnchor": "start", "color": "#334155"},
    {"kind": "line", "x1": TANK["x"] + 40, "y1": TANK["y"] + TANK["h"] - 6, "x2": TANK["x"] + 40, "y2": H - 22, "stroke": PIPE, "strokeWidth": 6},
    {"kind": "line", "x1": 12, "y1": H - 22, "x2": TANK["x"] + 40, "y2": H - 22, "stroke": PIPE, "strokeWidth": 6},
    {"kind": "text", "x": 12, "y": H - 30, "value": "saída (bomba ou válvula)", "fontSize": 10, "textAnchor": "start", "color": "#334155"},
]
pins = [{"id": name, "kind": "ANALOG_OUT", "x": W, "y": 70 + index * 40, "angle": 0, "length": 8, "label": label}
        for index, (name, _source, _port, label) in enumerate(OUTPUTS)]
interface = [{"pinId": name, "label": label, "internalTunnel": name, "domain": "signal", "direction": "out", "valueType": "Real", "width": 1}
             for name, _source, _port, label in OUTPUTS]

document = {
    "schemaVersion": 3,
    "typeId": "subcircuits.process.hydraulic_tank",
    "name": "Tanque hidráulico (vazão → volume)",
    "language": "pt-BR",
    "folderPath": ["Modelos"],
    "workspaceSection": "process",
    "help": {"description": (
        "Tanque aberto de seção A constante para o Laboratório de Cálculo: o volume V (L) integra a vazão de entrada menos a de "
        "saída num acumulador conservativo (fundo 0, borda Vmax = 1000·A·hmax). Saída por bomba (q = q_saída) ou por válvula "
        "(q = k·h). Com a área A mudando durante a execução, V é preservado, h = V/A salta e o excesso acima da borda derrama de "
        "uma vez. Vazões, área, borda, k e o modo de saída ficam em Propriedades Exportadas e mudam com a simulação rodando; o "
        "volume inicial é a propriedade 'initial' do acumulador (com a simulação parada). Todos os blocos rodam a 10 ms.")},
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
