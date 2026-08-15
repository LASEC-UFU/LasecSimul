---
id: FEAT-004
kind: feature
status: planned
dependsOn: [ARCH-002, ARCH-006, SCHEMA-002]
supersedes: []
---

# Subsistemas e templates compilados

Autoria preserva hierarquia; runtime pode achatar a instância.

## CompiledSubsystemTemplate

Chaveado pelo hash de documento normalizado, dependências filhas, schemas e ABIs referenciadas. Pode compartilhar validação, tabela local, topologia estrutural, SCCs, RateGroups, metadados e assets imutáveis.

Cada instância remapeia índices locais para globais e possui estado, matrizes, fatorações, processos e buffers próprios. Solução/fatoração mutável não é compartilhada entre instâncias.

## Estratégia incremental

1. cachear parse, normalização e validação;
2. cachear plano de sinal/template estrutural;
3. medir padrão MNA reutilizável;
4. somente então avaliar templates de padrão esparso.

## Aceitação

- ciclo de dependência é rejeitado;
- instâncias não colidem e não compartilham estado;
- template hit evita recompilação estrutural;
- resultado elétrico equivale ao circuito expandido manualmente;
- mudança em filho invalida pais pelo hash transitivo.
