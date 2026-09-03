# HOTFIX v4 — Work UI retry não é Work review

O log mostrou um bug de contabilidade:

```text
WORK UI bridge start
-> falha de transporte
-> retry 30s
(repetido)
-> 5 Work cycles without evidence_revision progress
-> BLOCKED_USER
```

Nenhum desses retries era um review concluído pelo Work.

## v4

Agora:

```text
UI bridge falha
-> NÃO consome max_work_calls_per_hour
-> NÃO incrementa no-progress review
-> salva tentativa de transporte
-> backoff 30 / 60 / 120 / 240 / 300s
-> tenta novamente sozinho
```

Somente depois de:

```text
WORK prompt sent
...
WORK_RESULT.json válido
```

é que o review entra na contabilidade semântica.

Além disso o erro exato do helper passa a aparecer no log, por exemplo:

```text
WORK UI transport retry ... detail=RuntimeError: ...
```

Isso permite diagnosticar a causa real se o bridge continuar falhando.

O BLOCKED_USER atual:

```text
5 Work cycles without evidence_revision progress; possible loop
```

é reconhecido como falso positivo legado e recuperado automaticamente.

## Instalação

Substitua SOMENTE:

```text
C:\SourceCode\LasecSimul\orchestrator\orchestrator.py
```

Não substitua config.json nem .ai.

Depois:

```powershell
python orchestrator.py --check
python orchestrator.py
```

Esperado:

```text
Orchestrator build: 2026-08-31-work-transport-retry-v4
AUTO-RECOVERY legacy Work transport/no-progress BLOCKED_USER -> REVIEW_REQUIRED
```
