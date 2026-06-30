# Google Sheets Sync Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Refresh one permanent Google Sheet in place each run, preserving the team's `Notes`/`Status` by matching on row IDs, and archive rows that become complete.

**Architecture:** Extract shared DB/data logic into `db.mjs`. Add pure, unit-tested modules `sheet-data.mjs` (row/merge/archive builders) and `sheet-format.mjs` (Google Sheets batchUpdate request builders). Add a thin I/O wrapper `sheets-client.mjs` over `googleapis`. An orchestrator `sync-sheet.mjs` wires them together. The existing `generate-report.mjs` xlsx generator is kept as an offline fallback and refactored to import `db.mjs`.

**Tech Stack:** Node.js (ESM), `googleapis`, `pg`, `jszip` (existing), Node built-in test runner (`node:test` + `node:assert`).

## Global Constraints

- Node ESM modules (`"type": "module"`); use `import`/`export`, no `require`.
- No new test framework — use built-in `node:test`, run with `node --test`.
- Pure logic (row building, merging, archiving, format-request building) lives in `sheet-data.mjs` / `sheet-format.mjs` with **zero** network or filesystem calls, so it is unit-testable without Google credentials or a database.
- Google Sheets formulas use Google syntax — **no `_xlfn.` prefix** (that is Excel-only).
- Admin link base URL: `https://admin-console.propbulls.in` (exported once from `db.mjs` as `ADMIN_BASE`; never re-hardcode).
- Tabs referenced by fixed title; never rename: `Missing Project Data`, `Missing Property Data`, `Resolved Project Data`, `Resolved Property Data`.
- Column layouts (0-based array indices):
  - Project active row = 21 cells (A..U). Key `Project ID` = 20, `Notes / Comments` = 18, `Status` = 19.
  - Property active row = 15 cells (A..O). Key `Property ID` = 13, `Note / Comments` = 11, `Status` = 12.
- Default status strings: projects `"Not updated"`, properties `"Not Updated"` (note the capitalization difference — copied from the existing report).
- Secrets `service-account.json` and `.env` must be gitignored — never committed.

---

## File Structure

| File | Responsibility |
|------|----------------|
| `db.mjs` (new) | `.env` loader, SQL strings, `ADMIN_BASE`, `fetchData()`, `mockData()`. |
| `generate-report.mjs` (modify) | xlsx generator; imports data from `db.mjs`. |
| `sheet-data.mjs` (new, pure) | Column constants, preserve-map, resolved diff, formula/row/archive builders, dedupe. |
| `sheet-format.mjs` (new, pure) | Build Google Sheets `batchUpdate` request objects (freeze, widths, dropdowns, conditional formatting). |
| `sheets-client.mjs` (new, I/O) | `googleapis` auth + read/write/append/format wrappers. |
| `sync-sheet.mjs` (new) | Orchestrator + `--dry-run`. |
| `test/*.test.mjs` (new) | Unit tests for the pure modules. |
| `.env.example` (new) | Documents required env vars. |

---

## Task 1: Project setup — deps, scripts, secrets, test runner

**Files:**
- Modify: `package.json`
- Modify: `.gitignore`
- Create: `.env.example`
- Create: `test/smoke.test.mjs`

**Interfaces:**
- Consumes: nothing.
- Produces: `npm run sync`, `npm test`; `googleapis` available; secrets ignored.

- [ ] **Step 1: Install googleapis**

Run:
```bash
npm install googleapis
```
Expected: `googleapis` appears under `dependencies` in `package.json`, no errors.

- [ ] **Step 2: Add npm scripts**

In `package.json`, replace the `"scripts"` block with:
```json
  "scripts": {
    "generate": "node generate-report.mjs",
    "sync": "node sync-sheet.mjs",
    "test": "node --test"
  },
```

- [ ] **Step 3: Gitignore secrets**

Append to `.gitignore` (only the lines not already present):
```
.env
service-account.json
*.xlsx
!template.xlsx
```

- [ ] **Step 4: Create `.env.example`**

Create `.env.example`:
```
# Postgres connection (already used by the xlsx generator)
DATABASE_URL=postgres://user:pass@host:5432/db

# Path to the Google service-account JSON key file
GOOGLE_SERVICE_ACCOUNT_KEY=./service-account.json

# The spreadsheet ID from the Google Sheet URL:
# https://docs.google.com/spreadsheets/d/<THIS_PART>/edit
SPREADSHEET_ID=
```

- [ ] **Step 5: Create a smoke test that proves the runner works**

Create `test/smoke.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";

test("test runner works", () => {
  assert.equal(1 + 1, 2);
});
```

- [ ] **Step 6: Run the test suite**

Run:
```bash
npm test
```
Expected: PASS — `tests 1`, `pass 1`, `fail 0`.

- [ ] **Step 7: Commit**

```bash
git add package.json package-lock.json .gitignore .env.example test/smoke.test.mjs
git commit -m "chore: add googleapis, sync/test scripts, secrets ignore"
```

---

## Task 2: Extract `db.mjs` and rewire the xlsx generator

**Files:**
- Create: `db.mjs`
- Modify: `generate-report.mjs` (remove the inlined `loadDotEnv`, SQL, `ADMIN_BASE`, `mockData`, and the DB-connect block in `main`)

**Interfaces:**
- Produces:
  - `export const ADMIN_BASE: string`
  - `export async function fetchData(): Promise<{ projects: object[], properties: object[] }>` — loads `.env`, returns `mockData()` when `process.env.MOCK === "1"`, otherwise connects to `DATABASE_URL` and runs both queries.
  - `export function mockData(): { projects, properties }`

- [ ] **Step 1: Create `db.mjs`**

