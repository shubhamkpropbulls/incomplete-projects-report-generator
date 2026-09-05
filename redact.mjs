// @ts-check
import process from "node:process";

const REDACTED = "[redacted]";

// Postgres URLs carry user:password@host. pg surfaces them in error messages,
// and those errors end up in the sheet, in a desktop dialog and in the log.
const CONNECTION_URL = /\b(?:postgres|postgresql):\/\/\S+/gi;
const PRIVATE_KEY = /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g;

/** Env vars whose literal values must never reach a log, a sheet cell or a dialog. */
export const SECRET_ENV_VARS = ["DATABASE_URL", "GOOGLE_SERVICE_ACCOUNT_KEY"];

/** @param {NodeJS.ProcessEnv} [env] */
export function secretsFromEnv(env = process.env) {
  return SECRET_ENV_VARS.map((k) => env[k]).filter(
    /** @returns {v is string} */ (v) => typeof v === "string" && v.length >= 8,
  );
}

/**
 * Strip credentials from text before it leaves this process.
 *
 * Applied to everything: the `_control` message cell (the whole team can read
 * it), the desktop dialog, and the log file (log files get pasted into issues).
 * A stack trace is just as useful with the connection string removed.
 *
 * @param {unknown} text
 * @param {string[]} [secrets] literal values to blank out, defaults to the env
 */
export function redact(text, secrets = secretsFromEnv()) {
  let out = typeof text === "string" ? text : String(text ?? "");
  out = out.replace(PRIVATE_KEY, REDACTED).replace(CONNECTION_URL, REDACTED);
  for (const secret of secrets) out = out.split(secret).join(REDACTED);
  return out;
}

/**
 * Host and database name from a Postgres URL, for logging which database we are
 * about to hit without printing the credentials. Returns null if unparseable.
 * @param {string | undefined} url
 */
export function describeDatabase(url) {
  if (!url) return null;
  try {
    const u = new URL(url);
    return `${u.hostname}${u.port ? `:${u.port}` : ""}/${u.pathname.replace(/^\//, "")}`;
  } catch {
    return null;
  }
}
