/* ============================================================================
   tests/lib_harness.js — test harness for the browser code, run under JXA.

   There is no Node in this environment, but macOS ships JavaScriptCore and
   `osascript -l JavaScript` exposes it. That is enough to load the real
   app.js / sync.js / auth.js, drive them against a fake DOM, and assert on
   what they render — which covers far more of the app than clicking through a
   browser does, and runs in milliseconds.

   What the fake DOM supports (deliberately small — the app's real DOM surface):
     * querySelector / querySelectorAll with auto-vivified elements, so every
       $("#x") in the app resolves to a stable, inspectable stub
     * innerHTML / textContent / value / hidden / disabled / dataset
     * classList.add/remove/toggle/contains
     * closest(), matches(), addEventListener(), dispatchEvent()
     * click(), focus(), submitForm() helpers for the modal flows

   Tests are grouped into suites; each returns {name, pass, detail}.
   ========================================================================== */

ObjC.import('Foundation');

var H = (function () {
  var ROOT = "/Users/surajsingh/Documents/cowork_folder/wedding-tracker-site";

  function read(p) {
    var e = $.NSError.alloc.init;
    return $.NSString.stringWithContentsOfFileEncodingError(
      $.NSString.stringWithString(p), $.NSUTF8StringEncoding, e).js;
  }

  /* ------------------------------------------------------------- fake DOM */
  function El(sel) {
    this.sel = sel;
    this._html = "";
    this.textContent = "";
    this.value = "";
    this.hidden = false;
    this.disabled = false;
    this.dataset = {};
    this.attrs = {};
    this.style = {};
    this.listeners = {};
    this.parentEl = null;
    this.ownerDoc = null;
    this._cls = {};
    var self = this;
    this.classList = {
      add: function (c) { self._cls[c] = true; self._syncCls(); },
      remove: function (c) { delete self._cls[c]; self._syncCls(); },
      toggle: function (c, on) {
        if (on === undefined) on = !self._cls[c];
        if (on) self._cls[c] = true; else delete self._cls[c];
        self._syncCls(); return on;
      },
      contains: function (c) { return !!self._cls[c]; },
    };
  }
  Object.defineProperty(El.prototype, "innerHTML", {
    get: function () { return this._html; },
    set: function (v) { this._html = String(v); },
  });
  Object.defineProperty(El.prototype, "className", {
    get: function () { return Object.keys(this._cls).join(" "); },
    set: function (v) {
      var self = this; this._cls = {};
      String(v).split(/\s+/).forEach(function (c) { if (c) self._cls[c] = true; });
    },
  });
  El.prototype._syncCls = function () { this._clsStr = Object.keys(this._cls).join(" "); };

  // real-enough selector support for the handful of shapes the app uses:
  //   "#id"  ".cls"  "tag.cls"  '[data-x="y"]'  compound "#id [data-h='h']"
  //   and comma-separated lists like ".gcell input, .ginput"
  El.prototype.matches = function (sel) {
    sel = String(sel).trim();
    if (sel.indexOf(",") > -1) {
      var self = this;
      return sel.split(",").some(function (s) { return s.trim() && self._matchOne(s.trim()); });
    }
    return this._matchOne(sel);
  };
  El.prototype._matchOne = function (sel) {
    sel = String(sel).trim();
    var self = this;
    if (/^#[\w-]+$/.test(sel)) return this.id === sel.slice(1);
    if (/^\[data-([\w-]+)(?:="([^"]*)")?\]$/.test(sel)) {
      var m = sel.match(/^\[data-([\w-]+)(?:="([^"]*)")?\]$/);
      var key = m[1].replace(/-([a-z])/g, function (_, c) { return c.toUpperCase(); });
      if (m[2] === undefined) return self.dataset[key] !== undefined;
      return String(self.dataset[key]) === m[2];
    }
    // compound like ".gcell input" or "input.cell" — test each part against self/ancestry
    var parts = sel.split(/\s+/);
    var leaf = parts[parts.length - 1];
    var cls = (leaf.match(/\.([\w-]+)/g) || []).map(function (s) { return s.slice(1); });
    var clsOk = cls.every(function (c) { return self._cls[c]; });
    if (!clsOk) return false;
    // ascend for the earlier parts
    var node = this;
    for (var i = parts.length - 2; i >= 0; i--) {
      var pcls = (parts[i].match(/\.([\w-]+)/g) || []).map(function (s) { return s.slice(1); });
      var pid = (parts[i].match(/^#([\w-]+)$/) || [])[1];
      var found = false;
      while (node) {
        var okCls = pcls.every(function (c) { return node._cls[c]; });
        var okId = !pid || node.id === pid;
        if (okCls && okId) { found = true; break; }
        node = node.parentEl;
      }
      if (!found) return false;
    }
    return true;
  };
  El.prototype.closest = function (sel) {
    var node = this;
    while (node) { if (node.matches && node.matches(sel)) return node; node = node.parentEl; }
    return null;
  };
  El.prototype.querySelector = function (sel) { return Doc.auto(sel, this.ownerDoc || doc); };
  El.prototype.querySelectorAll = function () { return []; };
  El.prototype.addEventListener = function (t, fn) {
    (this.listeners[t] = this.listeners[t] || []).push(fn);
  };
  El.prototype.removeEventListener = function () {};
  El.prototype.focus = function () { if (this.ownerDoc) this.ownerDoc.activeEl = this; };
  El.prototype.select = function () {};
  El.prototype.scrollIntoView = function () {};
  El.prototype.click = function () { return this.dispatchEvent({ type: "click", target: this }); };
  El.prototype.dispatchEvent = function (ev) {
    ev.target = ev.target || this;
    // bubble to ancestors, then to document
    var node = this;
    while (node) {
      (node.listeners[ev.type] || []).forEach(function (fn) { fn(ev); });
      node = node.parentEl;
    }
    if (this.ownerDoc) (this.ownerDoc.listeners[ev.type] || []).forEach(function (fn) { fn(ev); });
    return true;
  };
  // fire a form's onsubmit / addEventListener submit with a preventDefault stub
  El.prototype.submitForm = function () {
    var ev = { type: "submit", target: this, preventDefault: function () {} };
    if (typeof this.onsubmit === "function") this.onsubmit(ev);
    (this.listeners.submit || []).forEach(function (fn) { fn(ev); });
    return ev;
  };

  function Doc() {
    this.cache = {};
    this.listeners = {};
    this.activeEl = null;
    this.visibilityState = "visible";
  }
  Doc.prototype.auto = function (sel, doc) {
    doc = doc || this;
    var key = (doc === this ? "d:" : "x:") + sel;
    if (!doc.cache[key]) {
      var e = new El(sel);
      e.ownerDoc = doc;
      var idm = sel.match(/^#([\w-]+)/);
      if (idm) e.id = idm[1];
      doc.cache[key] = e;
    }
    return doc.cache[key];
  };
  Doc.prototype.querySelector = function (sel) { return this.auto(sel, this); };
  Doc.prototype.querySelectorAll = function () { return []; };
  Doc.prototype.getElementById = function (id) { return this.auto("#" + id, this); };
  Doc.prototype.addEventListener = function (t, fn) { (this.listeners[t] = this.listeners[t] || []).push(fn); };
  Doc.prototype.createElement = function () { return new El("new"); };

  var doc = null;

  function makeStorage(initial) {
    var data = Object.assign({}, initial || {});
    return {
      _d: data,
      getItem: function (k) { return Object.prototype.hasOwnProperty.call(data, k) ? data[k] : null; },
      setItem: function (k, v) { data[k] = String(v); },
      removeItem: function (k) { delete data[k]; },
      clear: function () { data = {}; },
      key: function (i) { return Object.keys(data)[i]; },
      get length() { return Object.keys(data).length; },
    };
  }

  /* --------------------------------------------------------------- loader
     Compiles the real source files with injected globals and hands back the
     exported functions. The boot IIFE is stripped so importing a module never
     triggers a network fetch. */
  function load(files, deps, exportNames) {
    var names = Object.keys(deps), vals = names.map(function (k) { return deps[k]; });
    var src = files.map(function (f) {
      var s = read(ROOT + "/" + f);
      // drop everything from the boot IIFE onwards
      var i = s.indexOf("(async function () {");
      return i > -1 ? s.slice(0, i) : s;
    }).join("\n;\n");
    var ret = "return {" + exportNames.map(function (n) {
      return n.indexOf(":") > -1 ? n : (n + ":" + n);
    }).join(",") + "};";
    var fn = new Function(names.join(","), src + "\n" + ret);
    return fn.apply(null, vals);
  }

  function env(overrides) {
    doc = new Doc();
    var storage = makeStorage((overrides && overrides.storage) || {});
    var deps = {
      document: doc,
      localStorage: storage,
      addEventListener: function () {},
      setTimeout: function (fn) { return 0; },      // timers never fire: deterministic
      clearTimeout: function () {},
      performance: { now: function () { return 0; } },
      atob: function (s) { return s; },
      TextDecoder: function () { this.decode = function () { return "{}"; }; },
      Uint8Array: Uint8Array,
      crypto: { subtle: { digest: function () { return Promise.resolve(new Uint8Array(32)); } } },
      fetch: function () { return Promise.reject(new Error("offline in tests")); },
      confirm: function () { return true; },
      alert: function () {},
      console: console,
      window: (overrides && overrides.window) || { SYNC_ENDPOINT: "", SYNC_EMAIL: "" },
    };
    Object.assign(deps, (overrides && overrides.deps) || {});
    return { doc: doc, storage: storage, deps: deps };
  }

  /* ------------------------------------------------------------ assertions */
  function Suite(name) { this.name = name; this.rows = []; }
  Suite.prototype.ok = function (cond, label, detail) {
    this.rows.push({ n: label, pass: !!cond, d: detail === undefined ? "" : String(detail) });
  };
  Suite.prototype.eq = function (a, b, label) {
    var pass = JSON.stringify(a) === JSON.stringify(b);
    this.rows.push({ n: label, pass: pass, d: pass ? "" : ("got " + JSON.stringify(a) + " want " + JSON.stringify(b)) });
  };
  Suite.prototype.report = function () {
    var pass = 0, fail = 0, out = ["\n== " + this.name + " =="];
    this.rows.forEach(function (r) {
      if (r.pass) { pass++; out.push("  PASS  " + r.n); }
      else { fail++; out.push("  FAIL  " + r.n + (r.d ? "   [" + r.d + "]" : "")); }
    });
    out.push("  -- " + pass + " passed, " + fail + " failed");
    return { text: out.join("\n"), pass: pass, fail: fail, total: pass + fail };
  };

  /* File I/O so a JXA step can hand data to the Python side of an end-to-end
     run. IN_FILE / OUT_FILE are globals the runner prepends. */
  function readFile(path) {
    var err = $.NSError.alloc.init;
    var ns = $.NSString.stringWithContentsOfFileEncodingError(
      $(path).stringByStandardizingPath, $.NSUTF8StringEncoding, err);
    if (!ns) throw new Error("readFile failed: " + path);
    return ns.UTF8String;
  }
  function writeFile(path, text) {
    var err = $.NSError.alloc.init;
    var ok = $.NSString.stringWithString(text).writeToFileAtomicallyEncodingError(
      $(path).stringByStandardizingPath, true, $.NSUTF8StringEncoding, err);
    if (!ok) throw new Error("writeFile failed: " + path);
    return text;
  }

  return {
    ROOT: ROOT, read: read, El: El, Doc: Doc,
    env: env, load: load, Suite: Suite, storage: makeStorage,
    readFile: readFile, writeFile: writeFile,
    doc: function () { return doc; },
  };
})();

/* Every suite file ends by printing this; the Python runner reads it back.
   osascript does not reliably surface the value of the final expression in a
   concatenated script, so the report goes to OUT_FILE as well. */
function finish(suites) {
  var text = [], p = 0, f = 0, t = 0;
  suites.forEach(function (s) {
    var r = s.report();
    text.push(r.text); p += r.pass; f += r.fail; t += r.total;
  });
  text.push("");
  text.push("SUITE_RESULT: PASS " + p + " / FAIL " + f + " / TOTAL " + t);
  var out = text.join("\n");
  if (typeof OUT_FILE === "string" && OUT_FILE.length) {
    var err = $.NSError.alloc.init;
    $.NSString.stringWithString(out).writeToFileAtomicallyEncodingError(
      OUT_FILE, true, $.NSUTF8StringEncoding, err);
  }
  return out;
}