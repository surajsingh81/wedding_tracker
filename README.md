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

Edits are saved in the browser immediately and sent to the shared Supabase
database automatically. Other open browsers receive database changes through
Supabase Realtime. **Sync now** retries any pending edits; **Reset** discards
this device's pending edits and restores the latest shared state. Excel remains
an offline workbook/export, not the live source of truth.

There is deliberately **no Export/Import**: the page is not meant to move data
around by hand.

## Password

The page is open for viewing. The live-edit password is checked by a Supabase
Edge Function and is never stored in the website code. The Supabase public key
in `realtime-config.js` is designed to be public; database row-level security
allows public reads, while writes are restricted to the Edge Function.

## Supabase realtime setup

The project URL and public key are in `realtime-config.js`. To finish setting up
the database once:

1. In the Supabase SQL Editor, run [`supabase/schema.sql`](./supabase/schema.sql).
   It creates the shared-state row/table, read-only public policy, write RPCs,
   and enables Realtime for the table.
2. Under Edge Functions, deploy the `tracker-write` function using the code in
   [`supabase/functions/tracker-write/index.ts`](./supabase/functions/tracker-write/index.ts).
   Turn **Verify JWT with legacy secret** off; the function checks its own
   `TRACKER_WRITE_PASSWORD` secret instead.
3. Under Edge Function Secrets, set `TRACKER_WRITE_PASSWORD` to the private
   editor password. Supabase provides `SUPABASE_URL` and
   `SUPABASE_SERVICE_ROLE_KEY` to functions automatically. Never put the
   service-role key in the site.
4. Publish the website changes. On the first successful edit, the app seeds the
   shared row from the existing workbook export plus that editor's changes.
   Each later field edit is sent as a small patch, so changes to different
   fields can be merged. If two editors change the same field, the last write
   wins; coordinate vendor additions/removals with other editors.

The site asks for the editor name and live-edit password on the first save in a
browser tab. It keeps the password only in memory for that tab. The shared data
is readable by anyone who can reach the site, as it already is in the published
`data.json`; do not put private information in it.

After each successful live save, the Edge Function also posts a full snapshot to
the existing Apps Script relay in the background. The `inbox/*.json` workflow
applies that snapshot to the Excel workbook and re-exports `data.json` on
`main`. This backup is asynchronous; Supabase remains the live source of truth.
If the relay or workbook workflow fails, the Edge Function logs the error and
the live database save still succeeds.

## Who changed what

Type your name in the **Your name** box at the top — it is remembered on that
device. Every edit (guest names, vendor fields, add/remove vendor, reset) is
recorded with your name and a timestamp, and shown on the **Changes** tab.

The log lives in that browser's `localStorage` (last 300 entries), so each
device shows its own history.

## Legacy Excel relay

Excel exports and the old relay workflow remain in the repository for offline
workbook maintenance. They are not used by the live website; see
`.github/workflows/apply-inbox.yml` and `tools/apply_payload.py` for that legacy
workflow.

## Conventions carried over from the spreadsheet

- **Two guests per room.** Each room has a Guest 1 and a Guest 2 slot. A room
  with two people still counts as **one room** against the required number.
- **One row per vendor.** A single invoice covering several services stays in one
  row and one total — never split across several rows.
- **Invoice detail is reference only.** Vendor detail sheets (invoice
  itemisation, hotel cost breakdown) are shown separately and are never added to
  the totals a second time.
