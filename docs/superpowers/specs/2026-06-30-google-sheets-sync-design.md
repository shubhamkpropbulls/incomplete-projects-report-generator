# Google Sheets Sync — Design

**Date:** 2026-06-30
**Status:** Approved (pending spec review)

## Problem

The current tool generates a fresh `.xlsx` on every run. The team imports it into a
**new** Google Sheet each time, shares a new link, then adds comments (in the
`Notes / Comments` column) and updates the `Status` dropdown.

On the next run a brand-new sheet is produced, so:

1. The team's notes and status updates are lost.
2. A new link must be re-shared every time.

## Goal

Refresh **one permanent Google Sheet in place** so:

- The team always uses the same link.
- Their `Notes / Comments` and `Status` values survive every refresh.
- Rows that become complete are archived (not silently discarded).

## What "comments" means here

Confirmed with the user: comments are **plain cell values** in the
`Notes / Comments` column plus the `Status` dropdown. They are **not** Google
threaded (speech-bubble) comments. This is the easy case — both are ordinary
cell values and can be preserved by matching on a stable key.

## Key insight

Every row already carries a stable database ID:

- Project rows: `Project ID` (column U).
- Property rows: `Property ID` (column N).

These IDs are the **join key**. On each refresh we read the existing
notes/status keyed by ID, regenerate the data, and write the preserved
notes/status back onto matching IDs. Matching by ID (not row position) means it
survives the team sorting or filtering rows.

## Approach (chosen: C — one idempotent script, keep xlsx)

A single `npm run sync` command that is safe to run any number of times. The old
`.xlsx` generator is kept as an offline fallback. (Rejected alternatives:
re-uploading an xlsx over the same Drive file wipes all cell content including
notes, so it solves nothing; a separate setup-once + refresh pair was more moving
parts than needed.)

## Authentication

**Service account** (recommended and chosen):

- Runs unattended (cron-able later), no login popups, no token expiry.
- The user creates the Google Sheet themselves (owned by their workspace) and
  shares it with the service account email as **Editor**. Ownership and sharing
  stay with the user.

## Architecture / files

Shared data logic is extracted so both outputs use one source of truth.

| File | Role |
|------|------|
| `db.mjs` (new) | `.env` loader + `fetchData()` (runs both SQL queries, returns `{projects, properties}`) + `mockData()`. Extracted from the current script. |
| `generate-report.mjs` (kept) | xlsx generator, now imports `db.mjs`. Offline fallback. `npm run generate`. |
| `sync-sheet.mjs` (new) | Google Sheets sync. `npm run sync`. The new normal path. |

New dependency: `googleapis` (official client; bundles `google-auth-library`).

`.env` additions:

```
GOOGLE_SERVICE_ACCOUNT_KEY=./service-account.json
SPREADSHEET_ID=<id from the sheet URL>
```

`service-account.json` is gitignored.

## Tabs (sheets within the file)

Four tabs total (2 active + 2 archive), all referenced by fixed title (do not
rename):

- `Missing Project Data` (active)
- `Missing Property Data` (active)
- `Resolved Project Data` (archive, auto-created)
- `Resolved Property Data` (archive, auto-created)

First `npm run sync` auto-creates any missing tabs.

## Column map (preserved fields)

**Project tab** (A=1 … U=21): key = `Project ID` (U=21), Notes = `Notes / Comments`
(S=19), Status = `Status` (T=20).

**Property tab** (A=1 … O=15): key = `Property ID` (N=14), Notes = `Note / Comments`
(L=12), Status = `Status` (M=13).

## Sync flow (per active tab)

1. `fetchData()` from the database.
2. Read the existing tab → build a map `ID → { notes, status }`.
3. Build fresh rows (sorted by `created_at DESC`, as today). For each record:
   - DB status cells (Missing/Present).
   - Count + Missing-Data-Summary as **Google Sheets formulas** (same logic as the
     xlsx, with the Excel-only `_xlfn.` prefix dropped). Formulas mean the count
     and summary recompute live if the team toggles a status dropdown.
   - `HYPERLINK(...)` for Link columns.
   - IDs.
   - Notes/Status pulled from the map by ID; if the ID is new → blank notes +
     default status (`Not updated` / `Not Updated`).
4. Write the full grid in one `values.update` with `USER_ENTERED` (so formulas and
   dates parse), then clear any trailing leftover rows from a previous, longer run.
   Writing the full grid in one call (rather than clear-then-write) avoids a
   momentary blank flash for anyone viewing.

### Merge rules

- ID present in old tab **and** new data → notes + status carried over. ✅
- New incomplete row → appears, blank notes, default status.
- Row now complete → removed from the active tab and **archived** (see below).
- Matching is by **ID, not row position** → survives team sorting/filtering.

## Formatting (idempotent, re-applied each run)

One `batchUpdate` applies: freeze the header row, set column widths, set data
validation dropdowns (`Missing,Present` on status columns; the `Status` workflow
dropdown), and red/green conditional formatting on the relevant columns. CF is
applied to **whole columns** so new rows are covered automatically. Existing CF
rules are deleted and re-added each run so they never accumulate duplicates.

The Missing/Present cells reflect database truth and are refreshed every run; the
team's real input (Notes + Status) is what gets preserved across runs.

## Archive

Two archive tabs: `Resolved Project Data`, `Resolved Property Data`.

Per run, per entity:

- Resolved IDs = `(IDs on the active tab before this run) − (IDs incomplete now)`.
- Each resolved row is appended to its archive tab with: name + IDs + the team's
  **Notes + Status** + a **Resolved At** date (the date the script noticed it was
  resolved).
- Archive is **append-only and deduped** — read existing archive IDs first, never
  double-add.
- The active tab then holds only currently-incomplete rows.

**Known behavior:** if an archived item becomes incomplete again later, it
reappears on the active tab with blank notes (the old notes remain in the
archive). Accepted for simplicity; not pulled back.

## Concurrency / known risk

If a teammate edits Notes/Status during the few seconds the script runs, that
edit can be overwritten (read-then-write race). Mitigation: run the refresh when
the team is not actively editing. Acceptable for infrequent runs.

## One-time setup (the user does this once)

1. Create a Google Cloud project → enable the **Google Sheets API**.
2. Create a **service account** → create a JSON key → save it as
   `service-account.json` in the project folder (gitignored).
3. Create the blank Google Sheet → **Share** it with the service account email
   (looks like `name@project.iam.gserviceaccount.com`) as **Editor** → copy the
   spreadsheet ID from its URL into `.env` as `SPREADSHEET_ID`.
4. Run `npm install`, then `npm run sync`. The two active tabs (and archive tabs,
   when first needed) are created automatically.

## Out of scope (YAGNI)

- Google threaded/speech-bubble comments (team doesn't use them).
- Pulling notes back when an archived row reappears.
- A stronger concurrency lock.
- Scheduling/automation (cron) — possible later; not part of this work.
