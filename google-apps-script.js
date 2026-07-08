// ============================================================
// CoE Initiative Feedback Tracker — Google Apps Script Backend
// ============================================================
// Setup instructions:
//   1. Go to script.google.com → New Project
//   2. Paste this entire file, replacing the default code
//   3. Save (Cmd+S), name it "CoE Tracker API"
//   4. Click Deploy → New Deployment → Web App
//      - Execute as: Me
//      - Who has access: Anyone within Salesforce (or "Anyone" for testing)
//   5. Copy the Web App URL
//   6. Paste it into .env.local as REACT_APP_SHEETS_URL=<url>
//   7. Restart npm start
// ============================================================

const SHEET_NAME = 'TrackerData';

function getSheet() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  let sheet = ss.getSheetByName(SHEET_NAME);
  if (!sheet) {
    sheet = ss.insertSheet(SHEET_NAME);
    sheet.getRange('A1').setValue('data');
    sheet.getRange('B1').setValue('updated');
  }
  return sheet;
}

// GET — read current data
function doGet(e) {
  const sheet = getSheet();
  const raw = sheet.getRange('A2').getValue();
  const output = raw
    ? ContentService.createTextOutput(raw).setMimeType(ContentService.MimeType.JSON)
    : ContentService.createTextOutput('{}').setMimeType(ContentService.MimeType.JSON);

  return output;
}

// POST — write new data
function doPost(e) {
  const sheet = getSheet();
  const body = e.postData.contents;

  // Validate it's real JSON before saving
  try {
    JSON.parse(body);
  } catch (err) {
    return ContentService.createTextOutput(JSON.stringify({ ok: false, error: 'Invalid JSON' }))
      .setMimeType(ContentService.MimeType.JSON);
  }

  sheet.getRange('A2').setValue(body);
  sheet.getRange('B2').setValue(new Date().toISOString());

  return ContentService.createTextOutput(JSON.stringify({ ok: true }))
    .setMimeType(ContentService.MimeType.JSON);
}
