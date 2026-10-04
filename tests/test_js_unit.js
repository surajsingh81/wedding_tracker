/* ============================================================================
   tests/test_js_unit.js — layer 1: UNIT
   Every counting / normalisation / status helper in app.js and the payload
   builder in sync.js, driven directly. No DOM required.
   ========================================================================== */

function fixture() {
  return {
    event: "Wedding - Dec 2026",
    generated: "2026-10-04 12:00:00",
    hotels: [{
      id: "nirmal", name: "Nirmal",
      nights: ["08-Dec-2026", "09-Dec-2026", "10-Dec-2026"],
      checkIn: "08-Dec-2026", checkOut: "11-Dec-2026", checkoutTime: "",
      needed: [2, 3, 1], totalRooms: 4, roomsBooked: 4,
      roomNos: ["101", "102", "103", "104"],
      notes: ["Bring ID", "A|B", "X │ Y"],
      grid: [
        [["Suraj", "Priyanka", ""], ["Suraj", "", ""], ["", "", ""]],
        [["Randhir", "Asha", ""], ["Randhir", "", ""], ["", "", ""]],
        [["", "", ""], ["", "", ""], ["Meera", "", "Kavya"]],
        [["", "", ""], ["", "", ""], ["", "", ""]],
      ],
    }],
    vendors: [
      { row: 5, name: "DeepLaxmie", contact: "Ravi", phone: "", whatsapp: "",
        event: "Venue", eventDate: "08-Dec-2026", quoted: 100000, paid: 40000,
        paymentMode: "UPI", ref: "UTR1", paidOn: "01-Dec-2026", address: "",
        notes: "", isNew: false },
      { row: 6, name: "", contact: "", phone: "", whatsapp: "", event: "",
        eventDate: "", quoted: "", paid: "", paymentMode: "", ref: "",
        paidOn: "", address: "", notes: "", isNew: false },
    ],
    vendorDetails: {},
  };
}

var E = H.env({});
var A = H.load(["app.js", "sync.js", "auth.js"], E.deps, [
  "normalize", "dataSig", "esc", "wd", "inr",
  "filledRooms", "nightGuests", "nightThird", "roomGuests", "roomNights", "roomThird",
  "hotelStats", "hotelStatus", "nightStatus", "vendorStatus",
  "buildSyncPayload", "getChanges",
  "setSt:function(v){st=v;}", "setBase:function(v){base=v;}", "getSt:function(){return st;}",
]);

var S = [];
var u = new H.Suite("UNIT / normalize — legacy and malformed exports");

u.eq(A.normalize({ hotels: [{ nights: ["a", "b"], totalRooms: 2,
        grid: [[["A", "B"], ["C", "D"]]] }] }).hotels[0].grid[0][0],
   ["A", "B", ""], "two-slot cell gains an empty third slot");
u.eq(A.normalize({ hotels: [{ nights: ["a"], totalRooms: 3,
        grid: [[["A", "B"]]] }] }).hotels[0].grid.length, 3,
   "missing room rows padded up to totalRooms");
u.eq(A.normalize({ hotels: [{ nights: ["a"], totalRooms: 1,
        grid: [[["A"]], [["B"]], [["C"]]] }] }).hotels[0].grid.length, 1,
   "surplus room rows truncated to totalRooms");
u.eq(A.normalize({ hotels: [{ nights: ["a"], grid: [[["A"]]] }] }).hotels[0].totalRooms, 1,
   "totalRooms derived from grid length when absent");
u.eq(A.normalize({ hotels: [{ nights: ["a"], totalRooms: 2, grid: [[["A"]]] }] }).hotels[0].roomsBooked, 2,
   "missing roomsBooked defaults to totalRooms");
u.eq(A.normalize({ hotels: [{ nights: ["a"], totalRooms: 2, roomsBooked: "x",
        grid: [[["A"]]] }] }).hotels[0].roomsBooked, 2,
   "non-numeric roomsBooked falls back to totalRooms");
u.eq(A.normalize({ hotels: [{ nights: ["a"], totalRooms: 3, roomNos: ["101"],
        grid: [[["A"]]] }] }).hotels[0].roomNos, ["101", "", ""],
   "roomNos padded to totalRooms");
