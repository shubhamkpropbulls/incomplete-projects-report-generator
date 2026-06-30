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
