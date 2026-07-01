// @ts-check
// One-time migration: copy Notes/Comments + Status from the member's original
// old-data.xlsx into the matching rows of the live Google Sheet. After this runs,
// the normal `npm run sync` preserves the values (buildPreserveMap keys by the ID
// column), so no ongoing code is needed.
//
//   node migrate-old-data.mjs               # dry-run (no network, prints plan)
//   node migrate-old-data.mjs --apply       # writes to the Google Sheet
//   node migrate-old-data.mjs --file=x.xlsx # override source file
import process from "node:process";
import { readFileSync } from "node:fs";
import { loadDotEnv } from "./db.mjs";
import { PROJECT_COLS, PROPERTY_COLS } from "./sheet-data.mjs";
import { readXlsxSheet } from "./xlsx-read.mjs";
import { buildProjectMap, buildPropertyMap, computeUpdates } from "./migrate-data.mjs";
import { getSheetsClient, getTabMap, readTab, batchUpdateValues } from "./sheets-client.mjs";

const APPLY = process.argv.includes("--apply");
const fileArg = process.argv.find((a) => a.startsWith("--file="));
const FILE = fileArg ? fileArg.slice("--file=".length) : "old-data.xlsx";

const PROJECT_TAB = "Missing Project Data";
const PROPERTY_TAB = "Missing Property Data";

// 0-based column index -> A1 letter (0 -> A, 17 -> R).
function colLetter(idx) {
  let s = "";
  idx += 1;
  while (idx > 0) {
    const r = (idx - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    idx = Math.floor((idx - 1) / 26);
  }
  return s;
}

// Build values.batchUpdate `data` entries for one tab's computed updates.
function buildData(title, updates, cols) {
  const notesCol = colLetter(cols.notes);
  const statusCol = colLetter(cols.status);
  const data = [];
  let notesN = 0;
  let statusN = 0;
  for (const u of updates) {
    const rowNum = u.rowIndex + 1; // array index 0 = header (A1 row 1)
    if (u.notes !== undefined) {
      data.push({ range: `'${title}'!${notesCol}${rowNum}`, values: [[u.notes]] });
      notesN++;
    }
    if (u.status !== undefined) {
      data.push({ range: `'${title}'!${statusCol}${rowNum}`, values: [[u.status]] });
      statusN++;
    }
  }
  return { data, notesN, statusN };
}

async function main() {
  loadDotEnv(); // same .env loading path npm run sync uses (via db.mjs)
  const buf = readFileSync(FILE);
  const projectMap = buildProjectMap(await readXlsxSheet(buf, PROJECT_TAB));
  const propertyMap = buildPropertyMap(await readXlsxSheet(buf, PROPERTY_TAB));
  console.log(`Old data: ${projectMap.size} project record(s), ${propertyMap.size} property record(s) with notes/status.`);

  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  const spreadsheetId = process.env.SPREADSHEET_ID;
  if (!keyPath || !spreadsheetId) {
    console.error("ERROR: GOOGLE_SERVICE_ACCOUNT_KEY and SPREADSHEET_ID are required.");
    process.exit(1);
  }

  const sheets = getSheetsClient(keyPath);
  await getTabMap(sheets, spreadsheetId); // validates auth / spreadsheet early

  let totalCells = 0;
  for (const { title, map, cols } of [
    { title: PROJECT_TAB, map: projectMap, cols: PROJECT_COLS },
    { title: PROPERTY_TAB, map: propertyMap, cols: PROPERTY_COLS },
  ]) {
    const liveRows = await readTab(sheets, spreadsheetId, title);
    const { updates, matched, unmatched } = computeUpdates(liveRows, cols, map);
    const { data, notesN, statusN } = buildData(title, updates, cols);
    totalCells += data.length;

    console.log(`\n${title}:`);
    console.log(`  live rows: ${Math.max(0, liveRows.length - 1)}`);
    console.log(`  matched:   ${matched} (writing ${statusN} status, ${notesN} notes = ${data.length} cells)`);
    console.log(`  skipped:   ${unmatched} old record(s) not in the current report`);
    for (const u of updates.slice(0, 5)) {
      const r = liveRows[u.rowIndex] ?? [];
      const label = r[0] ?? "";
      console.log(`    e.g. row ${u.rowIndex + 1} "${String(label).slice(0, 30)}" -> status="${u.status ?? ""}"${u.notes ? ` notes="${u.notes.slice(0, 30)}"` : ""}`);
    }

    if (APPLY) {
      await batchUpdateValues(sheets, spreadsheetId, data);
      console.log(`  applied ${data.length} cell update(s).`);
    }
  }

  if (!APPLY) {
    console.log(`\n[DRY RUN] Would update ${totalCells} cell(s). Re-run with --apply to write.`);
  } else {
    console.log(`\nDone. https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`);
  }
}

main().catch((err) => { console.error(err); process.exit(1); });
