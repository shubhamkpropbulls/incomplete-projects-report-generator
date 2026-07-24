// @ts-check
/**
 * Offline preview of `npm run sync` — READ ONLY.
 *
 * Answers one question: "if I run the sync right now, what changes on the
 * sheet?" It compares the sheet as it stands today against the grid the sync
 * would write, and reports rows added, rows moved to Resolved, and rows whose
 * cells change.
 *
 * It is deliberately rule-agnostic. It knows nothing about which checks the
 * report runs, so it keeps working unchanged as those checks evolve. It cannot
 * tell you which of the differences your branch caused — the sheet's baseline
 * is whatever code last synced it, plus any data entered since.
 *
 * What it reads:
 *   - the real database (DATABASE_URL) — never MOCK data
 *   - the real Google Sheet, through a readonly-scoped client
 *
 * What it writes:
 *   - one local markdown file. Nothing else. No code path here calls
 *     writeGrid / appendRows / runBatch / batchUpdate.
 *
 * Usage:
 *   node preview-sync.mjs                    # names the target, then stops
 *   node preview-sync.mjs --yes              # runs, writes preview-<date>.md
 *   node preview-sync.mjs --yes out.md       # custom output path
 *   node preview-sync.mjs --show-target      # reveal host/db/user at a private terminal
 *
 * The connection host, database name, username and spreadsheet ID are treated
 * as disclosing and are never printed or written to the report. The gate shows
 * local-vs-remote plus a stable fingerprint instead; --show-target opts in to
 * the real values for terminal output only.
 */

import { writeFile } from "node:fs/promises";
import { readFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import process from "node:process";
import pg from "pg";
import { google } from "googleapis";
import { loadDotEnv, SQL_PROJECTS, SQL_PROPERTIES } from "./db.mjs";
import {
  PROJECT_SHEET_HEADERS, PROPERTY_SHEET_HEADERS,
  PROJECT_COLS, PROPERTY_COLS,
  PROJECT_ARCHIVE_HEADERS, PROPERTY_ARCHIVE_HEADERS,
  PROJECT_ARCHIVE_KEY, PROPERTY_ARCHIVE_KEY,
  buildProjectRow, buildPropertyRow,
  buildProjectArchiveRow, buildPropertyArchiveRow,
  planTab,
} from "./sheet-data.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

const ARGS = process.argv.slice(2);
const CONFIRMED = ARGS.includes("--yes");
const SKIP_SHEET = ARGS.includes("--no-sheet");
const SHOW_TARGET = ARGS.includes("--show-target");
const OUT_ARG = ARGS.find((a) => !a.startsWith("--"));

const today = () => new Date().toISOString().slice(0, 10);

// ─────────────────────────────────────────────────────────────────────────────
// Target identification (DB env gate)
// ─────────────────────────────────────────────────────────────────────────────

/** Short, stable, non-reversible tag for a target. Identifies without disclosing. */
function fingerprint(s) {
  return createHash("sha256").update(s).digest("hex").slice(0, 8);
}

/** Redacted unless the operator explicitly opted in at the terminal. */
const reveal = (v, fallback) => (SHOW_TARGET ? v : fallback);

/**
 * Identifies the connection target WITHOUT echoing it.
 *
 * Host, database name and username are connection-identifying and must not be
 * printed to a terminal, a log, or a report file. What this gate is actually
 * for is "am I about to hit local or production", so that is all it surfaces by
 * default: a coarse verdict plus a fingerprint that is stable across runs, so
 * two runs can be compared without either one disclosing the target.
 */
function describeDb(url) {
  try {
    const u = new URL(url);
    const host = u.hostname;
    return {
      host,
      port: u.port || "5432",
      db: u.pathname.replace(/^\//, "") || "(default)",
      user: u.username || "(none)",
      isLocal: host === "localhost" || host === "127.0.0.1",
      fingerprint: fingerprint(`${host}/${u.pathname}`),
    };
  } catch {
    return { host: "", port: "", db: "", user: "", isLocal: false, fingerprint: "unparseable" };
  }
}

function gitInfo() {
  try {
    const run = (a) => execFileSync("git", a, { cwd: __dirname, encoding: "utf8" }).trim();
    return `${run(["rev-parse", "--abbrev-ref", "HEAD"])} @ ${run(["rev-parse", "--short", "HEAD"])}`;
  } catch {
    return "(not a git checkout)";
  }
}

function printTarget(dbInfo, spreadsheetId) {
  const verdict = dbInfo.isLocal ? "LOCAL" : "REMOTE — treat as PRODUCTION unless you know otherwise";
  console.log("");
  console.log("  Preview target");
  console.log("  ─────────────────────────────────────────────");
  console.log(`  Environment   : ${verdict}`);
  console.log(`  Database      : ${reveal(`${dbInfo.host}:${dbInfo.port}/${dbInfo.db} as ${dbInfo.user}`, `[redacted] fingerprint ${dbInfo.fingerprint}`)}`);
  console.log(`  Spreadsheet   : ${spreadsheetId ? reveal(spreadsheetId, `[redacted] fingerprint ${fingerprint(spreadsheetId)}`) : "(none — sheet read will be skipped)"}`);
  console.log(`  Code          : ${gitInfo()}`);
  console.log("  ─────────────────────────────────────────────");
  console.log("  Reads only. No write is issued to the database or the sheet.");
  if (!SHOW_TARGET) {
    console.log("  Host/db/user withheld. Pass --show-target at a private terminal to see them.");
  }
  console.log("");
}

// ─────────────────────────────────────────────────────────────────────────────
// Readonly Google client — narrower scope than sheets-client.mjs on purpose, so
// a write cannot succeed even by accident.
// ─────────────────────────────────────────────────────────────────────────────
function getReadonlySheetsClient(keyPath) {
  const key = JSON.parse(readFileSync(keyPath, "utf8"));
  const auth = new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets.readonly"],
  });
  return google.sheets({ version: "v4", auth });
}

