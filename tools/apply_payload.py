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
from openpyxl.utils import get_column_letter

# Repo root is the parent of tools/. This must be parents[1], not parents[2]:
# a stale copy of the workbook from 28-Sep still sits one level further up in
# the workspace, and a default that points at it would silently discard edits.
ROOT = Path(__file__).resolve().parents[1]
XLSX = ROOT / "Wedding_Expense_Tracker_Dec2026.xlsx"
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
    target = clean(label).casefold()
    return next((sheet for sheet in wb.worksheets
                 if sheet.title.casefold() == target), None)


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


def create_hotel_sheet(wb, details):
    """Create an Excel hotel sheet using the workbook's existing visual styles."""
    name = clean(details.get("hotel"))
    nights = details.get("nights")
    needed = details.get("needed")
    try:
        rooms = int(details.get("totalRooms"))
    except (TypeError, ValueError):
        return None
    if (not name or len(name) > 31 or any(c in name for c in r'\/:*?[]')
            or name.casefold() in {sheet.title.casefold() for sheet in wb.worksheets}
            or not 1 <= rooms <= 500 or not isinstance(nights, list)
            or not 1 <= len(nights) <= 90 or not isinstance(needed, list)
            or len(needed) != len(nights)):
        return None
    try:
        counts = [int(value) for value in needed]
    except (TypeError, ValueError):
        return None
    if any(count < 0 or count > rooms for count in counts):
        return None
    if any(not isinstance(date, str) or not date for date in nights):
        return None

    template = wb["Nirmal"] if "Nirmal" in wb.sheetnames else wb.active
    style_cells = {
        "title": "A1", "subtitle": "A2", "bar": "A4", "label": "A5",
        "value": "B5", "header": "A11", "header2": "B11", "date": "A12",
        "number": "B12", "gridbar": "A20", "gridhead": "A21",
        "griddate": "C21", "roomlabel": "A22", "roominput": "C22",
        "summary": "A43", "formula": "C43", "needlabel": "A44",
        "neednumber": "C44", "status": "A45",
    }
    styles = {key: copy(template[coord]._style) for key, coord in style_cells.items()}
    ws = wb.copy_worksheet(template)
    ws.title = name
    for merged in list(ws.merged_cells.ranges):
        ws.unmerge_cells(str(merged))
    for row in ws.iter_rows():
        for cell in row:
            cell.value = None
            cell._style = None
            cell.hyperlink = None
            cell.comment = None
    ws.sheet_view.showGridLines = False

    def put(row, col, value, style=None):
        cell = ws.cell(row, col, value)
        if style:
            cell._style = copy(style)
        return cell

    last_col = 2 + len(nights)
    last_letter = get_column_letter(last_col)

    def bar(row, text):
        put(row, 1, text, styles["bar"])
        ws.merge_cells(start_row=row, start_column=1,
                       end_row=row, end_column=last_col)

    put(1, 1, f"{name.upper()} — ROOM PLAN BY NIGHT", styles["title"])
    ws.merge_cells(start_row=1, start_column=1, end_row=1, end_column=last_col)
    put(2, 1, f"Check-in {clean(details.get('checkIn'))}  |  "
        f"Check-out {clean(details.get('checkOut'))}  |  {rooms} rooms available",
        styles["subtitle"])
    ws.merge_cells(start_row=2, start_column=1, end_row=2, end_column=last_col)

    bar(4, "BOOKING")
    metadata = [
        ("Check-in", details.get("checkIn", "")),
        ("Check-out", details.get("checkOut", "")),
        ("Rooms booked", max(counts, default=0)),
        ("Total rooms", rooms),
        ("Total room-nights", sum(counts)),
    ]
    for row, (label, value) in enumerate(metadata, 5):
        put(row, 1, label, styles["label"])
        put(row, 2, value, styles["value"])

    bar(11, "ROOMS NEEDED PER NIGHT")
    put(12, 1, "Date", styles["header"])
    put(12, 2, "Rooms", styles["header2"])
    for index, (date, count) in enumerate(zip(nights, counts), 13):
        put(index, 1, date[:6], styles["date"])
        put(index, 2, count, styles["number"])
    total_row = 13 + len(nights)
    put(total_row, 1, "TOTAL", styles["header"])
    put(total_row, 2, f"=SUM(B13:B{total_row - 1})", styles["header2"])

    grid_bar = total_row + 2
    bar(grid_bar, "ROOM ALLOCATION GRID")
    hdr = grid_bar + 1
    put(hdr, 1, "Room", styles["gridhead"])
    put(hdr, 2, "Room no.", styles["gridhead"])
    for index, date in enumerate(nights, 3):
        put(hdr, index, date, styles["griddate"])
    put(hdr, last_col + 1, "Notes", styles["gridhead"])

    g1a = hdr + 1
    g2a = g1a + rooms + 1
    g3a = g2a + rooms + 1
    for slot, first in enumerate((g1a, g2a, g3a), 1):
        for room in range(rooms):
            row = first + room
            put(row, 1, f"Room {room + 1} - Guest {slot}", styles["roomlabel"])
            if slot == 1:
                room_nos = details.get("roomNos") or []
                put(row, 2, clean(room_nos[room]) if room < len(room_nos) else "",
                    styles["roomlabel"])
            for col in range(3, last_col + 1):
                put(row, col, None, styles["roominput"])
        if slot < 3:
            divider_row = first + rooms
            title = ("SECOND GUEST PER ROOM" if slot == 1
                     else "THIRD GUEST PER ROOM")
            bar(divider_row, title)

    filled_row = g3a + rooms
    needed_row = filled_row + 1
    status_row = filled_row + 2
    guest_row = filled_row + 3
    third_row = filled_row + 4
    for row, label, style in (
        (filled_row, "FILLED", styles["summary"]),
        (needed_row, "NEEDED", styles["needlabel"]),
        (status_row, "STATUS", styles["status"]),
        (guest_row, "GUESTS", styles["summary"]),
        (third_row, "3rd GUESTS", styles["summary"]),
    ):
        put(row, 1, label, style)
    for index, count in enumerate(counts, 3):
        col = get_column_letter(index)
        put(filled_row, index,
            f'=SUMPRODUCT(--(((%s%d:%s%d<>"")+(%s%d:%s%d<>"")+(%s%d:%s%d<>""))>0))'
            % (col, g1a, col, g1a + rooms - 1,
               col, g2a, col, g2a + rooms - 1,
               col, g3a, col, g3a + rooms - 1), styles["formula"])
        put(needed_row, index, count, styles["neednumber"])
        put(status_row, index,
            f'=IF({col}{filled_row}={col}{needed_row},'
            f'IF({col}{needed_row}=0,"No rooms pre-booked","Guest details complete"),'
            f'IF({col}{filled_row}<{col}{needed_row},'
            f'({col}{needed_row}-{col}{filled_row})&" pre-booked room(s) missing guest details",'
            f'({col}{filled_row}-{col}{needed_row})&" room(s) beyond pre-booked count with guest details"))')
        put(guest_row, index,
            f'=COUNTIF({col}{g1a}:{col}{g1a + rooms - 1},"<>")'
            f'+COUNTIF({col}{g2a}:{col}{g2a + rooms - 1},"<>")'
            f'+COUNTIF({col}{g3a}:{col}{g3a + rooms - 1},"<>")', styles["formula"])
        put(third_row, index,
            f'=COUNTIF({col}{g3a}:{col}{g3a + rooms - 1},"<>")', styles["formula"])

    ws.column_dimensions["A"].width = 30
    ws.column_dimensions["B"].width = 12
    for col in range(3, last_col + 2):
        ws.column_dimensions[get_column_letter(col)].width = 18
    return ws


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
                sheet = create_hotel_sheet(wb, rb)
                if sheet is None:
                    skipped.append(
                        f"rooms: unknown hotel {rb.get('hotel')!r}; "
                        "new hotel details are invalid or incomplete")
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

            needed = rb.get("needed")
            nights = rb.get("nights")
            if isinstance(needed, list) and isinstance(nights, list):
                header_row = lay["hdr"]
                night_columns = {}
                for col_index in range(3, sheet.max_column + 1):
                    date = clean(sheet.cell(header_row, col_index).value)
                    if not date or date.casefold() == "notes":
                        break
                    night_columns[date] = col_index
                needed_row = find_row(sheet, "NEEDED")
                if (needed_row is None or len(needed) != len(nights)
                        or any(date not in night_columns for date in nights)):
                    skipped.append(
                        f"rooms: nightly pre-booked counts do not match dates on {sheet.title}")
                else:
                    try:
                        counts = [int(value) for value in needed]
                    except (TypeError, ValueError):
                        skipped.append(f"rooms: invalid nightly pre-booked counts on {sheet.title}")
                    else:
                        if any(count < 0 or count > lay["rooms"] for count in counts):
                            skipped.append(
                                f"rooms: nightly pre-booked count outside 0..{lay['rooms']} "
                                f"on {sheet.title}")
                        else:
                            for date, count in zip(nights, counts):
                                col_index = night_columns[date]
                                sheet.cell(needed_row, col_index).value = count
                                room_rows = find_row(sheet, "ROOMS NEEDED PER NIGHT")
                                if room_rows:
                                    first_date_row = room_rows + 2
                                    short_date = date[:6]
                                    for row_index in range(first_date_row, sheet.max_row + 1):
                                        if clean(sheet.cell(row_index, 1).value) == short_date:
                                            sheet.cell(row_index, 2).value = count
                                            break
                                status_row = find_row(sheet, "STATUS")
                                filled_row = find_row(sheet, "FILLED")
                                if status_row and filled_row:
                                    col = get_column_letter(col_index)
                                    sheet.cell(status_row, col_index).value = (
                                        f'=IF({col}{filled_row}={col}{needed_row},'
                                        f'IF({col}{needed_row}=0,"No rooms pre-booked",'
                                        f'"Guest details complete"),'
                                        f'IF({col}{filled_row}<{col}{needed_row},'
                                        f'({col}{needed_row}-{col}{filled_row})&'
                                        f'" pre-booked room(s) missing guest details",'
                                        f'({col}{filled_row}-{col}{needed_row})&'
                                        f'" room(s) beyond pre-booked count with guest details"))')

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
            col = next((get_column_letter(col_index)
                        for col_index in range(3, sheet.max_column + 1)
                        if clean(sheet.cell(hdr, col_index).value)
                        == clean(g.get("night"))), None)
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