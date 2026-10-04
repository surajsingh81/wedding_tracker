#!/usr/bin/env python3
"""Run the Python test suites, and the JXA helper steps used by end-to-end runs.

Usage:  python3 tests/run_py.py [test_py_unit] [test_py_integration] ...

Each test_py_*.py file is executed as a script; whatever it prints is totalled.
A file that prints no SUITE_RESULT line counts as a failure, which is what
catches a suite that dies before reaching finish().
"""
import json
import re
import subprocess
import sys
from pathlib import Path

HERE = Path(__file__).resolve().parent
REPO = HERE.parent
TMP = Path("/tmp/wt/pytest")
DEFAULT = ["test_py_unit", "test_py_integration", "test_py_dynamic_hotels", "test_py_e2e"]
COUNTS = re.compile(r"SUITE_RESULT: PASS (\d+) / FAIL (\d+) / TOTAL (\d+)")


def counts(out):
    m = COUNTS.search(out)
    return (int(m.group(1)), int(m.group(2)), int(m.group(3))) if m else None


def run_jxa(script_name, in_file=None, out_file=None, extra=None):
    """Run a JXA step with IN_FILE / OUT_FILE (and any extra globals) prepended."""
    TMP.mkdir(parents=True, exist_ok=True)
    merged = TMP / (script_name + ".merged.js")
    pre = ""
    if in_file:
        pre += "var IN_FILE = %r;\n" % str(in_file)
    if out_file:
        pre += "var OUT_FILE = %r;\n" % str(out_file)
    for k, v in (extra or {}).items():
        pre += "var %s = %s;\n" % (k, json.dumps(v))
    merged.write_text(pre + (HERE / "lib_harness.js").read_text()
                      + "\n;\n" + (HERE / (script_name + ".js")).read_text())
    proc = subprocess.run(["osascript", "-l", "JavaScript", str(merged)],
                          capture_output=True, text=True, timeout=600)
    if proc.returncode != 0:
        raise RuntimeError("%s failed (exit %d)\n%s"
                           % (script_name, proc.returncode, (proc.stderr or "").strip()))
    return out_file


def run_suite(name):
    path = HERE / (name + ".py")
    if not path.exists():
        return False, "missing suite file: %s" % path.name
    proc = subprocess.run([sys.executable, str(path)], capture_output=True,
                          text=True, timeout=1800, cwd=str(REPO))
    out = (proc.stdout or "").strip()
    if not counts(out):
        out = (out + "\n" + (proc.stderr or "")).strip() or \
            "(no SUITE_RESULT; exit %d)" % proc.returncode
        return False, out
    ok = counts(out)[1] == 0 and proc.returncode == 0
    tail = "" if ok else "\n[stderr] " + (proc.stderr or "").strip()
    return ok, out + tail


def main(argv):
    names = argv or DEFAULT
    tp = tf = tt = 0
    failed = []
    for name in names:
        ok, out = run_suite(name)
        print("=" * 62)
        print(out)
        c = counts(out)
        if c:
            tp += c[0]; tf += c[1]; tt += c[2]
        if not ok:
            failed.append(name)
    print("=" * 62)
    print("PYTHON: %d passed, %d failed, %d total" % (tp, tf, tt))
    if failed:
        print("failed suites: " + ", ".join(failed))
        return 1
    print("all Python suites green")
    return 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
