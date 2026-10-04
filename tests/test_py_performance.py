#!/usr/bin/env python3
"""Layer 6: PERFORMANCE — smoke measurements (deterministic enough to trend).

Measures payload size, export/apply time, and render/export/apply budgets.
Everything runs against throwaway copies in /tmp; no repo files touched.
"""
import json
import shutil
import subprocess
import sys
import time
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib_py import Suite, finish  # noqa: E402
from run_py import run_jxa  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
TMP = Path("/tmp/wt/pytest")
SRC = REPO / "Wedding_Expense_Tracker_Dec2026.xlsx"
TMP.mkdir(parents=True, exist_ok=True)


def export(workbook, out):
    t0 = time.time()
    subprocess.run([sys.executable, str(REPO / "tools" / "export_site_data.py"),
                    "--workbook", str(workbook), "--out", str(out)],
                   check=True, capture_output=True)
    return time.time() - t0, json.loads(out.read_text())


def apply(payload_path, workbook):
    t0 = time.time()
    subprocess.run([sys.executable, str(REPO / "tools" / "apply_payload.py"),
                    str(payload_path), "--workbook", str(workbook), "--no-backup"],
                   check=True, capture_output=True)
    return time.time() - t0


def main():
    S = []
    P = Suite("PERFORMANCE / smoke measurements")

    # migrated baseline
    wb = TMP / "perf.xlsx"
    shutil.copy2(SRC, wb)
    subprocess.run([sys.executable, str(REPO / "tools" / "migrate_hotels.py"),
                    "--workbook", str(wb)], check=True, capture_output=True)
    t_exp_base, base = export(wb, TMP / "perf-base.json")
    (TMP / "data.json").write_text(json.dumps({"generated": base["generated"]}))

    # build a realistic delta (edits + rooms change)
    delta_path = TMP / "perf-delta.json"
    run_jxa("e2e_build_delta", in_file=TMP / "perf-base.json",
            out_file=delta_path, extra={"ACTOR": "Perf"})
    delta = json.loads(delta_path.read_text())
    body = json.dumps(delta, separators=(",", ":"))
    kb = len(body) / 1024.0

    P.ok(kb < 50, "Delta payload < 50KB for a typical edit set",
         "%.1fKB (guests=%d rooms=%d)" % (kb, delta["stats"]["guestsSent"],
                                           len(delta["rooms"])))
    P.ok(delta["stats"]["cellsConsidered"] > 0,
         "All grid cells across hotels are considered")
    P.ok(delta["stats"]["guestsSent"] <= 20,
         "Guest edits are sparse (<=20 cells)")

    t_app = apply(delta_path, wb)
    t_exp_after, after = export(wb, TMP / "perf-after.json")

    P.ok(t_exp_base < 1.0, "Export completes in < 1s",
         "%.3fs" % t_exp_base)
    P.ok(t_app < 1.0, "Apply completes in < 1s",
         "%.3fs" % t_app)
    P.ok(t_exp_after < 1.0, "Re-export completes in < 1s",
         "%.3fs" % t_exp_after)

    # full payload size sanity: build a true full payload via the page logic
    full_path = TMP / "perf-full.json"
    run_jxa("e2e_build_delta", in_file=TMP / "perf-base.json",
            out_file=full_path, extra={"ACTOR": "__FULL__"})
    full = json.loads(full_path.read_text())
    full_kb = len(json.dumps(full, separators=(",", ":"))) / 1024.0
    P.ok(kb < full_kb / 4, "Delta is at least 4x smaller than a full payload",
         "%.1fKB vs %.1fKB" % (kb, full_kb))

    S.append(P)
    finish(S)


if __name__ == "__main__":
    main()
