"""Gera o exemplo da etapa 1 do CLP: trm/plc/partida_pisca.iec.json + partida_pisca.lsproj.

Partida/parada com selo em ST: botão LIGA acende a lâmpada e ela continua acesa ao soltar; DESLIGA
apaga. Com a lâmpada acesa, um TON de 500 ms e um FB do aluno (TOGGLE) fazem a saída PISCA trocar a
cada 0,5 s e COUNT conta os ciclos. Pinos do CLP referenciados ao terra; saídas BOOL dão 0/5 V.

Uso: python scripts/generate-plc-partida-pisca.py
"""

import json
import os

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, "trm", "plc")
STAMP = "1791700000000"

MAIN_ST = "\n".join([
    "(* Partida e parada com selo: LIGA acende, DESLIGA apaga. *)",
    "RUN := (START OR RUN) AND NOT STOP;",
    "LAMP := RUN;",
    "",
    "(* Pisca de 0,5 s enquanto a lampada esta acesa. *)",
    "T1(IN := RUN AND NOT T1.Q, PT := T#500ms);",
    "FLIP(CLK := T1.Q);",
    "BLINK := FLIP.Q AND RUN;",
    "IF T1.Q THEN",
    "  COUNT := COUNT + 1;",
    "END_IF;",
])

TOGGLE_ST = "\n".join([
    "(* Inverte Q a cada borda de subida de CLK. *)",
    "EDGE(CLK := CLK);",
    "IF EDGE.Q THEN",
    "  Q := NOT Q;",
    "END_IF;",
])

# Mesmo programa em Lista de Instruções (etapa 2): operadores de entrada de FB (PT, IN, CLK), N,
# rótulos e JMPCN. O TOGGLE também em IL.
MAIN_IL = "\n".join([
    "(* Partida e parada com selo: LIGA acende, DESLIGA apaga. *)",
    "      LD    START",
    "      OR    RUN",
    "      ANDN  STOP",
    "      ST    RUN",
    "      ST    LAMP",
    "",
    "(* Pisca de 0,5 s enquanto a lampada esta acesa. *)",
    "      LD    T#500ms",
    "      ST    T1.PT       (* so grava a entrada: PT T1 tambem CHAMARIA o TON, e duas *)",
    "                        (* chamadas no mesmo scan engolem o pulso de T1.Q        *)",
    "      LD    RUN",
    "      ANDN  T1.Q",
    "      IN    T1          (* T1(IN := RUN AND NOT T1.Q) *)",
    "      LD    T1.Q",
    "      CLK   FLIP        (* FLIP(CLK := T1.Q) *)",
    "      LD    FLIP.Q",
    "      AND   RUN",
    "      ST    BLINK",
    "      LD    T1.Q",
    "      JMPCN FIM",
    "      LD    COUNT",
    "      ADD   1",
    "      ST    COUNT",
    "FIM:",
])

TOGGLE_IL = "\n".join([
    "(* Inverte Q a cada borda de subida de CLK. *)",
    "      LD    CLK",
    "      CLK   EDGE        (* EDGE(CLK := CLK) *)",
    "      LD    EDGE.Q",
    "      JMPCN FIM",
    "      LD    Q",
    "      NOT",
    "      ST    Q",
    "FIM:",
])

IO = [
    {"ioId": "START", "name": "START", "direction": "input", "iecType": "BOOL"},
    {"ioId": "STOP", "name": "STOP", "direction": "input", "iecType": "BOOL"},
    {"ioId": "LAMP", "name": "LAMP", "direction": "output", "iecType": "BOOL"},
    {"ioId": "BLINK", "name": "BLINK", "direction": "output", "iecType": "BOOL"},
]

