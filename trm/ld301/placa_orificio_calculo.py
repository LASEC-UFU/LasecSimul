"""
Cálculo de vazão em placa de orifício (ISO 5167-2) para conferir a simulação do LasecSimul.

Projeto: trm/ld301/placa_orificio_ld301.lsproj, planta "Placa de orifício (vazão por ΔP)".
O script usa as MESMAS equações e os MESMOS ajustes da planta. Com os mesmos valores, ele chega à
mesma vazão mostrada no display "Vazão" da simulação.

Como usar
---------
1. Copie para CONFIGURACAO (logo abaixo) os valores que estão em "Propriedades exportadas" da planta.
2. Rode o script e informe o que você mediu:

     python placa_orificio_calculo.py                         pergunta o que foi medido
     python placa_orificio_calculo.py --dp 836.1              ΔP lido no LD301/PACTware (mmH2O)
     python placa_orificio_calculo.py --corrente 7.96         corrente do laço (mA), LD301 linear
     python placa_orificio_calculo.py --corrente 11.96 --raiz corrente do laço, LD301 com raiz quadrada
     python placa_orificio_calculo.py --valvula 50            caminho direto: abertura -> vazão -> ΔP

3. Compare a vazão calculada com o display "Vazão" da planta (e os outros valores com os displays).

Os ajustes também podem ir na linha de comando (ex.: --D 52.5 --d 31.5 --tomada 2 --T 80); veja --help.
"--autoteste" confere o script com os valores de referência da biblioteca fluids (ISO 5167-2).

Só usa a biblioteca padrão do Python (3.7 ou mais novo).
"""
import argparse
import math
import sys

# =====================================================================================
# CONFIGURAÇÃO -- os mesmos ajustes de "Propriedades exportadas" da planta na simulação
# =====================================================================================
CONFIGURACAO = {
    "D": 52.5,            # Diâmetro interno da tubulação D, a 20 °C [mm]
    "d": 31.5,            # Diâmetro do orifício d, a 20 °C [mm]
    "tomada": 1,          # Tipo de tomada: 1 = Flange, 2 = D e D/2 (radius taps), 3 = Canto (corner taps)
    "L_montante": 44.0,   # Trecho reto a montante, da curva de 90° até a placa [múltiplos de D]
    "L_jusante": 8.0,     # Trecho reto a jusante, da placa até a válvula [múltiplos de D]
    "material_tubo": 1,   # Material da tubulação (código da tabela MATERIAIS abaixo)
    "material_placa": 2,  # Material da placa de orifício (código da tabela MATERIAIS)
    "T": 20.0,            # Temperatura de operação [°C]
    "fluido": 0,          # 0 = Líquido (ε = 1), 1 = Gás (ε pela ISO 5167-2)
    "rho": 998.2,         # Massa específica do fluido na operação, a montante [kg/m³]
    "mu": 1.002,          # Viscosidade dinâmica [cP]
    "kappa": 1.4,         # Expoente isentrópico κ (só para gás)
    "p1": 200.0,          # Pressão a montante, manométrica [kPa]
    "Qmax": 15.0,         # Vazão máxima, válvula 100 % [m³/h]
    "desvio": 1,          # Desvio didático de instalação e rugosidade: 1 = aplicar, 0 = não aplicar
    # LD301 (só para converter a corrente do laço em ΔP)
    "LRV": 0.0,           # Limite inferior da faixa [mmH2O]
    "URV": 3376.3,        # Limite superior da faixa [mmH2O]
    "corte_raiz": 6.0,    # Ponto de corte da raiz quadrada [% da faixa]
}

# código: (nome, coeficiente de dilatação α [1e-6/K], rugosidade Ra [mm])
MATERIAIS = {
    1: ("Aço carbono", 11.2, 0.015),
    2: ("Aço inox AISI 316", 16.0, 0.005),
    3: ("Ferro fundido", 10.4, 0.08),
    4: ("Aço galvanizado", 11.2, 0.05),
    5: ("Cobre", 16.8, 0.0005),
    6: ("PVC", 54.0, 0.0005),
}
TOMADAS = {1: "Flange (25,4 mm da placa)", 2: "D e D/2 (radius taps)", 3: "Canto (corner taps)"}

