# Layout recomendado — subpasta `orchestrator`

Copie a pasta inteira `orchestrator` para:

`C:\SourceCode\LasecSimul\orchestrator`

Ficará assim:

```text
C:\SourceCode\LasecSimul\
├── core\
├── devices\
├── ...
└── orchestrator\
    ├── orchestrator.py
    ├── config.json
    ├── requirements.txt
    ├── AGENTS.md
    └── .ai\
        ├── STATUS.md
        ├── EVIDENCE.md
        ├── NEXT_ACTION.md
        └── ...
```

O código do projeto continua em:

`C:\SourceCode\LasecSimul`

O estado do ping-pong fica isolado em:

`C:\SourceCode\LasecSimul\orchestrator\.ai`

> Use `.ai`, não `.ia`.

## Instalação

```powershell
cd C:\SourceCode\LasecSimul\orchestrator
python -m pip install -r requirements.txt
codex --version
python orchestrator.py --check
python orchestrator.py --inspect-work
```

Teste de uma ação:

```powershell
python orchestrator.py --once
```

Execução contínua:

```powershell
python orchestrator.py
```

O `config.json` já aponta para:

- `project_root = C:\SourceCode\LasecSimul`
- `ai_dir = orchestrator\.ai`
- `executor_contract = orchestrator\AGENTS.md`

Assim o Codex trabalha na raiz real do projeto, mas todos os arquivos de orquestração ficam dentro da subpasta `orchestrator`.


## ChatGPT Desktop — modo testado nesta máquina

Nesta instalação, o Chromium/WebView do ChatGPT Desktop não expõe o compositor como
um controle UIA `Edit`. Por isso o `config.json` usa:

```json
"input_mode": "last_focused_composer"
```

Preparação única antes de iniciar o modo autônomo:

1. abra o ChatGPT Desktop;
2. abra a conversa Work correta;
3. clique uma vez no campo de mensagem;
4. volte ao terminal com `Alt+Tab`.

Teste seguro:

```powershell
python orchestrator.py --inspect-work
python orchestrator.py --test-work
```

O `--test-work` apenas envia:

`TESTE DO ORQUESTRADOR - responda apenas: WORK UI OK`

Ele não altera `state.json` e não chama o Codex.

Se o estado estiver `BLOCKED_USER` por uma falha de configuração já corrigida:

```powershell
python orchestrator.py --resume
```

O `--resume` é explícito e só muda `BLOCKED_USER -> EXECUTE`; ele se recusa a
continuar se `.ai\STOP` existir.

Depois:

```powershell
python orchestrator.py --once
```

e, quando os testes estiverem corretos:

```powershell
python orchestrator.py
```

### Limitação do modo `last_focused_composer`

Não há clique por coordenadas. O script apenas:

1. encontra a janela ChatGPT;
2. traz a janela para frente;
3. envia `Ctrl+V`;
4. envia `Enter`.

Por isso a conversa Work correta deve continuar aberta e o compositor deve ter sido
o último controle focado dentro do ChatGPT. Se aparecer modal/permissão/tela diferente,
pare com `.ai\STOP` ou `Ctrl+C` e revalide com `--test-work`.


## Correção Windows/npm — `codex.CMD`

No Windows, PowerShell pode resolver `codex` para `codex.CMD`, enquanto
`subprocess.Popen(["codex", ...])` pode não fazer a mesma resolução.

Esta versão resolve explicitamente `codex` com `shutil.which()` antes de iniciar o
subprocesso.

Teste sem consumir uma rodada de projeto:

```powershell
python orchestrator.py --test-codex
```

Esperado:

```text
Configured command: ['codex', 'exec']
Resolved executable: C:\Users\...\AppData\Roaming\npm\codex.CMD
Return code: 0
stdout: codex-cli ...
CODEX SUBPROCESS TEST PASS
```

Se o estado estiver `BLOCKED_USER` por uma tentativa anterior:

```powershell
python orchestrator.py --resume
```

Depois:

```powershell
python orchestrator.py --once
```


## Correção Windows — prompt grande via stdin

