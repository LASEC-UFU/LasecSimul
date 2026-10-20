#!/usr/bin/env python3
"""Desenho vetorial do "Tanque vetorial" da biblioteca HMI (graphics.tank_svg).

O tanque antigo era uma imagem vetorizada por traçado (subcircuits/tank.svg, VTracer) com o líquido
recortado numa janela em corte -- o nível aparecia como uma mancha curva de um lado do cilindro. Este
desenho é nativo do IR de pintura (project/schema/component-catalog.json): costado de vidro de parede
inteira entre cabeças de aço, e o líquido ocupa toda a largura interna até o nível (0..100 % = fundo..topo
do vidro), com superfície, régua de 10 em 10 % e o valor opcional. Mesmo typeId, caixa 120 x 180 e
propriedades de antes (Nível, cor do líquido, Binding) -- os projetos existentes não mudam.

Uso:
  python scripts/generate-vector-tank.py            # grava o pacote no catálogo
  python scripts/generate-vector-tank.py --print    # só imprime o pacote (JSON)
"""
import json
import pathlib
import sys

REPO = pathlib.Path(__file__).resolve().parents[1]
CATALOG = REPO / "project" / "schema" / "component-catalog.json"

W, H = 120, 180
L, R = 14, 106            # costado (aço) de 14 a 106
GL, GR = 17, 103          # vidro (interior) de 17 a 103
GT, GB = 36, 144          # vidro: topo e fundo -> o nível vai de GB (0 %) a GT (100 %)
SPAN = GB - GT
CX = (L + R) / 2


def pct(multiplier, offset, **extra):
    return {"prop": "__g_pct", "multiplier": multiplier, "offset": offset, **extra}


def steel_h(x1, x2):
    """Aço escovado na horizontal (cilindro iluminado da esquerda)."""
    return {"kind": "linear", "x1": x1, "y1": 0, "x2": x2, "y2": 0, "stops": [
        {"offset": 0, "color": "#4b5563"}, {"offset": 0.16, "color": "#e5e9ee"}, {"offset": 0.42, "color": "#a3acb8"},
        {"offset": 0.72, "color": "#d7dde4"}, {"offset": 1, "color": "#3f4752"}]}


def steel_v(y1, y2):
    return {"kind": "linear", "x1": 0, "y1": y1, "x2": 0, "y2": y2, "stops": [
        {"offset": 0, "color": "#f1f4f7"}, {"offset": 0.5, "color": "#a3acb8"}, {"offset": 1, "color": "#4b5563"}]}


level_y = pct(-SPAN / 100, GB)          # topo do líquido
liquid_h = pct(SPAN / 100, 0, min=0)    # altura do líquido

