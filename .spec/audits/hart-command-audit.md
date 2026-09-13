---
id: AUD-001
kind: governance
status: active
dependsOn: [FEAT-013]
supersedes: []
---

# Auditoria independente dos comandos HART

Data: 2026-09-11  
Escopo: `HartCommunicationComponent`, `HartEngine`, `HartReferenceCatalog`, ponte do Property Inspector e endpoint HART legado.

## Atualização (mesma data, sessão seguinte)

Esta auditoria foi usada como ponto de partida real (não reauditada do zero)
para fechar parte dos gaps que ela lista. Mudanças concretas desde a versão
original abaixo -- a matriz por comando permanece válida como estava (nenhum
dos 55 comandos "eco fallback" ganhou corpo novo nesta sessão), mas a
infraestrutura mudou de forma que afeta diretamente o "Resultado executivo":

- **`HartCommandJson` deixou de ser um subconjunto plano.** Agora aceita e
  serializa o vocabulário completo (`write`/`resp`/`after`, `Set`, `If`/EQ,
  `Map`, `FOR_CODES`), não só `hex`/`variable`/`body`/`bodySlice`. Testado
  ponta a ponta (parse → compile → execute → `toJson()` → re-parse →
  re-compile → mesmo byte) em `HartEngineTest.cpp`.