A versão anterior passava todo o contexto do executor como argumento:

```text
codex exec "<prompt enorme>"
```

No Windows isso pode falhar com:

```text
Linha de comando muito longa.
```

Esta versão usa:

```text
codex exec -
```

e envia o prompt completo pelo `stdin`.

Assim o tamanho de `AGENTS.md` + `.ai` + `NEXT_ACTION.md` não entra no limite da
linha de comando do Windows.

Depois de substituir o patch:

```powershell
python orchestrator.py --test-codex
python orchestrator.py --resume
python orchestrator.py --once
```

O log do Codex pode mostrar `Reading prompt from stdin...`/equivalente; isso é
esperado.


## Compact Work mode — context goes directly in the message

When Codex needs an external review:

```text
Codex
  ↓
writes orchestrator\.ai\REVIEW_PACKET.md
  ↓
sets REVIEW_REQUIRED
  ↓
Python reads REVIEW_PACKET.md
  ↓
Python pastes the packet directly into ChatGPT Work
  ↓
Work reviews without opening STATUS/EVIDENCE/etc.
  ↓
Work writes only NEXT_ACTION.md + state.json
  ↓
Python resumes Codex
```

Recommended review packet size: 2k–8k characters.
Hard maximum: 12,000 characters.

This does not make the content itself token-free; the packet still counts as input
to Work. The saving comes from sending a compact decision packet instead of having
Work repeatedly open/read the project notebook and tool context.


## Modelo do Codex configurável pelo usuário

O modelo usado pelo executor agora fica em `config.json`:

```json
"codex": {
  "enabled": true,
  "model": "gpt-5.6-luna",
  "command": ["codex", "exec"],
  "extra_args": [],
  "timeout_minutes": 180
}
```

O orquestrador transforma isso em:

```text
codex exec --model <valor-do-config> -
```

e continua enviando o prompt grande pelo `stdin`.

Para trocar o modelo, edite apenas:

```json
"model": "NOME_EXATO_ACEITO_PELO_SEU_CODEX"
```

Para deixar o Codex usar o modelo padrão/atual da própria instalação:

```json
"model": ""
```

ou:

```json
"model": null
```

O script NÃO tenta adivinhar ou converter nomes de modelos. O valor deve ser um
identificador aceito pela versão do Codex CLI instalada na sua máquina.

Confira a seleção com:

```powershell
python orchestrator.py --check
python orchestrator.py --test-codex
```

Observação: `--test-codex` usa apenas `codex --version`, então ele mostra a
configuração selecionada mas não faz uma chamada de agente para validar a
disponibilidade daquele modelo. A disponibilidade real é verificada quando uma
rodada `codex exec` começa.


## Ctrl+C / interrupted Codex recovery

An earlier version could leave:

```text
state = EXECUTING
```

when the user pressed `Ctrl+C` during `codex exec`.

This version:

1. starts Codex in its own process group on Windows;
2. catches `Ctrl+C` while Codex is running;
3. stops the Codex child process (graceful signal, then terminate/kill fallback);
4. changes the orchestration state to `BLOCKED_USER`;
5. allows explicit recovery with:

```powershell
python orchestrator.py --resume
```

`--resume` also accepts a stale `EXECUTING` left by an older orchestrator and changes
it to `EXECUTE`.

It intentionally does NOT auto-resume `REVIEWING`, because ChatGPT Work can continue
processing asynchronously after the Python waiter is stopped.


## Single-file Work result -> direct Codex handoff

The Work reviewer now writes ONE small file only:

```text
orchestrator\.ai\WORK_RESULT.json
```

Flow:

```text
Codex -> REVIEW_PACKET.md
Python -> pastes packet into Work
Work -> writes WORK_RESULT.json only
Python -> validates request_id + schema + size
Python -> updates NEXT_ACTION.md + state.json
Python -> injects WORK_RESULT.json directly into next Codex prompt
Codex -> continues
```

Work no longer edits NEXT_ACTION.md or state.json.

The result schema is:

