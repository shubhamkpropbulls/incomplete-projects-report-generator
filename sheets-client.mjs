// @ts-check
import { readFileSync } from "node:fs";
import { google } from "googleapis";

export function getSheetsClient(keyPath) {
  const key = JSON.parse(readFileSync(keyPath, "utf8"));
  const auth = new google.auth.JWT({
    email: key.client_email,
    key: key.private_key,
    scopes: ["https://www.googleapis.com/auth/spreadsheets"],
  });
  return google.sheets({ version: "v4", auth });
}

export async function getTabMap(sheets, spreadsheetId) {
  const res = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties(sheetId,title))",
  });
  const map = new Map();
  for (const s of res.data.sheets ?? []) {
    map.set(s.properties.title, s.properties.sheetId);
  }
  return map;
}

export async function ensureTab(sheets, spreadsheetId, title, tabMap) {
  if (tabMap.has(title)) return tabMap.get(title);
  const res = await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests: [{ addSheet: { properties: { title } } }] },
  });
  const sheetId = res.data.replies[0].addSheet.properties.sheetId;
  tabMap.set(title, sheetId);
  return sheetId;
}

export async function readTab(sheets, spreadsheetId, title) {
  const res = await sheets.spreadsheets.values.get({
    spreadsheetId,
    range: `'${title}'`,
    valueRenderOption: "FORMATTED_VALUE",
  });
  return res.data.values ?? [];
}

export async function cfRuleCount(sheets, spreadsheetId, sheetId) {
  const res = await sheets.spreadsheets.get({
    spreadsheetId,
    fields: "sheets(properties.sheetId,conditionalFormats)",
  });
  const sheet = (res.data.sheets ?? []).find((s) => s.properties.sheetId === sheetId);
  return sheet?.conditionalFormats?.length ?? 0;
}

export async function writeGrid(sheets, spreadsheetId, title, values, lastColLetter) {
  await sheets.spreadsheets.values.update({
    spreadsheetId,
    range: `'${title}'!A1`,
    valueInputOption: "USER_ENTERED",
    requestBody: { values },
  });
  const firstEmptyRow = values.length + 1;
  await sheets.spreadsheets.values.clear({
    spreadsheetId,
    range: `'${title}'!A${firstEmptyRow}:${lastColLetter}`,
  });
}

export async function appendRows(sheets, spreadsheetId, title, rows) {
  if (!rows.length) return;
  await sheets.spreadsheets.values.append({
    spreadsheetId,
    range: `'${title}'!A1`,
    valueInputOption: "USER_ENTERED",
    insertDataOption: "INSERT_ROWS",
    requestBody: { values: rows },
  });
}

export async function runBatch(sheets, spreadsheetId, requests) {
  if (!requests.length) return;
  await sheets.spreadsheets.batchUpdate({
    spreadsheetId,
    requestBody: { requests },
  });
}
