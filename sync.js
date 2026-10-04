/* ============================================================================
   sync.js — "Save on cloud"
   ----------------------------------------------------------------------------
   A static web page cannot write to a local .xlsx file, and GitHub Pages is
   read-only. So the page POSTs the entries to a tiny relay endpoint, which
   drops them into inbox/ in the repo; a GitHub Action then patches the Excel
   workbook and re-exports data.json automatically.

   TO WIRE THIS UP, put the URL of your relay in sync-config.js:

       window.SYNC_ENDPOINT = "https://script.google.com/macros/s/AKfy.../exec";
       window.SYNC_EMAIL   = "you@example.com";

   The relay must accept a JSON POST. The bundled Apps Script relay
   (tools/apps-script-endpoint.js) commits the payload to inbox/ — see
   README.md, "Save on cloud" for the one-time setup.

   v14
   ----
   * Name before password. ensureName() runs first; the password dialog only
     opens once we know who is saving.
   * The payload is a DELTA against the last export rather than the whole state.
     A 10-room x 6-night x 3-slot hotel is 180 cells per night block, nearly
     all of them empty; shipping every one of them on every save was the bulk
     of the transfer. Now only cells that actually differ are sent. A cell that
     had a name in the baseline and is now empty IS still sent, with name:"" —
     that is the "clear it in the workbook" instruction, so it must survive.
   * buildSyncPayload({ full: true }) restores the old whole-state behaviour for
     anyone who wants to force a complete rewrite of the grid.
   ========================================================================== */

function syncStatus(msg, cls) {
  const el = $("#syncStatus");
  if (!el) return;
  el.className = "dim " + (cls || "");
  el.textContent = msg;
}

const trim1 = x => String(x ?? "").trim();

// Flatten the grids + vendor list into something a spreadsheet script can apply.
function buildSyncPayload(opts = {}) {
  const full = !!opts.full;
  const guests = [];
  const rooms = [];
  let cellsConsidered = 0;

  for (const h of st.hotels) {
    const bh = (base?.hotels || []).find(x => x.id === h.id);

    h.grid.forEach((row, ri) => {
      row.forEach((cell, ni) => {
        cell.forEach((name, slot) => {
          cellsConsidered++;
          const now = trim1(name);
          if (!full) {
            // skip only when it genuinely matches the baseline
            const was = trim1(bh?.grid?.[ri]?.[ni]?.[slot]);
            if (now === was) return;
          }
          guests.push({
            hotel: h.name,
            room: ri + 1,              // physical grid row, 1-based
            night: h.nights[ni],
            slot: slot + 1,            // 1 = Guest 1, 2 = Guest 2, 3 = extra third guest
            name: now,
          });
        });
      });
    });

    // Rooms booked + the hotel's own room numbers. Also diffed: a hotel nobody
    // touched contributes nothing at all.
    const bookedNow = h.roomsBooked ?? h.totalRooms;
    const nosNow = (h.roomNos || []).map(trim1);
    const bookedWas = bh ? (bh.roomsBooked ?? bh.totalRooms) : null;
    const nosWas = (bh?.roomNos || []).map(trim1);
    const changed = full
      || bookedNow !== bookedWas
      || nosNow.length !== nosWas.length
      || nosNow.some((v, i) => v !== nosWas[i]);
    if (changed) {
      rooms.push({ hotel: h.name, roomsBooked: bookedNow, roomNos: nosNow });
    }
  }

  const q = st.vendors.reduce((a, v) => a + (v.quoted || 0), 0);
  const p = st.vendors.reduce((a, v) => a + (v.paid  || 0), 0);
  return {
    v: 2,
    mode: full ? "full" : "delta",
    event: st.event,
    sentAt: new Date().toISOString(),
    source: "web",
    author: ($("#yourName")?.value || $("#yourNameBar")?.value || "").trim() || "Anonymous",
    // which export the delta was measured against — apply_payload can refuse a
    // mismatch rather than writing changes into the wrong baseline
    baselineGenerated: base?.generated ?? null,
    changes: getChanges(),
    guests,
    rooms,
    vendors: st.vendors.map(v => ({
      name: v.name, contact: v.contact, phone: v.phone, whatsapp: v.whatsapp,
      event: v.event, eventDate: v.eventDate,
      quoted: v.quoted, paid: v.paid, paymentMode: v.paymentMode,
      ref: v.ref, paidOn: v.paidOn, address: v.address, notes: v.notes,
      row: v.row ?? null,          // workbook row, or null => append a new row
      isNew: !!v.isNew,
    })),
    totals: { quoted: q, paid: p, outstanding: q - p },
    stats: { cellsConsidered, guestsSent: guests.length, hotelsSent: rooms.length },
  };
}