```json
{
  "schema_version": 1,
  "request_id": "...",
  "state": "EXECUTE",
  "decision": "...",
  "next_action": "...",
  "reason": "..."
}
```

Default hard size limit: 4,000 characters.

The direct reviewer result is injected into one successful Codex turn. If that
Codex process crashes or is interrupted, the feedback remains pending and is sent
again on the retry so the decision is not lost.

`config.json` does not need to change. To override the default result limit, add
under `"work"`:

```json
"max_work_result_chars": 4000
```

Your existing `"codex.model"` setting remains untouched.


## AutoWork — usuário seleciona o campo uma vez

O padrão agora é:

```text
auto_review_after_codex = true
```

Mesmo que essa chave não exista no seu `config.json`, o padrão é ON.

Preparação única:

1. abra o ChatGPT Desktop na conversa Work correta;
2. clique UMA vez no campo de mensagem;
3. volte ao PowerShell com `Alt+Tab`;
4. inicie o orquestrador.

Depois disso o Python faz sozinho:

```text
Codex
  ↓
se state=EXECUTE, trabalha normalmente
  ↓
se terminar em REVIEW_REQUIRED
  ↓
Python foca ChatGPT
  ↓
cola REVIEW_PACKET
  ↓
Enter
  ↓
Work escreve WORK_RESULT.json
  ↓
Python valida e atualiza state/NEXT_ACTION
  ↓
próxima rodada Codex recebe o parecer diretamente
```

Não é mais necessário executar uma segunda chamada `--once` só para acionar o Work.

### `--once`

Agora significa um ciclo completo:

```text
Codex
  ↓
se necessário, Work automático
  ↓
para
```

### modo contínuo

```powershell
python orchestrator.py
```

continua Codex ↔ Work automaticamente até COMPLETE, BLOCKED_USER, STOP ou Ctrl+C.

### Desativar, se quiser

Opcionalmente adicione em `"work"` no `config.json`:

```json
"auto_review_after_codex": false
```

Para o comportamento automático, não precisa adicionar nada; ON é o padrão.


## Auto-discovery de firmware e QEMU

O orquestrador agora procura sozinho os artefatos externos antes de cada rodada
Codex. O usuário não precisa exportar manualmente:

```text
LASECSIMUL_TEST_FIRMWARE
LASECSIMUL_TEST_QEMU_BINARY
```

A resolução segue:

1. variável de ambiente já válida;
2. caminho explícito opcional em `config.json`;
3. cache `.ai\discovered_artifacts.json`;
4. busca local limitada.

Firmware:
- procura `merged.bin`;
- prioriza `C:\SourceCode\II1P04_GPIO_Debug`.

QEMU:
- procura `qemu-system-xtensa.exe`;
- pesquisa `C:\SourceCode\II1P04_GPIO_Debug`,
  `C:\SourceCode\qemu_lasecSimul`, o projeto e `C:\SourceCode`;
- prioriza a árvore ativa `qemu_lasecSimul`/build quando encontrada;
- evita preferir o executável histórico de rollback em
  `LasecSimul\devices\qemu-esp32\bin`.

Teste sem executar Codex:

```powershell
python orchestrator.py --discover-artifacts
```

Os dois itens devem retornar PASS.

A primeira descoberta é salva em:

```text
.ai\discovered_artifacts.json
```

e reutilizada enquanto os arquivos continuarem existindo.

Opcionalmente o usuário pode sobrescrever os defaults adicionando em `config.json`:

```json
"artifact_discovery": {
  "enabled": true,
  "firmware_path": "",
  "qemu_binary_path": ""
}
```

Não é necessário adicionar essa seção para o comportamento automático funcionar.


## Correção `self.root` na descoberta automática

A primeira versão do auto-discovery usava por engano `self.root`, atributo que não
existe no Orchestrator. O root correto do orquestrador é derivado de:

```text
config_path.parent
```

e armazenado como:

```text
self.orchestrator_root
```

O comando de validação permanece:

```powershell
python orchestrator.py --discover-artifacts
```

Nenhum `config.json` ou arquivo `.ai` precisa ser substituído por esta correção.


