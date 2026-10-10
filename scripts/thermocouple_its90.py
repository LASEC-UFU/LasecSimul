"""NIST ITS-90 thermocouple reference functions and approximate inverses (types B, E, J, K, N, R, S, T).

Coefficients copied from the NIST ITS-90 Thermocouple Database (NIST Monograph 175, SRD 60),
https://its90.nist.gov/ThermoDownloads (files type_<x>.tab.txt, downloaded 2026-10-10).
emf(type, t) is the reference function (mV, cold junction at 0 degC); temperature(type, e) the NIST
approximate inverse (errors listed by NIST: within +/-0.06 degC over each subrange).

The same data feeds:
- the TT301 thermocouple input stage (calc expressions: scratch patch, see docs/forno-termopar-tt301.md);
- the electric furnace plant (scripts/generate-electric-furnace-tc.py);
- the palette thermocouple device (devices/simulide-sensors/src/thermocouple_its90.h, `--c-header`).

Usage: python scripts/thermocouple_its90.py --check          (compares with NIST tables if given --tables DIR)
       python scripts/thermocouple_its90.py --c-header FILE
"""
import math
import sys

# Order of the TT301 sensor list (Cmd 131 byte 2 for TC): B=0, E=1, J=2, K=3, N=4, R=5, S=6, T=7.
TYPES = ['B', 'E', 'J', 'K', 'N', 'R', 'S', 'T']

# Reference functions: E = sum(c_i t^i) [+ a0 exp(a1 (t - a2)^2) for K above 0 degC], t in degC, E in mV.
FORWARD = {
    "B": [
        (0.0, 630.615, [0.0, -0.00024650818346, 5.9040421171e-06, -1.3257931636e-09, 1.5668291901e-12, -1.694452924e-15, 6.2990347094e-19]),
        (630.615, 1820.0, [-3.8938168621, 0.02857174747, -8.4885104785e-05, 1.5785280164e-07, -1.6835344864e-10, 1.1109794013e-13, -4.4515431033e-17, 9.8975640821e-21, -9.3791330289e-25]),
    ],
    "E": [
        (-270.0, 0.0, [0.0, 0.058665508708, 4.5410977124e-05, -7.7998048686e-07, -2.5800160843e-08, -5.9452583057e-10, -9.3214058667e-12, -1.0287605534e-13, -8.0370123621e-16, -4.3979497391e-18, -1.6414776355e-20, -3.9673619516e-23, -5.5827328721e-26, -3.4657842013e-29]),
        (0.0, 1000.0, [0.0, 0.05866550871, 4.5032275582e-05, 2.8908407212e-08, -3.3056896652e-10, 6.502440327e-13, -1.9197495504e-16, -1.2536600497e-18, 2.1489217569e-21, -1.4388041782e-24, 3.5960899481e-28]),
    ],
    "J": [
        (-210.0, 760.0, [0.0, 0.050381187815, 3.047583693e-05, -8.568106572e-08, 1.3228195295e-10, -1.7052958337e-13, 2.0948090697e-16, -1.2538395336e-19, 1.5631725697e-23]),
        (760.0, 1200.0, [296.45625681, -1.4976127786, 0.0031787103924, -3.1847686701e-06, 1.5720819004e-09, -3.0691369056e-13]),
    ],
    "K": [
        (-270.0, 0.0, [0.0, 0.039450128025, 2.3622373598e-05, -3.2858906784e-07, -4.9904828777e-09, -6.7509059173e-11, -5.7410327428e-13, -3.1088872894e-15, -1.0451609365e-17, -1.9889266878e-20, -1.6322697486e-23]),
        (0.0, 1372.0, [-0.017600413686, 0.038921204975, 1.8558770032e-05, -9.9457592874e-08, 3.1840945719e-10, -5.6072844889e-13, 5.6075059059e-16, -3.2020720003e-19, 9.7151147152e-23, -1.2104721275e-26]),
    ],
    "N": [
        (-270.0, 0.0, [0.0, 0.026159105962, 1.0957484228e-05, -9.3841111554e-08, -4.6412039759e-11, -2.6303357716e-12, -2.2653438003e-14, -7.6089300791e-17, -9.3419667835e-20]),
        (0.0, 1300.0, [0.0, 0.025929394601, 1.571014188e-05, 4.3825627237e-08, -2.5261169794e-10, 6.4311819339e-13, -1.0063471519e-15, 9.9745338992e-19, -6.0863245607e-22, 2.0849229339e-25, -3.0682196151e-29]),
    ],
    "R": [
        (-50.0, 1064.18, [0.0, 0.00528961729765, 1.39166589782e-05, -2.38855693017e-08, 3.56916001063e-11, -4.62347666298e-14, 5.00777441034e-17, -3.73105886191e-20, 1.57716482367e-23, -2.81038625251e-27]),
        (1064.18, 1664.5, [2.95157925316, -0.00252061251332, 1.59564501865e-05, -7.64085947576e-09, 2.05305291024e-12, -2.93359668173e-16]),
        (1664.5, 1768.1, [152.232118209, -0.268819888545, 0.000171280280471, -3.45895706453e-08, -9.34633971046e-15]),
    ],
    "S": [
        (-50.0, 1064.18, [0.0, 0.00540313308631, 1.2593428974e-05, -2.32477968689e-08, 3.22028823036e-11, -3.31465196389e-14, 2.55744251786e-17, -1.25068871393e-20, 2.71443176145e-24]),
        (1064.18, 1664.5, [1.32900444085, 0.00334509311344, 6.54805192818e-06, -1.64856259209e-09, 1.29989605174e-14]),
        (1664.5, 1768.1, [146.628232636, -0.258430516752, 0.000163693574641, -3.30439046987e-08, -9.43223690612e-15]),
    ],
    "T": [
        (-270.0, 0.0, [0.0, 0.038748106364, 4.4194434347e-05, 1.1844323105e-07, 2.0032973554e-08, 9.0138019559e-10, 2.2651156593e-11, 3.6071154205e-13, 3.8493939883e-15, 2.8213521925e-17, 1.4251594779e-19, 4.8768662286e-22, 1.079553927e-24, 1.3945027062e-27, 7.9795153927e-31]),
        (0.0, 400.0, [0.0, 0.038748106364, 3.329222788e-05, 2.0618243404e-07, -2.1882256846e-09, 1.0996880928e-11, -3.0815758772e-14, 4.547913529e-17, -2.7512901673e-20]),
    ],
}
K_EXPONENTIAL = (0.1185976, -0.0001183432, 126.9686)  # a0, a1, a2 (t >= 0 degC)

