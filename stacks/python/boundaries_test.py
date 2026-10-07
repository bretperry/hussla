"""Proves the Python pack's boundary checks fire: each broken tree must fail, and the clean one must pass.
In the app: nothing at runtime; `pnpm py:selftest` and `pnpm check` run it.
Used by: package.json `py:selftest`, through scripts/lib/run_unittests.py.
Uses: the real pyproject.toml and src/app copied into a temp dir, uv's venv tools (lint-imports, ruff).

A boundary check that quietly matches nothing is the failure this exists for. Each case copies
the real contracts and the real source, breaks one thing, and runs the real tool: a domain
module importing an adapter, a layer name misspelled, a root package misspelled, a module that no
layer owns, and an I/O package imported in the domain. The first case breaks nothing and must
pass, so a red result below means the tool caught the break, not that it could not start.
Run it with `uv run`, so the tools are on the path.
"""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path

import domain_purity

# The repo root: this file is stacks/python/boundaries_test.py.
ROOT = Path(__file__).resolve().parents[2]

# The venv's bin directory: where `uv run python` put lint-imports and ruff.
BIN = Path(sys.executable).parent


class Tree:
    """A temp copy of the real pyproject.toml and src/, safe to break."""

    def __init__(self) -> None:
        self.dir = Path(tempfile.mkdtemp(prefix="py-pack-"))
        shutil.copy(ROOT / "pyproject.toml", self.dir / "pyproject.toml")
        shutil.copytree(
            ROOT / "src", self.dir / "src", ignore=shutil.ignore_patterns("__pycache__")
        )

    # Adds or overwrites a file under the copy.
    def write(self, relative: str, text: str) -> None:
        path = self.dir / relative
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(text)

    # Replaces text in the copy's pyproject.toml; fails the test when it isn't there (a stale case).
    def edit_pyproject(self, old: str, new: str) -> None:
        path = self.dir / "pyproject.toml"
        text = path.read_text()
        assert old in text, f"pyproject.toml no longer contains {old!r}; update this case"
        path.write_text(text.replace(old, new))

    # Runs a venv tool inside the copy; src/ of the copy comes first on the import path.
    def run(self, tool: str, *args: str) -> subprocess.CompletedProcess[str]:
        env = {**os.environ, "PYTHONPATH": str(self.dir / "src")}
        return subprocess.run(
            [str(BIN / tool), *args],
            cwd=self.dir,
            env=env,
            capture_output=True,
            text=True,
            check=False,
        )

    def cleanup(self) -> None:
        shutil.rmtree(self.dir, ignore_errors=True)


class BoundaryChecks(unittest.TestCase):
    def tree(self) -> Tree:
        tree = Tree()
        self.addCleanup(tree.cleanup)
        return tree

    def test_the_unbroken_tree_passes(self) -> None:
        # The control: without it, every red case below could be the tool failing to start.
        result = self.tree().run("lint-imports")
        self.assertEqual(result.returncode, 0, result.stdout + result.stderr)
        self.assertIn("1 kept, 0 broken", result.stdout)

    def test_a_domain_module_importing_an_adapter_fails_lint_imports(self) -> None:
        tree = self.tree()
        tree.write("src/app/domain/leaky.py", "from app.adapters import system_clock\n")
        result = tree.run("lint-imports")
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("app.domain.leaky -> app.adapters.system_clock", result.stdout)

    def test_a_use_case_importing_an_adapter_fails_lint_imports(self) -> None:
        tree = self.tree()
        tree.write("src/app/services/leaky.py", "from app.adapters import system_clock\n")
        result = tree.run("lint-imports")
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("app.services.leaky -> app.adapters.system_clock", result.stdout)

    def test_a_misspelled_layer_fails_loudly_instead_of_passing(self) -> None:
        tree = self.tree()
        tree.edit_pyproject('"services | adapters"', '"services | adaptors"')
        result = tree.run("lint-imports")
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertIn("app.adaptors does not exist", result.stdout + result.stderr)

    def test_a_misspelled_root_package_fails_loudly_instead_of_passing(self) -> None:
        tree = self.tree()
        tree.edit_pyproject('root_package = "app"', 'root_package = "apps"')
        result = tree.run("lint-imports")
        self.assertNotEqual(result.returncode, 0, result.stdout)
        self.assertNotIn("kept", result.stdout)

    def test_a_module_no_layer_owns_fails_instead_of_slipping_past(self) -> None:
        tree = self.tree()
        tree.write("src/app/utils.py", "VALUE = 1\n")
        result = tree.run("lint-imports")
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("app.utils", result.stdout)

    def test_an_io_package_in_the_domain_fails_ruff(self) -> None:
        tree = self.tree()
        tree.write(
            "src/app/domain/leaky.py",
            "import sqlite3\n\nCONNECTION = sqlite3.connect(':memory:')\n",
        )
        result = tree.run("ruff", "check", "--select", "TID251", "src")
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("TID251", result.stdout)

    def test_an_adapter_may_import_an_io_package(self) -> None:
        tree = self.tree()
        tree.write(
            "src/app/adapters/db.py", "import sqlite3\n\nCONNECTION = sqlite3.connect(':memory:')\n"
        )
        result = tree.run("ruff", "check", "--select", "TID251", "src")
        self.assertEqual(result.returncode, 0, result.stdout)