Create `db.mjs` by moving the existing logic out of `generate-report.mjs` verbatim:
```js
// @ts-check
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import pg from "pg";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const ADMIN_BASE = "https://admin-console.propbulls.in";

/** Minimal .env loader (KEY=VALUE lines); does not override existing env vars. */
export function loadDotEnv() {
  const f = join(__dirname, ".env");
  if (!existsSync(f)) return;
  for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trimStart().startsWith("#")) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}

export const SQL_PROJECTS = `<COPY THE EXACT SQL_PROJECTS STRING FROM generate-report.mjs>`;
export const SQL_PROPERTIES = `<COPY THE EXACT SQL_PROPERTIES STRING FROM generate-report.mjs>`;

/** Sample rows for MOCK=1 smoke tests (no DB needed). */
export function mockData() {
  // <COPY THE EXACT mockData() BODY FROM generate-report.mjs>
}

export async function fetchData() {
  loadDotEnv();
  if (process.env.MOCK === "1") return mockData();
  const url = process.env.DATABASE_URL;
  if (!url) {
    console.error("ERROR: DATABASE_URL env var is required.");
    process.exit(1);
  }
  const isLocal = /@(localhost|127\.0\.0\.1)/.test(url);
  const client = new pg.Client({
    connectionString: url,
    ssl: isLocal ? false : { rejectUnauthorized: false },
  });
  await client.connect();
  try {
    const projects = (await client.query(SQL_PROJECTS)).rows;
    const properties = (await client.query(SQL_PROPERTIES)).rows;
    return { projects, properties };
  } finally {
    await client.end();
  }
}
```
> When implementing: paste the real `SQL_PROJECTS`, `SQL_PROPERTIES`, and `mockData()` contents from the current `generate-report.mjs` into the three placeholders above. Do not paraphrase them.

- [ ] **Step 2: Rewire `generate-report.mjs` to use `db.mjs`**

In `generate-report.mjs`:
- Delete the local `loadDotEnv` function and its `loadDotEnv()` call.
- Delete the local `const ADMIN_BASE = ...` line.
- Delete the `SQL_PROJECTS` and `SQL_PROPERTIES` consts.
- Delete the local `mockData()` function.
- Add near the top imports:
```js
import { fetchData, ADMIN_BASE } from "./db.mjs";
```
- In `main()`, replace the entire block that determines `projects`/`properties` (the `if (process.env.MOCK === "1") {...} else {...}` DB section) with:
```js
  const { projects, properties } = await fetchData();
```
- Remove now-unused imports from `generate-report.mjs`: `pg`, and `readFileSync`/`existsSync` if no longer referenced. Keep `readFile`/`writeFile` (used for the xlsx).

- [ ] **Step 3: Verify the xlsx generator still works against mock data**

Run:
```bash
MOCK=1 node generate-report.mjs "./_smoke.xlsx"
```
Expected: prints `Found 2 incomplete project(s), 1 incomplete property(ies).` then `Wrote ...\_smoke.xlsx`. File exists.

- [ ] **Step 4: Clean up the smoke artifact**

Run:
```bash
rm -f "./_smoke.xlsx"
```

- [ ] **Step 5: Commit**

```bash
git add db.mjs generate-report.mjs
git commit -m "refactor: extract db.mjs; generate-report imports shared fetchData"
```

---

## Task 3: `sheet-data.mjs` — column constants, preserve-map, resolved diff

**Files:**
- Create: `sheet-data.mjs`
- Test: `test/preserve.test.mjs`

**Interfaces:**
- Consumes: `ADMIN_BASE` from `db.mjs`.
- Produces:
  - `PROJECT_SHEET_HEADERS: string[]` (21), `PROPERTY_SHEET_HEADERS: string[]` (15)
  - `PROJECT_COLS = { key: 20, notes: 18, status: 19 }`, `PROPERTY_COLS = { key: 13, notes: 11, status: 12 }`
  - `buildPreserveMap(rows: any[][], cols: {key,notes,status}): Map<string,{notes:string,status:string}>`
  - `selectResolvedRows(prevRows: any[][], currentIdSet: Set<string>, keyIndex: number): any[][]`

- [ ] **Step 1: Write the failing test**

Create `test/preserve.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildPreserveMap,
  selectResolvedRows,
  PROJECT_COLS,
} from "../sheet-data.mjs";

/** Build a fixed-length row with values placed at given 0-based indices. */
function mkRow(len, vals) {
  const a = Array(len).fill("");
  for (const [i, v] of Object.entries(vals)) a[Number(i)] = v;
  return a;
}

test("buildPreserveMap indexes notes+status by id, skips header + blank ids", () => {
  const header = Array(21).fill("h");
  const r1 = mkRow(21, { [PROJECT_COLS.key]: "id-1", [PROJECT_COLS.notes]: "check rera", [PROJECT_COLS.status]: "Updated" });
  const r2 = mkRow(21, { [PROJECT_COLS.key]: "", [PROJECT_COLS.notes]: "orphan" }); // no id -> skipped
  const map = buildPreserveMap([header, r1, r2], PROJECT_COLS);

  assert.equal(map.size, 1);
  assert.deepEqual(map.get("id-1"), { notes: "check rera", status: "Updated" });
});

test("buildPreserveMap tolerates short rows (missing trailing cells)", () => {
  const header = Array(21).fill("h");
  const short = ["Proj A"]; // only column A present
  short[PROJECT_COLS.key] = "id-2"; // sets index 20, leaves gaps as undefined
  const map = buildPreserveMap([header, short], PROJECT_COLS);
  assert.deepEqual(map.get("id-2"), { notes: "", status: "" });
});

test("selectResolvedRows returns prev data rows whose id is no longer present", () => {
  const header = Array(21).fill("h");
  const keep = mkRow(21, { [PROJECT_COLS.key]: "id-keep" });
  const gone = mkRow(21, { [PROJECT_COLS.key]: "id-gone" });
  const resolved = selectResolvedRows([header, keep, gone], new Set(["id-keep"]), PROJECT_COLS.key);
  assert.equal(resolved.length, 1);
  assert.equal(resolved[0][PROJECT_COLS.key], "id-gone");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
node --test test/preserve.test.mjs
```
Expected: FAIL — `Cannot find module ... sheet-data.mjs` (or export not found).

- [ ] **Step 3: Write the minimal implementation**

