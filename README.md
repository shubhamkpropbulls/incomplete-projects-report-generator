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
  - Property sheet → `Property ID` + `Project ID` (columns O, P)
- Stale per-user saved filter views are dropped.

Resulting layout: project sheet = 21 columns (A–U), property sheet = 16 columns
(A–P).

## Files

- `generate-report.mjs` — the generator.
- `template.xlsx` — the styled template (do not delete; the script fills it).
- `package.json` — dependencies (`pg`, `jszip`).
