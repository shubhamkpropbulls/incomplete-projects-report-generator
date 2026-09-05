// @ts-check
import { readFileSync } from "node:fs";
import process from "node:process";
import { JWT } from "google-auth-library";
import { loadDotEnv } from "./env.mjs";
import { CELL, CONTROL_RANGE, STAMP_CELLS } from "./control-contract.mjs";

/**
 * Sheets access for the watcher.
 *
 * Deliberately does NOT import googleapis. Measured on this machine 2026-09-05:
 * bare node 45 MB, google-auth-library 54 MB, full googleapis 157 MB with ~950ms
 * of startup. sync-sheet.mjs is a short-lived child so it keeps using googleapis
 * unchanged; the watcher is resident forever and only needs two REST calls.
 */

const API = "https://sheets.googleapis.com/v4/spreadsheets";
const SCOPE = "https://www.googleapis.com/auth/spreadsheets";

/** @type {JWT | null} */
let jwt = null;

function auth() {
  if (jwt) return jwt;
  loadDotEnv();
  const keyPath = process.env.GOOGLE_SERVICE_ACCOUNT_KEY;
  if (!keyPath) throw new Error("GOOGLE_SERVICE_ACCOUNT_KEY is required.");
  const key = JSON.parse(readFileSync(keyPath, "utf8"));
  jwt = new JWT({ email: key.client_email, key: key.private_key, scopes: [SCOPE] });
  return jwt;
}

export function spreadsheetId() {
  loadDotEnv();
  const id = process.env.SPREADSHEET_ID;
  if (!id) throw new Error("SPREADSHEET_ID is required.");
  return id;
}

/**
 * @param {"GET" | "POST"} method
 * @param {string} path
 * @param {unknown} [body]
 */
async function call(method, path, body) {
  const { token } = await auth().getAccessToken();
  const res = await fetch(`${API}/${spreadsheetId()}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${token}`,
      "Content-Type": "application/json",
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    const err = new Error(`Sheets API ${res.status}: ${text.slice(0, 300)}`);
    // The watcher backs off on 429 rather than reporting it to the team.
    Object.assign(err, { status: res.status });
    throw err;
  }
  return res.json();
}

/**
 * @typedef {{ request: string, state: string, message: string, heartbeat: string, lastRun: string }} Control
 * @returns {Promise<Control>}
 */
export async function readControl() {
  const data = await call(
    "GET",
    `/values/${encodeURIComponent(CONTROL_RANGE)}?valueRenderOption=FORMATTED_VALUE`,
  );
  const rows = data.values ?? [];
  const at = (/** @type {number} */ i) => String(rows[i]?.[0] ?? "").trim();
  return {
    request: at(0),
    state: at(1),
    message: at(2),
    heartbeat: at(3),
    lastRun: at(4),
  };
}

/**
 * @param {{ range: string, values: string[][] }[]} data
 */
async function writeValues(data) {
  if (!data.length) return;
  await call("POST", "/values:batchUpdate", { valueInputOption: "RAW", data });
}

/**
 * Write only the named cells. `null` clears one.
 * @param {Partial<Record<keyof typeof CELL, string | null>>} patch
 */
export async function writeControl(patch) {
  await writeValues(
    Object.entries(patch)
      .filter(([key, value]) => key in CELL && value !== undefined)
      .map(([key, value]) => ({
        range: `'_control'!${CELL[/** @type {keyof typeof CELL} */ (key)]}`,
        values: [[value === null ? "" : String(value)]],
      })),
  );
}

/**
 * The human-readable stamp on the data tabs. Separate from writeControl because
 * these cells live on the tabs the team actually looks at, not the hidden one.
 * @param {string} text
 */
export async function writeStamps(text) {
  await writeValues(
    STAMP_CELLS.map(({ tab, cell }) => ({
      range: `'${tab}'!${cell}`,
      values: [[text]],
    })),
  );
}
