# ADR 0009 — Localização de strings declarativas (labels, grupos, taxonomia da paleta)

Status: aceito e implementado | Depende de: `.spec/lasecsimul.spec` seção 6.1-6.3,
`.spec/lasecsimul-native-devices.spec` seção 4.2.2.1

## Contexto

O pipeline de schema de propriedades (ver seção 6.1/6.1.3 de `lasecsimul.spec`) acabou de ficar 100%
declarativo: todo rótulo, grupo e nome de propriedade — de built-in ou de plugin — vem de um
`PropertySchema` (C++, registrado em `ComponentMetadataRegistry`) ou de `.lsdevice` (plugin), nunca mais
de inferência na Webview. O mesmo vale pro catálogo da paleta (`component-catalog.json`,
`items[].label`/`folderPath`).

Hoje toda essa string é texto solto em português, decidido implicitamente pelo autor de cada arquivo —
built-ins em C++ (`"Resistência"`, `"Elétrica"`), plugins em `.lsdevice` (`"Tensao medida"`, `"Leitura"`),
catálogo em JSON (`"Resistor"`, `"Passivos"`). Quem constrói um dispositivo novo (plugin de terceiro, e no
futuro um subcircuito publicado) não tem como declarar que escreveu em outra língua, nem fornecer
tradução — e o projeto não tem mecanismo pra escolher entre línguas mesmo que houvesse.

O usuário pediu explicitamente, ao revisar o pipeline de schema: que toda string visual (propriedades E
nomes de pasta da paleta) tenha uma "opção de língua" — quem constrói o dispositivo informa em que língua
(ou línguas) construiu, e o sistema usa a língua certa conforme configuração, com fallback pra língua que o
autor de fato forneceu quando a solicitada não existir.

## Decisão

1. **`LocalizedString = string | Record<string, string>`** — todo campo declarativo visível (nome de
   componente, rótulo/grupo de propriedade, rótulo de opção de enum, label/segmento de `folderPath` da
   paleta) aceita ou uma string simples (língua única) ou um mapa BCP-47→string (múltiplas línguas). Campo
   técnico não-traduzível (`id`, `typeId`, `unit`) continua `string` puro — nunca virou `LocalizedString`.
2. **`language` é obrigatório, `translations` é opcional**, declarados na raiz de cada manifesto/catálogo
   (`.lsdevice`, `component-catalog.json`, fonte registrada). `language` diz em que língua estão os
   campos `string` simples do resto do arquivo; `translations.<lang>` é um subconjunto dos mesmos campos,
   só o que foi de fato traduzido — campo faltante em `translations` cai pra `language`, nunca pra string
   vazia.
3. **Resolução por fallback determinístico, mesmo algoritmo nos dois processos** (Core em C++, Extension em
   TypeScript, sem dependência cruzada): língua ativa solicitada → `language`-base do manifesto → primeira
   entrada disponível no mapa. Nunca lança erro, nunca devolve string vazia.
4. **Resolução acontece antes de chegar na Webview** — Core resolve ao responder `getPropertySchemas`
   (recebe `language` no payload do request); Extension resolve o catálogo local
   (`component-catalog.json`/fontes registradas) com o mesmo algoritmo. A Webview nunca vê um mapa de
   tradução, só o resultado já resolvido — coerente com a Webview não ter acesso a `vscode.*`
   (ADR 0007, desacoplamento de UI).

## Alternativas consideradas e descartadas

- **Arquivo de tradução externo por língua** (estilo Qt Linguist `.ts`, que o próprio SimulIDE-dev usa —
  `resources/translations/simulide_pt_BR.ts`, referenciado em `lasecsimul.spec` seção 13.1): descartado
  porque exige um formato/ferramenta nova (extração de strings, compilação `.ts`→binário) só pra resolver um
  problema que aqui é pequeno (poucos campos por manifesto) — embutir a tradução no próprio JSON do
  manifesto/catálogo evita uma segunda fonte de verdade pra sincronizar, ao custo de não ter ferramenta de
  tradução colaborativa dedicada (aceitável: cada manifesto já é mantido por um autor/poucos autores, não
  por uma comunidade de tradutores como o SimulIDE tem).
- **Negociação de idioma no protocolo (Core "sabe" o idioma ativo e empurra mudanças)**: descartado — o
  Core é stateless quanto a isso; cada request de metadata carrega o idioma desejado explicitamente, sem
  estado de sessão sobre idioma. Mais simples, sem necessidade de um verbo "setLanguage" nem de invalidar
  cache quando o usuário troca o idioma do VSCode em runtime (raro, mas precisaria de notificação).
- **Resolver no lado do Core também pro catálogo (`component-catalog.json`)**: descartado — esse arquivo é
  lido direto pela Extension, sem o Core no meio (`UnifiedCatalog.ts`); forçar uma viagem IPC só pra
  resolver string de catálogo adicionaria latência sem necessidade. Os dois algoritmos de resolução são os
  MESMOS (seção 6.3.3 de `lasecsimul.spec`), só implementados duas vezes — descrito uma vez, codificado
  duas, igual a outras decisões já tomadas no projeto (ex: taxonomia de paleta existe como dado em
  `component-catalog.json`, lido só pela Extension, nunca pelo Core).

## Consequências

- Todo `.lsdevice`/`component-catalog.json` existente continua válido sem alteração — `language`
  ausente é tratado como "pt-BR implícito" (`CoreApplication.cpp::loadDeviceLibraryFile`,
  `UnifiedCatalog.ts::loadUnifiedCatalog`); todo arquivo NOVO deve declarar `language` explicitamente
  (normativo, RNF12 de `lasecsimul.spec`).
- **Implementado**: Core (`ComponentMetadataRegistry::language`/`translationsJson`,
  `resolvePropertySchemaForLanguage`, payload `language` em `getPropertySchemas`); Extension
  (`CoreClient.getPropertySchemas(language)` com `vscode.env.language`, `UnifiedCatalog.ts::
  resolveLocalizedItems`); exemplo real de tradução `en` em `devices/voltmeter/.lsdevice`
  (`displayVoltage`) e em `project/schema/component-catalog.json` (todos os 8 itens) — validado de
  ponta a ponta por teste (`testGetPropertySchemasOverIpc`, `UnifiedCatalog.test.ts`).
- Builtins continuam só com `language: "pt-BR"` (default), sem tradução nenhuma fornecida — pedir
  outra língua pra um built-in cai pra pt-BR sem erro (caminho de fallback exercitado pelo teste).
- Strings de log/erro do Core e da própria UI da Extension (comandos, menus) ficam fora deste mecanismo —
  são responsabilidade de l10n nativo do VSCode (`vscode-nls`), uma decisão independente, não tomada aqui.
