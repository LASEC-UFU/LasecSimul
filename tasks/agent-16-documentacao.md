# Agente 16 - Documentação

## Objetivo

Manter README, docs, ADRs e tarefas consistentes com `.skill` e `.spec`.

## Escopo

Documentação operacional, ADRs e tarefas por agente.

## Contexto

A documentação operacional existe para coordenar agentes paralelos. Specs continuam sendo fonte de verdade.

## Arquivos que pode criar

- `docs/*.md`.
- `docs/adr/*.md`.
- `tasks/*.md`.
- `examples/*/README.md`.

## Arquivos que pode modificar

- `README.md`.
- `docs/**`.
- `tasks/**`.

## Arquivos que não pode modificar

- `.spec/**` sem decisão explícita do usuário.
- `.skill/**` sem decisão explícita do usuário.
- Código de produção, salvo correções de links em comentários se autorizado.

## Dependências

- Todos os agentes.
- Specs existentes.
- ADRs aceitas.

## Interfaces obrigatórias

- Documentos devem apontar para fonte de verdade.
- ADRs devem registrar mudanças arquiteturais relevantes.
- Tarefas devem ter escopo claro por agente.

## Tarefas

- [ ] Revisar README quando scripts mudarem.
- [ ] Atualizar docs quando contratos mudarem.
- [ ] Criar ADR para decisão arquitetural nova.
- [ ] Marcar decisões superseded quando necessário.
- [ ] Manter tarefas sincronizadas com estrutura real.
- [ ] Verificar que WASM não aparece como solução ativa.
- [ ] Verificar que QEMU permanece no Core.
- [ ] Verificar que Extension não recebe solver.
- [ ] Revisar links locais.
- [ ] Revisar critérios de aceite do MVP.

## Testes obrigatórios

- [ ] Links principais existem.
- [ ] Todos os agentes têm tarefa.
- [ ] Todos os ADRs têm seções obrigatórias.
- [ ] README não virou spec gigante.
- [ ] Docs não contradizem `.spec/archive/legacy-v2/lasecsimul.spec`.
- [ ] Docs não contradizem `.spec/archive/legacy-v2/lasecsimul-native-devices.spec`.

## Critérios de aceite

- Documentação orienta implementação real.
- Tarefas são acionáveis por agentes independentes.
- Decisões aceitas não são reabertas sem ADR.

## Riscos técnicos

- Documentação genérica demais.
- README duplicar specs.
- Tarefas permitirem mudanças fora de escopo.

## Observações de integração

Ao final de cada onda do MVP, este agente deve revisar os documentos afetados e registrar mudanças relevantes.

## O que não fazer

- Não propor WASM ativo.
- Não alterar specs sem autorização.
- Não documentar arquitetura diferente da implementada.