- **Existe agora um parser real da Lasec DSL para corpos de comando HART**
  (`extension/src/dsl/HartCommandDsl.ts`), reaproveitando o MESMO lexer do
  DSL de circuito (`DslParser.ts::lex`) -- não uma segunda linguagem. Suporta
  cadeias (`A -> B -> out`), slices (`in[a:b]`), literais hex (`hex("...")`),
  `if <expr> == <expr> { ... } else { ... }`, e expansão fria do macro
  `IdentityBlock`. **Prova concreta**: a fonte DSL equivalente a 0x0B
  (`if in[0:6] == Tag { hex("00") -> out; IdentityBlock -> out } else { ... }`)
  foi parseada no lado TypeScript, o JSON resultante foi fixado como literal
  em `HartEngineTest.cpp`, e compilado/executado no lado C++ produzindo os
  MESMOS bytes golden que o AST manual de 0x0B -- primeira prova real
  cross-language de que "0x0B é DSL-representável" (item 1 da seção "Gaps
  que impedem PASS_DSL" abaixo, agora fechado para este UM comando).
- **Dois bugs reais foram encontrados e corrigidos durante essa verificação**,
  não hipotéticos: (1) `HartExpr::Kind::UserVariable` sempre codificava como
  Float32BE independente do `type` declarado da variável (UInt8/UInt16/Int16/
  Bool ficavam com 4 bytes errados) -- agora respeita o tipo real, com
  `PackedAscii` explicitamente rejeitado (não silenciosamente errado) até o
  modelo ganhar um slot de valor textual. (2) um id de comando custom que
  colide com um dos 55 ids padrão/vendor SEM handler dedicado derrubava o
  `HartPlanCompiler::compile()` inteiro ("duplicate HART command override"),
  o que significava que declarar um comando custom sob, por exemplo, 0x98
  ("Vendor Keepalive") quebrava a dispatch de TODOS os comandos do
  dispositivo, não só daquele -- corrigido em
  `HartCommunicationComponent::rebuildConfiguredPlan()`.
- **O que NÃO mudou**: os outros 54 comandos "eco fallback" continuam sem
  corpo real; `HartSemanticEndpoint`/o switch legado em
  `IndustrialProtocols.cpp` continuam publicados por
  `protocol.hart.transmitter`/`protocol.hart.communicator` (confirmado ainda
  registrados em `CoreApplication.cpp` -- remover exigiria uma história de
  migração fria para projetos existentes que usam esses typeIds, não feita
  nesta sessão); não existe editor visual de Command Graph (só o parser de
  texto); `IHartCommandHandler` continua disponível mas **zero** handlers de
  produção o usam (confirmado por busca, não apenas assumido).

Detalhe completo em `.spec/features/hart-device-engine.md` "Anexo D".

## Resultado executivo

O runtime novo possui um caminho compilado e bounded (`HartCommandCompiler` -> `HartCommandExecutor`), mas a implementação atual **não comprova 100% de comandos DSL-native**.

- Universo efetivo do catálogo: 60 comandos.
- Programas semânticos manuais compilados: 5 (`0x00`, `0x01`, `0x03`, `0x0B`, `0x21`). Eles usam o IR do compilador, porém ainda são construídos diretamente em C++, não derivados de uma fonte Lasec DSL parseada.
- Cobertura restante: 55 comandos gerados por um programa de eco `body -> response`. Isso é fallback de comportamento, não paridade de comando HART.
- `HartCommandJson` aceita uma coleção opaca de `responseSteps` (`hex`, `variable`, `body`, `bodySlice`); ainda não é o Command Graph/Lasec DSL unificado.
- `IHartCommandHandler` continua disponível no `HartEngine` e tem precedência sobre o program hook. Não há registro de handler de produção no caminho novo, mas a arquitetura ainda permite contornar o compilador.
- `HartSemanticEndpoint::execute` mantém um caminho legado com `command == 0/1/3`.

Conclusão: o hot path do caminho novo não interpreta DSL nem percorre SignalEngine, mas a meta de 100% DSL/Command Graph ainda **não está satisfeita**.

## Evidência de implementação

| Evidência | Local | Classificação |
|---|---|---|
| Compilador bounded e estimativa de pior caso | `core/src/protocols/HartCommandProgram.cpp` | presente |
| Executor de programa compilado | `core/src/protocols/HartCommandProgram.cpp` | presente |
| Hook de programa no engine | `core/src/protocols/HartEngine.cpp` | presente |
| Programas padrão | `core/src/protocols/HartReferenceCatalog.cpp` | 5 ASTs manuais + 55 ecos |
| Entrada customizada | `core/src/protocols/HartCommandJson.cpp` | JSON temporário/legado |
| UI customizada | `extension/src/ui/views/hartInspectorSections.ts` | JSON, não DSL |
| Handler nativo | `core/src/protocols/HartEngine.hpp/.cpp` | extensão paralela disponível |
| Switch legado | `core/src/protocols/IndustrialProtocols.cpp` | comandos 0, 1 e 3 |

## Matriz completa do catálogo

`DSL` indica existência de um programa no IR atual, não uma cadeia comprovada `Lasec DSL -> parser -> Command Graph -> compiler`.

| Command | Nome | DSL | Graph | IR | Legacy/native | Golden | Status |
|---:|---|---|---|---|---|---|---|
| 0x00 | Read Unique Identifier | manual AST | não | sim | não | parcial | DSL_PARTIAL |
| 0x01 | Read Primary Variable | manual AST | não | sim | não | sim | DSL_PARTIAL |
| 0x02 | Read Loop Current And Percent Of Range | eco fallback | não | sim | não | não | FALLBACK |
| 0x03 | Read Dynamic Variables And Loop Current | manual AST | não | sim | não | parcial | DSL_PARTIAL |
| 0x04 | Read Loop Current And Percent Of Range (common) | eco fallback | não | sim | não | não | FALLBACK |
| 0x05 | Read Dynamic Variables (common) | eco fallback | não | sim | não | não | FALLBACK |
| 0x06 | Write Polling Address | eco fallback | não | sim | não | não | FALLBACK |
| 0x07 | Read Loop Configuration | eco fallback | não | sim | não | não | FALLBACK |
| 0x08 | Read Dynamic Variable Classifications | eco fallback | não | sim | não | não | FALLBACK |
| 0x09 | Read Device Variables With Status | eco fallback | não | sim | não | não | FALLBACK |
| 0x0A | Read Expanded Device Status | eco fallback | não | sim | não | não | FALLBACK |
| 0x0B | Read Unique Identifier Associated With Tag | manual AST | não | sim | não | parcial | DSL_PARTIAL |
| 0x0C | Read Message | eco fallback | não | sim | não | não | FALLBACK |
| 0x0D | Read Tag, Descriptor, Date | eco fallback | não | sim | não | não | FALLBACK |
| 0x0E | Read Primary Variable Sensor Information | eco fallback | não | sim | não | não | FALLBACK |
| 0x0F | Read Device Output Information | eco fallback | não | sim | não | não | FALLBACK |
| 0x10 | Read Final Assembly Number | eco fallback | não | sim | não | não | FALLBACK |
| 0x11 | Write Message | eco fallback | não | sim | não | não | FALLBACK |
| 0x12 | Write Tag, Descriptor, Date | eco fallback | não | sim | não | não | FALLBACK |
| 0x13 | Write Final Assembly Number | eco fallback | não | sim | não | não | FALLBACK |
| 0x15 | Write Output Information | eco fallback | não | sim | não | não | FALLBACK |
| 0x21 | Read Device Variables | manual AST | não | sim | não | parcial | DSL_PARTIAL |
| 0x26 | Reset Configuration Changed Flag | eco fallback | não | sim | não | não | FALLBACK |
| 0x28 | Enter/Exit Fixed Current Mode | eco fallback | não | sim | não | não | FALLBACK |
| 0x29 | Trim DAC Zero | eco fallback | não | sim | não | não | FALLBACK |
| 0x2A | Trim DAC Gain | eco fallback | não | sim | não | não | FALLBACK |
| 0x2B | Write Transmitter Message | eco fallback | não | sim | não | não | FALLBACK |
| 0x2D | Write Polling Address (extended) | eco fallback | não | sim | não | não | FALLBACK |
| 0x2E | Write Loop Current Mode | eco fallback | não | sim | não | não | FALLBACK |
| 0x48 | Read Additional Transmitter Status | eco fallback | não | sim | não | não | FALLBACK |
| 0x50 | Read Dynamic Variable Assignment | eco fallback | não | sim | não | não | FALLBACK |
| 0x80 | Vendor Read Configuration | eco fallback | não | sim | não | não | FALLBACK |
| 0x82 | Vendor Read Device Identity | eco fallback | não | sim | não | não | FALLBACK |
| 0x84 | Vendor Read Sensor Configuration | eco fallback | não | sim | não | não | FALLBACK |
| 0x85 | Vendor Paged Read | eco fallback | não | sim | não | não | FALLBACK |
| 0x87 | Vendor Read Device Status | eco fallback | não | sim | não | não | FALLBACK |
| 0x88 | Vendor Read Device Parameters | eco fallback | não | sim | não | não | FALLBACK |
| 0x8A | Vendor Reset Error Flags | eco fallback | não | sim | não | não | FALLBACK |
| 0x8C | Vendor Read Calibration | eco fallback | não | sim | não | não | FALLBACK |
| 0x8E | Vendor Read Limits | eco fallback | não | sim | não | não | FALLBACK |
| 0x98 | Vendor Keepalive | eco fallback | não | sim | não | não | FALLBACK |
| 0x9C | Vendor Read Communication Status | eco fallback | não | sim | não | não | FALLBACK |
| 0xA0 | Vendor Paged Write/Read | eco fallback | não | sim | não | não | FALLBACK |
| 0xA2 | Vendor Read Block | eco fallback | não | sim | não | não | FALLBACK |
| 0xA4 | Vendor Read Alarm Configuration | eco fallback | não | sim | não | não | FALLBACK |
| 0xA6 | Vendor Read Device Variables | eco fallback | não | sim | não | não | FALLBACK |
| 0xA8 | Vendor Read Extended Block | eco fallback | não | sim | não | não | FALLBACK |
| 0xAD | Vendor Read Ordering Code | eco fallback | não | sim | não | não | FALLBACK |
| 0xB0 | Vendor Read Unit String | eco fallback | não | sim | não | não | FALLBACK |
| 0xB1 | Vendor Read Engineering Units | eco fallback | não | sim | não | não | FALLBACK |
| 0xB2 | Vendor Read Device Descriptor | eco fallback | não | sim | não | não | FALLBACK |
| 0xB3 | Vendor Read Primary Variable Units | eco fallback | não | sim | não | não | FALLBACK |
| 0xB4 | Vendor Read Secondary Variable Units | eco fallback | não | sim | não | não | FALLBACK |
| 0xB9 | Vendor Read Device Health | eco fallback | não | sim | não | não | FALLBACK |
| 0xBA | Vendor Read Upper Range | eco fallback | não | sim | não | não | FALLBACK |
| 0xBB | Vendor Read Device Type | eco fallback | não | sim | não | não | FALLBACK |
| 0xBD | Vendor Read Alarm Selection | eco fallback | não | sim | não | não | FALLBACK |
| 0xC6 | Vendor Read Firmware Information | eco fallback | não | sim | não | não | FALLBACK |
| 0xCC | Vendor Clear Status | eco fallback | não | sim | não | não | FALLBACK |
| 0xDF | Vendor Extended Identification | eco fallback | não | sim | não | não | FALLBACK |

## Gaps que impedem PASS_DSL

1. Não existe ainda uma fonte `.lsdsl`/Command Graph para os corpos dos comandos padrão.
2. O parser DSL da extensão não é usado para produzir `HartCommandDefinition`.
3. O IR atual não tem handles pré-resolvidos para variáveis nomeadas; variáveis customizadas ainda percorrem `UserVariable` por string no executor.
4. O hook prepara uma cópia de `HartDevicePlan` e resolve variáveis por `variable.id` em cada transação.
5. `HartCommandJson` suporta somente quatro passos de resposta e não representa `write`, `after`, `IF`, `MAP`, `FOR_CODES`, codecs tipados ou ownership.
6. O fallback de eco faz comandos não implementados parecerem suportados.
7. O endpoint legado com `command == 0/1/3` permanece publicado pela família `protocol.hart.transmitter/communicator`.
8. Não há goldens byte-a-byte para os 55 comandos restantes nem comparação pré/pós-migração.

## Próxima migração obrigatória

Antes de remover código legado, a implementação precisa:

1. caracterizar cada comando de referência com request, response, estado e efeitos;
2. adicionar os campos/handles HART necessários ao modelo sem lookup textual no hot path;
3. aceitar os corpos pela Lasec DSL/Command Graph e baixar para `HartCommandDefinition`;
4. substituir o eco por programas semânticos ou `NoImplementation` explícito;
5. comparar goldens e somente então remover `HartSemanticEndpoint`/`IHartCommandHandler` do caminho de comandos;
6. bloquear a inicialização se um comando declarado não tiver entrada compilada, em vez de instalar fallback.

## Fontes de referência auditadas

- `josuemoraisgh/process_simul`, commit `f79ac08faee6a98f1507bace64b1ae397db4b294`;
- `ININDII-UFU/EININDII07_PACTware_ProcessSimul`, commit `f12772f05e8eea4b4d68924211f9cafc7f7c37ed`;
- `core/src/protocols/*`;
- `core/test/core/protocols/HartEngineTest.cpp`;
- `.spec/features/hart-device-engine.md`.

## Validação executada

- `g++ -std=c++20 -fsyntax-only` nos arquivos HART e teste: passou;
- `npm test` da extensão: passou;
- `git diff --check`: passou;
- `node .spec/governance/check-specs.mjs`: falhou somente por duas referências antigas em arquivos externos `.piohome`, fora do escopo HART/DSL.
