// @ts-check
// Pure builders for Google Sheets spreadsheets.batchUpdate request objects.
// No I/O. Column indices are 0-based half-open ranges; startRowIndex 1 = skip header.

const RED = { red: 0.96, green: 0.80, blue: 0.80 };
const GREEN = { red: 0.85, green: 0.92, blue: 0.83 };
// Whole-row highlight for Status = "Should be Deleted": dark red fill, white text.
const DELETE_ROW_FORMAT = {
  backgroundColor: { red: 0.8, green: 0, blue: 0 },
  textFormat: { foregroundColor: { red: 1, green: 1, blue: 1 } },
};

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

// Whole-row conditional format driven by a custom formula. The formula anchors
// the status column absolutely and the row relatively to the range's first row.
function cfCustomFormula(sheetId, c0, c1, formula, format) {
  return {
    addConditionalFormatRule: {
      index: 0,
      rule: {
        ranges: [range(sheetId, c0, c1)],
        booleanRule: {
          condition: { type: "CUSTOM_FORMULA", values: [{ userEnteredValue: formula }] },
          format,
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
    dropdown(sheetId, 19, 20, ["Not updated", "Updated", "Should be Deleted", "Unavailable", "Pre-Rera"]),
    // Missing/Present dropdowns (cols D..J = indices 3..10)
    dropdown(sheetId, 3, 10, ["Missing", "Present"]),
    // D..J: Missing red / Present green
    cfTextEq(sheetId, 3, 10, "Missing", RED),
    cfTextEq(sheetId, 3, 10, "Present", GREEN),
    // K (index 10): <2 red, >=2 green
    cfNumberLess(sheetId, 10, 11, 2, RED),
    cfNumberGte(sheetId, 10, 11, 2, GREEN),
    // L..O (indices 11..15): <1 red, >=1 green
    cfNumberLess(sheetId, 11, 15, 1, RED),
    cfNumberGte(sheetId, 11, 15, 1, GREEN),
    // Whole row A..U dark red when Status (col T) = "Should be Deleted".
    // Added last so it takes top priority over the cell-level rules.
    cfCustomFormula(sheetId, 0, 21, '=$T2="Should be Deleted"', DELETE_ROW_FORMAT),
  ];
}

export function propertyFormatRequests(sheetId, existingCfCount) {
  return [
    ...deleteCfRequests(sheetId, existingCfCount),
    freezeHeader(sheetId),
    // Status workflow dropdown (col M = index 12)
    dropdown(sheetId, 12, 13, ["Not Updated", "Updated", "Should be Deleted", "Unavailable", "Pre-Rera"]),
    // Missing/Present dropdowns (cols G..I = indices 6..9)
    dropdown(sheetId, 6, 9, ["Missing", "Present"]),
    cfTextEq(sheetId, 6, 9, "Missing", RED),
    cfTextEq(sheetId, 6, 9, "Present", GREEN),
    // Whole row A..O dark red when Status (col M) = "Should be Deleted".
    cfCustomFormula(sheetId, 0, 15, '=$M2="Should be Deleted"', DELETE_ROW_FORMAT),
  ];
}
