// @ts-check
import test from "node:test";
import assert from "node:assert/strict";

import { decide, summarise } from "../watch-decide.mjs";
import { TOKEN_RE, makeToken } from "../control-contract.mjs";
import { redact, describeDatabase } from "../redact.mjs";

const MIN_GAP = 120_000;
const NOW = Date.UTC(2026, 8, 5, 14, 2, 0);
const TOKEN = "SYNC 2026-09-05T14:01:55.123Z a1b2c3d4";

/** @param {Partial<Parameters<typeof decide>[0]>} over */
const args = (over = {}) => ({
  request: "",
  lastHandledToken: null,
  lastRunAt: null,
  now: NOW,
  minGapMs: MIN_GAP,
  ...over,
});

test("empty request cell does nothing", () => {
  assert.equal(decide(args()).action, "none");
  assert.equal(decide(args({ request: "   " })).action, "none");
});

test("junk in the request cell is ignored, never run", () => {
  for (const junk of ["asdf", "SYNC", "2026-09-05", "SYNC 2026-09-05T14:01:55Z zzzzzzzz", TOKEN.toUpperCase()]) {
    const out = decide(args({ request: junk }));
    assert.equal(out.action, "ignore", `expected ignore for ${JSON.stringify(junk)}`);
    assert.equal(out.message, "Ignored unrecognised value in request cell.");
    assert.equal(out.token, undefined);
  }
});

test("a valid token runs", () => {
  const out = decide(args({ request: TOKEN }));
  assert.equal(out.action, "run");
  assert.equal(out.token, TOKEN);
});

test("a token already handled does not re-run after a restart", () => {
  const out = decide(args({ request: TOKEN, lastHandledToken: TOKEN }));
  assert.equal(out.action, "none");
});

test("a fresh token still runs when a different one was handled before", () => {
  const out = decide(args({ request: TOKEN, lastHandledToken: "SYNC 2026-09-04T09:00:00.000Z ffffffff" }));
  assert.equal(out.action, "run");
});

test("a second click inside the minimum gap is skipped, not queued", () => {
  const out = decide(args({ request: TOKEN, lastRunAt: NOW - 40_000 }));
  assert.equal(out.action, "skip");
  assert.equal(out.message, "Skipped — synced 40s ago.");
  // Still returned so the caller marks it handled; otherwise it retries every tick.
  assert.equal(out.token, TOKEN);
});

test("a click after the minimum gap runs", () => {
  const out = decide(args({ request: TOKEN, lastRunAt: NOW - MIN_GAP - 1 }));
  assert.equal(out.action, "run");
});

test("a lastRunAt in the future does not block forever", () => {
  const out = decide(args({ request: TOKEN, lastRunAt: NOW + 60_000 }));
  assert.equal(out.action, "run");
});

test("makeToken produces something decide accepts", () => {
  const token = makeToken(new Date(NOW));
  assert.match(token, TOKEN_RE);
  assert.equal(decide(args({ request: token })).action, "run");
});

test("summarise reads the counts the sync prints", () => {
  const stdout = [
    "Found 12 incomplete project(s), 5 incomplete property(ies).",
    "  Missing Project Data: 12 rows; archived 2.",
    "  Missing Property Data: 5 rows; archived 1.",
    "Done. https://docs.google.com/spreadsheets/d/abc/edit",
  ].join("\n");
  assert.equal(summarise(stdout), "Done — 12 project rows, 5 property rows, 3 archived.");
});

test("summarise tolerates a dry run printing no counts", () => {
  assert.equal(summarise("[DRY RUN] No network calls made."), "Done.");
  assert.equal(summarise(""), "Done.");
});

test("redact removes postgres connection strings", () => {
  const text = "error: connect ECONNREFUSED postgresql://admin:hunter2@db.example.com:5432/propbulls";
  const out = redact(text, []);
  assert.ok(!out.includes("hunter2"), out);
  assert.ok(!out.includes("db.example.com"), out);
  assert.ok(out.includes("[redacted]"));
});

test("redact removes a service-account private key block", () => {
  const text = "key: -----BEGIN PRIVATE KEY-----\nMIIEvQIBADAN\nsecret\n-----END PRIVATE KEY-----done";
  const out = redact(text, []);
  assert.ok(!out.includes("MIIEvQIBADAN"), out);
  assert.equal(out, "key: [redacted]done");
});

test("redact removes literal secret values passed in", () => {
  const secret = "postgres-super-secret-value";
  const out = redact(`boom ${secret} boom`, [secret]);
  assert.equal(out, "boom [redacted] boom");
});

test("redact leaves ordinary error text alone", () => {
  const text = "Sheets API 403: The caller does not have permission";
  assert.equal(redact(text, []), text);
});

test("describeDatabase gives host and database, never credentials", () => {
  const out = describeDatabase("postgresql://admin:hunter2@db.example.com:5432/propbulls");
  assert.equal(out, "db.example.com:5432/propbulls");
  assert.equal(describeDatabase(undefined), null);
  assert.equal(describeDatabase("not a url"), null);
});