Create `sheet-data.mjs`:
```js
// @ts-check
import { ADMIN_BASE } from "./db.mjs";

export const PROJECT_SHEET_HEADERS = [
  "Project", "Created At", "Creator", "Full Address and Geo Location",
  "Builder", "Land Type", "Land Acres", "Rera Number", "Rera Registration ",
  "Rera Possession", "Nearby Location (Min 3)", "Properties", "Images (Min 1)",
  "Attachements (Min 1) (Floor Plan, Brochure, etc)", "Amenities (Min 1)",
  "Missing Data Count", "Missing Data Summary", "Link", "Notes / Comments",
  "Status", "Project ID",
];

export const PROPERTY_SHEET_HEADERS = [
  "Project Name", "Project Link", "Property Name", "Link", "Created At",
  "Created By", "Total Floor ", "Units per floor ", "Unit configurations",
  "Missing Count", "Missing Data Summery", "Note / Comments", "Status",
  "Property ID", "Project ID",
];

// 0-based indices of the preserved/key columns.
export const PROJECT_COLS = { key: 20, notes: 18, status: 19 };   // U, S, T
export const PROPERTY_COLS = { key: 13, notes: 11, status: 12 };  // N, L, M

const cell = (v) => (v == null ? "" : v.toString());

export function buildPreserveMap(rows, cols) {
  const map = new Map();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const id = cell(row[cols.key]).trim();
    if (!id) continue;
    map.set(id, { notes: cell(row[cols.notes]), status: cell(row[cols.status]) });
  }
  return map;
}

export function selectResolvedRows(prevRows, currentIdSet, keyIndex) {
  const resolved = [];
  for (let i = 1; i < prevRows.length; i++) {
    const row = prevRows[i] ?? [];
    const id = cell(row[keyIndex]).trim();
    if (id && !currentIdSet.has(id)) resolved.push(row);
  }
  return resolved;
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
node --test test/preserve.test.mjs
```
Expected: PASS — `pass 3`, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add sheet-data.mjs test/preserve.test.mjs
git commit -m "feat: sheet-data preserve-map and resolved-row diff"
```

---

## Task 4: `sheet-data.mjs` — formula + row builders

**Files:**
- Modify: `sheet-data.mjs`
- Test: `test/rows.test.mjs`

**Interfaces:**
- Produces:
  - `buildProjectRow(rec, r: number, preserve: Map): any[]` → length-21 array.
  - `buildPropertyRow(rec, r: number, preserve: Map): any[]` → length-15 array.
  - `buildSheetValues(headers: string[], records: object[], rowBuilder, preserve): any[][]` → `[headers, ...rows]`; each record placed at sheet row `i + 2`.
- Where `rec` fields are exactly those returned by the SQL in `db.mjs` (e.g. `project_name`, `created_at`, `location_status`, `accessibility_count`, `project_id`, `property_id`, `total_floors_status`, etc.).

- [ ] **Step 1: Write the failing test**

Create `test/rows.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildProjectRow,
  buildPropertyRow,
  buildSheetValues,
  PROJECT_SHEET_HEADERS,
  PROJECT_COLS,
  PROPERTY_COLS,
} from "../sheet-data.mjs";

const proj = {
  project_id: "p1", project_name: "Acme Towers",
  created_at: "2026-03-01T05:19:19Z", creator_name: "Viinit",
  location_status: "Missing", builder_status: "Present", land_type_status: "Missing",
  land_acres_status: "Missing", rera_number_status: "Missing",
  rera_registration_status: "Missing", rera_completion_status: "Missing",
  accessibility_count: "4", property_count: "1",
  image_count: 0, attachment_count: 0, amenity_count: 0,
};

test("buildProjectRow has 21 cells with correct anchors", () => {
  const row = buildProjectRow(proj, 2, new Map());
  assert.equal(row.length, 21);
  assert.equal(row[0], "Acme Towers");
  assert.equal(row[1], "2026-03-01");          // created_at -> yyyy-mm-dd
  assert.equal(row[3], "Missing");             // location_status (D)
  assert.equal(row[10], 4);                     // accessibility_count numeric (K)
  assert.equal(row[15], "=IF(D2=\"Missing\",1,0)+IF(E2=\"Missing\",1,0)+IF(F2=\"Missing\",1,0)+IF(G2=\"Missing\",1,0)+IF(H2=\"Missing\",1,0)+IF(I2=\"Missing\",1,0)+IF(J2=\"Missing\",1,0)+IF(K2<3,1,0)+IF(L2<1,1,0)+IF(M2<1,1,0)+IF(N2<1,1,0)+IF(O2<1,1,0)");
  assert.ok(row[16].startsWith("=TEXTJOIN(CHAR(10),TRUE,")); // summary, no _xlfn.
  assert.ok(!row[16].includes("_xlfn"));
  assert.equal(row[17], '=HYPERLINK("https://admin-console.propbulls.in/projects/p1","Link")');
  assert.equal(row[PROJECT_COLS.key], "p1");
});

test("buildProjectRow defaults notes blank + status 'Not updated' for new ids", () => {
  const row = buildProjectRow(proj, 2, new Map());
  assert.equal(row[PROJECT_COLS.notes], "");
  assert.equal(row[PROJECT_COLS.status], "Not updated");
});

test("buildProjectRow carries preserved notes + status by id", () => {
  const preserve = new Map([["p1", { notes: "ping builder", status: "Updated" }]]);
  const row = buildProjectRow(proj, 2, preserve);
  assert.equal(row[PROJECT_COLS.notes], "ping builder");
  assert.equal(row[PROJECT_COLS.status], "Updated");
});

const prop = {
  property_id: "pr1", project_id: "p1", project_name: "Acme Towers",
  property_name: "Block A", created_at: "2026-06-09T13:10:14Z",
  creator_name: "Shreya", total_floors_status: "Missing",
  units_per_floor_status: "Missing", unit_config_status: "Missing",
};

test("buildPropertyRow has 15 cells, correct anchors + default status", () => {
  const row = buildPropertyRow(prop, 2, new Map());
  assert.equal(row.length, 15);
  assert.equal(row[0], "Acme Towers");
  assert.equal(row[1], '=HYPERLINK("https://admin-console.propbulls.in/projects/p1","Link")');
  assert.equal(row[3], '=HYPERLINK("https://admin-console.propbulls.in/properties/pr1","Link")');
  assert.equal(row[9], '=COUNTIF(G2:I2,"Missing")');
  assert.equal(row[PROPERTY_COLS.key], "pr1");
  assert.equal(row[14], "p1");
  assert.equal(row[PROPERTY_COLS.status], "Not Updated");
});

