/**
 * Wedding Tracker — "Save on cloud" relay (Google Apps Script)
 * ============================================================
 * The static site cannot write to the GitHub repo, so it POSTs the payload
 * here (Content-Type: text/plain — no CORS preflight). This script commits
 * the payload to inbox/update-<timestamp>.json in the repo. A GitHub Action
 * then patches the Excel workbook and re-exports data.json automatically.
 *
 * SETUP (one time, ~5 minutes):
 *   1. GitHub: create a fine-grained personal access token
 *      (Settings -> Developer settings -> Fine-grained tokens) with
 *      Repository access: only surajsingh81/wedding_tracker
 *      Permissions -> Contents: Read and write.
 *   2. script.google.com -> New project -> paste this whole file -> Save.
 *   3. Project Settings (gear) -> Script properties -> Add:
 *        GITHUB_TOKEN  = the token from step 1
 *        REPO          = surajsingh81/wedding_tracker   (optional, default)
 *        BRANCH        = main                            (optional, default)
 *   4. Deploy -> New deployment -> Web app:
 *        Execute as: Me
 *        Who has access: Anyone
 *      -> Deploy -> copy the /exec URL.
 *   5. Put that URL into sync-config.js:
 *        window.SYNC_ENDPOINT = "https://script.google.com/macros/s/.../exec";
 *      and commit/push. Done — "Save on cloud" now writes straight to Excel.
 */

function doGet() {
  return ContentService.createTextOutput("Wedding tracker relay is up.")
    .setMimeType(ContentService.MimeType.TEXT);
}

function doPost(e) {
  const props = PropertiesService.getScriptProperties();
  const token = props.getProperty("GITHUB_TOKEN");
  if (!token) {
    return json({ ok: false, error: "GITHUB_TOKEN not set in script properties" }, 500);
  }
  const repo = props.getProperty("REPO") || "surajsingh81/wedding_tracker";
  const branch = props.getProperty("BRANCH") || "main";

  const body = (e && e.postData && e.postData.contents) || "";
  if (!body) {
    return json({ ok: false, error: "empty payload" }, 400);
  }

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const path = "inbox/update-" + ts + ".json";

  const sha = getSha(token, repo, branch, path);
  const res = UrlFetchApp.fetch(
    "https://api.github.com/repos/" + repo + "/contents/" + path,
    {
      method: "put",
      headers: {
        Authorization: "Bearer " + token,
        "User-Agent": "wedding-tracker",
        Accept: "application/vnd.github+json",
      },
      contentType: "application/json",
      payload: JSON.stringify({
        message: "Save on cloud: " + ts,
        content: Utilities.base64Encode(body),
        branch: branch,
        ...(sha ? { sha: sha } : {}),
      }),
    }
  );

  const code = res.getResponseCode();
  if (code >= 300) {
    return json({ ok: false, error: "GitHub " + code + ": " + res.getContentText() }, 502);
  }
  return json({ ok: true, path: path });
}

function getSha(token, repo, branch, path) {
  try {
    const res = UrlFetchApp.fetch(
      "https://api.github.com/repos/" + repo + "/contents/" + path + "?ref=" + branch,
      {
        headers: {
          Authorization: "Bearer " + token,
          "User-Agent": "wedding-tracker",
          Accept: "application/vnd.github+json",
        },
      }
    );
    if (res.getResponseCode() === 200) {
      return JSON.parse(res.getContentText()).sha;
    }
  } catch (err) {
    // file does not exist yet — that's fine
  }
  return null;
}

function json(obj, code) {
  return ContentService.createTextOutput(JSON.stringify(obj))
    .setMimeType(ContentService.MimeType.JSON);
}