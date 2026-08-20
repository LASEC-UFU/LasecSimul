---
id: BENCH-002
kind: benchmark
status: active
dependsOn: [BENCH-001, FEAT-012]
supersedes: []
---

# Matriz de cobertura F7 — controle/processo TDPS

Inventario executado antes de adicionar primitivas. A coluna "destino" registra o reaproveitamento
preferido; nenhuma classe monolitica `TDPSProcess` ou runtime TDPS foi criada.

| Necessidade | Destino no LasecSimul | Decisao F7 |
|---|---|---|
| ganho, soma e expressao | `Gain`, `CalcExpression` do Signal Engine | reutilizado; DSL segura recebe entradas nomeadas |
| primeira/segunda ordem | composicao de `FirstOrder` | reutilizado |
| FOPDT | `Gain -> FirstOrder -> DeadTime` | `.lssubcircuit` reutilizavel, sem nova primitiva |
| atraso | `DeadTime` | reutilizado; capacidade dimensionada por atraso/taxa |
| lead/lag | `LeadLag` | reutilizado |
| saturacao | `Saturation` | reutilizado, inclusive em CalcExpression |
| deadband/stiction/rate limit | primitivas F6 existentes | reutilizado |
| atuador | `FirstOrder` | reutilizado |
| PID industrial | inexistente no inventario | nova primitiva stateful reutilizavel `Pid` |
| Scope/registrador/readout | telemetria `Probe` | reutilizado como observador sem efeito numerico |
| XY recorder | layout/bindings legados ambiguos | reportado como `unsupported`, sem inferir conexao |
| indices globais e `Mnn` | nenhuma semantica runtime permitida | resolvidos no importador para componentes/edges |
| tensao/corrente/digital entre dominios | inexistente no inventario | seis bridges explicitos adicionados |

Cobertura auditada do corpus TDPS v7.71: 24 arquivos, 66 controladores, 139 processos, 172 blocos
de calculo, 57 registradores, 24 registradores XY e 213 textos animados. Nomes relativos, hashes e
contagens estao em `tdps-v771-coverage.json`; os `.smp` originais nao sao redistribuidos.
