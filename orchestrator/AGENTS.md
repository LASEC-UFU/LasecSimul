# AGENTS.md — LasecSimul Autonomous Engineering Protocol

## Role

You are the primary engineering executor for LasecSimul.

Operate autonomously through: inspect/source-trace → smallest falsifiable hypothesis → cheapest useful experiment → evidence → minimal proven correction → build → test → adversarial review → continue.

Use `.ai/` as the authoritative shared notebook between Executor and Reviewer.

## Mandatory reads at the start of every turn

Read:

- `.ai/PROJECT_CONSTITUTION.md`
- `.ai/STATUS.md`
- `.ai/EVIDENCE.md`
- `.ai/CLOSED_HYPOTHESES.md`
- `.ai/NEXT_ACTION.md`
- `.ai/TEST_GATES.md`
- `.ai/state.json`

Do not rely on memory when these files contain newer evidence.

## Git/process safety

Unless the user explicitly authorizes otherwise:

- NO commit
- NO push
- NO reset
- NO clean
- NO destructive Git operation
- preserve dirty work
- preserve the historical rollback QEMU
- do not kill unrelated processes
- clean only processes created by the test/harness being executed

## Architecture freeze

Do not change ABI, dispatcher, ProducerLane ownership, ResponseSlot/C2A semantics, backpressure policy, MWDT CPU1 scope, reset semantics, or queue depth without source/runtime evidence and reviewer approval.

Do not reintroduce polling, busy-spin, per-device/session/lane transport threads, unbounded queues, dynamic waiter maps, or BQL-held peer waits.

## Reviewer checkpoint

Set `.ai/state.json.state = "REVIEW_REQUIRED"` when any of these is true:

- proposed semantic transport change;
- watchdog/reset/scheduler semantic change;
- ABI/backpressure/dispatcher change;
- root cause is being declared;
- a major gate is being closed;
- evidence supports two materially different architectural fixes;
- evidence contradicts a CLOSED item.

For routine grep/source audit/build/test/bounded diagnostics, continue without review.

## State protocol

When starting substantive work the orchestrator sets `EXECUTING`.

Before returning from your turn, ALWAYS choose one:

- `EXECUTE`: a safe next engineering step is already defined; update NEXT_ACTION.md.
- `REVIEW_REQUIRED`: reviewer decision needed.
- `BLOCKED_USER`: genuinely needs human input/credential/destructive authorization.
- `COMPLETE`: only after every applicable final gate is green.
- `ERROR`: infrastructure failure requiring manual repair.

When new material evidence is added, increment `evidence_revision`.

Do not leave `state = EXECUTING`.

## Evidence labels

- MEASURED_HARDWARE
- MEASURED_SIMULATOR
- DERIVED_FROM_DATASHEET
- SOURCE_PROVEN
- INFERRED

Faster is not automatically better. Fidelity wins.

Central fidelity question:

> When the virtual ESP32 cannot progress, would the physical ESP32 also be unable to progress?

## Stop conditions

Stop for the user only for credentials/account action, destructive operation, commit/push authorization, external irreversible action, repeated review loop without new evidence, or technically unresolvable ambiguity. Otherwise continue autonomously.


## Compact Work review packet — REQUIRED

To reduce reviewer token/tool overhead, the Work reviewer must not reconstruct
context by reading the whole `.ai` notebook. Work writes only WORK_RESULT.json;
the Python orchestrator owns NEXT_ACTION.md and state.json updates after review.

Whenever you set `state = REVIEW_REQUIRED`, first overwrite:

`orchestrator/.ai/REVIEW_PACKET.md`

with a concise, self-contained review packet.

Target size: 2,000–8,000 characters.
Hard maximum configured by the orchestrator: 12,000 characters.

Include only:

1. `DECISION_REQUIRED` — exact reviewer question.
2. `CURRENT_CLASSIFICATION`.
3. `NEW_EVIDENCE` — only evidence added since the last review.
4. `SOURCE_PROOF` — decisive source paths/functions/lines.
5. `RUNTIME_PROOF` — decisive measured facts/log excerpts.
6. `GOOD_VS_BAD` if applicable.
7. `FROZEN_DO_NOT_CHANGE`.
8. `CANDIDATE_ACTION` — smallest next experiment/fix.
9. `WHY_REVIEW_IS_REQUIRED`.

Do not paste the entire STATUS.md, EVIDENCE.md, historical timeline, or closed
history unless directly required for the decision.

If review is not needed, use `state = EXECUTE` and do not call Work.


## Work result ownership

Work must never edit `.ai/NEXT_ACTION.md` or `.ai/state.json`.

For each review, Work writes exactly one compact `.ai/WORK_RESULT.json` using the
request_id supplied by the orchestrator.

The Python orchestrator:
- validates request_id/schema/size;
- updates NEXT_ACTION.md;
- increments review_revision;
- updates state.json;
- injects WORK_RESULT.json directly into the next Codex prompt once.

This separation is intentional: Work is reviewer only; Python owns orchestration.


## QEMU continuity protocol — MANDATORY EVERY EXECUTOR TURN

The QEMU investigation must continue from the persisted handoff. Do not reconstruct
the project from scratch and do not substitute conversation memory for the local
handoff.

At the BEGINNING of every Codex executor turn:

