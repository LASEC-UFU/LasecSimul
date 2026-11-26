"""Generates subcircuits/hart_smar_fy301.lssubcircuit: the Smar FY301 valve positioner.

Usage: python scripts/generate-fy301.py subcircuits/hart_smar_fy301.lssubcircuit
See docs/fy301-posicionador.md and docs/fy301-dtm-engenharia-reversa.md.

The HART side follows the Smar device description (DD) of the FY301, device revision 2 (DD 0202,
`C:\\Program Files (x86)\\Smar\\HART\\DD\\00003e\\0003`), decoded by `scripts/fy301_dd_decode.py`,
and the traffic of the Smar FY301 DTM 3.02 recorded through LasecFDT:

- every configuration parameter is a HART variable written by the DTM (valve action, AIR_T,
  characterization through Command 47, KP, TR, TIME, set point limits, TSO, split range through
  Command 35 in mA, local/remote set point, table, Auto Setup through Command 152 ...). The model
  reads them from the device's output pins: the device is the only owner of its configuration, as in
  the real positioner;
- the device variables are the ones the DTM monitors with Command 33 (0 input mA, 1 PV = position,
  2 input %, 3 MV, 4 error, 6 set point, 7 integral, 8 Hall, 9 temperature ... 25 supply pressure);
- Command 48 byte 1 is the setup status (DD `setup_status`), Command 33 code 17 the setup progress.

Pins: LOOP+/LOOP- (electrical, loop powered ~550 ohm), SUP (air supply, bar, in), OUT1 (output
pressure, bar, out) and POS (stem travel seen by the magnet, mm, in).
"""
import json
import re
import sys

TS = "0.001"   # 1 ms: the servo loop (positioner + actuator) needs a short step at the high gain of a positioner
DT = 0.001
DEVICE = "fy301"

components = []
conductors = []
SRC = {}       # block id -> output pin id (sl.fcn/sl.unit_delay: out1)


def comp(cid, type_id, props, x, y, label=None):
    entry = {"id": cid, "typeId": type_id, "properties": props, "visual": {"x": x, "y": y, "rotation": 0}}
    if label:
        entry["label"] = label
    components.append(entry)


def link(a, a_pin, b, b_pin):
    conductors.append({"id": f"w-{len(conductors) + 1}", "from": {"kind": "port", "componentId": a, "pinId": a_pin},
                       "to": {"kind": "port", "componentId": b, "pinId": b_pin}, "points": []})


def endpoint(source):
    """(component id, pin id) of a source handle; 'hart:<variable>' is an output pin of the HART device."""
    if source.startswith("hart:"):
        return DEVICE, source[5:]
    return source, SRC.get(source, "out1")


_slot = [0]