MMH2O_EM_PA = 9.80665          # 1 mmH2O = 9,80665 Pa
KPA_EM_MMH2O = 101.97162       # 1 kPa = 101,97162 mmH2O
P_ATM_KPA = 101.325            # pressão atmosférica [kPa]


# =====================================================================================
# Equações (as mesmas dos blocos da planta)
# =====================================================================================
def geometria(cfg):
    """D e d na temperatura de operação (dilatação térmica dos materiais) e β = d/D."""
    _, alfa_tubo, ra_tubo = MATERIAIS[cfg["material_tubo"]]
    _, alfa_placa, _ = MATERIAIS[cfg["material_placa"]]
    D_T = cfg["D"] * (1 + alfa_tubo * 1e-6 * (cfg["T"] - 20))
    d_T = cfg["d"] * (1 + alfa_placa * 1e-6 * (cfg["T"] - 20))
    return {"alfa_tubo": alfa_tubo, "alfa_placa": alfa_placa, "Ra": ra_tubo, "D_T": D_T, "d_T": d_T, "beta": d_T / D_T}


def distancias_tomada(tomada, D_mm):
    """L1 (tomada de alta) e L'2 (tomada de baixa), em múltiplos de D -- ISO 5167-2, 5.3.2.1."""
    if tomada == 1:
        return 25.4 / D_mm, 25.4 / D_mm   # flange: 25,4 mm de cada face da placa
    if tomada == 2:
        return 1.0, 0.47                  # D e D/2
    return 0.0, 0.0                       # canto


def coeficiente_iso(beta, Re, tomada, D_mm):
    """C pela equação de Reader-Harris/Gallagher (ISO 5167-2)."""
    Re = Re + (1 if Re < 1 else 0)  # vazão zero: evita divisão por zero (C não é usado nesse caso)
    L1, L2 = distancias_tomada(tomada, D_mm)
    A = (19000 * beta / Re) ** 0.8
    M2 = 2 * L2 / (1 - beta)
    C = (0.5961 + 0.0261 * beta ** 2 - 0.216 * beta ** 8
         + 0.000521 * (1e6 * beta / Re) ** 0.7
         + (0.0188 + 0.0063 * A) * beta ** 3.5 * (1e6 / Re) ** 0.3
         + (0.043 + 0.080 * math.exp(-10 * L1) - 0.123 * math.exp(-7 * L1)) * (1 - 0.11 * A) * beta ** 4 / (1 - beta ** 4)
         - 0.031 * (M2 - 0.8 * M2 ** 1.1) * beta ** 1.3)
    if D_mm < 71.12:  # termo de tubulação pequena
        C += 0.011 * (0.75 - beta) * (2.8 - D_mm / 25.4)
    return C


def trechos_exigidos(beta):
    """Tabela 3 da ISO 5167-2 (uma curva de 90° a montante), em múltiplos de D.
    β intermediário usa a linha do β maior seguinte. Devolve (montante A, montante B, jusante)."""
    if beta < 0.2001:
        return 6, 3, 4
    if beta < 0.4001:
        return 16, 3, 6
    if beta < 0.5001:
        return 22, 9, 6
    if beta < 0.6001:
        return 42, 13, 7
    if beta < 0.6701:
        return 44, 20, 7
    return 44, 20, 8


def limite_rugosidade(beta):
    """Limite de 10⁴·Ra/D (aproximação da Tabela 1 da ISO 5167-2)."""
    return 25.0 if beta < 0.3 else 4 + 21 * math.exp(-19.1 * (beta - 0.3))


