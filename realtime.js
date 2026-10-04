/* Shared live state backed by Supabase. The browser key is public; writes go
   through an Edge Function that checks a server-side password. */
(function () {
  const TABLE = "tracker_state";
  const ROW_URL = () => `${window.SUPABASE_URL}/rest/v1/${TABLE}?id=eq.1&select=data`;
  let client = null;
  let remoteState = null;
  let accessPassword = null;
  let timer = 0;
  let writing = false;
  let dirty = false;
  let app = null;

  const clone = value => JSON.parse(JSON.stringify(value));
  const equal = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const headers = () => ({
    apikey: window.SUPABASE_PUBLIC_KEY,
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

  async function askForPassword(message) {
    if (accessPassword) return accessPassword;
    const password = await AuthGate.requestRealtimePassword(message);
    if (!password) throw new Error("Live save cancelled");
    return password;
  }

  async function invokeWriter(action, payload, message) {
    const url = `${window.SUPABASE_URL}/functions/v1/tracker-write`;
    let password = await askForPassword(message);
    const response = await fetch(url, {
      method: "POST",
      headers: { ...headers(), "Content-Type": "application/json" },
      body: JSON.stringify({ action, password, ...payload }),
    });
    if (response.status === 401) {
      accessPassword = null;
      throw new Error("The live-edit password was rejected. Try again.");
    }
    if (!response.ok) {
      const detail = await response.text();
      throw new Error(`Live save failed (HTTP ${response.status}): ${detail}`);
    }
    const result = await response.json();
    accessPassword = password;
    return result;
  }

  function reconcile(next, prior = remoteState) {
    if (!app || !next) return;
    const previous = prior;
    const pending = previous ? patchesBetween(previous, app.getState()) : [];
    remoteState = clone(next);
    app.setBase(next);
    const merged = clone(remoteState);
    for (const patch of pending) setPath(merged, patch.path, patch.value);
    const remaining = patchesBetween(remoteState, merged);
    const changed = !equal(app.getState(), merged);
    app.setState(merged);
    if (changed) app.render();
    if (remaining.length) queueSave();
    else {
      localStorage.setItem("wedding-tracker-pending-v1", "0");
      localStorage.removeItem("wedding-tracker-v1");
    }
  }

  async function persist() {
    if (!app) return;
    const state = clone(app.getState());
    const patches = remoteState ? patchesBetween(remoteState, state) : [];
    if (!remoteState) {
      const result = await invokeWriter(
        "initialize", { data: state },
        "Enter the live-edit password to connect this device.");
      reconcile(result.data, state);
      return result.backupQueued === true;
    }
    if (!patches.length) return;
    const result = await invokeWriter(
      "patch", { patches, author: app.getName() || "Anonymous" },
      "Enter the live-edit password to save your changes.");
    reconcile(result.data);
    return result.backupQueued === true;
  }

  async function drain() {
    if (writing || !dirty) return;
    writing = true;
    dirty = false;
    try {
      if (!await app.ensureName(
        "Enter your name so other editors can see who made each change.", true))
        throw new Error("Live save cancelled");
      const backupQueued = await persist();
      app.status(backupQueued
        ? "✓ Shared live; Excel backup queued in the background."
        : "✓ Changes saved and shared live.", "msg-ok");
    } catch (error) {
      if (error.message !== "Live save cancelled")
        app.status(error.message, "msg-error");
    } finally {
      writing = false;
      if (dirty) queueSave();
    }
  }

  function queueSave() {
    dirty = true;
    clearTimeout(timer);
    timer = setTimeout(drain, 450);
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
          if (status === "SUBSCRIBED") app.status("Connected — changes sync live.", "msg-ok");
          if (status === "CHANNEL_ERROR" || status === "TIMED_OUT")
            app.status("Realtime connection failed. Check Supabase setup and reload.", "msg-error");
        });
      if (options.hasPending) queueSave();
    },
    queueSave,
  };
})();
