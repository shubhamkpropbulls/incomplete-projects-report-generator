// @ts-check
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { CONTROL_TAB, CELL, TOKEN_RE, STATE } from "../control-contract.mjs";
import { decide } from "../watch-decide.mjs";

/**
 * The sheet button (Apps Script, .gs) and the watcher (Node, .mjs) agree on a
 * token format and a cell map by duplication — there is no shared module across
 * the two runtimes. A drift there fails silently: the watcher clears the cell
 * and reports "Ignored unrecognised value", while the dialog sits at "queued"
 * until it times out. These tests are the only thing that catches it.
 */

const ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const CODE_GS = readFileSync(join(ROOT, "apps-script", "Code.gs"), "utf8");

test("Code.gs targets the same control tab", () => {
  const m = /var CONTROL_TAB = '([^']+)';/.exec(CODE_GS);
  assert.ok(m, "CONTROL_TAB not found in Code.gs");
  assert.equal(m[1], CONTROL_TAB);
});

test("Code.gs uses the same cell map", () => {
  const block = /var CELL = \{([\s\S]*?)\};/.exec(CODE_GS);
  assert.ok(block, "CELL not found in Code.gs");

  /** @type {Record<string, string>} */
  const fromGs = {};
  for (const [, key, value] of block[1].matchAll(/(\w+):\s*'([^']+)'/g)) {
    fromGs[key] = value;
  }
  assert.deepEqual(fromGs, CELL);
});

test("the token Code.gs generates is one watch-decide.mjs will run", () => {
  // Plain ES5 with no Apps Script APIs, so it evaluates directly in Node —
  // this tests the real generator, not a copy of it.
  const src = /function makeToken_\(\) \{[\s\S]*?\n\}/.exec(CODE_GS);
  assert.ok(src, "makeToken_ not found in Code.gs");
  const makeToken = new Function(`return (${src[0]})`)();

  for (let i = 0; i < 200; i++) {
    const token = makeToken();
    assert.match(token, TOKEN_RE, `Code.gs produced a token the watcher rejects: ${token}`);
    const outcome = decide({
      request: token,
      lastHandledToken: null,
      lastRunAt: null,
      now: Date.now(),
      minGapMs: 120_000,
    });
    assert.equal(outcome.action, "run");
  }
});

test("Code.gs writes a state value the watcher and dialog both understand", () => {
  const written = [...CODE_GS.matchAll(/getRange\(CELL\.state\)\.setValue\('([^']+)'\)/g)].map(
    (m) => m[1],
  );
  assert.ok(written.length > 0, "Code.gs never sets the state cell");
  for (const value of written) {
    assert.ok(value in STATE, `Code.gs writes unknown state ${JSON.stringify(value)}`);
  }
});

test("Dialog.html only finishes on states the watcher actually writes", () => {
  const dialog = readFileSync(join(ROOT, "apps-script", "Dialog.html"), "utf8");
  const compared = [...dialog.matchAll(/s\.state === '([^']+)'/g)].map((m) => m[1]);
  assert.ok(compared.length >= 3, "Dialog.html does not branch on state");
  for (const value of compared) {
    assert.ok(value in STATE, `Dialog.html checks unknown state ${JSON.stringify(value)}`);
  }
  // The two terminal states must both be handled or the dialog hangs to timeout.
  assert.ok(compared.includes("done"));
  assert.ok(compared.includes("error"));
});

test("the dialog waits longer than the button's staleness threshold", () => {
  const stale = /var HEARTBEAT_STALE_MS = ([\d\s*]+);/.exec(CODE_GS);
  assert.ok(stale, "HEARTBEAT_STALE_MS not found");
  const staleMs = new Function(`return ${stale[1]}`)();

  const dialog = readFileSync(join(ROOT, "apps-script", "Dialog.html"), "utf8");
  const timeout = /var TIMEOUT_MS = (\d+);/.exec(dialog);
  assert.ok(timeout, "TIMEOUT_MS not found in Dialog.html");

  assert.ok(
    Number(timeout[1]) > staleMs,
    "the dialog would give up before a stale heartbeat could be detected",
  );
});
