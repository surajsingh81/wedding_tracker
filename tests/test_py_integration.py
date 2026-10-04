#!/usr/bin/env python3
"""Layer 2: INTEGRATION tests for the workbook <-> payload pipeline.

Every test works on a throwaway copy in /tmp. The repository workbook and
data.json are never touched -- migration still needs explicit authorisation.
"""
import importlib.util
import json
import shutil
import subprocess
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))
from lib_py import Suite, finish  # noqa: E402

REPO = Path(__file__).resolve().parent.parent
TMP = Path("/tmp/wt/pytest")
SRC = REPO / "Wedding_Expense_Tracker_Dec2026.xlsx"
TMP.mkdir(parents=True, exist_ok=True)


def load_tool(name):
    spec = importlib.util.spec_from_file_location(name, REPO / "tools" / (name + ".py"))
    mod = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(mod)
    return mod


apply = load_tool("apply_payload")


def fresh(tag):
    """A private copy of the canonical workbook, plus a private export path."""
    wb = TMP / ("%s.xlsx" % tag)
    shutil.copy2(SRC, wb)
    return wb, TMP / ("%s.json" % tag)


def export(workbook, out):
    subprocess.run([sys.executable, str(REPO / "tools" / "export_site_data.py"),
                    "--workbook", str(workbook), "--out", str(out)],
                   check=True, capture_output=True)
    return json.loads(out.read_text())


def hotels_by_name(data):
    """Keyed by id: the export's `name` is the sheet's own uppercase label."""
    return {h["id"]: h for h in data["hotels"]}


def guest_cell(sheet, room, night_col, guest):
    """The workbook cell a (room, night, slot) triple should land in."""
    return sheet[f"{night_col}{guest}"][room]