async function readTabSafe(sheets, spreadsheetId, title) {
  try {
    const res = await sheets.spreadsheets.values.get({
      spreadsheetId,
      range: `'${title}'`,
      valueRenderOption: "FORMATTED_VALUE",
    });
    return res.data.values ?? [];
  } catch (err) {
    const msg = err?.errors?.[0]?.message || err?.message || String(err);
    if (/Unable to parse range|not found/i.test(msg)) {
      console.warn(`  warn: tab "${title}" not found — treating as empty.`);
      return [];
    }
    throw err;
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// Sheet diff
//
// Rule-agnostic by construction: it compares cell values positionally and never
// looks at what a column means. Two column sets are excluded, for reasons that
// hold regardless of which checks the report runs:
//
//   formula columns — the sheet returns these already evaluated
//     (FORMATTED_VALUE), while a freshly built row still holds the raw
//     "=IF(...)" text. Comparing them would flag every row on every run.
//   notes/status columns — owned by the team and carried across by planTab, so
//     they are the same on both sides by design.
// ─────────────────────────────────────────────────────────────────────────────

/** Data columns worth diffing, per tab. Indices are 0-based sheet columns. */
const PROJECT_DIFF_COLS = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 20];
const PROPERTY_DIFF_COLS = [0, 2, 4, 5, 6, 7, 8, 13, 14];

/**
 * Reduces a date cell to YYYY-MM-DD, or returns null if it isn't a date.
 *
 * The sheet hands back FORMATTED_VALUE, so a date column reads as whatever
 * Google is displaying ("Jul 18, 2026") while a freshly built row holds ISO
 * ("2026-07-18"). Without this every dated row would report a change on every
 * run and drown out the real ones.
 *
 * The ISO case short-circuits before Date parsing on purpose. `new Date` reads
 * a bare "2026-07-18" as UTC midnight but "Jul 18, 2026" as LOCAL midnight, so
 * routing both through toISOString would shift the second one back a day in
 * IST. Reading local components off the parsed value avoids the offset.
 */
function normalizeDate(s) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(s)) return s;
  // Only attempt shapes that look like a date, so ordinary text can't be
  // coerced into one by a permissive parser.
  if (!/^[A-Za-z0-9][A-Za-z0-9 ,\/-]{5,}$/.test(s) || !/\d/.test(s)) return null;
  const d = new Date(s);
  if (Number.isNaN(d.getTime())) return null;
  const pad = (n) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

