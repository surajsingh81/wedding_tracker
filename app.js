/* Wedding tracker — all state lives in localStorage; nothing is sent anywhere.
   A fresh data.json (exported from the workbook) is the baseline to reset to.

   v14 changes
   -----------
   * Name gate: the person's name is asked for the first time they finish an
     edit, and again before a save — always BEFORE the password prompt.
   * Mobile entry layer: a room picker plus a one-room-at-a-time sheet, so
     filling 10 rooms x 6 nights x 3 guests is a vertical scroll, not a
     horizontal one. The desktop grid is unchanged and still drives both paths.
   * Faster data exchange:
       - data.json is cached in localStorage with its ETag, so a repeat load is
         a 304 with zero bytes instead of a full download, and the app still
         opens offline.
       - localStorage writes are coalesced: a burst of keystrokes costs one
         JSON.stringify + one write, not one per character.
       - the sync payload is a delta against the last export (see sync.js), which
         is typically a few KB instead of a few hundred.

   All render + count helpers stay pure so the test suite can drive them without
   a browser. */

const KEY = "wedding-tracker-v1";
const PENDING_KEY = "wedding-tracker-pending-v1";   // "1" = edits not yet in shared state
const CHANGES_KEY = "tracker-changes-v1";
const NAME_KEY = "tracker-name-v1";
const CACHE_KEY = "wedding-tracker-cache-v1";       // {etag, data} for fast loads
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// Live data source: the GitHub API serves data.json the moment the Action
// commits it (no Pages rebuild wait). Falls back to the Pages copy.
const DATA_API = "https://api.github.com/repos/surajsingh81/wedding_tracker/contents/data.json";

let base = null;   // last shared snapshot, initially loaded from the workbook export
let st   = null;   // live state = base + local edits

/* ------------------------------------------------------- fast baseline load
   A 304 answers in a few bytes; the Pages fallback and an offline launch both
   land on the cached copy. Three ordered sources, first success wins. */
function readCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || "null"); }
  catch { return null; }
}
function writeCache(etag, data) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ etag: etag || null, data })); }
  catch { /* quota — the cache is an optimisation, never a requirement */ }
}
function decodeGithubContent(meta) {
  // UTF-8 (₹, en-dashes, names). atob() alone decodes as Latin-1 and mangles
  // every non-ASCII character, so go through bytes + TextDecoder.
  const bin = atob(meta.content.replace(/\s+/g, ""));
  return JSON.parse(new TextDecoder("utf-8").decode(Uint8Array.from(bin, c => c.charCodeAt(0))));
}

async function loadData() {
  const shared = await window.RealtimeSync?.load();
  if (shared) return shared;
  const cache = readCache();
  try {
    const headers = cache?.etag ? { "If-None-Match": cache.etag } : {};
    const r = await fetch(DATA_API, { cache: "no-cache", headers });
    if (r.status === 304 && cache?.data) return cache.data;
    if (r.ok) {
      const meta = await r.json();
      if (meta.content) {
        const d = decodeGithubContent(meta);
        writeCache(meta.etag || r.headers.get("etag"), d);
        return d;
      }
    }
  } catch (e) { /* fall through to the Pages copy */ }

  try {
    const d = await (await fetch("data.json", { cache: "no-cache" })).json();
    writeCache(null, d);
    return d;
  } catch (e) { /* fall through to the cache */ }

  if (cache?.data) return cache.data;
  throw new Error("could not load data.json");
}

// Every hotel cell holds exactly this many guest slots. Slot 3 is the extra
// person the hotel bills on top of the room rate.
const SLOTS = 3;

// Exports from before this feature (and any browser snapshot saved then) lack
// rooms-booked, room numbers and the third guest slot. Normalise once so the
// rest of the app can assume a single shape.
function normalize(d) {
  for (const h of d.hotels || []) {
    const nights = h.nights || [];
    h.totalRooms = h.totalRooms ?? (h.grid ? h.grid.length : 0);
    h.roomsBooked = Number.isFinite(+h.roomsBooked) ? +h.roomsBooked : h.totalRooms;
    h.roomNos = Array.from({ length: h.totalRooms }, (_, i) => h.roomNos?.[i] ?? "");
    h.grid = (h.grid || []).map(row =>
      (row || []).map(cell => Array.from({ length: SLOTS }, (_, g) => cell?.[g] ?? "")));
    // a snapshot may carry fewer room rows than the export now reports
    while (h.grid.length < h.totalRooms)
      h.grid.push(Array.from({ length: nights.length }, () => Array(SLOTS).fill("")));
    h.grid = h.grid.slice(0, h.totalRooms);
  }
  d.vendors = d.vendors || [];
  return d;
}

// Signature of every editable field — used to detect when the workbook has
// absorbed a save (the API copy then matches the live state).
function dataSig(d) {
  return JSON.stringify([
    d.hotels.map(h => [h.id, h.grid, h.roomsBooked, h.roomNos]),
    d.vendors.map(v => [v.row, v.name, v.contact, v.phone, v.whatsapp,
      v.event, v.eventDate, v.quoted, v.paid, v.paymentMode,
      v.ref, v.paidOn, v.address, v.notes, v.isNew]),
  ]);
}

// The legacy Excel sync path adopts the export after its GitHub Action finishes.
function adoptFresh(d) {
  base = normalize(d);
  st = JSON.parse(JSON.stringify(base));
  localStorage.removeItem(KEY);
  localStorage.setItem(PENDING_KEY, "0");
  const g = $("#genDate"); if (g) g.textContent = base.generated;
  renderAll();
}

// After a successful save, poll the API until the workbook reflects it. The
// Action itself takes ~12s, so poll tightly at first, then back off, and show
// the elapsed time so the wait is never a mystery.
async function watchSync() {
  const want = dataSig(st);
  const t0 = Date.now();
  const elapsed = () => `${Math.round((Date.now() - t0) / 1000)}s`;
  for (let i = 0; i < 24; i++) {
    syncStatus(`✓ Sent to the cloud. Excel is absorbing it — ${elapsed()}…`, "msg-ok");
    await new Promise(r => setTimeout(r, i < 9 ? 2500 : 8000));
    let fresh = null;
    try { fresh = normalize(await loadData()); } catch (e) { continue; }
    if (dataSig(fresh) === want) {
      adoptFresh(fresh);
      syncStatus(`✓ Synced to Excel — the workbook has your changes (${elapsed()}).`, "msg-ok");
      return;
    }
  }
  syncStatus("Saved to the cloud — Excel is still catching up. Reload in a moment to see it.", "msg-ok");
}

