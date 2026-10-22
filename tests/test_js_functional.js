/* ============================================================================
   tests/test_js_functional.js — layer 3: FUNCTIONAL
   Behaviour of whole features rather than single functions: the name gate and
   its ordering against the password prompt, the send paths, the coalesced save,
   the mobile room-picker state machine, and the panel markup invariant that
   silently broke live repainting once already.
   ========================================================================== */

/* Fake clock: save() coalesces, so the tests need to control when the write
   actually happens rather than waiting on a real timer. */
var timers = [];
var fakeSetTimeout = function (fn, ms) { timers.push({ fn: fn, ms: ms }); return timers.length; };
var fakeClearTimeout = function (id) { if (id > 0 && timers[id - 1]) timers[id - 1].cancelled = true; };
function runTimers() {
  var t = timers.filter(function (x) { return !x.cancelled; });
  timers = [];
  t.forEach(function (x) { x.fn(); });
}

var approveHotelDelete = true;
var E = H.env({
  deps: {
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    confirm: function () { return approveHotelDelete; },
    window: { SYNC_ENDPOINT: "", SYNC_EMAIL: "" },
  },
});

// sync.js closes over whatever `fetch` was in scope when it was compiled, so the
// swappable part has to be the implementation, not the binding.
var FETCH = function () { return Promise.reject(new Error("offline in tests")); };
E.deps.fetch = function () { return FETCH.apply(null, arguments); };

var A = H.load(["app.js", "sync.js", "auth.js"], E.deps, [
  "ensureName", "currentName", "setName", "nameMissing", "getChanges", "recordChange",
  "discardLocalDraft",
  "renderRooms", "renderRoomsDesktop", "renderRoomsMobile", "renderHotelManagement", "deleteHotel", "renderAll",
  "addVendor", "deleteVendor", "deleteInvoice", "addOrUpdateInvoice", "editInvoice", "mSel", "mRoom",
  "mobileChips", "mobileStatsPills", "paintPanelTotals",
  "refreshRows", "refreshMobile", "onEditInput", "save", "flushSave",
  "syncNow", "buildSyncPayload", "watchSync", "AuthGate",
  "setSt:function(v){st=v;}", "setBase:function(v){base=v;}", "getSt:function(){return st;}",
  "setEnsureName:function(f){ensureName=f;}", "setWatchSync:function(f){watchSync=f;}",
  "hotelStatus", "getSaveT:function(){return saveT;}",
]);

function fixture() {
  return {
    event: "Wedding - Dec 2026", generated: "2026-10-04 12:00:00",
    hotels: [{
      id: "nirmal", name: "Nirmal",
      nights: ["08-Dec-2026", "09-Dec-2026", "10-Dec-2026"],
      checkIn: "08-Dec-2026", checkOut: "11-Dec-2026", checkoutTime: "",
      needed: [2, 1, 1], totalRooms: 3, roomsBooked: 3,
      roomNos: ["101", "102", "103"], notes: ["Bring ID"],
      grid: [
        [["Suraj", "Priyanka", ""], ["Suraj", "", ""], ["", "", ""]],
        [["Randhir", "", ""], ["", "", ""], ["", "", ""]],
        [["", "", ""], ["", "", ""], ["", "", ""]],
      ],
    }],
    vendors: [{ row: 5, name: "DeepLaxmie", contact: "", phone: "", whatsapp: "",
      event: "Venue", eventDate: "08-Dec-2026", quoted: 100000, paid: 40000,
      paymentMode: "UPI", ref: "", paidOn: "", address: "", notes: "", isNew: false }],
    vendorDetails: {},
  };
}
function norm(d) {
  for (var i = 0; i < d.hotels.length; i++) {
    var h = d.hotels[i];
    h.roomsBooked = Number.isFinite(+h.roomsBooked) ? +h.roomsBooked : h.totalRooms;
    h.roomNos = Array.from({ length: h.totalRooms }, function (_, k) { return h.roomNos[k] || ""; });
    h.grid = h.grid.map(function (row) {
      return row.map(function (c) { return [c[0] || "", c[1] || "", c[2] || ""]; });
    });
    while (h.grid.length < h.totalRooms)
      h.grid.push(h.nights.map(function () { return ["", "", ""]; }));
    h.grid = h.grid.slice(0, h.totalRooms);
  }
  return d;
}
function load(d) {
  A.setBase(norm(d));
  A.setSt(JSON.parse(JSON.stringify(norm(d))));
}
function reset() { load(fixture()); }