def desvio_didatico(cfg, geo):
    """Desvio do C quando a instalação foge da norma (recurso didático, não é da ISO). Em %."""
    A, B, A_jus = trechos_exigidos(geo["beta"])
    L, L_jus = cfg["L_montante"], cfg["L_jusante"]
    montante = 0.0
    if B < L < A:
        montante = 0.5 * (A - L) / (A - B)          # +0,5 % no comprimento B
    elif L < B + 1e-6:
        montante = 0.5 + 1.5 * (B - L) / B          # até +2 % sem trecho reto
    jusante = 0.0
    if A_jus / 2 < L_jus < A_jus:
        jusante = 0.25 * (A_jus - L_jus) / (A_jus / 2)
    elif L_jus < A_jus / 2 + 1e-6:
        jusante = 0.25 + 0.25 * (A_jus / 2 - L_jus) / (A_jus / 2)
    r = 1e4 * geo["Ra"] / geo["D_T"]
    lim = limite_rugosidade(geo["beta"])
    rugosidade = 0.0
    if r > lim:
        rugosidade = 0.5 * (r / lim - 1) if r / lim < 5 else 2.0
    total = (montante + jusante + rugosidade) if cfg["desvio"] == 1 else 0.0
    return {"A": A, "B": B, "A_jus": A_jus, "montante": montante, "jusante": jusante, "rugosidade": rugosidade,
            "total": total, "rug_rel": r, "rug_lim": lim}


def razao_pressoes(cfg, dp_pa):
    """p2/p1 em pressão absoluta (limitada a 0,01, como na planta)."""
    p1_abs = cfg["p1"] + P_ATM_KPA
    return max((p1_abs - dp_pa / 1000) / p1_abs, 0.01)


def expansibilidade(cfg, beta, dp_pa):
    """ε pela ISO 5167-2 para gás; 1 para líquido."""
    if cfg["fluido"] != 1:
        return 1.0
    return 1 - (0.351 + 0.256 * beta ** 4 + 0.93 * beta ** 8) * (1 - razao_pressoes(cfg, dp_pa) ** (1 / cfg["kappa"]))


def reynolds(cfg, Q_m3h, D_mm):
    """Re_D = 4·ρ·Q / (π·μ·D)."""
    return 4 * cfg["rho"] * (Q_m3h / 3600) / (math.pi * cfg["mu"] * 1e-3 * D_mm * 1e-3)


def perda_permanente(beta, C, dp):
    raiz = math.sqrt(1 - beta ** 4 * (1 - C ** 2))
    return (raiz - C * beta ** 2) / (raiz + C * beta ** 2) * dp


def conformidade(cfg, geo, dev, Re, dp_pa):
    """As lâmpadas de conformidade da planta."""
    b, D, d, t = geo["beta"], geo["D_T"], geo["d_T"], cfg["tomada"]
    faixa_re = Re > 170 * b ** 2 * D if t == 1 else (b < 0.56 or Re > 16000 * b ** 2)
    faixa_iso = (0.0999 < b < 0.7501 and 49.999 < D < 1000.001 and d > 12.499 and Re > 5000 and faixa_re
                 and (cfg["fluido"] != 1 or razao_pressoes(cfg, dp_pa) > 0.75))
    return {"Montante": cfg["L_montante"] > dev["A"] - 1e-4, "Jusante": cfg["L_jusante"] > dev["A_jus"] - 1e-4,
            "Rugosidade": dev["rug_rel"] < dev["rug_lim"], "Faixa ISO": faixa_iso}


def resultado_completo(cfg, Q_m3h, dp_pa, C_iso, C_real, eps, geo, dev):
    Re = reynolds(cfg, Q_m3h, geo["D_T"])
    return {
        "Q": Q_m3h, "v": Q_m3h / 3600 / (math.pi / 4 * (geo["D_T"] / 1000) ** 2), "Re": Re,
        "C_iso": C_iso, "C_real": C_real, "eps": eps, "dp_pa": dp_pa,
        "perda_kpa": perda_permanente(geo["beta"], C_real, dp_pa) / 1000,
        "geo": geo, "dev": dev, "ok": conformidade(cfg, geo, dev, Re, dp_pa),
    }


def dp_da_vazao(cfg, Q_m3h):
    """Caminho direto (o que a simulação faz): vazão -> C -> ε -> ΔP."""
    geo = geometria(cfg)
    dev = desvio_didatico(cfg, geo)
    b, d = geo["beta"], geo["d_T"] / 1000
    C_iso = coeficiente_iso(b, reynolds(cfg, Q_m3h, geo["D_T"]), cfg["tomada"], geo["D_T"])
    C_real = C_iso * (1 + dev["total"] / 100)
    dp0 = 8 * cfg["rho"] * (1 - b ** 4) * (Q_m3h / 3600) ** 2 / (C_real ** 2 * math.pi ** 2 * d ** 4)
    dp, eps = dp0, 1.0
    for _ in range(50):  # ε depende de ΔP e ΔP depende de ε
        eps = expansibilidade(cfg, b, dp)
        dp = dp0 / eps ** 2
    return resultado_completo(cfg, Q_m3h, dp, C_iso, C_real, eps, geo, dev)


