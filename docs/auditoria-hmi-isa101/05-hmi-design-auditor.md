# Especificação proposta: HMI Design Auditor

## Estado do protótipo no produto

O editor já oferece a ação `Verificar HMI` na barra de autoria. Ela verifica referências de componente ausentes, bindings para fontes inexistentes ou sem `readoutFormat`, índices de canal inválidos, destinos de navegação inexistentes, páginas inalcançáveis desde a inicial, controles sem alvo e propriedade de ação válidos, dimensões inválidas, IDs de página duplicados e elementos/atalhos que ultrapassam o viewport. O resultado é informativo; os achados navegáveis abrem a página e selecionam o elemento existente, inclusive quando sua referência de componente está quebrada. A checagem não move elementos, altera bindings, bloqueia operação ou declara conformidade.

Isso cobre um subconjunto estrutural da primeira etapa abaixo. Os achados navegáveis abrem a página correspondente e selecionam o elemento quando ele ainda existe na cena. Ainda não há motor puro reutilizável, perfil versionado de regras, relatório JSON/HTML, verificação de unidade, análise de ações de operador ou exceções auditáveis. Esses itens permanecem como trabalho futuro.

## Objetivo e limite

Ferramenta de análise estática de um projeto HMI que encontra inconsistências objetivas, riscos de operação e evidências faltantes. Deve ajudar o engenheiro a revisar uma aplicação; não declarar automaticamente conformidade com ANSI/ISA-101 nem substituir revisão normativa, de processo, usabilidade ou segurança.

## Entrada e saída

**Entrada:** `.lsproj` e futuro manifesto HMI versionado; catálogo usado; perfil de viewport/projeto; perfil de regras controlado; baseline opcional de tags, unidades e componentes aprovados.

**Saída:** relatório JSON e HTML acessível, com regra e versão, severidade de engenharia, confiança, página/componente/caminho, valor observado, justificativa, recomendação, referência de evidência e opção de exceção assinada. Exportação não inclui texto protegido da norma. IDs de requisito e conteúdo normativo só podem vir de registro local autorizado e são administrados pelo responsável competente.

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

- Filtros por página, componente, regra, severidade de engenharia e status.
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