/**
 * Sheet cells arrive as display strings; built rows hold numbers and ISO dates.
 * Compares by meaning so formatting alone never counts as a change.
 */
export function sameCell(a, b) {
  const sa = String(a ?? "").trim();
  const sb = String(b ?? "").trim();
  if (sa === sb) return true;
  if (sa === "" || sb === "") return false;

  const na = Number(sa);
  const nb = Number(sb);
  if (!Number.isNaN(na) && !Number.isNaN(nb)) return na === nb;

  const da = normalizeDate(sa);
  const db = normalizeDate(sb);
  if (da && db) return da === db;

  return false;
}

function indexRowsById(rows, keyIndex) {
  const map = new Map();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const id = String(row[keyIndex] ?? "").trim();
    if (id) map.set(id, row);
  }
  return map;
}

/**
 * Compares the live tab against the grid the sync would write.
 * Returns added / removed / changed rows, plus any header-layout change.
 */
export function diffTab({ prevRows, nextValues, headers, keyIndex, diffCols, nameIndex }) {
  const prevHeader = prevRows[0] ?? [];
  const headerChanged = prevRows.length > 0 && (
    prevHeader.length !== headers.length
    || headers.some((h, i) => String(prevHeader[i] ?? "").trim() !== h.trim())
  );

  const prevById = indexRowsById(prevRows, keyIndex);
  const nextById = indexRowsById(nextValues, keyIndex);

  const added = [];
  const changed = [];
  for (const [id, nextRow] of nextById) {
    const prevRow = prevById.get(id);
    if (!prevRow) { added.push(nextRow); continue; }
    // A shifted layout makes positional comparison meaningless — the header
    // section already reports it, so skip cell diffing rather than emit noise.
    if (headerChanged) continue;
    const cells = [];
    for (const c of diffCols) {
      if (!sameCell(prevRow[c], nextRow[c])) {
        cells.push({ column: headers[c] ?? `col ${c}`, from: prevRow[c] ?? "", to: nextRow[c] ?? "" });
      }
    }
    if (cells.length) changed.push({ id, name: nextRow[nameIndex], cells });
  }

  const removed = [];
  for (const [id, prevRow] of prevById) {
    if (!nextById.has(id)) removed.push(prevRow);
  }

  return { added, removed, changed, headerChanged, prevHeader };
}

// ─────────────────────────────────────────────────────────────────────────────
// Markdown helpers
// ─────────────────────────────────────────────────────────────────────────────

const esc = (v) => String(v ?? "").replace(/\|/g, "\\|").replace(/\r?\n/g, " ");
const trunc = (v, n) => { const s = esc(v); return s.length > n ? `${s.slice(0, n - 1)}…` : s; };

function table(headers, rows) {
  if (!rows.length) return "_none_\n";
  return [
    `| ${headers.join(" | ")} |`,
    `| ${headers.map(() => "---").join(" | ")} |`,
    ...rows.map((r) => `| ${r.map(esc).join(" | ")} |`),
  ].join("\n") + "\n";
}

// ─────────────────────────────────────────────────────────────────────────────
// Main
// ─────────────────────────────────────────────────────────────────────────────

