---
id: FEAT-006
kind: feature
status: deferred
dependsOn: [FEAT-001, ARCH-004, ARCH-005]
supersedes: []
---

# Runtime Python

## Modelo inicial

Um worker Python por sessão, criado sob demanda e limitado pelo Governor. Cada bloco possui namespace/módulo isolado dentro do worker. Blocos do mesmo timestamp/RateGroup são enviados por `STEP_BATCH` em ordem do plano.

O Core fornece timestamp e entradas; Python não consulta wall clock para semântica. IPC começa em JSON batelado e só migra para binário após benchmark.

## Falhas

Timeout de parede protege a operação, mas não define tempo simulado. Crash/timeout pausa a sessão, marca o domínio Python como `Faulted`, encerra o worker e invalida estado não checkpointado.

Worker dedicado exige isolamento solicitado, dependência incompatível, biblioteca nativa de risco ou carga longa comprovada, além de orçamento.

## Segurança

Python não é sandbox de segurança forte. SharedHost deve executar o processo sob identidade/containment do usuário, com workdir, ambiente, filesystem e rede definidos pelo deployment.

## Aceitação

- batch determinístico;
- limites de payload/memória/processos;
- timeout/crash/restart testados;
- worker nunca é compartilhado entre usuários;
- dependências e ambiente entram no diagnóstico reproduzível.
