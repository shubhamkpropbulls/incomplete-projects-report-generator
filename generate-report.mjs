// @ts-check
/**
 * Incomplete Data Report generator.
 *
 * Reads DATABASE_URL from env, finds projects + properties that are missing
 * required data, and writes an .xlsx that is visually identical to the
 * hand-made "Incomplete Units Propbulls" report (same fonts, borders,
 * conditional-format color coding, table styling and formulas).
 *
 * Strategy: template surgery. We load template.xlsx (a copy of the original
 * report) and rewrite the per-sheet content (rows, conditional formatting,
 * data-validation dropdowns, column widths, the table column list). We never
 * touch styles.xml, so all fonts/fills/borders/dxf colors and the custom table
 * styles are preserved exactly; the conditional-format rules only reference
 * dxf IDs that already live in styles.xml.
 *
 * Differences from the original report, per request:
 *   - Only the two data sheets are kept (hidden helper sheets removed).
 *   - The hidden helper columns are removed entirely.
 *   - Visible ID columns are appended so rows can be joined later:
 *       Project sheet  -> "Project ID"
 *       Property sheet -> "Property ID" + "Project ID"
 *
 * Usage:
 *   DATABASE_URL=postgres://... node generate-report.mjs [output.xlsx]
 *   MOCK=1 node generate-report.mjs out.xlsx     # sample data, no DB
 */

import { readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import JSZip from "jszip";
import { fetchData, ADMIN_BASE } from "./db.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

// ─────────────────────────────────────────────────────────────────────────────
// XML / cell helpers
// ─────────────────────────────────────────────────────────────────────────────

const xe = (s) =>
  String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const ef = xe;

function colLetter(n) {
  let s = "";
  while (n > 0) {
    const m = (n - 1) % 26;
    s = String.fromCharCode(65 + m) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

/** JS Date -> Excel serial date (days since 1899-12-30, with time fraction). */
function excelSerial(d) {
  return (d.getTime() - Date.UTC(1899, 11, 30)) / 86400000;
}

function cellFns(row) {
  const ref = (col) => `${colLetter(col)}${row}`;
  return {
    txt: (col, s, v) =>
      v == null || v === ""
        ? `<c r="${ref(col)}" s="${s}"/>`
        : `<c r="${ref(col)}" s="${s}" t="inlineStr"><is><t xml:space="preserve">${xe(v)}</t></is></c>`,
    num: (col, s, v) =>
      v == null || v === ""
        ? `<c r="${ref(col)}" s="${s}"/>`
        : `<c r="${ref(col)}" s="${s}"><v>${Number(v)}</v></c>`,
    date: (col, s, v) =>
      v == null
        ? `<c r="${ref(col)}" s="${s}"/>`
        : `<c r="${ref(col)}" s="${s}"><v>${excelSerial(new Date(v))}</v></c>`,
    fNum: (col, s, f) => `<c r="${ref(col)}" s="${s}"><f>${ef(f)}</f></c>`,
    fStr: (col, s, f) => `<c r="${ref(col)}" s="${s}" t="str"><f>${ef(f)}</f></c>`,
    empty: (col, s) => `<c r="${ref(col)}" s="${s}"/>`,
  };
}

function headerRow(cols) {
  const cells = cols
    .map(
      ([text, s], i) =>
        `<c r="${colLetter(i + 1)}1" s="${s}" t="inlineStr"><is><t xml:space="preserve">${xe(text)}</t></is></c>`,
    )
    .join("");
  return `<row r="1" spans="1:${cols.length}" ht="15.75" customHeight="1">${cells}</row>`;
}

/** Build a <cols> block from [widthChars] per column. */
function colsBlock(widths) {
  const cols = widths
    .map((w, i) => `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`)
    .join("");
  return `<cols>${cols}</cols>`;
}

function tableColumns(names) {
  return (
    `<tableColumns count="${names.length}">` +
    names.map((n, i) => `<tableColumn id="${i + 1}" name="${xe(n)}"/>`).join("") +
    `</tableColumns>`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Project sheet — 21 columns (A..U). Helper raw-URL column removed; Project ID
// appended. Status/count columns keep their letters, so the formulas that
// reference D..O are unchanged from the original report.
// ─────────────────────────────────────────────────────────────────────────────

const PROJECT_HEADERS = [
  ["Project", 1], ["Created At", 1], ["Creator", 1],
  ["Full Address and Geo Location", 1], ["Builder", 1], ["Land Type", 1],
  ["Land Acres", 1], ["Rera Number", 1], ["Rera Registration ", 1],
  ["Rera Possession", 1], ["Nearby Transit (Min 2)", 1], ["Properties", 1],
  ["Images (Min 1)", 1], ["Attachements (Min 1) (Floor Plan, Brochure, etc)", 1],
  ["Amenities (Min 1)", 1], ["Missing Data Count", 1], ["Missing Data Summary", 2],
  ["Link", 1], ["Notes / Comments", 3], ["Status", 3], ["Project ID", 1],
];
const PROJECT_WIDTHS = [
  33, 18, 16, 27, 18, 20, 21, 22, 28, 26, 23, 18, 16, 38, 17, 19, 45, 14, 27, 20, 40,
];
const PROJECT_TABLE_COLS = PROJECT_HEADERS.map(([n]) => n);

function projectCountFormula(r) {
  return (
    `IF(D${r}="Missing",1,0)+IF(E${r}="Missing",1,0)+IF(F${r}="Missing",1,0)` +
    `+IF(G${r}="Missing",1,0)+IF(H${r}="Missing",1,0)+IF(I${r}="Missing",1,0)` +
    `+IF(J${r}="Missing",1,0)+IF(K${r}<2,1,0)+IF(L${r}<1,1,0)+IF(M${r}<1,1,0)` +
    `+IF(N${r}<1,1,0)+IF(O${r}<1,1,0)`
  );
}

function projectSummaryFormula(r) {
  return (
    `_xlfn.TEXTJOIN(CHAR(10),TRUE,` +
    `IF(D${r}="Missing","Missing location coordinates or full address",""),` +
    `IF(E${r}="Missing","Missing builder",""),` +
    `IF(F${r}="Missing","Missing land type",""),` +
    `IF(G${r}="Missing","Missing land acres",""),` +
    `IF(H${r}="Missing","Missing RERA number",""),` +
    `IF(I${r}="Missing","Missing RERA registration date",""),` +
    `IF(J${r}="Missing","Missing RERA completion date",""),` +
    `IF(K${r}<2,"Nearby transit: "&K${r}&" of 2 required (metro + train)",""),` +
    `IF(L${r}<1,"No properties added",""),` +
    `IF(M${r}<1,"No images",""),` +
    `IF(N${r}<1,"No attachments",""),` +
    `IF(O${r}<1,"No amenities",""))`
  );
}

function projectRow(r, rec) {
  const c = cellFns(r);
  return (
    `<row r="${r}" spans="1:21">` +
    c.txt(1, 5, rec.project_name) +
    c.date(2, 6, rec.created_at) +
    c.txt(3, 5, rec.creator_name) +
    c.txt(4, 5, rec.location_status) +
    c.txt(5, 5, rec.builder_status) +
    c.txt(6, 5, rec.land_type_status) +
    c.txt(7, 5, rec.land_acres_status) +
    c.txt(8, 5, rec.rera_number_status) +
    c.txt(9, 5, rec.rera_registration_status) +
    c.txt(10, 5, rec.rera_completion_status) +
    c.num(11, 5, rec.accessibility_count) +
    c.num(12, 5, rec.property_count) +
    c.num(13, 5, rec.image_count) +
    c.num(14, 5, rec.attachment_count) +
    c.num(15, 5, rec.amenity_count) +
    c.fNum(16, 5, projectCountFormula(r)) +
    c.fStr(17, 8, projectSummaryFormula(r)) +
    c.fStr(18, 9, `HYPERLINK("${ADMIN_BASE}/projects/${rec.project_id}","Link")`) +
    c.empty(19, 10) + // Notes / Comments (blank for the team)
    c.txt(20, 11, "Not updated") +
    c.txt(21, 5, rec.project_id) +
    `</row>`
  );
}

/** Conditional formatting for the project sheet (last data row = L). */
function projectCF(L) {
  return (
    `<conditionalFormatting sqref="A2:U${L}"><cfRule type="expression" dxfId="17" priority="1"><formula>$T2="Should be Deleted"</formula></cfRule></conditionalFormatting>` +
    `<conditionalFormatting sqref="D2:J${L}"><cfRule type="cellIs" dxfId="16" priority="6" operator="equal"><formula>"Missing"</formula></cfRule><cfRule type="cellIs" dxfId="15" priority="7" operator="equal"><formula>"Present"</formula></cfRule></conditionalFormatting>` +
    `<conditionalFormatting sqref="K2:K${L}"><cfRule type="cellIs" dxfId="14" priority="4" operator="lessThan"><formula>2</formula></cfRule><cfRule type="cellIs" dxfId="13" priority="5" operator="greaterThanOrEqual"><formula>2</formula></cfRule><cfRule type="containsBlanks" dxfId="12" priority="8"><formula>LEN(TRIM(K2))=0</formula></cfRule></conditionalFormatting>` +
    `<conditionalFormatting sqref="L2:O${L}"><cfRule type="cellIs" dxfId="11" priority="2" operator="lessThan"><formula>1</formula></cfRule><cfRule type="cellIs" dxfId="10" priority="3" operator="greaterThanOrEqual"><formula>1</formula></cfRule><cfRule type="containsBlanks" dxfId="9" priority="9"><formula>LEN(TRIM(L2))=0</formula></cfRule></conditionalFormatting>`
  );
}

function projectDV(L) {
  return (
    `<dataValidations count="3">` +
    `<dataValidation type="list" allowBlank="1" sqref="T2:T${L}"><formula1>"Not updated,Updated,Should be Deleted"</formula1></dataValidation>` +
    `<dataValidation type="list" allowBlank="1" sqref="D2:J${L}"><formula1>"Missing,Present"</formula1></dataValidation>` +
    `<dataValidation type="custom" allowBlank="1" showDropDown="1" sqref="B2:B${L}"><formula1>OR(NOT(ISERROR(DATEVALUE(B2))), AND(ISNUMBER(B2), LEFT(CELL("format", B2))="D"))</formula1></dataValidation>` +
    `</dataValidations>`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Property sheet — 15 columns (A..O). All hidden helper columns removed; the
// three status columns are now contiguous (G..I). Property ID + Project ID
// appended.
// ─────────────────────────────────────────────────────────────────────────────

const PROPERTY_HEADERS = [
  ["Project Name", 1], ["Project Link", 1], ["Property Name", 1], ["Link", 13],
  ["Created At", 14], ["Created By", 1], ["Total Floor ", 1],
  ["Units per floor ", 1], ["Unit configurations", 1], ["Missing Count", 1],
  ["Missing Data Summery", 2], ["Note / Comments", 15], ["Status", 13],
  ["Property ID", 1], ["Project ID", 1],
];
const PROPERTY_WIDTHS = [
  31, 13, 36, 13, 18, 18, 16, 18, 19, 16, 67, 35, 18, 40, 40,
];
const PROPERTY_TABLE_COLS = PROPERTY_HEADERS.map(([n]) => n);

function propertySummaryFormula(r) {
  return (
    `_xlfn.TEXTJOIN(CHAR(10), TRUE, ` +
    `IF(G${r}="Missing", "Missing total floors", ""), ` +
    `IF(H${r}="Missing", "Missing units per floor", ""), ` +
    `IF(I${r}="Missing", "No unit configurations", ""))`
  );
}

function propertyRow(r, rec) {
  const c = cellFns(r);
  return (
    `<row r="${r}" spans="1:15">` +
    c.txt(1, 5, rec.project_name) +
    c.fStr(2, 9, `HYPERLINK("${ADMIN_BASE}/projects/${rec.project_id}","Link")`) +
    c.txt(3, 5, rec.property_name) +
    c.fStr(4, 9, `HYPERLINK("${ADMIN_BASE}/properties/${rec.property_id}","Link")`) +
    c.date(5, 17, rec.created_at) +
    c.txt(6, 5, rec.creator_name) +
    c.txt(7, 5, rec.total_floors_status) +
    c.txt(8, 5, rec.units_per_floor_status) +
    c.txt(9, 5, rec.unit_config_status) +
    c.fNum(10, 5, `COUNTIF(G${r}:I${r},"Missing")`) +
    c.fStr(11, 8, propertySummaryFormula(r)) +
    c.empty(12, 18) + // Note / Comments (blank for the team)
    c.txt(13, 11, "Not Updated") +
    c.txt(14, 5, rec.property_id) +
    c.txt(15, 5, rec.project_id) +
    `</row>`
  );
}

function propertyCF(L) {
  return (
    `<conditionalFormatting sqref="A2:O${L}"><cfRule type="expression" dxfId="8" priority="3"><formula>$M2="Should be Deleted"</formula></cfRule></conditionalFormatting>` +
    `<conditionalFormatting sqref="G2:I${L}"><cfRule type="cellIs" dxfId="7" priority="1" operator="equal"><formula>"Missing"</formula></cfRule><cfRule type="cellIs" dxfId="6" priority="2" operator="equal"><formula>"Present"</formula></cfRule></conditionalFormatting>`
  );
}

function propertyDV(L) {
  return (
    `<dataValidations count="3">` +
    `<dataValidation type="list" allowBlank="1" sqref="G2:I${L}"><formula1>"Missing,Present"</formula1></dataValidation>` +
    `<dataValidation type="custom" allowBlank="1" showDropDown="1" sqref="E2:E${L}"><formula1>OR(NOT(ISERROR(DATEVALUE(E2))), AND(ISNUMBER(E2), LEFT(CELL("format", E2))="D"))</formula1></dataValidation>` +
    `<dataValidation type="list" allowBlank="1" sqref="M2:M${L}"><formula1>"Not Updated,Updated,Should be Deleted"</formula1></dataValidation>` +
    `</dataValidations>`
  );
}

// ─────────────────────────────────────────────────────────────────────────────
// Workbook transforms
// ─────────────────────────────────────────────────────────────────────────────

function buildSheetData(headers, rows, rowFn) {
  const body = rows.map((rec, i) => rowFn(i + 2, rec)).join("");
  return `<sheetData>${headerRow(headers)}${body}</sheetData>`;
}

const reSheetData = /<sheetData>[\s\S]*?<\/sheetData>/;
const reCols = /<cols>[\s\S]*?<\/cols>/;
const reCustomSheetViews = /<customSheetViews>[\s\S]*?<\/customSheetViews>/;
const reCF = /<conditionalFormatting[\s\S]*<\/conditionalFormatting>/; // greedy: first..last block
const reDV = /<dataValidations[\s\S]*?<\/dataValidations>/;
const reTableCols = /<tableColumns count="\d+">[\s\S]*?<\/tableColumns>/;

function rewriteSheet(xml, { sheetData, cols, lastCol, lastRow, cf, dv }) {
  xml = xml.replace(reSheetData, sheetData);
  xml = xml.replace(/<dimension ref="[^"]*"\/>/, `<dimension ref="A1:${lastCol}${lastRow}"/>`);
  xml = xml.replace(reCols, cols);
  xml = xml.replace(reCustomSheetViews, ""); // drop stale per-user saved filters
  xml = xml.replace(reCF, cf);
  xml = xml.replace(reDV, dv);
  return xml;
}

function rewriteTable(xml, { ref, columns }) {
  xml = xml.replace(/ref="A1:[^"]*"/g, `ref="${ref}"`); // table ref + autoFilter ref
  xml = xml.replace(reTableCols, tableColumns(columns));
  return xml;
}

async function main() {
  const outArg = process.argv[2];
  const stamp = new Date().toISOString().slice(0, 10);
  const outPath = outArg || join(process.cwd(), `Incomplete Data Propbulls ${stamp}.xlsx`);

  const { projects, properties } = await fetchData();
  console.log(`Found ${projects.length} incomplete project(s), ${properties.length} incomplete property(ies).`);

  const zip = await JSZip.loadAsync(await readFile(join(__dirname, "template.xlsx")));

  const projRows = 1 + projects.length;
  const propRows = 1 + properties.length;
  const projCfLast = Math.max(projRows, 2); // keep ranges valid even with 0 rows
  const propCfLast = Math.max(propRows, 2);

  // Sheet 1 — Missing Project Data.
  let s1 = await zip.file("xl/worksheets/sheet1.xml").async("string");
  s1 = rewriteSheet(s1, {
    sheetData: buildSheetData(PROJECT_HEADERS, projects, projectRow),
    cols: colsBlock(PROJECT_WIDTHS),
    lastCol: "U",
    lastRow: projCfLast,
    cf: projectCF(projCfLast),
    dv: projectDV(projCfLast),
  });
  zip.file("xl/worksheets/sheet1.xml", s1);

  // Sheet 2 — Missing Property Data.
  let s2 = await zip.file("xl/worksheets/sheet2.xml").async("string");
  s2 = rewriteSheet(s2, {
    sheetData: buildSheetData(PROPERTY_HEADERS, properties, propertyRow),
    cols: colsBlock(PROPERTY_WIDTHS),
    lastCol: "O",
    lastRow: propCfLast,
    cf: propertyCF(propCfLast),
    dv: propertyDV(propCfLast),
  });
  zip.file("xl/worksheets/sheet2.xml", s2);

  // Tables — new ranges + rebuilt column lists.
  let t1 = await zip.file("xl/tables/table1.xml").async("string");
  t1 = rewriteTable(t1, { ref: `A1:U${projRows}`, columns: PROJECT_TABLE_COLS });
  zip.file("xl/tables/table1.xml", t1);

  let t2 = await zip.file("xl/tables/table2.xml").async("string");
  t2 = rewriteTable(t2, { ref: `A1:O${propRows}`, columns: PROPERTY_TABLE_COLS });
  zip.file("xl/tables/table2.xml", t2);

  // Remove the two hidden sheets (keep only the 2 data sheets).
  let wb = await zip.file("xl/workbook.xml").async("string");
  wb = wb.replace(
    '<sheet name="Missing Project Data Old Ignore" sheetId="7" state="hidden" r:id="rId3"/>',
    "",
  );
  wb = wb.replace('<sheet name="Query result" sheetId="8" state="hidden" r:id="rId4"/>', "");
  wb = wb.replace(/<customWorkbookViews>[\s\S]*?<\/customWorkbookViews>/, "");
  wb = wb.replace(
    /<definedNames>[\s\S]*?<\/definedNames>/,
    "<definedNames>" +
      `<definedName name="_xlnm._FilterDatabase" localSheetId="0" hidden="1">'Missing Project Data'!$A$1:$U$${projCfLast}</definedName>` +
      `<definedName name="_xlnm._FilterDatabase" localSheetId="1" hidden="1">'Missing Property Data'!$A$1:$O$${propCfLast}</definedName>` +
      "</definedNames>",
  );
  wb = wb.replace('<calcPr calcId="191029"/>', '<calcPr calcId="191029" fullCalcOnLoad="1"/>');
  zip.file("xl/workbook.xml", wb);

  // Workbook relationships — drop sheet3, sheet4, calcChain.
  let rels = await zip.file("xl/_rels/workbook.xml.rels").async("string");
  rels = rels.replace(/<Relationship Id="rId3"[^>]*\/>/, "");
  rels = rels.replace(/<Relationship Id="rId4"[^>]*\/>/, "");
  rels = rels.replace(/<Relationship Id="rId8"[^>]*\/>/, "");
  zip.file("xl/_rels/workbook.xml.rels", rels);

  // Content types — drop the removed parts.
  let ct = await zip.file("[Content_Types].xml").async("string");
  ct = ct.replace(/<Override PartName="\/xl\/worksheets\/sheet3\.xml"[^>]*\/>/, "");
  ct = ct.replace(/<Override PartName="\/xl\/worksheets\/sheet4\.xml"[^>]*\/>/, "");
  ct = ct.replace(/<Override PartName="\/xl\/tables\/table3\.xml"[^>]*\/>/, "");
  ct = ct.replace(/<Override PartName="\/xl\/calcChain\.xml"[^>]*\/>/, "");
  zip.file("[Content_Types].xml", ct);

  // Extended properties — fix the sheet count/titles so Excel doesn't repair.
  let app = await zip.file("docProps/app.xml").async("string");
  app = app.replace("<vt:i4>4</vt:i4>", "<vt:i4>2</vt:i4>");
  app = app.replace(
    /<TitlesOfParts>[\s\S]*?<\/TitlesOfParts>/,
    '<TitlesOfParts><vt:vector size="2" baseType="lpstr">' +
      "<vt:lpstr>Missing Project Data</vt:lpstr>" +
      "<vt:lpstr>Missing Property Data</vt:lpstr>" +
      "</vt:vector></TitlesOfParts>",
  );
  zip.file("docProps/app.xml", app);

  // Physically remove the dropped parts.
  for (const p of [
    "xl/worksheets/sheet3.xml",
    "xl/worksheets/sheet4.xml",
    "xl/worksheets/_rels/sheet3.xml.rels",
    "xl/tables/table3.xml",
    "xl/calcChain.xml",
  ]) {
    zip.remove(p);
  }

  const buf = await zip.generateAsync({ type: "nodebuffer", compression: "DEFLATE" });
  await writeFile(outPath, buf);
  console.log(`Wrote ${outPath}`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
