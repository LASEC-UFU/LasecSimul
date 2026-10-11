# Plano de validação e resultados desta auditoria

## Evidência já executada

| Verificação | Resultado | Escopo e limite |
|---|---|---|
| `npm --prefix extension test` | Passou, exit code 0 | Suíte configurada do pacote extension; sem afirmar contagem agregada de testes. Não inclui todos os testes de Core real listados abaixo. |
| `npm --prefix extension run test:hmi:visual` | Passou, exit code 0 | Renderizou os dez widgets HMI numa folha visual. Comprova renderização da amostra; não é teste de legibilidade operacional, interação ou adequação normativa. |
| `graphicsLibrary.test.js` | 35 passou, 0 falhou | Catálogo/lógica gráfica focada. Executado com cwd `extension`, requerido pelo loader do catálogo. |
| `graphicsBinding.test.js` | 13 passou, 0 falhou | Projeção de binding; não prova qualidade temporal nem E2E. |
| `graphicsAction.test.js` | 7 passou, 0 falhou | Resolver de ações; não valida autorização/interlock de produto. |
| `tdpsProcessScreens.test.js` | 10 passou, 0 falhou | 24 subcircuitos de processo, IDs, bindings, layers e round-trip; isso não representa sistema de páginas HMI. |
| `dsl/graphicsDslRoundTrip.test.js` | 6 passou, 0 falhou | Round-trip da DSL; inclui a limitação de que posições não são persistidas na DSL. |
| Testes focados combinados | 71 passou, 0 falhou | Soma dos cinco arquivos acima. |
| `heatedTankTt301.realCore.test.js` | 4 passou, 0 falhou | Core real; logs repetem aviso MnaSolver sobre grupo de quatro nós singular e tensão definida em 0 V: 5.996 ocorrências no log capturado. Causa não determinada. |
| `hartTt301Thermocouple.realCore.test.js` | 6 passou, 0 falhou | Core real e cenários de termopar/HART; 8 avisos iguais no log. Causa não determinada. |
| `electricFurnaceTt301.realCore.test.js` | 6 passou, 0 falhou | Core real; 12.009 avisos iguais no log. Causa não determinada. |
| Git após validações | Limpo antes de criar esta documentação | Artefatos gerados pelo teste estavam ignorados. Nenhum código funcional foi alterado nesta auditoria. |

Uma execução focada anterior a partir da raiz falhou porque o loader resolve o catálogo relativo ao diretório corrente. Reexecutada de `extension`, passou conforme acima; a falha foi de invocação, não reproduziu como falha do produto.

## Plano de verificação antes de alegar conformidade

Todos os critérios quantitativos devem ser definidos por processo, ambiente, operadores, plataforma e texto autorizado aplicável. Não se adotam limites universais inventados nesta auditoria.

### 1. Rastreabilidade

- Construir matriz requisito→aplicabilidade→design→implementação→teste→evidência, com edição e aprovadores.
- Revisão independente de cada interpretação normativa e de cada alegação pública de conformidade.
- Confirmar direitos de uso de código, ícones e vetores redistribuídos.

### 2. Projeto e navegação

- Testar criação, edição, import/export, migração e abertura de aplicações com múltiplas páginas.
- Verificar rotas, parâmetros, retorno, referências inválidas e degradação em páginas removidas.
- Observar tarefas reais com operadores representativos em displays/resoluções/distâncias do destino; medir conclusão, erros e tempo, e refinar com usuários.

### 3. Binding e qualidade

- Casos de valor válido, fora de faixa, inválido, sem binding, unidade incompatível, atualização atrasada e fonte desconectada.
- Verificar timestamp, estado de qualidade e transição entre atual/frozen/stale/disconnected em visual, faceplate e diagnóstico.
- Interrupção/reconexão; garantir que retenção de último valor nunca pareça valor fresco.
- Benchmark de quantidade de tags e frequência definidos por projeto; medir latência do Core à tela, CPU/memória e comportamento em backpressure.

### 4. Alarmes

