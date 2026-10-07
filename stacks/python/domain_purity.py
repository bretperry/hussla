#!/usr/bin/env python3
"""Fails when app/domain imports anything but the pure standard library, app.config, or app.domain, or calls open()/__import__().
In the app: nothing at runtime; `pnpm py:boundaries` runs it beside import-linter.
Used by: stacks/python/run.py (boundaries); stacks/python/boundaries_test.py.
Uses: nothing: stdlib only (ast, sys.stdlib_module_names, so Python 3.10+).

Ruff's TID251 is a deny list: it knows the I/O packages someone thought of. This is the allow
list that catches the rest, and what import-linter can't see (it ignores third-party packages
here, `include_external_packages = false`). Allowed: the standard library minus the I/O modules
in IO_MODULES, `app.config`, and `app.domain`. Not allowed: any third-party package, any other
app layer, a relative import that climbs out of the domain, and the two builtins that reach
around an import: `open(` and `__import__(`.
"""

from __future__ import annotations

import ast
import sys
from pathlib import Path

# Standard-library modules that do I/O, read the clock or environment, or load code by name.
IO_MODULES = frozenset(
    {
        "os", "pathlib", "io", "time", "http", "smtplib", "ftplib", "importlib", "socket", "ssl",
        "subprocess", "shutil", "sqlite3", "urllib", "select", "selectors", "tempfile", "glob",
        "fileinput", "ctypes", "multiprocessing", "threading", "signal", "sys", "logging", "shelve",
        "dbm", "zipfile", "tarfile", "gzip", "bz2", "lzma", "xmlrpc", "poplib", "imaplib",
        "telnetlib", "socketserver", "webbrowser", "pty", "fcntl", "mmap", "pickle", "runpy",
        "sched", "asyncio", "concurrent", "random", "secrets", "uuid", "getpass", "platform",
    }
)  # fmt: skip

# The only app modules the domain may import: itself and the knobs.
ALLOWED_APP = ("app.domain", "app.config")

# Builtins that reach around an import or touch the filesystem.
BANNED_CALLS = frozenset({"open", "__import__"})


# The dotted module a file defines, from its path under `root` ("src/app/domain/note.py" -> "app.domain.note").
def module_name(root: Path, file: Path) -> str:
    parts = list(file.relative_to(root).with_suffix("").parts)
    return ".".join(parts[:-1] if parts[-1] == "__init__" else parts)


# True when `module` (absolute, dotted) may be imported from the domain.
def allowed(module: str) -> bool:
    top = module.split(".", maxsplit=1)[0]
    if top == "app":
        return any(module == ok or module.startswith(f"{ok}.") for ok in ALLOWED_APP)
    return top in sys.stdlib_module_names and top not in IO_MODULES


# Problems in one domain file, as "path:line: message" strings.
def file_problems(src_root: Path, file: Path) -> list[str]:
    here = module_name(src_root, file)
    package = here if file.name == "__init__.py" else here.rpartition(".")[0]
    problems: list[str] = []
    for node in ast.walk(ast.parse(file.read_text(), filename=str(file))):
        where = f"{file}:{getattr(node, 'lineno', 0)}"
        if isinstance(node, ast.Import):
            problems += [f"{where}: imports {a.name}" for a in node.names if not allowed(a.name)]
        elif isinstance(node, ast.ImportFrom):
            # A relative import is resolved against this file's package, so `from .. import x` is judged as app.x.
            base = node.module or ""
            if node.level:
                anchor = package.split(".")[: len(package.split(".")) - (node.level - 1)]
                base = ".".join([*anchor, base] if base else anchor)
            # `from app import config` imports app.config, so judge each imported name as a submodule.
            if base == "app":
                ok = all(allowed(f"app.{a.name}") for a in node.names)
            else:
                ok = base != "" and allowed(base)
            if not ok:
                problems.append(f"{where}: imports {base or '.'}")
        elif (
            isinstance(node, ast.Call)
            and isinstance(node.func, ast.Name)
            and node.func.id in BANNED_CALLS
        ):
            problems.append(f"{where}: calls {node.func.id}()")
    return problems


# Problems across every .py file under `domain_dir`; `src_root` is the folder the package `app` sits in.
def violations(src_root: Path, domain_dir: Path) -> list[str]:
    return [p for f in sorted(domain_dir.rglob("*.py")) for p in file_problems(src_root, f)]


# Entry: `domain_purity.py [src_root]`, run from the repo root; src_root defaults to `src`.
def main(argv: list[str]) -> int:
    src_root = Path(argv[1] if len(argv) > 1 else "src")
    domain_dir = src_root / "app" / "domain"
    # A missing domain dir would pass vacuously: the failure this repo keeps guarding against.
    if not domain_dir.is_dir():
        sys.stderr.write(f"domain_purity: {domain_dir} does not exist\n")
        return 2
    problems = violations(src_root, domain_dir)
    for problem in problems:
        sys.stderr.write(f"{problem}\n")
    if problems:
        sys.stderr.write(
            "domain_purity: app/domain may import only the pure standard library, app.config, and app.domain, and never open()/__import__() (python.mdc)\n"
        )
    return 1 if problems else 0


# Run only as a script, so the test can import `violations`.
if __name__ == "__main__":
    sys.exit(main(sys.argv))
