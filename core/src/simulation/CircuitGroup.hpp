#pragma once

#include <Eigen/Dense>
#include <Eigen/SparseLU>
#include <cmath>
#include <cstdint>
#include <optional>
#include <memory>
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
    struct MatrixStampEntry { uint32_t row; uint32_t column; double value; };
    struct RhsStampEntry { uint32_t row; double value; };
    struct StampContribution {
        std::vector<MatrixStampEntry> matrix;
        std::vector<RhsStampEntry> rhs;
    };

    void beginPendingStamp(uint32_t ownerId) {
        StampContribution& pending = m_pendingStamps[ownerId];
        pending.matrix.clear(); pending.rhs.clear();
        if (pending.matrix.capacity() < 16) pending.matrix.reserve(16);
        if (pending.rhs.capacity() < 8) pending.rhs.reserve(8);
    }
    void addPendingMatrix(uint32_t ownerId, uint32_t row, uint32_t column, double value) {
        auto& entries = m_pendingStamps[ownerId].matrix;
        for (auto& entry : entries) if (entry.row == row && entry.column == column) { entry.value += value; return; }
        entries.push_back({row, column, value});
    }
    void addPendingRhs(uint32_t ownerId, uint32_t row, double value, bool replace = false) {
        auto& entries = m_pendingStamps[ownerId].rhs;
        for (auto& entry : entries) if (entry.row == row) { entry.value = replace ? value : entry.value + value; return; }
        entries.push_back({row, value});
    }
    void commitPendingStamp(uint32_t ownerId) {
        const StampContribution& pending = m_pendingStamps.at(ownerId);
        replaceStamp(ownerId, pending.matrix, pending.rhs);
    }
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

        std::vector<MatrixStampEntry> matrixEntries;
        std::vector<RhsStampEntry> rhsEntries;
        for (Eigen::Index row = 0; row < admittanceDelta.rows(); ++row)
            for (Eigen::Index column = 0; column < admittanceDelta.cols(); ++column)
                if (admittanceDelta(row, column) != 0.0)
                    matrixEntries.push_back({static_cast<uint32_t>(row), static_cast<uint32_t>(column), admittanceDelta(row, column)});
        for (Eigen::Index row = 0; row < rhsDelta.size(); ++row)
            if (rhsDelta(row) != 0.0) rhsEntries.push_back({static_cast<uint32_t>(row), rhsDelta(row)});
        replaceStamp(ownerId, matrixEntries, rhsEntries);
    }

    void replaceStamp(uint32_t ownerId, const std::vector<MatrixStampEntry>& matrixEntries,
                      const std::vector<RhsStampEntry>& rhsEntries) {
        StampContribution& previous = m_stamps[ownerId];
        bool matrixChanged = previous.matrix.size() != matrixEntries.size();
        if (!matrixChanged) for (size_t i = 0; i < matrixEntries.size(); ++i) {
            const auto& a = previous.matrix[i]; const auto& b = matrixEntries[i];
            if (a.row != b.row || a.column != b.column || a.value != b.value) { matrixChanged = true; break; }
        }
        bool rhsChanged = previous.rhs.size() != rhsEntries.size();
        if (!rhsChanged) for (size_t i = 0; i < rhsEntries.size(); ++i) {
            const auto& a = previous.rhs[i]; const auto& b = rhsEntries[i];
            if (a.row != b.row || a.value != b.value) { rhsChanged = true; break; }
        }
        if (matrixChanged) {
            for (const auto& entry : previous.matrix) m_admittance(entry.row, entry.column) -= entry.value;
            for (const auto& entry : matrixEntries) m_admittance(entry.row, entry.column) += entry.value;
            previous.matrix = matrixEntries;
            m_admittanceChanged = true;
        }
        if (rhsChanged) {
            for (const auto& entry : previous.rhs) m_rhs(entry.row) -= entry.value;
            for (const auto& entry : rhsEntries) m_rhs(entry.row) += entry.value;
            previous.rhs = rhsEntries;
            m_currentChanged = true;
        }
    }

    void clearStamps() {
        m_stamps.clear();
        m_pendingStamps.clear();
        m_admittance.setZero();
        m_rhs.setZero();
        m_lastSolution.setZero();
        m_factorization.reset();
        m_sparseFactorization.reset();
        m_sparsePatternInitialized = false;
        m_useSparse = false;
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

        if (static_cast<size_t>(n) >= kSparseThreshold) {
            Eigen::SparseMatrix<double> sparse = scaled.sparseView(0.0, 1e-15);
            sparse.makeCompressed();
            size_t patternHash = static_cast<size_t>(sparse.nonZeros());
            for (int outer = 0; outer < sparse.outerSize(); ++outer)
                for (Eigen::SparseMatrix<double>::InnerIterator it(sparse, outer); it; ++it)
                    patternHash ^= (static_cast<size_t>(it.row()) * 1315423911u + static_cast<size_t>(it.col()))
                                   + 0x9e3779b9u + (patternHash << 6) + (patternHash >> 2);
            if (!m_sparseFactorization) m_sparseFactorization = std::make_unique<SparseSolver>();
            if (!m_sparsePatternInitialized || patternHash != m_sparsePatternHash) {
                m_sparseFactorization->analyzePattern(sparse);
                m_sparsePatternHash = patternHash;
                m_sparsePatternInitialized = true;
            }
            m_sparseFactorization->factorize(sparse);
            m_singular = m_sparseFactorization->info() != Eigen::Success;
            m_useSparse = !m_singular;
            m_factorization.reset();
            m_lastRcond = m_singular ? 0.0 : 1.0;
            m_admittanceChanged = false;
            return;
        }
        m_useSparse = false;

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

    const Eigen::VectorXd& solve() {
        m_currentChanged = false;
        if (m_singular || (!m_useSparse && !m_factorization) || (m_useSparse && !m_sparseFactorization)) {
            m_lastSolution.setZero();
            return m_lastSolution;
        }
        // Sistema equilibrado: A'=S*A*S, b'=S*b, resolvido pra y; x verdadeiro = S*y (ver factor()).
        const Eigen::VectorXd scaledRhs = m_scale.cwiseProduct(m_rhs);
        Eigen::VectorXd y;
        if (m_useSparse) y = m_sparseFactorization->solve(scaledRhs);
        else y = m_factorization->solve(scaledRhs);
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
    using SparseSolver = Eigen::SparseLU<Eigen::SparseMatrix<double>, Eigen::COLAMDOrdering<int>>;
    std::unique_ptr<SparseSolver> m_sparseFactorization;
    size_t m_sparsePatternHash = 0;
    bool m_sparsePatternInitialized = false;
    bool m_useSparse = false;
    static constexpr size_t kSparseThreshold = 96;
    std::unordered_map<uint32_t, StampContribution> m_stamps;
    std::unordered_map<uint32_t, StampContribution> m_pendingStamps;
    bool m_admittanceChanged = true;
    bool m_currentChanged = true;
    bool m_singular = false;
    double m_lastRcond = 0.0;
};

} // namespace lasecsimul::simulation
