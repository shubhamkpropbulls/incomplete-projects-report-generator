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

function toDateStr(v) {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return "";
  return d.toISOString().slice(0, 10);
}

function projectCountFormula(r) {
  return `=IF(D${r}="Missing",1,0)+IF(E${r}="Missing",1,0)+IF(F${r}="Missing",1,0)`
    + `+IF(G${r}="Missing",1,0)+IF(H${r}="Missing",1,0)+IF(I${r}="Missing",1,0)`
    + `+IF(J${r}="Missing",1,0)+IF(K${r}<3,1,0)+IF(L${r}<1,1,0)+IF(M${r}<1,1,0)`
    + `+IF(N${r}<1,1,0)+IF(O${r}<1,1,0)`;
}

function projectSummaryFormula(r) {
  return `=TEXTJOIN(CHAR(10),TRUE,`
    + `IF(D${r}="Missing","Missing location coordinates or full address",""),`
    + `IF(E${r}="Missing","Missing builder",""),`
    + `IF(F${r}="Missing","Missing land type",""),`
    + `IF(G${r}="Missing","Missing land acres",""),`
    + `IF(H${r}="Missing","Missing RERA number",""),`
    + `IF(I${r}="Missing","Missing RERA registration date",""),`
    + `IF(J${r}="Missing","Missing RERA completion date",""),`
    + `IF(K${r}<3,"Nearby accessibility: "&K${r}&" of 3 required",""),`
    + `IF(L${r}<1,"No properties added",""),`
    + `IF(M${r}<1,"No images",""),`
    + `IF(N${r}<1,"No attachments",""),`
    + `IF(O${r}<1,"No amenities",""))`;
}

function propertySummaryFormula(r) {
  return `=TEXTJOIN(CHAR(10),TRUE,`
    + `IF(G${r}="Missing","Missing total floors",""),`
    + `IF(H${r}="Missing","Missing units per floor",""),`
    + `IF(I${r}="Missing","No unit configurations",""))`;
}

const num = (v) => (v == null || v === "" ? 0 : Number(v));

export function buildProjectRow(rec, r, preserve) {
  const saved = preserve.get(cell(rec.project_id)) || {};
  return [
    cell(rec.project_name),
    toDateStr(rec.created_at),
    cell(rec.creator_name),
    rec.location_status,
    rec.builder_status,
    rec.land_type_status,
    rec.land_acres_status,
    rec.rera_number_status,
    rec.rera_registration_status,
    rec.rera_completion_status,
    num(rec.accessibility_count),
    num(rec.property_count),
    num(rec.image_count),
    num(rec.attachment_count),
    num(rec.amenity_count),
    projectCountFormula(r),
    projectSummaryFormula(r),
    `=HYPERLINK("${ADMIN_BASE}/projects/${rec.project_id}","Link")`,
    saved.notes ?? "",
    saved.status || "Not updated",
    cell(rec.project_id),
  ];
}

export function buildPropertyRow(rec, r, preserve) {
  const saved = preserve.get(cell(rec.property_id)) || {};
  return [
    cell(rec.project_name),
    `=HYPERLINK("${ADMIN_BASE}/projects/${rec.project_id}","Link")`,
    cell(rec.property_name),
    `=HYPERLINK("${ADMIN_BASE}/properties/${rec.property_id}","Link")`,
    toDateStr(rec.created_at),
    cell(rec.creator_name),
    rec.total_floors_status,
    rec.units_per_floor_status,
    rec.unit_config_status,
    `=COUNTIF(G${r}:I${r},"Missing")`,
    propertySummaryFormula(r),
    saved.notes ?? "",
    saved.status || "Not Updated",
    cell(rec.property_id),
    cell(rec.project_id),
  ];
}

export function buildSheetValues(headers, records, rowBuilder, preserve) {
  return [headers, ...records.map((rec, i) => rowBuilder(rec, i + 2, preserve))];
}

// Archive rows keep enough context to understand a resolved item on their own:
// name, created-at, creator, a working Link (rebuilt from the ID so it stays
// clickable), the missing-data summary, and the team's notes/status.
export const PROJECT_ARCHIVE_HEADERS = [
  "Project", "Created At", "Creator", "Link", "Missing Data Summary",
  "Notes / Comments", "Status", "Project ID", "Resolved At",
];
export const PROPERTY_ARCHIVE_HEADERS = [
  "Project Name", "Project Link", "Property Name", "Link", "Created At",
  "Created By", "Missing Data Summery", "Note / Comments", "Status",
  "Property ID", "Project ID", "Resolved At",
];
export const PROJECT_ARCHIVE_KEY = 7;   // Project ID column in archive layout
export const PROPERTY_ARCHIVE_KEY = 9;  // Property ID column in archive layout

const projectLink = (id) => (id ? `=HYPERLINK("${ADMIN_BASE}/projects/${id}","Link")` : "");
const propertyLink = (id) => (id ? `=HYPERLINK("${ADMIN_BASE}/properties/${id}","Link")` : "");

export function buildProjectArchiveRow(prevRow, resolvedAt) {
  const projectId = cell(prevRow[20]);
  return [
    cell(prevRow[0]),        // Project
    cell(prevRow[1]),        // Created At
    cell(prevRow[2]),        // Creator
    projectLink(projectId),  // Link (rebuilt so it stays clickable)
    cell(prevRow[16]),       // Missing Data Summary
    cell(prevRow[18]),       // Notes / Comments
    cell(prevRow[19]),       // Status
    projectId,               // Project ID
    resolvedAt,
  ];
}

export function buildPropertyArchiveRow(prevRow, resolvedAt) {
  const propertyId = cell(prevRow[13]);
  const projectId = cell(prevRow[14]);
  return [
    cell(prevRow[0]),          // Project Name
    projectLink(projectId),    // Project Link
    cell(prevRow[2]),          // Property Name
    propertyLink(propertyId),  // Link
    cell(prevRow[4]),          // Created At
    cell(prevRow[5]),          // Created By
    cell(prevRow[10]),         // Missing Data Summery
    cell(prevRow[11]),         // Note / Comments
    cell(prevRow[12]),         // Status
    propertyId,                // Property ID
    projectId,                 // Project ID
    resolvedAt,
  ];
}

export function dedupeArchiveRows(existingRows, newRows, keyIndex) {
  const seen = new Set();
  for (let i = 1; i < existingRows.length; i++) {
    const id = cell((existingRows[i] ?? [])[keyIndex]).trim();
    if (id) seen.add(id);
  }
  return newRows.filter((r) => {
    const id = cell(r[keyIndex]).trim();
    return id && !seen.has(id);
  });
}

/** Pure planning function: turns DB records + previous tab state into sheet values + archive rows. */
export function planTab({ records, headers, cols, rowBuilder, idField, archiveHeaders, archiveKey, archiveBuilder, prevRows, prevArchive, resolvedAt }) {
  const preserve = buildPreserveMap(prevRows, cols);
  const currentIds = new Set(records.map((r) => r[idField]?.toString().trim()).filter(Boolean));
  const values = buildSheetValues(headers, records, rowBuilder, preserve);

  const resolvedPrevRows = selectResolvedRows(prevRows, currentIds, cols.key);
  const newArchiveRows = resolvedPrevRows.map((row) => archiveBuilder(row, resolvedAt));
  const archiveToAppend = dedupeArchiveRows(
    prevArchive.length ? prevArchive : [archiveHeaders],
    newArchiveRows,
    archiveKey,
  );
  return { values, archiveToAppend };
}
