"""Gera o exemplo SFC da etapa 3 do CLP: trm/plc/semaforo_sfc.iec.json + semaforo_sfc.lsproj.

Semáforo em SFC (IEC 61131-3, seção 6.7): VM (vermelho, inicial) 3 s -> VD (verde) -> AM (amarelo) 1 s
-> volta ao VM (salto). Do VD saem duas transições para o AM (divergência seletiva): prioridade 1, o
botão de pedestre com o verde aceso há pelo menos 1 s; prioridade 2, o verde completo de 4 s. A ação
CONTA (P1, corpo ST) soma um ciclo cada vez que o verde acende. LEDs ligados como ações booleanas N.

Uso: python scripts/generate-plc-semaforo-sfc.py
"""

import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "trm", "plc")
STAMP = "1791800000000"


def variable(name, variable_class, type_name):
    entry = {"name": name, "class": variable_class, "type": type_name}
    if variable_class in ("input", "output"):
        entry = {"ioId": name, **entry}
    return entry


def step(name, actions, initial=False):
    entry = {"stepId": f"step-{name.lower()}", "name": name, "actions": []}
    if initial:
        entry["initial"] = True
    for index, (qualifier, action) in enumerate(actions):
        entry["actions"].append({"actionId": f"a-{name.lower()}-{index + 1}", "qualifier": qualifier, "actionName": action})
    return entry


def transition(transition_id, source, target, condition, priority=None):
    entry = {"transitionId": transition_id, "fromStepIds": [f"step-{source.lower()}"], "toStepIds": [f"step-{target.lower()}"],
             "condition": condition}
    if priority is not None:
        entry["priority"] = priority
    return entry


IEC_PROJECT = {
    "schemaVersion": 1,
    "projectId": "semaforo_sfc",
    "dataTypes": [],
    "globalVariableLists": [],
    "configurations": [{"name": "CONFIGURATION_1", "resource": "RESOURCE_1"}],
    "resources": [{"name": "RESOURCE_1", "task": "MAIN_TASK"}],
    "tasks": [{"name": "MAIN_TASK", "intervalMs": 10, "priority": 1}],
    "programInstances": [{"name": "MAIN_INSTANCE", "pouId": "pou-main", "task": "MAIN_TASK"}],
    "pous": [{
        "pouId": "pou-main",
        "name": "MAIN",
        "kind": "program",
        "interface": {"variables": [
            variable("BOTAO", "input", "BOOL"),
            variable("VERMELHO", "output", "BOOL"),
            variable("AMARELO", "output", "BOOL"),
            variable("VERDE", "output", "BOOL"),
            variable("CICLOS", "local", "INT"),
        ]},
        "implementation": {
            "language": "sfc",
            "steps": [
                step("VM", [("N", "VERMELHO")], initial=True),
                step("VD", [("N", "VERDE"), ("P1", "CONTA")]),
                step("AM", [("N", "AMARELO")]),
            ],
            "transitions": [
                transition("t-vm-vd", "VM", "VD", "VM.T >= T#3s"),
                transition("t-vd-am-botao", "VD", "AM", "BOTAO AND VD.T >= T#1s", priority=1),
                transition("t-vd-am-tempo", "VD", "AM", "VD.T >= T#4s", priority=2),
                transition("t-am-vm", "AM", "VM", "AM.T >= T#1s"),
            ],
            "actions": [
                {"name": "CONTA", "language": "st",
                 "text": "(* P1: Q fica TRUE só no ciclo em que o verde acende; A roda mais uma vez quando Q cai. *)\nIF CONTA.Q THEN\n  CICLOS := CICLOS + 1;\nEND_IF;"},
            ],
        },
    }],
    "libraries": [],
    "buildSettings": {"entryConfiguration": "CONFIGURATION_1"},
}

IO = [
    {"ioId": "BOTAO", "name": "BOTAO", "direction": "input", "iecType": "BOOL"},
    {"ioId": "VERMELHO", "name": "VERMELHO", "direction": "output", "iecType": "BOOL"},
    {"ioId": "AMARELO", "name": "AMARELO", "direction": "output", "iecType": "BOOL"},
    {"ioId": "VERDE", "name": "VERDE", "direction": "output", "iecType": "BOOL"},
]


