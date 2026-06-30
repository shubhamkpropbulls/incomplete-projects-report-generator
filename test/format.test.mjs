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
