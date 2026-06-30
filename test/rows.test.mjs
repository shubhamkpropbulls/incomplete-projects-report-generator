import { test } from "node:test";
import assert from "node:assert/strict";
import {
  buildProjectRow,
  buildPropertyRow,
  buildSheetValues,
  PROJECT_SHEET_HEADERS,
  PROJECT_COLS,
  PROPERTY_COLS,
} from "../sheet-data.mjs";

const proj = {
  project_id: "p1", project_name: "Acme Towers",
  created_at: "2026-03-01T05:19:19Z", creator_name: "Viinit",
  location_status: "Missing", builder_status: "Present", land_type_status: "Missing",
  land_acres_status: "Missing", rera_number_status: "Missing",
  rera_registration_status: "Missing", rera_completion_status: "Missing",
  accessibility_count: "4", property_count: "1",
  image_count: 0, attachment_count: 0, amenity_count: 0,
};

test("buildProjectRow has 21 cells with correct anchors", () => {
  const row = buildProjectRow(proj, 2, new Map());
  assert.equal(row.length, 21);
  assert.equal(row[0], "Acme Towers");
  assert.equal(row[1], "2026-03-01");          // created_at -> yyyy-mm-dd
  assert.equal(row[3], "Missing");             // location_status (D)
  assert.equal(row[10], 4);                     // accessibility_count numeric (K)
  assert.equal(row[15], "=IF(D2=\"Missing\",1,0)+IF(E2=\"Missing\",1,0)+IF(F2=\"Missing\",1,0)+IF(G2=\"Missing\",1,0)+IF(H2=\"Missing\",1,0)+IF(I2=\"Missing\",1,0)+IF(J2=\"Missing\",1,0)+IF(K2<3,1,0)+IF(L2<1,1,0)+IF(M2<1,1,0)+IF(N2<1,1,0)+IF(O2<1,1,0)");
  assert.ok(row[16].startsWith("=TEXTJOIN(CHAR(10),TRUE,")); // summary, no _xlfn.
  assert.ok(!row[16].includes("_xlfn"));
  assert.equal(row[17], '=HYPERLINK("https://admin-console.propbulls.in/projects/p1","Link")');
  assert.equal(row[PROJECT_COLS.key], "p1");
});

test("buildProjectRow defaults notes blank + status 'Not updated' for new ids", () => {
  const row = buildProjectRow(proj, 2, new Map());
  assert.equal(row[PROJECT_COLS.notes], "");
  assert.equal(row[PROJECT_COLS.status], "Not updated");
});

test("buildProjectRow carries preserved notes + status by id", () => {
  const preserve = new Map([["p1", { notes: "ping builder", status: "Updated" }]]);
  const row = buildProjectRow(proj, 2, preserve);
  assert.equal(row[PROJECT_COLS.notes], "ping builder");
  assert.equal(row[PROJECT_COLS.status], "Updated");
});

const prop = {
  property_id: "pr1", project_id: "p1", project_name: "Acme Towers",
  property_name: "Block A", created_at: "2026-06-09T13:10:14Z",
  creator_name: "Shreya", total_floors_status: "Missing",
  units_per_floor_status: "Missing", unit_config_status: "Missing",
};

test("buildPropertyRow has 15 cells, correct anchors + default status", () => {
  const row = buildPropertyRow(prop, 2, new Map());
  assert.equal(row.length, 15);
  assert.equal(row[0], "Acme Towers");
  assert.equal(row[1], '=HYPERLINK("https://admin-console.propbulls.in/projects/p1","Link")');
  assert.equal(row[3], '=HYPERLINK("https://admin-console.propbulls.in/properties/pr1","Link")');
  assert.equal(row[9], '=COUNTIF(G2:I2,"Missing")');
  assert.equal(row[PROPERTY_COLS.key], "pr1");
  assert.equal(row[14], "p1");
  assert.equal(row[PROPERTY_COLS.status], "Not Updated");
});

test("buildSheetValues prepends header and numbers rows from 2", () => {
  const values = buildSheetValues(PROJECT_SHEET_HEADERS, [proj, proj], buildProjectRow, new Map());
  assert.equal(values.length, 3);                 // header + 2
  assert.deepEqual(values[0], PROJECT_SHEET_HEADERS);
  assert.ok(values[2][15].includes("D3"));        // 2nd record uses row 3
});
