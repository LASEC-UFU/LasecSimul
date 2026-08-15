#pragma once

#include <cstdint>
#include <span>
#include <vector>

namespace lasecsimul::simulation {

/**
 * Dirty-tracking O(1) insert/remove/contains, iteração contígua — substitui lista ligada intrusiva
 * (ver .spec/archive/legacy-v2/lasecsimul.spec, seção 7.1: pointer-chasing é hostil a cache em hardware atual; array
 * denso favorece prefetch). Array esparso indexado pelo slot do item -> posição no array denso.
 */
template <typename IndexT = uint32_t>
class SparseSet {
public:
    explicit SparseSet(size_t capacity) : m_sparse(capacity, kInvalid) {}

    /** Capacidade fixa no construtor não cresce sozinha — quem detecta que vai inserir um índice
     * >= capacity() precisa chamar isto antes (ex: SimulationSession::addComponent). Sem isso,
     * insert() faz acesso fora dos limites sem checagem (UB, não exceção limpa) — bug real que
     * existia antes desta correção. */
    void grow(size_t newCapacity) {
        if (newCapacity > m_sparse.size()) m_sparse.resize(newCapacity, kInvalid);
    }

    size_t capacity() const { return m_sparse.size(); }

    bool insert(IndexT index) {
        if (index >= m_sparse.size()) grow(static_cast<size_t>(index) + 1);
        if (contains(index)) return false;
        m_sparse[index] = static_cast<IndexT>(m_dense.size());
        m_dense.push_back(index);
        return true;
    }

    bool remove(IndexT index) {
        if (!contains(index)) return false;
        const IndexT pos = m_sparse[index];
        const IndexT last = m_dense.back();
        m_dense[pos] = last;
        m_sparse[last] = pos;
        m_dense.pop_back();
        m_sparse[index] = kInvalid;
        return true;
    }

    bool contains(IndexT index) const {
        return index < m_sparse.size() && m_sparse[index] != kInvalid;
    }

    void clear() {
        for (IndexT index : m_dense) m_sparse[index] = kInvalid;
        m_dense.clear();
    }

    std::span<const IndexT> dense() const { return m_dense; }
    size_t size() const { return m_dense.size(); }
    bool empty() const { return m_dense.empty(); }

private:
    static constexpr IndexT kInvalid = static_cast<IndexT>(-1);

    std::vector<IndexT> m_sparse; // slot do item -> posição em m_dense, ou kInvalid
    std::vector<IndexT> m_dense;  // itens dirty agora, compactos, sem buracos
};

} // namespace lasecsimul::simulation
