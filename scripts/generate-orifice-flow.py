"""Generates subcircuits/process_orifice_flow_dp.lssubcircuit.

Usage: python scripts/generate-orifice-flow.py subcircuits/process_orifice_flow_dp.lssubcircuit
See docs/placa-orificio-ld301.md.

Flow measurement with a concentric orifice plate (ISO 5167-2) and a DP transmitter (LD301):
- the control valve downstream of the plate (pin, 0-100 %) sets the flow Q (first-order lag);
- D and d are corrected to the operating temperature with the expansion coefficients of the pipe
  and plate materials;
- C comes from the Reader-Harris/Gallagher equation for the chosen tappings (flange, D and D/2,
  corner); epsilon from the ISO expansibility equation for gases (1 for liquids);
- dP = 8 rho (1 - b^4) Q^2 / (C^2 eps^2 pi^2 d^4); HIGH = p1, LOW = p1 - dP (mmH2O);
- straight lengths (Table 3, single 90 degree bend upstream), roughness and the ISO range are
  checked; an optional didactic installation deviation raises the real C when the straight runs are
  short or the pipe is too rough.
"""
import json
import sys

PERIOD = 10_000_000  # 10 ms, same as the TDPS process models

components = []
conductors = []
TUNNELS = {"t_valve"}


def comp(cid, type_id, props, x, y, label=None):
    entry = {"id": cid, "typeId": type_id, "properties": props, "visual": {"x": x, "y": y, "rotation": 0}}
    if label:
        entry["label"] = label
    components.append(entry)


def wire(src, dst, pin):
    conductors.append({"id": f"w-{len(conductors) + 1}", "from": {"kind": "port", "componentId": src, "pinId": "out" if src not in TUNNELS else "value"},
                       "to": {"kind": "port", "componentId": dst, "pinId": pin}, "points": []})


_calc_slot = [0]


