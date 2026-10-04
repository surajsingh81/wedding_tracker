#!/usr/bin/env python3
"""One-time migration of the hotel sheets.

Adds, per hotel:

  * a "Rooms booked" row in the BOOKING block (how many rooms are actually held,
    as opposed to "Total rooms", which is the inventory);
  * a "Room no." input in column B of every room row, for the hotel's real room
    number (101, 202, ...). Previously the label was hardcoded "Room 1..N";
  * a THIRD GUEST PER ROOM block, so a room can hold a third person;
  * GUESTS and "3rd GUESTS" summary rows -- total people per night, and how many
    of them are third guests (the ones billed as an extra).

Why rebuild instead of insert_rows: openpyxl's insert_rows moves cell values but
does NOT adjust merged ranges or formula references, and the existing sheets have
an inconsistent merge pattern (A22:B27 merged, A28:B31 not). Rebuilding from a
harvest of the old layout gives one predictable layout for both hotels and for
export_site_data.py / apply_payload.py to read.

The rebuild is idempotent: a sheet that already has a "Room 1 - Guest 3" row is
left alone.

Usage:
  python3 tools/migrate_hotels.py [--workbook PATH] [--no-backup] [--dry-run]
"""

import shutil
import sys
from copy import copy
from datetime import datetime
from pathlib import Path

from openpyxl import load_workbook
from openpyxl.utils import get_column_letter as CL

ROOT = Path(__file__).resolve().parents[1]
XLSX = ROOT / "Wedding_Expense_Tracker_Dec2026.xlsx"
HOTELS = ["Nirmal", "Amarai"]

# Scan a generous span for night columns; "Notes" and blanks are skipped later.
NIGHT_SCAN = ["C", "D", "E", "F", "G", "H", "I", "J"]

# Section bars and grid labels are not prose notes. Short form values must match
# EXACTLY -- a startswith test here used to swallow real notes such as
# "Check-out is 14-Dec-2026. 13-Dec is the last night...", which merely opens with
# a label word.
BAR_PREFIX = ("NIRMAL", "AMARAI", "SECOND GUEST", "THIRD GUEST")
BAR_EXACT = {"BOOKING", "ROOMS NEEDED PER NIGHT", "ROOM ALLOCATION GRID"}
LABEL_EXACT = {
    "Date", "Check-in", "Check-out", "Checkout time", "Rooms booked",
    "Total rooms", "Total room-nights", "TOTAL", "FILLED", "NEEDED",
    "STATUS", "GUESTS", "3rd GUESTS",
}


def is_note(t):
    if len(t) <= 40:
        return False
    # The A2 subtitle is "Check-in <date> | Check-out <date> | N rooms booked".
    # It uses an ASCII pipe, so match on that rather than the box character.
    if t.startswith("Check-in ") and ("|" in t or "│" in t):
        return False
    if t in BAR_EXACT or t in LABEL_EXACT:
        return False
    if any(t.startswith(p) for p in BAR_PREFIX):
        return False
    if t.startswith("Room "):        # "Room 1 - Guest 1"
        return False
    return True


def clean(v):
    if v is None:
        return ""
    return str(v).strip()


def find_row(ws, label, col="A"):
    for r in range(1, ws.max_row + 1):
        if clean(ws[f"{col}{r}"].value) == label:
            return r
    return None


def style_of(ws, coord):
    """Copy of a cell's style array, or None if the coordinate is unusable."""
    if not coord:
        return None
    try:
        return copy(ws[coord]._style)
    except Exception:
        return None


def short_date(full):
    """'08-Dec-2026' -> '08-Dec' (matches the existing down-column date labels)."""
    parts = str(full).split("-")
    return "-".join(parts[:2]) if len(parts) >= 2 else str(full)