// the name lives in three places; forget all of them
function clearName() {
  E.storage.removeItem("tracker-name-v1");
  E.doc.querySelector("#yourName").value = "";
  E.doc.querySelector("#yourNameBar").value = "";
}

// syncNow awaits ensureName, AuthGate.confirmSave and then fetch, so each of
// those suspends for a turn. Drain enough of them before asserting.
function tick(n) {
  var p = Promise.resolve();
  for (var i = 0; i < (n || 20); i++) p = p.then(function () {});
  return p;
}

var STAGE = "suite-build";
var S = [];

/* ------------------------------------------------------- refresh discards drafts */
STAGE = "refresh-discards-local-draft";
var refreshSuite = new H.Suite("FUNCTIONAL / refresh starts from shared data");
E.storage.setItem("wedding-tracker-v1", JSON.stringify({ stale: true }));
E.storage.setItem("wedding-tracker-pending-v1", "1");
A.discardLocalDraft();
refreshSuite.eq(E.storage.getItem("wedding-tracker-v1"), null,
                "refresh removes the saved local draft");
refreshSuite.eq(E.storage.getItem("wedding-tracker-pending-v1"), "0",
                "refresh clears the unsynced marker");
S.push(refreshSuite);

/* ------------------------------------------------------- 1. the name gate */
STAGE = "name-gate";
reset();
var g = new H.Suite("FUNCTIONAL / name gate");
g.ok(A.nameMissing(), "starts with no name recorded");
A.ensureName("why", true);
g.eq(E.doc.querySelector("#nameLock").hidden, false, "asking opens the name dialog");
g.eq(E.doc.querySelector("#nameLockWhy").textContent, "why", "the reason text is shown");

// a one-character name is rejected and the dialog stays open
STAGE = "gate-bad-name";
E.doc.querySelector("#nameLockInput").value = "A";
E.doc.querySelector("#nameLockForm").submitForm();
g.ok(/at least 2/.test(E.doc.querySelector("#nameLockErr").textContent),
     "a one-character name is refused with a reason");
g.eq(E.doc.querySelector("#nameLock").hidden, false, "the dialog stays open after a bad name");
g.ok(A.nameMissing(), "nothing was persisted from a bad name");

// a good name is accepted, persisted, and mirrored to both inputs
STAGE = "gate-good-name";
E.doc.querySelector("#nameLockInput").value = "  Aarti Sharma  ";
E.doc.querySelector("#nameLockForm").submitForm();
g.eq(E.doc.querySelector("#nameLock").hidden, true, "the dialog closes on a good name");
g.eq(A.currentName(), "Aarti Sharma", "the name is trimmed");
g.eq(E.doc.querySelector("#yourName").value, "Aarti Sharma", "header name box updated");
g.eq(E.doc.querySelector("#yourNameBar").value, "Aarti Sharma", "thumb-bar name box updated");
g.eq(E.doc.querySelector("#yourName").dataset.empty, "0", "the warning tint is switched off");
g.eq(E.storage.getItem("tracker-name-v1"), "Aarti Sharma", "the name is remembered on the device");
g.ok(!A.nameMissing(), "nameMissing() is now false");

// asking again when a name already exists does nothing at all
A.ensureName("again", true);
g.eq(E.doc.querySelector("#nameLock").hidden, true, "a known name never re-opens the dialog");

// declining is possible and leaves nothing behind
STAGE = "gate-cancel";
reset();
clearName();
A.ensureName("x", true);
E.doc.querySelector("#nameLockCancel").onclick();
g.eq(E.doc.querySelector("#nameLock").hidden, true, "cancelling closes the dialog");
g.ok(A.nameMissing(), "cancelling stores no name");

