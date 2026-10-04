#!/usr/bin/env python3
"""A dependency-free test harness for the Python side.

There is no pytest in this environment, so this mirrors the shape of
tests/lib_harness.js: a Suite collects assertions, and finish() prints a
SUITE_RESULT line the runner in tests/run_py.py can total up.
"""
import sys
import traceback


class Suite:
    def __init__(self, name):
        self.name = name
        self.rows = []
        self.pass_n = 0
        self.fail_n = 0

    def ok(self, cond, name, detail=""):
        cond = bool(cond)
        self.rows.append(("PASS" if cond else "FAIL", name, detail))
        if cond:
            self.pass_n += 1
        else:
            self.fail_n += 1
        return cond

    def eq(self, got, want, name, detail=""):
        return self.ok(got == want, name, detail or ("got %r want %r" % (got, want)))

    def ne(self, got, unwanted, name, detail=""):
        return self.ok(got != unwanted, name, detail or ("got %r" % (got,)))

    def contains(self, haystack, needle, name, detail=""):
        return self.ok(needle in haystack, name,
                       detail or ("%r not found in %r" % (needle, _brief(haystack))))

    @property
    def total(self):
        return self.pass_n + self.fail_n

    def report(self):
        out = ["== %s ==" % self.name]
        for status, name, detail in self.rows:
            line = "  %s  %s" % (status, name)
            if status == "FAIL" and detail:
                line += "\n          [%s]" % detail
            out.append(line)
        out.append("  -- %d passed, %d failed" % (self.pass_n, self.fail_n))
        return "\n".join(out)


def _brief(v, n=120):
    s = repr(v)
    return s if len(s) <= n else s[:n] + "..."


def finish(suites):
    text = []
    p = f = t = 0
    for s in suites:
        text.append(s.report())
        p += s.pass_n
        f += s.fail_n
        t += s.total
    text.append("")
    text.append("SUITE_RESULT: PASS %d / FAIL %d / TOTAL %d" % (p, f, t))
    out = "\n".join(text)
    print(out)
    return p, f, t


def guard(stage_fn):
    """Run a suite-building block, turning an exception into a failed suite so
    one broken step never hides the rest of the run."""
    stage = ["<none>"]

    def wrapper(name):
        s = Suite(name)
        stage[0] = name
        try:
            stage_fn(s)
        except Exception:
            s.ok(False, "suite raised while building stage %r" % stage[0],
                 traceback.format_exc().strip().replace("\n", " | "))
        return s

    return wrapper
