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
    const response = await fetch(url, { cache: "no-store" });
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
    const response = await fetch(url, { cache: "no-store" });
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
  d.invoices = Array.isArray(d.invoices) ? d.invoices : [];
  d.changeLog = Array.isArray(d.changeLog) ? d.changeLog : [];
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

function stayControls(h) {
  const rows = h.nights.map((night, i) => `<label class="stay-night-row"><span>${esc(wd(night))}<small>${esc(night)}</small></span>
    <input class="prebooked-count" type="number" min="0" max="${h.totalRooms}" value="${h.needed[i]}"
      data-h="${h.id}" data-n="${i}" inputmode="numeric" aria-label="${esc(h.name)} booked rooms for ${esc(night)}"></label>`).join("");
  return `<details class="stay-settings"><summary>Manage dates & rooms</summary>
    <div class="stay-settings-body"><p class="dim">Change the stay range or adjust booked rooms for any night. Guest names are kept for dates that remain in the stay.</p>
      <form class="update-stay-dates" data-h="${h.id}">
        <label>Check-in <input type="date" name="checkIn" value="${esc(trackerDateToISO(h.checkIn))}" required></label>
        <label>Check-out <input type="date" name="checkOut" value="${esc(trackerDateToISO(h.checkOut))}" required></label>
        <button class="btn small primary" type="submit">Update stay dates</button>
        <p class="form-error" data-date-error role="status"></p>
      </form>
      <div class="stay-night-list">${rows}</div>
      <form class="add-stay-night" data-h="${h.id}">
        <label>New date <input type="date" name="date" required></label>
        <label>Booked rooms <input type="number" name="count" min="0" max="${h.totalRooms}" value="0" required></label>
        <button class="btn small primary" type="submit">Add date</button>
        <p class="form-error" data-stay-error role="status"></p>
      </form>
    </div></details>`;
}

function updateStayDates(h, checkIn, checkOut) {
  const nights = hotelNightsFromDates(checkIn, checkOut);
  if (!nights.length) return "Choose a check-out date after check-in, with up to 90 nights.";
  const old = new Map(h.nights.map((night, i) => [
    trackerDateToISO(night),
    { need: h.needed[i], cells: h.grid.map(row => row[i]) },
  ]));
  const fallback = h.needed.at(-1) || 0;
  h.nights = nights;
  h.needed = nights.map(night => old.get(trackerDateToISO(night))?.need ?? fallback);
  h.grid = h.grid.map((row, ri) => nights.map(night =>
    old.get(trackerDateToISO(night))?.cells[ri] || Array(SLOTS).fill("")));
  h.checkIn = formatTrackerDate(checkIn);
  h.checkOut = formatTrackerDate(checkOut);
  h.roomsBooked = Math.max(0, ...h.needed);
  h.totalRoomNights = h.needed.reduce((sum, value) => sum + value, 0);
  return "";
}

