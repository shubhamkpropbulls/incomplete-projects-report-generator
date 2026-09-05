// @ts-check
import { createWriteStream, existsSync, mkdirSync, readdirSync, unlinkSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";
import { redact } from "./redact.mjs";

const __dirname = dirname(fileURLToPath(import.meta.url));

export const LOG_DIR = join(__dirname, "logs");
export const RETAIN_DAYS = 14;

const FILE_RE = /^watch-(\d{4}-\d{2}-\d{2})\.log$/;

/** @type {import("node:fs").WriteStream | null} */
let stream = null;
/** @type {string | null} */
let streamDay = null;
let echoToStdout = false;

/** @param {Date} [d] */
const dayStamp = (d = new Date()) => d.toISOString().slice(0, 10);

/**
 * Foreground (`npm run watch`) echoes to the terminal as well as the file.
 * The scheduled run is hidden and has no console, so the file is the only
 * record — see watch-hidden.vbs.
 */
export function configureLogger({ echo = false } = {}) {
  echoToStdout = echo;
}

/** @param {string} day */
function streamFor(day) {
  if (stream && streamDay === day) return stream;
  if (stream) stream.end();
  mkdirSync(LOG_DIR, { recursive: true });
  stream = createWriteStream(join(LOG_DIR, `watch-${day}.log`), { flags: "a" });
  streamDay = day;
  return stream;
}

/**
 * Drop log files older than `retainDays`. ISO day stamps compare correctly as
 * strings, so no date parsing is needed.
 * @param {Date} [now]
 * @param {number} [retainDays]
 */
export function pruneOldLogs(now = new Date(), retainDays = RETAIN_DAYS) {
  if (!existsSync(LOG_DIR)) return [];
  const cutoff = dayStamp(new Date(now.getTime() - retainDays * 86_400_000));
  const removed = [];
  for (const name of readdirSync(LOG_DIR)) {
    const m = FILE_RE.exec(name);
    if (m && m[1] < cutoff) {
      unlinkSync(join(LOG_DIR, name));
      removed.push(name);
    }
  }
  return removed;
}

/**
 * @param {"INFO" | "WARN" | "ERROR"} level
 * @param {unknown} message
 */
export function log(level, message) {
  const now = new Date();
  const line = `${now.toISOString()} ${level.padEnd(5)} ${redact(message)}\n`;
  streamFor(dayStamp(now)).write(line);
  if (echoToStdout) process.stdout.write(line);
}

/** @param {unknown} m */
export const info = (m) => log("INFO", m);
/** @param {unknown} m */
export const warn = (m) => log("WARN", m);
/** @param {unknown} m */
export const error = (m) => log("ERROR", m);

/**
 * Multi-line blocks (a child's stdout, a stack trace) indented so they do not
 * look like separate log lines when grepping.
 * @param {"INFO" | "WARN" | "ERROR"} level
 * @param {string} label
 * @param {string} body
 */
export function logBlock(level, label, body) {
  const text = String(body ?? "").trimEnd();
  if (!text) return;
  log(level, `${label}:\n${text.replace(/^/gm, "    ")}`);
}

export function closeLogger() {
  if (!stream) return;
  stream.end();
  stream = null;
  streamDay = null;
}
