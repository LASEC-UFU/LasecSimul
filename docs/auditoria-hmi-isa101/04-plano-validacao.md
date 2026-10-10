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
