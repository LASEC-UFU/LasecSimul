// Tabelas de consulta (biblioteca Lookup Tables). Tabelas N-D são guardadas na ordem linear do
// MATLAB (por coluna: a 1a dimensão varia mais rápido), com breakpoints estritamente crescentes
// (validados no builder). Métodos (Simulink, "Methods for Estimating Missing Points"):
//  - Flat: "Use Input Below" (valor no breakpoint imediatamente abaixo; fora da faixa, o da ponta);
//  - Nearest: breakpoint mais próximo; empate -> o de índice MAIOR;
//  - Linear point-slope: y = T(i) + f (T(i+1) - T(i)); Linear Lagrange: y = (1 - f) T(i) + f T(i+1),
//    aplicados dimensão a dimensão (multilinear sobre os 2^N vizinhos);
//  - Cubic spline: spline cúbica natural (segunda derivada nula nas pontas) em cada dimensão
//    (produto tensorial); Akima spline: Akima modificado (`makima` do MATLAB);
//  - extrapolação Clip (valor da ponta), Linear (reta do primeiro/último par; com spline, a
//    tangente da spline na ponta) e Cubic/Akima spline (o polinômio do intervalo da ponta).
#include <algorithm>
#include <cmath>
#include <limits>

#include "../KernelCommon.hpp"
#include "Families.hpp"