def component(key, type_id, label, x, y, properties=None, rotation=0, **extra):
    return {"id": f"component-{STAMP}-{key}", "typeId": type_id, "label": label, "showValue": False, "showDialValue": False,
            "visual": {"x": x, "y": y, "rotation": rotation}, "properties": properties or {}, **extra}


def wire(key, a, a_pin, b, b_pin):
    return {"id": f"wire-{STAMP}-{key}",
            "from": {"kind": "port", "componentId": f"component-{STAMP}-{a}", "pinId": a_pin},
            "to": {"kind": "port", "componentId": f"component-{STAMP}-{b}", "pinId": b_pin}, "vertices": []}


COMPONENTS = [
    component("plc", "plc.instance", "CLP (SFC)", 520, 300, {
        "plcIecProjectRef": "semaforo_sfc.iec.json", "plcArtifactRef": "", "plcEntryConfiguration": "CONFIGURATION_1", "plcTaskIntervalMs": 10,
    }, plc={"iecProjectRef": "semaforo_sfc.iec.json", "entryConfiguration": "CONFIGURATION_1", "exportedIoBindingVersion": 1, "exportedIo": IO}),
    component("vcc", "sources.dc_voltage", "Fonte 5 V", 120, 260, {"voltage": 5}),
    component("botao", "switches.push", "PEDESTRE", 300, 260, {"closed": False, "normallyClosed": False, "key": "P"}),
    component("rbotao", "passive.resistor", "R1 10k", 420, 420, {"resistance": 10000}, rotation=90),
    component("rvm", "passive.resistor", "R2 330", 700, 240, {"resistance": 330}),
    component("vm", "outputs.led", "Vermelho", 800, 240, {"color": "Red", "threshold": 2.4, "resistance": 0.6}),
    component("ram", "passive.resistor", "R3 330", 700, 310, {"resistance": 330}),
    component("am", "outputs.led", "Amarelo", 800, 310, {"color": "Yellow", "threshold": 2.4, "resistance": 0.6}),
    component("rvd", "passive.resistor", "R4 330", 700, 380, {"resistance": 330}),
    component("vd", "outputs.led", "Verde", 800, 380, {"color": "Green", "threshold": 2.4, "resistance": 0.6}),
    component("gnd", "other.ground", "GND", 520, 520),
]

WIRES = [
    wire("vcc-gnd", "vcc", "pin-2", "gnd", "pin"),
    wire("vcc-botao", "vcc", "pin-1", "botao", "pin-1"),
    wire("botao-plc", "botao", "pin-2", "plc", "BOTAO"),
    wire("plc-r1", "plc", "BOTAO", "rbotao", "pin-1"),
    wire("r1-gnd", "rbotao", "pin-2", "gnd", "pin"),
    wire("vm-r", "plc", "VERMELHO", "rvm", "pin-1"),
    wire("vm-led", "rvm", "pin-2", "vm", "anode"),
    wire("vm-gnd", "vm", "cathode", "gnd", "pin"),
    wire("am-r", "plc", "AMARELO", "ram", "pin-1"),
    wire("am-led", "ram", "pin-2", "am", "anode"),
    wire("am-gnd", "am", "cathode", "gnd", "pin"),
    wire("vd-r", "plc", "VERDE", "rvd", "pin-1"),
    wire("vd-led", "rvd", "pin-2", "vd", "anode"),
    wire("vd-gnd", "vd", "cathode", "gnd", "pin"),
]

PROJECT = {
    "schemaVersion": 2,
    "components": COMPONENTS,
    "topology": {"revision": 1, "nodes": [], "conductors": WIRES},
    "visual": {"viewport": {"x": 0, "y": 0, "zoom": 1}},
    "simulationSettings": {},
}


def main():
    os.makedirs(OUT, exist_ok=True)
    for name, document in (("semaforo_sfc.iec.json", IEC_PROJECT), ("semaforo_sfc.lsproj", PROJECT)):
        with open(os.path.join(OUT, name), "w", encoding="utf-8", newline="\n") as handle:
            handle.write(json.dumps(document, indent=2, ensure_ascii=False) + "\n")
    print("trm/plc/semaforo_sfc.iec.json + semaforo_sfc.lsproj")


if __name__ == "__main__":
    main()
