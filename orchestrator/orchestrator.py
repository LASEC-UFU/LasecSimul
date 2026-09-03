#!/usr/bin/env python3
"""LasecSimul Codex ↔ ChatGPT Work local orchestrator.

The Codex side is programmatic (`codex exec`). The Work side uses Windows UI
Automation only to focus ChatGPT and submit a prompt; Work must already be open,
authenticated, and allowed to edit the project `.ai` files.

No credentials are stored. The script never uses blind mouse coordinates.
"""
from __future__ import annotations

import argparse
import collections
import datetime as dt
import json
import hashlib
import os
import re
import signal
import shutil
import subprocess
import sys
import time
import uuid
from pathlib import Path
from typing import Any, Optional

VALID_STATES = {
    "EXECUTE", "EXECUTING", "REVIEW_REQUIRED", "REVIEWING",
    "WAITING_CAPACITY", "BLOCKED_USER", "COMPLETE", "ERROR",
}
TERMINAL_STATES = {"BLOCKED_USER", "COMPLETE", "ERROR"}

ORCHESTRATOR_BUILD = "2026-08-31-work-transport-retry-v4"


def now_iso() -> str:
    return dt.datetime.now().astimezone().isoformat(timespec="seconds")


def load_json(path: Path, retries: int = 20, delay: float = 0.15) -> dict[str, Any]:
    last: Optional[Exception] = None
    for _ in range(retries):
        try:
            return json.loads(path.read_text(encoding="utf-8"))
        except (OSError, json.JSONDecodeError) as exc:
            last = exc
            time.sleep(delay)
    raise RuntimeError(f"Could not read valid JSON from {path}: {last}")


def atomic_write_json(path: Path, data: dict[str, Any]) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)


def read_text(path: Path) -> str:
    try:
        return path.read_text(encoding="utf-8")
    except FileNotFoundError:
        return ""


