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
- endpoints PLC exportados ligam-se ao domínio de sinal por bindings tipados;
- links de protocolo alimentam contratos próprios;
- bridges são componentes explícitos entre domínios.

Cada endpoint declara domínio, tipo, largura, unidade e direção. A validação rejeita domínio/largura incompatíveis antes da execução.

## Elétrico

`Netlist::Topology`, resolução slot-to-node, grupos e `ComponentMatrixView` são a base do `ElectricalPlan`. Rebuild acontece em mutação estrutural, não a cada passo. Reuso de grupos e padrão esparso deve ser preservado.

## Sinais

Strings e aliases existem apenas na autoria/compilação. Runtime usa slots densos. Conversão de unidade é pré-compilada quando inequívoca.


## Subsistemas e dispositivos compostos

Uma porta externa de composto é um endpoint normal do respectivo domínio. O shell visual nunca é uma topologia paralela.

`interface[].portId` é a identidade externa estável. `interfaceBindings[]` resolve essa porta para um endpoint interno durante compilação. Após resolução, o runtime usa slots/handles densos; não procura caminhos hierárquicos por nome.

Regras:

- `package.pins[].id` referencia `portId`, mas geometria não define conectividade;
- uma porta de entrada pode alimentar fan-out interno normal;
- fan-in exige semântica explícita do domínio/bloco e nunca implica soma automática;
- remover uma porta conectada gera binding órfão;
- um composto aninhado é semanticamente equivalente a expandir seu grafo interno;
- bridges entre domínios continuam explícitos mesmo quando estão dentro de um composto.

Importação TDPS deve converter índices globais e `Mnn` em edges/bindings explícitos antes desta fase.

## PLC

O componente PLC é um consumidor/produtor tipado do `SignalPlan`; sua linguagem IEC interna não aparece na topologia externa.

Antes de existir `PlcCompiledArtifact`, o bloco é topologicamente válido com **zero endpoints**. Após load/build, `exportedIo[]` gera endpoints.

Cada endpoint PLC possui identidade estável `ioId`. Bindings persistem por `ioId`, não por nome, posição visual ou índice do array.

- rename com mesmo `ioId`: preserva binding;
- I/O removido: binding órfão e erro acionável;
- I/O novo: endpoint desconectado;
- tipo/largura alterados: binding é revalidado e pode bloquear `RUN`;
- `VAR_IN_OUT` exige semântica de binding compatível e não pode ser convertido silenciosamente para cópia simples.

FUNCTIONs e FUNCTION_BLOCKs internos ao programa PLC não viram endpoints do canvas automaticamente. Apenas símbolos explicitamente exportados pelo manifesto compõem a interface externa do bloco PLC.

## Bindings externos

Python, PLC, protocolos e UI recebem handles compilados. Nenhum runtime externo resolve nomes percorrendo todos os componentes durante um passo.

## Aceitação

- nenhum link implícito entre domínios;
- bloco PLC sem artefato possui zero endpoints e pode permanecer no projeto;
- pinos do PLC são derivados apenas de `exportedIo[]` validado;
- rename de I/O não quebra ligação quando `ioId` é preservado;
- remoção nunca reconecta automaticamente um fio a outro I/O;
- erro de tipo/largura/unidade aponta os dois endpoints;
- mudança visual não invalida topologia;
- mover/redesenhar pino de composto preserva conexão pelo `portId`;
- interface externa de composto e target interno são validados antes de `RUN`;
- mudança estrutural invalida apenas planos relacionados;
- projetos headless produzem a mesma topologia da UI.
