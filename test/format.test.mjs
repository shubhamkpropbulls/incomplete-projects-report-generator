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

// Whole-row highlight when Status = "Should be Deleted" (dark red, white text),
// matching the original xlsx report's conditional formatting.
function deleteRowRule(reqs) {
  return reqs
    .map((r) => r.addConditionalFormatRule?.rule)
    .find((rule) => rule?.booleanRule?.condition?.type === "CUSTOM_FORMULA"
      && rule.booleanRule.condition.values?.[0]?.userEnteredValue?.includes("Should be Deleted"));
}

test("projectFormatRequests highlights whole row when Status is 'Should be Deleted'", () => {
  const rule = deleteRowRule(projectFormatRequests(7, 0));
  assert.ok(rule, "expected a CUSTOM_FORMULA rule for Should be Deleted");
  // formula anchors the Status column (T) absolutely, row relative
  assert.equal(rule.booleanRule.condition.values[0].userEnteredValue, '=$T2="Should be Deleted"');
  // spans the whole row A..U (0..21)
  assert.equal(rule.ranges[0].startColumnIndex, 0);
  assert.equal(rule.ranges[0].endColumnIndex, 21);
  // dark red fill + white text
  assert.deepEqual(rule.booleanRule.format.backgroundColor, { red: 0.8, green: 0, blue: 0 });
  assert.deepEqual(rule.booleanRule.format.textFormat.foregroundColor, { red: 1, green: 1, blue: 1 });
});

test("propertyFormatRequests highlights whole row when Status is 'Should be Deleted'", () => {
  const rule = deleteRowRule(propertyFormatRequests(9, 0));
  assert.ok(rule, "expected a CUSTOM_FORMULA rule for Should be Deleted");
  assert.equal(rule.booleanRule.condition.values[0].userEnteredValue, '=$M2="Should be Deleted"');
  assert.equal(rule.ranges[0].startColumnIndex, 0);
  assert.equal(rule.ranges[0].endColumnIndex, 15);
});
