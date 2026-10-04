/* ============================================================================
   tests/test_js_realtime.js — manual shared-state sync and realtime reads.
   ========================================================================== */

var sequence = [];
var writeCount = 0;
var realtimeEvents = {};
var sharedReadOptions = null;
var passwordResponses = [];
var passwordPrompts = [];
var E = H.env({
  window: {
    SUPABASE_URL: "https://example.supabase.co",
    SUPABASE_PUBLIC_KEY: "public-key",
    supabase: {
      createClient: function () {
        return {
          channel: function () {
            return {
              on: function (_name, config, callback) {
                realtimeEvents[config.event] = callback;
                return this;
              },
              subscribe: function (callback) { callback("SUBSCRIBED"); return this; },
            };
          },
        };
      },
    },
  },
  deps: {
    setTimeout: function (fn) {
      return 1;
    },
    clearTimeout: function () {},
    AuthGate: {
      requestRealtimePassword: function (message) {
        sequence.push("password");
        passwordPrompts.push(message);
        return Promise.resolve(passwordResponses.length
          ? passwordResponses.shift()
          : "correct horse");
      },
    },
  },
});

var remote = { event: "Wedding", vendors: [{ row: 5, name: "Original" }] };
var writeRequest = null;
E.deps.fetch = function (url, options) {
  if (url.indexOf("/rest/v1/") > -1) {
    sharedReadOptions = options;
    return Promise.resolve({
      ok: true,
      json: function () {
        return Promise.resolve(JSON.parse(JSON.stringify([{ data: remote }])));
      },
    });
  }
  writeCount++;
  sequence.push("write");
  writeRequest = JSON.parse(options.body);
  if (writeRequest.password === "wrong") {
    return Promise.resolve({
      status: 401,
      ok: false,
      text: function () { return Promise.resolve('{"error":"Wrong password"}'); },
    });
  }
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
      return Promise.resolve(JSON.parse(JSON.stringify({ data: remote, backupQueued: true })));
    },
  });
};

var R = H.load(["realtime.js"], E.deps, ["RealtimeSync:window.RealtimeSync"]);
var S = new H.Suite("REALTIME / Supabase shared state");

(async function () {
  var loaded = await R.RealtimeSync.load();
  S.eq(loaded, remote, "initial state loads from the shared row");
  S.eq(sharedReadOptions.cache, "no-store", "shared-state reads bypass browser cache");
  S.eq(sharedReadOptions.headers["Cache-Control"], "no-cache, no-store, max-age=0",
       "shared-state reads request fresh intermediary responses");

  var state = JSON.parse(JSON.stringify(remote));
  state.defaulted = "normalized";
  var base = null;
  var status = "";
  var localPending = false;
  R.RealtimeSync.start({
    getState: function () { return state; },
    normalize: function (value) {
      if (!Object.hasOwn(value, "defaulted")) value.defaulted = "normalized";
      return value;
    },
    setState: function (value) { state = value; },
    setBase: function (value) { base = value; },
    getName: function () { return "Aarti"; },
    promptName: function () {
      sequence.push("name");
      return Promise.resolve(true);
    },
    flushLocal: function () { sequence.push("flush-local"); },
    setPending: function (value) { localPending = value; },
    setSyncBusy: function (busy) { sequence.push(busy ? "busy" : "idle"); },
    render: function () {},
    status: function (message) { status = message; },
  });

  remote.vendors[0].name = "Changed on another phone";
  await R.RealtimeSync.refresh();
  S.eq(state.vendors[0].name, "Changed on another phone",
       "a fresh shared-state check applies changes missed by the realtime socket");
  S.eq(base.vendors[0].name, "Changed on another phone",
       "a fresh shared-state check advances the local baseline");
  S.eq(localPending, false,
       "normalizing the shared row does not create a false unsynced local change");

  state.vendors[0].name = "Updated";
  S.eq(writeCount, 0, "editing does not write to Supabase automatically");
  S.eq(sequence, [], "editing does not prompt for name or password");

  await R.RealtimeSync.syncNow();

  S.eq(writeRequest.action, "patch", "existing shared state receives a patch");
  S.eq(writeRequest.patches, [{
    path: ["vendors", "0", "name"], value: "Updated",
  }], "only the changed field is sent");
  S.eq(writeRequest.author, "Aarti", "the editor name accompanies the write");
  S.eq(writeRequest.password, "correct horse", "the prompted password accompanies the write");
  S.eq(sequence, ["flush-local", "name", "password", "busy", "write", "idle"],
       "manual sync asks name then password before writing and only then shows busy");
  S.eq(remote.vendors[0].name, "Updated", "successful writes update shared state");
  S.eq(base.vendors[0].name, "Updated", "successful writes advance the baseline");
  S.eq(localPending, false, "successful writes clear the pending marker");
  S.eq(status, "Data Synced — no unsaved syncs remain. Excel backup queued in the background.",
       "successful writes report live sync and queued backup");

  state.vendors[0].name = "Retry succeeds";
  passwordResponses = ["wrong", "correct horse"];
  var retryStart = sequence.length;
  await R.RealtimeSync.syncNow();
  S.eq(sequence.slice(retryStart), [
    "flush-local", "name", "password", "busy", "write", "idle",
    "password", "busy", "write", "idle",
  ], "a rejected password keeps the sync flow available for a retry");
  S.eq(passwordPrompts[2], "Wrong password. Please try again.",
       "the retry password dialog clearly identifies a rejected password");
  S.eq(remote.vendors[0].name, "Retry succeeds",
       "a correct retry publishes the pending edit");
  S.eq(localPending, false, "a successful retry clears the pending marker");
  S.eq(status, "Data Synced — no unsaved syncs remain. Excel backup queued in the background.",
       "a successful retry reports the completed sync");

  var noChangesStart = sequence.length;
  await R.RealtimeSync.syncNow();
  S.eq(sequence.slice(noChangesStart), ["flush-local", "idle"],
       "a sync with no changes does not ask for credentials or call the writer");
  S.eq(writeCount, 3, "only actual edits are sent to the writer");

  state.vendors[0].name = "Local unsynced";
  localPending = true;
  remote.vendors[0].name = "Remote update";
  realtimeEvents.UPDATE({ new: { data: remote } });
  S.eq(state.vendors[0].name, "Local unsynced",
       "incoming realtime updates do not overwrite an unsynced local edit");
  S.eq(localPending, true, "a local edit stays marked pending after remote changes");
  S.eq(writeCount, 3, "incoming realtime updates never trigger a database write");
  S.ok(/tap Sync changes/.test(status), "the status tells the user how to publish local edits");
  remote.vendors[0].name = "Remote while offline";
  await R.RealtimeSync.refresh();
  S.eq(state.vendors[0].name, "Local unsynced",
       "catch-up refreshes keep this device's unsynced edits");
  S.eq(base.vendors[0].name, "Remote while offline",
       "catch-up refreshes still advance the shared baseline");
  finish([S]);
})().catch(function (error) {
  S.ok(false, "realtime suite completes", String(error && (error.stack || error)));
  finish([S]);
});