test("buildSheetValues prepends header and numbers rows from 2", () => {
  const values = buildSheetValues(PROJECT_SHEET_HEADERS, [proj, proj], buildProjectRow, new Map());
  assert.equal(values.length, 3);                 // header + 2
  assert.deepEqual(values[0], PROJECT_SHEET_HEADERS);
  assert.ok(values[2][15].includes("D3"));        // 2nd record uses row 3
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
node --test test/rows.test.mjs
```
Expected: FAIL — `buildProjectRow` not exported.

- [ ] **Step 3: Write the minimal implementation**

Append to `sheet-data.mjs`:
```js
function toDateStr(v) {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function projectCountFormula(r) {
  return `=IF(D${r}="Missing",1,0)+IF(E${r}="Missing",1,0)+IF(F${r}="Missing",1,0)`
    + `+IF(G${r}="Missing",1,0)+IF(H${r}="Missing",1,0)+IF(I${r}="Missing",1,0)`
    + `+IF(J${r}="Missing",1,0)+IF(K${r}<3,1,0)+IF(L${r}<1,1,0)+IF(M${r}<1,1,0)`
    + `+IF(N${r}<1,1,0)+IF(O${r}<1,1,0)`;
}

function projectSummaryFormula(r) {
  return `=TEXTJOIN(CHAR(10),TRUE,`
    + `IF(D${r}="Missing","Missing location coordinates or full address",""),`
    + `IF(E${r}="Missing","Missing builder",""),`
    + `IF(F${r}="Missing","Missing land type",""),`
    + `IF(G${r}="Missing","Missing land acres",""),`
    + `IF(H${r}="Missing","Missing RERA number",""),`
    + `IF(I${r}="Missing","Missing RERA registration date",""),`
    + `IF(J${r}="Missing","Missing RERA completion date",""),`
    + `IF(K${r}<3,"Nearby accessibility: "&K${r}&" of 3 required",""),`
    + `IF(L${r}<1,"No properties added",""),`
    + `IF(M${r}<1,"No images",""),`
    + `IF(N${r}<1,"No attachments",""),`
    + `IF(O${r}<1,"No amenities",""))`;
}

function propertySummaryFormula(r) {
  return `=TEXTJOIN(CHAR(10),TRUE,`
    + `IF(G${r}="Missing","Missing total floors",""),`
    + `IF(H${r}="Missing","Missing units per floor",""),`
    + `IF(I${r}="Missing","No unit configurations",""))`;
}

const num = (v) => (v == null || v === "" ? 0 : Number(v));

export function buildProjectRow(rec, r, preserve) {
  const saved = preserve.get(cell(rec.project_id)) || {};
  return [
    cell(rec.project_name),
    toDateStr(rec.created_at),
    cell(rec.creator_name),
    rec.location_status,
    rec.builder_status,
    rec.land_type_status,
    rec.land_acres_status,
    rec.rera_number_status,
    rec.rera_registration_status,
    rec.rera_completion_status,
    num(rec.accessibility_count),
    num(rec.property_count),
    num(rec.image_count),
    num(rec.attachment_count),
    num(rec.amenity_count),
    projectCountFormula(r),
    projectSummaryFormula(r),
    `=HYPERLINK("${ADMIN_BASE}/projects/${rec.project_id}","Link")`,
    saved.notes ?? "",
    saved.status || "Not updated",
    cell(rec.project_id),
  ];
}

export function buildPropertyRow(rec, r, preserve) {
  const saved = preserve.get(cell(rec.property_id)) || {};
  return [
    cell(rec.project_name),
    `=HYPERLINK("${ADMIN_BASE}/projects/${rec.project_id}","Link")`,
    cell(rec.property_name),
    `=HYPERLINK("${ADMIN_BASE}/properties/${rec.property_id}","Link")`,
    toDateStr(rec.created_at),
    cell(rec.creator_name),
    rec.total_floors_status,
    rec.units_per_floor_status,
    rec.unit_config_status,
    `=COUNTIF(G${r}:I${r},"Missing")`,
    propertySummaryFormula(r),
    saved.notes ?? "",
    saved.status || "Not Updated",
    cell(rec.property_id),
    cell(rec.project_id),
  ];
}

export function buildSheetValues(headers, records, rowBuilder, preserve) {
  return [headers, ...records.map((rec, i) => rowBuilder(rec, i + 2, preserve))];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
node --test test/rows.test.mjs
```
Expected: PASS — `pass 5`, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add sheet-data.mjs test/rows.test.mjs
git commit -m "feat: sheet-data project/property row + formula builders"
```

---

## Task 5: `sheet-data.mjs` — archive builders + dedupe

**Files:**
- Modify: `sheet-data.mjs`
- Test: `test/archive.test.mjs`

**Interfaces:**
- Produces:
  - `PROJECT_ARCHIVE_HEADERS: string[]` (5), `PROPERTY_ARCHIVE_HEADERS: string[]` (7)
  - `PROJECT_ARCHIVE_KEY = 1`, `PROPERTY_ARCHIVE_KEY = 2` (0-based id column in the archive layout)
  - `buildProjectArchiveRow(prevRow: any[], resolvedAt: string): any[]`
  - `buildPropertyArchiveRow(prevRow: any[], resolvedAt: string): any[]`
  - `dedupeArchiveRows(existingRows: any[][], newRows: any[][], keyIndex: number): any[][]`
- Consumes: `prevRow` is a full active-tab row (project = 21 cells, property = 15 cells) from `selectResolvedRows`.

- [ ] **Step 1: Write the failing test**

Create `test/archive.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildProjectArchiveRow,
  buildPropertyArchiveRow,
  dedupeArchiveRows,
  PROJECT_ARCHIVE_HEADERS,
  PROPERTY_ARCHIVE_HEADERS,
  PROJECT_ARCHIVE_KEY,
  PROPERTY_ARCHIVE_KEY,
} from "../sheet-data.mjs";

function mkRow(len, vals) {
  const a = Array(len).fill("");
  for (const [i, v] of Object.entries(vals)) a[Number(i)] = v;
  return a;
}

test("buildProjectArchiveRow extracts name/id/notes/status + resolvedAt", () => {
  // project active layout: 0=Project, 18=Notes, 19=Status, 20=Project ID
  const prev = mkRow(21, { 0: "Acme", 18: "fixed rera", 19: "Updated", 20: "p1" });
  const row = buildProjectArchiveRow(prev, "2026-06-30");
  assert.equal(row.length, PROJECT_ARCHIVE_HEADERS.length);
  assert.deepEqual(row, ["Acme", "p1", "fixed rera", "Updated", "2026-06-30"]);
  assert.equal(row[PROJECT_ARCHIVE_KEY], "p1");
});

test("buildPropertyArchiveRow extracts the right columns", () => {
  // property active layout: 0=Project Name, 2=Property Name, 11=Notes, 12=Status, 13=Property ID, 14=Project ID
  const prev = mkRow(15, { 0: "Acme", 2: "Block A", 11: "done", 12: "Updated", 13: "pr1", 14: "p1" });
  const row = buildPropertyArchiveRow(prev, "2026-06-30");
  assert.deepEqual(row, ["Acme", "Block A", "pr1", "p1", "done", "Updated", "2026-06-30"]);
  assert.equal(row[PROPERTY_ARCHIVE_KEY], "pr1");
});

test("dedupeArchiveRows drops rows whose key already exists in the archive", () => {
  const existing = [PROJECT_ARCHIVE_HEADERS, ["Old", "p1", "", "", "2026-01-01"]];
  const incoming = [
    ["Acme", "p1", "x", "y", "2026-06-30"], // dup of p1 -> dropped
    ["Beta", "p2", "x", "y", "2026-06-30"], // new -> kept
  ];
  const out = dedupeArchiveRows(existing, incoming, PROJECT_ARCHIVE_KEY);
  assert.equal(out.length, 1);
  assert.equal(out[0][PROJECT_ARCHIVE_KEY], "p2");
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
node --test test/archive.test.mjs
```
Expected: FAIL — archive exports not found.

- [ ] **Step 3: Write the minimal implementation**

Append to `sheet-data.mjs`:
```js
export const PROJECT_ARCHIVE_HEADERS = [
  "Project", "Project ID", "Notes / Comments", "Status", "Resolved At",
];
export const PROPERTY_ARCHIVE_HEADERS = [
  "Project Name", "Property Name", "Property ID", "Project ID",
  "Note / Comments", "Status", "Resolved At",
];
export const PROJECT_ARCHIVE_KEY = 1;   // Project ID column in archive layout
export const PROPERTY_ARCHIVE_KEY = 2;  // Property ID column in archive layout

export function buildProjectArchiveRow(prevRow, resolvedAt) {
  return [
    cell(prevRow[0]),   // Project
    cell(prevRow[20]),  // Project ID
    cell(prevRow[18]),  // Notes / Comments
    cell(prevRow[19]),  // Status
    resolvedAt,
  ];
}

export function buildPropertyArchiveRow(prevRow, resolvedAt) {
  return [
    cell(prevRow[0]),   // Project Name
    cell(prevRow[2]),   // Property Name
    cell(prevRow[13]),  // Property ID
    cell(prevRow[14]),  // Project ID
    cell(prevRow[11]),  // Note / Comments
    cell(prevRow[12]),  // Status
    resolvedAt,
  ];
}

export function dedupeArchiveRows(existingRows, newRows, keyIndex) {
  const seen = new Set();
  for (let i = 1; i < existingRows.length; i++) {
    const id = cell((existingRows[i] ?? [])[keyIndex]).trim();
    if (id) seen.add(id);
  }
  return newRows.filter((r) => {
    const id = cell(r[keyIndex]).trim();
    return id && !seen.has(id);
  });
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
node --test test/archive.test.mjs
```
Expected: PASS — `pass 3`, `fail 0`.

- [ ] **Step 5: Commit**

```bash
git add sheet-data.mjs test/archive.test.mjs
git commit -m "feat: sheet-data archive row builders + dedupe"
```

---

## Task 6: `sheet-format.mjs` — batchUpdate request builders

**Files:**
- Create: `sheet-format.mjs`
- Test: `test/format.test.mjs`

**Interfaces:**
- Produces:
  - `deleteCfRequests(sheetId: number, count: number): object[]` — `deleteConditionalFormatRule` requests for indices `count-1 .. 0` (delete high-to-low so indices stay valid).
  - `projectFormatRequests(sheetId: number, existingCfCount: number): object[]`
  - `propertyFormatRequests(sheetId: number, existingCfCount: number): object[]`
- Each `*FormatRequests` returns, in order: CF deletes, freeze-header (`updateSheetProperties`), data-validation dropdowns (`setDataValidation`), and fresh conditional-format rules (`addConditionalFormatRule`).

- [ ] **Step 1: Write the failing test**

Create `test/format.test.mjs`:
```js
import { test } from "node:test";
import assert from "node:assert/strict";
import {
  deleteCfRequests,
  projectFormatRequests,
  propertyFormatRequests,
} from "../sheet-format.mjs";

test("deleteCfRequests emits high-to-low indices", () => {
  const reqs = deleteCfRequests(7, 3);
  assert.deepEqual(reqs.map((r) => r.deleteConditionalFormatRule.index), [2, 1, 0]);
  assert.equal(reqs[0].deleteConditionalFormatRule.sheetId, 7);
});

test("deleteCfRequests with 0 existing rules emits nothing", () => {
  assert.deepEqual(deleteCfRequests(7, 0), []);
});

test("projectFormatRequests freezes header and adds dropdowns + CF", () => {
  const reqs = projectFormatRequests(7, 2);
  // first two are CF deletes
  assert.equal(reqs[0].deleteConditionalFormatRule.index, 1);
  assert.equal(reqs[1].deleteConditionalFormatRule.index, 0);
  // a freeze request exists
  assert.ok(reqs.some((r) => r.updateSheetProperties?.properties?.gridProperties?.frozenRowCount === 1));
  // a Missing/Present dropdown exists
  assert.ok(reqs.some((r) =>
    r.setDataValidation?.rule?.condition?.type === "ONE_OF_LIST"
    && r.setDataValidation.rule.condition.values.some((v) => v.userEnteredValue === "Missing")));
  // a Status dropdown with the workflow values exists
  assert.ok(reqs.some((r) =>
    r.setDataValidation?.rule?.condition?.values?.some((v) => v.userEnteredValue === "Should be Deleted")));
  // at least one conditional format rule added
  assert.ok(reqs.some((r) => r.addConditionalFormatRule));
});

test("propertyFormatRequests targets sheetId and adds CF", () => {
  const reqs = propertyFormatRequests(9, 0);
  assert.ok(reqs.some((r) => r.addConditionalFormatRule?.rule?.ranges?.[0]?.sheetId === 9));
  assert.ok(reqs.some((r) =>
    r.setDataValidation?.rule?.condition?.values?.some((v) => v.userEnteredValue === "Not Updated")));
});
```

- [ ] **Step 2: Run test to verify it fails**

Run:
```bash
node --test test/format.test.mjs
```
Expected: FAIL — `sheet-format.mjs` not found.

- [ ] **Step 3: Write the minimal implementation**

Create `sheet-format.mjs`:
```js
// @ts-check
// Pure builders for Google Sheets spreadsheets.batchUpdate request objects.
// No I/O. Column indices are 0-based half-open ranges; startRowIndex 1 = skip header.

const RED = { red: 0.96, green: 0.80, blue: 0.80 };
const GREEN = { red: 0.85, green: 0.92, blue: 0.83 };

function range(sheetId, c0, c1) {
  return { sheetId, startRowIndex: 1, startColumnIndex: c0, endColumnIndex: c1 };
}

function dropdown(sheetId, c0, c1, values) {
  return {
    setDataValidation: {
      range: range(sheetId, c0, c1),
      rule: {
        condition: { type: "ONE_OF_LIST", values: values.map((v) => ({ userEnteredValue: v })) },
        showCustomUi: true,
        strict: false,
      },
    },
  };
}

function freezeHeader(sheetId) {
  return {
    updateSheetProperties: {
      properties: { sheetId, gridProperties: { frozenRowCount: 1 } },
      fields: "gridProperties.frozenRowCount",
    },
  };
}

function cfTextEq(sheetId, c0, c1, text, color) {
  return {
    addConditionalFormatRule: {
      index: 0,
      rule: {
        ranges: [range(sheetId, c0, c1)],
        booleanRule: {
          condition: { type: "TEXT_EQ", values: [{ userEnteredValue: text }] },
          format: { backgroundColor: color },
        },
      },
    },
  };
}

function cfNumberLess(sheetId, c0, c1, n, color) {
  return {
    addConditionalFormatRule: {
      index: 0,
      rule: {
        ranges: [range(sheetId, c0, c1)],
        booleanRule: {
          condition: { type: "NUMBER_LESS", values: [{ userEnteredValue: String(n) }] },
          format: { backgroundColor: color },
        },
      },
    },
  };
}

function cfNumberGte(sheetId, c0, c1, n, color) {
  return {
    addConditionalFormatRule: {
      index: 0,
      rule: {
        ranges: [range(sheetId, c0, c1)],
        booleanRule: {
          condition: { type: "NUMBER_GREATER_THAN_EQ", values: [{ userEnteredValue: String(n) }] },
          format: { backgroundColor: color },
        },
      },
    },
  };
}

export function deleteCfRequests(sheetId, count) {
  const reqs = [];
  for (let i = count - 1; i >= 0; i--) {
    reqs.push({ deleteConditionalFormatRule: { sheetId, index: i } });
  }
  return reqs;
}

export function projectFormatRequests(sheetId, existingCfCount) {
  return [
    ...deleteCfRequests(sheetId, existingCfCount),
    freezeHeader(sheetId),
    // Status workflow dropdown (col T = index 19)
    dropdown(sheetId, 19, 20, ["Not updated", "Updated", "Should be Deleted"]),
    // Missing/Present dropdowns (cols D..J = indices 3..10)
    dropdown(sheetId, 3, 10, ["Missing", "Present"]),
    // D..J: Missing red / Present green
    cfTextEq(sheetId, 3, 10, "Missing", RED),
    cfTextEq(sheetId, 3, 10, "Present", GREEN),
    // K (index 10): <3 red, >=3 green
    cfNumberLess(sheetId, 10, 11, 3, RED),
    cfNumberGte(sheetId, 10, 11, 3, GREEN),
    // L..O (indices 11..15): <1 red, >=1 green
    cfNumberLess(sheetId, 11, 15, 1, RED),
    cfNumberGte(sheetId, 11, 15, 1, GREEN),
  ];
}

export function propertyFormatRequests(sheetId, existingCfCount) {
  return [
    ...deleteCfRequests(sheetId, existingCfCount),
    freezeHeader(sheetId),
    // Status workflow dropdown (col M = index 12)
    dropdown(sheetId, 12, 13, ["Not Updated", "Updated", "Should be Deleted"]),
    // Missing/Present dropdowns (cols G..I = indices 6..9)
    dropdown(sheetId, 6, 9, ["Missing", "Present"]),
    cfTextEq(sheetId, 6, 9, "Missing", RED),
    cfTextEq(sheetId, 6, 9, "Present", GREEN),
  ];
}
```

- [ ] **Step 4: Run test to verify it passes**

Run:
```bash
node --test test/format.test.mjs
```
Expected: PASS — `pass 4`, `fail 0`.

- [ ] **Step 5: Run the whole suite**

Run:
```bash
npm test
```
Expected: all tests pass (`fail 0`).

- [ ] **Step 6: Commit**

```bash
git add sheet-format.mjs test/format.test.mjs
git commit -m "feat: sheet-format batchUpdate request builders"
```

---

## Task 7: `sheets-client.mjs` — Google Sheets I/O wrappers

**Files:**
- Create: `sheets-client.mjs`

**Interfaces:**
- Consumes: `googleapis`.
- Produces:
  - `getSheetsClient(keyPath: string)` → authorized `sheets` API object (service-account JWT, scope `spreadsheets`).
  - `getTabMap(sheets, spreadsheetId)` → `Promise<Map<string, number>>` title→sheetId.
  - `ensureTab(sheets, spreadsheetId, title, tabMap)` → `Promise<number>` sheetId (creates the tab if absent, updates `tabMap`).
  - `readTab(sheets, spreadsheetId, title)` → `Promise<any[][]>` (`[]` if empty).
  - `cfRuleCount(sheets, spreadsheetId, sheetId)` → `Promise<number>` existing conditional-format rule count.
  - `writeGrid(sheets, spreadsheetId, title, values, lastColLetter)` → overwrite from A1, then clear trailing rows below the new data.
  - `appendRows(sheets, spreadsheetId, title, rows)` → append (no-op when `rows` empty).
  - `runBatch(sheets, spreadsheetId, requests)` → `spreadsheets.batchUpdate` (no-op when empty).

**This task has no unit test** (it is thin network I/O). It is verified end-to-end in Task 8 via `--dry-run` (no network) and, when the user supplies credentials, a live run.

- [ ] **Step 1: Write the implementation**

Create `sheets-client.mjs`:
```js
// @ts-check
import { readFileSync } from "node:fs";
import { google } from "googleapis";

export function getSheetsClient(keyPath) {
  const key = JSON.parse(readFileSync(keyPath, "utf8"));
  const auth = new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

export async function getTabMap(sheets, spreadsheetId) {
  const res = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(sheetId,title))",
  });
  const map = new Map();
  for (const s of res.data.sheets ?? []) {
    map.set(s.properties.title, s.properties.sheetId);
  }
  return map;
}

export async function ensureTab(sheets, spreadsheetId, title, tabMap) {
  if (tabMap.has(title)) return tabMap.get(title);
  const res = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title } } }] },
  });
  const sheetId = res.data.replies[0].addSheet.properties.sheetId;
  tabMap.set(title, sheetId);
  return sheetId;
}

export async function readTab(sheets, spreadsheetId, title) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${title}'`,
    valueRenderOption: "FORMATTED_VALUE",
  });
  return res.data.values ?? [];
}

export async function cfRuleCount(sheets, spreadsheetId, sheetId) {
  const res = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties.sheetId,conditionalFormats)",
  });
  const sheet = (res.data.sheets ?? []).find((s) => s.properties.sheetId === sheetId);
  return sheet?.conditionalFormats?.length ?? 0;
}