## QEMU_RUNTIME.json is authoritative

When this file exists:

```text
orchestrator\.ai\QEMU_RUNTIME.json
```

the orchestrator no longer chooses QEMU by directory-name/timestamp heuristics.

Resolution order for QEMU is:

1. a valid explicit process environment variable;
2. a valid explicit config path;
3. `QEMU_RUNTIME.json` canonical executable + SHA-256 validation;
4. cached discovery;
5. heuristic discovery only when no manifest exists.

If `QEMU_RUNTIME.json` exists but:
- `canonical_executable` is missing;
- the executable path does not exist;
- the SHA-256 does not match;
- `canonical_runtime_dir` is declared but missing;

the orchestrator fails safe instead of silently selecting another QEMU.

When a canonical runtime directory is available, it is prepended to the Codex child
`PATH` so the harness sees the same staged DLL/runtime environment as the validated
baseline.

Use:

```powershell
python orchestrator.py --discover-artifacts
```

to verify the selected executable and manifest before a run.


## Mandatory cross-agent handoff

Every Codex turn now receives permanent instructions requiring it to begin from
`.ai\QEMU_HANDOFF.md` and update that handoff before returning successfully.

Therefore a new Codex process does not start the QEMU investigation from zero.

If the previous agent was investigating a production-session failure and the
handoff says it remains OPEN, the next agent continues the recorded
`NEXT_EXACT_ACTION`.

`REVIEW_REQUIRED=NO` does not suppress handoff persistence.


## Bounded ChatGPT Work UI bridge

The Work UI send step now executes in a disposable Python child process with a
default hard timeout of 20 seconds (`work.ui_send_timeout_seconds`, optional).

This prevents Windows UI Automation / focus acquisition from hanging the whole
autonomous orchestrator indefinitely before `WORK prompt sent`.

Expected log sequence:

```text
WORK review prepare ...
WORK state -> REVIEWING ...; starting UI bridge
WORK UI bridge start ... timeout=20.0s
WORK UI bridge completed ...
WORK prompt sent; waiting for one matching .ai/WORK_RESULT.json
```

If the UI bridge blocks, it is terminated and state becomes `BLOCKED_USER` with
a specific UI timeout reason.

### Recovering an older stale REVIEWING state

If an older orchestrator version was interrupted while stuck in `REVIEWING`,
first stop that old process, confirm Work is not processing its prompt, then run:

```powershell
python orchestrator.py --recover-review
```

If a matching `WORK_RESULT.json` already exists it is consumed. Otherwise the
checkpoint is preserved as `REVIEW_REQUIRED`, ready for a fresh safe retry.


### Recovery after safety conversion REVIEWING -> BLOCKED_USER

If a stale `REVIEWING` checkpoint is converted to `BLOCKED_USER` by a later
startup, `--recover-review` now recognizes that state when the original
`review_request_id` is still present. It consumes a matching result if one
already exists, otherwise restores `REVIEW_REQUIRED` without rerunning Codex.


## Hybrid AutoWork cadence

AutoWork now has two independent triggers:

1. **Immediate:** Codex returns `REVIEW_REQUIRED`.
2. **Periodic:** two successful Codex turns return `EXECUTE` after the last Work
   review.

Default:

```json
{
  "work": {
    "periodic_review_every_codex_iterations": 2
  }
}
```

The key is optional; the embedded default is `2`. Set it to `0` to disable only
the periodic trigger while keeping immediate `REVIEW_REQUIRED` reviews.

A periodic checkpoint uses a freshly synthesized compact packet from the current
mandatory `QEMU_HANDOFF.md` plus recent STATUS/NEXT_ACTION context. It does not
reuse an old `REVIEW_PACKET.md`.

After every successful Work result, `state.json` records
`last_work_review_iteration`, so the cadence survives process restarts.

Example:

```text
Work reviews iteration 12
Codex 13 -> EXECUTE
Codex 14 -> EXECUTE
PERIODIC WORK checkpoint -> Work
Codex 15 -> EXECUTE
Codex 16 -> REVIEW_REQUIRED
Work immediately (does not wait for periodic cadence)
```


