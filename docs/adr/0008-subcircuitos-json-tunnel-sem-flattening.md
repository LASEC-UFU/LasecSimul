# ADR 0008 - Subcircuitos como dado (JSON), via Tunnel, sem flattening antecipado

## Objetivo

Registrar a decisão de como subcircuitos (circuitos reutilizáveis criados no próprio editor) são definidos,
expostos como I/O e resolvidos em simulação.

## Escopo

Terceiro caminho de extensibilidade de componente, ao lado de biblioteca padrão (C++ built-in) e plugin
nativo (DLL/SO, ADR implícita em `lasecsimul-native-devices.spec`).

## Status

Aceita

## Contexto

O projeto já tinha dois caminhos pra estender o catálogo de componentes — biblioteca padrão e plugin nativo
— ambos exigindo código (C++ ou C, compilado). Faltava um caminho pra reutilizar uma combinação de
componentes já existentes (ex: um divisor resistivo usado em vários projetos) sem escrever nada — o pedido
era "igual ao que o SimulIDE faz". Investigação do SimulIDE-dev (`src/components/subcircuits/`,
`src/components/connectors/tunnel.cpp`, `src/components/other/subpackage.cpp`) mostrou que o mecanismo dele
se apoia em três peças, duas das quais o LasecSimul já tinha equivalente: `Tunnel` unindo pinos por nome
(LasecSimul já tem, `Netlist::setTunnelName`) e um editor de símbolo visual reaproveitando o canvas do
esquemático (já especificado pra plugins nativos, `lasecsimul-native-devices.spec` seção 21). Só faltava a
terceira: o formato de arquivo do circuito interno + a regra de expansão em simulação.

## Decisão

Um subcircuito é um arquivo `*.lssubcircuit` com três blocos: `components`/`wires` (mesmo schema de `.lsproj`),
`interface` (mapeia pino público → nome de túnel interno) e `package` (mesmo bloco visual de `.lsdevice`,
reaproveitado sem alteração). Ao instanciar (`addComponent`), o Core expande os componentes internos
diretamente na `SimulationSession` ativa — sem matriz MNA separada, sem flattening feito pela Extension —
prefixando cada nome de túnel interno com o id da instância (`<subcircuitInstanceId>::<nome>`), mesmo
princípio de `SubCircuit::addPin()` do SimulIDE (`m_id + "-" + id`). O pino externo do subcircuito é o
próprio pino do `Tunnel` interno renomeado — não existe um `IComponentModel` "subcircuito" fazendo ponte.

Subcircuito não passa pela cerimônia de confiança/consentimento de plugin nativo (`lasecsimul-native-devices.spec`
seção 12) — é dado, nunca código executável; não há risco de memória a mitigar.

Especificação completa: `.spec/lasecsimul-subcircuits.spec`.

## Alternativas consideradas

- Subcircuito como `IComponentModel` próprio, delegando internamente pra uma `SimulationSession`/`Netlist`
  filha (caixa-preta com matriz própria): descartada — diverge do mecanismo validado do SimulIDE (que resolve
  tudo numa matriz única via `Tunnel`), e introduziria um segundo tipo de fronteira de solver
  (multi-sessão aninhada) sem necessidade real — `lasecsimul.spec` seção 4 já declara explicitamente que
  múltiplas sessões não são suportadas hoje.
- Formato XML (espelhando `.sim1`/`.sim2` do SimulIDE) em vez de JSON: descartada — todo o resto do
  LasecSimul já usa JSON (`.lsproj`, `.lsdevice`, protocolo IPC); introduzir XML só pra subcircuito
  quebraria consistência sem ganho.
- Arquivo de símbolo separado do circuito interno (espelhando `.package` separado do SimulIDE): descartada
  pela mesma razão já registrada em `lasecsimul-native-devices.spec` seção 21.1 — JSON não tem a limitação de
  mistura de formato que motivava separar no SimulIDE.

## Consequências

- `removeComponent` precisa de uma variante de remoção em cascata pra instância de subcircuito (remover
  todos os componentes internos criados na expansão, recursivamente para nesting).
- `addComponent` devolve um payload estendido (`exposedPins`) quando o `typeId` é subcircuito — mudança
  aditiva no protocolo, não quebra clientes que só esperam `instanceId`.
- O renderizador de símbolo da Webview precisa migrar de `switch(typeId)` hardcoded pra um modelo
  data-driven (`package` por entrada de catálogo) pra subcircuitos (e plugins) aparecerem com símbolo
  próprio sem exigir mudança de código da Extension a cada novo subcircuito criado pelo usuário.

## Impacto no projeto

- Nenhum subcircuito deve ser implementado como `IComponentModel`/factory no `ComponentRegistry` — a
  composição de instâncias já existentes (seção 5 do spec) é o único mecanismo válido.
- Novo trabalho de instrumento/dispositivo reutilizável que só combina componentes já existentes deve ser
  avaliado primeiro como candidato a subcircuito, antes de virar plugin nativo ou built-in.
