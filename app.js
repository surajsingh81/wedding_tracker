/* Wedding tracker — all state lives in localStorage; nothing is sent anywhere.
   A fresh data.json (exported from the workbook) is the baseline to reset to. */

const KEY = "wedding-tracker-v1";
const PENDING_KEY = "wedding-tracker-pending-v1";   // "1" = edits not yet in Excel
const CHANGES_KEY = "tracker-changes-v1";
const NAME_KEY = "tracker-name-v1";
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

// Live data source: the GitHub API serves data.json the moment the Action
// commits it (no Pages rebuild wait). Falls back to the Pages copy.
const DATA_API = "https://api.github.com/repos/surajsingh81/wedding_tracker/contents/data.json";

let base = null;   // last Excel export (immutable baseline)
let st   = null;   // live state = base + local edits

async function loadData() {
  try {
    const r = await fetch(DATA_API, { cache: "no-cache" });
    if (r.ok) {
      const meta = await r.json();
      if (meta.content) {
        // data.json is UTF-8 (₹, en-dashes, names). atob() alone would decode
        // the bytes as Latin-1 and mangle every non-ASCII character, so go
        // through bytes + TextDecoder.
        const bin = atob(meta.content.replace(/\s+/g, ""));
        const bytes = Uint8Array.from(bin, c => c.charCodeAt(0));
        return JSON.parse(new TextDecoder("utf-8").decode(bytes));
      }
    }
  } catch (e) { /* fall back to the Pages copy */ }
  const res = await fetch("data.json", { cache: "no-cache" });
  return res.json();
}

// Signature of every editable field — used to detect when the workbook has
// absorbed a save (the API copy then matches the live state).
function dataSig(d) {
  return JSON.stringify([
    d.hotels.map(h => [h.id, h.grid]),
    d.vendors.map(v => [v.row, v.name, v.contact, v.phone, v.whatsapp,
      v.event, v.eventDate, v.quoted, v.paid, v.paymentMode,
      v.ref, v.paidOn, v.address, v.notes, v.isNew]),
  ]);
}

// Excel is the source of truth. Once it has absorbed our changes, adopt its
// export and drop the stale browser snapshot, so the next load starts from
// Excel instead of replaying an old local state over fresh data.
function adoptFresh(d) {
  base = d;
  st = JSON.parse(JSON.stringify(d));
  localStorage.removeItem(KEY);
  localStorage.setItem(PENDING_KEY, "0");
  $("#genDate").textContent = d.generated;
  renderAll();
}

// After a successful save, poll the API until the workbook reflects it.
// The Action itself only takes ~12s, so poll every 3s for the first half
// minute and then back off — with the elapsed time shown, so the wait is
// never a mystery.
async function watchSync() {
  const want = dataSig(st);
  const t0 = Date.now();
  const elapsed = () => `${Math.round((Date.now() - t0) / 1000)}s`;
  for (let i = 0; i < 24; i++) {
    syncStatus(`✓ Sent to the cloud. Excel is absorbing it — ${elapsed()}…`, "msg-ok");
    await new Promise(r => setTimeout(r, i < 9 ? 3000 : 8000));
    let fresh = null;
    try { fresh = await loadData(); } catch (e) { continue; }
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
  for (const row of h.grid) if (row[ni][0] || row[ni][1]) n++;
  return n;
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

/* --------------------------------------------------------------- persistence */
function save() {
  try {
    localStorage.setItem(KEY, JSON.stringify(st));
    localStorage.setItem(PENDING_KEY, "1");   // not yet in Excel
    flash("Saved " + new Date().toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }));
  } catch (e) { flash("Could not save (storage full?)"); }
}
let flashT;
function flash(msg) {
  const el = $("#saveState");
  el.textContent = msg;
  clearTimeout(flashT);
  flashT = setTimeout(() => el.textContent = "Auto-saved", 2500);
}

