// @ts-check
// Pure helpers for the one-time old-data.xlsx -> Google Sheet migration.
// Kept IO-free so it can be unit tested (mirrors the sheet-data.mjs split).

// Old-file column indices (0-based) for the two authoritative tabs. The updated
// old-data.xlsx now carries direct UUID ID columns (mirrors the live sheet).
// `id` may hold a bare UUID or an admin-console URL — extractId handles both.
// Property tab has an extra "Base Price" column, so its ids sit one right of the
// live sheet's PROPERTY_COLS.
export const OLD_PROJECT = { id: 20, notes: 18, status: 19 };   // U, S, T
export const OLD_PROPERTY = { id: 14, notes: 12, status: 13 };  // O, M, N

// Allowed Status values per sheet (must match the live dropdowns exactly, or
// Google rejects the write). Note the casing differs between the two sheets.
export const PROJECT_STATUSES = new Set(["Not updated", "Updated", "Should be Deleted", "Unavailable", "Pre-Rera"]);
export const PROPERTY_STATUSES = new Set(["Not Updated", "Updated", "Should be Deleted", "Unavailable", "Pre-Rera"]);

const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** Extract the UUID from an admin-console URL. @returns {string|null} */
export function extractId(url) {
  const m = String(url ?? "").match(UUID);
  return m ? m[0].toLowerCase() : null;
}

/** A note worth migrating: non-empty text. @returns {boolean} */
export function isRealNote(v) {
  return String(v ?? "").trim() !== "";
}

function buildMap(rows, cols, statusSet) {
  const map = new Map();
  for (let i = 1; i < rows.length; i++) {
    const row = rows[i] ?? [];
    const id = extractId(row[cols.id]);
    if (!id) continue;
    const entry = {};
    const note = String(row[cols.notes] ?? "").trim();
    if (isRealNote(note)) entry.notes = note;
    const status = String(row[cols.status] ?? "").trim();
    if (statusSet.has(status)) entry.status = status;
    if (entry.notes !== undefined || entry.status !== undefined) map.set(id, entry);
  }
  return map;
}

/** @returns {Map<string,{notes?:string,status?:string}>} keyed by project_id */
export function buildProjectMap(rows) {
  return buildMap(rows, OLD_PROJECT, PROJECT_STATUSES);
}

/** @returns {Map<string,{notes?:string,status?:string}>} keyed by property_id */
export function buildPropertyMap(rows) {
  return buildMap(rows, OLD_PROPERTY, PROPERTY_STATUSES);
}

/**
 * Match live-sheet rows against the member map by their ID column and produce
 * the cell updates to apply. Overwrite semantics: the member value wins.
 * @param {string[][]} liveRows current sheet rows (row 0 = header)
 * @param {{key:number,notes:number,status:number}} cols live-sheet column indices
 * @param {Map<string,{notes?:string,status?:string}>} memberMap
 * @returns {{updates:{rowIndex:number,notes?:string,status?:string}[],matched:number,unmatched:number}}
 *   rowIndex is the 0-based array index into liveRows (header is 0, so the A1
 *   row number is rowIndex + 1).
 */
export function computeUpdates(liveRows, cols, memberMap) {
  const updates = [];
  const seen = new Set();
  for (let i = 1; i < liveRows.length; i++) {
    const row = liveRows[i] ?? [];
    const id = String(row[cols.key] ?? "").trim().toLowerCase();
    if (!id) continue;
    const entry = memberMap.get(id);
    if (!entry) continue;
    seen.add(id);
    const u = { rowIndex: i };
    if (entry.notes !== undefined) u.notes = entry.notes;
    if (entry.status !== undefined) u.status = entry.status;
    if (u.notes !== undefined || u.status !== undefined) updates.push(u);
  }
  return { updates, matched: seen.size, unmatched: memberMap.size - seen.size };
}
