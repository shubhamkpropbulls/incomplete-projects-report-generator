// @ts-check
import { readFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

const __dirname = dirname(fileURLToPath(import.meta.url));

/**
 * Minimal .env loader (KEY=VALUE lines); does not override existing env vars.
 *
 * Lives here rather than in db.mjs so the watcher can load config without
 * importing pg (which costs ~900ms of startup for a process that never touches
 * the database itself). db.mjs re-exports it, so existing callers are unchanged.
 */
export function loadDotEnv() {
  const f = join(__dirname, ".env");
  if (!existsSync(f)) return;
  for (const line of readFileSync(f, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([\w.-]+)\s*=\s*(.*)\s*$/);
    if (!m || line.trimStart().startsWith("#")) continue;
    let v = m[2].trim();
    if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) {
      v = v.slice(1, -1);
    }
    if (!(m[1] in process.env)) process.env[m[1]] = v;
  }
}
