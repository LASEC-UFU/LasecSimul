"""Generates subcircuits/process_sensor_4_20.lssubcircuit.

Usage: python scripts/generate-sensor-4-20.py subcircuits/process_sensor_4_20.lssubcircuit
See docs/53-laboratorio-calculo-experimentos-e-tanque.md §1 (experiment A).

Pressure transmitter as an affine function for the Calculus Lab:
    I_raw = 4 mA + 16 mA·(P − Pmin)/(Pmax − Pmin)
    I     = clamp(I_raw, 3.8 mA, 20.5 mA)   (saturation of a real 4-20 mA loop)
P, Pmin and Pmax are control.constant (the lab treats P as live and the range as stop-required).
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


PARAMETERS = [
    ("c_p", "Pressão aplicada P", 100.0, "kPa"),
    ("c_pmin", "Início da faixa (Pmin → 4 mA)", 0.0, "kPa"),
    ("c_pmax", "Fim da faixa (Pmax → 20 mA)", 200.0, "kPa"),
]
for index, (cid, label, value, unit) in enumerate(PARAMETERS):
    comp(cid, "control.constant", {"value": value, "unit": unit}, 40, 40 + index * 60, label)
comp("i_raw", "control.calc_expression", {"expression": "4+16*(p-pmin)/(pmax-pmin)", "inputs": ["p", "pmin", "pmax"],
                                         "upperLimit": 0, "lowerLimit": 0, "upperLimitEnabled": False, "lowerLimitEnabled": False,
                                         "samplePeriodNs": PERIOD}, 240, 80, "Corrente sem saturação (mA)")
for name, source in [("p", "c_p"), ("pmin", "c_pmin"), ("pmax", "c_pmax")]:
    wire(source, "i_raw", name)
comp("i_loop", "control.saturation", {"minimum": 3.8, "maximum": 20.5, "samplePeriodNs": PERIOD}, 440, 80, "Corrente do laço (mA)")
wire("i_raw", "i_loop", "in")
# Ids internos distintos dos pinos públicos (current/raw): o validador do subcircuito exige ids únicos.
OUTPUTS = [("current", "i_loop", "Corrente (mA)"), ("raw", "i_raw", "Corrente sem saturação (mA)")]
for index, (name, source, _label) in enumerate(OUTPUTS):
    tunnel = f"t_{name}"
    comp(tunnel, "connectors.signal_tunnel", {"name": name, "pinId": name, "direction": "Output", "valueType": "Real"}, 640, 80 + index * 80)
    TUNNELS.add(tunnel)
    wire(source, tunnel, "value")

W, H = 380, 220
exposed = []


def graphic(cid, type_id, props, x, y):
    comp(cid, type_id, props, x, y)
    exposed.append({"componentId": cid, "x": x, "y": y, "rotation": 0, "flipH": False, "flipV": False, "scale": 1, "layer": len(exposed)})


def binding(source, unit, decimals):
    return {"bindSource": source, "bindChannel": 0, "bindScale": 1, "bindOffset": 0, "bindMin": -1e9, "bindMax": 1e9, "bindUnit": unit, "bindDecimals": decimals}


for index, (cid, label, source, unit, decimals) in enumerate([("g_p", "Pressão", "c_p", "kPa", 1), ("g_i", "Corrente", "i_loop", "mA", 3)]):
    graphic(cid, "graphics.value_display", {"width": 150, "height": 40, "stroke": "currentColor", "fill": "#f8fafc", "strokeWidth": 1.5, "opacity": 1,
                                            "label": label, "valueColor": "#0f172a", "value": 0, **binding(source, unit, decimals)}, 210, 50 + index * 56)
shapes = [
    {"kind": "text", "x": 12, "y": 22, "value": "Transmissor 4–20 mA (função afim)", "fontSize": 13, "textAnchor": "start", "color": "#0f172a"},
    {"kind": "rect", "x": 24, "y": 60, "w": 150, "h": 100, "fill": "#e0f2fe", "stroke": "#0369a1", "strokeWidth": 1.5},
    {"kind": "text", "x": 99, "y": 100, "value": "I = 4 + 16·(P − Pmin)", "fontSize": 10, "textAnchor": "middle", "color": "#0c4a6e"},
    {"kind": "text", "x": 99, "y": 118, "value": "/(Pmax − Pmin)", "fontSize": 10, "textAnchor": "middle", "color": "#0c4a6e"},
    {"kind": "text", "x": 99, "y": 142, "value": "saturação 3,8–20,5 mA", "fontSize": 9, "textAnchor": "middle", "color": "#0c4a6e"},
]
pins = [{"id": name, "kind": "ANALOG_OUT", "x": W, "y": 90 + index * 40, "angle": 0, "length": 8, "label": label}
        for index, (name, _source, label) in enumerate(OUTPUTS)]
interface = [{"pinId": name, "label": label, "internalTunnel": name, "domain": "signal", "direction": "out", "valueType": "Real", "width": 1}
             for name, _source, label in OUTPUTS]

document = {
    "schemaVersion": 3,
    "typeId": "subcircuits.process.sensor_4_20",
    "name": "Sensor 4–20 mA (laboratório)",
    "language": "pt-BR",
    "folderPath": ["Modelos"],
    "workspaceSection": "process",
    "help": {"description": (
        "Transmissor de pressão como função afim: I = 4 mA + 16 mA·(P − Pmin)/(Pmax − Pmin), saturado em 3,8–20,5 mA como um laço "
        "4–20 mA real. A saída 'raw' mostra o valor sem saturação. P muda com a simulação rodando; a faixa Pmin–Pmax é configuração. "
        "Usado pelo experimento A do Laboratório de Cálculo (função afim, ganho/offset, inversa, saturação).")},
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
