#pragma once

#include <Eigen/Dense>
#include <cmath>
#include <cstdint>
#include <optional>
#include <stdexcept>
#include <unordered_map>
#include <vector>

namespace lasecsimul::simulation {

/**
 * Um sistema linear independente — um componente conectado do grafo de nós (DFS em Netlist).
 * Grupos nunca compartilham estado mutável entre si, por isso podem ser resolvidos em paralelo sem
 * sincronização (ver .spec/lasecsimul.spec, seção 7.1).
 *
 * Dimensão da matriz = nós do grupo + variáveis extras (correntes de ramo de fontes de tensão
 * ideais, ver seção 7.3) — alocadas uma vez no rebuild de topologia, nunca durante stamp(). As
 * linhas/colunas de variável extra vêm DEPOIS das de nó, na mesma matriz — MNA não distingue
 * incógnita de tensão de incógnita de corrente, é tudo resolvido junto pelo mesmo `Eigen::PartialPivLU`.
 *
 * LU densa com pivoteamento — substitui o método de Crout sem pivot do SimulIDE (risco de
 * imprecisão numérica em matrizes mal-condicionadas). Eigen::SparseLU é o caminho de upgrade
 * quando size() crescer além do que compensa matriz densa; não implementado preventivamente.
 */
class CircuitGroup {
public:
    CircuitGroup(std::vector<uint32_t> nodeIndices, uint32_t extraVariableCount = 0)
        : m_nodeIndices(std::move(nodeIndices)), m_extraVariableCount(extraVariableCount),
          m_admittance(Eigen::MatrixXd::Zero(totalSizeOf(m_nodeIndices, extraVariableCount),
                                              totalSizeOf(m_nodeIndices, extraVariableCount))),
          m_rhs(Eigen::VectorXd::Zero(totalSizeOf(m_nodeIndices, extraVariableCount))),
          m_lastSolution(Eigen::VectorXd::Zero(totalSizeOf(m_nodeIndices, extraVariableCount))) {}

    size_t size() const { return m_nodeIndices.size(); } // só nós, sem variável extra
    size_t totalSize() const { return m_nodeIndices.size() + m_extraVariableCount; }
    const std::vector<uint32_t>& nodeIndices() const { return m_nodeIndices; }
    bool singular() const { return m_singular; }
    double lastReciprocalConditionEstimate() const { return m_lastRcond; }

    /** Acesso de escrita marca o grupo "admitância mudou" — próxima solve() vai refatorar. */
    Eigen::MatrixXd& admittance() {
        m_admittanceChanged = true;
        return m_admittance;
    }

    /** Acesso de escrita marca só "corrente mudou" — próxima solve() reaproveita a fatoração. */
    Eigen::VectorXd& rhs() {
        m_currentChanged = true;
        return m_rhs;
    }

    void replaceStamp(uint32_t ownerId, const Eigen::MatrixXd& admittanceDelta, const Eigen::VectorXd& rhsDelta) {
        if (admittanceDelta.rows() != m_admittance.rows() || admittanceDelta.cols() != m_admittance.cols() ||
            rhsDelta.size() != m_rhs.size()) {
            throw std::invalid_argument("CircuitGroup::replaceStamp: stamp dimension mismatch");
        }

        StampContribution& previous = m_stamps[ownerId];
        if (previous.admittance.size() == 0) {
            previous.admittance = Eigen::MatrixXd::Zero(m_admittance.rows(), m_admittance.cols());
            previous.rhs = Eigen::VectorXd::Zero(m_rhs.size());
        }

        const Eigen::MatrixXd admittanceDiff = admittanceDelta - previous.admittance;
        const Eigen::VectorXd rhsDiff = rhsDelta - previous.rhs;

        if (!admittanceDiff.isZero(0.0)) {
            m_admittance += admittanceDiff;
            m_admittanceChanged = true;
        }
        if (!rhsDiff.isZero(0.0)) {
            m_rhs += rhsDiff;
            m_currentChanged = true;
        }

        previous.admittance = admittanceDelta;
        previous.rhs = rhsDelta;
    }

    void clearStamps() {
        m_stamps.clear();
        m_admittance.setZero();
        m_rhs.setZero();
        m_lastSolution.setZero();
        m_factorization.reset();
        m_admittanceChanged = true;
        m_currentChanged = true;
        m_singular = false;
        m_lastRcond = 0.0;
    }

    bool admittanceChanged() const { return m_admittanceChanged; }
    bool currentChanged() const { return m_currentChanged; }
    bool dirty() const { return m_admittanceChanged || m_currentChanged; }

