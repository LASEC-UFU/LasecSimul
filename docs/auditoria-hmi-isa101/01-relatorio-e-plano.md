# Auditoria técnica do HMI Designer e plano de adequação

**Repositório:** LasecSimul · **Data:** 10/10/2026 · **Escopo:** inspeção do código, testes existentes e artefatos visuais do workspace. **Natureza:** auditoria de produto; não é certificação nem parecer de conformidade ANSI/ISA-101.

## Sumário executivo

O projeto já oferece uma biblioteca gráfica ampla e um fluxo funcional de visualização do estado de componentes do simulador. A inspeção do catálogo encontrou **244 entradas `graphics.*`**: 239 com pacote vetorial declarativo e cinco primitivas desenhadas por caminhos especiais. Há **193 símbolos estáticos `graphics.pid.*`**, dez widgets `graphics.hmi.*`, 30 componentes com metadado `bindSource`, sete entradas com `actionTarget` e apenas um símbolo gráfico com pino no grafo de sinais (`graphics.slider`). Esses números descrevem o produto; não são pontuação de aderência à norma.

A separação mais importante é entre desenhos de P&ID e objetos HMI operacionais. Os 193 símbolos P&ID são formas estáticas, sem binding de processo. Os dez widgets HMI podem visualizar valores; os controles podem escrever propriedades genéricas de componentes. O sistema ainda não apresenta arquitetura de páginas e navegação HMI, gestão de alarmes, tendências de variáveis de processo com histórico, qualidade temporal da telemetria, papéis de usuário ou serviço de comando com confirmação e intertravamentos. O editor é um único canvas associado ao projeto/schematic; o filtro “Process” é categoria de paleta, não tela de operação.

A suíte `npm --prefix extension test` passou; também passaram a folha visual dos dez widgets, 71 testes focados e 16 testes Core reais de três cenários. Os testes Core registraram repetidamente avisos do solver sobre sistemas singulares e tensão definida como 0 V. A auditoria não investigou a causa. Não foi executado um E2E completo de operação na interface. Os resultados e limites estão em [Plano de validação](./04-plano-validacao.md).

**Conclusão de conformidade:** não se atribui nenhum requisito individual da ANSI/ISA-101 como confirmado, atendido ou violado. Esta etapa não processou o texto normativo integral. A classificação normativa e a rastreabilidade por cláusula dependem de cópia autorizada e revisão por profissional competente. Consulte também [Matriz](./02-matriz-rastreabilidade.md), que separa a situação do software da classificação normativa.

**Decisão recomendada:** manter o simulador Core como fonte única, evoluir primeiro o modelo de telas e o contrato de telemetria/qualidade, depois construir alarmes e tendências e, em seguida, encapsular comandos com permissões e feedback. Antes de qualquer declaração de conformidade ou uso comercial dos ativos derivados, revisar licenças e o texto integral autorizado da norma.

## Escopo, método e limites

Inspecionados: catálogo JSON e geradores; renderização vetorial e binding; ações gráficas; modelo de projeto; polling de estados; fluxo de overlays de subcircuito; testes unitários, round-trip DSL/TDPS, renderização de widgets e cenários Core reais. Foram usados apenas identificadores/referências normativas fornecidos pelo usuário e evidência do repositório. Não se transcreve, resume nem reconstrói conteúdo protegido de ISA. Não se acessou texto integral da norma para esta análise.

Os termos “atendido”, “parcial”, “não atendido” e “não verificado” nesta auditoria descrevem **capacidade observável do produto**, não uma conclusão sobre conformidade normativa. “Recomendação técnica” e “boa prática” são categorias de engenharia propostas pela equipe; sem confronto com cópia autorizada, não se afirma que qualquer item seja recomendação ou obrigação da norma.

### Entregáveis

