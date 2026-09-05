// @ts-check
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import { readControl, writeControl } from "./control.mjs";
import { STATE, STOPPED_MESSAGE } from "./control-contract.mjs";
import { decide, summarise } from "./watch-decide.mjs";
import { loadDotEnv } from "./env.mjs";
import { configureLogger, info, warn, error, logBlock, pruneOldLogs, closeLogger } from "./log.mjs";
import { notify } from "./notify.mjs";
import { describeDatabase } from "./redact.mjs";

/**
 * Watches `_control!B1` for a request token written by the sheet button and runs
 * the existing sync when one arrives.
 *
 * The sheet is a mailbox: Google never calls this machine, this machine polls
 * outbound over HTTPS exactly as `npm run sync` already does. Nothing inbound is
 * ever opened.
 */

const __dirname = dirname(fileURLToPath(import.meta.url));
const STATE_FILE = join(__dirname, ".watch-state.json");

const ONCE = process.argv.includes("--once");
const SYNC_DRY_RUN = process.argv.includes("--sync-dry-run");

const num = (/** @type {string} */ name, /** @type {number} */ fallback) => {
  const raw = process.env[name];
  const parsed = raw === undefined ? NaN : Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
};

const CONFIG = {
  pollMs: num("POLL_MS", 15_000),
  heartbeatMs: num("HEARTBEAT_MS", 60_000),
  minGapMs: num("MIN_GAP_MS", 120_000),
  aliveMs: num("ALIVE_MS", 3_600_000),
  backoffCapMs: num("BACKOFF_CAP_MS", 120_000),
  failuresBeforeDialog: num("FAILURES_BEFORE_DIALOG", 5),
};

/** @type {{ lastHandledToken: string | null, lastRunAt: number | null }} */
let persisted = { lastHandledToken: null, lastRunAt: null };

let lastHeartbeatAt = 0;
let lastAliveAt = 0;
let consecutiveFailures = 0;
let backoffUntil = 0;
let stopping = false;

const sleep = (/** @type {number} */ ms) => new Promise((r) => setTimeout(r, ms));

function loadState() {
  if (!existsSync(STATE_FILE)) return;
  try {
    const parsed = JSON.parse(readFileSync(STATE_FILE, "utf8"));
    persisted = {
      lastHandledToken:
        typeof parsed.lastHandledToken === "string" ? parsed.lastHandledToken : null,
      lastRunAt: typeof parsed.lastRunAt === "number" ? parsed.lastRunAt : null,
    };
  } catch (err) {
    warn(`Could not read ${STATE_FILE}, starting fresh: ${err}`);
  }
}

function saveState() {
  try {
    writeFileSync(STATE_FILE, JSON.stringify(persisted, null, 2));
  } catch (err) {
    warn(`Could not write ${STATE_FILE}: ${err}`);
  }
}

/**
 * Run the existing sync as a child process rather than importing it.
 * db.mjs:186 and sync-sheet.mjs:52,131 all call process.exit — imported into a
 * long-running watcher any one of them would kill it without a word. A child
 * also isolates a crash or a leaked connection from the loop.
 * @returns {Promise<{ code: number, stdout: string, stderr: string, ms: number }>}
 */
function runSync() {
  const args = ["sync-sheet.mjs"];
  if (SYNC_DRY_RUN) args.push("--dry-run");

  return new Promise((resolve) => {
    const startedAt = Date.now();
    const child = spawn(process.execPath, args, { cwd: __dirname });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      stderr += `\n${err.stack ?? err}`;
      resolve({ code: -1, stdout, stderr, ms: Date.now() - startedAt });
    });
    child.on("close", (code) =>
      resolve({ code: code ?? -1, stdout, stderr, ms: Date.now() - startedAt }),
    );
  });
}

/** Last non-empty line of stderr — the part worth showing in a cell. */
function failureMessage(/** @type {string} */ stderr) {
  const lines = String(stderr).split(/\r?\n/).filter((l) => l.trim());
  const last = lines[lines.length - 1] ?? "Sync failed with no output.";
  return last.length > 200 ? `${last.slice(0, 197)}...` : last;
}

async function handleRun(/** @type {string} */ token) {
  info(`Request accepted: ${token}`);

  // Clear the request BEFORE running, so a click arriving mid-run lands as a
  // fresh token and is picked up on the next tick instead of being swallowed.
  await writeControl({
    request: null,
    state: STATE.running,
    message: SYNC_DRY_RUN ? "Refreshing… (dry run)" : "Refreshing…",
  });

  persisted.lastHandledToken = token;
  saveState();

  const { code, stdout, stderr, ms } = await runSync();
  logBlock("INFO", `sync stdout (exit ${code}, ${ms}ms)`, stdout);
  logBlock(code === 0 ? "INFO" : "ERROR", "sync stderr", stderr);

  if (code === 0) {
    const message = summarise(stdout);
    persisted.lastRunAt = Date.now();
    saveState();
    await writeControl({
      state: STATE.done,
      message,
      lastRun: new Date().toISOString(),
    });
    info(`Sync finished in ${ms}ms — ${message}`);
    return;
  }

  const message = failureMessage(stderr);
  error(`Sync failed (exit ${code}): ${message}`);
  await writeControl({ state: STATE.error, message });
  notify("Incomplete-report sync failed", `The sync ran but exited ${code}.\n\n${message}`);
}

