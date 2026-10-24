/* ============================================================================
   tests/test_js_sync_ui.js — sync status and shared-view rendering.
   ========================================================================== */

var E = H.env({ deps: { setTimeout: function () { return 1; } } });
var A = H.load(["app.js", "sync.js"], E.deps, [
  "setSt:function(v){st=v;}",
  "getSt:function(){return st;}",
  "setBase:function(v){base=v;}",
  "save", "setSaveIndicator", "reportRealtimeStatus", "renderAll",
  "renderRoomsMobile", "renderChanges", "importLegacyInvoice", "mSel",
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
    "Nirmal's Executive": {
      kind: "hotel", title: "Nirmal Hotel Cost Detail",
      booking: [["Check-in", "08-Dec-2026"], ["Check-out", "14-Dec-2026"], ["Total rooms", 10]],
      plan: [["08-Dec", 2, 2]], cost: [["Amount quoted", 84000], ["Amount paid", 25000]],
      contact: [], caption: "Reference details; vendor totals are unchanged.",
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
var desktopHotel = E.doc.querySelector("#hotelPanels").innerHTML;
var mobileHotel = E.doc.querySelector("#hotelMobile").innerHTML;
var hotelManagement = E.doc.querySelector("#hotelManagement").innerHTML;
S.ok(hotelManagement.includes('class="prebooked-count"')
     && hotelManagement.includes("08-Dec-2026"),
     "hotel management exposes editable booked-room counts per date");
S.ok(hotelManagement.includes('data-delete-hotel="nirmal"')
     && hotelManagement.includes("Manage dates & rooms"),
     "hotel management includes date controls and a delete action");
S.ok(desktopHotel.includes("Rooms with Guest") && !desktopHotel.includes("Pre-Booked Rooms")
     && !mobileHotel.includes('class="prebooked-count"'),
     "guest entry no longer mixes in hotel booking controls");
S.ok(mobileHotel.includes('role="group" aria-label="Choose a hotel"')
     && mobileHotel.includes('aria-pressed="true"'),
     "mobile hotel selection uses valid group and pressed-button semantics");
S.ok(E.doc.querySelector("#vendorTable").innerHTML.includes("Sync Test Vendor"),
     "Vendors view renders updated vendor data");
S.ok(E.doc.querySelector("#vendorTable").innerHTML.includes('data-label="Contact"')
     && E.doc.querySelector("#vendorTable").innerHTML.includes('data-label="Notes"'),
     "vendor edit fields include labels for the mobile card layout");
S.ok(E.doc.querySelector("#vendorTable").innerHTML.includes("vendor-remove"),
     "the remove-vendor action remains available in the mobile card");
S.ok(E.doc.querySelector("#vendorTable").innerHTML.includes('value="75000"'),
     "Payments view renders the updated payment");
S.ok(E.doc.querySelector("#vendorCards").innerHTML.includes("Sync Test Vendor")
     && E.doc.querySelector("#vendorCards").innerHTML.includes('data-f="paymentMode"')
     && E.doc.querySelector("#vendorCards").innerHTML.includes('value="75000"'),
     "mobile vendor cards show editable payment details and amounts");
S.ok(E.doc.querySelector("#vendorSummary").innerHTML.includes("75,000"),
     "Payments summary reflects updated totals");
S.ok(E.doc.querySelector("#invoicePanels").innerHTML.includes("Sync Test Invoice"),
     "Invoices view renders updated invoice details");
S.ok(E.doc.querySelector("#invoicePanels").innerHTML.includes('data-import-invoice="Nirmal&#39;s Executive" aria-label="Edit invoice details for Nirmal&#39;s Executive">Edit</button>'),
     "hotel cost details expose a concise Edit action");
S.ok(E.doc.querySelector("#invoicePanels").innerHTML.includes('class="table-scroll invoice-table-scroll invoice-line-items" role="region"')
     && E.doc.querySelector("#invoicePanels").innerHTML.includes("Invoice line items for Sync Test Vendor"),
     "invoice detail tables have a named, keyboard-scrollable region and caption");
S.ok(!E.doc.querySelector("#invoicePanels").innerHTML.includes("Make editable"),
     "legacy invoice actions no longer use the Make editable label");
A.editInvoice(-1);
S.eq(E.doc.querySelector("#invoiceVendorDetails").open, false,
     "new invoices keep optional vendor details collapsed");
var vendorWithDetails = A.getSt().vendors[0];
vendorWithDetails.contact = "Existing contact";
vendorWithDetails.paymentMode = "Bank transfer";
A.editInvoice(-1);
E.doc.querySelector("#invoiceTitle").value = "New standalone invoice";
E.doc.querySelector("#invoiceVendor").value = vendorWithDetails.name;
E.doc.querySelector("#invoiceAmount").value = "1000";
A.addOrUpdateInvoice({ preventDefault: function () {} });
S.eq(vendorWithDetails.contact, "Existing contact",
     "saving an invoice with collapsed details preserves existing vendor contacts");
S.eq(vendorWithDetails.paymentMode, "Bank transfer",
     "saving an invoice with collapsed details preserves the vendor payment mode");
A.importLegacyInvoice("Nirmal's Executive");
var hotelInvoice = A.getSt().invoices.find(invoice => invoice.sourceDetail === "Nirmal's Executive");
S.ok(!!hotelInvoice,
     "editing hotel cost details creates a linked editable invoice");
S.eq(hotelInvoice.amount, 84000,
     "the editable hotel invoice starts from its quoted amount");
S.eq(E.doc.querySelector("#invoiceForm").dataset.editIndex, String(A.getSt().invoices.indexOf(hotelInvoice)),
     "the linked invoice opens directly in the editor");
S.eq(E.doc.querySelector("#invoiceVendorDetails").open, true,
     "editing a linked invoice opens its existing vendor details");
A.importLegacyInvoice("Nirmal's Executive");
S.eq(A.getSt().invoices.filter(invoice => invoice.sourceDetail === "Nirmal's Executive").length, 1,
     "reopening a hotel detail edits its linked invoice instead of duplicating it");

state.vendors[0].paid = 80000;
state.invoices = [{
  id: "no-notes", title: "No Notes Invoice", vendor: "Sync Test Vendor",
  number: "", date: "", amount: "", status: "Unpaid", pdf: "", notes: "",
}];
A.setSt(state);
A.renderAll();
S.ok(E.doc.querySelector("#vendorTable").innerHTML.includes('value="80000"'),
     "Vendors view reflects the latest shared payment after switching back");
S.ok(E.doc.querySelector("#vendorSummary").innerHTML.includes("80,000"),
     "Payments summary refreshes after a shared change");
S.ok(E.doc.querySelector("#invoicePanels").innerHTML.includes("Updated remotely"),
     "Invoices view remains populated after a shared change");
S.ok(E.doc.querySelector("#invoicePanels").innerHTML.includes("No notes added.")
     && !E.doc.querySelector("#invoicePanels").innerHTML.includes('class="invoice-notes" disabled'),
     "invoices without notes do not expose an inactive disclosure control");

state.vendors[0].quoted = "125000";
A.setSt(state);
A.renderAll();
S.ok(E.doc.querySelector("#vendorSummary").innerHTML.includes("125,000"),
     "vendor payment totals add numeric values stored as form strings");

state.changeLog = [
  {
    t: "2026-10-24T06:00:00.000Z",
    who: "Asha",
    what: 'Quoted amount of "Sync Test Vendor": "90000" → "100000" · Payment mode of "Sync Test Vendor": (empty) → "UPI"',
    changes: [
      'Quoted amount of "Sync Test Vendor": "90000" → "100000"',
      'Payment mode of "Sync Test Vendor": (empty) → "UPI"',
    ],
  },
  {
    t: "2026-10-24T05:00:00.000Z",
    who: "Ravi",
    what: 'Changed vendor event · Updated vendor payment',
  },
];
A.setSt(state);
A.renderChanges();
S.ok(E.doc.querySelector("#changesList").innerHTML.includes('class="activity-details"')
     && E.doc.querySelector("#changesList").innerHTML.includes('class="activity-details"><li>Quoted amount')
     && E.doc.querySelector("#changesList").innerHTML.includes("<li>Payment mode")
     && E.doc.querySelector("#changesList").innerHTML.includes("<li>Changed vendor event</li>")
     && E.doc.querySelector("#changesList").innerHTML.includes("<li>Updated vendor payment</li>"),
     "new and previously grouped shared history lists each individual edit under its editor");

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