IEC_PROJECT = {
    "schemaVersion": 1,
    "projectId": "partida_pisca",
    "dataTypes": [],
    "globalVariableLists": [],
    "configurations": [{"name": "CONFIGURATION_1", "resource": "RESOURCE_1"}],
    "resources": [{"name": "RESOURCE_1", "task": "MAIN_TASK"}],
    "tasks": [{"name": "MAIN_TASK", "intervalMs": 10, "priority": 1}],
    "programInstances": [{"name": "MAIN_INSTANCE", "pouId": "pou-main", "task": "MAIN_TASK"}],
    "pous": [
        {
            "pouId": "pou-main",
            "name": "MAIN",
            "kind": "program",
            "interface": {"variables": [
                {"ioId": "START", "name": "START", "class": "input", "type": "BOOL"},
                {"ioId": "STOP", "name": "STOP", "class": "input", "type": "BOOL"},
                {"ioId": "LAMP", "name": "LAMP", "class": "output", "type": "BOOL"},
                {"ioId": "BLINK", "name": "BLINK", "class": "output", "type": "BOOL"},
                {"name": "RUN", "class": "local", "type": "BOOL"},
                {"name": "COUNT", "class": "local", "type": "INT"},
                {"name": "T1", "class": "local", "type": "TON"},
                {"name": "FLIP", "class": "local", "type": "TOGGLE"},
            ]},
            "implementation": {"language": "st", "text": MAIN_ST},
        },
        {
            "pouId": "pou-toggle",
            "name": "TOGGLE",
            "kind": "functionBlock",
            "interface": {"variables": [
                {"ioId": "CLK", "name": "CLK", "class": "input", "type": "BOOL"},
                {"ioId": "Q", "name": "Q", "class": "output", "type": "BOOL"},
                {"name": "EDGE", "class": "local", "type": "R_TRIG"},
            ]},
            "implementation": {"language": "st", "text": TOGGLE_ST},
        },
    ],
    "libraries": [],
    "buildSettings": {"entryConfiguration": "CONFIGURATION_1"},
}


def component(key, type_id, label, x, y, properties=None, rotation=0, **extra):
    return {
        "id": f"component-{STAMP}-{key}",
        "typeId": type_id,
        "label": label,
        "showValue": False,
        "showDialValue": False,
        "visual": {"x": x, "y": y, "rotation": rotation},
        "properties": properties or {},
        **extra,
    }


def wire(key, a, a_pin, b, b_pin):
    return {
        "id": f"wire-{STAMP}-{key}",
        "from": {"kind": "port", "componentId": f"component-{STAMP}-{a}", "pinId": a_pin},
        "to": {"kind": "port", "componentId": f"component-{STAMP}-{b}", "pinId": b_pin},
        "vertices": [],
    }


COMPONENTS = [
    component("plc", "plc.instance", "CLP", 520, 300, {
        "plcIecProjectRef": "partida_pisca.iec.json",
        "plcArtifactRef": "",
        "plcEntryConfiguration": "CONFIGURATION_1",
        "plcTaskIntervalMs": 10,
    }, plc={
        "iecProjectRef": "partida_pisca.iec.json",
        "entryConfiguration": "CONFIGURATION_1",
        "exportedIoBindingVersion": 1,
        "exportedIo": IO,
    }),
    component("vcc", "sources.dc_voltage", "Fonte 5 V", 120, 260, {"voltage": 5}),
    component("liga", "switches.push", "LIGA", 300, 240, {"closed": False, "normallyClosed": False, "key": "L"}),
    component("desliga", "switches.push", "DESLIGA", 300, 330, {"closed": False, "normallyClosed": False, "key": "D"}),
    component("rliga", "passive.resistor", "R1 10k", 420, 420, {"resistance": 10000}, rotation=90),
    component("rdesliga", "passive.resistor", "R2 10k", 460, 420, {"resistance": 10000}, rotation=90),
    component("rlamp", "passive.resistor", "R3 330", 700, 280, {"resistance": 330}),
    component("lamp", "outputs.led", "Lâmpada", 800, 280, {"color": "Green", "threshold": 2.4, "resistance": 0.6}),
    component("rblink", "passive.resistor", "R4 330", 700, 360, {"resistance": 330}),
    component("blink", "outputs.led", "Pisca", 800, 360, {"color": "Yellow", "threshold": 2.4, "resistance": 0.6}),
    component("gnd", "other.ground", "GND", 520, 520),
]

WIRES = [
    wire("vcc-gnd", "vcc", "pin-2", "gnd", "pin"),
    wire("vcc-liga", "vcc", "pin-1", "liga", "pin-1"),
    wire("vcc-desliga", "vcc", "pin-1", "desliga", "pin-1"),
    wire("liga-start", "liga", "pin-2", "plc", "START"),
    wire("desliga-stop", "desliga", "pin-2", "plc", "STOP"),
    wire("start-r1", "plc", "START", "rliga", "pin-1"),
    wire("r1-gnd", "rliga", "pin-2", "gnd", "pin"),
    wire("stop-r2", "plc", "STOP", "rdesliga", "pin-1"),
    wire("r2-gnd", "rdesliga", "pin-2", "gnd", "pin"),
    wire("lamp-r3", "plc", "LAMP", "rlamp", "pin-1"),
    wire("r3-led", "rlamp", "pin-2", "lamp", "anode"),
    wire("led-gnd", "lamp", "cathode", "gnd", "pin"),
    wire("blink-r4", "plc", "BLINK", "rblink", "pin-1"),
    wire("r4-led", "rblink", "pin-2", "blink", "anode"),
    wire("led2-gnd", "blink", "cathode", "gnd", "pin"),
]

