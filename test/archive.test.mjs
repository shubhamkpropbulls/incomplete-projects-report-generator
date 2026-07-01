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

test("buildProjectArchiveRow keeps full context incl. rebuilt link", () => {
  // project active layout: 0=Project, 1=Created At, 2=Creator, 16=Summary,
  // 18=Notes, 19=Status, 20=Project ID
  const prev = mkRow(21, {
    0: "Acme", 1: "2026-01-15", 2: "Viinit", 16: "No images", 18: "fixed rera",
    19: "Updated", 20: "p1",
  });
  const row = buildProjectArchiveRow(prev, "2026-06-30");
  assert.equal(row.length, PROJECT_ARCHIVE_HEADERS.length);
  assert.deepEqual(row, [
    "Acme", "2026-01-15", "Viinit",
    '=HYPERLINK("https://admin-console.propbulls.in/projects/p1","Link")',
    "No images", "fixed rera", "Updated", "p1", "2026-06-30",
  ]);
  assert.equal(row[PROJECT_ARCHIVE_KEY], "p1");
});

test("buildPropertyArchiveRow keeps full context incl. both links", () => {
  // property active layout: 0=Project Name, 2=Property Name, 4=Created At,
  // 5=Created By, 10=Summary, 11=Notes, 12=Status, 13=Property ID, 14=Project ID
  const prev = mkRow(15, {
    0: "Acme", 2: "Block A", 4: "2026-02-01", 5: "Shreya", 10: "No unit configurations",
    11: "done", 12: "Updated", 13: "pr1", 14: "p1",
  });
  const row = buildPropertyArchiveRow(prev, "2026-06-30");
  assert.equal(row.length, PROPERTY_ARCHIVE_HEADERS.length);
  assert.deepEqual(row, [
    "Acme",
    '=HYPERLINK("https://admin-console.propbulls.in/projects/p1","Link")',
    "Block A",
    '=HYPERLINK("https://admin-console.propbulls.in/properties/pr1","Link")',
    "2026-02-01", "Shreya", "No unit configurations", "done", "Updated",
    "pr1", "p1", "2026-06-30",
  ]);
  assert.equal(row[PROPERTY_ARCHIVE_KEY], "pr1");
  assert.equal(row[10], "p1"); // Project ID column
});

test("dedupeArchiveRows drops rows whose key already exists in the archive", () => {
  const mk = (id) => { const a = Array(PROJECT_ARCHIVE_HEADERS.length).fill("x"); a[PROJECT_ARCHIVE_KEY] = id; return a; };
  const existing = [PROJECT_ARCHIVE_HEADERS, mk("p1")];
  const incoming = [mk("p1"), mk("p2")]; // p1 dup -> dropped, p2 new -> kept
  const out = dedupeArchiveRows(existing, incoming, PROJECT_ARCHIVE_KEY);
  assert.equal(out.length, 1);
  assert.equal(out[0][PROJECT_ARCHIVE_KEY], "p2");
});
