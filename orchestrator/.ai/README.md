# `.ai` — consolidated operational notebook

Single source of truth for the LasecSimul VNEXT_B / ESP32 work. Consolidated
2026-09-03.

## Read in this order

1. **`QEMU_HANDOFF.md`** — START HERE. What the problem is, where it stands,
   what was tried, what failed and why, what is still open.
2. `NEXT_ACTION.md` — the single next action.
3. `TEST_GATES.md` — per-gate status with evidence references.
4. `FINAL_CHECKLIST.md` — definition of done.

Only go deeper when you need the detail:

| File | Contents |
|---|---|
| `STATUS.md` | Current state, corrections to the earlier record, then the preserved per-iteration history |
| `EVIDENCE.md` | Numbered evidence log, newest first. **Read the warning in E099 before trusting any timing number in an older entry.** |
| `CLOSED_HYPOTHESES.md` | Dead ends, plus the postmortem of the iterations 61-90 infrastructure spiral |
| `DECISIONS.md` | Standing decisions (DECISION-001..009) |
| `PROJECT_CONSTITUTION.md` | Frozen architectural rules and historical hazards |
| `QEMU_RUNTIME.json` | Canonical QEMU runtime path, hash, provenance - authoritative for the hash |
| `QEMU_CURRENT_STATE.md` | How the canonical QEMU is built and staged, and the exact state of the QEMU worktree. Its former iteration diary was folded into `STATUS.md` |
| `vnext_b_backpressure_diagnostic.patch`, `esp32_i2c_hotpath_diagnostic.patch` | The two guard-only fixes applied to the QEMU source on 2026-09-03 (E102, E103), recorded so they can be reviewed or reverted |
| `MWDT_DEEP_REVIEW_PLAN.md` | Historical. Its section 2 diagnosis of the framework-fixture problem is sound; its prescribed pure-ESP-IDF route is closed — see `CLOSED_HYPOTHESES.md` |

## Working rules

- **DECISION-006** — device-level watchdog behaviour is tested with the
  bare-metal fixture, never with a framework guest.
- **DECISION-007** — diagnostic traces answer *what happened*, never *when*.
- **DECISION-008** — every scale result carries a validity arm.
- **DECISION-009** — the CPython / ESP-IDF assembly route is closed.

## Orchestrator protocol files

`CODEX_EXECUTOR_PROMPT.md`, `WORK_REVIEW_PROMPT.md`, `REVIEW_PACKET.md`,
`WORK_RESULT.json`, `APP_TASK_RESULT.json`, `state.json`, `BLOCKED.md`,
`discovered_artifacts.json`, `orchestrator.log`, `logs/`, `STOP.example`.

States: `EXECUTE`, `EXECUTING`, `REVIEW_REQUIRED`, `REVIEWING`, `BLOCKED_USER`,
`COMPLETE`, `ERROR`. Create `.ai/STOP` for a safe halt.

`evidence_revision` increases only on materially new technical evidence;
`review_revision` increases on each Work review. `request_id` prevents a stale
review result from being accepted.

Note: `state.json` currently reads `BLOCKED_USER` at iteration 90 for a missing
`pywinauto`/`pyperclip` install. That is an orchestrator UI-automation
dependency, unrelated to the engineering work, and iteration 90 belonged to the
closed route.

## Housekeeping, 2026-09-03

The dead CPython/ESP-IDF route artifacts (~452 MB here, ~16 MB in the
repository-root `.ai/`) were deleted, along with their acquisition scripts. The
postmortem in `CLOSED_HYPOTHESES.md` is the surviving record — do not recreate
them. Investigation logs under `vnext_prototype/` were pruned to the 15 files
actually cited by these documents.

`orchestrator.log`, `logs/` and `STOP` are runtime state and are gitignored; the
consolidated `.md`/`.json`/`.patch` notebook is versioned.