export async function writeGrid(sheets, spreadsheetId, title, values, lastColLetter) {
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${title}'!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });
  const firstEmptyRow = values.length + 1;
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `'${title}'!A${firstEmptyRow}:${lastColLetter}`,
  });
}

export async function appendRows(sheets, spreadsheetId, title, rows) {
  if (!rows.length) return;
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `'${title}'!A1`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: rows },
  });
}

export async function runBatch(sheets, spreadsheetId, requests) {
  if (!requests.length) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests },
  });
}
```

- [ ] **Step 2: Verify the module imports without error**

Run:
```bash
node -e "import('./sheets-client.mjs').then(m => console.log(Object.keys(m).sort().join(',')))"
```
Expected: prints `appendRows,cfRuleCount,ensureTab,getSheetsClient,getTabMap,readTab,runBatch,writeGrid`.

- [ ] **Step 3: Commit**

```bash
git add sheets-client.mjs
git commit -m "feat: sheets-client googleapis I/O wrappers"
```

---

## Task 8: `sync-sheet.mjs` — orchestrator + dry-run + live verification

**Files:**
- Create: `sync-sheet.mjs`

**Interfaces:**
- Consumes: `fetchData` (`db.mjs`); all builders (`sheet-data.mjs`, `sheet-format.mjs`); all wrappers (`sheets-client.mjs`).
- Produces: CLI `node sync-sheet.mjs [--dry-run]`.
  - `--dry-run`: forces `MOCK=1`, performs no network calls, prints the project + property grids and the resolved/archive counts, then exits 0.
  - Normal: reads `.env`, refreshes both active tabs in place, archives resolved rows, applies formatting, prints the sheet URL.

- [ ] **Step 1: Write the implementation**

Create `sync-sheet.mjs`:
```js
// @ts-check
import process from "node:process";
import { fetchData } from "./db.mjs";
import {
  PROJECT_SHEET_HEADERS, PROPERTY_SHEET_HEADERS,
  PROJECT_COLS, PROPERTY_COLS,
  PROJECT_ARCHIVE_HEADERS, PROPERTY_ARCHIVE_HEADERS,
  PROJECT_ARCHIVE_KEY, PROPERTY_ARCHIVE_KEY,
  buildPreserveMap, selectResolvedRows,
  buildProjectRow, buildPropertyRow, buildSheetValues,
  buildProjectArchiveRow, buildPropertyArchiveRow, dedupeArchiveRows,
} from "./sheet-data.mjs";
import { projectFormatRequests, propertyFormatRequests } from "./sheet-format.mjs";
import {
  getSheetsClient, getTabMap, ensureTab, readTab, cfRuleCount,
  writeGrid, appendRows, runBatch,
} from "./sheets-client.mjs";

