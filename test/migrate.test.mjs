import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import {
  extractId, isRealNote,
  buildProjectMap, buildPropertyMap, computeUpdates,
  OLD_PROJECT, OLD_PROPERTY,
} from "../migrate-data.mjs";
import { readXlsxSheet } from "../xlsx-read.mjs";
import { PROJECT_COLS, PROPERTY_COLS } from "../sheet-data.mjs";

test("extractId pulls UUID from project & property URLs, null on junk", () => {
  assert.equal(
    extractId("https://admin-console.propbulls.in/projects/3040FD6E-F0E2-492F-A6AE-6DACD25E56F0"),
    "3040fd6e-f0e2-492f-a6ae-6dacd25e56f0",
  );
  assert.equal(
    extractId("https://admin-console.propbulls.in/properties/ec15791d-1d95-46d3-8c34-ba6b2253e397"),
    "ec15791d-1d95-46d3-8c34-ba6b2253e397",
  );
  assert.equal(extractId("Link"), null);
  assert.equal(extractId(""), null);
  assert.equal(extractId(null), null);
});

test("isRealNote rejects blanks, accepts text", () => {
  assert.equal(isRealNote(""), false);
  assert.equal(isRealNote("   "), false);
  assert.equal(isRealNote(null), false);
  assert.equal(isRealNote("Waiting for brochure"), true);
});

// Build tiny old-file row grids matching the verified column layout. The `id`
// column now holds a bare UUID (or an admin-console URL — both are accepted).
const projRow = (name, id, notes, status) => {
  const r = [];
  r[0] = name;
  r[OLD_PROJECT.id] = id;
  r[OLD_PROJECT.notes] = notes;
  r[OLD_PROJECT.status] = status;
  return r;
};
const propRow = (name, id, notes, status) => {
  const r = [];
  r[0] = name;
  r[OLD_PROPERTY.id] = id;
  r[OLD_PROPERTY.notes] = notes;
  r[OLD_PROPERTY.status] = status;
  return r;
};

test("buildProjectMap keys by UUID, keeps notes+status, drops off-dropdown status", () => {
  const rows = [
    ["header"],
    projRow("A", "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa", "Pre-RERA Project", "Updated"),           // bare UUID
    projRow("B", "https://admin-console.propbulls.in/projects/bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb", "", "Not updated"), // URL still works
    projRow("C", "cccccccc-cccc-cccc-cccc-cccccccccccc", "note", "garbage-status"),
    projRow("D", "no-id", "note", "Updated"),
  ];
  const map = buildProjectMap(rows);
  assert.deepEqual(map.get("aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa"), { notes: "Pre-RERA Project", status: "Updated" });
  assert.deepEqual(map.get("bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb"), { status: "Not updated" }); // no note
  assert.deepEqual(map.get("cccccccc-cccc-cccc-cccc-cccccccccccc"), { notes: "note" });          // status dropped
  assert.equal(map.has("D"), false);                                                              // no url -> skipped
  assert.equal(map.size, 3);
});

test("buildPropertyMap uses the property casing for status", () => {
  const rows = [
    ["header"],
    propRow("P", "dddddddd-dddd-dddd-dddd-dddddddddddd", "", "Not Updated"),
    propRow("Q", "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee", "", "Not updated"),
  ];
  const map = buildPropertyMap(rows);
  assert.deepEqual(map.get("dddddddd-dddd-dddd-dddd-dddddddddddd"), { status: "Not Updated" });
  assert.equal(map.has("eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee"), false); // "Not updated" not in property set
});

test("computeUpdates matches by id column, overwrites, skips unmatched", () => {
  const map = new Map([
    ["id-1", { notes: "keep", status: "Updated" }],
    ["id-2", { status: "Not updated" }],
    ["id-gone", { status: "Updated" }], // not in live sheet
  ]);
  // live rows: header + 2 data rows; key column = PROJECT_COLS.key
  const mk = (id) => { const r = []; r[0] = id; r[PROJECT_COLS.key] = id; return r; };
  const live = [["header"], mk("id-1"), mk("id-2")];
  const { updates, matched, unmatched } = computeUpdates(live, PROJECT_COLS, map);
  assert.equal(matched, 2);
  assert.equal(unmatched, 1); // id-gone
  assert.equal(updates.length, 2);
  assert.deepEqual(updates[0], { rowIndex: 1, notes: "keep", status: "Updated" });
  assert.deepEqual(updates[1], { rowIndex: 2, status: "Not updated" });
});

// Integration guard for the shared-string resolution bug: if old-data.xlsx is
// present, the project URL column must resolve to real URLs (not pointer indices).
const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const OLD = fileURLToPath(new URL("../old-data.xlsx", import.meta.url));
test("readXlsxSheet resolves shared strings (project ID col, not a raw index)", { skip: !existsSync(OLD) }, async () => {
  const rows = await readXlsxSheet(readFileSync(OLD), "Missing Project Data");
  const dataRows = rows.slice(1).filter((r) => (r[OLD_PROJECT.id] ?? "").trim() !== "");
  assert.ok(dataRows.length > 100, "expected many project rows");
  assert.ok(
    UUID_RE.test(dataRows[0][OLD_PROJECT.id].trim()),
    "project ID column must resolve to a UUID, not a shared-string index",
  );
  const map = buildProjectMap(rows);
  assert.ok(map.size > 100, "expected many project records with status/notes");
});
