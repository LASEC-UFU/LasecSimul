"""Generates subcircuits/hart_smar_fy301.lssubcircuit: the Smar FY301 valve positioner.

Usage: python scripts/generate-fy301.py subcircuits/hart_smar_fy301.lssubcircuit
See docs/fy301-posicionador.md.

One standard HART field device (`protocol.hart.device.standard`) in current-input mode (the FY301 is
loop powered: a ~550 ohm load that reads the 4-20 mA written by the controller and answers HART with
a voltage carrier) plus the positioner, built from generic signal blocks:

  4-20 mA -> split range -> Auto/Man -> characterization (CHAR) -> setpoint limits / TSO -> TIME
  -> servo PI (KP, TR) against the position read by the Hall sensor (calibrated by Auto Setup,
  trimmed by LOPOS/UPPOS, direct or reverse action by TYPE, AIR_T) -> OUT1 = % of the air supply.

Pins: LOOP+/LOOP- (electrical), SUP (air supply, bar, in), OUT1 (output pressure, bar, out) and
POS (stem travel seen by the magnet, mm, in). The local adjustment parameters of the manual (section
4: TYPE, CHAR, MODE, SP%, LOPOS, UPPOS, TIME, KP, TR, SETUP, AIR_T) are exported properties: in the
simulator they play the magnetic screwdriver. HART answers the Universal/Common Practice commands; the
FY301 vendor commands are not captured yet (trm/fy301/Falta_fazer.txt).
"""
import json
import sys

PERIOD = 1_000_000  # 1 ms: the servo loop (positioner + actuator) needs a short step at the high gain of a positioner

components = []
conductors = []


def comp(cid, type_id, props, x, y, label=None):
    entry = {"id": cid, "typeId": type_id, "properties": props, "visual": {"x": x, "y": y, "rotation": 0}}
    if label:
        entry["label"] = label
    components.append(entry)


def link(a, a_pin, b, b_pin):
    conductors.append({"id": f"w-{len(conductors) + 1}", "from": {"kind": "port", "componentId": a, "pinId": a_pin},
                       "to": {"kind": "port", "componentId": b, "pinId": b_pin}, "points": []})


SOURCES = {}  # block id -> output pin


def out_of(source):
    return SOURCES.get(source, "out")


_slot = [0]


