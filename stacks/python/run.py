#!/usr/bin/env python3
"""Runs one of the Python pack's app-profile checks through `uv`, with a clear message when uv is missing.
In the app: nothing at runtime; package.json `py:lint`, `py:types`, `py:boundaries`, `py:test`, `py:selftest` call it.
Used by: package.json, through stacks/python/pack.json `checks`; stacks/python/run_test.py.
Uses: nothing: stdlib only, so a missing uv is reported by us, not as "command not found".

Why a wrapper and not `uv run ...` in package.json: a dead-code checker that reads package.json
scripts (a Node dead-code check) flags `uv` as an unlisted binary, and silencing it would leave a
Python line in a Node config that `stack:remove python` can't take back out. `--locked` makes
a stale uv.lock a failure (run `uv lock`), so CI and your machine run the same tool versions.
"""

from __future__ import annotations

import shutil
import subprocess
import sys

# Each check name -> the commands it runs, in order; the first failure stops the check.
CHECKS: dict[str, list[list[str]]] = {
    "lint": [["ruff", "check", "."], ["ruff", "format", "--check", "."]],
    "types": [["pyright"]],
    "boundaries": [["lint-imports"], ["python", "stacks/python/domain_purity.py"]],
    "test": [["pytest"]],
    "selftest": [["python", "scripts/lib/run_unittests.py", "stacks/python"]],
}


# Runs the named check; returns the exit code of the first command that fails, else 0.
def run(name: str) -> int:
    # An unknown name is a usage error, not a pass.
    if name not in CHECKS:
        sys.stderr.write(f"usage: run.py <{'|'.join(CHECKS)}>\n")
        return 2
    # No uv: say what to install instead of letting the shell print "command not found".
    if shutil.which("uv") is None:
        sys.stderr.write(
            "run.py: uv is not installed (https://docs.astral.sh/uv/); the Python pack's app checks need it\n"
        )
        return 127
    # Each command through `uv run --locked`: syncs .venv from uv.lock, fails if the lock is stale.
    for command in CHECKS[name]:
        code = subprocess.run(["uv", "run", "--locked", *command], check=False).returncode
        if code != 0:
            return code
    return 0


# Entry: `run.py <check>`.
def main(argv: list[str]) -> int:
    return run(argv[1]) if len(argv) == 2 else run("")


# Run only as a script, so the test can import `run`.
if __name__ == "__main__":
    sys.exit(main(sys.argv))
