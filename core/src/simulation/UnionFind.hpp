#pragma once

#include <algorithm>
#include <cstdint>
#include <stdexcept>
#include <unordered_map>
#include <vector>

namespace lasecsimul::simulation {

/**
 * Disjoint-set clássico (path halving + union por rank) — primitiva única usada nas duas passadas
 * de resolução de topologia (ver .spec/archive/legacy-v2/lasecsimul.spec, seção 7.2): pino->nó (fio + grupo de
 * túnel) e nó->grupo (pinos de um mesmo componente). Recalculado do zero a cada mudança de
 * topologia, nunca mantido incrementalmente — união não é desfazível (renomear um túnel pode
 * separar nós que estavam fundidos), e refazer do zero é barato porque topologia só muda em
 * edição do usuário, não a cada passo de simulação.
 */
class UnionFind {
public:
    explicit UnionFind(size_t n) : m_parent(n), m_rank(n, 0) {
        for (size_t i = 0; i < n; ++i) m_parent[i] = static_cast<uint32_t>(i);
    }

    uint32_t find(uint32_t x) {
        if (x >= m_parent.size()) throw std::out_of_range("UnionFind::find: index out of range");
        while (m_parent[x] != x) {
            m_parent[x] = m_parent[m_parent[x]]; // path halving
            x = m_parent[x];
        }
        return x;
    }

    void unite(uint32_t a, uint32_t b) {
        if (a >= m_parent.size() || b >= m_parent.size())
            throw std::out_of_range("UnionFind::unite: index out of range");
        a = find(a);
        b = find(b);
        if (a == b) return;
        if (m_rank[a] < m_rank[b]) std::swap(a, b);
        m_parent[b] = a;
        if (m_rank[a] == m_rank[b]) ++m_rank[a];
    }

    /** Remapeia raízes (arbitrárias) para um espaço denso 0..N-1 — é esse id denso que vira
     * "nó global" (1ª passada) ou "grupo" (2ª passada) no resto do pipeline. */
    std::vector<uint32_t> compress() {
        std::vector<uint32_t> result(m_parent.size());
        std::unordered_map<uint32_t, uint32_t> rootToId;
        for (size_t i = 0; i < m_parent.size(); ++i) {
            const uint32_t root = find(static_cast<uint32_t>(i));
            auto it = rootToId.find(root);
            uint32_t id;
            if (it == rootToId.end()) {
                id = static_cast<uint32_t>(rootToId.size());
                rootToId.emplace(root, id);
            } else {
                id = it->second;
            }
            result[i] = id;
        }
        m_idCount = rootToId.size();
        return result;
    }

    /** Só válido depois de compress(). */
    size_t idCount() const { return m_idCount; }

    size_t size() const { return m_parent.size(); }

private:
    std::vector<uint32_t> m_parent;
    std::vector<uint8_t> m_rank;
    size_t m_idCount = 0;
};

} // namespace lasecsimul::simulation
