# ADR 0006 - Instrumentos virtuais como plugin nativo (ABI), não código built-in

## Objetivo

Registrar a reversão da decisão original sobre onde instrumentos virtuais (voltímetro,
osciloscópio, multímetro, gerador de função, analisador lógico) vivem no Core.

## Escopo

Instrumentos virtuais conectados a nós/pinos arbitrários do circuito (RF06 de
`.spec/archive/legacy-v2/lasecsimul.spec`). Não afeta componentes passivos/fontes built-in (resistor, capacitor,
indutor, fonte DC, terra, túnel, chave) nem MCUs via QEMU.

## Status

Aceita — substitui o texto original de `.spec/archive/legacy-v2/lasecsimul.spec`, seção "Fora de escopo do MVP atual
(decisão deliberada)", que dizia "Instrumentos virtuais... como código nativo de primeira classe no
núcleo — não como plugin de terceiros".

## Contexto

A decisão original presumia que instrumentos, por serem "primeira classe", deveriam ser built-in
como resistor/capacitor. Na prática, ao implementar o primeiro instrumento real (voltímetro DC),
verificou-se que:

- A ABI de plugin nativo (`device_abi.h`) já expõe `LsdnMatrixView::get_node_voltage` e
  `add_conductance` dentro de `stamp()` — exatamente o que um voltímetro precisa, com o mesmo custo
  de chamada de um built-in (chamada de função direta em processo único, sem IPC — ver
  `lasecsimul-native-devices.spec`).
- Construir cada instrumento novo como built-in exigiria recompilar e religar o Core a cada
  instrumento — o oposto do RF07 ("permitir que terceiros contribuam novos componentes... sem
  recompilar o Core"), e sem nenhum benefício de desempenho real sobre o caminho de plugin.
- O único obstáculo real não era a ABI em si, mas duas lacunas de infraestrutura que afetavam
  IGUALMENTE qualquer plugin (não só instrumentos): `addComponent` não repassava `pins` do payload
  pra `ComponentParams::pinList` (então `NativeDeviceProxy` nunca tinha pinos válidos), e
  `loadDeviceLibrary` nunca tinha implementação (então nenhum plugin ficava ativo no
  `GlobalPluginCache`). Resolvidas essas duas, um instrumento via plugin funciona de ponta a ponta
  sem tocar no núcleo do solver.

## Decisão

Instrumentos virtuais são plugins nativos (DLL/SO) via `device_abi.h`, como qualquer outro
dispositivo de terceiros — não código built-in no Core. O primeiro exemplo é
`devices/voltmeter` (`instruments.voltmeter`), que mede tensão DC entre dois pinos.

Decisões de implementação que acompanham esta ADR:

- Leitura de um valor calculado por um instrumento (built-in ou plugin) volta pro chamador via um
  verbo IPC genérico, `getComponentState` — bytes opacos de `IComponentModel::getState()`, o mesmo
  mecanismo já usado por capacitor/indutor para persistir estado dinâmico. Não há verbo IPC por
  tipo de instrumento (ex: nunca existiu nem deve existir um `getVoltmeterReading`).
- Instrumentos que precisam só de `stamp()`/`get_node_voltage` (não de `pin_declare`/GPIO dinâmico)
  não dependem do bridge `LsdnHostApi` real (`host_ctx`), que ainda não existe (`create(nullptr,
  nullptr)` em `PluginRuntime::createDeviceInstance` — ver docs/mvp-limitacoes.md). Instrumentos
  que precisarem de `pin_declare` (ex: um analisador lógico com canais configuráveis em runtime)
  continuam bloqueados até esse bridge existir.

## Alternativas consideradas

- Manter built-in no Core: descartada — sem benefício de desempenho sobre plugin (mesma chamada
  direta), e contradiz RF07 ao exigir recompilar o Core por instrumento novo.
- Built-in para o primeiro instrumento "de referência" e plugin pros demais: descartada por
  inconsistência — um desenvolvedor de terceiros não teria como saber, sem ler o código do Core,
  por que um instrumento é built-in e outro é plugin.

## Consequências

- `.spec/archive/legacy-v2/lasecsimul.spec` precisa de correção textual (a frase "não como plugin de terceiros" não
  vale mais) — ver próxima seção.
- Novo instrumento = novo plugin em `devices/`, registrado em `devices/library.json`, carregado via
  `loadDeviceLibrary` — não precisa mais de PR no Core.
- `addComponent` (IPC) sempre deve receber `pins` quando o typeId puder ser um plugin — built-ins
  ignoram, plugins dependem disso.

## Impacto no projeto

- Onde `.spec/archive/legacy-v2/lasecsimul.spec` disser "instrumentos como código nativo... não como plugin", o texto
  está desatualizado; esta ADR é a fonte de verdade atual.
- Próximo instrumento (ex: osciloscópio/traço de pino ao longo do tempo) deve seguir o mesmo padrão:
  plugin em `devices/`, estado lido via `getComponentState`, sem novo verbo IPC dedicado a menos que
  `getComponentState` realmente não baste.
