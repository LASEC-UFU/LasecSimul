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

A feature completa continua adiada, mas a paleta lateral já reserva as abas de filtro `Controle` e
`Processo` conforme [FEAT-011](workspace-navigation.md). Ambas permanecem intencionalmente vazias
nesta fase — nenhum item de catálogo declara `workspaceSection: "control"` ou `"process"` ainda. A
presença das abas na paleta não autoriza misturar componentes elétricos, analógicos ou digitais
nelas e não significa que biblioteca ou runtime de processo estejam implementados.

Diferente da decisão anterior, o editor de esquemático (`main.ts`) não tem mais um modo de
navegação por aba nem um placeholder próprio: é um único canvas elétrico sempre visível. Quando a
implementação desta feature começar, a visualização de processo deve ser um overlay/projeção sobre
esse mesmo canvas (ou um painel próprio fora do fluxo de abas), nunca reintroduzir um canvas
alternativo selecionado por seção.

## Regras

- animações declarativas e limitadas;
- nenhum script visual muta estado de processo implicitamente;
- FPS é política da Extension;
- frame obsoleto pode ser descartado;
- assets não entram no `SimulationPlan` além de IDs/bindings necessários à telemetria.

## Aceitação

- antes da implementação da feature, `Controle` e `Processo` existem como abas de filtro na paleta,
  vazias e isoladas do catálogo de `Analógico`/`Digital`;
- ocultar/fechar Webview não muda resultado;
- SharedHost reduz FPS sem mudar simulação;
- bindings inválidos falham na compilação/autoria;
- memória de assets e frames é limitada.