async function main() {
  loadDotEnv();

  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("ERROR: DATABASE_URL is required (set it in .env).");
    process.exit(1);
  }
  const dbInfo = describeDb(url);
  const spreadsheetId = SKIP_SHEET ? "" : (process.env.SPREADSHEET_ID || "");
  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;

  printTarget(dbInfo, spreadsheetId);

  if (!CONFIRMED) {
    console.log("  Re-run with --yes to execute against the target above:");
    console.log("      node preview-sync.mjs --yes");
    console.log("");
    process.exit(2);
  }

  // ── 1. Database — the exact queries the sync would run ────────────────────
  const client = new pg.Client({
    connectionString: url,
    ssl: dbInfo.isLocal ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  let projects, properties;
  try {
    projects = (await client.query(SQL_PROJECTS)).rows;
    properties = (await client.query(SQL_PROPERTIES)).rows;
  } finally {
    await client.end();
  }
  console.log(`  DB: ${projects.length} incomplete project(s), ${properties.length} incomplete property(ies).`);

  // ── 2. Google Sheet — read only ───────────────────────────────────────────
  let prevProjectRows = [], prevProjectArchive = [];
  let prevPropertyRows = [], prevPropertyArchive = [];
  let sheetRead = false;
  if (spreadsheetId && keyPath) {
    const sheets = getReadonlySheetsClient(keyPath);
    prevProjectRows = await readTabSafe(sheets, spreadsheetId, "Missing Project Data");
    prevProjectArchive = await readTabSafe(sheets, spreadsheetId, "Resolved Project Data");
    prevPropertyRows = await readTabSafe(sheets, spreadsheetId, "Missing Property Data");
    prevPropertyArchive = await readTabSafe(sheets, spreadsheetId, "Resolved Property Data");
    sheetRead = true;
    console.log(`  Sheet: ${Math.max(0, prevProjectRows.length - 1)} project row(s), ` +
      `${Math.max(0, prevPropertyRows.length - 1)} property row(s) live now.`);
  } else {
    console.warn("  Sheet read skipped — every row will look 'added'.");
  }

  // ── 3. Plan exactly what the sync would write ─────────────────────────────
  const tabs = [
    {
      label: "Project", activeTitle: "Missing Project Data", archiveTitle: "Resolved Project Data",
      records: projects, headers: PROJECT_SHEET_HEADERS, cols: PROJECT_COLS,
      rowBuilder: buildProjectRow, idField: "project_id",
      archiveHeaders: PROJECT_ARCHIVE_HEADERS, archiveKey: PROJECT_ARCHIVE_KEY,
      archiveBuilder: buildProjectArchiveRow,
      prevRows: prevProjectRows, prevArchive: prevProjectArchive,
      diffCols: PROJECT_DIFF_COLS, nameIndex: 0,
    },
    {
      label: "Property", activeTitle: "Missing Property Data", archiveTitle: "Resolved Property Data",
      records: properties, headers: PROPERTY_SHEET_HEADERS, cols: PROPERTY_COLS,
      rowBuilder: buildPropertyRow, idField: "property_id",
      archiveHeaders: PROPERTY_ARCHIVE_HEADERS, archiveKey: PROPERTY_ARCHIVE_KEY,
      archiveBuilder: buildPropertyArchiveRow,
      prevRows: prevPropertyRows, prevArchive: prevPropertyArchive,
      diffCols: PROPERTY_DIFF_COLS, nameIndex: 2,
    },
  ];

  const results = tabs.map((t) => {
    const plan = planTab({
      records: t.records, headers: t.headers, cols: t.cols,
      rowBuilder: t.rowBuilder, idField: t.idField,
      archiveHeaders: t.archiveHeaders, archiveKey: t.archiveKey,
      archiveBuilder: t.archiveBuilder,
      prevRows: t.prevRows, prevArchive: t.prevArchive, resolvedAt: today(),
    });
    const diff = diffTab({
      prevRows: t.prevRows, nextValues: plan.values, headers: t.headers,
      keyIndex: t.cols.key, diffCols: t.diffCols, nameIndex: t.nameIndex,
    });
    return { tab: t, plan, diff };
  });

  // ── 4. Report ─────────────────────────────────────────────────────────────
  const md = [];
  md.push(`# Sync preview — ${today()}`);
  md.push("");
  md.push("Read-only. Nothing was written to the database or the Google Sheet.");
  md.push("");
  // Never write the host, database name, username or spreadsheet ID here. This
  // file gets opened in editors, pasted into chats and attached to tickets;
  // fingerprints let two reports be compared without disclosing either target.
  md.push("| | |");
  md.push("|---|---|");
  md.push(`| Database | ${dbInfo.isLocal ? "local" : "remote"}, fingerprint \`${dbInfo.fingerprint}\` |`);
  md.push(`| Spreadsheet | ${sheetRead ? `fingerprint \`${fingerprint(spreadsheetId)}\`` : "_not read_"} |`);
  md.push(`| Code | \`${gitInfo()}\` |`);
  md.push("");
  md.push("This is the sheet as it stands today versus what the sync would write.");
  md.push("Differences include everything since the last sync — code changes from");
  md.push("any branch, and data entered by the team. It does not attribute them.");
  md.push("");

  md.push("## Summary");
  md.push("");
  md.push(table(
    ["Tab", "Rows now", "Rows after", "Added", "Moved to Resolved", "Cells changed"],
    results.map(({ tab, plan, diff }) => [
      tab.activeTitle,
      sheetRead ? Math.max(0, tab.prevRows.length - 1) : "n/a",
      plan.values.length - 1,
      diff.added.length,
      plan.archiveToAppend.length,
      diff.changed.length,
    ]),
  ));

  for (const { tab, plan, diff } of results) {
    md.push(`## ${tab.activeTitle}`);
    md.push("");

    if (diff.headerChanged) {
      md.push("> **Column layout changed.** The live tab's header no longer matches the");
      md.push("> code's header, so the sync will rewrite the whole grid and per-cell");
      md.push("> comparison is skipped for this tab.");
      md.push("");
      md.push(table(["#", "On sheet now", "After sync"],
        tab.headers.map((h, i) => [i, diff.prevHeader[i] ?? "_(none)_", h])
          .filter(([, a, b]) => String(a) !== String(b))));
    }

    md.push(`### Added — ${diff.added.length} new row(s)`);
    md.push("");
    md.push("Newly flagged. Start with blank notes and the default status.");
    md.push("");
    md.push(table(
      ["Name", "ID"],
      diff.added.map((r) => [r[tab.nameIndex], r[tab.cols.key]]),
    ));

    md.push(`### Moved to ${tab.archiveTitle} — ${plan.archiveToAppend.length} row(s)`);
    md.push("");
    md.push("No longer flagged, so the sync lifts them off the active tab.");
    md.push("Their notes and status travel with them.");
    md.push("");
    md.push(table(
      ["Name", "Status", "Team notes", "ID"],
      plan.archiveToAppend.map((r) => {
        const isProject = tab.label === "Project";
        return isProject
          ? [r[0], r[6], trunc(r[5], 80), r[7]]
          : [r[2], r[8], trunc(r[7], 80), r[9]];
      }),
    ));

    md.push(`### Changed — ${diff.changed.length} row(s) with different cells`);
    md.push("");
    md.push("Row stays put; these values move. Notes, status and formula columns are");
    md.push("excluded — they are preserved by design or evaluated on the sheet.");
    md.push("");
    md.push(table(
      ["Name", "Column", "Now", "After sync", "ID"],
      diff.changed.flatMap((row) =>
        row.cells.map((c, i) => [i === 0 ? row.name : "", c.column, c.from, c.to, i === 0 ? row.id : ""]),
      ),
    ));

    md.push("### Full grid the sync would write");
    md.push("");
    md.push("Formula cells are shown as written; Sheets evaluates them on write.");
    md.push("");
    md.push(table(
      ["#", ...tab.headers],
      plan.values.slice(1).map((r, i) => [i + 2, ...tab.headers.map((_, c) => trunc(r[c], 60))]),
    ));
  }

  const outPath = OUT_ARG
    ? (OUT_ARG.includes("/") || OUT_ARG.includes("\\") ? OUT_ARG : join(__dirname, OUT_ARG))
    : join(__dirname, `preview-${today()}.md`);
  await writeFile(outPath, md.join("\n"), "utf8");

  console.log("");
  for (const { tab, plan, diff } of results) {
    console.log(`  ${tab.activeTitle}: ${sheetRead ? Math.max(0, tab.prevRows.length - 1) : "?"} -> ${plan.values.length - 1} rows` +
      `   (+${diff.added.length} added, ${plan.archiveToAppend.length} resolved, ${diff.changed.length} changed)`);
  }
  console.log(`  Report written: ${outPath}`);
  console.log("");
}

// Only run when invoked as a script, so tests can import the diff helpers
// without connecting to anything.
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => { console.error(err); process.exit(1); });
}
