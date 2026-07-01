// @ts-check
import process from "node:process";
import { fetchData } from "./db.mjs";
import {
  PROJECT_SHEET_HEADERS, PROPERTY_SHEET_HEADERS,
  PROJECT_COLS, PROPERTY_COLS,
  PROJECT_ARCHIVE_HEADERS, PROPERTY_ARCHIVE_HEADERS,
  PROJECT_ARCHIVE_KEY, PROPERTY_ARCHIVE_KEY,
  buildProjectRow, buildPropertyRow,
  buildProjectArchiveRow, buildPropertyArchiveRow,
  planTab,
} from "./sheet-data.mjs";
import { projectFormatRequests, propertyFormatRequests } from "./sheet-format.mjs";
import {
  getSheetsClient, getTabMap, ensureTab, readTab, cfRuleCount,
  writeGrid, appendRows, runBatch,
} from "./sheets-client.mjs";

const DRY_RUN = process.argv.includes("--dry-run");
const today = () => new Date().toISOString().slice(0, 10);

async function main() {
  if (DRY_RUN) process.env.MOCK = "1";
  const { projects, properties } = await fetchData();
  console.log(`Found ${projects.length} incomplete project(s), ${properties.length} incomplete property(ies).`);

  if (DRY_RUN) {
    const proj = planTab({
      records: projects, headers: PROJECT_SHEET_HEADERS, cols: PROJECT_COLS,
      rowBuilder: buildProjectRow, idField: "project_id", archiveHeaders: PROJECT_ARCHIVE_HEADERS,
      archiveKey: PROJECT_ARCHIVE_KEY, archiveBuilder: buildProjectArchiveRow,
      prevRows: [], prevArchive: [], resolvedAt: today(),
    });
    const prop = planTab({
      records: properties, headers: PROPERTY_SHEET_HEADERS, cols: PROPERTY_COLS,
      rowBuilder: buildPropertyRow, idField: "property_id", archiveHeaders: PROPERTY_ARCHIVE_HEADERS,
      archiveKey: PROPERTY_ARCHIVE_KEY, archiveBuilder: buildPropertyArchiveRow,
      prevRows: [], prevArchive: [], resolvedAt: today(),
    });
    console.log("\n[DRY RUN] Project grid (header + %d rows):", proj.values.length - 1);
    console.dir(proj.values, { depth: null, maxArrayLength: 5 });
    console.log("\n[DRY RUN] Property grid (header + %d rows):", prop.values.length - 1);
    console.dir(prop.values, { depth: null, maxArrayLength: 5 });
    console.log("\n[DRY RUN] No network calls made.");
    return;
  }

  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  const spreadsheetId = process.env.SPREADSHEET_ID;
  if (!keyPath || !spreadsheetId) {
    console.error("ERROR: GOOGLE_SERVICE_ACCOUNT_KEY and SPREADSHEET_ID are required.");
    process.exit(1);
  }

  const sheets = getSheetsClient(keyPath);
  const tabMap = await getTabMap(sheets, spreadsheetId);

  await syncOne(sheets, spreadsheetId, tabMap, {
    activeTitle: "Missing Project Data", archiveTitle: "Resolved Project Data",
    records: projects, headers: PROJECT_SHEET_HEADERS, cols: PROJECT_COLS,
    rowBuilder: buildProjectRow, idField: "project_id", archiveHeaders: PROJECT_ARCHIVE_HEADERS,
    archiveKey: PROJECT_ARCHIVE_KEY, archiveBuilder: buildProjectArchiveRow,
    lastCol: "U", formatReqs: projectFormatRequests,
  });

  await syncOne(sheets, spreadsheetId, tabMap, {
    activeTitle: "Missing Property Data", archiveTitle: "Resolved Property Data",
    records: properties, headers: PROPERTY_SHEET_HEADERS, cols: PROPERTY_COLS,
    rowBuilder: buildPropertyRow, idField: "property_id", archiveHeaders: PROPERTY_ARCHIVE_HEADERS,
    archiveKey: PROPERTY_ARCHIVE_KEY, archiveBuilder: buildPropertyArchiveRow,
    lastCol: "O", formatReqs: propertyFormatRequests,
  });

  console.log(`Done. https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`);
}

async function syncOne(sheets, spreadsheetId, tabMap, cfg) {
  const sheetId = await ensureTab(sheets, spreadsheetId, cfg.activeTitle, tabMap);
  await ensureTab(sheets, spreadsheetId, cfg.archiveTitle, tabMap);

  const prevRows = await readTab(sheets, spreadsheetId, cfg.activeTitle);
  let prevArchive = await readTab(sheets, spreadsheetId, cfg.archiveTitle);

  // (Re)write the archive header when the tab is empty or its header no longer
  // matches the current schema (e.g. the archive layout was expanded). This
  // discards any rows written under an older layout.
  const header = prevArchive[0] || [];
  const headerMatches = prevArchive.length
    && cfg.archiveHeaders.length === header.length
    && cfg.archiveHeaders.every((h, i) => String(header[i] ?? "") === h);
  if (!headerMatches) {
    await writeGrid(sheets, spreadsheetId, cfg.archiveTitle, [cfg.archiveHeaders], "Z");
    prevArchive = [cfg.archiveHeaders];
  }

  const { values, archiveToAppend } = planTab({
    records: cfg.records, headers: cfg.headers, cols: cfg.cols,
    rowBuilder: cfg.rowBuilder, idField: cfg.idField, archiveHeaders: cfg.archiveHeaders,
    archiveKey: cfg.archiveKey, archiveBuilder: cfg.archiveBuilder,
    prevRows, prevArchive, resolvedAt: today(),
  });

  await appendRows(sheets, spreadsheetId, cfg.archiveTitle, archiveToAppend);

  await writeGrid(sheets, spreadsheetId, cfg.activeTitle, values, cfg.lastCol);

  const count = await cfRuleCount(sheets, spreadsheetId, sheetId);
  const reqs = cfg.formatReqs(sheetId, count);
  // Apply everything except the dropdowns in one batch. Conditional formatting
  // and the freeze must land even when the dropdowns can't be re-applied.
  const dropdowns = reqs.filter((r) => r.setDataValidation);
  const rest = reqs.filter((r) => !r.setDataValidation);
  await runBatch(sheets, spreadsheetId, rest);
  // Re-applying dropdowns fails once a column has become a "typed column"
  // (Google promotes a whole-column dropdown to a column type after the first
  // run). The dropdown already exists in that case, so tolerate the rejection.
  try {
    await runBatch(sheets, spreadsheetId, dropdowns);
  } catch (err) {
    const msg = err?.cause?.message || err?.message || "";
    if (/typed column/i.test(msg)) {
      console.warn(`  ${cfg.activeTitle}: dropdowns already set as a column type — kept existing.`);
    } else {
      throw err;
    }
  }

  console.log(`  ${cfg.activeTitle}: ${values.length - 1} rows; archived ${archiveToAppend.length}.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