u.eq(A.normalize({ hotels: [] }).vendors, [], "missing vendors becomes []");
u.eq(A.normalize({ hotels: [{ nights: ["a"], totalRooms: 1, grid: [[null]] }] }).hotels[0].grid[0][0],
   ["", "", ""], "null cell becomes three empty slots");
S.push(u);

var c = new H.Suite("UNIT / counters");
var d = A.normalize(fixture());
var h = d.hotels[0];
c.eq(A.filledRooms(h, 0), 2, "filledRooms night 1 = 2");
c.eq(A.filledRooms(h, 1), 2, "filledRooms night 2 = 2");
c.eq(A.filledRooms(h, 2), 1, "filledRooms night 3 = 1");
c.eq(A.nightGuests(h, 0), 4, "nightGuests night 1 = 4");
c.eq(A.nightGuests(h, 1), 2, "nightGuests night 2 = 2");
c.eq(A.nightGuests(h, 2), 2, "nightGuests night 3 = 2");
c.eq(A.nightThird(h, 0), 0, "nightThird night 1 = 0 (no slot 3 filled)");
c.eq(A.roomGuests(h, 0), 3, "roomGuests room 1 = 3");
c.eq(A.roomGuests(h, 2), 2, "roomGuests room 3 = 2");
c.eq(A.roomGuests(h, 3), 0, "roomGuests room 4 = 0");
c.eq(A.roomNights(h, 0), 2, "roomNights room 1 = 2");
c.eq(A.roomNights(h, 2), 1, "roomNights room 3 = 1");
c.eq(A.roomNights(h, 3), 0, "roomNights room 4 = 0");
c.eq(A.roomThird(h, 0), 0, "roomThird room 1 = 0");

// a third occupant must count as a billable night AND still be one room
var h3 = A.normalize(JSON.parse(JSON.stringify(h)));
h3.grid[0][0][2] = "Kavya";
c.eq(A.filledRooms(h3, 0), 2, "a third guest does not add a room");
c.eq(A.nightGuests(h3, 0), 5, "a third guest adds one person");
c.eq(A.nightThird(h3, 0), 1, "a third guest is billable");
c.eq(A.roomThird(h3, 0), 1, "roomThird counts it");
c.eq(A.roomGuests(h3, 0), 4, "roomGuests includes it");
S.push(c);

var s = new H.Suite("UNIT / stats + status");
// room 3 night 3 carries a third guest ("Kavya" in slot 3), so the hotel has
// 8 guest-nights of which 1 is a billable third occupant
s.eq(A.hotelStats(h), { guestNights: 8, thirdNights: 1, needed: 6, filled: 5,
                        booked: 4, thirdGuests: 1 }, "hotelStats matches hand calculation");
var hs = A.hotelStatus(h);
s.eq(hs.roomsInUse, 3, "roomsInUse = 3");
s.eq(hs.booked.txt, "4 of 4 rooms", "booked pill text");
s.eq(hs.booked.cls, "ok", "fully booked pill is ok");
s.eq(hs.fill.txt, "3 of 4 rooms", "filled pill text");
s.eq(hs.fill.cls, "warn", "partly filled pill is warn");
s.eq(hs.current, { f: 2, need: 2, cls: "ok", txt: "OK" }, "first night is OK");

s.eq(A.nightStatus(h, 0), { f: 2, need: 2, cls: "ok", txt: "OK" }, "nightStatus ok");
s.eq(A.nightStatus(h, 1), { f: 2, need: 3, cls: "short", txt: "need 1 more" }, "nightStatus short");
s.eq(A.nightStatus(h, 2), { f: 1, need: 1, cls: "ok", txt: "OK" }, "nightStatus ok (third night)");
var hover = A.normalize({ hotels: [{ nights: ["a"], needed: [1], totalRooms: 2, roomsBooked: 2,
  grid: [[["A", "", ""]], [["B", "", ""]]] }] }).hotels[0];
s.eq(A.nightStatus(hover, 0), { f: 2, need: 1, cls: "over", txt: "1 over" }, "nightStatus over");

