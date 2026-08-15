---
id: GOV-001
kind: governance
status: active
dependsOn: []
supersedes: []
---

# Governança das especificações

## Metadados

Todo Markdown ativo, exceto `README.md` e `STATUS.md`, possui frontmatter com `id`, `kind`, `status`, `dependsOn` e `supersedes`.

Kinds: `architecture`, `feature`, `schema`, `adr`, `benchmark`, `governance`, `roadmap`.

Statuses: `active`, `planned`, `deferred`, `accepted`, `superseded`, `historical`.

## Regras

- IDs são únicos e estáveis;
- dependências formam DAG;
- documento superseded aponta substituto antes de sair da árvore ativa;
- ADR aceito não é reescrito para mudar a decisão: cria-se novo ADR que o supersede;
- arquitetura/feature/schema incluem seção `Aceitação`;
- debug diary, prompts, handoffs e changelogs vão para `archive/` ou `docs/`;
- status é gerado de frontmatter;
- manifests com hashes manuais não são fonte normativa.

## Verificação

```powershell
node .spec/governance/check-specs.mjs
node .spec/governance/generate-status.mjs
```

CI deve executar o checker antes de build. O gerador deve ser executado quando frontmatter mudar, e o diff de `STATUS.md` deve ser versionado.

## Aceitação da F0

- nenhum documento ativo sem frontmatter;
- nenhuma dependência ausente/cíclica;
- links ativos resolvem;
- referências first-party não usam o antigo nome plural da pasta;
- legado permanece preservado em `archive/legacy-v2/`.
