# ADR 0015 - Atividade do Laboratório de Cálculo persistida em `calculusLab` dentro do `.lsproj`

## Objetivo

Definir onde e como a definição de uma atividade é salva.

## Status

Aceita; implementada para as atividades Limites e Tanque (`validateCalculusLab`, 2026-10-17). Editor de atividades: M6 de
[`docs/54`](../54-laboratorio-calculo-validacao-e-riscos.md).

## Contexto

A atividade referencia componentes, portas e parâmetros do mesmo projeto. Um arquivo à parte se perderia em cópias e
renomeações. O loader do `.lsproj` exige igualdade estrita de `schemaVersion` (2): subir a versão invalidaria todos os
projetos do repositório por causa de um campo opcional.

## Decisão

- Campo opcional `calculusLab` ao lado de `hmiApplication`, com `schemaVersion` próprio (1); `LS_PROJ_SCHEMA_VERSION`
  não muda.
- Persistir só a definição (expressões em texto, parâmetros e faixas, gráficos, objetos, etapas, ritmo). Não persistir
  séries, cursor, Δt, vistas correntes, respostas de alunos nem estado de execução.
- Referência quebrada não impede abrir o projeto: vira achado de auditoria.

## Consequências

- Projetos sem laboratório não mudam. Modo aluno não suja o documento (ajustes de parâmetro não são gravados).
