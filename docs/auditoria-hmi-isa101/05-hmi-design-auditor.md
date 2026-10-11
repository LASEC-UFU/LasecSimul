# Especificação proposta: HMI Design Auditor

## Estado do protótipo no produto

O editor já oferece a ação `Verificar HMI` na barra de autoria. Ela verifica referências de componente ausentes, bindings para fontes inexistentes ou sem `readoutFormat`, índices de canal inválidos, destinos de navegação inexistentes, páginas inalcançáveis desde a inicial, controles sem alvo e propriedade de ação válidos, dimensões inválidas, IDs duplicados de página/elemento/atalho e elementos/atalhos que ultrapassam o viewport. Para elementos e atalhos, coordenadas precisam ser finitas e largura/altura positivas; geometrias inválidas não são confundidas com posição fora da página. IDs repetidos são tratados no escopo da página e não se seleciona arbitrariamente uma ocorrência. A análise de duplicidade e alcance usa mapas lineares no volume de objetos, evitando comparações quadráticas no projeto. O resultado é informativo; os achados navegáveis abrem a página e selecionam o elemento existente, inclusive quando sua referência de componente está quebrada. A checagem não move elementos, altera bindings, bloqueia operação ou declara conformidade.

Isso cobre um subconjunto estrutural da primeira etapa. O auditor verifica bindings, navegação, limites, faixas numéricas, ordem dos limites, unidades escalares, estruturas de página e ações de operador. Unidades iguais sem conversão são aceitas; unidades ausentes ou divergentes sem escala/offset geram aviso; transformações não são declaradas compatíveis automaticamente e exigem revisão humana. As regras estão em `hmiAudit.ts`, um motor que recebe aplicação, componentes e catálogo e devolve achados com IDs estáveis. A interface exporta relatórios JSON e HTML autocontidos (schema de relatório v2) e limitados a metadados/achados. Exceções auditáveis por regra/página/elemento, filtros por status, perfis locais versionados e fingerprints SHA-256 canônicos das entradas de auditoria e do catálogo já estão implementados. O pacote de evidências não é assinado e não autentica a origem dos arquivos.

`hmiAudit.test.ts` cobre composição estática, referências quebradas, canal e unidade, páginas inalcançáveis, indicação visual de alarmes, ausência de mutação, filtros, perfis, fingerprints e contratos JSON/HTML e exceções. Um fixture exercita cada ID de regra registrado. O instante de avaliação é uma entrada explícita do motor, inclusive para validade de exceções. O HTML usa marcação semântica e escapa todos os textos dinâmicos. A interface apresenta justificativa e próximo passo, exporta e navega os achados; fornece ao motor a lista de propriedades editáveis dos alvos de ação. A lista permite filtrar por página, componente, regra, severidade e status. As regras habilitáveis têm IDs genéricos; IDs extras de plugins são preservados e reportados, mesmo sem implementação local conhecida.

O auditor tambem avisa quando `graphics.hmi.alarm_banner` aparece numa pagina. A tarja compara valores com limites configurados e apresenta uma indicacao visual; ela nao implementa prioridade, reconhecimento, historico ou servico de alarmes. O aviso e informativo e nao altera o widget.

## Objetivo e limite

Ferramenta de análise estática de um projeto HMI que encontra inconsistências objetivas, riscos de operação e evidências faltantes. Deve ajudar o engenheiro a revisar uma aplicação; não declarar automaticamente conformidade com ANSI/ISA-101 nem substituir revisão normativa, de processo, usabilidade ou segurança.

## Entrada e saída

**Entrada:** `.lsproj` e futuro manifesto HMI versionado; catálogo usado; perfil de viewport/projeto; perfil de regras controlado; baseline opcional de tags, unidades e componentes aprovados.

**Saída:** relatório JSON e HTML acessível (schema v2), com regra/versão, severidade de engenharia, confiança da detecção, caminho de evidência, recomendação, disponibilidade de auto-fix, perfil ativo e fingerprints SHA-256 das entradas. A exportação redige por padrão nomes, mensagens dinâmicas e justificativas de exceção; o operador pode optar por incluí-los após confirmação. As regras atuais declaram explicitamente que não têm correção automática; o caminho de evidência preserva IDs técnicos, não valores brutos. O export não inclui texto protegido da norma nem assinatura digital. IDs de requisito e conteúdo normativo só podem vir de registro local autorizado e são administrados pelo responsável competente.

## Esquema de achado