async function tick() {
  const now = Date.now();
  if (now < backoffUntil) return;

  const control = await readControl();

  if (now - lastHeartbeatAt >= CONFIG.heartbeatMs) {
    await writeControl({ heartbeat: new Date().toISOString() });
    lastHeartbeatAt = now;
  }

  if (now - lastAliveAt >= CONFIG.aliveMs) {
    info(`alive — last run ${persisted.lastRunAt ? new Date(persisted.lastRunAt).toISOString() : "never"}`);
    lastAliveAt = now;
  }

  const outcome = decide({
    request: control.request,
    lastHandledToken: persisted.lastHandledToken,
    lastRunAt: persisted.lastRunAt,
    now,
    minGapMs: CONFIG.minGapMs,
  });

  switch (outcome.action) {
    case "none":
      return;

    case "ignore":
      warn(`Ignoring junk in request cell: ${JSON.stringify(control.request)}`);
      await writeControl({
        request: null,
        state: STATE.idle,
        message: outcome.message ?? "",
      });
      return;

    case "skip":
      info(`Skipping ${outcome.token} — ${outcome.message}`);
      if (outcome.token) {
        persisted.lastHandledToken = outcome.token;
        saveState();
      }
      await writeControl({
        request: null,
        state: STATE.done,
        message: outcome.message ?? "",
      });
      return;

    case "run":
      await handleRun(/** @type {string} */ (outcome.token));
      return;
  }
}

async function shutdown(/** @type {string} */ reason) {
  if (stopping) return;
  stopping = true;
  info(`Stopping: ${reason}`);
  try {
    await writeControl({ state: STATE.error, message: STOPPED_MESSAGE });
  } catch (err) {
    warn(`Could not write the stopped state to the sheet: ${err}`);
  }
  closeLogger();
}

async function main() {
  loadDotEnv();
  configureLogger({ echo: true });
  const pruned = pruneOldLogs();

  info("--- watcher starting ---");
  info(
    `config: poll=${CONFIG.pollMs}ms heartbeat=${CONFIG.heartbeatMs}ms ` +
      `minGap=${CONFIG.minGapMs}ms once=${ONCE} syncDryRun=${SYNC_DRY_RUN}`,
  );
  // Host and database name only — never the URL itself.
  info(`database target: ${describeDatabase(process.env.DATABASE_URL) ?? "unknown"}`);
  if (pruned.length) info(`pruned ${pruned.length} old log file(s)`);

  loadState();
  info(
    `state: lastHandledToken=${persisted.lastHandledToken ?? "none"} ` +
      `lastRunAt=${persisted.lastRunAt ? new Date(persisted.lastRunAt).toISOString() : "never"}`,
  );

  for (const signal of /** @type {const} */ (["SIGINT", "SIGTERM"])) {
    process.on(signal, () => {
      shutdown(signal).finally(() => process.exit(0));
    });
  }

  while (!stopping) {
    try {
      await tick();
      consecutiveFailures = 0;
      backoffUntil = 0;
    } catch (err) {
      consecutiveFailures += 1;
      const status = /** @type {{ status?: number }} */ (err)?.status;

      if (status === 429) {
        // A quota storm is not something the team should see in the sheet.
        const wait = Math.min(CONFIG.pollMs * 2 ** consecutiveFailures, CONFIG.backoffCapMs);
        backoffUntil = Date.now() + wait;
        warn(`Rate limited by Sheets; backing off ${wait}ms`);
      } else {
        error(`Tick failed (${consecutiveFailures} in a row): ${err instanceof Error ? (err.stack ?? err.message) : err}`);
        if (consecutiveFailures === CONFIG.failuresBeforeDialog) {
          notify(
            "Incomplete-report sync watcher is failing",
            `${consecutiveFailures} consecutive failures talking to Google Sheets.\n\n` +
              `${err instanceof Error ? err.message : err}\n\nCheck logs/ for detail.`,
          );
        }
      }
    }

    if (ONCE) break;
    await sleep(CONFIG.pollMs);
  }

  closeLogger();
}

process.on("uncaughtException", (err) => {
  error(`Uncaught exception: ${err.stack ?? err}`);
  notify("Incomplete-report sync watcher crashed", `${err.message}\n\nCheck logs/ for the stack.`);
  shutdown("uncaught exception").finally(() => process.exit(1));
});

process.on("unhandledRejection", (reason) => {
  error(`Unhandled rejection: ${reason instanceof Error ? (reason.stack ?? reason.message) : reason}`);
  notify(
    "Incomplete-report sync watcher crashed",
    `${reason instanceof Error ? reason.message : reason}\n\nCheck logs/ for the stack.`,
  );
  shutdown("unhandled rejection").finally(() => process.exit(1));
});

main().catch((err) => {
  error(`Watcher exited: ${err instanceof Error ? (err.stack ?? err.message) : err}`);
  notify("Incomplete-report sync watcher stopped", String(err instanceof Error ? err.message : err));
  closeLogger();
  process.exit(1);
});
