#!/usr/bin/env python3
"""Derive the PUBLIC data.public.json from the full data.json.

The public copy keeps everything the page needs to work (room grids, guest
names, hotel notes, vendor names/events) but strips personal and financial
detail: vendor phones, WhatsApp, emails, addresses, payment amounts, UTRs,
payment modes/dates, notes and the invoice PDF. The Invoices tab is omitted
entirely on the public page.

Run after every export:  python3 tools/make_public_data.py
"""

import json
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
FULL = ROOT / "wedding-tracker-site" / "data.json"
PUB = ROOT / "wedding-tracker-site" / "data.public.json"

STRIP = {"phone", "whatsapp", "email", "address", "quoted", "paid",
         "paymentMode", "ref", "paidOn", "notes", "pdf"}

data = json.loads(FULL.read_text())
public = {
    "generated": data["generated"],
    "event": data["event"],
    "hotels": data["hotels"],                      # grids + guest names stay
    "vendors": [
        {k: ("" if k in STRIP else v) for k, v in v.items()}
        for v in data["vendors"]
    ],
    "vendorDetails": {},                           # invoice/hotel detail is private
}
PUB.write_text(json.dumps(public, indent=1, ensure_ascii=False))
print(f"wrote {PUB} ({len(public['vendors'])} vendors, details stripped)")