# Approximate inverses: t = sum(d_i E^i), E in mV. (eLow, eHigh, d). Ranges of R and S overlap: a
# subrange is used from its own eLow up to the next eLow.
INVERSE = {
    "B": [
        (0.291, 2.431, [98.423321, 699.715, -847.65304, 1005.2644, -833.45952, 455.08542, -155.23037, 29.88675, -2.474286]),
        (2.431, 13.82, [213.15071, 285.10504, -52.742887, 9.9160804, -1.2965303, 0.1119587, -0.0060625199, 0.00018661696, -2.4878585e-06]),
    ],
    "E": [
        (-8.825, 0.0, [0.0, 16.977288, -0.4351497, -0.15859697, -0.092502871, -0.026084314, -0.0041360199, -0.0003403403, -1.156489e-05]),
        (0.0, 76.373, [0.0, 17.057035, -0.23301759, 0.0065435585, -7.3562749e-05, -1.7896001e-06, 8.4036165e-08, -1.3735879e-09, 1.0629823e-11, -3.2447087e-14]),
    ],
    "J": [
        (-8.095, 0.0, [0.0, 19.528268, -1.2286185, -1.0752178, -0.59086933, -0.17256713, -0.028131513, -0.002396337, -8.3823321e-05]),
        (0.0, 42.919, [0.0, 19.78425, -0.2001204, 0.01036969, -0.0002549687, 3.585153e-06, -5.344285e-08, 5.09989e-10]),
        (42.919, 69.553, [-3113.58187, 300.543684, -9.9477323, 0.17027663, -0.00143033468, 4.73886084e-06]),
    ],
    "K": [
        (-5.891, 0.0, [0.0, 25.173462, -1.1662878, -1.0833638, -0.8977354, -0.37342377, -0.086632643, -0.010450598, -0.00051920577]),
        (0.0, 20.644, [0.0, 25.08355, 0.07860106, -0.2503131, 0.0831527, -0.01228034, 0.0009804036, -4.41303e-05, 1.057734e-06, -1.052755e-08]),
        (20.644, 54.886, [-131.8058, 48.30222, -1.646031, 0.05464731, -0.0009650715, 8.802193e-06, -3.11081e-08]),
    ],
    "N": [
        (-3.99, 0.0, [0.0, 38.436847, 1.1010485, 5.2229312, 7.2060525, 5.8488586, 2.7754916, 0.77075166, 0.11582665, 0.0073138868]),
        (0.0, 20.613, [0.0, 38.6896, -1.08267, 0.0470205, -2.12169e-06, -0.000117272, 5.3928e-06, -7.98156e-08]),
        (20.613, 47.513, [19.72485, 33.00943, -0.3915159, 0.009855391, -0.0001274371, 7.767022e-07]),
    ],
    "R": [
        (-0.226, 1.923, [0.0, 188.9138, -93.83529, 130.68619, -227.0358, 351.45659, -389.539, 282.39471, -126.07281, 31.353611, -3.3187769]),
        (1.923, 13.228, [13.34584505, 147.2644573, -18.44024844, 4.031129726, -0.624942836, 0.06468412046, -0.004458750426, 0.0001994710149, -5.31340179e-06, 6.481976217e-08]),
        (11.361, 19.739, [-81.99599416, 155.3962042, -8.342197663, 0.4279433549, -0.0119157791, 0.0001492290091]),
        (19.739, 21.103, [34061.77836, -7023.729171, 558.2903813, -19.52394635, 0.2560740231]),
    ],
    "S": [
        (-0.235, 1.874, [0.0, 184.94946, -80.0504062, 102.23743, -152.248592, 188.821343, -159.085941, 82.302788, -23.4181944, 2.7978626]),
        (1.874, 11.95, [12.91507177, 146.6298863, -15.34713402, 3.145945973, -0.4163257839, 0.03187963771, -0.0012916375, 2.183475087e-05, -1.447379511e-07, 8.211272125e-09]),
        (10.332, 17.536, [-80.87801117, 162.1573104, -8.536869453, 0.4719686976, -0.01441693666, 0.000208161889]),
        (17.536, 18.693, [53338.75126, -12358.92298, 1092.657613, -42.65693686, 0.624720542]),
    ],
    "T": [
        (-5.603, 0.0, [0.0, 25.949192, -0.21316967, 0.79018692, 0.42527777, 0.13304473, 0.020241446, 0.0012668171]),
        (0.0, 20.872, [0.0, 25.928, -0.7602961, 0.04637791, -0.002165394, 6.048144e-05, -7.293422e-07]),
    ],
}

