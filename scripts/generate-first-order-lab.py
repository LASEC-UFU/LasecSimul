"""Generates subcircuits/process_first_order_lab.lssubcircuit.

Usage: python scripts/generate-first-order-lab.py subcircuits/process_first_order_lab.lssubcircuit
See docs/53-laboratorio-calculo-experimentos-e-tanque.md §1 (experiment D).

First-order response for the Calculus Lab: a control.constant step u (live) feeds control.first_order
(gain K, time constant tau, initial y0 -- block properties, stop-required):
    y(t) = K·u + (y0 − K·u)·e^(−t/τ)
Everything runs at 10 ms; the block integrates continuously (RK4) between scheduler steps.
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


comp("c_u", "control.constant", {"value": 1.0, "unit": ""}, 40, 80, "Degrau de entrada u")
comp("fo", "control.first_order", {"gain": 2.0, "tau": 5.0, "initial": 0.0, "samplePeriodNs": PERIOD}, 240, 80, "Primeira ordem K/(τs+1)")
wire("c_u", "fo", "in")
comp("t_y", "connectors.signal_tunnel", {"name": "y", "pinId": "y", "direction": "Output", "valueType": "Real"}, 440, 80)
TUNNELS.add("t_y")
wire("fo", "t_y", "value")

W, H = 360, 200
exposed = []


def graphic(cid, type_id, props, x, y):
    comp(cid, type_id, props, x, y)
    exposed.append({"componentId": cid, "x": x, "y": y, "rotation": 0, "flipH": False, "flipV": False, "scale": 1, "layer": len(exposed)})


def binding(source, unit, decimals):
    return {"bindSource": source, "bindChannel": 0, "bindScale": 1, "bindOffset": 0, "bindMin": -1e9, "bindMax": 1e9, "bindUnit": unit, "bindDecimals": decimals}


for index, (cid, label, source, decimals) in enumerate([("g_u", "Entrada u", "c_u", 3), ("g_y", "Saída y", "fo", 4)]):
    graphic(cid, "graphics.value_display", {"width": 150, "height": 40, "stroke": "currentColor", "fill": "#f8fafc", "strokeWidth": 1.5, "opacity": 1,
                                            "label": label, "valueColor": "#0f172a", "value": 0, **binding(source, "", decimals)}, 190, 50 + index * 56)
shapes = [
    {"kind": "text", "x": 12, "y": 22, "value": "Resposta de primeira ordem", "fontSize": 13, "textAnchor": "start", "color": "#0f172a"},
    {"kind": "rect", "x": 24, "y": 60, "w": 130, "h": 80, "fill": "#e0f2fe", "stroke": "#0369a1", "strokeWidth": 1.5},
    {"kind": "text", "x": 89, "y": 96, "value": "K / (τs + 1)", "fontSize": 14, "textAnchor": "middle", "color": "#0c4a6e"},
    {"kind": "text", "x": 89, "y": 120, "value": "y = Ku + (y₀ − Ku)e^(−t/τ)", "fontSize": 9, "textAnchor": "middle", "color": "#0c4a6e"},
]
pins = [{"id": "y", "kind": "ANALOG_OUT", "x": W, "y": 100, "angle": 0, "length": 8, "label": "y"}]
interface = [{"pinId": "y", "label": "Saída y", "internalTunnel": "y", "domain": "signal", "direction": "out", "valueType": "Real", "width": 1}]

document = {
    "schemaVersion": 3,
    "typeId": "subcircuits.process.first_order_lab",
    "name": "Resposta de primeira ordem (laboratório)",
    "language": "pt-BR",
    "folderPath": ["Modelos"],
    "workspaceSection": "process",
    "help": {"description": (
        "Degrau u (constante, muda com a simulação rodando) aplicado a um bloco de primeira ordem K/(τs+1) com saída inicial y₀: "
        "y(t) = Ku + (y₀ − Ku)·e^(−t/τ). Ganho, constante de tempo e y₀ são propriedades do bloco (mudam com a simulação parada). "
        "Usado pelo experimento D do Laboratório de Cálculo (exponencial, valor final, tangente em t = 0, 63,2 %).")},
    "components": components,
    "topology": {"revision": 0, "nodes": [], "conductors": conductors},
    "interface": interface,
    "symbolMode": "custom",
    "symbol": {"width": W, "height": H, "border": True, "shapes": shapes, "pins": pins},
    "exposedComponents": exposed,
    "exportedPropertyComponentIds": ["c_u", "fo"],
}

with open(sys.argv[1], "w", encoding="utf-8", newline="\n") as handle:
    json.dump(document, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
print(f"{len(components)} components, {len(conductors)} wires, {len(exposed)} exposed")
