---
id: FEAT-008
kind: feature
status: deferred
dependsOn: [FEAT-001, ARCH-005, FEAT-011]
supersedes: []
---

# Visualização animada de processo

Visualização é projeção de telemetria, não participante do solver. Assets e bindings pertencem à autoria/Extension; o Core publica valores por slots/handles compilados.

## Shell de navegação já disponível

A feature completa continua adiada, mas o workspace já reserva `Process/Ctrl` e `Process/Autom`
conforme [FEAT-011](workspace-navigation.md). Ambas as áreas permanecem intencionalmente vazias nesta
fase. A presença das abas não autoriza misturar componentes elétricos, analógicos ou digitais nelas e
não significa que editor, biblioteca ou runtime de processo estejam implementados.

Quando a implementação desta feature começar, a área de processo deve ser preenchida dentro dessa
hierarquia e preservar seu estado ao alternar abas, sem reutilizar o canvas elétrico como fonte de
verdade.

## Regras

- animações declarativas e limitadas;
- nenhum script visual muta estado de processo implicitamente;
- FPS é política da Extension;
- frame obsoleto pode ser descartado;
- assets não entram no `SimulationPlan` além de IDs/bindings necessários à telemetria.

## Aceitação

- antes da implementação da feature, `Ctrl` e `Autom` existem como áreas vazias e isoladas do catálogo
  de `Circuit`;
- ocultar/fechar Webview não muda resultado;
- SharedHost reduz FPS sem mudar simulação;
- bindings inválidos falham na compilação/autoria;
- memória de assets e frames é limitada.
