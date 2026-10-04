#!/usr/bin/env python3
"""Read the workbook and emit data.json for the static web tracker.

Every row is located by LABEL, not by hardcoded number, so hand-edits in Excel
(inserted/deleted rows, moved headers) don't break the export.
"""

import json
import re
import sys
import unicodedata
from datetime import datetime
from pathlib import Path
from openpyxl import load_workbook

# Paths are relative to this script so the same file works in the repo and in
# the GitHub Action (where the checkout root is the repo root).
SITE = Path(__file__).resolve().parent.parent
XLSX = SITE / "Wedding_Expense_Tracker_Dec2026.xlsx"
OUT = SITE / "data.json"

argv = sys.argv[1:]
if "--workbook" in argv:
    XLSX = Path(argv[argv.index("--workbook") + 1])
if "--out" in argv:
    OUT = Path(argv[argv.index("--out") + 1])

def clean(v):
    """Excel sometimes stores bidi marks (U+200E/200F) in typed text - strip them."""
    if v is None:
        return ""
    if isinstance(v, str):
        v = "".join(ch for ch in v if unicodedata.category(ch) != "Cf").strip()
    return v


def find_row(sheet, label, col="A"):
    for r in range(1, sheet.max_row + 1):
        if clean(sheet[f"{col}{r}"].value) == label:
            return r
    return None


def num(v):
    return v if isinstance(v, (int, float)) else ""


def hotel_id(name):
    ascii_name = unicodedata.normalize("NFKD", str(name))
    ascii_name = "".join(ch for ch in ascii_name if not unicodedata.category(ch).startswith("M"))
    return re.sub(r"[^a-z0-9]+", "-", ascii_name.lower()).strip("-") or "hotel"


# Prose notes only. Short labels must match EXACTLY -- a startswith test would
# swallow a real note such as "Check-out is 14-Dec-2026. 13-Dec is the last
# night...", which merely opens with a label word. Kept in step with
# migrate_hotels.is_note so both tools agree on what counts as a note.
BAR_PREFIX = ("NIRMAL", "AMARAI", "SECOND GUEST", "THIRD GUEST")
BAR_EXACT = {"BOOKING", "ROOMS NEEDED PER NIGHT", "ROOM ALLOCATION GRID"}
LABEL_EXACT = {
    "Date", "Check-in", "Check-out", "Checkout time", "Rooms booked",
    "Total rooms", "Total room-nights", "TOTAL", "FILLED", "NEEDED", "STATUS",
    "GUESTS", "3rd GUESTS",
}


def is_note(t):
    if len(t) <= 40:
        return False
    # The A2 subtitle is "Check-in <date> | Check-out <date> | N rooms booked".
    # The separator is an ASCII pipe in the shipped workbook but has been typed
    # as U+2502 elsewhere, so accept either.
    if t.startswith("Check-in ") and ("|" in t or "│" in t):
        return False
    if t in BAR_EXACT or t in LABEL_EXACT:
        return False
    if any(t.startswith(p) for p in BAR_PREFIX) or t.startswith("Room "):
        return False
    return True


wb = load_workbook(XLSX)
report = []

# =============================================================== hotel sheets
hotels = []
for s in wb.worksheets:

    r_in = find_row(s, "Check-in")
    r_out = find_row(s, "Check-out")
    r_time = find_row(s, "Checkout time")
    r_rooms = find_row(s, "Total rooms")
    r_nights = find_row(s, "Total room-nights")

    HDR = find_row(s, "Room")
    if not r_rooms or not HDR:
        continue
    rooms = int(s[f"B{r_rooms}"].value)

    # "Rooms booked" = how many rooms are actually held, as opposed to "Total
    # rooms" (the inventory). Workbooks from before the migration lack the row.
    r_booked = find_row(s, "Rooms booked")
    booked = int(s[f"B{r_booked}"].value) if r_booked else rooms

    # night columns = header cells C..H that are not the trailing "Notes"
    ncols = []
    for col in range(3, s.max_column + 1):
        value = clean(s.cell(HDR, col).value)
        if not value or value.casefold() == "notes":
            break
        ncols.append(s.cell(HDR, col).column_letter)
    nights = [clean(s[f"{c}{HDR}"].value) for c in ncols]

    g1a = HDR + 1
    g1b = g1a + rooms - 1
    g2a = g1b + 2          # divider bar sits between the guest blocks
    g2b = g2a + rooms - 1
    g3a = g2b + 2
    g3b = g3a + rooms - 1
    # the third-guest block only exists once tools/migrate_hotels.py has run, so
    # fall back to two slots for an un-migrated workbook.
    has3 = clean(s[f"A{g3a}"].value).startswith("Room 1 - Guest 3")
    F = (g3b if has3 else g2b) + 1

    needed = [num(s[f"{c}{F + 1}"].value) or 0 for c in ncols]

    # the hotel's own room number for each grid row (column B); may be blank
    room_nos = [clean(s[f"B{g1a + i}"].value) for i in range(rooms)]

    grid = []
    for i in range(rooms):
        row = []
        for c in ncols:
            cell = [clean(s[f"{c}{g1a + i}"].value), clean(s[f"{c}{g2a + i}"].value)]
            if has3:
                cell.append(clean(s[f"{c}{g3a + i}"].value))
            row.append(cell)
        grid.append(row)

    # long prose lines only: skip titles, subtitles, section bars and grid labels
    notes = [t for t in (clean(s[f"A{r}"].value) for r in range(1, s.max_row + 1))
             if is_note(t)]

    hotels.append({
        "id": hotel_id(s.title),
        "name": s.title,
        "checkIn": clean(s[f"B{r_in}"].value),
        "checkOut": clean(s[f"B{r_out}"].value),
        "checkoutTime": clean(s[f"B{r_time}"].value) if r_time else "",
        "totalRooms": rooms,
        "roomsBooked": booked,
        "roomNos": room_nos,
        "totalRoomNights": num(s[f"B{r_nights}"].value),
        "nights": nights,
        "needed": needed,
        "grid": grid,
        "notes": notes,
    })
    report.append(f"{s.title}: rooms={rooms} booked={booked} nights={len(nights)} "
                  f"hdr r{HDR} guest blocks r{g1a}/r{g2a}"
                  + (f"/r{g3a}" if has3 else " (no 3rd-guest block)") + f" FILLED r{F}")

