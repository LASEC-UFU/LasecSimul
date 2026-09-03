#!/usr/bin/env python3
"""Update only work.periodic_review_every_codex_iterations in config.json."""
from __future__ import annotations

import argparse
import json
import os
from pathlib import Path

def atomic_write_json(path: Path, data: dict) -> None:
    tmp = path.with_suffix(path.suffix + ".tmp")
    tmp.write_text(json.dumps(data, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")
    os.replace(tmp, path)

def main() -> int:
    p = argparse.ArgumentParser(
        description=(
            "Set how many Codex EXECUTE iterations may pass before a forced Work review. "
            "Use 0 for Work only when actually needed."
        )
    )
    p.add_argument("iterations", type=int)
    p.add_argument(
        "--config",
        type=Path,
        default=Path(__file__).resolve().with_name("config.json"),
    )
    a = p.parse_args()

    if a.iterations < 0:
        p.error("iterations must be >= 0; use 0 for on-demand-only Work reviews")

    config_path = a.config.resolve()
    data = json.loads(config_path.read_text(encoding="utf-8"))
    work = data.setdefault("work", {})
    before = work.get("periodic_review_every_codex_iterations", "<not set>")
    work["periodic_review_every_codex_iterations"] = a.iterations
    atomic_write_json(config_path, data)

    if a.iterations == 0:
        mode = "only when needed (REVIEW_REQUIRED / blocker triage)"
    else:
        mode = f"forced after {a.iterations} Codex EXECUTE iteration(s) without Work"
    print(
        f"Updated {config_path}\n"
        f"periodic_review_every_codex_iterations: {before} -> {a.iterations}\n"
        f"Mode: {mode}"
    )
    return 0

if __name__ == "__main__":
    raise SystemExit(main())
