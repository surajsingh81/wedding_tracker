/* Shared live state backed by Supabase. The browser key is public; writes go
   through an Edge Function that checks a server-side password. */
(function () {
  const TABLE = "tracker_state";
  const ROW_URL = () => `${window.SUPABASE_URL}/rest/v1/${TABLE}?id=eq.1&select=data`;
  let client = null;
  let remoteState = null;
  let writing = false;
  let app = null;
  let refreshTimer = 0;
  let refreshInFlight = false;
  const REFRESH_INTERVAL = 15000;

  const clone = value => JSON.parse(JSON.stringify(value));
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const headers = () => ({
    apikey: window.SUPABASE_PUBLIC_KEY,
    "Cache-Control": "no-cache, no-store, max-age=0",
    Pragma: "no-cache",
    Authorization: `Bearer ${window.SUPABASE_PUBLIC_KEY}`,
  });

  function diff(before, after, path, out) {
    if (equal(before, after)) return;
    if (Array.isArray(before) && Array.isArray(after) && before.length === after.length) {
      before.forEach((value, i) => diff(value, after[i], path.concat(String(i)), out));
      return;
    }
    if (before && after && typeof before === "object" && typeof after === "object"
        && !Array.isArray(before) && !Array.isArray(after)) {
      const keys = new Set([...Object.keys(before), ...Object.keys(after)]);
      for (const key of keys) {
        if (Object.hasOwn(after, key)) diff(before[key], after[key], path.concat(key), out);
        else out.push({ path: path.concat(key), value: null });
      }
      return;
    }
    out.push({ path, value: after });
  }

  function setPath(root, path, value) {
    let target = root;
    for (const part of path.slice(0, -1)) target = target[Array.isArray(target) ? +part : part];
    const key = path[path.length - 1];
    target[Array.isArray(target) ? +key : key] = value;
  }

  function patchesBetween(before, after) {
    const patches = [];
    diff(before, after, [], patches);
    return patches.filter(p => p.path.length);
  }

  async function readRow() {
    const response = await fetch(ROW_URL(), {
      headers: headers(),
      cache: "no-store",
    });
    if (!response.ok) throw new Error(`Supabase read failed (HTTP ${response.status})`);
    const rows = await response.json();
    return rows.length ? rows[0].data : null;
  }

  async function refreshShared() {
    if (!app || refreshInFlight || document.visibilityState === "hidden") return;
    refreshInFlight = true;
    const expectedRemote = remoteState;
    try {
      const next = await readRow();
      if (remoteState !== expectedRemote) return;
      if (next) reconcile(next);
    } catch (error) {
      app.status(`Could not refresh shared data: ${error.message}`, "msg-error");
    } finally {
      refreshInFlight = false;
    }
  }

  function scheduleRefresh() {
    clearTimeout(refreshTimer);
    refreshTimer = setTimeout(async () => {
      await refreshShared();
      scheduleRefresh();
    }, REFRESH_INTERVAL);
  }

  async function askForPassword(message) {
    const password = await AuthGate.requestRealtimePassword(message);
    if (!password) throw new Error("Live save cancelled");
    return password;
  }

  async function invokeWriter(action, payload, password) {
    const url = `${window.SUPABASE_URL}/functions/v1/tracker-write`;
    const response = await fetch(url, {
      method: "POST",
      headers: { ...headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ action, password, ...payload }),
    });
    if (response.status === 401) {
      throw new Error("The live-edit password was rejected. Try again.");
    }
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Live save failed (HTTP ${response.status}): ${detail}`);
    }
    const result = await response.json();
    return result;
  }

  function reconcile(next, prior = remoteState) {
    if (!app || !next) return;
    const previous = prior;
    const incoming = app.normalize ? app.normalize(clone(next)) : clone(next);
    const pending = previous ? patchesBetween(previous, app.getState()) : [];
    remoteState = clone(incoming);
    app.setBase(incoming);
    const merged = clone(remoteState);
    for (const patch of pending) setPath(merged, patch.path, patch.value);
    const remaining = patchesBetween(remoteState, merged);
    const changed = !equal(app.getState(), merged);
    app.setState(merged);
    if (changed) app.render();
    if (app.setPending(remaining.length > 0) === false) {
      app.status("Shared data updated, but this device could not update its local save. Check browser storage.", "msg-error");
      return null;
    }
    if (remaining.length)
      app.status("Shared updates received. Your edits are still local; tap Sync changes to publish them.", "msg-warn");
    else if (changed)
      app.status("Data Synced — shared changes received.", "msg-ok");
    return remaining.length > 0;
  }

  async function syncNow() {
    if (writing || !app) return;
    writing = true;
    try {
      if (app.flushLocal() === false) {
        app.status("Could not save the latest edits on this device. Check browser storage before syncing.", "msg-error");
        return;
      }
      if (!await app.promptName(
        "Enter your name to identify the edits you are about to share.")) {
        app.status("Sync cancelled. Your edits are still saved on this device.", "msg-warn");
        return;
      }
      const password = await askForPassword(
        "Enter the live-edit password to share your saved changes.");
      app.setSyncBusy(true);
      const state = clone(app.getState());
      let result;
      if (!remoteState) {
        result = await invokeWriter("initialize", { data: state }, password);
      } else {
        const patches = patchesBetween(remoteState, state);
        if (!patches.length) {
          if (app.setPending(false) === false) {
            app.status("Could not update the local sync marker. Check browser storage.", "msg-error");
            return;
          }
          app.status("Data Synced — there are no unsaved changes.", "msg-ok");
          return;
        }
        result = await invokeWriter("patch", {
          patches,
          author: app.getName() || "Anonymous",
        }, password);
      }
      if (!result?.data || typeof result.data !== "object") {
        throw new Error("Sync returned no shared data. Your edits remain local; try again.");
      }
      const hasPending = reconcile(result.data);
      if (hasPending === null) return;
      if (hasPending) {
        app.status("Data Synced, but newer edits remain unsaved. Tap Sync changes again.", "msg-warn");
      } else {
        app.status(result.backupQueued === true
          ? "Data Synced — no unsaved syncs remain. Excel backup queued in the background."
          : "Data Synced — no unsaved syncs remain.", "msg-ok");
      }
    } catch (error) {
      app.status(error.message === "Live save cancelled"
        ? "Sync cancelled. Your edits are still saved on this device."
        : error.message, error.message === "Live save cancelled" ? "msg-warn" : "msg-error");
    } finally {
      writing = false;
      app.setSyncBusy(false);
    }
  }

  window.RealtimeSync = {
    async load() {
      if (!window.SUPABASE_URL || !window.SUPABASE_PUBLIC_KEY) return null;
      try {
        remoteState = await readRow();
        return remoteState;
      } catch (error) {
        console.warn("Supabase is not ready; loading the published workbook export.", error);
        return null;
      }
    },
    start(options) {
      app = options;
      if (!window.SUPABASE_URL || !window.SUPABASE_PUBLIC_KEY) return;
      if (remoteState && app.normalize)
        remoteState = app.normalize(clone(remoteState));
      addEventListener("focus", refreshShared);
      addEventListener("online", refreshShared);
      document.addEventListener("visibilitychange", () => {
        if (document.visibilityState === "visible") refreshShared();
      });
      scheduleRefresh();
      if (!window.supabase?.createClient) {
        app.status("Realtime library did not load. Reload to reconnect.", "msg-error");
        return;
      }
      client = window.supabase.createClient(window.SUPABASE_URL, window.SUPABASE_PUBLIC_KEY);
      client.channel("tracker-live")
        .on("postgres_changes", {
          event: "UPDATE", schema: "public", table: TABLE, filter: "id=eq.1",
        }, event => reconcile(event.new.data))
        .on("postgres_changes", {
          event: "INSERT", schema: "public", table: TABLE, filter: "id=eq.1",
        }, event => reconcile(event.new.data))
        .subscribe(status => {
          if (status === "SUBSCRIBED")
            app.status("Connected — shared updates arrive live; tap Sync changes to publish your edits.", "msg-ok");
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT")
            app.status("Realtime connection failed. Check Supabase setup and reload.", "msg-error");
        });
    },
    refresh: refreshShared,
    syncNow,
  };
})();