class Orchestrator:
    def __init__(self, config_path: Path):
        self.config_path = config_path.resolve()
        self.orchestrator_root = self.config_path.parent
        self.config = load_json(self.config_path)
        root = os.path.expandvars(os.path.expanduser(self.config.get("project_root", ".")))
        self.project = Path(root).resolve()

        # The shared AI notebook can live outside the project root's default ".ai".
        # For the recommended layout this resolves to:
        # C:\\SourceCode\\LasecSimul\\orchestrator\\.ai
        ai_raw = os.path.expandvars(os.path.expanduser(self.config.get("ai_dir", ".ai")))
        ai_path = Path(ai_raw)
        self.ai = (ai_path if ai_path.is_absolute() else (self.project / ai_path)).resolve()

        contract_raw = os.path.expandvars(
            os.path.expanduser(self.config.get("executor_contract", "AGENTS.md"))
        )
        contract_path = Path(contract_raw)
        self.executor_contract = (
            contract_path
            if contract_path.is_absolute()
            else (self.project / contract_path)
        ).resolve()

        self.state_path = self.ai / "state.json"
        self.stop_path = self.ai / "STOP"
        self.log_path = self.ai / "orchestrator.log"
        self.work_result_path = self.ai / "WORK_RESULT.json"

        # WORK_RESULT.json is the only file Work itself needs to write.
        # Create an inert placeholder if this is an existing installation that
        # predates the direct-result protocol.
        if not self.work_result_path.exists():
            atomic_write_json(
                self.work_result_path,
                {
                    "schema_version": 1,
                    "request_id": "",
                    "state": "",
                    "decision": "",
                    "next_action": "",
                    "reason": "",
                },
            )

        s = self.config.get("safeguards", {})
        self.max_iterations = int(s.get("max_iterations", 80))
        self.max_no_progress_reviews = int(s.get("max_review_cycles_without_new_evidence", 5))
        self.max_work_calls_per_hour = int(s.get("max_work_calls_per_hour", 8))
        self.work_calls: collections.deque[float] = collections.deque()
        self.last_review_evidence: Optional[int] = None
        self.no_progress_reviews = 0
        self._check_structure()

    def _check_structure(self) -> None:
        required = [
            self.executor_contract,
            self.ai / "PROJECT_CONSTITUTION.md",
            self.ai / "STATUS.md",
            self.ai / "EVIDENCE.md",
            self.ai / "NEXT_ACTION.md",
            self.ai / "CODEX_EXECUTOR_PROMPT.md",
            self.ai / "WORK_REVIEW_PROMPT.md",
            self.state_path,
        ]
        missing = [str(p) for p in required if not p.exists()]
        if missing:
            raise RuntimeError("Missing .ai files:\n- " + "\n- ".join(missing))

    def log(self, msg: str) -> None:
        line = f"[{now_iso()}] {msg}"
        print(line, flush=True)
        self.ai.mkdir(parents=True, exist_ok=True)
        with self.log_path.open("a", encoding="utf-8") as f:
            f.write(line + "\n")

    def state(self) -> dict[str, Any]:
        st = load_json(self.state_path)
        if st.get("state") not in VALID_STATES:
            raise RuntimeError(f"Invalid state: {st.get('state')!r}")
        return st

    def update_state(self, **changes: Any) -> dict[str, Any]:
        st = self.state()
        st.update(changes)
        st["updated_at"] = now_iso()
        atomic_write_json(self.state_path, st)
        return st

    def block(self, reason: str) -> None:
        self.log("BLOCKED_USER: " + reason)
        self.update_state(state="BLOCKED_USER", last_actor="orchestrator", reason=reason)
        (self.ai / "BLOCKED.md").write_text(
            f"# BLOCKED_USER\n\n**{now_iso()}**\n\n{reason}\n", encoding="utf-8"
        )

    def _capacity_markers(self) -> tuple[str, ...]:
        return (
            "rate limit",
            "rate_limit",
            "usage limit",
            "usage cap",
            "you've hit your",
            "you have hit your",
            "reached your limit",
            "limit reached",
            "quota exceeded",
            "quota has been exceeded",
            "too many requests",
            "http 429",
            "status 429",
            "error 429",
            "try again later",
            "try again at",
            "retry after",
            "resets at",
            "reset at",
            "limite de uso",
            "limite atingido",
            "limite foi atingido",
            "tente novamente",
            "muitas solicitações",
        )

    def _looks_like_capacity_limit(self, value: str) -> bool:
        low = (value or "").lower()
        return any(marker in low for marker in self._capacity_markers())

    def _capacity_retry_seconds(
        self,
        value: str,
        default_seconds: float,
    ) -> float:
        """Best-effort parse of service-provided retry/reset timing.

        Exact relative delays and common local-clock reset messages are honored.
        Otherwise the configured bounded probe interval is used.
        """
        text_value = value or ""

        # Retry-After / "try again in N seconds|minutes|hours".
        patterns = [
            (r"(?:retry[- ]?after|try again in|tente novamente em)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(seconds?|secs?|segundos?|s)\b", 1.0),
            (r"(?:retry[- ]?after|try again in|tente novamente em)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(minutes?|mins?|minutos?|m)\b", 60.0),
            (r"(?:retry[- ]?after|try again in|tente novamente em)\s*[:=]?\s*(\d+(?:\.\d+)?)\s*(hours?|hrs?|horas?|h)\b", 3600.0),
        ]
        for pattern, scale in patterns:
            m = re.search(pattern, text_value, re.I)
            if m:
                return max(5.0, float(m.group(1)) * scale + 2.0)

        # Common bare Retry-After seconds header text.
        m = re.search(r"\bretry[- ]?after\s*[:=]\s*(\d+)\b", text_value, re.I)
        if m:
            return max(5.0, float(m.group(1)) + 2.0)

        # "resets at 3:42 PM", "try again at 15:42", Portuguese variants.
        m = re.search(
            r"(?:resets?|reset|try again|tente novamente|volte)\s+(?:at|às|as)?\s*"
            r"(\d{1,2}):(\d{2})(?:\s*(AM|PM))?",
            text_value,
            re.I,
        )
        if m:
            hour = int(m.group(1))
            minute = int(m.group(2))
            ampm = (m.group(3) or "").upper()
            if ampm:
                hour %= 12
                if ampm == "PM":
                    hour += 12
            if 0 <= hour <= 23 and 0 <= minute <= 59:
                now = dt.datetime.now().astimezone()
                target = now.replace(
                    hour=hour, minute=minute, second=2, microsecond=0
                )
                if target <= now:
                    target += dt.timedelta(days=1)
                return max(5.0, (target - now).total_seconds())

        return max(5.0, float(default_seconds))

    def _schedule_capacity_wait(
        self,
        *,
        target: str,
        resume_state: str,
        reason: str,
        retry_seconds: float,
        pending_request_id: str = "",
        review_trigger: str = "",
        iteration_override: Optional[int] = None,
    ) -> None:
        retry_seconds = max(5.0, float(retry_seconds))
        retry_at = dt.datetime.now().astimezone() + dt.timedelta(
            seconds=retry_seconds
        )
        changes: dict[str, Any] = {
            "state": "WAITING_CAPACITY",
            "last_actor": "orchestrator",
            "reason": reason,
            "capacity_target": target,
            "capacity_resume_state": resume_state,
            "capacity_retry_at": retry_at.isoformat(timespec="seconds"),
            "capacity_reason": reason,
            "capacity_pending_request_id": pending_request_id,
            "review_trigger": review_trigger,
        }
        if iteration_override is not None:
            changes["iteration"] = max(0, int(iteration_override))
        self.update_state(**changes)
        self.log(
            f"CAPACITY WAIT target={target} retry_at="
            f"{retry_at.isoformat(timespec='seconds')} "
            f"resume={resume_state}"
        )

    def _capacity_retry_at(self, st: dict[str, Any]) -> dt.datetime:
        raw = str(st.get("capacity_retry_at", "") or "")
        try:
            when = dt.datetime.fromisoformat(raw)
        except ValueError:
            when = dt.datetime.now().astimezone()
        if when.tzinfo is None:
            when = when.astimezone()
        return when

    def _finish_capacity_wait(self, st: dict[str, Any]) -> None:
        resume_state = str(st.get("capacity_resume_state", "") or "")
        if resume_state not in {"EXECUTE", "REVIEW_REQUIRED"}:
            resume_state = (
                "REVIEW_REQUIRED"
                if st.get("capacity_target") == "work"
                else "EXECUTE"
            )
        self.update_state(
            state=resume_state,
            last_actor="orchestrator",
            reason=(
                f"Capacity retry window reached for "
                f"{st.get('capacity_target', 'unknown')}; auto-resuming."
            ),
            capacity_target="",
            capacity_resume_state="",
            capacity_retry_at="",
            capacity_reason="",
            capacity_pending_request_id="",
        )
        self.log(
            f"CAPACITY AVAILABLE/RETRY WINDOW reached -> {resume_state}; "
            "continuing automatically"
        )

    def _wait_for_capacity(self) -> None:
        """Persistently wait and auto-resume without user intervention.

        For Work, a late matching WORK_RESULT is consumed immediately while waiting,
        so a slow reviewer can finish without requiring a resend.
        """
        while True:
            st = self.state()
            if st.get("state") != "WAITING_CAPACITY":
                return

            if self.stop_path.exists():
                self.block(".ai/STOP detected while waiting for service capacity")
                return

            pending_id = str(
                st.get("capacity_pending_request_id", "") or ""
            )
            if st.get("capacity_target") == "work" and pending_id:
                try:
                    result = self._read_matching_work_result(pending_id)
                except Exception as exc:
                    self.log(
                        "Ignoring transient invalid Work result while capacity "
                        f"waiting: {type(exc).__name__}: {exc}"
                    )
                    result = None
                if result is not None:
                    self._apply_work_result(st, result)
                    applied = self.state()
                    if applied.get("state") == "EXECUTE":
                        if not self._check_review_progress(st):
                            return
                    self.log(
                        "WORK completed while waiting for capacity; "
                        f"requested_state={result.get('state')} "
                        f"applied_state={self.state().get('state')}"
                    )
                    return

            retry_at = self._capacity_retry_at(st)
            now = dt.datetime.now().astimezone()
            if now >= retry_at:
                self._finish_capacity_wait(st)
                return

            remaining = max(0, int((retry_at - now).total_seconds()))
            # Log at most once per minute while sleeping.
            if remaining <= 10 or remaining % 60 < 3:
                self.log(
                    f"CAPACITY WAIT target={st.get('capacity_target')} "
                    f"remaining≈{remaining}s; no user action required"
                )
            time.sleep(min(5.0, max(1.0, remaining)))

    def check_stop(self) -> bool:
        if self.stop_path.exists():
            self.block(".ai/STOP detected. Remove it, review state, then restart the orchestrator.")
            return True
        return False

    def _codex_capability_snapshot(self) -> dict[str, Any]:
        """Return launcher-declared sandbox/write capabilities.

        This is deliberately derived from the exact config used to construct the
        next Codex process, so reviewer decisions can distinguish historical
        sandbox evidence from the CURRENT invocation policy.
        """
        c = self.config.get("codex", {})
        extra = [str(x) for x in c.get("extra_args", [])]
        sandbox = ""
        add_dirs: list[str] = []

        i = 0
        while i < len(extra):
            arg = extra[i]
            if arg in {"--sandbox", "-s"} and i + 1 < len(extra):
                sandbox = extra[i + 1]
                i += 2
                continue
            if arg == "--add-dir" and i + 1 < len(extra):
                add_dirs.append(extra[i + 1])
                i += 2
                continue
            i += 1

        return {
            "project_root": str(self.project),
            "sandbox": sandbox or "(CLI/default)",
            "add_dirs": add_dirs,
            "extra_args": extra,
        }

    @staticmethod
    def _norm_win_path(value: str) -> str:
        return os.path.normcase(os.path.normpath(str(value))).rstrip("\\/")

    def _work_blocker_already_satisfied(
        self, result_or_reason: Any
    ) -> tuple[bool, str]:
        """Detect the specific stale writable-root blocker we can prove resolved.

        We do NOT override arbitrary Work BLOCKED_USER decisions. This only
        handles a reviewer asking the human to grant a writable root that is
        already present in the CURRENT Codex launcher as
        `--sandbox workspace-write --add-dir <same path>`.
        """
        if isinstance(result_or_reason, dict):
            blob = " ".join(
                str(result_or_reason.get(k, ""))
                for k in ("decision", "next_action", "reason")
            )
        else:
            blob = str(result_or_reason or "")

        low = blob.lower()
        writable_markers = (
            "writable-root",
            "writable root",
            "writable local",
            "workspace root",
            "workspace scope",
            "outside the writable",
            "grant c:\\",
            "grant c:/",
            "human-controlled writable",
        )
        if not any(m in low for m in writable_markers):
            return False, ""

        cap = self._codex_capability_snapshot()
        if str(cap.get("sandbox", "")).lower() != "workspace-write":
            return False, ""

        add_dirs = [str(x) for x in cap.get("add_dirs", [])]
        if not add_dirs:
            return False, ""

        norm_blob = low.replace("/", "\\")
        for path in add_dirs:
            p = self._norm_win_path(path)
            if p.lower() in norm_blob:
                return True, path

            # Review text may normalize/case-fold the same basename while omitting
            # some formatting. Only accept this relaxed match for a distinctive
            # repo basename, never for a generic directory.
            basename = os.path.basename(p).lower()
            if basename and len(basename) >= 8 and basename in low:
                return True, path

        return False, ""

    def _codex_command(self) -> list[str]:
        c = self.config.get("codex", {})
        cmd = c.get("command", ["codex", "exec"])
        extra = c.get("extra_args", [])
        if not isinstance(cmd, list) or not cmd:
            raise RuntimeError("codex.command must be a non-empty list")
        if not isinstance(extra, list):
            raise RuntimeError("codex.extra_args must be a list")

        # Optional model selection. The value must be the exact model identifier
        # accepted by the installed Codex CLI. Set to "" or null to use Codex's
        # current/default model.
        model = c.get("model", "")
        if model is None:
            model = ""
        if not isinstance(model, str):
            raise RuntimeError("codex.model must be a string, empty string, or null")
        model = model.strip()

        parts = [str(x) for x in cmd]

        # Windows/npm commonly exposes Codex as codex.CMD. PowerShell resolves
        # PATHEXT automatically, while CreateProcess invoked by subprocess may not
        # resolve a bare "codex" the same way. Resolve it explicitly.
        executable = Path(parts[0])
        if not executable.is_absolute():
            resolved = shutil.which(parts[0])
            if not resolved:
                raise FileNotFoundError(
                    f"Codex command {parts[0]!r} was not found via shutil.which/PATH"
                )
            parts[0] = resolved

        # IMPORTANT: never put the full agent prompt on the Windows command line.
        # `codex exec -` explicitly reads the prompt from stdin, avoiding the
        # Windows command-line length limit.
        args = parts + [str(x) for x in extra]
        if model:
            args += ["--model", model]
        return args + ["-"]

    def _codex_prompt(self, st: dict[str, Any]) -> str:
        if st.get("work_feedback_pending"):
            direct_action = (
                "\n\n=== DIRECT WORK REVIEW RESULT ===\n"
                + read_text(self.work_result_path)
                + "\n=== DIRECT WORK REVIEW RESULT END ===\n"
                + "\nThis is the reviewer handoff for THIS execution turn. "
                  "The orchestrator already mirrored it into NEXT_ACTION.md for persistence. "
                  "Do not spend tokens re-reading NEXT_ACTION.md just to recover the same review.\n"
            )
        else:
            direct_action = (
                "\n\n=== CURRENT NEXT_ACTION.md ===\n"
                + read_text(self.ai / "NEXT_ACTION.md")
            )

        return (
            read_text(self.executor_contract)
            + "\n\n=== EXECUTOR CONTRACT END ===\n\n"
            + read_text(self.ai / "CODEX_EXECUTOR_PROMPT.md")
            + "\n\n=== ORCHESTRATOR RUNTIME ===\n"
            + f"Project root: {self.project}\n"
            + f"Shared AI directory: {self.ai}\n"
            + f"Iteration: {st.get('iteration', 0)}\n"
            + f"Evidence revision: {st.get('evidence_revision', 0)}\n"
            + f"Review revision: {st.get('review_revision', 0)}\n"
            + "\n=== CURRENT CODEX LAUNCH CAPABILITIES ===\n"
            + json.dumps(
                self._codex_capability_snapshot(),
                ensure_ascii=False,
                indent=2,
            )
            + "\nTreat this launcher snapshot as current authority. "
              "If historical NEXT_ACTION/STATUS says a configured --add-dir is "
              "not writable, perform one fresh minimal write-capability check "
              "through the approved patch/edit mechanism before repeating that "
              "historical blocker.\n"
            + "\nIMPORTANT PATH RULE:\n"
            + f"Whenever the protocol says `.ai/...`, use `{self.ai}\\...`.\n"
            + direct_action
            + f"\n\nBefore returning, update `{self.state_path}` and DO NOT leave state=EXECUTING.\n"
        )

    def _stop_codex_process(self, proc: subprocess.Popen, grace_seconds: float = 8.0) -> None:
        """Best-effort stop of the Codex subprocess after user interruption.

        On Windows the process is started in a separate process group, so we first
        send CTRL_BREAK_EVENT. We then fall back to terminate/kill if needed.
        """
        if proc.poll() is not None:
            return

        try:
            if os.name == "nt":
                proc.send_signal(signal.CTRL_BREAK_EVENT)
            else:
                proc.terminate()
        except Exception:
            try:
                proc.terminate()
            except Exception:
                pass

        try:
            proc.wait(timeout=grace_seconds)
            return
        except Exception:
            pass

        try:
            proc.terminate()
            proc.wait(timeout=3)
            return
        except Exception:
            pass

        try:
            proc.kill()
            proc.wait(timeout=3)
        except Exception:
            pass

    def _sha256_file(self, path: Path) -> str:
        h = hashlib.sha256()
        with path.open("rb") as f:
            for chunk in iter(lambda: f.read(1024 * 1024), b""):
                h.update(chunk)
        return h.hexdigest().upper()

    def _runtime_manifest_path(self) -> Path:
        return self.ai / "QEMU_RUNTIME.json"

    def _load_qemu_runtime_manifest(self) -> Optional[dict[str, Any]]:
        """Load the machine-readable canonical QEMU runtime manifest if present."""
        path = self._runtime_manifest_path()
        if not path.is_file():
            return None
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception as exc:
            raise RuntimeError(
                f"Invalid QEMU_RUNTIME.json: {type(exc).__name__}: {exc}"
            )
        if not isinstance(data, dict):
            raise RuntimeError("QEMU_RUNTIME.json must contain one JSON object")
        if data.get("schema_version") != 1:
            raise RuntimeError("QEMU_RUNTIME.json schema_version must be 1")
        return data

    def _validated_manifest_qemu(
        self,
        env: dict[str, str],
    ) -> tuple[str, str]:
        """Return canonical QEMU executable/runtime dir from QEMU_RUNTIME.json.

        If the manifest exists, it is authoritative. A missing executable or SHA
        mismatch is a hard error rather than a silent heuristic fallback.
        """
        manifest = self._load_qemu_runtime_manifest()
        if manifest is None:
            return "", ""

        raw_exe = str(manifest.get("canonical_executable", "") or "").strip()
        expected_sha = str(
            manifest.get("canonical_executable_sha256", "") or ""
        ).strip().upper()
        raw_runtime_dir = str(
            manifest.get("canonical_runtime_dir", "") or ""
        ).strip()

        if not raw_exe:
            raise RuntimeError(
                "QEMU_RUNTIME.json exists but canonical_executable is empty"
            )

        exe = self._expand_discovery_path(raw_exe)
        if not exe.is_file():
            raise RuntimeError(
                f"QEMU_RUNTIME.json canonical_executable does not exist: {exe}"
            )
        exe = exe.resolve()

        actual_sha = self._sha256_file(exe)
        if expected_sha and actual_sha != expected_sha:
            raise RuntimeError(
                "QEMU_RUNTIME.json SHA256 mismatch: "
                f"expected={expected_sha} actual={actual_sha} path={exe}"
            )

        runtime_dir = ""
        if raw_runtime_dir:
            p = self._expand_discovery_path(raw_runtime_dir)
            if not p.is_dir():
                raise RuntimeError(
                    f"QEMU_RUNTIME.json canonical_runtime_dir does not exist: {p}"
                )
            runtime_dir = str(p.resolve())
        else:
            runtime_dir = str(exe.parent)

        # Runtime staging directories commonly carry dependent DLLs. Prepending the
        # proven runtime directory to PATH lets the child/harness resolve the same
        # runtime dependencies as the validated baseline.
        current_path = env.get("PATH", "")
        path_parts = current_path.split(os.pathsep) if current_path else []
        if runtime_dir and runtime_dir.lower() not in {
            p.lower() for p in path_parts if p
        }:
            env["PATH"] = runtime_dir + (os.pathsep + current_path if current_path else "")

        self.log(
            "QEMU_RUNTIME manifest PASS "
            f"exe={exe} sha256={actual_sha} runtime_dir={runtime_dir}"
        )
        return str(exe), runtime_dir

    def _artifact_cache_path(self) -> Path:
        return self.ai / "discovered_artifacts.json"

    def _load_artifact_cache(self) -> dict[str, str]:
        path = self._artifact_cache_path()
        try:
            data = json.loads(path.read_text(encoding="utf-8"))
        except Exception:
            return {}
        if not isinstance(data, dict):
            return {}
        return {
            "firmware": str(data.get("firmware", "") or ""),
            "qemu": str(data.get("qemu", "") or ""),
        }

    def _save_artifact_cache(self, firmware: str, qemu: str) -> None:
        try:
            atomic_write_json(
                self._artifact_cache_path(),
                {
                    "firmware": firmware,
                    "qemu": qemu,
                    "updated_at": now_iso(),
                },
            )
        except Exception as exc:
            self.log(
                f"AUTO artifact cache write warning: {type(exc).__name__}: {exc}"
            )

    def _expand_discovery_path(self, raw: str) -> Path:
        source_root = self.project.parent
        value = str(raw)
        value = value.replace("{project_root}", str(self.project))
        value = value.replace("{source_root}", str(source_root))
        value = value.replace(
            "{orchestrator_root}", str(self.orchestrator_root)
        )
        return Path(value).expanduser()

    def _search_named_files(
        self,
        roots: list[Path],
        names: set[str],
        max_results: int = 64,
    ) -> list[Path]:
        """Bounded recursive local search used only when cached/explicit paths fail."""
        wanted = {name.lower() for name in names}
        found: list[Path] = []
        seen: set[str] = set()

        for root in roots:
            try:
                root = root.resolve()
            except Exception:
                pass

            if not root.exists():
                continue

            if root.is_file():
                if root.name.lower() in wanted:
                    key = str(root).lower()
                    if key not in seen:
                        seen.add(key)
                        found.append(root)
                continue

            try:
                for dirpath, dirnames, filenames in os.walk(root):
                    # Keep the search bounded and avoid obviously irrelevant trees.
                    dirnames[:] = [
                        d for d in dirnames
                        if d.lower() not in {
                            ".git", ".vs", ".venv", "venv", "node_modules",
                            "__pycache__"
                        }
                    ]
                    for filename in filenames:
                        if filename.lower() not in wanted:
                            continue
                        p = (Path(dirpath) / filename).resolve()
                        key = str(p).lower()
                        if key in seen:
                            continue
                        seen.add(key)
                        found.append(p)
                        if len(found) >= max_results:
                            return found
            except (OSError, PermissionError):
                continue

        return found

    def _score_firmware(self, p: Path) -> tuple[int, float, str]:
        s = str(p).lower()
        score = 0
        if p.name.lower() == "merged.bin":
            score += 1000
        if "ii1p04_gpio_debug" in s:
            score += 500
        if "\\build\\" in s or "/build/" in s:
            score += 40
        try:
            mtime = p.stat().st_mtime
        except OSError:
            mtime = 0.0
        return (score, mtime, s)

    def _score_qemu(self, p: Path) -> tuple[int, float, str]:
        s = str(p).lower()
        score = 0
        if p.name.lower() == "qemu-system-xtensa.exe":
            score += 1000

        # Prefer the active development source/build tree when present.
        if "qemu_lasecsimul" in s:
            score += 600
        if "ii1p04_gpio_debug" in s:
            score += 300
        if "\\build\\" in s or "/build/" in s:
            score += 150

        # Do not accidentally prefer the frozen historical rollback executable.
        historical = str(
            self.project
            / "devices"
            / "qemu-esp32"
            / "bin"
            / "qemu-system-xtensa.exe"
        ).lower()
        if s == historical:
            score -= 1000

        try:
            mtime = p.stat().st_mtime
        except OSError:
            mtime = 0.0
        return (score, mtime, s)

    def _resolve_test_artifacts(
        self,
        env: dict[str, str],
        verbose: bool = True,
    ) -> dict[str, str]:
        """Find firmware and QEMU locally and inject them into the Codex environment.

        Priority:
          1. valid environment variables already set by the user;
          2. optional explicit config paths;
          3. valid cached discovery;
          4. bounded automatic search.

        No prompt/user interaction is required.
        """
        cfg = self.config.get("artifact_discovery", {})
        if cfg.get("enabled", True) is False:
            return env

        source_root = self.project.parent
        cache = self._load_artifact_cache()

        def valid_file(value: str) -> str:
            if not value:
                return ""
            try:
                p = self._expand_discovery_path(value)
                if p.is_file():
                    return str(p.resolve())
            except Exception:
                pass
            return ""

        firmware = valid_file(env.get("LASECSIMUL_TEST_FIRMWARE", ""))
        qemu = valid_file(env.get("LASECSIMUL_TEST_QEMU_BINARY", ""))

        if not firmware:
            firmware = valid_file(str(cfg.get("firmware_path", "") or ""))
        if not qemu:
            qemu = valid_file(str(cfg.get("qemu_binary_path", "") or ""))

        # If there is no explicit valid QEMU override, QEMU_RUNTIME.json is
        # authoritative. This prevents accidentally selecting one of many historical
        # qemu-system-xtensa.exe copies by name/date heuristics.
        if not qemu:
            manifest_qemu, _manifest_runtime_dir = self._validated_manifest_qemu(env)
            if manifest_qemu:
                qemu = manifest_qemu

        if not firmware:
            firmware = valid_file(cache.get("firmware", ""))
        if not qemu:
            qemu = valid_file(cache.get("qemu", ""))

        # Defaults deliberately include the sibling firmware project the user uses,
        # the active QEMU source tree, the LasecSimul tree, and C:\SourceCode.
        firmware_roots = [
            self._expand_discovery_path(x)
            for x in cfg.get(
                "firmware_roots",
                [
                    r"C:\SourceCode\II1P04_GPIO_Debug",
                    "{project_root}",
                    "{source_root}",
                ],
            )
        ]
        qemu_roots = [
            self._expand_discovery_path(x)
            for x in cfg.get(
                "qemu_roots",
                [
                    r"C:\SourceCode\II1P04_GPIO_Debug",
                    r"C:\SourceCode\qemu_lasecSimul",
                    "{project_root}",
                    "{source_root}",
                ],
            )
        ]

        if not firmware:
            candidates = self._search_named_files(
                firmware_roots,
                set(cfg.get("firmware_names", ["merged.bin"])),
            )
            if candidates:
                candidates.sort(key=self._score_firmware, reverse=True)
                firmware = str(candidates[0])

        if not qemu:
            candidates = self._search_named_files(
                qemu_roots,
                set(cfg.get("qemu_names", ["qemu-system-xtensa.exe"])),
            )
            if candidates:
                candidates.sort(key=self._score_qemu, reverse=True)
                qemu = str(candidates[0])

        if firmware:
            env["LASECSIMUL_TEST_FIRMWARE"] = firmware
        if qemu:
            env["LASECSIMUL_TEST_QEMU_BINARY"] = qemu

        if firmware or qemu:
            self._save_artifact_cache(firmware, qemu)

        if verbose:
            self.log(
                "AUTO artifacts "
                f"firmware={firmware or 'NOT_FOUND'} "
                f"qemu={qemu or 'NOT_FOUND'}"
            )

        return env

    def run_codex(self) -> None:
        c = self.config.get("codex", {})
        if not c.get("enabled", True):
            self.block("Codex disabled in config.json")
            return

        st = self.state()
        iteration = int(st.get("iteration", 0)) + 1
        if iteration > self.max_iterations:
            self.block(f"Maximum {self.max_iterations} iterations reached")
            return

        self.update_state(state="EXECUTING", iteration=iteration, last_actor="codex", reason="")
        st = self.state()
        prompt = self._codex_prompt(st)
        cmd = self._codex_command()
        timeout = int(c.get("timeout_minutes", 180)) * 60

        logs = self.ai / "logs"
        logs.mkdir(exist_ok=True)
        logfile = logs / f"codex_{iteration:04d}.log"
        env = os.environ.copy()
        env["LASECSIMUL_ORCHESTRATOR"] = "1"

        # Resolve external test inputs automatically. The Codex child and every
        # process it launches inherit these values.
        env = self._resolve_test_artifacts(env)

        self.log(f"CODEX start iteration={iteration}")
        start = time.time()
        try:
            with logfile.open("w", encoding="utf-8", errors="replace") as out:
                creationflags = (
                    subprocess.CREATE_NEW_PROCESS_GROUP if os.name == "nt" else 0
                )
                proc = subprocess.Popen(
                    cmd,
                    cwd=str(self.project),
                    stdin=subprocess.PIPE,
                    stdout=out,
                    stderr=subprocess.STDOUT,
                    env=env,
                    text=True,
                    encoding="utf-8",
                    creationflags=creationflags,
                )
                try:
                    # Send the complete prompt through stdin rather than argv.
                    # This is the supported `codex exec -` path and avoids Windows'
                    # command-line length limit even when the shared .ai context is large.
                    if proc.stdin is None:
                        raise RuntimeError("Codex stdin pipe was not created")
                    proc.stdin.write(prompt)
                    if not prompt.endswith("\n"):
                        proc.stdin.write("\n")
                    proc.stdin.close()
                    rc = proc.wait(timeout=timeout)
                except subprocess.TimeoutExpired:
                    self._stop_codex_process(proc)
                    self.block(f"Codex timed out. See {logfile}")
                    return
                except KeyboardInterrupt:
                    self.log(
                        f"Ctrl+C received during Codex iteration={iteration}; "
                        "stopping Codex child process"
                    )
                    self._stop_codex_process(proc)
                    self.block(
                        f"Codex iteration={iteration} interrupted by user. "
                        f"Child process was stopped. Partial work may exist; see {logfile}. "
                        "Use --resume to continue explicitly."
                    )
                    raise
        except FileNotFoundError as exc:
            self.block(
                "Codex command could not be launched from Python. "
                f"Details: {exc}. Run `python orchestrator.py --test-codex`."
            )
            return
        except Exception as exc:
            self.block(f"Could not run Codex: {type(exc).__name__}: {exc}")
            return

        self.log(f"CODEX end iteration={iteration} rc={rc} elapsed={time.time()-start:.1f}s")
        self._trim_codex_logs()
        if rc != 0:
            log_text = read_text(logfile)
            if self._looks_like_capacity_limit(log_text):
                default_retry = float(
                    c.get("capacity_retry_probe_seconds", 300)
                )
                retry_seconds = self._capacity_retry_seconds(
                    log_text, default_retry
                )
                # Capacity denial is not a semantic executor iteration. Reuse the
                # same iteration number on retry and preserve the failed log under
                # a distinct capacity filename when possible.
                try:
                    stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
                    saved = logfile.with_name(
                        f"{logfile.stem}_capacity_{stamp}{logfile.suffix}"
                    )
                    logfile.replace(saved)
                    capacity_log = saved
                except OSError:
                    capacity_log = logfile
                self._schedule_capacity_wait(
                    target="codex",
                    resume_state="EXECUTE",
                    reason=(
                        "Codex usage/rate capacity temporarily unavailable; "
                        f"automatic retry scheduled. Evidence: {capacity_log}"
                    ),
                    retry_seconds=retry_seconds,
                    iteration_override=iteration - 1,
                )
                return

            self.block(f"Codex exited rc={rc}. See {logfile}")
            return

        after = self.state()

        # A Work result is injected directly into exactly one successful Codex turn.
        # If Codex crashed/interrupted, this flag remains true so the feedback is not lost.
        if after.get("work_feedback_pending"):
            after = self.update_state(work_feedback_pending=False)

        if after.get("interrupted_iteration"):
            after = self.update_state(interrupted_iteration="")

        if after.get("state") == "EXECUTING":
            self.log("Codex returned without selecting next state; safe fallback -> REVIEW_REQUIRED")
            self.update_state(
                state="REVIEW_REQUIRED", last_actor="orchestrator",
                reason="Codex ended without changing state from EXECUTING",
            )

    def _trim_codex_logs(self) -> None:
        keep = int(self.config.get("logging", {}).get("keep_codex_logs", 20))
        if keep <= 0:
            return
        items = sorted((self.ai / "logs").glob("codex_*.log"))
        for p in items[:-keep]:
            try:
                p.unlink()
            except OSError:
                pass

    def _work_call_capacity_available(self) -> bool:
        """Check the local Work calls/hour budget without consuming a slot.

        A UI bridge attempt that never confirms prompt delivery is transport
        activity, not a Work review call. The slot is recorded only after the
        prompt has actually been sent.
        """
        now = time.time()
        while self.work_calls and now - self.work_calls[0] > 3600:
            self.work_calls.popleft()
        if len(self.work_calls) >= self.max_work_calls_per_hour:
            remaining = max(
                5.0, 3600.0 - (now - self.work_calls[0]) + 2.0
            )
            st = self.state()
            self._schedule_capacity_wait(
                target="work",
                resume_state="REVIEW_REQUIRED",
                reason=(
                    f"Local Work call safeguard reached "
                    f"{self.max_work_calls_per_hour}/hour; automatic retry scheduled."
                ),
                retry_seconds=remaining,
                review_trigger=str(
                    st.get("review_trigger", "") or "codex_requested"
                ),
            )
            return False
        return True

    def _record_work_call(self) -> None:
        now = time.time()
        while self.work_calls and now - self.work_calls[0] > 3600:
            self.work_calls.popleft()
        self.work_calls.append(now)

    def _check_review_progress(self, st: dict[str, Any]) -> bool:
        rev = int(st.get("evidence_revision", 0))
        if self.last_review_evidence is None:
            self.last_review_evidence = rev
            return True
        if rev <= self.last_review_evidence:
            self.no_progress_reviews += 1
        else:
            self.no_progress_reviews = 0
            self.last_review_evidence = rev
        if self.no_progress_reviews >= self.max_no_progress_reviews:
            self.block(
                f"{self.no_progress_reviews} Work cycles without evidence_revision progress; possible loop"
            )
            return False
        return True

    def _native_work_window(self) -> tuple[int, str]:
        """Find the intended ChatGPT top-level window using Win32 only.

        The normal `last_focused_composer` path does not need Chromium/UIA child
        enumeration. Native EnumWindows is much cheaper and avoids the observed
        pywinauto UIA enumeration hang.
        """
        if os.name != "nt":
            raise RuntimeError("Native Work window bridge currently requires Windows")

        import ctypes
        from ctypes import wintypes

        user32 = ctypes.windll.user32
        title_re = self.config.get("work", {}).get(
            "window_title_regex", r".*ChatGPT.*"
        )
        matches: list[tuple[int, int, str]] = []

        EnumWindowsProc = ctypes.WINFUNCTYPE(
            ctypes.c_bool, wintypes.HWND, wintypes.LPARAM
        )

        @EnumWindowsProc
        def enum_proc(hwnd, _lparam):
            try:
                if not user32.IsWindowVisible(hwnd):
                    return True
                length = user32.GetWindowTextLengthW(hwnd)
                if length <= 0:
                    return True
                buf = ctypes.create_unicode_buffer(length + 1)
                user32.GetWindowTextW(hwnd, buf, length + 1)
                title = buf.value or ""
                if not re.search(title_re, title, re.I):
                    return True

                rect = wintypes.RECT()
                area = 0
                if user32.GetWindowRect(hwnd, ctypes.byref(rect)):
                    area = max(0, rect.right - rect.left) * max(
                        0, rect.bottom - rect.top
                    )
                matches.append((area, int(hwnd), title))
            except Exception:
                pass
            return True

        if not user32.EnumWindows(enum_proc, 0):
            raise RuntimeError("Win32 EnumWindows failed while locating ChatGPT")

        if not matches:
            raise RuntimeError(
                f"ChatGPT window not found by native Win32 "
                f"(regex={title_re!r}). Keep the intended Work conversation open."
            )

        matches.sort(reverse=True)
        _, hwnd, title = matches[0]
        return hwnd, title

    def _focus_native_work_window(self, hwnd: int) -> None:
        """Focus one HWND without Chromium UIA tree traversal."""
        import ctypes

        user32 = ctypes.windll.user32

        # Restore if minimized, then use a Win32-backed HwndWrapper. This does not
        # enumerate Chromium descendants and has proved substantially less fragile
        # than Desktop(backend="uia").windows().
        SW_RESTORE = 9
        try:
            user32.ShowWindow(hwnd, SW_RESTORE)
        except Exception:
            pass

        try:
            from pywinauto.controls.hwndwrapper import HwndWrapper
            HwndWrapper(hwnd).set_focus()
            return
        except Exception:
            pass

        if not user32.SetForegroundWindow(hwnd):
            raise RuntimeError(
                f"Could not focus ChatGPT HWND={hwnd} using Win32 bridge"
            )

    def _work_windows(self):
        from pywinauto import Desktop
        w = self.config.get("work", {})
        title_re = w.get("window_title_regex", r".*ChatGPT.*")
        wins = [
            x for x in Desktop(backend="uia").windows()
            if re.search(title_re, x.window_text() or "", re.I)
        ]
        if not wins:
            raise RuntimeError(
                f"ChatGPT window not found (regex={title_re!r}). "
                "Open the intended Work conversation first."
            )
        return wins

    def _largest_work_window(self):
        wins = self._work_windows()

        def area(win):
            try:
                r = win.rectangle()
                return max(0, r.width()) * max(0, r.height())
            except Exception:
                return 0

        return sorted(wins, key=area, reverse=True)[0]

    def inspect_work(self) -> int:
        try:
            wins = self._work_windows()
        except ImportError:
            print("Install requirements.txt first")
            return 2
        except Exception as exc:
            print(str(exc))
            return 1

        mode = self.config.get("work", {}).get("input_mode", "last_focused_composer")
        print(f"Work input mode: {mode}")

        total_edits = 0
        for wi, win in enumerate(wins):
            print(f"\nWINDOW[{wi}] {win.window_text()!r}")
            edits = []
            try:
                edits = win.descendants(control_type="Edit")
            except Exception:
                edits = []
            for i, ctrl in enumerate(edits):
                try:
                    r = ctrl.rectangle()
                    print(
                        f" EDIT[{i}] name={ctrl.window_text()!r} "
                        f"automation_id={ctrl.element_info.automation_id!r} "
                        f"rect=({r.left},{r.top},{r.right},{r.bottom}) "
                        f"visible={ctrl.is_visible()} enabled={ctrl.is_enabled()}"
                    )
                    total_edits += 1
                except Exception as exc:
                    print(f" EDIT[{i}] error={exc}")

        if mode == "last_focused_composer" and total_edits == 0:
            print(
                "\nINFO: no Edit control is exposed by ChatGPT Desktop UIA. "
                "This is expected for the tested Chromium/WebView shell. "
                "The orchestrator will focus the ChatGPT window and send Ctrl+V + Enter "
                "to the composer that was last focused manually."
            )
            print(
                "Before starting continuous mode, open the intended Work conversation, "
                "click the message composer once, then return to the terminal with Alt+Tab."
            )
        return 0

    def _work_input_uia(self):
        w = self.config.get("work", {})
        input_re = w.get(
            "input_name_regex",
            r".*(Message|Ask|Pergunte|Mensagem|Send a message|Enviar mensagem).*",
        )
        win = self._largest_work_window()
        win.set_focus()
        edits = []
        for ctrl in win.descendants(control_type="Edit"):
            try:
                if ctrl.is_visible() and ctrl.is_enabled():
                    edits.append(ctrl)
            except Exception:
                pass
        preferred = [e for e in edits if re.search(input_re, e.window_text() or "", re.I)]
        if preferred:
            preferred.sort(key=lambda e: e.rectangle().bottom, reverse=True)
            return win, preferred[0]
        raise RuntimeError(
            "Work message box not identified safely through UIA. "
            "Use work.input_mode='last_focused_composer' for the tested ChatGPT Desktop shell, "
            "or run --inspect-work and adjust input_name_regex."
        )

    def _send_work_text(self, prompt: str) -> None:
        import pyperclip
        from pywinauto.keyboard import send_keys

        w = self.config.get("work", {})
        mode = w.get("input_mode", "last_focused_composer")
        focus_delay = float(w.get("focus_delay_seconds", 1.0))
        paste_delay = float(w.get("paste_delay_seconds", 0.30))

        pyperclip.copy(prompt)

        if mode == "last_focused_composer":
            hwnd, title = self._native_work_window()
            self._focus_native_work_window(hwnd)
            time.sleep(focus_delay)

            # No Chromium/UIA tree enumeration and no mouse coordinates. The
            # intended Work conversation must have had its composer focused once;
            # focusing the top-level window restores that browser/webview focus.
            send_keys("^v")
            time.sleep(paste_delay)
            send_keys("{ENTER}")
            return

        if mode == "uia_edit":
            _, ctrl = self._work_input_uia()
            ctrl.set_focus()
            time.sleep(focus_delay)
            ctrl.type_keys("^v")
            time.sleep(paste_delay)
            ctrl.type_keys("{ENTER}")
            return

        raise RuntimeError(
            f"Unsupported work.input_mode={mode!r}. "
            "Use 'last_focused_composer' or 'uia_edit'."
        )

    def _work_capacity_probe_bounded(self) -> str:
        """Best-effort read of visible ChatGPT UIA text for capacity messages.

        Empty output means "not detected", not proof that capacity is available.
        The probe is disposable and tightly bounded because Chromium UIA can hang.
        """
        w = self.config.get("work", {})
        timeout = float(w.get("ui_capacity_probe_timeout_seconds", 5.0))
        cmd = [
            sys.executable,
            str(Path(__file__).resolve()),
            "--config",
            str(self.config_path),
            "--_work-capacity-probe",
        ]
        try:
            proc = subprocess.run(
                cmd,
                cwd=str(self.orchestrator_root),
                capture_output=True,
                text=True,
                encoding="utf-8",
                timeout=max(2.0, timeout),
                env=os.environ.copy(),
            )
        except Exception:
            return ""
        if proc.returncode != 0:
            return ""
        return (proc.stdout or "").strip()

    def _work_capacity_probe_local(self) -> str:
        """Child-only UIA scan for visible rate/usage-limit text."""
        try:
            hwnd, title = self._native_work_window()
            chunks: list[str] = [title]
            # Full UIA descendant scan is optional here because this probe runs in
            # a disposable bounded helper. The send path itself never depends on it.
            win = None
            try:
                from pywinauto import Desktop
                win = Desktop(backend="uia").window(handle=hwnd)
            except Exception:
                win = None
            if win is not None:
                try:
                    for ctrl in win.descendants():
                        try:
                            value = ctrl.window_text() or ""
                        except Exception:
                            continue
                        if value:
                            chunks.append(value)
                        if len(chunks) >= 500:
                            break
                except Exception:
                    pass
            joined = "\n".join(chunks)
            if not self._looks_like_capacity_limit(joined):
                return ""
            lines = [
                line.strip()
                for line in joined.splitlines()
                if line.strip()
                and self._looks_like_capacity_limit(line)
            ]
            return "\n".join(lines[:20]) or joined[-2000:]
        except Exception:
            return ""

    def _send_work_text_bounded(self, prompt: str, request_id: str) -> None:
        """Run the UIA/keyboard bridge in a disposable child process.

        Windows UI Automation can occasionally block inside window enumeration or
        focus acquisition. Keeping that work in a child process gives the parent a
        hard timeout and prevents the whole autonomous orchestrator from hanging
        forever before the prompt is sent.
        """
        w = self.config.get("work", {})
        timeout = float(w.get("ui_send_timeout_seconds", 20.0))
        timeout = max(5.0, timeout)

        prompt_path = self.ai / f".work_prompt_{request_id}.txt"
        prompt_path.write_text(prompt, encoding="utf-8")

        cmd = [
            sys.executable,
            str(Path(__file__).resolve()),
            "--config",
            str(self.config_path),
            "--_work-send-helper",
            str(prompt_path),
        ]

        self.log(
            f"WORK UI bridge start request_id={request_id} "
            f"timeout={timeout:.1f}s"
        )
        try:
            try:
                proc = subprocess.run(
                    cmd,
                    cwd=str(self.orchestrator_root),
                    capture_output=True,
                    text=True,
                    encoding="utf-8",
                    timeout=timeout,
                    env=os.environ.copy(),
                )
            except subprocess.TimeoutExpired as exc:
                raise RuntimeError(
                    "Work UI bridge timed out before confirming send. "
                    "The disposable UI helper was terminated. "
                    "Open the intended ChatGPT Work conversation, click its composer "
                    "once, Alt+Tab back, then use --recover-review and retry."
                ) from exc

            if proc.returncode != 0:
                detail = (proc.stderr or proc.stdout or "").strip()
                if len(detail) > 1200:
                    detail = detail[-1200:]
                raise RuntimeError(
                    f"Work UI helper exited rc={proc.returncode}"
                    + (f": {detail}" if detail else "")
                )

            self.log(f"WORK UI bridge completed request_id={request_id}")
        finally:
            try:
                prompt_path.unlink()
            except OSError:
                pass

    def test_work(self) -> int:
        """Send one harmless message to the already-open Work conversation.

        This does not change .ai/state.json and does not invoke Codex.
        """
        try:
            import pyperclip  # noqa: F401
            import pywinauto  # noqa: F401
        except ImportError:
            print("Install requirements.txt first")
            return 2

        w = self.config.get("work", {})
        message = w.get(
            "test_message",
            "TESTE DO ORQUESTRADOR - responda apenas: WORK UI OK",
        )

        try:
            test_request_id = "test-" + uuid.uuid4().hex
            self._send_work_text_bounded(message, test_request_id)
        except Exception as exc:
            print(
                f"WORK UI TEST FAIL: {type(exc).__name__}: {exc}",
                file=sys.stderr,
            )
            return 1

        print("WORK UI TEST SENT (same bounded/native bridge as production)")
        print("Expected message:")
        print(message)
        print(
            "If it appeared in the intended Work conversation, the last-focused-composer "
            "bridge is ready."
        )
        return 0

    def _periodic_work_review_interval(self) -> int:
        """Maximum number of successful Codex EXECUTE turns between Work reviews.

        0 disables periodic reviews while preserving immediate REVIEW_REQUIRED
        handoffs. The default is deliberately 2 for this orchestrator.
        """
        raw = self.config.get("work", {}).get(
            "periodic_review_every_codex_iterations", 2
        )
        try:
            value = int(raw)
        except (TypeError, ValueError) as exc:
            raise RuntimeError(
                "work.periodic_review_every_codex_iterations must be an integer"
            ) from exc
        if value < 0:
            raise RuntimeError(
                "work.periodic_review_every_codex_iterations must be >= 0; "
                "use 0 for on-demand-only Work reviews"
            )
        return value

    def _periodic_work_review_due(self, st: dict[str, Any]) -> bool:
        interval = self._periodic_work_review_interval()
        if interval <= 0 or st.get("state") != "EXECUTE":
            return False

        current_iteration = int(st.get("iteration", 0))
        last_review_iteration = st.get("last_work_review_iteration")

        # Migration behavior for an installation that predates this field:
        # if Work has already reviewed at least once, start counting from the
        # current iteration rather than immediately forcing an ambiguous review.
        if last_review_iteration is None:
            if int(st.get("review_revision", 0)) > 0:
                self.update_state(last_work_review_iteration=current_iteration)
                self.log(
                    "Periodic Work review counter initialized at "
                    f"iteration={current_iteration}"
                )
                return False
            last_review_iteration = 0

        try:
            last_review_iteration = int(last_review_iteration)
        except (TypeError, ValueError):
            last_review_iteration = 0

        return (current_iteration - last_review_iteration) >= interval

    def _periodic_review_packet(
        self,
        st: dict[str, Any],
        max_chars: int,
    ) -> str:
        """Build a fresh compact packet for a forced periodic Work checkpoint.

        REVIEW_PACKET.md may be stale because Codex only needs to refresh it for a
        semantic REVIEW_REQUIRED checkpoint. Periodic reviews therefore use the
        mandatory current handoff plus compact tails of STATUS/NEXT_ACTION instead.
        """
        handoff = read_text(self.ai / "QEMU_HANDOFF.md").strip()
        status = read_text(self.ai / "STATUS.md").strip()
        next_action = read_text(self.ai / "NEXT_ACTION.md").strip()

        def tail(value: str, limit: int) -> str:
            if len(value) <= limit:
                return value
            return "[... earlier text omitted ...]\n" + value[-limit:]

        packet = (
            "# PERIODIC WORK REVIEW CHECKPOINT\n\n"
            "This checkpoint was forced by the orchestrator after the configured "
            "number of Codex EXECUTE turns. Codex did not necessarily request an "
            "architectural review. Review direction, evidence quality, regressions, "
            "and the next smallest safe action. Do not manufacture a root cause.\n\n"
            "## ORCHESTRATOR STATE\n"
            f"iteration = {st.get('iteration', 0)}\n"
            f"evidence_revision = {st.get('evidence_revision', 0)}\n"
            f"review_revision = {st.get('review_revision', 0)}\n\n"
            "## CURRENT QEMU HANDOFF\n"
            + (handoff or "(QEMU_HANDOFF.md missing/empty)")
            + "\n\n## RECENT STATUS\n"
            + tail(status, 3000)
            + "\n\n## CURRENT/NEXT ACTION CONTEXT\n"
            + tail(next_action, 3000)
        )

        if max_chars > 0 and len(packet) > max_chars:
            # The handoff is the authoritative continuity record. Preserve it first
            # and reduce the lower-priority tails to stay within the existing bound.
            packet = (
                "# PERIODIC WORK REVIEW CHECKPOINT\n\n"
                "Forced periodic reviewer checkpoint. Review the current handoff "
                "and return the smallest safe next action.\n\n"
                "## ORCHESTRATOR STATE\n"
                f"iteration = {st.get('iteration', 0)}\n"
                f"evidence_revision = {st.get('evidence_revision', 0)}\n"
                f"review_revision = {st.get('review_revision', 0)}\n\n"
                "## CURRENT QEMU HANDOFF\n"
                + tail(handoff or "(QEMU_HANDOFF.md missing/empty)", 6000)
                + "\n\n## CURRENT/NEXT ACTION TAIL\n"
                + tail(next_action, 2500)
            )

        if max_chars > 0 and len(packet) > max_chars:
            packet = packet[:max_chars]

        return packet

    def _codex_blocked_review_packet(
        self,
        st: dict[str, Any],
        max_chars: int,
    ) -> str:
        """Build the reviewer packet when Codex attempted BLOCKED_USER.

        Codex is not allowed to escalate directly to the human. Work must first
        try to solve, route around, or reduce the blocker to the smallest genuinely
        human-only action.
        """
        handoff = read_text(self.ai / "QEMU_HANDOFF.md").strip()
        status = read_text(self.ai / "STATUS.md").strip()
        next_action = read_text(self.ai / "NEXT_ACTION.md").strip()
        blocked = read_text(self.ai / "BLOCKED.md").strip()
        original_reason = str(st.get("reason", "") or "").strip()

        def tail(value: str, limit: int) -> str:
            if len(value) <= limit:
                return value
            return "[... earlier text omitted ...]\n" + value[-limit:]

        packet = (
            "# CODEX BLOCKER — WORK MUST TRIAGE BEFORE USER\n\n"
            "Codex attempted to escalate to BLOCKED_USER. This escalation has been "
            "intercepted by Python. Do NOT forward it to the user reflexively.\n\n"
            "First determine whether the blocker can be solved with the persisted "
            "evidence, repository state, available local commands, a safer alternate "
            "experiment, or a clarified next action. Prefer EXECUTE whenever a safe "
            "non-human next step exists.\n\n"
            "Return BLOCKED_USER only when the remaining requirement is genuinely "
            "human-only (for example: explicit authorization, unavailable secret/"
            "credential, physical interaction, missing external artifact only the "
            "human can provide, or an ambiguity that cannot be resolved from the "
            "project/evidence). If BLOCKED_USER is unavoidable, state what was tried "
            "and request the smallest exact user action needed.\n\n"
            "## ORIGINAL CODEX BLOCKER\n"
            + (original_reason or "(no reason recorded)")
            + "\n\n## CURRENT QEMU HANDOFF\n"
            + (handoff or "(QEMU_HANDOFF.md missing/empty)")
            + "\n\n## BLOCKED RECORD\n"
            + tail(blocked, 1800)
            + "\n\n## CURRENT STATUS TAIL\n"
            + tail(status, 2600)
            + "\n\n## NEXT ACTION TAIL\n"
            + tail(next_action, 2200)
        )

        if max_chars > 0 and len(packet) > max_chars:
            packet = (
                "# CODEX BLOCKER — WORK MUST TRIAGE BEFORE USER\n\n"
                "Try to solve this blocker before escalating to the human. "
                "Use BLOCKED_USER only for a genuinely human-only dependency.\n\n"
                "## ORIGINAL BLOCKER\n"
                + tail(original_reason, 1200)
                + "\n\n## CURRENT QEMU HANDOFF\n"
                + tail(handoff or "(missing)", 6500)
                + "\n\n## NEXT ACTION TAIL\n"
                + tail(next_action, 2200)
            )

        if max_chars > 0 and len(packet) > max_chars:
            packet = packet[:max_chars]

        return packet

    def _build_work_review_prompt(
        self,
        st: dict[str, Any],
        request_id: str,
        review_trigger: str = "codex_requested",
    ) -> str:
        """Build a compact Work prompt with the complete review packet embedded.

        Work writes ONE small JSON file only. The orchestrator parses that result,
        updates state/NEXT_ACTION itself, and injects the result directly into the
        next Codex prompt.
        """
        work_template = read_text(self.ai / "WORK_REVIEW_PROMPT.md")
        wcfg = self.config.get("work", {})
        max_packet = int(wcfg.get("max_review_packet_chars", 12000))

        if review_trigger == "periodic":
            packet = self._periodic_review_packet(st, max_packet).strip()
        elif review_trigger == "codex_blocked":
            packet = self._codex_blocked_review_packet(st, max_packet).strip()
        else:
            packet = read_text(self.ai / "REVIEW_PACKET.md").strip()

            if not packet:
                # Compact fallback only. Never send the whole notebook.
                status = read_text(self.ai / "STATUS.md").strip()
                next_action = read_text(self.ai / "NEXT_ACTION.md").strip()
                packet = (
                    "# REVIEW PACKET FALLBACK\n\n"
                    "Codex did not provide REVIEW_PACKET.md.\n\n"
                    "## STATUS\n"
                    + status
                    + "\n\n## CURRENT NEXT ACTION\n"
                    + next_action
                )

        if max_packet > 0 and len(packet) > max_packet:
            raise RuntimeError(
                f"REVIEW_PACKET.md has {len(packet)} chars, above "
                f"max_review_packet_chars={max_packet}. Codex must compact it."
            )

        max_result = int(wcfg.get("max_work_result_chars", 4000))

        return (
            work_template
            + "\n\n=== REVIEW CONTEXT EMBEDDED BY ORCHESTRATOR ===\n"
            + f"Project: {self.project}\n"
            + f"Iteration: {st.get('iteration', 0)}\n"
            + f"Evidence revision: {st.get('evidence_revision', 0)}\n"
            + f"Review revision: {st.get('review_revision', 0)}\n"
            + f"Review trigger: {review_trigger}\n"
            + f"Review request id: {request_id}\n"
            + "\n=== CURRENT EXECUTOR CAPABILITY SNAPSHOT ===\n"
            + json.dumps(
                self._codex_capability_snapshot(),
                ensure_ascii=False,
                indent=2,
            )
            + "\nThis snapshot is from the CURRENT launcher configuration and "
              "supersedes older sandbox/root observations when they conflict. "
              "Do not return BLOCKED_USER asking for a writable root that is "
              "already listed under add_dirs with sandbox=workspace-write; "
              "return EXECUTE and require a fresh direct write-capability test "
              "instead.\n"
            + "\nIMPORTANT:\n"
              "- Do NOT read STATUS/EVIDENCE/NEXT_ACTION/source/log files before reviewing.\n"
              "- Treat the embedded REVIEW_PACKET as the complete review input.\n"
              "- Do NOT write NEXT_ACTION.md.\n"
              "- Do NOT write state.json.\n"
              "- Write exactly ONE local output file: WORK_RESULT.json.\n"
            + "\n=== REVIEW_PACKET BEGIN ===\n"
            + packet
            + "\n=== REVIEW_PACKET END ===\n"
            + "\n=== ONLY REQUIRED OUTPUT ===\n"
            + f"Write valid UTF-8 JSON to exactly: {self.work_result_path}\n"
            + "No markdown fences. No prose outside the JSON file.\n"
            + "Required schema:\n"
            + "{\n"
              '  "schema_version": 1,\n'
            + f'  "request_id": "{request_id}",\n'
              '  "state": "EXECUTE",\n'
              '  "decision": "short reviewer classification/decision",\n'
              '  "next_action": "smallest concrete next action for Codex",\n'
              '  "reason": "compact causal rationale"\n'
              "}\n"
            + "Allowed state values: EXECUTE, BLOCKED_USER, COMPLETE.\n"
            + f"Keep the entire WORK_RESULT.json under {max_result} characters.\n"
            + "If evidence is insufficient but Codex can collect more, return EXECUTE "
              "with the missing-evidence experiment as next_action.\n"
            + "\nDo not execute builds/tests and do not edit production code.\n"
        )

    def _read_matching_work_result(
        self,
        request_id: str,
    ) -> Optional[dict[str, Any]]:
        """Read and validate a fresh Work result for this request.

        A stale WORK_RESULT.json from an earlier review is ignored by request_id.
        """
        try:
            raw = self.work_result_path.read_text(encoding="utf-8")
        except (FileNotFoundError, OSError):
            return None

        if not raw.strip():
            return None

        max_chars = int(
            self.config.get("work", {}).get("max_work_result_chars", 4000)
        )
        if max_chars > 0 and len(raw) > max_chars:
            raise RuntimeError(
                f"WORK_RESULT.json has {len(raw)} chars, above "
                f"max_work_result_chars={max_chars}"
            )

        try:
            result = json.loads(raw)
        except json.JSONDecodeError:
            # Work may be in the middle of replacing/writing the file.
            return None

        if not isinstance(result, dict):
            raise RuntimeError("WORK_RESULT.json must contain one JSON object")
        if result.get("request_id") != request_id:
            return None
        if result.get("schema_version") != 1:
            raise RuntimeError("WORK_RESULT.json schema_version must be 1")

        state = result.get("state")
        if state not in {"EXECUTE", "BLOCKED_USER", "COMPLETE"}:
            raise RuntimeError(
                "WORK_RESULT.json state must be EXECUTE, BLOCKED_USER, or COMPLETE"
            )

        for key in ("decision", "next_action", "reason"):
            if not isinstance(result.get(key), str):
                raise RuntimeError(f"WORK_RESULT.json field {key!r} must be a string")

        if not result["next_action"].strip() and state == "EXECUTE":
            raise RuntimeError(
                "WORK_RESULT.json next_action cannot be empty when state=EXECUTE"
            )

        return result

    def _apply_work_result(
        self,
        st_before: dict[str, Any],
        result: dict[str, Any],
    ) -> None:
        """Convert the one Work JSON output into persistent orchestration state."""
        new_review_revision = int(st_before.get("review_revision", 0)) + 1
        decision = result["decision"].strip()
        next_action = result["next_action"].strip()
        reason = result["reason"].strip()
        state = result["state"]

        stale_blocker, granted_path = self._work_blocker_already_satisfied(result)
        if state == "BLOCKED_USER" and stale_blocker:
            state = "EXECUTE"
            decision = (
                "Reviewer writable-root blocker is stale: the CURRENT launcher "
                f"already grants workspace-write access to {granted_path}."
            )
            next_action = (
                f"Re-test write capability directly in {granted_path} using the "
                "approved edit/patch mechanism, then continue the previously "
                "approved task. Escalate only if a FRESH write attempt still "
                "fails, recording the exact current error and effective sandbox."
            )
            reason = (
                "BLOCKED_USER was automatically downgraded to EXECUTE because "
                "the requested human action is already satisfied by current "
                f"codex.extra_args (--sandbox workspace-write --add-dir "
                f"{granted_path}). Historical read-only evidence is not current "
                "evidence."
            )
            self.log(
                "STALE WORK BLOCKER intercepted: writable root already granted "
                f"path={granted_path}; continuing as EXECUTE"
            )

        # Python, not Work, maintains the notebook/state.
        next_text = (
            f"# NEXT ACTION — Work review {new_review_revision}\n\n"
            "## Decision\n\n"
            + (decision or "(no separate decision text)")
            + "\n\n## Next action\n\n"
            + (next_action or "(none)")
            + "\n\n## Reviewer rationale\n\n"
            + (reason or "(none)")
            + "\n"
        )
        (self.ai / "NEXT_ACTION.md").write_text(next_text, encoding="utf-8")

        self.update_state(
            state=state,
            review_revision=new_review_revision,
            last_work_review_iteration=int(st_before.get("iteration", 0)),
            last_actor="work",
            reason=reason or decision or "Work review completed",
            review_request_id="",
            review_trigger="",
            work_feedback_pending=(state == "EXECUTE"),
        )

    def run_work(self, review_trigger: Optional[str] = None) -> None:
        try:
            import pyperclip  # noqa: F401
        except ImportError:
            self.block("Install pywinauto/pyperclip from requirements.txt")
            return

        w = self.config.get("work", {})
        if not w.get("enabled", True):
            self.block("Work disabled in config.json")
            return

        st = self.state()
        if review_trigger is None:
            review_trigger = str(st.get("review_trigger", "") or "codex_requested")
        if review_trigger not in {
            "codex_requested", "periodic", "codex_blocked"
        }:
            review_trigger = "codex_requested"

        # Check the local delivery budget, but do not consume a Work call or a
        # semantic no-progress review cycle until a prompt is actually delivered
        # and a matching WORK_RESULT is completed.
        if not self._work_call_capacity_available():
            return

        request_id = uuid.uuid4().hex
        self.log(
            f"WORK review prepare request_id={request_id} "
            f"iteration={st.get('iteration', 0)} trigger={review_trigger}"
        )
        try:
            prompt = self._build_work_review_prompt(st, request_id, review_trigger)
        except Exception as exc:
            self.block(
                f"Could not build Work review prompt: {type(exc).__name__}: {exc}"
            )
            return

        self.update_state(
            state="REVIEWING",
            last_actor="orchestrator",
            reason=(
                "Periodic Work review requested; waiting for WORK_RESULT.json"
                if review_trigger == "periodic"
                else (
                    "Codex blocker intercepted; Work must triage before user escalation"
                    if review_trigger == "codex_blocked"
                    else "Work review requested; waiting for WORK_RESULT.json"
                )
            ),
            review_request_id=request_id,
            review_trigger=review_trigger,
        )
        self.log(
            f"WORK state -> REVIEWING request_id={request_id}; starting UI bridge"
        )

        try:
            self._send_work_text_bounded(prompt, request_id)
            self._record_work_call()
            self.update_state(work_ui_retry_count=0)
            self.log(
                "WORK prompt sent; waiting for one matching .ai/WORK_RESULT.json"
            )
        except Exception as exc:
            detail = f"{type(exc).__name__}: {exc}"
            low = detail.lower()

            transient_markers = (
                "timed out",
                "chatgpt window not found",
                "ui helper exited",
                "work message box not identified",
                "elementnotavailable",
                "uia",
                "focus",
                "window",
                "clipboard",
                "foreground",
            )
            transient = any(marker in low for marker in transient_markers)

            if transient:
                fresh = self.state()
                retry_count = int(fresh.get("work_ui_retry_count", 0) or 0) + 1
                base_retry = max(
                    5.0,
                    float(w.get("ui_bridge_retry_seconds", 30)),
                )
                max_retry = max(
                    base_retry,
                    float(w.get("ui_bridge_retry_max_seconds", 300)),
                )
                # 30, 60, 120, 240, 300... by default. This avoids hammering
                # the desktop bridge while remaining fully autonomous.
                retry_seconds = min(
                    max_retry,
                    base_retry * (2 ** min(retry_count - 1, 4)),
                )
                self.update_state(work_ui_retry_count=retry_count)
                self._schedule_capacity_wait(
                    target="work",
                    resume_state="REVIEW_REQUIRED",
                    reason=(
                        "Temporary Work UI bridge failure; automatic transport "
                        "retry scheduled without consuming a Work review cycle. "
                        f"Attempt={retry_count}. Detail: {detail}"
                    ),
                    retry_seconds=retry_seconds,
                    pending_request_id=request_id,
                    review_trigger=review_trigger,
                )
                detail_for_log = detail.replace("\n", " ")
                if len(detail_for_log) > 700:
                    detail_for_log = detail_for_log[-700:]
                self.log(
                    "WORK UI transport retry "
                    f"attempt={retry_count} delay≈{retry_seconds:.0f}s; "
                    f"semantic review counters unchanged; detail={detail_for_log}"
                )
                return

            # Invalid local configuration/dependency is not expected to heal by
            # waiting. Keep fail-safe behavior for clearly non-transient errors.
            self.block(
                f"Non-transient Work UI automation failure: {detail}"
            )
            return

        deadline = time.time() + int(w.get("wait_timeout_minutes", 90)) * 60
        poll = float(w.get("poll_seconds", 2))
        probe_every = max(
            15.0, float(w.get("capacity_ui_probe_seconds", 60))
        )
        next_capacity_probe = time.time() + probe_every

        while time.time() < deadline:
            if self.stop_path.exists():
                self.block(".ai/STOP detected while Work was reviewing")
                return

            try:
                result = self._read_matching_work_result(request_id)
            except Exception as exc:
                self.block(f"Invalid WORK_RESULT.json: {type(exc).__name__}: {exc}")
                return

            if result is not None:
                self._apply_work_result(st, result)
                applied = self.state()

                # The no-progress guard is semantic: it applies only after Work
                # actually completed a review and asked execution to continue.
                # UI delivery retries are not reviews and must never increment it.
                if applied.get("state") == "EXECUTE":
                    if not self._check_review_progress(st):
                        return

                self.log(
                    "WORK finished via WORK_RESULT.json "
                    f"requested_state={result.get('state')} "
                    f"applied_state={self.state().get('state')}"
                )
                return

            if time.time() >= next_capacity_probe:
                capacity_text = self._work_capacity_probe_bounded()
                next_capacity_probe = time.time() + probe_every
                if capacity_text and self._looks_like_capacity_limit(capacity_text):
                    default_retry = float(
                        w.get("capacity_retry_probe_seconds", 300)
                    )
                    retry_seconds = self._capacity_retry_seconds(
                        capacity_text, default_retry
                    )
                    self._schedule_capacity_wait(
                        target="work",
                        resume_state="REVIEW_REQUIRED",
                        reason=(
                            "Visible ChatGPT Work usage/rate limit detected; "
                            "automatic retry scheduled."
                        ),
                        retry_seconds=retry_seconds,
                        pending_request_id=request_id,
                        review_trigger=review_trigger,
                    )
                    self.log(
                        "WORK capacity signal detected in UI; no user action required"
                    )
                    return

            time.sleep(poll)

        default_retry = float(
            w.get("capacity_retry_probe_seconds", 300)
        )
        self._schedule_capacity_wait(
            target="work",
            resume_state="REVIEW_REQUIRED",
            reason=(
                "Work did not produce a matching result before the review timeout. "
                "Treating this as temporary reviewer/capacity unavailability first; "
                "automatic retry scheduled without user intervention."
            ),
            retry_seconds=default_retry,
            pending_request_id=request_id,
            review_trigger=review_trigger,
        )

    def discover_artifacts(self) -> int:
        """Show what test artifacts automatic discovery selects."""
        env = self._resolve_test_artifacts(os.environ.copy(), verbose=False)

        firmware = env.get("LASECSIMUL_TEST_FIRMWARE", "")
        qemu = env.get("LASECSIMUL_TEST_QEMU_BINARY", "")

        print("LASECSIMUL_TEST_FIRMWARE =", firmware or "NOT FOUND")
        print("LASECSIMUL_TEST_QEMU_BINARY =", qemu or "NOT FOUND")
        print(
            "QEMU_RUNTIME.json =",
            str(self._runtime_manifest_path())
            if self._runtime_manifest_path().is_file()
            else "NOT FOUND",
        )

        fw_ok = bool(firmware and Path(firmware).is_file())
        qemu_ok = bool(qemu and Path(qemu).is_file())
        print("Firmware:", "PASS" if fw_ok else "FAIL")
        print("QEMU:    ", "PASS" if qemu_ok else "FAIL")

        return 0 if fw_ok and qemu_ok else 2

    def test_codex(self) -> int:
        """Verify Windows command resolution and Codex subprocess startup.

        Uses --version only, so it does not consume a project-agent turn.
        """
        c = self.config.get("codex", {})
        raw = c.get("command", ["codex", "exec"])
        if not isinstance(raw, list) or not raw:
            print("Invalid codex.command in config.json", file=sys.stderr)
            return 2

        resolved = shutil.which(str(raw[0]))
        print(f"Configured command: {raw}")
        print(
            "Configured model:",
            c.get("model") or "Codex default/current"
        )
        print(f"Resolved executable: {resolved or 'NOT FOUND'}")
        if not resolved:
            return 2

        try:
            proc = subprocess.run(
                [resolved, "--version"],
                cwd=str(self.project),
                capture_output=True,
                text=True,
                timeout=30,
                env=os.environ.copy(),
            )
        except Exception as exc:
            print(
                f"CODEX SUBPROCESS TEST FAIL: {type(exc).__name__}: {exc}",
                file=sys.stderr,
            )
            return 1

        print(f"Return code: {proc.returncode}")
        if proc.stdout.strip():
            print("stdout:", proc.stdout.strip())
        if proc.stderr.strip():
            print("stderr:", proc.stderr.strip())

        if proc.returncode == 0:
            print("CODEX SUBPROCESS TEST PASS")
            print("Prompt transport: stdin (`codex exec -`) in normal orchestrator runs")
            return 0

        print("CODEX SUBPROCESS TEST FAIL", file=sys.stderr)
        return 1

    def recover_review(self) -> int:
        """Explicitly recover a stale Work-review checkpoint.

        Handles both REVIEWING and the safety BLOCKED_USER state produced when a
        later startup detects that interrupted REVIEWING checkpoint.

        If a matching WORK_RESULT.json already exists, consume it. Otherwise
        restore REVIEW_REQUIRED without rerunning the completed Codex iteration.
        """
        st = self.state()
        state = str(st.get("state", "") or "")
        reason = str(st.get("reason", "") or "")
        request_id = str(st.get("review_request_id", "") or "")

        recoverable = state == "REVIEWING"
        if state == "BLOCKED_USER" and request_id:
            recoverable = (
                "state=REVIEWING" in reason
                or "review" in reason.lower()
                or "work ui" in reason.lower()
            )

        if not recoverable:
            print(
                "No review recovery available: "
                f"current state={state}, "
                f"review_request_id={request_id or '<none>'}"
            )
            return 1

        if request_id:
            try:
                result = self._read_matching_work_result(request_id)
            except Exception as exc:
                print(
                    f"Cannot recover invalid WORK_RESULT.json: "
                    f"{type(exc).__name__}: {exc}",
                    file=sys.stderr,
                )
                return 2

            if result is not None:
                self._apply_work_result(st, result)
                self.log(
                    "Recovered completed Work review from matching "
                    f"WORK_RESULT.json state={result.get('state')}"
                )
                return 0

        self.update_state(
            state="REVIEW_REQUIRED",
            last_actor="user",
            reason=(
                "Explicit recovery of interrupted Work review; "
                "completed Codex checkpoint preserved for retry."
            ),
            review_request_id="",
        )
        self.log(
            f"Recovered stale review checkpoint {state} -> REVIEW_REQUIRED"
        )
        return 0

    def resume(self) -> int:
        """Explicitly resume a blocked or stale interrupted Codex execution.

        Supported recovery:
        - BLOCKED_USER -> EXECUTE
        - stale EXECUTING -> EXECUTE

        REVIEWING is intentionally not auto-recovered because the Work reviewer may
        still be running asynchronously in ChatGPT Desktop.
        """
        if self.stop_path.exists():
            print(
                f"Cannot resume while {self.stop_path} exists. Remove STOP first.",
                file=sys.stderr,
            )
            return 2

        st = self.state()
        state = st.get("state")

        if state == "REVIEWING":
            print(
                "Cannot auto-resume state=REVIEWING because ChatGPT Work may still "
                "be processing the previous review. Check the Work conversation/state "
                "before retrying.",
                file=sys.stderr,
            )
            return 2

        if state not in {"BLOCKED_USER", "EXECUTING"}:
            print(f"No resume needed: current state={state}")
            return 0

        previous = state
        self.update_state(
            state="EXECUTE",
            last_actor="user",
            reason=f"User explicitly resumed from {previous} with --resume",
        )
        try:
            blocked = self.ai / "BLOCKED.md"
            if blocked.exists():
                blocked.unlink()
        except OSError:
            pass

        print(f"State changed: {previous} -> EXECUTE")
        return 0

    def _current_stale_work_blocker_status(self) -> tuple[bool, str]:
        st = self.state()
        if st.get("state") != "BLOCKED_USER" or st.get("last_actor") != "work":
            return False, ""
        context = {
            "decision": "",
            "next_action": read_text(self.ai / "NEXT_ACTION.md"),
            "reason": str(st.get("reason", "") or ""),
        }
        return self._work_blocker_already_satisfied(context)

    def check(self) -> int:
        print(f"Project: {self.project}")
        print(f"Orchestrator: {self.orchestrator_root}")
        print(f"AI dir:  {self.ai}")
        print(f"State:   {self.state().get('state')}")
        print(
            f"Work:    input_mode="
            f"{self.config.get('work', {}).get('input_mode', 'last_focused_composer')}"
        )
        print(
            "Handoff: WORK_RESULT.json -> Python -> direct Codex prompt "
            f"(max {int(self.config.get('work', {}).get('max_work_result_chars', 4000))} chars)"
        )
        auto_work_enabled = self.config.get("work", {}).get(
            "auto_review_after_codex", True
        )
        periodic_interval = self._periodic_work_review_interval()
        if auto_work_enabled:
            periodic_text = (
                f" + forced every {periodic_interval} Codex EXECUTE iterations"
                if periodic_interval > 0
                else " + periodic forcing OFF"
            )
            print(
                "AutoWork: ON (REVIEW_REQUIRED immediate"
                + periodic_text
                + ")"
            )
        else:
            print("AutoWork: OFF")
        print(
            "Work interval config:",
            f"periodic_review_every_codex_iterations={periodic_interval} "
            "(0 = only when needed; N>0 = force after N EXECUTE iterations)"
        )
        st_check = self.state()
        print(
            "Work cadence:",
            f"last_review_iteration={st_check.get('last_work_review_iteration', 'not recorded')}; "
            f"review_revision={st_check.get('review_revision', 0)}",
        )
        print(
            "Escalation: Codex BLOCKED_USER -> Work first; "
            "only Work may escalate genuine human-only blockers"
        )
        print(
            "Capacity: auto-wait/resume ON "
            "(Codex/Work usage limits; persisted retry state)"
        )
        print(
            "Restart: transparent auto-recovery ON "
            "(just run `python orchestrator.py`)"
        )
        print(
            "Work UI: transient bridge failures auto-retry ON "
            "(default retry 30s; no user command)"
        )
        print(
            "Work bridge:",
            "native Win32 top-level focus + bounded helper "
            "(no UIA enumeration on send)"
        )
        print("Orchestrator build:", ORCHESTRATOR_BUILD)
        cap = self._codex_capability_snapshot()
        print(
            "Codex sandbox:",
            cap.get("sandbox"),
            "additional writable roots:",
            cap.get("add_dirs") or "(none)",
        )
        print(
            "Review freshness: current launcher capabilities embedded in Codex/Work "
            "prompts; stale writable-root BLOCKED_USER auto-invalidated"
        )
        print(
            "Work retry accounting: UI/transport failures do NOT count as Work "
            "calls or semantic no-progress reviews; exponential auto-backoff ON"
        )
        stale_now, stale_path = self._current_stale_work_blocker_status()
        if stale_now:
            print(
                "Current BLOCKED_USER: STALE/SATISFIED -> will auto-recover to "
                f"EXECUTE (writable root already granted: {stale_path})"
            )
        elif self.state().get("state") == "BLOCKED_USER":
            print(
                "Current BLOCKED_USER: not mechanically proven stale by current "
                "launcher/NEXT_ACTION context"
            )
        selected_model = self.config.get("codex", {}).get("model", "")
        print(f"Model:   {selected_model or 'Codex default/current'}")
        print(
            "Artifacts: auto-discovery "
            + (
                "ON"
                if self.config.get("artifact_discovery", {}).get("enabled", True)
                else "OFF"
            )
        )
        print(
            "QEMU manifest:",
            str(self._runtime_manifest_path())
            if self._runtime_manifest_path().is_file()
            else "not present (heuristic fallback allowed)",
        )
        cmd0 = str(self.config.get("codex", {}).get("command", ["codex"])[0])
        print(f"Codex:   {shutil.which(cmd0) or 'NOT FOUND'}")
        try:
            import pywinauto  # noqa: F401
            import pyperclip  # noqa: F401
            print("UI libs:  PASS")
        except ImportError as exc:
            print(f"UI libs:  FAIL ({exc})")
        return 0 if shutil.which(cmd0) else 2

    def show_status(self) -> int:
        print(json.dumps(self.state(), indent=2, ensure_ascii=False))
        print("\n--- STATUS.md ---\n" + read_text(self.ai / "STATUS.md"))
        print("\n--- NEXT_ACTION.md ---\n" + read_text(self.ai / "NEXT_ACTION.md"))
        return 0

    def _acquire_instance_lock(self) -> bool:
        """Prevent two continuous orchestrators from recovering/mutating one state.

        Hidden Work UI helper subprocesses do not call run(), so they do not
        contend with this lock.
        """
        lock_path = self.ai / "orchestrator.instance.lock"
        lock_path.parent.mkdir(parents=True, exist_ok=True)
        handle = lock_path.open("a+b")
        try:
            handle.seek(0, os.SEEK_END)
            if handle.tell() == 0:
                handle.write(b"\0")
                handle.flush()
            handle.seek(0)
            if os.name == "nt":
                import msvcrt
                msvcrt.locking(handle.fileno(), msvcrt.LK_NBLCK, 1)
            else:
                import fcntl
                fcntl.flock(handle.fileno(), fcntl.LOCK_EX | fcntl.LOCK_NB)
        except (OSError, BlockingIOError):
            handle.close()
            return False

        # Keep the handle alive for the whole process. The OS releases the lock
        # automatically if Python is killed or exits unexpectedly.
        self._instance_lock_handle = handle
        return True

    def _recover_pending_review_automatically(
        self,
        st: dict[str, Any],
        *,
        source_state: str,
    ) -> dict[str, Any]:
        """Recover an interrupted Work review without asking the user for commands.

        First give an already-sent Work prompt a short grace period to finish.
        If no matching result arrives, restore REVIEW_REQUIRED and let normal
        AutoWork resend the checkpoint with a fresh request_id.
        """
        request_id = str(st.get("review_request_id", "") or "")
        trigger = str(
            st.get("review_trigger", "") or "codex_requested"
        )
        if trigger not in {"codex_requested", "periodic", "codex_blocked"}:
            trigger = "codex_requested"

        if request_id:
            grace = max(
                0.0,
                float(
                    self.config.get("work", {}).get(
                        "restart_review_grace_seconds", 30
                    )
                ),
            )
            deadline = time.time() + grace
            self.log(
                "AUTO-RECOVERY review: checking for an already-completed "
                f"WORK_RESULT request_id={request_id} grace={grace:.0f}s"
            )
            while True:
                try:
                    result = self._read_matching_work_result(request_id)
                except Exception as exc:
                    self.log(
                        "AUTO-RECOVERY ignored invalid/intermediate Work result: "
                        f"{type(exc).__name__}: {exc}"
                    )
                    result = None

                if result is not None:
                    self._apply_work_result(st, result)
                    recovered = self.state()
                    self.log(
                        "AUTO-RECOVERY consumed existing Work result -> "
                        f"{recovered.get('state')}"
                    )
                    return recovered

                if time.time() >= deadline:
                    break
                if self.stop_path.exists():
                    return self.state()
                time.sleep(1.0)

        recovered = self.update_state(
            state="REVIEW_REQUIRED",
            last_actor="orchestrator",
            reason=(
                f"Automatically recovered interrupted {source_state} review; "
                "the completed Codex checkpoint is preserved and will be resent "
                "to Work without user intervention."
            ),
            review_request_id="",
            review_trigger=trigger,
        )
        self.log(
            f"AUTO-RECOVERY {source_state} -> REVIEW_REQUIRED "
            f"trigger={trigger}"
        )
        return recovered

    def _auto_recover_startup_state(self) -> dict[str, Any]:
        """Normalize interrupted states so `python orchestrator.py` is enough.

        This runs only after the single-instance lock is acquired, so a second
        orchestrator cannot mistake a live EXECUTING/REVIEWING state for a crash.
        """
        st = self.state()
        state = str(st.get("state", "") or "")
        actor = str(st.get("last_actor", "") or "")
        reason = str(st.get("reason", "") or "")
        low = reason.lower()

        if state == "EXECUTING":
            recovered = self.update_state(
                state="EXECUTE",
                last_actor="orchestrator",
                reason=(
                    "Automatically recovered stale EXECUTING after process restart. "
                    "Inspect and preserve any partial work from the interrupted Codex "
                    "turn, then continue from the persisted handoff."
                ),
            )
            self.log("AUTO-RECOVERY stale EXECUTING -> EXECUTE")
            return recovered

        if state == "REVIEWING":
            return self._recover_pending_review_automatically(
                st, source_state="REVIEWING"
            )

        if state == "BLOCKED_USER":
            # v3 and older counted Work UI transport retries as semantic review
            # cycles. Recover that infrastructure-only false positive
            # automatically after upgrading.
            low_reason = reason.lower()
            if (
                actor == "orchestrator"
                and "work cycles without evidence_revision progress" in low_reason
                and "possible loop" in low_reason
            ):
                recovered = self.update_state(
                    state="REVIEW_REQUIRED",
                    last_actor="orchestrator",
                    reason=(
                        "Automatically recovered legacy false Work no-progress "
                        "blocker. Transport/UI retries no longer count as semantic "
                        "Work review cycles."
                    ),
                    review_trigger=str(
                        st.get("review_trigger", "") or "codex_requested"
                    ),
                )
                self.log(
                    "AUTO-RECOVERY legacy Work transport/no-progress "
                    "BLOCKED_USER -> REVIEW_REQUIRED"
                )
                return recovered

            # A Work decision normally remains terminal, except when its exact
            # requested human action is provably already satisfied by the current
            # launcher configuration.
            if actor == "work":
                # state.reason is intentionally compact and may omit the exact
                # path named by Work. Reconstruct the persisted Work disposition
                # from BOTH state.reason and NEXT_ACTION.md before deciding that
                # a human action is still required.
                persisted_work_context = {
                    "decision": "",
                    "next_action": read_text(self.ai / "NEXT_ACTION.md"),
                    "reason": reason,
                }
                stale, granted_path = self._work_blocker_already_satisfied(
                    persisted_work_context
                )
                if stale:
                    recovered = self.update_state(
                        state="EXECUTE",
                        last_actor="orchestrator",
                        reason=(
                            "Automatically invalidated stale Work writable-root "
                            "blocker: current launcher already has "
                            "--sandbox workspace-write --add-dir "
                            f"{granted_path}. Codex must perform a fresh direct "
                            "write-capability test."
                        ),
                        work_feedback_pending=False,
                    )
                    self.log(
                        "AUTO-RECOVERY stale Work writable-root BLOCKED_USER "
                        f"-> EXECUTE path={granted_path}"
                    )
                    return recovered

                self.log(
                    "AUTO-RECOVERY kept BLOCKED_USER because Work explicitly "
                    "classified it as a genuine human-only blocker"
                )
                return st

            # Codex is never allowed to escalate directly to the user.
            if actor == "codex":
                recovered = self.update_state(
                    state="REVIEW_REQUIRED",
                    last_actor="orchestrator",
                    reason=(
                        "Automatically intercepted persisted Codex BLOCKED_USER; "
                        "mandatory Work-first blocker triage."
                    ),
                    review_trigger="codex_blocked",
                )
                self.log(
                    "AUTO-RECOVERY Codex BLOCKED_USER -> REVIEW_REQUIRED "
                    "(Work-first)"
                )
                return recovered

            # Ctrl+C while Codex was active is a normal operator stop, not a
            # technical user blocker. Continue automatically on next launch.
            codex_interrupted = (
                "codex iteration=" in low and "interrupted by user" in low
            )
            stale_execute = "state=executing" in low

            if actor == "orchestrator" and (codex_interrupted or stale_execute):
                current_iteration = int(st.get("iteration", 0))
                retry_base_iteration = current_iteration

                if codex_interrupted and current_iteration > 0:
                    # run_codex() increments before launching. Roll back the
                    # semantic counter by one so the retry reuses the interrupted
                    # iteration number instead of silently skipping it.
                    retry_base_iteration = current_iteration - 1

                    logfile = (
                        self.ai / "logs" / f"codex_{current_iteration:04d}.log"
                    )
                    if logfile.is_file():
                        stamp = dt.datetime.now().strftime("%Y%m%d_%H%M%S")
                        archived = logfile.with_name(
                            f"codex_{current_iteration:04d}_interrupted_"
                            f"{stamp}.log"
                        )
                        try:
                            logfile.replace(archived)
                            self.log(
                                "AUTO-RECOVERY archived interrupted Codex log: "
                                f"{archived}"
                            )
                        except OSError as exc:
                            self.log(
                                "AUTO-RECOVERY could not archive interrupted "
                                f"Codex log; continuing without deletion: {exc}"
                            )

                recovered = self.update_state(
                    state="EXECUTE",
                    iteration=retry_base_iteration,
                    interrupted_iteration=(
                        current_iteration if codex_interrupted else ""
                    ),
                    last_actor="orchestrator",
                    reason=(
                        "Automatically resumed after an intentional/interrupted "
                        "Codex stop. Existing partial work and handoff must be "
                        "inspected and preserved; the interrupted iteration number "
                        "will be retried."
                    ),
                )
                self.log(
                    "AUTO-RECOVERY interrupted Codex BLOCKED_USER -> EXECUTE "
                    f"(retry iteration={current_iteration})"
                )
                return recovered

            # Old versions converted an interrupted REVIEWING into BLOCKED_USER,
            # and UI bridge failures also preserve the review request id.
            review_related = bool(st.get("review_request_id")) and (
                "review" in low
                or "work ui" in low
                or "work ui automation" in low
                or "state=reviewing" in low
            )
            if actor == "orchestrator" and review_related:
                return self._recover_pending_review_automatically(
                    st, source_state="BLOCKED_USER(review)"
                )

            # Genuine orchestrator/infrastructure/safety blockers remain visible.
            self.log(
                "AUTO-RECOVERY kept BLOCKED_USER; reason is not a recognized "
                "safe interrupted-state recovery"
            )
            return st

        # WAITING_CAPACITY is intentionally left intact. run() will sleep until
        # the persisted retry time and resume automatically.
        if state == "WAITING_CAPACITY":
            self.log(
                "AUTO-RECOVERY found WAITING_CAPACITY; persisted timer will "
                "resume automatically"
            )
            return st

        # EXECUTE / REVIEW_REQUIRED / COMPLETE / ERROR are already stable.
        return st

    def run(self, once: bool = False) -> int:
        """Run autonomous orchestration.

        The user prepares the Work conversation once by clicking its composer.
        After that Python handles the handoff automatically.

        `--once` means one executor cycle:
          EXECUTE -> Codex
          -> mandatory Work if Codex attempts BLOCKED_USER
          -> immediate Work if Codex requests REVIEW_REQUIRED
          -> otherwise forced Work when the periodic cadence is due.

        Continuous mode keeps chaining cycles until COMPLETE, BLOCKED_USER,
        STOP, Ctrl+C, or the configured iteration limit.
        """
        self.log(f"Orchestrator started build={ORCHESTRATOR_BUILD}")

        if not self._acquire_instance_lock():
            self.log(
                "Another orchestrator instance is already running for this .ai "
                "workspace; refusing to start a second state-machine owner."
            )
            return 4

        recovered = self._auto_recover_startup_state()
        self.log(
            "Startup state resolved automatically: "
            f"{recovered.get('state')} iteration={recovered.get('iteration', 0)}"
        )

        cycles = 0

        while True:
            if self.check_stop():
                return 3

            st = self.state()
            state = st["state"]

            # Codex is never allowed to terminate directly on the user. If an
            # older/current Codex turn left BLOCKED_USER, route it through Work
            # before terminal-state handling. Work alone may decide a genuine
            # human-only dependency remains.
            if state == "BLOCKED_USER" and st.get("last_actor") == "codex":
                original_reason = str(st.get("reason", "") or "")
                self.update_state(
                    state="REVIEW_REQUIRED",
                    last_actor="orchestrator",
                    reason=(
                        "Recovered Codex user escalation for mandatory Work-first "
                        "triage. Original blocker: " + original_reason
                    ),
                    review_trigger="codex_blocked",
                )
                self.log(
                    "Recovered CODEX BLOCKED_USER -> mandatory Work-first blocker triage"
                )
                self.run_work(review_trigger="codex_blocked")
                cycles += 1
                if once and cycles >= 1:
                    self.log("--once: one cycle completed")
                    return 0
                continue

            if state == "WAITING_CAPACITY":
                self._wait_for_capacity()
                cycles += 1
                # Waiting is part of the same autonomous cycle. Do not require a
                # user restart after capacity returns, including under --once.
                continue

            if state in TERMINAL_STATES:
                self.log(f"Terminal state: {state}")
                return 0 if state == "COMPLETE" else 3

            if int(st.get("iteration", 0)) >= self.max_iterations:
                self.block(f"Maximum {self.max_iterations} iterations reached")
                return 3

            if state == "EXECUTE":
                self.run_codex()

                # Same-cycle automatic reviewer handoff.
                # No second manual --once is required.
                after_codex = self.state()
                auto_work = bool(
                    self.config.get("work", {}).get(
                        "auto_review_after_codex", True
                    )
                )

                if (
                    after_codex.get("state") == "BLOCKED_USER"
                    and after_codex.get("last_actor") == "codex"
                ):
                    original_reason = str(after_codex.get("reason", "") or "")
                    self.update_state(
                        state="REVIEW_REQUIRED",
                        last_actor="orchestrator",
                        reason=(
                            "Codex attempted user escalation; intercepted for "
                            "mandatory Work-first blocker triage. Original blocker: "
                            + original_reason
                        ),
                        review_trigger="codex_blocked",
                    )
                    self.log(
                        "CODEX attempted BLOCKED_USER; direct user escalation is "
                        "forbidden -> mandatory Work-first blocker triage"
                    )
                    self.run_work(review_trigger="codex_blocked")

                elif auto_work and after_codex.get("state") == "REVIEW_REQUIRED":
                    self.update_state(review_trigger="codex_requested")
                    self.log(
                        "CODEX requested REVIEW_REQUIRED; "
                        "auto-sending compact review packet to Work"
                    )
                    self.run_work(review_trigger="codex_requested")

                elif auto_work and self._periodic_work_review_due(after_codex):
                    interval = self._periodic_work_review_interval()
                    current_iteration = int(after_codex.get("iteration", 0))
                    self.update_state(
                        state="REVIEW_REQUIRED",
                        last_actor="orchestrator",
                        reason=(
                            "Periodic Work checkpoint required after "
                            f"{interval} Codex EXECUTE iterations without review."
                        ),
                        review_trigger="periodic",
                    )
                    self.log(
                        "PERIODIC WORK checkpoint due "
                        f"iteration={current_iteration} interval={interval}; "
                        "auto-sending fresh compact handoff to Work"
                    )
                    self.run_work(review_trigger="periodic")

                cycles += 1

            elif state == "REVIEW_REQUIRED":
                # Also supports starting the orchestrator while a review is already
                # pending from an older/manual run.
                self.run_work(
                    review_trigger=str(
                        st.get("review_trigger", "") or "codex_requested"
                    )
                )
                cycles += 1

            elif state in {"EXECUTING", "REVIEWING"}:
                # This should normally have been normalized at startup. If a
                # transient state somehow reappears while this process owns the
                # lock, fail safe rather than guessing concurrent ownership.
                self.block(
                    f"Unexpected live transient state={state} while this "
                    "orchestrator owns the instance lock."
                )
                return 3

            else:
                self.block(f"Unhandled state: {state}")
                return 3

            if once and cycles >= 1:
                self.log("--once: one cycle completed")
                return 0

            time.sleep(float(self.config.get("loop_poll_seconds", 1)))


