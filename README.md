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
| `Wedding_Expense_Tracker_Dec2026.xlsx` | The workbook itself, downloadable |
| `Vendor PDFs/` | The invoice PDF the page links to |

## Data & the Excel file

Everything is public by choice — the data is not confidential. The repo contains:

- `data.json` — the full export from the workbook (guest names, vendor contacts,
  payment amounts, invoice detail).
- `Wedding_Expense_Tracker_Dec2026.xlsx` — the actual workbook, downloadable
  from the repo.

## Refreshing from the workbook

After changing the spreadsheet, re-export and commit the result:

```bash
python3 tools/export_site_data.py     # writes data.json
git add data.json Wedding_Expense_Tracker_Dec2026.xlsx
git commit -m "refresh from workbook" && git push
```

## How edits work

Everything you type is saved in this browser as you go (`localStorage`) and stays
on this device. The toolbar has three buttons:

- **Save on cloud** — posts your entries to a small relay so they can be carried
  into the spreadsheet (see below).
- **Print** — prints the current view (handy for the front-desk room grid).
- **Reset** — discards your entries on this device and reloads the last Excel export.

There is deliberately **no Export/Import**: the page is not meant to move data
around by hand. If several people must edit the *same* shared copy, the relay
below is the way to do it.

## Password

The page is **open for viewing** — no login. The password is only asked when
**saving**: pressing **Save on cloud** prompts for it before anything leaves the
device. Default password: `wedding2026`.

> ⚠️ This is a *speed bump*, not real security. GitHub Pages is a static host, so
> the page, the data and the check all download to the visitor's browser. Anyone
> determined can still fetch `data.json` directly or read `auth.js`. It stops
> casual visitors from pushing changes to the spreadsheet. For real access
> control you would need Cloudflare Access or a small backend.

To change the password:

```bash
echo -n "newpassword" | shasum -a 256
```

Paste the hash into `AUTH.hash` in `auth.js`, then commit and push.

## Who changed what

Type your name in the **Your name** box at the top — it is remembered on that
device. Every edit (guest names, vendor fields, add/remove vendor, reset, send)
is recorded with your name and a timestamp, and shown on the **Changes** tab.

The log lives in that browser's `localStorage` (last 300 entries), so each
device shows its own history. When you press **Save on cloud**, the payload
carries `author` and the full `changes` list along with the data, so the
spreadsheet side can keep the same record.

## Getting entries into Excel

A static page cannot write to a local `.xlsx` file, and GitHub Pages is
read-only. So **Save on cloud** opens your mail app with the payload addressed
to `surajupes@gmail.com` (set in `sync-config.js`) — just press send.

To carry that email into the workbook, run the patch script on the payload:

```bash
python3 tools/apply_payload.py payload.json --export
```

It backs up the workbook first, refuses to run while Excel has the file open,
writes guest names into the grids (full state, so clearing a name clears the
cell), updates vendor rows, and appends new vendors as fresh rows above TOTAL
with the SUM ranges extended.

The payload shape is documented in `sync.js` (`buildSyncPayload()`): a flat list
of guest entries (hotel, room, night, slot, name) plus the full vendor list, with
`row: null` / `isNew: true` marking vendors that should be appended as new rows.

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