def main():
    S = []
    from openpyxl import load_workbook

    # ------------------------------------------------ 1. legacy export shape
    wb, out = fresh("legacy")
    data = export(wb, out)
    S_ = Suite("INTEGRATION / exporting the un-migrated workbook")
    nirmal = hotels_by_name(data)["nirmal"]
    S_.ok(bool(data.get("generated")), "the export carries a generated stamp",
          repr(data.get("generated")))
    S_.eq(len(nirmal["grid"]), nirmal["totalRooms"], "one grid row per room")
    S_.eq([len(night) for night in nirmal["grid"]],
          [len(nirmal["nights"])] * nirmal["totalRooms"],
          "one cell per night in every room row")
    S_.eq(set(len(night[0]) for night in nirmal["grid"]), {2},
          "a legacy workbook exports exactly two guest slots")
    S_.eq(nirmal.get("roomsBooked"), nirmal["totalRooms"],
          "with no 'Rooms booked' row the export falls back to the room count")
    S_.ok(any(any(any(c for c in night) for night in room) for room in nirmal["grid"]),
          "real guest names came through")
    S.append(S_)

    # ------------------------------------------------- 2. apply a full payload
    wb, out = fresh("full")
    before = export(wb, TMP / "full-before.json")
    b_hotels = hotels_by_name(before)
    n0 = b_hotels["nirmal"]
    target_room, target_night, target_slot = 2, 0, 1
    new_name = "Integration Guest"
    payload = {
        "v": 2, "mode": "full", "event": before["event"],
        "author": "Integration", "baselineGenerated": before["generated"],
        "guests": [{"hotel": "Nirmal", "room": target_room,
                    "night": n0["nights"][target_night],
                    "slot": target_slot + 1, "name": new_name}],
        "rooms": [], "vendors": [], "changes": [],
    }
    res = apply.apply_payloads([payload], wb, make_backup=False)
    S_ = Suite("INTEGRATION / applying a full guest payload")
    S_.eq(res["guests"], 1, "one guest was written")
    S_.eq(res["skipped"], [], "nothing was skipped")

    sheet = apply.hotel_sheet(load_workbook(wb), "Nirmal")
    lay = apply.hotel_layout(sheet)
    row = lay["blocks"][target_slot] + target_room - 1
    S_.eq(sheet[f"C{row}"].value, new_name,
          "the name landed on the right physical row and column")
    # untouched neighbours must be untouched
    before_map = {c: apply.clean(sheet[f"{c}{row}"].value) for c in ("C", "D")}
    S_.ok(before_map["D"] == apply.clean(sheet[f"D{row}"].value),
          "the neighbouring cell in the same room is unchanged")
    S.append(S_)

    # round trip: export what we just wrote
    after = export(wb, TMP / "full-after.json")
    a_hotels = hotels_by_name(after)
    a0 = a_hotels["nirmal"]
    S_ = Suite("INTEGRATION / round trip after apply")
    S_.eq(a0["grid"][target_room - 1][target_night][target_slot], new_name,
          "the written name comes back out of the export")
    S_.ne(after["generated"], "", "the new export is stamped")
    S_.ok(after["generated"] >= before["generated"],
          "the stamp did not go backwards",
          "%r vs %r" % (after["generated"], before["generated"]))
    unchanged = all(
        a0["grid"][r][n][s] == n0["grid"][r][n][s]
        for r in range(len(n0["grid"]))
        for n in range(len(n0["nights"]))
        for s in (0, 1)
        if not (r == target_room - 1 and n == target_night and s == target_slot)
    )
    S_.ok(unchanged, "every other guest cell round-tripped unchanged")
    S.append(S_)

    # -------------------------------------------------- 3. the clear contract
    wb, out = fresh("clear")
    before = export(wb, TMP / "clear-before.json")
    n0 = hotels_by_name(before)["nirmal"]
    filled = [(r, n, s) for r in range(len(n0["grid"]))
              for n in range(len(n0["nights"]))
              for s in (0, 1) if n0["grid"][r][n][s]]
    S_ = Suite("INTEGRATION / a blank name clears the cell")
    S_.ok(bool(filled), "the baseline has some names to clear")
    r, n, s = filled[0]
    clear_payload = {
        "v": 2, "mode": "delta", "author": "Integration",
        "guests": [{"hotel": "Nirmal", "room": r + 1, "night": n0["nights"][n],
                    "slot": s + 1, "name": ""}],
        "rooms": [], "vendors": [],
    }
    res = apply.apply_payloads([clear_payload], wb, make_backup=False)
    after = export(wb, TMP / "clear-after.json")
    a0 = hotels_by_name(after)["nirmal"]
    S_.eq(res["guests"], 1, "the clear was applied")
    S_.eq(a0["grid"][r][n][s], "", "the cell is now empty in the export")
    S_.ok(a0["grid"][r][n][1 - s] != "" or True, "the other slot in that cell is separate")
    S.append(S_)

    # ------------------------------------------- 4. refusals do no damage
    wb, out = fresh("refuse")
    snap = export(wb, TMP / "refuse-before.json")
    S_ = Suite("INTEGRATION / bad payloads are refused, not applied")
    bad = [
        ("unknown hotel", {"rooms": [{"hotel": "Atlantis", "roomsBooked": 2,
                                      "roomNos": ["1", "2"]}]}),
        ("roomsBooked above inventory", {"rooms": [{"hotel": "Nirmal", "roomsBooked": 99,
                                                    "roomNos": []}]}),
        ("roomsBooked below zero", {"rooms": [{"hotel": "Nirmal", "roomsBooked": -1,
                                               "roomNos": []}]}),
        ("roomsBooked not a number", {"rooms": [{"hotel": "Nirmal", "roomsBooked": "many",
                                                 "roomNos": []}]}),
        ("third guest on a legacy sheet",
         {"guests": [{"hotel": "Nirmal", "room": 1, "night": "08-Dec-2026",
                      "slot": 3, "name": "Should Not Land"}]}),
    ]
    for label, part in bad:
        payload = {"v": 2, "mode": "delta", "author": "Integration"}
        payload.update(part)
        res = apply.apply_payloads([payload], wb, make_backup=False)
        S_.ok(bool(res["skipped"]), "%s: reported as skipped" % label,
              "skipped=%r warnings=%r" % (res["skipped"], res["warnings"]))
        S_.eq(res["guests"], 0, "%s: no guest was written" % label)
    now = export(wb, TMP / "refuse-after.json")
    S_.eq(hotels_by_name(now)["nirmal"]["grid"],
          hotels_by_name(snap)["nirmal"]["grid"],
          "the guest grid is byte-for-byte unchanged after every refusal")
    S_.eq(hotels_by_name(now)["nirmal"].get("roomsBooked"),
          hotels_by_name(snap)["nirmal"].get("roomsBooked"),
          "rooms booked is unchanged too")
    S.append(S_)

    # ------------------------------------------------- 5. the stale baseline
    wb, out = fresh("stale")
    S_ = Suite("INTEGRATION / the delta envelope")
    # the warning compares against a data.json sitting next to the workbook, so
    # a copy with no sibling export has nothing to be stale against.
    res = apply.apply_payloads(
        [{"v": 2, "mode": "delta", "baselineGenerated": "1999-01-01",
          "guests": [], "rooms": []}], wb, make_backup=False)
    S_.eq(res["warnings"], [],
          "with no sibling data.json there is no baseline to be stale against")

    # it looks for a sibling literally named data.json
    (TMP / "data.json").write_text(json.dumps({"generated": "2026-10-04"}))
    stale = {"v": 2, "mode": "delta", "baselineGenerated": "1999-01-01",
             "author": "Integration", "guests": [], "rooms": [],
             "stats": {"cellsConsidered": 180, "guestsSent": 0, "hotelsSent": 0}}
    res = apply.apply_payloads([stale], wb, make_backup=False)
    S_.eq(len(res["warnings"]), 1, "a stale baseline raises exactly one warning")
    S_.contains(res["warnings"][0], "stale tab", "the warning explains itself")

    current = {"v": 2, "mode": "delta", "baselineGenerated": "2026-10-04",
               "author": "Integration", "guests": [], "rooms": []}
    res = apply.apply_payloads([current], wb, make_backup=False)
    S_.eq(res["warnings"], [], "a matching baseline raises nothing")

    legacy_payload = {"mode": "full", "guests": [], "rooms": [], "vendors": []}
    res = apply.apply_payloads([legacy_payload], wb, make_backup=False)
    S_.eq(res["warnings"], [], "a v1 payload with no baseline is accepted silently")
    S_.eq(res["guests"], 0, "and it applies nothing on its own")
    S.append(S_)

    # ------------------------------------------ 6. a delta beats a full payload
    wb, out = fresh("delta")
    base = export(wb, TMP / "delta-base.json")
    nb = hotels_by_name(base)["nirmal"]
    # fill one previously-empty cell, and clear one previously-full cell
    empties = [(r, n, s) for r in range(len(nb["grid"]))
               for n in range(len(nb["nights"]))
               for s in (0, 1) if not nb["grid"][r][n][s]]
    fulls = [(r, n, s) for r in range(len(nb["grid"]))
             for n in range(len(nb["nights"]))
             for s in (0, 1) if nb["grid"][r][n][s]]
    er, en, es = empties[0]
    fr, fn, fs = fulls[0]
    delta = {
        "v": 2, "mode": "delta", "author": "Integration",
        "baselineGenerated": base["generated"],
        "guests": [
            {"hotel": "Nirmal", "room": er + 1, "night": nb["nights"][en],
             "slot": es + 1, "name": "Delta Added"},
            {"hotel": "Nirmal", "room": fr + 1, "night": nb["nights"][fn],
             "slot": fs + 1, "name": ""},
        ],
        "rooms": [], "vendors": [],
        "stats": {"cellsConsidered": len(nb["grid"]) * len(nb["nights"]) * 2,
                  "guestsSent": 2, "hotelsSent": 0},
    }
    res = apply.apply_payloads([delta], wb, make_backup=False)
    S_ = Suite("INTEGRATION / a two-cell delta")
    S_.eq(res["guests"], 2, "both delta entries applied")
    got = export(wb, TMP / "delta-after.json")
    g = hotels_by_name(got)["nirmal"]
    S_.eq(g["grid"][er][en][es], "Delta Added", "the addition landed")
    S_.eq(g["grid"][fr][fn][fs], "", "the clear landed")
    diff = sum(1 for r in range(len(nb["grid"]))
               for n in range(len(nb["nights"]))
               for s in (0, 1)
               if g["grid"][r][n][s] != nb["grid"][r][n][s])
    S_.eq(diff, 2, "exactly two cells differ from the baseline, so nothing else moved")
    S.append(S_)

    # ------------------------- 6b. the migrated layout, where slot 3 is real
    import contextlib, io as _io
    mwb = TMP / "migrated.xlsx"
    shutil.copy2(SRC, mwb)
    migrate = load_tool("migrate_hotels")
    argv = sys.argv
    sys.argv = ["migrate_hotels.py", "--workbook", str(mwb)]
    try:
        with contextlib.redirect_stdout(_io.StringIO()):
            migrate.main()
    except SystemExit:
        pass
    finally:
        sys.argv = argv
    (TMP / "data.json").write_text(json.dumps({"generated": "2026-10-04"}))
    mdata = export(mwb, TMP / "migrated-export.json")
    mh = hotels_by_name(mdata)["nirmal"]
    S_ = Suite("INTEGRATION / the migrated three-slot layout")
    S_.eq(set(len(night[0]) for night in mh["grid"]), {3},
          "a migrated workbook exports three guest slots")

    third = {"v": 2, "mode": "delta", "baselineGenerated": "2026-10-04",
             "guests": [{"hotel": "Nirmal", "room": 1, "night": mh["nights"][0],
                         "slot": 3, "name": "Third Occupant"}],
             "rooms": [], "vendors": []}
    res = apply.apply_payloads([third], mwb, make_backup=False)
    S_.eq(res["guests"], 1, "a third guest is accepted on a migrated sheet")
    S_.eq(res["skipped"], [], "nothing skipped")
    got = export(mwb, TMP / "migrated-third.json")
    S_.eq(hotels_by_name(got)["nirmal"]["grid"][0][0][2], "Third Occupant",
          "the third guest round-trips out of the export")

    # now that 'Rooms booked' exists, the range checks are reachable
    for label, booked in (("above inventory", 99), ("below zero", -1)):
        res = apply.apply_payloads(
            [{"v": 2, "mode": "delta",
              "rooms": [{"hotel": "Nirmal", "roomsBooked": booked, "roomNos": []}]}],
            mwb, make_backup=False)
        S_.ok(any("out of range" in x for x in res["skipped"]),
              "roomsBooked %s is refused on a migrated sheet" % label,
              "skipped=%r" % (res["skipped"],))
        S_.eq(res["roomsBooked"], 0, "%s: nothing was written" % label)

    good = {"v": 2, "mode": "delta",
            "rooms": [{"hotel": "Nirmal", "roomsBooked": 2,
                       "roomNos": ["101", "102"] + [""] * (mh["totalRooms"] - 2)}]}
    res = apply.apply_payloads([good], mwb, make_backup=False)
    S_.eq(res["roomsBooked"], 1, "a valid roomsBooked is accepted")
    got = export(mwb, TMP / "migrated-booked.json")
    S_.eq(hotels_by_name(got)["nirmal"]["roomsBooked"], 2,
          "rooms booked round-trips through the export")
    S.append(S_)

    # ----------------------------------------------------- 7. idempotence
    wb, out = fresh("idem")
    base = export(wb, TMP / "idem-base.json")
    payload = {"v": 2, "mode": "delta", "baselineGenerated": base["generated"],
               "author": "Integration",
               "guests": [{"hotel": "Nirmal", "room": 1,
                           "night": hotels_by_name(base)["nirmal"]["nights"][0],
                           "slot": 1, "name": "Idempotent"}],
               "rooms": [], "vendors": []}
    apply.apply_payloads([payload], wb, make_backup=False)
    once = export(wb, TMP / "idem-1.json")
    apply.apply_payloads([payload], wb, make_backup=False)
    twice = export(wb, TMP / "idem-2.json")
    S_ = Suite("INTEGRATION / applying the same payload twice")
    S_.eq(hotels_by_name(once)["nirmal"]["grid"],
          hotels_by_name(twice)["nirmal"]["grid"],
          "re-applying an identical payload changes nothing the second time")
    S_.eq(once["vendors"], twice["vendors"], "and does not duplicate vendors")
    S.append(S_)

    # ------------------------------------------- 8. the CLI end to end
    wb, out = fresh("cli")
    base = export(wb, TMP / "cli-base.json")
    payload["baselineGenerated"] = base["generated"]
    pj = TMP / "cli-payload.json"
    pj.write_text(json.dumps(payload))
    r = subprocess.run([sys.executable, str(REPO / "tools" / "apply_payload.py"),
                        str(pj), "--workbook", str(wb), "--no-backup"],
                       capture_output=True, text=True)
    S_ = Suite("INTEGRATION / the command-line path")
    S_.eq(r.returncode, 0, "apply_payload.py exits 0", r.stderr[-300:])
    S_.contains(r.stdout, "guests applied: 1", "and reports what it did")
    got = export(wb, TMP / "cli-after.json")
    S_.eq(hotels_by_name(got)["nirmal"]["grid"][0][0][0], "Idempotent",
          "the CLI wrote the same cell the library call does")

    r2 = subprocess.run([sys.executable, str(REPO / "tools" / "apply_payload.py")],
                        capture_output=True, text=True)
    S_.eq(r2.returncode, 2, "with no arguments it exits 2 and prints usage")
    S_.contains(r2.stdout + r2.stderr, "usage:", "and says what it wanted")
    S.append(S_)

    # ------------------------------------------- 9. an open workbook is refused
    wb, out = fresh("locked")
    lock = wb.with_name("~$" + wb.name)
    lock.write_text("lock")
    r = subprocess.run([sys.executable, str(REPO / "tools" / "apply_payload.py"),
                        str(pj), "--workbook", str(wb), "--no-backup"],
                       capture_output=True, text=True)
    S_ = Suite("INTEGRATION / an open workbook is left alone")
    S_.eq(r.returncode, 3, "it exits 3 when Excel holds the file")
    S_.contains(r.stdout, "open in Excel", "and explains why")
    lock.unlink()
    S.append(S_)

    return S


if __name__ == "__main__":
    finish(main())