# --------------------------------------------------------------------- harvest
def harvest(ws):
    L = {
        "checkIn": find_row(ws, "Check-in"),
        "checkOut": find_row(ws, "Check-out"),
        "checkoutTime": find_row(ws, "Checkout time"),
        "rooms": find_row(ws, "Total rooms"),
        "nights": find_row(ws, "Total room-nights"),
        "bar": find_row(ws, "BOOKING"),
        "needBar": find_row(ws, "ROOMS NEEDED PER NIGHT"),
        "gridBar": find_row(ws, "ROOM ALLOCATION GRID"),
        "dateHdr": find_row(ws, "Date"),
    }
    hdr = find_row(ws, "Room")
    if not hdr or not L["rooms"]:
        raise SystemExit(f"{ws.title}: could not locate the room grid layout")

    rooms = int(ws[f"B{L['rooms']}"].value)
    ncols = []
    for c in NIGHT_SCAN:
        v = clean(ws[f"{c}{hdr}"].value)
        if not v or v == "Notes":
            continue
        ncols.append(c)
    nights = [clean(ws[f"{c}{hdr}"].value) for c in ncols]

    g1a = hdr + 1
    g2a = hdr + rooms + 2          # a divider row sits between the blocks
    g2b = g2a + rooms - 1
    F = g2b + 1                    # FILLED

    def block(first):
        return [[clean(ws[f"{c}{first + i}"].value) for c in ncols] for i in range(rooms)]

    needed = []
    for c in ncols:
        v = ws[f"{c}{F + 1}"].value
        needed.append(v if isinstance(v, (int, float)) else 0)

    notes, notes_row = [], None
    for r in range(1, ws.max_row + 1):
        t = clean(ws[f"A{r}"].value)
        if is_note(t):
            notes.append((r, t))
            if notes_row is None:
                notes_row = r

    return {
        "L": L, "hdr": hdr, "rooms": rooms, "ncols": ncols, "nights": nights,
        "g1a": g1a, "g2a": g2a, "g2b": g2b, "F": F,
        "g1": block(g1a), "g2": block(g2a), "needed": needed,
        "notes": [t for _, t in notes], "notes_row": notes_row,
        "title": clean(ws["A1"].value),
        "checkIn": ws[f"B{L['checkIn']}"].value if L["checkIn"] else "",
        "checkOut": ws[f"B{L['checkOut']}"].value if L["checkOut"] else "",
        "checkoutTime": ws[f"B{L['checkoutTime']}"].value if L["checkoutTime"] else "",
        "totalRooms": ws[f"B{L['rooms']}"].value,
        "totalRoomNights": ws[f"B{L['nights']}"].value if L["nights"] else "",
    }


def capture_styles(ws, d):
    L, hdr, g1a, F = d["L"], d["hdr"], d["g1a"], d["F"]
    nr = d["notes_row"] or (d["F"] + 4)
    return {
        "title": style_of(ws, "A1"),
        "subtitle": style_of(ws, "A2"),
        "bar": style_of(ws, f"A{L['bar']}") if L["bar"] else None,
        "label": style_of(ws, f"A{L['checkIn']}") if L["checkIn"] else None,
        "valdate": style_of(ws, f"B{L['checkIn']}") if L["checkIn"] else None,
        "valnum": style_of(ws, f"B{L['rooms']}") if L["rooms"] else None,
        "colhdr": style_of(ws, f"A{L['dateHdr']}") if L["dateHdr"] else None,
        "colhdr2": style_of(ws, f"B{L['dateHdr']}") if L["dateHdr"] else None,
        "datecell": style_of(ws, f"A{L['dateHdr'] + 1}") if L["dateHdr"] else None,
        "numcell": style_of(ws, f"B{L['dateHdr'] + 1}") if L["dateHdr"] else None,
        "gridhdr": style_of(ws, f"A{hdr}"),
        "gridhdrdate": style_of(ws, f"C{hdr}"),
        "roomlabel": style_of(ws, f"A{g1a}"),
        "roominput": style_of(ws, f"C{g1a}"),
        "divider": style_of(ws, f"A{d['g2a'] - 1}"),
        "sumlabel": style_of(ws, f"A{F}"),
        "sumformula": style_of(ws, f"C{F}"),
        "needlabel": style_of(ws, f"A{F + 1}"),
        "neednum": style_of(ws, f"C{F + 1}"),
        "statuslabel": style_of(ws, f"A{F + 2}"),
        "note": style_of(ws, f"A{nr}"),
    }


