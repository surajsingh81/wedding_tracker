/* ============================================================================
   tests/test_js_realtime.js — shared realtime persistence and patching.
   ========================================================================== */

var pendingTimers = [];
var timerId = 0;
var E = H.env({
  window: {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_PUBLIC_KEY: "public-key",
    supabase: {
      createClient: function () {
        return {
          channel: function () {
            return {
              on: function () { return this; },
              subscribe: function (callback) { callback("SUBSCRIBED"); return this; },
            };
          },
        };
      },
    },
  },
  deps: {
    setTimeout: function (fn) {
      pendingTimers.push(fn);
      return ++timerId;
    },
    clearTimeout: function () {},
    AuthGate: {
      requestRealtimePassword: function () { return Promise.resolve("correct horse"); },
    },
  },
});

var remote = { event: "Wedding", vendors: [{ row: 5, name: "Original" }] };
var writeRequest = null;
E.deps.fetch = function (url, options) {
  if (url.indexOf("/rest/v1/") > -1)
    return Promise.resolve({
      ok: true,
      json: function () {
        return Promise.resolve(JSON.parse(JSON.stringify([{ data: remote }])));
      },
    });
  writeRequest = JSON.parse(options.body);
  writeRequest.patches.forEach(function (patch) {
    var target = remote;
    patch.path.slice(0, -1).forEach(function (part) {
      target = target[Array.isArray(target) ? +part : part];
    });
    var key = patch.path[patch.path.length - 1];
    target[Array.isArray(target) ? +key : key] = patch.value;
  });
  return Promise.resolve({
    ok: true,
    json: function () {
      return Promise.resolve(JSON.parse(JSON.stringify({ data: remote })));
    },
  });
};

var R = H.load(["realtime.js"], E.deps, ["RealtimeSync:window.RealtimeSync"]);
var S = new H.Suite("REALTIME / Supabase shared state");

(async function () {
  var loaded = await R.RealtimeSync.load();
  S.eq(loaded, remote, "initial state loads from the shared row");

  var state = JSON.parse(JSON.stringify(remote));
  var base = null;
  var status = "";
  R.RealtimeSync.start({
    getState: function () { return state; },
    setState: function (value) { state = value; },
    setBase: function (value) { base = value; },
    getName: function () { return "Aarti"; },
    ensureName: function () { return Promise.resolve(true); },
    render: function () {},
    status: function (message) { status = message; },
    hasPending: false,
  });

  state.vendors[0].name = "Updated";
  R.RealtimeSync.queueSave();
  pendingTimers.shift()();
  for (var i = 0; i < 12; i++) await Promise.resolve();

  S.eq(writeRequest.action, "patch", "existing shared state receives a patch");
  S.eq(writeRequest.patches, [{
    path: ["vendors", "0", "name"], value: "Updated",
  }], "only the changed field is sent");
  S.eq(writeRequest.author, "Aarti", "the editor name accompanies the write");
  S.eq(remote.vendors[0].name, "Updated", "successful writes update shared state");
  S.eq(base.vendors[0].name, "Updated", "successful writes advance the baseline");
  S.eq(E.storage.getItem("wedding-tracker-pending-v1"), "0",
       "successful writes clear the pending marker");
  S.eq(pendingTimers.length, 0, "an acknowledged patch does not requeue itself");
  S.eq(status, "✓ Changes saved and shared live.", "successful writes report live sync");
  finish([S]);
})().catch(function (error) {
  S.ok(false, "realtime suite completes", String(error && (error.stack || error)));
  finish([S]);
});
