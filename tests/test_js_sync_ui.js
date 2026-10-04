/* ============================================================================
   tests/test_js_sync_ui.js — sync status and shared-view rendering.
   ========================================================================== */

var E = H.env({ deps: { setTimeout: function () { return 1; } } });
var A = H.load(["app.js", "sync.js"], E.deps, [
  "setSt:function(v){st=v;}",
  "setBase:function(v){base=v;}",
  "save", "setSaveIndicator", "reportRealtimeStatus", "renderAll",
  "renderRoomsMobile", "mSel",
]);
var S = new H.Suite("SYNC UI / status and shared tabs");

var state = {
  event: "Wedding - Dec 2026",
  generated: "2026-10-04",
  hotels: [{
    id: "nirmal", name: "Nirmal", nights: ["08-Dec-2026"],
    checkIn: "08-Dec-2026", checkOut: "09-Dec-2026", checkoutTime: "",
    needed: [1], totalRooms: 1, roomsBooked: 1, roomNos: ["101"],
    notes: [], grid: [[["", "", ""]]],
  }],
  vendors: [{
    row: 5, name: "Sync Test Vendor", contact: "", phone: "", whatsapp: "",
    event: "Venue", eventDate: "08-Dec-2026", quoted: 100000, paid: 75000,
    paymentMode: "UPI", ref: "", paidOn: "", address: "", notes: "", isNew: false,
  }],
  vendorDetails: {
    "Sync Test Vendor": {
      kind: "invoice", title: "Sync Test Invoice", sub: "Updated remotely",
      items: [["Venue", 1, 10000, 10000]], totals: [["Total", 10000]],
      terms: "", pdf: "", caption: "",
    },
  },
};
A.setBase(state);
A.setSt(JSON.parse(JSON.stringify(state)));

A.save();
S.eq(E.doc.querySelector("#saveState").textContent, "Unsaved Sync",
     "an edit immediately shows Unsaved Sync");
S.eq(E.doc.querySelector("#btnSync").dataset.pending, "1",
     "an edit immediately highlights the desktop sync button");
S.eq(E.doc.querySelector("#btnSyncBar").dataset.pending, "1",
     "an edit immediately highlights the mobile sync button");
A.setSaveIndicator(false);
S.eq(E.doc.querySelector("#saveState").textContent, "Data Synced",
     "clearing pending state shows Data Synced");
S.eq(E.doc.querySelector("#btnSync").dataset.pending, "0",
     "the desktop sync highlight clears when synced");
S.eq(E.doc.querySelector("#btnSyncBar").dataset.pending, "0",
     "the mobile sync highlight clears when synced");
E.doc.querySelector("#syncToast").hidden = true;
A.reportRealtimeStatus("Sending changes to the shared tracker…", "msg-ok");
S.eq(E.doc.querySelector("#syncToast").hidden, false,
     "sending feedback appears in the visible sync toast");
S.eq(E.doc.querySelector("#syncToast").textContent, "Sending changes to the shared tracker…",
     "the toast explains that the sync request is in progress");
A.reportRealtimeStatus("Wrong password. Your changes are still saved on this device.", "msg-error");
S.eq(E.doc.querySelector("#syncToast").hidden, false,
     "sync failures are visible without scrolling to the footer");
S.eq(E.doc.querySelector("#syncToast").textContent,
     "Wrong password. Your changes are still saved on this device.",
     "the toast shows the exact password rejection feedback");
A.reportRealtimeStatus("Data Synced — no unsaved syncs remain.", "msg-ok");
S.eq(E.doc.querySelector("#syncToast").textContent,
     "Data Synced — no unsaved syncs remain.",
     "successful sync confirmation is visible in the toast");

A.renderAll();
S.ok(E.doc.querySelector("#vendorTable").innerHTML.includes("Sync Test Vendor"),
     "Vendors view renders updated vendor data");
S.ok(E.doc.querySelector("#vendorTable").innerHTML.includes('data-label="Contact"')
     && E.doc.querySelector("#vendorTable").innerHTML.includes('data-label="Notes"'),
     "vendor edit fields include labels for the mobile card layout");
S.ok(E.doc.querySelector("#vendorTable").innerHTML.includes("vendor-remove"),
     "the remove-vendor action remains available in the mobile card");
S.ok(E.doc.querySelector("#vendorTable").innerHTML.includes('value="75000"'),
     "Payments view renders the updated payment");
S.ok(E.doc.querySelector("#vendorSummary").innerHTML.includes("75,000"),
     "Payments summary reflects updated totals");
S.ok(E.doc.querySelector("#invoicePanels").innerHTML.includes("Sync Test Invoice"),
     "Invoices view renders updated invoice details");

state.vendors[0].paid = 80000;
A.setSt(state);
A.renderAll();
S.ok(E.doc.querySelector("#vendorTable").innerHTML.includes('value="80000"'),
     "Vendors view reflects the latest shared payment after switching back");
S.ok(E.doc.querySelector("#vendorSummary").innerHTML.includes("80,000"),
     "Payments summary refreshes after a shared change");
S.ok(E.doc.querySelector("#invoicePanels").innerHTML.includes("Updated remotely"),
     "Invoices view remains populated after a shared change");

state.hotels[0].totalRooms = 2;
state.hotels[0].roomsBooked = 2;
state.hotels[0].roomNos.push("");
state.hotels[0].grid.push([["", "", ""]]);
A.mSel.nirmal = 0;
A.renderRoomsMobile();
var mobileRooms = E.doc.querySelector("#hotelMobile").innerHTML;
S.ok(mobileRooms.includes("hotel room number for Room 1")
     && mobileRooms.includes('data-k="roomNo" data-r="0"'),
     "the selected room has an editable actual hotel room-number field");
S.ok(mobileRooms.includes("Tap a room above to switch the guest fields"),
     "the mobile room picker explains what selecting a room does");
S.ok(/<td[^>]*>101<\/td>/.test(mobileRooms),
     "the first room shows its own guest table and hotel number when selected");
S.ok(!/<td[^>]*>Room 2<\/td>/.test(mobileRooms),
     "guest tables for other rooms stay hidden until that room is selected");

A.mSel.nirmal = 1;
A.renderRoomsMobile();
mobileRooms = E.doc.querySelector("#hotelMobile").innerHTML;
S.ok(mobileRooms.includes("hotel room number for Room 2")
     && mobileRooms.includes('data-k="roomNo" data-r="1"'),
     "selecting another room switches its hotel room-number input");
S.ok(/data-r="1" data-n="0" data-g="0"/.test(mobileRooms),
     "selecting another room switches the guest-name fields too");

finish([S]);