# ----------------------------------------------------------------------- build
def build(ws, d, st, rooms_booked):
    last = d["ncols"][-1]
    span = f"A{last}"                      # merge target for bars and notes
    r = 1

    def put(coord, value, style):
        c = ws[coord]
        c.value = value
        if style is not None:
            c._style = copy(style)

    def bar(row, text):
        ws[f"A{row}"] = text
        if st["bar"] is not None:
            ws[f"A{row}"]._style = copy(st["bar"])
        ws.merge_cells(f"A{row}:{span}{row}")

    put("A1", d["title"], st["title"])
    put("A2", f'Check-in {clean(d["checkIn"])}  |  Check-out {clean(d["checkOut"])}'
             f'  |  {rooms_booked} of {d["rooms"]} rooms booked', st["subtitle"])

    r = 4
    bar(r, "BOOKING")
    r += 1
    def kv(label, value, style):
        nonlocal r
        put(f"A{r}", label, st["label"])
        put(f"B{r}", value, style)
        r += 1

    kv("Check-in", d["checkIn"], st["valdate"])
    kv("Check-out", d["checkOut"], st["valdate"])
    if d["checkoutTime"]:
        kv("Checkout time", d["checkoutTime"], st["valdate"])
    kv("Rooms booked", rooms_booked, st["valnum"])          # NEW
    kv("Total rooms", d["totalRooms"], st["valnum"])
    if d["totalRoomNights"] != "":
        kv("Total room-nights", d["totalRoomNights"], st["valnum"])

    # ---- rooms needed per night (down-column view, kept for the human)
    r += 1
    bar(r, "ROOMS NEEDED PER NIGHT")
    r += 1
    put(f"A{r}", "Date", st["colhdr"])
    put(f"B{r}", "Rooms", st["colhdr2"])
    r += 1
    first_need = r
    for j, night in enumerate(d["nights"]):
        put(f"A{r}", short_date(night), st["datecell"])
        put(f"B{r}", d["needed"][j], st["numcell"])
        r += 1
    put(f"A{r}", "TOTAL", st["colhdr"])
    put(f"B{r}", f"=SUM(B{first_need}:B{r - 1})", st["colhdr2"])

    # ---- room allocation grid
    r += 2
    bar(r, "ROOM ALLOCATION GRID")
    r += 1
    hdr = r
    put(f"A{hdr}", "Room", st["gridhdr"])
    put(f"B{hdr}", "Room no.", st["gridhdr"])
    for j, c in enumerate(d["ncols"]):
        put(f"{c}{hdr}", d["nights"][j], st["gridhdrdate"])
    ws[f"{CL(ord(last) - 64 + 1)}{hdr}"] = "Notes"
    r += 1

    rooms = d["rooms"]

    def write_block(values, guest_label):
        nonlocal r
        for i in range(rooms):
            put(f"A{r}", f"Room {i + 1} - {guest_label}", st["roomlabel"])
            for j, c in enumerate(d["ncols"]):
                put(f"{c}{r}", values[i][j] or None, st["roominput"])
            r += 1

    # Block starts are captured from the running row counter, never recomputed,
    # and each divider bar sits immediately below its block so the layout keeps
    # the original convention  g2a = g1b + 2  (and g3a = g2b + 2) that
    # export_site_data.py and apply_payload.py both rely on.
    g1a = r
    write_block(d["g1"], "Guest 1")
    g1b = r - 1
    bar(r, "SECOND GUEST PER ROOM  -  fill only if two people share the room. "
           "FILLED counts occupied ROOMS, not guest names.")
    r += 1
    g2a = r
    write_block(d["g2"], "Guest 2")
    g2b = r - 1
    bar(r, "THIRD GUEST PER ROOM  -  fill only if a THIRD person shares the room. "
           "These are the extra guests the hotel bills on top of the room rate.")
    r += 1
    g3a = r
    write_block([[""] * len(d["ncols"]) for _ in range(rooms)], "Guest 3")
    g3b = r - 1

    # ---- summary rows
    # write_block already left r at g3b + 1, which is exactly where the readers
    # (export/apply) look for FILLED. Assert it rather than drift silently.
    F = r
    if F != g3b + 1:
        raise SystemExit(
            f"{ws.title}: FILLED would land on r{F} but readers expect r{g3b + 1}")
    put(f"A{F}", "FILLED", st["sumlabel"])
    for c in d["ncols"]:
        ws[f"{c}{F}"] = (f'=SUMPRODUCT(--((({c}{g1a}:{c}{g1b}<>"")+({c}{g2a}:{c}{g2b}<>"")'
                         f'+({c}{g3a}:{c}{g3b}<>""))>0))')
        if st["sumformula"] is not None:
            ws[f"{c}{F}"]._style = copy(st["sumformula"])

    put(f"A{F + 1}", "NEEDED", st["needlabel"])
    for j, c in enumerate(d["ncols"]):
        put(f"{c}{F + 1}", d["needed"][j], st["neednum"])

    put(f"A{F + 2}", "STATUS", st["statuslabel"])
    for c in d["ncols"]:
        ws[f"{c}{F + 2}"] = (f'=IF({c}{F}={c}{F + 1},"OK",'
                             f'IF({c}{F}<{c}{F + 1},"need "&({c}{F + 1}-{c}{F})&" more",'
                             f'"extra "&({c}{F}-{c}{F + 1})))')

    put(f"A{F + 3}", "GUESTS", st["sumlabel"])
    for c in d["ncols"]:
        ws[f"{c}{F + 3}"] = (f'=SUMPRODUCT(--({c}{g1a}:{c}{g1b}<>""))'
                             f'+SUMPRODUCT(--({c}{g2a}:{c}{g2b}<>""))'
                             f'+SUMPRODUCT(--({c}{g3a}:{c}{g3b}<>""))')
        if st["sumformula"] is not None:
            ws[f"{c}{F + 3}"]._style = copy(st["sumformula"])

    put(f"A{F + 4}", "3rd GUESTS", st["sumlabel"])
    for c in d["ncols"]:
        ws[f"{c}{F + 4}"] = f'=SUMPRODUCT(--({c}{g3a}:{c}{g3b}<>""))'
        if st["sumformula"] is not None:
            ws[f"{c}{F + 4}"]._style = copy(st["sumformula"])

    # ---- prose notes
    r = F + 6
    for t in d["notes"]:
        put(f"A{r}", t, st["note"])
        ws.merge_cells(f"A{r}:{span}{r}")
        r += 1

    ws.column_dimensions["A"].width = 30
    ws.column_dimensions["B"].width = 11
    return {"hdr": hdr, "g1a": g1a, "g2a": g2a, "g3a": g3a, "F": F}