def vazao_do_dp(cfg, dp_mmh2o, mostrar_iteracoes=True):
    """Caminho do aluno: ΔP medido -> vazão. C depende de Re, que depende da vazão: itera.
    Q = C·ε·(π/4)·d²·√(2·ΔP / (ρ·(1 − β⁴)))."""
    geo = geometria(cfg)
    dev = desvio_didatico(cfg, geo)
    b, d = geo["beta"], geo["d_T"] / 1000
    dp = dp_mmh2o * MMH2O_EM_PA
    if dp <= 0:
        return resultado_completo(cfg, 0.0, 0.0, coeficiente_iso(b, 0, cfg["tomada"], geo["D_T"]), 0.0, 1.0, geo, dev)
    eps = expansibilidade(cfg, b, dp)  # com o ΔP conhecido, ε sai direto
    raiz = math.sqrt(2 * dp / (cfg["rho"] * (1 - b ** 4)))
    C_iso = 0.6  # chute inicial
    if mostrar_iteracoes:
        print("\nIteração (C depende de Re, que depende de Q):")
        print("   k      C (ISO)      C real     Q [m³/h]        Re_D")
    Q = 0.0
    for k in range(1, 51):
        C_real = C_iso * (1 + dev["total"] / 100)
        Q = C_real * eps * math.pi / 4 * d ** 2 * raiz * 3600
        Re = reynolds(cfg, Q, geo["D_T"])
        if mostrar_iteracoes:
            print(f"  {k:2d}   {C_iso:10.6f}  {C_real:10.6f}  {Q:11.6f}  {Re:10.0f}")
        novo = coeficiente_iso(b, Re, cfg["tomada"], geo["D_T"])
        if abs(novo - C_iso) < 1e-12:
            break
        C_iso = novo
    return resultado_completo(cfg, Q, dp, C_iso, C_iso * (1 + dev["total"] / 100), eps, geo, dev)


def dp_da_corrente(cfg, miliamperes, raiz):
    """Corrente do laço do LD301 (4–20 mA) -> ΔP, com a função de transferência linear ou raiz quadrada."""
    saida = (miliamperes - 4) / 16 * 100  # % da saída
    if raiz:
        limite = 10 * math.sqrt(cfg["corte_raiz"])  # saída no ponto de corte
        if saida < limite:
            print(f"Aviso: saída {saida:.2f} % abaixo do corte da raiz ({cfg['corte_raiz']} % da faixa = {limite:.2f} % da saída); "
                  "abaixo do corte a saída não segue a raiz.")
        entrada = (max(saida, 0) / 10) ** 2   # inverso de saída = 10·√entrada
    else:
        entrada = saida
    return cfg["LRV"] + entrada / 100 * (cfg["URV"] - cfg["LRV"]), entrada


