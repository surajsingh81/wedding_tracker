/* ============================================================================
   auth.js — a simple client-side gate.
   ----------------------------------------------------------------------------
   IMPORTANT: this is NOT real security. GitHub Pages is a static host, so the
   page, the data and this check all download to the visitor's browser. Anyone
   who knows how can bypass it or fetch data.json directly. It only keeps out
   casual visitors who have the link.

   To change the password:
     1. pick a new one, e.g.  echo -n "newpass" | shasum -a 256
     2. paste the hash below in place of AUTH.hash
     3. commit and push
   ========================================================================== */

const AUTH = {
  hash: "80a5b9d6f893cb40365d935d61ae35d4674b2f182bf7251244b627c4365eda31", // "wedding2026"
  key: "wedding-auth-v1",
};

async function sha256hex(str) {
  const buf = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(str));
  return [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, "0")).join("");
}

const AuthGate = {
  isAuthed() {
    return sessionStorage.getItem(AUTH.key) === "1";
  },
  show() {
    const el = $("#lockScreen");
    if (el) el.hidden = false;
  },
  async checkPassword(pw) {
    return (await sha256hex(pw)) === AUTH.hash;
  },
  async unlock(pw) {
    if (await this.checkPassword(pw)) {
      sessionStorage.setItem(AUTH.key, "1");
      location.reload();
      return true;
    }
    return false;
  },
  // Ask for the password again before a save action (Send to Excel).
  confirmSave() {
    return new Promise(resolve => {
      const el = $("#saveLock");
      const input = $("#saveLockPass");
      const err = $("#saveLockErr");
      if (!el || !input) return resolve(true);
      el.hidden = false;
      input.value = "";
      err.textContent = "";
      input.focus();
      $("#saveLockForm").onsubmit = async e => {
        e.preventDefault();
        if (await AuthGate.checkPassword(input.value)) {
          el.hidden = true;
          resolve(true);
        } else {
          err.textContent = "Wrong password.";
          input.value = "";
          input.focus();
        }
      };
      $("#saveLockCancel").onclick = () => { el.hidden = true; resolve(false); };
    });
  },
};

document.addEventListener("DOMContentLoaded", () => {
  const form = $("#lockForm");
  if (!form) return;
  form.addEventListener("submit", async e => {
    e.preventDefault();
    const input = $("#lockPass");
    const err = $("#lockErr");
    if (await AuthGate.unlock(input.value)) return;
    err.textContent = "Wrong password — try again.";
    input.value = "";
    input.focus();
  });
});