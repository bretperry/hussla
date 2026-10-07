#!/usr/bin/env python3
"""Runs unittest discovery and fails when it finds no tests, which a bare `unittest discover` calls a pass.
In the app: nothing at runtime; the Python pack's `py:tooling` and `py:selftest` checks call it.
Used by: package.json (py:tooling, py:selftest); scripts/lib/run_unittests_test.py.
Uses: nothing: stdlib only, so it runs on the system python3 with no install.

The tooling profile of the Python pack (python.mdc): scripts here import the standard library and
nothing else, so CI and a fresh clone run them with no virtualenv. Why this runner exists:
Python 3.11's `python -m unittest discover` exits 0 after "Ran 0 tests" (3.12 fixed it), so a
renamed pattern or a test file that no longer imports looks green. Same silent failure as habit's
count_swift_tests.py, same fix.
"""

from __future__ import annotations

import fnmatch
import sys
import unittest
from pathlib import Path

# The oldest Python the pack supports (pyproject.toml requires-python); older ones fail here, clearly.
MIN_PYTHON = (3, 11)


# Test files that discovery will silently skip: a matching file in a subfolder with no __init__.py
# (3.11's loader only recurses into packages). Returns their paths, sorted.
def unreachable_tests(start_dir: str, pattern: str) -> list[str]:
    start = Path(start_dir)
    found: list[str] = []
    # Every matching file below the start dir, skipping caches and hidden folders.
    for file in sorted(start.rglob("*.py")):
        relative = file.relative_to(start)
        if any(part.startswith(".") or part == "__pycache__" for part in relative.parts):
            continue
        if not fnmatch.fnmatch(file.name, pattern):
            continue
        # Each folder between the start dir and the file must be a package.
        folders = [start.joinpath(*relative.parts[: i + 1]) for i in range(len(relative.parts) - 1)]
        if any(not (folder / "__init__.py").exists() for folder in folders):
            found.append(str(file))
    return found


# Discovers tests under `start_dir` matching `pattern`, runs them, and returns the exit code.
def run(start_dir: str, pattern: str) -> int:
    # A test file discovery would skip is a test that never runs: fail and name it.
    hidden = unreachable_tests(start_dir, pattern)
    if hidden:
        sys.stderr.write(
            "run_unittests: these test files sit in a folder with no __init__.py, so unittest skips them:\n"
        )
        sys.stderr.writelines(f"  {path}\n" for path in hidden)
        return 1
    # Discovery: an import error in a test file surfaces as a failing test, not a silent skip.
    suite = unittest.defaultTestLoader.discover(start_dir, pattern=pattern)
    # Run them with the default text runner, so output reads like `python -m unittest`.
    result = unittest.TextTestRunner(verbosity=1).run(suite)
    # Zero tests, or every one skipped, is the failure this wrapper exists to catch: unittest printed "OK".
    if result.testsRun - len(result.skipped) == 0:
        sys.stderr.write(
            f"run_unittests: no tests ran for {pattern!r} under {start_dir!r} (none matched, or all skipped)\n"
        )
        return 1
    # Otherwise unittest's own verdict decides.
    return 0 if result.wasSuccessful() else 1


# Entry: `run_unittests.py <start_dir> [pattern]`; pattern defaults to the pack's `*_test.py`.
# `version` is a parameter so the test can pretend to be an old Python.
def main(argv: list[str], version: tuple[int, ...] | None = None) -> int:
    # Too old a Python: say so, instead of a SyntaxError or a quiet wrong answer from the test files.
    current = tuple(sys.version_info[:2]) if version is None else version
    if current < MIN_PYTHON:
        sys.stderr.write(
            f"run_unittests: needs Python {MIN_PYTHON[0]}.{MIN_PYTHON[1]}+, found {current[0]}.{current[1]}\n"
        )
        return 3
    # One or two arguments; anything else is a usage error, not a guess.
    if not 2 <= len(argv) <= 3:
        sys.stderr.write("usage: run_unittests.py <start_dir> [pattern]\n")
        return 2
    return run(argv[1], argv[2] if len(argv) == 3 else "*_test.py")


# Run only as a script, so the test can import `run` and `main`.
if __name__ == "__main__":
    sys.exit(main(sys.argv))