# Valid temperature range of each reference function (degC) and of each inverse (mV).
def t_range(tc):
    return FORWARD[tc][0][0], FORWARD[tc][-1][1]


def e_range(tc):
    return INVERSE[tc][0][0], INVERSE[tc][-1][1]


def _poly(coeffs, x):
    value = 0.0
    for c in reversed(coeffs):
        value = value * x + c
    return value


def emf(tc, t):
    """Thermoelectric voltage (mV) with the reference junction at 0 degC."""
    segments = FORWARD[tc]
    segment = segments[0]
    for candidate in segments[1:]:
        if t >= candidate[0]:
            segment = candidate
    value = _poly(segment[2], t)
    if tc == "K" and t >= 0:
        a0, a1, a2 = K_EXPONENTIAL
        value += a0 * math.exp(a1 * (t - a2) ** 2)
    return value


def temperature(tc, e):
    """NIST approximate inverse: temperature (degC) for a voltage e (mV) referred to 0 degC."""
    segments = INVERSE[tc]
    segment = segments[0]
    for candidate in segments[1:]:
        if e >= candidate[0]:
            segment = candidate
    return _poly(segment[2], e)


# --- calc_expression builders (operators + - * / ^ > < only; comparisons give 0/1) ---------------------
def number(value):
    text = repr(float(value))
    return f"({text})" if text.startswith("-") else text


def horner(coeffs, var):
    """c0 + var*(c1 + var*(c2 + ...)) with trailing zeros dropped."""
    coeffs = list(coeffs)
    while len(coeffs) > 1 and coeffs[-1] == 0.0:
        coeffs.pop()
    text = number(coeffs[-1])
    for c in reversed(coeffs[:-1]):
        text = f"{var}*({text})" if c == 0.0 else f"{number(c)}+{var}*({text})"
    return text


def clamp(var, low, high):
    return f"{var}+({var}<{number(low)})*({number(low)}-{var})+({var}>{number(high)})*({number(high)}-{var})"


def _piecewise(var, pieces):
    """pieces: [(lower bound or None, expression)], ordered; each piece holds from its bound to the next one."""
    terms = []
    for index, (_, expression) in enumerate(pieces):
        guards = []
        if index > 0:
            guards.append(f"(1-({var}<{number(pieces[index][0])}))")
        if index + 1 < len(pieces):
            guards.append(f"({var}<{number(pieces[index + 1][0])})")
        terms.append("*".join(guards + [f"({expression})"]))
    return "+".join(terms)


def emf_expression(tc, var="t"):
    """E(t) in mV; outside the reference range the end subranges are extrapolated (clamp t first)."""
    pieces = [(low, horner(coeffs, var)) for low, _, coeffs in FORWARD[tc]]
    text = _piecewise(var, pieces)
    if tc == "K":
        a0, a1, a2 = K_EXPONENTIAL
        text += f"+(1-({var}<0))*{number(a0)}*2.718281828459045^({number(a1)}*({var}-{number(a2)})*({var}-{number(a2)}))"
    return text