function addStayNight(h, iso, count) {
  const date = formatTrackerDate(iso);
  if (!date) return "Choose a valid date.";
  if (h.nights.some(n => trackerDateToISO(n) === iso)) return "That date is already part of this stay.";
  const entries = h.nights.map((night, i) => ({ night, need: h.needed[i], cells: h.grid.map(row => row[i]) }));
  entries.push({ night: date, need: Math.max(0, Math.min(h.totalRooms, Math.floor(Number(count) || 0))), cells: h.grid.map(() => Array(SLOTS).fill("")) });
  entries.sort((a, b) => trackerDateToISO(a.night).localeCompare(trackerDateToISO(b.night)));
  h.nights = entries.map(x => x.night);
  h.needed = entries.map(x => x.need);
  h.grid = h.grid.map((row, ri) => entries.map(x => x.cells[ri]));
  h.roomsBooked = Math.max(0, ...h.needed);
  h.totalRoomNights = h.needed.reduce((sum, value) => sum + value, 0);
  const dates = h.nights.map(trackerDateToISO).sort();
  h.checkIn = formatTrackerDate(dates[0]);
  const last = new Date(`${dates.at(-1)}T00:00:00Z`);
  last.setUTCDate(last.getUTCDate() + 1);
  h.checkOut = formatTrackerDate(last.toISOString().slice(0, 10));
  return "";
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
    const returnTo = document.activeElement;
    const releaseFocus = typeof trapLockFocus === "function" ? trapLockFocus(el) : () => {};
    if (whyEl && why) whyEl.textContent = why;
    el.hidden = false;
    input.value = currentName();
    err.textContent = "";
    input.focus();
    const done = ok => {
      el.hidden = true;
      releaseFocus();
      if (returnTo?.isConnected) returnTo.focus();
      namePrompt = null;
      resolve(ok);
    };
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
  const shared = (st?.changeLog || []).map(c => ({ ...c, shared: true }));
  const local = getChanges().filter(c => !c.shared);
  const log = [...shared, ...local].sort((a, b) => String(b.t).localeCompare(String(a.t)));
  const el = $("#changesList");
  if (!el) return;
  const people = [...new Set(log.map(c => c.who).filter(Boolean))].sort();
  const person = $("#changePerson")?.value || "";
  const type = $("#changeType")?.value || "";
  const search = ($("#changeSearch")?.value || "").trim().toLowerCase();
  const filtered = log.filter(c => {
    const text = `${c.what || ""} ${c.who || ""}`.toLowerCase();
    const matchesType = !type || text.includes(type);
    return (!person || c.who === person) && matchesType && (!search || text.includes(search));
  });
  const personSelect = $("#changePerson");
  if (personSelect) {
    const current = personSelect.value;
    personSelect.innerHTML = `<option value="">Everyone</option>${people.map(p => `<option value="${esc(p)}">${esc(p)}</option>`).join("")}`;
    personSelect.value = people.includes(current) ? current : "";
  }
  if (!filtered.length) {
    el.innerHTML = `<div class="empty-state"><div class="empty-icon" aria-hidden="true">✓</div><h3>${log.length ? "No matching activity" : "No activity yet"}</h3><p>Synced changes will appear here with the editor name and details.</p></div>`;
    return;
  }
  el.innerHTML = `<div class="activity-list">${filtered.map(c => `
    <article class="activity-item"><div class="activity-avatar" aria-hidden="true">${esc((c.who || "?").slice(0, 1).toUpperCase())}</div>
      <div class="activity-body"><strong>${esc(c.who || "Unknown editor")}</strong><p>${esc(c.what || "Updated the tracker")}</p>
        <time>${esc(new Date(c.t).toLocaleString([], { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }))}</time></div>
      <span class="activity-badge">${c.shared ? "Shared" : "Pending"}</span></article>`).join("")}</div>`;
}

/* -------------------------------------------------------------------- render */
function renderAll() {
  renderOverview();
  renderHotelManagement();
  renderRooms();          // both the desktop grid and the phone sheet
  renderVendors();
  renderInvoices();
  renderChanges();
}

function renderHotelManagement() {
  const host = $("#hotelManagement");
  if (!host) return;
  if (!st.hotels.length) {
    host.innerHTML = `<div class="empty-state"><div class="empty-icon" aria-hidden="true">⌂</div><h3>No hotels yet</h3><p>Add a hotel to set the stay dates and daily room bookings.</p></div>`;
    return;
  }
  host.innerHTML = `<div class="hotel-admin-list">${st.hotels.map(h => {
    return `<article class="hotel-admin-card">
      <div class="hotel-admin-head">
        <div><p class="eyebrow">Hotel booking</p><h3>${esc(h.name)}</h3>
          <p>${esc(h.checkIn)} – ${esc(h.checkOut)} · ${h.totalRooms} rooms available · ${h.nights.length} ${h.nights.length === 1 ? "night" : "nights"}</p>
        </div>
        <button class="btn small danger" type="button" data-delete-hotel="${esc(h.id)}"
          aria-label="Delete ${esc(h.name)}">Delete hotel</button>
      </div>
      ${stayControls(h)}
    </article>`;
  }).join("")}</div>`;
}

