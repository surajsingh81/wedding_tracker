/* ============================================================================
   sync.js — "Send to Excel"
   ----------------------------------------------------------------------------
   A static web page cannot write to a local .xlsx file, and GitHub Pages is
   read-only. So the page POSTs the entries to a tiny endpoint you control, and
   that endpoint forwards them to the workbook.

   TO WIRE THIS UP, put the URL of your endpoint in sync-config.js:

       window.SYNC_ENDPOINT = "https://script.google.com/macros/s/AKfy.../exec";
       window.SYNC_EMAIL   = "you@example.com";

   It must accept a JSON POST (CORS allowed) and can be as simple as a Google
   Apps Script web app — see README.md, "Getting entries into Excel".
   ========================================================================== */

function syncStatus(msg, cls) {
  const el = $("#syncStatus");
  if (!el) return;
  el.className = "dim " + (cls || "");
  el.textContent = msg;
}

// Flatten the grids + vendor list into something a spreadsheet script can apply.
function buildSyncPayload() {
  const guests = [];
  for (const h of st.hotels) {
    h.grid.forEach((row, ri) => {
      row.forEach((cell, ni) => {
        cell.forEach((name, slot) => {
          if (String(name || "").trim())
            guests.push({
              hotel: h.name,
              room: ri + 1,
              night: h.nights[ni],
              slot: slot + 1,           // 1 = Guest 1, 2 = Guest 2
              name: String(name).trim(),
            });
        });
      });
    });
  }
  const q = st.vendors.reduce((a, v) => a + (v.quoted || 0), 0);
  const p = st.vendors.reduce((a, v) => a + (v.paid  || 0), 0);
  return {
    event: st.event,
    sentAt: new Date().toISOString(),
    source: "web",
    guests,
    vendors: st.vendors.map(v => ({
      name: v.name, contact: v.contact, phone: v.phone, whatsapp: v.whatsapp,
      event: v.event, eventDate: v.eventDate,
      quoted: v.quoted, paid: v.paid, paymentMode: v.paymentMode,
      ref: v.ref, paidOn: v.paidOn, address: v.address, notes: v.notes,
      row: v.row ?? null,          // workbook row, or null => append a new row
      isNew: !!v.isNew,
    })),
    totals: { quoted: q, paid: p, outstanding: q - p },
  };
}

async function syncNow() {
  const url = (window.SYNC_ENDPOINT || "").trim();
  const email = (window.SYNC_EMAIL || "").trim();
  const payload = buildSyncPayload();
  const body = JSON.stringify(payload, null, 1);

  // No relay configured yet -> fall back to emailing the payload yourself.
  // The scheduled Automation reads this email and patches the workbook.
  if (!url) {
    if (!email) {
      syncStatus(
        "Sending is not switched on yet — it needs an email address. Your entries are still saved in this browser.",
        "msg-warn");
      return;
    }
    const subject = encodeURIComponent(`Wedding tracker update — ${payload.sentAt.slice(0, 10)}`);
    const href = `mailto:${encodeURIComponent(email)}?subject=${subject}&body=${encodeURIComponent(body)}`;
    window.location.href = href;
    syncStatus(
      `Your mail app should open with ${payload.guests.length} guest name(s) and `
      + `${payload.vendors.length} vendor row(s) — just press send. The spreadsheet picks it up automatically.`,
      "msg-ok");
    flash("Mail opened");
    return;
  }

  const btn = $("#btnSync");
  const label = btn.textContent;
  btn.disabled = true; btn.textContent = "Sending…";
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body,
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    syncStatus(
      `Sent ${payload.guests.length} guest name(s) and ${payload.vendors.length} vendor row(s) `
      + `at ${new Date().toLocaleTimeString()}. The spreadsheet picks these up automatically.`,
      "msg-ok");
    flash("Sent");
  } catch (err) {
    syncStatus("Could not send (" + err.message + "). Your entries are still saved in this browser — try again shortly.", "msg-error");
  } finally {
    btn.disabled = false; btn.textContent = label;
  }
}
