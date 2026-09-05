# Incomplete Data Report

Generates an `.xlsx` listing **projects** and **properties** that are missing
required data, matching the hand-made "Incomplete Units Propbulls" report
(same fonts, borders, conditional-format color coding, table styling and
formulas).

## What it does

- Reads `DATABASE_URL` from the environment.
- Finds incomplete **projects** and **properties** (only rows that violate at
  least one rule are included).
- Writes a workbook with two sheets: **Missing Project Data** and
  **Missing Property Data**.

The output is produced by surgically filling `template.xlsx` (a copy of the
original report), so all styling, conditional formatting and the green/red
color coding are preserved exactly. The `Status` column defaults to
`Not updated` for every row — the team updates it later.

## Run

```bash
cd scripts/incomplete-data-report
npm install
DATABASE_URL='postgres://user:pass@host:5432/db' npm run generate
# optional custom output path:
DATABASE_URL='...' node generate-report.mjs "/path/to/report.xlsx"
```

Default output: `Incomplete Data Propbulls <YYYY-MM-DD>.xlsx` in the current
directory.

Remote databases use TLS automatically (`rejectUnauthorized: false`); a
`localhost`/`127.0.0.1` URL connects without TLS. To smoke-test the output
format without a database, run with `MOCK=1`.

## Google Sheets sync (keeps team comments)

`npm run sync` refreshes one permanent Google Sheet in place instead of
producing a new file each time. The team's `Notes / Comments` and `Status`
are preserved across refreshes (matched by the row's `Project ID` /
`Property ID`). Rows that become complete are moved to `Resolved …` tabs.

### One-time setup

1. In [Google Cloud Console](https://console.cloud.google.com/), create a
   project and enable the **Google Sheets API**.
2. Create a **service account**, then create a **JSON key** for it. Save the
   downloaded file as `service-account.json` in this folder (it is gitignored).
3. Create a blank Google Sheet. Click **Share** and add the service account's
   email (looks like `name@project-id.iam.gserviceaccount.com`, found inside
   the JSON key as `client_email`) as an **Editor**.
4. Copy the spreadsheet ID from the sheet URL
   (`https://docs.google.com/spreadsheets/d/<ID>/edit`) into `.env`:
   ```
   GOOGLE_SERVICE_ACCOUNT_KEY=./service-account.json
   SPREADSHEET_ID=<ID>
   DATABASE_URL=postgres://...
   ```
5. `npm install`, then `npm run sync`. The four tabs are created automatically
   on first run.

### Dry run (no Google account needed)

```bash
node sync-sheet.mjs --dry-run
```
Prints the grids it would write using mock data; makes no network calls.

### Notes

- Always share the **same** sheet link with the team — the script updates it
  in place, so comments persist.
- Don't rename the tabs (`Missing Project Data`, `Missing Property Data`,
  `Resolved Project Data`, `Resolved Property Data`).
- Run the refresh when the team is not actively editing: an edit made during
  the few seconds the script runs could be overwritten.
- The `.xlsx` generator (`npm run generate`) is kept as an offline fallback.

## Refresh button in the sheet

The team can refresh the report themselves from **PropBulls → Refresh report**
in the sheet's menu, instead of asking someone to run `npm run sync`.

### How it works

The button does not run the sync. Google Apps Script runs on Google's servers
and has no PostgreSQL driver, so it cannot reach the database at all.

Instead the sheet is a mailbox. The button writes a request token into a hidden
`_control` tab. A watcher on the sync machine polls that one cell every 15
seconds over an outbound HTTPS call — the same direction `npm run sync` already
calls — and when it sees a valid token it runs `sync-sheet.mjs` as a child
process and writes the result back. **Nothing inbound is ever opened on the sync
machine**, which matters because it holds the production `DATABASE_URL` and the
service-account key.

A modal dialog in the sheet polls the same cells, so the clicker sees
`queued → running → done` with the row counts.

### The `_control` tab

Hidden, labels in column A, values in column B.

| Cell | Label     | Written by  | Value                                            |
| ---- | --------- | ----------- | ------------------------------------------------ |
| B1   | Request   | Apps Script | `SYNC <ISO8601> <8 hex>`, cleared by the watcher |
| B2   | State     | watcher     | `idle` / `queued` / `running` / `done` / `error` |
| B3   | Message   | watcher     | the sentence shown in the dialog                 |
| B4   | Heartbeat | watcher     | ISO8601, rewritten every 60s                     |
| B5   | Last run  | watcher     | ISO8601 of the last successful sync              |

