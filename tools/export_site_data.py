#!/usr/bin/env python3
"""Read the workbook and emit data.json for the static web tracker.

Every row is located by LABEL, not by hardcoded number, so hand-edits in Excel
(inserted/deleted rows, moved headers) don't break the export.
"""

import json
import re
import unicodedata
from pathlib import Path
from openpyxl import load_workbook

ROOT = Path(__file__).resolve().parents[2]
XLSX = ROOT / "Wedding_Expense_Tracker_Dec2026.xlsx"
OUT = ROOT / "wedding-tracker-site" / "data.json"

NIGHT_COLS = ["C", "D", "E", "F", "G", "H"]


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


wb = load_workbook(XLSX)
report = []

# =============================================================== hotel sheets
hotels = []
for sheet_name, hid in (("Nirmal", "nirmal"), ("Amarai", "amarai")):
    s = wb[sheet_name]

    r_in = find_row(s, "Check-in")
    r_out = find_row(s, "Check-out")
    r_time = find_row(s, "Checkout time")
    r_rooms = find_row(s, "Total rooms")
    r_nights = find_row(s, "Total room-nights")

    rooms = int(s[f"B{r_rooms}"].value)
    HDR = find_row(s, "Room")

    # night columns = header cells C..H that are not the trailing "Notes"
    ncols = [c for c in NIGHT_COLS
             if clean(s[f"{c}{HDR}"].value) and clean(s[f"{c}{HDR}"].value) != "Notes"]
    nights = [clean(s[f"{c}{HDR}"].value) for c in ncols]

    g1a = HDR + 1
    g1b = g1a + rooms - 1
    g2a = g1b + 2          # divider bar sits between the two guest blocks
    g2b = g2a + rooms - 1
    F = g2b + 1

    needed = [num(s[f"{c}{F + 1}"].value) or 0 for c in ncols]
    grid = []
    for i in range(rooms):
        grid.append([[clean(s[f"{c}{g1a + i}"].value), clean(s[f"{c}{g2a + i}"].value)] for c in ncols])

    # long prose lines only: skip titles, subtitles, section bars and grid labels
    SKIP = ("NIRMAL", "AMARAI", "BOOKING", "ROOMS NEEDED PER NIGHT", "ROOM ALLOCATION GRID",
            "SECOND GUEST PER ROOM", "PAYMENT SUMMARY", "TOTAL", "Room", "FILLED", "NEEDED", "STATUS")
    notes = [t for t in (clean(s[f"A{r}"].value) for r in range(1, s.max_row + 1))
             if len(t) > 40 and t not in SKIP
             and not t.startswith(SKIP)
             and not (t.startswith("Check-in") and "|" in t)]

    hotels.append({
        "id": hid,
        "name": clean(s["A1"].value).split("—")[0].strip(),
        "checkIn": clean(s[f"B{r_in}"].value),
        "checkOut": clean(s[f"B{r_out}"].value),
        "checkoutTime": clean(s[f"B{r_time}"].value) if r_time else "",
        "totalRooms": rooms,
        "totalRoomNights": num(s[f"B{r_nights}"].value),
        "nights": nights,
        "needed": needed,
        "grid": grid,
        "notes": notes,
    })
    report.append(f"{sheet_name}: rooms={rooms} nights={len(nights)} hdr r{HDR} grid r{g1a}-r{g2b}")

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
    "generated": "2026-09-28",
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
