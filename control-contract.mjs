// @ts-check
import { randomBytes } from "node:crypto";

/**
 * The contract shared by the watcher (Node) and the sheet button (Apps Script).
 *
 * Pure constants and pure functions only — no network, no dependencies — so
 * tests and the decision logic can import it for free. The network side lives
 * in control.mjs.
 *
 * Anything changed here must be changed in apps-script/Code.gs to match. A
 * mismatch is silent: the watcher clears the cell, reports "Ignored
 * unrecognised value", and the dialog sits at `queued` until it times out.
 */

export const CONTROL_TAB = "_control";

/** Cell addresses within the control tab, by logical name. */
export const CELL = {
  request: "B1",
  state: "B2",
  message: "B3",
  heartbeat: "B4",
  lastRun: "B5",
};

/** Read in one shot; order matches CELL above. */
export const CONTROL_RANGE = `'${CONTROL_TAB}'!B1:B5`;

/** Column A labels, so the tab is readable if someone unhides it. */
export const CONTROL_LABELS = ["Request", "State", "Message", "Heartbeat", "Last run"];

export const STATE = {
  idle: "idle",
  queued: "queued",
  running: "running",
  done: "done",
  error: "error",
};

/** Written by the watcher on its way out; the sheet shows it until the next run. */
export const STOPPED_MESSAGE = "Watcher stopped.";

/**
 * A request only counts if it looks like this. Deliberately not "the cell
 * changed" — a stray keystroke or a pasted column in `_control` must not fire a
 * sync against production.
 */
export const TOKEN_RE = /^SYNC \d{4}-\d{2}-\d{2}T[\d:.]+Z [0-9a-f]{8}$/;

/** @param {Date} [now] */
export function makeToken(now = new Date()) {
  return `SYNC ${now.toISOString()} ${randomBytes(4).toString("hex")}`;
}

/**
 * A plain "last synced" stamp on the data tabs themselves, so nobody has to
 * open a dialog or unhide `_control` to know how fresh the numbers are.
 *
 * Both cells sit outside everything writeGrid touches. Verified against the
 * live sheet 2026-09-05: the project tab is 21 columns (A-U) and the property
 * tab is 15 (A-O) — note the README claims 16 (A-P), which is wrong — and
 * sheets-client.mjs:56-70 writes A1 across the data width then clears only
 * A<firstEmpty>:<lastCol>. Nothing reaches column W or R.
 */
export const STAMP_CELLS = [
  { tab: "Missing Project Data", cell: "W1" },
  { tab: "Missing Property Data", cell: "R1" },
];

/**
 * The team is in India and reads this cell directly, so format for a human in
 * IST rather than dumping the ISO string the control tab carries.
 * @param {Date} [at]
 */
export function stampText(at = new Date()) {
  const parts = new Intl.DateTimeFormat("en-IN", {
    timeZone: "Asia/Kolkata",
    day: "2-digit",
    month: "short",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: true,
  }).format(at);
  return `Last synced ${parts} IST`;
}
