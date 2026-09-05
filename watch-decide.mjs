// @ts-check
import { TOKEN_RE } from "./control-contract.mjs";

/**
 * Should this tick run a sync?
 *
 * Pure on purpose: this is the part most likely to misbehave and the hardest to
 * debug against a live sheet, so it is tested directly with no network.
 *
 * @param {object} args
 * @param {string} args.request              raw contents of `_control!B1`
 * @param {string | null} args.lastHandledToken  last token acted on, from .watch-state.json
 * @param {number | null} args.lastRunAt     epoch ms of the last successful sync
 * @param {number} args.now                  epoch ms
 * @param {number} args.minGapMs             refuse to run again inside this window
 * @returns {{ action: "none" | "ignore" | "skip" | "run", token?: string, message?: string }}
 */
export function decide({ request, lastHandledToken, lastRunAt, now, minGapMs }) {
  const req = String(request ?? "").trim();

  if (!req) return { action: "none" };

  if (!TOKEN_RE.test(req)) {
    return { action: "ignore", message: "Ignored unrecognised value in request cell." };
  }

  // Survives a watcher restart: .watch-state.json remembers the last token, so
  // a crash mid-run does not replay the sync on the next start.
  if (lastHandledToken && req === lastHandledToken) return { action: "none" };

  if (typeof lastRunAt === "number") {
    const elapsed = now - lastRunAt;
    if (elapsed >= 0 && elapsed < minGapMs) {
      const secs = Math.max(1, Math.round(elapsed / 1000));
      // Still marked handled by the caller, so four impatient clicks do not
      // queue four runs.
      return { action: "skip", token: req, message: `Skipped — synced ${secs}s ago.` };
    }
  }

  return { action: "run", token: req };
}

/**
 * Turn the sync's stdout into the sentence shown in the sheet and the dialog.
 * Tolerates missing lines: a `--dry-run` child prints grids, not counts.
 * @param {string} stdout
 */
export function summarise(stdout) {
  /** @type {Record<string, number>} */
  const rows = {};
  let archived = 0;
  let sawTab = false;

  for (const line of String(stdout ?? "").split(/\r?\n/)) {
    const m = /^\s*(Missing (?:Project|Property) Data):\s*(\d+) rows; archived (\d+)\./.exec(line);
    if (!m) continue;
    sawTab = true;
    rows[m[1]] = Number(m[2]);
    archived += Number(m[3]);
  }

  if (!sawTab) return "Done.";

  const parts = [];
  if (rows["Missing Project Data"] !== undefined) {
    parts.push(`${rows["Missing Project Data"]} project rows`);
  }
  if (rows["Missing Property Data"] !== undefined) {
    parts.push(`${rows["Missing Property Data"]} property rows`);
  }
  parts.push(`${archived} archived`);
  return `Done — ${parts.join(", ")}.`;
}
