---
id: FEAT-008
kind: feature
status: active
dependsOn: [FEAT-001, ARCH-005, FEAT-011]
supersedes: []
---

# Visualização animada de processo

Visualização é projeção de telemetria, não participante do solver. Assets e bindings pertencem à autoria/Extension; o Core publica valores por slots/handles compilados.

## Estado da implementação (v0.0.13)

A camada gráfica de supervisório está implementada e ativa: `Miscelâneos → Gráfico` publica 28
símbolos industriais como componentes normais de catálogo (`graphics.*`, `pinCount: 0`, portanto
fora do solver por construção), com binding genérico de telemetria por id estável e as 24 telas de
processo TDPS reconstruídas sem bitmap. Ver `docs/44-biblioteca-grafica-supervisorio-fase0.md`
(auditoria/arquitetura) e `docs/45-biblioteca-grafica-supervisorio-implementacao.md`
(implementação, cobertura, testes e lacunas).

Continua **não implementado** desta spec: animação declarativa com eixo de tempo (a projeção é
amostrada pela telemetria existente, ~300 ms, sem interpolação) e política própria de FPS/descarte
de frame. Bindings inválidos hoje degradam para o valor autorado e marcam `missing` no desenho, em
vez de falharem na compilação/autoria.

## Shell de navegação já disponível

A feature completa continua adiada, mas a paleta lateral já reserva as abas de filtro `Controle` e
`Processo` conforme [FEAT-011](workspace-navigation.md). Desde F7, subcircuitos de processo podem
declarar `workspaceSection: "process"` e aparecer na aba correspondente. Isso não implementa a
visualização animada: os itens continuam no canvas único e observadores são apenas projeções de
telemetria, sem scripts visuais ou participação no solver.

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

- antes da implementação da animação, `Controle` e `Processo` existem como abas de filtro isoladas;
  itens F7 podem ocupá-las somente por `workspaceSection` explícito;
- ocultar/fechar Webview não muda resultado;
- SharedHost reduz FPS sem mudar simulação;
- bindings inválidos falham na compilação/autoria;
- memória de assets e frames é limitada.
