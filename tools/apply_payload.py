#!/usr/bin/env python3
"""Apply web-tracker payloads to the workbook.

The payload is the JSON that sync.js's buildSyncPayload() produces (the body of
the "Wedding tracker update" email). This script:

  1. refuses to run while Excel has the workbook open (lock file check),
  2. makes a timestamped backup (unless --no-backup),
  3. writes each hotel's rooms-booked count and room numbers,
  4. writes guest names into the Nirmal/Amarai grids across three guest slots
     (full state, so clearing a name on the web also clears the cell),
  5. updates existing vendor rows by workbook row number,
  6. appends new vendors as fresh rows above TOTAL and extends the SUM ranges,
  7. saves, and optionally re-exports data.json.

Usage:
  python3 tools/apply_payload.py payload.json [--export] [--workbook PATH] [--no-backup]
  cat payload.json | python3 tools/apply_payload.py - [--export] [--workbook PATH]
  python3 tools/apply_payload.py --inbox-dir inbox [--export] [--workbook PATH] [--no-backup]

--inbox-dir DIR applies every *.json in DIR (sorted) and deletes them afterwards
  — this is what the GitHub Action uses for the "Save on cloud" pipeline.
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
from openpyxl.cell.cell import MergedCell

# Repo root is the parent of tools/. This must be parents[1], not parents[2]:
# a stale copy of the workbook from 28-Sep still sits one level further up in
# the workspace, and a default that points at it would silently discard edits.
ROOT = Path(__file__).resolve().parents[1]
XLSX = ROOT / "Wedding_Expense_Tracker_Dec2026.xlsx"
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


def hotel_sheet(wb, label):
    """Map a hotel name from the payload to its worksheet, or None."""
    for name in ("Nirmal", "Amarai"):
        if clean(label).upper() == name.upper():
            return wb[name]
    return None


def hotel_layout(sheet):
    """Locate the allocation grid on a hotel sheet.

    Returns {"hdr", "rooms", "blocks", "F"} where blocks[i] is the first row of
    guest slot i+1. Each divider bar sits directly below its block, so a block
    starts two rows after the previous block ends -- the same convention
    export_site_data.py assumes.
    """
    hdr = find_row(sheet, "Room")
    r_rooms = find_row(sheet, "Total rooms")
    if not hdr or not r_rooms:
        return None
    rooms = int(sheet[f"B{r_rooms}"].value)
    g1a = hdr + 1
    g2a = g1a + rooms + 1
    g3a = g2a + rooms + 1
    # A third-guest block exists only after tools/migrate_hotels.py has run.
    has3 = clean(sheet[f"A{g3a}"].value).startswith("Room 1 - Guest 3")
    blocks = [g1a, g2a, g3a] if has3 else [g1a, g2a]
    return {"hdr": hdr, "rooms": rooms, "blocks": blocks,
            "F": blocks[-1] + rooms}


def _sibling_generated(target: Path):
    """The `generated` stamp of the data.json sitting next to the workbook, used
    to detect a delta that was measured against a different baseline."""
    try:
        return json.load(open(target.parent / "data.json")).get("generated")
    except Exception:
        return None


# One-element holder so the delta-baseline check inside apply_payloads can read
# the workbook's current stamp without threading it through every helper.
CURRENT_GENERATED = [None]


def apply_payloads(payloads, target, do_export=False, make_backup=True):
    """Apply a list of payloads to the workbook at target. Returns a summary dict."""
    lock = target.with_name("~$" + target.name)
    if lock.exists():
        print("ABORT: the workbook is open in Excel. Save and close it, then retry.")
        sys.exit(3)

    if make_backup:
        stamp = datetime.now().strftime("%Y%m%d-%H%M%S")
        backup = target.with_name(f"{target.stem}.backup-apply-{stamp}.xlsx")
        shutil.copy2(target, backup)
        print(f"backup: {backup.name}")

    wb = load_workbook(target)
    CURRENT_GENERATED[0] = _sibling_generated(target)
    applied_g = applied_v = appended_v = applied_rb = applied_rn = 0
    skipped = []
    warnings = []

    for payload in payloads:
        # ------------------------------------------------------------ envelope
        # v2 payloads may be deltas: only the guest/room entries that differ
        # from the export the sender was looking at. Applying a delta is the
        # same work as applying a subset of a full payload, so nothing below
        # changes -- we just record what arrived and warn if the sender was
        # looking at a different export than this workbook currently is.
        mode = payload.get("mode", "full")
        stats = payload.get("stats") or {}
        if payload.get("v"):
            detail = []
            if stats.get("cellsConsidered") is not None:
                detail.append(f"{stats.get('guestsSent', 0)} of "
                              f"{stats['cellsConsidered']} cells differed")
            if stats.get("hotelsSent") is not None:
                detail.append(f"{stats['hotelsSent']} hotel(s) touched")
            print(f"payload v{payload['v']} mode={mode}"
                  + (f": {', '.join(detail)}" if detail else ""))
        base_gen = payload.get("baselineGenerated")
        if base_gen and CURRENT_GENERATED[0] and base_gen != CURRENT_GENERATED[0]:
            warnings.append(
                f"sender measured the delta against export {base_gen!r} but this "
                f"workbook is at {CURRENT_GENERATED[0]!r} — a stale tab may have "
                "sent changes measured from an older baseline")

        # ------------------------------------------------- rooms booked + nos.
        # Full state, so a blank roomNos entry clears the cell -- same contract
        # as the guest names below.
        for rb in payload.get("rooms", []):
            sheet = hotel_sheet(wb, rb.get("hotel", ""))
            if sheet is None:
                skipped.append(f"rooms: unknown hotel {rb.get('hotel')!r}")
                continue
            lay = hotel_layout(sheet)
            if not lay:
                skipped.append(f"rooms: layout not found on {sheet.title}")
                continue

            if "roomsBooked" in rb:
                r_booked = find_row(sheet, "Rooms booked")
                if not r_booked:
                    skipped.append(
                        f"rooms: no 'Rooms booked' row on {sheet.title} "
                        "(run tools/migrate_hotels.py)")
                else:
                    try:
                        booked = int(rb["roomsBooked"])
                    except (TypeError, ValueError):
                        skipped.append(f"rooms: bad roomsBooked {rb['roomsBooked']!r}")
                    else:
                        if not (0 <= booked <= lay["rooms"]):
                            skipped.append(
                                f"rooms: roomsBooked {booked} out of range "
                                f"0..{lay['rooms']} on {sheet.title}")
                        else:
                            sheet[f"B{r_booked}"] = booked
                            applied_rb += 1

            nos = rb.get("roomNos")
            if isinstance(nos, list):
                if len(nos) > lay["rooms"]:
                    skipped.append(
                        f"rooms: {len(nos)} room numbers for {lay['rooms']} rooms "
                        f"on {sheet.title}")
                else:
                    room_numbers_applied = True
                    for i, no in enumerate(nos[:lay["rooms"]]):
                        # Room numbers live in column B beside the guest-1 row.
                        cell = sheet[f"B{lay['blocks'][0] + i}"]
                        if isinstance(cell, MergedCell):
                            if clean(no):
                                skipped.append(
                                    f"rooms: room number {clean(no)!r} cannot be "
                                    f"stored in merged cell B{cell.row} on "
                                    f"{sheet.title}")
                                room_numbers_applied = False
                            continue
                        cell.value = clean(no) or None
                    if room_numbers_applied:
                        applied_rn += 1

        # ------------------------------------------------------------ guests
        for g in payload.get("guests", []):
            sheet = hotel_sheet(wb, g.get("hotel", ""))
            if sheet is None:
                skipped.append(f"guest: unknown hotel {g.get('hotel')!r}")
                continue
            lay = hotel_layout(sheet)
            if not lay:
                skipped.append(f"guest: layout not found on {sheet.title}")
                continue
            hdr, rooms = lay["hdr"], lay["rooms"]
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
            if not (1 <= room <= rooms):
                skipped.append(f"guest: room {room} out of range 1..{rooms} on {sheet.title}")
                continue
            if not (1 <= slot <= len(lay["blocks"])):
                skipped.append(
                    f"guest: slot {slot} out of range 1..{len(lay['blocks'])} on "
                    f"{sheet.title}" + (" (run tools/migrate_hotels.py for 3rd guest)"
                                        if slot == 3 else ""))
                continue
            cell_row = lay["blocks"][slot - 1] + room - 1
            sheet[f"{col}{cell_row}"] = clean(g.get("name")) or None
            applied_g += 1

        # ------------------------------------------------------------ vendors
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
    print(f"guests applied: {applied_g}, roomsBooked: {applied_rb}, "
          f"roomNos: {applied_rn}, vendors updated: {applied_v}, "
          f"vendors appended: {appended_v}")
    if skipped:
        print("skipped:")
        for s in skipped:
            print("  - " + s)
    if warnings:
        print("warnings:")
        for w in warnings:
            print("  ! " + w)

    if do_export:
        import subprocess
        subprocess.run([sys.executable, str(Path(__file__).resolve().parent / "export_site_data.py")],
                       check=True)

    return {"guests": applied_g, "roomsBooked": applied_rb, "roomNos": applied_rn,
            "vendors_updated": applied_v, "vendors_appended": appended_v,
            "skipped": skipped, "warnings": warnings}


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
    do_export = "--export" in argv
    make_backup = "--no-backup" not in argv

    if "--inbox-dir" in argv:
        i = argv.index("--inbox-dir")
        if i + 1 >= len(argv):
            print("usage: --inbox-dir DIR is required after --inbox-dir")
            sys.exit(2)
        inbox = Path(argv[i + 1])
        files = sorted(inbox.glob("*.json"))
        if not files:
            print("inbox: no payloads to apply")
            return
        payloads = [json.load(open(f)) for f in files]
        apply_payloads(payloads, target, do_export=do_export, make_backup=make_backup)
        for f in files:
            f.unlink()
            print(f"processed: {f.name}")
        return

    args = [a for a in argv if not a.startswith("--")]
    if not args:
        print("usage: apply_payload.py payload.json [--export] [--workbook PATH]  (or '-' for stdin)")
        sys.exit(2)
    payload = json.load(sys.stdin if args[0] == "-" else open(args[0]))
    apply_payloads([payload], target, do_export=do_export, make_backup=make_backup)


if __name__ == "__main__":
    main()