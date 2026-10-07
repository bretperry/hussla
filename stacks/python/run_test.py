"""Tests for run.py: an unknown check and a missing uv both fail, and every package.json script names a real check.
In the app: nothing at runtime; the Python pack's `py:selftest` check runs it.
Used by: stacks/python/run.py's own runner (scripts/lib/run_unittests.py).
Uses: unittest, json, mock (stdlib only); package.json for the script names.
"""

from __future__ import annotations

import io
import json
import unittest
from contextlib import redirect_stderr
from pathlib import Path
from unittest import mock

import run as run_module

# The repo root: this file is stacks/python/run_test.py.
ROOT = Path(__file__).resolve().parents[2]


class Run(unittest.TestCase):
    def test_an_unknown_check_is_a_usage_error(self) -> None:
        with redirect_stderr(io.StringIO()):
            self.assertEqual(run_module.run("nope"), 2)

    def test_a_missing_uv_fails_with_a_message_not_a_pass(self) -> None:
        err = io.StringIO()
        with mock.patch("shutil.which", return_value=None), redirect_stderr(err):
            self.assertEqual(run_module.run("lint"), 127)
        self.assertIn("uv is not installed", err.getvalue())

    def test_the_first_failing_command_stops_the_check(self) -> None:
        with (
            mock.patch("shutil.which", return_value="/bin/uv"),
            mock.patch("subprocess.run", return_value=mock.Mock(returncode=3)) as fake,
        ):
            self.assertEqual(run_module.run("lint"), 3)
        self.assertEqual(fake.call_count, 1)

    def test_every_package_json_py_script_names_a_real_check(self) -> None:
        # A script that names a check run.py lacks would exit 2 forever, and `pnpm check` would say so late.
        scripts = json.loads((ROOT / "package.json").read_text())["scripts"]
        for name, command in scripts.items():
            if command.startswith("python3 stacks/python/run.py "):
                self.assertIn(command.split()[-1], run_module.CHECKS, name)


if __name__ == "__main__":
    unittest.main()