Hidden is tidiness, not security — anyone with edit access can unhide it. The
real defence is the token format: a stray keystroke or a pasted column does not
match, so the watcher clears it and reports `Ignored unrecognised value` without
running anything.

Both data tabs also carry a plain `Last synced …` stamp (project `W1`, property
`R1`), outside everything `writeGrid` touches, so nobody has to open a dialog to
see how fresh the numbers are.

### Running the watcher

```bash
npm run watch          # foreground, logs to the terminal AND to logs/
```

Foreground is the debug path — it dies with the terminal. For 24/7:

```powershell
powershell -ExecutionPolicy Bypass -File .\install-watcher.ps1
schtasks /run /tn "PropBulls incomplete-report watcher"
```

That registers a logon-triggered task running `watch-hidden.vbs`, which starts
node with no console window. The script exists because four Task Scheduler
defaults each break a 24/7 watcher: the 3-day execution limit, the two
battery conditions, and no restart-on-failure. It also deliberately does *not*
use "run whether user is logged on or not" — that is session 0, where
`notify.vbs` cannot draw a dialog and every crash alert silently disappears.

Remove it with
`schtasks /delete /tn "PropBulls incomplete-report watcher" /f`.

The remaining uncovered case is a reboot where nobody logs back in (an
overnight Windows Update restart): the task waits at the lock screen. Locking
the machine is fine — a locked session keeps running processes.

Three ways to tell it is alive, in order of convenience:

1. `_control!B4` heartbeat moving.
2. The hourly `alive` line in `logs/watch-<date>.log`.
3. Task Manager.

If it is not running, the button refuses to queue anything and says the sync
machine looks offline, rather than appearing to do nothing.

Tuning, all optional env vars: `POLL_MS` (15000), `HEARTBEAT_MS` (60000),
`MIN_GAP_MS` (120000 — the shortest gap between two syncs, so four impatient
clicks do not queue four runs).

### When something goes wrong

- A crash, a failed sync, or five consecutive Sheets errors pops a **desktop
  dialog** on the sync machine (`notify.vbs`). A hard kill — `taskkill`, power
  loss, machine off — cannot report itself; Task Scheduler restarts it and the
  gap shows in the log.
- `logs/watch-<date>.log` keeps 14 days: startup config, every decision, every
  sync with its full stdout and stderr, and every failure with its stack.
  Credentials are stripped from everything written there, so it is safe to
  paste into an issue.

### One-time setup

```bash
node setup-control.mjs   # creates and hides the _control tab
```

Then paste `apps-script/Code.gs` and `apps-script/Dialog.html` into the sheet's
Apps Script project (Extensions → Apps Script; the HTML file must be named
exactly `Dialog`). **Those files are the source of truth and there is no
automatic sync** — re-paste after every edit.

`test/contract.test.mjs` guards the constants that are duplicated across the two
runtimes. If the token format or the cell map drifts, a test fails instead of
the button silently doing nothing.

### Caution

A refresh rewrites both data tabs. Notes / Comments and Status are kept, matched
back on by `Project ID` and `Property ID`, but anyone typing in the sheet while
it runs can lose that edit. The button confirms first for exactly this reason.
Observed runtimes: 12s and 33s — Neon can cold start.

## Rules checked

**Project** (each missing item = one violation): location (lat/lng + full
address), builder _(must be set **and** active — soft-deleted builder counts as
missing)_, land type, land acres, RERA number, RERA registration date, RERA
completion date, nearby transit _(must have **both** a metro station and a
railway/train station)_, active properties (min 1),
images, attachments, amenities.

**Property**: total floors, units per floor, active unit configurations.

Only active records are considered. Properties under a soft-deleted project are
excluded.

## Differences from the original report

- Only the two data sheets are kept (hidden helper sheets removed).
- The hidden helper columns are removed entirely. Clickable `Link` columns
  inline their URL so they still open admin-console.
- Visible ID columns are appended for joining later:
  - Project sheet → `Project ID` (column U)
  - Property sheet → `Property ID` + `Project ID` (columns N, O)
- Stale per-user saved filter views are dropped.

Resulting layout: project sheet = 21 columns (A–U), property sheet = 15 columns
(A–O).

## Files

- `generate-report.mjs` — the generator.
- `template.xlsx` — the styled template (do not delete; the script fills it).
- `package.json` — dependencies (`pg`, `jszip`).