def calc(cid, inputs, expression, label):
    """calc_expression block; laid out in columns of 15 in the inner diagram."""
    slot = _calc_slot[0]
    _calc_slot[0] += 1
    comp(cid, "control.calc_expression", {"expression": expression, "inputs": [name for name, _ in inputs],
                                          "upperLimit": 0, "lowerLimit": 0, "upperLimitEnabled": False, "lowerLimitEnabled": False,
                                          "samplePeriodNs": PERIOD}, 620 + 220 * (slot // 15), 40 + 60 * (slot % 15), label)
    for name, source in inputs:
        wire(source, cid, name)


def by_code(name, values):
    """Value chosen by an integer code 1..n: sum((c > k-0.5)*(c < k+0.5)*v_k)."""
    return "+".join(f"({name}>{k - 0.5})*({name}<{k + 0.5})*{v}" for k, v in enumerate(values, start=1))


# --- interface ---------------------------------------------------------------------------------
comp("t_valve", "connectors.signal_tunnel", {"name": "valve", "pinId": "valve", "direction": "Input", "valueType": "Real", "defaultValue": 0}, 40, 80)

# --- parameters (exported) ---------------------------------------------------------------------
MATERIALS = [  # name, thermal expansion [1e-6/K], roughness Ra [mm] (k ~ pi*Ra)
    ("Aço carbono", 11.2, 0.015),
    ("Aço inox AISI 316", 16.0, 0.005),
    ("Ferro fundido", 10.4, 0.08),
    ("Aço galvanizado", 11.2, 0.05),
    ("Cobre", 16.8, 0.0005),
    ("PVC", 54.0, 0.0005),
]
MATERIAL_OPTIONS = ";".join(f"{index}={name}" for index, (name, _a, _r) in enumerate(MATERIALS, start=1))
PARAMETERS = [  # id, label, default, unit, options ("value=name;...")
    ("c_D", "Diâmetro interno da tubulação D (a 20 °C)", 52.5, "mm", ""),
    ("c_d", "Diâmetro do orifício d (a 20 °C)", 31.5, "mm", ""),
    ("c_tap", "Tipo de tomada de pressão", 1, "", "1=Flange (25,4 mm da placa);2=D e D/2 (radius taps);3=Canto (corner taps)"),
    ("c_lup", "Trecho reto a montante (da curva de 90° até a placa)", 44, "D", ""),
    ("c_ldn", "Trecho reto a jusante (da placa até a válvula)", 8, "D", ""),
    ("c_pipe_mat", "Material da tubulação", 1, "", MATERIAL_OPTIONS),
    ("c_plate_mat", "Material da placa de orifício", 2, "", MATERIAL_OPTIONS),
    ("c_T", "Temperatura de operação", 20, "°C", ""),
    ("c_fluid", "Fluido", 0, "", "0=Líquido (ε = 1);1=Gás (ε pela ISO 5167-2)"),
    ("c_rho", "Massa específica do fluido na operação (a montante)", 998.2, "kg/m³", ""),
    ("c_mu", "Viscosidade dinâmica", 1.002, "cP", ""),
    ("c_kappa", "Expoente isentrópico κ (gás)", 1.4, "", ""),
    ("c_p1", "Pressão a montante (manométrica)", 200, "kPa", ""),
    ("c_qmax", "Vazão máxima (válvula 100 %)", 15, "m³/h", ""),
    ("c_inst", "Desvio didático de instalação e rugosidade", 1, "", "0=Não aplicar;1=Aplicar"),
]
for index, (cid, label, value, unit, options) in enumerate(PARAMETERS):
    props = {"value": value, "unit": unit}
    if options:
        props["options"] = options
    comp(cid, "control.constant", props, 200 + 200 * (index // 15), 40 + (index % 15) * 60, label)

# --- flow ----------------------------------------------------------------------------------------
comp("u", "control.observer", {"unit": "%", "observerOnly": True, "samplePeriodNs": PERIOD}, 40, 200, "Abertura da válvula")
wire("t_valve", "u", "in")
calc("q_set", [("u", "u"), ("Qmax", "c_qmax")], "Qmax*((u>0)*u)/100", "Vazão imposta pela válvula (m³/h)")
comp("q", "control.first_order", {"gain": 1, "tau": 1, "initial": 0, "samplePeriodNs": PERIOD}, 40, 320, "Vazão (m³/h)")
wire("q_set", "q", "in")

# --- geometry at the operating temperature --------------------------------------------------------
calc("alpha_pipe", [("m", "c_pipe_mat")], by_code("m", [a for _n, a, _r in MATERIALS]), "α da tubulação (1e-6/K)")
calc("alpha_plate", [("m", "c_plate_mat")], by_code("m", [a for _n, a, _r in MATERIALS]), "α da placa (1e-6/K)")
calc("ra_pipe", [("m", "c_pipe_mat")], by_code("m", [r for _n, _a, r in MATERIALS]), "Rugosidade Ra da tubulação (mm)")
calc("D_T", [("D", "c_D"), ("a", "alpha_pipe"), ("T", "c_T")], "D*(1+a*0.000001*(T-20))", "D na temperatura (mm)")
calc("d_T", [("d", "c_d"), ("a", "alpha_plate"), ("T", "c_T")], "d*(1+a*0.000001*(T-20))", "d na temperatura (mm)")
calc("beta", [("d", "d_T"), ("D", "D_T")], "d/D", "β = d/D")
calc("velocity", [("q", "q"), ("D", "D_T")], "q/3600/(0.785398163*(D/1000)^2)", "Velocidade na tubulação (m/s)")
# Re = 4 rho Q / (pi mu D), Q in m3/h, mu in cP, D in mm.
calc("reynolds", [("q", "q"), ("rho", "c_rho"), ("mu", "c_mu"), ("D", "D_T")], "1111.111111*rho*q/(3.14159265*mu*D)", "Reynolds Re_D")

# --- discharge coefficient (ISO 5167-2 5.3.2.1, Reader-Harris/Gallagher) -------------------------------
calc("tap_L1", [("t", "c_tap"), ("D", "D_T")], "(t>0.5)*(t<1.5)*25.4/D+(t>1.5)*(t<2.5)*1", "L1 (distância da tomada de alta / D)")
calc("tap_L2", [("t", "c_tap"), ("D", "D_T")], "(t>0.5)*(t<1.5)*25.4/D+(t>1.5)*(t<2.5)*0.47", "L'2 (distância da tomada de baixa / D)")
# Re + (Re < 1) keeps the zero-flow start finite; C is not used there (dP = 0).
calc("rhg_A", [("b", "beta"), ("Re", "reynolds")], "(19000*b/(Re+(Re<1)))^0.8", "A = (19000 β / Re_D)^0,8")
calc("c_iso", [("b", "beta"), ("Re", "reynolds"), ("L1", "tap_L1"), ("L2", "tap_L2"), ("A", "rhg_A"), ("D", "D_T")],
     "0.5961+0.0261*b^2-0.216*b^8+0.000521*(1000000*b/(Re+(Re<1)))^0.7"
     "+(0.0188+0.0063*A)*b^3.5*(1000000/(Re+(Re<1)))^0.3"
     "+(0.043+0.080*2.718281828^(-10*L1)-0.123*2.718281828^(-7*L1))*(1-0.11*A)*b^4/(1-b^4)"
     "-0.031*(2*L2/(1-b)-0.8*(2*L2/(1-b))^1.1)*b^1.3"
     "+(D<71.12)*0.011*(0.75-b)*(2.8-D/25.4)",
     "C (ISO 5167-2)")

# --- installation (ISO 5167-2 Table 3, single 90 degree bend upstream; intermediate beta uses the next row) --
calc("req_up_a", [("b", "beta")], "(b<0.2001)*6+(b>0.2001)*(b<0.4001)*16+(b>0.4001)*(b<0.5001)*22+(b>0.5001)*(b<0.6001)*42+(b>0.6001)*44",
     "Montante exigido, sem incerteza adicional (D)")
calc("req_up_b", [("b", "beta")], "(b<0.4001)*3+(b>0.4001)*(b<0.5001)*9+(b>0.5001)*(b<0.6001)*13+(b>0.6001)*20",
     "Montante mínimo, com +0,5 % de incerteza (D)")
calc("req_dn_a", [("b", "beta")], "(b<0.2001)*4+(b>0.2001)*(b<0.5001)*6+(b>0.5001)*(b<0.6701)*7+(b>0.6701)*8",
     "Jusante exigido (D)")
# Didactic deviation of C: 0 at the required length, +0.5 % at the "B" length, up to +2 % without any run.
calc("dev_up", [("L", "c_lup"), ("A", "req_up_a"), ("B", "req_up_b")],
     "(L<A)*(L>B)*0.5*(A-L)/(A-B)+(L<B+0.000001)*(0.5+1.5*(B-L)/B)", "Desvio do trecho a montante (%)")
calc("dev_dn", [("L", "c_ldn"), ("A", "req_dn_a")],
     "(L<A)*(L>A/2)*0.25*(A-L)/(A/2)+(L<A/2+0.000001)*(0.25+0.25*(A/2-L)/(A/2))", "Desvio do trecho a jusante (%)")
calc("rough_rel", [("Ra", "ra_pipe"), ("D", "D_T")], "10000*Ra/D", "10⁴·Ra/D")
calc("rough_limit", [("b", "beta")], "(b<0.3)*25+(b>0.3)*(4+21*2.718281828^(-19.1*(b-0.3)))", "Limite de 10⁴·Ra/D (aprox. da Tabela 1)")
calc("dev_rough", [("r", "rough_rel"), ("lim", "rough_limit")],
     "(r>lim)*(0.5*(r/lim-1)*(r/lim<5)+2*(r/lim>5))", "Desvio por rugosidade (%)")
calc("dev_total", [("on", "c_inst"), ("u", "dev_up"), ("d", "dev_dn"), ("r", "dev_rough")], "(on>0.5)*(u+d+r)",
     "Desvio didático total de C (%)")
calc("c_real", [("C", "c_iso"), ("dev", "dev_total")], "C*(1+dev/100)", "C real (com o desvio)")

# --- differential pressure -------------------------------------------------------------------------
calc("dp0", [("q", "q"), ("rho", "c_rho"), ("b", "beta"), ("C", "c_real"), ("d", "d_T")],
     "8*rho*(1-b^4)*(q/3600)^2/(C^2*9.8696044*(d/1000)^4)", "ΔP sem expansibilidade (Pa)")


def expansibility(dp):
    """ISO 5167-2 5.3.2.2 with p2/p1 = (p1 - dP)/p1 (absolute, kPa), clamped at 0.01."""
    ratio = f"(p1+101.325-{dp}/1000)/(p1+101.325)"
    return f"1-(gas>0.5)*(0.351+0.256*b^4+0.93*b^8)*(1-(({ratio}>0.01)*{ratio}+({ratio}<0.01)*0.01)^(1/k))"


EPS_INPUTS = [("gas", "c_fluid"), ("b", "beta"), ("p1", "c_p1"), ("k", "c_kappa")]
# epsilon depends on dP and dP on epsilon: two fixed-point passes (the second changes epsilon < 1e-4).
calc("eps1", [*EPS_INPUTS, ("dp", "dp0")], expansibility("dp"), "ε (1ª passada)")
calc("dp1", [("dp0", "dp0"), ("e", "eps1")], "dp0/e^2", "ΔP (1ª passada, Pa)")
calc("epsilon", [*EPS_INPUTS, ("dp", "dp1")], expansibility("dp"), "ε (expansibilidade)")
# "dp_pa", not "dp": an inner id must not repeat a symbol pin id.
calc("dp_pa", [("dp0", "dp0"), ("e", "epsilon")], "dp0/e^2", "ΔP (Pa)")
calc("dp_kpa", [("dp", "dp_pa")], "dp/1000", "ΔP (kPa)")
calc("dp_mm", [("dp", "dp_pa")], "dp/9.80665", "ΔP (mmH2O)")
calc("loss", [("dp", "dp_kpa"), ("b", "beta"), ("C", "c_real")],
     "((1-b^4*(1-C^2))^0.5-C*b^2)/((1-b^4*(1-C^2))^0.5+C*b^2)*dp", "Perda de carga permanente (kPa)")
calc("p_ratio", [("p1", "c_p1"), ("dp", "dp_pa")], "(p1+101.325-dp/1000)/(p1+101.325)", "p2/p1")
calc("p_high", [("p1", "c_p1")], "101.97162*p1", "Tomada de alta (mmH2O)")
calc("p_low", [("h", "p_high"), ("dp", "dp_mm")], "h-dp", "Tomada de baixa (mmH2O)")

# --- status lamps ------------------------------------------------------------------------------------------
calc("is_flange", [("t", "c_tap")], "(t<1.5)", "Tomada flange")
calc("is_dd2", [("t", "c_tap")], "(t>1.5)*(t<2.5)", "Tomada D e D/2")
calc("is_corner", [("t", "c_tap")], "(t>2.5)", "Tomada de canto")
calc("ok_up", [("L", "c_lup"), ("A", "req_up_a")], "(L>A-0.0001)", "Montante conforme")
calc("ok_dn", [("L", "c_ldn"), ("A", "req_dn_a")], "(L>A-0.0001)", "Jusante conforme")
calc("ok_rough", [("r", "rough_rel"), ("lim", "rough_limit")], "(r<lim)", "Rugosidade conforme")
# ISO 5167-2 5.3.1: d >= 12.5 mm, 50 <= D <= 1000 mm, 0.1 <= beta <= 0.75; flange taps
# Re >= 5000 and Re >= 170 beta^2 D; corner and D-D/2 Re >= 5000 (beta <= 0.56) or 16000 beta^2; gas p2/p1 >= 0.75.
calc("ok_iso", [("b", "beta"), ("D", "D_T"), ("d", "d_T"), ("Re", "reynolds"), ("t", "c_tap"), ("gas", "c_fluid"), ("r", "p_ratio")],
     "(b>0.0999)*(b<0.7501)*(D>49.999)*(D<1000.001)*(d>12.499)*(Re>5000)"
     "*((t<1.5)*(Re>170*b^2*D)+(t>1.5)*((b<0.56)+(b>0.56)*(Re>16000*b^2))>0.5)"
     "*((gas<0.5)+(r>0.75)>0.5)",
     "Dentro da faixa da ISO 5167-2")

OUTPUTS = [("high", "p_high"), ("low", "p_low"), ("flow", "q"), ("dp", "dp_mm")]
for index, (name, source) in enumerate(OUTPUTS):
    tunnel = f"t_{name}"
    comp(tunnel, "connectors.signal_tunnel", {"name": name, "pinId": name, "direction": "Output", "valueType": "Real"}, 1340, 80 + index * 80)
    conductors.append({"id": f"w-{len(conductors) + 1}", "from": {"kind": "port", "componentId": source, "pinId": "out"},
                       "to": {"kind": "port", "componentId": tunnel, "pinId": "value"}, "points": []})

# --- symbol: graphics (exposed) ------------------------------------------------------------------------
W, H = 1000, 720
PIPE_Y = 200                 # axis of the measuring run
IN_X = 70                    # vertical inlet pipe
UP_X0 = IN_X + 24            # the single 90 degree bend ends here: start of the upstream straight run
PLATE_X = 480                # orifice plate (between two flanges)
VALVE = 90
VALVE_X = 780                # control valve at the end of the downstream straight run
VALVE_BODY = (23, 67)        # horizontal extent of the drawn valve inside its 90 px box
valve_y = PIPE_Y - 0.805 * VALVE
sig_y = 40                   # valve pin: signal to the actuator
TAP_HIGH_X = PLATE_X - 9     # tap in the upstream flange
TAP_LOW_X = PLATE_X + 49     # tap in the downstream flange
y_flow, y_dp, y_high, y_low = 620, 645, 672, 698

exposed = []


def graphic(cid, type_id, props, x, y, label=None):
    comp(cid, type_id, props, x, y, label)
    exposed.append({"componentId": cid, "x": x, "y": y, "rotation": 0, "flipH": False, "flipV": False, "scale": 1, "layer": len(exposed)})


def binding(source, unit, decimals, lo=0, hi=100, threshold=50):
    return {"bindSource": source, "bindChannel": 0, "bindScale": 1, "bindOffset": 0, "bindMin": lo, "bindMax": hi,
            "bindUnit": unit, "bindDecimals": decimals, "bindThreshold": threshold, "bindInvert": False}


PIPE_PROPS = {"height": 18, "fill": "#cbd5e1", "stroke": "currentColor", "strokeWidth": 1.5, "opacity": 1, "showFlow": True,
              "flowDirection": "forward", "showFlanges": False, "value": 0}
# The chevron of the pipe shows while there is flow (Q >= 0.01 m3/h).
graphic("g_pipe_up", "graphics.pipe", {"width": PLATE_X - 18 - UP_X0, **PIPE_PROPS, **binding("q", "m³/h", 2, 0, 100, 0.01)}, UP_X0, PIPE_Y - 9)
# The downstream run goes under the valve body (drawn on top), so the pipe meets its flanges.
graphic("g_pipe_dn", "graphics.pipe", {"width": VALVE_X + VALVE_BODY[0] + 8 - (PLATE_X + 58), **PIPE_PROPS, **binding("q", "m³/h", 2, 0, 100, 0.01)}, PLATE_X + 58, PIPE_Y - 9)
FLANGE = {"width": 18, "height": 46, "stroke": "currentColor", "fill": "#cbd5e1", "strokeWidth": 1.5, "opacity": 1}
graphic("g_flange_up", "graphics.pipe_flange", FLANGE, PLATE_X - 18, PIPE_Y - 23)
graphic("g_plate", "graphics.orifice_plate", {"width": 40, "height": 44, "stroke": "currentColor", "fill": "#cbd5e1", "strokeWidth": 1.5, "opacity": 1},
        PLATE_X, PIPE_Y - 22)
graphic("g_flange_dn", "graphics.pipe_flange", FLANGE, PLATE_X + 40, PIPE_Y - 23)
graphic("g_valve", "graphics.valve_globe_svg", {"width": VALVE, "height": VALVE, "value": 0, "showValue": True, **binding("u", "%", 0)}, VALVE_X, valve_y)
graphic("g_arrow", "graphics.flow_arrow", {"width": 56, "height": 32, "stroke": "none", "fill": "#0284c7", "strokeWidth": 0, "opacity": 1},
        VALVE_X + VALVE + 54, PIPE_Y - 16)

LAMP = {"width": 34, "height": 42, "stroke": "currentColor", "fill": "#94a3b8", "strokeWidth": 1.5, "opacity": 1, "value": 0}
TAP_LAMPS = [("g_l_flange", "Flange", "is_flange"), ("g_l_dd2", "D e D/2", "is_dd2"), ("g_l_corner", "Canto", "is_corner")]
for index, (cid, label, source) in enumerate(TAP_LAMPS):
    graphic(cid, "graphics.status_lamp", {**LAMP, "onColor": "#0284c7", "offColor": "#cbd5e1", "label": label, **binding(source, "", 0, 0, 1, 0.5)},
            160 + index * 62, 74)
ISO_LAMPS = [("g_l_up", "Montante", "ok_up"), ("g_l_dn", "Jusante", "ok_dn"), ("g_l_rough", "Rugosidade", "ok_rough"), ("g_l_iso", "Faixa ISO", "ok_iso")]
for index, (cid, label, source) in enumerate(ISO_LAMPS):
    graphic(cid, "graphics.status_lamp", {**LAMP, "onColor": "#22c55e", "offColor": "#ef4444", "label": label, **binding(source, "", 0, 0, 1, 0.5)},
            380 + index * 66, 74)

READOUTS = [
    ("g_q", "Vazão", "q", "m³/h", 2), ("g_v", "Velocidade", "velocity", "m/s", 2),
    ("g_re", "Reynolds Re_D", "reynolds", "", 0), ("g_beta", "β = d/D", "beta", "", 4),
    ("g_c", "C (ISO 5167-2)", "c_iso", "", 4), ("g_creal", "C real (com desvio)", "c_real", "", 4),
    ("g_eps", "ε (expansibilidade)", "epsilon", "", 4), ("g_dev", "Desvio didático de C", "dev_total", "%", 2),
    ("g_dpk", "ΔP na placa", "dp_kpa", "kPa", 2), ("g_dpm", "ΔP na placa", "dp_mm", "mmH2O", 0),
    ("g_loss", "Perda permanente", "loss", "kPa", 2), ("g_rough", "10⁴·Ra/D", "rough_rel", "", 2),
]
for index, (cid, label, source, unit, decimals) in enumerate(READOUTS):
    graphic(cid, "graphics.value_display", {"width": 164, "height": 44, "stroke": "currentColor", "fill": "#f8fafc", "strokeWidth": 1.5, "opacity": 1,
                                            "label": label, "valueColor": "#0f172a", "value": 0, **binding(source, unit, decimals, -1e12, 1e12)},
            16 + (index % 2) * 174, 290 + (index // 2) * 50)
PARAM_READOUTS = [
    ("g_par_D", "D na temperatura", "D_T", "mm", 2), ("g_par_d", "d na temperatura", "d_T", "mm", 3),
    ("g_par_lup", "Montante instalado", "c_lup", "D", 1), ("g_par_lupreq", "Montante exigido", "req_up_a", "D", 0),
    ("g_par_ldn", "Jusante instalado", "c_ldn", "D", 1), ("g_par_ldnreq", "Jusante exigido", "req_dn_a", "D", 0),
    ("g_par_T", "Temperatura", "c_T", "°C", 1), ("g_par_p1", "Pressão a montante", "c_p1", "kPa", 1),
    ("g_par_rho", "Massa específica", "c_rho", "kg/m³", 1), ("g_par_mu", "Viscosidade", "c_mu", "cP", 3),
    ("g_par_ra", "Ra da tubulação", "ra_pipe", "mm", 4), ("g_par_rlim", "Limite 10⁴·Ra/D", "rough_limit", "", 2),
]
for index, (cid, label, source, unit, decimals) in enumerate(PARAM_READOUTS):
    graphic(cid, "graphics.value_display", {"width": 164, "height": 44, "stroke": "#64748b", "fill": "#fefce8", "strokeWidth": 1.2, "opacity": 1,
                                            "label": label, "valueColor": "#713f12", "value": 0, **binding(source, unit, decimals, -1e12, 1e12)},
            644 + (index % 2) * 174, 290 + (index // 2) * 50)

# --- symbol: static drawing -------------------------------------------------------------------------------
PIPE_EDGE = "#64748b"
PIPE_FILL = "#cbd5e1"
HIGH_COLOR = "#f97316"
LOW_COLOR = "#eab308"
INK = "#0f172a"
NOTE = "#334155"


def pipe_path(d):
    """A pipe drawn as a path: dark edge + light core, the same look as graphics.pipe."""
    return [{"kind": "path", "d": d, "stroke": PIPE_EDGE, "strokeWidth": 18, "fill": "none"},
            {"kind": "path", "d": d, "stroke": PIPE_FILL, "strokeWidth": 15, "fill": "none"}]


def dimension(x1, x2, y, text):
    return [{"kind": "line", "x1": x1, "y1": y, "x2": x2, "y2": y, "stroke": INK, "strokeWidth": 1},
            {"kind": "line", "x1": x1, "y1": y - 6, "x2": x1, "y2": y + 6, "stroke": INK, "strokeWidth": 1},
            {"kind": "line", "x1": x2, "y1": y - 6, "x2": x2, "y2": y + 6, "stroke": INK, "strokeWidth": 1},
            {"kind": "text", "x": (x1 + x2) / 2, "y": y + 16, "value": text, "fontSize": 10, "textAnchor": "middle", "color": NOTE}]


shapes = [
    {"kind": "text", "x": 160, "y": 24, "value": "Vazão por placa de orifício (ISO 5167-2) — transmissor de pressão diferencial",
     "fontSize": 13, "textAnchor": "start", "color": INK},
    # valve opening signal: pin -> over the plant -> actuator of the control valve
    {"kind": "path", "d": f"M112 {sig_y} H{VALVE_X - 24} V{valve_y + 28.4} H{VALVE_X + 26}", "stroke": INK, "strokeWidth": 1.2,
     "strokeDasharray": "6 4", "fill": "none"},
    # inlet from above, single 90 degree bend into the measuring run
    *pipe_path(f"M{IN_X} 56 V{PIPE_Y - 24} Q{IN_X} {PIPE_Y} {UP_X0} {PIPE_Y}"),
    {"kind": "text", "x": IN_X + 14, "y": 72, "value": "entrada", "fontSize": 10, "textAnchor": "start", "color": NOTE},
    {"kind": "text", "x": IN_X - 14, "y": PIPE_Y + 30, "value": "curva 90°", "fontSize": 10, "textAnchor": "start", "color": NOTE},
    # outlet after the valve
    *pipe_path(f"M{VALVE_X + VALVE_BODY[1] - 8} {PIPE_Y} H{VALVE_X + VALVE + 52}"),
    {"kind": "text", "x": VALVE_X + VALVE + 82, "y": PIPE_Y - 22, "value": "saída", "fontSize": 10, "textAnchor": "middle", "color": NOTE},
    {"kind": "text", "x": VALVE_X + VALVE / 2, "y": valve_y - 6, "value": "FV (válvula)", "fontSize": 10, "textAnchor": "middle", "color": NOTE},
    {"kind": "text", "x": PLATE_X + 20, "y": PIPE_Y - 30, "value": "FE (placa)", "fontSize": 10, "textAnchor": "middle", "color": INK},
    # straight runs
    *dimension(UP_X0, PLATE_X - 18, PIPE_Y + 40, "trecho reto a montante (L montante · D)"),
    *dimension(PLATE_X + 58, VALVE_X + VALVE_BODY[0], PIPE_Y + 40, "trecho reto a jusante (L jusante · D)"),
    # group captions of the lamps
    {"kind": "text", "x": 160, "y": 68, "value": "Tipo de tomada", "fontSize": 9, "textAnchor": "start", "color": "#0369a1"},
    {"kind": "text", "x": 380, "y": 68, "value": "Conformidade com a ISO 5167-2", "fontSize": 9, "textAnchor": "start", "color": "#166534"},
    # impulse lines: HIGH upstream of the plate, LOW downstream, down to the transmitter level
    {"kind": "line", "x1": TAP_HIGH_X, "y1": PIPE_Y + 23, "x2": TAP_HIGH_X, "y2": y_high, "stroke": HIGH_COLOR, "strokeWidth": 4},
    {"kind": "line", "x1": TAP_HIGH_X, "y1": y_high, "x2": W, "y2": y_high, "stroke": HIGH_COLOR, "strokeWidth": 4},
    {"kind": "line", "x1": TAP_LOW_X, "y1": PIPE_Y + 23, "x2": TAP_LOW_X, "y2": y_low, "stroke": LOW_COLOR, "strokeWidth": 4},
    {"kind": "line", "x1": TAP_LOW_X, "y1": y_low, "x2": W, "y2": y_low, "stroke": LOW_COLOR, "strokeWidth": 4},
    {"kind": "text", "x": TAP_HIGH_X - 8, "y": PIPE_Y + 76, "value": "alta (+)", "fontSize": 10, "textAnchor": "end", "color": "#7c2d12"},
    {"kind": "text", "x": TAP_LOW_X + 8, "y": PIPE_Y + 76, "value": "baixa (−)", "fontSize": 10, "textAnchor": "start", "color": "#713f12"},
    {"kind": "text", "x": PLATE_X + 20, "y": 470, "value": "ΔP", "fontSize": 16, "textAnchor": "middle", "color": INK},
    {"kind": "text", "x": 16, "y": y_high + 4, "value": "ligue HIGH e LOW no LD301 (função raiz quadrada: corrente ∝ vazão)",
     "fontSize": 10, "textAnchor": "start", "color": INK},
    {"kind": "text", "x": 16, "y": 280, "value": "Medição", "fontSize": 9, "textAnchor": "start", "color": INK},
    {"kind": "text", "x": 644, "y": 280, "value": "Parâmetros (Propriedades exportadas)", "fontSize": 9, "textAnchor": "start", "color": "#713f12"},
]

pins = [
    {"id": "valve", "kind": "ANALOG_IN", "x": 0, "y": sig_y, "angle": 180, "length": 8, "label": "Válvula (%)"},
    {"id": "flow", "kind": "ANALOG_OUT", "x": W, "y": y_flow, "angle": 0, "length": 8, "label": "Vazão (m³/h)"},
    {"id": "dp", "kind": "ANALOG_OUT", "x": W, "y": y_dp, "angle": 0, "length": 8, "label": "ΔP (mmH2O)"},
    {"id": "high", "kind": "ANALOG_OUT", "x": W, "y": y_high, "angle": 0, "length": 8, "label": "HIGH"},
    {"id": "low", "kind": "ANALOG_OUT", "x": W, "y": y_low, "angle": 0, "length": 8, "label": "LOW"},
]

interface = [
    {"pinId": "valve", "label": "Válvula (%)", "internalTunnel": "valve", "domain": "signal", "direction": "in", "valueType": "Real", "width": 1},
    {"pinId": "flow", "label": "Vazão (m³/h)", "internalTunnel": "flow", "domain": "signal", "direction": "out", "valueType": "Real", "width": 1},
    {"pinId": "dp", "label": "ΔP (mmH2O)", "internalTunnel": "dp", "domain": "signal", "direction": "out", "valueType": "Real", "width": 1},
    {"pinId": "high", "label": "HIGH (mmH2O)", "internalTunnel": "high", "domain": "signal", "direction": "out", "valueType": "Real", "width": 1},
    {"pinId": "low", "label": "LOW (mmH2O)", "internalTunnel": "low", "domain": "signal", "direction": "out", "valueType": "Real", "width": 1},
]

document = {
    "schemaVersion": 3,
    "typeId": "subcircuits.process.orifice_flow_dp",
    "name": "Placa de orifício (vazão por ΔP)",
    "language": "pt-BR",
    "folderPath": ["Modelos"],
    "workspaceSection": "process",
    "help": {"description": (
        "Medição de vazão com placa de orifício concêntrica (ISO 5167-2) e transmissor de pressão diferencial (LD301). "
        "A válvula de controle a jusante (pino, 0–100 %) impõe a vazão. C pela equação de Reader-Harris/Gallagher para "
        "tomadas de flange, D e D/2 ou de canto; ε pela ISO para gases (1 para líquidos); D e d corrigidos pela dilatação "
        "dos materiais. Saídas HIGH/LOW em mmH2O, com ΔP = 8ρ(1−β⁴)Q²/(C²ε²π²d⁴). Trechos retos (Tabela 3, uma curva de 90° "
        "a montante), rugosidade e faixa de validade da norma são verificados; um desvio didático opcional aumenta o C real "
        "quando a instalação foge da norma. Com os padrões (água a 20 °C, D 52,5 mm, d 31,5 mm, tomadas de flange, 15 m³/h) "
        "o ΔP a 100 % é ≈ 3376 mmH2O. Diâmetros, tomada, trechos retos, materiais, fluido e vazão máxima ficam em "
        "Propriedades Exportadas e mudam com a simulação rodando.")},
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
