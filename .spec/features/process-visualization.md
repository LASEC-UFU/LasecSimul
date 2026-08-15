---
id: FEAT-008
kind: feature
status: deferred
dependsOn: [FEAT-001, ARCH-005]
supersedes: []
---

# Visualização animada de processo

Visualização é projeção de telemetria, não participante do solver. Assets e bindings pertencem à autoria/Extension; o Core publica valores por slots/handles compilados.

## Regras

- animações declarativas e limitadas;
- nenhum script visual muta estado de processo implicitamente;
- FPS é política da Extension;
- frame obsoleto pode ser descartado;
- assets não entram no `SimulationPlan` além de IDs/bindings necessários à telemetria.

## Aceitação

- ocultar/fechar Webview não muda resultado;
- SharedHost reduz FPS sem mudar simulação;
- bindings inválidos falham na compilação/autoria;
- memória de assets e frames é limitada.