1. Inventário de ativos: [Inventário do catálogo](./03-inventario-catalogo.md).
2. Diagnóstico técnico por capacidade: abaixo e matriz.
3. Matriz de rastreabilidade: [Matriz](./02-matriz-rastreabilidade.md).
4. Gaps e prioridades: abaixo e plano de fases.
5. Arquitetura proposta: abaixo.
6. Plano de fases: abaixo.
7. Estratégia e resultados de validação: [Plano de validação](./04-plano-validacao.md).
8. Especificação do HMI Design Auditor: [Especificação](./05-hmi-design-auditor.md).
9. Catálogo de componentes: [Inventário detalhado](./03-inventario-catalogo.md).
10. Resumo executivo: acima.

## Diagnóstico do produto existente

### Modelo, telas e persistência

`ProjectDocument` persiste versão do schema, componentes, fios/topologia, configuração visual/viewport, configurações de simulação e firmware (`extension/src/project/ProjectTypes.ts`, interface `ProjectDocument`). Não há coleção de telas/páginas HMI, hierarquia de navegação, níveis de visão, parâmetros de exibição por tela, ou transições operacionais. A experiência principal é um canvas. Subcircuitos TDPS são modelos reutilizáveis, e os demos de processo são projetos/circuitos separados; isso não equivale a uma aplicação HMI multipágina. A DSL gráfica não persiste posições segundo seu teste round-trip.

### Catálogo e visuais

O catálogo central é `project/schema/component-catalog.json`, carregado por `extension/src/catalog/UnifiedCatalog.ts` e expandido por `scripts/generate-graphics-library.mjs`, `scripts/generate-ipd-symbol-library.mjs` e `scripts/generate-ipd-hmi-library.mjs`. A renderização passa por `extension/src/ui/webview/componentSymbols.ts` e `simulidePaint.ts`, com casos especiais para cinco primitivas. Existem propriedades visuais por instância, mas não um sistema de tokens semânticos ou tema HMI configurável por projeto. A existência de símbolos de ISA-5.1 ou a aparência inspirada em determinada convenção não foi tomada como evidência de conformidade ISA-101 nem ISA-5.1.

A família `graphics.pid.*` contém formas para equipamentos e instrumentação, mas não estados operacionais vinculados. Catálogo vetorial não é um modelo de processo. Existem alguns widgets dinâmicos, mas não há cobertura operacional dinâmica equivalente para todas as famílias de equipamentos representadas pelos desenhos. O plano é **aproveitar esses ativos**: manter e reutilizar os símbolos como camada de apresentação, associá-los a instâncias reais do Core e complementar as famílias sem modelo, telemetria, estado ou comando. A meta não é redesenhar os 193 símbolos nem duplicar componentes que já existem no simulador.

### Binding e telemetria

`extension/src/ui/webview/graphicsBinding.ts` projeta valor, percentual, texto, estado ligado/desligado, alarme calculado por limites e qualidade simplificada nos visuais. Os metadados configuráveis incluem fonte/canal, escala, offset, faixa, unidades, casas decimais, limites e inversão. Foram contadas 30 entradas com `bindSource`; isso não significa que toda variável do processo tenha caminho de binding completo ou validado.

O host em `extension/src/core/coreLifecycle.ts` lê estados do Core em lotes. `ComponentReadoutValue` em `extension/src/core/messages.ts` é `number | number[]`, sem timestamp/qualidade persistidos no contrato. O intervalo de polling da interface é 300 ms (`INSTRUMENT_POLL_INTERVAL_MS` em `main.ts`). Falha de leitura ou estado ausente é ignorado no ciclo; não há idade do dado, política configurável de stale, diagnóstico de canal, sequência de amostras ou indicador consistente de perda de comunicação. A inspeção não mediu latência de ponta a ponta.

### Alarmes e tendências

`__g_alarm` e `graphics.alarm_indicator` calculam condição visual comparando valor com limites. `graphics.hmi_alarm_banner` apresenta informação visual. Não foi encontrado ciclo de vida de alarme com prioridade/estado, reconhecimento, shelving/supressão, origem temporal e histórico de eventos. Os próprios testes do indicador afirmam ausência de campos de acknowledgement. Logo, o banner não equivale a um subsistema de alarmes.