# =====================================================================================
# Relatório (mesmos valores dos displays da planta)
# =====================================================================================
def relatorio(cfg, r):
    geo, dev = r["geo"], r["dev"]
    print("\nAjustes")
    print(f"  D = {cfg['D']} mm, d = {cfg['d']} mm (a 20 °C); tomada: {TOMADAS[cfg['tomada']]}")
    print(f"  Tubulação: {MATERIAIS[cfg['material_tubo']][0]}; placa: {MATERIAIS[cfg['material_placa']][0]}; T = {cfg['T']} °C")
    print(f"  Fluido: {'gás' if cfg['fluido'] == 1 else 'líquido'}; ρ = {cfg['rho']} kg/m³; μ = {cfg['mu']} cP; p1 = {cfg['p1']} kPa")
    print("\nGeometria na temperatura de operação")
    print(f"  D = {cfg['D']}·(1 + {geo['alfa_tubo']}e-6·({cfg['T']} − 20)) = {geo['D_T']:.2f} mm")
    print(f"  d = {cfg['d']}·(1 + {geo['alfa_placa']}e-6·({cfg['T']} − 20)) = {geo['d_T']:.3f} mm")
    print(f"  β = d/D = {geo['beta']:.4f}")
    print("\nInstalação (ISO 5167-2, Tabela 3 -- uma curva de 90°)")
    print(f"  Montante: instalado {cfg['L_montante']} D, exigido {dev['A']} D (mínimo com +0,5 %: {dev['B']} D)")
    print(f"  Jusante:  instalado {cfg['L_jusante']} D, exigido {dev['A_jus']} D")
    print(f"  10⁴·Ra/D = {dev['rug_rel']:.2f} (limite {dev['rug_lim']:.2f})")
    print(f"  Desvio didático de C: montante {dev['montante']:.3f} % + jusante {dev['jusante']:.3f} % "
          f"+ rugosidade {dev['rugosidade']:.3f} % = {dev['total']:.2f} %{'' if cfg['desvio'] == 1 else ' (desligado)'}")
    print("  Conformidade: " + ", ".join(f"{nome} {'OK' if ok else 'FORA'}" for nome, ok in r["ok"].items()))
    print("\nResultado (compare com os displays da planta)")
    print(f"  Vazão               {r['Q']:.2f} m³/h")
    print(f"  Velocidade          {r['v']:.2f} m/s")
    print(f"  Reynolds Re_D       {r['Re']:.0f}")
    print(f"  C (ISO 5167-2)      {r['C_iso']:.4f}")
    print(f"  C real (com desvio) {r['C_real']:.4f}")
    print(f"  ε (expansibilidade) {r['eps']:.4f}")
    print(f"  ΔP na placa         {r['dp_pa'] / 1000:.2f} kPa = {r['dp_pa'] / MMH2O_EM_PA:.0f} mmH2O")
    print(f"  Perda permanente    {r['perda_kpa']:.2f} kPa")
    print(f"  HIGH / LOW          {KPA_EM_MMH2O * cfg['p1']:.0f} / {KPA_EM_MMH2O * cfg['p1'] - r['dp_pa'] / MMH2O_EM_PA:.0f} mmH2O")


# =====================================================================================
# Autoteste: valores da biblioteca fluids (ISO 5167-2), os mesmos dos testes do simulador
# =====================================================================================
def autoteste():
    def confere(nome, obtido, esperado, tolerancia):
        ok = abs(obtido - esperado) <= tolerancia * abs(esperado)
        print(f"  {'OK   ' if ok else 'FALHA'} {nome}: {obtido:.9g} (esperado {esperado:.9g})")
        return ok

    base = dict(CONFIGURACAO, D=52.5, d=31.5, tomada=1, L_montante=44, L_jusante=8, material_tubo=1, material_placa=2,
                T=20.0, fluido=0, rho=998.2, mu=1.002, kappa=1.4, p1=200.0, Qmax=15.0, desvio=1, LRV=0.0, URV=3376.3)
    ok = True
    r = dp_da_vazao(base, 15)
    ok &= confere("C a 15 m³/h (flange)", r["C_iso"], 0.612422441827, 1e-8)
    ok &= confere("ΔP a 15 m³/h [mmH2O]", r["dp_pa"] / MMH2O_EM_PA, 3376.285174987, 1e-6)
    ok &= confere("perda permanente [kPa]", r["perda_kpa"], 20.728212903, 1e-6)
    ok &= confere("ΔP a 7,5 m³/h [mmH2O]", dp_da_vazao(base, 7.5)["dp_pa"] / MMH2O_EM_PA, 836.081491565, 1e-6)
    ok &= confere("C tomada D e D/2", dp_da_vazao(dict(base, tomada=2), 15)["C_iso"], 0.612965722556, 1e-8)
    ok &= confere("C tomada de canto", dp_da_vazao(dict(base, tomada=3), 15)["C_iso"], 0.611526303754, 1e-8)
    ok &= confere("ΔP com montante 10 D [mmH2O]", dp_da_vazao(dict(base, L_montante=10), 15)["dp_pa"] / MMH2O_EM_PA, 3319.865147240, 1e-6)
    gas = dict(base, fluido=1, rho=3.57, mu=0.0181, Qmax=150.0)
    r = dp_da_vazao(gas, 150)
    ok &= confere("ε do gás", r["eps"], 0.988368449177, 1e-6)
    ok &= confere("ΔP do gás [mmH2O]", r["dp_pa"] / MMH2O_EM_PA, 1244.199774964, 1e-6)
    ok &= confere("vazão do ΔP 836,08 mmH2O [m³/h]", vazao_do_dp(base, 836.081491565, False)["Q"], 7.5, 1e-7)
    ok &= confere("vazão do gás pelo ΔP [m³/h]", vazao_do_dp(gas, 1244.199774964, False)["Q"], 150.0, 1e-6)
    dp_mm, _ = dp_da_corrente(base, 4 + 0.16 * 10 * math.sqrt(100 * 836.081491565 / 3376.3), raiz=True)
    ok &= confere("vazão da corrente com raiz [m³/h]", vazao_do_dp(base, dp_mm, False)["Q"], 7.5, 1e-7)
    print("Autoteste:", "tudo certo" if ok else "FALHOU")
    return ok