- Transições com relógio controlado: entrada/saída, repetição, reconhecimento, shelving/supressão se adotados, usuário, alteração de prioridade, perda da fonte e recuperação.
- Consistência do banner, lista, detalhe, estado de evento e histórico; revisar cenários com especialista de processo.

### 5. Tendências

- Variáveis com unidades, escalas, lacunas, stale, troca de página, zoom temporal, retenção e reinício.
- Comparar amostras e tempos apresentados com fonte de verdade; teste de volume conforme retenção do projeto.

### 6. Comandos

- Executar controles em edit/run, alvo ausente, propriedade inválida, limites, interlock verdadeiro/falso, autorização insuficiente, resposta atrasada, rejeitada, duplicada, timeout e reconexão.
- Cobrir canvas, overlay e qualquer interface alternativa com a mesma política e telemetria de auditoria.
- Confirmar feedback com readback e comportamento seguro em falhas através de cenário real; aprovação pelo responsável de segurança/processo.

### 7. Visual e recuperação

- Revisão de símbolos e estados por pessoa licenciada contra referências autorizadas; testes de redundância além da cor, contraste/legibilidade e tarefas de reconhecimento com usuários.
- Variações de janela/escala, foco/teclado, condições de daltonismo e acessibilidade pertinentes ao produto.
- Cenários de crash/restart, indisponibilidade de fonte, Core parado, arquivo parcialmente inválido e recuperação.

## Lacunas da validação presente

Não houve E2E de click-to-Core via browser, sessão de operador, testes de autorização (não há modelo observado), navegação entre páginas, perda/reconexão de canal, carga/performance instrumentada, teste formal de usabilidade, validação de símbolos contra edição licenciada, nem root cause dos avisos MNA. A imagem `hmi-widget-sheet.png` comprova somente a renderização pontual. Portanto os testes verdes sustentam capacidades delimitadas, não conformidade.

## Continuidade da Fase 2 - unidades de binding

| Verificacao | Resultado | Escopo e limite |
|---|---|---|
| `graphicsBinding.test.ts` focado em binding, unidades e configuracao | 16 casos passaram, 0 falharam | Inclui a classificacao da tarja de alarme como indicacao visual; conversao dimensional nao e inferida. |
| `npm test` apos a checagem de unidade | Passou, exit code 0 | Suite configurada da extensao, incluindo compilacao da Webview, host e testes; nao substitui validacao de processo. |
| `tsc --noEmit -p ./tsconfig.webview.json` | Passou, exit code 0 | Confirma compilacao estatica do editor/verificador HMI. |
| `npm test` apos aviso da tarja visual | Passou, exit code 0 | Suite completa configurada da extensao; inclui regressao do verificador e os testes de HART/PLC ja presentes no HEAD. |
| `hmiAudit.test.ts` | 7 passaram, 0 falharam | Motor puro e export: entrada estatica, referencia/canal/unidade/rota, escopo de componente (inclusive referencia quebrada), tarja visual, filtros, nao mutacao, determinismo, privacidade JSON e escaping HTML. |
| `npm test` apos extracao do motor de auditoria | Passou, exit code 0 | Compila host e Webview, executa a suite completa da extensao e inclui `hmiAudit.test.ts`, HART e PLC. |
| `npm test` apos export JSON | Passou, exit code 0 | Inclui compilacao da Webview/extensao, suite completa e o teste do formato de exportacao. |
| `npm test` apos export HTML | Passou, exit code 0 | HTML acessivel e autocontido; o teste confirma que textos dinamicos sao escapados. |
| `npm test` apos filtros da lista | Passou, exit code 0 | Inclui compilacao host/Webview, regressao dos filtros e suite com HART/PLC. |
| `git diff --check` | Passou | Sem erros de whitespace nas alteracoes atuais. Git reportou apenas avisos de conversao LF/CRLF do checkout Windows. |

## Excecoes auditaveis e filtro por status

