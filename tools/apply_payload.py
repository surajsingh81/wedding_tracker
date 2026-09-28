#!/usr/bin/env python3
"""Apply a web-tracker payload to the workbook.

The payload is the JSON that sync.js's buildSyncPayload() produces (the body of
the "Wedding tracker update" email). This script:

  1. refuses to run while Excel has the workbook open (lock file check),
  2. makes a timestamped backup,
  3. writes guest names into the Nirmal/Amarai grids (full state, so clearing a
     name on the web also clears the cell),
  4. updates existing vendor rows by workbook row number,
  5. appends new vendors as fresh rows above TOTAL and extends the SUM ranges,
  6. saves, and optionally re-exports data.json.

Usage:
  python3 tools/apply_payload.py payload.json [--export] [--workbook PATH]
  cat payload.json | python3 tools/apply_payload.py - [--export] [--workbook PATH]

--workbook PATH applies to a copy instead of the real workbook (for tests);
the lock check, backup, and save all follow PATH.
"""

import json
import re
import shutil
import sys
from copy import copy
from datetime import datetime
from pathlib import Path

from openpyxl import load_workbook

ROOT = Path(__file__).resolve().parents[2]
XLSX = ROOT / "Wedding_Expense_Tracker_Dec2026.xlsx"
LOCK = ROOT / "~$Wedding_Expense_Tracker_Dec2026.xlsx"
NIGHT_COLS = ["C", "D", "E", "F", "G", "H"]
VENDOR_COLS = {  # payload field -> workbook column
    "contact": "B", "phone": "C", "whatsapp": "D", "address": "F",
    "event": "G", "eventDate": "H", "quoted": "I", "paid": "J",
    "paymentMode": "L", "ref": "M", "paidOn": "N", "notes": "Q",
}


def clean(v):
    if v is None:
        return ""
    return str(v).strip()


def find_row(sheet, label, col="A"):
    for r in range(1, sheet.max_row + 1):
        if clean(sheet[f"{col}{r}"].value) == label:
            return r
    return None


def num_or_blank(v):
    if v is None or v == "":
        return None
    try:
        return float(v)
    except (TypeError, ValueError):
        return None


def main():
    argv = sys.argv[1:]
    target = XLSX
    if "--workbook" in argv:
        i = argv.index("--workbook")
        if i + 1 >= len(argv):
            print("usage: --workbook PATH is required after --workbook")
            sys.exit(2)
        target = Path(argv[i + 1])
        del argv[i:i + 2]
    args = [a for a in argv if not a.startswith("--")]
    do_export = "--export" in argv

    if not args:
        print("usage: apply_payload.py payload.json [--export] [--workbook PATH]  (or '-' for stdin)")
        sys.exit(2)
    payload = json.load(sys.stdin if args[0] == "-" else open(args[0]))

    lock = target.with_name("~$" + target.name)
    if lock.exists():
        print("ABORT: the workbook is open in Excel. Save and close it, then retry.")
        sys.exit(3)

    stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
    backup = target.with_name(f"{target.stem}.backup-apply-{stamp}.xlsx")
    shutil.copy2(target, backup)
    print(f"backup: {backup.name}")

    wb = load_workbook(target)
    applied_g = applied_v = appended_v = 0
    skipped = []

    # ---------------------------------------------------------------- guests
    for g in payload.get("guests", []):
        sheet = None
        for name in ("Nirmal", "Amarai"):
            if g.get("hotel", "").strip().upper() == name.upper():
                sheet = wb[name]
                break
        if sheet is None:
            skipped.append(f"guest: unknown hotel {g.get('hotel')!r}")
            continue
        hdr = find_row(sheet, "Room")
        r_rooms = find_row(sheet, "Total rooms")
        if not hdr or not r_rooms:
            skipped.append(f"guest: layout not found on {sheet.title}")
            continue
        rooms = int(sheet[f"B{r_rooms}"].value)
        g1a, g2a = hdr + 1, hdr + rooms + 2
        col = next((c for c in NIGHT_COLS
                    if clean(sheet[f"{c}{hdr}"].value) == clean(g.get("night"))), None)
        if col is None:
            skipped.append(f"guest: night {g.get('night')!r} not found on {sheet.title}")
            continue
        try:
            room, slot = int(g["room"]), int(g["slot"])
        except (KeyError, TypeError, ValueError):
            skipped.append(f"guest: bad room/slot {g.get('room')}/{g.get('slot')}")
            continue
        if not (1 <= room <= rooms) or slot not in (1, 2):
            skipped.append(f"guest: out of range {sheet.title} room {room} slot {slot}")
            continue
        target = g1a + room - 1 if slot == 1 else g2a + room - 1
        sheet[f"{col}{target}"] = clean(g.get("name")) or None
        applied_g += 1

    # ---------------------------------------------------------------- vendors
    v = wb["Vendors"]
    hdr = find_row(v, "Vendor / Category")
    tot = find_row(v, "TOTAL")
    if not hdr or not tot:
        print("ABORT: Vendors layout (header/TOTAL) not found")
        sys.exit(4)

    for vd in payload.get("vendors", []):
        name = clean(vd.get("name"))
        if not name:
            skipped.append("vendor: empty name")
            continue
        row = vd.get("row")
        if vd.get("isNew") or not isinstance(row, int) or not (hdr < row < tot):
            # ---- append a fresh row just above TOTAL
            v.insert_rows(tot)
            r = tot
            for c in "ABCDEFGHIJKLMNOPQ":          # carry the table style down
                v[f"{c}{r}"]._style = copy(v[f"{c}{r - 1}"]._style)
            v[f"A{r}"] = name
            for f, c in VENDOR_COLS.items():
                v[f"{c}{r}"] = num_or_blank(vd.get(f)) if f in ("quoted", "paid") else clean(vd.get(f))
            v[f"K{r}"] = f'=IF(I{r}="","",I{r}-IF(J{r}="",0,J{r}))'
            v[f"O{r}"] = f'=IF(I{r}="","Not Quoted",IF(K{r}<=0,"Paid","Pending"))'
            for c in "IJK":                        # extend TOTAL sums to include the new row
                cell = v[f"{c}{r + 1}"]
                if isinstance(cell.value, str) and cell.value.startswith("=SUM("):
                    cell.value = re.sub(r"([A-Z]+)(\d+):([A-Z]+)(\d+)",
                                        lambda m: f"{m.group(1)}{m.group(2)}:{m.group(3)}{int(m.group(4)) + 1}",
                                        cell.value)
            appended_v += 1
        else:
            v[f"A{row}"] = name
            for f, c in VENDOR_COLS.items():
                v[f"{c}{row}"] = num_or_blank(vd.get(f)) if f in ("quoted", "paid") else clean(vd.get(f))
            applied_v += 1

    wb.save(target)
    print(f"guests applied: {applied_g}, vendors updated: {applied_v}, vendors appended: {appended_v}")
    if skipped:
        print("skipped:")
        for s in skipped:
            print("  - " + s)

    if do_export:
        import subprocess
        subprocess.run([sys.executable, str(ROOT / "wedding-tracker-site" / "tools" / "export_site_data.py")], check=True)


if __name__ == "__main__":
    main()