class NamespaceAndPurityChecks(unittest.TestCase):
    def tree(self) -> Tree:
        tree = Tree()
        self.addCleanup(tree.cleanup)
        return tree

    # Violations the allow-list check reports for a temp tree's domain.
    def purity(self, tree: Tree) -> list[str]:
        return domain_purity.violations(tree.dir / "src", tree.dir / "src" / "app" / "domain")

    def test_a_subpackage_with_no_init_file_fails_ruff_because_import_linter_cannot_see_it(
        self,
    ) -> None:
        # The hole: import-linter skips a folder with no __init__.py, so an upward import inside it passes.
        tree = self.tree()
        tree.write(
            "src/app/domain/sub/x.py", "from app.services import note_sync\n\nUSED = note_sync\n"
        )
        self.assertEqual(tree.run("lint-imports").returncode, 0)
        result = tree.run("ruff", "check", "--select", "INP001", "src")
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("src/app/domain/sub", result.stdout)

    def test_a_new_top_level_package_with_no_init_file_fails_ruff(self) -> None:
        tree = self.tree()
        tree.write("src/app/web/handler.py", "VALUE = 1\n")
        result = tree.run("ruff", "check", "--select", "INP001", "src")
        self.assertEqual(result.returncode, 1, result.stdout)
        self.assertIn("src/app/web", result.stdout)

    def test_each_io_import_and_clock_read_fails_ruff_in_the_domain(self) -> None:
        for name, line in {
            "from os import path": "from os import path\n\nUSED = path\n",
            "import pathlib": "import pathlib\n\nUSED = pathlib.Path\n",
            "import io": "import io\n\nUSED = io\n",
            "import time": "import time\n\nUSED = time\n",
            "import http.client": "import http.client\n\nUSED = http.client\n",
            "import smtplib": "import smtplib\n\nUSED = smtplib\n",
            "import importlib": "import importlib\n\nUSED = importlib\n",
            "asyncio.open_connection": "import asyncio\n\nUSED = asyncio.open_connection\n",
            "asyncio.create_subprocess_exec": "import asyncio\n\nUSED = asyncio.create_subprocess_exec\n",
            "datetime.now": "import datetime\n\nUSED = datetime.datetime.now()\n",
            "date.today": "import datetime\n\nUSED = datetime.date.today()\n",
        }.items():
            with self.subTest(name):
                tree = self.tree()
                tree.write("src/app/domain/leaky.py", line)
                result = tree.run("ruff", "check", "--select", "TID251", "src")
                self.assertEqual(result.returncode, 1, result.stdout)

    def test_the_real_domain_passes_the_allow_list(self) -> None:
        self.assertEqual(self.purity(self.tree()), [])

    def test_the_allow_list_catches_what_the_ban_list_misses(self) -> None:
        for name, body in {
            "third-party package": "import numpy\n",
            "from a third-party package": "from yaml import safe_load\n",
            "another app layer": "from app.services import note_sync\n",
            "another layer by name": "from app import ports\n",
            "a relative import that climbs out": "from .. import ports\n",
            "an I/O stdlib module": "import tempfile\n",
            "open()": "HANDLE = open('x')\n",
            "__import__()": "MODULE = __import__('os')\n",
        }.items():
            with self.subTest(name):
                tree = self.tree()
                tree.write("src/app/domain/leaky.py", body)
                self.assertNotEqual(self.purity(tree), [])

    def test_the_allow_list_accepts_the_pure_standard_library_the_config_and_the_domain(
        self,
    ) -> None:
        tree = self.tree()
        tree.write(
            "src/app/domain/fine.py",
            "import dataclasses\nimport math\nfrom app import config\nfrom app.config import SYNC_MAX_ATTEMPTS\n"
            "from app.domain import note\nfrom . import result\n",
        )
        self.assertEqual(self.purity(tree), [])

    def test_a_missing_domain_dir_fails_instead_of_passing_vacuously(self) -> None:
        tree = self.tree()
        shutil.rmtree(tree.dir / "src" / "app" / "domain")
        self.assertEqual(domain_purity.main(["domain_purity.py", str(tree.dir / "src")]), 2)


if __name__ == "__main__":
    unittest.main()
