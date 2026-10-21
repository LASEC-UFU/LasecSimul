// Continuous: parâmetros oficiais -> kernels de `simulation/library/kernels/ContinuousKernels.cpp`.
// Transfer Fcn e Zero-Pole viram a realização canônica controlável (a mesma de `tf2ss` do MATLAB)
// executada pelo kernel `state_space`; com estado inicial nulo, como na documentação. Descriptor
// State-Space é reduzido a um State-Space explícito (E não singular ou sistema de índice 1).
#include <complex>
#include <limits>

#include <Eigen/Dense>

#include "BuilderCommon.hpp"

namespace lasecsimul::components::blocks::builders {

Realization controllableCanonical(const BuildContext& c, const std::vector<std::vector<double>>& numerators,
                                  std::vector<double> denominator) {
    while (!denominator.empty() && denominator.front() == 0.0) denominator.erase(denominator.begin());
    if (denominator.empty()) c.fail("denominador nulo");
    for (double value : denominator) if (!std::isfinite(value)) c.fail("denominador com valor nao finito");
    const double leading = denominator.front();
    for (double& value : denominator) value /= leading;
    Realization r;
    r.n = denominator.size() - 1;
    r.outputs = numerators.size();
    r.a.assign(r.n * r.n, 0.0);
    for (size_t j = 0; j < r.n; ++j) r.a[j] = -denominator[j + 1];
    for (size_t i = 1; i < r.n; ++i) r.a[i * r.n + (i - 1)] = 1.0;
    r.b.assign(r.n, 0.0);
    if (r.n > 0) r.b[0] = 1.0;
    for (const std::vector<double>& rawNumerator : numerators) {
        std::vector<double> numerator = rawNumerator;
        while (numerator.size() > 1 && numerator.front() == 0.0 && numerator.size() > denominator.size()) numerator.erase(numerator.begin());
        if (numerator.size() > denominator.size()) c.fail("funcao de transferencia impropria (grau do numerador maior que o do denominador)");
        for (double value : numerator) if (!std::isfinite(value)) c.fail("numerador com valor nao finito");
        std::vector<double> padded(denominator.size() - numerator.size(), 0.0);
        for (double value : numerator) padded.push_back(value / leading);
        const double b0 = padded[0];
        for (size_t j = 0; j < r.n; ++j) r.c.push_back(padded[j + 1] - b0 * denominator[j + 1]);
        r.d.push_back(b0);
    }
    return r;
}

/** Kernel com várias saídas: vetor concatenado `<saída1>::v` e um Slice por porta de saída. */
void emitWithSlices(BuildContext& c, const char* kernelId, std::vector<uint16_t> inputs, std::vector<uint16_t> portWidths,
                    std::vector<double> rp, std::vector<int64_t> ip) {
    c.outputWidths = portWidths;
    if (c.widthsOnly) return;
    if (portWidths.size() == 1) {
        c.kernel("", kernelId, std::move(inputs), portWidths[0], std::move(rp), std::move(ip));
        c.connectInputs(c.outputBlock(0));
        return;
    }
    uint16_t total = 0;
    for (uint16_t w : portWidths) total = static_cast<uint16_t>(total + w);
    const std::string vector = c.outputBlock(0) + "::v";
    c.kernel(vector, kernelId, std::move(inputs), total, std::move(rp), std::move(ip));
    c.connectInputs(vector);
    int64_t offset = 0;
    for (size_t port = 0; port < portWidths.size(); ++port) {
        c.kernel(c.outputBlock(port), "slice", {total}, portWidths[port], {}, {offset});
        c.connect(vector, c.outputBlock(port), 1);
        offset += portWidths[port];
    }
}

int64_t resetMode(const std::string& mode) {
    if (mode == "rising" || mode == "Rising") return 1;
    if (mode == "falling" || mode == "Falling") return 2;
    if (mode == "either" || mode == "Either") return 3;
    if (mode == "level" || mode == "Level") return 4;
    if (mode == "level hold" || mode == "Level hold") return 5;
    return 0;
}

/** A, B, C, D (+ x0) -> layout do kernel `state_space`/`discrete_state_space`. B e D vazios fazem um
 * sistema autônomo (dx/dt = Ax, y = Cx, documentado): a entrada é aceita e não tem efeito. */
void buildStateSpaceKernel(BuildContext& c, const char* kernelId) {
    const lib::ParamValue a = c.value("A"), b = c.value("B"), cm = c.value("C"), d = c.value("D");
    const size_t n = a.rows;
    if (a.rows != a.cols) c.fail("A precisa ser quadrada");
    const bool autonomous = b.empty() && d.empty() && n > 0;
    const size_t m = autonomous ? 1 : b.empty() ? (d.empty() ? 1 : d.cols) : b.cols;
    const size_t p = cm.empty() ? (d.empty() ? 1 : d.rows) : cm.rows;
    if (!b.empty() && b.rows != n) c.fail("B precisa ter o mesmo numero de linhas de A");
    if (!cm.empty() && cm.cols != n) c.fail("C precisa ter o mesmo numero de colunas de A");
    if (n > 0 && ((b.empty() && !autonomous) || cm.empty())) c.fail("B e C sao obrigatorios quando A nao e vazia");
    const std::vector<double> bValues = autonomous ? std::vector<double>(n, 0.0) : b.data;
    std::vector<double> dValues;
    if (d.empty() || (d.isScalar() && d.data[0] == 0.0 && p * m > 1)) dValues.assign(p * m, 0.0);
    else if (d.rows == p && d.cols == m) dValues = d.data;
    else c.fail("D com dimensoes incompativeis com B e C");
    const std::vector<double> x0 = n == 0 ? std::vector<double>{} : expandTo(c, c.value("InitialCondition").linear(), n, "Initial conditions");
    for (double value : x0) if (!std::isfinite(value)) c.fail("Initial conditions nao podem ser Inf ou NaN");
    std::vector<double> rp = a.data;
    rp.insert(rp.end(), bValues.begin(), bValues.end());
    rp.insert(rp.end(), cm.data.begin(), cm.data.end());
    rp.insert(rp.end(), dValues.begin(), dValues.end());
    rp.insert(rp.end(), x0.begin(), x0.end());
    if (!autonomous && c.inputWidth(0) != m && !(m == 1 && c.inputWidth(0) == 1))
        c.fail("largura da entrada (" + std::to_string(c.inputWidth(0)) + ") difere do numero de colunas de B/D (" + std::to_string(m) + ")");
    c.outputWidths = {static_cast<uint16_t>(p)};
    if (c.widthsOnly) return;
    const std::vector<int64_t> ip{static_cast<int64_t>(n), static_cast<int64_t>(m), static_cast<int64_t>(p)};
    if (autonomous && c.inputWidth(0) != 1) {
        // Autônomo com entrada vetorial: a coluna nula de B lê só o primeiro elemento (sem efeito).
        const std::string first = c.outputBlock(0) + "::u1";
        c.kernel(first, "slice", {c.inputWidth(0)}, 1, {}, {0});
        c.connectInputs(first);
        c.kernel("", kernelId, {1}, static_cast<uint16_t>(p), rp, ip);
        c.connect(first, c.outputBlock(0), 1);
        return;
    }
    c.kernel("", kernelId, {c.inputWidth(0)}, static_cast<uint16_t>(p), rp, ip);
    c.connectInputs(c.outputBlock(0));
}

void emitRealization(BuildContext& c, const Realization& r, const char* kernelId, const std::vector<double>& x0) {
    std::vector<double> rp = r.a;
    rp.insert(rp.end(), r.b.begin(), r.b.end());
    rp.insert(rp.end(), r.c.begin(), r.c.end());
    rp.insert(rp.end(), r.d.begin(), r.d.end());
    rp.insert(rp.end(), x0.begin(), x0.end());
    if (c.inputWidth(0) != 1) c.fail("funcao de transferencia exige entrada escalar");
    simpleKernel(c, kernelId, static_cast<uint16_t>(r.outputs), rp, {static_cast<int64_t>(r.n), 1, static_cast<int64_t>(r.outputs)});
}

std::vector<std::vector<double>> numeratorRows(const lib::ParamValue& numerator) {
    std::vector<std::vector<double>> rows;
    if (numerator.rows <= 1) { rows.push_back(numerator.data); return rows; }
    for (size_t r = 0; r < numerator.rows; ++r)
        rows.emplace_back(numerator.data.begin() + static_cast<std::ptrdiff_t>(r * numerator.cols),
                          numerator.data.begin() + static_cast<std::ptrdiff_t>((r + 1) * numerator.cols));
    return rows;
}

std::vector<double> polyFromRoots(const std::vector<double>& roots) {
    std::vector<double> p{1.0};
    for (double root : roots) {
        std::vector<double> next(p.size() + 1, 0.0);
        for (size_t i = 0; i < p.size(); ++i) { next[i] += p[i]; next[i + 1] -= root * p[i]; }
        p = next;
    }
    return p;
}

// ---- Zeros e polos complexos (Zero-Pole e Discrete Zero-Pole) -------------------------------------
// O avaliador de parâmetros (`ParamExpr`) hoje é só real. Para que pares complexos conjugados
// funcionem sem mexer aqui quando ele aceitar literais complexos (`1i`, `2-3j`), as partes
// imaginárias são lidas de um membro `imag` de `ParamValue` SE ele existir (mesmo layout de `data`,
// ordem de linha; vazio = valor real). Enquanto não existir, todas as raízes são reais.
template <typename Value>
std::vector<double> imaginaryLinear(const Value& value) {
    if constexpr (requires(const Value& v) { v.imag; }) {
        if (value.imag.size() != value.data.size()) return std::vector<double>(value.data.size(), 0.0);
        std::vector<double> result;
        result.reserve(value.imag.size());
        for (size_t col = 0; col < value.cols; ++col)
            for (size_t row = 0; row < value.rows; ++row) result.push_back(value.imag[row * value.cols + col]);
        return result;
    } else {
        return std::vector<double>(value.data.size(), 0.0);
    }
}

/** Elementos em ordem linear do MATLAB (por coluna), com parte imaginária quando houver. */
std::vector<std::complex<double>> complexLinear(const lib::ParamValue& value) {
    const std::vector<double> re = value.linear();
    const std::vector<double> im = imaginaryLinear(value);
    std::vector<std::complex<double>> result(re.size());
    for (size_t i = 0; i < re.size(); ++i) result[i] = {re[i], i < im.size() ? im[i] : 0.0};
    return result;
}

/** Polinômio real com as raízes dadas; raízes complexas precisam vir em pares conjugados. */
std::vector<double> polyFromComplexRoots(const BuildContext& c, const std::vector<std::complex<double>>& roots, const char* what) {
    std::vector<bool> used(roots.size(), false);
    for (size_t i = 0; i < roots.size(); ++i) {
        if (!std::isfinite(roots[i].real()) || !std::isfinite(roots[i].imag())) c.fail(std::string(what) + ": valor nao finito");
        if (used[i] || roots[i].imag() == 0.0) continue;
        bool paired = false;
        for (size_t j = i + 1; j < roots.size() && !paired; ++j) {
            if (used[j]) continue;
            const double scale = std::max(1.0, std::abs(roots[i]));
            if (std::abs(roots[j] - std::conj(roots[i])) <= 1e-12 * scale) used[i] = used[j] = paired = true;
        }
        if (!paired) c.fail(std::string(what) + ": polos e zeros complexos devem vir em pares conjugados");
    }
    std::vector<std::complex<double>> p{1.0};
    for (const std::complex<double>& root : roots) {
        std::vector<std::complex<double>> next(p.size() + 1, 0.0);
        for (size_t i = 0; i < p.size(); ++i) { next[i] += p[i]; next[i + 1] -= root * p[i]; }
        p = next;
    }
    std::vector<double> real(p.size());
    for (size_t i = 0; i < p.size(); ++i) real[i] = p[i].real();
    return real;
}

/** Zero-Pole (contínuo e discreto): numeradores (um por saída = coluna de Zeros) e denominador. */
struct ZeroPoleModel { std::vector<std::vector<double>> numerators; std::vector<double> denominator; };

ZeroPoleModel zeroPoleModel(const BuildContext& c) {
    const lib::ParamValue zeros = c.value("Zeros");
    const lib::ParamValue poles = c.value("Poles");
    const std::vector<double> gains = c.value("Gain").linear();
    if (gains.empty()) c.fail("Gain vazio");
    for (double gain : gains) if (!std::isfinite(gain)) c.fail("Gain deve ser finito");
    if (!poles.isVector()) c.fail("Poles precisa ser vetor");
    const std::vector<std::complex<double>> zeroValues = complexLinear(zeros);
    // Zeros: uma COLUNA por saída ("Matrix of zeros"); vetor com um ganho só = uma saída.
    std::vector<std::vector<std::complex<double>>> columns;
    if (gains.size() == 1) {
        if (!zeros.empty() && !zeros.isVector()) c.fail("Zeros: uma coluna por saida (numero de colunas = numero de elementos de Gain)");
        columns.push_back(zeroValues);
    } else if (zeros.empty()) {
        columns.assign(gains.size(), {});
    } else {
        if (zeros.cols != gains.size()) c.fail("Zeros precisa ter uma coluna por elemento de Gain");
        for (size_t col = 0; col < zeros.cols; ++col)
            columns.emplace_back(zeroValues.begin() + static_cast<std::ptrdiff_t>(col * zeros.rows),
                                 zeroValues.begin() + static_cast<std::ptrdiff_t>((col + 1) * zeros.rows));
    }
    ZeroPoleModel model;
    model.denominator = polyFromComplexRoots(c, complexLinear(poles), "Poles");
    for (size_t output = 0; output < columns.size(); ++output) {
        if (columns[output].size() > model.denominator.size() - 1) c.fail("o numero de zeros nao pode exceder o numero de polos");
        std::vector<double> numerator = polyFromComplexRoots(c, columns[output], "Zeros");
        for (double& value : numerator) value *= gains[output];
        model.numerators.push_back(std::move(numerator));
    }
    return model;
}

namespace {

void requireFinite(const BuildContext& c, const std::vector<double>& values, const char* what) {
    for (double value : values) if (!std::isfinite(value)) c.fail(std::string(what) + " nao pode ser Inf ou NaN");
}

void buildIntegrator(BuildContext& c) {
    const bool external = c.text("InitialConditionSource") == "external";
    const std::vector<double> ic = external ? std::vector<double>{0.0} : c.value("InitialCondition").linear();
    if (ic.empty()) c.fail("Initial condition vazia");
    const bool limit = c.flag("LimitOutput");
    const bool wrap = c.flag("WrapState");
    const std::vector<double> upperRaw = limit ? c.value("UpperSaturationLimit").linear() : std::vector<double>{INFINITY};
    const std::vector<double> lowerRaw = limit ? c.value("LowerSaturationLimit").linear() : std::vector<double>{-INFINITY};
    const std::vector<double> wrapUpperRaw = wrap ? c.value("WrappedStateUpperValue").linear() : std::vector<double>{INFINITY};
    const std::vector<double> wrapLowerRaw = wrap ? c.value("WrappedStateLowerValue").linear() : std::vector<double>{-INFINITY};
    size_t n = std::max<size_t>(c.inputWidth(0), ic.size());
    for (const auto* values : {&upperRaw, &lowerRaw, &wrapUpperRaw, &wrapLowerRaw}) {
        if (values->empty()) c.fail("limite vazio");
        n = std::max(n, values->size());
    }
    if (external) n = std::max<size_t>(n, c.inputWidth(c.inputPorts.size() - 1));
    if (n > 4096) c.fail("largura de sinal grande demais");
    const bool showSat = limit && c.flag("ShowSaturationPort");
    const bool showState = c.flag("ShowStatePort");
    std::vector<double> rp = expandTo(c, ic, n, "Initial condition");
    requireFinite(c, rp, "Initial condition");
    const std::vector<double> upper = expandTo(c, upperRaw, n, "Upper saturation limit");
    const std::vector<double> lower = expandTo(c, lowerRaw, n, "Lower saturation limit");
    rp.insert(rp.end(), upper.begin(), upper.end());
    rp.insert(rp.end(), lower.begin(), lower.end());
    const std::vector<double> wrapUpper = expandTo(c, wrapUpperRaw, n, "Wrapped state upper value");
    const std::vector<double> wrapLower = expandTo(c, wrapLowerRaw, n, "Wrapped state lower value");
    if (wrap)
        for (size_t i = 0; i < n; ++i)
            if (!(wrapUpper[i] > wrapLower[i])) c.fail("Wrapped state upper value deve ser maior que Wrapped state lower value");
    if (wrapUpperRaw.size() == 1 && wrapLowerRaw.size() == 1) {
        rp.push_back(wrapUpperRaw[0]);
        rp.push_back(wrapLowerRaw[0]);
    } else {
        rp.insert(rp.end(), wrapUpper.begin(), wrapUpper.end());
        rp.insert(rp.end(), wrapLower.begin(), wrapLower.end());
    }
    std::vector<uint16_t> ports{static_cast<uint16_t>(n)};
    if (showSat) ports.push_back(static_cast<uint16_t>(n));
    if (showState) ports.push_back(static_cast<uint16_t>(n));
    emitWithSlices(c, "integrator", inputWidths(c), ports, rp,
                   {static_cast<int64_t>(n), limit ? 1 : 0, resetMode(c.text("ExternalReset")), external ? 1 : 0, wrap ? 1 : 0,
                    showSat ? 1 : 0, showState ? 1 : 0});
}

void buildSecondOrderIntegrator(BuildContext& c) {
    const bool icX = c.text("ICSourceX") == "external", icDX = c.text("ICSourceDXDT") == "external";
    const bool limitX = c.flag("LimitX"), limitDX = c.flag("LimitDXDT"), wrap = c.flag("WrapX");
    const std::string show = c.text("ShowOutput");
    const bool showX = show != "dxdt", showDX = show != "x";
    const std::string reset = c.text("ExternalReset");
    if (reset != "none" && reset != "rising" && reset != "falling" && reset != "either") c.fail("External reset invalido: " + reset);
    const std::vector<std::vector<double>> blocks{
        icX ? std::vector<double>{0.0} : c.value("ICX").linear(),
        icDX ? std::vector<double>{0.0} : c.value("ICDXDT").linear(),
        limitX ? c.value("UpperLimitX").linear() : std::vector<double>{INFINITY},
        limitX ? c.value("LowerLimitX").linear() : std::vector<double>{-INFINITY},
        limitDX ? c.value("UpperLimitDXDT").linear() : std::vector<double>{INFINITY},
        limitDX ? c.value("LowerLimitDXDT").linear() : std::vector<double>{-INFINITY},
        wrap ? c.value("WrappedUpperValueX").linear() : std::vector<double>{INFINITY},
        wrap ? c.value("WrappedLowerValueX").linear() : std::vector<double>{-INFINITY},
    };
    static const char* const kNames[] = {"Initial condition x", "Initial condition dx/dt", "Upper limit x", "Lower limit x",
                                         "Upper limit dx/dt", "Lower limit dx/dt", "Wrapped upper value x", "Wrapped lower value x"};
    size_t n = 1;
    for (size_t port = 0; port < c.inputPorts.size(); ++port) if (c.inputPorts[port] != "reset") n = std::max<size_t>(n, c.inputWidth(port));
    for (const auto& values : blocks) {
        if (values.empty()) c.fail("parametro vazio");
        n = std::max(n, values.size());
    }
    if (n > 4096) c.fail("largura de sinal grande demais");
    std::vector<double> rp;
    for (size_t block = 0; block < blocks.size(); ++block) {
        const std::vector<double> values = expandTo(c, blocks[block], n, kNames[block]);
        if (block < 2) requireFinite(c, values, kNames[block]);
        rp.insert(rp.end(), values.begin(), values.end());
    }
    if (wrap)
        for (size_t i = 0; i < n; ++i)
            if (!(rp[6 * n + i] > rp[7 * n + i])) c.fail("Wrapped upper value x deve ser maior que Wrapped lower value x");
    std::vector<uint16_t> ports;
    if (showX) ports.push_back(static_cast<uint16_t>(n));
    if (showDX) ports.push_back(static_cast<uint16_t>(n));
    emitWithSlices(c, "second_order_integrator", inputWidths(c), ports, rp,
                   {static_cast<int64_t>(n), limitX ? 1 : 0, limitDX ? 1 : 0, wrap ? 1 : 0, resetMode(reset), icX ? 1 : 0, icDX ? 1 : 0,
                    showX ? 1 : 0, showDX ? 1 : 0, c.flag("ReinitDXDTwhenXreachesSaturation") ? 1 : 0});
}

void buildStateSpace(BuildContext& c) { buildStateSpaceKernel(c, "state_space"); }

/** Matriz do parâmetro (ordem de linha) como Eigen. */
Eigen::MatrixXd toMatrix(const lib::ParamValue& value) {
    Eigen::MatrixXd m(static_cast<Eigen::Index>(value.rows), static_cast<Eigen::Index>(value.cols));
    for (size_t r = 0; r < value.rows; ++r)
        for (size_t col = 0; col < value.cols; ++col) m(static_cast<Eigen::Index>(r), static_cast<Eigen::Index>(col)) = value.data[r * value.cols + col];
    return m;
}

void appendRowMajor(std::vector<double>& out, const Eigen::MatrixXd& m) {
    for (Eigen::Index r = 0; r < m.rows(); ++r)
        for (Eigen::Index col = 0; col < m.cols(); ++col) out.push_back(m(r, col));
}

/** E dx/dt = A x + B u, y = C x + D u. E não singular: dx/dt = E^-1 A x + E^-1 B u. E singular:
 * decomposição em valores singulares E = U S V', z = V' x; a parte algébrica (S = 0) é eliminada
 * quando U2' A V2 é invertível (sistema de índice 1, o caso das DAEs lineares usuais), restando
 * S1 z1' = (A11 - A12 A22^-1 A21) z1 + (B1 - A12 A22^-1 B2) u e
 * y = (C1 - C2 A22^-1 A21) z1 + (D - C2 A22^-1 B2) u, com z1(0) = V1' x0 (parte consistente).
 * Índice > 1 é recusado com mensagem. */
void buildDescriptorStateSpace(BuildContext& c) {
    const lib::ParamValue eValue = c.value("E"), aValue = c.value("A"), bValue = c.value("B"), cValue = c.value("C"), dValue = c.value("D");
    const size_t n = aValue.rows;
    if (aValue.rows != aValue.cols) c.fail("A precisa ser quadrada");
    if (n == 0) c.fail("A vazia: use o bloco Gain ou State-Space");
    const auto N = static_cast<Eigen::Index>(n);
    const Eigen::MatrixXd E = eValue.isScalar() && n != 1 ? Eigen::MatrixXd(Eigen::MatrixXd::Identity(N, N) * eValue.data[0]) : toMatrix(eValue);
    if (E.rows() != N || E.cols() != N) c.fail("E precisa ser n x n (mesma dimensao de A)");
    if (bValue.rows != n) c.fail("B precisa ter o mesmo numero de linhas de A");
    if (cValue.cols != n) c.fail("C precisa ter o mesmo numero de colunas de A");
    const size_t m = bValue.cols, p = cValue.rows;
    const Eigen::MatrixXd D = dValue.isScalar() && dValue.data[0] == 0.0 && p * m > 1
                                  ? Eigen::MatrixXd(Eigen::MatrixXd::Zero(static_cast<Eigen::Index>(p), static_cast<Eigen::Index>(m)))
                                  : toMatrix(dValue);
    if (static_cast<size_t>(D.rows()) != p || static_cast<size_t>(D.cols()) != m) c.fail("D com dimensoes incompativeis com B e C");
    const Eigen::MatrixXd A = toMatrix(aValue), B = toMatrix(bValue), C = toMatrix(cValue);
    for (const Eigen::MatrixXd* matrix : {&E, &A, &B, &C, &D})
        if (!matrix->allFinite()) c.fail("matrizes devem ser finitas");
    const std::vector<double> x0Raw = expandTo(c, c.value("InitialCondition").linear(), n, "Initial conditions");
    requireFinite(c, x0Raw, "Initial conditions");
    Eigen::VectorXd x0(N);
    for (size_t i = 0; i < n; ++i) x0(static_cast<Eigen::Index>(i)) = x0Raw[i];

    const Eigen::JacobiSVD<Eigen::MatrixXd> svd(E, Eigen::ComputeFullU | Eigen::ComputeFullV);
    const Eigen::VectorXd sigma = svd.singularValues();
    const double tolerance = static_cast<double>(n) * std::numeric_limits<double>::epsilon() * (sigma.size() > 0 ? sigma(0) : 0.0);
    Eigen::Index rank = 0;
    while (rank < sigma.size() && sigma(rank) > tolerance) ++rank;
    if (rank == 0) c.fail("E nula: sistema puramente algebrico (use Gain ou State-Space)");
    Eigen::MatrixXd Ar, Br, Cr, Dr;
    Eigen::VectorXd z0;
    if (rank == N) {
        const Eigen::PartialPivLU<Eigen::MatrixXd> lu(E);
        Ar = lu.solve(A);
        Br = lu.solve(B);
        Cr = C;
        Dr = D;
        z0 = x0;
    } else {
        const Eigen::MatrixXd U = svd.matrixU(), V = svd.matrixV();
        const Eigen::MatrixXd Ah = U.transpose() * A * V, Bh = U.transpose() * B, Ch = C * V;
        const Eigen::Index r = rank, q = N - rank;
        const Eigen::MatrixXd A11 = Ah.topLeftCorner(r, r), A12 = Ah.topRightCorner(r, q), A21 = Ah.bottomLeftCorner(q, r), A22 = Ah.bottomRightCorner(q, q);
        const Eigen::MatrixXd B1 = Bh.topRows(r), B2 = Bh.bottomRows(q), C1 = Ch.leftCols(r), C2 = Ch.rightCols(q);
        const Eigen::FullPivLU<Eigen::MatrixXd> lu22(A22);
        if (!lu22.isInvertible()) c.fail("sistema descritor de indice maior que 1 (parte algebrica singular) nao suportado");
        const Eigen::MatrixXd X = lu22.solve(A21), Y = lu22.solve(B2);
        const Eigen::VectorXd sigmaInverse = sigma.head(r).cwiseInverse();
        Ar = sigmaInverse.asDiagonal() * (A11 - A12 * X);
        Br = sigmaInverse.asDiagonal() * (B1 - A12 * Y);
        Cr = C1 - C2 * X;
        Dr = D - C2 * Y;
        z0 = V.leftCols(r).transpose() * x0;
    }
    if (c.text("DirectFeedthrough") == "False" && Dr.size() > 0 && Dr.cwiseAbs().maxCoeff() > 0.0)
        c.fail("Direct feedthrough = False, mas o sistema tem transmissao direta (D efetiva nao nula)");
    if (c.inputWidth(0) != m && !(m == 1 && c.inputWidth(0) == 1))
        c.fail("largura da entrada (" + std::to_string(c.inputWidth(0)) + ") difere do numero de colunas de B/D (" + std::to_string(m) + ")");
    std::vector<double> rp;
    appendRowMajor(rp, Ar);
    appendRowMajor(rp, Br);
    appendRowMajor(rp, Cr);
    appendRowMajor(rp, Dr);
    for (Eigen::Index i = 0; i < z0.size(); ++i) rp.push_back(z0(i));
    simpleKernel(c, "state_space", static_cast<uint16_t>(p), rp, {static_cast<int64_t>(Ar.rows()), static_cast<int64_t>(m), static_cast<int64_t>(p)});
}

void buildTransferFcn(BuildContext& c) {
    const lib::ParamValue numerator = c.value("Numerator");
    if (numerator.empty()) c.fail("Numerator vazio");
    const Realization r = controllableCanonical(c, numeratorRows(numerator), c.value("Denominator").linear());
    emitRealization(c, r, "state_space", std::vector<double>(r.n, 0.0));
}

void buildZeroPole(BuildContext& c) {
    const ZeroPoleModel model = zeroPoleModel(c);
    const Realization r = controllableCanonical(c, model.numerators, model.denominator);
    emitRealization(c, r, "state_space", std::vector<double>(r.n, 0.0));
}

double delayCapacity(const BuildContext& c, double maximumDelay, double requested, bool fixed) {
    if (!(requested >= 2.0) || requested != std::floor(requested)) c.fail("tamanho de buffer deve ser inteiro >= 2");
    if (fixed) return std::min(requested, static_cast<double>(1u << 22));
    // Um registro por passo maior: o buffer cobre o atraso com o passo máximo do integrador (o
    // Simulink faz o buffer crescer; aqui ele nasce do tamanho certo, alocado uma vez no bind).
    const double needed = maximumDelay / (static_cast<double>(std::max<uint64_t>(1, c.resolution.maxStepNs)) * 1e-9) * 2.0 + 64.0;
    return std::clamp(std::max(requested, needed), 16.0, static_cast<double>(1u << 22));
}

void buildTransportDelay(BuildContext& c) {
    const std::vector<double> delays = c.value("DelayTime").linear();
    if (delays.empty()) c.fail("Time delay vazio");
    for (double delay : delays) if (!(delay >= 0.0) || !std::isfinite(delay)) c.fail("Time delay deve ser >= 0");
    const std::vector<double> initial = c.value("InitialOutput").linear();
    if (initial.empty()) c.fail("Initial output vazio");
    requireFinite(c, initial, "Initial output");
    const size_t n = std::max({static_cast<size_t>(c.inputWidth(0)), initial.size(), delays.size()});
    if (n > 4096) c.fail("largura de sinal grande demais");
    const bool fixed = c.flag("FixedBuffer");
    const double maximum = *std::max_element(delays.begin(), delays.end());
    const double capacity = delayCapacity(c, maximum, c.scalar("BufferSize"), fixed);
    const std::vector<double> expanded = expandTo(c, initial, n, "Initial output");
    if (delays.size() == 1) {
        std::vector<double> rp{delays[0]};
        rp.insert(rp.end(), expanded.begin(), expanded.end());
        simpleKernel(c, "transport_delay", static_cast<uint16_t>(n), rp,
                     {static_cast<int64_t>(n), static_cast<int64_t>(capacity), nanoseconds(c, delays[0], "Time delay"), fixed ? 1 : 0});
        return;
    }
    // Atraso por elemento: um kernel escalar por elemento (cada um com seus instantes de chegada) e
    // concatenação na saída.
    const std::vector<double> perElement = expandTo(c, delays, n, "Time delay");
    c.outputWidths = {static_cast<uint16_t>(n)};
    if (c.widthsOnly) return;
    const std::string base = c.outputBlock(0);
    for (size_t i = 0; i < n; ++i) {
        const std::string in = base + "::u" + std::to_string(i);
        const std::string element = base + "::e" + std::to_string(i);
        c.kernel(in, "slice", {c.inputWidth(0)}, 1, {}, {c.inputWidth(0) == 1 ? 0 : static_cast<int64_t>(i)});
        c.connectInputs(in);
        c.kernel(element, "transport_delay", {1}, 1, {perElement[i], expanded[i]},
                 {1, static_cast<int64_t>(capacity), nanoseconds(c, perElement[i], "Time delay"), fixed ? 1 : 0});
        c.connect(in, element, 1);
    }
    c.kernel(base, "concat", std::vector<uint16_t>(n, 1), static_cast<uint16_t>(n));
    for (size_t i = 0; i < n; ++i) c.connect(base + "::e" + std::to_string(i), base, static_cast<int>(i + 1));
}

void buildVariableDelay(BuildContext& c) {
    const bool transport = c.text("VariableDelayType") == "Variable transport delay";
    const std::vector<double> maximum = c.value("MaximumDelay").linear();
    const std::vector<double> initial = c.value("InitialOutput").linear();
    if (maximum.empty() || initial.empty()) c.fail("Maximum delay/Initial output vazios");
    for (double value : maximum) if (!(value >= 0.0) || !std::isfinite(value)) c.fail("Maximum delay deve ser >= 0 e finito");
    requireFinite(c, initial, "Initial output");
    const size_t n = std::max({static_cast<size_t>(c.inputWidth(0)), static_cast<size_t>(c.inputWidth(1)), maximum.size(), initial.size()});
    if (n > 4096) c.fail("largura de sinal grande demais");
    const double capacity = delayCapacity(c, *std::max_element(maximum.begin(), maximum.end()), c.scalar("MaximumPoints"), c.flag("FixedBuffer"));
    std::vector<double> rp = expandTo(c, maximum, n, "Maximum delay");
    const std::vector<double> expanded = expandTo(c, initial, n, "Initial output");
    rp.insert(rp.end(), expanded.begin(), expanded.end());
    simpleKernel(c, "variable_delay", static_cast<uint16_t>(n), rp,
                 {static_cast<int64_t>(n), static_cast<int64_t>(capacity), transport ? 1 : 0, !transport && c.flag("ZeroDelay") ? 1 : 0});
}

void buildDerivative(BuildContext& c) { simpleKernel(c, "derivative", elementwiseWidth(c)); }

/** First Order Hold: amostra a entrada na taxa (discreta) herdada dela e publica uma saída
 * contínua -- o kernel vai para a partição contínua; a taxa da entrada só define os acertos. */
void buildFirstOrderHold(BuildContext& c) {
    const std::vector<double> initial = c.value("InitialOutput").linear();
    if (initial.empty()) c.fail("Initial output vazio");
    requireFinite(c, initial, "Initial output");
    const double tolerance = c.scalar("ErrorTolerance");
    if (!(tolerance >= 0.0)) c.fail("Reset if relative extrapolation error exceeds deve ser >= 0");
    const bool allowContinuous = c.flag("AllowContinuousInput");
    const simulation::SignalRate rate = c.resolution.rate;
    const bool discrete = !rate.continuous() && rate.periodNs < simulation::kConstantSamplePeriodNs;
    if (!discrete && !allowContinuous) c.fail("exige tempo de amostragem discreto na entrada (ou Allow continuous input)");
    const uint16_t n = elementwiseWidth(c, {initial.size()});
    const std::vector<double> rp = expandTo(c, initial, n, "Initial output");
    c.outputWidths = {n};
    if (c.widthsOnly) return;
    simulation::SignalBlockDefinition& kernel = c.kernel("", "first_order_hold", inputWidths(c), n, rp,
        {static_cast<int64_t>(n), discrete ? static_cast<int64_t>(rate.periodNs) : 0, discrete ? static_cast<int64_t>(rate.offsetNs) : 0,
         c.text("OutputAlgorithm") == "Fast (Minimize Error)" ? 1 : 0, discrete ? 0 : 1});
    kernel.rate = {0, 0, 0};
    c.connectInputs(c.outputBlock(0));
}

} // namespace

void registerContinuousBuilders(BuilderTable& table) {
    table.add("integrator", buildIntegrator);
    table.add("second_order_integrator", buildSecondOrderIntegrator);
    table.add("state_space", buildStateSpace);
    table.add("descriptor_state_space", buildDescriptorStateSpace);
    table.add("transfer_fcn", buildTransferFcn);
    table.add("zero_pole", buildZeroPole);
    table.add("transport_delay", buildTransportDelay);
    table.add("variable_time_delay", buildVariableDelay);
    table.add("variable_transport_delay", buildVariableDelay);
    table.add("derivative", buildDerivative);
    table.add("first_order_hold", buildFirstOrderHold);
}

} // namespace lasecsimul::components::blocks::builders