Osciloscópio e analisador lógico mantêm histórico e timestamps para suas próprias amostras. Isso não fornece tendência histórica das variáveis de processo vinculadas por binding. Mini gráficos aproximados de valores de instrumentos não foram considerados historian/trending de processo.

### Comandos e segurança operacional

`extension/src/ui/webview/graphicsAction.ts` resolve ações set, toggle, momentary e increment sobre propriedade de um componente alvo, com faixa/min/max quando configurado. Há sete entradas com `actionTarget`. Inputs e setpoints usam `window.prompt`; sliders dependem de arraste e o fluxo normal de canvas consome ações no modo de simulação em execução. O caminho de overlay de subcircuito (`applyBoardOverlayOperatorAction` em `main.ts`) escreve via `requestUpdateBoardOverlayProperty` e não tem checagem visível de permissões, intertravamento, confirmação de execução ou reconhecimento do Core. Os dois caminhos carecem de uma fronteira comum de comando industrial com resultado rastreável.

Não foi identificado sistema de papéis/autorização por usuário, separação de funções, auditoria de comandos ou tratamento padronizado de rejeição/timeout. Isso é uma lacuna de segurança funcional e de operação a tratar antes de declarar o produto como HMI de operação industrial.

### Testabilidade e limitações legadas

A suíte cobre catálogo, binding, ações, rendering, projetos, subcircuitos e outros módulos. Testes TDPS exercitam 24 subcircuitos e round-trip de persistência, mas não validam navegação entre telas HMI porque esse modelo não existe. A folha visual comprova que dez widgets renderizam amostras; não comprova legibilidade em distância/resolução operacional, acessibilidade, interpretação de alarmes ou execução de tarefas por operadores. O resultado do DSL round-trip registra que a posição dos símbolos não é armazenada pelo formato.

### Licença e proveniência

`docs/third-party/IPD_STUDIO_PROVENANCE.md` registra 193 ativos `graphics.pid.*` provenientes de port direto de vetores e dez widgets `graphics.hmi.*` adaptados, com licença PolyForm Noncommercial 1.0.0 indicada para esses materiais. Revisão jurídica é necessária antes de distribuição/uso comercial. O simulador Core não deve ser confundido com o IPD Studio de origem. Proveniência gráfica tampouco certifica semântica operacional ou conformidade normativa.

## Perguntas da auditoria

- **O que atenderia?** Nesta etapa, nenhum requisito normativo individual está confirmado. No nível de capacidade do produto, há catálogo vetorial, alguns widgets de valor, bindings e interação de simulador; veja a coluna de situação de produto na matriz.
- **O que atende parcialmente?** Visualização numérica/analógica, indicação simplificada de limites, controles locais e representação de processo existem em escopo limitado. Faltam, entre outros, qualidade temporal, ciclo de alarmes, historian de processo, navegação HMI e serviço protegido de comandos.
- **O que precisa alterar?** O plano prioriza modelo multipágina, contratos de dados com qualidade/tempo, alarmes, trends e comandos/identidade, seguidos por padrões visuais configuráveis e validação com usuários.
- **Como provar conformidade?** Para cada edição/cláusula aplicável, copiar os requisitos de fonte autorizada num registro controlado; um especialista decide aplicabilidade, método e evidência; vincular cada requisito a decisão de design, implementação, teste e evidência visual/operacional. Registrar edição, interpretação, exceções e aprovadores. Revisar os ativos/licenças. Executar análise de tarefas com operadores e condições representativas. Só então um responsável competente pode assinar uma conclusão, delimitando versão e escopo. Esta auditoria não fornece essa assinatura.

## Gaps principais e prioridade proposta