function deleteHotel(id) {
  const index = st.hotels.findIndex(h => h.id === id);
  if (index < 0) return;
  const hotel = st.hotels[index];
  if (!confirm(`Delete "${hotel.name}" and all of its booking and guest details? This cannot be undone.`)) return;
  st.hotels.splice(index, 1);
  delete mSel[id];
  delete mDay[id];
  if (mHotel === id) mHotel = st.hotels[0]?.id || "";
  save();
  recordChange(`Deleted hotel "${hotel.name}" and its booking and guest details`);
  renderAll();
  flash("Hotel deleted");
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
    <div class="night-group"><h3>${esc(h.name)}</h3>` + h.nights.map((n, i) => {
      const s = nightStatus(h, i);
      const pct = s.prebooked ? Math.min(100, (s.f / s.prebooked) * 100) : 0;
      return `<div class="night-row"><span>${esc(wd(n))}</span><div class="bar"><i style="width:${pct}%"></i></div>
        <span class="status">${s.f}/${s.prebooked} rooms</span></div>`;
    }).join("") + `</div>`).join("");
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
  renderRoomsMobilePlanner();
}

function renderRoomsDesktop() {
  const host = $("#hotelPanels"); if (!host) return;
  if (!st.hotels.length) {
    host.innerHTML = `<div class="empty-state"><h3>No hotel stays yet</h3><p>Add a hotel in the Hotels tab before entering guest details.</p></div>`;
    return;
  }
  host.innerHTML = st.hotels.map(h => {
    const hs = hotelStatus(h);
    const booked = h.roomsBooked ?? h.totalRooms;
    const cols = h.nights.map(n => `<th scope="col" class="num">${esc(wd(n))}</th>`).join("");

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
            <tr class="total" data-row="${label}"><th scope="row" class="sticky-col">${label}</th>
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
      <div class="table-scroll" role="region" aria-label="Guest details for ${esc(h.name)}" tabindex="0">
        <table class="grid">
          <caption class="visually-hidden">Guest details by room and night at ${esc(h.name)}</caption>
          <thead><tr><th scope="col">Room</th>${cols}<th scope="col" class="num" title="guest-nights in this room">G-nights</th></tr></thead>
          <tbody>${rows}
            ${totalRow("Rooms with Guest", i => filledRooms(h, i))}
            ${totalRow("Guests", i => nightGuests(h, i))}
            ${totalRow("3rd guests", i => nightThird(h, i))}
            <tr class="total" data-row="status"><th scope="row" class="sticky-col">Status</th>
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
let mHotel = "";
const mDay = {};
function mRoom(h) {
  const i = Math.min(Math.max(0, mSel[h.id] ?? 0), Math.max(0, h.grid.length - 1));
  mSel[h.id] = i;
  return i;
}
function mHotelState() {
  const h = st.hotels.find(x => x.id === mHotel) || st.hotels[0];
  if (h) mHotel = h.id;
  return h;
}
function mobileGuestProgress(h) {
  const total = h.grid.reduce((sum, row) => sum + row.reduce((n, cell) => n + (cell.some(Boolean) ? 1 : 0), 0), 0);
  const filled = h.grid.reduce((sum, row) => sum + row.reduce((n, cell) => n + (cell.some(Boolean) ? 1 : 0), 0), 0);
  return { total: h.needed.reduce((a, b) => a + b, 0), filled };
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
  if (!st.hotels.length) {
    host.innerHTML = `<div class="empty-state"><h3>No hotel stays yet</h3><p>Add a hotel in the Hotels tab before entering guest details.</p></div>`;
    return;
  }
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

function renderRoomsMobilePlanner() {
  const host = $("#hotelMobile"); if (!host) return;
  const h = mHotelState();
  if (!h) { host.innerHTML = `<div class="empty-state"><h3>No hotel stays yet</h3><p>Add a hotel in the Hotels tab before entering guest details.</p></div>`; return; }
  const hs = hotelStatus(h), ri = mRoom(h), ni = Math.min(Math.max(0, mDay[h.id] ?? 0), h.nights.length - 1);
  mDay[h.id] = ni;
  const row = h.grid[ri], cell = row[ni], no = h.roomNos[ri] || "";
  const status = nightStatus(h, ni);
  const hotelTabs = st.hotels.map(item => `<button type="button" class="mobile-hotel-chip${item.id === h.id ? " active" : ""}" data-mobile-hotel="${item.id}" aria-pressed="${item.id === h.id}">${esc(item.name)}<small>${hotelStatus(item).roomsInUse}/${item.roomsBooked} rooms</small></button>`).join("");
  const dayTabs = h.nights.map((night, i) => {
    const s = nightStatus(h, i);
    return `<button type="button" class="mobile-day-chip${i === ni ? " active" : ""}" data-mobile-day="${i}" aria-pressed="${i === ni}"><strong>${esc(wd(night).slice(0, 3))}</strong><small>${esc(night.slice(0, 6))}</small><em>${s.f}/${s.prebooked}</em></button>`;
  }).join("");
  host.innerHTML = `<div class="mobile-planner">
    <div class="mobile-planner-intro"><p class="eyebrow">Guest check-in</p><h2>Build the room list</h2>
      <p>Choose a hotel, date, and room. Then add the guests staying that night.</p></div>
    <div class="mobile-hotel-tabs" role="group" aria-label="Choose a hotel">${hotelTabs}</div>
    <article class="mobile-stay-card">
      <div class="mobile-stay-head"><div><span class="eyebrow">Selected hotel</span><h3>${esc(h.name)}</h3><p>${esc(h.checkIn)} → ${esc(h.checkOut)}</p></div><span class="stay-progress">${hs.roomsInUse}/${h.roomsBooked}<small>rooms complete</small></span></div>
      <div class="mobile-progress"><span style="width:${Math.min(100, h.roomsBooked ? hs.roomsInUse / h.roomsBooked * 100 : 0)}%"></span></div>
      <div class="mobile-step"><span class="step-number">1</span><div><strong>Choose the night</strong><small>Guest names are saved separately for each date</small></div></div>
      <div class="mobile-day-tabs">${dayTabs}</div>
      <div class="mobile-step"><span class="step-number">2</span><div><strong>Choose the room</strong><small>Room ${ri + 1} · ${no ? `hotel room ${esc(no)}` : "number not entered yet"}</small></div></div>
      <div class="mobile-room-tabs">${mobileChips(h)}</div>
      <div class="mobile-guest-editor">
        <div class="mobile-editor-head"><div><span class="eyebrow">${esc(wd(h.nights[ni]))} · ${esc(h.nights[ni])}</span><h3>${no ? `Room ${esc(no)}` : `Room ${ri + 1}`}</h3><p>${status.f} of ${status.prebooked} booked rooms have guest details</p></div><div class="mobile-editor-controls"><label>Room number<input class="roomno" type="text" inputmode="numeric" value="${esc(no)}" placeholder="e.g. 204" data-h="${h.id}" data-k="roomNo" data-r="${ri}" aria-label="Hotel room number for ${esc(h.name)}, Room ${ri + 1}"></label></div></div>
        <div class="mobile-guest-fields">${Array.from({ length: SLOTS }, (_, g) => `<label class="mobile-guest-field${g === 2 ? " extra-field" : ""}"><span>${g === 2 ? "Guest 3" : `Guest ${g + 1}`}<small>${g === 2 ? "Optional extra guest" : "Name"}</small></span><input class="ginput" type="text" value="${esc(cell[g])}" placeholder="Enter full name" data-h="${h.id}" data-r="${ri}" data-n="${ni}" data-g="${g}" autocomplete="off" enterkeyhint="${g === SLOTS - 1 ? "done" : "next"}"></label>`).join("")}</div>
        <p class="mobile-save-tip">Changes save on this device as you type. Use <strong>Sync changes</strong> when you are ready to share them with the team.</p>
      </div>
      <div class="mobile-nav"><button class="btn small" type="button" data-mobile-nav="prev" data-h="${h.id}" ${ni === 0 ? "disabled" : ""}>← Previous night</button><span>Night ${ni + 1} of ${h.nights.length}</span><button class="btn small primary" type="button" data-mobile-nav="next" data-h="${h.id}" ${ni === h.nights.length - 1 ? "disabled" : ""}>Next night →</button></div>
    </article>
  </div>`;
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
      `<th scope="col" class="${t === "number" ? "num " : ""}${g}">${l}</th>`).join("")}<th scope="col">Actions</th></tr></thead>
     <tbody>${st.vendors.map((v, i) => {
       const s = vendorStatus(v);
       return `<tr>
         <td class="sticky-col g-id" data-label="Vendor"><input class="cell strong" type="text" value="${esc(v.name)}"
             data-v="${i}" data-f="name" aria-label="Vendor name for row ${i + 1}"></td>
         ${VCOLS.slice(1).map(([k, l, t, g]) => `<td class="${t === "number" ? "num " : ""}${g}" data-label="${l}">
            <input class="cell" type="${t === "number" ? "number" : "text"}"
                   ${t === "number" ? 'min="0" step="500"' : ""}
                   value="${esc(v[k])}" data-v="${i}" data-f="${k}"
                   aria-label="${l} for vendor ${i + 1}"></td>`).join("")}
         <td class="num vstat" data-label="Payment status"><span class="pill ${s.cls}">${s.txt}</span>
             ${s.bal !== undefined ? `<div class="dim">${inr(s.bal)} left</div>` : ""}</td>
         <td class="num vendor-remove"><button type="button" class="btn row-del" data-del="${i}"
             aria-label="Remove ${esc(v.name || `vendor ${i + 1}`)}">&times;</button></td>
       </tr>`;
     }).join("")}</tbody>`;
  renderVendorSummary();
}