async function syncNow(opts = {}) {
  flushSave();   // never let a coalesced keystroke sit behind a save

  // 1. the name. It comes first because a change we cannot attribute is worse
  //    than one that takes an extra moment to send.
  if (!await ensureName(
    "We record your name with every change you send, so the couple always know "
    + "who to ask about it. It stays on this device.", true)) {
    syncStatus("We need your name before saving — that is what tells the couple who changed what.", "msg-warn");
    return;
  }
  // 2. then the password.
  if (!(await AuthGate.confirmSave())) return;

  const url = (window.SYNC_ENDPOINT || "").trim();
  const email = (window.SYNC_EMAIL || "").trim();
  const t0 = (performance?.now?.() ?? Date.now());
  const payload = buildSyncPayload(opts);
  // Compact, not pretty-printed: this same string is the mailto: body in the
  // no-relay fallback, and the indent costs ~9KB of URL length that mail
  // clients reject. tools/apply_payload.py reads either form.
  const body = JSON.stringify(payload);
  const kb = (body.length / 1024).toFixed(1);
  const named = payload.guests.filter(g => g.name).length;
  const clears = payload.guests.length - named;

  // No relay configured yet -> fall back to emailing the payload yourself.
  if (!url) {
    if (!email) {
      syncStatus("Sending is not switched on yet — it needs an email address. "
        + "Your entries are still saved in this browser.", "msg-warn");
      return;
    }
    recordChange(`Prepared ${payload.guests.length} guest change(s), `
      + `${payload.rooms.length} hotel room list(s) and ${payload.vendors.length} vendor row(s)`);
    const subject = encodeURIComponent(`Wedding tracker update — ${payload.sentAt.slice(0, 10)}`);
    const href = `mailto:${encodeURIComponent(email)}?subject=${subject}&body=${encodeURIComponent(body)}`;
    window.location.href = href;
    syncStatus(
      `Your mail app should open with ${named} guest name(s) and `
      + `${payload.vendors.length} vendor row(s) — just press send. `
      + `That is ${kb}KB of changes (${payload.stats.guestsSent} of `
      + `${payload.stats.cellsConsidered} cells differed).`
      + (body.length > 20000
        ? " If the draft arrives empty the payload is too long for a mail link — use a synced save instead."
        : ""),
      body.length > 20000 ? "msg-warn" : "msg-ok");
    flash("Mail opened");
    return;
  }

  const btn = $("#btnSync"), bar = $("#btnSyncBar");
  const label = btn?.textContent, barLabel = bar?.textContent;
  if (btn) { btn.disabled = true; btn.textContent = "Sending…"; }
  if (bar) { bar.disabled = true; bar.textContent = "Sending…"; }
  try {
    // text/plain keeps this a "simple request" — no CORS preflight, which the
    // Apps Script relay cannot answer. It reads the raw body either way.
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=UTF-8" },
      body,
    });
    if (!res.ok) throw new Error("HTTP " + res.status);
    const ms = Math.round((performance?.now?.() ?? Date.now()) - t0);
    recordChange(`Saved ${named} guest name(s), ${payload.rooms.length} hotel room list(s) `
      + `and ${payload.vendors.length} vendor row(s) to the cloud (${kb}KB, ${ms}ms)`);
    syncStatus(
      `✓ Sent ${named} guest name(s)${clears ? ` and ${clears} clear(s)` : ""} `
      + `and ${payload.vendors.length} vendor row(s) — ${kb}KB in ${ms}ms. `
      + `Excel is picking these up now; you can carry on editing.`,
      "msg-ok");
    flash("Sent");
    watchSync();   // poll the live data until the workbook reflects this save
  } catch (err) {
    syncStatus("Could not send (" + err.message + "). Your entries are still saved in "
      + "this browser — try again shortly.", "msg-error");
  } finally {
    if (btn) { btn.disabled = false; btn.textContent = label; }
    if (bar) { bar.disabled = false; bar.textContent = barLabel; }
  }
}