var hzero = A.normalize({ hotels: [{ nights: ["a"], needed: [1], totalRooms: 3, roomsBooked: 0,
  grid: [[["", "", ""]], [["", "", ""]], [["", "", ""]]] }] }).hotels[0];
var hz = A.hotelStatus(hzero);
s.eq(hz.fill.cls, "none", "nothing booked and nobody in = none");
s.eq(hz.roomsInUse, 0, "roomsInUse 0");

s.eq(A.vendorStatus({ quoted: "", paid: "" }), { cls: "none", txt: "Not quoted" }, "vendorStatus none");
s.eq(A.vendorStatus({ quoted: 100000, paid: 40000 }), { cls: "warn", txt: "Pending", bal: 60000 },
   "vendorStatus pending with balance");
s.eq(A.vendorStatus({ quoted: 100, paid: 100 }), { cls: "ok", txt: "Paid", bal: 0 }, "vendorStatus paid");
s.eq(A.vendorStatus({ quoted: 0, paid: 0 }), { cls: "ok", txt: "Paid", bal: 0 }, "vendorStatus 0/0 is paid");
S.push(s);

var f = new H.Suite("UNIT / formatting");
f.eq(A.wd("08-Dec-2026"), "Tue 08 Dec", "weekday abbreviation");
f.eq(A.wd("rubbish"), "rubbish", "unparseable date passes through");
f.eq(A.esc("a&b<c>d\"e'f"), "a&amp;b&lt;c&gt;d&quot;e&#39;f", "all five entities escaped");
f.eq(A.esc(null), "", "null escapes to empty string");
f.eq(A.inr(1234567), "₹12,34,567", "Indian digit grouping");
f.eq(A.inr(null), "₹0", "null money is zero");
S.push(f);

var sig = new H.Suite("UNIT / dataSig");
sig.eq(A.dataSig(d), A.dataSig(A.normalize(fixture())), "identical exports share a signature");
var d2 = A.normalize(fixture());
d2.hotels[0].grid[0][0][0] = "Someone else";
sig.ok(A.dataSig(d2) !== A.dataSig(d), "a changed guest name changes the signature");
var d3 = A.normalize(fixture());
d3.hotels[0].roomsBooked = 3;
sig.ok(A.dataSig(d3) !== A.dataSig(d), "roomsBooked is part of the signature");
var d4 = A.normalize(fixture());
d4.hotels[0].roomNos[2] = "999";
sig.ok(A.dataSig(d4) !== A.dataSig(d), "room numbers are part of the signature");
S.push(sig);

/* ----------------------------------------------- payload builder (delta) */
var p = new H.Suite("UNIT / buildSyncPayload — delta");
E.doc.querySelector("#yourName").value = "Aarti";

function freshPair() {
  var b = A.normalize(fixture());
  A.setBase(b);
  A.setSt(JSON.parse(JSON.stringify(b)));
}

freshPair();
var pay = A.buildSyncPayload();
p.eq(pay.guests.length, 0, "no edits -> no guest entries");
p.eq(pay.rooms.length, 0, "no edits -> no room lists");
p.eq(pay.mode, "delta", "mode is delta");
p.eq(pay.author, "Aarti", "author taken from the name box");
p.eq(pay.stats.cellsConsidered, 4 * 3 * 3, "all 36 grid cells considered");
p.eq(pay.baselineGenerated, "2026-10-04 12:00:00", "baseline stamp carried");

// one new name
freshPair();
A.getSt().hotels[0].grid[0][1][0] = "Neha";
pay = A.buildSyncPayload();
p.eq(pay.guests.length, 1, "one new name -> one entry");
p.eq(pay.guests[0], { hotel: "Nirmal", room: 1, night: "09-Dec-2026", slot: 1, name: "Neha" },
   "entry carries hotel/room/night/slot/name");
p.eq(pay.rooms.length, 0, "rooms untouched -> still nothing sent");

// a cleared name must survive the delta, or the workbook keeps a stale guest
freshPair();
A.getSt().hotels[0].grid[0][0][1] = "";
pay = A.buildSyncPayload();
p.eq(pay.guests.length, 1, "clearing a name still sends an entry");
p.eq(pay.guests[0].name, "", "the cleared entry carries an empty name (clear instruction)");
p.eq(pay.guests[0].slot, 2, "the cleared entry names the right slot");

