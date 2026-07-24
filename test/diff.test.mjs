// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { sameCell, diffTab } from "../preview-sync.mjs";

// The sheet returns FORMATTED_VALUE, so cells come back as display text while a
// freshly built row holds raw numbers and ISO dates. sameCell has to see past
// that, or every dated row reports a change on every run.

test("sameCell treats identical text as equal", () => {
  assert.equal(sameCell("Present", "Present"), true);
  assert.equal(sameCell("Present", "Missing"), false);
});

test("sameCell compares numbers by value, not by string", () => {
  assert.equal(sameCell("3", 3), true);
  assert.equal(sameCell("0", 0), true);
  assert.equal(sameCell("3.0", 3), true);
  assert.equal(sameCell("3", 4), false);
});

test("sameCell sees through the sheet's date formatting", () => {
  assert.equal(sameCell("Jul 18, 2026", "2026-07-18"), true);
  assert.equal(sameCell("May 5, 2026", "2026-05-05"), true);
  assert.equal(sameCell("1 January 2026", "2026-01-01"), true);
  // A genuinely different date must still register.
  assert.equal(sameCell("Jul 18, 2026", "2026-07-19"), false);
});

test("sameCell does not coerce ordinary text into a date", () => {
  assert.equal(sameCell("Tower 4", "Tower 5"), false);
  assert.equal(sameCell("Not updated", "Updated"), false);
});

test("sameCell treats blank and non-blank as different", () => {
  assert.equal(sameCell("", "Present"), false);
  assert.equal(sameCell(null, ""), true);
  assert.equal(sameCell(undefined, null), true);
});

// ── diffTab ─────────────────────────────────────────────────────────────────

const HEADERS = ["Name", "Created At", "Status Col", "ID"];
const DIFF_COLS = [0, 1, 2, 3];
const KEY = 3;

const base = {
  headers: HEADERS, keyIndex: KEY, diffCols: DIFF_COLS, nameIndex: 0,
};

test("diffTab reports rows present only in the new grid as added", () => {
  const r = diffTab({
    ...base,
    prevRows: [HEADERS, ["A", "2026-01-01", "Present", "id-a"]],
    nextValues: [HEADERS,
      ["A", "2026-01-01", "Present", "id-a"],
      ["B", "2026-02-02", "Missing", "id-b"],
    ],
  });
  assert.equal(r.added.length, 1);
  assert.equal(r.added[0][KEY], "id-b");
  assert.equal(r.removed.length, 0);
  assert.equal(r.changed.length, 0);
});

test("diffTab reports rows missing from the new grid as removed", () => {
  const r = diffTab({
    ...base,
    prevRows: [HEADERS,
      ["A", "2026-01-01", "Present", "id-a"],
      ["B", "2026-02-02", "Missing", "id-b"],
    ],
    nextValues: [HEADERS, ["A", "2026-01-01", "Present", "id-a"]],
  });
  assert.equal(r.removed.length, 1);
  assert.equal(r.removed[0][KEY], "id-b");
  assert.equal(r.added.length, 0);
});

test("diffTab names the columns whose values move", () => {
  const r = diffTab({
    ...base,
    prevRows: [HEADERS, ["A", "2026-01-01", "Missing", "id-a"]],
    nextValues: [HEADERS, ["A", "2026-01-01", "Present", "id-a"]],
  });
  assert.equal(r.changed.length, 1);
  assert.deepEqual(r.changed[0].cells, [
    { column: "Status Col", from: "Missing", to: "Present" },
  ]);
  assert.equal(r.changed[0].id, "id-a");
  assert.equal(r.changed[0].name, "A");
});

test("diffTab ignores date re-formatting", () => {
  const r = diffTab({
    ...base,
    prevRows: [HEADERS, ["A", "Jan 1, 2026", "Present", "id-a"]],
    nextValues: [HEADERS, ["A", "2026-01-01", "Present", "id-a"]],
  });
  assert.equal(r.changed.length, 0, "display formatting is not a change");
});

test("diffTab skips cell comparison when the column layout moved", () => {
  const r = diffTab({
    ...base,
    prevRows: [["Name", "Created At", "Old Header", "ID"],
      ["A", "2026-01-01", "Missing", "id-a"]],
    nextValues: [HEADERS, ["A", "2026-01-01", "Present", "id-a"]],
  });
  assert.equal(r.headerChanged, true);
  assert.equal(r.changed.length, 0, "positional diffing is meaningless once columns shift");
});

test("diffTab treats an empty tab as all-added without flagging the header", () => {
  const r = diffTab({
    ...base,
    prevRows: [],
    nextValues: [HEADERS, ["A", "2026-01-01", "Present", "id-a"]],
  });
  assert.equal(r.headerChanged, false);
  assert.equal(r.added.length, 1);
  assert.equal(r.removed.length, 0);
});

test("diffTab ignores rows with a blank id on either side", () => {
  const r = diffTab({
    ...base,
    prevRows: [HEADERS, ["stray", "", "", ""]],
    nextValues: [HEADERS, ["A", "2026-01-01", "Present", "id-a"], ["orphan", "", "", ""]],
  });
  assert.equal(r.added.length, 1);
  assert.equal(r.added[0][KEY], "id-a");
  assert.equal(r.removed.length, 0);
});