1. **P0 — Base de rastreabilidade normativa/licença:** obter acesso legítimo à edição aplicável e revisão humana autorizada; esclarecer uso comercial dos assets antes de distribuição.
2. **P1 — Aplicação HMI:** modelo persistente de telas, navegação e composição de visões; schema migration e import/export.
3. **P1 — Semântica e telemetria:** binding validado no author-time, dado com timestamp/qualidade/estado de comunicação, stale policy configurável por projeto, diagnóstico de fonte e unidade.
4. **P1 — Comandos:** gateway único para interações de canvas/overlay; permissões, condição de modo, validação, intertravamento definido pelo domínio, resultado/ack/timeout e trilha de eventos. Definir a política de edit mode contra operação acidental.
5. **P2 — Alarmes e trends:** alarm model com ciclo de vida configurável e eventos; amostragem/histórico de tags com retenção e tendências navegáveis.
6. **P2 — Sistema de apresentação:** tokens semânticos, padrões de cor/forma/estado, tamanhos e escalas de tela validados para tarefas; níveis de navegação a decidir com os usuários e especialistas, não presumidos como obrigação da norma.
7. **P3 — Cobertura de equipamentos e validação:** widgets operacionais para equipamentos prioritários e testes de uso, resiliência e desempenho com cargas representativas.

Essas prioridades expressam dependências de engenharia e risco, não severidade definida pela norma.

## Arquitetura-alvo proposta

1. **Catálogo e design system:** catálogo atual versionado como entrada; schemas de propriedade e bindings declarativos; tokens semânticos de projeto com papéis separados para estado, alarme, seleção e decoração; lint visual automatizado. Manter clara a distinção entre símbolo estático e widget operacional.
2. **Modelo de aplicação:** `HmiApplication` com páginas, rotas, navegação, parâmetros de viewport e bindings; migração versionada do `.lsproj`; referências estáveis a tags e equipamentos. Subcircuitos permanecem recursos reutilizáveis, não substitutos de páginas.
3. **Serviço de tags:** fonte única ligada ao Core existente, com amostras tipadas `{value, timestamp, quality, source, unit}`; validação de binding ao abrir/compilar; estado explícito de invalid/stale/communication loss; taxa e coalescência configuradas pelo projeto e medidas em cenário real. Nenhum segundo simulador.
4. **Alarm service:** configuração/versionamento, condição, prioridade definida com processo, estados e transições aprovados, ack/shelve/suppress quando aplicáveis, event journal, filtros e histórico. O desenho exato requer revisão de domínio e requisitos autorizados.
5. **Command service:** todos os widgets chamam serviço único; autorização/contexto, checagem de modo, pré-condições/interlocks, range validation, envio ao Core, correlação, resposta e timeout visíveis; persistência de evento. Falha e ausência de confirmação têm resultado explícito.
6. **Visuais e tarefas:** widgets usam contratos de valor/qualidade/alarme comuns; telas associam uma intenção de tarefa; navegação, overview/detail e faceplates definidos em workshops de processo/operação; estado degradado não depende apenas de cor.
7. **Auditoria e evidência:** HMI Design Auditor opera como análise determinística do projeto e exporta achados rastreáveis. Não anuncia certificação automática; achados requerem validação humana.
8. **Reuso e extensão incremental:** um registro de mapeamento associa cada símbolo P&ID existente a equipamento/tag/variáveis/estados do Core e, quando aplicável, a widget HMI existente. O renderer reutiliza o símbolo e projeta por cima estados/qualidade/bindings; serviços compartilhados complementam alarmes, trends e comandos. Só se cria modelo de dispositivo ou widget novo quando o inventário mostrar ausência funcional.

## Plano faseado

### Regra de implementação: reusar primeiro e preservar o layout existente

Antes de criar desenhos ou componentes, inventariar os 193 símbolos P&ID, os dez widgets HMI e os modelos de dispositivo já registrados no Core. Para cada família (bomba, válvula, tanque/vaso, motor, instrumento e outras), registrar: símbolo existente; typeId/modelo Core correspondente; estados e variáveis disponíveis; binding; widget/faceplate; comando; lacuna remanescente; licença e teste. Classificar cada caso como **reusar**, **ligar**, **complementar** ou **criar**. A primeira saída será uma tabela `símbolo → dispositivo Core → estados/tags → binding → widget → comando → gaps → testes`, que orienta o backlog e evita duplicar os desenhos existentes.