# =================================================================== vendors
v = wb["Vendors"]
HDR = find_row(v, "Vendor / Category")
TOT = find_row(v, "TOTAL")

vendors = []
for r in range(HDR + 1, TOT):
    name = clean(v[f"A{r}"].value)
    if not name:
        continue
    link = v[f"P{r}"].hyperlink
    vendors.append({
        "row": r,
        "name": name,
        "contact": clean(v[f"B{r}"].value),
        "phone": clean(v[f"C{r}"].value),
        "whatsapp": clean(v[f"D{r}"].value),
        "email": clean(v[f"E{r}"].value),
        "address": clean(v[f"F{r}"].value),
        "event": clean(v[f"G{r}"].value),
        "eventDate": clean(v[f"H{r}"].value),
        "quoted": num(v[f"I{r}"].value),
        "paid": num(v[f"J{r}"].value),
        "paymentMode": clean(v[f"L{r}"].value),
        "ref": clean(v[f"M{r}"].value),
        "paidOn": clean(v[f"N{r}"].value),
        "notes": clean(v[f"Q{r}"].value),
        "pdf": link.target if link else "",
    })
report.append(f"Vendors: header r{HDR}, rows r{HDR+1}-r{TOT-1} ({len(vendors)} vendors), TOTAL r{TOT}")

# ====================================================== per-vendor detail tabs
details = {}
d = wb["Deeplaxmie Events"]
details["Deeplaxmie Events"] = {
    "kind": "invoice",
    "title": clean(d["A1"].value),
    "sub": clean(d["A2"].value),
    "caption": clean(d["A3"].value),
    "items": [[clean(d[f"A{r}"].value), num(d[f"B{r}"].value), num(d[f"C{r}"].value), num(d[f"D{r}"].value)]
              for r in (7, 8, 9)],
    "totals": [[clean(d[f"A{r}"].value), num(d[f"D{r}"].value)] for r in (10, 11, 12, 13, 14)],
    "terms": clean(d["A17"].value),
    "pdf": (d["A19"].hyperlink.target if d["A19"].hyperlink else ""),
}
n = wb["Nirmal's Executive"]
details["Nirmal's Executive"] = {
    "kind": "hotel",
    "title": clean(n["A1"].value),
    "sub": clean(n["A2"].value),
    "caption": clean(n["A3"].value),
    "booking": [[clean(n[f"A{r}"].value), clean(n[f"D{r}"].value)] for r in (6, 7, 8, 9)],
    "plan": [[clean(n[f"A{r}"].value), num(n[f"B{r}"].value), num(n[f"C{r}"].value)]
             for r in range(13, 19)],
    "cost": [[clean(n[f"A{r}"].value), num(n[f"D{r}"].value)] for r in (22, 23, 24)],
    "contact": [[clean(n[f"A{r}"].value), clean(n[f"D{r}"].value)] for r in (29, 30, 31)],
}
report.append("details: " + ", ".join(details))

data = {
    "generated": datetime.now().strftime("%Y-%m-%d"),
    "event": "Wedding - December 2026",
    "hotels": hotels,
    "vendors": vendors,
    "vendorDetails": details,
}
OUT.parent.mkdir(exist_ok=True)
OUT.write_text(json.dumps(data, indent=1, ensure_ascii=False))

for line in report:
    print("  " + line)
q = sum(x["quoted"] for x in vendors if isinstance(x["quoted"], (int, float)))
p = sum(x["paid"] for x in vendors if isinstance(x["paid"], (int, float)))
print(f"  money: quoted={q:,} paid={p:,} outstanding={q - p:,}")
print(f"wrote {OUT}")