/* ------------------------------------------------------------- change log */
function getChanges() {
  try { return JSON.parse(localStorage.getItem(CHANGES_KEY) || "[]"); }
  catch { return []; }
}
function recordChange(what) {
  const who = ($("#yourName")?.value || "").trim() || "Anonymous";
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
    el.innerHTML = `<p class="dim">No changes recorded on this device yet. Edit a guest name or
      a vendor field, then check back here.</p>`;
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
  renderRooms();
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
  const needRooms = st.hotels.reduce((a, h) => a + h.needed.filter(Boolean).length, 0);
  const short = Math.max(0, needRooms - st.hotels.reduce(
    (a, h) => a + h.nights.filter((_, i) => nightStatus(h, i).cls === "ok").length, 0));

  const q = st.vendors.reduce((a, v) => a + (v.quoted || 0), 0);
  const p = st.vendors.reduce((a, v) => a + (v.paid  || 0), 0);
  const pend = st.vendors.filter(v => vendorStatus(v).cls === "warn").length;

  $("#overviewCards").innerHTML = [
    ["Room-nights needed", needTot, `${st.hotels.length} hotels`],
    ["Room-nights assigned", fillTot, shortNights.length ? `${shortNights.length} night(s) short` : "all nights covered", shortNights.length ? "warn" : "ok"],
    ["Vendors", st.vendors.length, `${st.vendors.filter(v => v.quoted !== "" && v.quoted != null).length} quoted`],
    ["Vendors pending", pend, pend ? "money still due" : "nothing outstanding", pend ? "warn" : "ok"],
  ].map(([k, v, n, c = ""]) =>
    `<div class="card ${c}"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="n">${esc(n)}</div></div>`
  ).join("");

  $("#moneyCards").innerHTML = [
    ["Total quoted", inr(q), "", ""],
    ["Total paid", inr(p), "", "ok"],
    ["Total outstanding", inr(q - p), "", q - p > 0 ? "warn" : "ok"],
  ].map(([k, v, n, c]) => {
    const note = esc(n || "");
    return `<div class="card ${c}"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="n">${note || "&nbsp;"}</div></div>`;
  }).join("");

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

function renderRooms() {
  $("#hotelPanels").innerHTML = st.hotels.map(h => {
    const cols = h.nights.map(n => `<th class="num">${esc(wd(n))}</th>`).join("");
    const rows = h.grid.map((row, ri) => `
      <tr>
        <td class="sticky-col">Room ${ri + 1}</td>
        ${row.map((cell, ni) => {
          const g1 = !!cell[0], g2 = !!cell[1];
          const s = nightStatus(h, ni);
          return `<td${(g1 || g2) ? ' class="filled"' : ""}>
            <div class="gcell">
              <input type="text" value="${esc(cell[0])}" placeholder="Guest 1"
                     data-h="${h.id}" data-r="${ri}" data-n="${ni}" data-g="0"
                     aria-label="Room ${ri+1} guest 1, ${esc(h.nights[ni])}">
              <input type="text" value="${esc(cell[1])}" placeholder="Guest 2"
                     data-h="${h.id}" data-r="${ri}" data-n="${ni}" data-g="1"
                     aria-label="Room ${ri+1} guest 2, ${esc(h.nights[ni])}">
            </div></td>`;
        }).join("")}
      </tr>`).join("");

    const sum = h.needed.reduce((a, b) => a + (b || 0), 0);
    const okNights = h.nights.filter((_, i) => nightStatus(h, i).cls === "ok").length;
    return `<div class="panel">
      <div class="panel-h">
        <div><h3>${esc(h.name)}</h3>
          <div class="meta">
            <span>Check-in <b>${esc(h.checkIn)}</b></span>
            <span>Check-out <b>${esc(h.checkOut)}</b>${h.checkoutTime ? " at " + esc(h.checkoutTime) : ""}</span>
            <span>Rooms <b>${h.totalRooms}</b></span>
            <span>Room-nights <b>${sum}</b></span>
          </div>
        </div>
        <span class="pill ${okNights === h.nights.length ? "ok" : "warn"}">
          ${okNights}/${h.nights.length} nights fully assigned</span>
      </div>
      <div class="table-scroll">
        <table class="grid">
          <thead><tr><th>Room</th>${cols}</tr></thead>
          <tbody>${rows}
            <tr class="total"><td class="sticky-col">Filled</td>
              ${h.nights.map((_, i) => `<td class="num">${filledRooms(h, i)}</td>`).join("")}</tr>
            <tr class="total"><td class="sticky-col">Needed</td>
              ${h.nights.map((_, i) => `<td class="num">${h.needed[i]}</td>`).join("")}</tr>
            <tr class="total"><td class="sticky-col">Status</td>
              ${h.nights.map((_, i) => { const s = nightStatus(h, i);
                return `<td class="num"><span class="pill ${s.cls}">${esc(s.txt)}</span></td>`; }).join("")}</tr>
          </tbody>
        </table>
      </div>
      <ul class="notes">${h.notes.map(n => `<li>${esc(n)}</li>`).join("")}</ul>
    </div>`;
  }).join("");
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
  $("#vendorTable").innerHTML =
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
  $("#invoicePanels").innerHTML = Object.entries(st.vendorDetails || {}).map(([name, d]) => {
    let body = "";
    if (d.kind === "invoice") {
      body = `<div class="table-scroll"><table class="grid">
        <thead><tr><th>Item</th><th class="num">Qty</th><th class="num">Unit</th><th class="num">Total</th></tr></thead>
        <tbody>${d.items.map(i => `<tr><td>${esc(i[0])}</td><td class="num">${i[1]}</td>
          <td class="num">${inr(i[2])}</td><td class="num">${inr(i[3])}</td></tr>`).join("")}
          ${d.totals.map(([k, v]) => `<tr class="total"><td>${esc(k)}</td><td></td><td></td>
            <td class="num">${inr(v)}</td></tr>`).join("")}</tbody></table></div>
        ${d.terms ? `<p class="caption">${esc(d.terms)}</p>` : ""}
        ${d.pdf ? `<p class="caption"><a href="${esc(d.pdf)}" target="_blank" rel="noopener">Open the invoice PDF ↗</a></p>` : ""}`;
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

// update one vendor's status pill + balance in place (keeps the caret where it is)
function refreshVendorRow(i) {
  const s = vendorStatus(st.vendors[i]);
  const td = $(`#vendorTable tbody tr:nth-child(${i + 1}) td.vstat`);
  if (td) td.innerHTML = `<span class="pill ${s.cls}">${s.txt}</span>` +
    (s.bal !== undefined ? `<div class="dim">${inr(s.bal)} left</div>` : "");
  renderVendorSummary();
}

function renderVendorSummary() {
  const q = st.vendors.reduce((a, v) => a + (v.quoted || 0), 0);
  const p = st.vendors.reduce((a, v) => a + (v.paid  || 0), 0);
  const byCls = c => st.vendors.filter(v => vendorStatus(v).cls === c).length;
  $("#vendorSummary").innerHTML = [
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
function cellKey(t) { return t.dataset.h ? `${t.dataset.h}-${t.dataset.r}-${t.dataset.n}-${t.dataset.g}` : `v-${t.dataset.v}-${t.dataset.f}`; }
function baseVal(t) {
  if (t.dataset.h) {
    const h = base.hotels.find(x => x.id === t.dataset.h);
    return h?.grid?.[+t.dataset.r]?.[+t.dataset.n]?.[+t.dataset.g] ?? "";
  }
  return base.vendors?.[+t.dataset.v]?.[t.dataset.f] ?? "";
}
function describeCell(t) {
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

function wire() {
  document.addEventListener("input", e => {
    const t = e.target;
    if (t.matches(".gcell input")) {
      const h = st.hotels.find(x => x.id === t.dataset.h);
      h.grid[+t.dataset.r][+t.dataset.n][+t.dataset.g] = t.value;
      save(); renderOverview();
      // repaint only this cell's row state, keeping the caret in place
      const td = t.closest("td");
      const other = $$("input", t.closest(".gcell")).find(i => i !== t);
      td.classList.toggle("filled", !!(t.value || other.value));
      refreshRows(t.dataset.h);
    }
    if (t.matches("input.cell")) {
      const i = +t.dataset.v, f = t.dataset.f;
      st.vendors[i][f] = VNUM.has(f) ? (t.value === "" ? "" : Number(t.value)) : t.value;
      save(); renderOverview(); refreshVendorRow(i);
    }
  });

  // record finished edits (blur / Enter) in the change log
  document.addEventListener("change", e => {
    const t = e.target;
    if (t.matches(".gcell input") || t.matches("input.cell")) recordEdit(t);
  });

  // remember the person's name on this device
  $("#yourName").addEventListener("input", e => {
    localStorage.setItem(NAME_KEY, e.target.value);
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

  // refresh Filled/Needed/Status rows for one hotel without losing focus
  function refreshRows(hid) {
    const h = st.hotels.find(x => x.id === hid);
    const body = $(`#hotelPanels [data-h="${hid}"]`)?.closest("table")?.tBodies[0];
    if (!body) return;
    const tot = [...body.querySelectorAll("tr.total")];
    if (tot.length < 3) return;
    tot[0].querySelectorAll("td.num").forEach((td, i) => td.textContent = filledRooms(h, i));
    tot[2].querySelectorAll("td.num").forEach((td, i) => {
      const s = nightStatus(h, i);
      td.innerHTML = `<span class="pill ${s.cls}">${esc(s.txt)}</span>`;
    });
  }

  $("#tabs").addEventListener("click", e => {
    const b = e.target.closest(".tab"); if (!b) return;
    $$(".tab").forEach(t => t.classList.toggle("active", t === b));
    $$(".view").forEach(v => v.hidden = v.id !== "view-" + b.dataset.view);
  });

  $("#btnPrint").onclick = () => window.print();

  $("#btnSync").onclick = syncNow;

  $("#btnReset").onclick = () => {
    if (!confirm("Discard your edits on this device and reload the last Excel export?")) return;
    localStorage.removeItem(KEY); localStorage.setItem(PENDING_KEY, "0"); st = JSON.parse(JSON.stringify(base)); renderAll(); flash("Reset");
    recordChange("Reset — discarded local edits and reloaded the last Excel export");
  };
}

/* --------------------------------------------------------------------- boot */
(async function () {
  base = await loadData();
  const saved = JSON.parse(localStorage.getItem(KEY) || "null");
  // "1" = edits not yet pushed to Excel. null = a browser that predates the
  // marker, whose snapshot we keep rather than silently dropping.
  const pending = localStorage.getItem(PENDING_KEY);
  if (saved && pending !== "0") {
    st = saved;
    // Always carry the latest reference details (invoices/hotel breakdowns)
    // from the export, even when an older snapshot predates them.
    st.vendorDetails = base.vendorDetails;
  } else {
    // Nothing outstanding: Excel is the source of truth, so drop the snapshot.
    st = JSON.parse(JSON.stringify(base));
    localStorage.removeItem(KEY);
    localStorage.setItem(PENDING_KEY, "0");
  }
  $("#eventName").textContent = (base.event || "").replace(/^Wedding\s*[-–]\s*/i, "") || base.event;
  $("#genDate").textContent = base.generated;
  $("#yourName").value = localStorage.getItem(NAME_KEY) || "";
  renderAll(); wire();
  $("#saveState").textContent = "Auto-saved";
})();