const DRY_RUN = process.argv.includes("--dry-run");
const today = () => new Date().toISOString().slice(0, 10);

/** Plan shared by dry-run and live run: turns DB rows + prev tab into the writes. */
function planTab({ records, headers, cols, rowBuilder, archiveHeaders, archiveKey, archiveBuilder, prevRows, prevArchive }) {
  const preserve = buildPreserveMap(prevRows, cols);
  const currentIds = new Set(records.map((r) => (rowBuilder === buildProjectRow ? r.project_id : r.property_id)?.toString().trim()).filter(Boolean));
  const values = buildSheetValues(headers, records, rowBuilder, preserve);

  const resolvedPrevRows = selectResolvedRows(prevRows, currentIds, cols.key);
  const stamp = today();
  const newArchiveRows = resolvedPrevRows.map((row) => archiveBuilder(row, stamp));
  const archiveToAppend = dedupeArchiveRows(
    prevArchive.length ? prevArchive : [archiveHeaders],
    newArchiveRows,
    archiveKey,
  );
  return { values, archiveToAppend };
}

async function main() {
  const { projects, properties } = await fetchData();
  console.log(`Found ${projects.length} incomplete project(s), ${properties.length} incomplete property(ies).`);

  if (DRY_RUN) {
    const proj = planTab({
      records: projects, headers: PROJECT_SHEET_HEADERS, cols: PROJECT_COLS,
      rowBuilder: buildProjectRow, archiveHeaders: PROJECT_ARCHIVE_HEADERS,
      archiveKey: PROJECT_ARCHIVE_KEY, archiveBuilder: buildProjectArchiveRow,
      prevRows: [], prevArchive: [],
    });
    const prop = planTab({
      records: properties, headers: PROPERTY_SHEET_HEADERS, cols: PROPERTY_COLS,
      rowBuilder: buildPropertyRow, archiveHeaders: PROPERTY_ARCHIVE_HEADERS,
      archiveKey: PROPERTY_ARCHIVE_KEY, archiveBuilder: buildPropertyArchiveRow,
      prevRows: [], prevArchive: [],
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
    rowBuilder: buildProjectRow, archiveHeaders: PROJECT_ARCHIVE_HEADERS,
    archiveKey: PROJECT_ARCHIVE_KEY, archiveBuilder: buildProjectArchiveRow,
    lastCol: "U", formatReqs: projectFormatRequests,
  });

  await syncOne(sheets, spreadsheetId, tabMap, {
    activeTitle: "Missing Property Data", archiveTitle: "Resolved Property Data",
    records: properties, headers: PROPERTY_SHEET_HEADERS, cols: PROPERTY_COLS,
    rowBuilder: buildPropertyRow, archiveHeaders: PROPERTY_ARCHIVE_HEADERS,
    archiveKey: PROPERTY_ARCHIVE_KEY, archiveBuilder: buildPropertyArchiveRow,
    lastCol: "O", formatReqs: propertyFormatRequests,
  });

  console.log(`Done. https://docs.google.com/spreadsheets/d/${spreadsheetId}/edit`);
}

async function syncOne(sheets, spreadsheetId, tabMap, cfg) {
  const sheetId = await ensureTab(sheets, spreadsheetId, cfg.activeTitle, tabMap);
  await ensureTab(sheets, spreadsheetId, cfg.archiveTitle, tabMap);

  const prevRows = await readTab(sheets, spreadsheetId, cfg.activeTitle);
  const prevArchive = await readTab(sheets, spreadsheetId, cfg.archiveTitle);

  const { values, archiveToAppend } = planTab({
    records: cfg.records, headers: cfg.headers, cols: cfg.cols,
    rowBuilder: cfg.rowBuilder, archiveHeaders: cfg.archiveHeaders,
    archiveKey: cfg.archiveKey, archiveBuilder: cfg.archiveBuilder,
    prevRows, prevArchive,
  });

  // Ensure archive header exists before appending.
  if (!prevArchive.length) {
    await writeGrid(sheets, spreadsheetId, cfg.archiveTitle, [cfg.archiveHeaders], "Z");
  }
  await appendRows(sheets, spreadsheetId, cfg.archiveTitle, archiveToAppend);

  await writeGrid(sheets, spreadsheetId, cfg.activeTitle, values, cfg.lastCol);

  const count = await cfRuleCount(sheets, spreadsheetId, sheetId);
  await runBatch(sheets, spreadsheetId, cfg.formatReqs(sheetId, count));

  console.log(`  ${cfg.activeTitle}: ${values.length - 1} rows; archived ${archiveToAppend.length}.`);
}

main().catch((err) => { console.error(err); process.exit(1); });
```

- [ ] **Step 2: Run the dry-run (no credentials, no network)**

Run:
```bash
node sync-sheet.mjs --dry-run
```
Expected: prints `Found 2 incomplete project(s), 1 incomplete property(ies).`, then the project grid (3 rows incl. header) and property grid (2 rows incl. header), each row an array; project row 2 index 19 = `"Not updated"`, property row 2 index 12 = `"Not Updated"`; ends `[DRY RUN] No network calls made.`

- [ ] **Step 3: Commit**

```bash
git add sync-sheet.mjs
git commit -m "feat: sync-sheet orchestrator with --dry-run"
```

- [ ] **Step 4: Live verification (requires the user's Google setup)**

> Do this once the user has completed the one-time setup (Task 9 doc) and placed `service-account.json` + filled `.env`. If credentials are not yet available, STOP here and report that the code is complete and dry-run verified, pending live credentials.

Run:
```bash
node sync-sheet.mjs
```
Expected: prints per-tab row counts and the sheet URL, no errors. Then manually confirm in the browser:
1. Open the sheet URL. Both `Missing Project Data` and `Missing Property Data` tabs are populated; header frozen; Missing cells red, Present green.
2. In a project row, type a note in `Notes / Comments` and set `Status` to `Updated`. Note the `Project ID`.
3. Run `node sync-sheet.mjs` again. Confirm that row's note + status are **still present** after the refresh.
4. (Archive check) If any row's data was completed in the DB between runs, confirm it moved to the matching `Resolved …` tab with its note/status + a Resolved At date, and is gone from the active tab.

---

## Task 9: Documentation — README + one-time Google setup

**Files:**
- Modify: `README.md`

**Interfaces:** none (docs only).

- [ ] **Step 1: Add a "Google Sheets sync" section to `README.md`**

Add the following section to `README.md` (after the existing "Run" section):
````markdown
## Google Sheets sync (keeps team comments)

`npm run sync` refreshes one permanent Google Sheet in place instead of
producing a new file each time. The team's `Notes / Comments` and `Status`
are preserved across refreshes (matched by the row's `Project ID` /
`Property ID`). Rows that become complete are moved to `Resolved …` tabs.

### One-time setup

1. In [Google Cloud Console](https://console.cloud.google.com/), create a
   project and enable the **Google Sheets API**.
2. Create a **service account**, then create a **JSON key** for it. Save the
   downloaded file as `service-account.json` in this folder (it is gitignored).
3. Create a blank Google Sheet. Click **Share** and add the service account's
   email (looks like `name@project-id.iam.gserviceaccount.com`, found inside
   the JSON key as `client_email`) as an **Editor**.
4. Copy the spreadsheet ID from the sheet URL
   (`https://docs.google.com/spreadsheets/d/<ID>/edit`) into `.env`:
   ```
   GOOGLE_SERVICE_ACCOUNT_KEY=./service-account.json
   SPREADSHEET_ID=<ID>
   DATABASE_URL=postgres://...
   ```
5. `npm install`, then `npm run sync`. The four tabs are created automatically
   on first run.

### Dry run (no Google account needed)

```bash
node sync-sheet.mjs --dry-run
```
Prints the grids it would write using mock data; makes no network calls.

### Notes

- Always share the **same** sheet link with the team — the script updates it
  in place, so comments persist.
- Don't rename the tabs (`Missing Project Data`, `Missing Property Data`,
  `Resolved Project Data`, `Resolved Property Data`).
