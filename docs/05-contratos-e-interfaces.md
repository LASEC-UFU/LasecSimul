# 05 - Contratos e Interfaces

## Objetivo

Registrar os contratos conceituais mínimos que todos os agentes devem respeitar.

## Escopo

Contratos de arquitetura. Assinaturas finais pertencem aos arquivos C++/TS.

## Core C++

- `IComponentModel`: expõe `typeId`, pinos, `stamp`, `postStep`, serialização de estado, `propertyDescriptors()`
  (edição de propriedade em runtime — painel de propriedades, ver seção 6.1 do `.spec`) e não conhece UI.
- `IMcuAdapter`: descreve QEMU, argumentos de launch, regiões MMIO, mapa de pinos, dependências externas e
  `createModules()` (devolve os `QemuModule`s concretos — chip-específicos — que o chip usa).
- I2C/SPI/UART não têm interface própria: são decodificados bit a bit pelo próprio componente/device a
  partir de `ComponentEvent{kPinChangeEventTag}` (detecção de borda em `SimulationSession::settleStep()`),
  sem módulo de barramento intermediário — ver `docs/17-pendencias-pos-sessao-qemu-abi.md` seção 0.4.
- `MnaSolver`: recebe grupos do `Netlist`, aplica stamps via `ComponentMatrixView`, resolve com Eigen e devolve tensões/correntes.
- `Scheduler`: controla tempo, eventos, dirty tracking e settle loop sem IPC no caminho crítico.
- `Netlist`: resolve pinos, fios, túneis por nome, nós, grupos galvanicamente conectados e listeners por nó.
- `SimulationSession`: dona de `Netlist`, `Scheduler`, registries por sessão, `PluginRuntime` e `QemuProcessManager` da sessão.

## Registries

- `ComponentRegistry`: registra factories instanciáveis de componentes built-in ou proxies nativos.
- `ComponentMetadataRegistry`: registra metadados de UI e schema sem exigir instanciação.
- `McuRegistry`: resolve `chipId` para o `IMcuAdapter` correspondente — sempre via plugin nativo
  (`NativeMcuAdapterProxy`, `mcu_abi.h`); não existe caminho built-in.

## Plugins

- `PluginModule`: representa uma DLL/SO carregada e mantida viva por `shared_ptr`.
- `PluginLoader`: descobre, valida ABI e carrega binários.
- `PluginRuntime`: cria instâncias por sessão a partir do módulo ativo.
- `NativeDeviceProxy`: adapta `LsdnDeviceVTable` para `IComponentModel`.
- `NativeMcuAdapterProxy`: adapta `LsdnMcuVTable` para `IMcuAdapter`.

## QEMU

- `QemuProcessManager`: cria, monitora, para e mata o processo QEMU.
- `QemuArenaBridge`: abre memória compartilhada, lê eventos de registrador, despacha por faixa de endereço e injeta resultados no Core.
- `FirmwareWatcher`: vigia (por polling de `mtime`) a pasta de firmware configurada; ao detectar artefato
  novo, aciona o mesmo caminho de kill+respawn do reset do `QemuProcessManager` — nunca exige reload manual.

## IPC e projeto

- `IpcServer`: servidor do Core para comandos de controle, projeto e eventos discretos.
- `CoreClient`: único ponto de comunicação da Extension com o Core.
- `ProjectSerializer`: lê/escreve `.lsproj`, valida schema e preserva compatibilidade.

## Regras de fronteira

- ABI de plugin é C estável, sem STL, exceções ou RTTI.
- Mensagens IPC são versionadas.
- Telemetria contínua pode ser lossy; eventos discretos devem ser confiáveis.
- UI e Extension não podem bypassar `CoreClient`.
