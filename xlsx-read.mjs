// @ts-check
// Minimal read-only .xlsx parser built on the jszip dependency we already have.
// Returns a sheet as an array of row arrays (values indexed by column, 0-based).
//
// IMPORTANT: worksheet cells store text as *pointers* into sharedStrings.xml
// (`<c ... t="s"><v>1303</v></c>` means "shared string #1303"). The `<v>` value
// is the index, NOT the text. Any parser that skips the lookup prints the raw
// index (e.g. "1303") instead of the real value. Resolve every `t="s"` cell.
import JSZip from "jszip";

const XML_ENTITIES = [
  [/&lt;/g, "<"], [/&gt;/g, ">"], [/&quot;/g, '"'],
  [/&#10;/g, "\n"], [/&#xA;/g, "\n"], [/&#xa;/g, "\n"], [/&#39;/g, "'"],
  [/&amp;/g, "&"], // must run last
];

function decodeEntities(s) {
  for (const [re, rep] of XML_ENTITIES) s = s.replace(re, rep);
  return s;
}

function parseSharedStrings(xml) {
  const out = [];
  for (const si of xml.matchAll(/<si>([\s\S]*?)<\/si>/g)) {
    let text = "";
    for (const t of si[1].matchAll(/<t[^>]*>([\s\S]*?)<\/t>/g)) text += t[1];
    out.push(decodeEntities(text));
  }
  return out;
}

// "R" -> 17 (0-based). Column ref only, digits already stripped.
function colLettersToIndex(letters) {
  let n = 0;
  for (const ch of letters) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}

function parseSheet(xml, shared) {
  const rows = [];
  for (const rm of xml.matchAll(/<row[^>]*?>([\s\S]*?)<\/row>/g)) {
    const cells = {};
    // Capture each cell's full attribute string, then its inner content (or
    // self-closing). Capturing the whole attribute run is what lets us see
    // t="s" regardless of attribute order.
    for (const cm of rm[1].matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const attrs = cm[1];
      const inner = cm[2] || "";
      const refM = attrs.match(/r="([A-Z]+)\d+"/);
      if (!refM) continue;
      const idx = colLettersToIndex(refM[1]);
      const vM = inner.match(/<v>([\s\S]*?)<\/v>/);
      let val = vM ? vM[1] : "";
      if (/\bt="s"/.test(attrs)) {
        val = val === "" ? "" : (shared[Number(val)] ?? "");
      } else if (/\bt="(?:inlineStr|str)"/.test(attrs)) {
        const tM = inner.match(/<t[^>]*>([\s\S]*?)<\/t>/);
        val = tM ? decodeEntities(tM[1]) : "";
      } else {
        val = decodeEntities(val);
      }
      cells[idx] = val;
    }
    const maxIdx = Math.max(-1, ...Object.keys(cells).map(Number));
    const arr = [];
    for (let i = 0; i <= maxIdx; i++) arr.push(cells[i] ?? "");
    rows.push(arr);
  }
  return rows;
}

/**
 * Read a single named worksheet from an .xlsx buffer.
 * @param {Buffer|Uint8Array} buf raw .xlsx bytes
 * @param {string} sheetName worksheet tab name
 * @returns {Promise<string[][]>} rows of cell strings (0-based column index)
 */
export async function readXlsxSheet(buf, sheetName) {
  const zip = await JSZip.loadAsync(buf);
  const ssFile = zip.file("xl/sharedStrings.xml");
  const shared = ssFile ? parseSharedStrings(await ssFile.async("string")) : [];

  const wb = await zip.file("xl/workbook.xml").async("string");
  const relsXml = await zip.file("xl/_rels/workbook.xml.rels").async("string");
  const relMap = {};
  for (const r of relsXml.matchAll(/<Relationship[^>]*Id="([^"]*)"[^>]*Target="([^"]*)"/g)) {
    relMap[r[1]] = r[2];
  }

  const sheets = [...wb.matchAll(/<sheet[^>]*name="([^"]*)"[^>]*r:id="([^"]*)"/g)]
    .map((m) => ({ name: decodeEntities(m[1]), rid: m[2] }));
  const sheet = sheets.find((s) => s.name === sheetName);
  if (!sheet) {
    throw new Error(`Sheet "${sheetName}" not found. Available: ${sheets.map((s) => s.name).join(", ")}`);
  }
  let target = relMap[sheet.rid];
  if (!target) throw new Error(`No relationship target for sheet "${sheetName}"`);
  if (!target.startsWith("xl/")) target = "xl/" + target;

  const sheetXml = await zip.file(target).async("string");
  return parseSheet(sheetXml, shared);
}