def temperature_expression(tc, var="e"):
    """t(E) in degC from the NIST inverse; clamp E to e_range(tc) first."""
    return _piecewise(var, [(low, horner(coeffs, var)) for low, _, coeffs in INVERSE[tc]])


def select_expression(code_var, names):
    """Picks names[k] when code_var == k (codes 0, 1, 2...)."""
    return "+".join(f"({code_var}>{k - 0.5})*({code_var}<{k + 0.5})*{name}" for k, name in enumerate(names))


def evaluate(expression, **values):
    """Evaluates a calc expression the way the Core does (for the checks): ^ is power."""
    return eval(expression.replace("^", "**"), {"__builtins__": {}}, values)


# --- C header for the native palette device ------------------------------------------------------------
def c_header():
    out = ["/* Generated by scripts/thermocouple_its90.py --c-header. Do not edit by hand.",
           " * NIST ITS-90 thermocouple reference functions (NIST Monograph 175, https://its90.nist.gov),",
           " * E in mV for t in degC with the reference junction at 0 degC. */",
           "#ifndef THERMOCOUPLE_ITS90_H", "#define THERMOCOUPLE_ITS90_H", "",
           "typedef struct { double t_low; double t_high; int count; double c[15]; } TcSegment;",
           "typedef struct { char letter; int segments; TcSegment seg[3]; } TcType;", "",
           "static const TcType kTcTypes[8] = {"]
    for tc in TYPES:
        segs = []
        for low, high, coeffs in FORWARD[tc]:
            cs = ", ".join(f"{c!r}" for c in coeffs)
            segs.append(f"        {{{low!r}, {high!r}, {len(coeffs)}, {{{cs}}}}}")
        out.append(f"    {{'{tc}', {len(FORWARD[tc])}, {{\n" + ",\n".join(segs) + "\n    }},")
    out += ["};", ""]
    a0, a1, a2 = K_EXPONENTIAL
    out += [f"static const double kTcKExp[3] = {{{a0!r}, {a1!r}, {a2!r}}}; /* type K, t >= 0 */", "", "#endif", ""]
    return "\n".join(out)


# --- checks against the NIST tables ---------------------------------------------------------------------
def _read_table(path):
    import re
    table = {}
    for line in open(path, encoding="latin1"):
        match = re.match(r"^\s*(-?\d+)\s+(-?\d+\.\d+(?:\s+-?\d+\.\d+)*)\s*$", line)
        if not match:
            continue
        base = int(match.group(1))
        values = [float(x) for x in match.group(2).split()]
        negative = base < 0 or (base == 0 and len(values) > 1 and values[1] < 0)
        for index, value in enumerate(values[:11]):
            table.setdefault(base - index if negative else base + index, value)
    return table


def check(tables_dir=None):
    worst = {}
    for tc in TYPES:
        low, high = t_range(tc)
        forward_error = 0.0
        if tables_dir:
            table = _read_table(f"{tables_dir}/type_{tc.lower()}.tab.txt")
            for t, value in table.items():
                if low <= t <= high:
                    forward_error = max(forward_error, abs(emf(tc, t) - value))
        inverse_error = 0.0
        e_low, e_high = e_range(tc)
        t = math.ceil(low)
        while t <= high:
            e = emf(tc, t)
            if e_low <= e <= e_high and (tc != "B" or t >= 250):
                inverse_error = max(inverse_error, abs(temperature(tc, e) - t))
            t += 1
        expression_error = 0.0
        fwd, inv = emf_expression(tc), temperature_expression(tc)
        for t in range(int(math.ceil(low)), int(high) + 1, 7):
            expression_error = max(expression_error, abs(evaluate(fwd, t=float(t)) - emf(tc, t)))
            e = emf(tc, t)
            if e_low <= e <= e_high:
                expression_error = max(expression_error, abs(evaluate(inv, e=e) - temperature(tc, e)))
        worst[tc] = (forward_error, inverse_error, expression_error)
        print(f"{tc}: reference vs NIST table {forward_error:.6f} mV, inverse {inverse_error:.4f} degC, expressions {expression_error:.2e}")
    return worst


if __name__ == "__main__":
    if "--c-header" in sys.argv:
        path = sys.argv[sys.argv.index("--c-header") + 1]
        with open(path, "w", encoding="utf-8", newline="\n") as handle:
            handle.write(c_header())
        print("wrote", path)
    if "--check" in sys.argv:
        tables = sys.argv[sys.argv.index("--tables") + 1] if "--tables" in sys.argv else None
        result = check(tables)
        bad = [tc for tc, (f, i, x) in result.items() if (tables and f > 0.0006) or i > 0.07 or x > 1e-9]
        if bad:
            sys.exit(f"out of tolerance: {bad}")