## Work-first user escalation

Codex no longer has authority to surface `BLOCKED_USER` directly.

Preferred path:

```text
Codex encounters blocker
        ↓
tries safe local resolution / narrows evidence
        ↓
REVIEW_REQUIRED
        ↓
Work attempts to solve or select a safe alternate next action
        ↓
EXECUTE → Codex continues
```

If Codex violates the contract and writes `BLOCKED_USER`, Python intercepts it:

```text
Codex BLOCKED_USER
        ↓
Python converts to REVIEW_REQUIRED (trigger=codex_blocked)
        ↓
Work-first blocker triage
```

Only a `BLOCKED_USER` returned by Work (or an orchestrator infrastructure/safety
failure) may become a terminal user-facing blocker.

Work itself is instructed to return `BLOCKED_USER` only for a genuinely
human-only dependency after attempting to solve/narrow the issue first.


## Automatic capacity wait and resume

Temporary Codex/Work usage or rate limits no longer require the user to run
`--resume`.

The persisted state is:

```text
WAITING_CAPACITY
capacity_target = codex|work
capacity_retry_at = offset-aware ISO timestamp
capacity_resume_state = EXECUTE|REVIEW_REQUIRED
```

When a reset/retry time can be parsed from the service message, that exact local
time is used. Otherwise the default probe delay is 300 seconds.

Codex non-zero exits are inspected for rate/usage/quota/429 messages. A capacity
denial does not consume a semantic iteration; the same iteration number is retried.

For Work, the orchestrator:
- continues polling for a late matching `WORK_RESULT.json`;
- performs a bounded best-effort UIA scan for visible usage-limit text;
- parses an explicit retry/reset time when exposed;
- otherwise, after the normal Work result timeout, schedules an automatic retry
  instead of surfacing `BLOCKED_USER`.

A continuous `python orchestrator.py` process sleeps through capacity windows and
resumes automatically. The `WAITING_CAPACITY` state also survives process
restarts.


## Transparent stop / restart

Normal operator workflow is now only:

```powershell
# stop
Ctrl+C

# later, restart
python orchestrator.py
```

No normal decision between `--resume` and `--recover-review` is required.

At startup, after acquiring an exclusive per-workspace instance lock, Python
automatically resolves:

- `EXECUTE` -> continue;
- stale `EXECUTING` -> `EXECUTE`, preserving partial work;
- `REVIEW_REQUIRED` -> Work;
- stale `REVIEWING` -> consume a matching late `WORK_RESULT.json` if present,
  otherwise restore `REVIEW_REQUIRED` and resend automatically;
- Codex-authored `BLOCKED_USER` -> Work-first review;
- Ctrl+C/interrupted-Codex `BLOCKED_USER` -> `EXECUTE`;
- old review/UI interruption `BLOCKED_USER` -> reviewer recovery;
- `WAITING_CAPACITY` -> keep sleeping until the persisted retry time;
- Work-authored genuine `BLOCKED_USER` -> remain blocked for the human;
- `COMPLETE` -> remain complete.

The exclusive lock prevents a second `python orchestrator.py` process from
misclassifying a live `EXECUTING` or `REVIEWING` state as stale.

The old manual flags remain available as recovery/debug tools, but are no longer
part of the normal workflow.


## Configurable forced Work cadence

The cadence is now an explicit normal `config.json` setting:

```json
"work": {
  "periodic_review_every_codex_iterations": 2
}
```

Semantics:

- `0` = **on-demand only**, matching the original behavior. Work is called when
  Codex/architecture actually requires `REVIEW_REQUIRED`, or for mandatory
  Work-first blocker triage. There is no periodic forced review.
- `1` = Work after every Codex `EXECUTE` turn.
- `2` = Work after two consecutive Codex `EXECUTE` turns since the last Work
  review.
- `N > 0` = Work after N consecutive Codex `EXECUTE` turns since the last Work
  review.

Immediate `REVIEW_REQUIRED` always takes precedence; the counter never delays an
actually needed review.