/* ------------------------------------------------------------------ helpers */
const inr = n => "₹" + Number(n || 0).toLocaleString("en-IN");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const WD = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];
function wd(s) {                       // "08-Dec-2026" -> "Tue 08 Dec"
  const [d, m, y] = String(s).split("-");
  const dt = new Date(`${m} ${d}, ${y}`);
  return isNaN(dt) ? s : `${WD[dt.getDay()]} ${d} ${m}`;
}

function filledRooms(h, ni) {                    // rooms occupied on night ni
  let n = 0;
  for (const row of h.grid) if (row[ni].some(g => g)) n++;
  return n;
}
function nightGuests(h, ni) {                    // people in rooms on night ni
  let n = 0;
  for (const row of h.grid) for (const g of row[ni]) if (g) n++;
  return n;
}
function nightThird(h, ni) {                     // billable 3rd guests on night ni
  let n = 0;
  for (const row of h.grid) if (row[ni][2]) n++;
  return n;
}
function roomGuests(h, ri) {                     // people across every night in room ri
  return h.grid[ri].reduce((a, cell) => a + cell.filter(Boolean).length, 0);
}
function roomNights(h, ri) {                     // nights on which room ri is occupied
  return h.grid[ri].filter(cell => cell.some(Boolean)).length;
}
function roomThird(h, ri) {                      // billable 3rd-guest nights in room ri
  return h.grid[ri].filter(cell => cell[2]).length;
}
// Headline numbers for one hotel: guest-nights, extra 3rd-guest nights, and how
// much of the booked block is actually occupied.
function hotelStats(h) {
  const guestNights = h.grid.reduce((a, row) =>
    a + row.reduce((x, cell) => x + cell.filter(Boolean).length, 0), 0);
  const thirdNights = h.grid.reduce((a, row) =>
    a + row.filter(cell => cell[2]).length, 0);
  const needed = h.needed.reduce((a, b) => a + (b || 0), 0);
  const filled = h.nights.reduce((a, _, i) => a + filledRooms(h, i), 0);
  const booked = h.roomsBooked ?? h.totalRooms;
  return { guestNights, thirdNights, needed, filled, booked,
           thirdGuests: h.grid.reduce((a, row) =>
             a + row.reduce((x, cell) => x + (cell[2] ? 1 : 0), 0), 0) };
}
// A hotel is "booked" while its rooms are held, "filled" once the held rooms
// actually have guests, and "current" reflects the first night's demand.
function hotelStatus(h) {
  const s = hotelStats(h);
  const booked = h.roomsBooked ?? h.totalRooms;
  const roomsInUse = h.grid.filter(row => row.some(cell => cell.some(Boolean))).length;
  const fillCls = booked === 0 ? "none" : roomsInUse >= booked ? "ok" : roomsInUse ? "warn" : "none";
  return {
    ...s, roomsInUse,
    booked: { txt: `${booked} of ${h.totalRooms} rooms`, cls: booked >= h.totalRooms ? "ok" : "warn" },
    fill: { txt: `${roomsInUse} of ${booked} rooms`, cls: fillCls },
    current: nightStatus(h, 0),
  };
}
function nightStatus(h, ni) {
  const f = filledRooms(h, ni), need = h.needed[ni] || 0;
  if (f === need) return { f, need, cls: "ok",    txt: "OK" };
  if (f <  need)  return { f, need, cls: "short", txt: `need ${need - f} more` };
  return              { f, need, cls: "over",  txt: `${f - need} over` };
}
function vendorStatus(v) {
  if (v.quoted === "" || v.quoted == null) return { cls: "none", txt: "Not quoted" };
  const bal = (v.quoted || 0) - (v.paid || 0);
  return bal <= 0 ? { cls: "ok", txt: "Paid", bal }
                  : { cls: "warn", txt: "Pending", bal };
}

/* --------------------------------------------------------------- persistence
   A burst of keystrokes in one room used to cost one full JSON.stringify plus
   one localStorage write per character. Now they coalesce into one write, with
   a flush on the way out so nothing can be lost. */
let saveT = 0, saveDirty = false;
function flushSave() {
  if (!saveT && !saveDirty) return;
  clearTimeout(saveT); saveT = 0; saveDirty = false;
  try {
    localStorage.setItem(KEY, JSON.stringify(st));
    localStorage.setItem(PENDING_KEY, "1");   // not yet in shared state
  } catch (e) {
    flash("Could not save (storage full?)");
    return;
  }
  window.RealtimeSync?.queueSave();
  flash("Saved " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
}
function save() {
  saveDirty = true;
  flash("Editing…");
  clearTimeout(saveT);
  saveT = setTimeout(flushSave, 250);
}
// never lose an edit to a backgrounded tab or a closed lid
addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushSave(); });
addEventListener("pagehide", flushSave);
let flashT;
function flash(msg) {
  const t = new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });
  for (const id of ["#saveState", "#saveStateBar"]) {
    const el = $(id); if (!el) continue;
    el.textContent = msg;
    clearTimeout(el._t);
    el._t = setTimeout(() => el.textContent = "Auto-saved", 2500);
  }
  return t;
}

/* ------------------------------------------------------------- the name gate
   Two asks, in this order, and always before the password:
     1. the first time someone finishes an edit on this device, and
     2. before a live save is sent. */
let nameAsked = false;
let namePrompt = null;
function currentName() {
  return (($("#yourName")?.value || $("#yourNameBar")?.value) || "").trim();
}
function setName(v) {
  const s = String(v || "").trim();
  try { localStorage.setItem(NAME_KEY, s); } catch (e) { /* private mode */ }
  for (const id of ["#yourName", "#yourNameBar"]) {
    const el = $(id); if (!el) continue;
    el.value = s;
    el.dataset.empty = s ? "0" : "1";     // drives the amber warning tint
  }
  return s;
}
function nameMissing() { return !currentName(); }

