#!/usr/bin/env python3
"""Run the JavaScript test suites under macOS JXA.

There is no Node in this environment, but JavaScriptCore is present, so the real
app.js / sync.js / auth.js can be loaded and driven directly. Each suite is the
concatenation of tests/lib_harness.js and the suite file; osascript prints the
value of the final expression, which is the suite's report string.
"""
import json
import re
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TESTS = ROOT / "tests"
HARNESS = TESTS / "lib_harness.js"
TMP = Path("/tmp/wt/js")


def run_suite(name: str) -> tuple[bool, str]:
    suite = TESTS / f"{name}.js"
    if not suite.exists():
        return False, f"missing suite file: {suite.name}"
    TMP.mkdir(parents=True, exist_ok=True)
    merged = TMP / f"{name}.merged.js"
    report = TMP / f"{name}.report.txt"
    if report.exists():
        report.unlink()
    # OUT_FILE lets the harness hand the report back even when osascript
    # swallows the value of the last expression.
    merged.write_text(
        'var OUT_FILE = ' + json.dumps(str(report)) + ";\n"
        + HARNESS.read_text() + "\n;\n" + suite.read_text()
    )
    proc = subprocess.run(
        ["osascript", "-l", "JavaScript", str(merged)],
        capture_output=True, text=True, timeout=600,
    )
    err = (proc.stderr or "").strip()
    out = report.read_text().strip() if report.exists() else ""
    if not out:
        out = f"(no report produced; exit={proc.returncode})"
    ok = "SUITE_RESULT:" in out and _counts(out)[1] == 0 and not err
    return ok, (out + ("\n[stderr] " + err if err else ""))


def _counts(out: str) -> tuple[int, int, int]:
    m = re.search(r"SUITE_RESULT: PASS (\d+) / FAIL (\d+) / TOTAL (\d+)", out)
    return (int(m.group(1)), int(m.group(2)), int(m.group(3))) if m else (0, 0, 0)


def main() -> int:
    names = sys.argv[1:] or [
        "test_js_unit", "test_js_functional", "test_js_realtime", "test_js_e2e", "test_js_perf",
    ]
    total_pass = total_fail = total = 0
    failed_suites = []
    for name in names:
        ok, out = run_suite(name)
        print(out)
        a, b, c = _counts(out)
        total_pass += a; total_fail += b; total += c
        if not ok:
            failed_suites.append(name)
        print()

    print("=" * 62)
    print(f"JAVASCRIPT: {total_pass} passed, {total_fail} failed, {total} total")
    if failed_suites:
        print("failed suites: " + ", ".join(failed_suites))
        return 1
    print("all JavaScript suites green")
    return 0


if __name__ == "__main__":
    sys.exit(main())