function renderInvoices() {
  const host = $("#invoicePanels"); if (!host) return;
  const legacy = Object.entries(st.vendorDetails || {}).map(([name, d]) => {
    let body = "";
    if (d.kind === "invoice") {
      body = `<div class="table-scroll invoice-table-scroll invoice-line-items" role="region" aria-label="Invoice details for ${esc(name)}" tabindex="0"><table class="grid">
        <caption class="visually-hidden">Invoice line items for ${esc(name)}</caption>
        <thead><tr><th scope="col">Item</th><th scope="col" class="num">Qty</th><th scope="col" class="num">Unit</th><th scope="col" class="num">Total</th></tr></thead>
        <tbody>${d.items.map(i => `<tr><th scope="row">${esc(i[0])}</th><td class="num">${i[1]}</td>
          <td class="num">${inr(i[2])}</td><td class="num">${inr(i[3])}</td></tr>`).join("")}
          ${d.totals.map(([k, v]) => `<tr class="total"><th scope="row">${esc(k)}</th><td></td><td></td>
            <td class="num">${inr(v)}</td></tr>`).join("")}</tbody></table></div>
        ${d.terms ? `<p class="caption">${esc(d.terms)}</p>` : ""}
        ${d.pdf ? `<p class="caption"><a href="${esc(d.pdf)}" target="_blank" rel="noopener">Open the invoice PDF &#8599; <span class="visually-hidden">(opens in a new tab)</span></a></p>` : ""}`;
    } else {
      body = `<div class="table-scroll invoice-table-scroll invoice-hotel-details" role="region" aria-label="Hotel cost details for ${esc(name)}" tabindex="0"><table class="grid">
        <caption class="visually-hidden">Hotel booking and cost details for ${esc(name)}</caption>
        <tbody>
          ${d.booking.map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}
          ${d.cost.map(([k, v]) => `<tr class="total"><th scope="row">${esc(k)}</th><td class="num">${inr(v)}</td></tr>`).join("")}
          ${d.contact.map(([k, v]) => `<tr><th scope="row">${esc(k)}</th><td>${esc(v)}</td></tr>`).join("")}
        </tbody></table></div>`;
    }
    const total = d.totals?.find(([key]) => /grand|total|amount/i.test(key))?.[1]
      ?? d.cost?.find(([key]) => /grand|total|amount/i.test(key))?.[1] ?? "";
    const legacyEdit = d.kind === "invoice" || d.kind === "hotel"
      ? `<button class="btn small" type="button" data-import-invoice="${esc(name)}" aria-label="Edit invoice details for ${esc(name)}">Edit</button>` : "";
    return `<details class="inv legacy-invoice"${d.kind === "invoice" ? " open" : ""}>
      <summary>${esc(d.title || name)}</summary>
      <div class="legacy-invoice-toolbar"><p class="caption">${esc(d.sub || "")}</p>${legacyEdit}</div>${body}
      ${d.caption ? `<p class="caption dim">${esc(d.caption)}</p>` : ""}
    </details>`;
  }).join("");
  const editable = (st.invoices || []).map((invoice, i) => `
    <article class="invoice-card">
      <div class="invoice-card-head">
        <div><p class="eyebrow">${esc(invoice.status || "Unpaid")}</p>
          <h3>${esc(invoice.title || "Untitled invoice")}</h3>
          <p class="caption">${esc(invoice.vendor || "No vendor")} · ${esc(invoice.number || "No invoice number")}</p></div>
        <div class="invoice-card-actions">
          <strong class="invoice-amount">${invoice.amount === "" || invoice.amount == null ? "—" : inr(invoice.amount)}</strong>
          <button class="btn small" type="button" data-edit-invoice="${i}" aria-label="Edit ${esc(invoice.title || "invoice")}">Edit</button>
          <button class="btn small danger" type="button" data-delete-invoice="${i}" aria-label="Delete ${esc(invoice.title || "invoice")}">Delete</button>
        </div>
      </div>
      <dl class="invoice-meta">
        <div><dt>Date</dt><dd>${esc(invoice.date || "Not set")}</dd></div>
      </dl>
      ${invoice.notes
        ? `<details class="invoice-notes"><summary>Notes · view details</summary><p>${esc(invoice.notes)}</p></details>`
        : `<p class="invoice-no-notes">No notes added.</p>`}
      ${invoice.pdf ? `<a class="invoice-link" href="${esc(invoice.pdf)}" target="_blank" rel="noopener">Open invoice link ↗ <span class="visually-hidden">(opens in a new tab)</span></a>` : ""}
    </article>`).join("");
  host.innerHTML = (editable || legacy)
    ? `<div class="invoice-list">${editable}</div>${legacy ? `<h3 class="subheading">Imported invoice detail</h3>${legacy}` : ""}`
    : `<div class="empty-state"><div class="empty-icon" aria-hidden="true">＋</div><h3>No invoices yet</h3><p>Add an invoice to keep notes, amounts, and links available to everyone.</p></div>`;
}

