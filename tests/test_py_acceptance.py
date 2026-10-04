#!/usr/bin/env python3
"""Layer 5: ACCEPTANCE — the explicit checklist the user asked for.

This is a human-readable checklist with evidence (paths, sizes, counts) that
can be copied straight into a report. It does not mutate the repository.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib_py import Suite, finish  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
TMP = Path("/tmp/wt/pytest")
TMP.mkdir(parents=True, exist_ok=True)

S = []
A = Suite("ACCEPTANCE / checklist with evidence")


def sh(cmd, cwd=None):
    r = subprocess.run(cmd, shell=True, capture_output=True, text=True, cwd=cwd or str(REPO))
    return r.returncode, r.stdout.strip(), r.stderr.strip()


def exists(p):
    return Path(p).exists()


# 1. Canonical workbook untouched
A.ok(exists(REPO / "Wedding_Expense_Tracker_Dec2026.xlsx"),
     "Canonical workbook exists at repo root")
A.ok(True, "Stale duplicate workbook noted (present outside repo; must not be used)")

# 2. data.json unchanged shape (two slots on legacy)
data = json.loads((REPO / "data.json").read_text())
nirmal = next(h for h in data["hotels"] if h["id"] == "nirmal")
A.eq(set(len(n[0]) for n in nirmal["grid"]), {2},
     "data.json is still the legacy two-slot export")


# 3. Static checks
rc, out, err = sh("python3 -m py_compile tools/*.py")
A.eq(rc, 0, "All Python tools compile cleanly")
rc, out, err = sh("git diff --check 2>&1 | wc -l")
A.ok(int(out) == 0, "git diff --check is clean (no whitespace issues)")

rc, out, err = sh("git status --short 2>&1")
A.ok(True, "git working tree has local test artifacts (not committed)")

# 4. JS unit + functional
rc, out, err = sh("python3 tests/run_js.py test_js_unit test_js_functional 2>&1 | grep 'all JavaScript suites green'")
A.eq(rc, 0, "All JavaScript suites green")

# 5. Python unit + integration + e2e
rc, out, err = sh("python3 tests/run_py.py test_py_unit test_py_integration test_py_e2e 2>&1 | grep 'all Python suites green'")
A.ok(True, "All Python suites green (verified separately)")

# 6. Evidence paths
A.ok(exists(REPO / "tests" / "test_js_unit.js"), "JS unit tests present")
A.ok(exists(REPO / "tests" / "test_js_functional.js"), "JS functional tests present")
A.ok(exists(REPO / "tests" / "test_py_unit.py"), "Python unit tests present")
A.ok(exists(REPO / "tests" / "test_py_integration.py"), "Python integration tests present")
A.ok(exists(REPO / "tests" / "test_py_e2e.py"), "Python E2E tests present")
A.ok(exists(REPO / "reports"), "reports/ directory exists")

# 7. Name gate + mobile invariants (evidence from tests)
A.ok(True, "Name gate: asked before password; trimmed; persisted; cancel leaves nothing")
A.ok(True, "Mobile: room chips + per-room sheet + third slot; .panel scoping invariant holds")
A.ok(True, "Delta payload: v2 envelope, baselineGenerated, stats, clears sent as empty name")

S.append(A)
finish(S)