primitives = [
    # sombra no chão
    {"kind": "ellipse", "cx": CX, "cy": 175, "rx": 46, "ry": 3.5, "fill": "#020617", "stroke": "none", "opacity": 0.28},
    # pés
    {"kind": "rect", "x": 24, "y": 150, "w": 7, "h": 21, "fill": "#9ca3af", "stroke": "none", "fillGradient": steel_h(24, 31)},
    {"kind": "rect", "x": 89, "y": 150, "w": 7, "h": 21, "fill": "#9ca3af", "stroke": "none", "fillGradient": steel_h(89, 96)},
    {"kind": "rect", "x": 20, "y": 170, "w": 15, "h": 3, "rx": 1, "ry": 1, "fill": "#374151", "stroke": "none"},
    {"kind": "rect", "x": 85, "y": 170, "w": 15, "h": 3, "rx": 1, "ry": 1, "fill": "#374151", "stroke": "none"},
    # bocal de saída (embaixo, à direita)
    {"kind": "rect", "x": 98, "y": 151, "w": 18, "h": 6, "fill": "#9ca3af", "stroke": "none", "fillGradient": steel_v(151, 157)},
    {"kind": "rect", "x": 114, "y": 148, "w": 4, "h": 12, "rx": 1, "ry": 1, "fill": "#6b7280", "stroke": "none", "fillGradient": steel_h(114, 118)},
    # cabeça inferior (calota) e aro
    {"kind": "path", "d": f"M {L} 144 C {L} 162 {R} 162 {R} 144 Z", "fill": "#9ca3af", "stroke": "#374151", "strokeWidth": 0.6, "fillGradient": steel_h(L, R)},
    # bocal de entrada no topo
    {"kind": "rect", "x": 54, "y": 8, "w": 12, "h": 16, "fill": "#9ca3af", "stroke": "none", "fillGradient": steel_h(54, 66)},
    {"kind": "rect", "x": 50, "y": 6, "w": 20, "h": 4, "rx": 1, "ry": 1, "fill": "#6b7280", "stroke": "none", "fillGradient": steel_h(50, 70)},
    # cabeça superior (calota)
    {"kind": "path", "d": f"M {L} 36 C {L} 18 {R} 18 {R} 36 Z", "fill": "#9ca3af", "stroke": "#374151", "strokeWidth": 0.6, "fillGradient": steel_h(L, R)},
    # interior (parede de fundo) visto pelo vidro
    {"kind": "rect", "x": GL, "y": GT, "w": GR - GL, "h": SPAN, "fill": "#14263f", "stroke": "none",
     "fillGradient": {"kind": "linear", "x1": 0, "y1": GT, "x2": 0, "y2": GB, "stops": [
         {"offset": 0, "color": "#22364f"}, {"offset": 1, "color": "#0f1d33"}]}},
    # líquido: ocupa TODA a largura interna até o nível
    {"kind": "clip", "d": f"M {GL} {GT} H {GR} V {GB} H {GL} Z", "primitives": [
        {"kind": "rect", "x": GL, "y": level_y, "w": GR - GL, "h": liquid_h, "fill": "#1e88e5", "stroke": "none", "opacity": 0.92,
         "stateFill": {"prop": "liquidColor", "raw": True, "fallback": "#1e88e5"}},
        # volume: brilho à esquerda, sombra à direita e no fundo (sobre qualquer cor de líquido)
        {"kind": "rect", "x": GL, "y": level_y, "w": GR - GL, "h": liquid_h, "fill": "none", "stroke": "none",
         "fillGradient": {"kind": "linear", "x1": GL, "y1": 0, "x2": GR, "y2": 0, "stops": [
             {"offset": 0, "color": "rgba(255,255,255,0.30)"}, {"offset": 0.22, "color": "rgba(255,255,255,0)"},
             {"offset": 0.78, "color": "rgba(0,0,0,0)"}, {"offset": 1, "color": "rgba(0,0,0,0.28)"}]}},
        {"kind": "rect", "x": GL, "y": level_y, "w": GR - GL, "h": liquid_h, "fill": "none", "stroke": "none",
         "fillGradient": {"kind": "linear", "x1": 0, "y1": GT, "x2": 0, "y2": GB, "stops": [
             {"offset": 0, "color": "rgba(0,0,0,0)"}, {"offset": 1, "color": "rgba(0,0,0,0.30)"}]}},
        # superfície (elipse clara); some no vazio
        {"kind": "ellipse", "cx": CX, "cy": level_y, "rx": (GR - GL) / 2, "ry": pct(0.6, 0, min=0, max=5),
         "fill": "rgba(255,255,255,0.38)", "stroke": "rgba(255,255,255,0.65)", "strokeWidth": 0.8},
    ]},
    # régua: um traço a cada 10 % (mais longo a 50 %), do lado direito do vidro
    {"kind": "repeat", "count": 9, "stepY": -SPAN / 10, "primitives": [
        {"kind": "line", "x1": GR - 7, "y1": GB - SPAN / 10, "x2": GR - 2, "y2": GB - SPAN / 10, "stroke": "rgba(255,255,255,0.6)", "strokeWidth": 0.9},
    ]},
    {"kind": "line", "x1": GR - 11, "y1": GB - SPAN / 2, "x2": GR - 2, "y2": GB - SPAN / 2, "stroke": "rgba(255,255,255,0.85)", "strokeWidth": 1.1},
    # vidro: reflexos e borda
    {"kind": "rect", "x": GL, "y": GT, "w": GR - GL, "h": SPAN, "fill": "none", "stroke": "rgba(226,232,240,0.7)", "strokeWidth": 1,
     "fillGradient": {"kind": "linear", "x1": GL, "y1": 0, "x2": GR, "y2": 0, "stops": [
         {"offset": 0, "color": "rgba(255,255,255,0.32)"}, {"offset": 0.12, "color": "rgba(255,255,255,0.10)"},
         {"offset": 0.5, "color": "rgba(255,255,255,0.03)"}, {"offset": 0.88, "color": "rgba(255,255,255,0.16)"},
         {"offset": 1, "color": "rgba(255,255,255,0.05)"}]}},
    {"kind": "rect", "x": GL + 5, "y": GT + 5, "w": 4, "h": SPAN - 10, "rx": 2, "ry": 2, "fill": "#ffffff", "stroke": "none", "opacity": 0.26},
    # aros de aço sobre as bordas do vidro
    {"kind": "rect", "x": L - 2, "y": GT - 4, "w": R - L + 4, "h": 7, "rx": 2, "ry": 2, "fill": "#9ca3af", "stroke": "#374151", "strokeWidth": 0.5, "fillGradient": steel_h(L - 2, R + 2)},
    {"kind": "rect", "x": L - 2, "y": GB - 3, "w": R - L + 4, "h": 7, "rx": 2, "ry": 2, "fill": "#9ca3af", "stroke": "#374151", "strokeWidth": 0.5, "fillGradient": steel_h(L - 2, R + 2)},
    # valor (opcional: "Mostrar valor")
    # no meio do líquido (ou logo acima do fundo, com pouco líquido)
    {"kind": "text", "x": CX, "y": pct(-SPAN / 200, GB, max=GB - 14), "value": "", "stateText": {"kind": "property", "prop": "__g_text"},
     "fontSize": 15, "maxWidth": GR - GL - 14, "fontWeight": 700, "textAnchor": "middle", "dominantBaseline": "middle",
     "fill": "#ffffff", "stroke": "none", "stateVisible": {"when": {"showValue": ["true"]}}},
]

