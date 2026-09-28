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

## ⚠️ Before you publish this publicly

`data.json` contains **guest names, full addresses, phone numbers and payment
amounts**. A GitHub Pages site is public to anyone with the link, and every commit
stays in the repository history forever.

Before pushing, decide how you want to handle that:

1. **Publish as-is** — fine only if you are genuinely comfortable with these
   details being public and permanent.
2. **Publish a redacted copy** — keep `data.json` out of the public repo, or strip
   the address/phone/payment fields, and share the real file privately.
3. **Add a password gate** — a static site cannot really keep a secret, because
   the page and its data download before any password check. Client-side
   obfuscation is a speed bump, not security.

If you only need people to *read* the status, option 2 is the honest one.

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
re-run the exporter and commit the result:

```bash
python3 tools/export_site_data.py
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
