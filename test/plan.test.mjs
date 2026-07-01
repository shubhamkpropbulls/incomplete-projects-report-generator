import { test } from "node:test";
import assert from "node:assert/strict";
import {
  planTab,
  PROJECT_SHEET_HEADERS,
  PROJECT_COLS,
  PROJECT_ARCHIVE_HEADERS,
  PROJECT_ARCHIVE_KEY,
  buildProjectRow,
  buildProjectArchiveRow,
} from "../sheet-data.mjs";

/** Build a 21-cell row placing values at specified 0-based indices. */
function mkRow(vals) {
  const a = Array(21).fill("");
  for (const [i, v] of Object.entries(vals)) a[Number(i)] = v;
  return a;
}

// prevRows: header + 2 data rows
const prevRows = [
  PROJECT_SHEET_HEADERS,
  mkRow({ 0: "Keep Project", [PROJECT_COLS.notes]: "check rera", [PROJECT_COLS.status]: "Updated", [PROJECT_COLS.key]: "keep-1" }),
  mkRow({ 0: "Gone Project", [PROJECT_COLS.notes]: "to delete", [PROJECT_COLS.status]: "Should be Deleted", [PROJECT_COLS.key]: "gone-1" }),
];

// Only keep-1 is still incomplete (gone-1 is now resolved/absent from records)
const records = [
  {
    project_id: "keep-1",
    project_name: "Keep Project",
    created_at: "2026-01-15T00:00:00Z",
    creator_name: "Alice",
    location_status: "OK",
    builder_status: "Missing",
    land_type_status: "OK",
    land_acres_status: "OK",
    rera_number_status: "OK",
    rera_registration_status: "OK",
    rera_completion_status: "OK",
    accessibility_count: 3,
    property_count: 2,
    image_count: 1,
    attachment_count: 1,
    amenity_count: 1,
  },
];

const out = planTab({
  records,
  headers: PROJECT_SHEET_HEADERS,
  cols: PROJECT_COLS,
  rowBuilder: buildProjectRow,
  idField: "project_id",
  archiveHeaders: PROJECT_ARCHIVE_HEADERS,
  archiveKey: PROJECT_ARCHIVE_KEY,
  archiveBuilder: buildProjectArchiveRow,
  prevRows,
  prevArchive: [],
  resolvedAt: "2026-06-30",
});

test("planTab preserve: keep-1 row carries preserved Notes and Status", () => {
  // out.values[0] is the header, out.values[1] is keep-1
  assert.equal(out.values.length, 2, "expected header + 1 data row");
  const keepRow = out.values[1];
  assert.equal(keepRow[PROJECT_COLS.notes], "check rera", "Notes should be preserved");
  assert.equal(keepRow[PROJECT_COLS.status], "Updated", "Status should be preserved");
  assert.equal(keepRow[PROJECT_COLS.key], "keep-1", "Project ID should be keep-1");
});

test("planTab archive: gone-1 is archived with preserved Notes/Status and resolvedAt", () => {
  assert.equal(out.archiveToAppend.length, 1, "exactly 1 row archived");
  const archiveRow = out.archiveToAppend[0];
  assert.equal(archiveRow[PROJECT_ARCHIVE_KEY], "gone-1", "archive key should be gone-1");
  // PROJECT_ARCHIVE_HEADERS: Project, Created At, Creator, Link, Missing Data
  // Summary, Notes / Comments (5), Status (6), Project ID (7), Resolved At (8)
  assert.equal(archiveRow[5], "to delete", "archived Notes should be preserved");
  assert.equal(archiveRow[6], "Should be Deleted", "archived Status should be preserved");
  assert.equal(archiveRow[archiveRow.length - 1], "2026-06-30", "last cell should be resolvedAt stamp");
});

test("planTab dedupe: re-running with gone-1 already in prevArchive yields no new archive rows", () => {
  const out2 = planTab({
    records,
    headers: PROJECT_SHEET_HEADERS,
    cols: PROJECT_COLS,
    rowBuilder: buildProjectRow,
    idField: "project_id",
    archiveHeaders: PROJECT_ARCHIVE_HEADERS,
    archiveKey: PROJECT_ARCHIVE_KEY,
    archiveBuilder: buildProjectArchiveRow,
    prevRows,
    prevArchive: [PROJECT_ARCHIVE_HEADERS, out.archiveToAppend[0]],
    resolvedAt: "2026-06-30",
  });
  assert.equal(out2.archiveToAppend.length, 0, "already-archived row should not be re-added");
});
