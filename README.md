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

## Rules checked

**Project** (each missing item = one violation): location (lat/lng + full
address), builder _(must be set **and** active — soft-deleted builder counts as
missing)_, land type, land acres, RERA number, RERA registration date, RERA
completion date, nearby accessibility (min 3), active properties (min 1),
images, attachments, amenities.

**Property**: base price, total floors, units per floor, active unit
configurations.

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