function importLegacyInvoice(name) {
  const detail = st.vendorDetails?.[name];
  if (!detail) return;
  const invoices = st.invoices || (st.invoices = []);
  let index = invoices.findIndex(invoice => invoice.sourceDetail === name);
  if (index < 0) {
    const amount = detail.totals?.find(([key]) => /grand|total|amount/i.test(key))?.[1]
      ?? detail.cost?.find(([key]) => /amount quoted|grand|total|amount/i.test(key))?.[1] ?? "";
    const paid = detail.cost?.find(([key]) => /amount paid/i.test(key))?.[1];
    const booking = (detail.booking || []).map(([key, value]) => `${key}: ${value}`).join(" · ");
    const plan = (detail.plan || []).map(([day, rooms, booked]) =>
      `${day}: ${rooms} rooms (${booked} pre-booked)`).join(", ");
    const notes = [
      detail.terms,
      booking && `Booking: ${booking}`,
      plan && `Room plan: ${plan}`,
      paid !== undefined && `Amount paid: ${inr(paid)}`,
      detail.caption,
    ].filter(Boolean).join("\n\n");
    const status = Number(paid) >= Number(amount) && amount !== "" ? "Paid"
      : Number(paid) > 0 ? "Part-paid" : "Unpaid";
    invoices.push({
      id: `invoice-${Date.now()}`,
      sourceDetail: name,
      title: detail.title || name,
      vendor: name,
      number: "",
      date: "",
      amount,
      status,
      pdf: detail.pdf || "",
      notes,
    });
    index = invoices.length - 1;
    recordChange(`Created editable invoice from "${detail.title || name}"`);
    save();
  }
  renderAll();
  editInvoice(index);
}

