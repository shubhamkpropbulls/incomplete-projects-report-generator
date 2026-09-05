/**
 * Sheet-side half of the refresh button.
 *
 * This file is the source of truth and lives in the repo. The copy bound to the
 * spreadsheet (Extensions > Apps Script) is a manual paste — there is no
 * automatic sync, so re-paste after every edit here.
 *
 * How it works: the button does not run the sync. It writes a request token
 * into the hidden `_control` tab, and a watcher on Shubham's laptop polls that
 * cell every 15 seconds and runs the sync. Nothing inbound is ever opened on
 * the laptop. The dialog below watches the same cells the watcher writes back.
 *
 * CONTRACT — the constants below must stay identical to control-contract.mjs.
 * A mismatch is silent: the watcher clears the cell, reports "Ignored
 * unrecognised value", and the dialog sits at "queued" until it times out.
 */

var CONTROL_TAB = '_control';

var CELL = {
  request: 'B1',
  state: 'B2',
  message: 'B3',
  heartbeat: 'B4',
  lastRun: 'B5',
};

/**
 * The watcher rewrites the heartbeat every 60s. Three minutes is five missed
 * writes — late enough not to false-alarm on a back-off, early enough that
 * nobody queues a refresh into a dead machine.
 */
var HEARTBEAT_STALE_MS = 3 * 60 * 1000;

function onOpen() {
  SpreadsheetApp.getUi()
    .createMenu('PropBulls')
    .addItem('Refresh report', 'refreshReport')
    .addToUi();
}

/** @return {GoogleAppsScript.Spreadsheet.Sheet} */
function controlSheet_() {
  var sheet = SpreadsheetApp.getActive().getSheetByName(CONTROL_TAB);
  if (!sheet) {
    throw new Error(
      "The '" + CONTROL_TAB + "' tab is missing. Run `node setup-control.mjs` to create it."
    );
  }
  return sheet;
}

/**
 * The watcher writes ISO strings with valueInputOption RAW, so these arrive as
 * text — but tolerate a real Date in case someone retypes a cell by hand.
 * @return {number|null} epoch ms
 */
function parseTimestamp_(value) {
  if (value instanceof Date) return value.getTime();
  if (typeof value === 'string' && value) {
    var ms = Date.parse(value);
    return isNaN(ms) ? null : ms;
  }
  return null;
}

/** Must satisfy /^SYNC \d{4}-\d{2}-\d{2}T[\d:.]+Z [0-9a-f]{8}$/ in watch-decide.mjs. */
function makeToken_() {
  var hex = '';
  for (var i = 0; i < 8; i++) {
    hex += '0123456789abcdef'.charAt(Math.floor(Math.random() * 16));
  }
  return 'SYNC ' + new Date().toISOString() + ' ' + hex;
}

function heartbeatAgeMs_(sheet) {
  var at = parseTimestamp_(sheet.getRange(CELL.heartbeat).getValue());
  return at === null ? null : Date.now() - at;
}

function refreshReport() {
  var ui = SpreadsheetApp.getUi();
  var sheet = controlSheet_();

  // Check the machine is alive BEFORE writing anything. Otherwise the button
  // appears to do nothing and nobody can tell why.
  var age = heartbeatAgeMs_(sheet);
  if (age === null || age > HEARTBEAT_STALE_MS) {
    var lastSeen = age === null
      ? 'never'
      : Math.round(age / 60000) + ' minutes ago';
    ui.alert(
      'Sync machine looks offline',
      'The refresh runs on a laptop that checks this sheet every 15 seconds, and it has not '
        + 'checked in.\n\nLast seen: ' + lastSeen + '\n\n'
        + 'Nothing has been queued. Ask Shubham to check that the watcher is running.',
      ui.ButtonSet.OK
    );
    return;
  }

  var answer = ui.alert(
    'Refresh the report?',
    'This rewrites both data tabs from the database and takes about 12 seconds.\n\n'
      + 'Notes / Comments and Status are kept — they are matched back on by Project ID and '
      + 'Property ID. But anyone typing in the sheet while it runs can lose that edit.\n\n'
      + 'Refresh now?',
    ui.ButtonSet.YES_NO
  );
  if (answer !== ui.Button.YES) return;

  // Order matters. State and message first, the request token LAST — if the
  // token went first the watcher could flip the state to "running" in the gap
  // and we would overwrite it with "queued", leaving the dialog stuck.
  sheet.getRange(CELL.state).setValue('queued');
  sheet.getRange(CELL.message).setValue('Refresh queued…');
  sheet.getRange(CELL.request).setValue(makeToken_());
  SpreadsheetApp.flush();

  ui.showModalDialog(
    HtmlService.createHtmlOutputFromFile('Dialog').setWidth(400).setHeight(220),
    'Refreshing report'
  );
}

/**
 * Polled by Dialog.html every 2 seconds.
 * @return {{state: string, message: string, heartbeatStale: boolean}}
 */
function getSyncState() {
  var sheet = controlSheet_();
  var values = sheet.getRange('B2:B3').getValues();
  var age = heartbeatAgeMs_(sheet);
  return {
    state: String(values[0][0] || ''),
    message: String(values[1][0] || ''),
    // Lets the dialog say "the machine died mid-run" straight away rather than
    // waiting out its own 90-second timeout.
    heartbeatStale: age === null || age > HEARTBEAT_STALE_MS,
  };
}
