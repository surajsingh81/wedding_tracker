/* Wedding tracker — all state lives in localStorage; nothing is sent anywhere.
   A fresh data.json (exported from the workbook) is the baseline to reset to. */

const KEY = "wedding-tracker-v1";
const $  = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];

let base = null;   // last Excel export (immutable baseline)
let st   = null;   // live state = base + local edits

/* ------------------------------------------------------------------ helpers */
const inr = n => "₹" + Number(n || 0).toLocaleString("en-IN");
const esc = s => String(s ?? "").replace(/[&<>"']/g, c =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

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

/* -------------------------------------------------------------------- render */
function renderAll() {
  renderOverview();
  renderRooms();
  renderVendors();
  renderInvoices();
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
  ].map(([k, v, n, c]) =>
    `<div class="card ${c}"><div class="k">${esc(k)}</div><div class="v">${esc(v)}</div><div class="n">${esc(n || "&nbsp;")}</div></div>`
  ).join("");

  $("#nightBars").innerHTML = st.hotels.map(h => `
    <h3>${esc(h.name)}</h3>` + h.nights.map((n, i) => {
      const s = nightStatus(h, i);
      const pct = s.need ? Math.min(100, (s.f / s.need) * 100) : 0;
      return `<div class="night">
        <div class="night-h"><span class="d">${esc(n)}</span>
          <span class="s ${s.cls}">${s.f} of ${s.need} rooms &middot; ${esc(s.txt)}</span></div>
        <div class="track"><div class="fill ${s.cls}" style="width:${pct}%"></div></div>
      </div>`;
    }).join("")).join("");
}

function renderRooms() {
  $("#hotelPanels").innerHTML = st.hotels.map(h => {
    const cols = h.nights.map(n => `<th class="num">${esc(n.replace("-2026", ""))}</th>`).join("");
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

function renderVendors() {
  const cols = [["name", "Vendor"], ["contact", "Contact"], ["phone", "Phone"],
                ["event", "Event"], ["quoted", "Quoted"], ["paid", "Paid"], ["__bal", "Balance"],
                ["__st", "Status"]];
  $("#vendorTable").innerHTML =
    `<thead><tr>${cols.map(([k, l]) =>
      `<th class="${["quoted", "paid", "__bal"].includes(k) ? "num" : ""}">${l}</th>`).join("")}</tr></thead>
     <tbody>${st.vendors.map((v, i) => {
       const s = vendorStatus(v);
       return `<tr>
        <td class="sticky-col"><strong>${esc(v.name)}</strong>
          ${v.notes ? `<div class="dim">${esc(v.notes.slice(0, 90))}${v.notes.length > 90 ? "…" : ""}</div>` : ""}</td>
        <td>${esc(v.contact) || '<span class="dim">—</span>'}</td>
        <td>${v.phone ? `<a href="tel:${esc(v.phone)}">${esc(v.phone)}</a>` : '<span class="dim">—</span>'}
          ${v.whatsapp ? `<div class="dim">WA ${esc(v.whatsapp)}</div>` : ""}</td>
        <td>${esc(v.event) || '<span class="dim">—</span>'}${v.eventDate ? `<div class="dim">${esc(v.eventDate)}</div>` : ""}</td>
        <td class="num"><input class="cell" type="number" min="0" step="500" value="${v.quoted}"
            data-v="${i}" data-f="quoted" aria-label="Amount quoted for ${esc(v.name)}"></td>
        <td class="num"><input class="cell" type="number" min="0" step="500" value="${v.paid}"
            data-v="${i}" data-f="paid" aria-label="Amount paid to ${esc(v.name)}"></td>
        <td class="num">${s.bal === undefined ? '<span class="dim">—</span>' : inr(s.bal)}</td>
        <td class="num"><span class="pill ${s.cls}">${s.txt}</span></td>
      </tr>`;
     }).join("")}</tbody>`;

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

function renderInvoices() {
  $("#invoicePanels").innerHTML = Object.entries(st.vendorDetails).map(([name, d]) => {
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
function wire() {
  document.addEventListener("input", e => {
    const t = e.target;
    if (t.matches(".gcell input")) {
      const h = st.hotels.find(x => x.id === t.dataset.h);
      h.grid[+t.dataset.r][+t.dataset.n][+t.dataset.g] = t.value;
      save(); renderOverview();
      // repaint only this panel's summary rows, keeping the caret in place
      const tr = t.closest("tr");
      tr.classList.toggle("filled", !!(t.value || t.closest(".gcell").querySelector("input:not([value])")?.value));
      refreshRows(t.dataset.h);
    }
    if (t.matches("input.cell")) {
      const v = st.vendors[+t.dataset.v];
      v[t.dataset.f] = t.value === "" ? "" : Number(t.value);
      save(); renderOverview(); renderVendors();
      const again = $(`input.cell[data-v="${t.dataset.v}"][data-f="${t.dataset.f}"]`);
      if (again) { again.focus(); again.setSelectionRange(again.value.length, again.value.length); }
    }
  });

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

  $("#btnExport").onclick = () => {
    const blob = new Blob([JSON.stringify(st, null, 1)], { type: "application/json" });
    const a = Object.assign(document.createElement("a"), {
      href: URL.createObjectURL(blob),
      download: `wedding-tracker-${new Date().toISOString().slice(0, 10)}.json`,
    });
    a.click(); URL.revokeObjectURL(a.href);
  };
  $("#btnImport").onclick = () => $("#fileInput").click();
  $("#fileInput").onchange = e => {
    const f = e.target.files[0]; if (!f) return;
    const fr = new FileReader();
    fr.onload = () => {
      try { st = JSON.parse(fr.result); save(); renderAll(); flash("Imported"); }
      catch { flash("That file could not be read"); }
    };
    fr.readAsText(f);
    e.target.value = "";
  };
  $("#btnPrint").onclick = () => window.print();
  $("#btnReset").onclick = () => {
    if (!confirm("Discard your edits on this device and reload the last Excel export?")) return;
    localStorage.removeItem(KEY); st = JSON.parse(JSON.stringify(base)); renderAll(); flash("Reset");
  };
}

/* --------------------------------------------------------------------- boot */
(async function () {
  const res = await fetch("data.json", { cache: "no-cache" });
  base = await res.json();
  st = JSON.parse(localStorage.getItem(KEY) || "null") || JSON.parse(JSON.stringify(base));
  $("#eventName").textContent = base.event;
  $("#genDate").textContent = base.generated;
  renderAll(); wire();
  $("#saveState").textContent = "Auto-saved";
})();