function ensureName(why, force) {
  if (!nameMissing()) return Promise.resolve(true);
  if (nameAsked && !force) return Promise.resolve(false);   // don't nag mid-edit
  if (namePrompt) return namePrompt;
  namePrompt = new Promise(resolve => {
    const el = $("#nameLock"), input = $("#nameLockInput"), err = $("#nameLockErr");
    const whyEl = $("#nameLockWhy");
    if (!el || !input) { namePrompt = null; return resolve(false); }
    if (whyEl && why) whyEl.textContent = why;
    el.hidden = false;
    input.value = currentName();
    err.textContent = "";
    input.focus();
    const done = ok => { el.hidden = true; namePrompt = null; resolve(ok); };
    $("#nameLockForm").onsubmit = e => {
      e.preventDefault();
      const v = input.value.trim();
      if (v.length < 2) {
        err.textContent = "Please enter at least 2 characters, so it is clear who made the change.";
        input.focus();
        return;
      }
      setName(v); nameAsked = true; done(true);
    };
    $("#nameLockCancel").onclick = () => done(false);
  });
  return namePrompt;
}

/* --------------------------------------------------------------- change log */
function getChanges() {
  try { return JSON.parse(localStorage.getItem(CHANGES_KEY) || "[]"); }
  catch { return []; }
}
function recordChange(what) {
  const who = currentName() || "Anonymous";
  const log = getChanges();
  log.push({ t: new Date().toISOString(), who, what });
  if (log.length > 300) log.splice(0, log.length - 300);
  localStorage.setItem(CHANGES_KEY, JSON.stringify(log));
  renderChanges();
}
function renderChanges() {
  const log = getChanges();
  const el = $("#changesList");
  if (!el) return;
  if (!log.length) {
    el.innerHTML = `<p class="dim">No changes recorded on this device yet. Edit a guest name
      or a vendor field, then check back here.</p>`;
    return;
  }
  el.innerHTML = `<div class="table-scroll"><table class="grid">
    <thead><tr><th>When</th><th>Who</th><th>What changed</th></tr></thead>
    <tbody>${log.slice().reverse().map(c => `
      <tr><td class="num nowrap">${esc(new Date(c.t).toLocaleString([], {
        day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }))}</td>
        <td><b>${esc(c.who)}</b></td><td>${esc(c.what)}</td></tr>`).join("")}
    </tbody></table></div>`;
}

/* -------------------------------------------------------------------- render */
function renderAll() {
  renderOverview();
  renderRooms();          // both the desktop grid and the phone sheet
  renderVendors();
  renderInvoices();
  renderChanges();
}

function renderOverview() {
  const needTot = st.hotels.reduce((a, h) => a + h.needed.reduce((x, y) => x + (y || 0), 0), 0);
  let fillTot = 0, shortNights = [];
  for (const h of st.hotels)
    h.nights.forEach((_, i) => {
      const s = nightStatus(h, i);
      fillTot += s.f;
      if (s.cls === "short") shortNights.push(`${h.name} ${h.nights[i]}`);
    });

  let guestNights = 0, thirdGuests = 0, thirdNights = 0, roomsInUse = 0;
  for (const h of st.hotels) {
    const s = hotelStats(h);
    thirdGuests += s.thirdGuests;
    thirdNights += s.thirdNights;
    guestNights += s.guestNights;
    roomsInUse += h.grid.filter(row => row.some(cell => cell.some(Boolean))).length;
  }

  const q = st.vendors.reduce((a, v) => a + (v.quoted || 0), 0);
  const p = st.vendors.reduce((a, v) => a + (v.paid  || 0), 0);
  const pend = st.vendors.filter(v => vendorStatus(v).cls === "warn").length;

  $("#overviewCards").innerHTML = [
    ["Room-nights needed", needTot, `${st.hotels.length} hotels`],
    ["Room-nights assigned", fillTot, shortNights.length ? `${shortNights.length} night(s) short` : "all nights covered", shortNights.length ? "warn" : "ok"],
    ["Guest-nights", guestNights, `${roomsInUse} room${roomsInUse === 1 ? "" : "s"} in use`],
    ["Extra 3rd guests", thirdGuests, thirdNights ? `${thirdNights} billable guest-night${thirdNights === 1 ? "" : "s"}` : "none billable", thirdGuests ? "warn" : "ok"],
    ["Vendors", st.vendors.length, `${st.vendors.filter(v => v.quoted !== "" && v.quoted != null).length} quoted`],
    ["Vendors pending", pend, pend ? "money still due" : "nothing outstanding", pend ? "warn" : "ok"],
  ].map(([k, v, n, c = ""]) =>
    `<div class="card ${c}"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="n">${esc(n)}</div></div>`
  ).join("");

  $("#moneyCards").innerHTML = [
    ["Total quoted", inr(q), "", ""],
    ["Total paid", inr(p), "", "ok"],
    ["Total outstanding", inr(q - p), "", q - p > 0 ? "warn" : "ok"],
  ].map(([k, v, n, c]) =>
    `<div class="card ${c}"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="n">${esc(n || "") || "&nbsp;"}</div></div>`
  ).join("");

  $("#nightBars").innerHTML = st.hotels.map(h => `
    <h3>${esc(h.name)}</h3>` + h.nights.map((n, i) => {
      const s = nightStatus(h, i);
      const pct = s.need ? Math.min(100, (s.f / s.need) * 100) : 0;
      return `<div class="night">
        <div class="night-h"><span class="d">${esc(wd(n))}</span>
          <span class="s ${s.cls}">${s.f} of ${s.need} rooms &middot; ${esc(s.txt)}</span></div>
        <div class="track"><div class="fill ${s.cls}" style="width:${pct}%"></div></div>
      </div>`;
    }).join("")).join("");
}

/* Header pills + summary cards, kept as their own renderers so a live edit can
   repaint them without rebuilding the whole panel (which would eat the caret). */