def calc(cid, inputs, expression, label):
    slot = _slot[0]
    _slot[0] += 1
    comp(cid, "control.calc_expression", {"expression": expression, "inputs": [name for name, _ in inputs],
                                          "upperLimit": 0, "lowerLimit": 0, "upperLimitEnabled": False, "lowerLimitEnabled": False,
                                          "samplePeriodNs": PERIOD}, 640 + 220 * (slot // 12), 300 + 60 * (slot % 12), label)
    for name, source in inputs:
        link(source, out_of(source), cid, name)


def clamp(expr, low, high):
    return f"({expr})+(({expr})<{low})*({low}-({expr}))+(({expr})>{high})*({high}-({expr}))"


# --- HART device ----------------------------------------------------------------------------------
variables = [
    {"id": "PV", "name": "Setpoint (sinal de entrada 4-20 mA)", "role": "PV", "type": "Float32", "direction": "Input", "unit": "",
     "value": 0.0, "deviceVariableCode": 0, "deviceVariableUnit": 57, "classification": 91, "family": 6,
     "lowerRangeValue": 0.0, "upperRangeValue": 100.0, "dampingValue": 0.0},
    {"id": "position", "name": "Posicao da valvula", "role": "SV", "type": "Float32", "direction": "Input", "unit": "",
     "value": 0.0, "deviceVariableCode": 1, "deviceVariableUnit": 57, "classification": 91, "family": 6},
    {"id": "inputCurrent", "name": "Corrente de entrada", "role": "TV", "type": "Float32", "direction": "Output", "unit": "",
     "value": 0.0, "deviceVariableCode": 2, "deviceVariableUnit": 39},
    {"id": "outputPressure", "name": "Pressao de saida (OUT1)", "role": "QV", "type": "Float32", "direction": "Input", "unit": "",
     "value": 0.0, "deviceVariableCode": 3, "deviceVariableUnit": 7},
    {"id": "spFinal", "name": "Setpoint de posicao (apos curva, limites e TIME)", "role": "VendorSpecific", "type": "Float32",
     "direction": "Input", "unit": "", "value": 0.0, "deviceVariableCode": 4, "deviceVariableUnit": 57},
]
device_props = {
    "enabled": True, "pollingAddress": 0, "profileId": "lasecsimul.hart.standard-field-device",
    "alarmSelectionCode": 0, "configurationChangedFlags": 0, "dateDay": 1, "dateMonth": 1, "dateYear": 124,
    "descriptor": "POSICIONADOR", "finalAssemblyNumber": 0, "message": "", "tag": "FY301", "uniqueId": "0B2A61", "unit": "%",
    "writeProtectCode": 0,
    "sensorLowVolts": 0.0, "sensorHighVolts": 5.0, "sensorLowValue": 0.0, "sensorHighValue": 100.0,
    "hartManufacturerId": 62, "hartDeviceType": 3, "hartRequestPreambles": 5, "hartUniversalRevision": 5, "hartDeviceRevision": 1,
    "hartSoftwareRevision": 4, "hartHardwareRevision": 1, "hartFlags": 0, "hartImplementedRevision": 5,
    "hartCommandSet": "0-3,6,11-19,33-48,59", "hartWriteProtectActiveCode": 1,
    "analogSaturationLowPercent": -25.0, "analogSaturationHighPercent": 125.0,
    "analogLoopDirection": "input", "analogInputResistance": 550.0, "analogInputMinimumMilliamps": 3.8,
    "analogInputVariable": "inputCurrent", "sensorFault": False,
    "displayInstalled": True, "displayModelName": "FY301", "displayVariable1": "dv:1", "displayVariable2": "dv:4",
    "displayCodeMap": "", "displayGlass": 0,
    "hartVariablesJson": json.dumps(variables, ensure_ascii=False, separators=(",", ":")),
    # Universal and Common Practice commands only (built in). The FY301 vendor commands and the exact
    # content of its Command 3 are not captured yet: position and input current are read with
    # Command 33 (device variables 1 and 2).
    "hartCommandsJson": "[]",
}
comp("fy301", "protocol.hart.device.standard", device_props, 320, 40)
comp("tunnel_loop_plus", "connectors.tunnel", {"name": "loop_plus", "pinId": "loop_plus"}, 520, 60)
comp("tunnel_loop_minus", "connectors.tunnel", {"name": "loop_minus", "pinId": "loop_minus"}, 520, 100)
link("tunnel_loop_plus", "pin", "fy301", "loop_plus")
link("tunnel_loop_minus", "pin", "fy301", "loop_minus")
SOURCES["fy301"] = "inputCurrent"

# --- pneumatic / mechanical pins (signals) ----------------------------------------------------------------
comp("t_supply", "connectors.signal_tunnel", {"name": "supply", "pinId": "supply", "direction": "Input", "valueType": "Real", "defaultValue": 0},
     40, 60)
comp("t_position", "connectors.signal_tunnel", {"name": "position", "pinId": "position", "direction": "Input", "valueType": "Real",
                                                 "defaultValue": 0}, 40, 120)
comp("t_out1", "connectors.signal_tunnel", {"name": "out1", "pinId": "out1", "direction": "Output", "valueType": "Real"}, 40, 180)
SOURCES["t_supply"] = "value"
SOURCES["t_position"] = "value"

# --- local adjustment (exported): manual section 4 ---------------------------------------------------------
PARAMETERS = [  # id, label, default, unit, options
    ("c_type", "TYPE — Tipo de válvula e ação", 0, "", "0=Lind (linear, direta);1=Linr (linear, reversa);2=Rotd (rotativa, direta);3=Rotr (rotativa, reversa)"),
    ("c_air", "AIR_T — Efeito do ar", 0, "", "0=AIR_OPEN (o ar aumenta a posição);1=AIR_CLOSED (o ar diminui a posição)"),
    ("c_char", "CHAR — Curva de caracterização", 0, "",
     "0=Lin (linear);1=EP 1:25 (igual porcentagem);2=EP 1:33;3=EP 1:50;4=AR 1:25 (abertura rápida, hiperbólica);5=AR 1:33;6=AR 1:50"),
    ("c_mode", "MODE — Modo de operação", 0, "", "0=Auto (segue os 4-20 mA);1=Man (segue o SP%)"),
    ("c_sp", "SP% — Setpoint no modo manual", 0, "%", ""),
    ("c_time", "TIME — Tempo de variação do setpoint (0 a 100 %)", 1, "s", ""),
    ("c_kp", "KP — Ganho proporcional do servo", 40, "", ""),
    ("c_tr", "TR — Tempo integral do servo", 2, "min/rep", ""),
    ("c_lopos", "LOPOS — Ajuste da posição inferior", 0, "%", ""),
    ("c_uppos", "UPPOS — Ajuste da posição superior", 100, "%", ""),
    ("c_tso", "TSO — Fechamento estanque abaixo de (0 = desligado)", 0, "%", ""),
    ("c_spl", "Limite inferior do setpoint", 0, "%", ""),
    ("c_sph", "Limite superior do setpoint", 100, "%", ""),
    ("c_slo", "Split range: corrente do 0 %", 4, "mA", ""),
    ("c_shi", "Split range: corrente do 100 %", 20, "mA", ""),
    ("c_setup", "SETUP — Auto Setup (mude para Executar para iniciar)", 0, "", "0=Parado;1=Executar"),
]
for index, (cid, label, value, unit, options) in enumerate(PARAMETERS):
    props = {"value": value, "unit": unit}
    if options:
        props["options"] = options
    comp(cid, "control.constant", props, 200, 260 + index * 60, label)
comp("c_factory_span", "control.constant", {"value": 30, "unit": "mm"}, 40, 260, "Curso de fábrica do sensor de posição (antes do Auto Setup)")

# --- input: 4-20 mA -> setpoint ------------------------------------------------------------------------------
calc("pv_in", [("i", "fy301")], "(i-4)/16*100", "PV: sinal de entrada em % (4-20 mA)")
link("pv_in", "out", "fy301", "PV")
calc("in_pct", [("i", "fy301"), ("lo", "c_slo"), ("hi", "c_shi")],
     clamp("(i-lo)/(((hi-lo)>0.1)*(hi-lo)+((hi-lo)<0.1001)*0.1)*100", 0, 100), "Entrada em % do split range")
calc("sp_src", [("x", "in_pct"), ("m", "c_mode"), ("sp", "c_sp")], "(m<0.5)*x+(m>0.5)*(" + clamp("sp", 0, 100) + ")",
     "Setpoint: Auto (4-20 mA) ou Man (SP%)")


def ep(r):
    return f"100*({r}^(x/100)-1)/({r}-1)"


def qo(r):
    return f"100*{r}*(x/100)/(1+({r}-1)*(x/100))"


curves = ["x", ep(25), ep(33), ep(50), qo(25), qo(33), qo(50)]
char_expr = "+".join(f"(c>{k - 0.5})*(c<{k + 0.5})*({curve})" for k, curve in enumerate(curves))
calc("sp_char", [("x", "sp_src"), ("c", "c_char")], char_expr, "CHAR: setpoint caracterizado (%)")
calc("sp_lim", [("x", "sp_char"), ("lo", "c_spl"), ("hi", "c_sph")], clamp("x", "lo", "hi"), "Limites do setpoint")
calc("sp_t", [("x", "sp_lim"), ("c", "sp_char"), ("t", "c_tso")], "(t>0.0001)*(c<t)*(0-5)+(1-(t>0.0001)*(c<t))*x",
     "TSO: abaixo do limite, fecha estanque")
calc("sp_rate", [("x", "sp_t"), ("r", "sp_r"), ("T", "c_time")],
     clamp("20*(x-r)", "(0-100/((T>0.1)*T+(T<0.1001)*0.1))", "(100/((T>0.1)*T+(T<0.1001)*0.1))"), "TIME: taxa do setpoint (%/s)")
comp("sp_r", "control.integrator", {"gain": 1, "initial": 0, "samplePeriodNs": PERIOD}, 420, 600, "Setpoint de posição (%)")
link("sp_rate", "out", "sp_r", "in")
link("sp_r", "out", "fy301", "spFinal")

# --- Auto Setup ----------------------------------------------------------------------------------------------
calc("setup_in", [("s", "c_setup")], "(s>0.5)", "Auto Setup: contagem")
calc("setup_reset", [("s", "c_setup"), ("t", "setup_timer")], "(s<0.5)*10*t", "Auto Setup: zera")
comp("setup_timer", "control.tank", {"area": 1, "initial": 0, "samplePeriodNs": PERIOD}, 420, 660, "Tempo do Auto Setup (s)")
link("setup_in", "out", "setup_timer", "in")
link("setup_reset", "out", "setup_timer", "outflow")
calc("setup_active", [("s", "c_setup"), ("t", "setup_timer")], "(s>0.5)*(t<50)", "Auto Setup em andamento")
calc("setup_progress", [("s", "c_setup"), ("t", "setup_timer")], "(s>0.5)*((t<50)*t*2+(t>49.9999)*100)", "Auto Setup (%)")
for name, start, end, initial, source in (("rest", 20, 25, 0, None), ("full", 45, 50, None, "c_factory_span")):
    gate = f"(s>0.5)*(t>{start})*(t<{end})"
    calc(f"hold_{name}_in", [("s", "c_setup"), ("t", "setup_timer"), ("x", "t_position"), ("h", f"hold_{name}")],
         f"{gate}*((x-h)>0)*(x-h)*5", f"Auto Setup: grava a posição ({name})")
    calc(f"hold_{name}_out", [("s", "c_setup"), ("t", "setup_timer"), ("x", "t_position"), ("h", f"hold_{name}")],
         f"{gate}*((h-x)>0)*(h-x)*5", f"Auto Setup: grava a posição ({name})")
    comp(f"hold_{name}", "control.tank", {"area": 1, "initial": 30 if name == "full" else 0, "samplePeriodNs": PERIOD}, 420,
         720 + 60 * (name == "full"), "Posição sem ar (mm)" if name == "rest" else "Posição com ar total (mm)")
    link(f"hold_{name}_in", "out", f"hold_{name}", "in")
    link(f"hold_{name}_out", "out", f"hold_{name}", "outflow")

# --- position: Hall sensor, calibration, trims, action --------------------------------------------------------
calc("pos_raw", [("x", "t_position"), ("a", "hold_rest"), ("b", "hold_full")],
     "(x-((a<b)*a+(1-(a<b))*b))/((((a<b)*b+(1-(a<b))*a)-((a<b)*a+(1-(a<b))*b)>0.1)*(((a<b)*b+(1-(a<b))*a)-((a<b)*a+(1-(a<b))*b))"
     "+((((a<b)*b+(1-(a<b))*a)-((a<b)*a+(1-(a<b))*b))<0.1001)*0.1)*100",
     "Abertura medida pelo sensor (% do curso calibrado)")
calc("pos_trim", [("p", "pos_raw"), ("lo", "c_lopos"), ("up", "c_uppos")],
     "(p-lo)/((((up-lo)>0.1)*(up-lo))+(((up-lo)<0.1001)*0.1))*100", "LOPOS/UPPOS")
calc("pos", [("p", "pos_trim"), ("k", "c_type")], "(1-((k>0.5)*(k<1.5)+(k>2.5)))*p+((k>0.5)*(k<1.5)+(k>2.5))*(100-p)",
     "Posição (%): direta ou reversa (TYPE)")
link("pos", "out", "fy301", "position")

# --- servo PI and pneumatic output ------------------------------------------------------------------------------
calc("err", [("r", "sp_r"), ("p", "pos"), ("a", "c_air")], "(1-2*(a>0.5))*(r-p)", "Desvio do servo (com o efeito do ar)")
# Internal gain: KP x 3 (piezo flapper + spool amplification): with the manual's typical KP 35-45 the
# valve settles in about a second, the integral (TR) removes the last tenths of %; KP near 0.5 is slow.
calc("u", [("e", "err"), ("i", "servo_i"), ("kp", "c_kp")], "3*kp*(e+i)", "Saída do PI (%)")
calc("servo_i_in", [("e", "err"), ("u", "u"), ("tr", "c_tr"), ("a", "setup_active"), ("i", "servo_i")],
     "(1-a)*(tr>0.001)*(1-(u>100)*(e>0)-(u<0)*(e<0))*e/((((tr>0.001)*tr)+((tr<0.0011)*1))*60)-a*5*i",
     "TR: integral (anti-saturação; zerada no Auto Setup)")
comp("servo_i", "control.integrator", {"gain": 1, "initial": 0, "samplePeriodNs": PERIOD}, 420, 840, "Integral do servo")
link("servo_i_in", "out", "servo_i", "in")
# Below 3.8 mA the FY301 is off: the piezo is de-energized, OUT1 vents and the spring takes the valve to its fail position.
calc("out_pct", [("u", "u"), ("a", "setup_active"), ("t", "setup_timer"), ("i", "fy301")],
     "(i>3.8)*(a*(t>25)*100+(1-a)*(" + clamp("u", 0, 100) + "))",
     "Sinal do piezo/carretel (% do suprimento); sem sinal (< 3,8 mA) a saída esvazia")
calc("out1_bar", [("o", "out_pct"), ("s", "t_supply")], "o/100*((s>0)*s)", "OUT1 (bar)")
link("out1_bar", "out", "t_out1", "value")
link("out1_bar", "out", "fy301", "outputPressure")

# --- symbol: the FY301 picture, the LCD above it ----------------------------------------------------------------
# The picture between two 40 px bands: the pin labels (SUP, OUT1, POS, LOOP+, LOOP-) stay off the gauges.
W, H = 230, 200
shapes = [{"kind": "image", "href": "./fy301.svg", "x": 48, "y": 76, "w": 134, "h": 104, "preserveAspectRatio": "xMidYMid meet"}]
pins = [
    {"id": "supply", "kind": "ANALOG_IN", "x": 0, "y": 130, "angle": 180, "length": 8, "label": "SUP"},
    {"id": "out1", "kind": "ANALOG_OUT", "x": 0, "y": 150, "angle": 180, "length": 8, "label": "OUT1"},
    {"id": "position", "kind": "ANALOG_IN", "x": 0, "y": 170, "angle": 180, "length": 8, "label": "POS"},
    {"id": "loop_plus", "kind": "POWER", "x": W, "y": 140, "angle": 0, "length": 8, "label": "LOOP+"},
    {"id": "loop_minus", "kind": "POWER", "x": W, "y": 160, "angle": 0, "length": 8, "label": "LOOP-"},
]
interface = [
    {"pinId": "supply", "label": "Suprimento de ar (bar)", "internalTunnel": "supply", "domain": "signal", "direction": "in", "valueType": "Real", "width": 1},
    {"pinId": "out1", "label": "Saída pneumática OUT1 (bar)", "internalTunnel": "out1", "domain": "signal", "direction": "out", "valueType": "Real", "width": 1},
    {"pinId": "position", "label": "Posição da haste no ímã (mm)", "internalTunnel": "position", "domain": "signal", "direction": "in", "valueType": "Real", "width": 1},
    {"pinId": "loop_plus", "label": "LOOP+", "internalTunnel": "loop_plus", "domain": "electrical"},
    {"pinId": "loop_minus", "label": "LOOP-", "internalTunnel": "loop_minus", "domain": "electrical"},
]
document = {
    "schemaVersion": 3,
    "typeId": "subcircuits.hart.smar_fy301",
    "name": "SMAR FY301",
    "language": "pt-BR",
    "translations": {"en": {"name": "SMAR FY301"}},
    "folderPath": ["Protocolos Industriais", "HART"],
    "workspaceSection": "process",
    "help": {"description": (
        "Posicionador de válvula SMAR FY301 (HART). Alimentado pelo próprio laço: os bornes + e − recebem o sinal de 4-20 mA "
        "escrito pelo controlador (carga de cerca de 550 Ω, mínimo de 3,8 mA) e respondem HART modulando a tensão; ligue o "
        "modem HART em paralelo na linha. SUP recebe o suprimento de ar, OUT1 vai ao atuador e POS é a posição da haste lida "
        "pelo ímã (sensor Hall). Os parâmetros do ajuste local do manual (TYPE, AIR_T, CHAR, MODE, SP%, TIME, KP, TR, LOPOS, "
        "UPPOS, SETUP, TSO, limites e split range) ficam em Propriedades Exportadas. O display mostra a posição e o setpoint.")},
    "components": components,
    "topology": {"revision": 0, "nodes": [], "conductors": conductors},
    "interface": interface,
    "symbolMode": "custom",
    "iconPath": "./fy301.svg",
    "symbol": {"width": W, "height": H, "border": False, "shapes": shapes, "pins": pins},
    "exposedComponents": [{"componentId": "fy301", "x": 63, "y": 4, "rotation": 0, "flipH": False, "flipV": False, "scale": 1, "layer": 0}],
    "exportedPropertyComponentIds": ["fy301"] + [cid for cid, *_ in PARAMETERS],
}
with open(sys.argv[1], "w", encoding="utf-8", newline="\n") as handle:
    json.dump(document, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
print(f"{len(components)} components, {len(conductors)} wires")
