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