namespace lasecsimul::simulation::library {
namespace {
using namespace detail;

enum Interp : int64_t { InterpFlat = 0, InterpNearest, InterpLinear, InterpLagrange, InterpCubic, InterpAkima, InterpCount };
enum Extrap : int64_t { ExtrapClip = 0, ExtrapLinear, ExtrapCubic, ExtrapAkima, ExtrapCount };
constexpr size_t kMaxDims = 30;
constexpr size_t kMaxTable = size_t{1} << 22;

/** Intervalo k (0..n-2) e fração f de x: bp[k] <= x < bp[k+1] dentro da faixa; acima do último
 * breakpoint k = n-2 (f >= 1); abaixo do primeiro k = 0 (f < 0). x NaN -> f NaN. */
struct Cell { size_t k; double f; };
Cell locate(const double* bp, size_t n, double x) {
    size_t k = 0;
    if (x >= bp[n - 1]) k = n - 2;
    else if (x >= bp[0]) {
        size_t lo = 0, hi = n - 1;
        while (hi - lo > 1) {
            const size_t mid = (lo + hi) / 2;
            if (bp[mid] <= x) lo = mid; else hi = mid;
        }
        k = lo;
    }
    return {k, (x - bp[k]) / (bp[k + 1] - bp[k])};
}
/** Flat ("Use Input Below"): breakpoint <= x mais alto; abaixo da faixa, o primeiro. */
size_t indexBelow(const double* bp, size_t n, double x) {
    if (x >= bp[n - 1]) return n - 1;
    if (!(x >= bp[0])) return 0;
    return locate(bp, n, x).k;
}
/** Nearest: breakpoint mais próximo, empate para o índice maior. */
size_t indexNearest(const double* bp, size_t n, double x) {
    if (x >= bp[n - 1]) return n - 1;
    if (!(x > bp[0])) return 0;
    const Cell cell = locate(bp, n, x);
    return x - bp[cell.k] >= bp[cell.k + 1] - x ? cell.k + 1 : cell.k;
}
/** Use Input Above: breakpoint >= x mais baixo; acima da faixa, o último. */
size_t indexAbove(const double* bp, size_t n, double x) {
    if (!(x > bp[0])) return 0;
    if (x >= bp[n - 1]) return n - 1;
    const Cell cell = locate(bp, n, x);
    return x == bp[cell.k] ? cell.k : cell.k + 1;
}
Cell clipCell(Cell cell) {
    if (cell.f < 0.0) cell.f = 0.0;
    else if (cell.f > 1.0) cell.f = 1.0;
    return cell;
}

inline double combine(double a, double b, double f, bool lagrange) { return lagrange ? (1.0 - f) * a + f * b : a + f * (b - a); }

/** Interpolação multilinear: percorre os 2^N cantos com uma pilha por dimensão (sem memória extra). */
double multilinear(const double* table, const size_t* strides, const Cell* cells, size_t dims, bool lagrange) {
    double pending[kMaxDims + 1];
    double result = 0.0;
    const size_t corners = size_t{1} << dims;
    for (size_t corner = 0; corner < corners; ++corner) {
        size_t offset = 0;
        for (size_t d = 0; d < dims; ++d) offset += (cells[d].k + ((corner >> d) & 1u)) * strides[d];
        double value = table[offset];
        size_t d = 0;
        while (d < dims && ((corner >> d) & 1u)) { value = combine(pending[d], value, cells[d].f, lagrange); ++d; }
        if (d < dims) pending[d] = value; else result = value;
    }
    return result;
}

// ---- Splines 1-D ----------------------------------------------------------------------------------
/** Segundas derivadas da spline cúbica natural (algoritmo tridiagonal clássico). `work` >= n. */
void naturalSpline(const double* x, const double* y, size_t n, double* y2, double* work) {
    y2[0] = 0.0;
    work[0] = 0.0;
    for (size_t i = 1; i + 1 < n; ++i) {
        const double left = x[i] - x[i - 1], right = x[i + 1] - x[i];
        const double sigma = left / (left + right);
        const double p = sigma * y2[i - 1] + 2.0;
        y2[i] = (sigma - 1.0) / p;
        const double slopes = (y[i + 1] - y[i]) / right - (y[i] - y[i - 1]) / left;
        work[i] = (6.0 * slopes / (left + right) - sigma * work[i - 1]) / p;
    }
    y2[n - 1] = 0.0;
    for (size_t k = n - 1; k > 0; --k) y2[k - 1] = y2[k - 1] * y2[k] + work[k - 1];
}
double cubicAt(const double* x, const double* y, const double* y2, size_t k, double xq) {
    const double h = x[k + 1] - x[k];
    const double b = (xq - x[k]) / h, a = 1.0 - b;
    return a * y[k] + b * y[k + 1] + ((a * a * a - a) * y2[k] + (b * b * b - b) * y2[k + 1]) * h * h / 6.0;
}
double cubicSlope(const double* x, const double* y, const double* y2, size_t k, double xq) {
    const double h = x[k + 1] - x[k];
    const double b = (xq - x[k]) / h, a = 1.0 - b;
    return (y[k + 1] - y[k]) / h - (3.0 * a * a - 1.0) / 6.0 * h * y2[k] + (3.0 * b * b - 1.0) / 6.0 * h * y2[k + 1];
}
/** Derivadas nos nós do Akima modificado (`makima`): pesos |d(i+1)-d(i)| + |d(i+1)+d(i)|/2,
 * extrapolação linear de Akima das inclinações nas pontas. `work` >= n + 3. */
void makimaSlopes(const double* x, const double* y, size_t n, double* s, double* work) {
    double* e = work;  // e[0] = d(-2), e[1] = d(-1), e[2 + j] = d(j), e[n + 1] = d(n-1), e[n + 2] = d(n)
    for (size_t j = 0; j + 1 < n; ++j) e[2 + j] = (y[j + 1] - y[j]) / (x[j + 1] - x[j]);
    if (n == 2) { s[0] = s[1] = e[2]; return; }
    e[1] = 2.0 * e[2] - e[3];
    e[0] = 2.0 * e[1] - e[2];
    e[n + 1] = 2.0 * e[n] - e[n - 1];
    e[n + 2] = 2.0 * e[n + 1] - e[n];
    for (size_t i = 0; i < n; ++i) {
        const double w1 = std::abs(e[i + 1] - e[i]) + std::abs(e[i + 1] + e[i]) / 2.0;
        const double w2 = std::abs(e[i + 3] - e[i + 2]) + std::abs(e[i + 3] + e[i + 2]) / 2.0;
        const double sum = w1 + w2;
        s[i] = sum == 0.0 ? 0.0 : (w2 * e[i + 1] + w1 * e[i + 2]) / sum;
    }
}
double hermiteAt(const double* x, const double* y, const double* s, size_t k, double xq) {
    const double h = x[k + 1] - x[k];
    const double t = (xq - x[k]) / h, u = 1.0 - t;
    return (1.0 + 2.0 * t) * u * u * y[k] + t * u * u * h * s[k] + t * t * (3.0 - 2.0 * t) * y[k + 1] - t * t * u * h * s[k + 1];
}
/** Spline 1-D (cúbica natural ou makima) em xq com a extrapolação dada. `work` >= 2n + 4. */
double spline1(const double* x, const double* y, size_t n, double xq, bool akima, int64_t extrap, double* work) {
    if (std::isnan(xq)) return xq;
    if (extrap == ExtrapClip) xq = std::clamp(xq, x[0], x[n - 1]);
    double* coefficients = work;  // y2 (cúbica) ou s (makima)
    double* scratch = work + n;
    if (akima) makimaSlopes(x, y, n, coefficients, scratch);
    else naturalSpline(x, y, n, coefficients, scratch);
    const auto value = [&](size_t k, double at) { return akima ? hermiteAt(x, y, coefficients, k, at) : cubicAt(x, y, coefficients, k, at); };
    if (extrap == ExtrapLinear && (xq < x[0] || xq > x[n - 1])) {
        const bool below = xq < x[0];
        const size_t node = below ? 0 : n - 1;
        const double slope = akima ? coefficients[node] : cubicSlope(x, y, coefficients, below ? 0 : n - 2, x[node]);
        return y[node] + slope * (xq - x[node]);
    }
    return value(locate(x, n, xq).k, xq);
}
/** Spline N-D por produto tensorial: reduz a 1a dimensão de cada linha, depois a 2a... `buffer`
 * recebe prod(n)/n[0] valores; `work` >= 2 max(n) + 4. */
double splineNd(const double* table, const size_t* n, const double* const* bp, const double* xq, size_t dims, bool akima, int64_t extrap,
                double* buffer, double* work) {
    size_t count = 1;
    for (size_t d = 0; d < dims; ++d) count *= n[d];
    const double* source = table;
    for (size_t d = 0; d < dims; ++d) {
        const size_t lines = count / n[d];
        for (size_t line = 0; line < lines; ++line) {
            const double value = spline1(bp[d], source + line * n[d], n[d], xq[d], akima, extrap, work);
            buffer[line] = value;  // seguro no próprio buffer: line <= line * n[d]
        }
        source = buffer;
        count = lines;
    }
    return buffer[0];
}

// ---- n-D Lookup Table (1-D/2-D Lookup Table são presets) -------------------------------------------
// ip = [N, interp, extrap, umaPorta, tabelaPorPorta, n_1..n_N, bpPorPorta_1..bpPorPorta_N]
// rp = [bp_1 (n_1) ... bp_N (n_N), tabela (prod n, ordem por coluna; ausente se por porta)]
// Entradas: u_1..u_N (ou uma porta u com N elementos), [T], [bp_d das dimensões por porta].
// d = rascunho das splines (prod(n)/n_1 + 2 max(n) + 4); vazio para os demais métodos.
enum NdIp { NdDims = 0, NdInterp, NdExtrap, NdSingle, NdTablePort, NdHeader };
struct NdLayout {
    size_t dims = 0;
    size_t n[kMaxDims]{};
    size_t strides[kMaxDims]{};
    bool bpPort[kMaxDims]{};
    size_t total = 1, maxN = 0, rpBreakpoints = 0, coordinatePorts = 0, bpPorts = 0;
};
NdLayout ndLayout(const int64_t* ip) {
    NdLayout layout;
    layout.dims = static_cast<size_t>(ip[NdDims]);
    for (size_t d = 0; d < layout.dims; ++d) {
        layout.n[d] = static_cast<size_t>(ip[NdHeader + d]);
        layout.bpPort[d] = ip[NdHeader + layout.dims + d] != 0;
        layout.strides[d] = layout.total;
        layout.total *= layout.n[d];
        layout.maxN = std::max(layout.maxN, layout.n[d]);
        layout.rpBreakpoints += layout.n[d];
        layout.bpPorts += layout.bpPort[d] ? 1 : 0;
    }
    layout.coordinatePorts = ip[NdSingle] != 0 ? 1 : layout.dims;
    return layout;
}
size_t ndScratch(const NdLayout& layout, int64_t interp) {
    return interp == InterpCubic || interp == InterpAkima ? layout.total / layout.n[0] + 2 * layout.maxN + 4 : 0;
}
KernelShape lookupNdConfigure(const KernelConfig& c) {
    const auto& ip = c.intParameters;
    if (ip.size() < NdHeader || ip[NdDims] < 1 || static_cast<size_t>(ip[NdDims]) > kMaxDims ||
        ip.size() != NdHeader + 2 * static_cast<size_t>(ip[NdDims]))
        fail("n-D Lookup Table: parametros internos invalidos");
    if (ip[NdInterp] < 0 || ip[NdInterp] >= InterpCount || ip[NdExtrap] < 0 || ip[NdExtrap] >= ExtrapCount)
        fail("n-D Lookup Table: metodo invalido");
    const NdLayout layout = ndLayout(ip.data());
    for (size_t d = 0; d < layout.dims; ++d) if (layout.n[d] < 2) fail("n-D Lookup Table: cada dimensao precisa de 2 ou mais breakpoints");
    if (layout.total > kMaxTable) fail("n-D Lookup Table: tabela grande demais");
    const bool tablePort = ip[NdTablePort] != 0;
    const size_t inputs = layout.coordinatePorts + (tablePort ? 1 : 0) + layout.bpPorts;
    requireInputs(c, inputs, "n-D Lookup Table");
    if (c.realParameters.size() != layout.rpBreakpoints + (tablePort ? 0 : layout.total)) fail("n-D Lookup Table: tabela/breakpoints com tamanho incompativel");
    if (ip[NdSingle] != 0) {
        if (c.inputWidths[0] != layout.dims || c.outputWidth != 1)
            fail("n-D Lookup Table: a porta unica precisa ter largura " + std::to_string(layout.dims));
    } else {
        for (size_t port = 0; port < layout.dims; ++port)
            if (c.inputWidths[port] != 1 && c.inputWidths[port] != c.outputWidth) fail("n-D Lookup Table: largura de entrada incompativel");
    }
    size_t port = layout.coordinatePorts;
    if (tablePort && c.inputWidths[port++] != layout.total) fail("n-D Lookup Table: largura da porta T difere do tamanho da tabela");
    for (size_t d = 0; d < layout.dims; ++d)
        if (layout.bpPort[d] && c.inputWidths[port++] != layout.n[d]) fail("n-D Lookup Table: largura da porta de breakpoints incompativel");
    if (ip[NdInterp] == InterpCubic && c.outputWidth != 1) fail("n-D Lookup Table: Cubic spline so aceita sinais escalares (largura 1)");
    return {0, static_cast<uint32_t>(ndScratch(layout, ip[NdInterp])), allFeedthrough(inputs)};
}
void lookupNdOutputs(KernelContext& k) {
    const NdLayout layout = ndLayout(k.ip);
    const int64_t interp = k.ip[NdInterp], extrap = k.ip[NdExtrap];
    const bool single = k.ip[NdSingle] != 0, tablePort = k.ip[NdTablePort] != 0;
    const double* bp[kMaxDims];
    size_t port = layout.coordinatePorts + (tablePort ? 1 : 0), offset = 0;
    for (size_t d = 0; d < layout.dims; ++d) {
        bp[d] = layout.bpPort[d] ? k.in[port++] : k.rp + offset;
        offset += layout.n[d];
    }
    const double* table = tablePort ? k.in[layout.coordinatePorts] : k.rp + layout.rpBreakpoints;
    double x[kMaxDims];
    Cell cells[kMaxDims];
    for (uint16_t e = 0; e < k.outWidth; ++e) {
        bool nan = false;
        for (size_t d = 0; d < layout.dims; ++d) {
            x[d] = single ? k.in[0][d] : k.input(static_cast<uint16_t>(d), e);
            nan = nan || std::isnan(x[d]);
        }
        if (nan) { k.out[e] = std::numeric_limits<double>::quiet_NaN(); continue; }
        if (interp == InterpFlat || interp == InterpNearest) {
            size_t index = 0;
            for (size_t d = 0; d < layout.dims; ++d)
                index += (interp == InterpFlat ? indexBelow(bp[d], layout.n[d], x[d]) : indexNearest(bp[d], layout.n[d], x[d])) * layout.strides[d];
            k.out[e] = table[index];
        } else if (interp == InterpLinear || interp == InterpLagrange) {
            for (size_t d = 0; d < layout.dims; ++d) {
                cells[d] = locate(bp[d], layout.n[d], x[d]);
                if (extrap == ExtrapClip) cells[d] = clipCell(cells[d]);
            }
            k.out[e] = multilinear(table, layout.strides, cells, layout.dims, interp == InterpLagrange);
        } else {
            const size_t buffer = layout.total / layout.n[0];
            k.out[e] = splineNd(table, layout.n, bp, x, layout.dims, interp == InterpAkima, extrap, k.d, k.d + buffer);
        }
    }
}

// ---- Prelookup: ip = [extrapLinear, useLastBreakpoint, apenasIndice, bpPorPorta, n]; rp = bp (n).
// Saída [k x w | f x w] (k de base zero, como `double`) ou só [k x w]. Dentro da faixa
// bp(k) <= u < bp(k+1), f = (u - bp(k)) / (bp(k+1) - bp(k)). Clip: abaixo k = 0, f = 0; no último
// breakpoint ou acima k = n-2, f = 1 (ou k = n-1, f = 0 com UseLastBreakpoint). Linear: f < 0 ou
// f > 1 a partir do primeiro/último intervalo.
enum PreIp { PreLinear = 0, PreUseLast, PreIndexOnly, PreBpPort, PreN, PreIpCount };
KernelShape prelookupConfigure(const KernelConfig& c) {
    if (c.intParameters.size() != PreIpCount || c.intParameters[PreN] < 2) fail("Prelookup: parametros internos invalidos");
    const auto n = static_cast<size_t>(c.intParameters[PreN]);
    const bool bpPort = c.intParameters[PreBpPort] != 0;
    requireInputs(c, bpPort ? 2 : 1, "Prelookup");
    if (c.realParameters.size() != n || (bpPort && c.inputWidths[1] != n)) fail("Prelookup: breakpoints com tamanho incompativel");
    const size_t width = c.inputWidths[0];
    if (c.outputWidth != (c.intParameters[PreIndexOnly] != 0 ? width : 2 * width)) fail("Prelookup: largura de saida incompativel");
    return {0, 0, allFeedthrough(bpPort ? 2 : 1)};
}
void prelookupOutputs(KernelContext& k) {
    const auto n = static_cast<size_t>(k.ip[PreN]);
    const bool linear = k.ip[PreLinear] != 0, useLast = k.ip[PreUseLast] != 0, indexOnly = k.ip[PreIndexOnly] != 0;
    const double* bp = k.ip[PreBpPort] != 0 ? k.in[1] : k.rp;
    const uint16_t width = k.inWidth[0];
    for (uint16_t e = 0; e < width; ++e) {
        const double u = k.in[0][e];
        Cell cell = locate(bp, n, u);
        if (!linear) {
            if (u >= bp[n - 1] && useLast) cell = {n - 1, 0.0};
            else cell = clipCell(cell);
        }
        k.out[e] = static_cast<double>(cell.k);
        if (!indexOnly) k.out[width + e] = cell.f;
    }
}

// ---- Interpolation Using Prelookup: ip = [N, interp, extrapLinear, tabelaPorPorta, n_1..n_N];
// rp = tabela (prod n, ordem por coluna; ausente se por porta). Entradas k1, f1, ..., kN, fN, [T].
// k é truncado para [0, n-1]; k = n-1 (índice que alcança o último, ValidIndexMayReachLast) vira
// k = n-2 com f + 1. Clip limita f a [0, 1]. Flat usa só k; Nearest usa k+1 quando f >= 0,5.
enum IupIp { IupDims = 0, IupInterp, IupLinear, IupTablePort, IupHeader };
KernelShape interpolationConfigure(const KernelConfig& c) {
    const auto& ip = c.intParameters;
    if (ip.size() < IupHeader || ip[IupDims] < 1 || static_cast<size_t>(ip[IupDims]) > kMaxDims ||
        ip.size() != IupHeader + static_cast<size_t>(ip[IupDims]))
        fail("Interpolation Using Prelookup: parametros internos invalidos");
    if (ip[IupInterp] < InterpFlat || ip[IupInterp] > InterpLagrange) fail("Interpolation Using Prelookup: metodo invalido");
    const auto dims = static_cast<size_t>(ip[IupDims]);
    size_t total = 1;
    for (size_t d = 0; d < dims; ++d) {
        if (ip[IupHeader + d] < 2) fail("Interpolation Using Prelookup: cada dimensao precisa de 2 ou mais pontos");
        total *= static_cast<size_t>(ip[IupHeader + d]);
        if (total > kMaxTable) fail("Interpolation Using Prelookup: tabela grande demais");
    }
    const bool tablePort = ip[IupTablePort] != 0;
    requireInputs(c, 2 * dims + (tablePort ? 1 : 0), "Interpolation Using Prelookup");
    for (size_t port = 0; port < 2 * dims; ++port)
        if (c.inputWidths[port] != 1 && c.inputWidths[port] != c.outputWidth) fail("Interpolation Using Prelookup: largura de entrada incompativel");
    if (tablePort ? c.inputWidths[2 * dims] != total : c.realParameters.size() != total) fail("Interpolation Using Prelookup: tabela com tamanho incompativel");
    return {0, 0, allFeedthrough(2 * dims + (tablePort ? 1 : 0))};
}
void interpolationOutputs(KernelContext& k) {
    const auto dims = static_cast<size_t>(k.ip[IupDims]);
    const int64_t interp = k.ip[IupInterp];
    const bool linearExtrap = k.ip[IupLinear] != 0;
    const double* table = k.ip[IupTablePort] != 0 ? k.in[2 * dims] : k.rp;
    size_t n[kMaxDims], strides[kMaxDims], stride = 1;
    for (size_t d = 0; d < dims; ++d) { n[d] = static_cast<size_t>(k.ip[IupHeader + d]); strides[d] = stride; stride *= n[d]; }
    Cell cells[kMaxDims];
    for (uint16_t e = 0; e < k.outWidth; ++e) {
        size_t index = 0;
        for (size_t d = 0; d < dims; ++d) {
            const double kIn = k.input(static_cast<uint16_t>(2 * d), e), f = k.input(static_cast<uint16_t>(2 * d + 1), e);
            const double clamped = std::isnan(kIn) ? 0.0 : std::clamp(std::floor(kIn), 0.0, static_cast<double>(n[d] - 1));
            const auto i = static_cast<size_t>(clamped);
            if (interp == InterpFlat) { index += i * strides[d]; continue; }
            if (interp == InterpNearest) { index += std::min(f >= 0.5 ? i + 1 : i, n[d] - 1) * strides[d]; continue; }
            Cell cell = i == n[d] - 1 ? Cell{n[d] - 2, f + 1.0} : Cell{i, f};
            cells[d] = linearExtrap ? cell : clipCell(cell);
        }
        k.out[e] = interp == InterpFlat || interp == InterpNearest ? table[index] : multilinear(table, strides, cells, dims, interp == InterpLagrange);
    }
}

// ---- Direct Lookup Table (n-D): ip = [N, modo (0 Element, 1 Vector, 2 2-D Matrix), tabelaPorPorta,
// n_1..n_N]; rp = tabela (ordem por coluna). Entradas: índices de base zero (N - modo portas; a
// primeira indexa a dimensão modo+1) e [T]. Element: y = T(i1+1, ..., iN+1); Vector: y = T(:, i...);
// 2-D Matrix: y = T(:, :, i...) achatada por coluna. Índice fora da faixa é limitado à tabela; índice
// fracionário é truncado (conversão para inteiro).
enum DirIp { DirDims = 0, DirMode, DirTablePort, DirHeader };
KernelShape directConfigure(const KernelConfig& c) {
    const auto& ip = c.intParameters;
    if (ip.size() < DirHeader || ip[DirDims] < 1 || static_cast<size_t>(ip[DirDims]) > kMaxDims ||
        ip.size() != DirHeader + static_cast<size_t>(ip[DirDims]) || ip[DirMode] < 0 || ip[DirMode] > 2 || ip[DirMode] > ip[DirDims])
        fail("Direct Lookup Table (n-D): parametros internos invalidos");
    const auto dims = static_cast<size_t>(ip[DirDims]), mode = static_cast<size_t>(ip[DirMode]);
    size_t total = 1;
    for (size_t d = 0; d < dims; ++d) {
        if (ip[DirHeader + d] < 1) fail("Direct Lookup Table (n-D): dimensao vazia");
        total *= static_cast<size_t>(ip[DirHeader + d]);
        if (total > kMaxTable) fail("Direct Lookup Table (n-D): tabela grande demais");
    }
    const bool tablePort = ip[DirTablePort] != 0;
    const size_t indices = dims - mode;
    requireInputs(c, indices + (tablePort ? 1 : 0), "Direct Lookup Table (n-D)");
    if (tablePort ? c.inputWidths[indices] != total : c.realParameters.size() != total) fail("Direct Lookup Table (n-D): tabela com tamanho incompativel");
    if (mode == 0) {
        for (size_t port = 0; port < indices; ++port)
            if (c.inputWidths[port] != 1 && c.inputWidths[port] != c.outputWidth) fail("Direct Lookup Table (n-D): largura de indice incompativel");
    } else {
        for (size_t port = 0; port < indices; ++port)
            if (c.inputWidths[port] != 1) fail("Direct Lookup Table (n-D): indices precisam ser escalares (largura 1) ao selecionar vetor/matriz");
        const size_t expected = mode == 1 ? static_cast<size_t>(ip[DirHeader]) : static_cast<size_t>(ip[DirHeader] * ip[DirHeader + 1]);
        if (c.outputWidth != expected) fail("Direct Lookup Table (n-D): largura de saida incompativel");
    }
    return {0, 0, allFeedthrough(indices + (tablePort ? 1 : 0))};
}
size_t directIndex(double u, size_t n) {
    if (std::isnan(u) || u <= 0.0) return 0;
    const double clamped = std::min(std::trunc(u), static_cast<double>(n - 1));
    return static_cast<size_t>(clamped);
}
void directOutputs(KernelContext& k) {
    const auto dims = static_cast<size_t>(k.ip[DirDims]), mode = static_cast<size_t>(k.ip[DirMode]);
    const size_t indices = dims - mode;
    const double* table = k.ip[DirTablePort] != 0 ? k.in[indices] : k.rp;
    size_t n[kMaxDims], strides[kMaxDims], stride = 1;
    for (size_t d = 0; d < dims; ++d) { n[d] = static_cast<size_t>(k.ip[DirHeader + d]); strides[d] = stride; stride *= n[d]; }
    if (mode == 0) {
        for (uint16_t e = 0; e < k.outWidth; ++e) {
            size_t offset = 0;
            for (size_t d = 0; d < dims; ++d) offset += directIndex(k.input(static_cast<uint16_t>(d), e), n[d]) * strides[d];
            k.out[e] = table[offset];
        }
        return;
    }
    size_t base = 0;
    for (size_t port = 0; port < indices; ++port) base += directIndex(k.in[port][0], n[port + mode]) * strides[port + mode];
    for (uint16_t e = 0; e < k.outWidth; ++e) k.out[e] = table[base + e];
}

// ---- Lookup Table Dynamic: ip = [método]; entradas x (w), xdat (n), ydat (n). Métodos:
// 0 Interpolation-Extrapolation, 1 Interpolation-Use End Values, 2 Use Input Nearest, 3 Use Input
// Below, 4 Use Input Above (sem breakpoint abaixo/acima: o mais próximo). xdat estritamente crescente
// é responsabilidade do sinal (o Simulink também só verifica em execução).
KernelShape dynamicConfigure(const KernelConfig& c) {
    requireInputs(c, 3, "Lookup Table Dynamic");
    if (c.intParameters.size() != 1 || c.intParameters[0] < 0 || c.intParameters[0] > 4) fail("Lookup Table Dynamic: metodo invalido");
    if (c.inputWidths[1] < 2 || c.inputWidths[1] != c.inputWidths[2])
        fail("Lookup Table Dynamic: xdat e ydat precisam ter a mesma largura, >= 2");
    if (c.outputWidth != c.inputWidths[0]) fail("Lookup Table Dynamic: largura de saida incompativel");
    return {0, 0, {1, 1, 1}};
}
void dynamicOutputs(KernelContext& k) {
    const size_t n = k.inWidth[1];
    const double* xdat = k.in[1];
    const double* ydat = k.in[2];
    for (uint16_t e = 0; e < k.outWidth; ++e) {
        const double x = k.in[0][e];
        if (std::isnan(x)) { k.out[e] = x; continue; }
        switch (k.ip[0]) {
        case 0:
        case 1: {
            Cell cell = locate(xdat, n, x);
            if (k.ip[0] == 1) cell = clipCell(cell);
            k.out[e] = ydat[cell.k] + cell.f * (ydat[cell.k + 1] - ydat[cell.k]);
            break;
        }
        case 2: k.out[e] = ydat[indexNearest(xdat, n, x)]; break;
        case 3: k.out[e] = ydat[indexBelow(xdat, n, x)]; break;
        default: k.out[e] = ydat[indexAbove(xdat, n, x)]; break;
        }
    }
}

const KernelSpec kLookupNd{"lookup_nd", lookupNdConfigure, nullptr, lookupNdOutputs, nullptr, nullptr, nullptr};
const KernelSpec kPrelookup{"prelookup", prelookupConfigure, nullptr, prelookupOutputs, nullptr, nullptr, nullptr};
const KernelSpec kInterpolation{"interpolation_prelookup", interpolationConfigure, nullptr, interpolationOutputs, nullptr, nullptr, nullptr};
const KernelSpec kDirect{"direct_lookup_nd", directConfigure, nullptr, directOutputs, nullptr, nullptr, nullptr};
const KernelSpec kDynamic{"lookup_table_dynamic", dynamicConfigure, nullptr, dynamicOutputs, nullptr, nullptr, nullptr};

const KernelSpec* const kLookup[] = {&kLookupNd, &kPrelookup, &kInterpolation, &kDirect, &kDynamic};
} // namespace

std::span<const KernelSpec* const> lookupKernels() { return kLookup; }

} // namespace lasecsimul::simulation::library