To safely change only this field without replacing the rest of `config.json`:

```powershell
python set_work_cadence.py 0
python set_work_cadence.py 2
python set_work_cadence.py 5
```

`python orchestrator.py --check` prints the active configured value.


## Self-healing Work UI bridge

A bounded Work UI bridge timeout no longer terminates the orchestrator with
`BLOCKED_USER`.

For plausibly transient failures (UIA timeout/window/focus/helper failure), the
orchestrator now:

1. keeps the review request id;
2. enters persisted `WAITING_CAPACITY`;
3. waits 30 seconds by default (`work.ui_bridge_retry_seconds`);
4. consumes a late matching `WORK_RESULT.json` if the original send actually
   succeeded;
5. otherwise restores `REVIEW_REQUIRED` and retries Work automatically.

The local Work calls/hour safeguard still prevents an infinite rapid retry storm.

Clearly non-transient local configuration/dependency errors remain fail-safe.

## Interrupted Codex iteration numbering

A normal Ctrl+C during Codex now retries the same semantic iteration number on
the next transparent restart. Before retrying, the previous partial log is
archived as:

```text
codex_NNNN_interrupted_YYYYMMDD_HHMMSS.log
```

Partial repository work is not reset/cleaned.


## Native Work send bridge

The production `last_focused_composer` send path no longer enumerates Chromium
controls through `Desktop(backend="uia").windows()`.

It now:

1. finds the ChatGPT top-level window with native Win32 `EnumWindows`;
2. focuses only that HWND;
3. pastes into the composer that was last focused in the intended Work
   conversation;
4. presses Enter;
5. runs all of this inside the existing bounded helper subprocess.

This specifically addresses the observed 20-second hang before any prompt
appeared in Work.

`--test-work` now uses exactly the same bounded/native send path as production,
so a successful test is meaningful.

Current build marker:

```text
2026-08-31-native-work-bridge-v1
```


## Capability-aware reviewer / stale blocker invalidation

Current Codex launcher capabilities are now embedded in both the Codex executor
prompt and the Work review prompt.

This prevents a historical statement such as:

```text
C:\SourceCode\qemu_lasecSimul is outside the writable workspace
```

from being repeated after `config.json` has already changed to:

```text
--sandbox workspace-write
--add-dir C:\SourceCode\qemu_lasecSimul
```

A Work `BLOCKED_USER` is automatically converted to `EXECUTE` only for this
narrow, mechanically provable case: the reviewer asks the human to grant a
writable root that is already present in the current launcher configuration.

All other Work-authored human-only blockers remain terminal.

Build:

```text
2026-08-31-capability-aware-review-v2
```


## v3 startup stale-blocker fix

Startup recovery now evaluates the persisted Work blocker using both:

- `state.json.reason`
- `.ai/NEXT_ACTION.md`

This matters because `state.reason` is compact and may say only "changing
writable-root authorization is required" while `NEXT_ACTION.md` contains the
actual path (`C:\SourceCode\qemu_lasecSimul`).

Therefore an already-granted `--add-dir` is recognized immediately after
installing the patch, even when the stale Work result was produced by an older
orchestrator version.


## v4 Work transport retries are not semantic reviews

A Work UI/desktop delivery failure is now treated as transport failure, not a
review cycle.

Previous behavior could do this:

```text
UI send fails
-> WAITING_CAPACITY
-> retry
-> _check_review_progress()
-> retry
...
-> "5 Work cycles without evidence_revision progress"
-> BLOCKED_USER
```

even though Work never received any of those prompts.

v4 changes the accounting:

- local Work calls/hour slot is consumed only after prompt delivery succeeds;
- no-progress review counter is updated only after a matching `WORK_RESULT.json`
  has completed and the applied result is `EXECUTE`;
- transient UI bridge retries use exponential backoff (30/60/120/240/300s by
  default);
- exact UI helper failure detail is logged;
- the old false `BLOCKED_USER` is automatically recovered to
  `REVIEW_REQUIRED` on startup.

This does not weaken genuine Work-authored human-only blockers.
