/* Wedding tracker — edits stay in localStorage until the user presses Sync.
   A fresh data.json (exported from the workbook) is the baseline to reset to.

   v14 changes
   -----------
   * Manual sync: guest and vendor edits stay on this device until Sync is
     pressed. The name and password prompts are shown only for that action.
   * Mobile entry layer: a room picker plus a one-room-at-a-time sheet, so
     filling 10 rooms x 6 nights x 3 guests is a vertical scroll, not a
     horizontal one. The desktop grid is unchanged and still drives both paths.
   * Data exchange:
       - Supabase and the workbook export are requested fresh on each load.
         A last-known snapshot is retained only for offline fallback.
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
const CACHE_KEY = "wedding-tracker-cache-v1";       // last-known snapshot for offline fallback
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// Raw GitHub serves data.json as soon as the workbook workflow commits it.
const DATA_URL = "https://raw.githubusercontent.com/surajsingh81/wedding_tracker/main/data.json";

let base = null;   // last shared snapshot, initially loaded from the workbook export
let st   = null;   // live state = base + local edits

/* ------------------------------------------------------ fresh baseline load
   Always prefer an uncached database/workbook read. The local snapshot is an
   offline-only fallback, never a freshness shortcut. */
function readCache() {
  try { return JSON.parse(localStorage.getItem(CACHE_KEY) || "null"); }
  catch { return null; }
}
function writeCache(data) {
  try { localStorage.setItem(CACHE_KEY, JSON.stringify({ data })); }
  catch { /* quota — the cache is an optimisation, never a requirement */ }
}
function discardLocalDraft() {
  localStorage.removeItem(KEY);
  localStorage.setItem(PENDING_KEY, "0");
}
async function loadData() {
  const shared = await window.RealtimeSync?.load();
  if (shared) return shared;
  const cache = readCache();
  const noCache = {
    "Cache-Control": "no-cache, no-store, max-age=0",
    Pragma: "no-cache",
  };
  try {
    const url = new URL(DATA_URL);
    url.searchParams.set("fresh", `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const response = await fetch(url, { cache: "no-store", headers: noCache });
    if (!response.ok) throw new Error(`Fresh workbook data request failed (HTTP ${response.status})`);
    const data = await response.json();
    writeCache(data);
    return data;
  } catch (error) {
    console.warn("Fresh GitHub workbook data could not be loaded.", error);
  }

  try {
    const url = new URL("data.json", window.location.href);
    url.searchParams.set("fresh", `${Date.now()}-${Math.random().toString(36).slice(2)}`);
    const response = await fetch(url, { cache: "no-store", headers: noCache });
    if (!response.ok) throw new Error(`Website data request failed (HTTP ${response.status})`);
    const data = await response.json();
    writeCache(data);
    return data;
  } catch (error) {
    console.warn("Fresh website data could not be loaded.", error);
  }

  if (cache?.data) {
    syncStatus("Could not reach Supabase or a fresh workbook export. Showing this device's offline snapshot.", "msg-warn");
    return cache.data;
  }
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
    const defaultPrebooked = Number.isFinite(+h.roomsBooked) ? +h.roomsBooked : h.totalRooms;
    h.needed = Array.from({ length: nights.length }, (_, i) => {
      const count = h.needed?.[i] == null ? defaultPrebooked : Number(h.needed[i]);
      return Number.isFinite(count) ? Math.max(0, Math.min(h.totalRooms, Math.floor(count))) : 0;
    });
    h.roomsBooked = Math.max(0, ...h.needed);
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

const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
  "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const newHotelNightCounts = {};
function formatTrackerDate(iso) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(iso);
  if (!match) return "";
  const [, year, month, day] = match;
  return `${day}-${MONTHS[+month - 1]}-${year}`;
}
function hotelNightsFromDates(checkIn, checkOut) {
  const start = Date.parse(`${checkIn}T00:00:00Z`);
  const end = Date.parse(`${checkOut}T00:00:00Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) return [];
  const count = (end - start) / 86400000;
  if (count > 90) return [];
  return Array.from({ length: count }, (_, i) =>
    formatTrackerDate(new Date(start + i * 86400000).toISOString().slice(0, 10)));
}
function trackerDateToISO(value) {
  const match = /^(\d{2})-([A-Za-z]{3})-(\d{4})$/.exec(value);
  if (!match) return "";
  const month = MONTHS.findIndex(m => m.toLowerCase() === match[2].toLowerCase()) + 1;
  return month ? `${match[3]}-${String(month).padStart(2, "0")}-${match[1]}` : "";
}
function hotelId(name) {
  const slug = String(name).normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
    .toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return slug || "hotel";
}
function makeHotel(name, checkIn, checkOut, capacity, needed) {
  const nights = hotelNightsFromDates(checkIn, checkOut);
  const totalRooms = Math.floor(Number(capacity));
  if (!nights.length || !Number.isFinite(totalRooms) || totalRooms < 1 || totalRooms > 500)
    return null;
  const counts = nights.map((_, i) =>
    Math.max(0, Math.min(totalRooms, Math.floor(Number(needed[i]) || 0))));
  return {
    id: hotelId(name), name: name.trim(), checkIn: formatTrackerDate(checkIn),
    checkOut: formatTrackerDate(checkOut), checkoutTime: "", totalRooms,
    roomsBooked: Math.max(0, ...counts), roomNos: Array(totalRooms).fill(""),
    totalRoomNights: counts.reduce((a, b) => a + b, 0), nights, needed: counts,
    grid: Array.from({ length: totalRooms }, () =>
      nights.map(() => Array(SLOTS).fill(""))),
    notes: [],
  };
}

function renderNewHotelNights() {
  const host = $("#newHotelNights");
  if (!host) return;
  const dates = hotelNightsFromDates($("#newHotelCheckIn")?.value || "",
    $("#newHotelCheckOut")?.value || "");
  if (!dates.length) {
    host.innerHTML = '<p class="dim">Choose a check-in and later check-out date (up to 90 nights).</p>';
    return;
  }
  const capacity = Math.max(1, Math.min(500, Math.floor(Number($("#newHotelCapacity")?.value) || 1)));
  host.innerHTML = dates.map(date => {
    const key = trackerDateToISO(date);
    const count = Math.max(0, Math.min(capacity, Math.floor(Number(newHotelNightCounts[key]) || 0)));
    newHotelNightCounts[key] = String(count);
    return `<div class="hotel-night-count"><label>${esc(wd(date))} · pre-booked rooms
      <input class="new-hotel-prebooked" type="number" min="0" max="${capacity}"
        value="${count}" data-night="${key}" inputmode="numeric" aria-label="${esc(date)} pre-booked rooms"></label></div>`;
  }).join("");
}

function addHotelFromForm(event) {
  event.preventDefault();
  const error = $("#hotelFormError");
  const name = ($("#newHotelName")?.value || "").trim();
  const checkIn = $("#newHotelCheckIn")?.value || "";
  const checkOut = $("#newHotelCheckOut")?.value || "";
  const capacity = Number($("#newHotelCapacity")?.value);
  const nights = hotelNightsFromDates(checkIn, checkOut);
  const invalidSheetChars = /[\\\/:*?\[\]]/.test(name);
  const nameTaken = st.hotels.some(h => h.name.toLowerCase() === name.toLowerCase()
    || h.id === hotelId(name));
  const reservedSheetNames = ["vendors", ...Object.keys(st.vendorDetails || {})];
  const reserved = reservedSheetNames.some(sheet => sheet.toLowerCase() === name.toLowerCase());
  if (!name || name.length > 31 || invalidSheetChars) {
    error.textContent = "Enter a hotel name up to 31 characters. Excel sheet names cannot contain \\ / ? * : [ or ].";
    return;
  }
  if (nameTaken || reserved) {
    error.textContent = "That name is already used by a hotel or workbook sheet.";
    return;
  }
  if (!nights.length) {
    error.textContent = "Choose a check-out date after check-in, with a stay of up to 90 nights.";
    return;
  }
  if (!Number.isInteger(capacity) || capacity < 1 || capacity > 500) {
    error.textContent = "Enter the maximum number of rooms available (1–500).";
    return;
  }
  const counts = nights.map(date => {
    const count = Number(newHotelNightCounts[trackerDateToISO(date)] || 0);
    return Math.max(0, Math.min(capacity,
      Number.isFinite(count) ? Math.floor(count) : 0));
  });
  const hotel = makeHotel(name, checkIn, checkOut, capacity, counts);
  if (!hotel) {
    error.textContent = "The hotel details could not be created. Check the dates and room counts.";
    return;
  }
  if (st.hotels.some(h => h.id === hotel.id)) {
    error.textContent = "The hotel name creates a duplicate tracker ID. Use a more distinct name.";
    return;
  }
  st.hotels.push(hotel);
  mSel[hotel.id] = 0;
  save();
  recordChange(`Added hotel "${hotel.name}" with ${hotel.nights.length} night(s)`);
  $("#hotelForm").reset();
  $("#newHotelCapacity").value = "1";
  Object.keys(newHotelNightCounts).forEach(key => delete newHotelNightCounts[key]);
  renderNewHotelNights();
  $("#addHotelPanel").open = false;
  renderAll();
  flash("Hotel added — enter guest names in its room list");
}

// Signature of every editable field — used to detect when the workbook has
// absorbed a save (the API copy then matches the live state).
function dataSig(d) {
  return JSON.stringify([
    d.hotels.map(h => [h.id, h.name, h.checkIn, h.checkOut, h.nights,
      h.totalRooms, h.needed, h.grid, h.roomsBooked, h.roomNos]),
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
// much of the reserved block has guest details entered.
function hotelStats(h) {
  const guestNights = h.grid.reduce((a, row) =>
    a + row.reduce((x, cell) => x + cell.filter(Boolean).length, 0), 0);
  const thirdNights = h.grid.reduce((a, row) =>
    a + row.filter(cell => cell[2]).length, 0);
  const prebookedRoomNights = h.needed.reduce((a, b) => a + (b || 0), 0);
  const filled = h.nights.reduce((a, _, i) => a + filledRooms(h, i), 0);
  const booked = h.roomsBooked ?? h.totalRooms;
  return { guestNights, thirdNights, prebookedRoomNights, filled, booked,
           thirdGuests: h.grid.reduce((a, row) =>
             a + row.reduce((x, cell) => x + (cell[2] ? 1 : 0), 0), 0) };
}
// Hotel-wide reservation totals are distinct from rooms with guest details;
// current reflects whether the first night's pre-booked rooms have details.
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
  const f = filledRooms(h, ni), prebooked = h.needed[ni] || 0;
  if (f === prebooked) return {
    f, prebooked, cls: "ok",
    txt: prebooked ? "All pre-booked rooms have guest details" : "No rooms pre-booked",
  };
  if (f < prebooked) return {
    f, prebooked, cls: "short",
    txt: `${prebooked - f} pre-booked room${prebooked - f === 1 ? "" : "s"} missing guest details`,
  };
  const extra = f - prebooked;
  return {
    f, prebooked, cls: "over",
    txt: `${extra} room${extra === 1 ? "" : "s"} ${extra === 1 ? "has" : "have"} guest details beyond the pre-booked count`,
  };
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
  if (!saveT && !saveDirty) return true;
  clearTimeout(saveT); saveT = 0; saveDirty = false;
  try {
    localStorage.setItem(KEY, JSON.stringify(st));
    localStorage.setItem(PENDING_KEY, "1");   // not yet in shared state
  } catch (e) {
    flash("Could not save (storage full?)");
    return false;
  }
  setSaveIndicator(true);
  syncStatus("Unsaved Sync — saved only on this device. Tap Sync changes to share it; refreshing discards it.", "msg-warn");
  return true;
}
function save() {
  saveDirty = true;
  setSaveIndicator(true);
  flash("Unsaved Sync");
  syncStatus("Unsaved Sync — this edit is only on this device until you tap Sync changes.", "msg-warn");
  clearTimeout(saveT);
  saveT = setTimeout(flushSave, 250);
}
// never lose an edit to a backgrounded tab or a closed lid
addEventListener("visibilitychange", () => { if (document.visibilityState === "hidden") flushSave(); });
addEventListener("pagehide", flushSave);
let flashT;
function setSaveIndicator(pending) {
  const label = pending ? "Unsaved Sync · saved here" : "Data Synced";
  for (const id of ["#saveState", "#saveStateBar"]) {
    const el = $(id); if (!el) continue;
    el.textContent = label;
    el.dataset.pending = pending ? "1" : "0";
  }
  for (const id of ["#btnSync", "#btnSyncBar"]) {
    const el = $(id); if (el) el.dataset.pending = pending ? "1" : "0";
  }
}
function flash(msg) {
  for (const id of ["#saveState", "#saveStateBar"]) {
    const el = $(id); if (!el) continue;
    el.textContent = msg;
    clearTimeout(el._t);
    el._t = setTimeout(() => setSaveIndicator(localStorage.getItem(PENDING_KEY) === "1"), 2500);
  }
}

function setPending(pending) {
  try {
    if (pending) {
      localStorage.setItem(KEY, JSON.stringify(st));
      localStorage.setItem(PENDING_KEY, "1");
    } else {
      localStorage.removeItem(KEY);
      localStorage.setItem(PENDING_KEY, "0");
    }
  } catch (e) {
    flash("Could not update local save (storage full?)");
    return false;
  }
  setSaveIndicator(pending);
  return true;
}

function setSyncBusy(busy) {
  const labels = [["#btnSync", "Sync changes"], ["#btnSyncBar", "Sync"]];
  for (const [id, label] of labels) {
    const el = $(id);
    if (!el) continue;
    el.disabled = busy;
    el.textContent = busy ? "Syncing…" : label;
  }
}

let syncToastTimer = 0;
function reportRealtimeStatus(message, cls) {
  syncStatus(message, cls);
  const shouldShow = cls === "msg-error" || message.startsWith("Data Synced")
    || message.startsWith("Sending changes") || message.startsWith("Sync cancelled")
    || message.startsWith("Shared updates received");
  const toast = $("#syncToast");
  if (!toast || !shouldShow) return;
  clearTimeout(syncToastTimer);
  toast.textContent = message;
  toast.className = `sync-toast ${cls || ""}`;
  toast.hidden = false;
  syncToastTimer = setTimeout(() => { toast.hidden = true; }, 7000);
}

/* ------------------------------------------------------------- the name gate
   Sync asks for the user's name first, then requests the password. */
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
  const changes = getChanges();
  let attributed = false;
  changes.forEach(change => {
    if (change.who === "Pending") { change.who = s; attributed = true; }
  });
  if (attributed) {
    localStorage.setItem(CHANGES_KEY, JSON.stringify(changes));
    renderChanges();
  }
  return s;
}
function nameMissing() { return !currentName(); }

function requestName(why) {
  if (namePrompt) return namePrompt;
  nameAsked = false;
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

function ensureName(why, force) {
  if (!nameMissing()) return Promise.resolve(true);
  if (nameAsked && !force) return Promise.resolve(false);   // don't nag mid-edit
  return requestName(why);
}

/* --------------------------------------------------------------- change log */
function getChanges() {
  try { return JSON.parse(localStorage.getItem(CHANGES_KEY) || "[]"); }
  catch { return []; }
}
function recordChange(what) {
  const who = currentName() || "Pending";
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
  let fillTot = 0, missingDetails = 0, extraDetails = 0;
  for (const h of st.hotels)
    h.nights.forEach((_, i) => {
      const s = nightStatus(h, i);
      fillTot += s.f;
      missingDetails += Math.max(0, s.prebooked - s.f);
      extraDetails += Math.max(0, s.f - s.prebooked);
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
    ["Room-nights pre-booked", needTot, `${st.hotels.length} hotels`],
    ["Room-nights with guest details", fillTot,
      missingDetails ? `${missingDetails} pre-booked room-night${missingDetails === 1 ? "" : "s"} missing details` :
        extraDetails ? `Review ${extraDetails} room-night${extraDetails === 1 ? "" : "s"} beyond the pre-booked count` :
          "All pre-booked rooms have details",
      missingDetails || extraDetails ? "warn" : "ok"],
    ["Guest-nights", guestNights, `${roomsInUse} room${roomsInUse === 1 ? "" : "s"} with guest details`],
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
      const pct = s.prebooked ? Math.min(100, (s.f / s.prebooked) * 100) : 0;
      return `<div class="night">
        <div class="night-h"><span class="d">${esc(wd(n))}</span>
          <span class="s ${s.cls}">${s.f} of ${s.prebooked} pre-booked rooms have guest details &middot; ${esc(s.txt)}</span></div>
        <div class="track"><div class="fill ${s.cls}" style="width:${pct}%"></div></div>
      </div>`;
    }).join("")).join("");
}

/* Header pills + summary cards, kept as their own renderers so a live edit can
   repaint them without rebuilding the whole panel (which would eat the caret). */
function statPills(h, hs) {
  return `
          <span class="pill ${hs.booked.cls}" title="rooms reserved at this hotel vs total rooms available">Reserved ${esc(hs.booked.txt)}</span>
          <span class="pill ${hs.fill.cls}" title="reserved rooms with at least one guest name">Guest details ${esc(hs.fill.txt)}</span>
          <span class="pill ${hs.current.cls}" title="${esc(h.nights[0])}: ${esc(hs.current.f)} of ${esc(hs.current.prebooked)} pre-booked rooms have guest details">${esc(wd(h.nights[0]))} ${esc(hs.current.txt)}</span>`;
}

function sumCards(h, hs) {
  const booked = h.roomsBooked ?? h.totalRooms;
  return `
        <div class="sumcard"><div class="k">Guest-nights</div><div class="v">${hs.guestNights}</div><div class="n">${hs.filled} pre-booked room-night${hs.filled === 1 ? "" : "s"} with guest details of ${hs.prebookedRoomNights}</div></div>
        <div class="sumcard"><div class="k">Rooms with Guest</div><div class="v">${hs.roomsInUse}</div><div class="n">of ${booked} rooms available at this hotel</div></div>
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
            <span class="bookedwrap">Maximum pre-booked rooms
              <input class="booked" type="number" value="${booked}" data-h="${h.id}"
                     aria-label="Maximum pre-booked rooms at ${esc(h.name)}" disabled>
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
            ${totalRow("Rooms with Guest", i => filledRooms(h, i))}
            <tr class="total" data-row="Pre-Booked Rooms">
              <td class="sticky-col">Pre-Booked Rooms</td>
              ${h.nights.map((night, i) => `<td class="num"><input class="prebooked-count"
                type="number" inputmode="numeric" min="0" max="${h.totalRooms}" value="${h.needed[i]}"
                data-h="${h.id}" data-n="${i}" aria-label="${h.name}: pre-booked rooms for ${night}"></td>`).join("")}
            </tr>
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
        aria-pressed="${ri === sel}" aria-label="Edit Room ${ri + 1}${
          no ? `, hotel room ${esc(no)}` : ", hotel room number not entered"}">
        ${no ? esc(no) : ri + 1}<small>${ri === sel ? "Selected · " : ""}Room ${ri + 1}</small></button>`;
  }).join("");
}
function renderRoomsMobile() {
  const host = $("#hotelMobile"); if (!host) return;
  host.innerHTML = st.hotels.map(h => {
    const hs = hotelStatus(h);
    const booked = h.roomsBooked ?? h.totalRooms;
    const ri = mRoom(h);
    const cols = h.nights.map(n => `<th>${esc(wd(n))}</th>`).join("");

    const row = h.grid[ri];
    const rows = [row].filter(Boolean).map((row) => {
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
            <span class="bookedwrap">Maximum pre-booked rooms
              <input class="booked" type="number" value="${booked}" data-h="${h.id}"
                     aria-label="Maximum pre-booked rooms at ${esc(h.name)}" disabled>
              of <b>${h.totalRooms}</b></span>
          </div>
        </div>
        <div class="statpills">${statPills(h, hs)}</div>
      </div>
      <div class="sumcards">${sumCards(h, hs)}</div>
      <div class="roomchips" role="group" aria-label="Choose a room at ${esc(h.name)}">${mobileChips(h)}</div>
      <p class="room-picker-hint">Tap a room above to switch the guest fields and hotel room number shown below.</p>
      <div class="mroom-number">
        <label for="roomno-${esc(h.id)}-${ri + 1}">Actual hotel room number · Room ${ri + 1}</label>
        <input class="roomno" id="roomno-${esc(h.id)}-${ri + 1}" type="text" inputmode="numeric"
               value="${esc(h.roomNos[ri] || "")}" placeholder="Enter the room number"
               data-h="${h.id}" data-k="roomNo" data-r="${ri}"
               aria-label="Actual hotel room number for Room ${ri + 1} at ${esc(h.name)}">
      </div>
      <div class="table-scroll">
        <table class="grid">
          <thead><tr><th>Room</th>${cols}<th class="num" title="guest-nights in this room">G-nights</th></tr></thead>
          <tbody>${rows}
            ${totalRow("Rooms with Guest", i => filledRooms(h, i))}
            <tr class="total" data-row="Pre-Booked Rooms">
              <td class="sticky-col">Pre-Booked Rooms</td>
              ${h.nights.map((night, i) => `<td class="num"><input class="prebooked-count"
                type="number" inputmode="numeric" min="0" max="${h.totalRooms}" value="${h.needed[i]}"
                data-h="${h.id}" data-n="${i}" aria-label="${h.name}: pre-booked rooms for ${night}"></td>`).join("")}
              <td class="num"></td>
            </tr>
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
         <td class="sticky-col g-id" data-label="Vendor"><input class="cell strong" type="text" value="${esc(v.name)}"
             data-v="${i}" data-f="name" aria-label="Vendor name"></td>
         ${VCOLS.slice(1).map(([k, l, t, g]) => `<td class="${t === "number" ? "num " : ""}${g}" data-label="${l}">
            <input class="cell" type="${t === "number" ? "number" : "text"}"
                   ${t === "number" ? 'min="0" step="500"' : ""}
                   value="${esc(v[k])}" data-v="${i}" data-f="${k}"
                   aria-label="${l} for vendor ${i + 1}"></td>`).join("")}
         <td class="num vstat" data-label="Payment status"><span class="pill ${s.cls}">${s.txt}</span>
             ${s.bal !== undefined ? `<div class="dim">${inr(s.bal)} left</div>` : ""}</td>
         <td class="num vendor-remove"><button class="btn row-del" data-del="${i}"
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
  // hotel metadata inputs are keyed by kind, not guest-grid cell coordinates
  if (t.dataset.k) return `${t.dataset.h}-${t.dataset.k}-${t.dataset.r ?? ""}-${t.dataset.n ?? ""}`;
  if (t.matches(".prebooked-count"))
    return `${t.dataset.h}-prebooked-${t.dataset.n}`;
  return t.dataset.h ? `${t.dataset.h}-${t.dataset.r}-${t.dataset.n}-${t.dataset.g}` : `v-${t.dataset.v}-${t.dataset.f}`;
}
function baseVal(t) {
  if (t.dataset.k) {
    const h = base.hotels.find(x => x.id === t.dataset.h);
    return t.dataset.k === "booked" ? (h?.roomsBooked ?? "") : (h?.roomNos?.[+t.dataset.r] ?? "");
  }
  if (t.matches(".prebooked-count")) {
    const h = base.hotels.find(x => x.id === t.dataset.h);
    return h?.needed?.[+t.dataset.n] ?? "";
  }
  if (t.dataset.h) {
    const h = base.hotels.find(x => x.id === t.dataset.h);
    return h?.grid?.[+t.dataset.r]?.[+t.dataset.n]?.[+t.dataset.g] ?? "";
  }
  return base.vendors?.[+t.dataset.v]?.[t.dataset.f] ?? "";
}
function describeCell(t) {
  if (t.matches(".prebooked-count")) {
    const h = st.hotels.find(x => x.id === t.dataset.h);
    return `Pre-booked rooms for ${h.nights[+t.dataset.n]} at ${h.name}`;
  }
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
  // Scope by hotel panel so edits never rebuild the table and lose the caret.
  const panel = $(`#hotelPanels [data-h="${hid}"]`)?.closest(".panel");
  const body = panel?.querySelector("table.grid tbody");
  if (!body) return;
  const rowFor = label => body.querySelector(`tr.total[data-row="${label}"]`);
  const paint = (label, fn) => rowFor(label)?.querySelectorAll("td.num")
    .forEach((td, i) => { td.textContent = fn(i); });
  paint("Rooms with Guest", i => filledRooms(h, i));
  paint("Guests",  i => nightGuests(h, i));
  paint("3rd guests", i => nightThird(h, i));
  rowFor("Pre-Booked Rooms")?.querySelectorAll(".prebooked-count")
    .forEach((input, i) => { input.value = h.needed[i]; });
  panel?.querySelectorAll(".booked").forEach(el => {
    el.value = h.roomsBooked;
  });
  const hs = hotelStatus(h);
  panel?.querySelectorAll(".statpills").forEach(el => { el.innerHTML = statPills(h, hs); });
  panel?.querySelectorAll(".sumcards").forEach(el => { el.innerHTML = sumCards(h, hs); });
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
  panel.querySelectorAll(".booked").forEach(el => {
    el.value = h.roomsBooked;
  });
  const body = panel.querySelector("table.grid tbody");
  const rowFor = label => body?.querySelector(`tr.total[data-row="${label}"]`);
  const paint = (label, fn) => rowFor(label)?.querySelectorAll("td.num")
    .forEach((td, i) => { if (i < h.nights.length) td.textContent = fn(i); });
  paint("Rooms with Guest", i => filledRooms(h, i));
  paint("Guests", i => nightGuests(h, i));
  paint("3rd guests", i => nightThird(h, i));
  rowFor("Pre-Booked Rooms")?.querySelectorAll(".prebooked-count")
    .forEach((input, i) => { input.value = h.needed[i]; });
  rowFor("status")?.querySelectorAll("td.num").forEach((td, i) => {
    if (i >= h.nights.length) return;
    const status = nightStatus(h, i);
    td.innerHTML = `<span class="pill ${status.cls}">${esc(status.txt)}</span>`;
  });
  const chips = panel.querySelector(".roomchips");
  if (chips) chips.innerHTML = mobileChips(h);
  const sheet = panel.querySelector(".msheet");
  if (!sheet) return;
  const ri = mRoom(h);
  sheet.querySelectorAll(".mnight").forEach((el) => {
    const ni = +el.dataset.n;
    const s = nightStatus(h, ni);
    const sp = el.querySelector(".s");
    if (sp) { sp.className = "s " + s.cls; sp.textContent = `${s.f} of ${s.prebooked} pre-booked rooms have guest details · ${s.txt}`; }
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
  if (t.matches(".prebooked-count")) {
    const h = st.hotels.find(x => x.id === t.dataset.h);
    if (!h) return;
    const ni = +t.dataset.n;
    const raw = t.value === "" ? 0 : Number(t.value);
    const count = Number.isFinite(raw)
      ? Math.max(0, Math.min(h.totalRooms, Math.floor(raw))) : h.needed[ni];
    h.needed[ni] = count;
    h.roomsBooked = Math.max(0, ...h.needed);
    h.totalRoomNights = h.needed.reduce((sum, value) => sum + value, 0);
    t.value = String(count);
    save(); renderOverview(); refreshRows(t.dataset.h); refreshMobile(t.dataset.h);
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
  document.addEventListener("input", e => {
    const t = e.target;
    if (t.matches(".new-hotel-prebooked")) {
      newHotelNightCounts[t.dataset.night] = t.value;
      return;
    }
    onEditInput(t);
  });

  // Record edits locally without prompting; Sync asks for identity before upload.
  document.addEventListener("change", e => {
    const t = e.target;
    if (!(t.matches(GNAME) || t.matches(".roomno") || t.matches(".prebooked-count") || t.matches("input.cell")))
      return;
    recordEdit(t);
  });

  $("#hotelForm")?.addEventListener("submit", addHotelFromForm);
  for (const id of ["#newHotelCheckIn", "#newHotelCheckOut", "#newHotelCapacity"])
    $(id)?.addEventListener("input", renderNewHotelNights);
  $("#cancelAddHotel")?.addEventListener("click", () => {
    $("#hotelForm").reset();
    $("#newHotelCapacity").value = "1";
    Object.keys(newHotelNightCounts).forEach(key => delete newHotelNightCounts[key]);
    renderNewHotelNights();
    $("#addHotelPanel").open = false;
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
  $$(".btn-print").forEach(button => { button.onclick = () => {
    button.closest(".mobile-tools")?.removeAttribute("open");
    window.print();
  }; });

  $("#btnSync").onclick = () => window.RealtimeSync?.syncNow();
  const bar = $("#btnSyncBar");
  if (bar) bar.onclick = () => window.RealtimeSync?.syncNow();

  $$(".btn-reset").forEach(button => { button.onclick = () => {
    button.closest(".mobile-tools")?.removeAttribute("open");
    if (!confirm("Discard your edits on this device and reload the latest shared data?")) return;
    clearTimeout(saveT); saveT = 0; saveDirty = false;
    localStorage.removeItem(KEY); localStorage.setItem(PENDING_KEY, "0");
    setSaveIndicator(false);
    st = JSON.parse(JSON.stringify(base));
    renderAll(); flash("Reset");
    recordChange("Reset — discarded local edits and reloaded shared data");
  }; });
}

/* --------------------------------------------------------------------- boot */
(async function () {
  // Refresh always starts from shared data; unsynced drafts are intentionally
  // discarded rather than restored over changes made on another device.
  discardLocalDraft();
  base = normalize(await loadData());
  st = JSON.parse(JSON.stringify(base));
  $("#eventName").textContent = (base.event || "").replace(/^Wedding\s*[-–]\s*/i, "") || base.event;
  $("#genDate").textContent = base.generated;
  setName(localStorage.getItem(NAME_KEY) || "");
  renderAll(); wire();
  setSaveIndicator(localStorage.getItem(PENDING_KEY) === "1");
  window.RealtimeSync?.start({
    getState: () => st,
    normalize,
    setState: value => { st = normalize(value); },
    setBase: value => { base = normalize(value); },
    getName: currentName,
    promptName: requestName,
    flushLocal: flushSave,
    setPending,
    setSyncBusy,
    render: renderAll,
    status: reportRealtimeStatus,
  });
})();