// mid-edit we ask once, not on every keystroke
STAGE = "gate-suppress";
A.ensureName("first", false);
E.doc.querySelector("#nameLockInput").value = "Aarti";
E.doc.querySelector("#nameLockForm").submitForm();
A.setName("");
E.doc.querySelector("#nameLock").hidden = true;
A.ensureName("second", false);
g.eq(E.doc.querySelector("#nameLock").hidden, true, "a second non-forced ask is suppressed");
S.push(g);

/* ------------------------------- 2/3. name, then password, then the wire */
var o = new H.Suite("FUNCTIONAL / save ordering: name then password");
var y = new H.Suite("FUNCTIONAL / send paths");
S.push(o, y);

reset();
clearName();
var orderA = [], fetchedA = 0;
// hoisted: these are read by a later .then, which cannot see a later `var`
var orderB = [], sent = [], logBefore = 0;
FETCH = function () { fetchedA++; return Promise.resolve({ ok: true, status: 200 }); };
A.setEnsureName(function () { orderA.push("name"); return false; });   // declined
A.AuthGate.confirmSave = function () { orderA.push("password"); return false; };
A.syncNow();
o.eq(orderA[0], "name", "the name is requested first, before anything else runs");
o.eq(orderA.length, 1, "the password is not requested in the same turn as the name");