function statPills(h, hs) {
  return `
          <span class="pill ${hs.booked.cls}" title="rooms held vs total rooms available">Booked ${esc(hs.booked.txt)}</span>
          <span class="pill ${hs.fill.cls}" title="booked rooms that have at least one guest">Filled ${esc(hs.fill.txt)}</span>
          <span class="pill ${hs.current.cls}" title="${esc(h.nights[0])}: ${esc(hs.current.f)} of ${esc(hs.current.need)} rooms">${esc(wd(h.nights[0]))} ${esc(hs.current.txt)}</span>`;
}

function sumCards(h, hs) {
  const booked = h.roomsBooked ?? h.totalRooms;
  return `
        <div class="sumcard"><div class="k">Guest-nights</div><div class="v">${hs.guestNights}</div><div class="n">${hs.filled} room-night${hs.filled === 1 ? "" : "s"} filled of ${hs.needed} needed</div></div>
        <div class="sumcard"><div class="k">Rooms in use</div><div class="v">${hs.roomsInUse}</div><div class="n">of ${booked} booked</div></div>
        <div class="sumcard${hs.thirdGuests ? " extra" : ""}"><div class="k">Extra 3rd guests</div><div class="v">${hs.thirdGuests}</div><div class="n">${hs.thirdNights} billable guest-night${hs.thirdNights === 1 ? "" : "s"}</div></div>`;
}

/* -------------------------------------------------------------- desktop grid */
function renderRooms() {
  renderRoomsDesktop();
  renderRoomsMobile();
}

function renderRoomsDesktop() {
  const host = $("#hotelPanels"); if (!host) return;
  host.innerHTML = st.hotels.map(h => {
    const hs = hotelStatus(h);
    const booked = h.roomsBooked ?? h.totalRooms;
    const cols = h.nights.map(n => `<th class="num">${esc(wd(n))}</th>`).join("");

    const rows = h.grid.map((row, ri) => {
      const no = h.roomNos[ri] || "";
      return `
      <tr${ri >= booked ? ' class="unbooked"' : ""}>
        <td class="sticky-col">
          <div class="roomlab">
            <input class="roomno" type="text" inputmode="numeric" value="${esc(no)}"
                   placeholder="${ri + 1}" data-h="${h.id}" data-k="roomNo" data-r="${ri}"
                   aria-label="Room number for room ${ri + 1} at ${esc(h.name)}">
            <span class="rn">Room ${ri + 1}</span>
          </div>
        </td>
        ${row.map((cell, ni) => {
          const s = nightStatus(h, ni);
          const lab = no ? `room ${no}` : `room ${ri + 1}`;
          const inputs = Array.from({ length: SLOTS }, (_, g) => `
              <input type="text" value="${esc(cell[g])}" placeholder="G${g + 1}"
                     data-h="${h.id}" data-r="${ri}" data-n="${ni}" data-g="${g}"
                     enterkeyhint="next" autocomplete="off"
                     aria-label="${esc(lab)} guest ${g + 1}, ${esc(h.nights[ni])}">`).join("");
          return `<td${cell.some(Boolean) ? ' class="filled"' : ""} title="${esc(s.txt)}">
            <div class="gcell${cell[2] ? " has-third" : ""}">${inputs}</div></td>`;
        }).join("")}
        <td class="num rtot" title="guest-nights in this room">${roomGuests(h, ri)}</td>
      </tr>`;
    }).join("");

    const totalRow = (label, fn) => `
            <tr class="total" data-row="${label}"><td class="sticky-col">${label}</td>
              ${h.nights.map((_, i) => `<td class="num">${fn(i)}</td>`).join("")}</tr>`;

    return `<div class="panel">
      <div class="panel-h">
        <div><h3>${esc(h.name)}</h3>
          <div class="meta">
            <span>Check-in <b>${esc(h.checkIn)}</b></span>
            <span>Check-out <b>${esc(h.checkOut)}</b>${h.checkoutTime ? " at " + esc(h.checkoutTime) : ""}</span>
            <span class="bookedwrap">Rooms booked
              <input class="booked" type="number" inputmode="numeric" min="0" max="${h.totalRooms}"
                     value="${booked}" data-h="${h.id}" data-k="booked"
                     aria-label="Rooms booked at ${esc(h.name)}">
              of <b>${h.totalRooms}</b></span>
          </div>
        </div>
        <div class="statpills">${statPills(h, hs)}</div>
      </div>
      <div class="sumcards">${sumCards(h, hs)}</div>
      <div class="table-scroll">
        <table class="grid">
          <thead><tr><th>Room</th>${cols}<th class="num" title="guest-nights in this room">G-nights</th></tr></thead>
          <tbody>${rows}
            ${totalRow("Filled", i => filledRooms(h, i))}
            ${totalRow("Needed", i => h.needed[i])}
            ${totalRow("Guests", i => nightGuests(h, i))}
            ${totalRow("3rd guests", i => nightThird(h, i))}
            <tr class="total" data-row="status"><td class="sticky-col">Status</td>
              ${h.nights.map((_, i) => { const s = nightStatus(h, i);
                return `<td class="num"><span class="pill ${s.cls}">${esc(s.txt)}</span></td>`; }).join("")}</tr>
          </tbody>
        </table>
      </div>
      <ul class="notes">${h.notes.map(n => `<li>${esc(n)}</li>`).join("")}</ul>
    </div>`;
  }).join("");
}

/* ------------------------------------------------------------- mobile sheet
   One room at a time. mSel remembers which room is open per hotel so a repaint
   never throws the person back to room 1. */