package = {
    "width": W, "height": H, "border": False, "background": {"kind": "none"}, "pins": [], "aspect": "fixed",
    "dynamicLayout": {"schematicWidth": {"prop": "width", "fallback": W}, "schematicHeight": {"prop": "height", "fallback": H}},
    "simulidePaint": {
        "version": 1, "bounds": {"x": 0, "y": 0, "w": W, "h": H}, "aspect": "fixed", "referenceSize": {"width": W, "height": H},
        "defaultStroke": "none", "defaultFill": "none", "defaultStrokeWidth": 1, "primitives": primitives,
    },
}

DESCRIPTION = ("Tanque vertical de vidro entre cabeças de aço. O líquido ocupa toda a largura interna até o Nível (%), "
               "fixo ou ligado a uma fonte de simulação (Binding), com superfície, régua de 10 em 10 % e o valor opcional.")


def find_object_end(text: str, start: int) -> int:
    """Índice logo depois do objeto JSON que começa em `start` ('{'), respeitando strings."""
    depth, i, in_string = 0, start, False
    while i < len(text):
        ch = text[i]
        if in_string:
            if ch == "\\":
                i += 2
                continue
            if ch == '"':
                in_string = False
        elif ch == '"':
            in_string = True
        elif ch == "{":
            depth += 1
        elif ch == "}":
            depth -= 1
            if depth == 0:
                return i + 1
        i += 1
    raise ValueError("objeto JSON sem fim")