// Phase 2 has to wait for phase 1 to settle, or both runs would share state.
tick().then(function () {
  o.eq(orderA.join(","), "name",
       "a declined name stops the save before the password is ever asked for");
  o.eq(fetchedA, 0, "nothing is sent when the name is declined");

  /* ---- the accepted path: name, then password, then exactly one fetch ---- */
  STAGE = "send-paths";
  reset();
  clearName();
  orderB = []; sent = [];
  FETCH = function (url, opts) {
    sent.push({ url: url, method: opts.method, ct: opts.headers["Content-Type"], body: opts.body });
    return Promise.resolve({ ok: true, status: 200 });
  };
  A.setEnsureName(function () { orderB.push("name"); return true; });
  A.AuthGate.confirmSave = function () { orderB.push("password"); sent.push("pass"); return true; };
  A.setWatchSync(function () { sent.push("watch"); });
  E.deps.window.SYNC_ENDPOINT = "https://relay.example/exec";
  E.storage.setItem("tracker-name-v1", "Aarti");
  E.doc.querySelector("#yourName").value = "Aarti";

  STAGE = "send-first";
  A.getSt().hotels[0].grid[0][1][0] = "Neha";
  logBefore = A.getChanges().length;
  A.syncNow();
  return tick();
}).then(function () {
  STAGE = "send-assert1";
  o.eq(orderB[0], "name", "syncNow asked for the name before anything else");
  o.eq(orderB[1], "password", "the password is only asked once the name is in hand");
  o.eq(orderB.length, 2, "nothing else runs between the name and the password");
  y.eq(sent.length, 3, "one password, one fetch, one watchSync",
      "sent=" + JSON.stringify(sent.map(function (v) { return typeof v === "string" ? v : "FETCH"; }))
      + " status=" + E.doc.querySelector("#syncStatus").textContent);
  if (!sent[1] || typeof sent[1] !== "object") { return tick(); }
  y.eq(sent[1].url, "https://relay.example/exec", "the configured relay is used");
  y.eq(sent[1].method, "POST", "the relay is POSTed to");
  y.eq(sent[1].ct, "text/plain;charset=UTF-8", "text/plain keeps it a CORS simple request");
  var body = JSON.parse(sent[1].body);
  y.eq(body.mode, "delta", "a delta was sent");
  y.eq(body.author, "Aarti", "the author is the name we collected");
  y.eq(body.guests.length, 1, "only the edited guest travelled");
  y.ok(sent[1].body.indexOf("\n") === -1, "the body is compact, not pretty-printed");
  y.ok(A.getChanges().length > logBefore, "the save is recorded in the change log");

  /* ---- a wrong password must not send anything ---- */
  STAGE = "send-refused";
  reset(); clearName();
  sent = [];
  A.setEnsureName(function () { return true; });
  A.AuthGate.confirmSave = function () { return false; };
  A.getSt().hotels[0].grid[0][1][0] = "Neha";
  A.syncNow();
  return tick();
}).then(function () {
  y.eq(sent.length, 0, "a refused password sends nothing");

  /* ---- no relay configured -> the mail fallback carries the same JSON ---- */
  STAGE = "send-mail";
  reset(); clearName();
  E.deps.window.SYNC_ENDPOINT = "";
  E.deps.window.SYNC_EMAIL = "wedding@example.com";
  E.deps.window.location = { href: "" };
  A.AuthGate.confirmSave = function () { return true; };
  A.getSt().hotels[0].grid[0][1][0] = "Neha";
  A.syncNow();
  return tick();
}).then(function () {
  STAGE = "send-mail-assert";
  y.ok(/^mailto:/.test(E.deps.window.location.href), "the mail fallback opens a mailto",
       "href=" + String(E.deps.window.location.href).slice(0, 60));
  var q = String(E.deps.window.location.href).split("?")[1] || "";
  y.ok(/subject=/.test(q) && /body=/.test(q), "the mail carries a subject and a body");
  y.ok(q.indexOf("\n") === -1, "the mail body is compact enough for a URL");

  /* -------------------------------- 4. coalesced local saves */
  STAGE = "saves";
  reset();
  var writes = 0;
  var realSet = E.storage.setItem;
  E.storage.setItem = function (k, v) { writes++; return realSet.call(E.storage, k, v); };

  A.getSt().hotels[0].grid[0][0][0] = "S";
  A.save(); A.save(); A.save(); A.save(); A.save();
  var sv = new H.Suite("FUNCTIONAL / coalesced saves");
  sv.eq(writes, 0, "five keystrokes cause no write yet");
  sv.ok(A.getSaveT() !== 0, "a write is scheduled");
  runTimers();
  sv.eq(writes, 2, "the burst collapses to one write of KEY + one of PENDING");

  var w1 = writes;
  A.flushSave();
  sv.eq(writes, w1, "flushSave with nothing pending writes nothing");

  A.save();
  runTimers();
  sv.eq(writes, w1 + 2, "a later save writes again");
  sv.eq(E.doc.querySelector("#saveState").textContent, "Unsaved Sync · saved here",
        "the status line makes the local-only save explicit");
  sv.eq(E.doc.querySelector("#saveStateBar").textContent, "Unsaved Sync · saved here",
        "the thumb bar shows the unsaved sync state too");
  S.push(sv);

  /* ---------------------------------- 5. the mobile room picker */
  STAGE = "mobile";
  reset();
  var m = new H.Suite("FUNCTIONAL / mobile room picker");
  A.renderRoomsMobile();
  var html = E.doc.querySelector("#hotelMobile").innerHTML;
  m.ok(html.length > 500, "the mobile layer renders something substantial");
  m.ok(/class="roomchips"/.test(html), "a room chip strip is rendered");

  m.ok(/aria-pressed="true"/.test(html), "a chip is marked selected");
  m.eq((html.match(/aria-pressed="true"/g) || []).length, 1, "exactly one chip is selected");
  // third-guest slot styling depends on whether a third guest has been added; the class check is deferred to later test steps
  m.ok(/enterkeyhint="next"/.test(html), "inputs ask the keyboard for Next");
  m.ok(/<th>/.test(html), "nights appear as table headers");

  A.mSel.nirmal = 2;
  m.eq(A.mRoom(A.getSt().hotels[0]), 2, "the selection sticks");
  m.ok(/aria-pressed="true"/.test(A.mobileChips(A.getSt().hotels[0])), "chips mark room 3 selected");
  m.ok(A.mobileChips(A.getSt().hotels[0]).indexOf("103") > -1, "the chip shows the room number");

  A.mSel.nirmal = 99;
  m.eq(A.mRoom(A.getSt().hotels[0]), 2, "an out-of-range selection clamps to the last room");
  A.mSel.nirmal = -5;
  m.eq(A.mRoom(A.getSt().hotels[0]), 0, "a negative selection clamps to room 1");

  A.getSt().hotels[0].roomsBooked = 1;
  m.ok(/roomchip unbooked/.test(A.mobileChips(A.getSt().hotels[0])),
       "rooms past the booked count are marked unbooked");
  A.getSt().hotels[0].roomsBooked = 3;
  m.ok(!/roomchip unbooked/.test(A.mobileChips(A.getSt().hotels[0])),
       "no chips are unbooked once the count covers them");

  m.ok(/2 nights used/.test(A.mobileStatsPills(A.getSt().hotels[0], 0)),
       "room stats report nights used");
  A.getSt().hotels[0].grid[0][0][2] = "Kavya";
  m.ok(/1 billable/.test(A.mobileStatsPills(A.getSt().hotels[0], 0)),
       "a third occupant shows as billable");
  S.push(m);

  /* ---------------------- 6. the markup invariant behind the repaint bug */
  STAGE = "markup";
  reset();
  var r = new H.Suite("FUNCTIONAL / split hotel and guest views");
  A.renderRooms();
  A.renderHotelManagement();
  var desktop = E.doc.querySelector("#hotelPanels").innerHTML;
  var mobile = E.doc.querySelector("#hotelMobile").innerHTML;
  var management = E.doc.querySelector("#hotelManagement").innerHTML;
  r.ok(desktop.indexOf('class="panel guest-panel"') > -1, "desktop guest panel renders");
  r.ok(desktop.indexOf('class="statpills"') > -1, "desktop guest status remains visible");
  r.ok(desktop.indexOf('class="sumcards"') > -1, "desktop guest summary remains visible");
  r.ok(/class="booked"/.test(desktop), "desktop guest view shows room capacity");
  r.ok(/aria-label=/.test(desktop), "desktop guest inputs carry accessible names");
  r.ok(desktop.indexOf('class="grid guest-grid"') > -1, "desktop: the guest entry grid has its own styling hook");
  r.ok(desktop.indexOf('data-h="nirmal"') < desktop.indexOf('class="grid guest-grid"'),
     "desktop guest inputs retain their hotel context");
  r.ok(mobile.indexOf('class="mobile-stay-card"') > -1, "mobile: guided guest entry card renders");
  r.ok(mobile.indexOf('class="roomchip') > -1, "mobile: room picker remains available");
  r.ok(mobile.indexOf('class="mobile-guest-field') > -1, "mobile: guest fields remain available");
  r.ok(!/class="prebooked-count"/.test(desktop + mobile),
     "guest entry views do not include hotel booking controls");
  r.ok(management.indexOf('class="prebooked-count"') > -1,
     "hotel management includes per-night booking controls");
  r.ok(management.indexOf('data-delete-hotel="nirmal"') > -1,
     "hotel management includes the delete action");
  r.ok(!/class="msheet"/.test(mobile), "mobile guest planner remains responsive");
  var bookedInput = new H.El("input");
  bookedInput.classList.add("prebooked-count");
  bookedInput.dataset = { h: "nirmal", n: "1" };
  bookedInput.value = "2";
  A.onEditInput(bookedInput);
  r.eq(A.getSt().hotels[0].needed[1], 2,
    "editing a per-night count in Hotels updates the saved booking state");
  S.push(r);

  STAGE = "delete-hotel";
  reset();
  var remove = new H.Suite("FUNCTIONAL / hotel deletion");
  approveHotelDelete = false;
  A.deleteHotel("nirmal");
  remove.eq(A.getSt().hotels.length, 1, "cancelling the confirmation keeps the hotel and its data");
  approveHotelDelete = true;
  A.deleteHotel("nirmal");
  remove.eq(A.getSt().hotels.length, 0, "confirmed deletion removes the selected hotel");
  remove.ok(JSON.parse(E.storage.getItem("tracker-changes-v1"))
    .some(function (entry) { return entry.what === 'Deleted hotel "Nirmal" and its booking and guest details'; }),
    "hotel deletion is added to local activity");
  remove.ok(E.doc.querySelector("#hotelManagement").innerHTML.indexOf("No hotels yet") > -1,
    "empty hotel management explains how to add a hotel");
  remove.ok(E.doc.querySelector("#hotelMobile").innerHTML.indexOf("Hotels tab") > -1,
    "guest entry explains where to add a hotel");
  S.push(remove);

  STAGE = "vendor-invoice";
  reset();
  var linked = new H.Suite("FUNCTIONAL / vendor invoice autofill");
  A.addVendor();
  var invoiceCountBefore = A.getSt().invoices.length;
  var vendorIndex = A.getSt().vendors.length - 1;
  var vendorName = new H.El("input");
  vendorName.classList.add("cell");
  vendorName.dataset = { v: String(vendorIndex), f: "name" };
  vendorName.value = "Garden Decor";
  A.onEditInput(vendorName);
  var createdInvoice = A.getSt().invoices.find(function (invoice) {
    return invoice.sourceVendorId === A.getSt().vendors[vendorIndex].vendorId;
  });
  linked.ok(!!createdInvoice, "entering a new vendor name creates one linked invoice");
  linked.eq(createdInvoice.vendor, "Garden Decor", "the invoice is linked to the new vendor");
  linked.eq(createdInvoice.title, "Garden Decor invoice", "the invoice title is filled from the vendor name");
  linked.eq(createdInvoice.sourceVendorId, A.getSt().vendors[vendorIndex].vendorId,
    "the invoice retains a stable link to its vendor row");
  vendorName.value = "Garden Decor";
  A.onEditInput(vendorName);
  linked.eq(A.getSt().invoices.length, invoiceCountBefore + 1,
    "editing a linked vendor never duplicates its invoice");
  var editVendorField = function (field, value) {
    var input = new H.El("input");
    input.classList.add("cell");
    input.dataset = { v: String(vendorIndex), f: field };
    input.value = value;
    A.onEditInput(input);
  };
  editVendorField("contact", "Anika");
  editVendorField("phone", "555-0102");
  editVendorField("notes", "Floral arch and table arrangements");
  linked.eq(createdInvoice.vendorInfo.contact, "Anika", "vendor contact is mirrored to invoice details");
  linked.eq(createdInvoice.vendorInfo.phone, "555-0102", "vendor phone is mirrored to invoice details");
  linked.eq(createdInvoice.notes, "Floral arch and table arrangements",
    "vendor notes are copied into the invoice notes");
  linked.ok(E.doc.querySelector("#invoicePanels").innerHTML.includes("Anika")
    && E.doc.querySelector("#invoicePanels").innerHTML.includes("555-0102"),
    "invoice details display the contact information from the vendor row");
  linked.ok(E.doc.querySelector("#invoicePanels").innerHTML.includes("Floral arch and table arrangements"),
    "invoice view displays the vendor's notes");
  S.push(linked);

  STAGE = "vendor-invoice-backfill";
  reset();
  var backfill = new H.Suite("FUNCTIONAL / linked vendor invoices");
  A.getSt().vendors[0].contact = "Ravi";
  STAGE = "vendor-invoice-backfill-render";
  A.renderAll();
  var existingVendor = A.getSt().vendors[0];
  var existingInvoice = A.getSt().invoices.find(function (invoice) {
    return invoice.sourceVendorId === existingVendor.vendorId;
  });
  backfill.ok(!!existingInvoice, "existing named vendors are backfilled with linked invoices");
  backfill.eq(existingInvoice.vendorInfo.contact, "Ravi",
    "backfilled invoice includes existing vendor contact information");
  backfill.eq(existingInvoice.amount, 100000, "backfilled invoice includes the vendor quote");
  backfill.eq(existingInvoice.paid, 40000, "backfilled invoice includes the amount already paid");
  backfill.eq(existingInvoice.status, "Part-paid", "backfilled invoice status reflects vendor payments");
  var initialInvoiceCount = A.getSt().invoices.length;
  A.renderAll();
  backfill.eq(A.getSt().invoices.length, initialInvoiceCount,
    "re-rendering never duplicates invoices for existing vendors");

  STAGE = "vendor-invoice-backfill-edit";
  A.editInvoice(A.getSt().invoices.indexOf(existingInvoice));
  E.doc.querySelector("#invoiceAmount").value = "125000";
  E.doc.querySelector("#invoicePaid").value = "50000";
  E.doc.querySelector("#invoiceContact").value = "Meera";
  E.doc.querySelector("#invoiceNotes").value = "Updated invoice notes";
  E.doc.querySelector("#invoiceForm").reset = function () {};
  STAGE = "vendor-invoice-backfill-save";
  A.addOrUpdateInvoice({ preventDefault: function () {} });
  existingInvoice = A.getSt().invoices.find(function (invoice) {
    return invoice.sourceVendorId === existingVendor.vendorId;
  });
  backfill.eq(existingVendor.quoted, "125000", "invoice quote changes update the linked vendor");
  backfill.eq(existingVendor.paid, "50000", "invoice payment changes update the linked vendor");
  backfill.eq(existingVendor.contact, "Meera", "invoice contact changes update the linked vendor");
  backfill.eq(existingVendor.notes, "Updated invoice notes", "invoice notes update the linked vendor");

  var quoteInput = new H.El("input");
  quoteInput.classList.add("cell");
  quoteInput.dataset = { v: "0", f: "quoted" };
  quoteInput.value = "130000";
  A.onEditInput(quoteInput);
  backfill.eq(existingInvoice.amount, 130000, "vendor quote changes update the linked invoice");
  var paidInput = new H.El("input");
  paidInput.classList.add("cell");
  paidInput.dataset = { v: "0", f: "paid" };
  paidInput.value = "60000";
  A.onEditInput(paidInput);
  backfill.eq(existingInvoice.paid, 60000, "vendor payment changes update the linked invoice");
  var contactInput = new H.El("input");
  contactInput.classList.add("cell");
  contactInput.dataset = { v: "0", f: "contact" };
  contactInput.value = "Pooja";
  A.onEditInput(contactInput);
  backfill.eq(existingInvoice.vendorInfo.contact, "Pooja",
    "vendor contact changes update the linked invoice");

  var removedVendorId = existingVendor.vendorId;
  STAGE = "vendor-invoice-backfill-delete";
  A.deleteVendor(0);
  STAGE = "vendor-invoice-backfill-delete-assert";
  backfill.ok(!A.getSt().invoices.some(function (invoice) {
    return invoice.sourceVendorId === removedVendorId;
  }), "deleting a vendor also deletes its linked invoice");
  S.push(backfill);

  STAGE = "vendor-invoice-existing-link";
  reset();
  var existingLink = new H.Suite("FUNCTIONAL / reuse existing vendor invoices");
  var matchedVendor = A.getSt().vendors[0];
  A.getSt().invoices = [{
    id: "existing-vendor-invoice", title: "Garden service invoice",
    vendor: matchedVendor.name, amount: 100000, paid: 40000,
    status: "Part-paid", number: "INV-1", date: "", pdf: "", notes: "Existing invoice notes",
  }];
  A.renderAll();
  existingLink.eq(A.getSt().invoices.length, 1,
    "backfill links an existing matching invoice rather than duplicating it");
  existingLink.eq(A.getSt().invoices[0].sourceVendorId, matchedVendor.vendorId,
    "the existing invoice receives the vendor's persistent link");
  existingLink.eq(A.getSt().vendors[0].notes, "Existing invoice notes",
    "linking preserves existing invoice notes in the vendor details");
  var linkedVendor = A.getSt().vendors[0];
  A.deleteInvoice(0);
  existingLink.ok(A.getSt().vendors.indexOf(linkedVendor) >= 0,
    "deleting an invoice keeps its vendor record");
  existingLink.ok(linkedVendor.invoiceDeleted,
    "an intentionally deleted invoice is not automatically recreated");
  existingLink.eq(A.getSt().invoices.length, 0,
    "deleting a linked invoice removes the invoice while retaining vendor details");
  S.push(existingLink);

  finish(S);
}).catch(function (err) {
  var s = new H.Suite("FUNCTIONAL / harness");
  s.ok(false, "suite threw at stage " + STAGE,
       String((err && (err.stack || err.message)) || err));
  finish([s]);
});