def main() -> int:
    p = argparse.ArgumentParser(description="LasecSimul Codex↔Work orchestrator")
    p.add_argument("--config", type=Path)
    p.add_argument("--check", action="store_true")
    p.add_argument("--inspect-work", action="store_true")
    p.add_argument("--test-work", action="store_true")
    p.add_argument("--test-codex", action="store_true")
    p.add_argument("--discover-artifacts", action="store_true")
    p.add_argument("--resume", action="store_true")
    p.add_argument("--recover-review", action="store_true")
    p.add_argument("--_work-send-helper", type=Path, help=argparse.SUPPRESS)
    p.add_argument("--_work-capacity-probe", action="store_true", help=argparse.SUPPRESS)
    p.add_argument("--status", action="store_true")
    p.add_argument("--once", action="store_true")
    a = p.parse_args()
    config = a.config or Path(__file__).resolve().with_name("config.json")
    try:
        o = Orchestrator(config)
    except Exception as exc:
        print(f"Initialization error: {exc}", file=sys.stderr)
        return 2
    if a._work_send_helper is not None:
        try:
            prompt = a._work_send_helper.read_text(encoding="utf-8")
            o._send_work_text(prompt)
            return 0
        except Exception as exc:
            print(
                f"WORK UI HELPER FAIL: {type(exc).__name__}: {exc}",
                file=sys.stderr,
            )
            return 1
    if a._work_capacity_probe:
        value = o._work_capacity_probe_local()
        if value:
            print(value)
        return 0
    if a.check:
        return o.check()
    if a.inspect_work:
        return o.inspect_work()
    if a.test_work:
        return o.test_work()
    if a.test_codex:
        return o.test_codex()
    if a.discover_artifacts:
        return o.discover_artifacts()
    if a.resume:
        return o.resume()
    if a.recover_review:
        return o.recover_review()
    if a.status:
        return o.show_status()
    try:
        return o.run(once=a.once)
    except KeyboardInterrupt:
        try:
            st = o.state()
            if st.get("state") == "EXECUTING":
                o.block(
                    "Orchestrator interrupted by user while state=EXECUTING. "
                    "Use --resume to continue explicitly."
                )
        except Exception:
            pass
        o.log("Interrupted by user (Ctrl+C)")
        return 130
    except Exception as exc:
        try:
            o.block(f"Unhandled orchestrator exception: {type(exc).__name__}: {exc}")
        except Exception:
            pass
        print(f"ERROR: {exc}", file=sys.stderr)
        return 2


if __name__ == "__main__":
    raise SystemExit(main())