# =====================================================================================
def ler_argumentos():
    p = argparse.ArgumentParser(description="Vazão em placa de orifício (ISO 5167-2), igual à planta do LasecSimul.")
    medido = p.add_mutually_exclusive_group()
    medido.add_argument("--dp", type=float, help="ΔP medido [mmH2O] -> calcula a vazão")
    medido.add_argument("--corrente", type=float, help="corrente do laço do LD301 [mA] -> ΔP -> vazão")
    medido.add_argument("--valvula", type=float, help="abertura da válvula [%%] -> vazão -> ΔP")
    medido.add_argument("--autoteste", action="store_true", help="confere o script com os valores de referência")
    p.add_argument("--raiz", action="store_true", help="LD301 com função raiz quadrada (para --corrente)")
    for chave, valor in CONFIGURACAO.items():
        p.add_argument(f"--{chave}", type=type(valor), default=valor, help=f"padrão: {valor}")
    return p.parse_args()


def main():
    try:
        sys.stdout.reconfigure(encoding="utf-8")  # Δ, β, ε no console do Windows
    except (AttributeError, ValueError):
        pass
    args = ler_argumentos()
    if args.autoteste:
        sys.exit(0 if autoteste() else 1)
    cfg = {chave: getattr(args, chave) for chave in CONFIGURACAO}
    if cfg["tomada"] not in TOMADAS or cfg["material_tubo"] not in MATERIAIS or cfg["material_placa"] not in MATERIAIS:
        sys.exit("tomada deve ser 1, 2 ou 3 e os materiais de 1 a 6")

    if args.dp is None and args.corrente is None and args.valvula is None:
        print("O que você mediu?  1) ΔP no LD301 (mmH2O)   2) corrente do laço (mA)   3) abertura da válvula (%)")
        opcao = input("Opção: ").strip()
        valor = float(input("Valor: ").replace(",", "."))
        if opcao == "1":
            args.dp = valor
        elif opcao == "2":
            args.corrente = valor
            args.raiz = input("O LD301 está com raiz quadrada? (s/n): ").strip().lower().startswith("s")
        else:
            args.valvula = valor

    if args.valvula is not None:
        Q = cfg["Qmax"] * max(args.valvula, 0) / 100
        print(f"Vazão imposta pela válvula: Q = Qmax·u/100 = {cfg['Qmax']}·{args.valvula}/100 = {Q:.4f} m³/h")
        relatorio(cfg, dp_da_vazao(cfg, Q))
        return
    if args.corrente is not None:
        dp_mm, entrada = dp_da_corrente(cfg, args.corrente, args.raiz)
        print(f"Corrente {args.corrente} mA -> {entrada:.3f} % da faixa ({'raiz quadrada' if args.raiz else 'linear'}) "
              f"-> ΔP = {cfg['LRV']} + {entrada:.3f} % · ({cfg['URV']} − {cfg['LRV']}) = {dp_mm:.1f} mmH2O")
        args.dp = dp_mm
    relatorio(cfg, vazao_do_dp(cfg, args.dp))


if __name__ == "__main__":
    main()
