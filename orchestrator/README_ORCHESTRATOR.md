# LasecSimul Codex ↔ ChatGPT Work Orchestrator

Copy the contents of this package into:

`C:\SourceCode\LasecSimul`

Expected structure:

```text
C:\SourceCode\LasecSimul\
├── orchestrator.py
├── config.json
├── requirements.txt
├── AGENTS.md
└── .ai\
```

## 1. Install

In the VS Code terminal / PowerShell:

```powershell
cd C:\SourceCode\LasecSimul
python -m pip install -r requirements.txt
codex --version
```

The orchestrator intentionally uses **Codex CLI** even if VS Code remains open. A `codex exec` process ending is a reliable signal that the executor round ended.

Log into Codex CLI with the account intended for the executor.

## 2. Prepare ChatGPT Work

On the second account:

1. Open ChatGPT Desktop.
2. Open a dedicated Work conversation for LasecSimul.
3. Give Work access to `C:\SourceCode\LasecSimul`.
4. Keep that Work conversation open.

The Python script does **not** store passwords or tokens. Authentication remains inside each OpenAI client.

The Work side is experimental UI automation because this scaffold does not have an official local endpoint that targets a specific Work conversation. Work must be able to edit `.ai/NEXT_ACTION.md` and `.ai/state.json`. If it cannot, the script stops safely at `BLOCKED_USER`.

## 3. Check environment

```powershell
python orchestrator.py --check
python orchestrator.py --inspect-work
```

`--inspect-work` lists visible Windows UI Automation `Edit` controls. If the Work message box is not recognized, adjust `work.input_name_regex` in `config.json`.

The script deliberately does not click screen coordinates or guess an arbitrary input box.

## 4. One-action test

Initial state is `EXECUTE`.

```powershell
python orchestrator.py --once
python orchestrator.py --status
```

## 5. Continuous mode

```powershell
python orchestrator.py
```

Flow:

```text
EXECUTE
  ↓
codex exec
  ↓
EXECUTE --------------------→ next Codex round
  ↓
REVIEW_REQUIRED
  ↓
Work receives review prompt
  ↓
Work updates NEXT_ACTION/state.json
  ↓
EXECUTE
```

Work is called only when Codex asks for review.

## 6. Safety

The protocol forbids commit, push, reset, clean, and destructive Git operations unless explicitly authorized.

The orchestrator also:

- stores no credentials;
- uses no blind mouse coordinates;
- limits Work calls/hour;
- limits total iterations;
- blocks after repeated Work cycles without new evidence;
- retains only a configurable number of Codex logs;
- supports `.ai/STOP` as a safe stop switch.

To stop safely, create an empty file:

```text
.ai\STOP
```

To resume, remove it, review state, set `state.json` to `EXECUTE` or `REVIEW_REQUIRED`, and restart Python.

## 7. Two-account model

Recommended:

- Codex CLI → account A (executor)
- ChatGPT Desktop / Work → account B (reviewer)

The Python bridge knows neither password nor token.

## 8. Important limitation

The Codex side is robust/programmatic. The Work side depends on Windows UI Automation and on Work's ability to edit the local `.ai` files. App UI changes can require adjusting the input regex. On uncertainty the script STOPS instead of clicking blindly.