# ----------------------------------------------------------------------- main
def migrate(path, make_backup=True, dry_run=False):
    wb = load_workbook(path)
    report = []
    for name in HOTELS:
        if name not in wb.sheetnames:
            report.append(f"{name}: sheet missing, skipped")
            continue
        ws = wb[name]
        if find_row(ws, "Room 1 - Guest 3"):
            report.append(f"{name}: already has a Guest 3 block, skipped")
            continue
        d = harvest(ws)
        st = capture_styles(ws, d)
        idx = wb.sheetnames.index(name)
        rooms_booked = d["rooms"]
        new = wb.create_sheet(name + "___new")
        layout = build(new, d, st, rooms_booked)
        wb.remove(ws)
        new.title = name
        wb.move_sheet(new, offset=idx - wb.sheetnames.index(new.title))
        report.append(
            f"{name}: rooms={d['rooms']} nights={len(d['nights'])} "
            f"g1=r{layout['g1a']} g2=r{layout['g2a']} g3=r{layout['g3a']} "
            f"FILLED=r{layout['F']} guests_preserved="
            f"{sum(1 for row in d['g1'] + d['g2'] for v in row if v)}")
    if not dry_run:
        wb.save(path)
    for line in report:
        print("  " + line)
    return report


def main():
    argv = sys.argv[1:]
    target = XLSX
    if "--workbook" in argv:
        target = Path(argv[argv.index("--workbook") + 1])
    if "--no-backup" not in argv and not dry_run_flag(argv):
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = target.with_name(f"{target.stem}.backup-rooms-{stamp}.xlsx")
        shutil.copy2(target, backup)
        print(f"backup: {backup.name}")
    migrate(target, dry_run=dry_run_flag(argv))


def dry_run_flag(argv):
    return "--dry-run" in argv


if __name__ == "__main__":
    main()