const mSel = {};
function mRoom(h) {
  const i = Math.min(Math.max(0, mSel[h.id] ?? 0), Math.max(0, h.grid.length - 1));
  mSel[h.id] = i;
  return i;
}
function mobileStatsPills(h, ri) {
  const n = roomNights(h, ri), g = roomGuests(h, ri), t = roomThird(h, ri);
  const booked = h.roomsBooked ?? h.totalRooms;
  return `<span class="pill ${ri >= booked ? "none" : "ok"}">${n} night${n === 1 ? "" : "s"} used</span>
          <span class="pill none">${g} guest-night${g === 1 ? "" : "s"}</span>
          ${t ? `<span class="pill warn">${t} billable</span>` : ""}`;
}
function mobileChips(h) {
  const booked = h.roomsBooked ?? h.totalRooms;
  const sel = mRoom(h);
  return h.grid.map((row, ri) => {
    const no = h.roomNos[ri] || "";
    return `<button type="button" class="roomchip${ri >= booked ? " unbooked" : ""}${
        row.some(c => c[2]) ? " has-third" : ""}" data-h="${h.id}" data-r="${ri}"
        aria-pressed="${ri === sel}">
        ${no ? esc(no) : ri + 1}<small>Room ${ri + 1}</small></button>`;
  }).join("");
}
function renderRoomsMobile() {
  const host = $("#hotelMobile"); if (!host) return;
  host.innerHTML = st.hotels.map(h => {
    const hs = hotelStatus(h);
    const booked = h.roomsBooked ?? h.totalRooms;
    const ri = mRoom(h);
    const cols = h.nights.map(n => `<th>${esc(wd(n))}</th>`).join("");

    const rows = h.grid.map((row, ri) => {
      const bookedCls = ri >= booked ? " unbooked" : "";
      const filledCls = row.some(c => c.some(Boolean)) ? " filled" : "";
      const no = h.roomNos[ri] || "";
      const lab = no ? `room ${no}` : `room ${ri + 1}`;
      const cells = h.nights.map((_, ni) => {
        const cell = row[ni];
        const s = nightStatus(h, ni);
        const inputs = Array.from({ length: SLOTS }, (_, g) => `
              <input type="text" value="${esc(cell[g])}" placeholder="G${g + 1}"
                     data-h="${h.id}" data-r="${ri}" data-n="${ni}" data-g="${g}"
                     enterkeyhint="next" autocomplete="off"
                     aria-label="${esc(lab)} guest ${g + 1}, ${esc(h.nights[ni])}">`).join("");
        return `<td${cell.some(Boolean) ? ' class="filled"' : ""} title="${esc(s.txt)}">
            <div class="gcell${cell[2] ? " has-third" : ""}">${inputs}</div></td>`;
      }).join("");
      return `<tr class="${bookedCls}${filledCls}" data-r="${ri}">
        <td class="sticky-col">${no ? esc(no) : "Room " + (ri + 1)}</td>${cells}
        <td class="num rtot" title="guest-nights in this room">${roomGuests(h, ri)}</td>
      </tr>`;
    }).join("");

    const totalRow = (label, fn) => `
            <tr class="total" data-row="${label}"><td class="sticky-col">${label}</td>
              ${h.nights.map((_, i) => `<td class="num">${fn(i)}</td>`).join("")}
              <td class="num"></td></tr>`;

    return `<div class="panel">
      <div class="panel-h">
        <div><h3>${esc(h.name)}</h3>
          <div class="meta">
            <span>Check-in <b>${esc(h.checkIn)}</b></span>
            <span>Check-out <b>${esc(h.checkOut)}</b>${h.checkoutTime ? " at " + esc(h.checkoutTime) : ""}</span>
            <span class="bookedwrap">Rooms booked
              <input class="booked" type="number" inputmode="numeric" min="0" max="${h.totalRooms}"
                     value="${booked}" data-h="${h.id}" data-k="booked"
                     aria-label="Rooms booked at ${esc(h.name)}">
              of <b>${h.totalRooms}</b></span>
          </div>
        </div>
        <div class="statpills">${statPills(h, hs)}</div>
      </div>
      <div class="sumcards">${sumCards(h, hs)}</div>
      <div class="roomchips" role="group" aria-label="Choose a room at ${esc(h.name)}">${mobileChips(h)}</div>
      <div class="table-scroll">
        <table class="grid">
          <thead><tr><th>Room</th>${cols}<th class="num" title="guest-nights in this room">G-nights</th></tr></thead>
          <tbody>${rows}
            ${totalRow("Filled", i => filledRooms(h, i))}
            ${totalRow("Needed", i => h.needed[i])}
            ${totalRow("Guests", i => nightGuests(h, i))}
            ${totalRow("3rd guests", i => nightThird(h, i))}
            <tr class="total" data-row="status"><td class="sticky-col">Status</td>
              ${h.nights.map((_, i) => { const s = nightStatus(h, i);
                return `<td class="num"><span class="pill ${s.cls}">${esc(s.txt)}</span></td>`; }).join("")}
              <td class="num"></td></tr>
          </tbody>
        </table>
      </div>
      <ul class="notes">${h.notes.map(n => `<li>${esc(n)}</li>`).join("")}</ul>
    </div>`;
  }).join("");
}

/* Shared repaint for one panel in either layer. Must never touch an input, or
   the caret jumps. */
function paintPanelTotals(panel, h) {
  const hs = hotelStatus(h);
  const pills = panel.querySelector(".statpills");
  if (pills) pills.innerHTML = statPills(h, hs);
  const cards = panel.querySelector(".sumcards");
  if (cards) cards.innerHTML = sumCards(h, hs);
  return hs;
}

const VCOLS = [
  ["name",       "Vendor",     "text",   "g-id"],
  ["contact",    "Contact",    "text",   "g-contact"],
  ["phone",      "Phone",      "tel",    "g-contact"],
  ["whatsapp",   "WhatsApp",   "text",   "g-contact"],
  ["event",      "Event",      "text",   "g-event"],
  ["eventDate",  "Event date", "text",   "g-event"],
  ["quoted",     "Quoted",     "number", "g-money"],
  ["paid",       "Paid",       "number", "g-money"],
  ["paymentMode","Pay mode",   "text",   "g-pay"],
  ["ref",        "UTR / Ref",  "text",   "g-pay"],
  ["paidOn",     "Paid on",    "text",   "g-pay"],
  ["address",    "Address",    "text",   "g-detail"],
  ["notes",      "Notes",      "text",   "g-detail"],
];