- Run the refresh when the team is not actively editing: an edit made during
  the few seconds the script runs could be overwritten.
- The `.xlsx` generator (`npm run generate`) is kept as an offline fallback.
````

- [ ] **Step 2: Commit**

```bash
git add README.md
git commit -m "docs: Google Sheets sync usage + one-time setup"
```

---

## Self-Review

**Spec coverage:**
- Persistent sheet, in-place refresh → Tasks 7, 8 (`writeGrid`, orchestrator).
- Preserve Notes/Status by ID → Task 3 (`buildPreserveMap`) + Task 4 (row builders carry saved values).
- Service-account auth → Task 7 (`getSheetsClient`), Task 9 (setup doc).
- `db.mjs` extraction, xlsx kept → Task 2.
- New incomplete row defaults → Task 4 (`"Not updated"` / `"Not Updated"`).
- Resolved rows archived, append-only + deduped, Resolved At date → Task 5 + Task 8.
- Idempotent formatting (freeze, dropdowns, red/green CF on whole columns, CF wiped+re-added) → Task 6 (`deleteCfRequests` + `*FormatRequests`) + Task 8 (`cfRuleCount` then `runBatch`).
- Tabs by fixed title, auto-created → Task 8 (`ensureTab`).
- Formulas in Google syntax, no `_xlfn.` → Task 4 (asserted in tests).
- `.env` keys, secrets gitignored → Task 1.
- Known concurrency risk + reappearing-archived-row behavior → documented (Task 9 README + design doc).

**Placeholder scan:** The only intentional fill-ins are in Task 2 Step 1 (copy the exact `SQL_PROJECTS`/`SQL_PROPERTIES`/`mockData()` from the current file) — explicitly instructed to paste verbatim, not invent. No other TBDs.

**Type consistency:** `buildPreserveMap(rows, cols)` shape `{key,notes,status}` used consistently; `selectResolvedRows(prevRows, currentIdSet, keyIndex)` consumed in Task 8 with `cfg.cols.key`; archive key indices (`PROJECT_ARCHIVE_KEY=1`, `PROPERTY_ARCHIVE_KEY=2`) match the archive header layouts; `*FormatRequests(sheetId, existingCfCount)` signature matches Task 8's `cfg.formatReqs(sheetId, count)` call.