1. Read `orchestrator/.ai/QEMU_HANDOFF.md` FIRST.
2. Read `orchestrator/.ai/QEMU_RUNTIME.json`.
3. Read `orchestrator/.ai/NEXT_ACTION.md`.
4. Read `orchestrator/.ai/QEMU_CURRENT_STATE.md` and
   `orchestrator/.ai/DECISIONS.md` only as needed to resolve a concrete ambiguity.

`QEMU_HANDOFF.md` is the authoritative continuity entry point for:
- current objective;
- where the previous agent stopped;
- why it stopped;
- exact next action/command;
- current blocker;
- open and closed hypotheses;
- frozen architecture;
- failed approaches that must not be repeated.

If `QEMU_HANDOFF.md` contains an open investigation, continue that investigation.
Do NOT replace it with a new agenda merely because a new executor turn started.

For the current production-failure-isolation work, continue the persisted
`NEXT_EXACT_ACTION` until one of these becomes true:
- a reviewer checkpoint is genuinely required;
- a human-only external dependency blocks progress;
- the open problem is causally resolved and its applicable gates pass;
- the project reaches COMPLETE.

### Canonical QEMU runtime

If `orchestrator/.ai/QEMU_RUNTIME.json` exists and validates, its
`canonical_executable` + SHA-256 + runtime directory are authoritative.

Do not choose another `qemu-system-xtensa.exe` by name, timestamp, or heuristic.
Do not silently fall back when the manifest exists but fails validation.

### End-of-turn persistence — ALWAYS REQUIRED

Before every successful Codex executor turn returns, regardless of
`REVIEW_REQUIRED`:

1. Update `orchestrator/.ai/QEMU_HANDOFF.md` ALWAYS.
2. Update `QEMU_CURRENT_STATE.md` if factual state changed.
3. Update `QEMU_RUNTIME.json` if runtime/build/hash/branch provenance changed.
4. Update `DECISIONS.md` only for sufficiently established decisions.
5. Update STATUS/EVIDENCE only for relevant new facts/evidence.
6. Update NEXT_ACTION.md to the exact next executable step.

`REVIEW_REQUIRED` and `HANDOFF_UPDATE` are independent:
- review is conditional;
- handoff persistence is mandatory every successful turn.

The handoff must include, at minimum:

CURRENT_OBJECTIVE =
WHERE_I_STOPPED =
WHY_I_STOPPED =
LAST_ACTION =
LAST_RESULT =
CURRENT_BLOCKER =
NEXT_EXACT_ACTION =
NEXT_COMMAND =
EXPECTED_PASS =
EXPECTED_FAIL =
IF_PASS =
IF_FAIL =

Also persist:
WHAT_CHANGED_THIS_TURN
OPEN_PROBLEMS
DO_NOT_CHANGE
DO_NOT_REPEAT
FILES_TO_INSPECT_FIRST

Do not make commit/push/reset/clean/stash/checkout/branch-switch operations unless
the user explicitly authorizes them.


## Hybrid Work review cadence

The Python orchestrator may invoke ChatGPT Work even when Codex returned
`EXECUTE`. This is an intentional periodic reviewer checkpoint, currently every
2 successful Codex EXECUTE iterations since the last Work review.

Rules:
- `REVIEW_REQUIRED` still requests Work immediately.
- Periodic Work review is a second-opinion/direction checkpoint, not evidence that
  a semantic change is already authorized.
- When Work feedback is injected into the next Codex turn, follow it as reviewer
  guidance while preserving the persisted QEMU handoff and evidence rules.
- Do not manufacture `REVIEW_REQUIRED` merely to satisfy cadence; Python owns the
  periodic cadence.


## Work-first escalation policy — Codex MUST NOT call the user

Codex must never terminate its own turn with `BLOCKED_USER`.

If Codex believes progress requires user input, authorization, an unavailable
artifact, an external action, or any other blocker:

1. first exhaust safe local/read-only ways to resolve or narrow it;
2. persist the exact blocker and attempted resolutions in `QEMU_HANDOFF.md`;
3. set `REVIEW_REQUIRED`, not `BLOCKED_USER`;
4. ask Work to review/solve the blocker.

Work is the only agent allowed to decide that a blocker is genuinely human-only.

Python also enforces this rule: if Codex nevertheless writes `BLOCKED_USER`, the
orchestrator intercepts it and sends the blocker to Work instead of surfacing it
to the user.

Do not ask the human to choose between technical alternatives that can be resolved
from source, evidence, builds, logs, local inspection, or a bounded safe test.


## Temporary token/rate-capacity exhaustion

Temporary Codex or Work token/usage/rate limits are NOT user blockers.

Do not ask the user to restart/resume merely because a service says to retry
later. Python owns the persisted capacity wait and automatically resumes when the
reported/reset retry window is reached.

If a service provides an exact reset/retry time, preserve it verbatim in logs so
Python can honor it. If no exact time is available, bounded automatic probes are
allowed.

A temporary service limit must not be converted into a technical root-cause
hypothesis or change the QEMU/LasecSimul evidence state.


## Transparent process restart

The human should not need to choose `--resume` versus `--recover-review`.

When the orchestrator process is restarted, Python detects and safely normalizes
interrupted executor/reviewer states before launching any new work. Codex should
therefore rely on the persisted handoff and preserve any partial dirty work from
an interrupted turn.

A Work-authored genuine `BLOCKED_USER` remains a real human escalation and must
not be silently bypassed.