```json
{
  "ruleId": "HMI.BINDING.SOURCE_EXISTS",
  "ruleVersion": 1,
  "engineeringSeverity": "error",
  "confidence": "high",
  "scope": {"pageId": "page-1", "componentId": "c-7"},
  "observed": {"bindSource": "missing-tag"},
  "rationale": "A origem configurada não existe no manifesto de tags do projeto.",
  "recommendation": "Selecione uma tag válida ou remova o binding.",
  "evidence": [{"kind": "project-path", "path": "pages[0].components[6].properties.bindSource"}],
  "normativeMapping": null,
  "exception": null
}
```

O campo `normativeMapping` é opcional e só aponta para ID cadastrado por revisor autorizado; não contém cópia do requisito. `engineeringSeverity` não representa severidade normativa ou risco de processo sem análise de domínio.

## Regras iniciais

### Erro de engenharia

- binding sem origem existente, incompatibilidade de tipo/unidade declarada, componente/action target inexistente, ação aponta propriedade não gravável, página sem rota alcançável, ID duplicado, schema/pacote incompatível, widget dinâmico sem fonte requerida.
- assets com proveniência/licença ausente no manifesto da distribuição.

### Aviso de revisão

- elemento fora do viewport de projeto; ausência de indicação visual de qualidade para tag dinâmica; estado depende somente da cor; ação sem texto/feedback configurado; densidade/legibilidade exige verificação de usuário; uso de símbolo estático em tela operacional sem ligação semântica.
- alarme desenhado apenas como widget visual sem declarar a fonte de um serviço de alarmes.
- telas ou grupos com inventário de bindings acima do perfil de carga configurado. O limite vem do perfil, nunca de um default atribuído à norma.

### Informação

- elementos sem binding explicitamente marcados decorativos; referências de página, agrupamento, reutilização; cobertura de testes vinculada ao manifesto.

O auditor não calcula aceitabilidade de alarme, segurança de processo, qualidade ergonômica ou correção semântica a partir da aparência. Tais pareceres requerem profissional e contexto.

## UX do relatório

- Filtros por página, componente, regra, severidade e status implementados. Status: em aberto, com exceção, exceção vencida e exceção revogada.
- Exceção append-only vinculada à chave estável regra/página/elemento; exige responsável e justificativa, aceita validade opcional e registra data. Revogação cria novo evento sem apagar a decisão anterior.
- A trilha acompanha o documento HMI em `.lsproj` e `.lssubcircuit`, aparece nas exportações JSON/HTML e é preservada em undo/redo.
- O nome do responsável é informado pelo operador; este recurso registra a atribuição declarada, mas não autentica identidade nem substitui controle de acesso ou assinatura digital.
- O perfil ativo salvo com o HMI tem `schemaVersion`, nome, versão e IDs desativados. A interface lista regras genéricas; regras adicionais/desconhecidas são preservadas e também aparecem no relatório. As exportações registram o perfil e fingerprints SHA-256 das entradas analisadas, sem incluir o conteúdo bruto.
- Saltar para componente no editor, destaque sem alterar o documento.
- Explicação curta que diga o fato observado e o próximo passo.
- Ações de correção apenas para transformação determinística e reversível, com preview e undo; sem escrita automática em regras protegidas.
- Estado “revisão humana requerida” separado de “passou”. Um zero findings significa apenas que as regras habilitadas não encontraram problemas.
- Relatório exportável com versão de catálogo, perfil, hash do projeto e data de execução.

## Requisitos de implementação e verificação

1. Motor puro sobre DTO imutável; sem Core ativo nem rede.
2. Perfis de regras versionados, carregados localmente e legíveis.
3. Testes unitários para positivos/negativos, dados malformados, determinismo e estabilidade de localização.
4. Golden projects que incluem cada falha reportada e cada exceção.
5. Contrato de plugin para regras adicionais assinado/revisado; desligar regra precisa aparecer no relatório.
6. Verificação de que saída não incorpora textos protegidos, credenciais ou valores sensíveis de projeto sem opt-in.
7. Teste de acessibilidade e usabilidade da lista com engenheiros.

## Roadmap

1. Protótipo offline com 10 regras estruturais de schema/binding/ID/alvo/viewport.
2. Diagnóstico de qualidade, unidade, alarm declaration e actions após os respectivos serviços existirem.
3. Visual checks parametrizados por resolução e perfil de projeto.
4. Integração de rastreabilidade licenciada apenas como referências locais opacas revisadas.
5. Exportação de pacote de evidência de release sem selo/certificado automático.