function renderVendors() {
  const host = $("#vendorTable"); if (!host) return;
  host.innerHTML =
    `<thead><tr>${VCOLS.map(([k, l, t, g]) =>
      `<th class="${t === "number" ? "num " : ""}${g}">${l}</th>`).join("")}<th></th></tr></thead>
     <tbody>${st.vendors.map((v, i) => {
       const s = vendorStatus(v);
       return `<tr>
         <td class="sticky-col g-id"><input class="cell strong" type="text" value="${esc(v.name)}"
             data-v="${i}" data-f="name" aria-label="Vendor name"></td>
         ${VCOLS.slice(1).map(([k, l, t, g]) => `<td class="${t === "number" ? "num " : ""}${g}">
            <input class="cell" type="${t === "number" ? "number" : "text"}"
                   ${t === "number" ? 'min="0" step="500"' : ""}
                   value="${esc(v[k])}" data-v="${i}" data-f="${k}"
                   aria-label="${l} for vendor ${i + 1}"></td>`).join("")}
         <td class="num vstat"><span class="pill ${s.cls}">${s.txt}</span>
             ${s.bal !== undefined ? `<div class="dim">${inr(s.bal)} left</div>` : ""}</td>
         <td class="num"><button class="btn row-del" data-del="${i}"
             title="Remove this vendor" aria-label="Remove vendor ${i + 1}">&times;</button></td>
       </tr>`;
     }).join("")}</tbody>`;
  renderVendorSummary();
}

function renderInvoices() {
  const host = $("#invoicePanels"); if (!host) return;
  host.innerHTML = Object.entries(st.vendorDetails || {}).map(([name, d]) => {
    let body = "";
    if (d.kind === "invoice") {
      body = `<div class="table-scroll"><table class="grid">
        <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Total</th></tr></thead>
        <tbody>${d.items.map(i => `<tr><td>${esc(i[0])}</td><td class="num">${i[1]}</td>
          <td class="num">${inr(i[2])}</td><td class="num">${inr(i[3])}</td></tr>`).join("")}
          ${d.totals.map(([k, v]) => `<tr class="total"><td>${esc(k)}</td><td></td><td></td>
            <td class="num">${inr(v)}</td></tr>`).join("")}</tbody></table></div>
        ${d.terms ? `<p class="caption">${esc(d.terms)}</p>` : ""}
        ${d.pdf ? `<p class="caption"><a href="${esc(d.pdf)}" target="_blank" rel="noopener">Open the invoice PDF &#8599;</a></p>` : ""}`;
    } else {
      body = `<div class="table-scroll"><table class="grid">
        <tbody>
          ${d.booking.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}
          ${d.cost.map(([k, v]) => `<tr class="total"><td>${esc(k)}</td><td class="num">${inr(v)}</td></tr>`).join("")}
          ${d.contact.map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join("")}
        </tbody></table></div>`;
    }
    return `<details class="inv"${d.kind === "invoice" ? " open" : ""}>
      <summary>${esc(d.title || name)}</summary>
      <p class="caption">${esc(d.sub || "")}</p>${body}
      ${d.caption ? `<p class="caption dim">${esc(d.caption)}</p>` : ""}
    </details>`;
  }).join("");
}

/* ------------------------------------------------------------------- events */
const VNUM = new Set(["quoted", "paid"]);
// desktop grid inputs and mobile sheet inputs share this selector and the same
// data-* contract, so one handler serves both layers
const GNAME = ".gcell input, .ginput";

function refreshVendorRow(i) {
  const s = vendorStatus(st.vendors[i]);
  const td = $(`#vendorTable tbody tr:nth-child(${i + 1}) td.vstat`);
  if (td) td.innerHTML = `<span class="pill ${s.cls}">${s.txt}</span>` +
    (s.bal !== undefined ? `<div class="dim">${inr(s.bal)} left</div>` : "");
  renderVendorSummary();
}

function renderVendorSummary() {
  const host = $("#vendorSummary"); if (!host) return;
  const q = st.vendors.reduce((a, v) => a + (v.quoted || 0), 0);
  const p = st.vendors.reduce((a, v) => a + (v.paid  || 0), 0);
  const byCls = c => st.vendors.filter(v => vendorStatus(v).cls === c).length;
  host.innerHTML = [
    ["Total quoted", inr(q), ""],
    ["Total paid", inr(p), "ok"],
    ["Outstanding", inr(q - p), q - p > 0 ? "warn" : "ok"],
    ["Pending", byCls("warn"), ""], ["Paid", byCls("ok"), ""], ["Not quoted", byCls("none"), ""],
  ].map(([k, v, c]) =>
    `<div class="card ${c}"><div class="k">${k}</div><div class="v">${v}</div></div>`).join("");
}

function addVendor() {
  st.vendors.push({
    name: "", contact: "", phone: "", whatsapp: "", event: "", eventDate: "",
    quoted: "", paid: "", paymentMode: "", ref: "", paidOn: "",
    address: "", notes: "", row: null, isNew: true,
  });
  save(); renderAll();
  recordChange("Added a new vendor row");
  const rows = $$("#vendorTable tbody tr");
  const last = rows[rows.length - 1];
  last?.querySelector("input")?.focus();
  last?.scrollIntoView({ block: "center", behavior: "smooth" });
  flash("New vendor row added");
}