function resetInvoiceForm() {
  const form = $("#invoiceForm");
  form?.reset();
  if (form) { form.hidden = true; delete form.dataset.editIndex; }
  $("#invoiceFormError").textContent = "";
}
function editInvoice(index) {
  const invoice = index >= 0 ? st.invoices[index] : null;
  const form = $("#invoiceForm"); if (!form) return;
  form.hidden = false; form.dataset.editIndex = index >= 0 ? String(index) : "";
  for (const [id, key] of [["invoiceTitle", "title"], ["invoiceVendor", "vendor"],
    ["invoiceNumber", "number"], ["invoiceDate", "date"], ["invoiceAmount", "amount"],
    ["invoiceStatus", "status"], ["invoicePdf", "pdf"], ["invoiceNotes", "notes"]]) {
    const el = $(`#${id}`); if (el) el.value = invoice?.[key] ?? "";
  }
  form.scrollIntoView({ behavior: "smooth", block: "start" });
  $("#invoiceTitle")?.focus();
}
function addOrUpdateInvoice(event) {
  event.preventDefault();
  const title = $("#invoiceTitle").value.trim();
  if (!title) { $("#invoiceFormError").textContent = "Add an invoice title."; return; }
  const fields = { title, vendor: $("#invoiceVendor").value.trim(), number: $("#invoiceNumber").value.trim(),
    date: $("#invoiceDate").value, amount: $("#invoiceAmount").value, status: $("#invoiceStatus").value,
    pdf: $("#invoicePdf").value.trim(), notes: $("#invoiceNotes").value.trim() };
  const index = Number($("#invoiceForm").dataset.editIndex);
  const editing = Number.isInteger(index) && index >= 0;
  if (editing) { st.invoices[index] = { ...st.invoices[index], ...fields }; recordChange(`Updated invoice "${title}"`); }
  else { st.invoices.push({ id: `invoice-${Date.now()}`, ...fields }); recordChange(`Added invoice "${title}"`); }
  save(); resetInvoiceForm(); renderAll(); flash(editing ? "Invoice updated" : "Invoice added");
}