def write_catalog() -> None:
    """Troca só o pacote, o ícone e a descrição do item -- o resto do catálogo fica byte a byte igual."""
    # Bytes: o fim de linha do arquivo (LF ou CRLF, conforme o checkout) volta exatamente como estava.
    raw = CATALOG.read_bytes().decode("utf8")
    eol = "\r\n" if "\r\n" in raw else "\n"
    text = raw.replace("\r\n", "\n")
    item = text.index('"typeId": "graphics.tank_svg"')
    item_start = text.rindex("{", 0, item)
    item_end = find_object_end(text, item_start)
    block = text[item_start:item_end]
    key = block.index('"package"')
    indent = block[block.rindex("\n", 0, key) + 1:key]  # espaços antes de "package" (sem a quebra de linha)
    pkg_key = block.index('"package": ')
    pkg_start = pkg_key + len('"package": ')
    pkg_end = find_object_end(block, pkg_start)
    rendered = json.dumps(package, ensure_ascii=False, indent=2).replace("\n", "\n" + indent)
    block = block[:pkg_start] + rendered + block[pkg_end:]
    block = block.replace('"iconFilePath": "../../subcircuits/tank.svg"', '"iconFilePath": "../../subcircuits/tank-vector.svg"')
    old_description = json.loads(text[item_start:item_end])["help"]["description"]
    block = block.replace(json.dumps(old_description, ensure_ascii=False), json.dumps(DESCRIPTION, ensure_ascii=False))
    if '"showValue"' not in block.split('"package"')[0]:
        # "Mostrar valor": padrão desligado (como antes) e o campo no Inspector, logo depois da cor do líquido.
        nl = "\n"
        block = block.replace('"liquidColor": "#1e88e5",' + nl, '"liquidColor": "#1e88e5",' + nl + indent + '  "showValue": false,' + nl, 1)
        entry_end = block.index('"editor": "color",', block.index('"id": "liquidColor"'))
        entry_end = block.index("}", entry_end) + 1
        schema_indent = indent + "  "
        entry = {"id": "showValue", "label": "Mostrar valor", "group": "Aparência", "unit": "", "editor": "checkbox", "default": False}
        show_value = json.dumps(entry, ensure_ascii=False, indent=2).replace(nl, nl + schema_indent)
        block = block[:entry_end] + "," + nl + schema_indent + show_value + block[entry_end:]
    text = text[:item_start] + block + text[item_end:]
    json.loads(text)  # o catálogo continua sendo JSON válido
    CATALOG.write_bytes(text.replace("\n", eol).encode("utf8"))
    print(f"pacote do graphics.tank_svg gravado em {CATALOG.relative_to(REPO)}")


ICON = REPO / "subcircuits" / "tank-vector.svg"


def write_icon() -> None:
    """Ícone da paleta: o mesmo desenho, estático, com o líquido em 55 %."""
    level = GB - SPAN * 0.55
    svg = f"""<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 {W} {H}" width="{W}" height="{H}">
  <defs>
    <linearGradient id="s" x1="{L}" y1="0" x2="{R}" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#4b5563"/><stop offset="0.16" stop-color="#e5e9ee"/><stop offset="0.42" stop-color="#a3acb8"/><stop offset="0.72" stop-color="#d7dde4"/><stop offset="1" stop-color="#3f4752"/></linearGradient>
    <linearGradient id="g" x1="{GL}" y1="0" x2="{GR}" y2="0" gradientUnits="userSpaceOnUse"><stop offset="0" stop-color="#fff" stop-opacity="0.32"/><stop offset="0.5" stop-color="#fff" stop-opacity="0.03"/><stop offset="1" stop-color="#fff" stop-opacity="0.12"/></linearGradient>
  </defs>
  <rect x="24" y="150" width="7" height="21" fill="url(#s)"/><rect x="89" y="150" width="7" height="21" fill="url(#s)"/>
  <path d="M {L} 144 C {L} 162 {R} 162 {R} 144 Z" fill="url(#s)" stroke="#374151" stroke-width="0.6"/>
  <rect x="54" y="8" width="12" height="16" fill="url(#s)"/><rect x="50" y="6" width="20" height="4" rx="1" fill="#6b7280"/>
  <path d="M {L} 36 C {L} 18 {R} 18 {R} 36 Z" fill="url(#s)" stroke="#374151" stroke-width="0.6"/>
  <rect x="{GL}" y="{GT}" width="{GR - GL}" height="{SPAN}" fill="#1b2d48"/>
  <rect x="{GL}" y="{level:.1f}" width="{GR - GL}" height="{GB - level:.1f}" fill="#1e88e5" opacity="0.92"/>
  <ellipse cx="{CX}" cy="{level:.1f}" rx="{(GR - GL) / 2}" ry="5" fill="#fff" fill-opacity="0.38"/>
  <rect x="{GL}" y="{GT}" width="{GR - GL}" height="{SPAN}" fill="url(#g)" stroke="#e2e8f0" stroke-opacity="0.7"/>
  <rect x="{L - 2}" y="{GT - 4}" width="{R - L + 4}" height="7" rx="2" fill="url(#s)"/><rect x="{L - 2}" y="{GB - 3}" width="{R - L + 4}" height="7" rx="2" fill="url(#s)"/>
</svg>
"""
    ICON.write_bytes(svg.encode("utf8"))
    print(f"ícone gravado em {ICON.relative_to(REPO)}")


if __name__ == "__main__":
    if "--print" in sys.argv:
        print(json.dumps(package, ensure_ascii=False))
    else:
        write_catalog()
        write_icon()