// last value seen per editable cell, so the change log shows old -> new
const lastVal = new Map();
function cellKey(t) {
  // hotel metadata inputs (room no / rooms booked) are keyed by kind, not cell
  if (t.dataset.k) return `${t.dataset.h}-${t.dataset.k}-${t.dataset.r ?? ""}`;
  return t.dataset.h ? `${t.dataset.h}-${t.dataset.r}-${t.dataset.n}-${t.dataset.g}` : `v-${t.dataset.v}-${t.dataset.f}`;
}
function baseVal(t) {
  if (t.dataset.k) {
    const h = base.hotels.find(x => x.id === t.dataset.h);
    return t.dataset.k === "booked" ? (h?.roomsBooked ?? "") : (h?.roomNos?.[+t.dataset.r] ?? "");
  }
  if (t.dataset.h) {
    const h = base.hotels.find(x => x.id === t.dataset.h);
    return h?.grid?.[+t.dataset.r]?.[+t.dataset.n]?.[+t.dataset.g] ?? "";
  }
  return base.vendors?.[+t.dataset.v]?.[t.dataset.f] ?? "";
}
function describeCell(t) {
  if (t.dataset.k) {
    const h = st.hotels.find(x => x.id === t.dataset.h);
    return t.dataset.k === "booked"
      ? `Rooms booked at ${h.name}`
      : `Room number for room ${+t.dataset.r + 1} at ${h.name}`;
  }
  if (t.dataset.h) {
    const h = st.hotels.find(x => x.id === t.dataset.h);
    return `Guest ${+t.dataset.g + 1}, Room ${+t.dataset.r + 1}, ${h.nights[+t.dataset.n]} (${h.name})`;
  }
  const v = st.vendors[+t.dataset.v];
  const label = VCOLS.find(([k]) => k === t.dataset.f)?.[1] || t.dataset.f;
  return `${label} of "${(v?.name || "untitled").trim()}"`;
}
function recordEdit(t) {
  const key = cellKey(t);
  const old = lastVal.has(key) ? lastVal.get(key) : baseVal(t);
  const now = t.value;
  if (String(old) === String(now)) return;
  lastVal.set(key, now);
  recordChange(`${describeCell(t)}: ${old === "" ? "(empty)" : `"${old}"`} → ${now === "" ? "(empty)" : `"${now}"`}`);
}

// repaint the desktop grid's derived numbers for one hotel, caret untouched
function refreshRows(hid) {
  const h = st.hotels.find(x => x.id === hid);
  if (!h) return;
  // scope by panel: the first [data-h] match is the Rooms-booked input, which
  // sits outside the grid table, so .closest("table") from it finds nothing.
  const panel = $(`#hotelPanels [data-h="${hid}"]`)?.closest(".panel");
  const body = panel?.querySelector("table.grid tbody");
  if (!body) return;
  const rowFor = label => body.querySelector(`tr.total[data-row="${label}"]`);
  const paint = (label, fn) => rowFor(label)?.querySelectorAll("td.num")
    .forEach((td, i) => { td.textContent = fn(i); });
  paint("Filled",  i => filledRooms(h, i));
  paint("Needed",  i => h.needed[i]);
  paint("Guests",  i => nightGuests(h, i));
  paint("3rd guests", i => nightThird(h, i));
  rowFor("status")?.querySelectorAll("td.num").forEach((td, i) => {
    const s = nightStatus(h, i);
    td.innerHTML = `<span class="pill ${s.cls}">${esc(s.txt)}</span>`;
  });
  const booked = h.roomsBooked ?? h.totalRooms;
  body.querySelectorAll("tr:not(.total)").forEach((tr) => {
    const ri = +tr.querySelector(".roomno")?.dataset.r;
    tr.classList.toggle("unbooked", ri >= booked);
    const rt = tr.querySelector(".rtot");
    if (rt && Number.isFinite(ri)) rt.textContent = roomGuests(h, ri);
  });
  paintPanelTotals(panel, h);
}

// same idea for the phone sheet: chips carry no text fields, so rebuilding them
// is safe; the sheet itself is only ever patched, never re-rendered.
function refreshMobile(hid) {
  const h = st.hotels.find(x => x.id === hid);
  if (!h) return;
  const panel = $(`#hotelMobile [data-h="${hid}"]`)?.closest(".panel");
  if (!panel) return;
  paintPanelTotals(panel, h);
  const chips = panel.querySelector(".roomchips");
  if (chips) chips.innerHTML = mobileChips(h);
  const sheet = panel.querySelector(".msheet");
  if (!sheet) return;
  const ri = mRoom(h);
  sheet.querySelectorAll(".mnight").forEach((el) => {
    const ni = +el.dataset.n;
    const s = nightStatus(h, ni);
    const sp = el.querySelector(".s");
    if (sp) { sp.className = "s " + s.cls; sp.textContent = `${s.f} of ${s.need} rooms · ${s.txt}`; }
    el.querySelectorAll(".mg.slot3").forEach(g =>
      g.classList.toggle("on", !!(h.grid[ri][ni][2])));
  });
  const stats = sheet.querySelector(".mstats");
  if (stats) stats.innerHTML = mobileStatsPills(h, ri);
  sheet.querySelectorAll("[data-nav]").forEach(b => {
    if (b.dataset.nav === "prev") {
      b.disabled = ri === 0;
      b.innerHTML = `&larr; Room ${ri > 0 ? ri : 1}`;
    } else {
      b.disabled = ri >= h.grid.length - 1;
      b.innerHTML = `Room ${ri + 2} &rarr;`;
    }
  });
}

// one handler, both layers
function onEditInput(t) {
  if (t.matches(GNAME) && t.dataset.g !== undefined) {
    const h = st.hotels.find(x => x.id === t.dataset.h);
    if (!h) return;
    h.grid[+t.dataset.r][+t.dataset.n][+t.dataset.g] = t.value;
    save(); renderOverview();
    const cell = t.closest(".gcell");
    if (cell) {
      const td = t.closest("td");
      if (td) td.classList.toggle("filled", $$("input", cell).some(i => i.value));
      const third = cell.querySelector('[data-g="2"]');
      cell.classList.toggle("has-third", !!third?.value);
    }
    t.closest(".mg.slot3")?.classList.toggle("on", !!t.value);
    refreshRows(t.dataset.h);
    refreshMobile(t.dataset.h);
  }
  if (t.matches(".roomno")) {
    const h = st.hotels.find(x => x.id === t.dataset.h);
    h.roomNos[+t.dataset.r] = t.value;
    save(); refreshRows(t.dataset.h); refreshMobile(t.dataset.h);
  }
  if (t.matches(".booked")) {
    const h = st.hotels.find(x => x.id === t.dataset.h);
    const n = t.value === "" ? 0 : Number(t.value);
    // the workbook only has as many physical rows as Total rooms
    const v = Number.isFinite(n) ? Math.max(0, Math.min(h.totalRooms, n)) : h.totalRooms;
    h.roomsBooked = v;
    if (t.value !== String(v)) t.value = v;   // reflect the clamp
    save(); renderOverview(); renderRooms();
  }
  if (t.matches("input.cell")) {
    const i = +t.dataset.v, f = t.dataset.f;
    st.vendors[i][f] = VNUM.has(f) ? (t.value === "" ? "" : Number(t.value)) : t.value;
    save(); renderOverview(); refreshVendorRow(i);
  }
}

