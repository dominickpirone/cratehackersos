/* =====================================================================
   CRATE HACKERS — "Roast Us" leads → Google Sheet
   =====================================================================
   This little script catches every roast submission from
   lander.cratehackers.com/roastus and appends it as one clean row
   (Name, Email, Phone + all the roast answers) into your Sheet.

   ---------------------------------------------------------------------
   SETUP (do this once, ~2 minutes)
   ---------------------------------------------------------------------
   1.  Open your Sheet:
       https://docs.google.com/spreadsheets/d/14s0PiTV9QmNqKmCPPSrd6mqzTvEbcpXtPqg1_x8UkxI/edit
       (make sure you're signed in as dom@ ... the Crate Hackers Workspace)

   2.  Extensions  →  Apps Script.  Delete whatever's in the editor.

   3.  Paste this ENTIRE file in.  Click the 💾 Save icon.

   4.  Click  Deploy  →  New deployment.
         • Select type (gear icon)  →  Web app
         • Description:  Roast Us leads
         • Execute as:        Me (dom@cratehackers...)
         • Who has access:    Anyone
       Click  Deploy.  Approve the permissions prompt
       (it's your own script writing to your own Sheet — safe).

   5.  Copy the  Web app URL  it gives you. It ends in  /exec.

   6.  Open  roastus/index.html, find  SHEET_ENDPOINT = ""  near the
       bottom, and paste that URL between the quotes. Re-deploy the site.

   That's it. Test it: submit the form once, then refresh the Sheet —
   a "Roast Leads" tab appears with your row.

   ---------------------------------------------------------------------
   ZAPIER → KARTRA (after the Sheet is filling)
   ---------------------------------------------------------------------
   Trigger:  Google Sheets — "New Spreadsheet Row"
             Spreadsheet: this one · Worksheet: "Roast Leads"
   Action:   Kartra — "Create / Update Lead"  (or via Webhooks → Kartra API)
             Map Name, Email, Phone from the row.
             Assign the list/tag Dom creates (see note below).
   ===================================================================== */

var SHEET_ID  = '14s0PiTV9QmNqKmCPPSrd6mqzTvEbcpXtPqg1_x8UkxI';
var TAB_NAME  = 'Roast Leads';

var HEADERS = [
  'Timestamp', 'Name', 'Email', 'Phone',
  'DJ Type', 'Rating',
  'Primary Use', 'Uses Instead Of Us', 'Where It Falls Apart',
  'The Roast', 'Price Worth', 'Price No-Brainer', 'What Would Make A Fan',
  'Down For Zoom?', 'User Agent'
];

function doPost(e) {
  var lock = LockService.getScriptLock();
  try {
    lock.waitLock(20000); // avoid two submissions writing the same row

    var ss = SpreadsheetApp.openById(SHEET_ID);
    var sh = ss.getSheetByName(TAB_NAME);
    if (!sh) { sh = ss.insertSheet(TAB_NAME); }
    if (sh.getLastRow() === 0) { sh.appendRow(HEADERS); }

    var p = (e && e.parameter) ? e.parameter : {};
    sh.appendRow([
      new Date(),
      p.name        || '',
      p.email       || '',
      p.phone       || '',
      p.djType      || '',
      p.rating      || '',
      p.primaryUse  || '',
      p.competitor  || '',
      p.painPoints  || '',
      p.theRoast    || '',
      p.priceWorth  || '',
      p.pricing     || '',
      p.makeFan     || '',
      p.zoom        || '',
      p.userAgent   || ''
    ]);

    return ContentService
      .createTextOutput(JSON.stringify({ ok: true }))
      .setMimeType(ContentService.MimeType.JSON);
  } catch (err) {
    return ContentService
      .createTextOutput(JSON.stringify({ ok: false, error: String(err) }))
      .setMimeType(ContentService.MimeType.JSON);
  } finally {
    try { lock.releaseLock(); } catch (ignore) {}
  }
}

// Lets you open the /exec URL in a browser to confirm it's live.
function doGet() {
  return ContentService.createTextOutput('Crate Hackers — Roast Us lead endpoint is live. 🔥');
}