// whitespace-only change is not a change
freshPair();
A.getSt().hotels[0].grid[0][0][1] = "Priyanka ";
p.eq(A.buildSyncPayload().guests.length, 0, "trailing whitespace is trimmed, not sent");

// third slot
freshPair();
A.getSt().hotels[0].grid[0][0][2] = "Kavya";
pay = A.buildSyncPayload();
p.eq(pay.guests[0].slot, 3, "third slot reports slot 3");
p.eq(pay.guests[0].room, 1, "third slot reports the right room");

// roomsBooked change
freshPair();
A.getSt().hotels[0].roomsBooked = 3;
pay = A.buildSyncPayload();
p.eq(pay.rooms.length, 1, "roomsBooked change sends the room list");
p.eq(pay.rooms[0].roomsBooked, 3, "new roomsBooked value");
p.eq(pay.guests.length, 0, "roomsBooked change alone sends no guest entries");

// room number change
freshPair();
A.getSt().hotels[0].roomNos[1] = "555";
pay = A.buildSyncPayload();
p.eq(pay.rooms.length, 1, "room number change sends the room list");
p.eq(pay.rooms[0].roomNos, ["101", "555", "103", "104"], "full room-number vector still sent");

// clearing a room number also has to propagate
freshPair();
A.getSt().hotels[0].roomNos[1] = "";
p.eq(A.buildSyncPayload().rooms[0].roomNos[1], "", "cleared room number is sent as empty");

// full mode
freshPair();
var full = A.buildSyncPayload({ full: true });
p.eq(full.mode, "full", "full mode is labelled");
p.eq(full.guests.length, 36, "full mode sends every cell (36)");
p.eq(full.rooms.length, 1, "full mode always sends room lists");

// Size: the whole point of the delta. Measured on a realistic hotel shape —
// 10 rooms x 6 nights x 3 slots = 180 cells, nearly all empty.
function bigHotel() {
  var b = fixture();
  var nights = [];
  for (var i = 0; i < 6; i++) nights.push("0" + (8 + i) + "-Dec-2026");
  var grid = [], nos = [], needed = [];
  for (var r = 0; r < 10; r++) {
    var row = [];
    for (var n = 0; n < 6; n++) row.push(["", "", ""]);
    grid.push(row); nos.push(String(100 + r)); needed.push(r < 3 ? 4 : 10);
  }
  grid[0][0] = ["Suraj", "Priyanka", ""];
  grid[1][0] = ["Randhir", "Asha", ""];
  grid[9][5] = ["Meera", "", "Kavya"];
  b.hotels[0].nights = nights;
  b.hotels[0].needed = needed;
  b.hotels[0].grid = grid;
  b.hotels[0].roomNos = nos;
  b.hotels[0].totalRooms = 10;
  b.hotels[0].roomsBooked = 10;
  return b;
}

freshPair = function () {
  var b = A.normalize(fixture());
  A.setBase(b);
  A.setSt(JSON.parse(JSON.stringify(b)));
};

var big = A.normalize(bigHotel());
A.setBase(big);
A.setSt(JSON.parse(JSON.stringify(big)));
A.getSt().hotels[0].grid[3][2][0] = "Neha";          // exactly one new name
var dBytes = JSON.stringify(A.buildSyncPayload()).length;
var fBytes = JSON.stringify(A.buildSyncPayload({ full: true })).length;
p.ok(dBytes < fBytes / 8, "on a 10x6x3 hotel one edit sends under an eighth of a full payload",
     dBytes + " vs " + fBytes + " bytes (" + (fBytes / dBytes).toFixed(1) + "x smaller)");
p.eq(A.buildSyncPayload().stats.cellsConsidered, 180, "all 180 grid cells are considered");
p.eq(A.buildSyncPayload().stats.guestsSent, 1, "only the one edited cell is sent");

// and the delta is always at least as small as the full payload
freshPair();
p.ok(JSON.stringify(A.buildSyncPayload()).length
     <= JSON.stringify(A.buildSyncPayload({ full: true })).length,
     "delta is never larger than full");

S.push(p);

finish([u, c, s, f, sig, p]);