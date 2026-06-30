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
