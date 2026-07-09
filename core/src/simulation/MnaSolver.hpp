#pragma once

#include <cstdio>
#include <future>
#include <vector>
#include "CircuitGroup.hpp"

namespace lasecsimul::simulation {

/**
 * Resolve o circuito inteiro: grupos parados (nem admitância nem corrente mudou) ficam intocados;
 * grupos dirty são despachados em paralelo. Seguro porque cada grupo escreve só nos índices globais
 * de `nodeVoltages` listados em `group.nodeIndices()` — disjuntos entre grupos por construção (são
 * componentes conectados distintos do grafo), nunca há duas tasks escrevendo o mesmo índice.
 *
 * Nó isolado (grupo de 1) não tem caminho especial — vira CircuitGroup 1×1 normal; com Eigen isso já
 * é trivial, um acumulador paralelo ao estilo SimulIDE não se paga aqui (ver .spec, seção 7.1).
 *
 * Estrutura inicial: usa std::async direto, não um thread-pool dedicado — trocar por um pool
 * compartilhado com plugins::PluginModule::submit_task fica para quando o overhead de criar uma
 * task por grupo por passo se mostrar real (medir antes de complicar; ver .spec, seção 7.1).
 */
class MnaSolver {
public:
    void solve(std::vector<CircuitGroup>& groups, std::vector<double>& nodeVoltages) {
        std::vector<std::future<void>> pending;
        pending.reserve(groups.size());

        for (CircuitGroup& group : groups) {
            if (!group.dirty()) continue; // nada mudou nesse grupo — pula, zero custo

            pending.push_back(std::async(std::launch::async, [&group, &nodeVoltages] {
                if (group.admittanceChanged()) group.factor(); // caro — só quando topologia/conduct. mudou
                const Eigen::VectorXd voltages = group.solve(); // barato — substituição sobre LU em cache

                const std::vector<uint32_t>& indices = group.nodeIndices();
                const bool singular = group.singular() || !voltages.allFinite();
                for (size_t i = 0; i < indices.size(); ++i) {
                    // Nó sem nenhuma conexão real (admitância 0 em todo lado) dá matriz singular ->
                    // PartialPivLU não detecta isso sozinho, só devolve NaN/Inf. Nunca propagar isso
                    // pro resto do circuito — cai pra 0V e avisa.
                    nodeVoltages[indices[i]] =
                        singular ? 0.0 : voltages[static_cast<Eigen::Index>(i)];
                }
                if (singular) {
                    std::fprintf(stderr, "[MnaSolver] grupo com %zu nó(s) deu sistema singular — "
                                          "nó(s) sem referência/caminho real, tensão definida como 0V\n",
                                 indices.size());
                }
            }));
        }

        for (std::future<void>& f : pending) f.get();
    }
};

} // namespace lasecsimul::simulation
