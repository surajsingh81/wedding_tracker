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

Everything is saved in the visitor's own browser (`localStorage`). Nothing is
uploaded anywhere — there is no backend. So:

- Guest names and payment edits stay **on that device**.
- **Export** downloads a JSON snapshot; send that file to whoever maintains it.
- **Import** loads a snapshot back.
- **Reset** discards local edits and reloads the last Excel export.

If several people must edit the *same* shared copy, this needs a real backend
(Google Sheets, Airtable, Supabase, a small server) — a static page cannot do it.

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
