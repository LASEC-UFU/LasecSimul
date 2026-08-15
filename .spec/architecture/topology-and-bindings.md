---
id: ARCH-006
kind: architecture
status: active
dependsOn: [ARCH-001]
supersedes: []
---

# Topologia e bindings por domínio

## Regra

O canvas pode ser unificado, mas os domínios não são fundidos em um solver universal.

- fios elétricos alimentam `Netlist`/MNA;
- linhas de sinal alimentam `SignalPlan` tipado;
- links de protocolo alimentam contratos próprios;
- bridges são componentes explícitos entre domínios.

Cada endpoint declara domínio, tipo, largura, unidade e direção. A validação rejeita domínio/largura incompatíveis antes da execução.

## Elétrico

`Netlist::Topology`, resolução slot-to-node, grupos e `ComponentMatrixView` são a base do `ElectricalPlan`. Rebuild acontece em mutação estrutural, não a cada passo. Reuso de grupos e padrão esparso deve ser preservado.

## Sinais

Strings e aliases existem apenas na autoria/compilação. Runtime usa slots densos. Conversão de unidade é pré-compilada quando inequívoca.

## Bindings externos

Python, PLC, protocolos e UI recebem handles compilados. Nenhum runtime externo resolve nomes percorrendo todos os componentes durante um passo.

## Aceitação

- nenhum link implícito entre domínios;
- erro de tipo/largura/unidade aponta os dois endpoints;
- mudança visual não invalida topologia;
- mudança estrutural invalida apenas planos relacionados;
- projetos headless produzem a mesma topologia da UI.