- Cada excecao registra evento append-only ligado a regra, pagina e elemento HMI, com responsavel declarado, justificativa, data e validade opcional. Revogar adiciona evento novo e mantem a trilha anterior.
- O filtro apresenta achados em aberto, com excecao, vencidos ou revogados; as exportacoes JSON e HTML incluem status e decisao.
- Cobertura adicionada para vinculo/status da excecao, filtro e round-trip `.lsproj`, incluindo rejeicao de justificativa/responsavel vazios.
- O registro nao autentica o responsavel: identidade e permissao dependem de controles externos do ambiente.
- Perfil local versionado permite habilitar/desabilitar cada regra por ID; IDs desativados, inclusive extensões desconhecidas, aparecem nos relatórios. Versão do perfil avança somente quando há mudança.
- Perfil é salvo junto à aplicação HMI em `.lsproj`/`.lssubcircuit`; validação rejeita nome/versão/IDs duplicados inválidos.
- `hmiAudit.test.ts`: 12 passaram, incluindo chave genérica, última decisão, vencimento com relógio controlado, filtros, perfil versionado, fingerprints, exportação da trilha e pelo menos um fixture para cada ID de regra registrado.
- O motor recebe o instante de avaliação explicitamente; chamadas iguais com o mesmo instante continuam determinísticas também para exceções vencidas.
- Exportação redige textos do projeto por padrão; nomes, mensagens dinâmicas e justificativas de exceção só entram após opt-in explícito. Teste cobre os dois modos.
- `ProjectSerializer.test.ts`: passou com round-trip `.lsproj` e rejeição de responsável/justificativa vazios; `tsc -p ./tsconfig.test.json --noEmit` também passou.
- `npm test`: passou, exit code 0, incluindo perfis de regras, exceções, fingerprints SHA-256 e round-trip HMI em projetos/subcircuitos. Inclui compilação host/Webview, persistência, HART (11 casos), PLC Build, IL e SFC lowering, mais o pós-teste IEC 61131/browser cross-language.
- `subcircuitDocument.test.ts`: 13 passaram, 0 falharam; o caso HMI confere igualdade estrutural sem depender da ordem das chaves JSON e preserva posições/rotações dos componentes esquemáticos.
- `git diff --check`: passou; apenas avisos de conversão LF/CRLF do checkout Windows.

## Continuidade — integridade geométrica e identidade dos elementos

- O auditor detecta IDs duplicados de elementos e atalhos dentro da mesma página e geometrias com coordenadas não finitas ou largura/altura não positivas. A verificação de viewport só roda para geometria válida, evitando classificar `NaN`/infinito como um simples elemento fora da página. Duplicidade e alcançabilidade usam mapas lineares no volume de dados.
- `hmiAudit.test.ts`: fixture positivo incluído para cada novo ID; o contrato do teste garante cobertura de todo o registro genérico de regras.
- Compilação da extensão e Webview, `tsc -p ./tsconfig.test.json` e `hmiAudit.test.ts`: passaram; 12 grupos de teste, incluindo um fixture acionador para cada regra registrada.
- `npm test` em `extension`: passou, exit code 0, após as mudanças; incluiu compilação host/Webview, suíte completa configurada, HART, PLC Build/IL/SFC/LD e matriz IEC 61131/browser pós-teste. Essa passagem não substitui revisão humana normativa nem validação com operadores.
- `git diff --check`: passou nesta continuidade.

## Continuidade — estado visual do comando HMI

- O E2E de conexão revelou que um toggle poderia comandar um valor numérico (por exemplo 0/5 V) que coincidia com o próprio `value` visual inicial do controle, deixando o alvo atualizado e o controle aparentemente inalterado.
- A interpretação foi centralizada em `graphicalActionDisplayValue`: toggles refletem ativo/inativo pelos valores configurados; momentâneos refletem pressionado/solto; comandos set/increment continuam refletindo booleano ou valor numérico. A mesma função atende canvas e overlays de subcircuito, sem caminho específico por dispositivo.
- `graphicsAction.test.ts`: 7 passaram; inclui toggle numérico e comando momentâneo textual. `hmiAudit.test.ts`: 12 passaram. Compilação host/Webview e testes TypeScript passaram.
- `npm run test:connections:e2e`: passou; verificou o caminho de conexão e ação HMI até a atualização do alvo e do desenho do controle.