function wire() {
  document.addEventListener("input", e => onEditInput(e.target));

  // A finished edit: record it, and if we still do not know who this is, ask.
  document.addEventListener("change", e => {
    const t = e.target;
    if (!(t.matches(GNAME) || t.matches(".roomno") || t.matches(".booked") || t.matches("input.cell")))
      return;
    recordEdit(t);
    if (nameMissing()) ensureName(
      "Every change is recorded with the name of the person who made it, so the " +
      "couple can always ask you about it. It stays on this device.");
  });

  // remember the person's name on this device (both copies of the input)
  for (const id of ["#yourName", "#yourNameBar"]) {
    const el = $(id); if (!el) continue;
    el.addEventListener("input", () => {
      setName(el.value);
      const other = $(id === "#yourName" ? "#yourNameBar" : "#yourName");
      if (other) { other.value = el.value; other.dataset.empty = el.dataset.empty; }
    });
  }

  // room picker + prev/next on the phone sheet
  document.addEventListener("click", e => {
    const chip = e.target.closest(".roomchip");
    if (chip) {
      mSel[chip.dataset.h] = +chip.dataset.r;
      renderRoomsMobile();
      return;
    }
    const nav = e.target.closest("[data-nav]");
    if (nav) {
      const h = st.hotels.find(x => x.id === nav.dataset.h);
      if (!h) return;
      const dir = nav.dataset.nav === "next" ? 1 : -1;
      mSel[h.id] = Math.min(Math.max(0, mRoom(h) + dir), h.grid.length - 1);
      renderRoomsMobile();
      const sheet = $(`#hotelMobile .msheet[data-h="${h.id}"]`);
      sheet?.scrollIntoView({ block: "start", behavior: "smooth" });
    }
  });

  // Enter walks down the current column instead of submitting the page
  document.addEventListener("keydown", e => {
    if (e.key !== "Enter") return;
    const t = e.target;
    if (!t.matches(GNAME) && !t.matches(".roomno")) return;
    e.preventDefault();
    const scope = t.closest(".gcell, .msheet, .roomlab") || document;
    const all = [...scope.querySelectorAll(GNAME + ", .roomno")]
      .filter(i => i.dataset.h === t.dataset.h);
    const i = all.indexOf(t);
    if (i > -1 && all[i + 1]) { all[i + 1].focus(); all[i + 1].select?.(); }
  });

  // remove a vendor row
  $("#vendorTable").addEventListener("click", e => {
    const b = e.target.closest("[data-del]");
    if (!b) return;
    const v = st.vendors[+b.dataset.del];
    if (!confirm(`Remove "${(v.name || "untitled").trim()}" from the vendor list?`)) return;
    st.vendors.splice(+b.dataset.del, 1);
    save(); renderAll(); flash("Vendor removed");
    recordChange(`Removed vendor "${(v.name || "untitled").trim()}"`);
  });

  $("#btnAddVendor").onclick = addVendor;
  $("#tabs").addEventListener("click", e => {
    const b = e.target.closest(".tab"); if (!b) return;
    $$(".tab").forEach(t => t.classList.toggle("active", t === b));
    $$(".view").forEach(v => v.hidden = v.id !== "view-" + b.dataset.view);
  });
  $("#btnPrint").onclick = () => window.print();

  $("#btnSync").onclick = () => window.RealtimeSync?.queueSave();
  const bar = $("#btnSyncBar");
  if (bar) bar.onclick = () => window.RealtimeSync?.queueSave();

  $("#btnReset").onclick = () => {
    if (!confirm("Discard your edits on this device and reload the latest shared data?")) return;
    clearTimeout(saveT); saveT = 0; saveDirty = false;
    localStorage.removeItem(KEY); localStorage.setItem(PENDING_KEY, "0");
    st = JSON.parse(JSON.stringify(base));
    renderAll(); flash("Reset");
    recordChange("Reset — discarded local edits and reloaded shared data");
  };
}

/* --------------------------------------------------------------------- boot */
(async function () {
  base = normalize(await loadData());
  const saved = JSON.parse(localStorage.getItem(KEY) || "null");
  // "1" = edits not yet pushed to shared state. null = a browser that predates the
  // marker, whose snapshot we keep rather than silently dropping.
  const pending = localStorage.getItem(PENDING_KEY);
  if (saved && pending !== "0") {
    st = normalize(saved);
    // Keep the latest reference details even when an older snapshot predates them.
    st.vendorDetails = base.vendorDetails;
  } else {
    // Nothing outstanding: the shared snapshot is the source of truth.
    st = JSON.parse(JSON.stringify(base));
    localStorage.removeItem(KEY);
    localStorage.setItem(PENDING_KEY, "0");
  }
  // A snapshot taken before this feature has fewer room rows than the export;
  // keep whatever the person typed rather than padding it away.
  for (const b of base.hotels) {
    const s = st.hotels.find(x => x.id === b.id);
    if (s) s.grid = s.grid.slice(0, Math.max(b.grid.length, s.grid.length));
  }
  $("#eventName").textContent = (base.event || "").replace(/^Wedding\s*[-–]\s*/i, "") || base.event;
  $("#genDate").textContent = base.generated;
  setName(localStorage.getItem(NAME_KEY) || "");
  renderAll(); wire();
  window.RealtimeSync?.start({
    getState: () => st,
    setState: value => { st = normalize(value); },
    setBase: value => { base = normalize(value); },
    getName: currentName,
    ensureName,
    render: renderAll,
    status: syncStatus,
    hasPending: localStorage.getItem(PENDING_KEY) === "1",
  });
  const s0 = $("#saveState"); if (s0) s0.textContent = "Auto-saved";
})();