    void factor() {
        if (m_admittance.rows() == 0) {
            m_factorization.reset();
            m_singular = false;
            m_lastRcond = 0.0;
            m_admittanceChanged = false;
            return;
        }

        // Equilibração diagonal simétrica (Jacobi) antes de checar posto/condicionamento: sem isso,
        // um grupo que mistura condutância Norton-pra-terra "ideal" (Ground/FixedVolt/Clock/
        // VoltSource/WaveGen, todos ~1e9) com um componente de muitos pinos flutuantes (ex:
        // McuComponent, ~1e-6 -- ajustado pra ficar seguro SOZINHO, ver doc lá) faz
        // FullPivLU::rank() ficar bem abaixo de cols() mesmo sem nenhuma linha literalmente zerada,
        // porque o threshold do Eigen escala com o maior pivô (`maxPivot * size * epsilon`) -- 15
        // ordens de grandeza de spread sepultam as linhas fracas. Escalar cada linha/coluna i por
        // `1/sqrt(|A_ii|)` deixa a diagonal em ~1 e o spread relativo correto reaparece (resolve a
        // causa raiz pra qualquer combinação futura de magnitudes, não só este caso -- ver
        // .spec/lasecsimul-native-devices.spec seção 8.1). Variáveis extras (corrente de ramo de
        // fonte de tensão ideal) têm diagonal exatamente 0 por construção (MNA padrão) -- escala 1,
        // sem tocar essas linhas, que já são bem-condicionadas sozinhas (±1 nos off-diagonais).
        const Eigen::Index n = m_admittance.rows();
        m_scale = Eigen::VectorXd::Ones(n);
        for (Eigen::Index i = 0; i < n; ++i) {
            const double diag = std::abs(m_admittance(i, i));
            if (diag > 0.0) m_scale(i) = 1.0 / std::sqrt(diag);
        }
        const Eigen::MatrixXd scaled = m_scale.asDiagonal() * m_admittance * m_scale.asDiagonal();

        Eigen::FullPivLU<Eigen::MatrixXd> rankCheck(scaled);
        m_lastRcond = rankCheck.rcond();
        if (rankCheck.rank() < scaled.cols() || !std::isfinite(m_lastRcond) || m_lastRcond <= 1e-14) {
            m_factorization.reset();
            m_lastSolution.setZero();
            m_singular = true;
            m_admittanceChanged = false;
            return;
        }

        m_factorization.emplace(scaled);
        m_singular = false;
        m_admittanceChanged = false;
    }

    Eigen::VectorXd solve() {
        m_currentChanged = false;
        if (m_singular || !m_factorization) {
            m_lastSolution.setZero();
            return m_lastSolution;
        }
        // Sistema equilibrado: A'=S*A*S, b'=S*b, resolvido pra y; x verdadeiro = S*y (ver factor()).
        const Eigen::VectorXd scaledRhs = m_scale.cwiseProduct(m_rhs);
        const Eigen::VectorXd y = m_factorization->solve(scaledRhs);
        m_lastSolution = m_scale.cwiseProduct(y);
        if (!m_lastSolution.allFinite()) {
            m_lastSolution.setZero();
            m_singular = true;
        }
        return m_lastSolution;
    }

    /** Valor da linha local `index` conforme a última solve() — tensão se `index < size()`,
     * corrente de ramo se `index >= size()`. Usado por ComponentMatrixView durante o stamp() do
     * próximo passo (lê o que o solver já sabe, nunca dispara um solve novo). */
    double valueOf(uint32_t localIndex) const { return m_lastSolution[static_cast<Eigen::Index>(localIndex)]; }

private:
    struct StampContribution {
        Eigen::MatrixXd admittance;
        Eigen::VectorXd rhs;
    };

    static Eigen::Index totalSizeOf(const std::vector<uint32_t>& nodeIndices, uint32_t extraVariableCount) {
        return static_cast<Eigen::Index>(nodeIndices.size() + extraVariableCount);
    }

    std::vector<uint32_t> m_nodeIndices; // índice global de nó, na ordem das linhas/colunas locais
    uint32_t m_extraVariableCount;
    Eigen::MatrixXd m_admittance;
    Eigen::VectorXd m_rhs;
    Eigen::VectorXd m_lastSolution;
    Eigen::VectorXd m_scale; // fatores de equilibração da última factor() -- ver factor()/solve()
    std::optional<Eigen::PartialPivLU<Eigen::MatrixXd>> m_factorization;
    std::unordered_map<uint32_t, StampContribution> m_stamps;
    bool m_admittanceChanged = true;
    bool m_currentChanged = true;
    bool m_singular = false;
    double m_lastRcond = 0.0;
};

} // namespace lasecsimul::simulation
