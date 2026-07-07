# ADR 0002 - Dispositivos Nativos vs WASM

## Objetivo

Registrar a decisão de usar plugins nativos como mecanismo ativo de extensão.

## Escopo

Dispositivos customizados e adapters nativos carregados pelo Core.

## Status

Aceita

## Contexto

O desenho histórico em WASM foi avaliado, mas o custo de IPC, worker e serialização no caminho crítico do solver tornaria o simulador lento para muitos componentes.

## Decisão

Dispositivos customizados usam plugins nativos DLL/SO carregados em processo pelo Core, com ABI C estável em `device_abi.h`.

## Alternativas consideradas

- WASM com `worker_threads`: descartado e mantido apenas como histórico em `.spec/archive/lasecsimul-wasm-devices.spec`.
- Plugins isolados por processo: descartados no caminho padrão por custo e complexidade.

## Consequências

- Melhor desempenho no hot path.
- Menos isolamento de segurança.
- ABI C precisa ser rígida e versionada.
- Crash guard e reinício do Core são mitigação, não sandbox.

## Impacto no projeto

Não propor WASM, `worker_threads` ou sandbox como arquitetura ativa sem nova ADR.