Na migração de projetos e telas, preservar a composição que o usuário já montou: IDs dos componentes, posição X/Y, dimensões, rotação, escala, ordem de camadas, grupos, viewport e coordenadas de fios/conexões. Não reposicionar automaticamente símbolos para acomodar binding, novos estados, alarmes ou páginas. Os novos dados devem ser associados ao componente mantendo sua geometria e lugar. Se alguma transformação de coordenadas for inevitável por incompatibilidade de schema, fornecer pré-visualização, conversão reversível e teste round-trip que confirme a posição visual antes/depois. Não gravar alterações de layout silenciosamente.

- **Reusar:** conservar geometria, IDs e posição dos símbolos atuais; usar os widgets dinâmicos e faceplates existentes sempre que cobrirem a tarefa.
- **Ligar:** associar símbolo já colocado a uma instância real do Core e às tags/estados dela sem deslocar o símbolo.
- **Complementar:** acrescentar ao dispositivo já existente os estados/readouts que faltem e completar widgets com qualidade, unidades, alarmes, histórico ou feedback de comando, mantendo a colocação do usuário.
- **Criar:** implementar modelo Core ou visual novo somente quando o mapeamento demonstrar que falta capacidade funcional; adicionar na tela sem mover elementos existentes.

Critérios de aceite dessa regra: migrar projeto representativo e comparar antes/depois; IDs e geometria permanecem estáveis; abrir/salvar/reabrir mantém a disposição; atualização de binding/runtime não altera o layout; nenhuma reorganização ocorre sem comando explícito do usuário.

### Fase 0 — Governança e requisitos controlados

Confirmar edição/licenças, acesso autorizado, escopo de processos, usuários, tarefas, dispositivos e ambiente operacional. Criar registro requisito→decisão→teste→evidência e inventário jurídico de assets. Saída: baseline aprovada por especialista.

### Fase 1 — Fundamentos do projeto

Projetar `HmiApplication`/páginas/rotas, schema migrations, versão de tokens e identidade estável de tags. Especificar compatibilidade e fallback de projetos legados. Saída: ADRs, schemas e protótipo navegável validado, preservando IDs e posições dos elementos legados.

### Fase 2 — Telemetria confiável

Tipar valor/unidade/timestamp/qualidade, validar sources e gerar estado de stale/disconnected; incluir diagnóstico e testes de carga. Definir tempos e limites a partir do processo, do runtime e da medição, sem inventar valores universais. Saída: UI e logs distinguem valor atual, inválido e indisponível; símbolos/widgets existentes mostram esses estados através do contrato comum.

### Fase 3 — Alarmes e histórico

Implementar ciclo e armazenamento de alarmes aprovado; tags históricas e tendências; cenários de supressão/retorno/falha adequados ao domínio. Completar o indicador e banner atuais para consumirem o serviço comum de alarmes, e estender os widgets existentes para tendência somente onde isso atender às tarefas. Saída: evidências de ponta a ponta com relógio controlado.

### Fase 4 — Comandos e autorização

Unificar caminhos de canvas/overlay, estados do editor/operação, autorização, interlocks, confirmação e trilha; adaptar botões, slider, setpoint e demais controles já existentes para chamar o gateway comum; criar controles adicionais só para lacunas de tarefa confirmadas. Saída: nenhum comando sem resultado explícito; aprovação de segurança de processo, com controles existentes nas mesmas posições.

### Fase 5 — Telas, padrões visuais e componentes

Montar overview e detalhes orientados por tarefas com os símbolos P&ID atuais e os widgets/faceplates existentes; complementar estados operacionais e widgets por família priorizada, sem redesenhar o catálogo inteiro. Aplicar estilos/tokens de projeto e rever por distância, resolução e condições do posto real. Saída: tabela de cobertura atualizada e conjunto de telas testado por operadores representativos.

### Fase 6 — Verificação independente e release

