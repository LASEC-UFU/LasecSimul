# ADR 0007 - UI desacoplada do VSCode: o protocolo IPC é o único contrato

## Objetivo

Registrar a exigência de que a Extension VSCode seja substituível por outro shell de UI (ex: app Flutter)
sem mudar o Core, e corrigir o ponto concreto onde isso já não era verdade.

## Escopo

Fronteira entre `LasecSimul Core` (processo nativo) e qualquer shell de UI que fale com ele — hoje só a
Extension VSCode, no futuro potencialmente outro(s).

## Status

Aceita

## Contexto

O Core já era host-agnóstico por construção (RNF03/RNF06 de `.spec/lasecsimul.spec`: não conhece Qt nem
VSCode, só fala o protocolo de IPC). Ao implementar `loadDeviceLibrary` nesta rodada, apareceu um ponto
concreto onde uma decisão de *configuração* (quais `library.json` carregar) tinha vazado pra um mecanismo
específico do VSCode: `extension/package.json` declara isso via `contributes["lasecsimul.deviceLibraries"]`,
o *contribution point* nativo de extensões VSCode. Um shell Flutter não tem `package.json` nem `contributes`
— teria que reinventar essa declaração do zero, sem fonte de verdade compartilhada com a Extension.

## Decisão

O contrato entre Core e qualquer shell de UI é exclusivamente: (a) o protocolo de IPC (named pipe/socket +
JSON, versionado por `protocolVersion`) e (b) os formatos de arquivo em disco (`.lsproj`, `.lsdevice`,
`library.json`, e `.lssubcircuit` de subcircuitos — ver ADR 0008). Nenhuma decisão de protocolo ou de
"o que carregar" pode depender de um mecanismo exclusivo de um host.

Correção registrada (implementação pendente, ver `.spec/lasecsimul.spec` seção 1.1 e RNF10): a declaração de
bibliotecas de dispositivo/subcircuito a carregar precisa migrar de `contributes` do VSCode para algo
host-agnóstico — um arquivo de configuração próprio do projeto, ou descoberta automática pelo próprio Core
de pastas convencionais (`devices/`, `mcu-adapters/`, `subcircuits/`) relativas a si mesmo.

## Alternativas consideradas

- Manter a declaração em `contributes` e aceitar que um shell futuro duplique essa lista: descartada — viola
  a própria exigência (a configuração teria duas fontes de verdade divergentes possíveis).
- Mover a decisão pro Core via flag de linha de comando fixa (`--devices-dir`, sem arquivo de config):
  considerada, mais simples, mas menos flexível pra múltiplos projetos com bibliotecas diferentes na mesma
  máquina — não descartada, é candidata real na implementação, mas não fechada nesta ADR.

## Consequências

- Nenhum tipo de dado específico do VSCode (`Uri`, `WebviewPanel`, `TreeItem`) pode cruzar a fronteira IPC —
  já era verdade na prática (tudo no protocolo é JSON simples), agora é regra explícita.
- Um shell alternativo reimplementaria seu próprio cliente de protocolo (equivalente a `CoreClient.ts`) e sua
  própria renderização — sem reuso de código de UI entre frameworks, só de protocolo/formato de arquivo.
- A Extension de hoje continua sendo o único shell implementado; esta ADR não cria trabalho de implementar
  Flutter agora, só impede decisões que tornariam isso mais caro depois.

## Impacto no projeto

- Ao adicionar qualquer configuração nova que afete o que o Core carrega/expõe, perguntar: "um shell sem
  VSCode conseguiria fornecer isso?" — se a resposta for não, a decisão está no lugar errado.
- Corrigir a lacuna de `contributes["lasecsimul.deviceLibraries"]` é trabalho pendente, não fechado por esta
  ADR — só a decisão de que precisa ser corrigido está registrada aqui.
