/* ============================================================================
   auth.js — editor password prompts for the live database and legacy relay. Viewing is open.
   ----------------------------------------------------------------------------
   Live database writes are authorized by the Supabase Edge Function. The hash
   below is retained only for the legacy Excel relay.

   To change the password:
     1. pick a new one, e.g.  echo -n "newpass" | shasum -a 256
     2. paste the hash below in place of AUTH.hash
     3. commit and push
   ========================================================================== */

const AUTH = {
  hash: "80a5b9d6f893cb40365d935d61ae35d4674b2f182bf7251244b627c4365eda31", // "wedding2026"
};

async function sha256hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

function trapLockFocus(el) {
  const onKeydown = event => {
    if (event.key === "Escape") {
      event.preventDefault();
      el.querySelector("[data-dialog-cancel]")?.click();
      return;
    }
    if (event.key !== "Tab") return;
    const focusable = [...el.querySelectorAll(
      'a[href],button:not(:disabled),input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])'
    )].filter(item => !item.hidden && item.getAttribute("aria-hidden") !== "true");
    if (!focusable.length) { event.preventDefault(); return; }
    const first = focusable[0], last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault(); last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault(); first.focus();
    }
  };
  el.addEventListener("keydown", onKeydown);
  return () => el.removeEventListener("keydown", onKeydown);
}

const AuthGate = {
  async checkPassword(pw) {
    return (await sha256hex(pw)) === AUTH.hash;
  },
  requestRealtimePassword(message) {
    return new Promise(resolve => {
      const el = $("#saveLock");
      const input = $("#saveLockPass");
      const err = $("#saveLockErr");
      if (!el || !input) return resolve(null);
      const returnTo = document.activeElement;
      const releaseFocus = trapLockFocus(el);
      el.hidden = false;
      input.value = "";
      err.textContent = message || "";
      input.focus();
      const close = () => {
        el.hidden = true;
        releaseFocus();
        if (returnTo?.isConnected) returnTo.focus();
      };
      $("#saveLockForm").onsubmit = e => {
        e.preventDefault();
        if (!input.value) {
          err.textContent = "Enter the live-edit password.";
          input.focus();
          return;
        }
        const password = input.value;
        input.value = "";
        close();
        resolve(password);
      };
      $("#saveLockCancel").onclick = () => { close(); resolve(null); };
    });
  },
  // Ask for the password before a save action (Send to Excel).
  confirmSave() {
    return new Promise(resolve => {
      const el = $("#saveLock");
      const input = $("#saveLockPass");
      const err = $("#saveLockErr");
      if (!el || !input) return resolve(true);
      const returnTo = document.activeElement;
      const releaseFocus = trapLockFocus(el);
      el.hidden = false;
      input.value = "";
      err.textContent = "";
      input.focus();
      const close = () => {
        el.hidden = true;
        releaseFocus();
        if (returnTo?.isConnected) returnTo.focus();
      };
      $("#saveLockForm").onsubmit = async e => {
        e.preventDefault();
        if (await AuthGate.checkPassword(input.value)) {
          close();
          resolve(true);
        } else {
          err.textContent = "Wrong password.";
          input.value = "";
          input.focus();
        }
      };
      $("#saveLockCancel").onclick = () => { close(); resolve(false); };
    });
  },
};