Executar matriz de rastreabilidade contra fonte licenciada, revisão de especialista, teste de usabilidade, desempenho e recuperação; corrigir gaps; registrar exceções e versão. Saída: pacote de evidências assinado com escopo explícito antes de qualquer declaração de conformidade.

## Implementação iniciada da Fase 1

Foi criada uma fundação persistente para HMI: `HmiApplication` aceita páginas com dimensões do projeto, elementos que referenciam componentes `graphics.*` já existentes e itens de navegação entre páginas. O serializer valida IDs, dimensões, destino da página inicial e o tipo gráfico quando a referência do componente ainda existe; referências órfãs são preservadas para recuperação posterior; o campo é opcional para projetos legados. A extensão mantém o modelo no estado do projeto e o inclui ao salvar, carregar e calcular alterações não salvas.

Cada instância de página guarda a própria geometria, separada de `ProjectComponent.visual`. Assim, adicionar uma página ou posicionar nela um elemento não muda as coordenadas atuais no canvas. Os gráficos da tela continuam referenciando os componentes do projeto, sem duplicar o dispositivo Core. O schema permanece na versão atual e o campo novo é aditivo/opcional.

A autoria HMI, o modo Operar, a navegacao interna posicionavel e o redimensionamento das paginas estao disponiveis no canvas. O modo de operacao inicia na pagina inicial, oculta ferramentas de autoria e mantem leitura/estado de runtime e acoes do operador durante a simulacao. Os atalhos usam caixas calculadas em regioes livres, podem ser arrastados no modo de autoria e nao reposicionam elementos existentes. Permanecem pendentes os testes round-trip especificos para paginas.
## Base de evidências no repositório

- `project/schema/component-catalog.json`: fonte catalogada; contagens derivadas em [inventário](./03-inventario-catalogo.md).
- `extension/src/catalog/UnifiedCatalog.ts`; `scripts/generate-graphics-library.mjs`; `scripts/generate-ipd-symbol-library.mjs`; `scripts/generate-ipd-hmi-library.mjs`: carga e geração.
- `extension/src/ui/webview/componentSymbols.ts`; `simulidePaint.ts`: renderização vetorial.
- `extension/src/ui/webview/graphicsBinding.ts`: projeção de valor e estado.
- `extension/src/ui/webview/graphicsAction.ts`: resolver de ação.
- `extension/src/ui/webview/main.ts`: canvas, ações, polling visual, overlays e intervalo 300 ms (constante por volta da linha 550; funções `applyBoardOverlayOperatorAction`, `renderBoardOverlaysFor`).
- `extension/src/core/coreLifecycle.ts` (`pollInstrumentReadouts`, por volta da linha 656); `extension/src/core/messages.ts` (`ComponentReadoutValue`).
- `extension/src/project/ProjectTypes.ts` (`ProjectDocument`, por volta da linha 138): forma persistida do projeto.
- `docs/third-party/IPD_STUDIO_PROVENANCE.md`: proveniência/licença dos ativos.
- `.spec/features/process-visualization.md`: escopo de visualização e lacunas descritas no feature spec; conferir status atual do código em vez de tomar números legados do documento como inventário.
- `extension/src/catalog/graphicsLibrary.test.ts`, `extension/src/ui/webview/graphicsBinding.test.ts`, `graphicsAction.test.ts`, `tdpsProcessScreens.test.ts`, `dsl/graphicsDslRoundTrip.test.ts`: testes focados mencionados no plano de validação.

## Referências fornecidas pelo usuário

- ANSI/ISA-101, série sobre interface homem-máquina para sistemas de automação de processos; edição e cláusulas aplicáveis a confirmar com o responsável técnico.
- ANSI/ISA-5.1, identificação e símbolos de instrumentação; edição aplicável a confirmar. A inspeção da proveniência gráfica não foi uma comparação de símbolos contra edição autorizada.

As referências são registradas para orientar uma revisão licenciada. Nenhum texto normativo foi reproduzido neste documento.
