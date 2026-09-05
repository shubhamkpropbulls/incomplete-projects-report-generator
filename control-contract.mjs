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