function reportShell(title, body) {
  return `<h1>${esc(base?.event || "Wedding Tracker")}</h1><div class="report-meta">${esc(title)} · Generated ${new Date().toLocaleDateString()}</div>${body}`;
}
function printReport(kind) {
  const host = $("#pdfReport"); if (!host) return;
  let title = "Overview report", body = "";
  if (kind === "rooms") {
    title = "Room booking report";
    body = st.hotels.map(h => `<div class="report-card"><h3>${esc(h.name)}</h3>
      <div class="muted">${esc(h.checkIn || "")} → ${esc(h.checkOut || "")}</div>
      <table class="report-grid"><thead><tr><th>Date</th><th>Pre-booked</th><th>Guest details</th><th>Status</th></tr></thead><tbody>
      ${h.nights.map((night, i) => { const s = nightStatus(h, i); return `<tr><td>${esc(night)}</td><td>${s.prebooked}</td><td>${s.f}</td><td>${esc(s.txt)}</td></tr>`; }).join("")}
      </tbody></table></div>`).join("");
  } else if (kind === "vendors") {
    title = "Pending vendor payments";
    const pending = st.vendors.filter(v => vendorStatus(v).cls === "warn");
    body = `<h2>${pending.length} vendors need follow-up</h2><table class="report-grid"><thead><tr><th>Vendor</th><th>Event</th><th>Quoted</th><th>Paid</th><th>Balance</th><th>Payment mode</th></tr></thead><tbody>
      ${pending.map(v => `<tr><td>${esc(v.name || "Untitled")}</td><td>${esc(v.event || "")}</td><td>${inr(v.quoted || 0)}</td><td>${inr(v.paid || 0)}</td><td>${inr(Math.max(0, (v.quoted || 0) - (v.paid || 0)))} </td><td>${esc(v.paymentMode || "")}</td></tr>`).join("")}
      <tr class="report-total"><td colspan="2">Total outstanding</td><td colspan="4">${inr(pending.reduce((sum, v) => sum + Math.max(0, (v.quoted || 0) - (v.paid || 0)), 0))}</td></tr></tbody></table>`;
  } else if (kind === "invoices") {
    title = "Invoice register";
    const rows = (st.invoices || []).map(i => `<tr><td>${esc(i.title || "Untitled")}</td><td>${esc(i.vendor || "")}</td><td>${esc(i.number || "")}</td><td>${esc(i.status || "Unpaid")}</td><td>${i.amount === "" ? "—" : inr(i.amount)}</td><td>${esc(i.notes || "")}</td></tr>`).join("");
    body = `<table class="report-grid"><thead><tr><th>Invoice</th><th>Vendor</th><th>Number</th><th>Status</th><th>Amount</th><th>Notes</th></tr></thead><tbody>${rows || "<tr><td colspan=\"6\">No added invoices</td></tr>"}</tbody></table>`;
  } else {
    const q = st.vendors.reduce((a, v) => a + (v.quoted || 0), 0);
    const p = st.vendors.reduce((a, v) => a + (v.paid || 0), 0);
    title = "Executive overview";
    body = `<h2>Financial summary</h2><table class="report-grid"><tbody>
      <tr><td>Total quoted</td><td>${inr(q)}</td></tr><tr><td>Total paid</td><td>${inr(p)}</td></tr>
      <tr class="report-total"><td>Outstanding</td><td>${inr(q - p)}</td></tr></tbody></table>
      <h2>Hotels</h2><table class="report-grid"><thead><tr><th>Hotel</th><th>Room-nights pre-booked</th><th>Room-nights with details</th></tr></thead><tbody>
      ${st.hotels.map(h => `<tr><td>${esc(h.name)}</td><td>${h.needed.reduce((a, n) => a + n, 0)}</td><td>${h.nights.reduce((a, _, i) => a + nightStatus(h, i).f, 0)}</td></tr>`).join("")}</tbody></table>`;
  }
  host.innerHTML = reportShell(title, body);
  document.body.dataset.printReport = kind;
  window.setTimeout(() => window.print(), 30);
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
  if (!panel.querySelector("table")) {
    renderRoomsMobilePlanner();
    return;
  }
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
  $("#hotelManagement")?.addEventListener("click", e => {
    const button = e.target.closest("[data-delete-hotel]");
    if (button) deleteHotel(button.dataset.deleteHotel);
  });
  document.addEventListener("submit", e => {
    const datesForm = e.target.closest(".update-stay-dates");
    if (datesForm) {
      e.preventDefault();
      const h = st.hotels.find(x => x.id === datesForm.dataset.h);
      if (!h) return;
      const error = datesForm.querySelector("[data-date-error]");
      const message = updateStayDates(h, datesForm.elements.checkIn.value, datesForm.elements.checkOut.value);
      if (message) { error.textContent = message; return; }
      save(); recordChange(`Updated stay dates for "${h.name}"`);
      renderAll(); flash("Hotel stay dates updated");
      return;
    }
    const form = e.target.closest(".add-stay-night");
    if (!form) return;
    e.preventDefault();
    const h = st.hotels.find(x => x.id === form.dataset.h);
    if (!h) return;
    const error = form.querySelector("[data-stay-error]");
    const message = addStayNight(h, form.elements.date.value, form.elements.count.value);
    if (message) { error.textContent = message; return; }
    save(); recordChange(`Added a booking date to "${h.name}"`);
    renderAll(); flash("Date added to hotel stay");
  });
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
    const hotelChip = e.target.closest("[data-mobile-hotel]");
    if (hotelChip) {
      mHotel = hotelChip.dataset.mobileHotel;
      renderRoomsMobilePlanner();
      return;
    }
    const dayChip = e.target.closest("[data-mobile-day]");
    if (dayChip) {
      const h = mHotelState();
      if (!h) return;
      mDay[h.id] = +dayChip.dataset.mobileDay;
      renderRoomsMobilePlanner();
      return;
    }
    const chip = e.target.closest(".roomchip");
    if (chip) {
      mSel[chip.dataset.h] = +chip.dataset.r;
      renderRoomsMobilePlanner();
      return;
    }
    const nav = e.target.closest("[data-nav]");
    if (nav) {
      const h = st.hotels.find(x => x.id === nav.dataset.h);
      if (!h) return;
      const dir = nav.dataset.nav === "next" ? 1 : -1;
      mSel[h.id] = Math.min(Math.max(0, mRoom(h) + dir), h.grid.length - 1);
      renderRoomsMobilePlanner();
      const sheet = $(`#hotelMobile .msheet[data-h="${h.id}"]`);
      sheet?.scrollIntoView({ block: "start", behavior: "smooth" });
    }
    const mobileNav = e.target.closest("[data-mobile-nav]");
    if (mobileNav) {
      const h = st.hotels.find(x => x.id === mobileNav.dataset.h);
      if (!h) return;
      mDay[h.id] = Math.min(Math.max(0, (mDay[h.id] ?? 0) + (mobileNav.dataset.mobileNav === "next" ? 1 : -1)), h.nights.length - 1);
      renderRoomsMobilePlanner();
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
  $("#btnAddInvoice").onclick = () => editInvoice(-1);
  $("#invoiceForm").onsubmit = addOrUpdateInvoice;
  $("#cancelInvoice").onclick = resetInvoiceForm;
  $("#invoicePanels").addEventListener("click", e => {
    const imported = e.target.closest("[data-import-invoice]");
    if (imported) { importLegacyInvoice(imported.dataset.importInvoice); return; }
    const edit = e.target.closest("[data-edit-invoice]");
    if (edit) { editInvoice(+edit.dataset.editInvoice); return; }
    const remove = e.target.closest("[data-delete-invoice]");
    if (!remove) return;
    const invoice = st.invoices[+remove.dataset.deleteInvoice];
    if (!invoice || !confirm(`Delete "${invoice.title || "this invoice"}"?`)) return;
    st.invoices.splice(+remove.dataset.deleteInvoice, 1);
    save(); renderAll(); recordChange(`Deleted invoice "${invoice.title || "Untitled invoice"}"`); flash("Invoice deleted");
  });
  $("#tabs").addEventListener("click", e => {
    const b = e.target.closest(".tab"); if (!b) return;
    $(".mobile-tools")?.removeAttribute("open");
    $(".export-menu")?.removeAttribute("open");
    $$(".tab").forEach(t => {
      t.classList.toggle("active", t === b);
      if (t === b) t.setAttribute("aria-current", "page");
      else t.removeAttribute("aria-current");
    });
    $$(".view").forEach(v => v.hidden = v.id !== "view-" + b.dataset.view);
  });
  ["#changePerson", "#changeType", "#changeSearch"].forEach(id =>
    $(id)?.addEventListener("input", renderChanges));
  $$("[data-print-report]").forEach(button => { button.onclick = () => {
    button.closest(".mobile-tools")?.removeAttribute("open");
    button.closest(".export-menu")?.removeAttribute("open");
    printReport(button.dataset.printReport);
  }; });
  window.addEventListener("afterprint", () => {
    document.body.removeAttribute("data-print-report");
    const report = $("#pdfReport"); if (report) report.innerHTML = "";
  });

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
  const genDate = $("#genDate");
  if (genDate) genDate.textContent = base.generated;
  setName(localStorage.getItem(NAME_KEY) || "");
  renderAll(); wire();
  setSaveIndicator(localStorage.getItem(PENDING_KEY) === "1");
  window.RealtimeSync?.start({
    getState: () => st,
    normalize,
    setState: value => { st = normalize(value); },
    setBase: value => { base = normalize(value); },
    getName: currentName,
    getChanges,
    promptName: requestName,
    flushLocal: flushSave,
    setPending,
    setSyncBusy,
    render: renderAll,
    status: reportRealtimeStatus,
  });
})();