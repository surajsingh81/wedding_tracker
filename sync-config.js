/* Where "Save on cloud" delivers the entries.
   The Apps Script relay (tools/apps-script-endpoint.js) commits the payload
   to inbox/ in the repo; the GitHub Action patches the Excel and re-exports
   data.json automatically. */
window.SYNC_ENDPOINT = "https://script.google.com/macros/s/AKfycbwi_9kPwUv1lrUzOlgNBUix00uaIBIbsb-ar-3IZRgkKPn4ebVVmsSypOu2FhgA4w_TuA/exec";
window.SYNC_EMAIL   = "surajupes@gmail.com";