def place():
    slot = _slot[0]
    _slot[0] += 1
    return 700 + 260 * (slot // 14), 300 + 70 * (slot % 14)


def expand_minmax(expr):
    """The Fcn block has no min/max: min(a,b) = (a+b-|a-b|)/2, max(a,b) = (a+b+|a-b|)/2 (nested calls too)."""
    while True:
        match = re.search(r"(?<![\w.])(min|max)\(", expr)
        if not match:
            return expr
        start, depth, comma, end = match.end(), 1, None, None
        for i in range(start, len(expr)):
            if expr[i] == "(":
                depth += 1
            elif expr[i] == ")":
                depth -= 1
                if depth == 0:
                    end = i
                    break
            elif expr[i] == "," and depth == 1:
                comma = i
        a, b = expand_minmax(expr[start:comma]), expand_minmax(expr[comma + 1:end])
        sign = "-" if match.group(1) == "min" else "+"
        expr = f"{expr[:match.start()]}((({a})+({b}){sign}abs(({a})-({b})))/2){expr[end + 1:]}"


def fcn(cid, inputs, expr, label):
    """sl.fcn with named inputs (a Mux in front when there is more than one)."""
    x, y = place()
    expr = expand_minmax(expr)
    names = [name for name, _ in inputs]
    for k, name in sorted(enumerate(names, start=1), key=lambda item: -len(item[1])):
        expr = re.sub(rf"(?<![\w.]){re.escape(name)}(?![\w(])", f"u({k})", expr)
    comp(cid, "sl.fcn", {"Expr": expr, "SampleTime": TS}, x, y, label)
    if len(inputs) == 1:
        link(*endpoint(inputs[0][1]), cid, "in1")
    else:
        mux = f"{cid}__mux"
        comp(mux, "sl.mux", {"Inputs": str(len(inputs))}, x - 60, y)
        for k, (_, source) in enumerate(inputs, start=1):
            link(*endpoint(source), mux, f"in{k}")
        link(mux, "out1", cid, "in1")


def delay(cid, source, initial, label):
    """sl.unit_delay: the previous sample (memory of a discrete state)."""
    x, y = place()
    comp(cid, "sl.unit_delay", {"InitialCondition": str(initial), "SampleTime": TS}, x, y, label)
    link(*endpoint(source), cid, "in1")


def clamp(expr, low, high):
    return f"min(max({expr},{low}),{high})"


# =================================================================================================
# HART device: variables
# =================================================================================================
UNIT_MA, UNIT_PCT, UNIT_BAR, UNIT_DEGC, UNIT_DEGF, UNIT_MM, UNIT_S, UNIT_NONE = 39, 57, 7, 32, 33, 49, 51, 250


def dv(vid, name, code, unit, direction="Input", value=0.0, **extra):
    v = {"id": vid, "name": name, "role": "DeviceSpecific", "type": "Float32", "direction": direction, "unit": "",
         "value": value, "deviceVariableCode": code, "deviceVariableUnit": unit}
    v.update(extra)
    return v


def par(vid, name, value=0, typ="UInt8", direction="Internal", **extra):
    v = {"id": vid, "name": name, "role": "VendorSpecific", "type": typ, "direction": direction, "unit": "", "value": value}
    v.update(extra)
    return v


def txt(vid, name, text, width):
    return {"id": vid, "name": name, "role": "VendorSpecific", "type": "Ascii", "direction": "Internal", "unit": "",
            "value": 0.0, "text": text, "width": width}


variables = [
    # Device variables (Command 33 codes read by the DTM "Observe" page and Commands 1/3)
    {"id": "PV", "name": "PV: posicao da valvula", "role": "PV", "type": "Float32", "direction": "Input", "unit": "%",
     "value": 0.0, "deviceVariableCode": 1, "deviceVariableUnit": UNIT_PCT, "classification": 0, "family": 250,
     # Range = input split range in mA (Command 15/35, DD pv_urv/pv_lrv "URV mA"/"LRV mA")
     "lowerRangeValue": 4.0, "upperRangeValue": 20.0, "rangeUnitCode": UNIT_MA, "allowedUnitCodes": [UNIT_MA],
     "upperTransducerLimit": 20.0, "lowerTransducerLimit": 4.0, "minimumSpan": 4.0, "transducerSerialNumber": 76543},
    dv("inputCurrent", "Corrente de entrada (mA)", 0, UNIT_MA, "Output"),
    dv("inputPercent", "Entrada (% do split range)", 2, UNIT_PCT, "Output", derivedSource=243),
    dv("mv", "MV: sinal do piezo (%)", 3, UNIT_PCT),
    dv("error", "Desvio SP - PV (%)", 4, UNIT_PCT),
    dv("setpoint", "SP: setpoint de posicao (%)", 6, UNIT_PCT),
    dv("integral", "Parcela integral do servo (%)", 7, UNIT_PCT),
    dv("hall", "Sensor Hall (contagens)", 8, UNIT_NONE),
    dv("temperature", "Temperatura (C)", 9, UNIT_DEGC, value=30.0),
    dv("piezo", "Tensao do piezo (%)", 10, UNIT_PCT),
    dv("temperatureF", "Temperatura (F)", 11, UNIT_DEGF, value=86.0),
    dv("mileage", "Odometro (mm)", 12, UNIT_MM),
    dv("strokes", "Cursos completos", 13, UNIT_NONE),
    dv("reversals", "Reversoes", 14, UNIT_NONE),
    dv("temperatureLow", "Menor temperatura (C)", 15, UNIT_DEGC, value=30.0),
    dv("temperatureHigh", "Maior temperatura (C)", 16, UNIT_DEGC, value=30.0),
    dv("setupProgress", "Progresso do Auto Setup (%)", 17, UNIT_PCT),
    dv("openingTime", "Tempo de abertura (s)", 20, UNIT_S),
    dv("closingTime", "Tempo de fechamento (s)", 21, UNIT_S),
    dv("out1", "Pressao OUT1 (bar)", 23, UNIT_BAR),
    dv("out2", "Pressao OUT2 (bar)", 24, UNIT_BAR),
    dv("supplyPressure", "Pressao de suprimento (bar)", 25, UNIT_BAR),
    # Command 47 code (DD flow_char): 0 Linear, 1 EP 1:50, 2 QO 1:50, 3 Table, 4 EP 1:25, 5 QO 1:25, 6 EP 1:33, 7 QO 1:33
    par("flowChar", "Caracterizacao (Cmd 47)", 0, "UInt8", "Output", derivedSource=247),
    # Setup status (Command 48 byte 1, DD setup_status)
    par("setup.status", "Estado do setup", 0, "UInt8", "Input",
        codes={"0": "None", "1": "Low Air Supply", "2": "No Magnet", "3": "No Hall", "15": "Setup in Process",
               "16": "Piezo Out of Range", "17": "Magnet not Centralized"}),
    # --- configuration (DTM writes; the model reads the Output ones) -------------------------------
    par("display.connection", "LCD instalado (Cmd 128)", 1, codes={"1": "Yes", "250": "No"}),
    par("airTo", "Ar para (Cmd 128/129)", 0, "UInt8", "Output", codes={"0": "Open", "1": "Close"}),
    par("localKeys", "Ajuste local (Cmd 132)", 1, codes={"0": "Disable", "1": "Enable"}),
    par("protection", "Protecao (Cmd 170)", 0),
    par("table.points", "Pontos da tabela (Cmd 133/135)", 2, "UInt8", "Output"),
    par("setup.toggle", "Auto Setup: comando (Cmd 152 alterna)", 0, "UInt8", "Output"),
    par("backup.operation", "Backup/Restore (Cmd 153)", 0),
    par("valve.action", "Acao (Cmd 156/157)", 0, "UInt8", "Output", codes={"0": "Direct", "1": "Reverse"}),
    par("trim.control", "Trim: byte de controle (Cmd 168)", 0),
    par("trim.lower", "Trim da posicao inferior (%)", 0.0, "Float32", "Output"),
    par("trim.upper", "Trim da posicao superior (%)", 100.0, "Float32", "Output"),
    txt("orderCode", "Codigo de pedido (Cmd 173/174)", "FY301-1-1-0-0-0-0-0-0-0", 25),
    txt("actuatorId", "Identificacao do atuador (Cmd 183/184)", "ATUADOR", 16),
    txt("valveId", "Identificacao da valvula (Cmd 185/186)", "VALVULA", 16),
    par("valve.motion", "Tipo (Cmd 187/188)", 0, codes={"0": "Linear", "1": "Rotary"}),
    par("travel.deadbandUnit", "Unidade da banda morta do odometro", UNIT_PCT),
    par("travel.deadband", "Banda morta do odometro", 1.0, "Float32"),
    par("travel.limitUnit", "Unidade do limite do odometro", UNIT_PCT),
    par("travel.limit", "Limite do odometro", 1000.0, "Float32"),
    par("travel.lengthUnit", "Unidade do curso", UNIT_MM),
    par("travel.length", "Curso", 20.0, "Float32"),
    par("deviation.deadband", "Desvio: banda morta (%)", 5.0, "Float32"),
    par("deviation.time", "Desvio: tempo (s)", 10.0, "Float32"),
    par("reversal.deadband", "Reversoes: banda morta (%)", 1.0, "Float32"),
    par("reversal.limit", "Reversoes: limite", 1000.0, "Float32"),
    par("failSafe", "Posicao de seguranca (Cmd 203)", 1, codes={"0": "Open", "1": "Close", "2": "Pwr_up_in"}),
    par("pid.mode", "Servo: modo (Cmd 214/215)", 0, "UInt8", "Output", codes={"0": "Not_Bypass", "1": "Bypass"}),
    par("servo.kp", "KP do servo", 40.0, "Float32", "Output"),
    par("servo.tr", "TR do servo (min/rep)", 2.0, "Float32", "Output"),
    par("servo.deadband", "Banda morta do servo (%)", 0.0, "Float32", "Output"),
    par("sp.rateUpTime", "TIME de abertura (s, 0 = sem limite)", 0.0, "Float32", "Output"),
    par("sp.rateDownTime", "TIME de fechamento (s, 0 = sem limite)", 0.0, "Float32", "Output"),
    par("tso.cutoff", "TSO: corte baixo (%)", 0.0, "Float32", "Output"),
    par("sp.highLimit", "Limite superior do setpoint (%)", 100.0, "Float32", "Output"),
    par("sp.lowLimit", "Limite inferior do setpoint (%)", 0.0, "Float32", "Output"),
    par("tso.deadband", "TSO: banda morta (%)", 0.0, "Float32", "Output"),
    par("sp.mode", "Setpoint: 0 Local (SP%), 1 Remoto (4-20 mA)", 1, "UInt8", "Output", codes={"0": "Local", "1": "Remote"}),
    par("sp.local", "SP% local", 0.0, "Float32", "Output"),
    par("powerUp", "Posicao de partida (%)", 0.0, "Float32"),
    par("diag.enable", "Diagnostico habilitado", 1, codes={"0": "Disable", "1": "Enable"}),
    par("diag.reset", "Reset do diagnostico (Cmd 232)", 0),
    par("ref.motion", "Referencia: tipo", 0), par("ref.action", "Referencia: acao", 0), par("ref.airTo", "Referencia: ar para", 1),
    par("ref.openTime", "Referencia: tempo de abertura", 0.0, "Float32"),
    par("ref.closeTime", "Referencia: tempo de fechamento", 0.0, "Float32"),
    par("ref.kp", "Referencia: KP", 40.0, "Float32"), par("ref.tr", "Referencia: TR", 2.0, "Float32"),
    par("ref.char", "Referencia: caracterizacao", 0),
    par("ref.openingTime", "Referencia: tempo medido de abertura", 0.0, "Float32"),
    par("ref.closingTime", "Referencia: tempo medido de fechamento", 0.0, "Float32"),
    par("display.indication", "LCD (Cmd 247/248)", 1, codes={"1": "PV(%)", "2": "SP(%)"}),
    par("manualSetup", "Setup manual: passo (Cmd 249/250)", 0, "UInt8", "Output"),
    # Auto Setup calibration (EEPROM): the model writes the recorded positions to the Input variables and the
    # device keeps a non-volatile copy (retainFrom) that is saved with the project and read back on start.
    # -1 = never calibrated (factory scale 0 to c_factory_span mm).
    par("setup.restMeasured", "Auto Setup: posicao gravada sem ar (mm)", -1.0, "Float32", "Input"),
    par("setup.fullMeasured", "Auto Setup: posicao gravada com ar total (mm)", -1.0, "Float32", "Input"),
    par("setup.rest", "Calibracao (EEPROM): posicao sem ar (mm)", -1.0, "Float32", "Output", retainFrom="setup.restMeasured"),
    par("setup.full", "Calibracao (EEPROM): posicao com ar total (mm)", -1.0, "Float32", "Output", retainFrom="setup.fullMeasured"),
]
# Characterization table (Commands 133/134): coordinates 0-15 = X (input %), 16-31 = Y (position %)
TABLE = [f"table.c{k}" for k in range(32)]
for k in range(16):
    variables.append(par(f"table.c{k}", f"Tabela X{k + 1} (%)", round(100.0 * k / 15, 4), "Float32", "Output"))
for k in range(16):
    variables.append(par(f"table.c{16 + k}", f"Tabela Y{k + 1} (%)", round(100.0 * k / 15, 4), "Float32", "Output"))
# Operation counters (Command 166: 19 bytes, the DTM shows 19; the DD lists 18 + chg_cnt_Performance)
COUNTERS = [("maOpenClose", "35"), ("flowChar", "47"), ("directReverse", "157"), ("servoLimits", "222"), ("kp", "218"),
            ("tr", "219"), ("airTo", "129"), ("localRemote", "224"), ("spValue", "226"), ("failSafe", "203,228"),
            ("autoSetup", "152"), ("travelClose", "168"), ("travelOpen", ""), ("motionType", "188"), ("trim4mA", "45"),
            ("trim20mA", "46"), ("password", ""), ("confLevel", ""), ("performance", "235")]
for name, _ in COUNTERS:
    variables.append(par(f"counter.{name}", f"Contador: {name}", 0))
operation_counters = ";".join(f"{cmds}=counter.{name}" for name, cmds in COUNTERS if cmds)

# =================================================================================================
# HART device: commands (DD rev 2 layouts; response code and device status are framed by the engine)
# =================================================================================================


def v(name):
    return {"kind": "variable", "variable": name}


def h(hexbytes):
    return {"kind": "hex", "bytes": hexbytes}


def body(offset, length):
    return {"kind": "bodySlice", "offset": offset, "length": length}


def setv(target, value):
    return {"kind": "set", "target": target, "value": value}


def write_cmd(cid, name, fields):
    """fields: [(variable or None for a byte only echoed, length)] in request order; the reply echoes them."""
    steps, resp, offset = [], [], 0
    for var, length in fields:
        if var is not None:
            steps.append(setv(var, body(offset, length)))
            resp.append(v(var))
        else:
            resp.append(body(offset, length))
        offset += length
    return {"enabled": True, "id": cid, "name": name, "writeSteps": steps, "responseSteps": resp}


def read_cmd(cid, name, resp):
    return {"enabled": True, "id": cid, "name": name, "responseSteps": resp}


# Command 134: one IF per table coordinate (the request byte selects the variable)
table_write = [{"kind": "if", "lhs": body(0, 1), "rhs": h(f"{k:02X}"), "then": [setv(TABLE[k], body(1, 4))], "else": []}
               for k in range(32)]
# Command 152: each Auto Setup request toggles setup.toggle; the model starts on any change
setup_toggle = {"kind": "if", "lhs": v("setup.toggle"), "rhs": h("00"), "then": [setv("setup.toggle", h("01"))],
                "else": [setv("setup.toggle", h("00"))]}
# Command 168: control byte 0 = lower position trim, otherwise upper position trim (LOPOS/UPPOS, %)
trim_write = [setv("trim.control", body(0, 1)),
              {"kind": "if", "lhs": body(0, 1), "rhs": h("00"), "then": [setv("trim.lower", body(1, 4))],
               "else": [setv("trim.upper", body(1, 4))]}]

commands = [
    read_cmd(128, "Read Static Data, Materials and Air To", [v("display.connection"), v("airTo")]),
    write_cmd(129, "Write Air To", [("airTo", 1)]),
    read_cmd(130, "Write Lower Transducer Trim Point", []),
    read_cmd(131, "Write Upper Transducer Trim Point", []),
    read_cmd(132, "Read Local Key Mode Control", [v("localKeys")]),
    read_cmd(133, "Read Table Function", [body(0, 1), v("table.points")] +
             [{"kind": "variableTable", "variables": TABLE, "indexByte": 0, "addend": k} for k in range(4)]),
    {"enabled": True, "id": 134, "name": "Write Table Function", "writeSteps": table_write,
     "responseSteps": [body(0, 1), {"kind": "variableTable", "variables": TABLE, "indexByte": 0, "addend": 0}]},
    write_cmd(135, "Write Number of Table Points", [("table.points", 1)]),
    {"enabled": True, "id": 152, "name": "Setup (Auto Setup)", "writeSteps": [setup_toggle], "responseSteps": []},
    write_cmd(153, "Backup / Restore", [("backup.operation", 1), (None, 1)]),
    read_cmd(156, "Read Valve Action", [v("valve.action")]),
    write_cmd(157, "Write Valve Action", [("valve.action", 1)]),
    read_cmd(166, "Read Counter of Change", [v(f"counter.{name}") for name, _ in COUNTERS]),
    {"enabled": True, "id": 168, "name": "Lower / Upper Position Trim", "writeSteps": trim_write,
     "responseSteps": [v("trim.control"), body(1, 4)]},
    read_cmd(170, "Read Local Keys Mode Control", [v("protection")]),
    read_cmd(173, "Read Smar Order Code", [v("orderCode")]),
    write_cmd(174, "Write Smar Order Code", [("orderCode", 25)]),
    read_cmd(183, "Read Actuator Id", [v("actuatorId")]),
    write_cmd(184, "Write Actuator Id", [("actuatorId", 16)]),
    read_cmd(185, "Read Valve Id", [v("valveId")]),
    write_cmd(186, "Write Valve Id", [("valveId", 16)]),
    read_cmd(187, "Read Valve Motion Type", [v("valve.motion")]),
    write_cmd(188, "Write Valve Motion Type", [("valve.motion", 1)]),
    read_cmd(189, "Read Mileage Limit and Span", [v("travel.deadbandUnit"), v("travel.deadband"), v("travel.limitUnit"),
                                                  v("travel.limit"), v("travel.lengthUnit"), v("travel.length")]),
    write_cmd(190, "Write Mileage Limit and Span", [("travel.deadband", 4), ("travel.limit", 4), ("travel.length", 4),
                                                    ("travel.lengthUnit", 1)]),
    read_cmd(193, "Read Deviation and Reversal", [v("deviation.deadband"), v("deviation.time"), v("reversal.deadband"),
                                                  v("reversal.limit")]),
    write_cmd(194, "Write Deviation and Reversal", [("deviation.deadband", 4), ("deviation.time", 4),
                                                    ("reversal.deadband", 4), ("reversal.limit", 4)]),
    write_cmd(203, "Write Fail Safe Mode", [("failSafe", 1)]),
    read_cmd(214, "Read Servo PID Mode", [v("pid.mode")]),
    write_cmd(215, "Write Servo PID Mode", [("pid.mode", 1)]),
    read_cmd(216, "Read Servo PID Variables", [h("39"), v("PV"), h("39"), v("setpoint"), h("39"), v("mv"), h("00"),
                                               v("pid.mode"), h("39"), v("error")]),
    read_cmd(217, "Read Servo PID Parameters", [v("servo.kp"), v("servo.tr"), h("000000"), v("servo.deadband")]),
    write_cmd(218, "Write Servo KP", [("servo.kp", 4)]),
    write_cmd(219, "Write Servo TR", [("servo.tr", 4)]),
    write_cmd(220, "Write Servo Dead Band", [("servo.deadband", 4)]),
    read_cmd(221, "Read Servo SP Limits", [v("sp.rateUpTime"), v("sp.rateDownTime"), v("tso.cutoff"), v("sp.highLimit"),
                                           v("sp.lowLimit"), v("tso.deadband")]),
    write_cmd(222, "Write Servo SP Limits", [("sp.rateUpTime", 4), ("sp.rateDownTime", 4), ("tso.cutoff", 4),
                                             ("sp.highLimit", 4), ("sp.lowLimit", 4), ("tso.deadband", 4)]),
    read_cmd(223, "Read SP Mode", [v("sp.mode")]),
    write_cmd(224, "Write SP Mode", [("sp.mode", 1), (None, 1)]),
    read_cmd(225, "Read SP Percentage", [h("39"), v("setpoint")]),
    write_cmd(226, "Write SP Percentage", [(None, 1), ("sp.local", 4), (None, 1)]),
    read_cmd(227, "Read Power Up Position", [h("39"), v("powerUp")]),
    write_cmd(228, "Write Power Up Position", [(None, 1), ("powerUp", 4)]),
    read_cmd(230, "Read Diagnostic Enable", [v("diag.enable")]),
    write_cmd(231, "Write Diagnostic Enable", [("diag.enable", 1)]),
    write_cmd(232, "Reset Settings", [("diag.reset", 1)]),
    read_cmd(233, "Read Diagnosis Reference", [v("ref.motion"), v("ref.action"), v("ref.airTo"), v("ref.openTime"),
                                               v("ref.closeTime"), v("ref.kp"), v("ref.tr"), v("ref.char")]),
    {"enabled": True, "id": 234, "name": "Write Diagnosis Reference", "responseSteps": [],
     "writeSteps": [setv("ref.motion", v("valve.motion")), setv("ref.action", v("valve.action")),
                    setv("ref.airTo", v("airTo")), setv("ref.openTime", v("sp.rateUpTime")),
                    setv("ref.closeTime", v("sp.rateDownTime")), setv("ref.kp", v("servo.kp")),
                    setv("ref.tr", v("servo.tr")), setv("ref.openingTime", v("openingTime")),
                    setv("ref.closingTime", v("closingTime"))]},
    read_cmd(235, "Get Performance Time", []),
    read_cmd(236, "Read Diagnosis Reference Times", [v("ref.openingTime"), v("ref.closingTime"), v("openingTime"),
                                                     v("closingTime")]),
    read_cmd(237, "Read Diagnosis Variables", [v("travel.lengthUnit"), v("mileage"), h("FA"), v("strokes"), h("FA"),
                                               v("reversals"), h("20"), v("temperatureLow"), h("20"), v("temperatureHigh")]),
    # Factory read used by the DTM identification page (outside the DD): echo of the key + factory block
    read_cmd(242, "Factory Data (DTM)", [body(0, 2), h("00" * 30)]),
    read_cmd(246, "Read Pressure Status", [h("04")]),
    read_cmd(247, "Read Display Indication", [v("display.indication")]),
    write_cmd(248, "Write Display Indication", [("display.indication", 1)]),
    read_cmd(249, "Read Manual Setup", [v("manualSetup")]),
    write_cmd(250, "Write Manual Setup", [("manualSetup", 1)]),
]
assert len(commands) <= 64, len(commands)

device_props = {
    "enabled": True, "pollingAddress": 0, "profileId": "lasecsimul.hart.standard-field-device",
    "alarmSelectionCode": 0, "configurationChangedFlags": 0, "dateDay": 1, "dateMonth": 1, "dateYear": 126,
    "descriptor": "POSICIONADOR", "finalAssemblyNumber": 12345, "message": "FY301", "tag": "FY301", "uniqueId": "0B2A61",
    "unit": "%", "writeProtectCode": 0,
    "sensorLowVolts": 0.0, "sensorHighVolts": 5.0, "sensorLowValue": 0.0, "sensorHighValue": 100.0,
    # Command 0: Smar 3E, FY301 type 03, HART 5, device revision 2 (DD 0202), firmware 2.04 (the DTM shows "2.04")
    "hartManufacturerId": 62, "hartDeviceType": 3, "hartRequestPreambles": 5, "hartUniversalRevision": 5, "hartDeviceRevision": 2,
    "hartSoftwareRevision": 0x24, "hartHardwareRevision": 8, "hartFlags": 0, "hartImplementedRevision": 5,
    "hartCommandSet": "0-3,6,11-19,33-48", "hartWriteProtectActiveCode": 1,
    "hartTransferFunctionCodes": "0-7", "hartStatusVariables": "setup.status", "hartCommand48ConfigChanged": False,
    "hartOperationCounters": operation_counters,
    "analogSaturationLowPercent": -25.0, "analogSaturationHighPercent": 125.0,
    "analogLoopDirection": "input", "analogInputResistance": 550.0, "analogInputMinimumMilliamps": 3.8,
    "analogInputVariable": "inputCurrent", "sensorFault": False,
    "displayInstalled": True, "displayModelName": "FY301", "displayVariable1": "var:display.indication",
    "displayVariable2": "", "displayCodeMap": "1=dv:1/1,2=dv:6/1", "displayGlass": 0,
    "hartVariablesJson": json.dumps(variables, ensure_ascii=False, separators=(",", ":")),
    "hartCommandsJson": json.dumps(commands, ensure_ascii=False, separators=(",", ":")),
}
comp(DEVICE, "protocol.hart.device.standard", device_props, 320, 40)
comp("tunnel_loop_plus", "connectors.tunnel", {"name": "loop_plus", "pinId": "loop_plus"}, 520, 60)
comp("tunnel_loop_minus", "connectors.tunnel", {"name": "loop_minus", "pinId": "loop_minus"}, 520, 100)
link("tunnel_loop_plus", "pin", DEVICE, "loop_plus")
link("tunnel_loop_minus", "pin", DEVICE, "loop_minus")

# --- pneumatic / mechanical pins (signals) -------------------------------------------------------
comp("t_supply", "connectors.signal_tunnel", {"name": "supply", "pinId": "supply", "direction": "Input", "valueType": "Real",
                                              "defaultValue": 0}, 40, 60)
comp("t_position", "connectors.signal_tunnel", {"name": "position", "pinId": "position", "direction": "Input",
                                                "valueType": "Real", "defaultValue": 0}, 40, 120)
comp("t_out1", "connectors.signal_tunnel", {"name": "out1", "pinId": "out1", "direction": "Output", "valueType": "Real"}, 40, 180)
SRC["t_supply"] = "value"
SRC["t_position"] = "value"
comp("c_factory_span", "control.constant", {"value": 30, "unit": "mm"}, 40, 260,
     "Escala de fábrica do sensor de posição (antes do Auto Setup)")
SRC["c_factory_span"] = "out"
comp("c_temperature", "control.constant", {"value": 30, "unit": "°C"}, 40, 320, "Temperatura ambiente do posicionador")
SRC["c_temperature"] = "out"


def H(pin):
    """source handle of an output pin of the HART device"""
    return f"hart:{pin}"


# =================================================================================================
# Model (signal blocks)
# =================================================================================================
# --- power and set point source ---------------------------------------------------------------
fcn("powered", [("i", H("inputCurrent"))], "i > 3.8", "Alimentado pelo laço (> 3,8 mA)")
fcn("sp_in", [("m", H("sp.mode")), ("loc", H("sp.local")), ("inp", H("inputPercent"))],
    f"(m < 0.5)*{clamp('loc', -5, 105)} + (m > 0.5)*{clamp('inp', -5, 105)}",
    "Setpoint: Local (SP% por HART) ou Remoto (4-20 mA no split range)")


# --- characterization (Command 47 code) -------------------------------------------------------
def ep(r):
    return f"100*({r}^(max(x,0)/100) - 1)/({r} - 1)"


def qo(r):
    return f"100*{r}*(max(x,0)/100)/(1 + ({r} - 1)*(max(x,0)/100))"


# table: piecewise linear over the first N points (2..16), X ascending, end values held
xs = [f"xa{k}" for k in range(16)]
ys = [f"ya{k}" for k in range(16)]
seg = []
for k in range(15):
    seg.append(f"(n > {k + 1.5})*(x >= {xs[k]})*(x < {xs[k + 1]})*({ys[k]} + ({ys[k + 1]} - {ys[k]})*(x - {xs[k]})/max({xs[k + 1]} - {xs[k]}, 0.001))")
last = " + ".join(f"(abs(n - {k + 1}) < 0.5)*(x >= {xs[k]})*{ys[k]}" for k in range(1, 16))
table_expr = f"(x < {xs[0]})*{ys[0]} + " + " + ".join(seg) + " + " + last
fcn("sp_table", [("x", "sp_in"), ("n", H("table.points"))] +
    [(xs[k], H(TABLE[k])) for k in range(16)] + [(ys[k], H(TABLE[16 + k])) for k in range(16)],
    table_expr, "Tabela de 16 pontos (CHAR = Tabela)")
curves = {0: "x", 1: ep(50), 2: qo(50), 4: ep(25), 5: qo(25), 6: ep(33), 7: qo(33)}
char_expr = " + ".join(f"(abs(c - {code}) < 0.5)*({curve})" for code, curve in curves.items()) + " + (abs(c - 3) < 0.5)*t"
fcn("sp_char", [("x", "sp_in"), ("c", H("flowChar")), ("t", "sp_table")], char_expr,
    "Caracterização (Cmd 47): 0 Lin, 1 EP 1:50, 2 AR 1:50, 3 Tabela, 4 EP 1:25, 5 AR 1:25, 6 EP 1:33, 7 AR 1:33")
fcn("sp_lim", [("x", "sp_char"), ("lo", H("sp.lowLimit")), ("hi", H("sp.highLimit"))], "min(max(x, lo), max(hi, lo))",
    "Limites do setpoint")
# --- TSO with dead band: closes below CutOff, reopens above CutOff + dead band ---------------------
fcn("tso_on", [("x", "sp_char"), ("c", H("tso.cutoff")), ("d", H("tso.deadband")), ("p", "tso_prev")],
    "(c > 0.001)*((x < c) + (1 - (x < c))*(p > 0.5)*(x < c + d))", "TSO ativo (fechamento estanque)")
delay("tso_prev", "tso_on", 0, "TSO: estado anterior")
fcn("sp_t", [("x", "sp_lim"), ("on", "tso_on")], "(on > 0.5)*(0 - 5) + (on < 0.5)*x", "TSO: setpoint de fechamento estanque")
# --- TIME: opening/closing rate (s from 0 to 100 %, 0 = no limit) ----------------------------------
fcn("sp_step", [("x", "sp_t"), ("r", "sp_r_prev"), ("tu", H("sp.rateUpTime")), ("td", H("sp.rateDownTime"))],
    f"r + min(max(x - r, 0 - 100*{DT}/max(td, {DT})), 100*{DT}/max(tu, {DT}))", "TIME: taxa do setpoint")
fcn("sp_r", [("s", "sp_step"), ("p", "powered")], "(p > 0.5)*s", "Setpoint de posição (%)")
delay("sp_r_prev", "sp_r", 0, "Setpoint de posição anterior")

# --- Auto Setup (Command 152 toggles setup.toggle) ---------------------------------------------------
delay("setup_toggle_prev", H("setup.toggle"), 0, "Auto Setup: comando anterior")
# The toggle is saved with the project: on the first sample (project opened) there is no edge.
fcn("setup_start", [("a", H("setup.toggle")), ("b", "setup_toggle_prev"), ("f", "first")], "(f < 0.5)*(abs(a - b) > 0.5)",
    "Auto Setup: início")
fcn("setup_time", [("s", "setup_start"), ("t", "setup_time_prev"), ("run", "setup_run_prev")],
    f"(s < 0.5)*(t + (run > 0.5)*{DT})", "Tempo do Auto Setup (s)")
delay("setup_time_prev", "setup_time", 0, "Tempo do Auto Setup anterior")
fcn("setup_run", [("s", "setup_start"), ("t", "setup_time"), ("run", "setup_run_prev")],
    "(s > 0.5) + (s < 0.5)*(run > 0.5)*(t < 50)", "Auto Setup em andamento")
delay("setup_run_prev", "setup_run", 0, "Auto Setup em andamento (anterior)")
fcn("setup_done", [("run", "setup_run"), ("t", "setup_time"), ("d", "setup_done_prev")],
    "(run < 0.5)*((t > 49.9) + (t < 49.9)*(d > 0.5))", "Auto Setup concluído")
delay("setup_done_prev", "setup_done", 0, "Auto Setup concluído (anterior)")
fcn("setup_progress", [("t", "setup_time"), ("run", "setup_run"), ("done", "setup_done")],
    "(run > 0.5)*min(t*2, 99) + (run < 0.5)*(done > 0.5)*100", "Progresso do Auto Setup (%)")
# records: rest position (no air, 20-25 s) and full-air position (45-50 s); manual setup steps 1/2 too.
# On start the calibration saved with the project (setup.rest/setup.full, EEPROM); never calibrated (-1): the
# factory sensor scale, 0 to `c_factory_span` mm.
fcn("zero", [("s", "t_supply")], "0*s", "Zero")
delay("first", "zero", 1, "Primeira amostra")
for name, window, manual, text in (("rest", "(t > 20)*(t < 25)", 1, "sem ar"), ("full", "(t > 45)*(t < 50)", 2, "ar total")):
    gate = f"min((run > 0.5)*{window} + (abs(ms - {manual}) < 0.5), 1)"
    factory = "0" if name == "rest" else "fs"
    start = f"(e > 0 - 0.5)*e + (e < 0 - 0.5)*{factory}"
    fcn(f"hold_{name}", [("run", "setup_run"), ("t", "setup_time"), ("x", "t_position"), ("h", f"hold_{name}_prev"),
                         ("ms", H("manualSetup")), ("f", "first"), ("fs", "c_factory_span"), ("e", H(f"setup.{name}"))],
        f"(f > 0.5)*({start}) + (f < 0.5)*({gate}*x + (1 - {gate})*h)", f"Auto Setup: posição gravada ({text}, mm)")
    delay(f"hold_{name}_prev", f"hold_{name}", 0, f"Posição gravada ({text}), anterior")

# --- position: Hall sensor, calibration, trims (LOPOS/UPPOS), action ---------------------------------
fcn("pos_raw", [("x", "t_position"), ("a", "hold_rest"), ("b", "hold_full")],
    "(x - min(a, b))/max(abs(b - a), 0.1)*100", "Posição pelo sensor (% do curso calibrado)")
fcn("pos_trim", [("p", "pos_raw"), ("lo", H("trim.lower")), ("up", H("trim.upper"))],
    "(p - lo)/max(up - lo, 0.1)*100", "Trim de posição inferior/superior (LOPOS/UPPOS)")
fcn("pos", [("p", "pos_trim"), ("a", H("valve.action"))], "(a < 0.5)*p + (a > 0.5)*(100 - p)",
    "PV: posição (%), ação direta ou reversa")
fcn("hall", [("x", "t_position")], "1000 + 100*x", "Sensor Hall (contagens)")

# --- servo PI (KP x 3 internal gain: piezo + spool), dead band, bypass, anti-windup --------------------
fcn("err", [("r", "sp_r"), ("p", "pos"), ("db", H("servo.deadband"))], "(abs(r - p) > db)*(r - p)", "Desvio do servo (%)")
fcn("err_air", [("e", "err"), ("air", H("airTo"))], "(1 - 2*(air > 0.5))*e", "Desvio com o efeito do ar (AIR_T)")
fcn("u", [("e", "err_air"), ("i", "servo_i_prev"), ("kp", H("servo.kp"))], "3*kp*(e + i)", "Saída do PI (%)")
fcn("servo_i", [("e", "err_air"), ("u", "u"), ("tr", H("servo.tr")), ("i", "servo_i_prev"), ("run", "setup_run"),
                ("p", "powered")],
    f"(run < 0.5)*(p > 0.5)*(i + (tr > 0.001)*(1 - (u > 100)*(e > 0) - (u < 0)*(e < 0))*e*{DT}/(max(tr, 0.001)*60))",
    "TR: integral (anti-saturação; zerada no Auto Setup e sem sinal)")
delay("servo_i_prev", "servo_i", 0, "Integral do servo (anterior)")
fcn("out_pct", [("u", "u"), ("p", "powered"), ("run", "setup_run"), ("t", "setup_time"), ("ms", H("manualSetup")),
                ("bp", H("pid.mode")), ("r", "sp_r"), ("air", H("airTo"))],
    "(p > 0.5)*("
    "(run > 0.5)*(t > 25)*100"
    " + (run < 0.5)*(abs(ms - 2) < 0.5)*100"
    " + (run < 0.5)*(abs(ms - 1) > 0.5)*(abs(ms - 2) > 0.5)*((bp > 0.5)*min(max((air < 0.5)*r + (air > 0.5)*(100 - r), 0), 100)"
    " + (bp < 0.5)*min(max(u, 0), 100)))",
    "Sinal do piezo/carretel (% do suprimento); sem sinal (< 3,8 mA) a saída esvazia")
fcn("out1_bar", [("o", "out_pct"), ("s", "t_supply")], "o/100*max(s, 0)", "OUT1 (bar)")
link("out1_bar", "out1", "t_out1", "value")
fcn("out2_bar", [("o", "out1_bar"), ("s", "t_supply")], "max(s, 0) - o", "OUT2 (bar, ação dupla)")
fcn("supply_bar", [("s", "t_supply")], "max(s, 0)", "Suprimento (bar)")

# --- setup status (Command 48 byte 1) -----------------------------------------------------------------
fcn("setup_status", [("run", "setup_run"), ("s", "t_supply"), ("a", "hold_rest"), ("b", "hold_full"), ("done", "setup_done")],
    "(run > 0.5)*15 + (run < 0.5)*((s < 1)*1 + (s >= 1)*(done > 0.5)*(abs(b - a) < 1)*2)",
    "Estado do setup: 15 em andamento, 1 ar baixo, 2 sem ímã")

# --- diagnosis: odometer (mm), strokes, reversals -------------------------------------------------------
delay("x_prev", "t_position", 0, "Posição anterior (mm)")
fcn("mileage", [("x", "t_position"), ("xp", "x_prev"), ("m", "mileage_prev")], "m + abs(x - xp)", "Odômetro (mm)")
delay("mileage_prev", "mileage", 0, "Odômetro anterior")
fcn("strokes", [("m", "mileage"), ("a", "hold_rest"), ("b", "hold_full")], "floor(m/max(2*abs(b - a), 1))",
    "Cursos completos")
fcn("dir", [("x", "t_position"), ("xp", "x_prev"), ("d", "dir_prev")],
    "(x - xp > 0.0005) - (x - xp < 0 - 0.0005) + (abs(x - xp) <= 0.0005)*d", "Sentido do movimento")
delay("dir_prev", "dir", 0, "Sentido anterior")
fcn("reversals", [("d", "dir"), ("dp", "dir_prev"), ("n", "reversals_prev")], "n + (abs(d - dp) > 1.5)", "Reversões")
delay("reversals_prev", "reversals", 0, "Reversões (anterior)")
fcn("temp_f", [("t", "c_temperature")], "t*1.8 + 32", "Temperatura (F)")
fcn("temp_c", [("t", "c_temperature")], "t", "Temperatura (C)")

# --- to the HART device (Input variables) ----------------------------------------------------------------
for source, pin in (("pos", "PV"), ("sp_r", "setpoint"), ("out_pct", "mv"), ("err", "error"), ("servo_i", "integral"),
                    ("hall", "hall"), ("temp_c", "temperature"), ("out_pct", "piezo"), ("temp_f", "temperatureF"),
                    ("mileage", "mileage"), ("strokes", "strokes"), ("reversals", "reversals"), ("temp_c", "temperatureLow"),
                    ("temp_c", "temperatureHigh"), ("setup_progress", "setupProgress"), ("out1_bar", "out1"),
                    ("out2_bar", "out2"), ("supply_bar", "supplyPressure"), ("setup_status", "setup.status"),
                    ("hold_rest", "setup.restMeasured"), ("hold_full", "setup.fullMeasured")):
    link(source, "out1", DEVICE, pin)

# =================================================================================================
# Symbol: the FY301 picture with the LCD above it
# =================================================================================================
W, H_ = 230, 200
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
        "Posicionador de válvula SMAR FY301 (HART 5, revisão 2). Alimentado pelo próprio laço: os bornes + e − recebem o "
        "4-20 mA escrito pelo controlador (carga de cerca de 550 Ω, mínimo de 3,8 mA) e respondem HART modulando a tensão; "
        "ligue o modem HART em paralelo na linha. SUP recebe o suprimento de ar, OUT1 vai ao atuador e POS é a posição da "
        "haste lida pelo ímã (sensor Hall). Toda a configuração (ação, ar para abrir/fechar, caracterização, KP, TR, TIME, "
        "limites, TSO, split range, modo local/remoto, tabela, Auto Setup) é feita por HART, com os comandos do DD da Smar: "
        "use o DTM do FY301 no LasecFDT ou no PACTware. O display mostra a posição (PV%) ou o setpoint (SP%).")},
    "components": components,
    "topology": {"revision": 0, "nodes": [], "conductors": conductors},
    "interface": interface,
    "symbolMode": "custom",
    "iconPath": "./fy301.svg",
    "symbol": {"width": W, "height": H_, "border": False, "shapes": shapes, "pins": pins},
    "exposedComponents": [{"componentId": DEVICE, "x": 63, "y": 4, "rotation": 0, "flipH": False, "flipV": False, "scale": 1, "layer": 0}],
    "exportedPropertyComponentIds": [DEVICE, "c_factory_span", "c_temperature"],
}
with open(sys.argv[1], "w", encoding="utf-8", newline="\n") as handle:
    json.dump(document, handle, ensure_ascii=False, indent=2)
    handle.write("\n")
print(f"{len(components)} components, {len(conductors)} wires, {len(variables)} variables, {len(commands)} commands")
