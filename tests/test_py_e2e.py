#!/usr/bin/env python3
"""Layer 4: END-TO-END — edit → payload → apply → export → reload.

This is the cross-language contract: the JXA page logic builds a delta, the
Python pipeline applies it to a workbook, the exporter reads it back, and the
page logic can reload that export and see the same state. No repository files
are modified; everything lives under /tmp/wt/pytest.
"""
import json
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib_py import Suite, finish  # noqa: E402
from run_py import run_jxa  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
TMP = Path("/tmp/wt/pytest")
SRC = REPO / "Wedding_Expense_Tracker_Dec2026.xlsx"
TMP.mkdir(parents=True, exist_ok=True)


def export(workbook, out):
    subprocess.run([sys.executable, str(REPO / "tools" / "export_site_data.py"),
                    "--workbook", str(workbook), "--out", str(out)],
                   check=True, capture_output=True)
    return json.loads(out.read_text())


def apply(payload_path, workbook, make_backup=False):
    subprocess.run([sys.executable, str(REPO / "tools" / "apply_payload.py"),
                    str(payload_path), "--workbook", str(workbook),
                    "--no-backup" if not make_backup else "--export"],
                   check=True, capture_output=True)


def main():
    S = []
    ACTOR = "E2E Tester"

    # 1. start from a migrated copy (so slot 3 is real and roomsBooked exists)
    wb = TMP / "e2e.xlsx"
    shutil.copy2(SRC, wb)
    migrate = subprocess.run([sys.executable, str(REPO / "tools" / "migrate_hotels.py"),
                              "--workbook", str(wb)],
                             check=True, capture_output=True, text=True)

    # 2. export the baseline
    base = export(wb, TMP / "e2e-base.json")
    (TMP / "data.json").write_text(json.dumps({"generated": base["generated"]}))

    # 3. have the page build a delta against that baseline
    delta_path = TMP / "e2e-delta.json"
    run_jxa("e2e_build_delta", in_file=TMP / "e2e-base.json",
            out_file=delta_path, extra={"ACTOR": ACTOR})
    delta = json.loads(delta_path.read_text())

    S_ = Suite("E2E / the page builds a delta")
    S_.eq(delta["mode"], "delta", "it is a delta, not a full payload")
    S_.eq(delta["author"], ACTOR, "the author is the name we collected")
    S_.ok(delta["baselineGenerated"] == base["generated"],
          "the delta is measured against the export we just made")
    S_.ok(delta["stats"]["guestsSent"] >= 1, "at least one guest cell differs")
    S_.ok(delta["stats"]["cellsConsidered"] > 0, "all cells were considered")
    S_.ok(delta["rooms"], "the rooms list was sent (roomsBooked/roomNos changed)")
    S.append(S_)

    # 4. apply the delta to the workbook
    apply(delta_path, wb)
    after = export(wb, TMP / "e2e-after.json")

    S_ = Suite("E2E / apply → export round trip")
    S_.ok(bool(after["generated"]), "the export was re-stamped (has a generated stamp)")
    S_.ok(after["generated"] >= base["generated"], "the stamp did not go backwards")
    S.append(S_)

    # 5. reload the new export in the page and confirm the state matches
    delta2_path = TMP / "e2e-delta2.json"
    run_jxa("e2e_build_delta", in_file=TMP / "e2e-after.json",
            out_file=delta2_path, extra={"ACTOR": "__NOOP__"})
    delta2 = json.loads(delta2_path.read_text())

    S_ = Suite("E2E / a no-op delta after reload")
    S_.eq(delta2["mode"], "delta", "still a delta")
    S_.eq(delta2["stats"]["guestsSent"], 0, "no guest cells differ after reload")
    S_.eq(delta2["rooms"], [], "no room changes after reload")
    S_.eq(delta2["baselineGenerated"], after["generated"],
          "the new baseline is the one we just exported")
    S.append(S_)

    # 6. the clear instruction survives: a cell that went from filled to empty
    #    must be sent again if we change something else, but more directly, the
    #    first delta must have included the clear we asked for.
    cleared = [g for g in delta["guests"] if g["name"] == ""]
    S_ = Suite("E2E / the clear contract is preserved")
    S_.ok(cleared, "at least one clear (name: '') was sent in the delta",
          "guests=%r" % ([{"h": g["hotel"], "r": g["room"], "n": g["night"],
                           "s": g["slot"], "name": g["name"]} for g in delta["guests"]]))
    S.append(S_)

    return S


if __name__ == "__main__":
    finish(main())
