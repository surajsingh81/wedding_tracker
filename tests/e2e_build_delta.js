/* ============================================================================
   tests/e2e_build_delta.js — one step of the end-to-end run.

   Reads a data.json export, replays a realistic set of edits the way the page
   would, and writes out the delta payload the page would POST. Run under JXA by
   tests/test_py_e2e.py, with IN_FILE / OUT_FILE / ACTOR prepended.
   ========================================================================== */
var E = H.env({
  deps: {
    window: { SYNC_ENDPOINT: "", SYNC_EMAIL: "" },
    setTimeout: function () { return 0; },
    clearTimeout: function () {},
  },
});

var A = H.load(["app.js", "sync.js", "auth.js"], E.deps, [
  "normalize", "buildSyncPayload", "setName",
  "setSt:function(v){st=v;}", "setBase:function(v){base=v;}", "getSt:function(){return st;}",
]);

// The page does exactly this: render, let the user type, send only what changed.
var d = A.normalize(JSON.parse(H.readFile(IN_FILE)));
A.setBase(JSON.parse(JSON.stringify(d)));
A.setSt(JSON.parse(JSON.stringify(d)));
A.setName(ACTOR);

var h = null;
for (var i = 0; i < A.getSt().hotels.length; i++) {
  if (A.getSt().hotels[i].id === "nirmal") h = A.getSt().hotels[i];
}
if (!h) throw new Error("no nirmal hotel in " + IN_FILE);

if (ACTOR !== "__NOOP__") {
  // 1. overwrite a guest who is already there
  h.grid[0][0][0] = ACTOR;
  // 2. clear a filled cell
  h.grid[0][0][1] = "";
  // 3. a third occupant
  h.grid[0][0][2] = ACTOR + " plus one";
  // 4. change the booked count and one room number
  h.roomsBooked = Math.max(0, (h.roomsBooked || 0) - 1);
  h.roomNos[1] = "E2E-2";
}

var payload = (ACTOR === "__FULL__") ? A.buildSyncPayload({full:true}) : A.buildSyncPayload();
H.writeFile(OUT_FILE, JSON.stringify(payload));
