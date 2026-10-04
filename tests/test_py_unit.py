#!/usr/bin/env python3
"""Layer 1 (Python side): UNIT tests for the workbook helpers.

These are the small pure functions the pipeline leans on to locate rows and
tell a real note from a layout label. Nothing here writes to the repository
workbook: the exporter is executed against a throwaway copy in /tmp.
"""
import importlib.util
import runpy
import shutil
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib_py import Suite, finish  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
TMP = Path("/tmp/wt/pytest")
SRC = REPO / "Wedding_Expense_Tracker_Dec2026.xlsx"

S = []


def load_tool(name):
    spec = importlib.util.spec_from_file_location(name, REPO / "tools" / (name + ".py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


def load_exporter(workbook, out):
    """export_site_data.py runs its export at import time, so point it at a
    throwaway copy before executing it."""
    argv = sys.argv
    sys.argv = [argv[0], "--workbook", str(workbook), "--out", str(out)]
    try:
        return runpy.run_path(str(REPO / "tools" / "export_site_data.py"))
    finally:
        sys.argv = argv


# --------------------------------------------------------------------- setup
TMP.mkdir(parents=True, exist_ok=True)
WB = TMP / "unit.xlsx"
shutil.copy2(SRC, WB)

apply = load_tool("apply_payload")
migrate = load_tool("migrate_hotels")
exporter = load_exporter(WB, TMP / "unit-export.json")

# --------------------------------------------------------------- clean / num
u = Suite("UNIT / clean, num_or_blank, num")
ap, ep, mp = apply, exporter, migrate

u.eq(ap.clean(None), "", "clean(None) is empty")
u.eq(ap.clean("  Aarti  "), "Aarti", "clean trims")
u.eq(ap.clean(7), "7", "clean stringifies a number")
u.eq(ep["clean"]("\u200eNeha"), "Neha", "the exporter strips a leading bidi mark")
u.eq(ep["clean"]("\u200fAarti\u200e"), "Aarti", "the exporter strips bidi marks on both sides")
u.eq(ap.clean(ap.clean(" x ")), ap.clean(" x "), "clean is idempotent")
u.eq(ap.clean(""), "", "clean of an empty string")

u.eq(ap.num_or_blank(None), None, "num_or_blank(None) is blank")
u.eq(ap.num_or_blank(""), None, "num_or_blank('') is blank")
u.eq(ap.num_or_blank("12"), 12.0, "num_or_blank parses a numeric string")
u.eq(ap.num_or_blank(40000), 40000.0, "num_or_blank passes a number through")
u.eq(ap.num_or_blank("abc"), None, "num_or_blank rejects prose")
u.eq(ep["num"](40000), 40000, "the exporter keeps an integer integer")
u.eq(ep["num"]("abc"), "", "the exporter blanks prose rather than exporting it")
u.eq(ep["num"](None), "", "the exporter blanks None")
S.append(u)

# ------------------------------------------------------------- is_note rules
n = Suite("UNIT / is_note: telling a note from a label")
inote, enote = mp.is_note, ep["is_note"]

prose = "Check-out is 14-Dec-2026. 13-Dec is the last night, so nobody arrives that day."
n.ok(inote(prose), "migrate: a long sentence is a note")
n.ok(enote(prose), "exporter: a long sentence is a note")
n.ok(not inote("Check-in"), "migrate: a bare label is not a note")
n.ok(not enote("Check-in"), "exporter: a bare label is not a note")
n.ok(not inote("Room 1 - Guest 1"), "migrate: a grid heading is not a note")
n.ok(not enote("Room 1 - Guest 1"), "exporter: a grid heading is not a note")
n.ok(not inote("Room Allocation Grid"), "exporter: the grid bar is not a note")
n.ok(not inote("Total room-nights"), "the totals label is not a note")
n.ok(not inote("3rd GUESTS"), "the third-guest bar is not a note")

# The A2 subtitle happens to be long, and once read as a note it would turn
# into a bogus checklist item.
subtitle = "Check-in 08-Dec-2026 | Check-out 11-Dec-2026 | 3 rooms booked"
n.ok(len(subtitle) > 40, "the subtitle really is over the length threshold")
n.ok(not inote(subtitle), "migrate: the header subtitle is not a note")
n.ok(not enote(subtitle), "exporter: the header subtitle is not a note")
n.ok(not inote(subtitle.replace("|", "\u2502")), "a box-drawing separator is also recognised")
n.ok(not enote(subtitle.replace("|", "\u2502")), "exporter accepts the box-drawing separator too")

# The two tools must agree, or a migrated workbook exports differently from an
# un-migrated one.
samples = [prose, "Check-in", "Room 1 - Guest 1", subtitle, "NEEDED", "STATUS",
           "GUESTS", "Check-out time is 11-Dec-2026 by 11:00, so the driver leaves then.",
           "Rooms booked", "NIRMAL", "SECOND GUEST", "short note", ""]
mismatch = [t for t in samples if inote(t) != enote(t)]
n.eq(mismatch, [], "migrate and exporter classify every sample identically",
     "mismatched: %r" % (mismatch,))
S.append(n)

# ------------------------------------------------------------- find_row/layer
f = Suite("UNIT / find_row and hotel_layout")
from openpyxl import load_workbook  # noqa: E402
wb = load_workbook(WB)
sheet = ap.hotel_sheet(wb, "Nirmal")

f.ok(sheet is not None, "hotel_sheet finds Nirmal by name")
f.eq(ap.hotel_sheet(wb, "Nowhere"), None, "an unknown hotel is None, not a crash")
f.ok(ap.find_row(sheet, "Check-in") is not None, "find_row locates Check-in")
f.ok(ap.find_row(sheet, "Total rooms") is not None, "find_row locates Total rooms")
f.eq(ap.find_row(sheet, "No Such Label"), None, "a missing label is None")
f.eq(ap.find_row(sheet, "Check-in", col="B"), None, "the label is looked for in the right column")

lay = ap.hotel_layout(sheet)
f.ok(bool(lay), "hotel_layout resolves the layout of a real sheet")
f.eq(lay["rooms"], int(sheet["B" + str(ap.find_row(sheet, "Total rooms"))].value),
     "layout room count agrees with the Total rooms cell")
# The canonical workbook has been migrated to support actual room numbers and
# three guest slots; keep these expectations aligned with the published file.
f.ok(ap.find_row(sheet, "Rooms booked") is not None,
     "the canonical workbook has a Rooms booked row")
f.ok("Room 1 - Guest 3" in [ap.clean(sheet["A%d" % r].value)
                             for r in range(1, sheet.max_row + 1)],
     "the canonical workbook has a third-guest block")

# Re-running migration on a current workbook must be idempotent.
MIG = Path("/tmp/wt/pytest/migrated.xlsx")
shutil.copy2(SRC, MIG)
mig_args = [str(REPO / "tools" / "migrate_hotels.py")]
if migrate.main is not None:
    import io
    import contextlib
    argv = sys.argv
    sys.argv = mig_args + ["--workbook", str(MIG)]
    try:
        with contextlib.redirect_stdout(io.StringIO()):
            migrate.main()
    except SystemExit:
        pass
    finally:
        sys.argv = argv
from openpyxl import load_workbook as _lw  # noqa: E402
if MIG.exists():
    mwb = _lw(MIG)
    msheet = ap.hotel_sheet(mwb, "Nirmal")
    f.eq(sum(ap.clean(msheet.cell(r, 1).value) == "Rooms booked"
              for r in range(1, msheet.max_row + 1)), 1,
         "migration does not duplicate the Rooms booked row")
    f.eq(sum(ap.clean(msheet.cell(r, 1).value) == "Room 1 - Guest 3"
              for r in range(1, msheet.max_row + 1)), 1,
         "migration does not duplicate the third-guest block")
    f.ok(ap.hotel_layout(msheet)["rooms"] == lay["rooms"],
         "migration does not change the room count")
else:
    f.ok(False, "migrate_hotels.py produced a copy", "no output at " + str(MIG))
S.append(f)

finish(S)
