"""Tests for run_unittests.py: a pass is 0, a failure is 1, and a run that finds no tests is 1.
In the app: nothing at runtime; the Python pack's `py:tooling` check runs it.
Used by: scripts/lib/run_unittests.py's own runner (python3 scripts/lib/run_unittests.py scripts/lib).
Uses: unittest, subprocess, tempfile (stdlib only).
"""

from __future__ import annotations

import io
import subprocess
import sys
import tempfile
import textwrap
import unittest
from contextlib import redirect_stderr
from pathlib import Path

import run_unittests

# The runner under test; this file sits beside it.
RUNNER = Path(__file__).with_name("run_unittests.py")


# Runs the runner in a child process over a temp dir holding `files`; returns (exit code, stderr).
def run_over(files: dict[str, str], *extra: str) -> tuple[int, str]:
    with tempfile.TemporaryDirectory() as tmp:
        for name, body in files.items():
            Path(tmp, name).parent.mkdir(parents=True, exist_ok=True)
            Path(tmp, name).write_text(textwrap.dedent(body))
        done = subprocess.run(
            [sys.executable, str(RUNNER), tmp, *extra],
            cwd=tmp,
            capture_output=True,
            text=True,
            check=False,
        )
        return done.returncode, done.stderr


PASSING = """
    import unittest

    class T(unittest.TestCase):
        def test_ok(self) -> None:
            self.assertTrue(True)
"""

FAILING = PASSING.replace("assertTrue(True)", "assertTrue(False)")


class RunUnittests(unittest.TestCase):
    def test_a_passing_suite_exits_zero(self) -> None:
        code, _ = run_over({"a_test.py": PASSING})
        self.assertEqual(code, 0)

    def test_a_failing_suite_exits_one(self) -> None:
        code, _ = run_over({"a_test.py": FAILING})
        self.assertEqual(code, 1)

    def test_a_pattern_that_matches_nothing_exits_one_and_says_so(self) -> None:
        # The silent failure: bare `unittest discover` on 3.11 exits 0 after "Ran 0 tests".
        code, err = run_over({"a_test.py": PASSING}, "*_nope.py")
        self.assertEqual(code, 1)
        self.assertIn("no tests ran", err)

    def test_a_test_file_that_cannot_import_fails_instead_of_vanishing(self) -> None:
        code, _ = run_over({"a_test.py": "import a_module_that_does_not_exist\n"})
        self.assertEqual(code, 1)

    def test_a_suite_where_every_test_is_skipped_exits_one(self) -> None:
        skipped = PASSING.replace("def test_ok", "@unittest.skip('later')\n        def test_ok")
        code, err = run_over({"a_test.py": skipped})
        self.assertEqual(code, 1)
        self.assertIn("all skipped", err)

    def test_a_test_file_in_a_folder_with_no_init_file_fails_and_is_named(self) -> None:
        # 3.11's loader skips such a folder without a word.
        code, err = run_over({"sub/b_test.py": PASSING, "a_test.py": PASSING})
        self.assertEqual(code, 1)
        self.assertIn("b_test.py", err)

    def test_a_test_file_in_a_package_folder_runs(self) -> None:
        code, _ = run_over({"sub/__init__.py": "", "sub/b_test.py": PASSING})
        self.assertEqual(code, 0)

    def test_an_old_python_fails_with_a_clear_message(self) -> None:
        err = io.StringIO()
        with redirect_stderr(err):
            self.assertEqual(run_unittests.main(["run_unittests.py", "."], version=(3, 9)), 3)
        self.assertIn("needs Python 3.11+", err.getvalue())

    def test_wrong_arguments_exit_two(self) -> None:
        done = subprocess.run(
            [sys.executable, str(RUNNER)], capture_output=True, text=True, check=False
        )
        self.assertEqual(done.returncode, 2)


if __name__ == "__main__":
    unittest.main()
