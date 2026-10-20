# ADR 0018 - Documento, desfazer e telemetria com autoridade no Extension Host

## Objetivo

Definir onde vivem o documento visual, o histórico de edição e a distribuição de telemetria quando várias vistas
(acopladas, flutuantes, em tela cheia) mostram o mesmo projeto.

## Status

Aceita e implementada (2026-10-20): `extension/src/visual/screenStore.ts` (telas e Faceplates, revisão e desfazer por
documento no Host), ver [docs/65](../65-unificacao-visual-implementacao.md). Proposta em 2026-10-19; análise em [`docs/60`](../60-unificacao-visual-diagnostico-e-inventario.md) §11 e
[`docs/62`](../62-unificacao-visual-arquitetura-e-documento.md) §3, §11.

## Contexto

- A Webview do esquemático é a autora das edições e envia o estado inteiro (`projectChanged`); o desfazer de HMI/Faceplate
  vive na memória dela.
- Toda troca de janela recria a Webview (verificado), o que apagaria esse histórico.
- A telemetria só é entregue ao esquemático e só com ele aberto.
- Abrir um subsistema substitui o estado do Host e reconstrói o Core com o subsistema isolado.
- O Laboratório já mantém o desfazer da definição no Host — precedente que funciona.

## Decisão

- `ProjectDocumentStore`: o projeto raiz é independente da visão em edição; a simulação é a do projeto raiz.
- `VisualDocumentService`: operações com revisão, desfazer/refazer por documento e *patches* às outras vistas; uma trava
  de edição por documento.
- `TelemetryHub`: um `getTelemetryFrame` por tique com a união das assinaturas e *fan-out* por vista; séries
  compartilhadas com contagem de referências.
- `CommandGateway`: caminho único de escrita (propriedade, filho de subsistema, parâmetro com política, execução).
- Webviews são vistas reconstruíveis: no `ready`, recebem documento, revisão, sessão e último quadro.
- Editar Faceplate não reconstrói o Core.

## Consequências

- Dock/Undock/tela cheia sem perda de estado nem de histórico.
- Uma simulação, uma assinatura por sinal, independentemente do número de vistas.
- Refatoração do Host antes da extração do motor visual (Fase 4 do [`docs/63`](../63-unificacao-visual-plano-testes-riscos.md)).
