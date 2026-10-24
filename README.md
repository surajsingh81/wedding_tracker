# Wedding Tracker — December 2026

A small static wedding planning page for hotel bookings, guest lists, vendor
payments, invoices, and shared activity.

No build step, backend, or package install is needed. It is a static
`index.html` + `styles.css` + `app.js` + `data.json` site. jsPDF is loaded from
jsDelivr for direct PDF downloads, so PDF generation requires an internet
connection; the print fallback remains available.

## Files

| File | What it is |
|---|---|
| `index.html` | Page structure and the Overview, Hotels, Guests, Vendors, Miscellaneous, Invoices, and Changes tabs |
| `styles.css` | All styling, including dark mode and print |
| `app.js` | Rendering, editing, and the stats |
| `data.json` | **The data**, exported from the workbook |
| `Wedding_Expense_Tracker_Dec2026.xlsx` | The workbook itself, downloadable |
| `Vendor PDFs/` | The invoice PDF the page links to |

## Live links

- Website: <https://surajsingh81.github.io/wedding_tracker/>
- Excel workbook: <https://github.com/surajsingh81/wedding_tracker/raw/refs/heads/main/Wedding_Expense_Tracker_Dec2026.xlsx>
- Latest workbook data export: <https://raw.githubusercontent.com/surajsingh81/wedding_tracker/main/data.json>
- Workbook workflow runs: <https://github.com/surajsingh81/wedding_tracker/actions/workflows/apply-inbox.yml>

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

Edits are saved in the browser immediately and stay on that device until the
editor clicks **Sync changes**. The app then asks for the editor name followed
by the live-edit password before writing to Supabase. Unsynced edits are
discarded on page refresh; sync them before reloading or closing the page. Other
open browsers receive committed database changes through Supabase Realtime, with
a periodic fresh read to catch up after a mobile device suspends its connection.
Sync progress, success, and failures are shown in a visible status toast.
If the live-edit password is rejected, the password dialog reopens with a
clear retry message; unsaved changes remain on this device. Syncing with no
changes does not request credentials.
**Discard local changes** restores the latest shared state and removes this
device's unsynced edits. Excel remains an asynchronous backup, not the live
source of truth. On phones, vendor rows are shown as labeled edit cards instead
of a wide spreadsheet; the theme follows the phone's light/dark appearance
setting. Use **Hotels** to add or delete hotel bookings, change check-in and
check-out dates, add individual dates, or adjust the booked-room count for each
night. Deleting a hotel also deletes its booking and guest details after
confirmation. Use **Guests** to enter names separately by hotel, date, and room;
desktop uses a styled room-by-night grid, while phones use a guided one-room
flow. On phones, choose a room chip to show only that room's guest fields, then
enter its actual hotel-assigned room number in the labeled box. After a
successful sync, the Excel backup creates a worksheet for an added hotel and
includes its nightly bookings and guest names.

Every named vendor has a linked invoice. Existing vendor rows are linked or
backfilled automatically; adding a vendor and entering its name creates the
invoice. Contact, event, payment, address, quote, paid amount, and notes fields
stay in sync in either tab. Deleting a vendor also deletes its linked invoice;
deleting only an invoice leaves the vendor row in place. On phones, vendor
cards support Enter-to-advance between visible fields. Optional vendor details
on a new invoice stay collapsed until needed; editing a linked invoice opens
those fields automatically. Saving a new invoice without opening that section
preserves existing vendor contact and payment details.

Use **Miscellaneous** to add, edit, or delete one-off expenses with a title,
amount, optional notes, and Cash, UPI, or Credit card payment method. Its total
and payment-method subtotals appear on the tab and as a separate spend figure
on the Overview; vendor quote and payment totals remain unchanged.

There is deliberately **no Export/Import**: the page is not meant to move data
around by hand.

## Accessibility

The site supports keyboard navigation, visible focus indicators, a skip-to-content
link, labeled form controls, and focus-managed name/password dialogs. The mobile
hotel and date selectors announce their selected state, and invoice tables wrap
to fit narrow screens. Animations are reduced when the device requests reduced
motion; color contrast was checked in both light and dark themes.

## PDF reports

Use **Export PDF** in the header (or **More** on mobile) to create a report.
Choosing a report opens a preview. **Download PDF** generates a PDF directly
without relying on the mobile print dialog; on supported phones it opens the
system share sheet so the file can be saved or shared. **Print / Save as PDF**
remains available as an alternative. Available reports are:

- Overview — vendor financial summary, miscellaneous spending by payment
  method, and hotel room-night status.
- Room bookings — nightly pre-booked rooms and guest-detail completion.
- Pending vendor payments — vendors with an outstanding balance.
- Miscellaneous expenses — expense titles, amounts, notes, and payment methods.
- Invoices — added invoice records, status, amounts, and notes.

The reports are intentionally separate from the editing screens so a PDF is
easy to share or print.

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
4. Publish the website changes. Edits are saved on the current device as you
   type, but are not sent to Supabase automatically. Click **Sync changes** to
   confirm the editor name and enter the live-edit password. The first successful
   sync seeds the shared row; later syncs send field-level patches. If two editors
   change the same field, the last write wins; coordinate vendor additions/removals.

The site asks for the editor name and live-edit password each time **Sync changes**
is used. The password is not retained in the browser. The shared data is readable
by anyone who can reach the site, as it already is in the published
`data.json`; do not put private information in it.

After each successful live save, the Edge Function also posts a full snapshot to
the existing Apps Script relay in the background. The `inbox/*.json` workflow
applies that snapshot to the Excel workbook and re-exports `data.json` on
`main`. This backup is asynchronous; Supabase remains the live source of truth.
If the relay or workbook workflow fails, the Edge Function logs the error and
the live database save still succeeds.

Each page load asks Supabase and the raw `main` workbook export for fresh data
without browser or intermediary caching. A previously saved browser snapshot is
used only when both network sources are unavailable, and the status line warns
when the site has fallen back to that offline copy.

## Who changed what

Type your name in the **Your name** box at the top — it is remembered on that
device. Every edit (guest names, vendor fields, add/remove vendor, reset) is
recorded with your name and a timestamp, and shown on the **Changes** tab.

The log lives in that browser's `localStorage` (last 300 entries), so each
device shows its own history. Shared activity lists each recorded field change
under the editor who made it.

## Legacy Excel relay

Excel exports and the old relay workflow remain in the repository for offline
workbook maintenance. They are not used by the live website; see
`.github/workflows/apply-inbox.yml` and `tools/apply_payload.py` for that legacy
workflow.

## Conventions carried over from the spreadsheet

- The nightly **NEEDED** count means rooms already pre-booked. Website status
  compares that count with rooms that have guest names entered; a shortfall
  means guest details are missing, not that more rooms need to be booked.
- **Two guests per room.** Each room has a Guest 1 and a Guest 2 slot. A room
  with two people still counts as **one room** against the pre-booked count.
- **One row per vendor.** A single invoice covering several services stays in one
  row and one total — never split across several rows.
- **Invoice detail is reference only.** Vendor detail sheets (invoice
  itemisation, hotel cost breakdown) are shown separately and are never added to
  the totals a second time.
