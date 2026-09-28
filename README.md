# Wedding Tracker — December 2026

A small static web page that shows the same figures as
`Wedding_Expense_Tracker_Dec2026.xlsx`, and lets people fill in guest names and
payments without needing Excel.

No build step, no dependencies, no server. It is plain `index.html` + `styles.css`
+ `app.js` + `data.json`, so it runs straight from GitHub Pages.

## Files

| File | What it is |
|---|---|
| `index.html` | Page structure and the four tabs |
| `styles.css` | All styling, including dark mode and print |
| `app.js` | Rendering, editing, and the stats |
| `data.json` | **The data**, exported from the workbook |
| `Vendor PDFs/` | The invoice PDF the page links to |

## ⚠️ Public vs private data

The deployed site is **public**. The repo therefore contains `data.public.json` —
a redacted copy that keeps the room grids, guest names and hotel notes (the page
needs them) but strips vendor phones, WhatsApp, emails, addresses, payment
amounts, UTRs, notes and the invoice detail.

The **full** export is `data.json`, which is gitignored and never pushed. It is
generated locally by the exporter and used for the Excel sync.

- `tools/export_site_data.py` → writes the full `data.json` (local only).
- `tools/make_public_data.py` → derives `data.public.json` from it (committed).
- `app.js` loads `data.public.json` when `PUBLIC_MODE` is true (deployed) and
  `data.json` when false (local full preview).

If you ever want the full data public, delete the redaction and push `data.json`
— but remember it is permanent once pushed.

## How edits work

Everything you type is saved in this browser as you go (`localStorage`) and stays
on this device. The toolbar has three buttons:

- **Send to Excel** — posts your entries to a small relay so they can be carried
  into the spreadsheet (see below).
- **Print** — prints the current view (handy for the front-desk room grid).
- **Reset** — discards your entries on this device and reloads the last Excel export.

There is deliberately **no Export/Import**: the page is not meant to move data
around by hand. If several people must edit the *same* shared copy, the relay
below is the way to do it.

## Getting entries into Excel

A static page cannot write to a local `.xlsx` file, and GitHub Pages is
read-only. So "Send to Excel" POSTs a JSON payload to a tiny endpoint, and that
endpoint forwards it to the workbook. Two supported ways:

1. **Email relay (recommended, matches "one email")** — point the page at a form
   service (Formspree, Web3Forms, EmailJS) or a Google Apps Script web app that
   emails the payload to your inbox. Then a scheduled OpenWork Automation reads
   that email, parses the JSON, and patches
   `Wedding_Expense_Tracker_Dec2026.xlsx` (with a timestamped backup first).
2. **Google Sheets bridge** — the endpoint appends the payload to a Google Sheet;
   the same Automation reads the sheet and patches the workbook.

To switch sending on, put the endpoint URL in `sync-config.js`:

```js
window.SYNC_ENDPOINT = "https://your-relay.example/accept";
window.SYNC_EMAIL   = "you@example.com";
```

The payload shape is documented in `sync.js` (`buildSyncPayload()`): a flat list
of guest entries (hotel, room, night, slot, name) plus the full vendor list, with
`row: null` / `isNew: true` marking vendors that should be appended as new rows.

## Refreshing from the workbook

`data.json` is generated from the Excel file, so after changing the spreadsheet
re-run the exporter and the public copy, then commit the result:

```bash
python3 tools/export_site_data.py     # full data.json (local only)
python3 tools/make_public_data.py     # redacted data.public.json (committed)
git add data.public.json && git commit -m "refresh from workbook" && git push
```

It reads the workbook by **label** (`Check-in`, `Total rooms`, `Vendor / Category`,
`TOTAL`), not by row number, so inserting or deleting rows in Excel will not
break it.

## Conventions carried over from the spreadsheet

- **Two guests per room.** Each room has a Guest 1 and a Guest 2 slot. A room
  with two people still counts as **one room** against the required number.
- **One row per vendor.** A single invoice covering several services stays in one
  row and one total — never split across several rows.
- **Invoice detail is reference only.** Vendor detail sheets (invoice
  itemisation, hotel cost breakdown) are shown separately and are never added to
  the totals a second time.