PROJECT = {
    "schemaVersion": 2,
    "components": COMPONENTS,
    "topology": {"revision": 1, "nodes": [], "conductors": WIRES},
    "visual": {"viewport": {"x": 0, "y": 0, "zoom": 1}},
    "simulationSettings": {},
}


def il_variant():
    """Projeto IEC e esquemático iguais, com MAIN e TOGGLE em IL."""
    project = json.loads(json.dumps(IEC_PROJECT))
    project["projectId"] = "partida_pisca_il"
    texts = {"pou-main": MAIN_IL, "pou-toggle": TOGGLE_IL}
    for pou in project["pous"]:
        pou["implementation"] = {"language": "il", "text": texts[pou["pouId"]]}
    schematic = json.loads(json.dumps(PROJECT))
    for item in schematic["components"]:
        if item["typeId"] == "plc.instance":
            item["properties"]["plcIecProjectRef"] = "partida_pisca_il.iec.json"
            item["plc"]["iecProjectRef"] = "partida_pisca_il.iec.json"
            item["label"] = "CLP (IL)"
    return project, schematic


def ld_contact(variable, kind="no"):
    return {"kind": "contact", "contact": kind, "variable": variable}


def ld_coil(variable, kind="coil"):
    return {"kind": "coil", "coil": kind, "variable": variable}


def ld_row(*cells, width=6):
    return list(cells) + [None] * (width - len(cells))


def ld_variant():
    """Mesmo programa em Ladder (etapa 4): o TOGGLE continua em ST e é chamado do LD."""
    project = json.loads(json.dumps(IEC_PROJECT))
    project["projectId"] = "partida_pisca_ld"
    rungs = [
        {"rungId": "rung-1", "comment": "Partida e parada com selo: LIGA acende, DESLIGA apaga.",
         "rows": [ld_row(ld_contact("START"), ld_contact("STOP", "nc"), ld_coil("RUN")), ld_row(ld_contact("RUN"))],
         "verticals": [{"row": 0, "column": 0}]},
        {"rungId": "rung-2", "rows": [ld_row(ld_contact("RUN"), ld_coil("LAMP"))], "verticals": []},
        {"rungId": "rung-3", "comment": "Pisca de 0,5 s enquanto a lampada esta acesa.",
         "rows": [ld_row(
             ld_contact("RUN"), ld_contact("T1.Q", "nc"),
             {"kind": "block", "typeName": "TON", "instanceName": "T1", "powerInput": "IN", "powerOutput": "Q", "inputs": {"PT": "T#500ms"}, "outputs": {}},
             {"kind": "block", "typeName": "TOGGLE", "instanceName": "FLIP", "powerInput": "CLK", "powerOutput": "Q", "inputs": {}, "outputs": {}},
             ld_contact("RUN"), ld_coil("BLINK"))],
         "verticals": []},
        {"rungId": "rung-4", "comment": "Conta os ciclos do temporizador.",
         "rows": [ld_row(ld_contact("T1.Q"),
                         {"kind": "block", "typeName": "ADD", "powerInput": "EN", "powerOutput": "ENO",
                          "inputs": {"IN1": "COUNT", "IN2": "1"}, "outputs": {"OUT": "COUNT"}})],
         "verticals": []},
    ]
    for pou in project["pous"]:
        if pou["pouId"] == "pou-main":
            pou["implementation"] = {"language": "ld", "networks": [], "rungs": rungs}
    schematic = json.loads(json.dumps(PROJECT))
    for item in schematic["components"]:
        if item["typeId"] == "plc.instance":
            item["properties"]["plcIecProjectRef"] = "partida_pisca_ld.iec.json"
            item["plc"]["iecProjectRef"] = "partida_pisca_ld.iec.json"
            item["label"] = "CLP (LD)"
    return project, schematic


def write(name, document):
    with open(os.path.join(OUT, name), "w", encoding="utf-8", newline="\n") as handle:
        handle.write(json.dumps(document, indent=2, ensure_ascii=False) + "\n")


def main():
    os.makedirs(OUT, exist_ok=True)
    write("partida_pisca.iec.json", IEC_PROJECT)
    write("partida_pisca.lsproj", PROJECT)
    il_project, il_schematic = il_variant()
    write("partida_pisca_il.iec.json", il_project)
    write("partida_pisca_il.lsproj", il_schematic)
    ld_project, ld_schematic = ld_variant()
    write("partida_pisca_ld.iec.json", ld_project)
    write("partida_pisca_ld.lsproj", ld_schematic)
    print("trm/plc/partida_pisca[_il|_ld].iec.json + .lsproj")


if __name__ == "__main__":
    main()
