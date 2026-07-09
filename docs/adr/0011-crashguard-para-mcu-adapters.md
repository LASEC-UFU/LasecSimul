# ADR 0011 - Contenção de crash/travamento para plugins de MCU (paridade com dispositivos ABI)

## Objetivo

Registrar por que `NativeMcuAdapterProxy`/`QemuModuleProxy` ganharam `CrashGuard`/`PluginWatchdog`
— mecanismo que `NativeDeviceProxy` (dispositivos ABI comuns) já tinha desde antes desta ADR.

## Status

Aceita — implementada.

## Contexto

A auditoria arquitetural de 2026-07-09 (`docs/25-auditoria-arquitetural-core-2026-07-09.md`, seção
2.2 e ranking §15 item 2) encontrou uma assimetria de robustez: toda chamada de `NativeDeviceProxy`
pra dentro de um plugin de dispositivo (`stamp`, `on_event`, `get_property`, `set_property`, etc.)
já passava por `CrashGuard::call` (SEH no Windows) e, pras chamadas com orçamento declarado
(`postStep`), por `PluginWatchdog` (thread dedicada com timeout, contendo também TRAVAMENTO, não só
crash). `NativeMcuAdapterProxy` e `QemuModuleProxy` (o equivalente pro lado de plugins de MCU/QEMU)
não tinham NENHUMA das duas proteções — um MCU adapter mal escrito (ou um módulo de periférico
concreto, ex: um `Esp32GpioModule` de terceiro) podia travar ou desreferenciar um ponteiro inválido
e derrubar o processo Core inteiro, sem `IMcuAdapter::health()` nenhum pra sinalizar o problema
antes disso (o método nem existia).

O usuário perguntou explicitamente se fechar essa lacuna comprometeria desempenho, já que
`McuComponent::stamp()` roda a cada `kPollIntervalNs` = 50 microssegundos — o caminho mais quente do
Core inteiro. A resposta, verificada no código (`core/src/plugins/CrashGuard.cpp`,
`core/src/plugins/PluginWatchdog.hpp`):

- `CrashGuard::call` no Windows x64 usa SEH **table-based** (não frame-based como x86 antigo) — o
  caminho feliz (sem exceção) não tem custo runtime mensurável; no POSIX é um passthrough direto
  (`fn(); return true;`).
- `PluginWatchdog::call` com `timeoutMs == 0` já cai direto em `CrashGuard::call`, sem criar thread
  nenhuma (comportamento pré-existente, documentado no próprio arquivo).
- Uma thread de watchdog COM timeout real (`timeoutMs > 0`) custa dezenas de microssegundos só pra
  criar — maior que o próprio período de poll de 50us, se aplicada ali.

## Decisão

Duas políticas diferentes, escolhidas pelo ponto de chamada:

1. **Caminho quente** (`QemuModuleProxy`, chamado por `McuComponent::stamp()`/
   `pollAndDispatchPendingEvents()` a cada 50us): `CrashGuard::call` puro, sem watchdog/thread —
   custo desprezível no caminho feliz, contém crash (não trava), mesma política que `stamp()` de
   `NativeDeviceProxy` já usa e pela mesma razão (síncrono por design, sem "último valor conhecido"
   seguro pra adiar).
2. **Caminho frio** (`NativeMcuAdapterProxy`: construtor — `get_memory_regions`/`get_pin_map`, 1x
   por instância; `buildLaunchArgs`/`createModules` — 1x por `loadFirmware`/construção; destrutor —
   1x no fim da vida): `PluginWatchdog::call` com timeout real (`kColdCallTimeoutMs = 5000`ms) —
   afiançável porque nunca roda no loop de 50us; contém tanto crash quanto TRAVAMENTO (loop
   infinito), que `CrashGuard` sozinho não pega.

`QemuModule::health()`/`IMcuAdapter::health()` (novos, default `Ok`, mesmo padrão de
`IComponentModel::health()`) sobem até `McuComponent::health()` (novo, agrega adapter + todo
módulo — `Faulted` se qualquer um faltar, senão `Lagging` se qualquer um atrasar, senão `Ok`).

Separadamente (mesma auditoria, achado independente): `PluginRuntime::createMcuAdapter` chamava
`vt->create(nullptr, nullptr)` — o `LsdnMcuHostApi` (`log`/`now_ns`) declarado na ABI nunca era de
fato passado, então qualquer plugin de MCU que tentasse usá-lo sofria null-pointer dereference.
Corrigido: `kMcuHostApi` real (log→stderr, now_ns→wall-clock `steady_clock`, já que não há
`Scheduler` disponível na hora em que o adapter é criado — tempo simulado de verdade só existe
depois, dentro de `McuComponent`/`QemuModule`).

## Alternativas consideradas

- **Aplicar `PluginWatchdog` com timeout também no caminho quente**: descartada — custo de criar
  thread por chamada (dezenas de us) estouraria o orçamento de 50us do poll, exatamente a
  preocupação de desempenho levantada pelo usuário.
- **Não fazer nada, manter a assimetria**: descartada — não havia registro de decisão de design
  explícita justificando essa lacuna; era um buraco de implementação, não uma escolha deliberada.

## Consequências

- ABI C (`mcu_abi.h`) não muda — nenhum plugin de MCU já compilado (só ESP32 hoje) precisa ser
  recompilado.
- `NativeMcuAdapterProxy`'s construtor/`buildLaunchArgs`/`createModules` agora podem LANÇAR
  `std::runtime_error` quando uma chamada fria crasha/trava (antes: derrubava o processo inteiro,
  sem exceção nenhuma pra capturar) — comportamento estritamente melhor, mas é uma mudança
  observável de "processo morre" pra "exceção C++ limpa" que testes/chamadores devem esperar.
- Novo teste dedicado, `McuCrashResilienceTest` (`core/test/core/plugins/McuCrashResilienceTest.cpp`,
  Windows-only — POSIX não contém SEH), prova os dois caminhos com uma vtable sintética que
  deliberadamente desreferencia um ponteiro nulo.

## Impacto no projeto

- `.spec/lasecsimul-native-devices.spec` seção 22/23 precisa registrar que MCU agora tem `health()`
  e contenção de crash simétrica à de dispositivo comum (ver atualização correspondente nesta mesma
  rodada).
- Qualquer MCU adapter de terceiro futuro (além do ESP32) já herda essa proteção automaticamente,
  sem precisar de nenhuma mudança própria.
